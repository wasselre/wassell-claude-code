/**
 * The current task — design screen 06 (card) and screen 38 (request changes) —
 * plus `TasksApprovalsTab`, the FULL «المهام والاعتمادات» tab of screen 10.
 *
 * One card, one action. The checklist is DERIVED from the step's own
 * `required_fields` plus the scene footage, so it can never drift from what the
 * workflow actually asks for. Approving with a gap open is allowed — and
 * recorded on the approval, which is the honest version of a soft gate.
 *
 * Screen 10's tab is the difference between a database and an operating
 * system: nobody assigns these rows — closing one generates the next. The
 * rejection loop is drawn AS a loop: the rejected review is red-tinted with
 * its note, and the revision task it spawned is an indented child row. Future
 * steps come from the record's PINNED workflow version (content_detail's
 * `steps`), never from the live workflow definition.
 */
import { useState, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosContentRow, MosScene, MosStep, MosTask, ROLE_LABELS, completeTask,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Check, Modal, Pill } from './kit';
import { IconCheck, IconX } from './icons';
import { daysAgo, initial, num, roleAvatarClass, shortDate } from '../lib/format';

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

/* ════════════════════════════════════════════════════════════════════════
   Screen 10 — «المهام والاعتمادات», the whole tab.

   Wire from ContentDetailPage's `activeTab === 'tasks'` branch:
     <TasksApprovalsTab item={item} tasks={tasks} steps={steps}
       scenes={scenes} canApprove={canAct && currentStep?.is_approval === true}
       onRequestChanges={() => setRejectOpen(true)} onDone={() => void load()}
       isAr={isAr} />
   Every prop beyond item/tasks/steps/isAr is optional with a safe default, so
   partial wiring still renders (read-only chain, no approval card).
   ════════════════════════════════════════════════════════════════════════ */

const DAY_MS = 86_400_000;

/** «يوم واحد» / «يومان» / «٣ أيام» / «١٢ يومًا» — elapsed-time units. */
function elapsedDays(n: number, isAr: boolean): string {
  if (!isAr) return n <= 0 ? 'under a day' : `${n} day${n === 1 ? '' : 's'}`;
  if (n <= 0) return 'أقل من يوم';
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  if (n <= 10) return `${num(n, true)} أيام`;
  return `${num(n, true)} يومًا`;
}

/** «بعد يوم» / «بعد يومين» / «بعد ٣ أيام» — the SLA clause's unit. */
function afterDays(n: number, isAr: boolean): string {
  if (!isAr) return `after ${n} day${n === 1 ? '' : 's'}`;
  if (n === 1) return 'بعد يوم';
  if (n === 2) return 'بعد يومين';
  if (n <= 10) return `بعد ${num(n, true)} أيام`;
  return `بعد ${num(n, true)} يومًا`;
}

const APPROVAL_KIND_LABELS: Record<string, { ar: string; en: string }> = {
  creative: { ar: 'الإبداعي',  en: 'creative' },
  process:  { ar: 'الإجرائي',  en: 'process' },
  budget:   { ar: 'المالي',    en: 'budget' },
};

export function TasksApprovalsTab({
  item, tasks, steps, scenes = [], canApprove = false, onRequestChanges, onDone, isAr,
}: {
  item: MosContentRow;
  tasks: MosTask[];
  /** The record's PINNED workflow-version steps (content_detail), NOT the live workflow. */
  steps: MosStep[];
  scenes?: MosScene[];
  /** The open task is an approval my role may act on (the page's canAct rule). */
  canApprove?: boolean;
  /** Opens part 1's RequestChangesModal. Default no-op per the build spec. */
  onRequestChanges?: () => void;
  onDone?: () => void;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const { people } = useWorkspace();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const stepById = new Map(steps.map((s) => [s.id, s]));
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const chron = [...tasks].sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  const openTask = chron.find((t) => t.status === 'open') ?? null;
  const currentStep = openTask ? stepById.get(openTask.step_id ?? '') ?? null : null;

  const roleLabel = (role: string): string => {
    const m = ROLE_LABELS[role as keyof typeof ROLE_LABELS];
    return m ? (isAr ? m.ar : m.en) : role;
  };
  const nameOf = (userId: string | null | undefined): string | null => {
    if (!userId) return null;
    const u = people.find((x) => x.user_id === userId);
    if (!u) return null;
    return (isAr ? u.name_ar : u.name_en) ?? u.name_en ?? u.name_ar;
  };
  /** Who holds a role — the first holder's name, else the role label. */
  const holderOf = (role: string): string => {
    const holder = people.find((p) => (p.roles as string[]).includes(role));
    if (holder) {
      const n = (isAr ? holder.name_ar : holder.name_en) ?? holder.name_en ?? holder.name_ar;
      if (n) return n;
    }
    return roleLabel(role);
  };

  /* ── the chain rows ──────────────────────────────────────────────── */

  const data = item.data ?? {};
  const doneCount = tasks.filter((t) => t.status === 'done').length;

  /** Result cell for a closed task. */
  const resultPill = (t: MosTask, step: MosStep | null): ReactNode => {
    if (t.result === 'approved') return <Pill tone="go">{isAr ? 'اعتُمدت' : 'Approved'}</Pill>;
    if (t.result === 'changes_requested') return <Pill tone="late">{isAr ? 'طُلبت تعديلات' : 'Changes requested'}</Pill>;
    // A submitted writing step is a VERSION going out — name the version.
    if (step?.creates_revision) {
      return <Pill tone="go">{isAr ? `أُرسلت النسخة ${num(t.round, true)}` : `Version ${t.round} sent`}</Pill>;
    }
    return <Pill tone="go">{isAr ? 'أُرسلت' : 'Submitted'}</Pill>;
  };

  const assigneeCell = (role: string, assigneeId: string | null): ReactNode => {
    const name = nameOf(assigneeId) ?? holderOf(role);
    return (
      <div className="who">
        <span className={`av ${roleAvatarClass(role)}`}>{initial(name)}</span>
        {name}
      </div>
    );
  };

  /* Future steps from the PINNED path — everything after the current step. */
  const currentPos = currentStep?.position ?? Number.POSITIVE_INFINITY;
  const futureSteps = openTask ? ordered.filter((s) => s.position > currentPos) : [];

  /* ── the approval card's derivations ─────────────────────────────── */

  const isApprovalNow = openTask !== null && currentStep?.is_approval === true;
  const nextStep = currentStep
    ? ordered.find((s) => s.position === currentStep.position + 1) ?? null
    : null;
  const returnStep = currentStep
    ? [...ordered].filter((s) => s.position < currentStep.position).reverse()
        .find((s) => s.creates_revision) ?? ordered[0] ?? null
    : null;
  const requiredFields = (currentStep?.required_fields ?? []).filter(
    (f): f is string => typeof f === 'string',
  );
  const requiredFiles = (currentStep?.required_files ?? []).filter(
    (f): f is string => typeof f === 'string',
  );
  const filled = (key: string): boolean => {
    const v = data[key];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null;
  };
  const scenesSettled = scenes.length > 0 && !scenes.some((s) => s.footage_status === 'missing');

  const approve = async (): Promise<void> => {
    if (!openTask) return;
    setBusy(true);
    try {
      await completeTask(openTask.id, 'approved', note.trim() || undefined);
      addToast(isAr ? 'اعتُمد — انتقل إلى الخطوة التالية.' : 'Approved — it moved on.', 'success');
      setNote('');
      onDone?.();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ── «أين ذهب الوقت» buckets ─────────────────────────────────────── */

  interface Bucket { key: string; label: string; days: number; late: boolean; color: string }
  const buckets: Bucket[] = [];
  for (const t of chron) {
    const s = stepById.get(t.step_id ?? '') ?? null;
    const end = t.closed_at ? new Date(t.closed_at).getTime() : Date.now();
    const start = new Date(t.opened_at).getTime();
    const days = Math.max(0, (end - start) / DAY_MS);
    const isApproval = s?.is_approval === true;
    const isRevision = !isApproval && t.round > 1;
    const key = `${isApproval ? 'a' : isRevision ? 'r' : 'w'}:${t.step_id ?? '?'}`;
    const baseLabel = s ? (isAr ? s.label_ar : s.label_en) : isAr ? 'خطوة' : 'a stage';
    const label = isRevision ? (isAr ? `تعديل ${baseLabel}` : `Revising ${baseLabel}`) : baseLabel;
    const color = isApproval ? 'var(--late)' : isRevision ? 'var(--gold)' : 'var(--copper)';
    const hit = buckets.find((b) => b.key === key);
    if (hit) hit.days += days;
    else buckets.push({ key, label, days, late: isApproval, color });
  }
  const totalDays = buckets.reduce((a, b) => a + b.days, 0);
  const approvalDays = buckets.filter((b) => b.late).reduce((a, b) => a + b.days, 0);
  const reviewDominates = totalDays > 0 && approvalDays > totalDays / 2;

  /* ── «القواعد السارية» from the pinned path ──────────────────────── */

  const ruleLines: ReactNode[] = [];
  for (const s of ordered.filter((x) => x.is_approval)) {
    const kind = s.approval_kind ? APPROVAL_KIND_LABELS[s.approval_kind] : null;
    ruleLines.push(
      <span key={`ap-${s.id}`}>
        {isAr
          ? <>الاعتماد {kind && <b>{kind.ar}</b>} ل{roleLabel(s.role)}</>
          : <>The {kind && <b>{kind.en}</b>} approval sits with the {roleLabel(s.role)}</>}
      </span>,
    );
  }
  if (ordered.some((s) => s.is_approval && s.require_note_on_reject)) {
    ruleLines.push(
      <span key="note">{isAr ? 'الرفض يستلزم ملاحظة' : 'A rejection requires a note'}</span>,
    );
  }
  if (ordered.some((s) => s.creates_revision)) {
    ruleLines.push(
      <span key="rev">{isAr ? 'الرفض يُنشئ مهمة تعديل' : 'A rejection opens a revision task'}</span>,
      <span key="back">{isAr ? 'التعديل يعود للدور الذي أرسل' : 'The revision returns to the role that submitted'}</span>,
    );
  }
  const dueValues = [...new Set(ordered.map((s) => s.due_days))].sort((a, b) => a - b);
  if (dueValues.length === 1 && dueValues[0] !== undefined) {
    ruleLines.push(
      <span key="due">
        {isAr
          ? `استحقاق المهمة ${afterDays(dueValues[0], true)} من فتحها`
          : `A task falls due ${afterDays(dueValues[0], false).replace('after ', '')} after it opens`}
      </span>,
    );
  } else if (dueValues.length > 1) {
    ruleLines.push(
      <span key="due">
        {isAr
          ? `استحقاق المهمة بين ${num(dueValues[0] ?? 0, true)} و${num(dueValues[dueValues.length - 1] ?? 0, true)} أيام من فتحها`
          : `Tasks fall due ${dueValues[0]}–${dueValues[dueValues.length - 1]} days after opening`}
      </span>,
    );
  }
  ruleLines.push(
    <span key="late">
      {isAr ? 'المتأخرة تُشعر الدور، ثم مشرف العمليات' : 'A late task notifies the role, then the operations supervisor'}
    </span>,
  );

  /* ── render ──────────────────────────────────────────────────────── */

  return (
    <div className="cd2-split">
      <div style={{ minWidth: 0 }}>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-h">
            <h4>{isAr ? 'سلسلة المهام' : 'The task chain'}</h4>
            <span className="r">
              {isAr
                ? 'يولّدها مسار العمل · لا أحد يُسندها يدويًا'
                : 'generated by the workflow · nobody assigns these by hand'}
            </span>
          </div>
          {chron.length === 0 && futureSteps.length === 0 ? (
            <p style={{ padding: 20, textAlign: 'center', fontSize: 12.5, color: 'var(--mute)' }}>
              {isAr ? 'لا مهام بعد — هذا العنصر خارج أي مسار.' : 'No tasks yet — this item is on no path.'}
            </p>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>{isAr ? 'المهمة' : 'The task'}</th>
                    <th style={{ width: 126 }}>{isAr ? 'الدور' : 'Role'}</th>
                    <th style={{ width: 124 }}>{isAr ? 'المُسندة إلى' : 'Assigned to'}</th>
                    <th style={{ width: 150 }}>{isAr ? 'النتيجة' : 'Result'}</th>
                    <th style={{ width: 88 }}>{isAr ? 'الإغلاق' : 'Closed'}</th>
                  </tr>
                </thead>
                <tbody>
                  {chron.map((t, i) => {
                    const s = stepById.get(t.step_id ?? '') ?? null;
                    const label = s ? (isAr ? s.label_ar : s.label_en) : isAr ? 'مهمة' : 'Task';
                    const prev = i > 0 ? chron[i - 1] : undefined;
                    const isChild = prev?.result === 'changes_requested';
                    const isOpen = t.status === 'open';
                    const rejected = t.result === 'changes_requested';
                    const lateBy = isOpen && t.due_at && new Date(t.due_at).getTime() < Date.now()
                      ? daysAgo(t.due_at, isAr)
                      : null;
                    const roundSuffix = s?.is_approval
                      ? isAr ? ` · الجولة ${num(t.round, true)}` : ` · round ${t.round}`
                      : '';
                    return (
                      <tr
                        key={t.id}
                        className={rejected ? 'cd2-rejected' : isOpen ? 'hl' : undefined}
                      >
                        <td className={isChild ? 'cd2-child-arrow' : undefined}>
                          {isChild ? (
                            '↳'
                          ) : isOpen ? (
                            <span className="pill p-now" style={{ padding: '3px 5px' }}>●</span>
                          ) : rejected ? (
                            <span className="pill p-late" style={{ padding: '3px 5px' }}><IconX /></span>
                          ) : (
                            <span className="pill p-go" style={{ padding: '3px 5px' }}><IconCheck /></span>
                          )}
                        </td>
                        <td className={`ttl${isChild ? ' cd2-child-title' : ''}`}>
                          {isChild
                            ? isAr ? `تعديل ${label}` : `Revise ${label}`
                            : label}
                          {roundSuffix && (
                            <span style={{ fontWeight: 400, color: 'var(--mute)' }}>{roundSuffix}</span>
                          )}
                          {isChild && (
                            <div className="cd2-sub">
                              {isAr
                                ? 'أنشأها الرفض تلقائيًا · الملاحظة منقولة معها'
                                : 'opened automatically by the rejection · the note travels with it'}
                            </div>
                          )}
                          {rejected && t.note && (
                            <div className="cd2-sub" style={{ color: 'var(--late)' }}>«{t.note}»</div>
                          )}
                        </td>
                        <td>{roleLabel(t.role)}</td>
                        <td>{assigneeCell(t.role, t.assignee_user_id)}</td>
                        <td>
                          {isOpen ? (
                            lateBy ? (
                              <Pill tone="wait">{isAr ? `مفتوحة · متأخرة ${lateBy}` : `Open · ${lateBy} late`}</Pill>
                            ) : (
                              <Pill tone="now">{isAr ? 'مفتوحة' : 'Open'}</Pill>
                            )
                          ) : (
                            resultPill(t, s)
                          )}
                        </td>
                        <td style={{ color: 'var(--mute)' }}>
                          {t.closed_at ? shortDate(t.closed_at, isAr) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                  {/* Dimmed FUTURE steps — the pinned path's remainder. */}
                  {futureSteps.map((s) => (
                    <tr key={`f-${s.id}`} className="cd2-future">
                      <td style={{ textAlign: 'center', color: 'var(--mute)' }}>○</td>
                      <td className="ttl" style={{ color: 'var(--mute)' }}>
                        {isAr ? s.label_ar : s.label_en}
                      </td>
                      <td>{roleLabel(s.role)}</td>
                      <td>{assigneeCell(s.role, null)}</td>
                      <td><Pill tone="idle">{isAr ? 'لم تبدأ' : 'Not started'}</Pill></td>
                      <td style={{ color: 'var(--mute)' }}>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="grid g2">
          {/* Inline approval card — only when the open step is an approval MY
              role may act on. No disabled refusals (screen 36). */}
          {isApprovalNow && canApprove && openTask && currentStep && (
            <div className="card">
              <div className="card-h">
                <h4>
                  {isAr
                    ? `الاعتماد — الجولة ${num(openTask.round, true)}`
                    : `The approval — round ${openTask.round}`}
                </h4>
                <span className="r">
                  {isAr ? `${holderOf(currentStep.role)} فقط` : `${holderOf(currentStep.role)} only`}
                </span>
              </div>
              <div className="card-b">
                {requiredFields.map((f) => (
                  <Check key={f} ok={filled(f)}>{fieldLabel(f, isAr)}</Check>
                ))}
                {/* required_files are checked against data presence too — files
                    live as URLs/entries in the item data, same rule as fields. */}
                {requiredFiles.map((f) => (
                  <Check key={`file-${f}`} ok={filled(f)}>
                    {isAr ? `الملف «${fieldLabel(f, true)}» مرفوع` : `File “${fieldLabel(f, false)}” attached`}
                  </Check>
                ))}
                {scenes.length > 0 && (
                  <Check ok={scenesSettled}>
                    {isAr ? 'المواد المطلوبة محددة' : 'Required material identified'}
                  </Check>
                )}
                <input
                  className="inp"
                  style={{ width: '100%', marginTop: 12, fontSize: 12 }}
                  placeholder={isAr ? 'ملاحظة الاعتماد · اختيارية' : 'Approval note · optional'}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
                  <button
                    type="button"
                    className="btn btn-go"
                    style={{ flex: 1, justifyContent: 'center' }}
                    disabled={busy}
                    onClick={() => void approve()}
                  >
                    {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'اعتماد' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    style={{ flex: 1, justifyContent: 'center' }}
                    disabled={busy}
                    onClick={() => onRequestChanges?.()}
                  >
                    {isAr ? 'طلب تعديلات' : 'Request changes'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 10, lineHeight: 1.75 }}>
                  {nextStep ? (
                    isAr ? (
                      <>عند الاعتماد ← تُفتح <b style={{ color: 'var(--ink)' }}>{nextStep.label_ar}</b> ل{holderOf(nextStep.role)}، استحقاق {afterDays(nextStep.due_days, true)}.</>
                    ) : (
                      <>On approval → <b style={{ color: 'var(--ink)' }}>{nextStep.label_en}</b> opens for {holderOf(nextStep.role)}, due {afterDays(nextStep.due_days, false)}.</>
                    )
                  ) : (
                    isAr
                      ? <>عند الاعتماد ← يُقفل المسار — هذه آخر خطوة.</>
                      : <>On approval → the path closes — this is the last stage.</>
                  )}
                  <br />
                  {returnStep && (
                    isAr
                      ? <>عند طلب التعديلات ← تعود مهمة تعديل ل{holderOf(returnStep.role)}، وملاحظتك إلزامية.</>
                      : <>On requesting changes → a revision task returns to {holderOf(returnStep.role)}, and your note is required.</>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* «أين ذهب الوقت» — the honest report. */}
          {buckets.length > 0 && (
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'أين ذهب الوقت' : 'Where the time went'}</h4>
                <span className="r">
                  {isAr
                    ? `${elapsedDays(Math.round(totalDays), true)} منقضية`
                    : `${elapsedDays(Math.round(totalDays), false)} elapsed`}
                </span>
              </div>
              <div className="card-b" style={{ display: 'grid', gap: 9 }}>
                {buckets.map((b) => (
                  <div key={b.key} className="cd2-time-row">
                    <div className="cd2-time-h">
                      <span>{b.label}</span>
                      <span style={b.late
                        ? { color: 'var(--late)', fontWeight: 700 }
                        : { color: 'var(--mute)' }}
                      >
                        {elapsedDays(Math.round(b.days), isAr)}
                      </span>
                    </div>
                    <div className="meter" style={{ marginTop: 4 }}>
                      <i style={{
                        width: `${totalDays > 0 ? Math.max(2, (b.days / totalDays) * 100) : 2}%`,
                        background: b.color,
                      }}
                      />
                    </div>
                  </div>
                ))}
                {reviewDominates && (
                  <div
                    style={{
                      fontSize: 11.5, color: 'var(--ink-2)', marginTop: 4,
                      paddingTop: 10, borderTop: '1px solid var(--line-soft)', lineHeight: 1.75,
                    }}
                  >
                    {isAr
                      ? 'أكثر من نصف الوقت المنقضي على هذا السجل هو تأخير مراجعة، لا إنتاج. هذا النمط عبر كل المحتوى هو تقرير يوم الأحد لمشرف العمليات.'
                      : 'More than half the elapsed time on this record is review delay, not production. That pattern across all content is the operations supervisor’s Sunday report.'}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── the tab's own side column — the pinned rules, verbatim shape ── */}
      <div>
        <div className="lbl" style={{ marginBottom: 11 }}>
          {isAr ? 'القواعد السارية' : 'The rules in force'}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--ink-2)' }}>
          {ruleLines.map((line, i) => (
            <div key={i} className="rule">
              <span className="arw">←</span>
              {line}
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--line-soft)',
            fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.75,
          }}
        >
          {isAr
            ? 'هذه من تعريف مسار العمل في الإعدادات — تغييرها هناك يغيّر سلوك كل سجل جديد، ويترك السجلات الجارية كما هي.'
            : 'These come from the workflow definition in Settings — changing it there changes every NEW record, and leaves in-flight ones exactly as they are.'}
        </div>
        {doneCount > 0 && (
          <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr
              ? `${num(tasks.length, true)} مهام · ${num(doneCount, true)} منجزة`
              : `${tasks.length} tasks · ${doneCount} done`}
          </div>
        )}
      </div>
    </div>
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
