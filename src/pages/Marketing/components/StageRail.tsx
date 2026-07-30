/**
 * The stage rail — design screen 06, right column.
 *
 * The whole workflow, always visible, with the current step lit. Steps that
 * closed show WHO closed them and when; steps ahead show only the role, because
 * naming a person for work that hasn't started is a promise the system can't keep.
 */
import { MosStep, MosTask, ROLE_LABELS } from '@/lib/marketingOS/client';
import { IconCheck } from './icons';
import { num, shortDate } from '../lib/format';

export default function StageRail({
  steps, tasks, workflowLabel, isAr,
}: {
  steps: MosStep[];
  tasks: MosTask[];
  workflowLabel: string;
  isAr: boolean;
}) {
  const open = tasks.find((t) => t.status === 'open') ?? null;
  const currentPos = open
    ? steps.find((s) => s.id === open.step_id)?.position ?? -1
    : Number.POSITIVE_INFINITY;

  const lastClosed = (stepId: string): MosTask | null => {
    const done = tasks
      .filter((t) => t.step_id === stepId && t.status === 'done')
      .sort((a, b) => (a.closed_at ?? '').localeCompare(b.closed_at ?? ''));
    return done[done.length - 1] ?? null;
  };

  return (
    <div className="card" style={{ padding: '15px 15px 5px' }}>
      <div className="lbl" style={{ marginBottom: 13 }}>
        {isAr ? 'مسار العمل · ' : 'Workflow · '}{workflowLabel}
      </div>
      <div className="steps">
        {steps.map((s) => {
          const isCurrent = open?.step_id === s.id;
          const closed = lastClosed(s.id);
          const state = isCurrent ? 'cur' : s.position < currentPos && closed ? 'done' : 'pend';
          const roleLabel = ROLE_LABELS[s.role]
            ? isAr ? ROLE_LABELS[s.role].ar : ROLE_LABELS[s.role].en
            : s.role;

          let sub = roleLabel;
          if (state === 'done' && closed) {
            const verb = closed.result === 'approved'
              ? isAr ? 'اعتُمدت' : 'approved'
              : closed.result === 'changes_requested'
                ? isAr ? 'أُعيدت' : 'sent back'
                : isAr ? 'أُرسلت' : 'submitted';
            sub = `${verb} · ${roleLabel} · ${shortDate(closed.closed_at, isAr)}`;
          } else if (isCurrent && open) {
            sub = open.due_at
              ? `${roleLabel} · ${isAr ? 'الاستحقاق ' : 'due '}${shortDate(open.due_at, isAr)}`
              : roleLabel;
            if (open.round > 1) {
              sub += isAr ? ` · الجولة ${num(open.round, true)}` : ` · round ${open.round}`;
            }
          }

          return (
            <div key={s.id} className={`step ${state}`}>
              <span className="bar" />
              <span className="dot">{state === 'done' && <IconCheck />}</span>
              <div className="txt">
                <div className="nm">{isAr ? s.label_ar : s.label_en}</div>
                <div className="sub">{sub}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
