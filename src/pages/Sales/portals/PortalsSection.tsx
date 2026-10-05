/**
 * «البوابات» — the Sales Workspace tab for developer / marketer broker portals.
 *
 * One place to see what is happening in the portals, across every client the
 * viewer can see (their own RLS — a rep sees their book, an admin everything):
 *   - one card per portal: who is registered, who failed, runs live now, the
 *     last automatic status check, whether automatic registration is on;
 *   - «يحدث الآن» — runs queued / running / waiting for a code / parked;
 *   - «العملاء والبوابات» — every client × portal row with our status, the
 *     portal's own status, ref, project, how and when it was registered;
 *   - «المحاولات الفاشلة» — every failed run with the reason in plain words and
 *     the portal's screenshots; failures settled since (the client got
 *     registered, a later check passed) are hidden unless asked for;
 *   - «سجل المحاولات» — every run.
 * Editing a registration stays in the client's own «البوابات» tab (rows link
 * there), so there is one edit path.
 *
 * Data: GET /api/portal-registration?overview=1 (api/_lib/portalRegistrations.ts
 * listPortalsOverview). Grouping logic: ./portalsOverview.ts.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Globe, RefreshCw, Loader2, AlertTriangle, CheckCircle2, Users, Activity, Image as ImageIcon,
  Zap, KeyRound, Search, ExternalLink, Clock,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import {
  fetchPortalsOverview, fetchPortalJob, pickErrorLine, REGISTRATION_OUR_STATUSES,
  type PortalsOverview, type OverviewRun, type OverviewRegistration, type RegistrationOurStatus,
} from '@/lib/portalRegistration/client';
import {
  FAILURE_META, LIVE_RUN, countsByPortal, failureCategory, isResolvedFailure, pairKey,
  type FailureCategory,
} from './portalsOverview';

const OUR_META: Record<RegistrationOurStatus, { ar: string; en: string; cls: string }> = {
  not_registered: { ar: 'غير مسجّل', en: 'Not registered', cls: 'bg-charcoal/10 text-charcoal/70' },
  registering: { ar: 'جارٍ التسجيل', en: 'Registering', cls: 'bg-copper/10 text-copper' },
  registered: { ar: 'مسجّل', en: 'Registered', cls: 'bg-green-100 text-green-800' },
  already_registered: { ar: 'لدى وسيط آخر', en: "Another broker's", cls: 'bg-sky-100 text-sky-800' },
  failed: { ar: 'فشل', en: 'Failed', cls: 'bg-red-100 text-red-800' },
};

const RUN_META: Record<string, { ar: string; en: string; cls: string }> = {
  queued: { ar: 'في الانتظار', en: 'Queued', cls: 'bg-charcoal/10 text-charcoal/70' },
  running: { ar: 'يعمل الآن', en: 'Running', cls: 'bg-copper/10 text-copper' },
  awaiting_input: { ar: 'بانتظار الرمز', en: 'Waiting for code', cls: 'bg-amber-100 text-amber-800' },
  done: { ar: 'تم', en: 'Done', cls: 'bg-green-100 text-green-800' },
  already_registered: { ar: 'لدى وسيط آخر', en: "Another broker's", cls: 'bg-sky-100 text-sky-800' },
  failed: { ar: 'فشل', en: 'Failed', cls: 'bg-red-100 text-red-800' },
  cancelled: { ar: 'أُلغي', en: 'Cancelled', cls: 'bg-charcoal/10 text-charcoal/60' },
};

const VIA_META: Record<string, { ar: string; en: string }> = {
  auto: { ar: 'تلقائي', en: 'Automatic' },
  manual_run: { ar: 'زر التسجيل', en: 'Register button' },
  manual_entry: { ar: 'أُضيف يدوياً', en: 'Added by hand' },
  portal_sync: { ar: 'وُجد في البوابة', en: 'Found in the portal' },
};

type View = 'clients' | 'failed' | 'runs';
const LIVE_POLL_MS = 20_000;

function fmtDate(iso: string | null, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // en-GB digits in both languages: ar-SA would switch to the Hijri calendar.
  return withTime
    ? d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB');
}

function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

export default function PortalsSection() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const t = (ar: string, en: string) => (isAr ? ar : en);

  const [data, setData] = useState<PortalsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>('clients');
  const [portalFilter, setPortalFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<RegistrationOurStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [shots, setShots] = useState<{ run: OverviewRun; urls: { label: string; url: string }[] | null; error: string | null } | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setData(await fetchPortalsOverview());
      setLoadError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PortalsSection] load failed:', msg);
      setLoadError(msg);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const portalName = useMemo(() => new Map((data?.portals ?? []).map((p) => [p.id, p.name])), [data]);
  const clientById = useMemo(() => new Map((data?.clients ?? []).map((c) => [c.id, c])), [data]);
  const regByPair = useMemo(
    () => new Map((data?.registrations ?? []).map((r) => [pairKey(r.client_record_id, r.portal_record_id), r] as const)),
    [data],
  );
  const runs = data?.runs ?? [];
  const counts = useMemo(
    () => (data ? countsByPortal(data.portals, data.registrations, data.runs, regByPair) : new Map()),
    [data, regByPair],
  );
  const liveRuns = useMemo(() => runs.filter((r) => LIVE_RUN.has(r.status)), [runs]);
  const failedRuns = useMemo(() => runs.filter((r) => r.status === 'failed'), [runs]);
  const openFailures = useMemo(
    () => failedRuns.filter((r) => !isResolvedFailure(r, regByPair, runs)),
    [failedRuns, regByPair, runs],
  );

  // Follow live runs without a manual refresh.
  useEffect(() => {
    if (liveRuns.length === 0) return;
    const id = setInterval(() => { void load(true); }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [liveRuns.length, load]);

  const latestRunByPair = useMemo(() => {
    const m = new Map<string, OverviewRun>();
    for (const r of runs) {
      if (r.kind !== 'register' || !r.client_record_id) continue;
      const k = pairKey(r.client_record_id, r.portal_record_id);
      if (!m.has(k)) m.set(k, r); // newest first
    }
    return m;
  }, [runs]);

  const q = query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const matchesClient = useCallback((clientId: string | null) => {
    if (!q) return true;
    if (!clientId) return false;
    const c = clientById.get(clientId);
    if (!c) return false;
    if (c.name.toLowerCase().includes(q) || (c.owner_name ?? '').toLowerCase().includes(q)) return true;
    return qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits);
  }, [q, qDigits, clientById]);

  const regRows = useMemo(() => (data?.registrations ?? [])
    .filter((r) => portalFilter === 'all' || r.portal_record_id === portalFilter)
    .filter((r) => statusFilter === 'all' || r.our_status === statusFilter)
    .filter((r) => matchesClient(r.client_record_id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  [data, portalFilter, statusFilter, matchesClient]);

  const failedRows = useMemo(() => (showResolved ? failedRuns : openFailures)
    .filter((r) => portalFilter === 'all' || r.portal_record_id === portalFilter)
    .filter((r) => !q || matchesClient(r.client_record_id)),
  [showResolved, failedRuns, openFailures, portalFilter, q, matchesClient]);

  const runRows = useMemo(() => runs
    .filter((r) => portalFilter === 'all' || r.portal_record_id === portalFilter)
    .filter((r) => !q || matchesClient(r.client_record_id)),
  [runs, portalFilter, q, matchesClient]);

  const failureSummary = useMemo(() => {
    const m = new Map<FailureCategory, number>();
    for (const r of failedRows) {
      const c = failureCategory(r);
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [failedRows]);

  const openClient = (clientId: string | null) => {
    if (clientId) navigate(`/model/clients/${clientId}?tab=portals`);
  };

  const openShots = async (run: OverviewRun) => {
    setShots({ run, urls: null, error: null });
    try {
      const job = await fetchPortalJob(run.id);
      setShots({ run, urls: (job.screenshot_urls ?? []).map((s) => ({ label: s.label, url: s.url })), error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PortalsSection] screenshots failed:', msg);
      setShots({ run, urls: [], error: msg });
      addToast(t(`تعذّر تحميل الصور: ${msg}`, `Could not load the screenshots: ${msg}`), 'error');
    }
  };

  const clientCell = (clientId: string | null) => {
    if (!clientId) return <span className="text-charcoal/50">{t('فحص الحالات (كل العملاء)', 'Status check (all clients)')}</span>;
    const c = clientById.get(clientId);
    return (
      <button type="button" onClick={() => openClient(clientId)} className="text-start hover:text-copper">
        <div className="font-medium text-charcoal">{c?.name || t('عميل', 'Client')}</div>
        {c?.phone && <div className="text-[11px] text-charcoal/50" dir="ltr">{c.phone}</div>}
      </button>
    );
  };

  if (loading) {
    return (
      <div className="card flex items-center justify-center gap-2 p-10 text-sm text-charcoal/60">
        <Loader2 size={16} className="animate-spin" /> {t('جارٍ تحميل البوابات…', 'Loading portals…')}
      </div>
    );
  }
  if (loadError || !data) {
    return (
      <div className="card space-y-3 p-6 text-sm">
        <div className="flex items-center gap-2 text-red-700">
          <AlertTriangle size={16} /> {t('تعذّر تحميل البوابات', 'Could not load the portals')}
        </div>
        <div className="text-xs text-charcoal/60" dir="ltr">{loadError}</div>
        <Button variant="secondary" onClick={() => void load()}><RefreshCw size={14} /> {t('إعادة المحاولة', 'Retry')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-chocolate"><Globe size={18} /> {t('بوابات المطورين والمسوّقين', 'Developer & marketer portals')}</h2>
          <p className="text-xs text-charcoal/60">
            {t(
              'كل عميل في كل بوابة، والمحاولات الجارية والفاشلة. لا يُسجَّل عميل مسجّل لدينا في البوابة مرة أخرى.',
              'Every client in every portal, with live and failed runs. A client we already registered in a portal is never registered again.',
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-charcoal/50">
          {t('آخر تحديث', 'Updated')} {fmtDate(data.generated_at, true)}
          <Button variant="secondary" onClick={() => void load()}><RefreshCw size={14} /> {t('تحديث', 'Refresh')}</Button>
        </div>
      </div>

      {/* Portal cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.portals.map((p) => {
          const c = counts.get(p.id);
          const selected = portalFilter === p.id;
          const check = c?.last_check ?? null;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPortalFilter(selected ? 'all' : p.id)}
              className={`card p-4 text-start transition-colors ${selected ? 'ring-2 ring-copper' : 'hover:border-copper/40'} ${p.is_active ? '' : 'opacity-60'}`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="font-bold text-charcoal">{p.name}</div>
                {!p.is_active && <Badge cls="bg-charcoal/10 text-charcoal/60">{t('غير نشطة', 'Inactive')}</Badge>}
              </div>
              <div className="mb-3 flex flex-wrap gap-1">
                <Badge cls={p.auto_register ? 'bg-green-50 text-green-800' : 'bg-charcoal/5 text-charcoal/60'}>
                  <Zap size={10} className="me-0.5 inline" />{p.auto_register ? t('تسجيل تلقائي', 'Auto-register on') : t('يدوي فقط', 'Manual only')}
                </Badge>
                <Badge cls="bg-charcoal/5 text-charcoal/60">
                  <KeyRound size={10} className="me-0.5 inline" />
                  {!p.otp_channel || p.otp_channel === 'none'
                    ? t('بدون رمز', 'No code')
                    : p.otp_whatsapp_relay ? t('الرمز عبر واتساب العمليات', 'Code via ops WhatsApp') : t('يحتاج رمزاً', 'Needs a code')}
                </Badge>
              </div>
              <div className="grid grid-cols-4 gap-1 text-center">
                <Stat n={c?.registered ?? 0} label={t('مسجّل', 'Registered')} cls="text-green-700" />
                <Stat n={c?.already_registered ?? 0} label={t('وسيط آخر', 'Other broker')} cls="text-sky-700" />
                <Stat n={c?.open_failures ?? 0} label={t('فشل مفتوح', 'Open fails')} cls={(c?.open_failures ?? 0) > 0 ? 'text-red-700' : 'text-charcoal/40'} />
                <Stat n={c?.live_runs ?? 0} label={t('جارٍ الآن', 'Live now')} cls={(c?.live_runs ?? 0) > 0 ? 'text-copper' : 'text-charcoal/40'} />
              </div>
              <div className="mt-3 border-t border-sand/50 pt-2 text-[11px] text-charcoal/60">
                {p.can_check_status
                  ? check
                    ? <>{t('آخر فحص للحالات:', 'Last status check:')} {fmtDate(check.finished_at ?? check.created_at, true)} · <span className={check.status === 'failed' ? 'text-red-700' : ''}>{t(RUN_META[check.status]?.ar ?? check.status, RUN_META[check.status]?.en ?? check.status)}</span></>
                    : t('لم يُفحص بعد', 'Never checked yet')
                  : t('لا يوجد فحص تلقائي للحالات', 'No automatic status check')}
              </div>
            </button>
          );
        })}
      </div>

      {/* Happening now */}
      {liveRuns.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-copper">
            <Activity size={15} /> {t(`يحدث الآن (${liveRuns.length})`, `Happening now (${liveRuns.length})`)}
          </div>
          <ul className="divide-y divide-sand/40">
            {liveRuns.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
                <div className="min-w-[10rem]">{clientCell(r.client_record_id)}</div>
                <span className="text-charcoal/70">{portalName.get(r.portal_record_id) ?? '—'}</span>
                <Badge cls={RUN_META[r.status]?.cls ?? ''}>
                  {r.parked_at ? t('متوقف حتى رد صاحب الجوال', 'Parked until the phone owner replies') : t(RUN_META[r.status]?.ar ?? r.status, RUN_META[r.status]?.en ?? r.status)}
                </Badge>
                <span className="text-charcoal/60">{isAr ? r.phase_ar : r.phase_en}</span>
                <span className="ms-auto flex items-center gap-1 text-charcoal/50"><Clock size={11} />{fmtDate(r.created_at, true)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* View switch + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-charcoal/5 p-1">
          <ViewBtn active={view === 'clients'} onClick={() => setView('clients')} icon={<Users size={14} />} label={t(`العملاء والبوابات (${data.registrations.length})`, `Clients & portals (${data.registrations.length})`)} />
          <ViewBtn active={view === 'failed'} onClick={() => setView('failed')} icon={<AlertTriangle size={14} />} label={t(`المحاولات الفاشلة (${openFailures.length})`, `Failed runs (${openFailures.length})`)} danger={openFailures.length > 0} />
          <ViewBtn active={view === 'runs'} onClick={() => setView('runs')} icon={<Activity size={14} />} label={t(`سجل المحاولات (${runs.length})`, `All runs (${runs.length})`)} />
        </div>
        <div className="relative min-w-[12rem] flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-charcoal/40 start-2.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('ابحث باسم العميل أو رقمه أو المندوب', 'Search client name, phone or rep')}
            className="input w-full text-sm ps-8"
          />
        </div>
        <select value={portalFilter} onChange={(e) => setPortalFilter(e.target.value)} className="input text-sm">
          <option value="all">{t('كل البوابات', 'All portals')}</option>
          {data.portals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {view === 'clients' && (
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as RegistrationOurStatus | 'all')} className="input text-sm">
            <option value="all">{t('كل الحالات', 'All statuses')}</option>
            {REGISTRATION_OUR_STATUSES.map((s) => <option key={s} value={s}>{t(OUR_META[s].ar, OUR_META[s].en)}</option>)}
          </select>
        )}
        {view === 'failed' && (
          <label className="flex items-center gap-1.5 text-xs text-charcoal/70">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            {t('أظهر ما حُلّ لاحقاً', 'Show resolved')}
          </label>
        )}
      </div>

      {/* Clients × portals */}
      {view === 'clients' && (
        <div className="card overflow-x-auto">
          {regRows.length === 0 ? (
            <Empty text={t('لا يوجد عملاء بهذه الحالة.', 'No clients match.')} />
          ) : (
            <table className="w-full min-w-[56rem] text-xs">
              <thead className="bg-charcoal/5 text-charcoal/60">
                <tr>
                  <Th>{t('العميل', 'Client')}</Th>
                  <Th>{t('المندوب', 'Rep')}</Th>
                  <Th>{t('البوابة', 'Portal')}</Th>
                  <Th>{t('حالتنا', 'Our status')}</Th>
                  <Th>{t('حالة البوابة', 'Portal status')}</Th>
                  <Th>{t('المشروع', 'Project')}</Th>
                  <Th>{t('سُجّل', 'Registered')}</Th>
                  <Th>{t('آخر محاولة', 'Last run')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand/40">
                {regRows.map((r) => regRow(r))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Failed runs */}
      {view === 'failed' && (
        <div className="space-y-3">
          {failureSummary.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {failureSummary.map(([cat, n]) => (
                <span key={cat} className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs text-red-800" title={t(FAILURE_META[cat].hint_ar, FAILURE_META[cat].hint_en)}>
                  {t(FAILURE_META[cat].ar, FAILURE_META[cat].en)} · {n}
                </span>
              ))}
            </div>
          )}
          <div className="card overflow-x-auto">
            {failedRows.length === 0 ? (
              <Empty text={showResolved ? t('لا توجد محاولات فاشلة.', 'No failed runs.') : t('لا توجد محاولات فاشلة تحتاج متابعة.', 'No failed runs need attention.')} ok />
            ) : (
              <table className="w-full min-w-[56rem] text-xs">
                <thead className="bg-charcoal/5 text-charcoal/60">
                  <tr>
                    <Th>{t('العميل', 'Client')}</Th>
                    <Th>{t('البوابة', 'Portal')}</Th>
                    <Th>{t('متى', 'When')}</Th>
                    <Th>{t('السبب', 'Why')}</Th>
                    <Th>{t('ماذا تفعل', 'What to do')}</Th>
                    <Th>{t('الوضع الآن', 'Now')}</Th>
                    <Th>{''}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-sand/40">
                  {failedRows.map((r) => {
                    const cat = failureCategory(r);
                    const now = r.client_record_id ? regByPair.get(pairKey(r.client_record_id, r.portal_record_id)) : undefined;
                    return (
                      <tr key={r.id} className="align-top">
                        <Td>{clientCell(r.client_record_id)}</Td>
                        <Td>
                          <div>{portalName.get(r.portal_record_id) ?? '—'}</div>
                          {r.project_name && <div className="text-[11px] text-charcoal/50">{r.project_name}</div>}
                        </Td>
                        <Td>
                          <div className="whitespace-nowrap">{fmtDate(r.finished_at ?? r.created_at, true)}</div>
                          <div className="text-[11px] text-charcoal/50">
                            {r.kind === 'status_check' ? t('فحص حالات', 'Status check') : r.origin === 'auto' ? t('تلقائي', 'Automatic') : `${t('يدوي', 'Manual')}${r.owner_name ? ` · ${r.owner_name}` : ''}`}
                          </div>
                        </Td>
                        <Td>
                          <div className="font-medium text-red-800">{t(FAILURE_META[cat].ar, FAILURE_META[cat].en)}</div>
                          <div className="max-w-[22rem] break-words text-[11px] text-charcoal/60" dir="auto">{pickErrorLine(r.error_message, isAr)}</div>
                        </Td>
                        <Td><div className="max-w-[16rem] text-[11px] text-charcoal/70">{t(FAILURE_META[cat].hint_ar, FAILURE_META[cat].hint_en)}</div></Td>
                        <Td>{now ? <Badge cls={OUR_META[now.our_status].cls}>{t(OUR_META[now.our_status].ar, OUR_META[now.our_status].en)}</Badge> : '—'}</Td>
                        <Td>
                          {r.screenshot_count > 0 && (
                            <button type="button" onClick={() => void openShots(r)} className="inline-flex items-center gap-1 text-copper hover:underline">
                              <ImageIcon size={12} /> {t(`الصور (${r.screenshot_count})`, `Screenshots (${r.screenshot_count})`)}
                            </button>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Every run */}
      {view === 'runs' && (
        <div className="card overflow-x-auto">
          {runRows.length === 0 ? (
            <Empty text={t('لا توجد محاولات.', 'No runs.')} />
          ) : (
            <table className="w-full min-w-[50rem] text-xs">
              <thead className="bg-charcoal/5 text-charcoal/60">
                <tr>
                  <Th>{t('العميل', 'Client')}</Th>
                  <Th>{t('البوابة', 'Portal')}</Th>
                  <Th>{t('النوع', 'Kind')}</Th>
                  <Th>{t('النتيجة', 'Result')}</Th>
                  <Th>{t('متى', 'When')}</Th>
                  <Th>{t('ملاحظة', 'Note')}</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand/40">
                {runRows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <Td>{clientCell(r.client_record_id)}</Td>
                    <Td>
                      <div>{portalName.get(r.portal_record_id) ?? '—'}</div>
                      {r.project_name && <div className="text-[11px] text-charcoal/50">{r.project_name}</div>}
                    </Td>
                    <Td>
                      {r.kind === 'status_check' ? t('فحص حالات', 'Status check') : r.origin === 'auto' ? t('تسجيل تلقائي', 'Auto registration') : t('تسجيل يدوي', 'Manual registration')}
                      {r.owner_name && <div className="text-[11px] text-charcoal/50">{r.owner_name}</div>}
                    </Td>
                    <Td>
                      <Badge cls={RUN_META[r.status]?.cls ?? ''}>
                        {r.skip_reason === 'already_registered_by_us'
                          ? t('تُخطّي — مسجّل لدينا', 'Skipped — already ours')
                          : r.parked_at && r.status === 'queued' ? t('متوقف', 'Parked') : t(RUN_META[r.status]?.ar ?? r.status, RUN_META[r.status]?.en ?? r.status)}
                      </Badge>
                    </Td>
                    <Td><span className="whitespace-nowrap">{fmtDate(r.finished_at ?? r.created_at, true)}</span></Td>
                    <Td><div className="max-w-[22rem] break-words text-[11px] text-charcoal/60" dir="auto">{pickErrorLine(r.error_message, isAr) || (LIVE_RUN.has(r.status) ? (isAr ? r.phase_ar : r.phase_en) : '')}</div></Td>
                    <Td>
                      {r.screenshot_count > 0 && r.client_record_id && (
                        <button type="button" onClick={() => void openShots(r)} className="inline-flex items-center gap-1 text-copper hover:underline">
                          <ImageIcon size={12} /> {r.screenshot_count}
                        </button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Screenshots */}
      <Modal
        open={!!shots}
        onClose={() => setShots(null)}
        title={shots ? `${portalName.get(shots.run.portal_record_id) ?? ''} — ${clientById.get(shots.run.client_record_id ?? '')?.name ?? ''}` : ''}
        maxWidth="max-w-3xl"
      >
        {shots && (
          shots.urls === null ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-charcoal/60"><Loader2 size={16} className="animate-spin" /> {t('جارٍ التحميل…', 'Loading…')}</div>
          ) : shots.urls.length === 0 ? (
            <div className="p-6 text-center text-sm text-charcoal/60">{shots.error ?? t('لا توجد صور لهذه المحاولة.', 'No screenshots for this run.')}</div>
          ) : (
            <div className="space-y-4">
              {shots.urls.map((s) => (
                <figure key={s.url} className="space-y-1">
                  <figcaption className="flex items-center justify-between text-xs text-charcoal/60">
                    <span>{s.label}</span>
                    <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-copper"><ExternalLink size={12} /> {t('فتح', 'Open')}</a>
                  </figcaption>
                  <img src={s.url} alt={s.label} className="w-full rounded-lg border border-sand" />
                </figure>
              ))}
            </div>
          )
        )}
      </Modal>
    </div>
  );

  function regRow(r: OverviewRegistration) {
    const c = clientById.get(r.client_record_id);
    const last = latestRunByPair.get(pairKey(r.client_record_id, r.portal_record_id));
    return (
      <tr key={r.id} className="align-top hover:bg-cream/40">
        <Td>{clientCell(r.client_record_id)}</Td>
        <Td>{c?.owner_name ?? '—'}</Td>
        <Td>{portalName.get(r.portal_record_id) ?? '—'}</Td>
        <Td><Badge cls={OUR_META[r.our_status].cls}>{t(OUR_META[r.our_status].ar, OUR_META[r.our_status].en)}</Badge></Td>
        <Td>
          <div>{r.portal_status ?? '—'}</div>
          {r.portal_ref && <div className="text-[11px] text-charcoal/50" dir="ltr">{r.portal_ref}</div>}
          {r.last_checked_at && <div className="text-[11px] text-charcoal/40">{t('فُحص', 'checked')} {fmtDate(r.last_checked_at)}</div>}
        </Td>
        <Td>
          <div>{r.project_names.join('، ') || '—'}</div>
          {r.registered_as.length > 0 && r.registered_as.join('|') !== r.project_names.join('|') && (
            <div className="text-[11px] text-charcoal/50">{t('في البوابة:', 'In the portal:')} {r.registered_as.join('، ')}</div>
          )}
        </Td>
        <Td>
          <div className="whitespace-nowrap">{fmtDate(r.registered_at)}</div>
          {r.registered_via && <div className="text-[11px] text-charcoal/50">{t(VIA_META[r.registered_via]?.ar ?? r.registered_via, VIA_META[r.registered_via]?.en ?? r.registered_via)}</div>}
        </Td>
        <Td>
          {last ? (
            <>
              <Badge cls={RUN_META[last.status]?.cls ?? ''}>{t(RUN_META[last.status]?.ar ?? last.status, RUN_META[last.status]?.en ?? last.status)}</Badge>
              <div className="text-[11px] text-charcoal/50">{fmtDate(last.finished_at ?? last.created_at, true)}</div>
              {last.status === 'failed' && (
                <div className="max-w-[16rem] text-[11px] text-red-700">{t(FAILURE_META[failureCategory(last)].ar, FAILURE_META[failureCategory(last)].en)}</div>
              )}
            </>
          ) : <span className="text-charcoal/40">{t('بلا محاولة', 'No run')}</span>}
        </Td>
      </tr>
    );
  }
}

function Stat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div>
      <div className={`text-lg font-bold ${cls}`}>{n}</div>
      <div className="text-[10px] text-charcoal/50">{label}</div>
    </div>
  );
}

function ViewBtn({ active, onClick, icon, label, danger }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'bg-white text-copper shadow-sm' : danger ? 'text-red-700 hover:text-red-800' : 'text-charcoal/60 hover:text-charcoal'
      }`}
    >
      {icon}{label}
    </button>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-3 py-2 text-start font-medium">{children}</th>;
}

function Td({ children }: { children: ReactNode }) {
  return <td className="px-3 py-2">{children}</td>;
}

function Empty({ text, ok }: { text: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-charcoal/50">
      {ok && <CheckCircle2 size={16} className="text-green-600" />} {text}
    </div>
  );
}
