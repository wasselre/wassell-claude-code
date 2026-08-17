// ============================================================================
// Meta → MOS sync orchestration (shared by the UI action + the cron endpoint).
// ----------------------------------------------------------------------------
// Fetches the ad account's Campaign → Ad Set → Ad tree + lifetime insights from
// the Marketing API, normalizes them into the three arrays mos_meta_sync_apply
// expects, and calls that RPC (which upserts by external id, prunes vanished
// children within the holder, and self-heals lead attribution).
//
// Runtime-agnostic (Edge/Node): the Graph client uses Web Crypto + fetch; the
// Supabase client is passed in (a service-role client, since mos_meta_sync_apply
// is granted to service_role only).
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadMetaConfig, MetaMarketingClient, leadsFromActions,
  type MetaInsightRow,
} from './metaMarketingApi.js';

export interface MetaSyncResult {
  ok: boolean;
  skipped?: 'not_configured' | 'disabled';
  account?: { id: string; name: string; currency: string };
  applied?: Record<string, unknown>;
  error?: string;
}

/** Index insights rows by the id at the requested level. */
function indexInsights(rows: MetaInsightRow[], key: 'campaign_id' | 'adset_id' | 'ad_id') {
  const m = new Map<string, MetaInsightRow>();
  for (const r of rows) { const id = r[key]; if (id) m.set(id, r); }
  return m;
}

/**
 * Run one full sync. Returns a structured result; NEVER throws for expected
 * states (unconfigured / kill-switched) — callers surface those as info, not
 * errors. Graph/DB failures return { ok:false, error } and are logged upstream.
 */
export async function runMetaSync(sb: SupabaseClient): Promise<MetaSyncResult> {
  const cfg = loadMetaConfig();
  if (!cfg) return { ok: false, skipped: 'not_configured' };

  // kill switch (mos_meta_sync_state.is_enabled); absent row → enabled default
  const state = await sb.from('mos_meta_sync_state')
    .select('is_enabled').eq('ad_account_id', cfg.adAccountId).maybeSingle();
  if (state.data && state.data.is_enabled === false) return { ok: false, skipped: 'disabled' };

  const client = new MetaMarketingClient(cfg);

  try {
    const [account, campaigns, adSets, ads, campInsights, adInsights] = await Promise.all([
      client.getAdAccount(),
      client.listCampaigns(),
      client.listAdSets(),
      client.listAds(),
      client.getInsights('campaign'),
      client.getInsights('ad'),
    ]);

    const ci = indexInsights(campInsights, 'campaign_id');
    const ai = indexInsights(adInsights, 'ad_id');

    const p_campaigns = campaigns.map((c) => {
      const i = ci.get(c.id);
      return {
        id: c.id, name: c.name, objective: c.objective,
        status: c.effective_status || c.status,
        daily_budget: c.daily_budget ?? null, lifetime_budget: c.lifetime_budget ?? null,
        spend: i?.spend ?? null, impressions: i?.impressions ?? null,
        clicks: i?.clicks ?? null, leads: leadsFromActions(i?.actions),
      };
    });

    const p_ad_sets = adSets.map((s) => ({
      id: s.id, campaign_id: s.campaign_id, name: s.name,
      status: s.effective_status || s.status,
    }));

    const p_ads = ads.map((a) => {
      const i = ai.get(a.id);
      return {
        id: a.id, campaign_id: a.campaign_id, adset_id: a.adset_id, name: a.name,
        status: a.effective_status || a.status,
        spend: i?.spend ?? null, impressions: i?.impressions ?? null,
        clicks: i?.clicks ?? null, leads: leadsFromActions(i?.actions),
      };
    });

    const applied = await sb.rpc('mos_meta_sync_apply', {
      p_account_id: cfg.adAccountId,
      p_holder_name: 'Meta — synced',
      p_currency: account.currency,
      p_campaigns, p_ad_sets, p_ads,
    });
    if (applied.error) {
      await sb.from('mos_meta_sync_state').update({ last_error: applied.error.message })
        .eq('ad_account_id', cfg.adAccountId);
      return { ok: false, error: `mos_meta_sync_apply: ${applied.error.message}` };
    }

    return {
      ok: true,
      account: { id: account.id, name: account.name, currency: account.currency },
      applied: applied.data as Record<string, unknown>,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('mos_meta_sync_state').update({ last_error: msg })
      .eq('ad_account_id', cfg.adAccountId).then(() => {}, () => {});
    return { ok: false, error: msg };
  }
}
