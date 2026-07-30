/**
 * The workflow stage rail — design screen 6.
 *
 * Every step of the item's workflow, with done / current / pending state. This
 * is the whole reason there is no status dropdown: the rail shows where the work
 * actually is, and it is read from the task chain rather than a field anyone can
 * set to whatever they like.
 */
import { Check } from 'lucide-react';
import { MosStep, MosTask, MosRole, ROLE_LABELS } from '@/lib/marketingOS/client';

interface Props {
  steps: MosStep[];
  tasks: MosTask[];
  isAr: boolean;
}

export default function StageRail({ steps, tasks, isAr }: Props) {
  const openTask = tasks.find((t) => t.status === 'open') ?? null;
  const currentPos = openTask
    ? steps.find((s) => s.id === openTask.step_id)?.position ?? 0
    : steps.length + 1; // nothing open → everything behind us

  /** Closed tasks per step, so a step that came back twice can say so. */
  const roundsFor = (stepId: string): number =>
    tasks.filter((t) => t.step_id === stepId && t.status === 'done').length;

  return (
    <div className="rounded-xl border border-sand bg-white p-4">
      <h3 className="mb-3 text-xs font-bold text-charcoal/50">
        {isAr ? 'مسار العمل' : 'Workflow'}
      </h3>
      <ol className="space-y-0">
        {steps.map((step, i) => {
          const done = step.position < currentPos;
          const current = openTask?.step_id === step.id;
          const rounds = roundsFor(step.id);
          const isLast = i === steps.length - 1;

          return (
            <li key={step.id} className="relative flex gap-3">
              {/* connector */}
              {!isLast && (
                <span
                  aria-hidden
                  className={`absolute top-5 h-full w-px ${done ? 'bg-green-600/40' : 'bg-sand'}`}
                  style={{ insetInlineStart: '0.5rem' }}
                />
              )}
              <span
                className={`relative z-10 mt-0.5 grid h-4 w-4 flex-none place-items-center rounded-full border ${
                  current
                    ? 'border-copper bg-copper ring-4 ring-copper/15'
                    : done
                      ? 'border-green-600 bg-green-50'
                      : 'border-sand bg-white'
                }`}
              >
                {done && <Check className="h-2.5 w-2.5 text-green-700" strokeWidth={3} />}
              </span>
              <div className="pb-4">
                <div
                  className={`text-xs ${
                    current ? 'font-bold text-copper' : done ? 'font-semibold' : 'text-charcoal/45'
                  }`}
                >
                  {isAr ? step.label_ar : step.label_en}
                </div>
                <div className="mt-0.5 text-[11px] text-charcoal/45">
                  {isAr ? ROLE_LABELS[step.role as MosRole].ar : ROLE_LABELS[step.role as MosRole].en}
                  {step.is_approval && (
                    <span className="ms-1.5 rounded bg-cream px-1 py-px text-[10px]">
                      {step.approval_kind === 'process'
                        ? isAr ? 'اعتماد إجرائي' : 'process'
                        : step.approval_kind === 'budget'
                          ? isAr ? 'اعتماد ميزانية' : 'budget'
                          : isAr ? 'اعتماد إبداعي' : 'creative'}
                    </span>
                  )}
                  {rounds > 1 && (
                    <span className="ms-1.5 font-semibold text-amber-700">
                      {isAr ? `${rounds} جولات` : `${rounds} rounds`}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
