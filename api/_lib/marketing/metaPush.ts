// ============================================================================
// Meta "push" payload builders — turn a PLANNED Wassell execution (campaign +
// ad sets) into Graph-API create payloads for Campaign and Ad Set.
// ----------------------------------------------------------------------------
// History: until 2026-09-10 only Campaign + Ad Sets were pushed (Meta App in
// Development mode). 2026-09-10 added creatives + ads built inline in the Edge
// function. 2026-09-13 the ads moved OUT of here again — every ad (manual push
// or approval automation) is now created by ONE place, the Fly worker's
// meta-ad lane (worker/src/runMetaAdJob.ts), after the manager approves the
// AI-written caption. This module only builds the skeleton.
//
// Everything is created PAUSED — nothing spends until a human activates it in
// Meta. These are pure functions (no I/O); the marketing-os action calls the
// Graph client and does the DB write-back of the returned platform ids.
//
// HOUSE RULES the ad set builder enforces (operator decision 2026-09-13 —
// every rule below was violated by the first C-042 push and is now hard-coded):
//   1. TARGETING = the account's Meta Saved Audience («عام - ألرياض - 18+»),
//      never a broad KSA fallback. The caller MUST pass the saved audience's
//      spec; there is no default. (Resolution order lives in marketing-os:
//      the campaign's linked audience → mos_settings.meta_push → the account's
//      only saved audience → refuse.)
//   2. PLACEMENTS = Instagram (feed, stories, reels, profile feed) + WhatsApp
//      status ONLY. Never Facebook, Messenger, Audience Network or Threads.
//      Mobile only. Unknown-age WhatsApp users excluded.
// ============================================================================

/** Wassell campaign objective (lowercase enum) → Meta ODAX objective. */
const OBJECTIVE_MAP: Record<string, string> = {
  awareness: 'OUTCOME_AWARENESS',
  traffic: 'OUTCOME_TRAFFIC',
  engagement: 'OUTCOME_ENGAGEMENT',
  leads: 'OUTCOME_LEADS',
  sales: 'OUTCOME_SALES',
  app: 'OUTCOME_APP_PROMOTION',
  app_promotion: 'OUTCOME_APP_PROMOTION',
};

interface AdSetDefault { optimization_goal: string; billing_event: string; destination_type?: string }

// Leads at Wassell = Click-to-WhatsApp; that's the whole live use case, and the
// fallback for any objective not in the map (kept as a concrete const so the
// `?? ` fallback below is always defined under noUncheckedIndexedAccess).
const LEADS_ADSET_DEFAULT: AdSetDefault = { optimization_goal: 'CONVERSATIONS', billing_event: 'IMPRESSIONS', destination_type: 'WHATSAPP' };

/** Sensible ad-set defaults per objective (overridable by platform_settings). */
const ADSET_DEFAULTS: Record<string, AdSetDefault> = {
  OUTCOME_AWARENESS: { optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' },
  OUTCOME_TRAFFIC: { optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS' },
  OUTCOME_ENGAGEMENT: { optimization_goal: 'POST_ENGAGEMENT', billing_event: 'IMPRESSIONS' },
  OUTCOME_LEADS: LEADS_ADSET_DEFAULT,
  OUTCOME_SALES: { optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS' },
  OUTCOME_APP_PROMOTION: { optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS' },
};

/** Default daily budget (SAR) when neither the ad set nor execution names one. */
const DEFAULT_DAILY_BUDGET_SAR = 50;
/** Meta refuses a tiny daily budget on a CONVERSATIONS ad set (10 SAR was
 *  rejected «Invalid parameter» on 2026-09-13; 20 SAR passed) — each half of
 *  the pair gets at least this. */
const MIN_HALF_BUDGET_SAR = 20;
/** Meta's ad set name limit is 255 chars; keep a margin. */
const MAX_ADSET_NAME = 200;

type Json = Record<string, unknown>;

export interface PushCampaign {
  id: string;
  ref: string | null;
  name: string | null;
  objective: string | null;
}
export interface PushExecution {
  id: string;
  label: string | null;
  platform: string;
  budget: number | null;
  starts_on: string | null;
  ends_on: string | null;
  targeting: Json | null;
  platform_settings: Json | null;
}
export interface PushAdSet {
  id: string | null;
  name: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function numOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** SAR (major) → halalas (minor units) Meta expects, integer. */
function toMinor(sar: number): number {
  return Math.round(sar * 100);
}

/** Resolve the Meta objective — platform_settings wins, else map the campaign. */
export function resolveObjective(campaign: PushCampaign, ps: Json | null): string {
  const fromSettings = str(ps?.objective);
  if (fromSettings && fromSettings.startsWith('OUTCOME_')) return fromSettings;
  const key = (campaign.objective ?? '').toLowerCase();
  return OBJECTIVE_MAP[key] ?? 'OUTCOME_LEADS';
}

/** A short, human-readable reference prefix so Meta names trace back to Wassell. */
function refPrefix(campaign: PushCampaign, execution: PushExecution): string {
  return [campaign.ref, execution.label].filter(Boolean).join(' · ') || 'WSL';
}

/** Build the Campaign create payload (always PAUSED). */
export function buildCampaignPayload(campaign: PushCampaign, execution: PushExecution): Json {
  const ps = execution.platform_settings ?? null;
  const objective = resolveObjective(campaign, ps);
  const cbo = ps?.advantage_campaign_budget === true;
  const specialCats = Array.isArray(ps?.special_ad_categories) ? ps?.special_ad_categories : [];

  const payload: Json = {
    name: `${refPrefix(campaign, execution)} · ${campaign.name ?? 'Campaign'}`.slice(0, 400),
    objective,
    status: 'PAUSED',
    special_ad_categories: specialCats,
    buying_type: str(ps?.buying_type) ?? 'AUCTION',
  };

  if (cbo) {
    // Campaign-budget optimization: budget lives on the campaign; sharing is on.
    payload.is_adset_budget_sharing_enabled = true;
    const lifetime = str(ps?.budget_mode) === 'LIFETIME';
    const sar = numOr(ps?.[lifetime ? 'lifetime_budget' : 'daily_budget'] ?? execution.budget, DEFAULT_DAILY_BUDGET_SAR);
    payload[lifetime ? 'lifetime_budget' : 'daily_budget'] = toMinor(sar);
    if (str(ps?.bid_strategy)) payload.bid_strategy = str(ps?.bid_strategy);
  } else {
    // Ad-set-level budgets (the live Wassell case): required flag in v21+.
    payload.is_adset_budget_sharing_enabled = false;
  }
  return payload;
}

/**
 * A Wassel ad set is a PAIR of Meta ad sets (2026-09-13): Meta will not let
 * one Click-to-WhatsApp ad switch designs by placement, so the square design
 * runs in a FEED set and the vertical one in a STORY set — Instagram only,
 * mobile only (operator rule; WhatsApp status was dropped 2026-09-13).
 */
export type PlacementVariant = 'feed' | 'story';
export const PLACEMENTS_BY_VARIANT: Readonly<Record<PlacementVariant, Readonly<{
  publisher_platforms: string[];
  instagram_positions: string[];
  device_platforms: string[];
}>>> = Object.freeze({
  feed: Object.freeze({ publisher_platforms: ['instagram'], instagram_positions: ['stream', 'profile_feed'], device_platforms: ['mobile'] }),
  story: Object.freeze({ publisher_platforms: ['instagram'], instagram_positions: ['story', 'reels'], device_platforms: ['mobile'] }),
});
export const VARIANT_SUFFIX: Readonly<Record<PlacementVariant, string>> = Object.freeze({ feed: ' — فيد', story: ' — ستوري' });

/** Keys Meta returns on a saved audience but that only describe placements —
 *  stripped so the house placements above are the single source of truth. */
const PLACEMENT_KEYS = new Set([
  'publisher_platforms', 'facebook_positions', 'instagram_positions', 'messenger_positions',
  'whatsapp_positions', 'audience_network_positions', 'threads_positions', 'device_platforms',
]);

/**
 * Ad-set targeting = the Saved Audience's spec (verbatim: geo, age, gender,
 * Advantage+ audience flags) + the house placements + «unknown age on WhatsApp
 * excluded». Pure; throws when the spec is empty so a caller can never sneak a
 * broad audience through.
 */
export function buildAdSetTargeting(savedAudienceTargeting: Json, variant: PlacementVariant): Json {
  if (!savedAudienceTargeting || typeof savedAudienceTargeting !== 'object' || Object.keys(savedAudienceTargeting).length === 0) {
    throw new Error('saved audience targeting is empty — an ad set is never created with a broad audience');
  }
  const base: Json = {};
  for (const [k, v] of Object.entries(savedAudienceTargeting)) {
    if (PLACEMENT_KEYS.has(k)) continue;
    base[k] = v;
  }
  const pl = PLACEMENTS_BY_VARIANT[variant];
  return {
    ...base,
    publisher_platforms: [...pl.publisher_platforms],
    instagram_positions: [...pl.instagram_positions],
    device_platforms: [...pl.device_platforms],
    user_age_unknown: false,
  };
}

/**
 * Build an Ad Set create payload (PAUSED) for ONE variant of the pair.
 * `metaCampaignId` is the id Meta returned for the campaign. `pageId` backs
 * WhatsApp/Messenger promoted_object. `savedAudienceTargeting` is REQUIRED —
 * the resolved Meta Saved Audience spec. The planned budget is split evenly
 * between the two variants (each Meta ad set gets half).
 */
export function buildAdSetPayload(
  campaign: PushCampaign,
  execution: PushExecution,
  adSet: PushAdSet,
  metaCampaignId: string,
  pageId: string | null,
  savedAudienceTargeting: Json,
  variant: PlacementVariant,
): Json {
  const ps = execution.platform_settings ?? null;
  const objective = resolveObjective(campaign, ps);
  const defaults = ADSET_DEFAULTS[objective] ?? LEADS_ADSET_DEFAULT;
  const cbo = ps?.advantage_campaign_budget === true;

  // Meta caps ad set names (1487046 «The name is too long» at ~255 chars —
  // hit live 2026-09-13 once the variant suffix was appended). Trim the base
  // so the suffix always survives.
  const suffix = VARIANT_SUFFIX[variant];
  const base = `${refPrefix(campaign, execution)} · ${adSet.name ?? 'Ad set'}`;
  const name = `${base.slice(0, MAX_ADSET_NAME - suffix.length)}${suffix}`;
  const destination = str(ps?.destination_type) ?? defaults.destination_type;

  const payload: Json = {
    name,
    campaign_id: metaCampaignId,
    status: 'PAUSED',
    billing_event: str(ps?.billing_event) ?? defaults.billing_event,
    optimization_goal: str(ps?.optimization_goal) ?? defaults.optimization_goal,
    targeting: buildAdSetTargeting(savedAudienceTargeting, variant),
    bid_strategy: str(ps?.bid_strategy) ?? 'LOWEST_COST_WITHOUT_CAP',
  };

  if (destination) payload.destination_type = destination;
  // WhatsApp / Messenger / page destinations promote a page.
  if ((destination === 'WHATSAPP' || destination === 'MESSENGER' || destination === 'FACEBOOK_PAGE') && pageId) {
    payload.promoted_object = { page_id: pageId };
  }

  if (!cbo) {
    // Non-CBO: budget must sit on the ad set — half per variant of the pair.
    const lifetime = str(ps?.budget_mode) === 'LIFETIME';
    const sar = numOr(ps?.[lifetime ? 'lifetime_budget' : 'daily_budget'] ?? execution.budget, DEFAULT_DAILY_BUDGET_SAR);
    payload[lifetime ? 'lifetime_budget' : 'daily_budget'] = toMinor(Math.max(sar / 2, MIN_HALF_BUDGET_SAR));
    if (lifetime && execution.ends_on) payload.end_time = new Date(execution.ends_on).toISOString();
  }
  if (execution.starts_on) payload.start_time = new Date(execution.starts_on).toISOString();

  return payload;
}
