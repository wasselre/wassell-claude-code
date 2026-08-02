/**
 * «طلب تعديلات» — design screen 38, the other half of the approval loop.
 *
 * Rejection here is SPECIFIC, never «عدّل النص»: the reviewer picks what needs
 * changing (the type's writing fields + individual scenes), and those chips
 * become the task's revision_targets so the writer's next task says exactly
 * where to look. The note is mandatory — a rejection without a reason just
 * restarts the loop blind — and the publish-date cost of the delay is shown
 * BEFORE sending, because seeing «١٠ ← ١٢ أغسطس» sometimes changes a reviewer's
 * mind.
 *
 * The engine decides where the work returns (last prior creates_revision step,
 * falling back to the first) — the «إلى من تعود؟» cards display that decision;
 * the alternative role is shown dimmed, exactly as the mockup draws it, because
 * the SQL transition cannot honor a different target and a selectable lie is
 * worse than a visible default.
 */
import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosContentRow, MosFieldDef, MosScene, MosStep, MosTask, ROLE_LABELS,
  completeTask, updateTask,
} from '@/lib/marketingOS/client';
import { Modal } from './kit';
import { daysAgo, isoDate, num, roleAvatarClass, shortDate } from '../lib/format';

/** Arabic ordinals for the round sentence — «هذه الجولة الثانية.» */
const ORDINAL_AR = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة'];

function roundOrdinal(round: number, isAr: boolean): string {
  if (!isAr) return `round ${round}`;
  return ORDINAL_AR[round - 1] ?? `الجولة ${num(round, true)}`;
}

/** «يوم» / «يومان» / «٣ أيام» / «١٢ يومًا» — the delay clause's unit. */
function daysText(n: number, isAr: boolean): string {
  if (!isAr) return `${n} ${n === 1 ? 'day' : 'days'}`;
  if (n === 1) return 'يوم';
  if (n === 2) return 'يومين';
  if (n <= 10) return `${num(n, true)} أيام`;
  return `${num(n, true)} يومًا`;
}

/** «المشهد ٣ والتعليق الصوتي» — labels joined for the consequence sentence. */
function joinLabels(labels: string[], isAr: boolean): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0] ?? '';
  const last = labels[labels.length - 1] ?? '';
  return `${labels.slice(0, -1).join(isAr ? '، ' : ', ')}${isAr ? ' و' : ' and '}${last}`;
}

/**
 * «١٠ ← ١٢ أغسطس» — the mockup collapses the month when both dates share it,
 * so the shift reads as one phrase, not two dates.
 */
function publishShift(fromIso: string, toIso: string, isAr: boolean): string {
  const a = new Date(fromIso);
  const b = new Date(toIso);
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  if (isAr) {
    const from = sameMonth ? num(a.getDate(), true) : shortDate(fromIso, true);
    return `${from} ← ${shortDate(toIso, true)}`;
  }
  const to = sameMonth ? String(b.getDate()) : shortDate(toIso, false);
  return `${shortDate(fromIso, false)} → ${to}`;
}

const DAY_MS = 86_400_000;

export default function RequestChangesModal({
  item, openTask, steps, scenes, fields, isAr, onClose, onSubmitted,
}: {
  item: MosContentRow;
  openTask: MosTask;
  steps: MosStep[];
  scenes: MosScene[];
  /** The content type's visible writing fields — the field chips. */
  fields: MosFieldDef[];
  isAr: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [targets, setTargets] = useState<string[]>([]);
  const [note, setNote] = useState('');
  // The revision's due date defaults to the task's own due date, else tomorrow.
  const [due, setDue] = useState<string>(
    isoDate(openTask.due_at) || isoDate(new Date(Date.now() + DAY_MS).toISOString()),
  );
  const [busy, setBusy] = useState(false);

  const round = openTask.round;
  const currentStep = steps.find((s) => s.id === openTask.step_id) ?? null;
  const stepLabel = currentStep ? (isAr ? currentStep.label_ar : currentStep.label_en) : '';

  // Where the engine returns the work: the LAST prior creates_revision step,
  // falling back to the first — the same rule workflow_advance_role_path runs.
  const returnStep = useMemo(() => {
    if (!currentStep) return steps[0] ?? null;
    const prior = steps.filter((s) => s.position < currentStep.position);
    return [...prior].reverse().find((s) => s.creates_revision) ?? steps[0] ?? null;
  }, [steps, currentStep]);
  const returnRoleLabel = returnStep
    ? ROLE_LABELS[returnStep.role]
      ? isAr ? ROLE_LABELS[returnStep.role].ar : ROLE_LABELS[returnStep.role].en
      : returnStep.role
    : '';
  const returnStepLabel = returnStep ? (isAr ? returnStep.label_ar : returnStep.label_en) : '';
  // One OTHER role on the path, drawn dimmed like the mockup's «دور آخر» card.
  const otherRole = steps.find((s) => returnStep && s.role !== returnStep.role)?.role ?? null;

  // The thing under revision is the RETURN step's work — s38 says «النسخة ٢ من
  // النص» and «تعديل النص», never the review step's own name.
  const revisedLabel = returnStepLabel || stepLabel;
  const sentAgo = daysAgo(openTask.opened_at, isAr);

  /* ── the change-area chips ── */
  const chipDefs = useMemo(() => {
    const fieldChips = fields
      .filter((f) => !f.is_hidden)
      .map((f) => ({ target: f.key, label: isAr ? f.label_ar : f.label_en }));
    const sceneChips = scenes.map((s) => ({
      target: `scene:${s.id}`,
      label: isAr ? `المشهد ${num(s.position, true)}` : `Scene ${s.position}`,
    }));
    return [...fieldChips, ...sceneChips];
  }, [fields, scenes, isAr]);

  const toggle = (target: string): void => {
    setTargets((t) => (t.includes(target) ? t.filter((x) => x !== target) : [...t, target]));
  };
  const labelOf = (target: string): string => chipDefs.find((c) => c.target === target)?.label ?? target;
  const targetLabels = targets.map(labelOf);

  /* ── the publish-date cost, shown before sending ── */
  const shiftDays = useMemo(() => {
    if (!due) return 0;
    const dueT = new Date(`${due}T12:00:00`).getTime();
    const refT = openTask.due_at ? new Date(openTask.due_at).getTime() : Date.now();
    return Math.max(0, Math.round((dueT - refT) / DAY_MS));
  }, [due, openTask.due_at]);
  const shiftedPublish = item.target_publish_at && shiftDays > 0
    ? new Date(new Date(item.target_publish_at).getTime() + shiftDays * DAY_MS).toISOString()
    : null;
  const tomorrow = isoDate(new Date(Date.now() + DAY_MS).toISOString());

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await completeTask(openTask.id, 'changes_requested', note.trim(), targets);
      // The due date rides a second call: task_complete advances the path, then
      // task_update moves the NEW task's due date. A failure here must be
      // visible — the rejection already landed, so say exactly what didn't.
      if (due && res.opened_task_id) {
        try {
          await updateTask(res.opened_task_id, { due_at: new Date(`${due}T17:00:00`).toISOString() });
        } catch (e) {
          console.error('[marketing] revision due-date update failed', e);
          addToast(
            isAr
              ? 'أُرسل طلب التعديلات، لكن تعذّر ضبط استحقاق التعديل — عدّله من شاشة الفريق.'
              : 'The change request went through, but the revision due date did not — adjust it from the team screen.',
            'error',
          );
        }
      }
      addToast(
        isAr ? 'أُعيدت للخطوة السابقة مع الملاحظة.' : 'Sent back a stage with your note.',
        'success',
      );
      onSubmitted();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const roundSentence = isAr
    ? `هذه الجولة ${roundOrdinal(round, true)}. ثلاث جولات على سجل واحد تُظهر تنبيهًا لمدير التسويق — غالبًا الموجز هو المشكلة لا الكتابة.`
    : `This is ${roundOrdinal(round, false)}. Three rounds on one record raise an alert for the marketing manager — usually the brief is the problem, not the writing.`;

  return (
    <Modal
      title={isAr ? `طلب تعديلات · ${item.ref ?? ''}` : `Request changes · ${item.ref ?? ''}`}
      sub={isAr
        ? `النسخة ${num(round, true)} من ${revisedLabel} — أرسلها ${returnRoleLabel}${sentAgo === 'اليوم' ? ' اليوم' : ` قبل ${sentAgo}`}`
        : `Version ${round} of ${revisedLabel} — sent by the ${returnRoleLabel} ${sentAgo === 'today' ? 'today' : `${sentAgo} ago`}`}
      onClose={onClose}
      footer={
        <>
          <span className="note">{roundSentence}</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={busy || note.trim() === ''}
            onClick={() => void submit()}
          >
            {busy ? (isAr ? 'جارٍ الإرسال…' : 'Sending…') : isAr ? 'إرسال الطلب' : 'Send the request'}
          </button>
        </>
      }
    >
      {/* Three rounds on one record: the footer sentence promoted to a banner. */}
      {round >= 3 && (
        <div className="s38-alert" role="alert">
          {roundSentence}
        </div>
      )}

      {/* ── ما الذي يحتاج تعديلًا؟ ── */}
      <div>
        <div className="lbl" style={{ marginBottom: 7 }}>
          {isAr ? 'ما الذي يحتاج تعديلًا؟' : 'What needs changing?'}
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {chipDefs.map((c) => {
            const on = targets.includes(c.target);
            return (
              <button
                key={c.target}
                type="button"
                className={`fbtn${on ? ' on' : ''}`}
                onClick={() => toggle(c.target)}
              >
                {c.label}
                {on && <span className="x">×</span>}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 6 }}>
          {isAr
            ? 'المحدَّد يظهر في مهمة التعديل، فيعرف الكاتب أين ينظر دون قراءة كل شيء من جديد.'
            : 'The selection shows on the revision task, so the writer knows where to look without re-reading everything.'}
        </div>
      </div>

      {/* ── الملاحظة · إلزامية ── */}
      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {isAr ? 'الملاحظة' : 'The note'}{' '}
          <span style={{ color: 'var(--late)' }}>{isAr ? '· إلزامية' : '· required'}</span>
        </div>
        <textarea
          className="inp"
          style={{ width: '100%', minHeight: 82, lineHeight: 1.9 }}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoFocus
          placeholder={isAr
            ? 'المشهد ٣ ما زال يشرح الموقع بدل أن يُظهره — اجعليه لقطة خريطة متحركة بلا تعليق.'
            : 'Scene 3 still explains the location instead of showing it — make it an animated map shot with no voice-over.'}
        />
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 6 }}>
          {isAr
            ? `تُحفظ على النسخة ${num(round, true)} للأبد، وتظهر أعلى شاشة ${returnRoleLabel} حتى يعالجها.`
            : `Saved on version ${round} forever, and pinned to the top of the ${returnRoleLabel}’s screen until addressed.`}
        </div>
      </div>

      {/* ── إلى من تعود؟ ── */}
      {returnStep && (
        <div>
          <div className="lbl" style={{ marginBottom: 7 }}>
            {isAr ? 'إلى من تعود؟' : 'Who does it go back to?'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="s38-role on">
              <span className={`av ${roleAvatarClass(returnStep.role)}`}>{returnRoleLabel.slice(0, 1)}</span>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{returnRoleLabel}</div>
                <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                  {isAr ? 'الدور الذي أرسل — الافتراضي' : 'The role that submitted — the default'}
                </div>
              </div>
            </div>
            {otherRole && (
              <div className="s38-role" style={{ flex: '0 0 150px', opacity: 0.65 }}>
                <span className={`av ${roleAvatarClass(otherRole)}`}>
                  {(ROLE_LABELS[otherRole] ? (isAr ? ROLE_LABELS[otherRole].ar : ROLE_LABELS[otherRole].en) : otherRole).slice(0, 1)}
                </span>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>
                    {ROLE_LABELS[otherRole] ? (isAr ? ROLE_LABELS[otherRole].ar : ROLE_LABELS[otherRole].en) : otherRole}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                    {isAr ? 'دور آخر' : 'Another role'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── الاستحقاق + التأثير على النشر ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <div>
          <div className="lbl" style={{ marginBottom: 6 }}>
            {isAr ? 'استحقاق التعديل' : 'Revision due date'}
          </div>
          <input
            type="date"
            className="inp"
            style={{ width: '100%' }}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          {due === tomorrow && (
            <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5 }}>
              {isAr ? 'غدًا' : 'Tomorrow'}
            </div>
          )}
        </div>
        <div>
          <div className="lbl" style={{ marginBottom: 6 }}>
            {isAr ? 'التأثير على تاريخ النشر' : 'Impact on the publish date'}
          </div>
          <div
            className="inp"
            style={{
              width: '100%',
              color: shiftedPublish ? 'var(--late)' : 'var(--mute)',
              fontWeight: shiftedPublish ? 700 : 400,
            }}
          >
            {!item.target_publish_at
              ? isAr ? 'بلا تاريخ نشر مستهدف' : 'No target publish date'
              : shiftedPublish
                ? publishShift(item.target_publish_at, shiftedPublish, isAr)
                : isAr ? 'لا تغيير متوقع' : 'No change expected'}
          </div>
        </div>
      </div>

      {/* ── عند الإرسال — the consequence, stated before it happens ── */}
      <div className="s38-cons">
        <b style={{ color: 'var(--ink)', fontWeight: 700 }}>
          {isAr ? 'عند الإرسال' : 'On send'}
        </b>
        {isAr ? (
          <>
            {' — تُنشأ مهمة '}
            <b style={{ color: 'var(--ink)' }}>
              «تعديل {revisedLabel}
              {targetLabels.length > 0 ? ` — ${joinLabels(targetLabels, true)}` : ''}»
            </b>
            {' ل'}{returnRoleLabel}
            {returnStepLabel && <>، وتعود المرحلة إلى «{returnStepLabel}»</>}
            {shiftedPublish && (
              <>، ويُخطر مشرف العمليات بتأخر تاريخ النشر {daysText(shiftDays, true)}</>
            )}
            .
          </>
        ) : (
          <>
            {' — a task '}
            <b style={{ color: 'var(--ink)' }}>
              “Revise {revisedLabel}
              {targetLabels.length > 0 ? ` — ${joinLabels(targetLabels, false)}` : ''}”
            </b>
            {' '}opens for the {returnRoleLabel}
            {returnStepLabel && <>, and the stage returns to “{returnStepLabel}”</>}
            {shiftedPublish && (
              <>, and the operations supervisor is notified of a {daysText(shiftDays, false)} publish-date slip</>
            )}
            .
          </>
        )}
      </div>
    </Modal>
  );
}
