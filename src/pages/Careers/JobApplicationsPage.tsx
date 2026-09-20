import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Loader2, Search, FileText, Download, Play, X, RefreshCw, Phone, Clock,
  Megaphone, AlertTriangle, Briefcase, StickyNote, HandCoins, Save, Calculator, FileDown,
  Send, Copy, CheckCircle2, XCircle, MessageCircle, Link2, Settings, Eye,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { SITUATION_OPTIONS, EXPERIENCE_OPTIONS, YES_NO_OPTIONS } from '@/lib/careers/form';
import { buildOfferLetterPdf, offerPdfFilename } from '@/lib/careers/offerPdf';
import { downloadPdf } from '@/lib/projects/sendPdfToChat';

/**
 * Internal, admin-only review of public job applications ("مستشار مبيعات عقارية").
 * Route is guarded by RequireAdmin; the table's RLS (`wassell_is_admin`) is the
 * server-side gate, so reads/updates here only work for admins. CV + audio are
 * fetched through the admin-gated /api/careers/file-url (short-lived signed url) —
 * private files are never exposed publicly.
 */

interface JobApplication {
  id: string;
  created_at: string;
  status: string;
  full_name: string;
  phone: string;
  phone_raw: string | null;
  current_situation: string | null;
  experience_level: string | null;
  experience_results: string | null;
  can_commit: string | null;
  expected_salary: number | null;
  expected_commission: string | null;
  additional_notes: string | null;
  cv_path: string | null;
  cv_name: string | null;
  cv_size: number | null;
  audio_path: string | null;
  audio_duration_sec: number | null;
  source_url: string | null;
  utm: Record<string, string> | null;
  click_ids: Record<string, string> | null;
  // Offer stage + reviewer notes (2026-09-08) — admin-authored, never applicant-visible.
  offer_salary: number | null;
  offer_commission: string | null;
  offer_details: string | null;
  offer_sent_at: string | null;
  review_notes: string | null;
  // Cost-projection scenario inputs (2026-09-08). Null → UI defaults below.
  offer_sales_per_month: number | null;
  offer_avg_sale_price: number | null;
  offer_company_commission_pct: number | null;
  // Recruitment-experience link (2026-09-17) — set by the send + the candidate's actions.
  invite_token: string | null;
  experience_confirmed_at: string | null;
  experience_decided_at: string | null;
  experience_decision: string | null;         // 'interested' | 'declined'
  experience_decline_category: string | null;  // 'salary' | 'commission' | 'other'
  experience_decline_reason: string | null;
}

/** Admin-editable columns (the rest of the row is applicant-authored + immutable). */
type AppPatch = Partial<Pick<JobApplication,
  | 'status' | 'offer_salary' | 'offer_commission' | 'offer_details' | 'offer_sent_at' | 'review_notes'
  | 'offer_sales_per_month' | 'offer_avg_sale_price' | 'offer_company_commission_pct'>>;

/** Projection defaults when the row has no saved scenario yet. */
const DEFAULT_AVG_SALE_PRICE = 1_250_000;   // SAR
const DEFAULT_COMPANY_COMMISSION_PCT = 2.5; // % of the sale price the company earns

/**
 * Parse a user-typed number: strips thousands separators / % / currency, maps
 * Arabic-Indic digits to ASCII. '' → null (unset); garbage → NaN (invalid).
 */
function parseNum(s: string): number | null {
  const ascii = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const cleaned = ascii.replace(/[^\d.]/g, '');
  if (s.trim() === '') return null;
  if (cleaned === '') return NaN;
  return Number(cleaned);
}

const STATUSES = [
  { value: 'new', ar: 'جديد', en: 'New', color: '#3B82F6' },
  { value: 'reviewing', ar: 'قيد المراجعة', en: 'Reviewing', color: '#C09B5F' },
  { value: 'interview', ar: 'للمقابلة', en: 'Interview', color: '#8B5CF6' },
  { value: 'offer_pending', ar: 'إعداد العرض', en: 'Prepare offer', color: '#D97706' },
  { value: 'offer_sent', ar: 'تم إرسال العرض', en: 'Offer sent', color: '#0EA5E9' },
  { value: 'offer_accepted', ar: 'قبِل العرض', en: 'Offer accepted', color: '#059669' },
  { value: 'offer_rejected', ar: 'رفض العرض', en: 'Offer declined', color: '#B45309' },
  { value: 'rejected', ar: 'مرفوض', en: 'Rejected', color: '#8E4E3A' },
  { value: 'hired', ar: 'تم التوظيف', en: 'Hired', color: '#10B981' },
] as const;

/** Statuses at which the offer card is the main thing the reviewer is working on. */
const OFFER_STATUSES = new Set<string>(['offer_pending', 'offer_sent', 'offer_accepted', 'offer_rejected', 'hired']);

const situationLabel = (v: string | null) => SITUATION_OPTIONS.find((o) => o.value === v)?.label ?? '—';
const experienceLabel = (v: string | null) => EXPERIENCE_OPTIONS.find((o) => o.value === v)?.label ?? '—';
const yesNoLabel = (v: string | null) => YES_NO_OPTIONS.find((o) => o.value === v)?.label ?? '—';
const statusOf = (v: string) => STATUSES.find((s) => s.value === v) ?? STATUSES[0];
const declineCategoryLabel = (c: string, isAr: boolean) =>
  c === 'salary' ? (isAr ? 'الراتب' : 'Salary')
  : c === 'commission' ? (isAr ? 'العمولة' : 'Commission')
  : (isAr ? 'سبب آخر' : 'Other');

/** One tile in the offer-experience funnel. */
function FunnelStat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className="rounded-xl border border-sand/30 bg-cream/40 px-2 py-2.5 text-center">
      <div className="text-xl font-extrabold" style={{ color }}>{n}</div>
      <div className="mt-0.5 text-[11px] text-charcoal/55 leading-tight">{label}</div>
    </div>
  );
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fileUrl(id: string, kind: 'cv' | 'audio', download = false): Promise<string> {
  const res = await fetch('/api/careers/file-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ id, kind, download }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.url;
}

interface SendExperienceResult { link: string; invite_token: string; offer_sent_at: string; status: string }
/** Auto-send the candidate's personal experience link over WhatsApp (admin-gated). */
async function sendExperienceLink(id: string): Promise<SendExperienceResult> {
  const res = await fetch('/api/careers/send-experience', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ id, origin: window.location.origin }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<SendExperienceResult> & { error?: string };
  if (!res.ok || !body.link) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as SendExperienceResult;
}

export default function JobApplicationsPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [apps, setApps] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expFilter, setExpFilter] = useState('');
  const [selected, setSelected] = useState<JobApplication | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [msgTemplate, setMsgTemplate] = useState('');
  const [msgSaving, setMsgSaving] = useState(false);

  // Editable WhatsApp message for the experience link (careers_settings singleton).
  useEffect(() => {
    if (!supabase) return;
    void supabase.from('careers_settings').select('experience_message').eq('id', 1).maybeSingle()
      .then(({ data }) => { if (data?.experience_message != null) setMsgTemplate(data.experience_message as string); });
  }, []);

  const saveMessage = async () => {
    if (!supabase) return;
    setMsgSaving(true);
    const { error: err } = await supabase.from('careers_settings').update({ experience_message: msgTemplate }).eq('id', 1);
    setMsgSaving(false);
    if (err) { addToast(isAr ? `تعذّر الحفظ: ${err.message}` : `Could not save: ${err.message}`, 'error'); return; }
    addToast(isAr ? 'تم حفظ الرسالة' : 'Message saved', 'success');
    setSettingsOpen(false);
  };

  const load = useCallback(async () => {
    if (!supabase) { setError(isAr ? 'قاعدة البيانات غير متصلة' : 'Database not connected'); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('job_applications')
      .select('*')
      .order('created_at', { ascending: false });
    if (err) { setError(err.message); setLoading(false); return; }
    setApps((data ?? []) as JobApplication[]);
    setLoading(false);
  }, [isAr]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return apps.filter((a) => {
      if (statusFilter && a.status !== statusFilter) return false;
      if (expFilter && a.experience_level !== expFilter) return false;
      if (q) {
        const hay = `${a.full_name} ${a.phone} ${a.phone_raw ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [apps, search, statusFilter, expFilter]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of apps) m[a.status] = (m[a.status] ?? 0) + 1;
    return m;
  }, [apps]);

  // Offer-experience funnel: who got a link, opened it, stalled, or finished.
  const expStats = useMemo(() => {
    let sent = 0, opened = 0, notOpened = 0, noDecision = 0, interested = 0, declined = 0;
    for (const a of apps) {
      if (!a.offer_sent_at && !a.invite_token) continue; // link never sent
      sent++;
      const isOpened = !!a.experience_confirmed_at;
      if (isOpened) opened++; else notOpened++;
      if (a.experience_decision === 'interested') interested++;
      else if (a.experience_decision === 'declined') declined++;
      else if (isOpened) noDecision++;
    }
    return { sent, opened, notOpened, noDecision, interested, declined };
  }, [apps]);

  /**
   * Optimistic patch of the admin-editable columns (status / offer / notes).
   * Rolls back list + drawer and toasts on failure — never a silent loss.
   * Returns true when the write landed so callers can clear a "dirty" flag.
   */
  const patchApp = async (id: string, patch: AppPatch): Promise<boolean> => {
    if (!supabase) return false;
    const prevApps = apps;
    const prevSelected = selected;
    setApps((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    setSelected((s) => (s && s.id === id ? { ...s, ...patch } : s));
    const { error: err } = await supabase.from('job_applications').update(patch).eq('id', id);
    if (err) {
      console.error('[job_applications] patch failed', { id, patch, err });
      setApps(prevApps);
      setSelected((s) => (s && s.id === id ? prevSelected : s));
      addToast(isAr ? `تعذّر الحفظ: ${err.message}` : `Could not save: ${err.message}`, 'error');
      return false;
    }
    return true;
  };

  /** Local-only patch (no DB write) — used after a server action already persisted. */
  const applyLocal = (id: string, patch: Partial<JobApplication>) => {
    setApps((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    setSelected((s) => (s && s.id === id ? { ...s, ...patch } : s));
  };

  const updateStatus = (app: JobApplication, status: string) => {
    const patch: AppPatch = { status };
    // First move to "offer sent" stamps the send time; later re-selections keep the original.
    if (status === 'offer_sent' && !app.offer_sent_at) patch.offer_sent_at = new Date().toISOString();
    return patchApp(app.id, patch);
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium' });

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: '#B8734F14' }}>
            <Briefcase size={22} style={{ color: '#B8734F' }} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-charcoal">{isAr ? 'طلبات التوظيف' : 'Job Applications'}</h1>
            <p className="text-sm text-charcoal/50">{isAr ? 'مستشار مبيعات عقارية' : 'Real-estate sales consultant'} · {apps.length}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setSettingsOpen(true)} className="p-2.5 rounded-xl bg-white border border-sand/30 hover:bg-cream" title={isAr ? 'إعدادات رسالة الرابط' : 'Link message settings'}>
            <Settings size={18} className="text-charcoal/60" />
          </button>
          <button onClick={() => void load()} className="p-2.5 rounded-xl bg-white border border-sand/30 hover:bg-cream" title={isAr ? 'تحديث' : 'Refresh'}>
            <RefreshCw size={18} className="text-charcoal/60" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={18} className="absolute top-1/2 -translate-y-1/2 text-charcoal/40" style={{ [isAr ? 'right' : 'left']: 12 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAr ? 'ابحث بالاسم أو رقم الجوال…' : 'Search by name or phone…'}
            className="w-full rounded-xl border border-sand/40 bg-white py-2.5 text-sm outline-none focus:ring-2 focus:ring-copper/20"
            style={{ paddingInlineStart: 38, paddingInlineEnd: 12 }}
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-xl border border-sand/40 bg-white px-3 py-2.5 text-sm outline-none">
          <option value="">{isAr ? 'كل الحالات' : 'All statuses'}</option>
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{isAr ? s.ar : s.en}{counts[s.value] ? ` (${counts[s.value]})` : ''}</option>)}
        </select>
        <select value={expFilter} onChange={(e) => setExpFilter(e.target.value)} className="rounded-xl border border-sand/40 bg-white px-3 py-2.5 text-sm outline-none">
          <option value="">{isAr ? 'كل مستويات الخبرة' : 'All experience'}</option>
          {EXPERIENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {expStats.sent > 0 && (
        <div className="mb-5 rounded-2xl bg-white border border-sand/30 p-4">
          <p className="text-xs text-charcoal/40 mb-3 flex items-center gap-1.5"><MessageCircle size={13} /> {isAr ? 'تحليل تجربة العرض' : 'Offer-experience funnel'}</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <FunnelStat n={expStats.sent} label={isAr ? 'أُرسل الرابط' : 'Link sent'} color="#0EA5E9" />
            <FunnelStat n={expStats.notOpened} label={isAr ? 'لم يُفتح' : 'Not opened'} color="#9CA3AF" />
            <FunnelStat n={expStats.opened} label={isAr ? 'فُتح الرابط' : 'Opened'} color="#8B5CF6" />
            <FunnelStat n={expStats.noDecision} label={isAr ? 'فتح ولم يُكمل' : 'Opened, no decision'} color="#D97706" />
            <FunnelStat n={expStats.interested} label={isAr ? 'مهتم' : 'Interested'} color="#059669" />
            <FunnelStat n={expStats.declined} label={isAr ? 'اعتذر' : 'Declined'} color="#B45309" />
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-charcoal/50"><Loader2 className="animate-spin" size={20} /> {isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>
      ) : error ? (
        <div className="flex items-center gap-2 rounded-xl bg-terracotta/10 text-terracotta px-4 py-3 text-sm"><AlertTriangle size={18} /> {error}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-charcoal/40">{isAr ? 'لا توجد طلبات مطابقة' : 'No matching applications'}</div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((a) => {
            const st = statusOf(a.status);
            return (
              <button
                key={a.id}
                onClick={() => setSelected(a)}
                className="w-full flex items-center gap-4 rounded-2xl bg-white border border-sand/30 p-4 text-start hover:shadow-md transition-shadow"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-charcoal truncate">{a.full_name}</p>
                  <p className="text-sm text-charcoal/50 flex items-center gap-1.5" dir="ltr">
                    <Phone size={13} /> {a.phone}
                  </p>
                </div>
                <div className="hidden sm:block text-sm text-charcoal/50 shrink-0">{experienceLabel(a.experience_level)}</div>
                <div className="text-xs text-charcoal/40 flex items-center gap-1 shrink-0"><Clock size={12} /> {fmtDate(a.created_at)}</div>
                <span className="shrink-0 rounded-full px-3 py-1 text-xs font-bold text-white" style={{ background: st.color }}>{isAr ? st.ar : st.en}</span>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <DetailDrawer
          app={selected}
          isAr={isAr}
          onClose={() => setSelected(null)}
          onStatus={(status) => void updateStatus(selected, status)}
          onPatch={(patch) => patchApp(selected.id, patch)}
          onLocalPatch={(patch) => applyLocal(selected.id, patch)}
          onToast={(m, t) => addToast(m, t)}
          fmtDate={fmtDate}
        />
      )}

      {settingsOpen && (
        <MessageSettingsModal
          isAr={isAr}
          value={msgTemplate}
          onChange={setMsgTemplate}
          saving={msgSaving}
          onSave={() => void saveMessage()}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

/** View + edit the WhatsApp message sent with the experience link. */
function MessageSettingsModal({
  isAr, value, onChange, saving, onSave, onClose,
}: {
  isAr: boolean; value: string; onChange: (v: string) => void;
  saving: boolean; onSave: () => void; onClose: () => void;
}) {
  const preview = value
    .split('{name}').join('أبو فيصل')
    .split('{link}').join('https://app.wassel.re/careers/experience/…');
  const inputCls = 'w-full rounded-lg border border-sand/40 bg-white px-3 py-2 text-sm text-charcoal outline-none focus:ring-2 focus:ring-copper/20';
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!saving) onClose(); }}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-copper/10 text-copper"><MessageCircle size={18} /></span>
            <h3 className="font-bold text-charcoal">{isAr ? 'رسالة رابط التجربة' : 'Experience link message'}</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-sand/20"><X size={18} className="text-charcoal/60" /></button>
        </div>

        <p className="text-xs text-charcoal/50 leading-relaxed mb-2">
          {isAr
            ? 'هذه الرسالة تُرسَل مع الرابط عبر واتساب. استخدم {name} لاسم المرشّح و{link} لرابطه الخاص.'
            : 'This message is sent with the link over WhatsApp. Use {name} for the candidate name and {link} for their personal link.'}
        </p>

        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={7} className={`${inputCls} resize-y`} dir="rtl" />

        <div className="mt-3">
          <p className="text-xs text-charcoal/40 mb-1.5 flex items-center gap-1.5"><Eye size={13} /> {isAr ? 'معاينة' : 'Preview'}</p>
          <div className="rounded-xl p-3" style={{ background: '#EDE0CC' }}>
            <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-white px-3 py-2 text-sm leading-relaxed text-charcoal whitespace-pre-wrap break-words">{preview}</div>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-sand/40 bg-white px-4 py-2 text-sm font-bold text-charcoal disabled:opacity-50">{isAr ? 'إلغاء' : 'Cancel'}</button>
          <button onClick={onSave} disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {isAr ? 'حفظ' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailDrawer({
  app, isAr, onClose, onStatus, onPatch, onLocalPatch, onToast, fmtDate,
}: {
  app: JobApplication; isAr: boolean; onClose: () => void;
  onStatus: (status: string) => void;
  onPatch: (patch: AppPatch) => Promise<boolean>;
  onLocalPatch: (patch: Partial<JobApplication>) => void;
  onToast: (m: string, t: 'error' | 'success') => void;
  fmtDate: (iso: string) => string;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const experienceLink = app.invite_token ? `${window.location.origin}/careers/experience/${app.invite_token}` : null;

  const doSendExperience = async () => {
    setBusy('send');
    try {
      const r = await sendExperienceLink(app.id);
      onLocalPatch({ invite_token: r.invite_token, status: 'offer_sent', offer_sent_at: r.offer_sent_at });
      onToast(isAr ? 'تم إرسال رابط التجربة عبر واتساب' : 'Experience link sent via WhatsApp', 'success');
      setConfirmSend(false);
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'error', 'error');
    } finally { setBusy(null); }
  };

  const copyLink = async () => {
    if (!experienceLink) return;
    try { await navigator.clipboard.writeText(experienceLink); onToast(isAr ? 'تم نسخ الرابط' : 'Link copied', 'success'); }
    catch { onToast(isAr ? 'تعذّر النسخ' : 'Copy failed', 'error'); }
  };

  // Offer + notes drafts. Re-seeded whenever a different application opens.
  const str = (n: number | null) => (n != null ? String(n) : '');
  const [offerSalary, setOfferSalary] = useState(str(app.offer_salary));
  const [offerCommission, setOfferCommission] = useState(app.offer_commission ?? '');
  const [offerDetails, setOfferDetails] = useState(app.offer_details ?? '');
  const [offerSales, setOfferSales] = useState(str(app.offer_sales_per_month));
  const [offerAvgPrice, setOfferAvgPrice] = useState(str(app.offer_avg_sale_price ?? DEFAULT_AVG_SALE_PRICE));
  const [offerCompanyPct, setOfferCompanyPct] = useState(str(app.offer_company_commission_pct ?? DEFAULT_COMPANY_COMMISSION_PCT));
  const [includeDetailsInPdf, setIncludeDetailsInPdf] = useState(true);
  const [notes, setNotes] = useState(app.review_notes ?? '');
  useEffect(() => {
    setOfferSalary(str(app.offer_salary));
    setOfferCommission(app.offer_commission ?? '');
    setOfferDetails(app.offer_details ?? '');
    setOfferSales(str(app.offer_sales_per_month));
    setOfferAvgPrice(str(app.offer_avg_sale_price ?? DEFAULT_AVG_SALE_PRICE));
    setOfferCompanyPct(str(app.offer_company_commission_pct ?? DEFAULT_COMPANY_COMMISSION_PCT));
    setIncludeDetailsInPdf(true);
    setNotes(app.review_notes ?? '');
    setAudioUrl(null);
  }, [app.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parsed numbers (null = unset, NaN = invalid).
  const salaryNum = parseNum(offerSalary);
  const repPctNum = parseNum(offerCommission);
  const salesNum = parseNum(offerSales);
  const avgPriceNum = parseNum(offerAvgPrice);
  const companyPctNum = parseNum(offerCompanyPct);
  const invalid = [salaryNum, repPctNum, salesNum, avgPriceNum, companyPctNum].some((n) => n != null && Number.isNaN(n));
  const bad = (n: number | null) => n != null && Number.isNaN(n);

  // Cost projection: company commission per sale → rep's share → × sales → + salary.
  const companyPerSale = avgPriceNum != null && companyPctNum != null && !bad(avgPriceNum) && !bad(companyPctNum)
    ? avgPriceNum * (companyPctNum / 100) : null;
  const repPerSale = companyPerSale != null && repPctNum != null && !bad(repPctNum) ? companyPerSale * (repPctNum / 100) : null;
  const monthlyCommission = repPerSale != null && salesNum != null && !bad(salesNum) ? repPerSale * salesNum : null;
  const monthlyCost = monthlyCommission != null || (salaryNum != null && !bad(salaryNum))
    ? (bad(salaryNum) ? 0 : salaryNum ?? 0) + (monthlyCommission ?? 0) : null;
  const annualCost = monthlyCost != null ? monthlyCost * 12 : null;
  const money = (n: number | null) => (n == null ? '—' : `${Math.round(n).toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}`);

  const same = (a: number | null, b: number | null) => (a == null ? null : a) === (b == null ? null : b);
  const offerDirty =
    !same(bad(salaryNum) ? null : salaryNum, app.offer_salary) ||
    (offerCommission.trim() || null) !== (app.offer_commission || null) ||
    (offerDetails.trim() || null) !== (app.offer_details || null) ||
    !same(bad(salesNum) ? null : salesNum, app.offer_sales_per_month) ||
    !same(bad(avgPriceNum) ? null : avgPriceNum, app.offer_avg_sale_price ?? DEFAULT_AVG_SALE_PRICE) ||
    !same(bad(companyPctNum) ? null : companyPctNum, app.offer_company_commission_pct ?? DEFAULT_COMPANY_COMMISSION_PCT);
  const notesDirty = (notes.trim() || null) !== (app.review_notes || null);

  const saveOffer = async (): Promise<boolean> => {
    if (invalid) { onToast(isAr ? 'تحقق من الأرقام المدخلة في العرض' : 'Check the numbers entered in the offer', 'error'); return false; }
    setBusy('offer');
    const ok = await onPatch({
      offer_salary: salaryNum,
      offer_commission: offerCommission.trim() || null,
      offer_details: offerDetails.trim() || null,
      offer_sales_per_month: salesNum,
      offer_avg_sale_price: avgPriceNum,
      offer_company_commission_pct: companyPctNum,
    });
    setBusy(null);
    if (ok) onToast(isAr ? 'تم حفظ العرض' : 'Offer saved', 'success');
    return ok;
  };

  /** Candidate-facing offer letter. Saves first when the card has unsaved edits. */
  const exportOfferPdf = async () => {
    if (offerDirty) {
      const ok = await saveOffer();
      if (!ok) return;
    }
    setBusy('pdf');
    try {
      const blob = await buildOfferLetterPdf({
        candidateName: app.full_name,
        candidatePhone: app.phone,
        salary: bad(salaryNum) ? null : salaryNum,
        commissionPct: bad(repPctNum) ? null : repPctNum,
        details: offerDetails.trim() || null,
        includeDetails: includeDetailsInPdf,
        isAr,
      });
      downloadPdf(blob, offerPdfFilename(app.full_name));
    } catch (e) {
      console.error('[job_applications] offer pdf failed', e);
      onToast(isAr ? `تعذّر إنشاء الملف: ${e instanceof Error ? e.message : 'error'}` : `Could not build the PDF: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally { setBusy(null); }
  };

  const saveNotes = async () => {
    setBusy('notes');
    const ok = await onPatch({ review_notes: notes.trim() || null });
    setBusy(null);
    if (ok) onToast(isAr ? 'تم حفظ الملاحظات' : 'Notes saved', 'success');
  };

  const inputCls = 'w-full rounded-lg border border-sand/40 bg-white px-3 py-2 text-sm text-charcoal outline-none focus:ring-2 focus:ring-copper/20';

  const openCv = async (download: boolean) => {
    setBusy(download ? 'cv-dl' : 'cv');
    try {
      const url = await fileUrl(app.id, 'cv', download);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      onToast((e instanceof Error ? e.message : 'error'), 'error');
    } finally { setBusy(null); }
  };

  const loadAudio = async () => {
    setBusy('audio');
    try {
      setAudioUrl(await fileUrl(app.id, 'audio', false));
    } catch (e) {
      onToast((e instanceof Error ? e.message : 'error'), 'error');
    } finally { setBusy(null); }
  };

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="py-3 border-b border-sand/20">
      <p className="text-xs text-charcoal/40 mb-1">{label}</p>
      <div className="text-charcoal font-medium break-words whitespace-pre-wrap">{children}</div>
    </div>
  );

  const attribution = { ...(app.utm ?? {}), ...(app.click_ids ?? {}) };
  const hasAttribution = Object.keys(attribution).length > 0 || app.source_url;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-md bg-cream-light h-full overflow-y-auto overflow-x-hidden shadow-2xl" style={{ [isAr ? 'borderLeft' : 'borderRight']: 'none' }}>
        <div className="sticky top-0 bg-cream-light/95 backdrop-blur border-b border-sand/30 px-5 py-4 flex items-center justify-between z-10">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-charcoal truncate">{app.full_name}</h2>
            <a href={`tel:${app.phone}`} className="text-sm text-copper flex items-center gap-1.5" dir="ltr"><Phone size={13} /> {app.phone}</a>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-sand/20"><X size={20} className="text-charcoal/60" /></button>
        </div>

        <div className="px-5 py-4">
          {/* Status control */}
          <div className="mb-4">
            <p className="text-xs text-charcoal/40 mb-2">{isAr ? 'الحالة' : 'Status'}</p>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => {
                const active = app.status === s.value;
                return (
                  <button
                    key={s.value}
                    onClick={() => onStatus(s.value)}
                    className="rounded-full px-3 py-1.5 text-xs font-bold border transition-all"
                    style={active
                      ? { background: s.color, color: '#fff', borderColor: s.color }
                      : { background: '#fff', color: s.color, borderColor: `${s.color}55` }}
                  >
                    {isAr ? s.ar : s.en}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reviewer notes — impression of the candidate, internal only */}
          <div className="rounded-xl bg-white border border-sand/30 p-4 mb-4">
            <p className="text-xs text-charcoal/40 mb-2 flex items-center gap-1.5"><StickyNote size={13} /> {isAr ? 'ملاحظات المراجعة' : 'Review notes'}</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={isAr ? 'انطباعك عن المتقدم…' : 'Your impression of the candidate…'}
              className={inputCls}
            />
            <div className="flex justify-end mt-2">
              <button
                onClick={() => void saveNotes()}
                disabled={!notesDirty || !!busy}
                className="flex items-center gap-1.5 rounded-lg bg-copper text-white text-xs font-bold px-3 py-1.5 disabled:opacity-40"
              >
                {busy === 'notes' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} {isAr ? 'حفظ الملاحظات' : 'Save notes'}
              </button>
            </div>
          </div>

          {/* Offer — what we intend to submit / did submit to the candidate */}
          <div
            className="rounded-xl bg-white border p-4 mb-4"
            style={{ borderColor: OFFER_STATUSES.has(app.status) ? '#D9770655' : undefined }}
          >
            <p className="text-xs text-charcoal/40 mb-2 flex items-center gap-1.5">
              <HandCoins size={13} /> {isAr ? 'العرض الوظيفي' : 'Job offer'}
              {app.offer_sent_at && (
                <span className="ms-auto text-[11px] text-sky-600">{isAr ? 'أُرسل' : 'Sent'} {fmtDate(app.offer_sent_at)}</span>
              )}
            </p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <label className="block text-[11px] text-charcoal/50 mb-1">{isAr ? 'الراتب الأساسي (ر.س)' : 'Base salary (SAR)'}</label>
                <input
                  value={offerSalary}
                  onChange={(e) => setOfferSalary(e.target.value)}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder={app.expected_salary != null ? String(app.expected_salary) : '6000'}
                  className={inputCls}
                  style={bad(salaryNum) ? { borderColor: '#8E4E3A' } : undefined}
                />
              </div>
              <div>
                <label className="block text-[11px] text-charcoal/50 mb-1">{isAr ? 'عمولة الموظف (٪ من عمولة الشركة)' : "Rep commission (% of company's)"}</label>
                <input
                  value={offerCommission}
                  onChange={(e) => setOfferCommission(e.target.value)}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder={app.expected_commission || (isAr ? 'مثال: 12%' : 'e.g. 12%')}
                  className={inputCls}
                  style={bad(repPctNum) ? { borderColor: '#8E4E3A' } : undefined}
                />
              </div>
            </div>

            {/* Cost projection inputs */}
            <div className="grid grid-cols-3 gap-2 mb-2">
              <div>
                <label className="block text-[11px] text-charcoal/50 mb-1">{isAr ? 'مبيعات / شهر' : 'Sales / month'}</label>
                <input value={offerSales} onChange={(e) => setOfferSales(e.target.value)} inputMode="decimal" dir="ltr" placeholder="2" className={inputCls} style={bad(salesNum) ? { borderColor: '#8E4E3A' } : undefined} />
              </div>
              <div>
                <label className="block text-[11px] text-charcoal/50 mb-1">{isAr ? 'متوسط سعر البيع' : 'Avg sale price'}</label>
                <input value={offerAvgPrice} onChange={(e) => setOfferAvgPrice(e.target.value)} inputMode="decimal" dir="ltr" placeholder={String(DEFAULT_AVG_SALE_PRICE)} className={inputCls} style={bad(avgPriceNum) ? { borderColor: '#8E4E3A' } : undefined} />
              </div>
              <div>
                <label className="block text-[11px] text-charcoal/50 mb-1">{isAr ? 'عمولة الشركة ٪' : 'Company comm. %'}</label>
                <input value={offerCompanyPct} onChange={(e) => setOfferCompanyPct(e.target.value)} inputMode="decimal" dir="ltr" placeholder={String(DEFAULT_COMPANY_COMMISSION_PCT)} className={inputCls} style={bad(companyPctNum) ? { borderColor: '#8E4E3A' } : undefined} />
              </div>
            </div>

            {/* Cost projection (internal — never printed on the offer letter) */}
            <div className="rounded-lg bg-cream/70 border border-sand/30 px-3 py-2 mb-3 text-xs">
              <p className="text-[11px] font-bold text-charcoal/60 mb-1.5 flex items-center gap-1.5"><Calculator size={12} /> {isAr ? 'تقدير التكلفة علينا' : 'Projected cost to us'}</p>
              <div className="flex justify-between py-0.5 text-charcoal/70"><span>{isAr ? 'عمولة الشركة عن كل بيعة' : 'Company commission / sale'}</span><span dir="ltr">{money(companyPerSale)}</span></div>
              <div className="flex justify-between py-0.5 text-charcoal/70"><span>{isAr ? 'عمولة الموظف عن كل بيعة' : 'Rep commission / sale'}</span><span dir="ltr">{money(repPerSale)}</span></div>
              <div className="flex justify-between py-0.5 text-charcoal/70"><span>{isAr ? 'عمولة الموظف شهريًا' : 'Rep commission / month'}</span><span dir="ltr">{money(monthlyCommission)}</span></div>
              <div className="flex justify-between py-1 mt-1 border-t border-sand/40 font-bold text-charcoal"><span>{isAr ? 'التكلفة الشهرية (راتب + عمولة)' : 'Monthly cost (salary + commission)'}</span><span dir="ltr">{money(monthlyCost)}</span></div>
              <div className="flex justify-between py-0.5 text-charcoal/70"><span>{isAr ? 'التكلفة السنوية' : 'Annual cost'}</span><span dir="ltr">{money(annualCost)}</span></div>
            </div>

            <label className="block text-[11px] text-charcoal/50 mb-1">{isAr ? 'تفاصيل العرض والمكافآت' : 'Offer details & bonuses'}</label>
            <textarea
              value={offerDetails}
              onChange={(e) => setOfferDetails(e.target.value)}
              rows={3}
              placeholder={isAr ? 'المكافآت، تاريخ المباشرة، فترة التجربة، شروط أخرى…' : 'Bonuses, start date, probation, other terms…'}
              className={inputCls}
            />
            <div className="flex items-center justify-between mt-2 gap-2">
              <p className="text-[11px] text-charcoal/40">
                {isAr ? 'المطلوب:' : 'Asked:'} {app.expected_salary != null ? app.expected_salary.toLocaleString(isAr ? 'ar-SA' : 'en-US') : '—'} {app.expected_commission ? `· ${app.expected_commission}` : ''}
              </p>
              <button
                onClick={() => void saveOffer()}
                disabled={!offerDirty || !!busy}
                className="flex items-center gap-1.5 rounded-lg bg-copper text-white text-xs font-bold px-3 py-1.5 disabled:opacity-40"
              >
                {busy === 'offer' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} {isAr ? 'حفظ العرض' : 'Save offer'}
              </button>
            </div>

            {/* Offer letter PDF */}
            <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-sand/30">
              <label className="flex items-center gap-1.5 text-[11px] text-charcoal/60 select-none">
                <input
                  type="checkbox"
                  checked={includeDetailsInPdf && !!offerDetails.trim()}
                  disabled={!offerDetails.trim()}
                  onChange={(e) => setIncludeDetailsInPdf(e.target.checked)}
                  className="accent-copper"
                />
                {isAr ? 'تضمين التفاصيل والمكافآت في الملف' : 'Include details & bonuses in the letter'}
              </label>
              <button
                onClick={() => void exportOfferPdf()}
                disabled={!!busy || invalid || (salaryNum == null && repPctNum == null)}
                className="flex items-center gap-1.5 rounded-lg bg-chocolate text-white text-xs font-bold px-3 py-1.5 disabled:opacity-40"
                title={isAr ? 'ملف عرض العمل الرسمي (PDF)' : 'Official offer letter (PDF)'}
              >
                {busy === 'pdf' ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />} {isAr ? 'ملف العرض PDF' : 'Offer letter PDF'}
              </button>
            </div>
          </div>

          {/* Recruitment experience link + the candidate's own decision */}
          <div className="rounded-xl bg-white border p-4 mb-4" style={{ borderColor: app.experience_decision ? '#05966955' : undefined }}>
            <p className="text-xs text-charcoal/40 mb-2 flex items-center gap-1.5">
              <MessageCircle size={13} /> {isAr ? 'تجربة المرشّح (رابط العرض)' : 'Candidate experience (offer link)'}
            </p>
            <p className="text-[11px] text-charcoal/50 mb-3 leading-relaxed">
              {isAr
                ? 'يُرسَل للمرشّح رابط خاص عبر واتساب: يؤكّد بياناته، يطّلع على طريقة العمل والدخل، ثم يختار المقابلة أو الاعتذار — والاختيار يحدّث الحالة تلقائيًا.'
                : 'Sends a personal WhatsApp link: confirm details, see the role + income, then choose an interview or decline — their choice updates the status automatically.'}
            </p>

            <button
              onClick={() => setConfirmSend(true)}
              disabled={!!busy}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-[#25D366] text-white text-sm font-bold py-2.5 disabled:opacity-50"
            >
              {busy === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              {app.invite_token ? (isAr ? 'إعادة إرسال الرابط' : 'Resend link') : (isAr ? 'إرسال رابط التجربة عبر واتساب' : 'Send experience link via WhatsApp')}
            </button>

            {experienceLink && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-cream/60 border border-sand/30 px-2.5 py-2">
                <Link2 size={13} className="text-charcoal/40 shrink-0" />
                <span className="flex-1 text-[11px] text-charcoal/60 truncate" dir="ltr">{experienceLink}</span>
                <button onClick={() => void copyLink()} className="shrink-0 p-1 rounded hover:bg-sand/30" title={isAr ? 'نسخ' : 'Copy'}><Copy size={14} className="text-charcoal/50" /></button>
              </div>
            )}

            {app.experience_confirmed_at && (
              <p className="mt-2 text-[11px] text-charcoal/50 flex items-center gap-1.5"><CheckCircle2 size={12} className="text-emerald-600" /> {isAr ? 'أكّد بياناته' : 'Confirmed details'} · {fmtDate(app.experience_confirmed_at)}</p>
            )}

            {app.experience_decision === 'interested' && (
              <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800 flex items-center gap-2">
                <CheckCircle2 size={15} /> {isAr ? 'مهتم — يريد المقابلة' : 'Interested — wants an interview'}
              </div>
            )}
            {app.experience_decision === 'declined' && (
              <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-800">
                <div className="flex items-center gap-2 font-bold"><XCircle size={15} /> {isAr ? 'العرض غير مناسب له' : 'Not interested'}</div>
                {app.experience_decline_category && (
                  <p className="mt-1 text-[13px]">
                    <span className="font-semibold">{isAr ? 'السبب:' : 'Reason:'}</span>{' '}
                    {declineCategoryLabel(app.experience_decline_category, isAr)}
                    {app.experience_decline_reason && (
                      <> — {app.experience_decline_category === 'salary' ? (isAr ? 'الراتب المناسب له:' : 'Desired salary:')
                        : app.experience_decline_category === 'commission' ? (isAr ? 'العمولة المناسبة له:' : 'Desired commission:')
                        : ''} {app.experience_decline_reason}</>
                    )}
                  </p>
                )}
                {!app.experience_decline_category && app.experience_decline_reason && (
                  <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{app.experience_decline_reason}</p>
                )}
              </div>
            )}
          </div>

          {/* Files */}
          <div className="grid grid-cols-1 gap-3 mb-4">
            <div className="rounded-xl bg-white border border-sand/30 p-4">
              <p className="text-xs text-charcoal/40 mb-2 flex items-center gap-1.5"><FileText size={13} /> {isAr ? 'السيرة الذاتية' : 'CV'}</p>
              {app.cv_path ? (
                <div className="flex items-center gap-2">
                  <button onClick={() => void openCv(false)} disabled={!!busy} className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-copper text-white text-sm font-bold py-2 disabled:opacity-50">
                    {busy === 'cv' ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />} {isAr ? 'عرض' : 'View'}
                  </button>
                  <button onClick={() => void openCv(true)} disabled={!!busy} className="flex items-center justify-center gap-2 rounded-lg bg-white border border-sand/40 text-charcoal text-sm font-bold px-3 py-2 disabled:opacity-50" title={isAr ? 'تنزيل' : 'Download'}>
                    {busy === 'cv-dl' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  </button>
                </div>
              ) : <p className="text-sm text-charcoal/40">{isAr ? 'لا يوجد' : 'None'}</p>}
              {app.cv_name && <p className="text-xs text-charcoal/40 mt-2 truncate">{app.cv_name}</p>}
            </div>

            <div className="rounded-xl bg-white border border-sand/30 p-4">
              <p className="text-xs text-charcoal/40 mb-2 flex items-center gap-1.5"><Play size={13} /> {isAr ? 'التسجيل الصوتي' : 'Voice recording'}
                {app.audio_duration_sec ? <span dir="ltr"> · {Math.floor(app.audio_duration_sec / 60)}:{String(app.audio_duration_sec % 60).padStart(2, '0')}</span> : null}
              </p>
              {app.audio_path ? (
                audioUrl ? (
                  <audio src={audioUrl} controls className="w-full" />
                ) : (
                  <button onClick={() => void loadAudio()} disabled={!!busy} className="w-full flex items-center justify-center gap-2 rounded-lg bg-copper text-white text-sm font-bold py-2 disabled:opacity-50">
                    {busy === 'audio' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} {isAr ? 'تشغيل التسجيل' : 'Play recording'}
                  </button>
                )
              ) : <p className="text-sm text-charcoal/40">{isAr ? 'لا يوجد' : 'None'}</p>}
            </div>
          </div>

          {/* Answers */}
          <Row label={isAr ? 'الوضع الحالي' : 'Current situation'}>{situationLabel(app.current_situation)}</Row>
          <Row label={isAr ? 'الخبرة في المبيعات العقارية' : 'Experience'}>{experienceLabel(app.experience_level)}</Row>
          {app.experience_results && <Row label={isAr ? 'النتائج السابقة' : 'Past results'}>{app.experience_results}</Row>}
          <Row label={isAr ? 'الالتزام بالعمل الحضوري 6 أيام' : 'Can commit (6 days on-site)'}>{yesNoLabel(app.can_commit)}</Row>
          <Row label={isAr ? 'الراتب الأساسي المتوقع' : 'Expected base salary'}>{app.expected_salary != null ? `${app.expected_salary.toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}` : '—'}</Row>
          <Row label={isAr ? 'نسبة العمولة المتوقعة' : 'Expected commission'}>{app.expected_commission || '—'}</Row>
          {app.additional_notes && <Row label={isAr ? 'إضافات أخرى' : 'Additional notes'}>{app.additional_notes}</Row>}
          <Row label={isAr ? 'تاريخ التقديم' : 'Submitted'}>{fmtDate(app.created_at)}</Row>

          {hasAttribution && (
            <div className="mt-4 rounded-xl bg-white border border-sand/30 p-4">
              <p className="text-xs text-charcoal/40 mb-2 flex items-center gap-1.5"><Megaphone size={13} /> {isAr ? 'مصدر الإعلان' : 'Ad attribution'}</p>
              {app.source_url && <p className="text-xs text-charcoal/50 break-all mb-2" dir="ltr">{app.source_url}</p>}
              {Object.keys(attribution).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(attribution).map(([k, v]) => (
                    <span key={k} className="max-w-full break-all rounded-md bg-cream px-2 py-1 text-[11px] text-charcoal/60" dir="ltr">{k}: {v}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {confirmSend && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!busy) setConfirmSend(false); }}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#25D366]/15 text-[#128C7E]"><MessageCircle size={18} /></span>
              <h3 className="font-bold text-charcoal">{isAr ? 'إرسال رابط التجربة' : 'Send experience link'}</h3>
            </div>
            <p className="text-sm text-charcoal/70 leading-relaxed">{isAr ? 'سيُرسَل رابط خاص عبر واتساب إلى:' : 'A personal link will be sent via WhatsApp to:'}</p>
            <div className="my-3 rounded-lg bg-cream/60 px-3 py-2">
              <div className="font-bold text-charcoal">{app.full_name}</div>
              <div className="text-sm text-charcoal/60" dir="ltr">{app.phone}</div>
            </div>
            <p className="text-xs text-charcoal/50">{isAr ? 'وستتحوّل حالته إلى «تم إرسال العرض».' : 'Their status will change to “Offer sent”.'}</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setConfirmSend(false)} disabled={!!busy} className="flex-1 rounded-lg border border-sand/40 bg-white py-2 text-sm font-bold text-charcoal disabled:opacity-50">{isAr ? 'إلغاء' : 'Cancel'}</button>
              <button onClick={() => void doSendExperience()} disabled={!!busy} className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-[#25D366] py-2 text-sm font-bold text-white disabled:opacity-50">
                {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {isAr ? 'إرسال الآن' : 'Send now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
