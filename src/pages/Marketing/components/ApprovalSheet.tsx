/**
 * «اعتماد هذا النص؟» — design screen 29, phone 3: the mobile approval sheet.
 *
 * The requirements checklist renders ABOVE the buttons, so a gap is seen
 * BEFORE the tap — and when something is missing the button itself says
 * «اعتماد رغم النقص» with the count under it. Approving with a gap stays
 * possible, but it is a conscious act, never a silent default. The checklist
 * derives from the approval step's own `required_fields` plus the scene
 * footage — the same recipe TaskCard prints — so it can never drift from what
 * the workflow actually asks for.
 *
 * اعتماد wires to the SAME `task_complete` flow the desktop header uses
 * (`completeTask(taskId, 'approved')`); the optional note rides that call.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosScene, MosStep, MosTask, ROLE_LABELS, completeTask,
} from '@/lib/marketingOS/client';
import { daysAgo, num } from '../lib/format';
import '../styles/mobile-m2.css';

/** `true` below the workspace's 760px phone breakpoint — live across resizes. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const on = (e: MediaQueryListEvent): void => setMobile(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

/** The checklist's field sentences — the same shape TaskCard prints. */
const FIELD_CHECK: Record<string, { ar: string; en: string }> = {
  idea: { ar: 'الفكرة مكتوبة', en: 'Idea written' },
  hook: { ar: 'الافتتاحية مكتوبة', en: 'Hook written' },
  script: { ar: 'النص مكتوب', en: 'Script written' },
  voiceover: { ar: 'نص التعليق الصوتي مكتوب', en: 'Voice-over written' },
  headlines: { ar: 'العناوين المقترحة مكتوبة', en: 'Draft headlines written' },
  approved_headline: { ar: 'العنوان المعتمد محدد', en: 'Headline chosen' },
  caption: { ar: 'الكابشن مكتوب', en: 'Caption written' },
  hashtags: { ar: 'الوسوم محددة', en: 'Hashtags set' },
  design_brief: { ar: 'موجز التصميم مكتوب', en: 'Design brief written' },
  slides: { ar: 'الشرائح محددة', en: 'Slides listed' },
};

function fieldCheckLabel(key: string, isAr: boolean): string {
  const m = FIELD_CHECK[key];
  return m ? (isAr ? m.ar : m.en) : key;
}

/** «متطلب واحد ناقص — سيُسجَّل» — the button's honest subtitle, per count. */
function gapsPhrase(n: number, isAr: boolean): string {
  if (!isAr) return `${n} requirement${n === 1 ? '' : 's'} missing — it will be recorded`;
  if (n === 1) return 'متطلب واحد ناقص — سيُسجَّل';
  if (n === 2) return 'متطلبان ناقصان — سيُسجَّل';
  return `${num(n, true)} متطلبات ناقصة — سيُسجَّل`;
}

interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  sub?: string;
}

export default function ApprovalSheet({
  openTask, step, reviewedStep, nextStep, scenes, data, isAr, onClose, onDone,
}: {
  openTask: MosTask;
  /** The approval step itself — its `required_fields` seed the checklist. */
  step: MosStep | null;
  /** The step under review — names the thing being approved. */
  reviewedStep: MosStep | null;
  /** What approval unlocks — the consequence line under the title. */
  nextStep: MosStep | null;
  scenes: MosScene[];
  data: Record<string, unknown>;
  isAr: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const roleLabel = (role: MosStep['role'] | null | undefined): string | null => {
    if (!role) return null;
    return ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;
  };

  /* ── the checklist — required fields + scene footage, TaskCard's recipe ── */
  const required = Array.isArray(step?.required_fields)
    ? (step?.required_fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];
  const withFootage = scenes.filter((s) => s.footage_status === 'have').length;

  const items: CheckItem[] = [
    ...required.map((f) => {
      const v = data[f];
      const ok = Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null;
      return { key: f, label: fieldCheckLabel(f, isAr), ok };
    }),
    ...(scenes.length > 0
      ? [{
          key: '_footage',
          label: isAr ? 'المواد المطلوبة محددة' : 'Required material identified',
          ok: withFootage === scenes.length,
          sub: withFootage === scenes.length
            ? undefined
            : isAr
              ? `${num(withFootage, true)} من ${num(scenes.length, true)} لديها تصوير`
              : `${withFootage} of ${scenes.length} have footage`,
        }]
      : []),
  ];
  const gaps = items.filter((i) => !i.ok).length;

  /* ── the words — «اعتماد النص؟» + who waits + what approval opens ────── */
  const thing = reviewedStep
    ? (isAr ? reviewedStep.label_ar : reviewedStep.label_en)
    : isAr ? 'هذه الخطوة' : 'this stage';
  const title = isAr ? `اعتماد ${thing}؟` : `Approve ${thing}?`;

  const waitRole = roleLabel(reviewedStep?.role) ?? (isAr ? 'المرسل' : 'the submitter');
  const sentAgo = daysAgo(openTask.opened_at, isAr);
  const nextLabel = nextStep ? (isAr ? nextStep.label_ar : nextStep.label_en) : null;
  const nextRole = roleLabel(nextStep?.role);
  const sub = isAr
    ? `${waitRole} ${sentAgo === 'اليوم' ? 'أرسلها اليوم' : `ينتظر منذ ${sentAgo}`}.${
        nextLabel
          ? ` الاعتماد يفتح «${nextLabel}»${nextRole ? ` لدى ${nextRole}` : ''}.`
          : ' هذه آخر خطوة في المسار.'}`
    : `The ${waitRole} ${sentAgo === 'today' ? 'submitted today' : `has been waiting ${sentAgo}`}.${
        nextLabel
          ? ` Approving opens “${nextLabel}”${nextRole ? ` for the ${nextRole}` : ''}.`
          : ' This is the last step on the path.'}`;

  const approve = async (): Promise<void> => {
    setBusy(true);
    try {
      await completeTask(openTask.id, 'approved', note.trim() || undefined);
      addToast(
        isAr ? 'اعتُمد — انتقل إلى الخطوة التالية.' : 'Approved — it moved to the next stage.',
        'success',
      );
      onDone();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Rendered into <body> so the workspace's scroll container can never clip
  // it — the same posture as kit's Modal.
  return createPortal(
    <div
      className="mos-root m2-scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="m2-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="m2-grab" />
        <div className="m2-sheet-title">{title}</div>
        <div className="m2-sheet-sub">{sub}</div>

        {/* The checklist — ABOVE the buttons, so the gap is seen first. */}
        <div className="m2-chks">
          {items.map((i) => (
            <div key={i.key} className={`m2-chk${i.ok ? ' ok' : ' gap'}`}>
              <span className="bx">
                {i.ok && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </span>
              <div>
                <div className="tx">{i.label}</div>
                {i.sub && <div className="mt3">{i.sub}</div>}
              </div>
            </div>
          ))}
          {items.length === 0 && (
            <div className="m2-empty">
              {isAr ? 'لا متطلبات محددة على هذه الخطوة.' : 'No requirements are defined for this step.'}
            </div>
          )}
        </div>

        <textarea
          className="m2-note-box"
          rows={1}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={isAr ? 'أضف ملاحظة — اختياري' : 'Add a note — optional'}
        />

        <div className="m2-btns">
          <button
            type="button"
            className="m2-btn"
            style={{ flex: '0 0 110px' }}
            onClick={onClose}
            disabled={busy}
          >
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          {gaps > 0 ? (
            <button
              type="button"
              className="m2-btn g stack"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void approve()}
            >
              <span>
                {busy
                  ? isAr ? 'جارٍ…' : 'Working…'
                  : isAr ? 'اعتماد رغم النقص' : 'Approve despite the gap'}
              </span>
              <span className="sub">{gapsPhrase(gaps, isAr)}</span>
            </button>
          ) : (
            <button
              type="button"
              className="m2-btn g"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void approve()}
            >
              {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'اعتماد' : 'Approve'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
