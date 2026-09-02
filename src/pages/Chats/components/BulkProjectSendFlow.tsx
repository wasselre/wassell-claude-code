import { useMemo, useState } from 'react';
import {
  X, Loader2, Check, AlertTriangle, Clock, ArrowUp, ArrowDown, Trash2, Pencil,
  Send, Layers, CheckCircle2, FileText, Image as ImageIcon,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import ProjectMessageComposeStep from '@/pages/Chats/components/ProjectMessageComposeStep';
import ProjectFilePickerModal from '@/pages/Chats/components/ProjectFilePickerModal';
import type { PickedClient } from '@/pages/Chats/components/ClientPicker';
import {
  runBulkProjectSend,
  type BulkProgress,
  type BulkRecipient,
  type BulkSendResult,
  type BulkStepStatus,
} from '@/lib/projects/bulkProjectSend';

/**
 * BulkProjectSendFlow — send SEVERAL projects to ONE client, in order.
 *
 * Flow: walk each project { compose message → pick files (top-3 photos + PDFs
 * pre-checked) } → REVIEW all projects in order → SEND ALL. Nothing is sent
 * until "Send all": the engine (`runBulkProjectSend`) then sends each project
 * text → PDF → pictures, one whole project finishing before the next starts,
 * each step gated on WhatsApp accepting the previous (sent-gating). Live
 * per-project progress is shown while it runs.
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

type Phase = 'compose' | 'files' | 'review' | 'sending' | 'done';

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

  // Frozen send plan + live progress (set on "Send all").
  const [sendOrder, setSendOrder] = useState<string[]>([]);
  const [progress, setProgress] = useState<BulkProgress[]>([]);
  const [result, setResult] = useState<BulkSendResult | null>(null);

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

    setSendOrder(configuredOrder);
    setProgress(configuredOrder.map((id, index) => ({ index, projectId: id, status: 'pending' as BulkStepStatus })));
    setPhase('sending');

    const res = await runBulkProjectSend(engineRecipient, plan, {
      onProgress: (p) => setProgress((prev) => prev.map((row) => (row.index === p.index ? p : row))),
    });
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

  // ── Sending / Done — one status list, driven by the engine's progress ──
  const summary = result
    ? L(`أُرسل ${result.sentProjects} من ${sendOrder.length}${result.failedProjects ? ` — فشل ${result.failedProjects}` : ''}`,
        `Sent ${result.sentProjects} of ${sendOrder.length}${result.failedProjects ? ` — ${result.failedProjects} failed` : ''}`)
    : '';

  return (
    <Shell
      isAr={isAr}
      title={phase === 'done' ? L('اكتمل الإرسال', 'Send complete') : L('جارٍ الإرسال…', 'Sending…')}
      subtitle={L(`إلى ${recipientLabel}`, `to ${recipientLabel}`)}
      onClose={phase === 'done' ? onClose : undefined}
    >
      <ul className="space-y-2">
        {progress.map((p) => (
          <li key={p.index} className="flex items-center gap-3 rounded-xl border border-sand/40 px-3 py-2.5">
            <StatusIcon status={p.status} />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm text-charcoal truncate">{nameOf(p.projectId)}</div>
              <div className="text-[11px] text-charcoal/55">{statusLabel(p, isAr)}</div>
            </div>
          </li>
        ))}
      </ul>

      {phase === 'done' && (
        <div className="pt-4">
          <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${result && result.failedProjects === 0 ? 'text-green-700 bg-green-50 border border-green-200' : 'text-amber-700 bg-amber-50 border border-amber-200'}`}>
            {result && result.failedProjects === 0 ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <span>{summary}</span>
          </div>
          {result?.stoppedAt != null && (
            <p className="text-[11px] text-charcoal/55 mt-2">
              {L('توقّف الإرسال عند مشروع تعذّر إرسال رسالته — لم تُرسَل المشاريع التالية له.',
                 'Sending stopped at a project whose message failed — the projects after it were not sent.')}
            </p>
          )}
          <div className="flex justify-end pt-3">
            <Button variant="primary" onClick={onClose}>{L('تم', 'Done')}</Button>
          </div>
        </div>
      )}
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

function StatusIcon({ status }: { status: BulkStepStatus }) {
  if (status === 'sending-text' || status === 'sending-media') return <Loader2 size={16} className="animate-spin text-copper shrink-0" />;
  if (status === 'done') return <Check size={16} className="text-green-600 shrink-0" />;
  if (status === 'done-with-errors') return <AlertTriangle size={16} className="text-amber-600 shrink-0" />;
  if (status === 'failed') return <X size={16} className="text-red-600 shrink-0" />;
  return <Clock size={16} className="text-charcoal/30 shrink-0" />; // pending
}

function statusLabel(p: BulkProgress, isAr: boolean): string {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  switch (p.status) {
    case 'pending': return L('في الانتظار', 'Queued');
    case 'sending-text': return L('جارٍ إرسال النص…', 'Sending text…');
    case 'sending-media': return L('جارٍ إرسال الملفات…', 'Sending files…');
    case 'done': return L('تم الإرسال', 'Sent');
    case 'done-with-errors':
      return L(`أُرسل — فشل ${p.mediaFailed ?? 0} ملف`, `Sent — ${p.mediaFailed ?? 0} file(s) failed`);
    case 'failed': return p.error ? L(`فشل: ${p.error}`, `Failed: ${p.error}`) : L('فشل الإرسال', 'Failed to send');
  }
}
