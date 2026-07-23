// Automated identity-discovery workspace (admin). Pick a monitored organization,
// run the Browserbase-backed discovery engine, and audit every scored candidate
// with its full reason breakdown + the run history. Read-mostly: the only write
// is "Run discovery", which enqueues an organization_discovery worker job.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Radar, Play, CheckCircle2, HelpCircle, ShieldAlert } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  fetchDiscoveryRuns, fetchDiscoveryCandidates, runOrganizationDiscovery,
  type DiscoveryRun, type IdentityCandidate,
} from '@/lib/marketing/client';

interface OrgLite { organization_id: string; name_ar: string | null; name_en: string | null }

const CONF_CLS: Record<string, string> = {
  high: 'bg-green-100 text-green-800', medium: 'bg-amber-100 text-amber-800', low: 'bg-charcoal/10 text-charcoal/60',
};
const CLASS_CLS: Record<string, string> = {
  organization: 'bg-copper/10 text-copper', marketplace: 'bg-red-100 text-red-700',
  broker: 'bg-amber-100 text-amber-800', unknown: 'bg-charcoal/10 text-charcoal/50',
};

function num(v: number | string): number { return typeof v === 'string' ? Number(v) : v; }

export default function DiscoveryPanel({ orgs }: { orgs: OrgLite[] }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const [orgId, setOrgId] = useState<string>('');
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [candidates, setCandidates] = useState<IdentityCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (org: string) => {
    if (!org) { setRuns([]); setCandidates([]); return; }
    setLoading(true);
    try {
      const [r, c] = await Promise.all([fetchDiscoveryRuns(org), fetchDiscoveryCandidates(org)]);
      setRuns(r.runs); setCandidates(c.candidates);
    } catch (e) {
      addToast(e instanceof Error ? e.message : L('فشل تحميل الاكتشاف', 'Failed to load discovery'), 'error');
    } finally { setLoading(false); }
  }, [addToast, isAr]);

  useEffect(() => { void load(orgId); }, [orgId, load]);

  const onRun = async () => {
    if (!orgId) { addToast(L('اختر مؤسسة أولًا', 'Pick an organization first'), 'error'); return; }
    setBusy(true);
    try {
      const { job_id } = await runOrganizationDiscovery(orgId);
      addToast(L('بدأ الاكتشاف — سيظهر خلال دقيقة', `Discovery queued (${job_id.slice(0, 8)}) — refresh in ~1 min`), 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : L('فشل بدء الاكتشاف', 'Failed to start discovery'), 'error');
    } finally { setBusy(false); }
  };

  const latest = runs[0] ?? null;
  const byPlatform = useMemo(() => {
    const m: Record<string, IdentityCandidate[]> = {};
    for (const c of candidates) (m[c.platform] ??= []).push(c);
    return m;
  }, [candidates]);

  return (
    <section className="card p-4 mb-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-charcoal flex items-center gap-2">
          <Radar size={16} className="text-chocolate" /> {L('اكتشاف الحسابات الآلي', 'Automated identity discovery')}
        </h2>
        <div className="flex items-center gap-2">
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="text-xs border border-sand rounded-lg px-2 py-1 bg-white max-w-[220px]">
            <option value="">{L('اختر مؤسسة…', 'Select organization…')}</option>
            {orgs.map((o) => <option key={o.organization_id} value={o.organization_id}>{isAr ? (o.name_ar ?? o.name_en) : (o.name_en ?? o.name_ar)}</option>)}
          </select>
          <button type="button" onClick={onRun} disabled={busy || !orgId} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-chocolate text-white hover:bg-chocolate/90 disabled:opacity-50">
            <Play size={14} /> {L('تشغيل الاكتشاف', 'Run discovery')}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-charcoal/40 mb-3">
        {L('يزحف موقع المؤسسة + يبحث في جوجل + يفحص الحسابات عبر Browserbase، ويثبّت فقط الحسابات ذات الدليل القوي (رابط متبادل).',
           'Crawls the org site + Google + inspects profiles via Browserbase, storing all evidence. Only link-back-anchored, non-marketplace winners are auto-confirmed.')}
      </p>

      {!orgId && <div className="text-xs text-charcoal/40">{L('اختر مؤسسة لعرض المرشحين وسجل الاكتشاف.', 'Select an organization to view candidates and discovery history.')}</div>}

      {orgId && (
        <>
          {latest && (
            <div className="mb-3 text-xs text-charcoal/60 flex flex-wrap gap-x-4 gap-y-1">
              <span>{L('آخر تشغيل', 'Last run')}: <b className={latest.status === 'done' ? 'text-green-700' : latest.status === 'failed' ? 'text-red-600' : 'text-amber-600'}>{latest.status}</b></span>
              <span>{L('استعلامات', 'Queries')}: {latest.queries_count}</span>
              <span>{L('أدلة', 'Evidence')}: {latest.evidence_count}</span>
              <span>{L('مرشحون', 'Candidates')}: {latest.candidates_count}</span>
              <span>{L('مؤكَّد', 'Confirmed')}: <b className="text-copper">{latest.confirmed_count}</b></span>
              <span>{L('التكلفة', 'Cost')}: ${num(latest.cost_usd).toFixed(3)}</span>
              {latest.error && <span className="text-red-600">{latest.error}</span>}
            </div>
          )}

          {loading ? (
            <div className="text-xs text-charcoal/40">{L('جارٍ التحميل…', 'Loading…')}</div>
          ) : candidates.length === 0 ? (
            <div className="text-xs text-charcoal/40">{L('لا مرشحون بعد — شغّل الاكتشاف.', 'No candidates yet — run discovery.')}</div>
          ) : (
            <div className="space-y-3">
              {Object.entries(byPlatform).map(([platform, list]) => (
                <div key={platform}>
                  <div className="text-[11px] uppercase tracking-wide text-charcoal/40 mb-1">{platform}</div>
                  <div className="space-y-1.5">
                    {list.sort((a, b) => num(b.score) - num(a.score)).map((c) => (
                      <div key={c.id} className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg border border-sand/50 bg-white">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-charcoal flex items-center gap-1.5 flex-wrap">
                            {c.status === 'confirmed' ? <CheckCircle2 size={13} className="text-green-600" />
                              : c.is_marketplace ? <ShieldAlert size={13} className="text-red-500" />
                              : <HelpCircle size={13} className="text-charcoal/40" />}
                            {c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="text-copper hover:underline">@{c.handle}</a> : <span>@{c.handle}</span>}
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${CONF_CLS[c.confidence]}`}>{c.confidence}</span>
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${CLASS_CLS[c.account_class] ?? CLASS_CLS.unknown}`}>{c.account_class}</span>
                            <span className="text-[10px] text-charcoal/40">{L('نقاط', 'score')} {num(c.score)}</span>
                            {c.status === 'confirmed' && c.verification_method && <span className="text-[10px] text-green-700/70">· {c.verification_method}</span>}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {(c.reasons ?? []).map((r, i) => (
                              <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${r.delta >= 0 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`} title={isAr ? r.label_ar : r.label_en}>
                                {isAr ? r.label_ar : r.label_en} {r.delta >= 0 ? '+' : ''}{r.delta}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
