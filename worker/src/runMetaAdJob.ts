/**
 * Auto Meta ad — the worker half (generation_jobs kind='meta-ad', 2026-09-10;
 * two-phase + house rules 2026-09-13; ONE phase since 2026-09-22 — decision D4).
 *
 * ONE ad-creation path: the manager's FINAL approval of a paid creative (the
 * `auto_meta_ad` step) and the buyer's manual «Create in Meta» push both go
 * through `mos_meta_ad_enqueue`, which admits ONE job per ad row per approved
 * caption and stamps `approval_hash` on the row. There is no AI caption phase
 * and no caption approval any more: the caption the WRITER confirmed on the
 * creative is the caption of the ad, snapshotted into the job at approval
 * time (`params.approved_caption = {text, hash, source, approved_at,
 * approved_by}`). The worker builds EXACTLY that text — it never re-reads a
 * caption that may have changed since, and it never appends hashtags.
 *
 * What a job does: uploads the TWO design slots (square 1:1 → the Instagram
 * feed; vertical 9:16 → stories, reels, WhatsApp status — both required, never
 * one file for every placement), duplicates an existing Click-to-WhatsApp
 * welcome template with the project name swapped, creates ONE creative per
 * placement with every Advantage+ enhancement OFF and multi-advertiser OFF,
 * then the ad in the target ad set; records platform ids + state +
 * `approval_hash` / `built_text_hash` on the row; notifies the approver.
 *
 * Legacy jobs (enqueued before 2026-09-22, no `approved_caption` in params)
 * take the writer-caption path: the creative's confirmed caption, VERIFIED
 * against the hash bound by the final approval (`mos_content_approvals
 * .caption_hash`) — a mismatch fails the job loudly instead of sending Meta a
 * text nobody approved.
 *
 * Ownership: a job writes the ad row ONLY while `creative.auto_ad.job_id` is
 * its own id (or unset). A superseding job (a re-approval with another
 * caption) takes the row over once this one is no longer live; the older
 * job's late writes are refused and logged, never applied on top.
 *
 * Ads are created PAUSED by default (`mos_settings.planning
 * .ads_created_paused`, default true) and activated on schedule by the
 * refresh lane; the linked `mos_creative_slots` row becomes `ready`.
 * `mos_settings.meta_auto_ad.status` stays the explicit override for tests.
 * Transient Graph failures retry instead of paging a human: 5xx, codes 1/2,
 * rate limits (4/17/32/613/80000/80004) and network timeouts are retried 3×
 * (2 s / 8 s / 30 s) after a full undo of anything already built; still
 * failing, the job is requeued ONCE by the lane. Permanent errors (missing
 * design, policy verdict, bad target, an unconfirmed caption) never retry.
 *
 * Failure at any step patches `creative.auto_ad = {state:'failed', error}` on
 * the ad row (while this job owns it) and notifies `ad_failed` — the
 * Placements tab offers a retry.
 *
 * Hard rules: never hold an HTTP request for this (the API only enqueues);
 * the Meta client here is the WORKER COPY (worker/src/marketing/
 * metaMarketingApi.ts); no silent fallbacks (one design everywhere / no
 * template / broad audience / a guessed caption) — every shortcut a buyer
 * would have to undo by hand is a loud failure instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { loadMetaConfig, MetaApiError, MetaMarketingClient, type MetaSiblingAd } from './marketing/metaMarketingApi.js';

export interface MetaAdJob {
  id: string;
  /** generation_jobs.record_id = mos_content.id */
  recordId: string;
  /** generation_jobs.message_id = the mos_execution_ads row id. */
  messageId?: string | null;
  userId: string;
  params: Record<string, unknown>;
  attempts: number;
}

/** Only 'create' exists since 2026-09-22 (D4): the caption is bound at
 *  approval, so there is no caption phase. Kept as a type for the row's
 *  `auto_ad.phase` field, which older rows still carry as 'caption'. */
export type MetaAdPhase = 'caption' | 'create';

/** 'writer' = the caption the writer confirmed and the manager approved at
 *  the final step — the ONLY source since 2026-09-22 (no AI caption). Older
 *  rows may still carry 'deepseek' / 'fallback' from the retired AI phase. */
export type MetaCaptionSource = 'writer';

export interface MetaAdJobResult {
  phase: 'create'; platform_ad_id: string; creative_id: string;
  caption_source: MetaCaptionSource; format: 'image' | 'video';
  ad_status: 'ACTIVE' | 'PAUSED'; slot_id: string | null;
  /** `mos_caption_hash` of the caption bound at approval / built into the ad. */
  approval_hash: string | null; built_text_hash: string | null;
}

interface Deps {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: MetaAdJob;
  log: (msg: string, extra?: unknown) => void;
}

type Slot = 'square' | 'vertical';

interface SlotMedia {
  slot: Slot;
  assetId: string;
  kind: 'image' | 'video';
  mime: string | null;
  /** A URL Meta (or we) can fetch — public legacy url or a 1h signed url. */
  url: string;
  title: string;
}

interface ContentRow {
  id: string; ref: string | null; title: string; project_id: string | null; project_ids: unknown;
  campaign_id: string | null; approval_asset_id: string | null; data: Record<string, unknown> | null;
  angle: string | null; cta: string | null; audience: string | null; goal: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null));

/* ────────────────────────────────────────────────────────────────────────── */
/* Facts                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

interface ProjectFacts {
  name: string | null;
  district: string | null;
  city: string | null;
  unit_types: string[];
  price_min: number | null;
  price_max: number | null;
  area_min: number | null;
  area_max: number | null;
  bedrooms_min: number | null;
  bedrooms_max: number | null;
  available_units: number | null;
  construction_status: string | null;
  off_plan: boolean;
  handover: string | null;
  payment_plan: string | null;
  features: string[];
  landmarks: string[];
  guarantee_max_years: number | null;
}

interface SchemaField { name: string; type?: string; rollup_kind?: string; options?: Array<{ value?: string; id?: string; label_ar?: string; label_en?: string }> }

function fieldsOf(schema: unknown): SchemaField[] {
  const sections = (schema as { sections?: Array<{ fields?: SchemaField[] }> } | null)?.sections ?? [];
  return sections.flatMap((s) => s.fields ?? []);
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function handoverText(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${AR_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function optionLabel(field: SchemaField | undefined, value: unknown): string {
  const v = String(value);
  const opt = field?.options?.find((o) => o.value === v || o.id === v);
  return opt?.label_ar || opt?.label_en || v;
}

/** Years in a guarantee cell like «25 سنة» / «سنتان» / «سنة واحدة» / «10 سنوات». */
function yearsOf(text: string): number | null {
  const t = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = /(\d+)/.exec(t);
  if (m) return Number(m[1]);
  if (/سنتان|سنتين/.test(t)) return 2;
  if (/سنة/.test(t)) return 1;
  return null;
}

async function loadProjectFacts(sb: SupabaseClient, projectId: string | null): Promise<ProjectFacts | null> {
  if (!projectId) return null;
  const model = await sb.from('models').select('id, schema').eq('name', 'all_projects').maybeSingle();
  if (model.error) throw new Error(`all_projects model: ${model.error.message}`);
  const modelId = (model.data as { id?: string } | null)?.id;
  const fields = fieldsOf((model.data as { schema?: unknown } | null)?.schema);
  const rec = await sb.from('unified_records').select('data').eq('id', projectId).maybeSingle();
  if (rec.error) throw new Error(`project read: ${rec.error.message}`);
  const pd = ((rec.data as { data?: Record<string, unknown> } | null)?.data ?? null);
  if (!pd) return null;
  void modelId;

  const byKind = (k: string): string | null => fields.find((f) => f.rollup_kind === k)?.name ?? null;
  const range = (slug: string | null): { min: number | null; max: number | null } => {
    const r = slug ? pd[slug] : null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { min: null, max: null };
    const o = r as { min?: unknown; max?: unknown };
    return { min: num(o.min), max: num(o.max) };
  };
  const price = range(byKind('available_price_range') ?? 'available_price_range');
  const area = range(byKind('available_area_range') ?? 'available_area_range');
  const beds = range(byKind('bedroom_range') ?? 'bedroom_range');

  // Geography — the district / city rows carry authoritative Arabic names.
  const loc = (pd.location && typeof pd.location === 'object' && !Array.isArray(pd.location) ? pd.location : {}) as Record<string, unknown>;
  let district: string | null = null;
  let city: string | null = null;
  const districtId = str(loc.district);
  const cityId = str(loc.city);
  if (districtId) {
    const d = await sb.from('unified_records').select('data').eq('id', districtId).maybeSingle();
    const dd = (d.data as { data?: Record<string, unknown> } | null)?.data ?? {};
    district = str(dd.display_name) ? `حي ${String(dd.display_name)}`.replace(/^حي حي /, 'حي ') : str(dd.name_ar);
    city = str(dd.city_name_ar);
  }
  if (!city && cityId) {
    const c = await sb.from('unified_records').select('data').eq('id', cityId).maybeSingle();
    const cd = (c.data as { data?: Record<string, unknown> } | null)?.data ?? {};
    city = str(cd.name_ar) ?? str(cd.display_name);
  }

  const utField = fields.find((f) => f.name === 'unit_types');
  const utRaw = pd.unit_types;
  const utVals = Array.isArray(utRaw) ? utRaw : utRaw != null && utRaw !== '' ? [utRaw] : [];
  const csField = fields.find((f) => f.name === 'construction_status');
  const csRaw = str(pd.construction_status);
  const constructionStatus = csRaw ? optionLabel(csField, csRaw) : null;
  const offPlan = !!csRaw && !/مكتمل|جاهز|complete|ready|تم التسليم/i.test(`${csRaw} ${constructionStatus ?? ''}`);

  const features = (Array.isArray(pd.features) ? pd.features : [])
    .map((r) => str((r as { feature?: unknown })?.feature)).filter((x): x is string => !!x).slice(0, 8);
  const landmarks = (Array.isArray(pd.nearby_landmarks) ? pd.nearby_landmarks : [])
    .map((r) => {
      const o = r as { landmark?: unknown; duration?: unknown };
      const l = str(o.landmark); const d = str(o.duration);
      return l ? (d ? `${l} ${d}` : l) : null;
    }).filter((x): x is string => !!x).slice(0, 4);
  const guaranteeYears = (Array.isArray(pd.guarantees) ? pd.guarantees : [])
    .map((r) => yearsOf(str((r as { col_3?: unknown })?.col_3) ?? '')).filter((y): y is number => y != null);

  return {
    name: str(pd.project_name),
    district,
    city,
    unit_types: utVals.map((v) => optionLabel(utField, v)),
    price_min: price.min, price_max: price.max,
    area_min: area.min, area_max: area.max,
    bedrooms_min: beds.min, bedrooms_max: beds.max,
    available_units: num(pd.available_units),
    construction_status: constructionStatus,
    off_plan: offPlan,
    handover: handoverText(str(pd.handover_date)),
    payment_plan: str(pd.payment_plan_summary)?.split('\n')[0] ?? null,
    features,
    landmarks,
    guarantee_max_years: guaranteeYears.length ? Math.max(...guaranteeYears) : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Caption — bound at approval, never written here                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** The caption bound at approval time, as the enqueue RPC put it on the job. */
interface ApprovedCaptionPayload {
  /** RAW text — the database hashes `btrim(text)`; the text sent to Meta is this. */
  text: string;
  /** `mos_caption_hash(text)` computed by the database at enqueue. */
  hash: string | null;
  source: string;
  approved_at: string | null;
  approved_by: string | null;
}

/**
 * `params.approved_caption` when the job carries one (every job enqueued since
 * 2026-09-22); null for a legacy job. An EMPTY text is an error, not a legacy
 * signal — the RPC never enqueues one, so it means the params were tampered
 * with or truncated.
 */
function approvedCaptionOf(job: MetaAdJob): ApprovedCaptionPayload | null {
  const raw = job.params.approved_caption;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('approved_caption on the job is not an object');
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text : '';
  if (!text.trim()) throw new Error('approved_caption on the job carries no text');
  return {
    text,
    hash: str(o.hash),
    source: str(o.source) ?? 'writer',
    approved_at: str(o.approved_at),
    approved_by: str(o.approved_by),
  };
}

/** `mos_caption_hash(text)` — THE hash every comparison uses. Database-side
 *  on purpose, so the worker can never disagree with the approval by a trim. */
async function captionHashOf(sb: SupabaseClient, text: string): Promise<string | null> {
  const { data, error } = await sb.rpc('mos_caption_hash', { p_text: text });
  if (error) throw new Error(`mos_caption_hash: ${error.message}`);
  return str(data);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Media                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

async function resolveSlots(sb: SupabaseClient, content: ContentRow): Promise<SlotMedia[]> {
  // `superseded_at IS NULL` = the CURRENT version of each slot. This reader was
  // the only slot reader missing it (`content_ad_readiness` and
  // `mos_content_design_hash` both have it), which was harmless only because
  // every one of the 38 links live is still at version 1. On the first
  // re-upload the old row stays behind with `superseded_at` set, `.find()`
  // would return whichever row Postgres handed back first, and Meta would get
  // the SUPERSEDED design with no error anywhere.
  const links = await sb.from('mos_asset_links').select('asset_id, role')
    .eq('content_id', content.id).is('superseded_at', null);
  if (links.error) throw new Error(`asset links: ${links.error.message}`);
  const rows = (links.data ?? []) as Array<{ asset_id: string; role: string }>;
  const byRole = (r: string): string | null => rows.find((x) => x.role === r)?.asset_id ?? null;
  const square = byRole('final_square');
  const vertical = byRole('final_vertical');
  // BOTH slots are required (operator rule 2026-09-13). The old "one file
  // serves every placement" fallback put a 9:16 design in the Instagram feed
  // and is exactly what the buyer had to undo by hand — so a missing slot is a
  // loud failure, not a guess.
  if (!square || !vertical) {
    const missingAr = [!square ? 'المربّع (١:١ للفيد)' : null, !vertical ? 'الطولي (٩:١٦ للستوري والريلز وحالة واتساب)' : null].filter(Boolean).join(' و');
    const missingEn = [!square ? 'square 1:1 (feed)' : null, !vertical ? 'vertical 9:16 (stories / reels / status)' : null].filter(Boolean).join(' and ');
    throw new Error(`ينقص التصميم ${missingAr} — ارفع التصميمين معًا من تبويب المواد ثم اضغط «إعادة المحاولة». / The ${missingEn} design is missing — upload BOTH design slots on the Materials tab, then retry.`);
  }
  const ids = [...new Set([square, vertical])];

  const assets = await sb.from('mos_assets').select('id, title, kind, mime_type, file_id, url').in('id', ids);
  if (assets.error) throw new Error(`assets: ${assets.error.message}`);
  const byId = new Map((assets.data ?? []).map((a) => [(a as { id: string }).id, a as {
    id: string; title: string; kind: string; mime_type: string | null; file_id: string | null; url: string | null;
  }]));

  const resolveUrl = async (a: { id: string; file_id: string | null; url: string | null }): Promise<string> => {
    if (a.url) return a.url;
    if (!a.file_id) throw new Error(`file bytes missing for design ${a.id}`);
    const fr = await sb.from('files').select('storage_bucket, storage_path').eq('id', a.file_id).maybeSingle();
    if (fr.error) throw new Error(fr.error.message);
    const file = fr.data as { storage_bucket: string; storage_path: string } | null;
    if (!file) throw new Error(`file row missing for design ${a.id}`);
    const signed = await sb.storage.from(file.storage_bucket).createSignedUrl(file.storage_path, 3600);
    if (signed.error || !signed.data?.signedUrl) throw new Error(signed.error?.message ?? 'sign failed');
    return signed.data.signedUrl;
  };

  const out: SlotMedia[] = [];
  for (const [slot, id] of [['square', square], ['vertical', vertical]] as Array<[Slot, string | null]>) {
    if (!id) continue;
    const a = byId.get(id);
    if (!a) throw new Error(`design ${id} not found`);
    const isVideo = a.kind === 'video' || (a.mime_type ?? '').startsWith('video/');
    out.push({ slot, assetId: a.id, kind: isVideo ? 'video' : 'image', mime: a.mime_type, url: await resolveUrl(a), title: a.title });
  }
  return out;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`design download failed (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error('design download was empty');
  if (buf.byteLength > 30 * 1024 * 1024) throw new Error('design image is larger than 30 MB — Meta refuses it');
  return buf;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Creative enhancements — ALL OFF                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Every Advantage+ creative enhancement Meta knows (music, overlays, visual
 * touch-ups, text improvements, animation, …) is switched OFF on every
 * creative we make, and the ad is opted OUT of multi-advertiser units.
 * Operator rule 2026-09-13. The key list is the one Meta itself returned on
 * the buyer's hand-corrected ad 120253385933010020 (83 keys, all OPT_OUT);
 * verified writable + read back with zero OPT_IN keys on 2026-09-13.
 */
const ENHANCEMENT_KEYS = [
  // NOT `standard_enhancements` — Meta rejects the umbrella key on create
  // (100/3858504 "Creative should not include standard enhancements …
  // deprecated, set individual features instead", measured 2026-09-13).
  'adapt_to_placement', 'add_text_overlay', 'ads_with_benefits', 'advantage_plus_creative', 'app_highlights',
  'audio', 'auto_promotion_tag', 'biz_ai', 'carousel_to_video', 'catalog_feed_tag', 'creative_stickers',
  'customize_product_recommendation', 'cv_transformation', 'description_automation', 'dha_optimization',
  'dynamic_cta_text', 'dynamic_partner_content', 'enable_ncs_testimonials', 'enhance_cta', 'fb_feed_tag',
  'fb_reels_tag', 'fb_story_tag', 'feed_caption_optimization', 'generate_cta', 'hide_price',
  'hyperlink_formatting', 'ig_feed_tag', 'ig_glados_feed', 'ig_reels_tag', 'ig_stream_tag',
  'ig_video_native_subtitle', 'image_animation', 'image_auto_crop', 'image_background_gen', 'image_banner',
  'image_brightness_and_contrast', 'image_end_card', 'image_enhancement', 'image_templates',
  'image_text_translation', 'image_touchups', 'image_uncrop', 'inline_comment', 'local_store_extension',
  'media_liquidity_animated_image', 'media_order', 'media_type_automation', 'multi_creative_post_carousel',
  'multi_photo_to_video', 'music_generation', 'pac_genai_recomposition', 'pac_recomposition', 'pac_relaxation',
  'product_browsing', 'product_extensions', 'product_metadata_automation', 'product_tags', 'profile_card',
  'profile_extension', 'replace_media_text', 'reveal_details_over_time', 'show_destination_blurbs',
  'show_summary', 'site_extensions', 'standard_enhancements_catalog', 'text_extraction_for_headline',
  'text_extraction_for_tap_target', 'text_formatting_optimization', 'text_generation', 'text_optimizations',
  'text_overlay_translation', 'text_translation', 'translate_voiceover', 'video_auto_crop', 'video_filtering',
  'video_highlight', 'video_highlights', 'video_to_image', 'video_uncrop', 'video_uncrop_9x16_to_9x18',
  'video_voiceover', 'wa_mm_image_filtering', 'wa_mm_text_truncation_length',
] as const;

export function noEnhancementsSpec(): Record<string, unknown> {
  const features: Record<string, { enroll_status: 'OPT_OUT' }> = {};
  for (const k of ENHANCEMENT_KEYS) features[k] = { enroll_status: 'OPT_OUT' };
  return { creative_features_spec: features };
}
export const NO_MULTI_ADVERTISER = { enroll_status: 'OPT_OUT' } as const;

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp welcome template                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const PROJECT_ICEBREAKER = /مهتم بمشروع\s+(.+?)\s*$/u;

function deepReplace(v: unknown, from: string, to: string): unknown {
  if (typeof v === 'string') return v.includes(from) ? v.split(from).join(to) : v;
  if (Array.isArray(v)) return v.map((x) => deepReplace(x, from, to));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepReplace(x, from, to);
    return out;
  }
  return v;
}

/**
 * Operator rule 2026-09-13: the Click-to-WhatsApp welcome template is always a
 * DUPLICATE of an existing project's template with the project name swapped
 * for this campaign's project. The source project is read off the template's
 * own «مهتم بمشروع <name>» ice-breaker; every occurrence of that name in the
 * template (greeting, ice-breaker titles, canned replies) becomes the target.
 * Returns the template unchanged (and says why) when the swap is impossible.
 */
export function retargetWelcomeTemplate(
  template: string, targetProject: string | null, log: (m: string) => void,
): string {
  if (!targetProject) { log('welcome template used verbatim — this campaign has no project name to swap in'); return template; }
  let parsed: unknown;
  try { parsed = JSON.parse(template); } catch (e) {
    // Meta returns the template as a JSON string; a non-JSON value is unknown
    // territory — keep it verbatim rather than corrupt it.
    console.error('[meta-ad] welcome template is not JSON — used verbatim:', e instanceof Error ? e.message : e);
    return template;
  }
  const titles: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.title === 'string') titles.push(o.title);
      Object.values(o).forEach(walk);
    }
  };
  walk(parsed);
  const source = titles.map((t) => PROJECT_ICEBREAKER.exec(t)?.[1]?.trim() ?? null).find((x): x is string => !!x) ?? null;
  if (!source) { log('welcome template has no «مهتم بمشروع …» line — used verbatim'); return template; }
  if (source === targetProject) { log(`welcome template already names «${targetProject}»`); return template; }
  log(`welcome template duplicated from «${source}» → «${targetProject}»`);
  return JSON.stringify(deepReplace(parsed, source, targetProject));
}

const welcomeOf = (a: MetaSiblingAd): string | null => {
  const c = a.creative;
  return c?.object_story_spec?.link_data?.page_welcome_message
    ?? c?.object_story_spec?.video_data?.page_welcome_message
    ?? c?.asset_feed_spec?.additional_data?.page_welcome_message
    ?? null;
};

/** The template to duplicate: a sibling in the same ad set first, else the
 *  newest Click-to-WhatsApp ad anywhere in the account. Throws when the account
 *  has none — an ad that opens WhatsApp with no template is not what the
 *  buyer wants, and silently shipping one hid exactly that. */
async function findWelcomeTemplate(meta: MetaMarketingClient, platformAdSetId: string, log: (m: string) => void): Promise<string> {
  const siblings = await meta.listAdSetAds(platformAdSetId, 10);
  const fromSibling = siblings.map(welcomeOf).find((w): w is string => typeof w === 'string' && w.length > 0);
  if (fromSibling) { log('welcome template source: a sibling ad in the same ad set'); return fromSibling; }
  const recent = await meta.listAccountAds(60);
  const fromAccount = recent.map(welcomeOf).find((w): w is string => typeof w === 'string' && w.length > 0);
  if (fromAccount) { log('welcome template source: the newest Click-to-WhatsApp ad in the account'); return fromAccount; }
  throw new Error('no WhatsApp welcome template found on any ad in the account — create one ad by hand in Ads Manager first, the automation duplicates it');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Job                                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────── */
/* Transient vs permanent Graph failures                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A Meta failure that is worth trying again: the request never expressed an
 * opinion about our ad, it just did not land. Everything else — a refused
 * creative, a policy verdict, a missing design, a target that does not exist —
 * is PERMANENT and goes straight to the human, because retrying it only burns
 * time and produces the same refusal.
 *
 * | Signal                                            | Class      |
 * |---------------------------------------------------|------------|
 * | HTTP 5xx from Graph                                | transient  |
 * | code 1 (API_UNKNOWN) / 2 (API_SERVICE)             | transient  |
 * | code 4 / 17 / 32 / 613 (rate + throttling limits)  | transient  |
 * | code 80000 / 80004 (ads-API rate limits)           | transient  |
 * | HTTP 429                                           | transient  |
 * | fetch/network/DNS/socket/abort/timeout             | transient  |
 * | anything else (100, 190, 200, 368, 2635 …)         | permanent  |
 * | a non-Meta Error we threw ourselves                | permanent  |
 */
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 613, 80000, 80004]);
const NETWORK_HINTS = [
  'fetch failed', 'network', 'socket hang up', 'econnreset', 'econnrefused', 'etimedout',
  'enotfound', 'eai_again', 'epipe', 'timeout', 'aborted', 'terminated',
];

export function classifyMetaError(err: unknown): 'transient' | 'permanent' {
  if (err instanceof TransientMetaAdError) return 'transient';
  if (err instanceof MetaApiError) {
    if (err.httpStatus >= 500 || err.httpStatus === 429) return 'transient';
    return TRANSIENT_META_CODES.has(err.code ?? -1) ? 'transient' : 'permanent';
  }
  const name = err instanceof Error ? err.name.toLowerCase() : '';
  if (name === 'aborterror' || name === 'timeouterror') return 'transient';
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && NETWORK_HINTS.some((h) => code.toLowerCase() === h)) return 'transient';
  return NETWORK_HINTS.some((h) => msg.includes(h)) ? 'transient' : 'permanent';
}

/** Thrown when the retries are exhausted and the failure is still transient —
 *  the lane requeues the job ONCE instead of failing it in the manager's face. */
export class TransientMetaAdError extends Error {
  /** The last underlying failure (named `lastError`, not `cause`: `cause` is a
   *  member of Error itself and overriding it needs an `override` modifier). */
  readonly lastError: unknown;
  constructor(message: string, lastError?: unknown) {
    super(message);
    this.name = 'TransientMetaAdError';
    this.lastError = lastError;
  }
}

/** 3 retries after the first attempt. */
export const META_RETRY_BACKOFF_MS = [2_000, 8_000, 30_000] as const;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying only transient failures. `fn` MUST leave nothing
 * half-built behind when it throws (the ad build undoes itself), so every
 * attempt starts from a clean state.
 */
export async function withTransientRetry<T>(
  label: string, fn: (attempt: number) => Promise<T>, log: Deps['log'],
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (classifyMetaError(e) === 'permanent') {
        console.error(`[meta-ad] ${label} failed permanently (no retry): ${msg}`);
        throw e;
      }
      if (attempt >= META_RETRY_BACKOFF_MS.length) {
        console.error(`[meta-ad] ${label} still failing after ${attempt + 1} attempts: ${msg}`);
        throw new TransientMetaAdError(msg, e);
      }
      const backoff = META_RETRY_BACKOFF_MS[attempt]!;
      log(`${label}: transient failure (${msg}) — retry ${attempt + 1}/${META_RETRY_BACKOFF_MS.length} in ${Math.round(backoff / 1000)}s`);
      await wait(backoff);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Settings, slots and the writer's approved caption                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The status a NEW ad is created with.
 *
 * Planning default: PAUSED (`mos_settings.planning.ads_created_paused`, true),
 * because the launch date and the weekly refresh decide when a creative starts
 * spending — not the moment its ad happened to be built.
 * `mos_settings.meta_auto_ad.status` is the explicit override (tests, and the
 * pre-planning behaviour) and wins whenever it is set to ACTIVE or PAUSED.
 */
async function resolveAdStatus(sb: SupabaseClient, log: Deps['log']): Promise<'ACTIVE' | 'PAUSED'> {
  const res = await sb.from('mos_settings').select('key, value').in('key', ['meta_auto_ad', 'planning']);
  if (res.error) {
    console.error('[meta-ad] mos_settings read failed:', res.error.message, '— defaulting to PAUSED (safe: nothing spends)');
    return 'PAUSED';
  }
  const rows = (res.data ?? []) as Array<{ key: string; value: Record<string, unknown> | null }>;
  const byKey = new Map(rows.map((r) => [r.key, r.value ?? {}]));
  const override = byKey.get('meta_auto_ad')?.status;
  if (override === 'ACTIVE' || override === 'PAUSED') {
    log(`ad status ${override} — mos_settings.meta_auto_ad.status override`);
    return override;
  }
  const paused = byKey.get('planning')?.ads_created_paused;
  const createPaused = typeof paused === 'boolean' ? paused : true;
  log(`ad status ${createPaused ? 'PAUSED' : 'ACTIVE'} — planning.ads_created_paused=${createPaused}`);
  return createPaused ? 'PAUSED' : 'ACTIVE';
}

/** The creative slot this ad row fills, when the planning layer created one. */
async function readSlotId(sb: SupabaseClient, adRowId: string): Promise<string | null> {
  const res = await sb.from('mos_execution_ads').select('slot_id').eq('id', adRowId).maybeSingle();
  if (res.error) {
    // The column arrives with the planning migration; before it lands this is
    // an unknown-column error, which means "no slots yet", not a job failure.
    console.error('[meta-ad] slot_id read failed (planning migration not applied yet?):', res.error.code, res.error.message);
    return null;
  }
  return str((res.data as { slot_id?: unknown } | null)?.slot_id);
}

/**
 * A built-but-paused ad makes its slot `ready` — the refresh lane activates it
 * on the cycle's refresh date (§7.5 step 3: "the refresh date arrived" proves
 * nothing; a slot is ready only when its ad exists and passed the verdict).
 */
async function markSlotReady(sb: SupabaseClient, slotId: string, adRowId: string, log: Deps['log']): Promise<void> {
  const upd = await sb.from('mos_creative_slots')
    .update({ status: 'ready', ad_row_id: adRowId, updated_at: new Date().toISOString() })
    .eq('id', slotId).in('status', ['reserved', 'producing', 'ready']);
  if (upd.error) {
    console.error(`[meta-ad] creative slot ${slotId} could not be marked ready:`, upd.error.code, upd.error.message);
    return;
  }
  log(`creative slot ${slotId} → ready (ad built, waiting for its activation date)`);
}

/**
 * LEGACY path — a job enqueued before 2026-09-22 carries no `approved_caption`.
 * The caption it may build is the one the WRITER confirmed and the manager
 * approved at the FINAL step, verified by hash. Three conditions, all required:
 *   1. `mos_content.data.caption` is non-empty;
 *   2. `data.caption_confirmed_text` equals it EXACTLY (raw, untrimmed — the
 *      database's own rule, `2026-09-14_01:895`, and the writing UI's,
 *      `WritingFields.tsx`; a caption edited after the confirmation no longer
 *      matches, and the comparison IS the invalidation);
 *   3. a `mos_content_approvals` row exists for the content's FINAL approval
 *      step (the step flagged `auto_meta_ad` on its pinned workflow version)
 *      whose `caption_hash` equals `mos_caption_hash(caption)` — the text the
 *      manager approved is the text on the creative NOW. Until 2026-09-22 this
 *      hash was read and discarded; a caption changed after approval reached
 *      Meta unnoticed. A mismatch is a loud failure now.
 * Anything missing THROWS with a sentence — there is no AI fallback any more.
 */
async function loadApprovedWriterCaption(
  sb: SupabaseClient, contentId: string, content: ContentRow, log: Deps['log'],
): Promise<{ caption: string; hash: string | null; confirmedAt: string | null; stepKey: string; approvedAt: string | null }> {
  const d = content.data ?? {};
  const caption = typeof d.caption === 'string' ? d.caption : '';
  const confirmedText = typeof d.caption_confirmed_text === 'string' ? d.caption_confirmed_text : '';
  const confirmedAt = str(d.caption_confirmed_at);
  if (!caption.trim()) throw new Error('the creative has no caption — nothing to build the ad from');
  if (!confirmedText) throw new Error('the writer has not confirmed the caption — confirm it on the creative, then retry');
  if (confirmedText !== caption) throw new Error('the caption changed after the writer confirmed it — confirm it again, then retry');

  // The final approval step = the step that triggers the ad on the pinned path.
  const finalSteps: string[] = [];
  const pin = await sb.from('mos_content').select('workflow_version_id').eq('id', contentId).maybeSingle();
  if (pin.error) {
    console.error('[meta-ad] pinned workflow read failed:', pin.error.message);
  } else {
    const versionId = str((pin.data as { workflow_version_id?: unknown } | null)?.workflow_version_id);
    if (versionId) {
      const ver = await sb.from('workflow_versions').select('definition').eq('id', versionId).maybeSingle();
      if (ver.error) console.error('[meta-ad] workflow version read failed:', ver.error.message);
      const steps = ((ver.data as { definition?: { metadata?: { steps?: unknown } } } | null)?.definition?.metadata?.steps);
      if (Array.isArray(steps)) {
        for (const s of steps) {
          const o = (s ?? {}) as { key?: unknown; auto_meta_ad?: unknown };
          if (o.auto_meta_ad === true && typeof o.key === 'string') finalSteps.push(o.key);
        }
      }
    }
  }
  // Fallback for content whose pinned version has no flagged step (legacy rows,
  // hand-made paths): the two step keys that ARE the final manager approval.
  if (finalSteps.length === 0) finalSteps.push('design_review', 'final_review');

  const appr = await sb.from('mos_content_approvals')
    .select('step_key, approved_at, caption_hash')
    .eq('content_id', contentId).in('step_key', finalSteps)
    .order('approved_at', { ascending: false }).limit(1).maybeSingle();
  if (appr.error) throw new Error(`mos_content_approvals read failed: ${appr.error.code} ${appr.error.message}`);
  const row = appr.data as { step_key: string; approved_at: string | null; caption_hash: string | null } | null;
  if (!row) throw new Error(`no final approval (${finalSteps.join('/')}) for this creative — approve it first`);
  const hash = await captionHashOf(sb, caption);
  if (row.caption_hash && hash && row.caption_hash !== hash) {
    throw new Error('the caption on the creative is not the one the final approval bound — re-approve the creative to launch it with the new caption');
  }
  if (!row.caption_hash) log(`legacy job: approval '${row.step_key}' carries no caption hash — building from the confirmed caption unverified`);
  else log(`legacy job: writer caption verified against approval '${row.step_key}' (${caption.length} chars)`);
  return { caption, hash, confirmedAt, stepKey: row.step_key, approvedAt: row.approved_at };
}

async function patchAdRow(sb: SupabaseClient, adRowId: string, patch: Record<string, unknown>, autoAd: Record<string, unknown>): Promise<void> {
  const prev = await sb.from('mos_execution_ads').select('creative').eq('id', adRowId).maybeSingle();
  if (prev.error) throw new Error(`ad row read: ${prev.error.message}`);
  const cr = ((prev.data as { creative?: Record<string, unknown> } | null)?.creative ?? {}) as Record<string, unknown>;
  const prevAuto = (cr.auto_ad && typeof cr.auto_ad === 'object' ? cr.auto_ad : {}) as Record<string, unknown>;
  const upd = await sb.from('mos_execution_ads')
    .update({ ...patch, creative: { ...cr, ...(patch.creative as Record<string, unknown> | undefined ?? {}), auto_ad: { ...prevAuto, ...autoAd } }, updated_at: new Date().toISOString() })
    .eq('id', adRowId);
  if (upd.error) throw new Error(`ad row update: ${upd.error.message}`);
}

/**
 * Ownership-guarded row write (2026-09-22): applied only while
 * `creative.auto_ad.job_id` is THIS job's id (or unset). Returns false — and
 * logs what was refused — when another job has taken the row over (a
 * re-approval with a new caption enqueued a superseding job after this one
 * stopped being live): the older job's writes must never land on top of the
 * newer job's. The enqueue RPC refuses a superseding job while this one is
 * queued/running, so the read-then-write window here is never raced by a
 * legitimate takeover.
 */
async function patchAdRowOwned(
  sb: SupabaseClient, adRowId: string, jobId: string,
  patch: Record<string, unknown>, autoAd: Record<string, unknown>,
): Promise<boolean> {
  const prev = await sb.from('mos_execution_ads').select('creative').eq('id', adRowId).maybeSingle();
  if (prev.error) throw new Error(`ad row read: ${prev.error.message}`);
  const cr = ((prev.data as { creative?: Record<string, unknown> } | null)?.creative ?? {}) as Record<string, unknown>;
  const prevAuto = (cr.auto_ad && typeof cr.auto_ad === 'object' ? cr.auto_ad : {}) as Record<string, unknown>;
  const owner = str(prevAuto.job_id);
  if (owner && owner !== jobId) {
    console.error(`[meta-ad] ad row ${adRowId} is owned by job ${owner}, not ${jobId} — write refused:`, Object.keys(autoAd).join(','));
    return false;
  }
  const upd = await sb.from('mos_execution_ads')
    .update({ ...patch, creative: { ...cr, ...(patch.creative as Record<string, unknown> | undefined ?? {}), auto_ad: { ...prevAuto, ...autoAd, job_id: jobId } }, updated_at: new Date().toISOString() })
    .eq('id', adRowId);
  if (upd.error) throw new Error(`ad row update: ${upd.error.message}`);
  return true;
}

/** Returns whether the emission was accepted (a refused emission is logged). */
async function notify(sb: SupabaseClient, args: {
  event: 'ad_created' | 'ad_failed'; users: string[]; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; url: string;
  dedupeKey?: string | null;
}): Promise<boolean> {
  const { error } = await sb.rpc('notify_emit', {
    p_workspace: 'marketing',
    p_event: args.event,
    p_role_keys: ['mos_marketing_manager'],
    p_user_ids: args.users,
    p_title_ar: args.titleAr,
    p_title_en: args.titleEn,
    p_body_ar: args.bodyAr,
    p_body_en: args.bodyEn,
    p_url: args.url,
    ...(args.dedupeKey ? { p_dedupe_key: args.dedupeKey } : {}),
  });
  if (error) {
    console.error('[meta-ad] notify_emit failed', args.event, error.code, error.message);
    return false;
  }
  return true;
}

/** How many times this job has already been requeued after exhausted retries. */
export function requeueAttemptOf(job: MetaAdJob): number {
  const n = Number(job.params.requeue_attempt ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Put ONE more copy of this job on the queue after the in-job retries were
 * exhausted on a transient Meta failure (§9.5: "transient Graph errors … retried
 * ×3 with backoff by the worker"). The ad row stays `creating` with the last
 * error recorded, so the Placements tab keeps saying «جارٍ الإنشاء» — which is
 * true — instead of paging the manager for something the machine is still
 * handling. The SECOND exhaustion fails the job for real.
 *
 * Returns false when the requeue itself could not be written; the caller then
 * falls back to the normal failure path (never a silent drop).
 */
export async function requeueMetaAdJob(
  sb: SupabaseClient, job: MetaAdJob, reason: string, log: Deps['log'],
): Promise<boolean> {
  const attempt = requeueAttemptOf(job) + 1;
  const newId = crypto.randomUUID();
  const ins = await sb.from('generation_jobs').insert({
    id: newId,
    record_id: job.recordId,
    message_id: job.messageId ?? str(job.params.ad_row_id) ?? job.recordId,
    generation_id: null,
    user_id: job.userId,
    kind: 'meta-ad',
    status: 'queued',
    prompt: null,
    params: { ...job.params, requeue_attempt: attempt, requeue_of: job.id, requeue_reason: reason.slice(0, 400) },
  });
  if (ins.error) {
    console.error('[meta-ad] requeue insert failed:', ins.error.code, ins.error.message);
    return false;
  }
  const adRowId = str(job.params.ad_row_id);
  if (adRowId) {
    try {
      await patchAdRow(sb, adRowId, {}, {
        state: 'creating',
        retry_queued_at: new Date().toISOString(),
        retry_attempt: attempt,
        last_transient_error: reason.slice(0, 400),
      });
    } catch (e) {
      console.error('[meta-ad] could not record the requeue on the ad row:', e instanceof Error ? e.message : e);
    }
  }
  log(`transient failure survived the retries — requeued as job ${newId} (attempt ${attempt}): ${reason}`);
  return true;
}

/** Mark the ad row failed (while this job owns it) + notify. Called by the lane on ANY thrown error. */
export async function failMetaAdJob(sb: SupabaseClient, job: MetaAdJob, message: string): Promise<void> {
  const adRowId = str(job.params.ad_row_id);
  const approvedBy = str(job.params.approved_by_user_id);
  if (adRowId) {
    try {
      const owned = await patchAdRowOwned(sb, adRowId, job.id, {}, { state: 'failed', error: message, failed_at: new Date().toISOString() });
      if (!owned) console.error(`[meta-ad] failure of job ${job.id} NOT recorded on ad row ${adRowId} — another job owns it now`);
    } catch (e) {
      console.error('[meta-ad] could not record the failure on the ad row:', e instanceof Error ? e.message : e);
    }
  }
  await notify(sb, {
    event: 'ad_failed',
    users: approvedBy ? [approvedBy] : [],
    titleAr: 'تعذّر إنشاء الإعلان في ميتا',
    titleEn: 'The Meta ad could not be created',
    bodyAr: message,
    bodyEn: message,
    url: `/m/content/${job.recordId}?tab=placements`,
    dedupeKey: `meta-ad:${job.id}:ad_failed`,
  });
}

export async function runMetaAdJob({ supabase: sb, job, log }: Deps): Promise<MetaAdJobResult> {
  const cfg = loadMetaConfig();
  if (!cfg) throw new Error('Meta credentials are not configured on the worker (META_SYSTEM_USER_TOKEN / META_AD_ACCOUNT_ID)');
  if (!cfg.pageId) throw new Error('META_PAGE_ID is not set — every creative runs from a page');
  const meta = new MetaMarketingClient(cfg);

  const contentId = str(job.params.content_id) ?? job.recordId;
  const adRowId = str(job.params.ad_row_id);
  const adSetId = str(job.params.ad_set_id);
  const platformAdSetId = str(job.params.platform_adset_id);
  const approvedBy = str(job.params.approved_by_user_id);
  if (!adRowId || !adSetId || !platformAdSetId) throw new Error('meta-ad job is missing ad_row_id / ad_set_id / platform_adset_id');

  // ── 1. content + campaign ────────────────────────────────────────────────
  const cRes = await sb.from('mos_content')
    .select('id, ref, title, project_id, project_ids, campaign_id, approval_asset_id, data, angle, cta, audience, goal')
    .eq('id', contentId).maybeSingle();
  if (cRes.error) throw new Error(`content read: ${cRes.error.message}`);
  const content = cRes.data as ContentRow | null;
  if (!content) throw new Error('content not found');

  const adRowRes = await sb.from('mos_execution_ads').select('id, execution_id, platform_ad_id, creative').eq('id', adRowId).maybeSingle();
  if (adRowRes.error) throw new Error(`ad row read: ${adRowRes.error.message}`);
  const adRow = adRowRes.data as { id: string; execution_id: string; platform_ad_id: string | null; creative: Record<string, unknown> | null } | null;
  if (!adRow) throw new Error('ad row not found');
  if (adRow.platform_ad_id) throw new Error(`this creative already has Meta ad ${adRow.platform_ad_id}`);

  const execRes = await sb.from('mos_campaign_executions').select('campaign_id, platform_settings')
    .eq('id', adRow.execution_id).maybeSingle();
  if (execRes.error) throw new Error(`execution read: ${execRes.error.message}`);
  const exec = execRes.data as { campaign_id: string; platform_settings: Record<string, unknown> | null } | null;
  const campRes = exec ? await sb.from('mos_campaigns').select('name, offer, destination_url, project_ids, project_id').eq('id', exec.campaign_id).maybeSingle() : null;
  const camp = (campRes?.data ?? null) as { name: string; offer: string | null; destination_url: string | null; project_ids: unknown; project_id: string | null } | null;

  // The CAMPAIGN's project first — the ad belongs to the campaign, and the
  // welcome template is retargeted to the campaign's project.
  const projectId = (Array.isArray(camp?.project_ids) ? str(camp?.project_ids[0]) : null)
    ?? str(camp?.project_id)
    ?? str(content.project_id)
    ?? (Array.isArray(content.project_ids) ? str(content.project_ids[0]) : null);

  // ── 2. the caption — bound at approval; verified by hash for a legacy job ─
  const payload = approvedCaptionOf(job);
  let caption: string;
  let approvalHash: string | null;
  const captionSource: MetaCaptionSource = 'writer';
  if (payload) {
    caption = payload.text;
    approvalHash = payload.hash ?? await captionHashOf(sb, payload.text);
    log(`caption: bound at approval (${caption.length} chars, hash ${approvalHash ?? '-'}, event ${str(job.params.event_id) ?? '-'})`);
  } else {
    const legacy = await loadApprovedWriterCaption(sb, contentId, content, log);
    caption = legacy.caption;
    approvalHash = legacy.hash;
  }

  // Take the row. Refused when a newer job owns it — then this job is the
  // superseded one and must not touch anything (its failure is logged only).
  const taken = await patchAdRowOwned(sb, adRowId, job.id, {
    creative: { primary_text: caption, message: caption },
  }, {
    state: 'creating', phase: 'create', started_at: new Date().toISOString(), error: null,
    caption_source: captionSource, approval_hash: approvalHash, approval_scope: 'caption',
    ...(payload ? { caption_approved_at: payload.approved_at, caption_approved_by_user_id: payload.approved_by, event_id: str(job.params.event_id) } : {}),
  });
  if (!taken) throw new Error(`ad row ${adRowId} is owned by another job — this job is superseded and built nothing`);

  // Project facts feed the welcome template's project name only.
  const facts = await loadProjectFacts(sb, projectId);
  if (!facts) log(`no project facts (project=${projectId ?? 'none'}) — the welcome template keeps its own project name`);

  // ── 3. designs → Meta (BOTH slots required) ──────────────────────────────
  const slots = await resolveSlots(sb, content);
  const kinds = new Set(slots.map((s) => s.kind));
  if (kinds.size > 1) throw new Error('the square and vertical designs must be the same type (both images or both videos)');
  const format: 'image' | 'video' = slots[0]!.kind;
  const adName = `${content.ref ?? ''} · ${content.title}`.replace(/^ · /, '').slice(0, 120);

  // Media uploads live OUTSIDE the retry closure on purpose: an image hash is
  // content-addressed and a transcoded video costs minutes, so a retry of the
  // build reuses what already landed instead of re-uploading it.
  const imageHashes: Partial<Record<Slot, string>> = {};
  const videoIds: Partial<Record<Slot, { id: string; thumb: string | null }>> = {};
  const uploadSlots = async (): Promise<void> => {
    for (const s of slots) {
      if (s.kind === 'image') {
        if (imageHashes[s.slot]) continue;
        const bytes = await fetchBytes(s.url);
        const up = await meta.uploadImageBytes(bytes, `${adName} · ${s.slot}`);
        imageHashes[s.slot] = up.hash;
        log(`uploaded ${s.slot} image → ${up.hash}`);
      } else {
        if (videoIds[s.slot]) continue;
        const up = await meta.uploadVideoByUrl(s.url, `${adName} · ${s.slot}`);
        // Meta transcodes asynchronously; a creative on an unready video fails.
        let status = 'processing';
        let thumb: string | null = null;
        const deadline = Date.now() + 6 * 60_000;
        while (Date.now() < deadline) {
          const st = await meta.getVideoStatus(up.id);
          status = st.status ?? 'processing'; thumb = st.thumbnailUrl;
          if (st.ready) break;
          if (status === 'error') throw new Error(`Meta could not process the ${s.slot} video`);
          await new Promise((r) => setTimeout(r, 5_000));
        }
        if (status !== 'ready') throw new Error(`the ${s.slot} video was still processing after 6 minutes`);
        videoIds[s.slot] = { id: up.id, thumb };
        log(`uploaded ${s.slot} video → ${up.id}`);
      }
    }
  };

  // ── 4. the ad-set PAIR (feed / story) + welcome template ─────────────────
  // Meta will not let one WhatsApp ad switch designs by placement (see the
  // header), so a Wassel ad set is a PAIR of Meta ad sets: the primary row
  // (variant 'feed') and its shadow (variant 'story', same pair_id). Each
  // design becomes a plain link_data ad in its own set. A legacy set with no
  // pair (hand-made, synced) gets ONE ad with the square design.
  const setRes = await sb.from('mos_ad_sets')
    .select('id, name, execution_id, platform_adset_id, placement_variant, pair_id')
    .eq('id', adSetId).maybeSingle();
  if (setRes.error) throw new Error(`ad set read: ${setRes.error.message}`);
  type SetRow = { id: string; name: string; execution_id: string; platform_adset_id: string | null; placement_variant: string | null; pair_id: string | null };
  const primarySet = setRes.data as SetRow | null;
  if (!primarySet?.platform_adset_id) throw new Error('the ad set is not linked to Meta');
  let storySet: SetRow | null = null;
  if (primarySet.placement_variant === 'feed' && primarySet.pair_id) {
    const sr = await sb.from('mos_ad_sets')
      .select('id, name, execution_id, platform_adset_id, placement_variant, pair_id')
      .eq('pair_id', primarySet.pair_id).eq('placement_variant', 'story').is('archived_at', null).maybeSingle();
    if (sr.error) throw new Error(`story ad set read: ${sr.error.message}`);
    storySet = (sr.data as SetRow | null) ?? null;
    if (!storySet?.platform_adset_id) throw new Error(`المجموعة الإعلانية «${primarySet.name}» بلا شريكة للستوري في ميتا — أعد «إنشاء في ميتا» على الحملة. / The ad set has no linked stories partner — run «Create in Meta» on the campaign again.`);
  }
  type Target = { variant: 'feed' | 'story' | 'single'; slot: Slot; setRowId: string; platformAdSetId: string; suffixAr: string };
  const targets: Target[] = storySet
    ? [
      { variant: 'feed', slot: 'square', setRowId: primarySet.id, platformAdSetId: primarySet.platform_adset_id, suffixAr: 'فيد' },
      { variant: 'story', slot: 'vertical', setRowId: storySet.id, platformAdSetId: storySet.platform_adset_id as string, suffixAr: 'ستوري' },
    ]
    : [{ variant: 'single', slot: 'square', setRowId: primarySet.id, platformAdSetId: primarySet.platform_adset_id, suffixAr: '' }];
  if (!storySet) log(`ad set «${primarySet.name}» is a legacy single set — one ad with the square design`);

  const adSet = await withTransientRetry(
    'ad set read', () => meta.getAdSet(primarySet.platform_adset_id as string), log,
  );
  const destination = String(exec?.platform_settings?.destination_type ?? adSet.destination_type ?? 'WHATSAPP').toUpperCase();
  const isWhatsapp = destination === 'WHATSAPP';
  const linkUrl = isWhatsapp ? 'https://api.whatsapp.com/send' : (str(camp?.destination_url) ?? 'https://wassel.re');
  const ctaType = isWhatsapp ? 'WHATSAPP_MESSAGE' : 'LEARN_MORE';
  const headline = isWhatsapp ? 'تواصل معنا على الواتساب' : 'اعرف المزيد';
  const cta = isWhatsapp
    ? { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } }
    : { type: 'LEARN_MORE', value: { link: linkUrl } };

  // ── 5 + 6. one plain creative + ad per target — the Ads-Manager shape ────
  // (object_story_spec.link_data / video_data: the ONLY shape Meta both
  // accepts for Click-to-WhatsApp and lets Ads Manager open; measured
  // 2026-09-13 — every asset-feed variant was flagged or unreadable.)
  //
  // The WHOLE Meta build is one retryable unit: uploads (cached), the welcome
  // template, the creatives, the ads and the verdict. Anything that throws
  // first UNDOES every node this attempt created, so a retry can never leave a
  // second copy of the ad behind, and a permanent refusal is re-thrown at once
  // with the buyer-readable reason.
  const oss: Record<string, unknown> = { page_id: cfg.pageId };
  if (cfg.instagramId) oss.instagram_user_id = cfg.instagramId;
  const adStatus = await resolveAdStatus(sb, log);
  type BuiltAd = Target & { adId: string; creativeId: string; name: string };
  let welcome: string | null = null;

  const buildAds = async (): Promise<BuiltAd[]> => {
    const built: BuiltAd[] = [];
    /** Deletes everything THIS attempt created, then forgets it (so a second
     *  call — e.g. the flagged-verdict path — is a no-op, not a double delete). */
    const undo = async (): Promise<void> => {
      const list = built.splice(0, built.length);
      for (const b of list) {
        try { await meta.deleteNode(b.adId); } catch (e) { console.error('[meta-ad] undo: ad delete failed', b.adId, e instanceof Error ? e.message : e); }
        try { await meta.deleteNode(b.creativeId); } catch (e) { console.error('[meta-ad] undo: creative delete failed', b.creativeId, e instanceof Error ? e.message : e); }
      }
    };

    try {
      await uploadSlots();

      if (isWhatsapp && welcome === null) {
        const template = await findWelcomeTemplate(meta, primarySet.platform_adset_id as string, log);
        welcome = retargetWelcomeTemplate(template, facts?.name ?? null, log);
      }

      for (const t of targets) {
        const name = t.suffixAr ? `${adName} · ${t.suffixAr}` : adName;
        let story: Record<string, unknown>;
        if (format === 'image') {
          const link_data: Record<string, unknown> = { link: linkUrl, message: caption, name: headline, image_hash: imageHashes[t.slot], call_to_action: cta };
          if (isWhatsapp && welcome) link_data.page_welcome_message = welcome;
          story = { ...oss, link_data };
        } else {
          const v = videoIds[t.slot]!;
          const video_data: Record<string, unknown> = { video_id: v.id, message: caption, title: headline, call_to_action: cta };
          if (v.thumb) video_data.image_url = v.thumb;
          if (isWhatsapp && welcome) video_data.page_welcome_message = welcome;
          story = { ...oss, video_data };
        }
        let creativeId: string;
        try {
          creativeId = (await meta.createAdCreative({
            name, object_story_spec: story,
            degrees_of_freedom_spec: noEnhancementsSpec(),
            contextual_multi_ads: NO_MULTI_ADVERTISER,
          })).id;
        } catch (e) {
          // A transient failure keeps its own identity so the retry wrapper can
          // see it; a real refusal becomes the sentence the buyer reads.
          if (classifyMetaError(e) === 'transient') throw e;
          const userMsg = e instanceof MetaApiError
            ? ((e.raw as { error?: { error_user_msg?: string; error_user_title?: string } } | null)?.error?.error_user_msg
              ?? (e.raw as { error?: { error_user_title?: string } } | null)?.error?.error_user_title ?? null)
            : null;
          throw new Error(`رفضت ميتا الكرييتف (${t.suffixAr || 'الإعلان'}): ${userMsg ?? (e instanceof Error ? e.message : String(e))} / Meta refused the ${t.variant} creative`);
        }
        const ad = await meta.createAd({ name, adset_id: t.platformAdSetId, creative: { creative_id: creativeId }, status: adStatus });
        built.push({ ...t, adId: ad.id, creativeId, name });
        log(`${t.variant} ad ${ad.id} created ${adStatus} in ad set ${t.platformAdSetId} (creative ${creativeId})`);
      }

      // Meta validates the ad against the objective ASYNCHRONOUSLY: creation
      // returns 200 and the verdict lands on `issues_info` seconds later. Wait
      // for it — an ad flagged WITH_ISSUES is not "created", it is a failure the
      // manager must see (the 2026-09-13 «Invalid Creative For Objective» case).
      for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setTimeout(r, 5_000));
        const verdicts = await Promise.all(built.map((b) => meta.getAdIssues(b.adId)));
        const flagged = verdicts.flatMap((v, idx) => v.issues.map((issue) => `${built[idx]!.variant}: ${issue}`));
        if (flagged.length > 0) {
          throw new Error(`رفضت ميتا الإعلان بعد إنشائه: ${flagged.join('; ')} / Meta flagged the ad after creation: ${flagged.join('; ')} (deleted)`);
        }
        if (verdicts.every((v) => v.status && v.status !== 'IN_PROCESS')) break;
      }
      return built;
    } catch (e) {
      // NEVER leave a half-built ad: whatever happened, the nodes this attempt
      // created go away before the error travels on.
      await undo();
      throw e;
    }
  };

  const built = await withTransientRetry('meta ad build', buildAds, log);
  log(`Meta accepted ${built.length} ad(s): ${built.map((b) => `${b.variant}=${b.adId}`).join(', ')}`);

  // ── 7. record + notify ───────────────────────────────────────────────────
  const primary = built.find((b) => b.variant !== 'story')!;
  const shadow = built.find((b) => b.variant === 'story') ?? null;
  const rowStatus = adStatus === 'ACTIVE' ? 'running' : 'paused';
  const copy = { primary_text: caption, message: caption, headline, cta: ctaType, destination_url: linkUrl };
  // The hash of what was actually sent — equal to approval_hash by
  // construction; recorded so an audit can prove it without trusting the code.
  const builtTextHash = await captionHashOf(sb, caption);
  const recorded = await patchAdRowOwned(sb, adRowId, job.id, {
    platform_ad_id: primary.adId,
    label: primary.name,
    status: rowStatus,
    creative: copy,
    ...(shadow ? { placement_variant: 'feed', pair_id: adRowId } : {}),
  }, {
    state: 'created',
    phase: 'create',
    creative_id: primary.creativeId,
    creative_shape: shadow ? 'pair' : 'single',
    platform_ad_ids: Object.fromEntries(built.map((b) => [b.variant, b.adId])),
    format,
    image_hashes: imageHashes,
    video_ids: Object.fromEntries(Object.entries(videoIds).map(([k, v]) => [k, v.id])),
    caption_source: captionSource,
    approval_hash: approvalHash,
    approval_scope: 'caption',
    built_text_hash: builtTextHash,
    welcome_template: welcome ? 'duplicated' : null,
    ad_status: adStatus,
    created_at: new Date().toISOString(),
    error: null,
  });
  if (!recorded) {
    throw new Error(`Meta ads ${built.map((b) => b.adId).join(', ')} were created but ad row ${adRowId} is owned by another job — sync from Meta to record them`);
  }
  if (shadow) {
    // The stories ad lives on a SHADOW row (variant 'story', pair_id = the
    // primary row) so the execution's Ads tab and the Meta sync see it by its
    // own platform id; the Placements tab hides it behind the primary.
    const existing = await sb.from('mos_execution_ads').select('id')
      .eq('pair_id', adRowId).eq('placement_variant', 'story').is('archived_at', null).maybeSingle();
    if (existing.error) throw new Error(`shadow row read: ${existing.error.message}`);
    const shadowPatch = {
      execution_id: adRow.execution_id, ad_set_id: shadow.setRowId, content_id: contentId,
      label: shadow.name, status: rowStatus, platform_ad_id: shadow.adId,
      placement_variant: 'story', pair_id: adRowId,
      creative: { ...copy, auto_ad: { state: 'created', shadow_of: adRowId, creative_id: shadow.creativeId, created_at: new Date().toISOString() } },
      updated_at: new Date().toISOString(),
    };
    const w = existing.data
      ? await sb.from('mos_execution_ads').update(shadowPatch).eq('id', (existing.data as { id: string }).id)
      : await sb.from('mos_execution_ads').insert(shadowPatch);
    if (w.error) throw new Error(`shadow row write: ${w.error.message} (Meta ads ${built.map((b) => b.adId).join(', ')} exist — sync from Meta to recover)`);
  }
  // A PAUSED ad is a creative WAITING for its date: its slot becomes `ready`
  // and the refresh lane activates it on schedule (§7.5). An ACTIVE one (the
  // explicit meta_auto_ad override) is already live, so its slot is `active`.
  const slotId = await readSlotId(sb, adRowId);
  if (slotId) {
    if (adStatus === 'PAUSED') {
      await markSlotReady(sb, slotId, adRowId, log);
    } else {
      const upd = await sb.from('mos_creative_slots')
        .update({ status: 'active', ad_row_id: adRowId, activated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', slotId);
      if (upd.error) console.error(`[meta-ad] creative slot ${slotId} could not be marked active:`, upd.error.code, upd.error.message);
    }
  }

  await notify(sb, {
    event: 'ad_created',
    users: approvedBy ? [approvedBy] : [],
    titleAr: adStatus === 'ACTIVE' ? 'أُنشئ الإعلان في ميتا وهو يعمل' : 'أُنشئ الإعلان في ميتا (متوقف حتى موعد التشغيل)',
    titleEn: adStatus === 'ACTIVE' ? 'The Meta ad was created and is running' : 'The Meta ad was created (paused until its scheduled start)',
    bodyAr: `«${content.title}» — ${shadow ? 'إعلانان: فيد + ستوري' : adSet.name}`,
    bodyEn: `“${content.title}” — ${shadow ? 'two ads: feed + stories' : adSet.name}`,
    url: `/m/content/${contentId}?tab=placements`,
    dedupeKey: `meta-ad:${job.id}:ad_created`,
  });

  return {
    phase: 'create',
    platform_ad_id: primary.adId,
    creative_id: primary.creativeId,
    caption_source: captionSource,
    format,
    ad_status: adStatus,
    slot_id: slotId,
    approval_hash: approvalHash,
    built_text_hash: builtTextHash,
  };
}
