// Marketing Intelligence — Paid Advertiser discovery & confirmation (admin).
// Shows each monitored organization's advertiser identity state: a CONFIRMED
// Meta page (with evidence + audit), or SCORED candidates awaiting a human
// decision. Makes the unsafe states obvious: no advertiser, ambiguous
// candidates, marketplace/third-party advertisers, blocked paid collection,
// and Page-ID changes. Deterministic scoring happens in the worker; this page
// renders the stored scores/evidence and drives confirm/reject/discover/collect.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Search, CheckCircle2, XCircle, AlertTriangle, ShieldAlert, PlayCircle, ExternalLink, History } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import BackToSettings from './components/BackToSettings';
import {
  fetchAdvertisers, runAdvertiserDiscovery, confirmAdvertiser, rejectCandidate, runAdsPage,
  type AdvertiserOrg, type AdvertiserCandidate,
} from '@/lib/marketing/client';

const CONF_CLS: Record<string, string> = {
  high: 'bg-green-100 text-green-800', medium: 'bg-amber-100 text-amber-800', low: 'bg-red-100 text-red-800', manual: 'bg-blue-100 text-blue-800',
};

function ReasonChips({ reasons, isAr }: { reasons: AdvertiserCandidate['reasons']; isAr: boolean }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {reasons.map((r, i) => (
        <span key={i} className={`text-[11px] px-1.5 py-0.5 rounded-full ${r.delta >= 0 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {isAr ? r.label_ar : r.label_en} {r.delta >= 0 ? '+' : ''}{r.delta}
        </span>
      ))}
    </div>
  );
}

export default function MarketingAdvertisersPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [orgs, setOrgs] = useState<AdvertiserOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOrgs((await fetchAdvertisers()).organizations); }
    catch (e) { addToast(e instanceof Error ? e.message : L('فشل التحميل', 'Load failed'), 'error'); }
    finally { setLoading(false); }
  }, [addToast, isAr]);
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const act = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    try { await fn(); addToast(okMsg, 'success'); await load(); }
    catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); }
    finally { setBusy(null); }
  };

  const confirmedCount = useMemo(() => orgs.filter((o) => o.meta_confirmed).length, [orgs]);

  if (loading && orgs.length === 0) {
    return <div className="max-w-5xl"><BackToSettings /><div className="text-charcoal/50 text-sm">{L('جارٍ التحميل…', 'Loading…')}</div></div>;
  }

  return (
    <div className="max-w-5xl pb-16">
      <BackToSettings />
      <div className="flex items-center gap-3 mb-4">
        <div className="w-11 h-11 rounded-2xl bg-chocolate/10 flex items-center justify-center"><Megaphone size={22} className="text-chocolate" /></div>
        <div>
          <h1 className="text-xl font-bold text-charcoal">{L('المعلنون المدفوعون (Meta)', 'Paid Advertisers (Meta)')}</h1>
          <div className="text-xs text-charcoal/40">{L(`${confirmedCount} مؤسسة بمُعلن مؤكَّد`, `${confirmedCount} organization(s) with a confirmed advertiser`)}</div>
        </div>
      </div>

      {confirmedCount === 0 && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm flex items-start gap-2">
          <ShieldAlert size={18} className="shrink-0 mt-0.5" />
          <div>{L('لا يوجد أي مُعلن مؤكَّد بعد. جمع الإعلانات المدفوعة متوقف لكل المؤسسات حتى تأكيد صفحة Meta الصحيحة.', 'No advertiser is confirmed yet. Paid-ad collection is blocked for all organizations until a correct Meta page is confirmed.')}</div>
        </div>
      )}

      <div className="space-y-4">
        {orgs.map((o) => {
          const name = isAr ? (o.name_ar ?? o.name_en) : (o.name_en ?? o.name_ar);
          const cands = o.meta_candidates ?? [];
          const nonMkt = cands.filter((c) => !c.isMarketplace);
          const ambiguous = !o.meta_confirmed && nonMkt.length >= 2 && Math.abs((nonMkt[0]?.score ?? 0) - (nonMkt[1]?.score ?? 0)) < 25;
          const allThirdParty = !o.meta_confirmed && cands.length > 0 && nonMkt.every((c) => c.confidence === 'low');
          const pageChanges = o.audit.filter((a) => a.event === 'page_id_changed');
          return (
            <section key={o.id} className="card p-4">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-charcoal">{name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-sand/40 text-charcoal/60">{o.org_type === 'developer' ? L('مطوّر', 'developer') : L('مسوّق', 'marketer')}</span>
                  {o.website && <a href={o.website} target="_blank" rel="noreferrer" className="text-xs text-copper hover:underline flex items-center gap-0.5">{o.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}<ExternalLink size={11} /></a>}
                </div>
                <button type="button" disabled={busy === `disc-${o.id}`} onClick={() => act(`disc-${o.id}`, () => runAdvertiserDiscovery(o.id, (o.name_ar ?? o.name_en ?? '').trim()), L('بدأ البحث — حدّث بعد قليل', 'Discovery queued — refresh shortly'))}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-copper/10 text-copper hover:bg-copper/20 disabled:opacity-50">
                  <Search size={13} /> {L('بحث عن مُعلن', 'Run discovery')}
                </button>
              </div>

              {o.meta_confirmed ? (
                <div className="rounded-lg border border-green-200 bg-green-50/50 p-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 size={16} className="text-green-600" />
                      <span className="font-medium text-charcoal">{o.meta_display_name ?? L('مُعلن مؤكَّد', 'Confirmed advertiser')}</span>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${CONF_CLS[o.meta_discovery_confidence ?? 'manual'] ?? 'bg-blue-100 text-blue-800'}`}>{o.meta_discovery_confidence ?? 'manual'}</span>
                    </div>
                    <button type="button" disabled={busy === `run-${o.id}`} onClick={() => act(`run-${o.id}`, () => runAdsPage(o.id, 25), L('بدأ الجمع', 'Collection queued'))}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-chocolate text-white hover:bg-chocolate/90 disabled:opacity-50">
                      <PlayCircle size={13} /> {L('اجمع الإعلانات', 'Collect ads')}
                    </button>
                  </div>
                  <div className="text-xs text-charcoal/60 mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                    <span>Page ID: <code className="text-charcoal/80">{o.meta_page_id}</code></span>
                    {o.meta_page_url && <a href={o.meta_page_url} target="_blank" rel="noreferrer" className="text-copper hover:underline flex items-center gap-0.5">{L('صفحة فيسبوك', 'Facebook page')}<ExternalLink size={10} /></a>}
                    <span>{L('إعلانات مُجمَّعة', 'ads collected')}: {o.ad_count}</span>
                    {o.meta_confirmed_at && <span>{L('أُكِّد', 'confirmed')}: {new Date(o.meta_confirmed_at).toLocaleDateString()}</span>}
                  </div>
                  {Array.isArray(o.meta_confirmation_evidence?.evidence) && o.meta_confirmation_evidence!.evidence!.length > 0 && (
                    <ReasonChips reasons={o.meta_confirmation_evidence!.evidence!} isAr={isAr} />
                  )}
                </div>
              ) : (
                <>
                  <div className="mb-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center gap-1.5">
                    <ShieldAlert size={14} /> {L('لا مُعلن مؤكَّد — جمع الإعلانات المدفوعة متوقف لهذه المؤسسة.', 'No confirmed advertiser — paid-ad collection is blocked for this organization.')}
                  </div>
                  {ambiguous && (
                    <div className="mb-2 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-xs flex items-center gap-1.5">
                      <AlertTriangle size={14} /> {L('مرشّحون متقاربون — يلزم قرار بشري.', 'Ambiguous candidates — a human decision is required.')}
                    </div>
                  )}
                  {allThirdParty && (
                    <div className="mb-2 px-3 py-1.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-center gap-1.5">
                      <AlertTriangle size={14} /> {L('كل المرشّحين أطراف ثالثة/أسواق عقارية — لا يوجد مُعلن ذاتي واضح.', 'All candidates are third-party / marketplace advertisers — no clear self-advertiser.')}
                    </div>
                  )}
                  {cands.length === 0 ? (
                    <div className="text-xs text-charcoal/40 py-1">{L('لا مرشّحين بعد. شغّل البحث.', 'No candidates yet. Run discovery.')}</div>
                  ) : (
                    <div className="space-y-2">
                      {cands.map((c) => (
                        <div key={c.pageId} className={`rounded-lg border p-2.5 ${c.isMarketplace ? 'border-red-200 bg-red-50/40' : 'border-sand/60'}`}>
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-sm">
                                <span className="font-medium text-charcoal truncate">{c.pageName ?? c.pageId}</span>
                                <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${CONF_CLS[c.confidence]}`}>{c.confidence} · {c.score}</span>
                                {c.isMarketplace && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-800 flex items-center gap-0.5"><ShieldAlert size={11} />{L('سوق عقاري', 'marketplace')}</span>}
                              </div>
                              <div className="text-[11px] text-charcoal/50 mt-0.5">
                                Page ID: {c.pageId} · {c.adCount ?? 0} {L('إعلان', 'ads')}
                                {c.landingDomains && c.landingDomains.length > 0 && <> · {c.landingDomains.join(', ')}</>}
                              </div>
                              <ReasonChips reasons={c.reasons} isAr={isAr} />
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <button type="button" disabled={busy === `conf-${c.pageId}`} onClick={() => act(`conf-${c.pageId}`, () => confirmAdvertiser(o.id, c.pageId, c.pageName ?? undefined), L('تم التأكيد', 'Confirmed'))}
                                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                                <CheckCircle2 size={12} /> {L('تأكيد', 'Confirm')}
                              </button>
                              <button type="button" disabled={busy === `rej-${c.pageId}`} onClick={() => act(`rej-${c.pageId}`, () => rejectCandidate(o.id, c.pageId), L('رُفض', 'Rejected'))}
                                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-white border border-sand text-charcoal/60 hover:bg-sand/20 disabled:opacity-50">
                                <XCircle size={12} /> {L('رفض', 'Reject')}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {pageChanges.length > 0 && (
                <div className="mt-2 text-[11px] text-charcoal/50 flex items-center gap-1.5">
                  <History size={12} /> {L('تغيّر مُعرّف الصفحة', 'Page ID changed')}: {pageChanges.map((a) => `${a.old_page_id ?? '?'}→${a.new_page_id ?? '?'}`).join(', ')}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
