/**
 * The current-task card — design screen 6, and the approval controls from
 * screen 10.
 *
 * This is the visual centre of the workspace on purpose: on any given day the
 * item has exactly one thing that needs doing, and it should be impossible to
 * miss. The buttons are role-conditional — an approver sees Approve / Request
 * changes, a producer sees Submit. Nobody sees a status dropdown.
 *
 * Requesting changes forces a note. That is enforced by a CHECK constraint in
 * the database too; this is the humane version of the same rule.
 */
import { useState } from 'react';
import { AlertCircle, Check, RotateCcw } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { MosRole, MosStep, MosTask, ROLE_LABELS } from '@/lib/marketingOS/client';

interface Props {
  task: MosTask | null;
  step: MosStep | null;
  myRole: MosRole;
  isAr: boolean;
  busy: boolean;
  onComplete: (result: 'submitted' | 'approved' | 'changes_requested', note?: string) => void;
}

export default function TaskPanel({ task, step, myRole, isAr, busy, onComplete }: Props) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  if (!task || !step) {
    return (
      <div className="rounded-xl border border-sand bg-white p-6 text-center">
        <p className="text-sm text-charcoal/60">
          {isAr
            ? 'لا توجد مهمة مفتوحة. اكتمل مسار هذا العنصر.'
            : 'No open task. This item has finished its workflow.'}
        </p>
      </div>
    );
  }

  // A person can act when their marketing role matches the step's role. Admins
  // and the marketing manager can always act — they carry every capability.
  const canAct =
    myRole === 'administrator' || myRole === 'marketing_manager' || myRole === step.role;

  const overdue = task.due_at ? new Date(task.due_at).getTime() < Date.now() : false;
  const daysLate = task.due_at
    ? Math.floor((Date.now() - new Date(task.due_at).getTime()) / 86_400_000)
    : 0;

  const submit = (result: 'submitted' | 'approved' | 'changes_requested', n?: string) => {
    onComplete(result, n);
    setRejecting(false);
    setNote('');
  };

  return (
    <>
      <div className="rounded-xl border border-copper/35 bg-copper/[0.06] p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-copper px-2 py-0.5 text-[11px] font-bold text-white">
            {isAr ? 'المهمة الحالية' : 'Current task'}
          </span>
          <h2 className="text-base font-bold">{isAr ? step.label_ar : step.label_en}</h2>
          {task.round > 1 && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">
              {isAr ? `الجولة ${task.round}` : `Round ${task.round}`}
            </span>
          )}
          {overdue && (
            <span className="ms-auto flex items-center gap-1 text-xs font-bold text-red-700">
              <AlertCircle className="h-3.5 w-3.5" />
              {isAr ? `متأخرة ${daysLate} يومًا` : `${daysLate} days late`}
            </span>
          )}
        </div>

        <p className="mt-2 text-xs text-charcoal/60">
          {isAr
            ? `الدور المسؤول: ${ROLE_LABELS[step.role].ar}`
            : `Responsible role: ${ROLE_LABELS[step.role].en}`}
          {step.is_approval && (
            <>
              {' · '}
              {isAr
                ? step.approval_kind === 'process'
                  ? 'اعتماد إجرائي'
                  : 'اعتماد إبداعي'
                : step.approval_kind === 'process'
                  ? 'process approval'
                  : 'creative approval'}
            </>
          )}
        </p>

        {/* the note that sent it back, if this is a revision round */}
        {task.round > 1 && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-3">
            <div className="text-[11px] font-bold text-red-800">
              {isAr ? 'أُعيدت مع ملاحظة' : 'Returned with a note'}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-charcoal/80">
              {isAr
                ? 'راجع سجل المهام أدناه لقراءة الملاحظة كاملة.'
                : 'See the task chain below for the full note.'}
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {!canAct ? (
            <p className="text-xs text-charcoal/50">
              {isAr
                ? `هذه المهمة لدى ${ROLE_LABELS[step.role].ar} — لا إجراء منك.`
                : `This sits with ${ROLE_LABELS[step.role].en} — nothing for you to do.`}
            </p>
          ) : step.is_approval ? (
            <>
              <Button onClick={() => submit('approved')} disabled={busy}>
                <Check className="h-4 w-4" />
                {isAr ? 'اعتماد' : 'Approve'}
              </Button>
              <Button variant="secondary" onClick={() => setRejecting(true)} disabled={busy}>
                <RotateCcw className="h-4 w-4" />
                {isAr ? 'طلب تعديلات' : 'Request changes'}
              </Button>
            </>
          ) : (
            <Button onClick={() => submit('submitted')} disabled={busy}>
              {isAr ? 'إرسال للمرحلة التالية' : 'Submit to next stage'}
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={isAr ? 'طلب تعديلات' : 'Request changes'}
        footer={
          <div className="flex items-center gap-2">
            <p className="me-auto text-xs text-charcoal/50">
              {isAr
                ? 'الملاحظة إلزامية — ترجع مع المهمة إلى الدور السابق.'
                : 'The note is required — it travels back with the task.'}
            </p>
            <Button variant="secondary" onClick={() => setRejecting(false)} disabled={busy}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button
              onClick={() => submit('changes_requested', note.trim())}
              disabled={busy || note.trim().length === 0}
            >
              {isAr ? 'إرجاع مع الملاحظة' : 'Send back'}
            </Button>
          </div>
        }
      >
        <label className="mb-1.5 block text-xs font-semibold text-charcoal/60">
          {isAr ? 'ما الذي يجب تعديله؟' : 'What needs to change?'}
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          className="form-input w-full"
          placeholder={
            isAr
              ? 'مثال: الافتتاحية تأخذ وقتًا طويلًا. ابدأ بادعاء الموقع في أول ٣ ثوانٍ.'
              : 'e.g. The hook takes too long. Lead with the location claim in the first 3 seconds.'
          }
        />
      </Modal>
    </>
  );
}
