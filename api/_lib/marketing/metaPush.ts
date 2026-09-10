// ============================================================================
// Meta "push" payload builders — turn a PLANNED Wassell execution (campaign +
// ad sets + ads) into Graph-API create payloads for Campaign, Ad Set, Ad
// Creative and Ad.
// ----------------------------------------------------------------------------
// History: until 2026-09-10 only Campaign + Ad Sets were pushed, because the
// Meta *App* was in Development mode and Meta refused app-made ad CREATIVES
// ("app in development mode", subcode 1885183). The app is now Live and the
// business is verified — inline creatives (link, Instagram identity,
// Click-to-WhatsApp CTA, image_hash, video) were all verified against the real
// account on 2026-09-10 — so the push now builds the whole tree.
//
// Everything is created PAUSED — nothing spends until a human activates it in
// Meta. These are pure functions (no I/O); the marketing-os action calls the
// Graph client, uploads the media, and does the DB write-back of the returned
// platform ids.
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
  // Meta requires acknowledging Advantage+ audience whenever detailed targeting
  // is set (age/gender/interests): advantage_audience 0 = respect the audience as
  // a hard constraint, 1 = let Meta expand it. Default 0.
  const targeting: Json = { geo_locations: { countries }, targeting_automation: { advantage_audience: 0 } };
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
  /** Option B: targeting spec from the campaign's linked Meta Saved Audience.
   *  When present it is sent verbatim as the ad set targeting; else we fall back
   *  to the execution's own targeting / KSA default. */
  audienceTargeting: Json | null = null,
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
    // A linked Meta Saved Audience's spec wins; ensure the Advantage+ flag is set
    // (the saved audience may already carry its own — spreading it lets it win).
    targeting: audienceTargeting
      ? { targeting_automation: { advantage_audience: 0 }, ...audienceTargeting }
      : buildTargeting(execution),
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

// ============================================================================
// Ad-level: creative + ad (added 2026-09-10, once the Meta App went Live).
// ============================================================================

/** A planned Wassell ad (`mos_execution_ads` row without a platform_ad_id). */
export interface PushAd {
  id: string;
  label: string | null;
  /** `mos_execution_ads.creative` — the five standardized copy keys
   *  (`primary_text`/`message`, `headline`, `description`, `cta`,
   *  `destination_url`) plus the `meta_*` ids the push writes back for resume. */
  creative: Json | null;
  /** Title of the content record the ad uses (fallback ad name). */
  content_title: string | null;
}

/** Uploaded media the creative references. Video needs a thumbnail image URL
 *  (Meta's own generated `thumbnails` edge — no upload of ours required). */
export type PushMedia =
  | { kind: 'image'; image_hash: string }
  | { kind: 'video'; video_id: string; thumbnail_url: string };

/** Meta CTA enums a Wassel buyer can pick for a LINK destination. Anything
 *  else typed into `creative.cta` falls back to LEARN_MORE rather than a Graph
 *  rejection. WhatsApp ad sets always use WHATSAPP_MESSAGE regardless. */
const LINK_CTAS = new Set([
  'LEARN_MORE', 'SIGN_UP', 'CONTACT_US', 'GET_QUOTE', 'BOOK_NOW', 'CALL_NOW',
  'APPLY_NOW', 'DOWNLOAD', 'SEE_MORE', 'GET_OFFER', 'SUBSCRIBE', 'SHOP_NOW',
  'ORDER_NOW', 'REQUEST_TIME', 'WATCH_MORE', 'NO_BUTTON',
]);

/** Fallback landing page when a link ad names none. */
const DEFAULT_LANDING_URL = 'https://wassel.re';
/** The link Meta wants on Click-to-WhatsApp creatives (verified live). */
const WHATSAPP_LINK = 'https://api.whatsapp.com/send';

/** Where the ad set sends people — decides the creative's CTA + link shape. */
export function resolveAdDestination(campaign: PushCampaign, execution: PushExecution): 'WHATSAPP' | 'MESSENGER' | 'LINK' {
  const ps = execution.platform_settings ?? null;
  const objective = resolveObjective(campaign, ps);
  const defaults = ADSET_DEFAULTS[objective] ?? LEADS_ADSET_DEFAULT;
  const destination = str(ps?.destination_type) ?? defaults.destination_type ?? null;
  if (destination === 'WHATSAPP') return 'WHATSAPP';
  if (destination === 'MESSENGER') return 'MESSENGER';
  return 'LINK';
}

/** The ad's display name in Meta — `<campaign ref · execution> · <ad label>`. */
export function adName(campaign: PushCampaign, execution: PushExecution, ad: PushAd): string {
  const label = ad.label ?? ad.content_title ?? 'Ad';
  return `${refPrefix(campaign, execution)} · ${label}`.slice(0, 400);
}

function ctaFor(destination: 'WHATSAPP' | 'MESSENGER' | 'LINK', creative: Json | null, link: string): Json {
  if (destination === 'WHATSAPP') {
    return { type: 'WHATSAPP_MESSAGE', value: { link: WHATSAPP_LINK, app_destination: 'WHATSAPP' } };
  }
  if (destination === 'MESSENGER') {
    return { type: 'MESSAGE_PAGE', value: { link, app_destination: 'MESSENGER' } };
  }
  const raw = (str(creative?.cta) ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  return { type: LINK_CTAS.has(raw) ? raw : 'LEARN_MORE', value: { link } };
}

/**
 * Build the Ad Creative create payload (`object_story_spec` — an unpublished
 * page post carrying the copy + media). `pageId` is required: every creative
 * runs from a page. `instagramId`, when set, lets the same creative deliver
 * under the Instagram identity too.
 */
export function buildCreativePayload(
  campaign: PushCampaign,
  execution: PushExecution,
  ad: PushAd,
  media: PushMedia,
  pageId: string,
  instagramId: string | null,
): Json {
  const c = ad.creative ?? null;
  const destination = resolveAdDestination(campaign, execution);
  const link = destination === 'WHATSAPP'
    ? WHATSAPP_LINK
    : (str(c?.destination_url) ?? DEFAULT_LANDING_URL);
  const message = str(c?.message) ?? str(c?.primary_text) ?? '';
  const headline = str(c?.headline);
  const description = str(c?.description);
  const cta = ctaFor(destination, c, link);

  const spec: Json = { page_id: pageId };
  if (instagramId) spec.instagram_user_id = instagramId;

  if (media.kind === 'image') {
    const linkData: Json = { message, link, image_hash: media.image_hash, call_to_action: cta };
    if (headline) linkData.name = headline;
    if (description) linkData.description = description;
    spec.link_data = linkData;
  } else {
    const videoData: Json = {
      video_id: media.video_id,
      message,
      image_url: media.thumbnail_url,
      call_to_action: cta,
    };
    if (headline) videoData.title = headline;
    if (description) videoData.link_description = description;
    spec.video_data = videoData;
  }

  return { name: adName(campaign, execution, ad), object_story_spec: spec };
}

/** Build the Ad create payload (PAUSED) binding a creative to a Meta ad set. */
export function buildAdPayload(
  campaign: PushCampaign,
  execution: PushExecution,
  ad: PushAd,
  metaAdSetId: string,
  creativeId: string,
): Json {
  return {
    name: adName(campaign, execution, ad),
    adset_id: metaAdSetId,
    creative: { creative_id: creativeId },
    status: 'PAUSED',
  };
}

/** A content's linked asset as read from `mos_asset_links` ⨝ `mos_assets`. */
export interface CreativeAssetCandidate {
  asset_id: string;
  role: string | null;
  kind: string | null;
  mime_type: string | null;
  file_id: string | null;
  url: string | null;
}

/**
 * Pick the ONE asset a content record's ad should run: the final cut wins over
 * source/reference; an image (by mime, so a `document`-kind design export
 * still counts) or an mp4 with our own bytes (`file_id`) or a public url.
 * YouTube/Drive links are not uploadable media and are skipped.
 */
export function pickCreativeAsset(
  candidates: CreativeAssetCandidate[],
): { asset: CreativeAssetCandidate; kind: 'image' | 'video' } | null {
  const ROLE_RANK: Record<string, number> = { final: 0, source: 1, reference: 2 };
  const typed = candidates
    .map((a) => {
      const mime = (a.mime_type ?? '').toLowerCase();
      const kind: 'image' | 'video' | null = mime.startsWith('image/') && mime !== 'image/heic'
        ? 'image'
        : mime.startsWith('video/') || (a.kind === 'video' && !mime) ? 'video' : null;
      return { a, kind };
    })
    .filter((x): x is { a: CreativeAssetCandidate; kind: 'image' | 'video' } => x.kind !== null)
    .filter((x) => Boolean(x.a.file_id) || /^https?:\/\/[^ ]+\.(jpe?g|png|webp|mp4|mov)(\?|$)/i.test(x.a.url ?? ''))
    .sort((x, y) => (ROLE_RANK[x.a.role ?? ''] ?? 9) - (ROLE_RANK[y.a.role ?? ''] ?? 9));
  const best = typed[0];
  return best ? { asset: best.a, kind: best.kind } : null;
}
