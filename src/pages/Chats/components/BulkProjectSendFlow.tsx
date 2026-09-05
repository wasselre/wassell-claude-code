import { useMemo, useState } from 'react';
import {
  X, Loader2, AlertTriangle, ArrowUp, ArrowDown, Trash2, Pencil,
  Send, Layers, CheckCircle2, FileText, Image as ImageIcon, CalendarClock,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import ProjectMessageComposeStep from '@/pages/Chats/components/ProjectMessageComposeStep';
import ProjectFilePickerModal from '@/pages/Chats/components/ProjectFilePickerModal';
import type { PickedClient } from '@/pages/Chats/components/ClientPicker';
import {
  enqueueBulkProjectSend,
  type BulkEnqueueResult,
  type BulkRecipient,
} from '@/lib/projects/bulkProjectSend';

/**
 * BulkProjectSendFlow — send SEVERAL projects to ONE client, in order.
 *
 * Flow: walk each project { compose message → pick files (top-3 photos + PDFs
 * pre-checked) } → REVIEW all projects in order → SEND ALL. Nothing is queued
 * until "Send all": the engine (`enqueueBulkProjectSend`) then ENQUEUES the
 * whole plan to the backend scheduled-send queue — each project's text → PDF →
 * pictures on a staggered delivery schedule — and returns immediately. The Fly
 * worker delivers in the background, so the rep is never made to wait: the
 * modal shows a brief "queued" confirmation and closes.
 */

/** Where the bulk goes. An existing conversation, or a client we resolve a
 *  brand-new conversation for on the first send. */
export type BulkRecipientInput =
  | { kind: 'chat'; chatWid: string; label?: string }
  | { kind: 'client'; client: PickedClient };

interface Props {
  isAr: boolean;
  /** all_projects record ids, in the rep's chosen initial order. */
  projectIds: string[];
  recipient: BulkRecipientInput;
  onClose: () => void;
}

interface ProjectConfig {
  text: string;
  sendLang: 'ar' | 'en';
  /** Media refs, ordered documents → photos → videos. */
  refs: string[];
}

type Phase = 'compose' | 'files' | 'review' | 'queuing' | 'done';

export default function BulkProjectSendFlow({ isAr, projectIds, recipient, onClose }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const allProjectsModel = useMemo(() => models.find((m) => m.name === 'all_projects'), [models]);
  const nameOf = (id: string): string => {
    const rec = (records[allProjectsModel?.id ?? ''] ?? []).find((r) => r.id === id);
    const n = (rec?.data as Record<string, unknown> | undefined)?.project_name;
    return typeof n === 'string' && n.trim() ? n : id;
  };

  // The working ordered list of project ids (dedup) + per-project config.
  const [order, setOrder] = useState<string[]>(() => [...new Set(projectIds)]);
  const [configs, setConfigs] = useState<Record<string, ProjectConfig>>({});

  const [phase, setPhase] = useState<Phase>('compose');
  const [cursor, setCursor] = useState(0); // index in `order` while walking/editing
  const [mode, setMode] = useState<'walk' | 'edit'>('walk');

  // Backend enqueue result (set on "Send all"). No live per-delivery progress:
  // the plan is queued to the worker and delivered in the background.
  const [result, setResult] = useState<BulkEnqueueResult | null>(null);

  const recipientLabel =
    recipient.kind === 'chat'
      ? recipient.label || L('المحادثة', 'the conversation')
      : recipient.client.name;
  const recipientPhoneMissing = recipient.kind === 'client' && !recipient.client.phone;

  const currentId = order[cursor];

  // ── Walk: compose → files, per project ──────────────────────────────
  if (phase === 'compose' && currentId) {
    return (
      <ProjectMessageComposeStep
        isAr={isAr}
        projectId={currentId}
        projectName={nameOf(currentId)}
        subtitle={
          mode === 'walk'
            ? L(`مشروع ${cursor + 1} من ${order.length} • إلى ${recipientLabel}`,
                `Project ${cursor + 1} of ${order.length} • to ${recipientLabel}`)
            : L(`تعديل: ${nameOf(currentId)}`, `Editing: ${nameOf(currentId)}`)
        }
        primaryLabel={L('التالي: الملفات', 'Next: files')}
        onAccept={({ text, sendLang }) => {
          setConfigs((c) => ({
            ...c,
            [currentId]: { text, sendLang, refs: c[currentId]?.refs ?? [] },
          }));
          setPhase('files');
        }}
        onBack={
          mode === 'edit'
            ? () => setPhase('review')
            : cursor > 0
              ? () => { setCursor((i) => i - 1); }
              : undefined
        }
        backLabel={mode === 'edit' ? L('إلى المراجعة', 'To review') : L('المشروع السابق', 'Previous project')}
        onCancel={onClose}
      />
    );
  }

  if (phase === 'files' && currentId) {
    return (
      <ProjectFilePickerModal
        allProjectId={currentId}
        projectName={nameOf(currentId)}
        isAr={isAr}
        preselect="bulk"
        confirmLabel={mode === 'edit' ? L('حفظ', 'Save') : L('التالي', 'Next')}
        onConfirm={(refs) => {
          setConfigs((c) => ({
            ...c,
            [currentId]: { text: c[currentId]?.text ?? '', sendLang: c[currentId]?.sendLang ?? (isAr ? 'ar' : 'en'), refs },
          }));
          if (mode === 'edit') {
            setPhase('review');
          } else if (cursor >= order.length - 1) {
            setPhase('review');
          } else {
            setCursor((i) => i + 1);
            setPhase('compose');
          }
        }}
        // Cancel on the file picker steps back to the message step for this project.
        onClose={() => setPhase('compose')}
      />
    );
  }

  // ── Review ──────────────────────────────────────────────────────────
  const configuredOrder = order.filter((id) => configs[id]?.text?.trim());
  const canSend = configuredOrder.length > 0 && !recipientPhoneMissing;

  function editProject(id: string) {
    const idx = order.indexOf(id);
    if (idx < 0) return;
    setCursor(idx);
    setMode('edit');
    setPhase('compose');
  }
  function removeProject(id: string) {
    setOrder((o) => o.filter((x) => x !== id));
  }
  function move(id: string, dir: -1 | 1) {
    setOrder((o) => {
      const idx = o.indexOf(id);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= o.length) return o;
      const copy = [...o];
      const a = copy[idx]!;
      copy[idx] = copy[next]!;
      copy[next] = a;
      return copy;
    });
  }

  async function sendAll() {
    const plan = configuredOrder.map((id) => {
      const cfg = configs[id]!; // configuredOrder only keeps ids with a config
      return { projectId: id, projectName: nameOf(id), text: cfg.text, orderedRefs: cfg.refs };
    });
    const engineRecipient: BulkRecipient =
      recipient.kind === 'chat'
        ? { kind: 'chat', chatWid: recipient.chatWid }
        : { kind: 'new', phone: recipient.client.phone as string, clientRecordId: recipient.client.recordId };

    // Enqueue only — resolves in ~a second (fast queue inserts, no delivery
    // waits). The worker then delivers in the background.
    setPhase('queuing');
    const res = await enqueueBulkProjectSend(engineRecipient, plan);
    setResult(res);
    setPhase('done');
  }

  if (phase === 'review') {
    return (
      <Shell isAr={isAr} title={L('مراجعة الإرسال الجماعي', 'Review bulk send')} subtitle={L(`إلى ${recipientLabel}`, `to ${recipientLabel}`)} onClose={onClose}>
        <div className="space-y-3">
          <p className="text-xs text-charcoal/60">
            {L('تُرسَل المشاريع بالترتيب أدناه. لكل مشروع: النص، ثم ملف PDF، ثم الصور — ولا يبدأ مشروع قبل اكتمال إرسال الذي قبله.',
               'Projects send in the order below. Per project: text, then PDF, then photos — and no project starts until the previous one has fully sent.')}
          </p>

          {recipientPhoneMissing && (
            <div className="flex items-start gap-2 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>{L('لا يوجد رقم هاتف لهذا العميل — أضف رقمًا قبل الإرسال.', 'This client has no phone number — add one before sending.')}</span>
            </div>
          )}

          {configuredOrder.length === 0 ? (
            <p className="text-sm text-charcoal/40 py-8 text-center">{L('لا توجد مشاريع للإرسال', 'No projects to send')}</p>
          ) : (
            <ul className="space-y-2">
              {configuredOrder.map((id, idx) => {
                const cfg = configs[id]!; // configuredOrder only keeps ids with a config
                const photoOrDocCount = cfg.refs.length;
                return (
                  <li key={id} className="rounded-xl border border-sand/40 px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <div className="w-6 h-6 rounded-md bg-copper/10 text-copper text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-charcoal truncate">{nameOf(id)}</div>
                        <p className="text-[11px] text-charcoal/55 line-clamp-2 whitespace-pre-line mt-0.5" dir="auto">{cfg.text}</p>
                        <div className="flex items-center gap-3 text-[10px] text-charcoal/45 mt-1">
                          <span className="inline-flex items-center gap-1"><FileText size={11} /> {L('نص', 'text')}</span>
                          <span className="inline-flex items-center gap-1"><ImageIcon size={11} /> {L(`${photoOrDocCount} ملف`, `${photoOrDocCount} file${photoOrDocCount === 1 ? '' : 's'}`)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button onClick={() => move(id, -1)} disabled={idx === 0} className="p-1 rounded text-charcoal/40 hover:text-copper hover:bg-cream disabled:opacity-30" aria-label={L('لأعلى', 'Move up')}><ArrowUp size={14} /></button>
                        <button onClick={() => move(id, 1)} disabled={idx === configuredOrder.length - 1} className="p-1 rounded text-charcoal/40 hover:text-copper hover:bg-cream disabled:opacity-30" aria-label={L('لأسفل', 'Move down')}><ArrowDown size={14} /></button>
                        <button onClick={() => editProject(id)} className="p-1 rounded text-charcoal/40 hover:text-copper hover:bg-cream" aria-label={L('تعديل', 'Edit')}><Pencil size={14} /></button>
                        <button onClick={() => removeProject(id)} className="p-1 rounded text-charcoal/40 hover:text-red-600 hover:bg-red-50" aria-label={L('إزالة', 'Remove')}><Trash2 size={14} /></button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-4 mt-1">
          <Button variant="secondary" onClick={onClose}>{L('إلغاء', 'Cancel')}</Button>
          <Button variant="primary" onClick={() => void sendAll()} disabled={!canSend}>
            <Send size={14} />
            {L(`إرسال الكل (${configuredOrder.length})`, `Send all (${configuredOrder.length})`)}
          </Button>
        </div>
      </Shell>
    );
  }

  // ── Queuing / Done — the plan is enqueued to the backend, delivered later ──
  if (phase === 'queuing') {
    return (
      <Shell isAr={isAr} title={L('جارٍ الجدولة…', 'Queuing…')} subtitle={L(`إلى ${recipientLabel}`, `to ${recipientLabel}`)}>
        <div className="flex items-center gap-3 py-6 text-charcoal/70">
          <Loader2 size={18} className="animate-spin text-copper shrink-0" />
          <span className="text-sm">
            {L('جارٍ جدولة الرسائل للإرسال في الخلفية…', 'Queuing the messages to send in the background…')}
          </span>
        </div>
      </Shell>
    );
  }

  // phase === 'done'
  const ok = result ? result.failedProjects === 0 : false;
  const summary = result
    ? L(`تمت جدولة ${result.queuedProjects} مشروع${result.queuedMedia ? ` و${result.queuedMedia} ملف` : ''} للإرسال${result.failedProjects ? ` — تعذّر ${result.failedProjects}` : ''}`,
        `Queued ${result.queuedProjects} project${result.queuedProjects === 1 ? '' : 's'}${result.queuedMedia ? ` and ${result.queuedMedia} file${result.queuedMedia === 1 ? '' : 's'}` : ''}${result.failedProjects ? ` — ${result.failedProjects} couldn't queue` : ''}`)
    : '';

  return (
    <Shell isAr={isAr} title={L('في قائمة الإرسال', 'Queued to send')} subtitle={L(`إلى ${recipientLabel}`, `to ${recipientLabel}`)} onClose={onClose}>
      <div className="flex flex-col items-center text-center py-4 gap-3">
        <div className={`w-12 h-12 rounded-full flex items-center justify-center ${ok ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'}`}>
          {ok ? <CheckCircle2 size={26} /> : <AlertTriangle size={26} />}
        </div>
        <p className="text-sm font-semibold text-charcoal">{summary}</p>
        <div className="flex items-start gap-2 text-[12px] text-charcoal/60 bg-cream/60 border border-sand/40 rounded-lg px-3 py-2 text-start">
          <CalendarClock size={15} className="shrink-0 mt-0.5 text-copper" />
          <span>
            {L('تُرسَل الرسائل تِباعًا في الخلفية — لست بحاجة للانتظار. يمكنك متابعتها أو إلغاؤها من داخل المحادثة.',
               "The messages send one after another in the background — you don't have to wait. You can watch or cancel them from inside the conversation.")}
          </span>
        </div>
        {result?.firstError && (
          <p className="text-[11px] text-amber-700">{L(`ملاحظة: ${result.firstError}`, `Note: ${result.firstError}`)}</p>
        )}
      </div>
      <div className="flex justify-end pt-2">
        <Button variant="primary" onClick={onClose}>{L('تم', 'Done')}</Button>
      </div>
    </Shell>
  );
}

// ── Presentational helpers ────────────────────────────────────────────

function Shell({
  isAr, title, subtitle, onClose, children,
}: {
  isAr: boolean;
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]" dir={isAr ? 'rtl' : 'ltr'}>
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-copper/10 text-copper flex items-center justify-center shrink-0">
            <Layers size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-chocolate truncate">{title}</h2>
            {subtitle && <p className="text-xs text-charcoal/50 truncate">{subtitle}</p>}
          </div>
          {onClose && (
            <button onClick={onClose} className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors" aria-label={L('إغلاق', 'Close')}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
