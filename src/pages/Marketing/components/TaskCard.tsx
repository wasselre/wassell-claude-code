/**
 * The current task — design screen 06 (card) and screen 38 (request changes).
 *
 * One card, one action. The checklist is DERIVED from the step's own
 * `required_fields` plus the scene footage, so it can never drift from what the
 * workflow actually asks for. Approving with a gap open is allowed — and
 * recorded on the approval, which is the honest version of a soft gate.
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosContentRow, MosScene, MosStep, MosTask, ROLE_LABELS, completeTask,
} from '@/lib/marketingOS/client';
import { Check, Modal, Pill } from './kit';
import { IconCheck } from './icons';
import { daysAgo, num, shortDate } from '../lib/format';

export default function TaskCard({
  item, task, step, scenes, canAct, isAr, onDone,
}: {
  item: MosContentRow;
  task: MosTask;
  step: MosStep | null;
  scenes: MosScene[];
  canAct: boolean;
  isAr: boolean;
  onDone: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  const data = (item as unknown as { data?: Record<string, unknown> }).data ?? {};
  const required = Array.isArray(step?.required_fields)
    ? (step?.required_fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];

  const withFootage = scenes.filter((s) => s.footage_status === 'have').length;
  const overdue = task.due_at ? new Date(task.due_at).getTime() < Date.now() : false;
  const roleLabel = ROLE_LABELS[task.role]
    ? isAr ? ROLE_LABELS[task.role].ar : ROLE_LABELS[task.role].en
    : task.role;

  const run = async (result: 'submitted' | 'approved' | 'changes_requested', text?: string): Promise<void> => {
    setBusy(true);
    try {
      await completeTask(task.id, result, text);
      addToast(
        result === 'changes_requested'
          ? isAr ? 'أُعيدت للخطوة السابقة مع الملاحظة.' : 'Sent back a stage with your note.'
          : isAr ? 'تم — انتقلت إلى الخطوة التالية.' : 'Done — it moved to the next stage.',
        'success',
      );
      setRejecting(false);
      setNote('');
      onDone();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const isApproval = step?.is_approval === true;

  return (
    <>
      <div className="task-card">
        <div className="hd">
          <Pill tone="now">{isAr ? 'المهمة الحالية' : 'Current task'}</Pill>
          <h4 style={{ marginInlineStart: 2 }}>
            {step ? (isAr ? step.label_ar : step.label_en) : (isAr ? 'مهمة مفتوحة' : 'Open task')}
          </h4>
          <span
            style={{
              marginInlineStart: 'auto',
              fontSize: 11.5,
              fontWeight: 700,
              color: overdue ? 'var(--late)' : 'var(--mute)',
            }}
          >
            {task.due_at
              ? overdue
                ? isAr
                  ? `استحقاق ${shortDate(task.due_at, true)} · متأخر ${daysAgo(task.due_at, true)}`
                  : `due ${shortDate(task.due_at, false)} · ${daysAgo(task.due_at, false)} late`
                : isAr
                  ? `الاستحقاق ${shortDate(task.due_at, true)}`
                  : `due ${shortDate(task.due_at, false)}`
              : isAr ? 'بلا موعد' : 'no due date'}
          </span>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--mute)', margin: '9px 0 12px' }}>
          {isAr ? 'مُسندة إلى ' : 'Assigned to '}
          <b style={{ color: 'var(--ink)' }}>{roleLabel}</b>
          {task.round > 1 && (
            <> · {isAr ? `الجولة ${num(task.round, true)}` : `round ${task.round}`}</>
          )}
          {' · '}
          {isAr ? 'فُتحت ' : 'opened '}{shortDate(task.opened_at, isAr)}
        </div>

        {(required.length > 0 || scenes.length > 0) && (
          <>
            <div className="lbl" style={{ marginBottom: 5 }}>
              {isApproval
                ? isAr ? 'المطلوب قبل الاعتماد' : 'Expected before approval'
                : isAr ? 'المطلوب لإنهاء الخطوة' : 'Expected to finish this stage'}
            </div>
            {required.map((f) => {
              const v = data[f];
              const filled = Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null;
              return <Check key={f} ok={filled}>{fieldLabel(f, isAr)}</Check>;
            })}
            {scenes.length > 0 && (
              <Check ok={withFootage === scenes.length}>
                {isAr
                  ? `المواد محددة — ${num(withFootage, true)} من ${num(scenes.length, true)} مشاهد لديها تصوير`
                  : `Material identified — ${withFootage} of ${scenes.length} scenes have footage`}
              </Check>
            )}
          </>
        )}

        {canAct ? (
          <div
            style={{
              marginTop: 13,
              paddingTop: 12,
              borderTop: '1px solid color-mix(in srgb, var(--copper) 25%, transparent)',
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {isApproval && (
              <button type="button" className="btn btn-late" disabled={busy} onClick={() => setRejecting(true)}>
                {isAr ? 'طلب تعديلات' : 'Request changes'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-go"
              disabled={busy}
              onClick={() => void run(isApproval ? 'approved' : 'submitted')}
            >
              <IconCheck />
              {busy
                ? isAr ? 'جارٍ…' : 'Working…'
                : isApproval
                  ? isAr ? 'اعتماد' : 'Approve'
                  : isAr ? 'إرسال للخطوة التالية' : 'Submit to next stage'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--mute)' }}>
              {isApproval
                ? isAr
                  ? 'الاعتماد مع وجود متطلب ناقص مسموح، لكنه يُسجَّل على الاعتماد نفسه.'
                  : 'Approving with a gap open is allowed — it is recorded on the approval.'
                : isAr
                  ? 'الإرسال يفتح الخطوة التالية فورًا لدى صاحب الدور التالي.'
                  : 'Submitting opens the next stage for the next role immediately.'}
            </span>
          </div>
        ) : (
          <div
            style={{
              marginTop: 13,
              paddingTop: 12,
              borderTop: '1px solid color-mix(in srgb, var(--copper) 25%, transparent)',
              fontSize: 12,
              color: 'var(--mute)',
            }}
          >
            {isAr
              ? `هذه المرحلة لدى ${roleLabel} — لا إجراء مطلوب منك.`
              : `This stage sits with the ${roleLabel} — no action from you.`}
          </div>
        )}
      </div>

      {rejecting && (
        <Modal
          title={isAr ? 'طلب تعديلات' : 'Request changes'}
          sub={isAr
            ? 'ترجع الخطوة واحدة إلى الوراء كجولة جديدة. الملاحظة إلزامية — الرفض بلا سبب يعيد الدورة عمياء.'
            : 'This sends the work back one stage as a new round. The note is required — a rejection without a reason just restarts the loop blind.'}
          onClose={() => setRejecting(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRejecting(false)} disabled={busy}>
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                type="button"
                className="btn btn-p"
                disabled={busy || note.trim() === ''}
                onClick={() => void run('changes_requested', note.trim())}
              >
                {isAr ? 'إرجاع مع الملاحظة' : 'Send back with note'}
              </button>
            </>
          }
        >
          <div>
            <div className="lbl" style={{ marginBottom: 6 }}>
              {isAr ? 'ما الذي يجب تغييره؟' : 'What needs to change?'}
            </div>
            <textarea
              className="inp"
              rows={5}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
              placeholder={isAr
                ? 'مثال: المشهدان ٣ و٤ يحتاجان إعادة كتابة — الافتتاحية طويلة.'
                : 'e.g. Scenes 3 and 4 need a rewrite — the hook runs long.'}
            />
          </div>
        </Modal>
      )}
    </>
  );
}

/** Field keys as sentences. Unknown keys print themselves rather than vanish. */
function fieldLabel(key: string, isAr: boolean): string {
  const MAP: Record<string, { ar: string; en: string }> = {
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
  const m = MAP[key];
  return m ? (isAr ? m.ar : m.en) : key;
}
