/**
 * The Meta SKELETON of one execution: the campaign + the feed/story ad-set pair.
 *
 * Extracted 2026-09-17 from the `meta_push_structure` action so there is ONE
 * implementation for both callers:
 *   · «إنشاء في ميتا» (a person, on an execution);
 *   · the month model (build item E6) — every paid campaign of a confirmed
 *     month gets its campaign + ad-set pair built from the month template, so
 *     a creative's final approval has an ad set to create its ad in.
 *
 * House rules carried unchanged (see metaPush.ts): the Saved Audience is
 * REQUIRED (campaign audience → settings default → the account's only one);
 * a Wassel ad set is a PAIR of Meta ad sets (feed + story, Instagram only),
 * budget halved; everything is created PAUSED; all-or-nothing — a rejected ad
 * set deletes the campaign this call created and links nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadMetaConfig, MetaApiError, MetaMarketingClient } from './metaMarketingApi.js';
import {
  buildAdSetPayload, buildCampaignPayload,
  type PushCampaign, type PushExecution,
} from './metaPush.js';

export interface LinkedAdSet { id: string | null; name: string | null; platform_adset_id: string | null }

export interface SkeletonOk {
  ok: true;
  campaign: { platform_campaign_id: string | null; name: string | null; created: boolean };
  ad_sets: Array<{ wassell_ad_set_id: string | null; platform_adset_id: string; name: string; variant: 'feed' | 'story'; pair_id: string; sort_order: number }>;
  audience: { id: string | null; name: string | null; source: string };
  /** The FEED halves as the ads phase sees them (existing links + this call's). */
  linked_sets: LinkedAdSet[];
  campaign_row: PushCampaign & { id: string };
}
export interface SkeletonFail { ok: false; status: number; error: string; error_ar: string }

/** Human-readable one-liner from a Meta Graph error (or any thrown value). */
export function metaErr(e: unknown): string {
  if (e instanceof MetaApiError) {
    const raw = (e.raw as { error?: { error_user_msg?: unknown; error_user_title?: unknown } } | null)?.error;
    const user = typeof raw?.error_user_msg === 'string' ? raw.error_user_msg
      : typeof raw?.error_user_title === 'string' ? raw.error_user_title : null;
    return `${user ?? e.message}${e.code != null ? ` (code ${e.code}${e.subcode != null ? `/${e.subcode}` : ''})` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const fail = (status: number, error: string, error_ar?: string): SkeletonFail =>
  ({ ok: false, status, error, error_ar: error_ar ?? error });

export async function ensureMetaSkeleton(
  sb: SupabaseClient,
  executionId: string,
  opts: { validateOnly?: boolean; campaignNameOverride?: { ref: string | null; name: string | null } } = {},
): Promise<SkeletonOk | SkeletonFail> {
  const validateOnly = opts.validateOnly === true;
  const cfg = loadMetaConfig();
  if (!cfg) return fail(400, 'Meta not configured', 'ميتا غير مُعدّة على الخادم.');

  const execRes = await sb.from('mos_campaign_executions')
    .select('id, campaign_id, platform, label, budget, starts_on, ends_on, targeting, platform_settings, platform_campaign_id')
    .eq('id', executionId).maybeSingle();
  if (execRes.error) return fail(500, `execution read failed: ${execRes.error.message}`);
  const execRow = execRes.data as (PushExecution & { campaign_id: string; platform_campaign_id: string | null }) | null;
  if (!execRow) return fail(404, 'execution not found');
  if (execRow.platform !== 'meta' && execRow.platform !== 'instagram') {
    return fail(400, 'Only Meta/Instagram executions can be pushed to Meta.');
  }

  const campRes = await sb.from('mos_campaigns')
    .select('id, ref, name, objective, audience_id').eq('id', execRow.campaign_id).maybeSingle();
  if (campRes.error) return fail(500, `campaign read failed: ${campRes.error.message}`);
  const campaignRow = campRes.data as (PushCampaign & { audience_id: string | null }) | null;
  if (!campaignRow) return fail(404, 'campaign not found');
  // What Meta shows: a month campaign's ref is a machine key («2026-09:paid:<uuid>»).
  const campaign: PushCampaign = opts.campaignNameOverride
    ? { ...campaignRow, ref: opts.campaignNameOverride.ref, name: opts.campaignNameOverride.name ?? campaignRow.name }
    : campaignRow;

  const client = new MetaMarketingClient(cfg);

  // ---- Saved audience (REQUIRED) ---------------------------------------------
  let wantedAudienceId: string | null = null;
  let audienceSource = '';
  if (campaignRow.audience_id) {
    const audRes = await sb.from('mos_audiences')
      .select('name, meta_saved_audience_id').eq('id', campaignRow.audience_id).maybeSingle();
    if (audRes.error) return fail(500, `audience read failed: ${audRes.error.message}`);
    const a = audRes.data as { name?: string; meta_saved_audience_id?: string | null } | null;
    if (a?.meta_saved_audience_id) { wantedAudienceId = a.meta_saved_audience_id; audienceSource = `campaign audience «${a.name ?? ''}»`; }
  }
  if (!wantedAudienceId) {
    const st = await sb.from('mos_settings').select('value').eq('key', 'meta_push').maybeSingle();
    if (st.error) return fail(500, `settings read failed: ${st.error.message}`);
    const v = (st.data as { value?: { saved_audience_id?: unknown } } | null)?.value;
    if (typeof v?.saved_audience_id === 'string' && v.saved_audience_id) { wantedAudienceId = v.saved_audience_id; audienceSource = 'settings default'; }
  }
  let savedAudienceTargeting: Record<string, unknown> | null = null;
  let savedAudienceName: string | null = null;
  try {
    const audiences = await client.listSavedAudiences();
    const pick = wantedAudienceId
      ? audiences.find((a) => a.id === wantedAudienceId) ?? null
      : audiences.length === 1 ? audiences[0] ?? null : null;
    if (!pick) {
      const names = audiences.map((a) => `«${a.name}»`).join('، ');
      const why = wantedAudienceId
        ? `saved audience ${wantedAudienceId} (${audienceSource}) no longer exists in the ad account`
        : audiences.length === 0
          ? 'the ad account has no saved audience — create one in Ads Manager first'
          : `the ad account has ${audiences.length} saved audiences (${names}) — pick the default in Settings → Platforms → Meta, or link one to the campaign audience`;
      return fail(422,
        `Refusing to create an ad set without a saved audience: ${why}.`,
        `لن تُنشأ مجموعة إعلانية بدون جمهور محفوظ: ${why}.`);
    }
    if (!pick.targeting || typeof pick.targeting !== 'object') {
      return fail(422, `saved audience «${pick.name}» carries no targeting spec`);
    }
    savedAudienceTargeting = pick.targeting as Record<string, unknown>;
    savedAudienceName = pick.name;
    if (!audienceSource) audienceSource = 'the account’s only saved audience';
  } catch (e) {
    return fail(502, `Meta saved audiences failed: ${metaErr(e)}`);
  }

  const setsRes = await sb.from('mos_ad_sets')
    .select('id, name, platform_adset_id, sort_order, placement_variant, pair_id').eq('execution_id', executionId)
    .is('archived_at', null).order('sort_order', { ascending: true });
  if (setsRes.error) return fail(500, `ad sets read failed: ${setsRes.error.message}`);
  type PlannedSet = { id: string; name: string | null; platform_adset_id: string | null; sort_order: number | null; placement_variant: string | null; pair_id: string | null };
  // Story rows are the push's own shadows — never a plan of their own.
  const adSets = ((setsRes.data ?? []) as PlannedSet[]).filter((x) => x.placement_variant !== 'story');

  let metaCampaignId: string | null = execRow.platform_campaign_id;
  const campaignCreated = !metaCampaignId;
  let campaignName: string | null = null;
  const createdSets: SkeletonOk['ad_sets'] = [];
  const errors: Array<{ ad_set: string; error: string }> = [];
  const linkedSets: LinkedAdSet[] = adSets.map((s) => ({ id: s.id, name: s.name, platform_adset_id: s.platform_adset_id }));
  try {
    if (!metaCampaignId) {
      /*
       * ADOPT BEFORE CREATING.
       *
       * `platform_campaign_id` is written only once the WHOLE skeleton
       * succeeds — deliberately, so a half-built skeleton is never mistaken
       * for a finished one. But that leaves a window: the campaign exists in
       * Meta the instant `createCampaign` returns, and if this process dies
       * before the id reaches the database, the account holds a campaign
       * nothing points at. The next run then builds a SECOND one.
       *
       * That is not hypothetical. On 2026-09-20 the month confirm was killed
       * by Vercel's 25-second function limit at 13:54:25, four seconds after
       * creating «WSL · 2026-09 — مدفوع — يمام 17». The planning sweep built
       * it again at 13:55:14, and the operator opened Ads Manager to four
       * campaigns for a three-project month.
       *
       * The name is deterministic — prefix, month and project — so a retry can
       * recognise its own orphan and take it over. Deleted and archived ones
       * are ignored: those are decisions someone made, not leftovers.
       */
      const campaignPayload = buildCampaignPayload(campaign, execRow);
      const wantedName = String(campaignPayload.name);
      let adopted: string | null = null;
      if (!validateOnly) {
        try {
          const existing = await client.listCampaigns();
          const match = existing.find((c) => c.name === wantedName
            && c.status !== 'DELETED' && c.status !== 'ARCHIVED'
            && c.effective_status !== 'DELETED' && c.effective_status !== 'ARCHIVED');
          if (match?.id) adopted = match.id;
        } catch (e) {
          // A lookup that fails must not block the build — creating is still
          // the right move, and a duplicate is recoverable where a refusal
          // leaves the month with no campaign at all.
          console.error('[meta-skeleton] campaign lookup failed, creating instead', metaErr(e));
        }
      }
      if (adopted) {
        metaCampaignId = adopted;
        campaignName = wantedName;
        console.warn('[meta-skeleton] adopted an existing Meta campaign', adopted, wantedName);
      } else {
        const campaignResult = await client.createCampaign(campaignPayload, validateOnly);
        metaCampaignId = campaignResult.id ?? null;
        campaignName = wantedName;
      }
    }

    type PlanRow = { id: string | null; name: string | null; platform_adset_id: string | null; sort_order: number | null; pair_id: string | null };
    const plan: PlanRow[] = adSets.length
      ? adSets.map((x) => ({ id: x.id, name: x.name, platform_adset_id: x.platform_adset_id, sort_order: x.sort_order, pair_id: x.pair_id }))
      : [{ id: null, name: execRow.label ?? 'Ad set', platform_adset_id: null, sort_order: 0, pair_id: null }];
    /*
     * The same orphan problem one level down. Adopting a campaign without
     * adopting its ad sets would rebuild the feed/story pair inside it, so the
     * duplication would simply move from the campaign to the ad sets.
     */
    let existingSets: Array<{ id: string; name: string; campaign_id?: string; status?: string; effective_status?: string }> = [];
    if (!validateOnly && metaCampaignId) {
      try {
        existingSets = (await client.listAdSets()).filter((a) => a.campaign_id === metaCampaignId
          && a.status !== 'DELETED' && a.status !== 'ARCHIVED'
          && a.effective_status !== 'DELETED' && a.effective_status !== 'ARCHIVED');
      } catch (e) {
        console.error('[meta-skeleton] ad set lookup failed, creating instead', metaErr(e));
      }
    }

    for (const s of plan) {
      if (s.platform_adset_id) continue; // already linked — don't duplicate
      const pairId = s.pair_id ?? crypto.randomUUID();
      for (const variant of ['feed', 'story'] as const) {
        try {
          const p = buildAdSetPayload(campaign, execRow, { id: s.id, name: s.name }, metaCampaignId ?? '', cfg.pageId, savedAudienceTargeting, variant);
          const already = existingSets.find((x) => x.name === String(p.name));
          if (already) {
            createdSets.push({
              wassell_ad_set_id: s.id, platform_adset_id: already.id, name: String(p.name),
              variant, pair_id: pairId, sort_order: s.sort_order ?? 0,
            });
            console.warn('[meta-skeleton] adopted an existing Meta ad set', already.id, String(p.name));
            continue;
          }
          const asResult = await client.createAdSet(p, validateOnly);
          createdSets.push({ wassell_ad_set_id: s.id, platform_adset_id: asResult.id ?? '(validated)', name: String(p.name), variant, pair_id: pairId, sort_order: s.sort_order ?? 0 });
        } catch (e) {
          errors.push({ ad_set: `${s.name ?? '(unnamed)'} (${variant})`, error: metaErr(e) });
        }
      }
    }

    if (errors.length > 0) {
      if (campaignCreated && !validateOnly && metaCampaignId) {
        try { await client.deleteNode(metaCampaignId); }
        catch (delErr) { console.error('[meta-skeleton] rollback delete failed:', metaErr(delErr)); }
      }
      const first = errors[0];
      return fail(422,
        `Meta rejected the ad set "${first?.ad_set}": ${first?.error}. Nothing was created — fix the plan and try again.`,
        `رفضت ميتا المجموعة الإعلانية «${first?.ad_set}»: ${first?.error}. لم يُنشأ شيء — صحّح الخطة وأعد المحاولة.`);
    }

    if (!validateOnly && metaCampaignId) {
      if (campaignCreated) {
        const up = await sb.from('mos_campaign_executions')
          .update({ platform_campaign_id: metaCampaignId, updated_at: new Date().toISOString() })
          .eq('id', executionId);
        if (up.error) return fail(500, `execution link write failed: ${up.error.message}`);
      }
      for (const c of createdSets) {
        if (c.platform_adset_id === '(validated)') continue;
        if (c.wassell_ad_set_id && c.variant === 'feed') {
          const su = await sb.from('mos_ad_sets')
            .update({ platform_adset_id: c.platform_adset_id, placement_variant: 'feed', pair_id: c.pair_id, updated_at: new Date().toISOString() })
            .eq('id', c.wassell_ad_set_id);
          if (su.error) console.error('[meta-skeleton] ad set link write failed:', su.error.message);
          const ls = linkedSets.find((s) => s.id === c.wassell_ad_set_id);
          if (ls) ls.platform_adset_id = c.platform_adset_id;
        } else {
          const ins = await sb.from('mos_ad_sets')
            .insert({ execution_id: executionId, name: c.name, platform_adset_id: c.platform_adset_id, status: 'paused',
              sort_order: c.sort_order, placement_variant: c.variant, pair_id: c.pair_id })
            .select('id').maybeSingle();
          if (ins.error) console.error('[meta-skeleton] ad set row insert failed:', ins.error.message);
          if (c.variant === 'feed') linkedSets.push({ id: (ins.data as { id?: string } | null)?.id ?? null, name: c.name, platform_adset_id: c.platform_adset_id });
        }
      }
    }
  } catch (e) {
    return fail(502, `Meta push failed at campaign: ${metaErr(e)}`, `تعذّر إنشاء الحملة في ميتا: ${metaErr(e)}`);
  }

  return {
    ok: true,
    campaign: { platform_campaign_id: metaCampaignId, name: campaignName, created: campaignCreated },
    ad_sets: createdSets,
    audience: { id: wantedAudienceId, name: savedAudienceName, source: audienceSource },
    linked_sets: linkedSets,
    campaign_row: campaignRow,
  };
}
