import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';
import { useSv, optOf, clientNameOf, KpiCard, Pill, SectionCard, PageHeader } from './components/shared';

const dayKey = (v: unknown, fallback: string): string => {
  if (typeof v === 'string' && v) {
    const dt = new Date(v);
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  return fallback.slice(0, 10);
};

export default function CoachingPage() {
  const { isAr, m, rows, resolveUser } = useSv();
  const navigate = useNavigate();
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const summaries = useMemo(
    () => [...rows(m.daily)].sort((a, b) => String(b.data.valuation_date).localeCompare(String(a.data.valuation_date))),
    [m.daily, rows],
  );
  const [selId, setSelId] = useState<string | null>(null);
  const sel = summaries.find((s) => s.id === selId) ?? summaries[0] ?? null;

  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const categoryName = (id: unknown): string => {
    const c = typeof id === 'string' ? rows(m.categories).find((x) => x.id === id) : null;
    return (c?.data.category_name as string) || '—';
  };

  const dateStr = sel ? dayKey(sel.data.valuation_date, sel.created_at) : '';
  const repId = sel?.data.sales_rep;

  const mistakeReviews = useMemo(() => {
    if (!sel) return [] as AppRecord[];
    return rows(m.reviews).filter((r) => {
      const d = r.data;
      return d.sales_rep === repId
        && dayKey(d.review_date, r.created_at) === dateStr
        && (d.review_outcome === 'minor' || d.review_outcome === 'major' || d.review_outcome === 'critical');
    });
  }, [m.reviews, rows, sel, repId, dateStr]);

  const openTasks = useMemo(() => {
    if (!sel) return [] as AppRecord[];
    return rows(m.tasks).filter((t) => t.data.sales_rep === repId && ['open', 'in_progress', 'overdue'].includes(t.data.task_status as string));
  }, [m.tasks, rows, sel, repId]);

  if (!sel) {
    return (
      <div className="mx-auto max-w-[1100px] p-4 sm:p-6">
        <PageHeader title={isAr ? 'التوجيه اليومي للمبيعات' : 'Daily Sales Coaching'} />
        <div className="card p-10 text-center text-charcoal/50">{isAr ? 'لا يوجد توجيه يومي بعد. سيظهر بعد مراجعة متابعاتك.' : 'No daily coaching yet.'}</div>
      </div>
    );
  }

  const d = sel.data;
  const clientRows = rows(m.clients);

  async function repSave(patch: Record<string, unknown>) {
    if (!sel) return;
    setSaving(true);
    const res = await saveRecord({ ...sel, data: { ...sel.data, ...patch }, updated_at: new Date().toISOString() }, { expectedVersion: sel.version ?? null });
    setSaving(false);
    if (res.status === 'conflict') { addToast(isAr ? 'تم التعديل من مستخدم آخر — حدّث الصفحة' : 'Edited elsewhere — reload', 'error'); return; }
    addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
  }

  const summaryStatus = optOf(m.daily, 'summary_status', d.summary_status, isAr);

  return (
    <div className="mx-auto max-w-[1100px] p-4 sm:p-6 space-y-5">
      <PageHeader
        title={isAr ? 'التوجيه اليومي للمبيعات' : 'Daily Sales Coaching'}
        subtitle={`${resolveUser(repId)} · ${dateStr}`}
        right={summaries.length > 1 ? (
          <select value={sel.id} onChange={(e) => setSelId(e.target.value)} className="form-input text-sm w-auto min-w-[220px]">
            {summaries.map((s) => <option key={s.id} value={s.id}>{resolveUser(s.data.sales_rep)} · {dayKey(s.data.valuation_date, s.created_at)}</option>)}
          </select>
        ) : <Pill label={summaryStatus.label} color={summaryStatus.color} />}
      />

      {/* Top summary */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KpiCard label={isAr ? 'الدرجة اليومية' : 'Daily Score'} value={typeof d.average_score === 'number' ? d.average_score : '—'} tone="#10B981" />
        <KpiCard label={isAr ? 'متابعات مراجَعة' : 'Reviewed'} value={(d.total_reviewed as number) ?? 0} tone="#B8734F" />
        <KpiCard label={isAr ? 'عدد الملاحظات' : 'Mistakes'} value={(d.mistakes_found as number) ?? 0} tone="#F59E0B" />
        <KpiCard label={isAr ? 'متابعات صحيحة' : 'Correct'} value={(d.correct_follow_ups as number) ?? 0} tone="#10B981" />
        <KpiCard label={isAr ? 'مهام تصحيح مفتوحة' : 'Open Corrections'} value={(d.open_correction_tasks as number) ?? 0} tone="#8E4E3A" />
      </div>

      {/* Coaching card */}
      <SectionCard title={isAr ? 'توجيه المدير' : 'Manager Coaching'}>
        <Field label={isAr ? 'ملخص المدير' : 'Manager Summary'} value={(d.manager_summary as string) || (isAr ? 'لا يوجد ملخص بعد' : 'No summary yet')} />
        <Field label={isAr ? 'نقاط التحسين' : 'Improvement Points'} value={(d.improvement_points as string) || '—'} />
        <div className="text-sm"><span className="text-charcoal/55 me-2">{isAr ? 'التصنيف الأكثر تكراراً:' : 'Top mistake:'}</span><span className="font-semibold text-charcoal">{categoryName(d.main_mistake_category)}</span></div>
      </SectionCard>

      {/* Mistake examples */}
      <SectionCard title={isAr ? 'أمثلة الملاحظات اليوم' : "Today's Mistake Examples"}>
        {mistakeReviews.length === 0 ? (
          <p className="text-sm text-charcoal/50">{isAr ? 'لا توجد ملاحظات اليوم 🎉' : 'No mistakes today 🎉'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs font-semibold text-charcoal/55 border-b border-sand/40">
                <th className="text-start px-2 py-2">{isAr ? 'العميل' : 'Client'}</th>
                <th className="text-start px-2 py-2">{isAr ? 'النوع' : 'Type'}</th>
                <th className="text-start px-2 py-2">{isAr ? 'النتيجة' : 'Outcome'}</th>
                <th className="text-start px-2 py-2">{isAr ? 'تصنيف الخطأ' : 'Category'}</th>
                <th className="text-start px-2 py-2">{isAr ? 'ملاحظة تدريبية' : 'Coaching'}</th>
                <th className="px-2 py-2"></th>
              </tr></thead>
              <tbody>
                {mistakeReviews.map((r) => {
                  const rd = r.data;
                  const oc = optOf(m.reviews, 'review_outcome', rd.review_outcome, isAr);
                  return (
                    <tr key={r.id} className="border-b border-sand/20">
                      <td className="px-2 py-2 font-semibold">{clientNameOf(r, clientRows)}</td>
                      <td className="px-2 py-2">{optOf(m.reviews, 'followup_type', rd.followup_type, isAr).label}</td>
                      <td className="px-2 py-2"><Pill label={oc.label} color={oc.color} /></td>
                      <td className="px-2 py-2">{categoryName(rd.mistake_category)}</td>
                      <td className="px-2 py-2 text-charcoal/70 max-w-[260px] truncate">{(rd.coaching_note as string) || '—'}</td>
                      <td className="px-2 py-2">
                        <button type="button" title={isAr ? 'فتح التقييم' : 'Open'} onClick={() => navigate(`/model/sales_valuation_reviews/${r.id}`)}
                          className="p-1.5 rounded-lg text-charcoal/60 hover:bg-copper/10 hover:text-copper"><Eye size={15} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Open correction tasks */}
      <SectionCard title={isAr ? 'مهام التصحيح المفتوحة' : 'Open Correction Tasks'}>
        {openTasks.length === 0 ? (
          <p className="text-sm text-charcoal/50">{isAr ? 'لا توجد مهام مفتوحة' : 'No open tasks'}</p>
        ) : (
          <div className="space-y-2">
            {openTasks.map((t) => {
              const st = optOf(m.tasks, 'task_status', t.data.task_status, isAr);
              return (
                <div key={t.id} className="flex items-center justify-between rounded-xl border border-sand/30 bg-cream/40 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="font-semibold text-charcoal text-sm">{clientNameOf(t, clientRows)}</p>
                    <p className="text-xs text-charcoal/60 truncate max-w-[420px]">{(t.data.required_action as string) || '—'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill label={st.label} color={st.color} />
                    <Button variant="secondary" onClick={() => navigate(`/model/sales_correction_tasks/${t.id}`)}>{isAr ? 'فتح المهمة' : 'Open'}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      {/* Rep actions */}
      <SectionCard title={isAr ? 'إجراءاتي' : 'My Actions'}>
        {d.rep_acknowledged
          ? <p className="inline-flex items-center gap-1 text-sm font-semibold text-green-600"><CheckCircle2 size={16} /> {isAr ? 'تم الاطلاع على توجيه اليوم' : 'Acknowledged'}</p>
          : <p className="text-sm text-charcoal/60">{isAr ? 'يرجى الاطلاع على توجيه اليوم.' : 'Please acknowledge today’s coaching.'}</p>}
        <textarea value={note || (d.rep_notes as string) || ''} rows={2} className="form-input w-full"
          placeholder={isAr ? 'أضف ردّك (اختياري)…' : 'Add your response (optional)…'}
          onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={saving || Boolean(d.rep_acknowledged)} onClick={() => repSave({ rep_acknowledged: true, summary_status: 'acknowledged', rep_notes: note || d.rep_notes })}>
            {isAr ? 'أقرّ بالاطلاع' : 'Acknowledge'}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={() => repSave({ rep_notes: note })}>{isAr ? 'حفظ الرد' : 'Save Response'}</Button>
        </div>
        {mistakeReviews.length > 0 && (
          <p className="text-xs text-charcoal/50">{isAr ? 'للاعتراض على تقييم محدد، افتح التقييم من جدول الملاحظات أعلاه.' : 'To dispute a specific review, open it from the table above.'}</p>
        )}
      </SectionCard>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-charcoal/50 mb-1">{label}</p>
      <div className="rounded-xl bg-cream/60 border border-sand/30 px-4 py-3 text-sm text-charcoal whitespace-pre-wrap">{value}</div>
    </div>
  );
}
