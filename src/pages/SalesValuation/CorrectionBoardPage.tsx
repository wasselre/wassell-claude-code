import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Check, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { useSv, optOf, fmtDateTime, clientNameOf, Pill, PageHeader } from './components/shared';

const COLUMNS: { value: string; tone: string }[] = [
  { value: 'open', tone: '#C09B5F' },
  { value: 'in_progress', tone: '#3B82F6' },
  { value: 'overdue', tone: '#EF4444' },
  { value: 'done', tone: '#10B981' },
  { value: 'cancelled', tone: '#6B7280' },
];

export default function CorrectionBoardPage() {
  const { isAr, m, rows, resolveUser } = useSv();
  const navigate = useNavigate();
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const tasks = rows(m.tasks);
  const clientRows = rows(m.clients);

  const byStatus = useMemo(() => {
    const map: Record<string, AppRecord[]> = {};
    for (const c of COLUMNS) map[c.value] = [];
    for (const t of tasks) {
      const s = (t.data.task_status as string) || 'open';
      (map[s] ?? (map[s] = [])).push(t);
    }
    for (const k of Object.keys(map)) map[k]?.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return map;
  }, [tasks]);

  async function setApproval(task: AppRecord, approval: 'approved' | 'rejected') {
    const data = { ...task.data, manager_approval: approval };
    const res = await saveRecord({ ...task, data, updated_at: new Date().toISOString() }, { expectedVersion: task.version ?? null });
    if (res.status === 'conflict') { addToast(isAr ? 'تم التعديل من مستخدم آخر — حدّث الصفحة' : 'Edited elsewhere — reload', 'error'); return; }
    addToast(approval === 'approved' ? (isAr ? 'تم اعتماد التصحيح' : 'Approved') : (isAr ? 'تم رفض التصحيح' : 'Rejected'), 'success');
  }

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader title={isAr ? 'مهام تصحيح المبيعات' : 'Sales Correction Tasks'}
        subtitle={isAr ? 'لوحة متابعة مهام التصحيح' : 'Correction task board'} />

      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((col) => {
          const list = byStatus[col.value] ?? [];
          const colLabel = optOf(m.tasks, 'task_status', col.value, isAr).label;
          return (
            <div key={col.value} className="flex-shrink-0 w-[300px]">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="inline-flex items-center gap-2 text-sm font-bold text-charcoal">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: col.tone }} />
                  {colLabel}
                </span>
                <span className="text-xs font-semibold text-charcoal/50">{list.length}</span>
              </div>
              <div className="space-y-3">
                {list.length === 0 && (
                  <div className="rounded-xl border border-dashed border-sand/50 py-8 text-center text-xs text-charcoal/40">
                    {isAr ? 'لا توجد مهام' : 'No tasks'}
                  </div>
                )}
                {list.map((t) => {
                  const d = t.data;
                  const reviewId = typeof d.valuation_review === 'string' ? d.valuation_review : '';
                  const approval = optOf(m.tasks, 'manager_approval', d.manager_approval, isAr);
                  return (
                    <div key={t.id} className="card p-4 space-y-2 cursor-pointer hover:shadow-md transition-shadow"
                      onClick={() => navigate(`/model/sales_correction_tasks/${t.id}`)}>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-charcoal text-sm">{clientNameOf(t, clientRows)}</span>
                        <Pill label={approval.label} color={approval.color} />
                      </div>
                      <p className="text-xs text-charcoal/70">{resolveUser(d.sales_rep)}</p>
                      <p className="text-sm text-charcoal line-clamp-3">{(d.required_action as string) || '—'}</p>
                      <p className="text-xs text-charcoal/55">{isAr ? 'الاستحقاق' : 'Due'}: {fmtDateTime(d.due_date, isAr)}</p>
                      <div className="flex items-center gap-1 pt-1" onClick={(e) => e.stopPropagation()}>
                        {reviewId && (
                          <button type="button" title={isAr ? 'فتح التقييم' : 'Open review'} onClick={() => navigate(`/model/sales_valuation_reviews/${reviewId}`)}
                            className="p-1.5 rounded-lg text-charcoal/60 hover:bg-copper/10 hover:text-copper"><ExternalLink size={14} /></button>
                        )}
                        <button type="button" title={isAr ? 'اعتماد التصحيح' : 'Approve'} onClick={() => setApproval(t, 'approved')}
                          className="p-1.5 rounded-lg text-green-600 hover:bg-green-50"><Check size={14} /></button>
                        <button type="button" title={isAr ? 'رفض التصحيح' : 'Reject'} onClick={() => setApproval(t, 'rejected')}
                          className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"><X size={14} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
