import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Loader2, Search, Building2, Globe, KeyRound, ExternalLink, Eye, EyeOff,
  CheckCircle2, AlertTriangle, Send, RefreshCw, Ban, History,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';
import {
  loadPortalOptions,
  startPortalRegistration,
  submitPortalInput,
  cancelPortalRegistration,
  fetchPortalJob,
  subscribePortalJob,
  pickErrorLine,
  type PortalOption,
  type PortalHistoryItem,
  type PortalJob,
} from '@/lib/portalRegistration/client';

/**
 * "Register in portal" — register this chat's client in the broker portal of
 * the developer / marketer / officer behind a project, with a Browserbase
 * browser driven by the Fly worker (the sibling of "Notify officer").
 *
 * Flow: pick the project → the server lists the portals covering it (and this
 * client's earlier registrations) → the portal's customer fields, prefilled
 * from the client record → Start. The run is a job row the modal follows via
 * Realtime (+ a poll fallback): phase labels, the live browser view, and —
 * when the portal asks for an OTP — an input box. The rep types the code, the
 * worker continues, the final screenshot is the proof.
 */
export default function RegisterLeadPortalModal({
  clientId,
  clientName,
  preferredProjectIds,
  onClose,
}: {
  clientId: string;
  clientName: string;
  preferredProjectIds?: string[];
  onClose: () => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  const projectsModel = useMemo(() => models.find((m) => m.name === 'all_projects') ?? null, [models]);
  const projects = useMemo<AppRecord[]>(
    () => (projectsModel ? records[projectsModel.id] ?? [] : []),
    [projectsModel, records],
  );
  const projectName = useCallback((r: AppRecord | null | undefined): string => {
    if (!r) return '—';
    const d = r.data as Record<string, unknown>;
    return (typeof d.project_name === 'string' && d.project_name) || (typeof d.name === 'string' && d.name) || '—';
  }, []);

  // ── Step 1: project ────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (projectId || !preferredProjectIds || preferredProjectIds.length !== 1) return;
    const p = projects.find((r) => r.id === preferredProjectIds[0]);
    if (p) setProjectId(p.id);
  }, [preferredProjectIds, projects, projectId]);
  const selectedProject = useMemo(() => projects.find((r) => r.id === projectId) ?? null, [projects, projectId]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? projects.filter((r) => projectName(r).toLowerCase().includes(q)) : projects;
    return base.slice(0, 40);
  }, [projects, query, projectName]);

  // ── Step 2: portals covering the project ───────────────────────────────
  const [loadingPortals, setLoadingPortals] = useState(false);
  const [portals, setPortals] = useState<PortalOption[] | null>(null);
  const [history, setHistory] = useState<PortalHistoryItem[]>([]);
  const [portalId, setPortalId] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) {
      setPortals(null);
      setPortalId(null);
      return;
    }
    let cancelled = false;
    setLoadingPortals(true);
    setPortals(null);
    loadPortalOptions(clientId, projectId)
      .then(({ portals: list, history: hist }) => {
        if (cancelled) return;
        setPortals(list);
        setHistory(hist);
        const first = list.find((p) => p.recipe_ok) ?? list[0] ?? null;
        setPortalId(first?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setPortals([]);
        addToast(err instanceof Error ? err.message : String(err), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadingPortals(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, clientId, addToast]);
  const portal = useMemo(() => portals?.find((p) => p.id === portalId) ?? null, [portals, portalId]);

  // ── Step 3: the customer fields the portal needs ───────────────────────
  const [lead, setLead] = useState<Record<string, string>>({});
  const [loginPhone, setLoginPhone] = useState('');
  useEffect(() => {
    if (!portal) return;
    setLead({ ...portal.prefill });
    setLoginPhone(portal.login_phone ?? '');
  }, [portal]);
  const missing = useMemo(
    () => (portal ? portal.fields.filter((f) => f.required !== false && !(lead[f.key] ?? '').trim()) : []),
    [portal, lead],
  );
  const priorDone = useMemo(
    () => (portal ? history.find((h) => h.portal_record_id === portal.id && h.status === 'done') ?? null : null),
    [portal, history],
  );

  // ── Step 4: the run ────────────────────────────────────────────────────
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<PortalJob | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const [otp, setOtp] = useState('');
  const [submittingInput, setSubmittingInput] = useState(false);
  const [inputSentFor, setInputSentFor] = useState<string | null>(null);
  const [showLive, setShowLive] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  // Realtime on the job row + a 4 s poll as the backstop (the poll also brings
  // signed screenshot URLs, which Realtime rows don't carry).
  useEffect(() => {
    const id = jobIdRef.current;
    if (!id) return;
    let disposed = false;
    const apply = (row: PortalJob) => {
      if (disposed) return;
      setJob((cur) => (cur && cur.id === row.id ? { ...cur, ...row, screenshot_urls: row.screenshot_urls ?? cur.screenshot_urls } : row));
    };
    const unsub = subscribePortalJob(id, apply);
    const poll = async () => {
      try {
        apply(await fetchPortalJob(id));
      } catch (err) {
        console.error('[portal-registration] poll failed', err);
      }
    };
    void poll();
    const t = window.setInterval(() => {
      void poll();
    }, 4000);
    return () => {
      disposed = true;
      unsub();
      window.clearInterval(t);
    };
  }, [job?.id]);

  // Stop polling once the run is over (one last fetch for the final screenshots).
  const terminal = job ? ['done', 'failed', 'cancelled'].includes(job.status) : false;
  useEffect(() => {
    if (!terminal || !job) return;
    void fetchPortalJob(job.id).then((row) => setJob((cur) => (cur ? { ...cur, ...row } : row))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);

  const start = async () => {
    if (!portal || !projectId) return;
    setStarting(true);
    try {
      const { jobId } = await startPortalRegistration({
        portalId: portal.id,
        clientId,
        projectId,
        lead: { ...lead, project_name: projectName(selectedProject) },
        loginPhone: loginPhone.trim() || null,
      });
      jobIdRef.current = jobId;
      setOtp('');
      setInputSentFor(null);
      setJob({
        id: jobId,
        portal_record_id: portal.id,
        client_record_id: clientId,
        project_record_id: projectId,
        status: 'queued',
        phase: null, phase_ar: null, phase_en: null,
        input_request: null, input_requested_at: null,
        live_view_url: null, screenshots: [], result: null, error_message: null,
        created_at: new Date().toISOString(), started_at: null, finished_at: null,
      });
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setStarting(false);
    }
  };

  const sendInput = async () => {
    if (!job || !otp.trim()) return;
    setSubmittingInput(true);
    try {
      await submitPortalInput(job.id, otp.trim());
      setInputSentFor(job.input_request?.key ?? 'otp');
      setOtp('');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSubmittingInput(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    setCancelling(true);
    try {
      await cancelPortalRegistration(job.id);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setCancelling(false);
    }
  };

  const retry = () => {
    jobIdRef.current = null;
    setJob(null);
    setOtp('');
    setInputSentFor(null);
  };

  const coverageLabel = (c: PortalOption['coverage']) =>
    c === 'project' ? (isAr ? 'مرتبطة بالمشروع' : 'linked to project')
    : c === 'officer' ? (isAr ? 'عبر المسؤول' : 'via officer')
    : c === 'developer' ? (isAr ? 'عبر المطور' : 'via developer')
    : (isAr ? 'عبر المسوّق' : 'via marketer');

  const statusLabel = (s: PortalJob['status']) =>
    s === 'queued' ? (isAr ? 'في الانتظار' : 'Queued')
    : s === 'running' ? (isAr ? 'جارٍ التنفيذ' : 'Running')
    : s === 'awaiting_input' ? (isAr ? 'بانتظار الرمز' : 'Waiting for the code')
    : s === 'done' ? (isAr ? 'تم التسجيل' : 'Registered')
    : s === 'failed' ? (isAr ? 'فشل' : 'Failed')
    : (isAr ? 'أُلغي' : 'Cancelled');

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(isAr ? 'ar-SA' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return iso;
    }
  };

  const awaiting = job?.status === 'awaiting_input' && !!job.input_request;
  const inputConsumed = awaiting && inputSentFor === job?.input_request?.key;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={terminal || !job ? onClose : undefined}>
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe size={18} className="text-copper" />
            <h2 className="text-lg font-bold text-chocolate">
              {isAr ? 'تسجيل العميل في بوابة الجهة' : 'Register the client in the partner portal'}
            </h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-charcoal/50 hover:bg-charcoal/5" aria-label="close">
            <X size={18} />
          </button>
        </div>

        {!job ? (
          <>
            <p className="mb-3 text-xs text-charcoal/50">
              {isAr
                ? `اختر المشروع، وسنعرض بوابات المطور/المسوّق/المسؤول المرتبطة به. يُسجَّل العميل${clientName ? ` (${clientName})` : ''} تلقائياً في متصفح آمن؛ إذا طلبت البوابة رمز تحقق ستكتبه هنا.`
                : `Pick the project — we list the developer/marketer/officer portals behind it. The client${clientName ? ` (${clientName})` : ''} is registered by an automated browser; if the portal asks for a code you type it here.`}
            </p>

            {/* Project picker */}
            {!projectId ? (
              <div>
                <label className="mb-1 block text-sm font-medium text-charcoal">{isAr ? 'المشروع' : 'Project'}</label>
                <div className="relative mb-2">
                  <Search size={14} className="absolute top-2.5 ltr:left-2.5 rtl:right-2.5 text-charcoal/40" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={isAr ? 'ابحث عن مشروع…' : 'Search a project…'}
                    className="input w-full ltr:pl-8 rtl:pr-8 text-sm"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto rounded-xl border border-sand">
                  {filtered.length === 0 ? (
                    <p className="p-3 text-center text-xs text-charcoal/40">{isAr ? 'لا توجد مشاريع مطابقة' : 'No matching projects'}</p>
                  ) : (
                    filtered.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => setProjectId(r.id)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-cream/60"
                      >
                        <Building2 size={13} className="shrink-0 text-charcoal/40" />
                        <span className="truncate">{projectName(r)}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between rounded-xl bg-cream/60 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Building2 size={14} className="shrink-0 text-copper" />
                    <span className="truncate text-sm font-medium text-charcoal">{projectName(selectedProject)}</span>
                  </div>
                  <button
                    onClick={() => { setProjectId(null); setQuery(''); }}
                    className="text-xs font-medium text-copper hover:text-terracotta"
                  >
                    {isAr ? 'تغيير' : 'Change'}
                  </button>
                </div>

                {/* Portals */}
                {loadingPortals ? (
                  <div className="mb-3 flex items-center gap-2 text-sm text-charcoal/50">
                    <Loader2 size={14} className="animate-spin" />
                    {isAr ? 'جارٍ البحث عن البوابات…' : 'Finding portals…'}
                  </div>
                ) : portals && portals.length === 0 ? (
                  <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    {isAr
                      ? 'لا توجد بوابة تسجيل مرتبطة بهذا المشروع أو بمطوّره/مسوّقه. أضِف بوابة في «بوابات تسجيل العملاء» (الإعدادات).'
                      : 'No lead portal is linked to this project or its developer/marketer. Add one under Settings → Lead portals.'}
                  </div>
                ) : portals && portals.length > 0 ? (
                  <div className="mb-3">
                    <label className="mb-1 block text-sm font-medium text-charcoal">{isAr ? 'البوابة' : 'Portal'}</label>
                    <div className="space-y-1.5">
                      {portals.map((p) => (
                        <label
                          key={p.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                            portalId === p.id ? 'border-copper bg-copper/5' : 'border-sand hover:bg-cream/50'
                          } ${p.recipe_ok ? '' : 'opacity-70'}`}
                          title={p.recipe_ok ? p.login_url : (p.recipe_error ?? '')}
                        >
                          <input type="radio" name="portal" checked={portalId === p.id} onChange={() => setPortalId(p.id)} className="accent-copper" />
                          <span className="font-medium text-charcoal">{p.name}</span>
                          <span className="truncate text-xs text-charcoal/50" dir="ltr">{p.login_url.replace(/^https?:\/\//, '')}</span>
                          <span className="ms-auto rounded-full bg-gold/20 px-2 py-0.5 text-[10px] text-[#8a6a2f]">{coverageLabel(p.coverage)}</span>
                          {!p.recipe_ok && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800">
                              {isAr ? 'بدون أتمتة' : 'no recipe'}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Prior registration warning */}
                {priorDone && (
                  <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
                    <History size={14} className="mt-0.5 shrink-0" />
                    <span>
                      {isAr
                        ? `سبق تسجيل هذا العميل في «${priorDone.portal_name}» بتاريخ ${fmtDate(priorDone.finished_at ?? priorDone.created_at)}. التسجيل مرة أخرى قد يُرفض من البوابة.`
                        : `This client was already registered in "${priorDone.portal_name}" on ${fmtDate(priorDone.finished_at ?? priorDone.created_at)}. Registering again may be rejected by the portal.`}
                    </span>
                  </div>
                )}

                {/* Customer fields */}
                {portal && (
                  <div className="mb-4 rounded-xl border border-sand p-3">
                    <div className="mb-2 text-sm font-medium text-charcoal">{isAr ? 'بيانات العميل المطلوبة' : 'Customer details the portal needs'}</div>
                    {!portal.recipe_ok && (
                      <div className="mb-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
                        {isAr ? 'هذه البوابة بلا خطوات أتمتة صالحة بعد: ' : 'This portal has no runnable recipe yet: '}
                        <span dir="ltr">{portal.recipe_error}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {portal.fields.map((f) => {
                        const label = isAr ? f.label_ar : f.label_en;
                        const value = lead[f.key] ?? '';
                        const set = (v: string) => setLead((cur) => ({ ...cur, [f.key]: v }));
                        const full = f.type === 'textarea';
                        return (
                          <div key={f.key} className={full ? 'sm:col-span-2' : ''}>
                            <label className="mb-1 block text-xs font-medium text-charcoal/70">
                              {label}{f.required !== false && <span className="text-terracotta"> *</span>}
                            </label>
                            {f.type === 'select' && f.options ? (
                              <select value={value} onChange={(e) => set(e.target.value)} className="input w-full text-sm">
                                <option value="">—</option>
                                {f.options.map((o) => (
                                  <option key={o.value} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>
                                ))}
                              </select>
                            ) : full ? (
                              <textarea value={value} onChange={(e) => set(e.target.value)} rows={3} className="input w-full text-sm" placeholder={f.placeholder} />
                            ) : (
                              <input
                                value={value}
                                onChange={(e) => set(e.target.value)}
                                type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}
                                dir={f.type === 'phone' || f.type === 'email' || f.type === 'number' ? 'ltr' : undefined}
                                className="input w-full text-sm"
                                placeholder={f.placeholder}
                              />
                            )}
                          </div>
                        );
                      })}
                      <div>
                        <label className="mb-1 block text-xs font-medium text-charcoal/70">
                          {isAr ? 'رقم الدخول للبوابة (يصله رمز التحقق)' : 'Portal sign-in phone (receives the code)'}
                        </label>
                        <input value={loginPhone} onChange={(e) => setLoginPhone(e.target.value)} dir="ltr" className="input w-full text-sm" placeholder="+9665XXXXXXXX" />
                      </div>
                    </div>
                  </div>
                )}

                {/* History */}
                {history.length > 0 && (
                  <details className="mb-4 rounded-xl border border-sand p-3 text-xs">
                    <summary className="cursor-pointer font-medium text-charcoal/70">
                      {isAr ? `تسجيلات سابقة لهذا العميل (${history.length})` : `Earlier registrations for this client (${history.length})`}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {history.map((h) => (
                        <li key={h.id} className="flex items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${h.status === 'done' ? 'bg-green-100 text-green-800' : h.status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-charcoal/10 text-charcoal/70'}`}>
                            {statusLabel(h.status)}
                          </span>
                          <span className="font-medium">{h.portal_name}</span>
                          <span className="text-charcoal/50">{fmtDate(h.finished_at ?? h.created_at)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={onClose} disabled={starting}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
                  <Button onClick={start} disabled={!portal || !portal.recipe_ok || missing.length > 0 || starting}>
                    {starting ? <Loader2 size={15} className="animate-spin" /> : <Globe size={15} />}
                    {isAr ? 'ابدأ التسجيل' : 'Start registration'}
                  </Button>
                </div>
                {portal && missing.length > 0 && (
                  <p className="mt-2 text-end text-[11px] text-terracotta">
                    {isAr ? 'أكمل الحقول المطلوبة: ' : 'Fill the required fields: '}
                    {missing.map((f) => (isAr ? f.label_ar : f.label_en)).join('، ')}
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {/* ── Run view ─────────────────────────────────────────────── */}
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-cream/60 px-3 py-2 text-sm">
              <Building2 size={14} className="shrink-0 text-copper" />
              <span className="truncate font-medium text-charcoal">{projectName(selectedProject)}</span>
              <span className="text-charcoal/40">·</span>
              <span className="truncate text-charcoal">{portal?.name ?? '—'}</span>
              <span
                className={`ms-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  job.status === 'done' ? 'bg-green-100 text-green-800'
                  : job.status === 'failed' ? 'bg-red-100 text-red-800'
                  : job.status === 'cancelled' ? 'bg-charcoal/10 text-charcoal/70'
                  : job.status === 'awaiting_input' ? 'bg-amber-100 text-amber-800'
                  : 'bg-copper/10 text-copper'
                }`}
              >
                {statusLabel(job.status)}
              </span>
            </div>

            {/* Phase */}
            {!terminal && (
              <div className="mb-3 flex items-center gap-2 text-sm text-charcoal/70">
                <Loader2 size={14} className="animate-spin text-copper" />
                <span>
                  {job.status === 'queued'
                    ? (isAr ? 'بانتظار العامل…' : 'Waiting for the worker…')
                    : (isAr ? job.phase_ar : job.phase_en) || (isAr ? 'جارٍ العمل…' : 'Working…')}
                </span>
              </div>
            )}

            {/* OTP / input request */}
            {awaiting && job.input_request && (
              <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-900">
                  <KeyRound size={15} />
                  {isAr ? job.input_request.prompt_ar : job.input_request.prompt_en}
                </div>
                {job.input_request.otp_channel && job.input_request.otp_channel !== 'none' && (
                  <p className="mb-2 text-xs text-amber-800">
                    {isAr
                      ? `يصل الرمز عبر ${job.input_request.otp_channel === 'sms' ? 'رسالة نصية' : job.input_request.otp_channel === 'whatsapp' ? 'واتساب' : 'البريد الإلكتروني'} إلى رقم الدخول.`
                      : `The code arrives by ${job.input_request.otp_channel === 'sms' ? 'SMS' : job.input_request.otp_channel === 'whatsapp' ? 'WhatsApp' : 'email'} on the sign-in number.`}
                  </p>
                )}
                {inputConsumed ? (
                  <div className="flex items-center gap-2 text-xs text-amber-800">
                    <Loader2 size={12} className="animate-spin" />
                    {isAr ? 'تم إرسال الرمز — جارٍ المتابعة…' : 'Code sent — continuing…'}
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      value={otp}
                      onChange={(e) => setOtp(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void sendInput(); }}
                      inputMode={job.input_request.kind === 'otp' ? 'numeric' : 'text'}
                      dir="ltr"
                      maxLength={job.input_request.kind === 'otp' ? (job.input_request.length ?? 8) : undefined}
                      className="input w-40 text-center text-lg tracking-[0.3em]"
                      placeholder={job.input_request.kind === 'otp' ? '••••' : ''}
                    />
                    <Button onClick={sendInput} disabled={!otp.trim() || submittingInput}>
                      {submittingInput ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                      {isAr ? 'إرسال الرمز' : 'Send code'}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Live browser view */}
            {job.live_view_url && !terminal && (
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between text-xs text-charcoal/60">
                  <span className="flex items-center gap-1">
                    <Eye size={12} />
                    {isAr ? 'المتصفح مباشرة — يمكنك التدخل إذا لزم' : 'Live browser — you can step in if needed'}
                  </span>
                  <span className="flex items-center gap-2">
                    <a href={job.live_view_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-copper hover:text-terracotta">
                      <ExternalLink size={12} />
                      {isAr ? 'فتح في نافذة' : 'Open in a window'}
                    </a>
                    <button onClick={() => setShowLive((v) => !v)} className="flex items-center gap-1 text-copper hover:text-terracotta">
                      {showLive ? <EyeOff size={12} /> : <Eye size={12} />}
                      {showLive ? (isAr ? 'إخفاء' : 'Hide') : (isAr ? 'عرض' : 'Show')}
                    </button>
                  </span>
                </div>
                {showLive && (
                  <div className="overflow-hidden rounded-xl border border-sand bg-charcoal/5" style={{ aspectRatio: '16 / 10' }}>
                    <iframe
                      src={job.live_view_url}
                      title="live browser"
                      className="h-full w-full"
                      sandbox="allow-same-origin allow-scripts allow-forms allow-pointer-lock allow-popups"
                      allow="clipboard-read; clipboard-write"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Outcome */}
            {job.status === 'done' && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-green-300 bg-green-50 p-3 text-sm text-green-900">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                <span>
                  {isAr
                    ? `تم تسجيل العميل${clientName ? ` «${clientName}»` : ''} في بوابة «${portal?.name ?? ''}» بنجاح.`
                    : `Client${clientName ? ` "${clientName}"` : ''} registered in "${portal?.name ?? ''}" successfully.`}
                </span>
              </div>
            )}
            {job.status === 'failed' && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{pickErrorLine(job.error_message, isAr) || (isAr ? 'فشل التسجيل.' : 'Registration failed.')}</span>
              </div>
            )}
            {job.status === 'cancelled' && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-sand bg-cream/60 p-3 text-sm text-charcoal">
                <Ban size={16} className="mt-0.5 shrink-0" />
                <span>{isAr ? 'أُلغي التسجيل وأُغلق المتصفح.' : 'The registration was cancelled and the browser closed.'}</span>
              </div>
            )}

            {/* Screenshots (evidence) */}
            {job.screenshot_urls && job.screenshot_urls.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs text-charcoal/60">{isAr ? 'لقطات من التسجيل' : 'Screenshots from the run'}</div>
                <div className="flex gap-2 overflow-x-auto">
                  {job.screenshot_urls.map((s) => (
                    <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="shrink-0" title={s.label}>
                      <img src={s.url} alt={s.label} className="h-24 rounded-lg border border-sand object-cover" />
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              {!terminal ? (
                <Button variant="secondary" onClick={cancel} disabled={cancelling}>
                  {cancelling ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
                  {isAr ? 'إيقاف التسجيل' : 'Stop the registration'}
                </Button>
              ) : (
                <>
                  {job.status !== 'done' && (
                    <Button variant="secondary" onClick={retry}>
                      <RefreshCw size={15} />
                      {isAr ? 'حاول مرة أخرى' : 'Try again'}
                    </Button>
                  )}
                  <Button onClick={onClose}>{isAr ? 'إغلاق' : 'Close'}</Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
