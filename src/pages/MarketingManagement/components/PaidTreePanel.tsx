/**
 * The paid hierarchy under one campaign:
 *
 *   Paid campaign → Platform campaign → Ad group → Ad → creative
 *
 * Platform-specific settings live in a jsonb blob behind a schema version, NOT
 * in one universal form merging every Meta/TikTok/Snapchat/Google option. The
 * exact field vocabularies have NOT been verified against current official
 * documentation, so this screen offers the normalized fields it can stand
 * behind and a free-form JSON box for the rest — and says so, rather than
 * implying platform parity it does not have.
 *
 * An ad's creative is a CONTENT ITEM, never a second copy of the file, and the
 * database refuses to let an ad go active on unapproved content.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, ChevronDown, Coins, Layers, Megaphone } from 'lucide-react';
import Button from '@/components/ui/Button';
import { EmptyHint, CaveatStrip, Spinner } from '@/pages/MarketingIntelligence/components/shared';
import { lbl, PLATFORM_LABEL } from '@/lib/marketingMgmt/labels';
import { fetchPaidTree, savePlatformCampaign, saveAdGroup, saveAd } from '@/lib/marketingMgmt/v2';
import { fetchContentList, type ContentItem } from '@/lib/marketingMgmt/client';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Platforms the schema accepts for a platform campaign. */
const AD_PLATFORMS = ['meta', 'instagram', 'facebook', 'tiktok', 'snapchat', 'google', 'youtube', 'x', 'linkedin'];

type PC = Record<string, unknown> & {
  id: string; platform: string; name: string; status: string;
  budget: number | null; budget_kind: string | null; objective: string | null;
  mkt_ad_groups?: AG[];
};
type AG = Record<string, unknown> & {
  id: string; name: string; budget: number | null; status: string;
  mkt_ads?: Ad[];
};
type Ad = Record<string, unknown> & {
  id: string; name: string; status: string; content_item_id: string | null;
  headline: string | null; cta_label: string | null;
};

export function PaidTreePanel({ campaignId, isAr, onError, onToast }: {
  campaignId: string; isAr: boolean; onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const [tree, setTree] = useState<PC[]>([]);
  const [approved, setApproved] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openPc, setOpenPc] = useState<string | null>(null);
  const [addingPc, setAddingPc] = useState(false);
  const [pf, setPf] = useState<Record<string, string>>({ platform: 'meta' });

  /** Spinner on the FIRST load only. Flipping `loading` on every refresh returns
   *  a spinner instead of the tree, which unmounts it — so adding an ad
   *  collapsed the ad group you were working in. Refreshes now swap the data
   *  underneath and leave what is open, open. */
  const load = useCallback((spinner = false) => {
    if (spinner) setLoading(true);
    fetchPaidTree(campaignId)
      .then((r) => setTree(r.platform_campaigns as PC[]))
      .catch((e) => onError(err(e)))
      .finally(() => { if (spinner) setLoading(false); });
  }, [campaignId, onError]);
  useEffect(() => { load(true); }, [load]);

  useEffect(() => {
    // Only approved-or-later content may be an ad creative; the DB enforces it,
    // so offering anything else here would just produce a rejection.
    fetchContentList({ limit: 200 })
      .then((r) => setApproved(r.content.filter((c) =>
        ['approved', 'ready_to_publish', 'scheduled', 'published'].includes(c.status))))
      .catch(() => {});
  }, []);

  const addPlatform = async () => {
    if (!pf.name?.trim()) return;
    setBusy(true);
    try {
      let config: Record<string, unknown> = {};
      if (pf.config?.trim()) {
        try { config = JSON.parse(pf.config); }
        catch { onError(isAr ? 'إعدادات المنصة ليست JSON صالحاً' : 'Platform settings are not valid JSON'); setBusy(false); return; }
      }
      await savePlatformCampaign({
        campaign_id: campaignId, platform: pf.platform, name: pf.name.trim(),
        objective: pf.objective || null,
        budget: pf.budget ? Number(pf.budget) : null,
        budget_kind: pf.budget_kind || null,
        destination_url: pf.destination || null,
        conversion_event: pf.conversion || null,
        platform_config: config,
      });
      setAddingPc(false); setPf({ platform: 'meta' });
      onToast(isAr ? 'أُضيفت حملة المنصة' : 'Platform campaign added'); load();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  if (loading) return <div className="py-2"><Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /></div>;

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-sand/50 bg-cream-light/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-charcoal/70">
          <Coins className="h-3.5 w-3.5" />{isAr ? 'بنية الإعلانات' : 'Ad structure'}
        </span>
        <button type="button" onClick={() => setAddingPc((v) => !v)}
          className="text-[11.5px] font-medium text-copper hover:underline">
          {isAr ? '+ حملة منصة' : '+ platform campaign'}
        </button>
      </div>

      <CaveatStrip>
        {isAr ? 'الحقول الموحّدة فقط مؤكدة. خيارات كل منصة لم تُراجَع مقابل توثيقها الرسمي، لذا تُحفظ كإعدادات حرة بنسخة مخطط — ولا يوجد أي ربط تلقائي بحسابات الإعلانات.'
              : 'Only the normalized fields are dependable. Per-platform options have NOT been checked against official documentation, so they are stored as free-form settings with a schema version — and nothing here connects to an ad account.'}
      </CaveatStrip>

      {addingPc && (
        <div className="grid gap-2 rounded-lg border border-copper/30 bg-white p-2.5 sm:grid-cols-3">
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'المنصة' : 'Platform'}</span>
            <select value={pf.platform} onChange={(e) => setPf({ ...pf, platform: e.target.value })} className={FIELD}>
              {AD_PLATFORMS.map((p) => <option key={p} value={p}>{lbl(PLATFORM_LABEL, p, isAr)}</option>)}
            </select></label>
          <label className="block sm:col-span-2"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'الاسم' : 'Name'}</span>
            <input value={pf.name ?? ''} onChange={(e) => setPf({ ...pf, name: e.target.value })} className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'الهدف' : 'Objective'}</span>
            <input value={pf.objective ?? ''} onChange={(e) => setPf({ ...pf, objective: e.target.value })} className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'الميزانية' : 'Budget'}</span>
            <input type="number" value={pf.budget ?? ''} onChange={(e) => setPf({ ...pf, budget: e.target.value })} className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'نوع الميزانية' : 'Budget kind'}</span>
            <select value={pf.budget_kind ?? ''} onChange={(e) => setPf({ ...pf, budget_kind: e.target.value })} className={FIELD}>
              <option value="">{isAr ? '— غير محدد —' : '— not set —'}</option>
              <option value="daily">{isAr ? 'يومية' : 'daily'}</option>
              <option value="lifetime">{isAr ? 'إجمالية' : 'lifetime'}</option>
            </select></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'وجهة الإعلان' : 'Destination'}</span>
            <input value={pf.destination ?? ''} onChange={(e) => setPf({ ...pf, destination: e.target.value })} className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'حدث التحويل' : 'Conversion event'}</span>
            <input value={pf.conversion ?? ''} onChange={(e) => setPf({ ...pf, conversion: e.target.value })} className={FIELD} /></label>
          <label className="block sm:col-span-3">
            <span className="mb-1 block text-[11px] text-charcoal/55">
              {isAr ? 'إعدادات المنصة (JSON، غير مُتحقَّق منها)' : 'Platform settings (JSON, unverified)'}
            </span>
            <textarea rows={2} value={pf.config ?? ''} onChange={(e) => setPf({ ...pf, config: e.target.value })}
              className={FIELD} placeholder='{"placements":["feed","reels"]}' /></label>
          <div className="sm:col-span-3">
            <Button onClick={addPlatform} disabled={busy || !pf.name?.trim()}>{isAr ? 'إضافة' : 'Add'}</Button>
          </div>
        </div>
      )}

      {tree.length === 0 ? (
        <EmptyHint>{isAr ? 'لا حملات منصات بعد' : 'No platform campaigns yet'}</EmptyHint>
      ) : (
        <ul className="space-y-2">
          {tree.map((pc) => (
            <li key={pc.id} className="rounded-lg border border-sand/50 bg-white">
              <button type="button" onClick={() => setOpenPc(openPc === pc.id ? null : pc.id)}
                className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-start">
                <span className="text-[12.5px] text-charcoal">
                  {lbl(PLATFORM_LABEL, pc.platform, isAr)} · {pc.name}
                </span>
                <span className="flex items-center gap-2 text-[11px] text-charcoal/50">
                  {pc.budget != null && <span className="tabular-nums">{pc.budget.toLocaleString()}</span>}
                  <span>{(pc.mkt_ad_groups ?? []).length} {isAr ? 'مجموعة' : 'ad groups'}</span>
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${openPc === pc.id ? 'rotate-180' : ''}`} />
                </span>
              </button>
              {openPc === pc.id && (
                <AdGroups pc={pc} isAr={isAr} approved={approved}
                  onError={onError} onToast={onToast} onChanged={load} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AdGroups({ pc, isAr, approved, onError, onToast, onChanged }: {
  pc: PC; isAr: boolean; approved: ContentItem[];
  onError: (m: string) => void; onToast: (m: string) => void; onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [openAg, setOpenAg] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await saveAdGroup({ platform_campaign_id: pc.id, name: name.trim(),
        budget: budget ? Number(budget) : null });
      setName(''); setBudget(''); onToast(isAr ? 'أُضيفت المجموعة' : 'Ad group added'); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2 border-t border-sand/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${FIELD} max-w-[200px]`}
          placeholder={isAr ? 'اسم المجموعة الإعلانية' : 'Ad group name'} />
        <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)}
          className={`${FIELD} max-w-[110px]`} placeholder={isAr ? 'ميزانية' : 'Budget'} />
        <Button variant="secondary" onClick={add} disabled={busy || !name.trim()}>
          <Plus className="h-4 w-4" />{isAr ? 'مجموعة' : 'Group'}
        </Button>
      </div>

      {(pc.mkt_ad_groups ?? []).length === 0 ? (
        <EmptyHint>{isAr ? 'لا مجموعات إعلانية' : 'No ad groups'}</EmptyHint>
      ) : (
        <ul className="space-y-1.5">
          {(pc.mkt_ad_groups ?? []).map((ag) => (
            <li key={ag.id} className="rounded border border-sand/40 bg-cream-light/50">
              <button type="button" onClick={() => setOpenAg(openAg === ag.id ? null : ag.id)}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-start">
                <span className="flex items-center gap-1.5 text-[12px] text-charcoal">
                  <Layers className="h-3 w-3 text-charcoal/35" />{ag.name}
                </span>
                <span className="text-[10.5px] text-charcoal/45">
                  {(ag.mkt_ads ?? []).length} {isAr ? 'إعلان' : 'ads'}
                </span>
              </button>
              {openAg === ag.id && (
                <Ads ag={ag} isAr={isAr} approved={approved}
                  onError={onError} onToast={onToast} onChanged={onChanged} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Ads({ ag, isAr, approved, onError, onToast, onChanged }: {
  ag: AG; isAr: boolean; approved: ContentItem[];
  onError: (m: string) => void; onToast: (m: string) => void; onChanged: () => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!f.name?.trim()) return;
    setBusy(true);
    try {
      await saveAd({
        ad_group_id: ag.id, name: f.name.trim(),
        content_item_id: f.creative || null,
        headline: f.headline || null, primary_text: f.body || null,
        cta_label: f.cta || null, destination_url: f.dest || null,
        status: 'draft',
      });
      setF({}); onToast(isAr ? 'أُضيف الإعلان' : 'Ad added'); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2 border-t border-sand/30 p-2.5">
      {(ag.mkt_ads ?? []).length > 0 && (
        <ul className="divide-y divide-sand/30">
          {(ag.mkt_ads ?? []).map((ad) => (
            <li key={ad.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[11.5px]">
              <span className="flex items-center gap-1.5 text-charcoal">
                <Megaphone className="h-3 w-3 text-charcoal/30" />{ad.name}
                {ad.headline && <span className="text-charcoal/45">— {ad.headline}</span>}
              </span>
              <span className="text-[10.5px] text-charcoal/45">
                {ad.content_item_id
                  ? (approved.find((c) => c.id === ad.content_item_id)?.content_number
                     ?? (isAr ? 'مادة مرتبطة' : 'linked creative'))
                  : <span className="text-amber-700">{isAr ? 'بلا مادة' : 'no creative'}</span>}
                {' · '}{ad.status}
              </span>
            </li>))}
        </ul>
      )}

      <div className="grid gap-1.5 sm:grid-cols-4">
        <input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })}
          className={FIELD} placeholder={isAr ? 'اسم الإعلان' : 'Ad name'} />
        <select value={f.creative ?? ''} onChange={(e) => setF({ ...f, creative: e.target.value })}
          className={`${FIELD} sm:col-span-2`}>
          <option value="">{isAr ? '— المادة (معتمدة فقط) —' : '— creative (approved only) —'}</option>
          {approved.map((c) => <option key={c.id} value={c.id}>{c.content_number} · {c.title}</option>)}
        </select>
        <input value={f.cta ?? ''} onChange={(e) => setF({ ...f, cta: e.target.value })}
          className={FIELD} placeholder={isAr ? 'زر الإجراء' : 'CTA label'} />
        <input value={f.headline ?? ''} onChange={(e) => setF({ ...f, headline: e.target.value })}
          className={`${FIELD} sm:col-span-2`} placeholder={isAr ? 'العنوان' : 'Headline'} />
        <input value={f.dest ?? ''} onChange={(e) => setF({ ...f, dest: e.target.value })}
          className={`${FIELD} sm:col-span-2`} placeholder={isAr ? 'الرابط' : 'Destination URL'} />
        <div className="sm:col-span-4">
          <Button variant="secondary" onClick={add} disabled={busy || !f.name?.trim()}>
            <Plus className="h-4 w-4" />{isAr ? 'إعلان' : 'Ad'}
          </Button>
          {approved.length === 0 && (
            <span className="ms-2 text-[10.5px] text-charcoal/45">
              {isAr ? 'لا مواد معتمدة بعد — الإعلان يُنشأ كمسودة'
                    : 'No approved content yet — the ad is created as a draft'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
