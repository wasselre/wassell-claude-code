import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Plus, Play, Pause, Pencil, Trash2, Clock, History } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import Button from '@/components/ui/Button';
import ScheduledReportModal from './components/ScheduledReportModal';
import type { ScheduledReport, ScheduledReportRun } from '@/types';

export default function ScheduledReportsPage() {
  const { scheduledReports, dashboards, metricDefinitions, language, saveScheduledReport, deleteScheduledReport, addToast } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();

  const [reports, setReports] = useState<ScheduledReport[]>(scheduledReports);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledReport | undefined>();
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduledReportRun[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.from('scheduled_reports').select('*').order('created_at', { ascending: false });
    if (data) setReports(data as ScheduledReport[]);
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);
  useEffect(() => { setReports(scheduledReports); }, [scheduledReports]);

  const sourceLabel = (r: ScheduledReport): string => {
    if (r.source_type === 'dashboard') return (isAr ? 'لوحة: ' : 'Dashboard: ') + (dashboards.find((d) => d.id === r.dashboard_id)?.[isAr ? 'label_ar' : 'label_en'] ?? '—');
    if (r.source_type === 'widget') return isAr ? 'عنصر لوحة' : 'Dashboard widget';
    if (r.source_type === 'metric') return (isAr ? 'مقياس: ' : 'Metric: ') + (metricDefinitions.find((m) => m.id === r.metric_id)?.[isAr ? 'label_ar' : 'label_en'] ?? '—');
    return isAr ? 'استعلام مخصص' : 'Custom query';
  };
  const scheduleLabel = (r: ScheduledReport): string => {
    const h = `${String(r.hour_of_day).padStart(2, '0')}:00`;
    if (r.frequency === 'daily') return `${isAr ? 'يومياً' : 'Daily'} ${h}`;
    if (r.frequency === 'weekly') {
      const days = isAr ? ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `${isAr ? 'أسبوعياً' : 'Weekly'} ${days[r.day_of_week ?? 0]} ${h}`;
    }
    return `${isAr ? 'شهرياً يوم' : 'Monthly day'} ${r.day_of_month ?? 1} ${h}`;
  };
  const fmtDate = (s?: string | null): string => (s ? new Date(s).toLocaleString(isAr ? 'ar' : 'en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'short', timeStyle: 'short' }) : '—');

  const statusBadge = (r: ScheduledReport): JSX.Element => {
    const map: Record<string, [string, string]> = {
      active: ['#15803d', isAr ? 'نشط' : 'Active'],
      paused: ['#9ca3af', isAr ? 'متوقف' : 'Paused'],
      running: ['#B8734F', isAr ? 'قيد التشغيل' : 'Running'],
      error: ['#b91c1c', isAr ? 'خطأ' : 'Error'],
    };
    const [color, label] = map[r.status] ?? ['#9ca3af', r.status];
    return <span style={{ color }} className="rounded-full px-2 py-0.5 text-[11px] font-bold" >{label}</span>;
  };

  const runNow = async (r: ScheduledReport) => {
    if (!supabase) return;
    setBusyId(r.id);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch('/api/scheduled-reports/run-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ report_id: r.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast(`${isAr ? 'فشل التشغيل' : 'Run failed'}: ${body.error ?? res.status}`, 'error');
      } else {
        const result = body.result ?? {};
        const verb = result.status === 'sent' ? (isAr ? 'أُرسل' : 'sent') : result.status === 'draft' ? (isAr ? 'مسودة' : 'draft') : result.status === 'failed' ? (isAr ? 'فشل' : 'failed') : result.status;
        addToast(`${isAr ? 'التشغيل' : 'Run'}: ${verb}${result.error ? ` — ${result.error}` : ''}`, result.status === 'failed' ? 'error' : 'success');
      }
    } catch (e) {
      addToast(`${isAr ? 'تعذّر الاتصال' : 'Network error'}: ${e instanceof Error ? e.message : ''}`, 'error');
    } finally {
      setBusyId(null);
      await refetch();
    }
  };

  const toggle = (r: ScheduledReport) => {
    saveScheduledReport({ ...r, status: r.status === 'paused' ? 'active' : 'paused', updated_at: new Date().toISOString() });
    setTimeout(() => void refetch(), 300);
  };
  const remove = (r: ScheduledReport) => {
    if (!window.confirm(isAr ? `حذف "${r.title}"؟` : `Delete "${r.title}"?`)) return;
    deleteScheduledReport(r.id);
    setReports((rs) => rs.filter((x) => x.id !== r.id));
  };
  const viewRuns = async (r: ScheduledReport) => {
    setRunsFor(r.id);
    setRuns([]);
    if (!supabase) return;
    const { data } = await supabase.from('scheduled_report_runs').select('*').eq('report_id', r.id).order('started_at', { ascending: false }).limit(10);
    if (data) setRuns(data as ScheduledReportRun[]);
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/dashboards')} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream"><ArrowRight size={18} className={isAr ? '' : 'rotate-180'} /></button>
          <h1 className="text-xl font-bold text-chocolate">{isAr ? 'التقارير المجدولة' : 'Scheduled Reports'}</h1>
        </div>
        <Button onClick={() => { setEditing(undefined); setModalOpen(true); }}><Plus size={16} /> {isAr ? 'تقرير جديد' : 'New report'}</Button>
      </div>

      {reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-sand/60 py-16 text-center text-charcoal/40">
          <Clock size={28} className="mx-auto mb-3 opacity-40" />
          <p className="font-bold">{isAr ? 'لا توجد تقارير مجدولة' : 'No scheduled reports yet'}</p>
          <p className="mt-1 text-sm">{isAr ? 'أنشئ تقريراً من لوحة أو مقياس ليصلك بالبريد على جدول.' : 'Create one from a dashboard or metric to get it emailed on a schedule.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reports.map((r) => (
            <div key={r.id} className="rounded-xl border border-sand/30 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-charcoal">{r.title}</span>
                    {statusBadge(r)}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-charcoal/55">
                    <span>{sourceLabel(r)}</span>
                    <span>· {scheduleLabel(r)}</span>
                    <span>· {isAr ? 'التالي' : 'Next'}: {fmtDate(r.next_run_at)}</span>
                    <span>· {(r.recipients ?? []).length} {isAr ? 'مستلم' : 'recipients'}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-charcoal/45">
                    {isAr ? 'آخر تشغيل' : 'Last run'}: {fmtDate(r.last_run_at)} {r.last_status ? `(${r.last_status})` : ''}
                    {r.error_message && <span className="text-red-500"> — {r.error_message}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button title={isAr ? 'تشغيل الآن' : 'Run now'} disabled={busyId === r.id} onClick={() => runNow(r)} className="rounded p-1.5 text-copper hover:bg-copper/10 disabled:opacity-40"><Play size={15} /></button>
                  <button title={r.status === 'paused' ? (isAr ? 'استئناف' : 'Resume') : (isAr ? 'إيقاف' : 'Pause')} onClick={() => toggle(r)} className="rounded p-1.5 text-charcoal/50 hover:bg-cream">{r.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}</button>
                  <button title={isAr ? 'السجل' : 'Run history'} onClick={() => viewRuns(r)} className="rounded p-1.5 text-charcoal/50 hover:bg-cream"><History size={15} /></button>
                  <button title={isAr ? 'تعديل' : 'Edit'} onClick={() => { setEditing(r); setModalOpen(true); }} className="rounded p-1.5 text-charcoal/50 hover:bg-cream"><Pencil size={15} /></button>
                  <button title={isAr ? 'حذف' : 'Delete'} onClick={() => remove(r)} className="rounded p-1.5 text-charcoal/30 hover:bg-red-50 hover:text-red-500"><Trash2 size={15} /></button>
                </div>
              </div>

              {runsFor === r.id && (
                <div className="mt-3 border-t border-sand/30 pt-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] font-bold text-charcoal/50">
                    <span>{isAr ? 'آخر عمليات التشغيل' : 'Recent runs'}</span>
                    <button onClick={() => setRunsFor(null)} className="hover:text-charcoal">{isAr ? 'إغلاق' : 'close'}</button>
                  </div>
                  {runs.length === 0 ? <div className="text-[11px] text-charcoal/40">{isAr ? 'لا سجل بعد' : 'No runs yet'}</div> : (
                    <table className="w-full text-[11px]">
                      <tbody>
                        {runs.map((run) => (
                          <tr key={run.id} className="border-b border-sand/20">
                            <td className="py-1 text-charcoal/60">{fmtDate(run.started_at)}</td>
                            <td className="py-1 font-bold text-charcoal/80">{run.status}{run.triggered_by === 'manual' ? ` (${isAr ? 'يدوي' : 'manual'})` : ''}</td>
                            <td className="py-1 text-charcoal/50">{run.delivery ?? ''}</td>
                            <td className="py-1 text-red-500">{run.error_message ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ScheduledReportModal open={modalOpen} onClose={() => { setModalOpen(false); setTimeout(() => void refetch(), 300); }} existing={editing} />
    </div>
  );
}
