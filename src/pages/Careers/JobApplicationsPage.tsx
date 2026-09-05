import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Loader2, Search, FileText, Download, Play, X, RefreshCw, Phone, Clock,
  Megaphone, AlertTriangle, Briefcase,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { SITUATION_OPTIONS, EXPERIENCE_OPTIONS, YES_NO_OPTIONS } from '@/lib/careers/form';

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
}

const STATUSES = [
  { value: 'new', ar: 'جديد', en: 'New', color: '#3B82F6' },
  { value: 'reviewing', ar: 'قيد المراجعة', en: 'Reviewing', color: '#C09B5F' },
  { value: 'interview', ar: 'للمقابلة', en: 'Interview', color: '#8B5CF6' },
  { value: 'rejected', ar: 'مرفوض', en: 'Rejected', color: '#8E4E3A' },
  { value: 'hired', ar: 'تم التوظيف', en: 'Hired', color: '#10B981' },
] as const;

const situationLabel = (v: string | null) => SITUATION_OPTIONS.find((o) => o.value === v)?.label ?? '—';
const experienceLabel = (v: string | null) => EXPERIENCE_OPTIONS.find((o) => o.value === v)?.label ?? '—';
const yesNoLabel = (v: string | null) => YES_NO_OPTIONS.find((o) => o.value === v)?.label ?? '—';
const statusOf = (v: string) => STATUSES.find((s) => s.value === v) ?? STATUSES[0];

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

  const updateStatus = async (id: string, status: string) => {
    if (!supabase) return;
    const prev = apps;
    setApps((list) => list.map((a) => (a.id === id ? { ...a, status } : a)));
    setSelected((s) => (s && s.id === id ? { ...s, status } : s));
    const { error: err } = await supabase.from('job_applications').update({ status }).eq('id', id);
    if (err) {
      setApps(prev);
      addToast(isAr ? 'تعذّر تحديث الحالة' : 'Could not update status', 'error');
    }
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
        <button onClick={() => void load()} className="p-2.5 rounded-xl bg-white border border-sand/30 hover:bg-cream" title={isAr ? 'تحديث' : 'Refresh'}>
          <RefreshCw size={18} className="text-charcoal/60" />
        </button>
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
          onStatus={(status) => updateStatus(selected.id, status)}
          onToast={(m, t) => addToast(m, t)}
          fmtDate={fmtDate}
        />
      )}
    </div>
  );
}

function DetailDrawer({
  app, isAr, onClose, onStatus, onToast, fmtDate,
}: {
  app: JobApplication; isAr: boolean; onClose: () => void;
  onStatus: (status: string) => void;
  onToast: (m: string, t: 'error' | 'success') => void;
  fmtDate: (iso: string) => string;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      <div className="w-full max-w-md bg-cream-light h-full overflow-y-auto shadow-2xl" style={{ [isAr ? 'borderLeft' : 'borderRight']: 'none' }}>
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
                    <span key={k} className="rounded-md bg-cream px-2 py-1 text-[11px] text-charcoal/60" dir="ltr">{k}: {v}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
