// ============================================================================
// Meta "push structure" payload builders — turn a PLANNED Wassell execution
// (campaign + ad sets) into Graph-API create payloads for Campaign + Ad Sets.
// ----------------------------------------------------------------------------
// Why only Campaign + Ad Sets: while the Meta *App* is in Development mode,
// Meta refuses to create an ad CREATIVE from a new inline post ("app in
// development mode", subcode 1885183). Campaign and Ad Set creation are NOT
// gated by app mode. So the automation builds the skeleton (paused), the media
// buyer adds the creatives/ads in Meta, and the hourly sync matches them back.
//
// Everything is created PAUSED — nothing spends until a human activates it in
// Meta. These are pure functions (no I/O); the marketing-os action calls the
// Graph client and does the DB write-back of the returned platform ids.
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

/** Build targeting from platform_settings / execution.targeting, defaulting to KSA. */
function buildTargeting(execution: PushExecution): Json {
  const ps = execution.platform_settings ?? null;
  const t = execution.targeting ?? null;
  const countries = (Array.isArray(ps?.countries) && ps?.countries.length ? ps?.countries
    : Array.isArray(t?.countries) && (t?.countries as unknown[]).length ? t?.countries
    : ['SA']) as unknown[];
  const targeting: Json = { geo_locations: { countries } };
  const ageMin = numOr(ps?.age_min, 0);
  const ageMax = numOr(ps?.age_max, 0);
  if (ageMin) targeting.age_min = Math.round(ageMin);
  if (ageMax) targeting.age_max = Math.round(ageMax);
  const genders = str(ps?.genders);
  if (genders === '1' || genders === '2') targeting.genders = [Number(genders)];
  return targeting;
}

/**
 * Build an Ad Set create payload (PAUSED). `metaCampaignId` is the id Meta
 * returned for the campaign. `pageId` backs WhatsApp/Messenger promoted_object.
 */
export function buildAdSetPayload(
  campaign: PushCampaign,
  execution: PushExecution,
  adSet: PushAdSet,
  metaCampaignId: string,
  pageId: string | null,
): Json {
  const ps = execution.platform_settings ?? null;
  const objective = resolveObjective(campaign, ps);
  const defaults = ADSET_DEFAULTS[objective] ?? LEADS_ADSET_DEFAULT;
  const cbo = ps?.advantage_campaign_budget === true;

  const name = `${refPrefix(campaign, execution)} · ${adSet.name ?? 'Ad set'}`.slice(0, 400);
  const destination = str(ps?.destination_type) ?? defaults.destination_type;

  const payload: Json = {
    name,
    campaign_id: metaCampaignId,
    status: 'PAUSED',
    billing_event: str(ps?.billing_event) ?? defaults.billing_event,
    optimization_goal: str(ps?.optimization_goal) ?? defaults.optimization_goal,
    targeting: buildTargeting(execution),
    bid_strategy: str(ps?.bid_strategy) ?? 'LOWEST_COST_WITHOUT_CAP',
  };

  if (destination) payload.destination_type = destination;
  // WhatsApp / Messenger / page destinations promote a page.
  if ((destination === 'WHATSAPP' || destination === 'MESSENGER' || destination === 'FACEBOOK_PAGE') && pageId) {
    payload.promoted_object = { page_id: pageId };
  }

  if (!cbo) {
    // Non-CBO: budget must sit on the ad set.
    const lifetime = str(ps?.budget_mode) === 'LIFETIME';
    const sar = numOr(ps?.[lifetime ? 'lifetime_budget' : 'daily_budget'] ?? execution.budget, DEFAULT_DAILY_BUDGET_SAR);
    payload[lifetime ? 'lifetime_budget' : 'daily_budget'] = toMinor(sar);
    if (lifetime && execution.ends_on) payload.end_time = new Date(execution.ends_on).toISOString();
  }
  if (execution.starts_on) payload.start_time = new Date(execution.starts_on).toISOString();

  return payload;
}
