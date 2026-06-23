import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { useSv, optOf, fmtDateTime, clientNameOf, Fact, Pill, SectionCard } from './components/shared';

export default function CorrectionDetailPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const { isAr, m, rows, resolveUser } = useSv();
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const task = rows(m.tasks).find((t) => t.id === recordId) ?? null;
  const clientRows = rows(m.clients);

  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(task?.data ?? {}) }));
  const [saving, setSaving] = useState(false);
  const seededRef = useRef<string | null>(null);
  const versionRef = useRef<number | null>(task?.version ?? null);
  useEffect(() => {
    if (task && seededRef.current !== task.id) {
      seededRef.current = task.id;
      versionRef.current = task.version ?? null;
      setDraft({ ...task.data });
    }
  }, [task]);

  if (!task) return <div className="p-6 text-[#8E4E3A]">{isAr ? 'المهمة غير موجودة' : 'Task not found'}</div>;

  const d = draft;
  const reviewId = typeof d.valuation_review === 'string' ? d.valuation_review : '';
  const followupId = typeof d.follow_up === 'string' ? d.follow_up : '';
  const status = optOf(m.tasks, 'task_status', d.task_status, isAr);
  const approval = optOf(m.tasks, 'manager_approval', d.manager_approval, isAr);

  async function save(patch: Record<string, unknown>) {
    if (!task) return;
    setSaving(true);
    const data = { ...draft, ...patch };
    setDraft(data);
    const res = await saveRecord({ ...task, data, updated_at: new Date().toISOString() }, { expectedVersion: versionRef.current });
    setSaving(false);
    if (res.status === 'conflict') { addToast(isAr ? 'تم التعديل من مستخدم آخر — حدّث الصفحة' : 'Edited elsewhere — reload', 'error'); return; }
    if (versionRef.current != null) versionRef.current += 1;
    addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
  }

  return (
    <div className="mx-auto max-w-[900px] p-4 sm:p-6 space-y-5">
      <button type="button" onClick={() => navigate('/model/sales_correction_tasks')}
        className="inline-flex items-center gap-1 text-sm font-semibold text-terracotta hover:underline">
        <ArrowLeft size={15} className={isAr ? 'rotate-180' : ''} /> {isAr ? 'رجوع للوحة' : 'Back to board'}
      </button>

      <SectionCard title={isAr ? 'سياق المهمة' : 'Task Context'}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Fact label={isAr ? 'العميل' : 'Client'} value={<span className="text-base font-bold text-chocolate">{clientNameOf(task, clientRows)}</span>} />
          <Fact label={isAr ? 'مندوب المبيعات' : 'Sales Rep'} value={resolveUser(d.sales_rep)} />
          <Fact label={isAr ? 'مدير المبيعات' : 'Sales Manager'} value={resolveUser(d.sales_manager)} />
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {reviewId && <Button variant="secondary" onClick={() => navigate(`/model/sales_valuation_reviews/${reviewId}`)}><ExternalLink size={15} /> {isAr ? 'فتح التقييم المرتبط' : 'Open linked review'}</Button>}
          {followupId && <Button variant="secondary" onClick={() => navigate(`/model/followups/${followupId}`)}><ExternalLink size={15} /> {isAr ? 'فتح المتابعة الأصلية' : 'Open follow-up'}</Button>}
        </div>
      </SectionCard>

      <SectionCard title={isAr ? 'الإجراء المطلوب' : 'Required Action'} action={<Pill label={status.label} color={status.color} />}>
        <div className="rounded-xl bg-cream/60 border border-sand/30 px-4 py-3 text-sm text-charcoal whitespace-pre-wrap min-h-[3rem]">
          {(d.required_action as string) || '—'}
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Fact label={isAr ? 'تاريخ الاستحقاق' : 'Due Date'} value={fmtDateTime(d.due_date, isAr)} />
          <Fact label={isAr ? 'تاريخ الإكمال' : 'Completed At'} value={fmtDateTime(d.completed_at, isAr)} />
        </div>
      </SectionCard>

      <SectionCard title={isAr ? 'رد المندوب' : 'Rep Response'}>
        <textarea value={(d.rep_note as string) ?? ''} rows={3} className="form-input w-full"
          placeholder={isAr ? 'اكتب ملاحظتك حول التصحيح…' : 'Note about the correction…'}
          onChange={(e) => setDraft((x) => ({ ...x, rep_note: e.target.value }))} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={saving} onClick={() => save({ rep_note: d.rep_note })}>{isAr ? 'حفظ الملاحظة' : 'Save Note'}</Button>
          {d.task_status !== 'in_progress' && d.task_status !== 'done' && (
            <Button variant="secondary" disabled={saving} onClick={() => save({ task_status: 'in_progress' })}>{isAr ? 'بدء التنفيذ' : 'Start'}</Button>
          )}
          {d.task_status !== 'done' && (
            <Button disabled={saving} onClick={() => save({ task_status: 'done', completed_at: new Date().toISOString() })}>{isAr ? 'تم التنفيذ' : 'Mark Done'}</Button>
          )}
        </div>
      </SectionCard>

      <SectionCard title={isAr ? 'اعتماد المدير' : 'Manager Approval'} action={<Pill label={approval.label} color={approval.color} />}>
        <div className="flex flex-wrap gap-2">
          <Button disabled={saving} onClick={() => save({ manager_approval: 'approved' })}>{isAr ? 'اعتماد' : 'Approve'}</Button>
          <Button variant="danger" disabled={saving} onClick={() => save({ manager_approval: 'rejected' })}>{isAr ? 'رفض' : 'Reject'}</Button>
        </div>
      </SectionCard>

      <div className="border-t border-sand/60 pt-3">
        <button type="button" onClick={() => navigate(`/model/sales_correction_tasks/${task.id}?generic=1`)}
          className="text-xs font-semibold text-copper hover:underline">{isAr ? 'الحقول المتقدمة (نموذج كامل)' : 'Advanced fields (full form)'}</button>
      </div>
    </div>
  );
}
