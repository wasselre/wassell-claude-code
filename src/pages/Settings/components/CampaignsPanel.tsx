// Cross-platform campaign workspace (inside Content Intelligence). Lists unified
// campaigns (organic + paid), and a detail modal with members, timeline,
// evidence, and manual corrections (rename, confirm/reject/move a member).
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Play, Layers, X, CheckCircle2, XCircle, Link2, Film, ImageIcon } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  fetchCampaigns, fetchCampaignDetail, runCampaignGrouping, campaignCorrect,
  type Campaign, type CampaignMember, type CampaignEvent,
} from '@/lib/marketing/client';

export default function CampaignsPanel({ orgId }: { orgId: string }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Campaign | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return; setLoading(true);
    try { setCampaigns((await fetchCampaigns(orgId)).campaigns); }
    catch (e) { addToast(e instanceof Error ? e.message : L('فشل التحميل', 'Load failed'), 'error'); }
    finally { setLoading(false); }
  }, [orgId, addToast, isAr]);
  useEffect(() => { void load(); }, [load]);

  const onGroup = async () => {
    setBusy(true);
    try { await runCampaignGrouping(orgId); addToast(L('بدأ تجميع الحملات — حدّث بعد دقيقة', 'Campaign grouping queued — refresh in ~1 min'), 'success'); }
    catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-charcoal/50">{campaigns.length} {L('حملة', 'campaigns')}</div>
        <div className="flex gap-2">
          <button type="button" onClick={() => load()} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-copper/10 text-copper hover:bg-copper/20"><RefreshCw size={14} /> {L('تحديث', 'Refresh')}</button>
          <button type="button" onClick={onGroup} disabled={busy} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-chocolate text-white hover:bg-chocolate/90 disabled:opacity-50"><Play size={14} /> {L('تجميع الحملات', 'Group campaigns')}</button>
        </div>
      </div>
      {loading ? <div className="text-sm text-charcoal/40">{L('جارٍ التحميل…', 'Loading…')}</div> : campaigns.length === 0 ? (
        <div className="text-sm text-charcoal/40">{L('لا حملات بعد — شغّل التجميع.', 'No campaigns yet — run grouping.')}</div>
      ) : (
        <div className="space-y-2">
          {campaigns.map((c) => (
            <button key={c.id} type="button" onClick={() => setOpen(c)} className="card p-3 w-full text-start hover:ring-2 hover:ring-copper/30 transition">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-charcoal flex items-center gap-2">
                    <Layers size={14} className="text-chocolate shrink-0" />
                    <span className="truncate">{c.manual_label ?? c.label ?? c.signature.slice(0, 8)}</span>
                    {!c.is_active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-charcoal/10 text-charcoal/50">{L('منتهية', 'ended')}</span>}
                  </div>
                  <div className="text-[11px] text-charcoal/50 mt-0.5">{c.key_message?.slice(0, 90)}</div>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-charcoal/60 shrink-0">
                  <span className="flex gap-1">{c.platforms.map((p) => <span key={p} className="px-1.5 py-0.5 rounded bg-sand/30">{p}</span>)}</span>
                  <span>{c.organic_count}🅾 · {c.paid_count}💰</span>
                  {c.reused_creatives > 0 && <span className="text-copper flex items-center gap-0.5"><Link2 size={11} />{c.reused_creatives}</span>}
                  <span className={`px-1.5 py-0.5 rounded-full ${c.confidence >= 0.8 ? 'bg-green-100 text-green-800' : c.confidence >= 0.6 ? 'bg-amber-100 text-amber-800' : 'bg-charcoal/10 text-charcoal/50'}`}>{Math.round(c.confidence * 100)}%</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && <CampaignModal campaign={open} onClose={() => setOpen(null)} onChange={load} L={L} isAr={isAr} addToast={addToast} />}
    </div>
  );
}

function CampaignModal({ campaign, onClose, onChange, L, isAr, addToast }: { campaign: Campaign; onClose: () => void; onChange: () => void; L: (a: string, e: string) => string; isAr: boolean; addToast: (m: string, t: 'success' | 'error') => void }) {
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const load = useCallback(async () => {
    try { const d = await fetchCampaignDetail(campaign.id); setMembers(d.members); setEvents(d.events); } catch { /* ignore */ }
  }, [campaign.id]);
  useEffect(() => { void load(); }, [load]);

  const correct = async (op: 'status' | 'rename', payload: Record<string, unknown>) => {
    try { await campaignCorrect(op, payload); await load(); onChange(); addToast(L('تم التحديث', 'Updated'), 'success'); }
    catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-cream rounded-2xl max-w-3xl w-full max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-cream border-b border-sand/50 px-4 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-charcoal flex items-center gap-2"><Layers size={15} /> {campaign.manual_label ?? campaign.label}</div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { const v = prompt(L('اسم الحملة', 'Campaign name'), campaign.manual_label ?? campaign.label ?? ''); if (v) void correct('rename', { campaign_id: campaign.id, label: v }); }} className="text-xs px-2 py-1 rounded bg-white/60 hover:bg-white">{L('إعادة تسمية', 'Rename')}</button>
            <button type="button" onClick={onClose} className="text-charcoal/50 hover:text-charcoal"><X size={18} /></button>
          </div>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <Info label={L('المنصات', 'Platforms')} value={campaign.platforms.join(', ')} />
            <Info label={L('عضوية', 'Members')} value={`${campaign.organic_count} ${L('عضوي', 'organic')} · ${campaign.paid_count} ${L('مدفوع', 'paid')}`} />
            <Info label={L('ثقة التجميع', 'Confidence')} value={`${Math.round(campaign.confidence * 100)}%`} />
            <Info label={L('إبداعات معادة', 'Reused creatives')} value={String(campaign.reused_creatives)} />
            {campaign.offers.length > 0 && <Info label={L('العروض', 'Offers')} value={campaign.offers.join(' · ')} />}
            {campaign.payment_plans.length > 0 && <Info label={L('خطط السداد', 'Payment plans')} value={campaign.payment_plans.join(' · ')} />}
            {campaign.ctas.length > 0 && <Info label={L('دعوات لاتخاذ إجراء', 'CTAs')} value={campaign.ctas.join(' · ')} />}
          </div>
          <div className="text-[11px] text-charcoal/50">{L('الدليل', 'Evidence')}: {JSON.stringify(campaign.evidence)}</div>

          <div>
            <div className="text-[11px] text-charcoal/40 mb-1">{L('الأعضاء', 'Members')}</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {members.map((m) => {
                const cp = m.mkt_content_posts; const ad = m.mkt_paid_ads;
                const thumb = cp?.thumbnail_ref ?? ad?.creative_stored_url;
                return (
                  <div key={m.id} className={`card p-2 ${m.status === 'rejected' ? 'opacity-40' : ''}`}>
                    <div className="flex items-center gap-1.5 text-[11px] text-charcoal/60 mb-1">
                      {m.member_type === 'ad' ? '💰' : cp?.post_type && ['video', 'reel', 'short'].includes(cp.post_type) ? <Film size={11} /> : <ImageIcon size={11} />}
                      {m.mkt_content_posts?.platform ?? 'meta'} · {m.status}
                    </div>
                    {thumb && <img src={thumb} alt="" className="w-full aspect-video object-cover rounded mb-1" loading="lazy" />}
                    <div className="text-[10px] text-charcoal/60 line-clamp-2">{cp?.caption?.slice(0, 70) ?? ad?.headline?.slice(0, 70)}</div>
                    <div className="flex gap-1 mt-1">
                      <button type="button" title={L('تأكيد', 'confirm')} onClick={() => correct('status', { member_id: m.id, status: 'confirmed' })} className="text-green-600 hover:bg-green-50 rounded p-0.5"><CheckCircle2 size={13} /></button>
                      <button type="button" title={L('رفض', 'reject')} onClick={() => correct('status', { member_id: m.id, status: 'rejected' })} className="text-red-500 hover:bg-red-50 rounded p-0.5"><XCircle size={13} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {events.length > 0 && (
            <div>
              <div className="text-[11px] text-charcoal/40 mb-1">{L('الخط الزمني', 'Timeline')}</div>
              <div className="space-y-1">
                {events.map((e, i) => (
                  <div key={i} className="text-[11px] text-charcoal/60 flex items-center gap-2"><span className="px-1.5 py-0.5 rounded bg-sand/30">{e.kind}</span> <span className="text-charcoal/40">{new Date(e.at).toLocaleDateString(isAr ? 'ar' : 'en')}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-white p-2"><div className="text-[10px] text-charcoal/40">{label}</div><div className="text-charcoal/80 truncate">{value || '—'}</div></div>;
}
