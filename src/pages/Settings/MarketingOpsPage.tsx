// Marketing Intelligence — Operations & Monitoring dashboard.
// System status, provider/org/queue health, cost, freshness, diagnostics,
// historical KPIs, and operational alerts. All data comes from live production
// via /api/marketing ops_* actions (admin-gated). Read-only except: retry a
// failed job, ack/resolve an alert, and run the evaluator on demand.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Play, Activity, AlertTriangle, CheckCircle2, XCircle, RotateCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import BackToSettings from './components/BackToSettings';
import {
  fetchOpsDashboard, fetchOpsOrgHealth, fetchOpsAlerts, fetchOpsMetricsHistory, fetchOpsFailedJobs,
  setOpsAlertStatus, runOpsEvaluate, retryJob,
  type OpsDashboard, type OpsOrgHealth, type OpsAlert, type OpsMetricRow, type OpsFailedJob,
} from '@/lib/marketing/client';
import {
  providerBucket, providerCounts, overallSystemStatus, sortAlerts, isStale,
  metricSeries, sumMetric, duplicatePreventionRate, costSpikePct, ago, usd,
  type SystemStatus, type Bucket,
} from '@/lib/marketing/ops';

const BUCKET_CLS: Record<Bucket, string> = {
  healthy: 'bg-green-100 text-green-800',
  degraded: 'bg-amber-100 text-amber-800',
  offline: 'bg-red-100 text-red-800',
};
const SYS_CLS: Record<SystemStatus, string> = {
  healthy: 'bg-green-100 text-green-800 border-green-200',
  degraded: 'bg-amber-100 text-amber-800 border-amber-200',
  down: 'bg-red-100 text-red-800 border-red-200',
};
const DIAG_CLS: Record<string, string> = { ok: 'bg-green-500', degraded: 'bg-amber-500', down: 'bg-red-500' };
const SEV_CLS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200',
  warning: 'bg-amber-100 text-amber-800 border-amber-200',
  info: 'bg-blue-100 text-blue-800 border-blue-200',
};

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-charcoal/50 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${tone ?? 'text-copper'}`}>{value}</div>
      {sub && <div className="text-[11px] text-charcoal/40 mt-0.5">{sub}</div>}
    </div>
  );
}

/** Minimal dependency-free sparkline. */
function Spark({ data, color = '#B8734F' }: { data: number[]; color?: string }) {
  if (data.length === 0) return <div className="h-8 text-[11px] text-charcoal/30">—</div>;
  const max = Math.max(...data, 1); const min = Math.min(...data, 0);
  const range = max - min || 1; const w = 120; const h = 32; const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function MarketingOpsPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const [dash, setDash] = useState<OpsDashboard | null>(null);
  const [orgs, setOrgs] = useState<OpsOrgHealth[]>([]);
  const [alerts, setAlerts] = useState<OpsAlert[]>([]);
  const [metrics, setMetrics] = useState<OpsMetricRow[]>([]);
  const [failedJobs, setFailedJobs] = useState<OpsFailedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [alertFilter, setAlertFilter] = useState<'open' | 'acknowledged' | 'resolved' | 'all'>('open');

  const load = useCallback(async (aFilter = alertFilter) => {
    setLoading(true);
    try {
      const [d, o, a, m, fj] = await Promise.all([
        fetchOpsDashboard(), fetchOpsOrgHealth(), fetchOpsAlerts(aFilter), fetchOpsMetricsHistory(30), fetchOpsFailedJobs(),
      ]);
      setDash(d.dashboard); setOrgs(o.organizations); setAlerts(a.alerts); setMetrics(m.rows); setFailedJobs(fj.jobs);
    } catch (e) {
      addToast(e instanceof Error ? e.message : L('فشل تحميل بيانات المراقبة', 'Failed to load monitoring data'), 'error');
    } finally { setLoading(false); }
  }, [alertFilter, addToast, isAr]);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const runEvaluate = async () => {
    setBusy(true);
    try { await runOpsEvaluate(); addToast(L('تم تشغيل الفحص', 'Evaluation ran'), 'success'); await load(); }
    catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); }
    finally { setBusy(false); }
  };
  const onRetry = async (id: string) => {
    try { await retryJob(id); addToast(L('أُعيدت جدولة المهمة', 'Job re-queued'), 'success'); await load(); }
    catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); }
  };
  const onAlert = async (id: string, status: 'acknowledged' | 'resolved') => {
    try { await setOpsAlertStatus(id, status); await load(); }
    catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); }
  };

  const providers = dash?.providers ?? [];
  const counts = useMemo(() => providerCounts(providers), [providers]);
  const sysStatus = useMemo<SystemStatus>(() => dash
    ? overallSystemStatus({ diagnostics: dash.diagnostics, criticalAlerts: dash.critical_alerts, providers })
    : 'degraded', [dash, providers]);
  const shownProviders = providerFilter === 'all' ? providers : providers.filter((p) => p.provider === providerFilter);
  const sortedAlerts = useMemo(() => sortAlerts(alerts), [alerts]);

  const KPIS: Array<{ key: string; ar: string; en: string }> = [
    { key: 'posts_collected', ar: 'منشورات', en: 'Posts' },
    { key: 'ads_collected', ar: 'إعلانات', en: 'Ads' },
    { key: 'new_campaigns', ar: 'حملات', en: 'Campaigns' },
    { key: 'new_landing_pages', ar: 'صفحات هبوط', en: 'Landing pages' },
    { key: 'runs', ar: 'عمليات', en: 'Runs' },
    { key: 'failures', ar: 'إخفاقات', en: 'Failures' },
    { key: 'provider_cost_usd', ar: 'التكلفة', en: 'Cost' },
    { key: 'avg_latency_ms', ar: 'زمن الاستجابة', en: 'Latency' },
  ];

  if (loading && !dash) {
    return <div className="max-w-6xl"><BackToSettings /><div className="text-charcoal/50 text-sm">{L('جارٍ التحميل…', 'Loading…')}</div></div>;
  }

  return (
    <div className="max-w-6xl pb-16">
      <BackToSettings />
      {/* Header + overall status */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-chocolate/10 flex items-center justify-center">
            <Activity size={22} className="text-chocolate" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-charcoal">{L('مراقبة ذكاء التسويق', 'Marketing Intelligence Operations')}</h1>
            <div className="text-xs text-charcoal/40">{dash && `${L('آخر تحديث', 'updated')} ${ago(dash.generated_at)} ${L('مضت', 'ago')}`}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${SYS_CLS[sysStatus]}`}>
            {sysStatus === 'healthy' ? L('سليم', 'Healthy') : sysStatus === 'degraded' ? L('متدهور', 'Degraded') : L('متوقف', 'Down')}
          </span>
          <button type="button" onClick={() => load()} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-copper/10 text-copper hover:bg-copper/20">
            <RefreshCw size={14} /> {L('تحديث', 'Refresh')}
          </button>
          <button type="button" onClick={runEvaluate} disabled={busy} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-chocolate text-white hover:bg-chocolate/90 disabled:opacity-50">
            <Play size={14} /> {L('تشغيل الفحص', 'Run diagnostics')}
          </button>
        </div>
      </div>

      {dash && (
        <>
          {/* Top KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat label={L('مزوّدون سليمون', 'Healthy providers')} value={`${counts.healthy}/${counts.total}`} sub={`${counts.degraded} ${L('متدهور', 'degraded')} · ${counts.offline} ${L('متوقف', 'offline')}`} tone={counts.offline ? 'text-red-600' : counts.degraded ? 'text-amber-600' : 'text-green-600'} />
            <Stat label={L('مهام قيد التشغيل', 'Jobs running')} value={dash.jobs_running} sub={`${dash.queue.queued} ${L('في الانتظار', 'queued')}`} />
            <Stat label={L('تجميعات اليوم', 'Collections today')} value={dash.collections_today} sub={`${dash.failures_today} ${L('إخفاق', 'failed')}`} tone={dash.failures_today ? 'text-amber-600' : 'text-copper'} />
            <Stat label={L('تنبيهات مفتوحة', 'Open alerts')} value={dash.open_alerts} sub={`${dash.critical_alerts} ${L('حرجة', 'critical')}`} tone={dash.critical_alerts ? 'text-red-600' : dash.open_alerts ? 'text-amber-600' : 'text-green-600'} />
            <Stat label={L('آخر تجميع ناجح', 'Last success')} value={ago(dash.last_success_collection)} sub={L('مضت', 'ago')} />
            <Stat label={L('آخر إخفاق', 'Last failure')} value={ago(dash.last_failed_collection)} sub={L('مضت', 'ago')} />
            <Stat label={L('متوسط مدة التجميع', 'Avg duration')} value={dash.avg_collection_duration_ms ? `${Math.round(dash.avg_collection_duration_ms / 1000)}s` : '—'} />
            <Stat label={L('تكلفة الشهر', 'Cost this month')} value={usd(dash.cost.month_usd)} sub={`${L('اليوم', 'today')} ${usd(dash.cost.today_usd)}`} tone={dash.cost.spike.is_spike ? 'text-red-600' : 'text-copper'} />
          </div>

          {dash.collection_paused && (
            <div className="mb-4 px-4 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm flex items-center gap-2">
              <AlertTriangle size={16} /> {L('التجميع متوقف مؤقتًا (إيقاف عام)', 'Collection is globally paused')}
            </div>
          )}

          {/* Diagnostics */}
          <section className="card p-4 mb-4">
            <h2 className="text-sm font-semibold text-charcoal mb-3">{L('الفحوصات الذاتية', 'Self-diagnostics')}</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {Object.entries(dash.diagnostics).map(([name, d]) => (
                <div key={name} className="flex items-center gap-2 text-sm">
                  <span className={`w-2.5 h-2.5 rounded-full ${DIAG_CLS[d.status] ?? 'bg-charcoal/30'}`} />
                  <span className="text-charcoal/70">{name}</span>
                  <span className="text-charcoal/40 text-xs truncate">{d.detail}</span>
                </div>
              ))}
              {Object.entries(dash.heartbeats).map(([c, t]) => (
                <div key={c} className="flex items-center gap-2 text-sm">
                  <span className={`w-2.5 h-2.5 rounded-full ${isStale(t, c === 'scheduler' ? 5400 : 180) ? 'bg-red-500' : 'bg-green-500'}`} />
                  <span className="text-charcoal/70">{c} {L('نبضة', 'beat')}</span>
                  <span className="text-charcoal/40 text-xs">{ago(t)}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Providers */}
          <section className="card p-4 mb-4 overflow-x-auto">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-charcoal">{L('صحة المزوّدين', 'Provider health')}</h2>
              <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="text-xs border border-sand rounded-lg px-2 py-1 bg-white">
                <option value="all">{L('كل المزوّدين', 'All providers')}</option>
                {providers.map((p) => <option key={p.provider} value={p.provider}>{p.display_name ?? p.provider}</option>)}
              </select>
            </div>
            <table className="w-full text-sm min-w-[720px]">
              <thead><tr className="text-charcoal/50 text-xs text-start">
                {[L('المزوّد', 'Provider'), L('الحالة', 'Status'), L('آخر نجاح', 'Last ok'), L('آخر إخفاق', 'Last fail'), L('إخفاقات متتالية', 'Streak'), L('متوسط المدة', 'Avg dur'), L('نجاح', 'Success'), L('خطأ', 'Error'), L('اليوم', 'Today'), L('الشهر', 'Month')].map((h) => <th key={h} className="text-start font-medium pb-2 px-1">{h}</th>)}
              </tr></thead>
              <tbody>
                {shownProviders.map((p) => {
                  const b = providerBucket(p);
                  return (
                    <tr key={p.provider} className="border-t border-sand/40">
                      <td className="py-2 px-1 font-medium text-charcoal">{p.display_name ?? p.provider}</td>
                      <td className="px-1"><span className={`px-1.5 py-0.5 rounded-full text-xs ${BUCKET_CLS[b]}`}>{b}</span></td>
                      <td className="px-1 text-charcoal/60">{ago(p.last_success)}</td>
                      <td className="px-1 text-charcoal/60">{ago(p.last_failure)}</td>
                      <td className={`px-1 ${p.consecutive_failures >= 3 ? 'text-red-600 font-semibold' : p.consecutive_failures ? 'text-amber-600' : 'text-charcoal/40'}`}>{p.consecutive_failures}</td>
                      <td className="px-1 text-charcoal/60">{p.avg_run_duration_ms ? `${Math.round(p.avg_run_duration_ms / 1000)}s` : '—'}</td>
                      <td className="px-1 text-charcoal/60">{p.success_rate != null ? `${Math.round(p.success_rate * 100)}%` : '—'}</td>
                      <td className="px-1 text-charcoal/60">{p.error_rate != null ? `${Math.round(p.error_rate * 100)}%` : '—'}</td>
                      <td className="px-1 text-charcoal/60">{usd(p.cost_today)}</td>
                      <td className="px-1 text-charcoal/60">{usd(p.cost_month)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {/* Queue + failed jobs */}
          <section className="card p-4 mb-4">
            <h2 className="text-sm font-semibold text-charcoal mb-3">{L('قائمة المهام', 'Queue')}</h2>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-3 text-center">
              {([['queued', L('انتظار', 'Queued')], ['running', L('تشغيل', 'Running')], ['retrying', L('إعادة', 'Retrying')], ['succeeded_24h', L('نجح ٢٤س', 'OK 24h')], ['failed_24h', L('فشل ٢٤س', 'Fail 24h')], ['retried_total', L('أُعيدت', 'Retried')]] as const).map(([k, lbl]) => (
                <div key={k} className="rounded-lg bg-sand/20 py-2">
                  <div className="text-lg font-bold text-charcoal">{(dash.queue as unknown as Record<string, number>)[k] ?? 0}</div>
                  <div className="text-[11px] text-charcoal/50">{lbl}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-6 text-xs text-charcoal/50 mb-2">
              <span>{L('أقدم منتظرة', 'Oldest queued')}: {ago(dash.queue.oldest_queued_at)}</span>
              <span>{L('أطول تشغيلًا', 'Longest running')}: {ago(dash.queue.longest_running_at)}</span>
            </div>
            {failedJobs.length > 0 ? (
              <div className="mt-2 border-t border-sand/40 pt-2">
                <div className="text-xs text-charcoal/50 mb-1">{L('مهام متعثّرة', 'Failed / retrying jobs')}</div>
                {failedJobs.map((j) => (
                  <div key={j.id} className="flex items-center justify-between py-1.5 text-sm border-b border-sand/30 last:border-0">
                    <div className="min-w-0">
                      <span className="font-medium text-charcoal">{j.kind}</span>
                      <span className="text-charcoal/40 mx-1">· {j.provider}</span>
                      <span className="text-charcoal/40">({j.attempts}/{j.max_attempts})</span>
                      {j.error_message && <span className="text-red-600/70 text-xs block truncate max-w-md">{j.error_message}</span>}
                    </div>
                    <button type="button" onClick={() => onRetry(j.id)} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-copper/10 text-copper hover:bg-copper/20 shrink-0">
                      <RotateCw size={12} /> {L('إعادة', 'Retry')}
                    </button>
                  </div>
                ))}
              </div>
            ) : <div className="text-xs text-green-700/70">{L('لا مهام متعثّرة', 'No failed jobs')}</div>}
          </section>

          {/* Cost */}
          <section className="card p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-charcoal">{L('التكلفة', 'Cost monitoring')}</h2>
              {dash.cost.spike.is_spike && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-800 flex items-center gap-1">
                  <AlertTriangle size={12} /> {L('ارتفاع غير معتاد', 'Spike')} +{costSpikePct(dash.cost)}%
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3 text-center">
              <div className="rounded-lg bg-sand/20 py-2"><div className="text-lg font-bold text-copper">{usd(dash.cost.today_usd)}</div><div className="text-[11px] text-charcoal/50">{L('اليوم', 'Today')}</div></div>
              <div className="rounded-lg bg-sand/20 py-2"><div className="text-lg font-bold text-copper">{usd(dash.cost.month_usd)}</div><div className="text-[11px] text-charcoal/50">{L('الشهر', 'Month')}</div></div>
              <div className="rounded-lg bg-sand/20 py-2"><div className="text-lg font-bold text-charcoal">{usd(dash.cost.avg_per_run)}</div><div className="text-[11px] text-charcoal/50">{L('لكل عملية', 'Per run')}</div></div>
              <div className="rounded-lg bg-sand/20 py-2"><div className="text-lg font-bold text-charcoal">{usd(dash.cost.avg_per_item)}</div><div className="text-[11px] text-charcoal/50">{L('لكل عنصر', 'Per item')}</div></div>
              <div className="rounded-lg bg-sand/20 py-2"><div className="text-lg font-bold text-charcoal">{usd(dash.cost.total_usd)}</div><div className="text-[11px] text-charcoal/50">{L('الإجمالي', 'Total')}</div></div>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-charcoal/50 mb-1">{L('حسب المزوّد', 'By provider')}</div>
                {Object.entries(dash.cost.by_provider).map(([p, v]) => (
                  <div key={p} className="flex justify-between text-sm py-0.5"><span className="text-charcoal/70">{p}</span><span className="text-charcoal/60">{usd(v.usd)} · {v.runs} {L('عملية', 'runs')} · {v.items} {L('عنصر', 'items')}</span></div>
                ))}
              </div>
              <div>
                <div className="text-xs text-charcoal/50 mb-1">{L('حسب المؤسسة', 'By organization')}</div>
                {dash.cost.by_org.slice(0, 6).map((o) => (
                  <div key={o.organization_id} className="flex justify-between text-sm py-0.5"><span className="text-charcoal/70 truncate">{o.name ?? o.organization_id.slice(0, 8)}</span><span className="text-charcoal/60">{usd(o.usd)} · {o.runs}</span></div>
                ))}
                {dash.cost.by_org.length === 0 && <div className="text-xs text-charcoal/30">—</div>}
              </div>
            </div>
          </section>

          {/* Freshness — organizations */}
          <section className="card p-4 mb-4 overflow-x-auto">
            <h2 className="text-sm font-semibold text-charcoal mb-3">{L('صحة المؤسسات ونضارة البيانات', 'Organization health & freshness')}</h2>
            <table className="w-full text-sm min-w-[760px]">
              <thead><tr className="text-charcoal/50 text-xs">
                {[L('المؤسسة', 'Organization'), L('آخر تجميع', 'Last collection'), L('آخر محتوى', 'Last content'), L('آخر إعلان', 'Last ad'), L('آخر مقاييس', 'Last metrics'), L('إخفاقات', 'Fails'), L('التالي', 'Next run')].map((h) => <th key={h} className="text-start font-medium pb-2 px-1">{h}</th>)}
              </tr></thead>
              <tbody>
                {orgs.map((o) => (
                  <tr key={o.organization_id} className={`border-t border-sand/40 ${o.is_stale ? 'bg-red-50/40' : ''}`}>
                    <td className="py-2 px-1 font-medium text-charcoal">
                      {o.is_stale && <span className="inline-block w-2 h-2 rounded-full bg-red-500 me-1.5 align-middle" />}
                      {isAr ? (o.name_ar ?? o.name_en) : (o.name_en ?? o.name_ar)}
                    </td>
                    <td className="px-1 text-charcoal/60">{ago(o.last_success_collection)}</td>
                    <td className="px-1 text-charcoal/60">{ago(o.last_new_content)}</td>
                    <td className="px-1 text-charcoal/60">{ago(o.last_paid_ad)}</td>
                    <td className="px-1 text-charcoal/60">{ago(o.last_metrics_update)}</td>
                    <td className={`px-1 ${o.consecutive_failures ? 'text-amber-600' : 'text-charcoal/40'}`}>{o.consecutive_failures}</td>
                    <td className="px-1 text-charcoal/60">{o.next_scheduled_run ? ago(o.next_scheduled_run) : '—'}</td>
                  </tr>
                ))}
                {orgs.length === 0 && <tr><td colSpan={7} className="text-xs text-charcoal/30 py-2">{L('لا مؤسسات مراقَبة', 'No monitored organizations')}</td></tr>}
              </tbody>
            </table>
          </section>

          {/* Metrics history */}
          <section className="card p-4 mb-4">
            <h2 className="text-sm font-semibold text-charcoal mb-3">{L('مؤشرات الأداء (٣٠ يومًا)', 'KPIs (30 days)')}</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {KPIS.map((k) => {
                const series = metricSeries(metrics, k.key);
                const lastVal = series.length ? series[series.length - 1]!.value : 0;
                const total = k.key === 'avg_latency_ms' ? lastVal : sumMetric(metrics, k.key);
                return (
                  <div key={k.key}>
                    <div className="text-xs text-charcoal/50 mb-1">{L(k.ar, k.en)}</div>
                    <div className="text-lg font-bold text-charcoal mb-1">{k.key === 'provider_cost_usd' ? usd(total) : k.key === 'avg_latency_ms' ? `${Math.round(total / 1000)}s` : total}</div>
                    <Spark data={series.map((s) => s.value)} />
                  </div>
                );
              })}
            </div>
            <div className="text-xs text-charcoal/50 mt-3">
              {L('معدّل منع التكرار', 'Duplicate-prevention rate')}: <span className="font-semibold text-copper">{Math.round(duplicatePreventionRate(metrics) * 100)}%</span>
            </div>
          </section>

          {/* Alerts */}
          <section className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-charcoal">{L('التنبيهات التشغيلية', 'Operational alerts')}</h2>
              <select value={alertFilter} onChange={(e) => { const v = e.target.value as typeof alertFilter; setAlertFilter(v); void load(v); }} className="text-xs border border-sand rounded-lg px-2 py-1 bg-white">
                <option value="open">{L('مفتوحة', 'Open')}</option>
                <option value="acknowledged">{L('مُقرّة', 'Acknowledged')}</option>
                <option value="resolved">{L('محلولة', 'Resolved')}</option>
                <option value="all">{L('الكل', 'All')}</option>
              </select>
            </div>
            {sortedAlerts.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-green-700/70"><CheckCircle2 size={16} /> {L('لا تنبيهات', 'No alerts')}</div>
            ) : (
              <div className="space-y-2">
                {sortedAlerts.map((a) => (
                  <div key={a.id} className={`flex items-start justify-between gap-3 px-3 py-2 rounded-lg border ${SEV_CLS[a.severity] ?? 'bg-charcoal/5'}`}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium flex items-center gap-1.5">
                        {a.severity === 'critical' ? <XCircle size={14} /> : <AlertTriangle size={14} />}
                        {a.title}
                        {a.occurrences > 1 && <span className="text-xs opacity-60">×{a.occurrences}</span>}
                      </div>
                      {a.body && <div className="text-xs opacity-70 mt-0.5">{a.body}</div>}
                      <div className="text-[11px] opacity-50 mt-0.5">{a.kind} · {ago(a.last_seen_at)} {L('مضت', 'ago')}</div>
                    </div>
                    {a.status !== 'resolved' && (
                      <div className="flex gap-1 shrink-0">
                        {a.status === 'open' && <button type="button" onClick={() => onAlert(a.id, 'acknowledged')} className="text-xs px-2 py-0.5 rounded bg-white/60 hover:bg-white">{L('إقرار', 'Ack')}</button>}
                        <button type="button" onClick={() => onAlert(a.id, 'resolved')} className="text-xs px-2 py-0.5 rounded bg-white/60 hover:bg-white">{L('حل', 'Resolve')}</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
