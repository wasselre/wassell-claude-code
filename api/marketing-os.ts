/**
 * POST /api/marketing-os
 *
 * Action-dispatch endpoint for the Marketing OS module — a ground-up rebuild.
 * It shares NOTHING with the `mkt_*` tables or `api/marketing-mgmt.ts`; it reads
 * and writes the `mos_*` domain tables plus the canonical engine tables
 * (`workflows` kind='role_path', `workflow_versions`, `workflow_role_tasks`,
 * `roles` key 'mos_*', `surface_access`) that replaced the retired mos engine
 * (formerly mos_workflows / mos_workflow_steps / mos_tasks / mos_role_grants).
 *
 * Deliberately NOT `api/marketing.ts` — that name is already the live Marketing
 * Intelligence endpoint (competitor intel, ~49k observed facts) and is unrelated.
 *
 * Posture, matching every other bespoke module here:
 *   - Edge runtime, one POST, `{ action, ...payload }`.
 *   - Runs on the CALLER's JWT, never the service role. RLS is the authorization
 *     boundary — `wassell_mos_can(<capability>)` decides, not this file.
 *   - Task transitions go through `workflow_advance_role_path` (SQL, atomic);
 *     this file only snapshots versions and translates the response.
 *   - Reads go through `mos_content_v`, which DERIVES status and current owner
 *     from the open task. There is no stored status column to disagree with.
 *   - Updates use an allow-list, never a deny-list.
 *   - Deliberate DB rejections are translated bilingually; raw Postgres is never
 *     returned to the browser but is always console.error-ed (repo rule: fail loudly).
 */
import { createClient, type SupabaseClient, type PostgrestError } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
import { runMetaSync } from './_lib/marketing/metaSync.js';
import { loadMetaConfig, MetaMarketingClient, MetaApiError } from './_lib/marketing/metaMarketingApi.js';
import { buildCampaignPayload, buildAdSetPayload, type PushCampaign, type PushExecution } from './_lib/marketing/metaPush.js';
import {
  loadBundleConfig, isBundlePlatform, buildPlatformData, platformAcceptsKind,
  uploadFromUrl, createPost, getPost, deletePost, getTeam, extractPermalink, mapBundleStatus,
  BundleApiError, BUNDLE_PLATFORM_TYPE, type BundlePost,
} from './_lib/marketing/bundleSocial.js';
import { pullPublicationMetrics, runBundleMetricsSync } from './_lib/marketing/bundleMetrics.js';
import { runBundleAccountMetricsSync } from './_lib/marketing/bundleAccountMetrics.js';
import { runBundleStatusSweep } from './_lib/marketing/bundleStatusSync.js';
import { embedQuery, diversify, describeMatch, num as cvNum, type CvSearchRow } from './_lib/marketing/modalCv.js';
// Pure shared rulebook — same blessed src↔api cross-import as localizedName.ts.
import { preflightPublishSet } from '../src/lib/marketingOS/platformRules.js';

/* ── creative director (handlers — dispatch block is near the switch end) ── */
import { creativeTargets } from './_lib/marketing/creative/targets.js';
import {
  writePostCreative, creativeConceptSelect, creativeRegenerate, creativeJobStatus,
  creativePackageList, creativePackageGet, creativePackageSave, creativeAssetReplace,
} from './_lib/marketing/creative/packages.js';
import {
  creativePackageApply, creativePackageRevert, creativeAiApprove, creativeAiDismiss,
} from './_lib/marketing/creative/apply.js';
import { creativeHandoff } from './_lib/marketing/creative/handoff.js';
import {
  creativeFlags, creativeFlagsSave, brandKitGet, brandKitSave, brandKitReview,
  writerRulesGet, writerRulesSave, roleMapGet, roleMapSave, aiRolesGet, aiRolesSave,
} from './_lib/marketing/creative/settings.js';
import { designExampleSet, designExampleList } from './_lib/marketing/creative/examples.js';
import { creativePerformance } from './_lib/marketing/creative/performance.js';
import { enqueueWasselReadsOnPublish } from './_lib/marketing/creative/onPublished.js';

export const config = { runtime: 'edge' };

/* ------------------------------------------------------------------ */
/* transport                                                          */
/* ------------------------------------------------------------------ */

function callerClient(req: Request): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('supabase env missing');
  const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

async function resolveAppUserId(sb: SupabaseClient, authUid: string): Promise<string | null> {
  const { data, error } = await sb.rpc('wassell_app_user_id', { auth_user_id: authUid });
  if (error) {
    console.error('[marketing-os] wassell_app_user_id failed', error.code, error.message, error.details);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Gate an action on a marketing capability, evaluated as the CALLER (union of
 * their held roles) via wassell_mos_capabilities. Returns a 403 Response when
 * the capability is absent, or null to proceed. Used for the Meta write paths,
 * whose side effects live on Meta (outside RLS's reach), so the DB can't gate
 * them for us.
 */
async function requireCap(sb: SupabaseClient, capability: string): Promise<Response | null> {
  // wassell_mos_can carries the admin bypass + viewer read-floor, so an admin
  // with no explicit marketing role still passes (wassell_mos_capabilities,
  // being a plain union of held roles, would wrongly 403 them).
  const res = await sb.rpc('wassell_mos_can', { p_capability: capability });
  if (res.error) return jsonError(500, res.error.message);
  if (res.data !== true) return jsonError(403, `${capability} capability required`);
  return null;
}

/** Fire-and-forget /wake ping to the Fly worker so a freshly enqueued job skips
 *  the poll latency. Missing env or a dead worker is fine — the worker's poll
 *  loop is the reliable path (same posture as /api/generate-deck). */
function wakeWorker(): void {
  const base = process.env.WASSEL_DECK_WORKER_URL;
  if (!base) return;
  void fetch(`${base.replace(/\/$/, '')}/wake`, { method: 'POST' }).catch(() => {
    /* best-effort by design */
  });
}

/** Human-readable one-liner from a Meta Graph error (or any thrown value). */
function metaErr(e: unknown): string {
  if (e instanceof MetaApiError) {
    return `${e.message}${e.code != null ? ` (code ${e.code}${e.subcode != null ? `/${e.subcode}` : ''})` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * A campaign's LIVE status, derived from its executions' real platform state.
 * `manualStatus` is the hand-set lifecycle; a deliberate `done`/`cancelled`
 * is never overridden. Otherwise a running execution → 'active', a synced-but-
 * not-running one → 'paused', nothing synced → null (fall back to manual).
 */
function deriveLiveStatus(
  manualStatus: string | undefined,
  live: { running: boolean; synced: boolean } | undefined,
): 'active' | 'paused' | null {
  if (manualStatus === 'done' || manualStatus === 'cancelled') return null;
  if (!live) return null;
  if (live.running) return 'active';
  if (live.synced) return 'paused';
  return null;
}

/** Clamp any client-supplied limit. No list here is ever unbounded. */
const cap = (n: unknown, def: number, max: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : def;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** Deliberate database rejections, translated. Anything unmapped stays generic. */
const DB_MESSAGES: Record<string, { en: string; ar: string }> = {
  'MOS:UNKNOWN_CONTENT_TYPE': {
    en: 'That content type does not exist.',
    ar: 'نوع المحتوى غير موجود.',
  },
  'MOS:NOTE_REQUIRED': {
    en: 'Requesting changes requires a note explaining what to change.',
    ar: 'طلب التعديلات يستلزم ملاحظة توضّح المطلوب.',
  },
  'MOS:NO_OPEN_TASK': {
    en: 'This item has no open task.',
    ar: 'لا توجد مهمة مفتوحة لهذا العنصر.',
  },
  'MOS:NOT_YOUR_TASK': {
    en: 'This task sits with another role.',
    ar: 'هذه المهمة تتبع دورًا آخر.',
  },
  'MOS:UNKNOWN_ROLE': {
    en: 'That marketing role does not exist.',
    ar: 'دور التسويق غير موجود.',
  },
  'MOS:RATINGS_DISABLED': {
    en: 'Ratings are switched off in performance settings.',
    ar: 'التقييم متوقف من إعدادات الأداء.',
  },
  'MOS:CONTENT_NOT_DONE': {
    en: 'This creative still has an open task — rate it when it is finished.',
    ar: 'لا يزال لهذا المحتوى مهمة مفتوحة — قيّمه بعد اكتماله.',
  },
  'MOS:NO_CONTRIBUTORS': {
    en: 'No contributors found on this creative to rate.',
    ar: 'لا يوجد مساهمون في هذا المحتوى لتقييمهم.',
  },
  'MOS:INSUFFICIENT_XP': {
    en: 'Not enough points for this reward yet.',
    ar: 'النقاط لا تكفي لهذه المكافأة بعد.',
  },
  'MOS:CLAIM_NOT_PENDING': {
    en: 'This reward claim was already decided.',
    ar: 'طلب المكافأة سبق البت فيه.',
  },
  'MOS:ACTION_NOT_PENDING': {
    en: 'This notice was already decided.',
    ar: 'هذا الإشعار سبق البت فيه.',
  },
  'MOS:DEDUCTIONS_DISABLED': {
    en: 'Deductions are in observe mode — enable them in performance settings first.',
    ar: 'الخصومات في وضع المراقبة — فعّلها من إعدادات الأداء أولًا.',
  },
  'MOS:LEAVE_NOT_PENDING': {
    en: 'This leave request was already decided.',
    ar: 'طلب الإجازة سبق البت فيه.',
  },
  'MOS:BAD_RANGE': {
    en: 'The leave end must be after its start.',
    ar: 'نهاية الإجازة يجب أن تكون بعد بدايتها.',
  },
  'MOS:REWARD_NOT_FOUND': {
    en: 'That reward is not available.',
    ar: 'هذه المكافأة غير متاحة.',
  },
  'MOS:TASK_NOT_YOURS': {
    en: 'This task is assigned to someone else.',
    ar: 'هذه المهمة مسندة إلى شخص آخر.',
  },
  'MOS:TASK_FIELD_LOCKED': {
    en: 'You can complete this task, but only the person who assigned it can change it.',
    ar: 'يمكنكِ إنهاء المهمة، لكن تعديلها يعود لمن أسندها.',
  },
  'MOS:TASK_CANCEL_DENIED': {
    en: 'Only the person who assigned this task can cancel it.',
    ar: 'إلغاء المهمة يعود لمن أسندها.',
  },
  mos_task_series_weekly_check: {
    en: 'A weekly repeat needs at least one weekday.',
    ar: 'التكرار الأسبوعي يحتاج يومًا واحدًا على الأقل.',
  },
  mos_task_series_monthly_check: {
    en: 'A monthly repeat needs a day of the month between 1 and 31.',
    ar: 'التكرار الشهري يحتاج يومًا من الشهر بين ١ و٣١.',
  },
  mos_manual_tasks_title_check: {
    en: 'A task needs a title.',
    ar: 'المهمة تحتاج عنوانًا.',
  },
  workflow_role_tasks_reject_note_check: {
    en: 'Requesting changes requires a note explaining what to change.',
    ar: 'طلب التعديلات يستلزم ملاحظة توضّح المطلوب.',
  },
  uq_workflow_role_tasks_one_open: {
    en: 'This item already has an open task.',
    ar: 'هذا العنصر لديه مهمة مفتوحة بالفعل.',
  },
  mos_content_purpose_check: {
    en: 'Purpose must be organic, paid or both.',
    ar: 'الغرض يجب أن يكون عضويًا أو مدفوعًا أو الاثنين.',
  },
  mos_campaign_executions_purpose_check: {
    en: 'Execution purpose must be conversion, awareness, retargeting or traffic.',
    ar: 'غرض التنفيذ يجب أن يكون تحويلًا أو وعيًا أو إعادة استهداف أو زيارات.',
  },
  mos_campaign_events_kind_check: {
    en: 'That campaign event kind does not exist.',
    ar: 'نوع حدث الحملة غير موجود.',
  },
  client_attributions_source_check: {
    en: 'Attribution source must be lead_form, manual or import.',
    ar: 'مصدر النسبة يجب أن يكون نموذج عميل أو يدويًا أو استيرادًا.',
  },
  client_attributions_touch_check: {
    en: 'Touch type must be first or last.',
    ar: 'نوع اللمسة يجب أن يكون الأولى أو الأخيرة.',
  },
  'MOS:ATTRIBUTION_IMMUTABLE': {
    en: 'Attribution rows are append-only; correct by stamping a superseding row.',
    ar: 'سجل النسبة غير قابل للتعديل؛ صحّح بإضافة صف جديد يحل محل القديم.',
  },
  mos_snap_not_empty_check: {
    en: 'Enter at least one number, or skip this publication.',
    ar: 'أدخل رقمًا واحدًا على الأقل، أو تخطَّ هذا المنشور.',
  },
};

/* ------------------------------------------------------------------ */
/* Platform-settings guard                                             */
/*                                                                     */
/* The structured ad-platform fields (schemas in                       */
/* src/lib/marketingOS/adPlatforms/, reference in                      */
/* docs/reference/ad-platforms/). The server stays permissive on       */
/* purpose — this is a planning record until the platforms are         */
/* connected — but rejects garbage shapes and objectives the           */
/* platform's API does not have. Kept self-contained: api/** does not  */
/* import the src schema files (server-bundle boundary).               */
/* ------------------------------------------------------------------ */

const AD_PLATFORM_OBJECTIVES: Record<string, { key: string; values: string[] }> = {
  meta: {
    key: 'objective',
    values: ['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT',
             'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES'],
  },
  instagram: {
    key: 'objective',
    values: ['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT',
             'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES'],
  },
  snapchat: {
    key: 'objective_v2_type',
    values: ['AWARENESS_AND_ENGAGEMENT', 'TRAFFIC', 'LEADS', 'APP_PROMOTION', 'SALES'],
  },
  tiktok: {
    key: 'objective_type',
    values: ['REACH', 'TRAFFIC', 'VIDEO_VIEWS', 'LEAD_GENERATION', 'ENGAGEMENT',
             'APP_PROMOTION', 'WEB_CONVERSIONS', 'PRODUCT_SALES'],
  },
};

/** Flat jsonb only: scalars, null, or lists of strings — nothing nested. */
function flatJsonbError(field: string, raw: unknown): { en: string; ar: string } | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      en: `${field} must be an object.`,
      ar: `حقل ${field} يجب أن يكون كائنًا.`,
    };
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const ok = v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) {
      return {
        en: `${field}.${k} must be a scalar or a list of strings.`,
        ar: `قيمة ${k} في ${field} يجب أن تكون نصًا أو رقمًا أو قائمة نصوص.`,
      };
    }
  }
  return null;
}

function platformSettingsError(platform: string | null, raw: unknown): { en: string; ar: string } | null {
  const shape = flatJsonbError('platform_settings', raw);
  if (shape) return shape;
  if (raw === null || raw === undefined) return null;
  const spec = platform ? AD_PLATFORM_OBJECTIVES[platform] : undefined;
  if (spec) {
    const objective = (raw as Record<string, unknown>)[spec.key];
    if (objective !== null && objective !== undefined && objective !== ''
        && (typeof objective !== 'string' || !spec.values.includes(objective))) {
      return {
        en: `Unknown ${platform} objective.`,
        ar: 'هدف الحملة غير معروف لهذه المنصة.',
      };
    }
  }
  return null;
}

function translateDbError(error: PostgrestError): { status: number; en: string; ar: string } {
  console.error('[marketing-os] db error', error.code, error.message, error.details, error.hint);

  if (error.code === '42501' || /row-level security/i.test(error.message)) {
    return {
      status: 403,
      en: 'Your marketing role does not allow this action.',
      ar: 'دورك في التسويق لا يسمح بهذا الإجراء.',
    };
  }
  for (const token of Object.keys(DB_MESSAGES)) {
    const mapped = DB_MESSAGES[token];
    if (mapped && error.message.includes(token)) {
      return { status: 400, en: mapped.en, ar: mapped.ar };
    }
  }
  return {
    status: 400,
    en: 'The database rejected this change.',
    ar: 'رفضت قاعدة البيانات هذا التغيير.',
  };
}

/** Returns a Response when `error` is set, otherwise null. */
function dbFail(error: PostgrestError | null): Response | null {
  if (!error) return null;
  const t = translateDbError(error);
  return new Response(JSON.stringify({ error: t.en, error_ar: t.ar }), {
    status: t.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Minimal row shape. PostgREST cannot infer a select built from a runtime string. */
interface Row {
  id: string;
  [key: string]: unknown;
}

/**
 * The Content list shows a dozen fields. Naming them keeps the payload
 * proportional to the screen instead of shipping every column of the view.
 */
const CONTENT_LIST_COLUMNS = [
  'id', 'ref', 'title', 'content_type_key', 'content_type_label_ar', 'content_type_label_en',
  'project_id', 'project_ids', 'campaign_id', 'purpose', 'organic_platforms',
  'status_key', 'current_step_label_ar', 'current_step_label_en',
  'owner_role', 'current_assignee_user_id', 'current_task_due_at', 'current_round',
  'due_at', 'target_publish_at', 'updated_at',
].join(', ');

/** Patchable content fields. Identity and provenance are excluded by omission.
 *  `purpose` is NO LONGER writable — it is DERIVED in mos_content_v from the
 *  placements that exist (paid ad rows / publications). `campaign_id` stays
 *  writable but is now PROVENANCE ("born here"), not ownership: it does not
 *  constrain which placements the creative may carry. */
const CONTENT_EDITABLE = [
  'title', 'project_id', 'project_ids', 'campaign_id', 'language',
  'goal', 'audience', 'angle', 'cta', 'organic_platforms',
  'target_publish_at', 'due_at', 'data',
] as const;

/** The five standardized ad-copy keys a paid placement carries in `creative`. */
const AD_CREATIVE_KEYS = ['primary_text', 'headline', 'description', 'cta', 'destination_url'] as const;

/** Ad channels with NO organic feed. A publications row is the ORGANIC publish
 *  surface — a row on one of these renders «إعلانات ميتا» inside the Placements
 *  tab's organic section (the 2026-08-28 bug: paid-campaign bulk content seeded
 *  a publication per execution platform). Paid placements live on
 *  mos_execution_ads, never on mos_publications — refuse loudly. */
const PAID_ONLY_PLATFORMS = new Set(['meta', 'google']);

/** ONE paid placement = one `mos_execution_ads` row for this creative, wherever
 *  it lives (any campaign, any execution, any ad set). The creative is decoupled
 *  from its campaign, so a placement resolves its OWN execution → campaign path. */
interface PaidPlacement {
  id: string;
  execution_id: string;
  ad_set_id: string | null;
  ad_set_name: string | null;
  content_id: string | null;
  creative: Record<string, unknown> | null;
  status: string;
  execution: {
    id: string; platform: string; label: string | null;
    campaign_id: string; campaign_name: string | null;
  };
}
interface PaidPlacementsPayload {
  placements: PaidPlacement[];
}

/**
 * The paid placements a creative actually carries — its `mos_execution_ads` rows
 * across ANY campaign (the creative is no longer owned by one). Each row resolves
 * its execution + campaign + ad set for display. Reused by the `content_paid_ads`
 * read and returned fresh from the save/remove actions. Reads as the CALLER (RLS)
 * — throws PostgrestError.
 */
async function loadPaidAdsPayload(sb: SupabaseClient, contentId: string): Promise<PaidPlacementsPayload> {
  const adsRes = await sb.from('mos_execution_ads')
    .select('id, execution_id, ad_set_id, content_id, creative, status')
    .eq('content_id', contentId).is('archived_at', null)
    .order('created_at', { ascending: true });
  if (adsRes.error) throw adsRes.error;
  const ads = (adsRes.data ?? []) as Array<{
    id: string; execution_id: string; ad_set_id: string | null;
    content_id: string | null; creative: Record<string, unknown> | null; status: string;
  }>;
  if (ads.length === 0) return { placements: [] };

  const execIds = [...new Set(ads.map((a) => a.execution_id))];
  const execsRes = await sb.from('mos_campaign_executions')
    .select('id, platform, label, campaign_id').in('id', execIds);
  if (execsRes.error) throw execsRes.error;
  const execs = (execsRes.data ?? []) as Array<{ id: string; platform: string; label: string | null; campaign_id: string }>;
  const execById = new Map(execs.map((e) => [e.id, e]));

  const campIds = [...new Set(execs.map((e) => e.campaign_id))];
  const campName = new Map<string, string>();
  if (campIds.length > 0) {
    const campsRes = await sb.from('mos_campaigns').select('id, name').in('id', campIds);
    if (campsRes.error) throw campsRes.error;
    for (const c of (campsRes.data ?? []) as Array<{ id: string; name: string }>) campName.set(c.id, c.name);
  }

  const setIds = [...new Set(ads.map((a) => a.ad_set_id).filter((x): x is string => !!x))];
  const setName = new Map<string, string>();
  if (setIds.length > 0) {
    const setsRes = await sb.from('mos_ad_sets').select('id, name').in('id', setIds);
    if (setsRes.error) throw setsRes.error;
    for (const s of (setsRes.data ?? []) as Array<{ id: string; name: string }>) setName.set(s.id, s.name);
  }

  const placements: PaidPlacement[] = ads.map((a) => {
    const e = execById.get(a.execution_id);
    // The ad caption has two historical homes: `message` (written by the campaign
    // wizard / tree editor) and `primary_text` (written by the Placements tab).
    // Surface ONE — primary_text, falling back to message — so the caption a user
    // typed in the wizard shows on the Placements card instead of an empty box.
    const cr = a.creative ?? {};
    const normCreative = (cr.primary_text == null && typeof cr.message === 'string')
      ? { ...cr, primary_text: cr.message }
      : cr;
    return {
      id: a.id,
      execution_id: a.execution_id,
      ad_set_id: a.ad_set_id,
      ad_set_name: a.ad_set_id ? (setName.get(a.ad_set_id) ?? null) : null,
      content_id: a.content_id,
      creative: normCreative,
      status: a.status,
      execution: e
        ? { id: e.id, platform: e.platform, label: e.label, campaign_id: e.campaign_id, campaign_name: campName.get(e.campaign_id) ?? null }
        : { id: a.execution_id, platform: '', label: null, campaign_id: '', campaign_name: null },
    };
  });
  return { placements };
}

/** The live metric a success measure's target is tracked against (mirrors the
 *  MosMeasureSource type + the mos_measure_types.source CHECK constraint). */
const MEASURE_SOURCES: readonly string[] = [
  'impressions', 'clicks', 'leads', 'qualified',
  'spend', 'cpl', 'cpl_qualified', 'ctr', 'none',
];

/**
 * A campaign or content item can link to SEVERAL projects (`project_ids`, a
 * searchable multi-select restricted to Our Projects) while `project_id` is kept
 * as the PRIMARY (first) project — so every existing filter, join, attribution
 * read, and single-name display keeps working unchanged. Call this on any patch
 * that carries `project_ids`: it normalizes the array (drops blanks, dedupes) and
 * derives the primary. If the caller sent `project_ids` we always re-derive
 * `project_id` from it, so the two can never disagree.
 */
function applyProjectIds(patch: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(patch, 'project_ids')) return;
  const raw = patch.project_ids;
  const ids = Array.isArray(raw)
    ? Array.from(new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0)))
    : [];
  patch.project_ids = ids;
  patch.project_id = ids[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Project Info — resolve a curated set of all_projects fields for the */
/* content writer's «project info» tab (labels from schema, values     */
/* from the record; formatting stays on the client via `kind`).        */
/* ------------------------------------------------------------------ */

type SchemaFieldDef = {
  name?: string; type?: string; label_ar?: string; label_en?: string;
  options?: Array<{ value?: string; label_ar?: string; label_en?: string }>;
};

interface ProjectInfoField {
  key: string;
  label_ar: string;
  label_en: string;
  kind: string;
  value?: unknown;
  value_ar?: string;
  value_en?: string;
}

/** Build one display field, or null to skip (empty/absent). Formatting of
 *  numbers/ranges/dates stays on the client (Arabic digits); dropdowns and
 *  location are resolved to labels here because that needs the schema. */
function buildProjectInfoField(key: string, def: SchemaFieldDef | undefined, raw: unknown): ProjectInfoField | null {
  const empty = raw === null || raw === undefined || raw === ''
    || (Array.isArray(raw) && raw.length === 0);
  if (empty) return null;
  const label_ar = def?.label_ar ?? key;
  const label_en = def?.label_en ?? key;
  const type = def?.type ?? 'text';
  const base = { key, label_ar, label_en };

  const optLabel = (val: unknown): { ar: string; en: string } => {
    const o = (def?.options ?? []).find((x) => x.value === val);
    return { ar: o?.label_ar ?? String(val), en: o?.label_en ?? String(val) };
  };

  if (type === 'dropdown') {
    const l = optLabel(raw);
    return { ...base, kind: 'text', value_ar: l.ar, value_en: l.en };
  }
  if (type === 'multiselect') {
    const arr = Array.isArray(raw) ? raw : [raw];
    const ars = arr.map((v) => optLabel(v).ar);
    const ens = arr.map((v) => optLabel(v).en);
    return { ...base, kind: 'text', value_ar: ars.join('، '), value_en: ens.join(', ') };
  }
  if (type === 'range') {
    const r = raw as { min?: unknown; max?: unknown };
    const min = typeof r?.min === 'number' ? r.min : null;
    const max = typeof r?.max === 'number' ? r.max : null;
    if (min === null && max === null) return null;
    return { ...base, kind: key.includes('price') ? 'range_currency' : 'range', value: { min, max } };
  }
  if (type === 'location') {
    const loc = raw as Record<string, unknown>;
    const parts = ['district', 'city', 'region'].map((k) => loc?.[k]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (parts.length === 0) return null;
    const s = parts.join(' · ');
    return { ...base, kind: 'text', value_ar: s, value_en: s };
  }
  if (type === 'currency' || type === 'number' || type === 'formula') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return null;
    return { ...base, kind: type === 'currency' ? 'currency' : 'number', value: n };
  }
  if (type === 'date' || type === 'datetime') {
    return { ...base, kind: 'date', value: String(raw) };
  }
  if (type === 'url') {
    return { ...base, kind: 'url', value: String(raw) };
  }
  // text / textarea / anything else → a plain (possibly long) string.
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return { ...base, kind: s.length > 90 ? 'long' : 'text', value_ar: s, value_en: s };
}

/** Fields shown in the content writer's «project info» tab, in reading order.
 *  Customer-facing ranges use the AVAILABLE-only family (see rollup rules). */
const PROJECT_INFO_KEYS = [
  'project_name', 'project_type', 'project_status', 'construction_status',
  'location', 'project_location',
  'available_units', 'unit_count', 'unit_types',
  'available_price_range', 'available_area_range', 'bedroom_range', 'avg_price_per_m2',
  'handover_date', 'on_handover_percent', 'post_handover_months',
  'broucher_developer', 'project_analysis',
];

/* ------------------------------------------------------------------ */
/* the canonical engine (workflows kind='role_path' + workflow_role_   */
/* tasks + roles 'mos_*' + surface_access)                             */
/* ------------------------------------------------------------------ */

/** The five marketing roles a role-path step can point at (keys, mos_ stripped). */
const MOS_ROLE_KEYS = ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage'] as const;

/** Every surface the shell can route to, in the matrix's stable order. */
const SURFACES = [
  'overview', 'mywork', 'team', 'content', 'calendar', 'library',
  'shoots', 'goals', 'campaigns', 'numbers',
  // Organic cockpit: Platform Pulse ('organic') + Publishing Board ('publishing').
  'organic', 'publishing',
  // Performance & load system: own profile ('myperf') + the manager desk.
  'myperf', 'performance',
  'settings', 'roles',
] as const;
type SurfaceKey = (typeof SURFACES)[number];
type SurfaceLevel = 'full' | 'read' | 'hidden';

/**
 * Every marketing capability, in a stable order for the Roles-screen matrix.
 * These are what a role can DO (RLS gates on them via wassell_mos_can); they
 * are stored as data in role_capabilities. Keep in sync with the seed in
 * migration 2026-08-06_01_role_capabilities.sql and the client `Capability`
 * type (MarketingWorkspace.tsx).
 */
const CAPABILITIES = [
  'read', 'comment', 'write_content', 'view_content_body', 'compare_versions',
  'view_activity', 'assign', 'assign_task', 'schedule', 'publish', 'approve_creative',
  'approve_process', 'approve_budget', 'manage_assets', 'enter_metrics',
  'review_performance', 'delete_records', 'manage_settings', 'manage_roles',
  // manage_paid_ads: sync + create/manage OUR Meta campaigns via the Marketing
  // API (can affect live ad spend). Gated separately from manage_settings so a
  // role can run reports/sync without the power to launch or edit live ads.
  'manage_paid_ads',
  // Performance & load system (2026-08-28): rate finished creatives, and run
  // the manager desk (discipline/leave/reward decisions, KPI goals, toggles).
  'rate_creative', 'manage_performance',
] as const;

/** The notification channels a step may permit; AND-ed with each role's grid. */
const NOTIFY_CHANNELS = ['inapp', 'push', 'whatsapp'] as const;
type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * Normalize a raw `notify_channels` value from jsonb into a clean, deduped
 * subset of the three known channels. Absent / non-array → all three (the
 * legacy default: the role grid alone decides).
 */
function channelsOf(raw: unknown): NotifyChannel[] {
  if (!Array.isArray(raw)) return [...NOTIFY_CHANNELS];
  const out = NOTIFY_CHANNELS.filter((c) => (raw as unknown[]).includes(c));
  // An explicitly empty array is a real state (step permits nothing); only an
  // absent/garbage value falls back to "all three".
  return out;
}

/** A role-path step as stored in workflows.metadata->'steps'. */
interface StepDef {
  key: string;
  label_ar: string;
  label_en: string;
  role_key: string;
  due_days: number;
  is_approval: boolean;
  approval_kind: string | null;
  require_note_on_reject: boolean;
  creates_revision: boolean;
  required_fields: string[];
  required_files: string[];
  /** Whether opening this step fires a notification at all. */
  notify: boolean;
  /** Channels this step permits (AND-ed with each recipient's role settings). */
  notify_channels: NotifyChannel[];
}

/** Defensive read of metadata.steps — metadata is jsonb, so nothing is guaranteed. */
function stepsOf(metadata: unknown): StepDef[] {
  const raw = (metadata as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw)) return [];
  const out: StepDef[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key : '';
    if (!key) continue;
    out.push({
      key,
      label_ar: typeof r.label_ar === 'string' ? r.label_ar : '',
      label_en: typeof r.label_en === 'string' ? r.label_en : '',
      role_key: typeof r.role_key === 'string' ? r.role_key : '',
      due_days: typeof r.due_days === 'number' && Number.isFinite(r.due_days) ? r.due_days : 2,
      is_approval: r.is_approval === true,
      approval_kind: typeof r.approval_kind === 'string' ? r.approval_kind : null,
      require_note_on_reject: r.require_note_on_reject === true,
      creates_revision: r.creates_revision === true,
      required_fields: Array.isArray(r.required_fields) ? (r.required_fields as unknown[]).map(String) : [],
      required_files: Array.isArray(r.required_files) ? (r.required_files as unknown[]).map(String) : [],
      // Absent on legacy rows → notify on, all channels (the original behavior).
      notify: r.notify !== false,
      notify_channels: 'notify_channels' in r ? channelsOf(r.notify_channels) : [...NOTIFY_CHANNELS],
    });
  }
  return out;
}

interface WorkflowDef {
  id: string;
  label_ar: string;
  label_en: string;
  is_active: boolean;
  steps: StepDef[];
  current_version_no: number;
  current_version_id: string | null;
}

/** Canonical role-path rows + the version table → the contract's WorkflowDef list. */
function assembleWorkflowDefs(wfRows: unknown[], verRows: unknown[]): WorkflowDef[] {
  const latest = new Map<string, { version_no: number; id: string }>();
  for (const v of verRows) {
    const r = v as { workflow_id: string; version_no: number; id: string };
    const cur = latest.get(r.workflow_id);
    if (!cur || r.version_no > cur.version_no) {
      latest.set(r.workflow_id, { version_no: r.version_no, id: r.id });
    }
  }
  return wfRows.map((w) => {
    const r = w as { id: string; label_ar: string; label_en: string; is_active: boolean; metadata: unknown };
    const v = latest.get(r.id);
    return {
      id: r.id,
      label_ar: r.label_ar,
      label_en: r.label_en,
      is_active: r.is_active,
      steps: stepsOf(r.metadata),
      current_version_no: v?.version_no ?? 0,
      current_version_id: v?.id ?? null,
    };
  });
}

/**
 * The caller's level per surface, mirroring wassell_mos_surface_level() exactly:
 * administrator / marketing_manager see everything; otherwise the MAX level
 * across held roles wins and absence of a row means hidden; a viewer (no
 * marketing role at all) gets a read floor on 'overview' alone. Computed here
 * from one surface_access read so bootstrap stays a single round trip.
 */
function computeSurfaces(held: string[], accessRows: unknown[]): Record<SurfaceKey, SurfaceLevel> {
  const rows = accessRows as Array<{
    surface_key: string;
    level: SurfaceLevel;
    roles: { key: string } | Array<{ key: string }> | null;
  }>;
  const rank: Record<SurfaceLevel, number> = { hidden: 0, read: 1, full: 2 };
  const seesAll = held.includes('administrator') || held.includes('marketing_manager');
  const out = {} as Record<SurfaceKey, SurfaceLevel>;
  for (const surface of SURFACES) {
    if (seesAll) {
      out[surface] = 'full';
      continue;
    }
    let best: SurfaceLevel | null = null;
    for (const r of rows) {
      if (r.surface_key !== surface) continue;
      const joined = Array.isArray(r.roles) ? r.roles[0] : r.roles;
      const key = joined?.key ?? '';
      if (!key.startsWith('mos_') || !held.includes(key.slice(4))) continue;
      if (best === null || rank[r.level] > rank[best]) best = r.level;
    }
    if (best !== null) {
      out[surface] = best;
    } else {
      out[surface] = held.includes('viewer') && surface === 'overview' ? 'read' : 'hidden';
    }
  }
  return out;
}

/**
 * workflow_role_tasks row → the task shape the SPA already renders. The stage
 * rail matches tasks to steps by id, so step_id carries the step KEY (steps are
 * synthesized with id = key below) — one stable identifier across versions.
 */
function mapRoleTask(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: t.id,
    content_id: t.subject_id,
    step_id: t.step_key ?? null,
    role: t.role_key,
    assignee_user_id: t.assignee_user_id ?? null,
    status: t.status,
    result: t.result ?? null,
    note: t.note ?? null,
    round: t.round,
    opened_at: t.opened_at,
    due_at: t.due_at ?? null,
    closed_at: t.closed_at ?? null,
    // Who closed it + what a rejection targeted — screen 08's «اعتمده ريان · …»
    // meta line and screen 38's revision chips both read these.
    closed_by_user_id: t.closed_by_user_id ?? null,
    revision_targets: Array.isArray(t.revision_targets) ? t.revision_targets : [],
  };
}

/* ------------------------------------------------------------------ */
/* manual tasks — hand-assigned work, alongside the workflow queue     */
/* ------------------------------------------------------------------ */

/** Today in Asia/Riyadh, as `YYYY-MM-DD`. Occurrence dates are Riyadh-local. */
function riyadhToday(): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the date literal Postgres wants.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
}

/**
 * Validate a repeat rule from the browser into the column set `mos_task_series`
 * expects. Every rejection is explicit: a rule that silently never fires is
 * worse than a refused save, so an empty weekday list or a missing month day is
 * an error here rather than a CHECK violation the user cannot read.
 */
function validateRepeat(
  raw: Record<string, unknown>,
): { value: Record<string, unknown> } | { error: string } {
  const freq = str(raw.freq);
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') {
    return { error: 'repeat.freq must be daily, weekly or monthly' };
  }
  const interval = numOrNull(raw.interval_n) ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
    return { error: 'repeat.interval_n must be a whole number between 1 and 52' };
  }

  // Postgres DOW: 0 = Sunday … 6 = Saturday.
  let byweekday: number[] = [];
  if (freq === 'weekly') {
    byweekday = Array.isArray(raw.byweekday)
      ? [...new Set((raw.byweekday as unknown[])
          .map((d) => numOrNull(d))
          .filter((d): d is number => d !== null && Number.isInteger(d) && d >= 0 && d <= 6))]
        .sort((a, b) => a - b)
      : [];
    if (byweekday.length === 0) return { error: 'a weekly repeat needs at least one weekday' };
  }

  let bymonthday: number | null = null;
  if (freq === 'monthly') {
    bymonthday = numOrNull(raw.bymonthday);
    if (bymonthday === null || !Number.isInteger(bymonthday) || bymonthday < 1 || bymonthday > 31) {
      return { error: 'a monthly repeat needs a day of the month between 1 and 31' };
    }
  }

  const dueTime = str(raw.due_time) ?? '12:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) {
    return { error: 'repeat.due_time must be HH:MM' };
  }
  const startsOn = str(raw.starts_on) ?? riyadhToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) return { error: 'repeat.starts_on must be YYYY-MM-DD' };
  const endsOn = str(raw.ends_on);
  if (endsOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) {
    return { error: 'repeat.ends_on must be YYYY-MM-DD' };
  }
  if (endsOn !== null && endsOn < startsOn) return { error: 'repeat.ends_on is before starts_on' };

  return {
    value: {
      freq,
      interval_n: interval,
      byweekday,
      bymonthday,
      due_time: dueTime,
      starts_on: startsOn,
      ends_on: endsOn,
      is_active: true,
    },
  };
}

/**
 * Tell someone a task was put in their queue by a person.
 *
 * Its own event key (`manual_task_assigned`), NOT the workflow's `task_assigned`:
 * the two differ in what muting them should mean. Silencing "a previous stage
 * approved and your turn began" is a reasonable thing for a busy role to want;
 * silencing "your manager just handed you something" is not the same decision,
 * and the workflow event's own subtitle would become a lie if it carried both.
 *
 * Self-assignment is silent — you do not need to be told what you just wrote
 * down. Channels are left to the role grid (in-app always lands; push/WhatsApp
 * per the matrix), the same posture as every non-step caller here.
 */
async function notifyTaskAssigned(
  sb: SupabaseClient,
  t: {
    assignee: string;
    actor: string | null;
    title: string;
    dueAt: string | null;
    repeating: boolean;
  },
): Promise<void> {
  if (!t.assignee || t.assignee === t.actor) return;

  // The assigner's name makes the notification answerable — «من أسندها؟» is the
  // first thing anyone asks. A failed lookup degrades to no name, never to no
  // notification.
  let byAr = '';
  let byEn = '';
  if (t.actor) {
    const who = await sb.from('users').select('name_ar, name_en, email')
      .eq('id', t.actor).maybeSingle();
    if (who.error) {
      console.error('[marketing-os] assigner name lookup failed', who.error.code, who.error.message);
    } else if (who.data) {
      const u = who.data as { name_ar: string | null; name_en: string | null; email: string | null };
      byAr = u.name_ar ?? u.name_en ?? u.email ?? '';
      byEn = u.name_en ?? u.name_ar ?? u.email ?? '';
    }
  }

  const whenAr = t.repeating
    ? ' — مهمة متكررة'
    : t.dueAt
      ? ` — الاستحقاق ${new Date(t.dueAt).toLocaleDateString('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long' })}`
      : '';
  const whenEn = t.repeating
    ? ' — a repeating task'
    : t.dueAt
      ? ` — due ${new Date(t.dueAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long' })}`
      : '';

  await emitNotify(sb, {
    event: 'manual_task_assigned',
    users: [t.assignee],
    titleAr: byAr ? `أسند إليك ${byAr} مهمة` : 'أُسندت إليك مهمة',
    titleEn: byEn ? `${byEn} assigned you a task` : 'A task was assigned to you',
    bodyAr: `«${t.title}»${whenAr}`,
    bodyEn: `“${t.title}”${whenEn}`,
    url: '/m/my-work',
  });
}

/**
 * @mention notifications on a comment. Each tagged person gets a
 * `mentioned_in_comment` inbox row (seeded ON for every role in 2026-08-01_04,
 * so the dashboard bell always shows it) deep-linking to the commented subject.
 *
 * The claimed ids are re-validated against active users before we notify —
 * never trust the client's mention list to interrupt arbitrary accounts. The
 * author is dropped: mentioning yourself is a no-op. A read failure degrades to
 * no notification, never to a failed comment write.
 */
async function notifyCommentMentions(
  sb: SupabaseClient,
  a: {
    mentionIds: string[];
    authorId: string | null;
    contentId: string | null;
    campaignId: string | null;
    bodyText: string;
  },
): Promise<void> {
  const ids = a.mentionIds.filter((id) => id !== a.authorId);
  if (ids.length === 0) return;

  // Only real, active accounts may be tagged.
  const usersRes = await sb.from('users').select('id').eq('is_active', true).in('id', ids);
  if (usersRes.error) {
    console.error('[marketing-os] mention validation failed', usersRes.error.code, usersRes.error.message);
    return;
  }
  const valid = ((usersRes.data ?? []) as Array<{ id: string }>).map((u) => u.id);
  if (valid.length === 0) return;

  // The tagger's name answers «من ذكرني؟». A failed lookup degrades to no name.
  let byAr = '';
  let byEn = '';
  if (a.authorId) {
    const who = await sb.from('users').select('name_ar, name_en, email').eq('id', a.authorId).maybeSingle();
    if (!who.error && who.data) {
      const u = who.data as { name_ar: string | null; name_en: string | null; email: string | null };
      byAr = u.name_ar ?? u.name_en ?? u.email ?? '';
      byEn = u.name_en ?? u.name_ar ?? u.email ?? '';
    }
  }

  // The subject label + deep link. Content → «V-004 · العنوان»; campaign → its name.
  let subjectAr = '';
  let subjectEn = '';
  let url: string | null = null;
  if (a.contentId) {
    const c = await sb.from('mos_content').select('ref, title').eq('id', a.contentId).maybeSingle();
    if (!c.error && c.data) {
      const row = c.data as { ref: string | null; title: string | null };
      const label = [row.ref, row.title].filter((x): x is string => !!x && x.trim() !== '').join(' · ');
      subjectAr = label;
      subjectEn = label;
    }
    url = `/m/content/${a.contentId}`;
  } else if (a.campaignId) {
    const c = await sb.from('mos_campaigns').select('name').eq('id', a.campaignId).maybeSingle();
    if (!c.error && c.data) {
      const row = c.data as { name: string | null };
      subjectAr = row.name ?? '';
      subjectEn = row.name ?? '';
    }
    url = `/m/campaigns/${a.campaignId}`;
  }

  // A short excerpt of the comment gives the notification its own context.
  const excerpt = a.bodyText.length > 140 ? `${a.bodyText.slice(0, 140)}…` : a.bodyText;

  await emitNotify(sb, {
    event: 'mentioned_in_comment',
    users: valid,
    titleAr: byAr ? `ذكرك ${byAr} في تعليق` : 'ذُكِرتَ في تعليق',
    titleEn: byEn ? `${byEn} mentioned you in a comment` : 'You were mentioned in a comment',
    bodyAr: subjectAr ? `على «${subjectAr}» — ${excerpt}` : excerpt,
    bodyEn: subjectEn ? `on “${subjectEn}” — ${excerpt}` : excerpt,
    url,
  });
}

/**
 * Read the manual-task queue. Generation runs FIRST — `mos_task_series_materialize`
 * is idempotent and bounded, and pg_cron is not enabled on this project, so the
 * read is what turns a repeat rule into rows.
 */
async function listManualTasks(
  sb: SupabaseClient,
  opts: {
    scope: 'mine' | 'team' | 'created';
    meUserId: string | null;
    includeDone?: boolean;
    campaignId?: string | null;
    contentId?: string | null;
    goalId?: string | null;
    projectId?: string | null;
  },
): Promise<{ rows: unknown[] } | { fail: Response }> {
  const mat = await sb.rpc('mos_task_series_materialize');
  const mf = dbFail(mat.error);
  if (mf) return { fail: mf };

  let q = sb.from('mos_manual_tasks').select('*');
  if (opts.scope === 'mine') {
    // No profile resolved → an empty queue, not everyone else's work.
    if (!opts.meUserId) return { rows: [] };
    q = q.eq('assignee_user_id', opts.meUserId);
  } else if (opts.scope === 'created') {
    if (!opts.meUserId) return { rows: [] };
    q = q.eq('created_by_user_id', opts.meUserId);
  }
  if (!opts.includeDone) q = q.eq('status', 'open');
  if (opts.campaignId) q = q.eq('campaign_id', opts.campaignId);
  if (opts.contentId) q = q.eq('content_id', opts.contentId);
  if (opts.goalId) q = q.eq('goal_id', opts.goalId);
  if (opts.projectId) q = q.eq('project_id', opts.projectId);

  const rows = await q.order('due_at', { ascending: true, nullsFirst: false }).limit(300);
  const f = dbFail(rows.error);
  if (f) return { fail: f };
  return { rows: rows.data ?? [] };
}

/**
 * The pinned path each listed subject is following: its open task's step key +
 * the pinned workflow version's steps. Screens 02 («القادم إليك») and 35 (the
 * creative/process approval split) both read steps from the PINNED version,
 * never from the workflow's current definition — the item keeps following the
 * path it started on.
 */
async function loadPinnedStepMeta(
  sb: SupabaseClient,
  subjectIds: string[],
): Promise<
  | { bySubject: Map<string, { steps: StepDef[]; currentStepKey: string | null }> }
  | { fail: Response }
> {
  const bySubject = new Map<string, { steps: StepDef[]; currentStepKey: string | null }>();
  if (subjectIds.length === 0) return { bySubject };

  const taskRes = await sb.from('workflow_role_tasks')
    .select('subject_id, step_key, workflow_version_id')
    .eq('subject_table', 'mos_content')
    .in('subject_id', subjectIds)
    .eq('status', 'open');
  if (taskRes.error) {
    const fail = dbFail(taskRes.error);
    if (fail) return { fail };
    return { bySubject };
  }
  const tasks = (taskRes.data ?? []) as Array<{
    subject_id: string; step_key: string | null; workflow_version_id: string | null;
  }>;
  const versionIds = Array.from(new Set(
    tasks.map((t) => t.workflow_version_id).filter((v): v is string => typeof v === 'string' && v !== ''),
  ));
  const stepsByVersion = new Map<string, StepDef[]>();
  if (versionIds.length > 0) {
    const verRes = await sb.from('workflow_versions').select('id, definition').in('id', versionIds);
    if (verRes.error) {
      const fail = dbFail(verRes.error);
      if (fail) return { fail };
      return { bySubject };
    }
    for (const v of verRes.data ?? []) {
      const row = v as { id: string; definition: unknown };
      const metadata = (row.definition as { metadata?: unknown } | null)?.metadata;
      stepsByVersion.set(row.id, stepsOf(metadata));
    }
  }
  for (const t of tasks) {
    bySubject.set(t.subject_id, {
      steps: (t.workflow_version_id ? stepsByVersion.get(t.workflow_version_id) : undefined) ?? [],
      currentStepKey: t.step_key,
    });
  }
  return { bySubject };
}

/** StepDefs → the step shape the SPA renders (id = key, position = 1-based index). */
function mapStepDefs(workflowId: string, steps: StepDef[]): Array<Record<string, unknown>> {
  return steps.map((s, i) => ({
    id: s.key,
    workflow_id: workflowId,
    position: i + 1,
    key: s.key,
    label_ar: s.label_ar,
    label_en: s.label_en,
    role: s.role_key,
    due_days: s.due_days,
    is_approval: s.is_approval,
    approval_kind: s.approval_kind,
    required_fields: s.required_fields,
    required_files: s.required_files,
    require_note_on_reject: s.require_note_on_reject,
    creates_revision: s.creates_revision,
    notify: s.notify,
    notify_channels: s.notify_channels,
  }));
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'workflow';

/** roles.key 'mos_*' → the stripped key the API contract speaks in. */
const stripMosPrefix = (key: string): string => key.replace(/^mos_/, '');

/** Finite number or null — for budget/spend inputs that may arrive as null. */
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/* ------------------------------------------------------------------ */
/* notifications — every emission enters through notify_emit, and a    */
/* notification failure must NEVER fail the business write that        */
/* triggered it, so the one call site below swallows exactly that      */
/* failure (console.error'd) and nothing else.                         */
/* ------------------------------------------------------------------ */

interface NotifyArgs {
  event: string;
  /** UNPREFIXED role keys ('writer'); the helper adds the mos_ prefix. */
  roles?: string[];
  users?: string[];
  titleAr: string;
  titleEn?: string | null;
  bodyAr?: string | null;
  bodyEn?: string | null;
  url?: string | null;
  /**
   * Per-step channel mask (subset of inapp/push/whatsapp). When present it is
   * AND-ed with each recipient's role grid inside notify_emit — a step narrows,
   * never widens. Omit for the role-grid-only behavior every other caller wants.
   */
  channels?: NotifyChannel[];
}

async function emitNotify(sb: SupabaseClient, args: NotifyArgs): Promise<void> {
  try {
    const params: Record<string, unknown> = {
      p_workspace: 'marketing',
      p_event: args.event,
      // roles.key is mos_*-prefixed; the API speaks in stripped keys.
      p_role_keys: (args.roles ?? []).map((r) => (r.startsWith('mos_') ? r : `mos_${r}`)),
      p_user_ids: args.users ?? [],
      p_title_ar: args.titleAr,
      p_title_en: args.titleEn ?? null,
      p_body_ar: args.bodyAr ?? null,
      p_body_en: args.bodyEn ?? null,
      p_url: args.url ?? null,
    };
    // Only the per-step path passes a mask. Omitting p_channels entirely (rather
    // than sending null) lets the four role-grid-only callers resolve against
    // either notify_emit signature, so they never depend on this feature's
    // migration having landed first; the mask itself needs the 10-arg version.
    if (args.channels) params.p_channels = args.channels;
    const { error } = await sb.rpc('notify_emit', params);
    // A failed emission is logged, never thrown: the content advance, the
    // shoot delivery or the campaign save that triggered it already committed,
    // and a lost notification must not read as a lost business write.
    if (error) {
      console.error('[marketing-os] notify_emit failed', args.event, error.code, error.message, error.details);
    }
  } catch (e) {
    // Same posture for a transport-level throw: loud in the logs, invisible
    // to the business write.
    console.error('[marketing-os] notify_emit threw', args.event, e);
  }
}

/**
 * Resolve a pinned step's notification gate + permitted channels from the
 * version the task was opened under. workflow_versions.definition snapshots
 * metadata.steps, so an in-flight record keeps the notification rules it
 * started with. Anything missing (legacy version, deleted step, read error) →
 * notify on, all channels: the engine's original behavior.
 */
async function resolveStepNotify(
  sb: SupabaseClient,
  versionId: string | null,
  stepKey: string | null,
): Promise<{ notify: boolean; channels: NotifyChannel[] }> {
  const fallback = { notify: true, channels: [...NOTIFY_CHANNELS] as NotifyChannel[] };
  if (!versionId || !stepKey) return fallback;
  const res = await sb.from('workflow_versions')
    .select('definition').eq('id', versionId).maybeSingle();
  if (res.error) {
    console.error('[marketing-os] step-notify version read failed', res.error.code, res.error.message);
    return fallback;
  }
  if (!res.data) return fallback;
  const def = (res.data as { definition?: unknown }).definition;
  const step = stepsOf((def as { metadata?: unknown } | null)?.metadata).find((s) => s.key === stepKey);
  return step ? { notify: step.notify, channels: step.notify_channels } : fallback;
}

/**
 * The caller's surface levels — the same read bootstrap makes, extracted so
 * search can filter result types by exactly the same rules (hidden surface →
 * the type is absent from results AND chips).
 */
async function callerSurfaces(
  sb: SupabaseClient,
): Promise<{ surfaces: Record<SurfaceKey, SurfaceLevel> } | { fail: Response }> {
  const [rolesRes, accessRes] = await Promise.all([
    sb.rpc('wassell_mos_roles'),
    sb.from('surface_access').select('surface_key, level, roles!inner(key)'),
  ]);
  const fail = dbFail(rolesRes.error) ?? dbFail(accessRes.error);
  if (fail) return { fail };
  const held = (rolesRes.data as string[] | null) ?? [];
  return { surfaces: computeSurfaces(held, accessRes.data ?? []) };
}

/** The role × event × channel matrix rows, in the contract's shape. */
async function fetchNotificationRuleRows(
  sb: SupabaseClient,
): Promise<{ rules: Array<Record<string, unknown>> } | { fail: Response }> {
  const res = await sb.from('notification_rules').select('event, channel, timing, enabled, roles!inner(key)');
  const fail = dbFail(res.error);
  if (fail) return { fail };
  const rows = ((res.data ?? []) as unknown as Array<{
    event: string;
    channel: string;
    timing: string;
    enabled: boolean;
    roles: { key: string } | Array<{ key: string }> | null;
  }>)
    .map((r) => {
      const joined = Array.isArray(r.roles) ? r.roles[0] : r.roles;
      const key = joined?.key ?? '';
      return {
        role_key: key.startsWith('mos_') ? stripMosPrefix(key) : '',
        event: r.event,
        channel: r.channel,
        timing: r.timing,
        enabled: r.enabled,
      };
    })
    .filter((r) => r.role_key !== '');
  // Deterministic order: role, then event, then channel.
  rows.sort((a, b) =>
    a.role_key.localeCompare(b.role_key)
    || a.event.localeCompare(b.event)
    || a.channel.localeCompare(b.channel));
  return { rules: rows };
}

/**
 * The campaign the UI renders = the view's aggregates + the base table's
 * brief/signature columns (mos_campaign_v predates them and a view change is
 * out of scope for this endpoint, so the two reads are merged here).
 */
async function readCampaignMerged(
  sb: SupabaseClient,
  id: string,
): Promise<{ row: Record<string, unknown> | null; error: PostgrestError | null }> {
  const [viewRes, baseRes] = await Promise.all([
    sb.from('mos_campaign_v').select('*').eq('id', id).maybeSingle(),
    sb.from('mos_campaigns').select('*').eq('id', id).maybeSingle(),
  ]);
  const error = viewRes.error ?? baseRes.error;
  if (error) return { row: null, error };
  if (!viewRes.data && !baseRes.data) return { row: null, error: null };
  const row: Record<string, unknown> = {
    ...((viewRes.data ?? {}) as Record<string, unknown>),
    ...((baseRes.data ?? {}) as Record<string, unknown>),
  };
  // Attach the chosen audience's LIVE details (the name is snapshotted on the
  // campaign; the long details are resolved fresh so an edit to the record shows
  // through). Non-fatal: a failed lookup just omits details, it never sinks the read.
  const audienceId = str(row.audience_id);
  if (audienceId) {
    const aud = await sb.from('mos_audiences').select('details').eq('id', audienceId).maybeSingle();
    if (aud.error) {
      console.error('[marketing-os] audience details read failed', aud.error.code, aud.error.message);
    } else if (aud.data) {
      row.audience_details = (aud.data as { details: string | null }).details;
    }
  }
  return { row, error: null };
}

/**
 * Read the goal ids currently linked to a campaign. Returns an error Response
 * (via dbFail) on failure so callers can bail the same way they do elsewhere.
 */
async function readCampaignGoalIds(
  sb: SupabaseClient,
  campaignId: string,
): Promise<{ ids: string[]; error: Response | null }> {
  const res = await sb.from('mos_campaign_goals').select('goal_id').eq('campaign_id', campaignId);
  const f = dbFail(res.error);
  if (f) return { ids: [], error: f };
  const ids = ((res.data ?? []) as Array<{ goal_id: string }>).map((r) => r.goal_id);
  return { ids, error: null };
}

/**
 * Replace a campaign's goal links with exactly `goalIds` (delete-all then
 * insert), so a save is idempotent and order-independent. Returns an error
 * Response on failure, or null on success.
 */
async function syncCampaignGoals(
  sb: SupabaseClient,
  campaignId: string,
  goalIds: string[],
): Promise<Response | null> {
  const del = await sb.from('mos_campaign_goals').delete().eq('campaign_id', campaignId);
  const df = dbFail(del.error);
  if (df) return df;
  if (goalIds.length === 0) return null;
  const rows = goalIds.map((goal_id) => ({ campaign_id: campaignId, goal_id }));
  const ins = await sb.from('mos_campaign_goals').insert(rows);
  return dbFail(ins.error);
}

/**
 * Append to the campaign's «ما الذي تغيّر» ledger. The ledger row is part of
 * the audit trail, but the business write it describes has already committed
 * by the time this runs — so an insert failure is console.error-ed and the
 * action continues rather than falsely reporting the write itself failed.
 */
async function logCampaignEvent(
  sb: SupabaseClient,
  args: {
    campaignId: string;
    kind: string;
    summaryAr: string;
    summaryEn?: string | null;
    detail?: Record<string, unknown>;
    actorUserId: string | null;
  },
): Promise<void> {
  const ins = await sb.from('mos_campaign_events').insert({
    campaign_id: args.campaignId,
    kind: args.kind,
    summary_ar: args.summaryAr,
    summary_en: args.summaryEn ?? null,
    detail: (args.detail ?? {}) as Record<string, unknown>,
    actor_user_id: args.actorUserId,
  });
  if (ins.error) {
    console.error('[marketing-os] campaign event insert failed', args.kind,
      ins.error.code, ins.error.message, ins.error.details);
  }
}

/** mos_settings.signature_threshold → the amount above which a budget needs a signature. */
async function readSignatureThreshold(sb: SupabaseClient): Promise<number> {
  const res = await sb.from('mos_settings').select('value').eq('key', 'signature_threshold').maybeSingle();
  if (res.error) {
    console.error('[marketing-os] signature_threshold read failed', res.error.code, res.error.message);
    return 50_000;
  }
  const amount = ((res.data as { value?: { amount?: unknown } } | null)?.value?.amount);
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : 50_000;
}

/**
 * Open a freshly created content item on its workflow's first step: pin the
 * current version, then insert the open task. Shared by content_create and
 * assets_bulk's create_content so the two never drift.
 */
async function openFirstTask(
  sb: SupabaseClient,
  contentId: string,
  workflowId: string,
): Promise<Response | null> {
  const [wfRes, verRes] = await Promise.all([
    sb.from('workflows').select('id, metadata').eq('id', workflowId).maybeSingle(),
    sb.from('workflow_versions').select('id, version_no')
      .eq('workflow_id', workflowId)
      .order('version_no', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const wfFail = dbFail(wfRes.error) ?? dbFail(verRes.error);
  if (wfFail) return wfFail;

  const first = stepsOf((wfRes.data as { metadata?: unknown } | null)?.metadata ?? null)[0];
  const versionId = (verRes.data as { id: string } | null)?.id ?? null;
  if (!first) return null;
  if (versionId) {
    const pin = await sb.from('mos_content')
      .update({ workflow_version_id: versionId }).eq('id', contentId);
    const pinFail = dbFail(pin.error);
    if (pinFail) return pinFail;
  }
  // Definer-rights RPC: screen 33 grants creation to Writer/Ops, but the task
  // INSERT policy requires 'assign' — opening the first task on create is an
  // engine concern, not a caller privilege (migration 08).
  const taskRes = await sb.rpc('workflow_role_path_start', {
    p_subject_table: 'mos_content',
    p_subject_id: contentId,
  });
  return dbFail(taskRes.error);
}

/**
 * Search excerpt: the matching text with the first case-insensitive hit
 * wrapped in <mark>. indexOf (not RegExp) so any term — including regex
 * metacharacters — is matched literally.
 */
function buildExcerpt(text: string, term: string): string | null {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + term.length + 80);
  return (start > 0 ? '…' : '')
    + text.slice(start, idx)
    + '<mark>'
    + text.slice(idx, idx + term.length)
    + '</mark>'
    + text.slice(idx + term.length, end)
    + (end < text.length ? '…' : '');
}

/** First field (in priority order) containing the term → the hit's reason + excerpt. */
function matchIn(
  fields: Array<[reason: string, text: string | null | undefined]>,
  term: string,
): { match_reason: string; excerpt: string } {
  for (const [reason, text] of fields) {
    if (!text) continue;
    const excerpt = buildExcerpt(text, term);
    if (excerpt !== null) return { match_reason: reason, excerpt };
  }
  // Unreachable when the caller only feeds rows the DB matched, but a row
  // that slipped through reports the title rather than crashing the search.
  return { match_reason: 'title', excerpt: '' };
}

/* ------------------------------------------------------------------ */
/* handler                                                            */
/* ------------------------------------------------------------------ */
/* Script writer v2 — recipes, drafts, scene protection, references   */
/*                                                                     */
/* Generated scripts are DRAFTS (mos_script_drafts). Nothing reaches   */
/* mos_scenes without a human Apply, and Apply never removes a scene   */
/* the protection RPC (mos_scene_protection) marks as protected.       */
/* ------------------------------------------------------------------ */

/** Recipes are DATA (mos_script_recipes). This is only the fallback key. */
const DEFAULT_RECIPE = 'walkthrough';

/** Draft statuses a human has not yet decided on. */
const PENDING_DRAFT: string[] = ['draft', 'needs_attention'];

interface RecipeRow {
  key: string;
  label_ar: string;
  label_en: string;
  default_duration_sec: number;
  scene_count_hint: number;
  version: number;
}

async function loadActiveRecipes(sb: SupabaseClient): Promise<{ rows: RecipeRow[]; fail: Response | null }> {
  const res = await sb.from('mos_script_recipes')
    .select('key, label_ar, label_en, default_duration_sec, scene_count_hint, version')
    .eq('is_active', true)
    .order('key', { ascending: true });
  return { rows: (res.data ?? []) as RecipeRow[], fail: dbFail(res.error) };
}

/**
 * Deterministic recipe recommendation from the SQL-built brief. No model call:
 * a sales/leads objective with a campaign offer → offer; awareness → launch
 * (launch/teaser content) or product_explainer; anything else → walkthrough.
 * Never recommends a recipe that is not active.
 */
function recommendRecipe(brief: Record<string, unknown>, active: Set<string>): string {
  const objective = (typeof brief.objective === 'string' ? brief.objective : '').toLowerCase();
  const campaign = (brief.campaign ?? null) as { offer?: unknown; kind?: unknown } | null;
  const hasOffer = typeof campaign?.offer === 'string' && campaign.offer.trim() !== '';
  const typeKey = typeof brief.content_type_key === 'string' ? brief.content_type_key : '';
  const kind = typeof campaign?.kind === 'string' ? campaign.kind : '';
  let pick = DEFAULT_RECIPE;
  if (/sales|lead|conversion/.test(objective) && hasOffer) pick = 'offer';
  else if (/awareness|reach/.test(objective)) {
    pick = /launch|teaser/i.test(`${typeKey} ${kind}`) ? 'launch' : 'product_explainer';
  }
  if (!active.has(pick)) pick = active.has(DEFAULT_RECIPE) ? DEFAULT_RECIPE : ([...active][0] ?? DEFAULT_RECIPE);
  return pick;
}

/** One scene of a draft (`mos_script_drafts.scenes[]`, the worker's DraftScene). */
interface DraftSceneRow {
  order?: number;
  purpose?: string;
  duration_sec?: number;
  start_sec?: number;
  end_sec?: number;
  voiceover?: string;
  on_screen_text?: string;
  visual?: string;
  visual_intent?: Record<string, unknown>;
  angle?: string;
  fact_refs?: string[];
  learned_from?: string[];
  asset_requirement?: string;
  production_note?: string;
  warnings?: string[];
}

interface DraftRow {
  id: string;
  job_id: string | null;
  content_id: string;
  recipe: string;
  brief: Record<string, unknown>;
  facts: Record<string, unknown>;
  exemplars: unknown[];
  plan: Record<string, unknown>;
  scenes: DraftSceneRow[];
  hooks: string[];
  chosen_hook: number | null;
  review: Record<string, unknown>;
  status: 'draft' | 'needs_attention' | 'applied' | 'discarded';
  applied_scene_ids: string[];
  approved_by: string | null;
  applied_at: string | null;
  roles: Record<string, unknown>;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

async function loadDraft(svc: SupabaseClient, draftId: string): Promise<{ draft: DraftRow | null; fail: Response | null }> {
  const res = await svc.from('mos_script_drafts').select('*').eq('id', draftId).maybeSingle();
  return { draft: (res.data as DraftRow | null) ?? null, fail: dbFail(res.error) };
}

/** The one pending (draft | needs_attention) draft of a content item, if any. */
async function loadPendingDraft(svc: SupabaseClient, contentId: string): Promise<{ draft: DraftRow | null; fail: Response | null }> {
  const res = await svc.from('mos_script_drafts').select('*')
    .eq('content_id', contentId).in('status', PENDING_DRAFT)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return { draft: (res.data as DraftRow | null) ?? null, fail: dbFail(res.error) };
}

const draftScenes = (draft: DraftRow): DraftSceneRow[] => (Array.isArray(draft.scenes) ? draft.scenes : []);
const draftHooks = (draft: DraftRow): string[] =>
  (Array.isArray(draft.hooks) ? draft.hooks : []).filter((h): h is string => typeof h === 'string');

interface ProtectionRow {
  scene_id: string;
  position: number;
  visual: string | null;
  replaceable: boolean;
  reason: 'edited' | 'shoot_linked' | 'production_used' | 'manual' | null;
}

/** mos_scene_protection — computed in SQL so preview and apply can never disagree. */
async function sceneProtection(svc: SupabaseClient, contentId: string): Promise<{ rows: ProtectionRow[]; fail: Response | null }> {
  const res = await svc.rpc('mos_scene_protection', { p_content_id: contentId });
  return { rows: (res.data ?? []) as ProtectionRow[], fail: dbFail(res.error) };
}

/**
 * DraftScene.asset_requirement → mos_scenes.footage_status. A machine never
 * marks footage as 'have': footage/image/graphic/animation seed the shoot
 * backlog ('missing'), templates are 'template', and a scene that needs no
 * asset at all is 'to_make' (produced in the edit, not shot).
 */
function footageStatusFor(requirement: unknown): 'missing' | 'template' | 'to_make' {
  if (requirement === 'template') return 'template';
  if (requirement === 'none') return 'to_make';
  return 'missing';
}

/** The visual-system query for a scene: structured intent first, then the writer's shot description. */
function sceneQueryText(visual: string | null | undefined, intent: Record<string, unknown> | null | undefined): string {
  const keys = ['shot_size', 'subject', 'setting', 'interior_exterior', 'motion', 'graphic_kind', 'mood'];
  const parts = keys
    .map((k) => intent?.[k])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '' && v !== 'none');
  return [parts.join(' '), (visual ?? '').trim()].filter(Boolean).join(' — ').slice(0, 600);
}

/** What production must create when no Wassel asset matches a scene. */
function gapFor(
  intent: Record<string, unknown> | null,
  assetRequirement: string | null,
  visual: string | null,
): { kind: 'footage' | 'image' | 'design' | 'animation'; spec: string } {
  const graphic = typeof intent?.graphic_kind === 'string' ? intent.graphic_kind : 'none';
  let kind: 'footage' | 'image' | 'design' | 'animation' = 'footage';
  if (assetRequirement === 'animation' || graphic === 'animated_map' || graphic === 'motion_graphic') kind = 'animation';
  else if (assetRequirement === 'graphic' || assetRequirement === 'template' || graphic !== 'none' || intent?.interior_exterior === 'graphic') kind = 'design';
  else if (assetRequirement === 'image') kind = 'image';
  return { kind, spec: visual ?? '' };
}

/** Where a set of scene references hangs: a real scene, or a draft scene by index. */
interface ReferenceTarget {
  scene_id: string | null;
  draft_id: string | null;
  draft_scene_index: number | null;
}

/** Scope a mos_scene_references query to one target. */
function scopeReferences<Q extends { eq(column: string, value: unknown): Q }>(q: Q, t: ReferenceTarget): Q {
  return t.scene_id
    ? q.eq('scene_id', t.scene_id)
    : q.eq('draft_id', t.draft_id).eq('draft_scene_index', t.draft_scene_index);
}

/* ------------------------------------------------------------------ */

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');

  return withAuth(req, async (user) => {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'body must be JSON');
    }

    const sb = callerClient(req);
    const action = str(body.action);
    if (!action) return jsonError(400, 'action is required');

    switch (action) {
      /* -------------------------------------------------------- */
      /* bootstrap — me (roles, surfaces), workflows, settings in  */
      /* one call on page load                                     */
      /* -------------------------------------------------------- */
      case 'bootstrap': {
        const [rolesRes, capsRes, accessRes, typesRes, wfRes, verRes, settingsRes, accountsRes, appUserId] =
          await Promise.all([
            sb.rpc('wassell_mos_roles'),
            // Capability truth from the DB (role_capabilities), so the client
            // stops hand-mirroring the matrix. One source, no drift.
            sb.rpc('wassell_mos_capabilities'),
            sb.from('surface_access').select('surface_key, level, roles!inner(key)'),
            sb.from('mos_content_types')
              .select('id, key, label_ar, label_en, prefix, workflow_id, field_schema, sort_order')
              .is('archived_at', null)
              .eq('is_active', true)
              .order('sort_order', { ascending: true }),
            sb.from('workflows')
              .select('id, label_ar, label_en, is_active, metadata')
              .eq('kind', 'role_path')
              .order('label_en', { ascending: true }),
            sb.from('workflow_versions').select('id, workflow_id, version_no'),
            sb.from('mos_settings').select('key, value'),
            sb.from('mos_platform_accounts').select('*').is('archived_at', null)
              .order('sort_order', { ascending: true }),
            resolveAppUserId(sb, user.userId),
          ]);
        const fail = dbFail(rolesRes.error) ?? dbFail(capsRes.error) ?? dbFail(accessRes.error)
          ?? dbFail(typesRes.error) ?? dbFail(wfRes.error) ?? dbFail(verRes.error)
          ?? dbFail(settingsRes.error) ?? dbFail(accountsRes.error);
        if (fail) return fail;

        const held = (rolesRes.data as string[] | null) ?? [];
        const capabilities = (capsRes.data as string[] | null) ?? [];
        // Display-affecting only (contract convention): the header chooses which
        // of the caller's HELD roles the UI leads with; it never authorizes.
        const requestedRole = (req.headers.get('x-mos-active-role') ?? '').trim();
        const activeRole = held.includes(requestedRole) ? requestedRole : (held[0] ?? 'viewer');

        // Admin-only "view as": preview ANOTHER role's interface to test what
        // they see. Gated on the caller actually being a platform admin — a
        // non-admin sending the header is ignored. This only shapes what the UI
        // SHOWS (roles/capabilities/surfaces); RLS still runs under the admin's
        // real identity, so it previews the VIEW, not data-level access.
        const isAdmin = held.includes('administrator');
        const PREVIEWABLE = new Set(['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage', 'viewer']);
        const rawPreview = (req.headers.get('x-mos-preview-role') ?? '').trim();
        const previewRole = isAdmin && PREVIEWABLE.has(rawPreview) ? rawPreview : null;

        let effRoles: string[] = held;
        let effCaps: string[] = capabilities;
        let effActive = activeRole;
        let effSurfaces = computeSurfaces(held, accessRes.data ?? []);

        if (previewRole) {
          effRoles = [previewRole];
          effActive = previewRole;
          effSurfaces = computeSurfaces([previewRole], accessRes.data ?? []);
          if (previewRole === 'viewer') {
            effCaps = [];
          } else {
            // A previewed role's capabilities are exactly its role_capabilities
            // rows (the marketing_manager row already carries the full registry,
            // matching wassell_mos_can's manager special-case). RLS on
            // role_capabilities is read-open to any authenticated user.
            const capQ = await sb.from('role_capabilities')
              .select('capability, roles!inner(key)')
              .eq('roles.key', `mos_${previewRole}`);
            const capFail = dbFail(capQ.error);
            if (capFail) return capFail;
            effCaps = ((capQ.data ?? []) as Array<{ capability: string }>).map((r) => r.capability);
          }
        }

        const settings: Record<string, unknown> = {};
        for (const row of (settingsRes.data ?? []) as Array<{ key: string; value: unknown }>) {
          settings[row.key] = row.value;
        }

        return jsonOk({
          me: {
            user_id: appUserId,
            roles: effRoles,
            capabilities: effCaps,
            active_role: effActive,
            surfaces: effSurfaces,
            // Notification prefs arrive with the notifications migration (…_04),
            // which is not in this build yet.
            prefs: {},
            is_admin: isAdmin,
            preview_role: previewRole,
          },
          content_types: typesRes.data ?? [],
          workflows: assembleWorkflowDefs(wfRes.data ?? [], verRes.data ?? []),
          platform_accounts: accountsRes.data ?? [],
          settings,
          unread_notifications: 0,
        });
      }

      /* -------------------------------------------------------- */
      /* Content list                                              */
      /* -------------------------------------------------------- */
      case 'content_list': {
        let q = sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).is('archived_at', null);

        const typeKey = str(body.content_type_key);
        const statusKey = str(body.status_key);
        const projectId = str(body.project_id);
        const role = str(body.role);
        const search = str(body.q);
        if (typeKey) q = q.eq('content_type_key', typeKey);
        if (statusKey) q = q.eq('status_key', statusKey);
        // Match membership, not just the primary project — an item filtered by a
        // project it's tagged with (even as a secondary) should surface.
        if (projectId) q = q.contains('project_ids', [projectId]);
        if (role) q = q.eq('owner_role', role);
        if (search) q = q.ilike('title', `%${search}%`);

        // Items with a due date first, soonest first; undated fall to the end.
        const { data, error } = await q
          .order('due_at', { ascending: true, nullsFirst: false })
          .limit(cap(body.limit, 200, 500));

        const fail = dbFail(error);
        if (fail) return fail;

        // Screen 03's campaign column and platform filter need two facts the
        // content view does not carry: the campaign's NAME and which platforms
        // each item is headed to. Both are one batched lookup, never per-row.
        const rows = (data ?? []) as unknown as Row[];
        const ids = rows.map((r) => r.id as string);
        const campaignIds = Array.from(new Set(
          rows.map((r) => r.campaign_id as string | null).filter((c): c is string => Boolean(c)),
        ));
        const camps = campaignIds.length > 0
          ? await sb.from('mos_campaigns').select('id, name').in('id', campaignIds)
          : { data: [] as Array<{ id: string; name: string }>, error: null };
        const pubs = ids.length > 0
          ? await sb.from('mos_publications').select('content_id, platform').in('content_id', ids)
          : { data: [] as Array<{ content_id: string; platform: string }>, error: null };
        // A preview THUMBNAIL for each item — its FINAL cut's image, falling back
        // to a source/reference asset that actually has a thumb. Powers the
        // reference chooser (screen 08) and any thumbnailed content list. Two
        // batched reads, never per-row; RLS applies, so an unreadable asset is
        // simply omitted (the item shows a typed placeholder instead).
        const links = ids.length > 0
          ? await sb.from('mos_asset_links').select('content_id, asset_id, role').in('content_id', ids)
          : { data: [] as Array<{ content_id: string; asset_id: string; role: string }>, error: null };
        const fail2 = dbFail(camps.error) ?? dbFail(pubs.error) ?? dbFail(links.error);
        if (fail2) return fail2;

        const assetIds = Array.from(new Set((links.data ?? []).map((l) => l.asset_id)));
        const assetsRes = assetIds.length > 0
          // file_id rides along so a CANONICAL asset (private bytes, no public
          // url) can still produce a preview: the client signs it via
          // useAssetUrls. Without it the tile would silently fall back to the
          // typed placeholder for every new upload.
          ? await sb.from('mos_assets').select('id, thumb_url, kind, url, file_id').in('id', assetIds)
          : { data: [] as Array<{ id: string; thumb_url: string | null; kind: string | null; url: string | null; file_id: string | null }>, error: null };
        const fail3 = dbFail(assetsRes.error);
        if (fail3) return fail3;

        const campName = new Map((camps.data ?? []).map((c) => [c.id, c.name]));
        const plats = new Map<string, string[]>();
        for (const p of pubs.data ?? []) {
          const arr = plats.get(p.content_id) ?? [];
          if (p.platform && !arr.includes(p.platform)) arr.push(p.platform);
          plats.set(p.content_id, arr);
        }

        // Choose one preview asset per content: an asset WITH a thumb wins over
        // one without, and among those the final cut wins over source/reference.
        const assetById = new Map((assetsRes.data ?? []).map((a) => [a.id, a]));
        const ROLE_RANK: Record<string, number> = { final: 0, source: 1, reference: 2 };
        const bestByContent = new Map<string, {
          thumb: string | null; kind: string | null; fileId: string | null; score: number;
        }>();
        for (const l of links.data ?? []) {
          const a = assetById.get(l.asset_id);
          if (!a) continue;
          // A canonical asset has no stored thumb but IS renderable via its
          // file_id, so it must not score as "no preview" behind a thumbless one.
          const renderable = a.thumb_url || a.file_id;
          const score = (renderable ? 0 : 100) + (ROLE_RANK[l.role] ?? 3);
          const cur = bestByContent.get(l.content_id);
          if (!cur || score < cur.score) {
            bestByContent.set(l.content_id, {
              thumb: a.thumb_url ?? null, kind: a.kind ?? null, fileId: a.file_id ?? null, score,
            });
          }
        }

        return jsonOk({
          content: rows.map((r) => {
            const best = bestByContent.get(r.id as string);
            return {
              ...r,
              campaign_name: r.campaign_id ? campName.get(r.campaign_id as string) ?? null : null,
              platforms: plats.get(r.id as string) ?? [],
              thumb_url: best?.thumb ?? null,
              preview_file_id: best?.fileId ?? null,
              preview_kind: best?.kind ?? null,
            };
          }),
        });
      }

      /* -------------------------------------------------------- */
      /* Workspace — one round trip                                */
      /* -------------------------------------------------------- */
      case 'content_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const [item, tasks, scenes] = await Promise.all([
          sb.from('mos_content_v').select('*').eq('id', id).maybeSingle(),
          sb.from('workflow_role_tasks').select('*')
            .eq('subject_table', 'mos_content').eq('subject_id', id)
            .order('opened_at', { ascending: true }),
          sb.from('mos_scenes').select('*').eq('content_id', id)
            .order('position', { ascending: true }),
        ]);

        const fail = dbFail(item.error) ?? dbFail(tasks.error) ?? dbFail(scenes.error);
        if (fail) return fail;
        if (!item.data) return jsonError(404, 'content item not found');

        // Steps for the stage rail come from the item's PINNED version, so an
        // edit to the path never relabels a step under running work. An item
        // with no pin (never started on a path) falls back to the live row.
        const row = item.data as Row;
        const workflowId = (row.workflow_id as string | null) ?? null;
        const pinnedVersionId = (row.workflow_version_id as string | null) ?? null;
        let steps: Array<Record<string, unknown>> = [];
        if (pinnedVersionId) {
          const verRes = await sb.from('workflow_versions')
            .select('definition').eq('id', pinnedVersionId).maybeSingle();
          const verFail = dbFail(verRes.error);
          if (verFail) return verFail;
          const def = (verRes.data as { definition?: { metadata?: unknown } } | null)?.definition;
          steps = mapStepDefs(workflowId ?? '', stepsOf(def?.metadata ?? null));
        } else if (workflowId) {
          const wfRes = await sb.from('workflows')
            .select('metadata').eq('id', workflowId).maybeSingle();
          const wfFail = dbFail(wfRes.error);
          if (wfFail) return wfFail;
          steps = mapStepDefs(workflowId, stepsOf((wfRes.data as { metadata?: unknown } | null)?.metadata ?? null));
        }

        return jsonOk({
          item: item.data,
          tasks: (tasks.data ?? []).map((t) => mapRoleTask(t as Record<string, unknown>)),
          scenes: scenes.data ?? [],
          steps,
        });
      }

      /* -------------------------------------------------------- */
      /* Create — and open the first task in the same request      */
      /* -------------------------------------------------------- */
      case 'content_create': {
        const title = str(body.title);
        const typeKey = str(body.content_type_key);
        if (!title) return jsonError(400, 'title is required');
        if (!typeKey) return jsonError(400, 'content_type_key is required');

        const typeRes = await sb.from('mos_content_types')
          .select('id, workflow_id').eq('key', typeKey).maybeSingle();
        const typeFail = dbFail(typeRes.error);
        if (typeFail) return typeFail;
        if (!typeRes.data) return jsonError(400, 'unknown content type');
        const type = typeRes.data as { id: string; workflow_id: string | null };

        const appUserId = await resolveAppUserId(sb, user.userId);
        const insert: Record<string, unknown> = {};
        for (const k of CONTENT_EDITABLE) {
          if (Object.prototype.hasOwnProperty.call(body, k)) insert[k] = body[k];
        }
        // Derive the content's project from its campaign when none was given — a
        // content piece under a campaign inherits that campaign's project(s), so
        // the writer never re-picks it and the two can never disagree.
        {
          const given = insert.project_ids;
          const hasProjects = Array.isArray(given) && given.length > 0;
          const campId = str(insert.campaign_id);
          if (!hasProjects && campId) {
            const camp = await sb.from('mos_campaigns').select('project_ids').eq('id', campId).maybeSingle();
            const cf = dbFail(camp.error); if (cf) return cf;
            const cpids = (camp.data as { project_ids?: string[] } | null)?.project_ids;
            if (Array.isArray(cpids) && cpids.length > 0) insert.project_ids = cpids;
          }
        }
        applyProjectIds(insert);
        insert.title = title;
        insert.content_type_id = type.id;
        insert.workflow_id = type.workflow_id;
        insert.created_by_user_id = appUserId;

        const created = await sb.from('mos_content').insert(insert).select('id, ref').maybeSingle();
        const createFail = dbFail(created.error);
        if (createFail) return createFail;
        if (!created.data) return jsonError(500, 'insert returned no row');
        const row = created.data as unknown as Row;

        // Open the workflow's first step immediately. Content with no task would
        // read as 'draft' and sit in nobody's queue — the exact failure mode this
        // module exists to remove. The item is PINNED to the current version, so
        // a later edit to the path never moves running work.
        if (type.workflow_id) {
          const openFail = await openFirstTask(sb, row.id, type.workflow_id);
          if (openFail) return openFail;
        }

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', row.id).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;
        return jsonOk({ item: full.data });
      }

      /* -------------------------------------------------------- */
      /* Allow-listed patch                                        */
      /* -------------------------------------------------------- */
      case 'content_update': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const raw = (body.patch ?? {}) as Record<string, unknown>;

        const patch: Record<string, unknown> = {};
        for (const k of CONTENT_EDITABLE) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        applyProjectIds(patch);
        if (Object.keys(patch).length === 0) return jsonError(400, 'no editable fields in patch');

        const upd = await sb.from('mos_content').update(patch).eq('id', id).select('id').maybeSingle();
        const updFail = dbFail(upd.error);
        if (updFail) return updFail;
        if (!upd.data) return jsonError(404, 'content item not found');

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', id).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;
        return jsonOk({ item: full.data });
      }

      case 'content_delete': {
        // Hard-delete one or many content items. Children cascade or SET NULL
        // (scenes/versions/comments/publications/asset_links cascade; executions/
        // ads/tasks unlink). Gated on delete_records for a clean 403; the DELETE
        // RLS policy on mos_content re-enforces it per row (scope-limited).
        const gate = await requireCap(sb, 'delete_records'); if (gate) return gate;
        const single = str(body.id);
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const all = single ? [single, ...ids] : ids;
        if (all.length === 0) return jsonError(400, 'id or ids is required');
        const del = await sb.from('mos_content').delete().in('id', all).select('id');
        const delFail = dbFail(del.error);
        if (delFail) return delFail;
        return jsonOk({ deleted: (del.data ?? []).length });
      }

      /* -------------------------------------------------------- */
      /* Advance the role path — the transition itself is SQL      */
      /* -------------------------------------------------------- */
      case 'task_complete': {
        // The SPA hands the open task's id; the engine advances by subject.
        // Both are accepted and resolved to the same open row.
        const taskId = str(body.task_id);
        let contentId = str(body.content_id);
        const result = str(body.result);
        const note = str(body.note);
        const targets = Array.isArray(body.targets)
          ? (body.targets as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        if (!taskId && !contentId) return jsonError(400, 'task_id or content_id is required');
        if (!result || !['submitted', 'approved', 'changes_requested'].includes(result)) {
          return jsonError(400, 'result must be submitted, approved or changes_requested');
        }
        // Mirrors the CHECK constraint so the user gets a sentence, not a violation.
        if (result === 'changes_requested' && !note) {
          return new Response(
            JSON.stringify({
              error: 'Requesting changes requires a note explaining what to change.',
              error_ar: 'طلب التعديلات يستلزم ملاحظة توضّح المطلوب.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        let tq = sb.from('workflow_role_tasks')
          .select('id, subject_id, round')
          .eq('subject_table', 'mos_content')
          .eq('status', 'open');
        tq = taskId ? tq.eq('id', taskId) : tq.eq('subject_id', contentId ?? '');
        const cur = await tq.maybeSingle();
        const curFail = dbFail(cur.error);
        if (curFail) return curFail;
        if (!cur.data) return jsonError(404, 'no open task found');
        const openTask = cur.data as unknown as { id: string; subject_id: string; round: number };
        contentId = openTask.subject_id;

        // Submitted work gets a frozen snapshot of the round BEFORE the engine
        // moves on — a resubmit of the same round overwrites its own snapshot.
        if (result === 'submitted') {
          const [contentRes, scenesRes, appUserId] = await Promise.all([
            sb.from('mos_content').select('data').eq('id', contentId).maybeSingle(),
            sb.from('mos_scenes').select('*').eq('content_id', contentId)
              .order('position', { ascending: true }),
            resolveAppUserId(sb, user.userId),
          ]);
          const snapReadFail = dbFail(contentRes.error) ?? dbFail(scenesRes.error);
          if (snapReadFail) return snapReadFail;
          const snap = await sb.from('mos_content_versions').upsert(
            {
              content_id: contentId,
              round: openTask.round,
              data: ((contentRes.data as { data?: unknown } | null)?.data ?? {}) as Record<string, unknown>,
              scenes: scenesRes.data ?? [],
              submitted_by_user_id: appUserId,
            },
            { onConflict: 'content_id,round' },
          );
          const snapFail = dbFail(snap.error);
          if (snapFail) return snapFail;
        }

        const adv = await sb.rpc('workflow_advance_role_path', {
          p_subject_table: 'mos_content',
          p_subject_id: contentId,
          p_result: result,
          p_note: note,
          p_targets: targets,
        });
        const advFail = dbFail(adv.error);
        if (advFail) return advFail;
        const payload = (adv.data ?? {}) as {
          closed_task_id: string;
          opened_task_id: string | null;
          next_step_key: string | null;
          round: number;
          done: boolean;
        };

        // A rejection's reason lives on the version it rejected. The engine has
        // already incremented the round, so the rejected version is round - 1.
        if (result === 'changes_requested' && payload.round - 1 >= 1) {
          const rn = await sb.from('mos_content_versions')
            .update({ rejected_note: note })
            .eq('content_id', contentId)
            .eq('round', payload.round - 1);
          const rnFail = dbFail(rn.error);
          if (rnFail) return rnFail;
        }

        // Approval is the bridge to a publishable file: the material the item's
        // owner submitted for approval (mos_content.approval_asset_id) becomes an
        // approved ('final') link, which is what the Publishing tab reads. The RPC
        // is SECURITY DEFINER (the approver may not hold asset-write RLS) and
        // promotes the EXPLICIT selection only — a no-op when nothing was marked.
        if (result === 'approved') {
          const promo = await sb.rpc('mos_promote_approval_asset', { p_content_id: contentId });
          const promoFail = dbFail(promo.error);
          if (promoFail) return promoFail;
        }

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', contentId).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;

        // Notifications: the engine has opened the NEXT task — its role is who
        // gets interrupted. A rejection reopens the revision step (the writer),
        // a submit/approval opens the following step. done=true opens nothing.
        if (payload.opened_task_id) {
          const nt = await sb.from('workflow_role_tasks')
            .select('role_key, assignee_user_id, workflow_version_id, step_key')
            .eq('id', payload.opened_task_id).maybeSingle();
          if (nt.error) {
            console.error('[marketing-os] next-task read for notification failed',
              nt.error.code, nt.error.message);
          } else if (nt.data) {
            const next = nt.data as {
              role_key: string;
              assignee_user_id: string | null;
              workflow_version_id: string | null;
              step_key: string | null;
            };
            // The step that just became active decides whether — and on which
            // channels — its owner is interrupted. `notify: false` opens the
            // task silently (it still shows in «my work»); otherwise the step's
            // permitted channels are AND-ed with the recipient's role grid.
            const notifyCfg = await resolveStepNotify(sb, next.workflow_version_id, next.step_key);
            if (notifyCfg.notify) {
              const itemTitle = ((full.data as { title?: string } | null)?.title) ?? '';
              await emitNotify(sb, result === 'changes_requested'
                ? {
                    event: 'changes_requested',
                    roles: [next.role_key],
                    users: next.assignee_user_id ? [next.assignee_user_id] : [],
                    titleAr: 'أُعيد العمل بتعديلات',
                    titleEn: 'Changes requested',
                    bodyAr: `«${itemTitle}» — ${note ?? ''}`,
                    bodyEn: itemTitle,
                    url: `/m/content/${contentId}?tab=tasks`,
                    channels: notifyCfg.channels,
                  }
                : {
                    event: 'task_assigned',
                    roles: [next.role_key],
                    users: next.assignee_user_id ? [next.assignee_user_id] : [],
                    titleAr: 'فُتحت لك مهمة',
                    titleEn: 'A task was assigned to you',
                    bodyAr: `«${itemTitle}» بانتظار خطوتك.`,
                    bodyEn: itemTitle,
                    url: `/m/content/${contentId}?tab=tasks`,
                    channels: notifyCfg.channels,
                  });
            }
          }
        }

        return jsonOk({ item: full.data, ...payload });
      }

      /* -------------------------------------------------------- */
      /* Hand an open task to a specific person                    */
      /* -------------------------------------------------------- */
      case 'task_transfer': {
        const taskId = str(body.task_id);
        const toUserId = str(body.to_user_id);
        if (!taskId || !toUserId) return jsonError(400, 'task_id and to_user_id are required');
        const res = await sb.rpc('workflow_role_task_transfer', {
          p_task_id: taskId,
          p_to_user_id: toUserId,
        });
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* «تأجيل / تقديم» (s35) — move an open task's due date.     */
      /* RLS gates the write to roles holding 'assign' (manager /  */
      /* ops supervisor / admin), the same gate as transfer.       */
      /* -------------------------------------------------------- */
      case 'task_update': {
        const taskId = str(body.task_id);
        const dueAt = str(body.due_at);
        if (!taskId) return jsonError(400, 'task_id is required');
        if (!dueAt) return jsonError(400, 'due_at is required');
        if (Number.isNaN(new Date(dueAt).getTime())) return jsonError(400, 'due_at must be a date');
        const upd = await sb.from('workflow_role_tasks')
          .update({ due_at: new Date(dueAt).toISOString() })
          .eq('id', taskId).eq('subject_table', 'mos_content').eq('status', 'open')
          .select('id').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'open task not found');
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Round snapshots — the review-comparison trail             */
      /* -------------------------------------------------------- */
      case 'content_versions': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const res = await sb.from('mos_content_versions').select('*')
          .eq('content_id', contentId)
          .order('round', { ascending: true });
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ versions: res.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Notifications — the in-app inbox. RLS scopes every read   */
      /* to the caller's own rows; writes happen via notify_emit.  */
      /* -------------------------------------------------------- */
      case 'notifications_list': {
        const unreadOnly = body.unread_only === true;
        // Filters before transforms: .order()/.limit() return the transform
        // builder, which no longer accepts .is().
        const base = sb.from('notifications')
          .select('id, kind, title_ar, title_en, body_ar, body_en, url, read_at, created_at');
        const filtered = unreadOnly ? base.is('read_at', null) : base;
        const [rows, unread] = await Promise.all([
          filtered.order('created_at', { ascending: false }).limit(cap(body.limit, 50, 200)),
          sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
        ]);
        const f = dbFail(rows.error) ?? dbFail(unread.error);
        if (f) return f;
        return jsonOk({ rows: rows.data ?? [], unread: unread.count ?? 0 });
      }

      case 'notifications_read': {
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
          : [];
        if (ids.length === 0) return jsonError(400, 'ids must be a non-empty array');
        if (ids.length > 500) return jsonError(400, 'at most 500 ids per call');
        // The RPC re-checks ownership definer-side; ids belonging to someone
        // else are no-ops, not leaks.
        const res = await sb.rpc('mark_notifications_read', { p_ids: ids });
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* The role × event × channel matrix (screen 43)             */
      /* -------------------------------------------------------- */
      case 'notification_rules': {
        const res = await fetchNotificationRuleRows(sb);
        if ('fail' in res) return res.fail;
        return jsonOk({ rules: res.rules });
      }

      case 'notification_rule_set': {
        const roleKey = str(body.role_key);
        const event = str(body.event);
        const channel = str(body.channel);
        const timing = str(body.timing);
        if (!roleKey || !(MOS_ROLE_KEYS as readonly string[]).includes(roleKey)) {
          return jsonError(400, 'unknown role');
        }
        if (!event) return jsonError(400, 'event is required');
        if (!channel || !['inapp', 'push', 'whatsapp'].includes(channel)) {
          return jsonError(400, 'channel must be inapp, push or whatsapp');
        }
        if (typeof body.enabled !== 'boolean') return jsonError(400, 'enabled must be a boolean');
        if (timing && !['immediate', 'digest'].includes(timing)) {
          return jsonError(400, 'timing must be immediate or digest');
        }
        const roleRes = await sb.from('roles').select('id').eq('key', `mos_${roleKey}`).maybeSingle();
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        if (!roleRes.data) return jsonError(400, 'unknown role');

        const row: Record<string, unknown> = {
          role_id: (roleRes.data as { id: string }).id,
          event,
          channel,
          enabled: body.enabled,
        };
        if (timing) row.timing = timing;
        const up = await sb.from('notification_rules').upsert(row, { onConflict: 'role_id,event,channel' });
        const f = dbFail(up.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Per-user delivery prefs — whatsapp on/off, digest hour,   */
      /* quiet hours. Absent row = defaults, so this is an upsert. */
      /* -------------------------------------------------------- */
      case 'notification_prefs_save': {
        const appUserId = await resolveAppUserId(sb, user.userId);
        if (!appUserId) return jsonError(400, 'no app user for this account');

        const hour = (v: unknown, name: string): number | null | Response => {
          if (v === undefined || v === null) return null;
          if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23) return v;
          return jsonError(400, `${name} must be an integer between 0 and 23`);
        };
        const digestHour = hour(body.digest_hour, 'digest_hour');
        if (digestHour instanceof Response) return digestHour;
        const quietFrom = hour(body.quiet_from, 'quiet_from');
        if (quietFrom instanceof Response) return quietFrom;
        const quietTo = hour(body.quiet_to, 'quiet_to');
        if (quietTo instanceof Response) return quietTo;

        const patch: Record<string, unknown> = { user_id: appUserId };
        if (typeof body.whatsapp_enabled === 'boolean') patch.whatsapp_enabled = body.whatsapp_enabled;
        if (digestHour !== null) patch.digest_hour = digestHour;
        if (Object.prototype.hasOwnProperty.call(body, 'quiet_from')) patch.quiet_from = quietFrom;
        if (Object.prototype.hasOwnProperty.call(body, 'quiet_to')) patch.quiet_to = quietTo;

        const up = await sb.from('notification_prefs')
          .upsert(patch, { onConflict: 'user_id' }).select('*').maybeSingle();
        const f = dbFail(up.error);
        if (f) return f;
        return jsonOk({ prefs: up.data });
      }

      /* -------------------------------------------------------- */
      /* «تذكير» (s01/s35) — a manual nudge to whoever holds the   */
      /* item's open task.                                         */
      /* -------------------------------------------------------- */
      case 'remind': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');

        const [taskRes, itemRes] = await Promise.all([
          sb.from('workflow_role_tasks')
            .select('id, role_key, assignee_user_id')
            .eq('subject_table', 'mos_content')
            .eq('subject_id', contentId)
            .eq('status', 'open')
            .maybeSingle(),
          sb.from('mos_content_v').select('id, title').eq('id', contentId).maybeSingle(),
        ]);
        const f = dbFail(taskRes.error) ?? dbFail(itemRes.error);
        if (f) return f;
        const task = taskRes.data as { role_key: string; assignee_user_id: string | null } | null;
        if (!task) {
          return new Response(
            JSON.stringify({
              error: 'This item has no open task.',
              error_ar: 'لا توجد مهمة مفتوحة لهذا العنصر.',
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const title = ((itemRes.data as { title?: string } | null)?.title) ?? '';

        await emitNotify(sb, {
          event: 'manual_reminder',
          roles: [task.role_key],
          users: task.assignee_user_id ? [task.assignee_user_id] : [],
          titleAr: 'تذكير بمهمة',
          titleEn: 'Task reminder',
          bodyAr: `تذكير: «${title}» بانتظار خطوتك.`,
          bodyEn: `Reminder: "${title}" is waiting on your step.`,
          url: `/m/content/${contentId}?tab=tasks`,
        });
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Script writer v2 — recipes, brief, jobs, drafts           */
      /* -------------------------------------------------------- */
      case 'script_recipes': {
        // The five recipes are rows in mos_script_recipes (read-only single
        // source). RLS already allows authenticated SELECT; the cap gate keeps
        // the surface consistent with the rest of the writer actions.
        const gate = await requireCap(sb, 'read');
        if (gate) return gate;
        const { rows, fail } = await loadActiveRecipes(sb);
        if (fail) return fail;
        return jsonOk({ recipes: rows });
      }

      case 'script_brief': {
        // The brief is built ONCE in SQL (mos_script_brief) so the API and the
        // worker can never disagree about what the writer is told.
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const gate = await requireCap(sb, 'read');
        if (gate) return gate;
        const [briefRes, recipes] = await Promise.all([
          sb.rpc('mos_script_brief', { p_content_id: contentId }),
          loadActiveRecipes(sb),
        ]);
        const fail = dbFail(briefRes.error) ?? recipes.fail;
        if (fail) return fail;
        const brief = (briefRes.data ?? null) as Record<string, unknown> | null;
        if (!brief) return jsonError(404, 'content item not found');
        const warnings: string[] = [];
        if (brief.multi_project_warning === true) warnings.push('multi_project');
        if (!brief.project_id) warnings.push('no_project');
        const active = new Set(recipes.rows.map((r) => r.key));
        return jsonOk({ brief, recommended_recipe: recommendRecipe(brief, active), warnings });
      }

      case 'write_video_script': {
        // ENQUEUE a background job. The Fly worker's script lane runs the
        // staged pipeline (facts → retrieve → write → validate → review) OFF
        // the HTTP request (the rule shared with decks/image/documents — never
        // hold a request open for the AI call) and writes a DRAFT — never
        // mos_scenes. Returns fast with the job row; the SPA drives a progress
        // bar from script_job_status and reviews the draft when it lands.
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const gate = await requireCap(sb, 'write_content');
        if (gate) return gate;
        const recipe = str(body.recipe) ?? DEFAULT_RECIPE;
        const recipes = await loadActiveRecipes(sb);
        if (recipes.fail) return recipes.fail;
        const recipeRow = recipes.rows.find((r) => r.key === recipe);
        if (!recipeRow) return jsonError(400, `unknown or inactive recipe: ${recipe}`);
        // Fail fast before burning a worker slot: the item must exist and have a
        // project linked (project facts are the ONLY source of claims).
        const c = await sb.from('mos_content_v').select('id, project_id').eq('id', contentId).maybeSingle();
        const cf = dbFail(c.error); if (cf) return cf;
        if (!c.data) return jsonError(404, 'content item not found');
        if (!(c.data as { project_id: string | null }).project_id) {
          return jsonError(400, 'link a project to this content first');
        }
        const svc = makeServiceClient('api:marketing-os:video-script');
        if (!svc) return jsonError(500, 'service unavailable');
        // A pending draft blocks a new generation unless the caller explicitly
        // regenerates, which discards it (the partial unique index allows one).
        const pending = await loadPendingDraft(svc, contentId);
        if (pending.fail) return pending.fail;
        if (pending.draft) {
          if (body.regenerate !== true) {
            return jsonOk({ error: 'draft_pending', draft_id: pending.draft.id }, 409);
          }
          const disc = await svc.from('mos_script_drafts')
            .update({ status: 'discarded', updated_at: new Date().toISOString() })
            .eq('id', pending.draft.id).in('status', PENDING_DRAFT);
          const df = dbFail(disc.error); if (df) return df;
        }
        // One active (queued|running) job per content item (partial unique
        // index). If one already runs, return it rather than fanning out a dup.
        const JOB_COLS = 'id, status, stage, recipe, draft_id, created_at';
        const existing = await svc.from('mos_script_jobs')
          .select(JOB_COLS)
          .eq('content_id', contentId).in('status', ['queued', 'running'])
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        const ef = dbFail(existing.error); if (ef) return ef;
        if (existing.data) return jsonOk({ job: existing.data });

        const durationSec = typeof body.duration_sec === 'number' && Number.isFinite(body.duration_sec)
          ? Math.min(180, Math.max(10, Math.round(body.duration_sec)))
          : recipeRow.default_duration_sec;
        const brief = {
          recipe,
          duration_sec: durationSec,
          audience: str(body.audience)?.slice(0, 500) ?? null,
          objection: str(body.objection)?.slice(0, 500) ?? null,
        };
        const requestedBy = await resolveAppUserId(sb, user.userId);
        const insert = await svc.from('mos_script_jobs')
          .insert({ content_id: contentId, recipe, requested_by: requestedBy, brief })
          .select(JOB_COLS).maybeSingle();
        if (insert.error) {
          // Lost the unique-index race with a concurrent enqueue — return the winner.
          const again = await svc.from('mos_script_jobs')
            .select(JOB_COLS)
            .eq('content_id', contentId).in('status', ['queued', 'running'])
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
          if (again.data) return jsonOk({ job: again.data });
          const f = dbFail(insert.error); if (f) return f;
        }
        wakeWorker();
        return jsonOk({ job: insert.data });
      }

      case 'script_job_status': {
        // Latest script job for a content item — drives the SPA's progress bar
        // (stage) and survives a reload / navigating away (the job lives in the DB).
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const gate = await requireCap(sb, 'read');
        if (gate) return gate;
        const svc = makeServiceClient('api:marketing-os:video-script');
        if (!svc) return jsonError(500, 'service unavailable');
        const j = await svc.from('mos_script_jobs')
          .select('id, status, stage, recipe, scene_count, error, error_kind, draft_id, cost_usd, created_at, started_at, finished_at')
          .eq('content_id', contentId)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        const jf = dbFail(j.error); if (jf) return jf;
        return jsonOk({ job: j.data ?? null });
      }

      case 'script_draft_get': {
        // Full draft row (scenes, hooks, review, facts, exemplars) — by id, or
        // the pending draft of a content item (null when there is none).
        const gate = await requireCap(sb, 'read');
        if (gate) return gate;
        const draftId = str(body.draft_id);
        const contentId = str(body.content_id);
        if (!draftId && !contentId) return jsonError(400, 'draft_id or content_id is required');
        const svc = makeServiceClient('api:marketing-os:video-script');
        if (!svc) return jsonError(500, 'service unavailable');
        if (draftId) {
          const { draft, fail } = await loadDraft(svc, draftId);
          if (fail) return fail;
          if (!draft) return jsonError(404, 'draft not found');
          return jsonOk({ draft });
        }
        const { draft, fail } = await loadPendingDraft(svc, contentId as string);
        if (fail) return fail;
        return jsonOk({ draft });
      }

      case 'script_draft_preview_apply': {
        // What Apply WOULD do: which current scenes go (replace mode only —
        // AI-written, untouched, not shoot-linked, not in production) and which
        // stay, with the reason. Same RPC Apply re-checks, so this is a promise.
        const draftId = str(body.draft_id);
        if (!draftId) return jsonError(400, 'draft_id is required');
        const mode = body.mode === 'replace' ? 'replace' : body.mode === 'append' ? 'append' : null;
        if (!mode) return jsonError(400, "mode must be 'append' or 'replace'");
        const gate = await requireCap(sb, 'read');
        if (gate) return gate;
        const svc = makeServiceClient('api:marketing-os:video-script');
        if (!svc) return jsonError(500, 'service unavailable');
        const { draft, fail } = await loadDraft(svc, draftId);
        if (fail) return fail;
        if (!draft) return jsonError(404, 'draft not found');
        const prot = await sceneProtection(svc, draft.content_id);
        if (prot.fail) return prot.fail;
        const replaceable = mode === 'replace'
          ? prot.rows.filter((r) => r.replaceable).map((r) => ({ id: r.scene_id, position: r.position, visual: r.visual }))
          : [];
        const protectedRows = prot.rows.filter((r) => !r.replaceable)
          .map((r) => ({ id: r.scene_id, position: r.position, reason: r.reason ?? 'manual' }));
        return jsonOk({
          mode, replaceable, protected: protectedRows,
          will_insert: draftScenes(draft).length, existing: prot.rows.length,
        });
      }

      case 'script_draft_apply': {
        // The ONLY path from a draft into mos_scenes. Protection is recomputed
        // server-side; replace mode must name exactly the current replaceable
        // set (409 protection_changed otherwise) so a stale preview can never
        // delete a scene someone edited in the meantime.
        const draftId = str(body.draft_id);
        if (!draftId) return jsonError(400, 'draft_id is required');
        const mode = body.mode === 'replace' ? 'replace' : body.mode === 'append' ? 'append' : null;
        if (!mode) return jsonError(400, "mode must be 'append' or 'replace'");
        const gate = await requireCap(sb, 'write_content');
        if (gate) return gate;
        const svc = makeServiceClient('api:marketing-os:video-script');
        if (!svc) return jsonError(500, 'service unavailable');
        const { draft, fail } = await loadDraft(svc, draftId);
        if (fail) return fail;
        if (!draft) return jsonError(404, 'draft not found');
        if (!PENDING_DRAFT.includes(draft.status)) {
          return jsonOk({ error: 'draft_not_pending', status: draft.status }, 409);
        }
        const scenes = draftScenes(draft);
        if (scenes.length === 0) return jsonError(400, 'draft has no scenes');

        // Validate the hook BEFORE touching anything.
        let chosenHook: number | null = draft.chosen_hook ?? null;
        let hookText: string | null = null;
        if (body.chosen_hook !== undefined && body.chosen_hook !== null) {
          const idx = body.chosen_hook;
          const hooks = draftHooks(draft);
          const picked = typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? hooks[idx] : undefined;
          if (typeof idx !== 'number' || picked === undefined) {
            return jsonError(400, 'chosen_hook is out of range');
          }
          chosenHook = idx;
          hookText = picked;
        }

        const prot = await sceneProtection(svc, draft.content_id);
        if (prot.fail) return prot.fail;
        const replaceableIds = mode === 'replace' ? prot.rows.filter((r) => r.replaceable).map((r) => r.scene_id) : [];
        if (mode === 'replace') {
          const confirm = Array.isArray(body.confirm_remove_ids)
            ? (body.confirm_remove_ids as unknown[]).filter((x): x is string => typeof x === 'string')
            : null;
          if (!confirm) return jsonError(400, 'confirm_remove_ids is required for replace');
          const want = new Set(replaceableIds);
          const got = new Set(confirm);
          const same = want.size === got.size && [...want].every((id) => got.has(id));
          if (!same) return jsonOk({ error: 'protection_changed', replaceable: replaceableIds }, 409);
        }

        // Claim the draft first (status flip guarded on pending) so two
        // concurrent Applies cannot both insert; on any later failure we put
        // the status back so the human can retry.
        const nowIso = new Date().toISOString();
        const approvedBy = await resolveAppUserId(sb, user.userId);
        const claim = await svc.from('mos_script_drafts')
          .update({ status: 'applied', approved_by: approvedBy, applied_at: nowIso, chosen_hook: chosenHook, updated_at: nowIso })
          .eq('id', draft.id).in('status', PENDING_DRAFT)
          .select('id').maybeSingle();
        const claimFail = dbFail(claim.error); if (claimFail) return claimFail;
        if (!claim.data) return jsonOk({ error: 'draft_not_pending', status: 'applied' }, 409);
        const revert = async (): Promise<void> => {
          const r = await svc.from('mos_script_drafts')
            .update({ status: draft.status, approved_by: draft.approved_by, applied_at: draft.applied_at, chosen_hook: draft.chosen_hook, updated_at: new Date().toISOString() })
            .eq('id', draft.id);
          if (r.error) console.error('[marketing-os] draft apply revert failed', draft.id, r.error.code, r.error.message);
        };

        if (replaceableIds.length > 0) {
          const del = await svc.from('mos_scenes').delete().in('id', replaceableIds).eq('content_id', draft.content_id);
          const delFail = dbFail(del.error);
          if (delFail) { await revert(); return delFail; }
        }
        const last = await svc.from('mos_scenes').select('position')
          .eq('content_id', draft.content_id).order('position', { ascending: false }).limit(1).maybeSingle();
        const lastFail = dbFail(last.error);
        if (lastFail) { await revert(); return lastFail; }
        let pos = (last.data as { position: number } | null)?.position ?? 0;
        const rows = scenes.map((s) => {
          pos += 1;
          return {
            content_id: draft.content_id,
            position: pos,
            visual: str(s.visual) ?? null,
            voiceover: str(s.voiceover) ?? null,
            on_screen_text: str(s.on_screen_text) ?? null,
            start_sec: typeof s.start_sec === 'number' ? s.start_sec : null,
            end_sec: typeof s.end_sec === 'number' ? s.end_sec : null,
            footage_status: footageStatusFor(s.asset_requirement),
            note: str(s.production_note) ?? null,
            source: 'ai',
            source_draft_id: draft.id,
            purpose: str(s.purpose) ?? null,
            visual_intent: s.visual_intent && typeof s.visual_intent === 'object' ? s.visual_intent : null,
            fact_refs: Array.isArray(s.fact_refs) ? s.fact_refs : [],
          };
        });
        const ins = await svc.from('mos_scenes').insert(rows).select('id, position');
        const insFail = dbFail(ins.error);
        if (insFail) { await revert(); return insFail; }
        const insertedIds = ((ins.data ?? []) as Array<{ id: string; position: number }>)
          .sort((a, b) => a.position - b.position).map((r) => r.id);

        // Draft-scene references (suggested before Apply) follow their scene.
        const carry = await Promise.all(insertedIds.map((sceneId, i) =>
          svc.from('mos_scene_references').update({ scene_id: sceneId, updated_at: nowIso })
            .eq('draft_id', draft.id).eq('draft_scene_index', i)));
        for (const r of carry) {
          if (r.error) console.error('[marketing-os] scene reference carry-over failed', draft.id, r.error.code, r.error.message);
        }

        if (hookText !== null) {
          const cur = await svc.from('mos_content').select('data').eq('id', draft.content_id).maybeSingle();
          const curFail = dbFail(cur.error); if (curFail) return curFail;
          const data = ((cur.data as { data?: Record<string, unknown> } | null)?.data ?? {});
          const upd = await svc.from('mos_content').update({ data: { ...data, hook: hookText } }).eq('id', draft.content_id);
          const updFail = dbFail(upd.error); if (updFail) return updFail;
        }

        const done = await svc.from('mos_script_drafts')
          .update({ applied_scene_ids: insertedIds, updated_at: new Date().toISOString() })
          .eq('id', draft.id).select('*').maybeSingle();
        const doneFail = dbFail(done.error); if (doneFail) return doneFail;

        const list = await svc.from('mos_scenes').select('*')
          .eq('content_id', draft.content_id).order('position', { ascending: true });
        const lf = dbFail(list.error); if (lf) return lf;
        return jsonOk({ scenes: list.data ?? [], removed: replaceableIds, draft: done.data });
      }

      case 'script_draft_discard': {
        const draftId = str(body.draft_id);
        if (!draftId) return jsonError(400, 'draft_id is required');
        const gate = await requireCap(sb, 'write_content');
        if (gate) return gate;
        const svc = makeServiceClient('api:marketing-os:video-script');
        if (!svc) return jsonError(500, 'service unavailable');
        const upd = await svc.from('mos_script_drafts')
          .update({ status: 'discarded', updated_at: new Date().toISOString() })
          .eq('id', draftId).in('status', PENDING_DRAFT)
          .select('*').maybeSingle();
        const uf = dbFail(upd.error); if (uf) return uf;
        if (upd.data) return jsonOk({ draft: upd.data });
        const { draft, fail } = await loadDraft(svc, draftId);
        if (fail) return fail;
        if (!draft) return jsonError(404, 'draft not found');
        return jsonOk({ error: 'draft_not_pending', status: draft.status }, 409);
      }

      case 'script_draft_feedback': {
        // Learning infrastructure: a rating/note plus the diff between what the
        // writer produced and what the humans kept/edited. Proposals only —
        // nothing here changes the writer automatically.
        const draftId = str(body.draft_id);
        if (!draftId) return jsonError(400, 'draft_id is required');
        const rating = typeof body.rating === 'number' && Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5
          ? body.rating : null;
        const note = str(body.note)?.slice(0, 4000) ?? null;
        if (rating === null && note === null) return jsonError(400, 'rating (1–5) or note is required');
        const gate = await requireCap(sb, 'write_content');
        if (gate) return gate;
        const svc = makeServiceClient('api:marketing-os:video-script');
        if (!svc) return jsonError(500, 'service unavailable');
        const { draft, fail } = await loadDraft(svc, draftId);
        if (fail) return fail;
        if (!draft) return jsonError(404, 'draft not found');
        const cur = await svc.from('mos_scenes')
          .select('id, position, visual, voiceover, on_screen_text, footage_status, manually_edited_at')
          .eq('source_draft_id', draft.id).order('position', { ascending: true });
        const cf = dbFail(cur.error); if (cf) return cf;
        type Cur = { id: string; visual: string | null; voiceover: string | null; on_screen_text: string | null; manually_edited_at: string | null };
        const current = (cur.data ?? []) as Cur[];
        const byId = new Map(current.map((s) => [s.id, s]));
        const applied = Array.isArray(draft.applied_scene_ids) ? draft.applied_scene_ids : [];
        const scenes = draftScenes(draft);
        const FIELDS = ['visual', 'voiceover', 'on_screen_text'] as const;
        const changed = applied.flatMap((id, i) => {
          const c = byId.get(id);
          const d = scenes[i];
          if (!c || !d) return [];
          const changes: Record<string, { draft: string; current: string }> = {};
          for (const f of FIELDS) {
            const a = (d[f] ?? '').trim();
            const b = (c[f] ?? '').trim();
            if (a !== b) changes[f] = { draft: a, current: b };
          }
          return Object.keys(changes).length ? [{ scene_id: id, index: i, edited_at: c.manually_edited_at, changes }] : [];
        });
        const diff = {
          applied: applied.length,
          present: current.length,
          removed: applied.filter((id) => !byId.has(id)),
          edited: changed,
        };
        const createdBy = await resolveAppUserId(sb, user.userId);
        const ins = await svc.from('mos_script_feedback')
          .insert({ draft_id: draft.id, content_id: draft.content_id, rating, note, diff, created_by: createdBy })
          .select('*').maybeSingle();
        const inf = dbFail(ins.error); if (inf) return inf;
        return jsonOk({ feedback: ins.data });
      }

      /* -------------------------------------------------------- */
      /* Scenes — the shoot list is derived from these             */
      /* -------------------------------------------------------- */
      case 'scene_save': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const raw = (body.scene ?? {}) as Record<string, unknown>;
        const id = str(raw.id);

        const patch: Record<string, unknown> = {};
        for (const k of ['position', 'start_sec', 'end_sec', 'visual', 'voiceover',
                         'on_screen_text', 'footage_status', 'note'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }

        if (id) {
          // A human change to the script text / production fields stamps the
          // scene as manually edited — from then on a draft Apply can never
          // replace it (mos_scene_protection reads manually_edited_at).
          const HUMAN_FIELDS = ['visual', 'voiceover', 'on_screen_text', 'note', 'footage_status'] as const;
          const cur = await sb.from('mos_scenes')
            .select('id, visual, voiceover, on_screen_text, note, footage_status')
            .eq('id', id).maybeSingle();
          const cf = dbFail(cur.error);
          if (cf) return cf;
          if (!cur.data) return jsonError(404, 'scene not found');
          const before = cur.data as Record<string, unknown>;
          const touched = HUMAN_FIELDS.some((k) =>
            Object.prototype.hasOwnProperty.call(patch, k) && (patch[k] ?? null) !== (before[k] ?? null));
          if (touched) {
            patch.manually_edited_at = new Date().toISOString();
            patch.last_edited_by = await resolveAppUserId(sb, user.userId);
          }
          const upd = await sb.from('mos_scenes').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'scene not found');
        } else {
          patch.content_id = contentId;
          patch.source = 'manual';
          if (patch.position === undefined) {
            const last = await sb.from('mos_scenes').select('position')
              .eq('content_id', contentId).order('position', { ascending: false }).limit(1).maybeSingle();
            const f = dbFail(last.error);
            if (f) return f;
            patch.position = ((last.data as { position: number } | null)?.position ?? 0) + 1;
          }
          const ins = await sb.from('mos_scenes').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }

        const list = await sb.from('mos_scenes').select('*')
          .eq('content_id', contentId).order('position', { ascending: true });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ scenes: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Scene references — competitor shots (reference only),     */
      /* Wassel assets (usable), or an explicit production gap     */
      /* -------------------------------------------------------- */
      case 'scene_references_suggest': {
        // Phase 4. Query = the scene's structured visual intent + shot text,
        // embedded by the Modal service, searched with mkt_cv_search (RRF in
        // SQL, diversity here). The visual system is OPTIONAL: when it is off,
        // unconfigured or unreachable this returns {unavailable:true} — never
        // a 500 — so the writer keeps working without it.
        const gate = await requireCap(sb, 'write_content');
        if (gate) return gate;
        const svc = makeServiceClient('api:marketing-os:scene-references');
        if (!svc) return jsonError(500, 'service unavailable');
        const k = cap(body.k, 6, 12);
        const sceneId = str(body.scene_id);
        const draftId = str(body.draft_id);
        const sceneIndex = typeof body.scene_index === 'number' && Number.isInteger(body.scene_index) && body.scene_index >= 0
          ? body.scene_index : null;

        let target: ReferenceTarget & {
          content_id: string; visual: string | null; visual_intent: Record<string, unknown> | null; asset_requirement: string | null;
        };
        if (sceneId) {
          const s = await svc.from('mos_scenes').select('id, content_id, visual, visual_intent').eq('id', sceneId).maybeSingle();
          const sf = dbFail(s.error); if (sf) return sf;
          if (!s.data) return jsonError(404, 'scene not found');
          const row = s.data as { id: string; content_id: string; visual: string | null; visual_intent: Record<string, unknown> | null };
          target = {
            scene_id: row.id, draft_id: null, draft_scene_index: null, content_id: row.content_id,
            visual: row.visual, visual_intent: row.visual_intent ?? null, asset_requirement: null,
          };
        } else if (draftId && sceneIndex !== null) {
          const { draft, fail } = await loadDraft(svc, draftId);
          if (fail) return fail;
          if (!draft) return jsonError(404, 'draft not found');
          const s = draftScenes(draft)[sceneIndex];
          if (!s) return jsonError(404, 'draft scene not found');
          target = {
            scene_id: null, draft_id: draft.id, draft_scene_index: sceneIndex, content_id: draft.content_id,
            visual: str(s.visual) ?? null, visual_intent: s.visual_intent ?? null, asset_requirement: str(s.asset_requirement) ?? null,
          };
        } else {
          return jsonError(400, 'scene_id, or draft_id + scene_index, is required');
        }

        const unavailable = (): Response => jsonOk({ unavailable: true, competitor: [], wassel_assets: [], gap: null });
        const enabled = await svc.rpc('mkt_cv_enabled');
        const enFail = dbFail(enabled.error); if (enFail) return enFail;
        if (enabled.data !== true) return unavailable();
        const queryText = sceneQueryText(target.visual, target.visual_intent);
        if (!queryText) return jsonError(400, 'the scene has no visual description to search with');
        const vec = await embedQuery(queryText);
        if (!vec) return unavailable();

        const search = (owner: 'competitor' | 'wassel', limit: number) => svc.rpc('mkt_cv_search', {
          p_qvec_image: vec.image_vec, p_qvec_text: vec.text_vec, p_query_text: queryText,
          p_filters: { owner }, p_mode: 'shot', p_limit: limit,
        });
        const [compRes, wasRes] = await Promise.all([search('competitor', 60), search('wassel', 30)]);
        const sFail = dbFail(compRes.error) ?? dbFail(wasRes.error); if (sFail) return sFail;
        const pick = (rows: CvSearchRow[], limit: number): CvSearchRow[] => diversify(rows, {
          videoKey: (r) => r.video_id, orgKey: (r) => r.organization_id,
          score: (r) => cvNum(r.score), perVideo: 1, perOrg: 3, lambda: 0.7, limit,
        });
        const competitor = pick((compRes.data ?? []) as CvSearchRow[], k);
        const wassel = pick((wasRes.data ?? []) as CvSearchRow[], k);

        // A Wassel-owned video is indexed FROM a mos_assets row — that is what
        // the reference points at (usable), not the shot.
        const assetByVideo = new Map<string, string | null>();
        if (wassel.length > 0) {
          const v = await svc.from('mkt_cv_videos').select('id, wassel_asset_id').in('id', wassel.map((r) => r.video_id));
          const vf = dbFail(v.error); if (vf) return vf;
          for (const row of (v.data ?? []) as Array<{ id: string; wassel_asset_id: string | null }>) assetByVideo.set(row.id, row.wassel_asset_id);
        }

        const createdBy = await resolveAppUserId(sb, user.userId);
        const targetCols = { scene_id: target.scene_id, draft_id: target.draft_id, draft_scene_index: target.draft_scene_index, content_id: target.content_id };
        const openUrl = (r: CvSearchRow): string | null =>
          r.stored_url ? `${r.stored_url}#t=${(r.start_ms ?? 0) / 1000}` : null;
        const toRow = (r: CvSearchRow, rank: number, kind: 'competitor_shot' | 'wassel_asset'): Record<string, unknown> => {
          const d = describeMatch(r);
          return {
            ...targetCols, kind,
            ref_id: kind === 'competitor_shot' ? r.shot_id : (assetByVideo.get(r.video_id) ?? null),
            frame_url: r.representative_frame_url, open_url: openUrl(r),
            start_ms: r.start_ms, end_ms: r.end_ms,
            reason: d.reason, learn_element: d.learn_element, adaptation_notes: null,
            usage_class: kind === 'competitor_shot' ? 'reference_only' : 'usable',
            gap: null, rank, similarity: cvNum(r.score), status: 'suggested', created_by: createdBy,
          };
        };
        const rows: Record<string, unknown>[] = [
          ...competitor.map((r, i) => toRow(r, i + 1, 'competitor_shot')),
          ...wassel.map((r, i) => toRow(r, i + 1, 'wassel_asset')),
        ];
        if (wassel.length === 0) {
          const g = gapFor(target.visual_intent, target.asset_requirement, target.visual);
          rows.push({
            ...targetCols, kind: 'gap', ref_id: null, frame_url: null, open_url: null, start_ms: null, end_ms: null,
            reason: `no Wassel asset matches this scene — needs ${g.kind}`, learn_element: null, adaptation_notes: null,
            usage_class: 'reference_only', gap: g, rank: 1, similarity: null, status: 'suggested', created_by: createdBy,
          });
        }

        // Re-suggest replaces the previous SUGGESTED rows for this target;
        // accepted / rejected decisions are kept and never re-suggested.
        const del = await scopeReferences(svc.from('mos_scene_references').delete().eq('status', 'suggested'), target);
        const delFail = dbFail(del.error); if (delFail) return delFail;
        const decided = await scopeReferences(svc.from('mos_scene_references').select('*').neq('status', 'suggested'), target);
        const decFail = dbFail(decided.error); if (decFail) return decFail;
        const decidedRows = (decided.data ?? []) as Array<Record<string, unknown> & { ref_id: string | null; kind: string }>;
        const decidedIds = new Set(decidedRows.map((r) => r.ref_id).filter((x): x is string => typeof x === 'string'));
        const fresh = rows.filter((r) => r.ref_id === null || !decidedIds.has(r.ref_id as string));
        let inserted: Array<Record<string, unknown> & { kind: string; rank: number | null }> = [];
        if (fresh.length > 0) {
          const ins = await svc.from('mos_scene_references').insert(fresh).select('*');
          const insFail = dbFail(ins.error); if (insFail) return insFail;
          inserted = (ins.data ?? []) as typeof inserted;
        }
        // Decorate with the search row's display fields (org, platform, summary,
        // tags, channel scores) so the UI needs no second call.
        const meta = new Map<string, CvSearchRow>();
        competitor.forEach((r, i) => meta.set(`competitor_shot:${i + 1}`, r));
        wassel.forEach((r, i) => meta.set(`wassel_asset:${i + 1}`, r));
        const decorate = (row: Record<string, unknown> & { kind: string; rank: number | null }): Record<string, unknown> => {
          const m = meta.get(`${row.kind}:${row.rank ?? 0}`);
          return m ? {
            ...row, shot_id: m.shot_id, video_id: m.video_id, organization_id: m.organization_id, org_name: m.org_name,
            platform: m.platform, post_url: m.post_url, published_at: m.published_at, duration_ms: m.duration_ms,
            summary: m.summary, tags: m.tags, why: m.why,
          } : row;
        };
        const all = [
          ...inserted.map(decorate),
          ...decidedRows as Array<Record<string, unknown>>,
        ];
        const byRank = (a: Record<string, unknown>, b: Record<string, unknown>) => cvNum(a.rank) - cvNum(b.rank);
        return jsonOk({
          unavailable: false,
          query: queryText,
          competitor: all.filter((r) => r.kind === 'competitor_shot').sort(byRank),
          wassel_assets: all.filter((r) => r.kind === 'wassel_asset').sort(byRank),
          gap: all.find((r) => r.kind === 'gap') ?? null,
        });
      }

      case 'scene_references_list': {
        // Every reference attached to a scene (suggested / accepted / rejected),
        // decorated the way suggest decorates competitor shots so the panel can
        // re-render from the DB alone after a reload.
        const sceneId = str(body.scene_id);
        if (!sceneId) return jsonError(400, 'scene_id is required');
        const gate = await requireCap(sb, 'read');
        if (gate) return gate;
        const svc = makeServiceClient('api:marketing-os:scene-references');
        if (!svc) return jsonError(500, 'service unavailable');
        const refs = await svc.from('mos_scene_references').select('*')
          .eq('scene_id', sceneId).order('rank', { ascending: true, nullsFirst: false });
        const rf = dbFail(refs.error); if (rf) return rf;
        type RefRow = Record<string, unknown> & { kind: string; ref_id: string | null };
        const rows = (refs.data ?? []) as RefRow[];
        const shotIds = [...new Set(rows
          .filter((r) => r.kind === 'competitor_shot' && typeof r.ref_id === 'string')
          .map((r) => r.ref_id as string))];
        type ShotMeta = {
          shot_id: string; video_id: string; organization_id: string | null; org_name: string | null;
          platform: string | null; post_url: string | null; published_at: string | null;
          duration_ms: number | null; summary: string | null; tags: string[] | null;
        };
        const meta = new Map<string, ShotMeta>();
        if (shotIds.length > 0) {
          const shots = await svc.from('mkt_cv_shots').select('id, video_id, duration_ms, summary, tags').in('id', shotIds);
          const sf = dbFail(shots.error); if (sf) return sf;
          type ShotRow = { id: string; video_id: string; duration_ms: number | null; summary: string | null; tags: string[] | null };
          const shotRows = (shots.data ?? []) as ShotRow[];
          const videoIds = [...new Set(shotRows.map((s) => s.video_id))];
          const videos = videoIds.length > 0
            ? await svc.from('mkt_cv_videos').select('id, organization_id, content_post_id').in('id', videoIds)
            : { data: [], error: null };
          const vf = dbFail(videos.error); if (vf) return vf;
          type VideoRow = { id: string; organization_id: string | null; content_post_id: string | null };
          const videoRows = (videos.data ?? []) as VideoRow[];
          const orgIds = [...new Set(videoRows.map((v) => v.organization_id).filter((x): x is string => typeof x === 'string'))];
          const postIds = [...new Set(videoRows.map((v) => v.content_post_id).filter((x): x is string => typeof x === 'string'))];
          const [orgs, posts] = await Promise.all([
            orgIds.length > 0 ? svc.from('mkt_organizations').select('id, name_ar').in('id', orgIds) : Promise.resolve({ data: [], error: null }),
            postIds.length > 0 ? svc.from('mkt_content_posts').select('id, platform, post_url, published_at').in('id', postIds) : Promise.resolve({ data: [], error: null }),
          ]);
          const of = dbFail(orgs.error) ?? dbFail(posts.error); if (of) return of;
          const orgName = new Map(((orgs.data ?? []) as Array<{ id: string; name_ar: string | null }>).map((o) => [o.id, o.name_ar]));
          type PostRow = { id: string; platform: string | null; post_url: string | null; published_at: string | null };
          const postById = new Map(((posts.data ?? []) as PostRow[]).map((p) => [p.id, p]));
          const videoById = new Map(videoRows.map((v) => [v.id, v]));
          for (const s of shotRows) {
            const v = videoById.get(s.video_id);
            const p = v?.content_post_id ? postById.get(v.content_post_id) : undefined;
            meta.set(s.id, {
              shot_id: s.id, video_id: s.video_id,
              organization_id: v?.organization_id ?? null,
              org_name: v?.organization_id ? (orgName.get(v.organization_id) ?? null) : null,
              platform: p?.platform ?? null, post_url: p?.post_url ?? null, published_at: p?.published_at ?? null,
              duration_ms: s.duration_ms, summary: s.summary, tags: s.tags,
            });
          }
        }
        const references = rows.map((r) => {
          const m = r.kind === 'competitor_shot' && typeof r.ref_id === 'string' ? meta.get(r.ref_id) : undefined;
          return m ? { ...r, ...m } : r;
        });
        return jsonOk({ references });
      }

      case 'scene_reference_set': {
        const refId = str(body.reference_id);
        const status = body.status;
        if (!refId) return jsonError(400, 'reference_id is required');
        if (status !== 'suggested' && status !== 'accepted' && status !== 'rejected') {
          return jsonError(400, "status must be 'suggested', 'accepted' or 'rejected'");
        }
        const gate = await requireCap(sb, 'write_content');
        if (gate) return gate;
        const svc = makeServiceClient('api:marketing-os:scene-references');
        if (!svc) return jsonError(500, 'service unavailable');
        const upd = await svc.from('mos_scene_references')
          .update({ status, updated_at: new Date().toISOString() })
          .eq('id', refId).select('*').maybeSingle();
        const uf = dbFail(upd.error); if (uf) return uf;
        if (!upd.data) return jsonError(404, 'reference not found');
        return jsonOk({ reference: upd.data });
      }

      case 'scene_delete': {
        const id = str(body.id);
        const contentId = str(body.content_id);
        if (!id || !contentId) return jsonError(400, 'id and content_id are required');
        const del = await sb.from('mos_scenes').delete().eq('id', id);
        const f = dbFail(del.error);
        if (f) return f;
        const list = await sb.from('mos_scenes').select('*')
          .eq('content_id', contentId).order('position', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ scenes: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Publications — one row per platform                       */
      /* -------------------------------------------------------- */
      case 'publication_list': {
        const contentId = str(body.content_id);
        const [pubs, accounts] = await Promise.all([
          contentId
            ? sb.from('mos_publication_v').select('*').eq('content_id', contentId)
                .order('scheduled_at', { ascending: true, nullsFirst: false })
            : sb.from('mos_publication_v').select('*')
                .order('scheduled_at', { ascending: true, nullsFirst: false })
                .limit(cap(body.limit, 200, 500)),
          sb.from('mos_platform_accounts').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }),
        ]);
        const f = dbFail(pubs.error) ?? dbFail(accounts.error);
        if (f) return f;
        return jsonOk({ publications: pubs.data ?? [], accounts: accounts.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Platform Pulse cockpit — per-account growth headline +    */
      /* the growth series + recent published posts, in one trip.  */
      /* Read-only; RLS ('read') on the underlying view/table gates */
      /* visibility exactly like publication_list.                 */
      /* -------------------------------------------------------- */
      case 'organic_pulse': {
        const trendSince = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
        const postCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const [pulse, trends, pubs] = await Promise.all([
          sb.from('mos_account_pulse_v').select('*'),
          sb.from('mos_account_metric_snapshots')
            .select('account_id, captured_on, followers, reach, views, post_count')
            .gte('captured_on', trendSince)
            .order('captured_on', { ascending: true }),
          sb.from('mos_publication_v').select('*')
            .eq('status', 'published')
            .gte('published_at', postCutoff)
            .order('published_at', { ascending: false })
            .limit(200),
        ]);
        const f = dbFail(pulse.error) ?? dbFail(trends.error) ?? dbFail(pubs.error);
        if (f) return f;
        return jsonOk({
          pulse: pulse.data ?? [],
          trends: trends.data ?? [],
          publications: pubs.data ?? [],
        });
      }

      case 'publication_save': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const raw = (body.publication ?? {}) as Record<string, unknown>;
        const id = str(raw.id);

        const patch: Record<string, unknown> = {};
        for (const k of ['platform', 'account_id', 'status', 'scheduled_at', 'published_at',
                         'caption', 'external_url', 'external_id', 'note',
                         // The OPTIONAL organic campaign this placement belongs to
                         // (mos_campaigns.id, kind='organic'). NULL = "no campaign" —
                         // an explicitly supported choice for an organic placement.
                         'campaign_id',
                         // The approved material this publication uses. asset_id is
                         // the durable link (mos_assets.id, always present); file_id
                         // is kept for legacy rows that stored an asset's file id.
                         'asset_id', 'file_id'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // Carousel: the ORDERED file set. Sanitized (strings, deduped, ≤10);
        // asset_id is kept = the FIRST file so every single-file consumer
        // (board, metrics, the file cell) stays correct unchanged.
        if (Object.prototype.hasOwnProperty.call(raw, 'asset_ids')) {
          const ids = Array.isArray(raw.asset_ids)
            ? [...new Set(raw.asset_ids.filter((x): x is string => typeof x === 'string' && x !== ''))]
            : [];
          if (ids.length > 10) return jsonError(400, 'A publication carries at most 10 files.');
          patch.asset_ids = ids.length > 0 ? ids : null;
          patch.asset_id = ids[0] ?? patch.asset_id ?? null;
        }

        // A publication is an ORGANIC placement — ad channels are refused here;
        // they belong on mos_execution_ads (content_ad_creative_save).
        if (typeof patch.platform === 'string' && PAID_ONLY_PLATFORMS.has(patch.platform)) {
          return jsonError(400, `"${patch.platform}" is an ad channel, not an organic feed — add it as a paid placement instead`);
        }

        // Marking published stamps who and when, so "who posted this" is never a
        // guess. The DB also refuses published without a timestamp.
        if (patch.status === 'published') {
          if (!patch.published_at) patch.published_at = new Date().toISOString();
          patch.published_by_user_id = await resolveAppUserId(sb, user.userId);
        }
        // Scheduling emits NOTHING here: «حان وقت النشر» (publish_due) fires at
        // tick time from the worker's mos_notification_sweep, not at save time —
        // a notification on save would arrive hours before anyone can act on it.

        if (id) {
          const upd = await sb.from('mos_publications').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'publication not found');
        } else {
          if (!patch.platform) return jsonError(400, 'platform is required');
          patch.content_id = contentId;
          const ins = await sb.from('mos_publications').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }

        const list = await sb.from('mos_publication_v').select('*').eq('content_id', contentId)
          .order('scheduled_at', { ascending: true, nullsFirst: false });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ publications: list.data ?? [] });
      }

      /* ---------------------------------------------------------------- */
      /* Placement-authoring from the CONTENT tab (Option A, 2026-08-26).  */
      /*                                                                  */
      /* A caption belongs to the PLACEMENT it runs on, not the creative. */
      /* The content writer authors it here; the SAME publication row is  */
      /* what the Publish tab schedules and what bundle.social posts — so  */
      /* the caption a writer types is finally the caption that publishes. */
      /*                                                                  */
      /* These write only TEXT (caption / ad creative) and are gated on   */
      /* `write_content`. Scheduling a publication stays gated by          */
      /* `schedule` and ad structure/metrics by `enter_metrics` —         */
      /* capabilities the writer role need not hold — so the text write    */
      /* goes through the service client after the write_content gate,     */
      /* touching nothing but the copy.                                    */
      /* ---------------------------------------------------------------- */
      case 'content_caption_save': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        const contentId = str(body.content_id);
        const platform = str(body.platform);
        if (!contentId || !platform) return jsonError(400, 'content_id and platform are required');
        if (PAID_ONLY_PLATFORMS.has(platform)) {
          return jsonError(400, `"${platform}" is an ad channel, not an organic feed — paid ad copy lives on the placement (content_ad_creative_save)`);
        }
        const caption = typeof body.caption === 'string' ? body.caption : '';

        // The caller must be able to SEE the content (RLS read) before we write.
        const own = await sb.from('mos_content_v').select('id').eq('id', contentId).maybeSingle();
        const of = dbFail(own.error); if (of) return of;
        if (!own.data) return jsonError(404, 'content item not found');

        const svc = makeServiceClient('api:marketing-os');
        if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');

        // Lazy-upsert the platform's DRAFT publication — caption text ONLY.
        const existing = await svc.from('mos_publications').select('id')
          .eq('content_id', contentId).eq('platform', platform)
          .order('created_at', { ascending: true }).limit(1).maybeSingle();
        const ef = dbFail(existing.error); if (ef) return ef;
        if (existing.data) {
          const upd = await svc.from('mos_publications')
            .update({ caption, updated_at: new Date().toISOString() })
            .eq('id', (existing.data as { id: string }).id).select('id').maybeSingle();
          const uf = dbFail(upd.error); if (uf) return uf;
        } else {
          // Default account for the platform (prefer connected, then sort order).
          const acct = await svc.from('mos_platform_accounts').select('id')
            .eq('platform', platform).is('archived_at', null)
            .order('is_connected', { ascending: false }).order('sort_order', { ascending: true })
            .limit(1).maybeSingle();
          const af = dbFail(acct.error); if (af) return af;
          const ins = await svc.from('mos_publications').insert({
            content_id: contentId, platform,
            account_id: (acct.data as { id: string } | null)?.id ?? null,
            status: 'draft', caption,
          }).select('id').maybeSingle();
          const insf = dbFail(ins.error); if (insf) return insf;
        }

        const list = await sb.from('mos_publication_v').select('*').eq('content_id', contentId)
          .order('scheduled_at', { ascending: true, nullsFirst: false });
        const lf = dbFail(list.error); if (lf) return lf;
        return jsonOk({ publications: list.data ?? [] });
      }

      case 'content_paid_ads': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        try {
          return jsonOk(await loadPaidAdsPayload(sb, contentId));
        } catch (e) {
          return dbFail(e as PostgrestError)
            ?? jsonError(500, e instanceof Error ? e.message : String(e));
        }
      }

      /* ---------------------------------------------------------------- */
      /* Add / edit a PAID placement on a creative (Placements tab).       */
      /*                                                                  */
      /* A paid placement is an mos_execution_ads row under some execution */
      /* + ad set. The creative is decoupled from its campaign, so a       */
      /* placement may point at ANY paid campaign's execution — there is    */
      /* no "must match the content's campaign" constraint any more.        */
      /*                                                                  */
      /*   edit   → send `ad_id` + `creative` (merges the copy).           */
      /*   add    → send `execution_id` (+ `ad_set_id` OR `new_ad_set_name`)*/
      /*            + optional initial `creative`; a new ad row is created. */
      /*                                                                  */
      /* Text-only + structure writes go through the service client after   */
      /* the write_content gate — same posture as content_caption_save.     */
      /* ---------------------------------------------------------------- */
      case 'content_ad_creative_save': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const adId = str(body.ad_id);
        const executionId = str(body.execution_id);
        const rawCreative = (body.creative ?? {}) as Record<string, unknown>;
        const creative: Record<string, string> = {};
        for (const k of AD_CREATIVE_KEYS) {
          if (typeof rawCreative[k] === 'string') creative[k] = rawCreative[k] as string;
        }
        // The ad caption lives under `message` for the campaign wizard / tree
        // editor (and any Meta-facing use). Mirror primary_text → message so a
        // caption typed on the Placements tab is the SAME field both surfaces read.
        if (typeof creative.primary_text === 'string') creative.message = creative.primary_text;

        // The caller must be able to SEE the content (RLS read) before we write.
        const own = await sb.from('mos_content_v').select('id, title').eq('id', contentId).maybeSingle();
        const of = dbFail(own.error); if (of) return of;
        const ownRow = own.data as { id: string; title: string } | null;
        if (!ownRow) return jsonError(404, 'content item not found');

        const svc = makeServiceClient('api:marketing-os');
        if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');

        if (adId) {
          // Edit THIS creative's placement, OR attach to an existing UNLINKED ad
          // (e.g. a Meta-synced ad the buyer made). Never steal an ad already
          // linked to a different creative.
          const existing = await svc.from('mos_execution_ads').select('id, creative, content_id')
            .eq('id', adId).is('archived_at', null).maybeSingle();
          const ef = dbFail(existing.error); if (ef) return ef;
          const exRow = existing.data as { id: string; creative: unknown; content_id: string | null } | null;
          if (!exRow) return jsonError(404, 'placement not found');
          if (exRow.content_id && exRow.content_id !== contentId) {
            return jsonError(400, 'that ad is already linked to another creative');
          }
          const prev = (exRow.creative ?? {}) as Record<string, unknown>;
          const upd = await svc.from('mos_execution_ads')
            .update({ content_id: contentId, creative: { ...prev, ...creative }, updated_at: new Date().toISOString() })
            .eq('id', adId).select('id').maybeSingle();
          const uf = dbFail(upd.error); if (uf) return uf;
        } else {
          // Add a new placement — the caller picks execution + ad set (or a new one).
          if (!executionId) return jsonError(400, 'execution_id or ad_id is required');
          const exec = await sb.from('mos_campaign_executions').select('id, campaign_id')
            .eq('id', executionId).maybeSingle();
          const exf = dbFail(exec.error); if (exf) return exf;
          if (!exec.data) return jsonError(404, 'execution not found');

          let adSetId = str(body.ad_set_id) || null;
          const newSetName = str(body.new_ad_set_name);
          if (!adSetId && newSetName) {
            const sets = await svc.from('mos_ad_sets').select('id')
              .eq('execution_id', executionId).is('archived_at', null);
            const scf = dbFail(sets.error); if (scf) return scf;
            const setIns = await svc.from('mos_ad_sets').insert({
              execution_id: executionId, name: newSetName,
              sort_order: (sets.data ?? []).length, status: 'active',
            }).select('id').maybeSingle();
            const sif = dbFail(setIns.error); if (sif) return sif;
            adSetId = str((setIns.data as { id?: string } | null)?.id) || null;
          } else if (adSetId) {
            const chk = await svc.from('mos_ad_sets').select('id')
              .eq('id', adSetId).eq('execution_id', executionId).is('archived_at', null).maybeSingle();
            const cf = dbFail(chk.error); if (cf) return cf;
            if (!chk.data) return jsonError(400, 'ad set does not belong to that execution');
          }

          const ins = await svc.from('mos_execution_ads').insert({
            execution_id: executionId, ad_set_id: adSetId, content_id: contentId,
            label: ownRow.title, status: 'waiting', creative,
          }).select('id').maybeSingle();
          const insf = dbFail(ins.error); if (insf) return insf;
        }

        try {
          return jsonOk(await loadPaidAdsPayload(sb, contentId));
        } catch (e) {
          return dbFail(e as PostgrestError)
            ?? jsonError(500, e instanceof Error ? e.message : String(e));
        }
      }

      /* Remove (soft-archive) a paid placement from a creative. */
      case 'paid_placement_remove': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        const contentId = str(body.content_id);
        const adId = str(body.ad_id);
        if (!contentId || !adId) return jsonError(400, 'content_id and ad_id are required');
        const own = await sb.from('mos_content_v').select('id').eq('id', contentId).maybeSingle();
        const of = dbFail(own.error); if (of) return of;
        if (!own.data) return jsonError(404, 'content item not found');
        const svc = makeServiceClient('api:marketing-os');
        if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');
        const ad = await svc.from('mos_execution_ads').select('id, content_id')
          .eq('id', adId).is('archived_at', null).maybeSingle();
        const af = dbFail(ad.error); if (af) return af;
        const adRow = ad.data as { id: string; content_id: string | null } | null;
        if (!adRow || adRow.content_id !== contentId) return jsonError(404, 'placement not found');
        const upd = await svc.from('mos_execution_ads')
          .update({ archived_at: new Date().toISOString() }).eq('id', adId);
        const uf = dbFail(upd.error); if (uf) return uf;
        try {
          return jsonOk(await loadPaidAdsPayload(sb, contentId));
        } catch (e) {
          return dbFail(e as PostgrestError)
            ?? jsonError(500, e instanceof Error ? e.message : String(e));
        }
      }

      /* The pick-list for "add paid placement": paid campaigns → executions →
         ad sets. Read as the caller (RLS) — only campaigns they can see appear. */
      case 'paid_placement_targets': {
        const camps = await sb.from('mos_campaigns').select('id, name')
          .eq('kind', 'paid').is('archived_at', null).order('created_at', { ascending: false });
        const cf = dbFail(camps.error); if (cf) return cf;
        const campRows = (camps.data ?? []) as Array<{ id: string; name: string }>;
        if (campRows.length === 0) return jsonOk({ campaigns: [] });

        const execs = await sb.from('mos_campaign_executions').select('id, campaign_id, platform, label')
          .in('campaign_id', campRows.map((c) => c.id)).order('platform', { ascending: true });
        const ef = dbFail(execs.error); if (ef) return ef;
        const execRows = (execs.data ?? []) as Array<{ id: string; campaign_id: string; platform: string; label: string | null }>;

        let setRows: Array<{ id: string; execution_id: string; name: string; sort_order: number }> = [];
        let adRows: Array<{ id: string; ad_set_id: string | null; label: string | null; content_id: string | null; platform_ad_id: string | null }> = [];
        if (execRows.length > 0) {
          const [sets, ads] = await Promise.all([
            sb.from('mos_ad_sets').select('id, execution_id, name, sort_order')
              .in('execution_id', execRows.map((e) => e.id)).is('archived_at', null)
              .order('sort_order', { ascending: true }),
            sb.from('mos_execution_ads').select('id, ad_set_id, label, content_id, platform_ad_id')
              .in('execution_id', execRows.map((e) => e.id)).is('archived_at', null),
          ]);
          const sf = dbFail(sets.error) ?? dbFail(ads.error); if (sf) return sf;
          setRows = (sets.data ?? []) as typeof setRows;
          adRows = (ads.data ?? []) as typeof adRows;
        }
        // Existing ads a creative can ATTACH to = those not yet linked to any
        // creative (an unlinked/synced ad). Ads already linked show as taken.
        type TargetAd = { id: string; label: string | null; platform_ad_id: string | null; linked: boolean };
        type TargetSet = { id: string; name: string; ads: TargetAd[] };
        type TargetExec = { id: string; platform: string; label: string | null; ad_sets: TargetSet[] };
        const adsBySet = new Map<string, TargetAd[]>();
        for (const a of adRows) {
          if (!a.ad_set_id) continue;
          const arr = adsBySet.get(a.ad_set_id) ?? [];
          arr.push({ id: a.id, label: a.label, platform_ad_id: a.platform_ad_id, linked: !!a.content_id });
          adsBySet.set(a.ad_set_id, arr);
        }
        const setsByExec = new Map<string, TargetSet[]>();
        for (const s of setRows) {
          const arr = setsByExec.get(s.execution_id) ?? [];
          arr.push({ id: s.id, name: s.name, ads: adsBySet.get(s.id) ?? [] });
          setsByExec.set(s.execution_id, arr);
        }
        const execsByCamp = new Map<string, TargetExec[]>();
        for (const e of execRows) {
          const arr = execsByCamp.get(e.campaign_id) ?? [];
          arr.push({ id: e.id, platform: e.platform, label: e.label, ad_sets: setsByExec.get(e.id) ?? [] });
          execsByCamp.set(e.campaign_id, arr);
        }
        return jsonOk({
          campaigns: campRows.map((c) => ({ id: c.id, name: c.name, executions: execsByCamp.get(c.id) ?? [] })),
        });
      }

      /* Remove an ORGANIC placement (delete its publication). Gated on
         write_content; the placement's own scheduling caps are not required. */
      case 'publication_remove': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        const contentId = str(body.content_id);
        const pubId = str(body.id);
        if (!contentId || !pubId) return jsonError(400, 'content_id and id are required');
        const own = await sb.from('mos_content_v').select('id').eq('id', contentId).maybeSingle();
        const of = dbFail(own.error); if (of) return of;
        if (!own.data) return jsonError(404, 'content item not found');
        const svc = makeServiceClient('api:marketing-os');
        if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');
        const pub = await svc.from('mos_publications').select('id, content_id')
          .eq('id', pubId).maybeSingle();
        const pf = dbFail(pub.error); if (pf) return pf;
        const pubRow = pub.data as { id: string; content_id: string | null } | null;
        if (!pubRow || pubRow.content_id !== contentId) return jsonError(404, 'placement not found');
        const del = await svc.from('mos_publications').delete().eq('id', pubId);
        const df = dbFail(del.error); if (df) return df;
        const list = await sb.from('mos_publication_v').select('*').eq('content_id', contentId)
          .order('scheduled_at', { ascending: true, nullsFirst: false });
        const lf = dbFail(list.error); if (lf) return lf;
        return jsonOk({ publications: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Organic posting via bundle.social — the REAL publish path */
      /* (the manual copy-paste flow stays for x/website).         */
      /*                                                           */
      /* One MOS publication = one platform = one bundle post. We  */
      /* upload the APPROVED file by URL (bundle fetches it), then */
      /* create a post scheduled at the slot (or ~now). bundle     */
      /* handles the OAuth tokens, the platform upload, retries and*/
      /* the review state; we track the result by bundle_post_id.  */
      /* -------------------------------------------------------- */
      case 'publication_publish': {
        const cfg = loadBundleConfig();
        if (!cfg) {
          return jsonError(503, 'Organic posting is not configured (bundle.social credentials missing).');
        }
        // Side effects live on the platforms, outside RLS's reach — gate on the
        // existing `publish` capability, same posture as the Meta write paths.
        const gate = await requireCap(sb, 'publish');
        if (gate) return gate;

        const pubId = str(body.publication_id);
        if (!pubId) return jsonError(400, 'publication_id is required');

        const pubRes = await sb.from('mos_publication_v').select('*').eq('id', pubId).maybeSingle();
        const pf = dbFail(pubRes.error);
        if (pf) return pf;
        const pub = pubRes.data as Record<string, unknown> | null;
        if (!pub) return jsonError(404, 'publication not found');

        const platform = String(pub.platform ?? '');
        if (!isBundlePlatform(platform)) {
          return jsonError(400, `${platform} cannot be auto-posted — publish it manually.`);
        }
        if (pub.account_connected !== true) {
          return jsonError(400, `${platform} is not connected — connect it in Settings → Platforms first.`);
        }

        // ── idempotency guard ─────────────────────────────────────────
        // A publication already handed to bundle must NOT create a second live
        // post (double-click, retry-after-timeout, two users). Re-publishing is
        // allowed ONLY when the previous attempt is dead (ERROR, or DELETED on
        // bundle's side) — that is the retry path.
        const priorPostId = typeof pub.bundle_post_id === 'string' ? pub.bundle_post_id : null;
        const priorBundle = typeof pub.bundle_status === 'string' ? pub.bundle_status.toUpperCase() : null;
        const retrying = priorPostId !== null && (priorBundle === 'ERROR' || priorBundle === 'DELETED');
        if (priorPostId && !retrying) {
          return jsonError(409,
            'هذا النشر أُرسل للمنصة بالفعل — حدّث الحالة بدلًا من النشر مرة أخرى. / '
            + 'Already handed to the platform — refresh its status instead of publishing again.');
        }

        // The ORDERED file set: asset_ids (carousel) or the single asset_id.
        const setIds = Array.isArray(pub.asset_ids)
          ? (pub.asset_ids as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
          : [];
        const effectiveIds = setIds.length > 0 ? setIds : [str(pub.asset_id) ?? ''].filter(Boolean);
        if (effectiveIds.length === 0) {
          return jsonError(400, 'This publication has no approved file to post.');
        }
        const caption = typeof pub.caption === 'string' ? pub.caption : '';
        // Shared hashtags live once on the CONTENT (data.hashtags) so a single
        // edit updates every platform; they are folded into the placement caption
        // HERE at publish, leaving the authored caption clean copy. Idempotent on
        // re-publish (the caption is rebuilt from pub.caption each time).
        let finalCaption = caption;
        {
          const cid = typeof pub.content_id === 'string' ? pub.content_id : '';
          if (cid) {
            const tagRes = await sb.from('mos_content').select('data').eq('id', cid).maybeSingle();
            const tags = typeof (tagRes.data as { data?: Record<string, unknown> } | null)?.data?.hashtags === 'string'
              ? String((tagRes.data as { data: Record<string, unknown> }).data.hashtags).trim() : '';
            if (tags && !finalCaption.includes(tags)) {
              finalCaption = finalCaption ? `${finalCaption}\n\n${tags}` : tags;
            }
          }
        }

        // Resolve every approved asset, PRESERVING the carousel order (the
        // .in() result order is arbitrary — re-order by effectiveIds).
        type AssetRow = { id: string; url: string | null; file_id: string | null;
          mime_type: string | null; kind: string; size_bytes: number | null;
          duration_seconds: number | null; aspect_ratio: string | null };
        const assetRes = await sb.from('mos_assets')
          .select('id, url, file_id, mime_type, kind, size_bytes, duration_seconds, aspect_ratio')
          .in('id', effectiveIds);
        const af = dbFail(assetRes.error);
        if (af) return af;
        const byId = new Map(((assetRes.data ?? []) as AssetRow[]).map((a) => [a.id, a]));
        const assets = effectiveIds.map((aid) => byId.get(aid)).filter((a): a is AssetRow => Boolean(a));
        if (assets.length !== effectiveIds.length) {
          return jsonError(404, 'An approved file on this publication no longer exists — re-pick the files.');
        }

        for (const a of assets) {
          const k = (a.kind ?? 'photo');
          if (!platformAcceptsKind(platform, k)) {
            return jsonError(400, `${platform} cannot take a ${k} file.`);
          }
        }

        // ── pre-flight — the platform's own rules, checked BEFORE upload ──
        // The SPA runs the same preflightPublishSet for its checklist; this is
        // the authoritative gate (a stale client or a direct API call still
        // cannot push a doomed post). Blockers only — warnings (unverifiable
        // metadata) pass through: bundle validates everything at post time.
        const flight = preflightPublishSet(platform, assets, finalCaption);
        const blockers = flight.issues.filter((i) => i.level === 'block');
        if (blockers.length > 0) {
          return jsonError(422, blockers.map((b) => `${b.ar} / ${b.en}`).join('  •  '));
        }

        // Resolve each file to a URL bundle can fetch (public legacy URL
        // verbatim, or a 1h signed URL — bundle fetches server-side right after
        // handoff, but its fetch can queue; 300s left no slack).
        const svc = makeServiceClient('api:marketing-os');
        const resolveUrl = async (a: AssetRow): Promise<string> => {
          if (a.url) return a.url;
          if (!a.file_id) throw new Error(`file bytes missing for asset ${a.id}`);
          if (!svc) throw new Error('file signing is unavailable');
          const fr = await svc.from('files')
            .select('storage_bucket, storage_path').eq('id', a.file_id).maybeSingle();
          if (fr.error) throw new Error(fr.error.message);
          const file = fr.data as { storage_bucket: string; storage_path: string } | null;
          if (!file) throw new Error(`file row missing for asset ${a.id}`);
          const signed = await svc.storage.from(file.storage_bucket)
            .createSignedUrl(file.storage_path, 3600);
          if (signed.error || !signed.data?.signedUrl) {
            throw new Error(signed.error?.message ?? 'sign failed');
          }
          return signed.data.signedUrl;
        };
        let fileUrls: string[];
        try {
          fileUrls = await Promise.all(assets.map(resolveUrl));
        } catch (e) {
          console.error('[marketing-os] resolving approved files failed', e);
          return jsonError(500, `Could not resolve the approved files: ${e instanceof Error ? e.message : String(e)}`);
        }

        // A human-readable title on bundle's side — ref + title, or a fallback.
        const cRes = await sb.from('mos_content_v')
          .select('ref, title').eq('id', pub.content_id as string).maybeSingle();
        const cRow = cRes.data as { ref: string | null; title: string | null } | null;
        const title = [cRow?.ref, cRow?.title].filter(Boolean).join(' ').trim() || 'Wassel';

        // Schedule at the slot when it is safely in the future; otherwise post
        // ~now (bundle needs a valid future-ish postDate — a minute's lead).
        const now = Date.now();
        const schedMs = typeof pub.scheduled_at === 'string' ? Date.parse(pub.scheduled_at) : NaN;
        const postDate = new Date(
          Number.isFinite(schedMs) && schedMs > now + 60_000 ? schedMs : now + 60_000,
        ).toISOString();

        // Retry path: clear the dead attempt on bundle's side first so the
        // dashboard doesn't accumulate ERROR corpses. Best-effort — a failed
        // delete of an already-dead post must not block the retry (logged).
        if (retrying && priorPostId && priorBundle === 'ERROR') {
          try {
            await deletePost(cfg, priorPostId);
          } catch (e) {
            console.error('[marketing-os] cleanup of errored bundle post failed (continuing)', priorPostId, e);
          }
        }

        let post;
        try {
          // Upload every file (bundle fetches each by URL), keeping order.
          const ups = await Promise.all(fileUrls.map((u) => uploadFromUrl(cfg, u)));
          const uploads = ups.map((up, i) => ({
            id: up.id,
            kind: (assets[i]?.kind ?? 'photo') as 'photo' | 'video' | 'design' | 'audio' | 'document',
          }));
          const built = buildPlatformData(platform, { text: finalCaption, uploads });
          if (!built) return jsonError(400, `${platform} is not supported for auto-posting.`);
          post = await createPost(cfg, {
            title,
            status: 'SCHEDULED',
            socialAccountTypes: [built.socialAccountType],
            postDate,
            data: built.data,
          });
        } catch (e) {
          // Fail loudly — the platform's own message reaches the user, never swallowed.
          const msg = e instanceof BundleApiError ? e.message : (e instanceof Error ? e.message : String(e));
          console.error('[marketing-os] bundle.social publish failed', e);
          return jsonError(502, `bundle.social: ${msg}`);
        }

        const patch: Record<string, unknown> = {
          status: 'scheduled',
          scheduled_at: postDate,
          external_id: post.id,
          bundle_post_id: post.id,
          bundle_status: post.status,
          bundle_error: null,
          bundle_synced_at: new Date().toISOString(),
        };
        const upd = await sb.from('mos_publications').update(patch).eq('id', pubId).select('id').maybeSingle();
        if (upd.error || !upd.data) {
          // The live post now exists but our row doesn't know its id — that is
          // an ORPHAN live post (and a future duplicate when the user retries).
          // Compensate: delete the just-created bundle post, then fail honestly.
          try {
            await deletePost(cfg, post.id);
            console.error('[marketing-os] publish DB write failed — bundle post rolled back', pubId, post.id, upd.error);
            return jsonError(500, 'Saving the publish result failed — the post was rolled back. Try again.');
          } catch (delErr) {
            // Rollback itself failed: the post IS live but untracked. Say so
            // loudly instead of pretending — the id is in the message + logs.
            console.error('[marketing-os] publish DB write failed AND rollback failed — orphan live post', pubId, post.id, delErr);
            return jsonError(500,
              `Saving failed and rollback failed — a live post may exist untracked on bundle.social (post ${post.id}). Do not re-publish; report this.`);
          }
        }

        // ── creative director: design reads on publish (best-effort) ──
        // Verifies the published assets exist as collected internal-org media
        // for the design-read sweep; failure here must never fail the publish.
        try {
          const readsSvc = makeServiceClient('api:marketing-os:creative');
          if (readsSvc) await enqueueWasselReadsOnPublish(readsSvc, pubId);
        } catch (e) {
          console.error('[marketing-os] reads-on-publish hook failed (non-fatal)', pubId, e);
        }

        const list = await sb.from('mos_publication_v').select('*').eq('content_id', pub.content_id as string)
          .order('scheduled_at', { ascending: true, nullsFirst: false });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ publications: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Reconcile ONE publication with bundle.social (poll). On   */
      /* POSTED we flip our coarse status to published + store the */
      /* permalink; ERROR is surfaced (never swallowed) but stays  */
      /* actionable. The webhook does this automatically too — this*/
      /* is the on-demand refresh for when no webhook is wired.    */
      /* -------------------------------------------------------- */
      case 'publication_sync': {
        const cfg = loadBundleConfig();
        if (!cfg) return jsonError(503, 'Organic posting is not configured.');
        const pubId = str(body.publication_id);
        if (!pubId) return jsonError(400, 'publication_id is required');

        const pr = await sb.from('mos_publications')
          .select('id, content_id, bundle_post_id, published_by_user_id').eq('id', pubId).maybeSingle();
        const prf = dbFail(pr.error);
        if (prf) return prf;
        const pub = pr.data as
          { id: string; content_id: string; bundle_post_id: string | null; published_by_user_id: string | null } | null;
        if (!pub) return jsonError(404, 'publication not found');
        if (!pub.bundle_post_id) return jsonError(400, 'This publication was not posted through bundle.social.');

        let post: BundlePost | null = null;
        let gone = false;
        try {
          post = await getPost(cfg, pub.bundle_post_id);
        } catch (e) {
          if (e instanceof BundleApiError && e.httpStatus === 404) {
            gone = true; // deleted on bundle's side — recorded, not an error
          } else {
            const msg = e instanceof BundleApiError ? e.message : (e instanceof Error ? e.message : String(e));
            console.error('[marketing-os] bundle.social sync failed', e);
            return jsonError(502, `bundle.social: ${msg}`);
          }
        }

        const bStatus = gone || !post ? 'DELETED' : post.status;
        const patch: Record<string, unknown> = {
          bundle_status: bStatus,
          bundle_error: post && typeof post.error === 'string' ? post.error : null,
          bundle_synced_at: new Date().toISOString(),
        };
        if (post && mapBundleStatus(post.status) === 'published') {
          patch.status = 'published';
          patch.published_at = post.postedDate ?? new Date().toISOString();
          patch.published_by_user_id = pub.published_by_user_id
            ?? await resolveAppUserId(sb, user.userId);
          const link = extractPermalink(post);
          if (link) patch.external_url = link;
        } else if (bStatus === 'DELETED') {
          // Same recipe as the status sweep: the live post no longer exists, so
          // the row returns to editable and the publish path allows a retry.
          patch.status = 'draft';
        }
        const upd = await sb.from('mos_publications').update(patch).eq('id', pubId).select('id').maybeSingle();
        const uf = dbFail(upd.error);
        if (uf) return uf;

        // ── creative director: design reads on sync→published (best-effort) ──
        if (patch.status === 'published') {
          try {
            const readsSvc = makeServiceClient('api:marketing-os:creative');
            if (readsSvc) await enqueueWasselReadsOnPublish(readsSvc, pubId);
          } catch (e) {
            console.error('[marketing-os] reads-on-publish hook failed (non-fatal)', pubId, e);
          }
        }

        const list = await sb.from('mos_publication_v').select('*').eq('content_id', pub.content_id)
          .order('scheduled_at', { ascending: true, nullsFirst: false });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ publications: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Reconcile EVERY in-flight bundle post at once — the       */
      /* Publishing Board's refresh (same engine the 10-min cron   */
      /* runs; see bundleStatusSync.ts). Gated on publish because  */
      /* the sweep updates publication rows.                       */
      /* -------------------------------------------------------- */
      case 'publication_sync_all': {
        const cfg = loadBundleConfig();
        if (!cfg) return jsonError(503, 'Organic posting is not configured.');
        const gate = await requireCap(sb, 'publish');
        if (gate) return gate;
        const summary = await runBundleStatusSweep(sb);
        return jsonOk({ summary });
      }

      /* -------------------------------------------------------- */
      /* Pull the LIVE connection status from bundle.social's team */
      /* and reflect it onto mos_platform_accounts, so the UI shows*/
      /* the truth (connected + real handle) instead of a hand-set */
      /* checkbox. Idempotent; safe to run any time.               */
      /* -------------------------------------------------------- */
      case 'platform_sync': {
        const cfg = loadBundleConfig();
        if (!cfg) return jsonError(503, 'Organic posting is not configured.');
        const gate = await requireCap(sb, 'manage_settings');
        if (gate) return gate;

        let team;
        try {
          team = await getTeam(cfg);
        } catch (e) {
          const msg = e instanceof BundleApiError ? e.message : (e instanceof Error ? e.message : String(e));
          console.error('[marketing-os] bundle.social team fetch failed', e);
          return jsonError(502, `bundle.social: ${msg}`);
        }

        // External truth → service-role write (reflects bundle, not user input).
        const svc = makeServiceClient('api:marketing-os');
        if (!svc) return jsonError(503, 'connection sync is unavailable');

        const byType = new Map(team.socialAccounts.map((a) => [a.type, a]));
        const accsRes = await sb.from('mos_platform_accounts')
          .select('id, platform').is('archived_at', null);
        const acf = dbFail(accsRes.error);
        if (acf) return acf;
        const stamp = new Date().toISOString();
        for (const acc of (accsRes.data ?? []) as Array<{ id: string; platform: string }>) {
          const type = BUNDLE_PLATFORM_TYPE[acc.platform];
          const remote = type ? byType.get(type) : undefined;
          const patch: Record<string, unknown> = remote
            ? {
                is_connected: true, can_publish: true, can_read_metrics: true,
                handle: remote.username ?? undefined,
                bundle_account_id: remote.id, bundle_account_type: remote.type,
                bundle_synced_at: stamp,
              }
            : {
                is_connected: false, can_publish: false, can_read_metrics: false,
                bundle_account_id: null, bundle_account_type: null, bundle_synced_at: stamp,
              };
          const u = await svc.from('mos_platform_accounts').update(patch).eq('id', acc.id);
          if (u.error) {
            console.error('[marketing-os] platform_sync update failed', acc.platform, u.error);
            return jsonError(500, u.error.message);
          }
        }
        const list = await sb.from('mos_platform_accounts').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ accounts: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Pull performance numbers from bundle.social for ONE       */
      /* published publication (on-demand twin of the daily cron). */
      /* Appends an `api` snapshot only when the reading changed.   */
      /* -------------------------------------------------------- */
      case 'metrics_pull': {
        const cfg = loadBundleConfig();
        if (!cfg) return jsonError(503, 'Organic posting is not configured.');
        const gate = await requireCap(sb, 'enter_metrics');
        if (gate) return gate;
        const pubId = str(body.publication_id);
        if (!pubId) return jsonError(400, 'publication_id is required');

        const pr = await sb.from('mos_publications')
          .select('id, platform, bundle_post_id, external_url, content_id').eq('id', pubId).maybeSingle();
        const prf = dbFail(pr.error);
        if (prf) return prf;
        const pub = pr.data as
          { id: string; platform: string; bundle_post_id: string | null; external_url: string | null; content_id: string } | null;
        if (!pub) return jsonError(404, 'publication not found');
        if (!pub.bundle_post_id) return jsonError(400, 'This publication was not posted through bundle.social.');

        const r = await pullPublicationMetrics(sb, cfg, pub);
        if (r.status === 'error') return jsonError(502, `bundle.social: ${r.reason ?? 'analytics failed'}`);

        const [list, hist] = await Promise.all([
          sb.from('mos_publication_v').select('*').eq('content_id', pub.content_id)
            .order('scheduled_at', { ascending: true, nullsFirst: false }),
          sb.from('mos_metric_snapshots').select('*').eq('publication_id', pubId)
            .order('captured_at', { ascending: true }),
        ]);
        const lf = dbFail(list.error) ?? dbFail(hist.error);
        if (lf) return lf;
        return jsonOk({ publications: list.data ?? [], snapshots: hist.data ?? [], pull_status: r.status });
      }

      /* -------------------------------------------------------- */
      /* Pull numbers for EVERY published bundle post in the 30-day */
      /* window — the "refresh all from platforms" button on the    */
      /* Numbers screen (same engine the daily cron runs).          */
      /* -------------------------------------------------------- */
      case 'metrics_pull_all': {
        const cfg = loadBundleConfig();
        if (!cfg) return jsonError(503, 'Organic posting is not configured.');
        const gate = await requireCap(sb, 'enter_metrics');
        if (gate) return gate;
        const summary = await runBundleMetricsSync(sb);
        return jsonOk({ summary });
      }

      /* -------------------------------------------------------- */
      /* Snapshot profile numbers (followers/reach/…) for every    */
      /* connected account — the Platform Pulse "refresh" button    */
      /* (same engine the daily cron runs). Fills the growth history */
      /* bundle.social deletes after 30 days.                       */
      /* -------------------------------------------------------- */
      case 'account_metrics_pull_all': {
        const cfg = loadBundleConfig();
        if (!cfg) return jsonError(503, 'Organic posting is not configured.');
        const gate = await requireCap(sb, 'enter_metrics');
        if (gate) return gate;
        const summary = await runBundleAccountMetricsSync(sb);
        return jsonOk({ summary });
      }

      /* -------------------------------------------------------- */
      /* Metric snapshots — append-only, never overwritten         */
      /* -------------------------------------------------------- */
      case 'metrics_record': {
        const publicationId = str(body.publication_id);
        if (!publicationId) return jsonError(400, 'publication_id is required');

        const num = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null;
        const views = num(body.views);
        const engagement = num(body.engagement);
        const enquiries = num(body.enquiries);
        // The engagement breakdown — captured per publication, same posture as
        // the three above (empty box → NULL, never 0).
        const likes = num(body.likes);
        const comments = num(body.comments);
        const saves = num(body.saves);

        // Platform-specific readings (e.g. TikTok watch-time) ride in extra.
        const extra = (body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra))
          ? (body.extra as Record<string, unknown>)
          : {};

        // Mirrors mos_snap_not_empty_check so the user gets a sentence rather
        // than a constraint violation.
        if (views === null && engagement === null && enquiries === null
            && likes === null && comments === null && saves === null
            && Object.keys(extra).length === 0) {
          return new Response(
            JSON.stringify({
              error: 'Enter at least one number, or skip this publication.',
              error_ar: 'أدخل رقمًا واحدًا على الأقل، أو تخطَّ هذا المنشور.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const ins = await sb.from('mos_metric_snapshots').insert({
          publication_id: publicationId,
          source: 'manual',
          views, engagement, enquiries,
          likes, comments, saves,
          extra,
          entered_by_user_id: await resolveAppUserId(sb, user.userId),
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;

        const hist = await sb.from('mos_metric_snapshots').select('*')
          .eq('publication_id', publicationId).order('captured_at', { ascending: true });
        const hf = dbFail(hist.error);
        if (hf) return hf;
        return jsonOk({ snapshots: hist.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* «لا توجد أرقام» — a deliberate skip is a THIRD state,     */
      /* distinct from both missing (nothing entered) and zero.    */
      /* extra {skipped: reason} satisfies the not-empty CHECK.    */
      /* -------------------------------------------------------- */
      case 'metrics_skip': {
        const publicationId = str(body.publication_id);
        const reason = str(body.reason);
        if (!publicationId || !reason) {
          return jsonError(400, 'publication_id and reason are required');
        }
        const ins = await sb.from('mos_metric_snapshots').insert({
          publication_id: publicationId,
          source: 'manual',
          views: null,
          engagement: null,
          enquiries: null,
          extra: { skipped: reason },
          entered_by_user_id: await resolveAppUserId(sb, user.userId),
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* The Friday entry screen (s50): everything published in    */
      /* the week, grouped by platform, each publication carrying  */
      /* its latest reading and its three-state status.            */
      /* -------------------------------------------------------- */
      case 'numbers_week': {
        const { weekStart, weekEnd } = weekBounds(str(body.week_start));

        const pubs = await sb.from('mos_publication_v').select('*')
          .eq('status', 'published')
          .gte('published_at', weekStart)
          .lt('published_at', weekEnd)
          .order('published_at', { ascending: false })
          .limit(cap(body.limit, 300, 500));
        const f = dbFail(pubs.error);
        if (f) return f;
        const pubRows = (pubs.data ?? []) as unknown as Array<Row & {
          content_id: string; platform: string; published_at: string | null;
        }>;

        const pubIds = pubRows.map((p) => p.id);
        const contentIds = Array.from(new Set(pubRows.map((p) => p.content_id)));
        const [snaps, titles] = await Promise.all([
          pubIds.length > 0
            ? sb.from('mos_metric_snapshots').select('*')
                .in('publication_id', pubIds)
                .order('captured_at', { ascending: false })
            : Promise.resolve({ data: [] as unknown[], error: null }),
          contentIds.length > 0
            ? sb.from('mos_content_v').select('id, ref, title').in('id', contentIds)
            : Promise.resolve({ data: [] as unknown[], error: null }),
        ]);
        const f2 = dbFail(snaps.error) ?? dbFail(titles.error);
        if (f2) return f2;

        // Latest snapshot per publication (the list is captured_at DESC).
        const latestByPub = new Map<string, Record<string, unknown>>();
        for (const s of (snaps.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const pid = s.publication_id as string;
          if (!latestByPub.has(pid)) latestByPub.set(pid, s);
        }
        const titleById = new Map(
          ((titles.data ?? []) as unknown as Array<{ id: string; ref: string | null; title: string }>)
            .map((c) => [c.id, c] as const),
        );

        const byPlatform = new Map<string, Array<Record<string, unknown>>>();
        let entered = 0;
        let missingCount = 0;
        for (const p of pubRows) {
          const latest = latestByPub.get(p.id) ?? null;
          const extra = (latest?.extra ?? {}) as Record<string, unknown>;
          const skippedReason = typeof extra.skipped === 'string' ? extra.skipped : null;
          // Missing = nothing was ever entered. A skip is NOT missing — it is
          // a deliberate statement, so it counts toward neither entered nor
          // the remaining-work estimate.
          const missing = latest === null;
          if (missing) missingCount += 1;
          else if (!skippedReason) entered += 1;

          const entry: Record<string, unknown> = {
            publication_id: p.id,
            content_ref: titleById.get(p.content_id)?.ref ?? null,
            title: titleById.get(p.content_id)?.title ?? '',
            latest: latest
              ? {
                  captured_at: latest.captured_at ?? null,
                  source: latest.source ?? null,
                  views: latest.views ?? null,
                  engagement: latest.engagement ?? null,
                  enquiries: latest.enquiries ?? null,
                  likes: latest.likes ?? null,
                  comments: latest.comments ?? null,
                  saves: latest.saves ?? null,
                  extra,
                }
              : null,
            missing,
            skipped_reason: skippedReason,
          };
          const list = byPlatform.get(p.platform) ?? [];
          list.push(entry);
          byPlatform.set(p.platform, list);
        }

        const platforms = Array.from(byPlatform.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([platform, publications]) => ({ platform, publications }));

        return jsonOk({
          platforms,
          progress: {
            entered,
            total: pubRows.length,
            // Two minutes per publication is the team's own estimate for the
            // Friday round — it sizes the «باقي ~٢٠ دقيقة» line.
            estimate_minutes: missingCount * 2,
          },
          week_start: weekStart,
          week_end: weekEnd,
        });
      }

      case 'metrics_history': {
        const publicationId = str(body.publication_id);
        if (!publicationId) return jsonError(400, 'publication_id is required');
        const hist = await sb.from('mos_metric_snapshots').select('*')
          .eq('publication_id', publicationId).order('captured_at', { ascending: true });
        const f = dbFail(hist.error);
        if (f) return f;
        return jsonOk({ snapshots: hist.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Content inventory — per-project rollup of the files/media */
      /* linked to OUR projects (is_public all_projects), broken   */
      /* down by media kind, content type (document_type: floor    */
      /* plans / gallery / marketing / brochures…), asset nature   */
      /* (real vs AI/CGI vs graphic) and top subject tags, plus    */
      /* storage. Read-only planning view; no writes.              */
      /* -------------------------------------------------------- */
      case 'content_inventory': {
        // Visible to anyone with the marketing read floor. The numbers span
        // files across every project regardless of the caller's own file RLS,
        // so we read them with the service client AFTER the capability gate.
        const capFail = await requireCap(sb, 'read');
        if (capFail) return capFail;
        const svc = makeServiceClient('api:marketing-os');
        if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');

        // all_projects model id — file_links reference it as (model_id, record_id).
        const modelRes = await svc.from('models').select('id').eq('name', 'all_projects').single();
        const modelFail = dbFail(modelRes.error);
        if (modelFail) return modelFail;
        const apId = (modelRes.data as { id: string }).id;

        // OUR projects = all_projects rows flagged is_public (the marketed set,
        // ~99). The is_public filter keeps this to ~99 rows, well under the
        // 1000-row PostgREST cap, so no pagination is needed here.
        const projRes = await svc
          .from('records')
          .select('id, data')
          .eq('model_id', apId)
          .eq('data->>is_public', 'true');
        const projFail = dbFail(projRes.error);
        if (projFail) return projFail;
        const ours = ((projRes.data ?? []) as Array<{ id: string; data: Record<string, unknown> }>)
          .map((r) => ({ id: r.id, name: typeof r.data?.project_name === 'string' ? r.data.project_name : '' }));

        // Per-project accumulator, seeded so a project with ZERO content still
        // shows — a content gap is exactly what this planning view is for.
        interface Agg {
          id: string; name: string;
          files: number; storage_bytes: number;
          kind: { image: number; video: number; pdf: number; document: number; other: number };
          nature: { real: number; ai: number; graphic: number; screenshot: number; unknown: number };
          // Content TYPE = what the file IS (files.document_type: floor_plan,
          // gallery_image, marketing_asset, brochure…). This is the honest
          // "what content do we have" axis and it matches the Files library's
          // own grouping — unlike the file_links.role (how it's ATTACHED), which
          // is frequently a generic 'marketing_asset' link over a floor-plan
          // image, so counting by role read as "409 marketing" for a project
          // whose files are really 404 floor plans.
          type: Map<string, number>;
          seen: Set<string>;
          tags: Map<string, number>;
        }
        const agg = new Map<string, Agg>();
        for (const p of ours) {
          agg.set(p.id, {
            id: p.id, name: p.name,
            files: 0, storage_bytes: 0,
            kind: { image: 0, video: 0, pdf: 0, document: 0, other: 0 },
            nature: { real: 0, ai: 0, graphic: 0, screenshot: 0, unknown: 0 },
            type: new Map(), seen: new Set(), tags: new Map(),
          });
        }
        const ourIds = ours.map((p) => p.id);

        // file_links → files, business-class only, our projects only. Paginate:
        // our projects hold ~3.9k links, well over the 1000-row cap, and a bare
        // select would silently truncate (the repo's documented footgun).
        type LinkRow = {
          record_id: string;
          file: {
            id: string; kind: string | null; size_bytes: number | null;
            asset_nature: string | null; document_type: string | null; tags: string[] | null;
          } | null;
        };
        if (ourIds.length > 0) {
          for (let from = 0; ; from += 1000) {
            const linkRes = await svc
              .from('file_links')
              .select('record_id, file:files!inner(id, kind, size_bytes, asset_nature, document_type, tags, file_class)')
              .eq('model_id', apId)
              .in('record_id', ourIds)
              .eq('file.file_class', 'business')
              .range(from, from + 999);
            const linkFail = dbFail(linkRes.error);
            if (linkFail) return linkFail;
            const rows = (linkRes.data ?? []) as unknown as LinkRow[];
            for (const row of rows) {
              const a = agg.get(row.record_id);
              if (!a || !row.file) continue;
              // Count each file ONCE per project — a photo linked to the same
              // project under two roles is one photo, not two.
              const fid = row.file.id;
              if (a.seen.has(fid)) continue;
              a.seen.add(fid);
              a.files += 1;
              a.storage_bytes += Number(row.file.size_bytes) || 0;
              const dt = row.file.document_type || 'other';
              a.type.set(dt, (a.type.get(dt) ?? 0) + 1);
              switch (row.file.kind) {
                case 'image': a.kind.image += 1; break;
                case 'video': a.kind.video += 1; break;
                case 'pdf': a.kind.pdf += 1; break;
                case 'document': case 'wassel_doc': a.kind.document += 1; break;
                default: a.kind.other += 1; break;
              }
              switch (row.file.asset_nature) {
                case 'real': a.nature.real += 1; break;
                case 'ai_generated': case 'ai_edited': case 'cgi_render': a.nature.ai += 1; break;
                case 'graphic_design': a.nature.graphic += 1; break;
                case 'screenshot': a.nature.screenshot += 1; break;
                default: a.nature.unknown += 1; break;
              }
              for (const tag of row.file.tags ?? []) {
                if (typeof tag !== 'string' || tag.trim() === '') continue;
                a.tags.set(tag, (a.tags.get(tag) ?? 0) + 1);
              }
            }
            if (rows.length < 1000) break;
          }
        }

        // Shape the response: drop the Sets/Maps, emit top tags, sort by volume.
        const projects = [...agg.values()]
          .map((a) => ({
            id: a.id, name: a.name,
            files: a.files, storage_bytes: a.storage_bytes,
            by_kind: a.kind, by_nature: a.nature,
            // document_type tally, highest first — the content-type breakdown.
            by_type: [...a.type.entries()]
              .sort((x, y) => y[1] - x[1])
              .map(([type, n]) => ({ type, n })),
            top_tags: [...a.tags.entries()]
              .sort((x, y) => y[1] - x[1]).slice(0, 8)
              .map(([tag, n]) => ({ tag, n })),
          }))
          .sort((x, y) => y.files - x.files || x.name.localeCompare(y.name));

        const totals = projects.reduce(
          (t, p) => {
            t.files += p.files; t.storage_bytes += p.storage_bytes;
            t.images += p.by_kind.image; t.videos += p.by_kind.video;
            t.pdfs += p.by_kind.pdf; t.documents += p.by_kind.document;
            t.real += p.by_nature.real; t.ai += p.by_nature.ai; t.graphic += p.by_nature.graphic;
            if (p.files > 0) t.projects_with_content += 1;
            return t;
          },
          {
            projects: projects.length, projects_with_content: 0, files: 0, storage_bytes: 0,
            images: 0, videos: 0, pdfs: 0, documents: 0, real: 0, ai: 0, graphic: 0,
          },
        );

        // model_id lets the client deep-link into the Files library filtered to
        // one project (business_files_search needs model_id + record_id).
        return jsonOk({ projects, totals, model_id: apId });
      }

      /* -------------------------------------------------------- */
      /* Content readiness — per project, does it have its        */
      /* required assets? 1 brochure + 3 hero images (counted on   */
      /* the file's MAIN type primary_category), and how many of   */
      /* its units have a plan (units.unit_plan). Aggregated in    */
      /* SQL by mkt_content_readiness() so we never fetch the ~7k  */
      /* unit rows. Read-only planning view.                       */
      /* -------------------------------------------------------- */
      case 'content_readiness': {
        const capFail = await requireCap(sb, 'read');
        if (capFail) return capFail;
        const svc = makeServiceClient('api:marketing-os');
        if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');

        const rpc = await svc.rpc('mkt_content_readiness');
        const rpcFail = dbFail(rpc.error);
        if (rpcFail) return rpcFail;

        // all_projects model id — lets the client deep-link into the Files library.
        const modelRes = await svc.from('models').select('id').eq('name', 'all_projects').single();
        const modelFail = dbFail(modelRes.error);
        if (modelFail) return modelFail;
        const apId = (modelRes.data as { id: string }).id;

        type Row = {
          project_id: string; project_name: string;
          brochure_count: number; hero_count: number;
          total_units: number; units_with_plan: number;
        };
        const projects = ((rpc.data ?? []) as Row[]).map((r) => ({
          id: r.project_id,
          name: r.project_name || '',
          brochure_count: r.brochure_count,
          hero_count: r.hero_count,
          total_units: r.total_units,
          units_with_plan: r.units_with_plan,
          units_missing_plan: Math.max(0, r.total_units - r.units_with_plan),
        }));

        const totals = projects.reduce(
          (t, p) => {
            if (p.brochure_count === 1) t.brochure_ok += 1;
            else if (p.brochure_count === 0) t.brochure_missing += 1;
            else t.brochure_over += 1;
            if (p.hero_count === 3) t.hero_ok += 1;
            else if (p.hero_count < 3) t.hero_under += 1;
            else t.hero_over += 1;
            t.total_units += p.total_units;
            t.units_missing_plan += p.units_missing_plan;
            return t;
          },
          {
            projects: projects.length,
            brochure_ok: 0, brochure_missing: 0, brochure_over: 0,
            hero_ok: 0, hero_under: 0, hero_over: 0,
            total_units: 0, units_missing_plan: 0,
          },
        );

        return jsonOk({ projects, totals, model_id: apId });
      }

      /* -------------------------------------------------------- */
      /* Content readiness — units drill-down: the units of ONE    */
      /* project with whether each has a plan (units.unit_plan).   */
      /* -------------------------------------------------------- */
      case 'content_readiness_units': {
        const capFail = await requireCap(sb, 'read');
        if (capFail) return capFail;
        const svc = makeServiceClient('api:marketing-os');
        if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');
        const projectId = str(body.project_id);
        if (!projectId) return jsonError(400, 'project_id is required');

        const uModel = await svc.from('models').select('id').eq('name', 'units').single();
        const uFail = dbFail(uModel.error);
        if (uFail) return uFail;
        const uId = (uModel.data as { id: string }).id;

        // A project can hold a few hundred units — paginate past the 1000 cap.
        const rows: Array<{ id: string; data: Record<string, unknown> }> = [];
        for (let from = 0; ; from += 1000) {
          const res = await svc
            .from('records')
            .select('id, data')
            .eq('model_id', uId)
            .eq('data->>project_id', projectId)
            .range(from, from + 999);
          const f = dbFail(res.error);
          if (f) return f;
          const batch = (res.data ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
          rows.push(...batch);
          if (batch.length < 1000) break;
        }
        const units = rows
          .map((r) => {
            const d = (r.data ?? {}) as Record<string, unknown>;
            const label =
              (typeof d.unit_number === 'string' && d.unit_number) ||
              (typeof d.unit_name === 'string' && d.unit_name) ||
              (typeof d.name === 'string' && d.name) ||
              r.id.slice(0, 8);
            const hasPlan = typeof d.unit_plan === 'string' && d.unit_plan.trim() !== '';
            return { id: r.id, label: String(label), has_plan: hasPlan };
          })
          // missing-plan units first, then by label
          .sort((a, b) => Number(a.has_plan) - Number(b.has_plan) || a.label.localeCompare(b.label, 'ar'));

        return jsonOk({ units, model_id: uId });
      }

      /* -------------------------------------------------------- */
      /* Roles — canonical roles 'mos_*' × users.role_assignments  */
      /* -------------------------------------------------------- */
      case 'roles_list': {
        const [rolesRes, usersRes] = await Promise.all([
          sb.from('roles').select('id, key, label_ar, label_en')
            .like('key', 'mos\\_%').order('key', { ascending: true }),
          sb.from('users').select('id, name_ar, name_en, email, role_assignments, is_active')
            .eq('is_active', true).order('name_en', { ascending: true }).limit(500),
        ]);
        const f = dbFail(rolesRes.error) ?? dbFail(usersRes.error);
        if (f) return f;

        const roleRows = (rolesRes.data ?? []) as unknown as Array<{
          id: string; key: string; label_ar: string; label_en: string;
        }>;
        const keyById = new Map(roleRows.map((r) => [r.id, stripMosPrefix(r.key)]));
        const people = ((usersRes.data ?? []) as unknown as Array<{
          id: string;
          name_ar: string | null;
          name_en: string | null;
          email: string | null;
          role_assignments: unknown;
        }>).map((u) => {
          const assignments = Array.isArray(u.role_assignments) ? u.role_assignments : [];
          const held = assignments
            .map((a) => keyById.get(String((a as { role_id?: unknown } | null)?.role_id ?? '')))
            .filter((k): k is string => Boolean(k));
          return { user_id: u.id, name_ar: u.name_ar, name_en: u.name_en, email: u.email, roles: held };
        });
        const roles = roleRows.map((r) => {
          const key = stripMosPrefix(r.key);
          return {
            key,
            role_id: r.id,
            label_ar: r.label_ar,
            label_en: r.label_en,
            holders: people.filter((p) => p.roles.includes(key)).length,
          };
        });
        return jsonOk({ people, roles });
      }

      case 'role_grant': {
        const targetUserId = str(body.user_id);
        const roleKey = str(body.role_key);
        if (!targetUserId || !roleKey) return jsonError(400, 'user_id and role_key are required');
        if (typeof body.grant !== 'boolean') return jsonError(400, 'grant must be a boolean');
        // Atomic + self-authorizing (manage_roles) inside the RPC — a browser
        // read-modify-write of users.role_assignments would be a lost-update race.
        const res = await sb.rpc('mos_role_grant', {
          p_user_id: targetUserId,
          p_role_key: roleKey,
          p_grant: body.grant,
        });
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* The surface matrix (screen 33) — full / read / hidden     */
      /* -------------------------------------------------------- */
      case 'surface_matrix': {
        const [rolesRes, cellsRes] = await Promise.all([
          sb.from('roles').select('id, key').like('key', 'mos\\_%').order('key', { ascending: true }),
          sb.from('surface_access').select('role_id, surface_key, level'),
        ]);
        const f = dbFail(rolesRes.error) ?? dbFail(cellsRes.error);
        if (f) return f;
        const roleRows = (rolesRes.data ?? []) as unknown as Array<{ id: string; key: string }>;
        const keyById = new Map(roleRows.map((r) => [r.id, stripMosPrefix(r.key)]));
        const cells = ((cellsRes.data ?? []) as unknown as Array<{
          role_id: string; surface_key: string; level: string;
        }>)
          .map((c) => ({ role_key: keyById.get(c.role_id) ?? '', surface_key: c.surface_key, level: c.level }))
          .filter((c) => c.role_key !== '');
        return jsonOk({
          surfaces: [...SURFACES],
          roles: roleRows.map((r) => ({ key: stripMosPrefix(r.key), role_id: r.id })),
          cells,
        });
      }

      case 'surface_set': {
        const roleKey = str(body.role_key);
        const surfaceKey = str(body.surface_key);
        const level = str(body.level);
        if (!roleKey || !(MOS_ROLE_KEYS as readonly string[]).includes(roleKey)) {
          return jsonError(400, 'unknown role');
        }
        if (!surfaceKey || !(SURFACES as readonly string[]).includes(surfaceKey)) {
          return jsonError(400, 'unknown surface');
        }
        if (!level || !['full', 'read', 'hidden'].includes(level)) {
          return jsonError(400, 'level must be full, read or hidden');
        }
        const roleRes = await sb.from('roles').select('id').eq('key', `mos_${roleKey}`).maybeSingle();
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        if (!roleRes.data) return jsonError(400, 'unknown role');
        const up = await sb.from('surface_access').upsert(
          { role_id: (roleRes.data as { id: string }).id, surface_key: surfaceKey, level },
          { onConflict: 'role_id,surface_key' },
        );
        const f = dbFail(up.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Capabilities matrix — what each role can DO (role x cap). */
      /* Twin of surface_matrix; the Roles screen edits both.      */
      /* -------------------------------------------------------- */
      case 'capability_matrix': {
        const [rolesRes, cellsRes] = await Promise.all([
          sb.from('roles').select('id, key').like('key', 'mos\\_%').order('key', { ascending: true }),
          sb.from('role_capabilities').select('role_id, capability'),
        ]);
        const f = dbFail(rolesRes.error) ?? dbFail(cellsRes.error);
        if (f) return f;
        const roleRows = (rolesRes.data ?? []) as unknown as Array<{ id: string; key: string }>;
        const keyById = new Map(roleRows.map((r) => [r.id, stripMosPrefix(r.key)]));
        const cells = ((cellsRes.data ?? []) as unknown as Array<{ role_id: string; capability: string }>)
          .map((c) => ({ role_key: keyById.get(c.role_id) ?? '', capability: c.capability }))
          .filter((c) => c.role_key !== '');
        return jsonOk({
          capabilities: [...CAPABILITIES],
          roles: roleRows.map((r) => ({ key: stripMosPrefix(r.key), role_id: r.id })),
          cells,
        });
      }

      case 'capability_set': {
        const roleKey = str(body.role_key);
        const capability = str(body.capability);
        const grant = body.grant === true;
        if (!roleKey || !(MOS_ROLE_KEYS as readonly string[]).includes(roleKey)) {
          return jsonError(400, 'unknown role');
        }
        if (!capability || !(CAPABILITIES as readonly string[]).includes(capability)) {
          return jsonError(400, 'unknown capability');
        }
        const roleRes = await sb.from('roles').select('id').eq('key', `mos_${roleKey}`).maybeSingle();
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        if (!roleRes.data) return jsonError(400, 'unknown role');
        const roleId = (roleRes.data as { id: string }).id;
        // Presence IS the grant — insert to grant, delete to revoke. RLS
        // (role_capabilities_ins / _del) enforces 'manage_roles' on the caller.
        const res = grant
          ? await sb.from('role_capabilities')
              .upsert({ role_id: roleId, capability }, { onConflict: 'role_id,capability' })
          : await sb.from('role_capabilities')
              .delete().eq('role_id', roleId).eq('capability', capability);
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Overview — four numbers and the two lists that need a     */
      /* decision today. Counts are COUNTS, not a fetched page     */
      /* trimmed client-side, so they stay true past 1,000 rows.   */
      /* -------------------------------------------------------- */
      case 'overview': {
        const nowIso = new Date().toISOString();
        // Screen 01's segmented control: هذا الأسبوع / الشهر / الربع. The
        // response shape is unchanged — week_start/week_end carry the bounds
        // of whichever period was asked for.
        const periodRaw = str(body.period);
        const period = periodRaw === 'month' || periodRaw === 'quarter' ? periodRaw : 'week';
        const { weekStart, weekEnd } = periodBounds(period, str(body.week_of));
        const roleRes = await sb.rpc('wassell_mos_role', { p_auth_uid: user.userId });
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        const myRole = (roleRes.data as string | null) ?? 'viewer';

        const live = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).not('status_key', 'in', '("draft","done")');
        const mine = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).eq('owner_role', myRole);
        const late = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).not('status_key', 'in', '("draft","done")')
          .lt('current_task_due_at', nowIso);

        const [liveRes, mineRes, lateRes, stalled, week, spend, byType, mineOldest, lateRows] = await Promise.all([
          live,
          mine,
          late,
          // Oldest-touched open work first — the bottleneck, by definition.
          // «متوقف — لم يتحرك منذ ٤٨ ساعة»: only items untouched for 48h count
          // as stalled. Without this every in-production item showed, including
          // ones that moved today. nowIso is the frozen epoch on the capture
          // server and real now in prod — correct in both.
          sb.from('mos_content_v')
            .select('id, ref, title, status_key, current_step_label_ar, current_step_label_en, owner_role, current_task_due_at, updated_at, content_type_key')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")')
            .lt('updated_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
            .order('updated_at', { ascending: true }).limit(8),
          sb.from('mos_publication_v')
            .select('id, content_id, platform, status, scheduled_at, published_at')
            .gte('scheduled_at', weekStart).lt('scheduled_at', weekEnd)
            .order('scheduled_at', { ascending: true }).limit(60),
          sb.from('mos_campaign_v')
            .select('id, ref, name, status, budget_total, total_spend, total_leads, total_qualified')
            .in('status', ['active', 'planning']).limit(20),
          sb.from('mos_content_v').select('content_type_key, status_key')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")').limit(1000),
          // «أقدمها منتظر منذ …» — the oldest item sitting with my role.
          sb.from('mos_content_v').select('updated_at')
            .is('archived_at', null).eq('owner_role', myRole)
            .order('updated_at', { ascending: true }).limit(1),
          // The late stat's breakdown («٢ في التصميم · ٢ بانتظار المراجعة»).
          sb.from('mos_content_v').select('current_step_label_ar, current_step_label_en')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")')
            .lt('current_task_due_at', nowIso).limit(200),
        ]);

        const f = dbFail(liveRes.error) ?? dbFail(mineRes.error) ?? dbFail(lateRes.error)
          ?? dbFail(stalled.error) ?? dbFail(week.error) ?? dbFail(spend.error) ?? dbFail(byType.error)
          ?? dbFail(mineOldest.error) ?? dbFail(lateRows.error);
        if (f) return f;

        // Titles for the week card rows — one extra query beats N.
        const weekContentIds = Array.from(new Set(
          (week.data ?? []).map((p) => (p as unknown as Row).content_id as string),
        ));
        let weekTitles = new Map<string, { ref: string | null; title: string }>();
        if (weekContentIds.length > 0) {
          const t = await sb.from('mos_content_v').select('id, ref, title').in('id', weekContentIds);
          const tf = dbFail(t.error);
          if (tf) return tf;
          weekTitles = new Map((t.data ?? []).map((r): [string, { ref: string | null; title: string }] => {
            const row = r as unknown as { id: string; ref: string | null; title: string };
            return [row.id, { ref: row.ref, title: row.title }];
          }));
        }
        const weekRows = (week.data ?? []).map((p) => {
          const row = p as unknown as Row;
          const t = weekTitles.get(row.content_id as string);
          return { ...row, ref: t?.ref ?? null, title: t?.title ?? null };
        });

        // «بحاجة لموعد نشر» — aimed at this period but nothing scheduled yet.
        const unscheduledRes = await sb.from('mos_content_v')
          .select('id, ref, title, target_publish_at')
          .is('archived_at', null).not('status_key', 'in', '("draft","done")')
          .gte('target_publish_at', weekStart).lt('target_publish_at', weekEnd)
          .order('target_publish_at', { ascending: true }).limit(20);
        const uf = dbFail(unscheduledRes.error);
        if (uf) return uf;
        const unscheduled = (unscheduledRes.data ?? []).filter((r) =>
          !weekContentIds.includes((r as unknown as Row).id as string));

        // Aggregate the late rows by stage label for the stat's detail line.
        const mixMap = new Map<string, { label_ar: string; label_en: string; n: number }>();
        for (const r of lateRows.data ?? []) {
          const row = r as unknown as { current_step_label_ar: string | null; current_step_label_en: string | null };
          const key = row.current_step_label_ar ?? row.current_step_label_en ?? '';
          if (!key) continue;
          const cur = mixMap.get(key);
          if (cur) cur.n += 1;
          else mixMap.set(key, {
            label_ar: row.current_step_label_ar ?? key,
            label_en: row.current_step_label_en ?? key,
            n: 1,
          });
        }
        const lateMix = Array.from(mixMap.values()).sort((a, b) => b.n - a.n).slice(0, 3);

        return jsonOk({
          role: myRole,
          period,
          counts: {
            in_production: liveRes.count ?? 0,
            waiting_on_me: mineRes.count ?? 0,
            publishing_this_week: weekRows.length + unscheduled.length,
            late: lateRes.count ?? 0,
          },
          stalled: stalled.data ?? [],
          week: weekRows,
          unscheduled,
          campaigns: spend.data ?? [],
          mix: byType.data ?? [],
          waiting_oldest_at: (mineOldest.data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? null,
          late_mix: lateMix,
          week_start: weekStart,
          week_end: weekEnd,
        });
      }

      /* -------------------------------------------------------- */
      /* My work / Team work — the task queue, by role             */
      /* -------------------------------------------------------- */
      case 'work_list': {
        let scope = str(body.scope) === 'team' ? 'team' : 'mine';
        // The team board (EVERYONE's queue) is gated by the `team` surface —
        // only roles whose team surface is not 'hidden' (CEO + marketing
        // manager by default) may pull it. A hidden-surface caller is silently
        // downgraded to their OWN queue, so a stale client, a direct API call,
        // or a leftover "الجميع" button can never expose the whole team's tasks.
        if (scope === 'team') {
          const surf = await callerSurfaces(sb);
          if ('fail' in surf) return surf.fail;
          if (surf.surfaces.team === 'hidden') scope = 'mine';
        }
        const roleRes = await sb.rpc('wassell_mos_role', { p_auth_uid: user.userId });
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        const myRole = (roleRes.data as string | null) ?? 'viewer';

        let q = sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS)
          .is('archived_at', null)
          .not('status_key', 'in', '("draft","done")');
        // 'mine' filters to the role the open task sits with. An administrator
        // has no queue of their own, so they see the team board instead of an
        // empty screen that would read as "nothing to do".
        if (scope === 'mine' && myRole !== 'administrator') q = q.eq('owner_role', myRole);

        const rows = await q.order('current_task_due_at', { ascending: true, nullsFirst: false })
          .limit(cap(body.limit, 300, 500));
        const f = dbFail(rows.error);
        if (f) return f;

        // The item's own open task carries the step key we need to name the action.
        const ids = (rows.data ?? []).map((r) => (r as unknown as Row).id);
        let tasks: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('workflow_role_tasks').select('*')
            .eq('subject_table', 'mos_content')
            .in('subject_id', ids)
            .eq('status', 'open');
          const tf = dbFail(t.error);
          if (tf) return tf;
          tasks = (t.data ?? []).map((row) => mapRoleTask(row as Record<string, unknown>));
        }

        // Pinned-version steps for the listed tasks — one read drives both the
        // approval split on screen 35 (is_approval / approval_kind per task)
        // and screen 02's «القادم إليك» band below.
        const stepMeta = await loadPinnedStepMeta(sb, ids);
        if ('fail' in stepMeta) return stepMeta.fail;
        tasks = (tasks as Array<Record<string, unknown>>).map((t) => {
          const meta = stepMeta.bySubject.get(t.content_id as string);
          const step = meta?.steps.find((s) => s.key === t.step_id);
          return {
            ...t,
            is_approval: step?.is_approval ?? false,
            approval_kind: step?.approval_kind ?? null,
          };
        });

        // «القادم إليك» (s02) — NOT tasks: in-flight items whose pinned path
        // reaches my role at a FUTURE step, so I can prepare without my queue
        // filling with work I cannot start yet.
        let upcoming: unknown[] = [];
        if (scope === 'mine' && (MOS_ROLE_KEYS as readonly string[]).includes(myRole)) {
          const cand = await sb.from('mos_content_v')
            .select('id, ref, title')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")')
            .neq('owner_role', myRole).limit(200);
          const cf = dbFail(cand.error);
          if (cf) return cf;
          const candIds = (cand.data ?? []).map((r) => (r as unknown as Row).id as string);
          if (candIds.length > 0) {
            const meta = await loadPinnedStepMeta(sb, candIds);
            if ('fail' in meta) return meta.fail;
            const titleBy = new Map((cand.data ?? []).map(
              (r): [string, { id: string; ref: string | null; title: string }] => {
                const row = r as unknown as { id: string; ref: string | null; title: string };
                return [row.id, row];
              },
            ));
            for (const [subjectId, m] of meta.bySubject) {
              if (!m.currentStepKey) continue;
              const idx = m.steps.findIndex((s) => s.key === m.currentStepKey);
              if (idx < 0) continue;
              for (let j = idx + 1; j < m.steps.length; j += 1) {
                const s = m.steps[j];
                if (!s || s.role_key !== myRole) continue;
                const c = titleBy.get(subjectId);
                if (!c) break;
                upcoming.push({
                  content_id: subjectId,
                  ref: c.ref,
                  title: c.title,
                  step_key: s.key,
                  step_label_ar: s.label_ar,
                  step_label_en: s.label_en,
                  steps_away: j - idx,
                });
                break;
              }
            }
            upcoming = (upcoming as Array<{ steps_away: number }>)
              .sort((a, b) => a.steps_away - b.steps_away).slice(0, 12);
          }
        }
        // Hand-assigned work rides the SAME queue. Generation runs first so a
        // repeating task exists as a real row before we read (see
        // mos_task_series_materialize: pg_cron is not enabled on this project).
        const manual = await listManualTasks(sb, {
          scope: scope === 'team' ? 'team' : 'mine',
          meUserId: await resolveAppUserId(sb, user.userId),
        });
        if ('fail' in manual) return manual.fail;

        return jsonOk({
          role: myRole,
          content: rows.data ?? [],
          tasks,
          upcoming,
          manual_tasks: manual.rows,
        });
      }

      /* -------------------------------------------------------- */
      /* Manual tasks — hand-assigned work no workflow generates.   */
      /* A manager or the CEO gives a person something to do        */
      /* («اعرضي حملة مينا ٥٢»); anyone may give it to THEMSELVES.  */
      /* Authorization is RLS + the `assign_task` capability; this  */
      /* file only shapes and validates.                            */
      /* -------------------------------------------------------- */
      case 'manual_task_list': {
        const rawScope = str(body.scope);
        const scope = rawScope === 'team' || rawScope === 'created' ? rawScope : 'mine';
        const res = await listManualTasks(sb, {
          scope,
          meUserId: await resolveAppUserId(sb, user.userId),
          includeDone: body.include_done === true,
          campaignId: str(body.campaign_id),
          contentId: str(body.content_id),
          goalId: str(body.goal_id),
          projectId: str(body.project_id),
        });
        if ('fail' in res) return res.fail;
        return jsonOk({ manual_tasks: res.rows });
      }

      case 'manual_task_save': {
        const raw = (body.task ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const seriesId = str(raw.series_id);
        const me = await resolveAppUserId(sb, user.userId);
        if (!me) return jsonError(403, 'no marketing profile for this account');

        // Editing ONE existing task (including a single occurrence of a series).
        if (id) {
          const patch: Record<string, unknown> = {};
          for (const k of ['title', 'details', 'due_at', 'assignee_user_id',
            'campaign_id', 'content_id', 'goal_id', 'project_id'] as const) {
            if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k] ?? null;
          }
          if (Object.prototype.hasOwnProperty.call(patch, 'title') && !str(patch.title)) {
            return jsonError(400, 'title is required');
          }
          if (Object.keys(patch).length === 0) return jsonError(400, 'nothing to update');
          // Who holds it BEFORE the edit — a handover notifies the new person,
          // and only a handover does. Re-wording a task someone already has is
          // not an assignment and must not re-interrupt them.
          const before = await sb.from('mos_manual_tasks')
            .select('assignee_user_id').eq('id', id).maybeSingle();
          const bf = dbFail(before.error);
          if (bf) return bf;
          const upd = await sb.from('mos_manual_tasks').update(patch)
            .eq('id', id).select('id, title, due_at, assignee_user_id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'task not found');
          const after = upd.data as { title: string; due_at: string | null; assignee_user_id: string };
          const priorAssignee = (before.data as { assignee_user_id?: string } | null)?.assignee_user_id;
          if (priorAssignee && priorAssignee !== after.assignee_user_id) {
            await notifyTaskAssigned(sb, {
              assignee: after.assignee_user_id,
              actor: me,
              title: after.title,
              dueAt: after.due_at,
              repeating: false,
            });
          }
          return jsonOk({ id });
        }

        const title = str(raw.title);
        if (!title) return jsonError(400, 'title is required');
        const assignee = str(raw.assignee_user_id) ?? me;
        const repeat = raw.repeat && typeof raw.repeat === 'object'
          ? (raw.repeat as Record<string, unknown>)
          : null;

        const links = {
          campaign_id: str(raw.campaign_id),
          content_id: str(raw.content_id),
          goal_id: str(raw.goal_id),
          project_id: str(raw.project_id),
        };

        // A repeating task is a RULE, not a row: the rule is stored once and the
        // materializer turns it into occurrences. Editing the rule replaces the
        // future open occurrences (done ones are history and stay).
        if (repeat) {
          const rule = validateRepeat(repeat);
          if ('error' in rule) return jsonError(400, rule.error);
          const payload = {
            title,
            details: str(raw.details),
            assignee_user_id: assignee,
            ...links,
            ...rule.value,
          };
          let targetSeries = seriesId;
          if (targetSeries) {
            const upd = await sb.from('mos_task_series').update(payload)
              .eq('id', targetSeries).select('id').maybeSingle();
            const f = dbFail(upd.error);
            if (f) return f;
            if (!upd.data) return jsonError(404, 'series not found');
            // Drop the not-yet-started future occurrences so the new rule can
            // regenerate them. Anything already done is untouched history.
            const today = riyadhToday();
            const del = await sb.from('mos_manual_tasks').delete()
              .eq('series_id', targetSeries).eq('status', 'open').gte('occurrence_on', today);
            const df = dbFail(del.error);
            if (df) return df;
          } else {
            const ins = await sb.from('mos_task_series')
              .insert({ ...payload, created_by_user_id: me })
              .select('id').maybeSingle();
            const f = dbFail(ins.error);
            if (f) return f;
            targetSeries = (ins.data as { id: string } | null)?.id ?? null;
          }
          const mat = await sb.rpc('mos_task_series_materialize');
          const mf = dbFail(mat.error);
          if (mf) return mf;
          // ONE notification for the rule, not one per generated occurrence:
          // the materializer opens rows up to a fortnight ahead, so per-occurrence
          // emission would deliver a fortnight of interruptions at once. Editing
          // an existing rule is not a new assignment and stays silent.
          if (!seriesId) {
            await notifyTaskAssigned(sb, {
              assignee,
              actor: me,
              title,
              dueAt: null,
              repeating: true,
            });
          }
          return jsonOk({ series_id: targetSeries, generated: mat.data ?? 0 });
        }

        const ins = await sb.from('mos_manual_tasks').insert({
          title,
          details: str(raw.details),
          assignee_user_id: assignee,
          created_by_user_id: me,
          due_at: str(raw.due_at),
          ...links,
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        await notifyTaskAssigned(sb, {
          assignee,
          actor: me,
          title,
          dueAt: str(raw.due_at),
          repeating: false,
        });
        return jsonOk({ id: (ins.data as { id: string } | null)?.id ?? null });
      }

      case 'manual_task_complete':
      case 'manual_task_reopen':
      case 'manual_task_cancel': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const me = await resolveAppUserId(sb, user.userId);
        const patch: Record<string, unknown> = action === 'manual_task_reopen'
          ? { status: 'open', closed_at: null, closed_by_user_id: null, done_note: null }
          : {
              status: action === 'manual_task_cancel' ? 'cancelled' : 'done',
              done_note: str(body.note),
              closed_at: new Date().toISOString(),
              closed_by_user_id: me,
            };
        const upd = await sb.from('mos_manual_tasks').update(patch)
          .eq('id', id).select('id').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'task not found');
        return jsonOk({ ok: true });
      }

      case 'manual_task_delete': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const del = await sb.from('mos_manual_tasks').delete().eq('id', id).select('id').maybeSingle();
        const f = dbFail(del.error);
        if (f) return f;
        if (!del.data) return jsonError(404, 'task not found');
        return jsonOk({ ok: true });
      }

      case 'task_series_list': {
        const rows = await sb.from('mos_task_series').select('*')
          .order('created_at', { ascending: false }).limit(cap(body.limit, 100, 300));
        const f = dbFail(rows.error);
        if (f) return f;
        return jsonOk({ series: rows.data ?? [] });
      }

      /**
       * Stopping a repeating task. Deactivating (the default) keeps the history
       * and every occurrence already open; `purge_future` also clears the
       * not-yet-started ones so the queue does not carry work nobody will do.
       */
      case 'task_series_stop': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const upd = await sb.from('mos_task_series').update({ is_active: false })
          .eq('id', id).select('id').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'series not found');
        if (body.purge_future === true) {
          const del = await sb.from('mos_manual_tasks').delete()
            .eq('series_id', id).eq('status', 'open').gte('occurrence_on', riyadhToday());
          const df = dbFail(del.error);
          if (df) return df;
        }
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Calendar — what is scheduled, and what is merely due       */
      /* -------------------------------------------------------- */
      case 'calendar': {
        const from = str(body.from);
        const to = str(body.to);
        if (!from || !to) return jsonError(400, 'from and to are required');

        const [pubs, due] = await Promise.all([
          sb.from('mos_publication_v')
            .select('id, content_id, platform, status, scheduled_at, published_at, caption')
            .or(`and(scheduled_at.gte.${from},scheduled_at.lte.${to}),and(published_at.gte.${from},published_at.lte.${to})`)
            .limit(500),
          // Content rows for the dotted chips: a task due date OR a target
          // publish date landing in the window. Fetched together so one query
          // feeds both the «استحقاق» and «مستهدف» chips the client derives.
          sb.from('mos_content_v')
            .select('id, ref, title, content_type_key, status_key, due_at, target_publish_at, owner_role')
            .is('archived_at', null)
            .or(`and(due_at.gte.${from},due_at.lte.${to}),and(target_publish_at.gte.${from},target_publish_at.lte.${to})`)
            .limit(500),
        ]);
        const f = dbFail(pubs.error) ?? dbFail(due.error);
        if (f) return f;

        // Titles for the publication chips — one extra query beats N.
        const ids = Array.from(new Set((pubs.data ?? []).map((p) => (p as unknown as Row).content_id as string)));
        let titles: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('mos_content_v').select('id, ref, title, content_type_key').in('id', ids);
          const tf = dbFail(t.error);
          if (tf) return tf;
          titles = t.data ?? [];
        }
        return jsonOk({ publications: pubs.data ?? [], due: due.data ?? [], titles });
      }

      /* -------------------------------------------------------- */
      /* Campaigns — the spend side                                */
      /* -------------------------------------------------------- */
      case 'campaign_list': {
        const rows = await sb.from('mos_campaign_v').select('*')
          .is('archived_at', null)
          // Hide the Meta-sync HOLDER pseudo-campaign ("Meta — synced"). It is an
          // internal inbox the sync parks freshly-pulled Meta campaigns under, not
          // a real campaign, and it read as a stray "active" row in the list.
          .not('ref', 'like', 'meta-sync:%')
          .order('starts_on', { ascending: false, nullsFirst: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;
        // Attach each campaign's linked goal ids in one extra read (the junction
        // carries only two ids, so a full scan grouped in JS is cheaper than an
        // N+1 or a view rebuild). A campaign with no links gets an empty array.
        const links = await sb.from('mos_campaign_goals').select('campaign_id, goal_id');
        const lf = dbFail(links.error);
        if (lf) return lf;
        const byCampaign = new Map<string, string[]>();
        for (const l of (links.data ?? []) as Array<{ campaign_id: string; goal_id: string }>) {
          const arr = byCampaign.get(l.campaign_id) ?? [];
          arr.push(l.goal_id);
          byCampaign.set(l.campaign_id, arr);
        }
        // Platform sub-lines (design screen 14). Paid campaigns name their
        // executions' ad platforms; organic ones (or paid not launched yet) name
        // the feeds their attributed content publishes to. Computed HERE in three
        // bounded, campaign-scoped reads — the list used to resolve these on the
        // client with one full `campaign_detail` per row plus a `publication_list`,
        // an N+1 that saturated the browser's connection limit and the DB and
        // froze the whole workspace on mobile (the "entering Campaigns hangs" bug).
        const listRows = (rows.data ?? []) as Array<{ id: string; kind?: string; status?: string }>;
        const ids = listRows.map((c) => c.id);
        const platformsByCampaign = new Map<string, Set<string>>();
        // Live status derived from a campaign's executions (real platform state),
        // so a hand-set "planning" campaign whose ads are actually running on Meta
        // stops reading as planning. running > paused > null.
        const liveByCampaign = new Map<string, { running: boolean; synced: boolean }>();
        if (ids.length > 0) {
          const [execRows, contentRows] = await Promise.all([
            sb.from('mos_campaign_executions').select('campaign_id, platform, status, platform_campaign_id').in('campaign_id', ids),
            sb.from('mos_content_v').select('id, campaign_id').in('campaign_id', ids).is('archived_at', null),
          ]);
          const ef = dbFail(execRows.error) ?? dbFail(contentRows.error);
          if (ef) return ef;
          const execByCampaign = new Map<string, Set<string>>();
          for (const r of (execRows.data ?? []) as Array<{ campaign_id: string; platform: string | null; status: string | null; platform_campaign_id: string | null }>) {
            // Live-status accumulation: any execution counts (a synced Meta
            // campaign has a platform_campaign_id and a running/paused status).
            const live = liveByCampaign.get(r.campaign_id) ?? { running: false, synced: false };
            if (r.status === 'running') live.running = true;
            if (r.platform_campaign_id) live.synced = true;
            liveByCampaign.set(r.campaign_id, live);
            if (!r.platform) continue;
            const s = execByCampaign.get(r.campaign_id) ?? new Set<string>();
            s.add(r.platform);
            execByCampaign.set(r.campaign_id, s);
          }
          const campaignByContent = new Map<string, string>();
          const contentIds: string[] = [];
          for (const r of (contentRows.data ?? []) as Array<{ id: string; campaign_id: string | null }>) {
            if (!r.campaign_id) continue;
            campaignByContent.set(r.id, r.campaign_id);
            contentIds.push(r.id);
          }
          const pubByCampaign = new Map<string, Set<string>>();
          if (contentIds.length > 0) {
            const pubRows = await sb.from('mos_publications')
              .select('content_id, platform, status').in('content_id', contentIds);
            const pf = dbFail(pubRows.error);
            if (pf) return pf;
            for (const p of (pubRows.data ?? []) as Array<{ content_id: string; platform: string | null; status: string | null }>) {
              if (!p.platform || p.status === 'cancelled') continue;
              const cid = campaignByContent.get(p.content_id);
              if (!cid) continue;
              const s = pubByCampaign.get(cid) ?? new Set<string>();
              s.add(p.platform);
              pubByCampaign.set(cid, s);
            }
          }
          for (const c of listRows) {
            // Paid: executions' ad platforms. Empty (organic, or a paid campaign
            // with no executions yet) falls back to the attributed content's feeds.
            const execSet = c.kind === 'paid' ? execByCampaign.get(c.id) : undefined;
            const set = execSet && execSet.size > 0 ? execSet : (pubByCampaign.get(c.id) ?? new Set<string>());
            platformsByCampaign.set(c.id, set);
          }
        }
        const campaigns = listRows.map((c) => ({
          ...c,
          goal_ids: byCampaign.get(c.id) ?? [],
          platforms: Array.from(platformsByCampaign.get(c.id) ?? []),
          live_status: deriveLiveStatus(c.status, liveByCampaign.get(c.id)),
        }));
        return jsonOk({ campaigns });
      }

      case 'campaign_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const [item, execs, content, comments, events, goalLinks] = await Promise.all([
          // Merged read: the view's aggregates + the base row's brief and
          // signature columns (see readCampaignMerged).
          readCampaignMerged(sb, id),
          sb.from('mos_campaign_executions').select('*').eq('campaign_id', id)
            .order('created_at', { ascending: true }),
          sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).eq('campaign_id', id)
            .is('archived_at', null).limit(300),
          sb.from('mos_comments').select('*').eq('campaign_id', id)
            .order('created_at', { ascending: true }).limit(200),
          sb.from('mos_campaign_events').select('*').eq('campaign_id', id)
            .order('created_at', { ascending: false }).limit(200),
          // The goals this campaign serves, joined to their record for names.
          sb.from('mos_campaign_goals').select('goal_id, mos_goals(*)')
            .eq('campaign_id', id),
        ]);
        const f = dbFail(item.error) ?? dbFail(execs.error)
          ?? dbFail(content.error) ?? dbFail(comments.error) ?? dbFail(events.error)
          ?? dbFail(goalLinks.error);
        if (f) return f;
        if (!item.row) return jsonError(404, 'campaign not found');
        const goals = ((goalLinks.data ?? []) as Array<{ goal_id: string; mos_goals: unknown }>)
          .map((l) => l.mos_goals)
          .filter((g): g is Record<string, unknown> => g !== null && typeof g === 'object');
        const goalIds = ((goalLinks.data ?? []) as Array<{ goal_id: string }>).map((l) => l.goal_id);
        const detailLive = { running: false, synced: false };
        for (const e of (execs.data ?? []) as Array<{ status?: string | null; platform_campaign_id?: string | null }>) {
          if (e.status === 'running') detailLive.running = true;
          if (e.platform_campaign_id) detailLive.synced = true;
        }
        const itemRow = item.row as Record<string, unknown>;
        return jsonOk({
          item: {
            ...itemRow,
            goal_ids: goalIds,
            live_status: deriveLiveStatus(itemRow.status as string | undefined, detailLive),
          },
          executions: execs.data ?? [],
          content: content.data ?? [],
          comments: comments.data ?? [],
          events: events.data ?? [],
          goals,
        });
      }

      case 'campaign_save': {
        const raw = (body.campaign ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        // Goals are a MANY-TO-MANY link, not a column — pulled out of the patch
        // and synced into mos_campaign_goals after the row is written. `undefined`
        // (key absent) means "leave the links untouched"; an array (even empty on
        // an existing campaign) replaces them.
        const goalIdsProvided = Object.prototype.hasOwnProperty.call(raw, 'goal_ids');
        const goalIds = goalIdsProvided && Array.isArray(raw.goal_ids)
          ? Array.from(new Set((raw.goal_ids as unknown[])
              .filter((v): v is string => typeof v === 'string' && v.length > 0)))
          : [];
        const patch: Record<string, unknown> = {};
        for (const k of ['name', 'project_id', 'project_ids', 'objective', 'status', 'starts_on',
                         'ends_on', 'budget_total', 'note',
                         'kind', 'goal', 'owner_role', 'success_metric',
                         'success_threshold',
                         // The brief (screen 19): who it's for, what it offers,
                         // where it lands, how it's measured.
                         'audience', 'audience_id', 'offer', 'destination_url', 'measured_by'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // Multi-project: normalize the array and re-derive the primary project_id.
        applyProjectIds(patch);

        // Audience: when a saved record is chosen, SNAPSHOT its name into the
        // `audience` text column so every join-free reader (the brief read grid,
        // search's `audience` match, list/overview) keeps rendering a concise
        // label — the same posture as success_measures. Clearing the link
        // (audience_id = null) leaves whatever free text the client sent.
        if (Object.prototype.hasOwnProperty.call(patch, 'audience_id')) {
          const audienceId = str(patch.audience_id);
          patch.audience_id = audienceId; // normalize '' → null
          if (audienceId) {
            const aud = await sb.from('mos_audiences').select('name').eq('id', audienceId).maybeSingle();
            const af = dbFail(aud.error);
            if (af) return af;
            if (!aud.data) return jsonError(400, 'audience not found');
            patch.audience = (aud.data as { name: string }).name;
          }
        }

        // Multi-measure success criteria: sanitize the array to the known shape
        // and derive the back-compat primary (success_metric / success_threshold
        // = the first measure) so the list / overview / judgment reads that still
        // consult the scalar pair keep working unchanged.
        if (Object.prototype.hasOwnProperty.call(raw, 'success_measures') && Array.isArray(raw.success_measures)) {
          const clean = (raw.success_measures as unknown[])
            .map((e) => {
              const o = (e ?? {}) as Record<string, unknown>;
              return {
                type_key: str(o.type_key) ?? '',
                label_ar: str(o.label_ar) ?? '',
                label_en: str(o.label_en) ?? '',
                direction: o.direction === 'lower' ? 'lower' : 'higher',
                unit: o.unit === 'currency' ? 'currency' : o.unit === 'percent' ? 'percent' : 'count',
                source: MEASURE_SOURCES.includes(str(o.source) ?? '') ? (str(o.source) as string) : 'none',
                threshold: numOrNull(o.threshold),
              };
            })
            .filter((m) => m.type_key !== '');
          patch.success_measures = clean;
          patch.success_metric = clean[0]?.type_key ?? null;
          patch.success_threshold = clean[0]?.threshold ?? null;
        }

        // The signature requirement is DATA (mos_settings.signature_threshold),
        // recomputed on every save so a budget edit can raise — or clear — it.
        const threshold = await readSignatureThreshold(sb);
        const budgetOf = (v: unknown): number | null => numOrNull(v);
        const appUserId = await resolveAppUserId(sb, user.userId);

        if (id) {
          // Read the row first: the requires_signature flip detection (and the
          // budget fallback when this save doesn't carry one) both need it.
          const prev = await sb.from('mos_campaigns')
            .select('id, budget_total, requires_signature').eq('id', id).maybeSingle();
          const prevFail = dbFail(prev.error);
          if (prevFail) return prevFail;
          if (!prev.data) return jsonError(404, 'campaign not found');
          const prevRow = prev.data as { budget_total: unknown; requires_signature: boolean };

          const effectiveBudget = Object.prototype.hasOwnProperty.call(patch, 'budget_total')
            ? budgetOf(patch.budget_total)
            : budgetOf(prevRow.budget_total);
          const requires = effectiveBudget !== null && effectiveBudget >= threshold;
          patch.requires_signature = requires;

          const upd = await sb.from('mos_campaigns').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'campaign not found');

          // The CEO's «ميزانية تنتظر توقيعك» card fires on the false→true flip.
          if (!prevRow.requires_signature && requires) {
            await emitNotify(sb, {
              event: 'budget_signature',
              roles: ['ceo'],
              titleAr: 'ميزانية تنتظر توقيعك',
              titleEn: 'A budget awaits your signature',
              bodyAr: `حملة تجاوزت ميزانيتها حد التوقيع (${threshold} ر.س).`,
              bodyEn: `A campaign budget crossed the signature threshold (${threshold} SAR).`,
              url: `/m/campaigns/${id}`,
            });
          }

          // Sync the campaign↔goal links when the client sent them (an edit that
          // doesn't touch goals omits the key and leaves the links alone). An
          // explicit EMPTY array is refused — a campaign must keep ≥1 goal.
          if (goalIdsProvided) {
            if (goalIds.length === 0) return jsonError(400, 'at least one goal is required');
            const sf = await syncCampaignGoals(sb, id, goalIds);
            if (sf) return sf;
          }
          const finalGoals = await readCampaignGoalIds(sb, id);
          if (finalGoals.error) return finalGoals.error;

          const merged = await readCampaignMerged(sb, id);
          const mergedFail = dbFail(merged.error);
          if (mergedFail) return mergedFail;
          return jsonOk({ item: { ...(merged.row as Record<string, unknown>), goal_ids: finalGoals.ids } });
        }

        // Every campaign must serve at least one goal (the design rule: a
        // campaign is created in service of a goal). The UI enforces this too;
        // this is the server-side guarantee.
        if (goalIds.length === 0) {
          return jsonError(400, 'at least one goal is required');
        }

        // The campaign's identity is its `name` (auto-generated, editable in the
        // UI); `goal` is now an optional free-text description. For back-compat
        // with any caller that still sends only a goal, the name falls back to it.
        if (!str(patch.name) && str(patch.goal)) patch.name = patch.goal;
        if (!str(patch.name)) return jsonError(400, 'goal or name is required');
        const newBudget = budgetOf(patch.budget_total);
        const requires = newBudget !== null && newBudget >= threshold;
        patch.requires_signature = requires;
        patch.created_by_user_id = appUserId;
        const ins = await sb.from('mos_campaigns').insert(patch).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        const created = ins.data as unknown as Row | null;

        // Link the new campaign to its goals (required, validated above).
        if (created?.id) {
          const sf = await syncCampaignGoals(sb, created.id, goalIds);
          if (sf) return sf;
        }

        // "التنفيذات التي ستُنشأ" — the modal's promise, kept server-side in
        // the same request: one DRAFT execution per chosen platform with its
        // budget share. Drafts spend nothing until someone launches them on
        // the platform itself.
        const execs = Array.isArray(body.executions) ? (body.executions as unknown[]) : [];
        if (created?.id && execs.length > 0) {
          const rows = execs
            .map((e) => e as Record<string, unknown>)
            .filter((e) => typeof e.platform === 'string' && e.platform !== '')
            .map((e) => ({
              campaign_id: created.id,
              platform: e.platform,
              label: typeof e.label === 'string' ? e.label : null,
              budget: typeof e.budget === 'number' && Number.isFinite(e.budget) ? e.budget : null,
              status: 'draft',
            }));
          if (rows.length > 0) {
            const execIns = await sb.from('mos_campaign_executions').insert(rows);
            const ef = dbFail(execIns.error);
            if (ef) return ef;
          }
        }

        // A brand-new campaign already over threshold is the false→true flip
        // from the CEO's perspective — they had nothing to sign before.
        if (created?.id && requires) {
          await emitNotify(sb, {
            event: 'budget_signature',
            roles: ['ceo'],
            titleAr: 'ميزانية تنتظر توقيعك',
            titleEn: 'A budget awaits your signature',
            bodyAr: `حملة جديدة تجاوزت ميزانيتها حد التوقيع (${threshold} ر.س).`,
            bodyEn: `A new campaign budget crossed the signature threshold (${threshold} SAR).`,
            url: `/m/campaigns/${created.id}`,
          });
        }

        const merged = await readCampaignMerged(sb, created?.id ?? '');
        const mergedFail = dbFail(merged.error);
        if (mergedFail) return mergedFail;
        return jsonOk({ item: { ...(merged.row as Record<string, unknown>), goal_ids: goalIds } });
      }

      case 'goals_list': {
        const [list, links] = await Promise.all([
          sb.from('mos_goals').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
          sb.from('mos_campaign_goals').select('goal_id'),
        ]);
        const f = dbFail(list.error) ?? dbFail(links.error);
        if (f) return f;
        // Attach a linked-campaign count per goal so the Goals list can show
        // «٣ حملات» without a second round trip.
        const counts = new Map<string, number>();
        for (const l of (links.data ?? []) as Array<{ goal_id: string }>) {
          counts.set(l.goal_id, (counts.get(l.goal_id) ?? 0) + 1);
        }
        const goals = ((list.data ?? []) as Array<{ id: string }>).map((g) => ({
          ...g,
          campaign_count: counts.get(g.id) ?? 0,
        }));
        return jsonOk({ goals });
      }

      case 'goal_save': {
        const raw = (body.goal ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['name', 'description', 'sort_order', 'is_active'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // `name` is the identity shown everywhere — never let it be blanked.
        if (Object.prototype.hasOwnProperty.call(patch, 'name') && !str(patch.name)) {
          return jsonError(400, 'name is required');
        }
        // Multi-measure success criteria — the SAME sanitize as campaign_save
        // (goals have no back-compat scalar pair to derive, so it ends here).
        if (Object.prototype.hasOwnProperty.call(raw, 'success_measures') && Array.isArray(raw.success_measures)) {
          patch.success_measures = (raw.success_measures as unknown[])
            .map((e) => {
              const o = (e ?? {}) as Record<string, unknown>;
              return {
                type_key: str(o.type_key) ?? '',
                label_ar: str(o.label_ar) ?? '',
                label_en: str(o.label_en) ?? '',
                direction: o.direction === 'lower' ? 'lower' : 'higher',
                unit: o.unit === 'currency' ? 'currency' : o.unit === 'percent' ? 'percent' : 'count',
                source: MEASURE_SOURCES.includes(str(o.source) ?? '') ? (str(o.source) as string) : 'none',
                threshold: numOrNull(o.threshold),
              };
            })
            .filter((m) => m.type_key !== '');
        }
        if (id) {
          patch.updated_at = new Date().toISOString();
          const upd = await sb.from('mos_goals').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'goal not found');
        } else {
          if (!str(patch.name)) return jsonError(400, 'name is required');
          patch.created_by_user_id = await resolveAppUserId(sb, user.userId);
          const ins = await sb.from('mos_goals').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const [list, links] = await Promise.all([
          sb.from('mos_goals').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
          sb.from('mos_campaign_goals').select('goal_id'),
        ]);
        const lf = dbFail(list.error) ?? dbFail(links.error);
        if (lf) return lf;
        const counts = new Map<string, number>();
        for (const l of (links.data ?? []) as Array<{ goal_id: string }>) {
          counts.set(l.goal_id, (counts.get(l.goal_id) ?? 0) + 1);
        }
        const goals = ((list.data ?? []) as Array<{ id: string }>).map((g) => ({
          ...g,
          campaign_count: counts.get(g.id) ?? 0,
        }));
        return jsonOk({ goals });
      }

      case 'goal_delete': {
        // Hard-delete one or many goals. Campaign links cascade away in the DB
        // (mos_campaign_goals.goal_id ON DELETE CASCADE) — the campaigns
        // themselves survive, possibly serving fewer goals; series/manual tasks
        // unlink (SET NULL). Goal management is approve_budget territory (same
        // as goal_save and the mos_goals DELETE RLS policy), NOT delete_records.
        const gate = await requireCap(sb, 'approve_budget'); if (gate) return gate;
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        if (ids.length === 0) return jsonError(400, 'ids is required');
        const del = await sb.from('mos_goals').delete().in('id', ids).select('id');
        const df = dbFail(del.error);
        if (df) return df;
        // Return the refreshed list — same convention as goal_save, so the page
        // swaps its rows wholesale without a second round trip.
        const [list, links] = await Promise.all([
          sb.from('mos_goals').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
          sb.from('mos_campaign_goals').select('goal_id'),
        ]);
        const lf = dbFail(list.error) ?? dbFail(links.error);
        if (lf) return lf;
        const counts = new Map<string, number>();
        for (const l of (links.data ?? []) as Array<{ goal_id: string }>) {
          counts.set(l.goal_id, (counts.get(l.goal_id) ?? 0) + 1);
        }
        const goals = ((list.data ?? []) as Array<{ id: string }>).map((g) => ({
          ...g,
          campaign_count: counts.get(g.id) ?? 0,
        }));
        return jsonOk({ goals, deleted: (del.data ?? []).length });
      }

      case 'campaign_delete': {
        // Hard-delete one or many campaigns. Children cascade in the DB
        // (executions + their ads, comments, events, goal links) or unlink
        // (publications, task series, manual tasks — SET NULL). Gated on
        // delete_records for a clean 403; the DELETE RLS policy on
        // mos_campaigns re-enforces it per row.
        const gate = await requireCap(sb, 'delete_records'); if (gate) return gate;
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        if (ids.length === 0) return jsonError(400, 'ids is required');
        const targets = await sb.from('mos_campaigns').select('id, ref, name').in('id', ids);
        const tf = dbFail(targets.error);
        if (tf) return tf;
        const targetRows = (targets.data ?? []) as Array<{ id: string; ref: string | null; name: string }>;
        // The Meta-sync holder is infrastructure — deleting it would cascade
        // every synced execution, and the next sync run would recreate the lot.
        if (targetRows.some((c) => (c.ref ?? '').startsWith('meta-sync:'))) {
          return new Response(
            JSON.stringify({
              error: 'The "Meta — synced" holder campaign is sync infrastructure and cannot be deleted.',
              error_ar: 'حملة «Meta — synced» بنية أساسية للمزامنة ولا يمكن حذفها.',
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // client_attributions RESTRICTs on campaign_id, execution_id AND ad_id —
        // and deleting a campaign cascades into its executions and ads, so an
        // attribution naming ONLY an execution or ad blocks the delete too.
        // Resolve the full spend tree, then pre-check all three columns to name
        // the blockers; the FK still backstops if RLS hides any of this.
        const execs = await sb.from('mos_campaign_executions').select('id, campaign_id').in('campaign_id', ids);
        const ef = dbFail(execs.error);
        if (ef) return ef;
        const execRows = (execs.data ?? []) as Array<{ id: string; campaign_id: string }>;
        const execToCampaign = new Map(execRows.map((e) => [e.id, e.campaign_id]));
        let adRows: Array<{ id: string; execution_id: string | null }> = [];
        if (execRows.length > 0) {
          const ads = await sb.from('mos_execution_ads').select('id, execution_id')
            .in('execution_id', execRows.map((e) => e.id));
          const af = dbFail(ads.error);
          if (af) return af;
          adRows = (ads.data ?? []) as Array<{ id: string; execution_id: string | null }>;
        }
        const adToCampaign = new Map(
          adRows.map((a) => [a.id, a.execution_id ? execToCampaign.get(a.execution_id) ?? null : null]),
        );
        const orParts = [`campaign_id.in.(${ids.join(',')})`];
        if (execRows.length > 0) orParts.push(`execution_id.in.(${execRows.map((e) => e.id).join(',')})`);
        if (adRows.length > 0) orParts.push(`ad_id.in.(${adRows.map((a) => a.id).join(',')})`);
        const linked = await sb.from('client_attributions')
          .select('campaign_id, execution_id, ad_id').or(orParts.join(','));
        const lkf = dbFail(linked.error);
        if (lkf) return lkf;
        const blockedIds = new Set<string>();
        for (const r of (linked.data ?? []) as Array<{ campaign_id: string | null; execution_id: string | null; ad_id: string | null }>) {
          const candidates = [
            r.campaign_id,
            r.execution_id ? execToCampaign.get(r.execution_id) ?? null : null,
            r.ad_id ? adToCampaign.get(r.ad_id) ?? null : null,
          ];
          for (const c of candidates) if (c && ids.includes(c)) blockedIds.add(c);
        }
        const attributionRefusal = (names: string[]): Response => new Response(
          JSON.stringify({
            error: names.length > 0
              ? `Cannot delete: ${names.join(', ')} — linked to client acquisition records. Deselect and retry.`
              : 'A selected campaign is linked to client acquisition records and cannot be deleted. Deselect it and retry.',
            error_ar: names.length > 0
              ? `لا يمكن الحذف: ${names.join('، ')} — مرتبطة بسجلات اكتساب عملاء. ألغِ تحديدها وأعد المحاولة.`
              : 'إحدى الحملات المحددة مرتبطة بسجلات اكتساب عملاء ولا يمكن حذفها. ألغِ تحديدها وأعد المحاولة.',
            blocked: [...blockedIds],
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
        if (blockedIds.size > 0) {
          return attributionRefusal(targetRows.filter((c) => blockedIds.has(c.id)).map((c) => c.name));
        }
        // Delete FIRST — cleanup must never run for a delete that gets refused
        // (a raced attribution insert can still trip the FK backstop below).
        const del = await sb.from('mos_campaigns').delete().in('id', ids).select('id');
        if (del.error) {
          // FK RESTRICT backstop: the whole statement aborts, nothing deleted.
          if (del.error.code === '23503') return attributionRefusal([]);
          const f = dbFail(del.error);
          if (f) return f;
        }
        const deletedIds = ((del.data ?? []) as Array<{ id: string }>).map((r) => r.id);
        if (deletedIds.length > 0) {
          // Post-delete provenance cleanup: mos_content.campaign_id has no FK,
          // so content still points at the now-deleted campaigns. The caller's
          // RLS may lack write_content even with delete_records, so this uses
          // the service client — it only ever nulls references to campaigns
          // that no longer exist (keyed on the ACTUALLY deleted ids).
          const svc = makeServiceClient('api:marketing-os');
          if (svc) {
            const detach = await svc.from('mos_content').update({ campaign_id: null }).in('campaign_id', deletedIds);
            if (detach.error) console.error('campaign_delete: content provenance detach failed', detach.error);
          } else {
            console.error('campaign_delete: service client unavailable — content provenance not detached', deletedIds);
          }
        }
        return jsonOk({ deleted: deletedIds.length });
      }

      case 'execution_save': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');
        const raw = (body.execution ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        let savedId: string | null = id || null;
        const patch: Record<string, unknown> = {};
        for (const k of ['content_id', 'platform', 'account_id', 'label', 'status',
                         'starts_on', 'ends_on', 'budget', 'spend', 'impressions',
                         'clicks', 'leads', 'qualified', 'note',
                         'targeting', 'lead_form_fields',
                         // The platform's own campaign id + what the ad set is
                         // FOR (conversion / awareness / retargeting / traffic).
                         'platform_campaign_id', 'purpose',
                         // Structured per-platform campaign settings (real
                         // Marketing API fields — see adPlatforms schemas).
                         'platform_settings'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'platform_settings')) {
          // Platform comes with the patch (create / modal save) or from the row.
          let settingsPlatform = str(patch.platform);
          if (!settingsPlatform && id) {
            const p = await sb.from('mos_campaign_executions')
              .select('platform').eq('id', id).maybeSingle();
            settingsPlatform = (p.data as { platform?: string } | null)?.platform ?? null;
          }
          const bad = platformSettingsError(settingsPlatform, patch.platform_settings);
          if (bad) {
            return new Response(
              JSON.stringify({ error: bad.en, error_ar: bad.ar }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            );
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'purpose') && patch.purpose !== null
            && !['conversion', 'awareness', 'retargeting', 'traffic'].includes(String(patch.purpose))) {
          return new Response(
            JSON.stringify({
              error: 'Execution purpose must be conversion, awareness, retargeting or traffic.',
              error_ar: 'غرض التنفيذ يجب أن يكون تحويلًا أو وعيًا أو إعادة استهداف أو زيارات.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const appUserId = await resolveAppUserId(sb, user.userId);

        if (id) {
          // The previous status decides which ledger line this save writes.
          const prev = await sb.from('mos_campaign_executions')
            .select('id, status, label, platform').eq('id', id).maybeSingle();
          const prevFail = dbFail(prev.error);
          if (prevFail) return prevFail;
          if (!prev.data) return jsonError(404, 'execution not found');
          const prevRow = prev.data as { status: string; label: string | null; platform: string };

          const upd = await sb.from('mos_campaign_executions').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'execution not found');

          // «ما الذي تغيّر» — pause/resume is a decision someone made, not a
          // number that drifted, so it belongs in the campaign's event ledger.
          const nextStatus = typeof patch.status === 'string' ? patch.status : null;
          if (nextStatus && nextStatus !== prevRow.status) {
            const label = prevRow.label ?? prevRow.platform;
            if (nextStatus === 'paused') {
              await logCampaignEvent(sb, {
                campaignId,
                kind: 'execution_paused',
                summaryAr: `أُوقف التنفيذ «${label}».`,
                summaryEn: `Execution "${label}" paused.`,
                detail: { execution_id: id },
                actorUserId: appUserId,
              });
            } else if (nextStatus === 'running' && prevRow.status === 'paused') {
              await logCampaignEvent(sb, {
                campaignId,
                kind: 'execution_resumed',
                summaryAr: `استُؤنف التنفيذ «${label}».`,
                summaryEn: `Execution "${label}" resumed.`,
                detail: { execution_id: id },
                actorUserId: appUserId,
              });
            }
          }
        } else {
          if (!str(patch.platform)) return jsonError(400, 'platform is required');
          patch.campaign_id = campaignId;
          const ins = await sb.from('mos_campaign_executions').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
          const createdId = (ins.data as unknown as Row | null)?.id ?? null;
          if (createdId) {
            savedId = createdId;
            const label = str(patch.label) ?? String(patch.platform);
            await logCampaignEvent(sb, {
              campaignId,
              kind: 'execution_added',
              summaryAr: `أُضيف تنفيذ جديد: «${label}».`,
              summaryEn: `Execution added: "${label}".`,
              detail: { execution_id: createdId },
              actorUserId: appUserId,
            });
          }
        }
        const list = await sb.from('mos_campaign_executions').select('*')
          .eq('campaign_id', campaignId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        // saved_id lets the caller continue straight into the just-created
        // execution's ad-sets/ads editor without re-finding it in the list.
        return jsonOk({ executions: list.data ?? [], saved_id: savedId });
      }

      /* -------------------------------------------------------- */
      /* Execution detail — the bottom layer, where each AD is a   */
      /* content reference + targeting + a result (screen 21)      */
      /* -------------------------------------------------------- */
      case 'execution_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const exec = await sb.from('mos_campaign_executions').select('*').eq('id', id).maybeSingle();
        const execFail = dbFail(exec.error);
        if (execFail) return execFail;
        if (!exec.data) return jsonError(404, 'execution not found');
        const row = exec.data as unknown as Row;

        const [campaign, ads, daily, adSets] = await Promise.all([
          sb.from('mos_campaign_v').select('*').eq('id', row.campaign_id as string).maybeSingle(),
          sb.from('mos_execution_ads').select('*').eq('execution_id', id)
            .order('created_at', { ascending: true }),
          sb.from('mos_execution_daily').select('*').eq('execution_id', id)
            .order('day', { ascending: false }).limit(90),
          // The ad-set level (synced from Meta or planned) so the execution page
          // can group its ads by ad set instead of showing them flat.
          sb.from('mos_ad_sets').select('*').eq('execution_id', id)
            .is('archived_at', null).order('sort_order', { ascending: true }),
        ]);
        const f = dbFail(campaign.error) ?? dbFail(ads.error) ?? dbFail(daily.error) ?? dbFail(adSets.error);
        if (f) return f;

        // Each ad points at a content record — fetch the referenced rows so the
        // UI can show titles, types, project (for the wrong-project warning) and
        // the workflow state (for the "waiting on approval" note).
        const contentIds = Array.from(new Set(
          (ads.data ?? [])
            .map((a) => (a as unknown as Row).content_id as string | null)
            .filter((c): c is string => Boolean(c)),
        ));
        let adContent: unknown[] = [];
        if (contentIds.length > 0) {
          const c = await sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).in('id', contentIds);
          const cf = dbFail(c.error);
          if (cf) return cf;
          adContent = c.data ?? [];
        }

        return jsonOk({
          execution: exec.data,
          campaign: campaign.data,
          ads: ads.data ?? [],
          ad_content: adContent,
          daily: daily.data ?? [],
          ad_sets: adSets.data ?? [],
        });
      }

      case 'ad_save': {
        const executionId = str(body.execution_id);
        if (!executionId) return jsonError(400, 'execution_id is required');
        const raw = (body.ad ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['content_id', 'label', 'status', 'spend', 'impressions',
                         'clicks', 'leads', 'qualified', 'note',
                         // Identity: external Meta/TikTok/… Ad ID (the key an
                         // inbound Click-to-WhatsApp lead resolves against) and
                         // the ad-set this ad belongs to.
                         'platform_ad_id', 'ad_set_id',
                         // Ad-level platform creative (format, copy, CTA,
                         // destination) — see adPlatforms adSections.
                         'creative'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'creative')) {
          const bad = flatJsonbError('creative', patch.creative);
          if (bad) {
            return new Response(
              JSON.stringify({ error: bad.en, error_ar: bad.ar }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            );
          }
        }
        if (id) {
          const upd = await sb.from('mos_execution_ads').update(patch).eq('id', id).select('id').maybeSingle();
          const uf = dbFail(upd.error);
          if (uf) return uf;
          if (!upd.data) return jsonError(404, 'ad not found');
        } else {
          patch.execution_id = executionId;
          const ins = await sb.from('mos_execution_ads').insert(patch).select('id').maybeSingle();
          const inf = dbFail(ins.error);
          if (inf) return inf;
        }
        // If this ad now carries an external Meta Ad ID, back-fill any WhatsApp
        // conversation that captured that id before the ad record existed
        // (preserve-then-resolve — see mos_reresolve_first_touch).
        const savedAdId = str(raw.platform_ad_id);
        if (savedAdId) {
          const rr = await sb.rpc('mos_reresolve_first_touch', { p_platform_ad_id: savedAdId });
          if (rr.error) console.error('[marketing-os] mos_reresolve_first_touch failed:', rr.error.message);
        }
        const list = await sb.from('mos_execution_ads').select('*')
          .eq('execution_id', executionId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ ads: list.data ?? [] });
      }

      case 'ad_delete': {
        const id = str(body.id);
        const executionId = str(body.execution_id);
        if (!id || !executionId) return jsonError(400, 'id and execution_id are required');
        const del = await sb.from('mos_execution_ads').delete().eq('id', id);
        const df = dbFail(del.error);
        if (df) return df;
        const list = await sb.from('mos_execution_ads').select('*')
          .eq('execution_id', executionId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ ads: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Nested Campaign→Ad Set→Ad identity tree (one-page entry)  */
      /* -------------------------------------------------------- */
      case 'campaign_tree_get': {
        const executionId = str(body.execution_id);
        if (!executionId) return jsonError(400, 'execution_id is required');
        const exec = await sb.from('mos_campaign_executions')
          .select('id, campaign_id, platform, label, platform_campaign_id')
          .eq('id', executionId).maybeSingle();
        const ef = dbFail(exec.error); if (ef) return ef;
        if (!exec.data) return jsonError(404, 'execution not found');
        const [sets, ads] = await Promise.all([
          sb.from('mos_ad_sets').select('id, name, platform_adset_id, status, sort_order')
            .eq('execution_id', executionId).is('archived_at', null)
            .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
          sb.from('mos_execution_ads').select('id, label, platform_ad_id, ad_set_id, content_id, status, creative')
            .eq('execution_id', executionId).is('archived_at', null)
            .order('created_at', { ascending: true }),
        ]);
        const sf = dbFail(sets.error); if (sf) return sf;
        const af = dbFail(ads.error); if (af) return af;
        return jsonOk({ execution: exec.data, ad_sets: sets.data ?? [], ads: ads.data ?? [] });
      }

      case 'campaign_tree_save': {
        const executionId = str(body.execution_id);
        if (!executionId) return jsonError(400, 'execution_id is required');
        const exec = await sb.from('mos_campaign_executions').select('id').eq('id', executionId).maybeSingle();
        const ef = dbFail(exec.error); if (ef) return ef;
        if (!exec.data) return jsonError(404, 'execution not found');
        const orNull = (v: unknown): string | null => { const s = str(v); return s ? s : null; };

        // Campaign external id lives on the execution — set it only when sent.
        if (Object.prototype.hasOwnProperty.call(body, 'platform_campaign_id')) {
          const u = await sb.from('mos_campaign_executions')
            .update({ platform_campaign_id: orNull(body.platform_campaign_id) }).eq('id', executionId);
          const uf = dbFail(u.error); if (uf) return uf;
        }

        const inSets = Array.isArray(body.ad_sets) ? (body.ad_sets as Array<Record<string, unknown>>) : [];
        const keptSetIds: string[] = [];
        const keptAdIds: string[] = [];
        const reresolve = new Set<string>();

        for (let si = 0; si < inSets.length; si++) {
          const s = inSets[si] ?? {};
          const name = str(s.name);
          if (!name) return jsonError(400, 'each ad set needs a name');
          const setPatch = {
            execution_id: executionId,
            name,
            platform_adset_id: orNull(s.platform_adset_id),
            sort_order: si,
            status: str(s.status) || 'active',
          };
          let setId = str(s.id);
          if (setId) {
            const u = await sb.from('mos_ad_sets').update(setPatch).eq('id', setId).select('id').maybeSingle();
            const uf = dbFail(u.error); if (uf) return uf;
            if (!u.data) return jsonError(404, `ad set ${setId} not found`);
          } else {
            const ins = await sb.from('mos_ad_sets').insert(setPatch).select('id').maybeSingle();
            const inf = dbFail(ins.error); if (inf) return inf;
            setId = str((ins.data as { id?: string } | null)?.id);
          }
          if (setId) keptSetIds.push(setId);

          const inAds = Array.isArray(s.ads) ? (s.ads as Array<Record<string, unknown>>) : [];
          for (const a of inAds) {
            const label = str(a.label);
            if (!label) return jsonError(400, 'each ad needs a name');
            const adPatch: Record<string, unknown> = {
              execution_id: executionId,
              ad_set_id: setId || null,
              label,
              platform_ad_id: orNull(a.platform_ad_id),
              content_id: orNull(a.content_id),
              status: str(a.status) || 'running',
            };
            // Ad-level creative (caption/message etc.) — same jsonb column the
            // per-ad AdModal writes. Only set when sent, and validate it.
            if (Object.prototype.hasOwnProperty.call(a, 'creative')) {
              const bad = flatJsonbError('creative', a.creative);
              if (bad) {
                return new Response(
                  JSON.stringify({ error: bad.en, error_ar: bad.ar }),
                  { status: 400, headers: { 'Content-Type': 'application/json' } },
                );
              }
              adPatch.creative = a.creative;
            }
            let adId = str(a.id);
            if (adId) {
              const u = await sb.from('mos_execution_ads').update(adPatch).eq('id', adId).select('id').maybeSingle();
              const uf = dbFail(u.error); if (uf) return uf;
              if (!u.data) return jsonError(404, `ad ${adId} not found`);
            } else {
              const ins = await sb.from('mos_execution_ads').insert(adPatch).select('id').maybeSingle();
              const inf = dbFail(ins.error); if (inf) return inf;
              adId = str((ins.data as { id?: string } | null)?.id);
            }
            if (adId) keptAdIds.push(adId);
            const pid = orNull(a.platform_ad_id);
            if (pid) reresolve.add(pid);
          }
        }

        // Soft-archive rows dropped from the tree (never hard-delete — a past
        // lead's first_touch resolves through these rows).
        const nowIso = new Date().toISOString();
        {
          let q = sb.from('mos_execution_ads').update({ archived_at: nowIso })
            .eq('execution_id', executionId).is('archived_at', null);
          if (keptAdIds.length) q = q.not('id', 'in', `(${keptAdIds.join(',')})`);
          const arch = await q; const af = dbFail(arch.error); if (af) return af;
        }
        {
          let q = sb.from('mos_ad_sets').update({ archived_at: nowIso })
            .eq('execution_id', executionId).is('archived_at', null);
          if (keptSetIds.length) q = q.not('id', 'in', `(${keptSetIds.join(',')})`);
          const arch = await q; const af = dbFail(arch.error); if (af) return af;
        }

        for (const pid of reresolve) {
          const rr = await sb.rpc('mos_reresolve_first_touch', { p_platform_ad_id: pid });
          if (rr.error) console.error('[marketing-os] mos_reresolve_first_touch failed:', rr.error.message);
        }

        const [execRow, setsRow, adsRow] = await Promise.all([
          sb.from('mos_campaign_executions').select('id, campaign_id, platform, label, platform_campaign_id').eq('id', executionId).maybeSingle(),
          sb.from('mos_ad_sets').select('id, name, platform_adset_id, status, sort_order').eq('execution_id', executionId).is('archived_at', null).order('sort_order', { ascending: true }),
          sb.from('mos_execution_ads').select('id, label, platform_ad_id, ad_set_id, content_id, status, creative').eq('execution_id', executionId).is('archived_at', null).order('created_at', { ascending: true }),
        ]);
        return jsonOk({ execution: execRow.data, ad_sets: setsRow.data ?? [], ads: adsRow.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Meta Marketing API — sync OUR ad account + manage ads.    */
      /* Reads are open to any 'read' role; every WRITE (sync,      */
      /* toggle, link, status, create, update) is gated on          */
      /* manage_paid_ads because its effect lands on live Meta.     */
      /* -------------------------------------------------------- */
      case 'meta_account': {
        // Read-only status panel: is Meta wired, and the last sync state.
        const cfg = loadMetaConfig();
        if (!cfg) return jsonOk({ configured: false });
        const state = await sb.from('mos_meta_sync_state')
          .select('is_enabled, currency, last_synced_at, last_result, last_error, holder_campaign_id')
          .eq('ad_account_id', cfg.adAccountId).maybeSingle();
        const sf = dbFail(state.error); if (sf) return sf;
        return jsonOk({ configured: true, ad_account_id: cfg.adAccountId, state: state.data ?? null });
      }

      case 'meta_saved_audiences': {
        // Option B: list the Saved Audiences the buyer built in Ads Manager so a
        // Wassel audience can be linked to one. Read of Meta data → manage_paid_ads.
        const gate = await requireCap(sb, 'manage_paid_ads'); if (gate) return gate;
        const cfg = loadMetaConfig(); if (!cfg) return jsonError(400, 'Meta not configured');
        try {
          const audiences = await new MetaMarketingClient(cfg).listSavedAudiences();
          return jsonOk({
            audiences: audiences.map((a) => ({
              id: a.id,
              name: a.name,
              targeting: a.targeting ?? null,
              approx_lower: a.approximate_count_lower_bound ?? null,
              approx_upper: a.approximate_count_upper_bound ?? null,
            })),
          });
        } catch (e) {
          return jsonError(502, `Meta saved audiences failed: ${metaErr(e)}`);
        }
      }

      case 'meta_sync': {
        const gate = await requireCap(sb, 'manage_paid_ads'); if (gate) return gate;
        const svc = makeServiceClient('api:meta-sync');
        if (!svc) return jsonError(500, 'service client unavailable');
        const result = await runMetaSync(svc);
        if (!result.ok && result.error) return jsonError(502, `Meta sync failed: ${result.error}`);
        return jsonOk(result);
      }

      case 'meta_toggle': {
        const gate = await requireCap(sb, 'manage_paid_ads'); if (gate) return gate;
        const cfg = loadMetaConfig(); if (!cfg) return jsonError(400, 'Meta not configured');
        const enabled = body.enabled === true;
        const svc = makeServiceClient('api:meta-sync'); if (!svc) return jsonError(500, 'service client unavailable');
        const up = await svc.from('mos_meta_sync_state')
          .upsert({ ad_account_id: cfg.adAccountId, is_enabled: enabled }, { onConflict: 'ad_account_id' });
        const f = dbFail(up.error); if (f) return f;
        return jsonOk({ ok: true, is_enabled: enabled });
      }

      case 'meta_link_execution': {
        // Link a synced Meta execution to a real project campaign, then force
        // re-resolve every chat_messages row for that execution's ads so their
        // attribution snapshot points at the newly-linked project.
        const gate = await requireCap(sb, 'manage_paid_ads'); if (gate) return gate;
        const executionId = str(body.execution_id);
        const campaignId = str(body.campaign_id);
        if (!executionId || !campaignId) return jsonError(400, 'execution_id and campaign_id are required');
        const mv = await sb.from('mos_campaign_executions')
          .update({ campaign_id: campaignId, updated_at: new Date().toISOString() })
          .eq('id', executionId).eq('platform', 'meta').select('id').maybeSingle();
        const mf = dbFail(mv.error); if (mf) return mf;
        if (!mv.data) return jsonError(404, 'meta execution not found');
        const svc = makeServiceClient('api:meta-sync'); if (!svc) return jsonError(500, 'service client unavailable');
        const rr = await svc.rpc('mos_meta_force_reresolve_execution', { p_execution_id: executionId });
        if (rr.error) console.error('[marketing-os] force reresolve failed:', rr.error.message);
        return jsonOk({ ok: true, reresolved: rr.data ?? null });
      }

      case 'meta_set_status': {
        const gate = await requireCap(sb, 'manage_paid_ads'); if (gate) return gate;
        const nodeId = str(body.node_id);      // Meta campaign / ad set / ad id
        const status = str(body.status);       // 'ACTIVE' | 'PAUSED'
        if (!nodeId || (status !== 'ACTIVE' && status !== 'PAUSED')) {
          return jsonError(400, 'node_id and status (ACTIVE|PAUSED) are required');
        }
        const cfg = loadMetaConfig(); if (!cfg) return jsonError(400, 'Meta not configured');
        try {
          await new MetaMarketingClient(cfg).setStatus(nodeId, status);
          return jsonOk({ ok: true, node_id: nodeId, status });
        } catch (e) {
          return jsonError(502, `Meta set status failed: ${metaErr(e)}`);
        }
      }

      // Passthrough create/update — the caller (UI form built from the meta.ts
      // schema, or Claude) supplies a Graph-shaped payload; we never hardcode an
      // incomplete field mapping. validate_only runs Meta's dry-run (no spend,
      // nothing created) — the form's "check" button.
      case 'meta_create': {
        const gate = await requireCap(sb, 'manage_paid_ads'); if (gate) return gate;
        const level = str(body.level);
        const payload = (body.payload && typeof body.payload === 'object')
          ? body.payload as Record<string, unknown> : null;
        const validateOnly = body.validate_only === true;
        if (!payload) return jsonError(400, 'payload is required');
        const cfg = loadMetaConfig(); if (!cfg) return jsonError(400, 'Meta not configured');
        const client = new MetaMarketingClient(cfg);
        try {
          let result: { id: string };
          if (level === 'campaign') result = await client.createCampaign(payload, validateOnly);
          else if (level === 'adset') result = await client.createAdSet(payload, validateOnly);
          else if (level === 'creative') result = await client.createAdCreative(payload);
          else if (level === 'ad') result = await client.createAd(payload, validateOnly);
          else return jsonError(400, 'level must be campaign|adset|creative|ad');
          return jsonOk({ ok: true, level, validate_only: validateOnly, result });
        } catch (e) {
          return jsonError(502, `Meta create ${level} failed: ${metaErr(e)}`);
        }
      }

      case 'meta_update': {
        const gate = await requireCap(sb, 'manage_paid_ads'); if (gate) return gate;
        const nodeId = str(body.node_id);
        const payload = (body.payload && typeof body.payload === 'object')
          ? body.payload as Record<string, unknown> : null;
        if (!nodeId || !payload) return jsonError(400, 'node_id and payload are required');
        const cfg = loadMetaConfig(); if (!cfg) return jsonError(400, 'Meta not configured');
        try {
          const out = await new MetaMarketingClient(cfg).updateNode(nodeId, payload);
          return jsonOk({ ok: true, node_id: nodeId, result: out });
        } catch (e) {
          return jsonError(502, `Meta update failed: ${metaErr(e)}`);
        }
      }

      case 'meta_push_structure': {
        // Build the PLANNED execution (its campaign + ad sets) in Meta as a
        // PAUSED skeleton, then write the returned platform ids straight back
        // onto Wassell so the execution is linked with no manual id typing.
        // Ads/creatives are NOT created here — Meta blocks app-made creatives
        // while the app is in Development mode, so the buyer adds them in Meta
        // and the hourly sync matches them back by platform id.
        const gate = await requireCap(sb, 'manage_paid_ads'); if (gate) return gate;
        const executionId = str(body.execution_id);
        const validateOnly = body.validate_only === true;
        if (!executionId) return jsonError(400, 'execution_id is required');
        const cfg = loadMetaConfig(); if (!cfg) return jsonError(400, 'Meta not configured');

        const execRes = await sb.from('mos_campaign_executions')
          .select('id, campaign_id, platform, label, budget, starts_on, ends_on, targeting, platform_settings, platform_campaign_id')
          .eq('id', executionId).maybeSingle();
        const ef = dbFail(execRes.error); if (ef) return ef;
        const execRow = execRes.data as (PushExecution & { campaign_id: string; platform_campaign_id: string | null }) | null;
        if (!execRow) return jsonError(404, 'execution not found');
        if (execRow.platform !== 'meta' && execRow.platform !== 'instagram') {
          return jsonError(400, 'Only Meta/Instagram executions can be pushed to Meta.');
        }
        if (execRow.platform_campaign_id) {
          return jsonError(409, `This execution is already linked to Meta campaign ${execRow.platform_campaign_id}.`);
        }

        const campRes = await sb.from('mos_campaigns')
          .select('id, ref, name, objective, audience_id').eq('id', execRow.campaign_id).maybeSingle();
        const cf = dbFail(campRes.error); if (cf) return cf;
        const campaign = campRes.data as (PushCampaign & { audience_id: string | null }) | null;
        if (!campaign) return jsonError(404, 'campaign not found');

        // Option B: if the campaign's audience is linked to a Meta Saved Audience,
        // push its cached targeting spec as the ad set targeting (else metaPush
        // falls back to the KSA default and the buyer refines in Meta).
        let audienceTargeting: Record<string, unknown> | null = null;
        if (campaign.audience_id) {
          const audRes = await sb.from('mos_audiences')
            .select('meta_targeting').eq('id', campaign.audience_id).maybeSingle();
          const af = dbFail(audRes.error); if (af) return af;
          const t = (audRes.data as { meta_targeting?: unknown } | null)?.meta_targeting;
          if (t && typeof t === 'object') audienceTargeting = t as Record<string, unknown>;
        }

        const setsRes = await sb.from('mos_ad_sets')
          .select('id, name, platform_adset_id, sort_order').eq('execution_id', executionId)
          .is('archived_at', null).order('sort_order', { ascending: true });
        const sf = dbFail(setsRes.error); if (sf) return sf;
        const adSets = (setsRes.data ?? []) as Array<{ id: string; name: string | null; platform_adset_id: string | null }>;

        const client = new MetaMarketingClient(cfg);
        try {
          // 1) Campaign. We do NOT write platform_campaign_id yet — the execution
          //    is only "linked" once the WHOLE skeleton (campaign + every ad set)
          //    succeeds. Writing it here is what left a failed push showing a
          //    false "linked to Meta" badge over a half-built campaign.
          const campaignPayload = buildCampaignPayload(campaign, execRow);
          const campaignResult = await client.createCampaign(campaignPayload, validateOnly);
          const metaCampaignId = campaignResult.id;

          // 2) Ad sets — one per planned ad set (a single default if none planned).
          const plan = adSets.length
            ? adSets
            : [{ id: null as string | null, name: execRow.label ?? 'Ad set', platform_adset_id: null }];
          const createdSets: Array<{ wassell_ad_set_id: string | null; platform_adset_id: string; name: string }> = [];
          const errors: Array<{ ad_set: string; error: string }> = [];
          for (const s of plan) {
            if (s.platform_adset_id) continue; // already linked — don't duplicate
            try {
              const p = buildAdSetPayload(campaign, execRow, { id: s.id, name: s.name }, metaCampaignId, cfg.pageId, audienceTargeting);
              const asResult = await client.createAdSet(p, validateOnly);
              createdSets.push({ wassell_ad_set_id: s.id, platform_adset_id: asResult.id ?? '(validated)', name: String(p.name) });
            } catch (e) {
              errors.push({ ad_set: s.name ?? '(unnamed)', error: metaErr(e) });
            }
          }

          // 3a) ANY ad set failed → all-or-nothing: undo the campaign in Meta
          //     (deleting a campaign cascades its ad sets) and link NOTHING. The
          //     buyer gets the real Meta rejection so they can fix the plan.
          if (errors.length > 0) {
            if (!validateOnly && metaCampaignId) {
              try { await client.deleteNode(metaCampaignId); }
              catch (delErr) { console.error('[marketing-os] rollback delete failed:', metaErr(delErr)); }
            }
            const first = errors[0];
            return new Response(
              JSON.stringify({
                error: `Meta rejected the ad set "${first?.ad_set}": ${first?.error}. Nothing was created — fix the plan and try again.`,
                error_ar: `رفضت ميتا المجموعة الإعلانية «${first?.ad_set}»: ${first?.error}. لم يُنشأ شيء — صحّح الخطة وأعد المحاولة.`,
              }),
              { status: 422, headers: { 'Content-Type': 'application/json' } },
            );
          }

          // 3b) All succeeded → NOW persist the links (campaign + each ad set).
          if (!validateOnly && metaCampaignId) {
            const up = await sb.from('mos_campaign_executions')
              .update({ platform_campaign_id: metaCampaignId, updated_at: new Date().toISOString() })
              .eq('id', executionId);
            const uf = dbFail(up.error); if (uf) return uf;
            for (const c of createdSets) {
              if (c.wassell_ad_set_id && c.platform_adset_id && c.platform_adset_id !== '(validated)') {
                const su = await sb.from('mos_ad_sets')
                  .update({ platform_adset_id: c.platform_adset_id, updated_at: new Date().toISOString() })
                  .eq('id', c.wassell_ad_set_id);
                if (su.error) console.error('[marketing-os] ad set link write failed:', su.error.message);
              }
            }
          }

          return jsonOk({
            ok: true,
            validate_only: validateOnly,
            campaign: { platform_campaign_id: metaCampaignId, name: String(campaignPayload.name) },
            ad_sets: createdSets,
            errors,
          });
        } catch (e) {
          return jsonError(502, `Meta push failed at campaign: ${metaErr(e)}`);
        }
      }

      case 'daily_save': {
        const executionId = str(body.execution_id);
        const day = str(body.day);
        if (!executionId || !day) return jsonError(400, 'execution_id and day are required');
        const numOrNull = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? v : null;
        const spend = numOrNull(body.spend);
        const leads = numOrNull(body.leads);
        const qualified = numOrNull(body.qualified);
        // Mirrors mos_exec_daily_not_empty so the user gets a sentence.
        if (spend === null && leads === null && qualified === null) {
          return new Response(
            JSON.stringify({
              error: 'Enter at least one number for the day.',
              error_ar: 'أدخل رقمًا واحدًا على الأقل لليوم.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const up = await sb.from('mos_execution_daily').upsert(
          {
            execution_id: executionId,
            day,
            spend,
            leads,
            qualified,
            entered_by_user_id: await resolveAppUserId(sb, user.userId),
          },
          { onConflict: 'execution_id,day' },
        );
        const uf = dbFail(up.error);
        if (uf) return uf;
        const list = await sb.from('mos_execution_daily').select('*')
          .eq('execution_id', executionId).order('day', { ascending: false }).limit(90);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ daily: list.data ?? [] });
      }

      case 'execution_delete': {
        const id = str(body.id);
        const campaignId = str(body.campaign_id);
        if (!id || !campaignId) return jsonError(400, 'id and campaign_id are required');
        const del = await sb.from('mos_campaign_executions').delete().eq('id', id);
        const f = dbFail(del.error);
        if (f) return f;
        const list = await sb.from('mos_campaign_executions').select('*')
          .eq('campaign_id', campaignId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ executions: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* The «ما الذي تغيّر» ledger — append-only                 */
      /* -------------------------------------------------------- */
      case 'campaign_events': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');
        const rows = await sb.from('mos_campaign_events').select('*')
          .eq('campaign_id', campaignId)
          .order('created_at', { ascending: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;
        return jsonOk({ events: rows.data ?? [] });
      }

      case 'campaign_event_add': {
        const campaignId = str(body.campaign_id);
        const kind = str(body.kind);
        const summaryAr = str(body.summary_ar);
        if (!campaignId || !kind || !summaryAr) {
          return jsonError(400, 'campaign_id, kind and summary_ar are required');
        }
        // Mirrors mos_campaign_events_kind_check so the user gets a sentence.
        if (!['budget_shift', 'execution_added', 'execution_paused', 'execution_resumed',
              'content_linked', 'content_unlinked', 'signed', 'note'].includes(kind)) {
          return new Response(
            JSON.stringify({
              error: 'That campaign event kind does not exist.',
              error_ar: 'نوع حدث الحملة غير موجود.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const detail = (body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail))
          ? (body.detail as Record<string, unknown>)
          : {};
        const ins = await sb.from('mos_campaign_events').insert({
          campaign_id: campaignId,
          kind,
          summary_ar: summaryAr,
          summary_en: str(body.summary_en),
          detail,
          actor_user_id: await resolveAppUserId(sb, user.userId),
        }).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ event: ins.data });
      }

      /* -------------------------------------------------------- */
      /* What did this campaign actually produce? The derivation   */
      /* lives in SQL (mos_campaign_outcomes) over the attribution */
      /* ledger; this action also returns the settings it used.    */
      /* -------------------------------------------------------- */
      case 'campaign_outcomes': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');

        const exists = await sb.from('mos_campaigns').select('id').eq('id', campaignId).maybeSingle();
        const existsFail = dbFail(exists.error);
        if (existsFail) return existsFail;
        if (!exists.data) return jsonError(404, 'campaign not found');

        const [outcomes, attrSettings] = await Promise.all([
          sb.rpc('mos_campaign_outcomes', { p_campaign_id: campaignId }),
          sb.from('mos_settings').select('value').eq('key', 'attribution').maybeSingle(),
        ]);
        const f = dbFail(outcomes.error) ?? dbFail(attrSettings.error);
        if (f) return f;
        return jsonOk({
          outcomes: outcomes.data ?? {},
          settings: (attrSettings.data as { value?: unknown } | null)?.value ?? null,
        });
      }

      /* -------------------------------------------------------- */
      /* Budget signature — the CEO's named sign-off               */
      /* -------------------------------------------------------- */
      case 'campaign_sign': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');

        // approve_budget is the capability; the role check narrows it to the
        // people the design hands the pen to (CEO card on s43, manager/admin).
        const [canRes, rolesRes] = await Promise.all([
          sb.rpc('wassell_mos_can', { p_capability: 'approve_budget' }),
          sb.rpc('wassell_mos_roles'),
        ]);
        const gateFail = dbFail(canRes.error) ?? dbFail(rolesRes.error);
        if (gateFail) return gateFail;
        const held = (rolesRes.data as string[] | null) ?? [];
        const maySign = canRes.data === true
          && held.some((r) => ['ceo', 'marketing_manager', 'administrator'].includes(r));
        if (!maySign) {
          return new Response(
            JSON.stringify({
              error: 'Only the CEO can sign a campaign budget.',
              error_ar: 'التوقيع على ميزانية الحملة للرئيس التنفيذي فقط.',
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const appUserId = await resolveAppUserId(sb, user.userId);
        const upd = await sb.from('mos_campaigns')
          .update({ signed_by_user_id: appUserId, signed_at: new Date().toISOString() })
          .eq('id', campaignId).select('id').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'campaign not found');

        await logCampaignEvent(sb, {
          campaignId,
          kind: 'signed',
          summaryAr: 'وُقّعت ميزانية الحملة.',
          summaryEn: 'Campaign budget signed.',
          actorUserId: appUserId,
        });

        const merged = await readCampaignMerged(sb, campaignId);
        const mergedFail = dbFail(merged.error);
        if (mergedFail) return mergedFail;
        return jsonOk({ campaign: merged.row });
      }

      /* -------------------------------------------------------- */
      /* CEO overview (s34) — three questions only: are we         */
      /* producing enough, at what cost, and what came back. NO    */
      /* task lists: the CEO is not a production manager.          */
      /* -------------------------------------------------------- */
      case 'ceo_overview': {
        const periodRaw = str(body.period);
        const period: 'month' | 'quarter' | 'year' =
          periodRaw === 'quarter' || periodRaw === 'year' ? periodRaw : 'month';
        const { weekStart: start, weekEnd: end } = periodBounds(period, null);
        const { weekStart: prevStart, weekEnd: prevEnd } = previousPeriodBounds(period, null);

        // The six calendar months ending this month — the production chart.
        const now = new Date();
        const monthKeys: string[] = [];
        for (let i = 5; i >= 0; i -= 1) {
          const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
          monthKeys.push(d.toISOString().slice(0, 7));
        }
        const sixMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1))
          .toISOString();

        const [publishedNow, publishedPrev, published6m, campaigns, pendingSig, threshold] =
          await Promise.all([
            sb.from('mos_publication_v').select('id', { count: 'exact', head: true })
              .eq('status', 'published')
              .gte('published_at', start).lt('published_at', end),
            sb.from('mos_publication_v').select('id', { count: 'exact', head: true })
              .eq('status', 'published')
              .gte('published_at', prevStart).lt('published_at', prevEnd),
            sb.from('mos_publication_v').select('published_at')
              .eq('status', 'published')
              .gte('published_at', sixMonthsAgo).limit(2000),
            // Campaigns the CEO judges: anything running or recently ended.
            sb.from('mos_campaign_v')
              .select('id, ref, name, status, kind, objective, budget_total, total_spend, total_leads, total_qualified, success_metric, success_threshold, goal, starts_on, ends_on')
              .in('status', ['active', 'paused', 'done'])
              .order('total_spend', { ascending: false, nullsFirst: false })
              .limit(8),
            sb.from('mos_campaigns')
              .select('id, ref, name, budget_total, success_metric, success_threshold, goal')
              .eq('requires_signature', true)
              .is('signed_at', null)
              .is('archived_at', null)
              .order('budget_total', { ascending: false })
              .limit(10),
            readSignatureThreshold(sb),
          ]);
        const f = dbFail(publishedNow.error) ?? dbFail(publishedPrev.error)
          ?? dbFail(published6m.error) ?? dbFail(campaigns.error) ?? dbFail(pendingSig.error);
        if (f) return f;

        // The funnel's bottom half lives in the attribution ledger — aggregate
        // mos_campaign_outcomes over the campaigns on the list.
        const campaignRows = (campaigns.data ?? []) as Array<Record<string, unknown>>;
        const outcomeByCampaign = new Map<string, {
          appointments: number; reservations: number; reservation_value: number;
        }>();
        const outcomeResults = await Promise.all(
          campaignRows.map((c) => sb.rpc('mos_campaign_outcomes', { p_campaign_id: c.id as string })),
        );
        for (let i = 0; i < campaignRows.length; i += 1) {
          const res = outcomeResults[i];
          const camp = campaignRows[i];
          if (!res || !camp) continue;
          const of = dbFail(res.error);
          if (of) return of;
          const o = (res.data ?? {}) as Record<string, unknown>;
          outcomeByCampaign.set(camp.id as string, {
            appointments: typeof o.appointments === 'number' ? o.appointments : 0,
            reservations: typeof o.reservations === 'number' ? o.reservations : 0,
            reservation_value: typeof o.reservation_value === 'number' ? o.reservation_value : 0,
          });
        }

        const totals = campaignRows.reduce<{
          spend: number; committed: number; leads: number; qualified: number;
          appointments: number; reservations: number; reservation_value: number;
        }>(
          (acc, c) => {
            const o = outcomeByCampaign.get(c.id as string);
            acc.spend += typeof c.total_spend === 'number' ? c.total_spend : 0;
            acc.committed += typeof c.budget_total === 'number' ? c.budget_total : 0;
            acc.leads += typeof c.total_leads === 'number' ? c.total_leads : 0;
            acc.qualified += typeof c.total_qualified === 'number' ? c.total_qualified : 0;
            acc.appointments += o?.appointments ?? 0;
            acc.reservations += o?.reservations ?? 0;
            acc.reservation_value += o?.reservation_value ?? 0;
            return acc;
          },
          { spend: 0, committed: 0, leads: 0, qualified: 0, appointments: 0, reservations: 0, reservation_value: 0 },
        );

        const monthCount = new Map<string, number>(monthKeys.map((k): [string, number] => [k, 0]));
        for (const p of published6m.data ?? []) {
          const at = (p as { published_at?: string | null }).published_at;
          if (!at) continue;
          const key = at.slice(0, 7);
          if (monthCount.has(key)) monthCount.set(key, (monthCount.get(key) ?? 0) + 1);
        }

        return jsonOk({
          period,
          period_start: start,
          period_end: end,
          produced: publishedNow.count ?? 0,
          produced_prev: publishedPrev.count ?? 0,
          ...totals,
          campaigns: campaignRows.map((c) => {
            const o = outcomeByCampaign.get(c.id as string);
            const spend = typeof c.total_spend === 'number' ? c.total_spend : 0;
            const reservations = o?.reservations ?? 0;
            return {
              id: c.id,
              ref: c.ref ?? null,
              name: c.name ?? '',
              status: c.status,
              objective: c.objective ?? null,
              starts_on: c.starts_on ?? null,
              spend,
              qualified: typeof c.total_qualified === 'number' ? c.total_qualified : 0,
              reservations,
              cost_per_reservation: reservations > 0 ? Math.round(spend / reservations) : null,
            };
          }),
          production_by_month: monthKeys.map((k) => ({ month: k, count: monthCount.get(k) ?? 0 })),
          pending_signature: pendingSig.data ?? [],
          signature_threshold: threshold,
        });
      }

      /* -------------------------------------------------------- */
      /* Budget shift — move money between executions              */
      /* -------------------------------------------------------- */
      case 'budget_shift': {
        const campaignId = str(body.campaign_id);
        const fromId = str(body.from_execution_id);
        const toId = str(body.to_execution_id);
        const amount = numOrNull(body.amount);
        if (!campaignId || !fromId || !toId) {
          return jsonError(400, 'campaign_id, from_execution_id and to_execution_id are required');
        }
        if (fromId === toId) return jsonError(400, 'from and to executions must differ');
        if (amount === null || amount <= 0) {
          return jsonError(400, 'amount must be a positive number');
        }

        const execs = await sb.from('mos_campaign_executions')
          .select('id, campaign_id, budget, label, platform')
          .in('id', [fromId, toId]);
        const execsFail = dbFail(execs.error);
        if (execsFail) return execsFail;
        const rows = (execs.data ?? []) as unknown as Array<{
          id: string; campaign_id: string; budget: number | null; label: string | null; platform: string;
        }>;
        const from = rows.find((r) => r.id === fromId);
        const to = rows.find((r) => r.id === toId);
        if (!from || !to || from.campaign_id !== campaignId || to.campaign_id !== campaignId) {
          return jsonError(404, 'execution not found in this campaign');
        }
        const fromBudget = numOrNull(from.budget);
        if (fromBudget === null || fromBudget < amount) {
          return new Response(
            JSON.stringify({
              error: 'The source execution does not have enough budget for this shift.',
              error_ar: 'ميزانية التنفيذ المصدر لا تكفي لهذا التحويل.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Two conditional updates, each re-checking the budget it relies on so
        // a concurrent shift cannot push the source negative. (PostgREST has no
        // multi-statement transaction; the guards are the atomicity we can get
        // without a dedicated RPC.)
        const dec = await sb.from('mos_campaign_executions')
          .update({ budget: fromBudget - amount })
          .eq('id', fromId).eq('budget', fromBudget).select('id').maybeSingle();
        const decFail = dbFail(dec.error);
        if (decFail) return decFail;
        if (!dec.data) {
          return new Response(
            JSON.stringify({
              error: 'The source budget changed while shifting; try again.',
              error_ar: 'تغيّرت ميزانية المصدر أثناء التحويل؛ حاول مجددًا.',
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const inc = await sb.from('mos_campaign_executions')
          .update({ budget: (numOrNull(to.budget) ?? 0) + amount })
          .eq('id', toId);
        const incFail = dbFail(inc.error);
        if (incFail) return incFail;

        await logCampaignEvent(sb, {
          campaignId,
          kind: 'budget_shift',
          summaryAr: `حُوّل مبلغ ${amount} ر.س من «${from.label ?? from.platform}» إلى «${to.label ?? to.platform}».`,
          summaryEn: `Shifted ${amount} SAR from "${from.label ?? from.platform}" to "${to.label ?? to.platform}".`,
          detail: { from_execution_id: fromId, to_execution_id: toId, amount },
          actorUserId: await resolveAppUserId(sb, user.userId),
        });

        const list = await sb.from('mos_campaign_executions').select('*')
          .eq('campaign_id', campaignId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ executions: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Attribution — the append-only client ↔ spend ledger. The  */
      /* list reads the BASE table and flags superseded rows: the  */
      /* effective view (client_attributions_effective) is exactly */
      /* the rows where superseded = false, so one payload serves  */
      /* both the effective list and the audit trail.              */
      /* -------------------------------------------------------- */
      case 'attribution_list': {
        const campaignId = str(body.campaign_id);
        const clientRecordId = str(body.client_record_id);
        if (!campaignId && !clientRecordId) {
          return jsonError(400, 'campaign_id or client_record_id is required');
        }

        // Filters before transforms — .order()/.limit() would drop .eq()/.or().
        let q = sb.from('client_attributions').select('*');
        if (clientRecordId) q = q.eq('client_record_id', clientRecordId);
        if (campaignId) {
          // A row attributes to the campaign directly, through one of its
          // executions, or through an ad of one of its executions — the same
          // three paths mos_campaign_outcomes walks.
          const execs = await sb.from('mos_campaign_executions')
            .select('id').eq('campaign_id', campaignId).limit(500);
          const execsFail = dbFail(execs.error);
          if (execsFail) return execsFail;
          const execIds = (execs.data ?? []).map((e) => (e as unknown as Row).id);
          let adIds: string[] = [];
          if (execIds.length > 0) {
            const ads = await sb.from('mos_execution_ads').select('id').in('execution_id', execIds).limit(1000);
            const adsFail = dbFail(ads.error);
            if (adsFail) return adsFail;
            adIds = (ads.data ?? []).map((a) => (a as unknown as Row).id);
          }
          const ors = [`campaign_id.eq.${campaignId}`];
          if (execIds.length > 0) ors.push(`execution_id.in.(${execIds.join(',')})`);
          if (adIds.length > 0) ors.push(`ad_id.in.(${adIds.join(',')})`);
          q = q.or(ors.join(','));
        }
        const rows = await q
          .order('occurred_at', { ascending: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;

        // The supersession flag: a row is superseded when any other row points
        // at it. Asked of the base table so the flag is true even when the
        // correcting row falls outside this filter.
        const data = (rows.data ?? []) as unknown as Array<Row & { supersedes_id: string | null }>;
        const ids = data.map((r) => r.id);
        const supersededIds = new Set<string>();
        if (ids.length > 0) {
          const sup = await sb.from('client_attributions')
            .select('supersedes_id').in('supersedes_id', ids).limit(1000);
          const supFail = dbFail(sup.error);
          if (supFail) return supFail;
          for (const s of (sup.data ?? []) as unknown as Array<{ supersedes_id: string | null }>) {
            if (s.supersedes_id) supersededIds.add(s.supersedes_id);
          }
        }
        return jsonOk({
          rows: data.map((r) => ({ ...r, superseded: supersededIds.has(r.id) })),
        });
      }

      case 'attribution_stamp': {
        const clientRecordId = str(body.client_record_id);
        const occurredAt = str(body.occurred_at);
        const source = str(body.source);
        if (!clientRecordId || !occurredAt || !source) {
          return jsonError(400, 'client_record_id, occurred_at and source are required');
        }
        if (!['lead_form', 'manual', 'import'].includes(source)) {
          return new Response(
            JSON.stringify({
              error: 'Attribution source must be lead_form, manual or import.',
              error_ar: 'مصدر النسبة يجب أن يكون نموذج عميل أو يدويًا أو استيرادًا.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const campaignId = str(body.campaign_id);
        const executionId = str(body.execution_id);
        const adId = str(body.ad_id);
        // Mirrors the table CHECK: a row naming no spend object attributes nothing.
        if (!campaignId && !executionId && !adId) {
          return new Response(
            JSON.stringify({
              error: 'Name at least one of campaign, execution or ad.',
              error_ar: 'حدّد حملة أو تنفيذًا أو إعلانًا واحدًا على الأقل.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const touchType = str(body.touch_type);
        if (touchType && !['first', 'last'].includes(touchType)) {
          return jsonError(400, 'touch_type must be first or last');
        }
        const ins = await sb.from('client_attributions').insert({
          client_record_id: clientRecordId,
          campaign_id: campaignId,
          execution_id: executionId,
          ad_id: adId,
          touch_type: touchType ?? 'first',
          occurred_at: occurredAt,
          source,
          note: str(body.note),
          supersedes_id: str(body.supersedes_id),
          created_by_user_id: await resolveAppUserId(sb, user.userId),
        }).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ row: ins.data });
      }

      /* -------------------------------------------------------- */
      /* Assets — the material library                             */
      /* -------------------------------------------------------- */
      case 'asset_list': {
        let q = sb.from('mos_assets').select('*').is('archived_at', null);
        const kind = str(body.kind);
        const projectId = str(body.project_id);
        const search = str(body.q);
        if (kind) q = q.eq('kind', kind);
        if (projectId) q = q.eq('project_id', projectId);
        if (search) q = q.ilike('title', `%${search}%`);
        const rows = await q.order('created_at', { ascending: false }).limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;

        // Usage comes from the link table, so "unused" is a fact rather than a
        // counter somebody has to remember to decrement.
        const links = await sb.from('mos_asset_links').select('asset_id, content_id, role').limit(2000);
        const lf = dbFail(links.error);
        if (lf) return lf;
        return jsonOk({ assets: rows.data ?? [], links: links.data ?? [] });
      }

      case 'asset_save': {
        const raw = (body.asset ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'kind', 'source', 'project_id', 'file_id', 'url',
                         'thumb_url', 'shot_on', 'tags', 'note',
                         'file_path', 'mime_type', 'size_bytes', 'original_name',
                         'usage_rights', 'shoot_request_id', 'aspect_ratio',
                         'duration_seconds',
                         'shot_by', 'rights_expiry'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_assets').update(patch).eq('id', id).select('*').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'asset not found');
          return jsonOk({ asset: upd.data });
        }
        if (!str(patch.title)) return jsonError(400, 'title is required');
        patch.created_by_user_id = await resolveAppUserId(sb, user.userId);
        const ins = await sb.from('mos_assets').insert(patch).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ asset: ins.data });
      }

      /* -------------------------------------------------------- */
      /* One asset: what uses it, its derivative versions, and     */
      /* whether any publication depends on it (screen 22)         */
      /* -------------------------------------------------------- */
      case 'asset_detail': {
        const assetId = str(body.asset_id);
        if (!assetId) return jsonError(400, 'asset_id is required');

        const asset = await sb.from('mos_assets').select('*').eq('id', assetId).maybeSingle();
        const assetFail = dbFail(asset.error);
        if (assetFail) return assetFail;
        if (!asset.data) return jsonError(404, 'asset not found');
        const row = asset.data as unknown as Row & { parent_asset_id: string | null };

        const links = await sb.from('mos_asset_links')
          .select('asset_id, content_id, role').eq('asset_id', assetId);
        const linksFail = dbFail(links.error);
        if (linksFail) return linksFail;
        const linkRows = (links.data ?? []) as unknown as Array<{
          asset_id: string; content_id: string; role: string;
        }>;
        const contentIds = Array.from(new Set(linkRows.map((l) => l.content_id)));

        const [contents, liveAds, pubsCount, versions] = await Promise.all([
          contentIds.length > 0
            ? sb.from('mos_content_v').select('id, ref, title').in('id', contentIds)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          contentIds.length > 0
            ? sb.from('mos_execution_ads').select('content_id').in('content_id', contentIds).eq('status', 'running')
            : Promise.resolve({ data: [] as unknown[], error: null }),
          contentIds.length > 0
            ? sb.from('mos_publications').select('id', { count: 'exact', head: true })
                .in('content_id', contentIds)
            : Promise.resolve({ count: 0, error: null }),
          // Derivatives of the same root: the parent plus every child cut.
          sb.from('mos_assets').select('id, title, created_at')
            .or(`id.eq.${row.parent_asset_id ?? row.id},parent_asset_id.eq.${row.parent_asset_id ?? row.id}`)
            .order('created_at', { ascending: true }),
        ]);
        const f = dbFail(contents.error) ?? dbFail(liveAds.error)
          ?? dbFail(pubsCount.error) ?? dbFail(versions.error);
        if (f) return f;

        const titleById = new Map(
          ((contents.data ?? []) as unknown as Array<{ id: string; ref: string | null; title: string }>)
            .map((c) => [c.id, c] as const),
        );
        const liveContentIds = new Set(
          ((liveAds.data ?? []) as unknown as Array<{ content_id: string | null }>)
            .map((a) => a.content_id).filter((c): c is string => Boolean(c)),
        );
        const usedIn = linkRows
          .map((l) => ({
            content_id: l.content_id,
            ref: titleById.get(l.content_id)?.ref ?? null,
            title: titleById.get(l.content_id)?.title ?? '',
            role: l.role,
            live_ad: liveContentIds.has(l.content_id),
          }))
          // Deterministic: by content title, then role.
          .sort((a, b) => a.title.localeCompare(b.title) || a.role.localeCompare(b.role));

        return jsonOk({
          asset: asset.data,
          used_in: usedIn,
          versions: versions.data ?? [],
          publications_using: pubsCount.count ?? 0,
        });
      }

      /* -------------------------------------------------------- */
      /* Archive / unarchive. Allowed even while in use — the      */
      /* asset stops appearing in pickers without breaking the     */
      /* record of what shipped.                                   */
      /* -------------------------------------------------------- */
      case 'asset_archive': {
        const assetId = str(body.asset_id);
        if (!assetId) return jsonError(400, 'asset_id is required');
        if (typeof body.archived !== 'boolean') return jsonError(400, 'archived must be a boolean');
        const upd = await sb.from('mos_assets')
          .update({ archived_at: body.archived ? new Date().toISOString() : null })
          .eq('id', assetId).select('*').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'asset not found');
        return jsonOk({ asset: upd.data });
      }

      /* -------------------------------------------------------- */
      /* Delete — blocked while anything references the asset.     */
      /* In use → 409 {error:'in_use', used_in}; unused → real     */
      /* delete (archiving is asset_archive's job).                */
      /* -------------------------------------------------------- */
      case 'asset_delete': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const links = await sb.from('mos_asset_links')
          .select('asset_id, content_id, role').eq('asset_id', id);
        const linksFail = dbFail(links.error);
        if (linksFail) return linksFail;
        const linkRows = (links.data ?? []) as unknown as Array<{
          asset_id: string; content_id: string; role: string;
        }>;
        const contentIds = Array.from(new Set(linkRows.map((l) => l.content_id)));

        let pubsUsing = 0;
        let titleById = new Map<string, { id: string; ref: string | null; title: string }>();
        if (contentIds.length > 0) {
          const [contents, pubsCount] = await Promise.all([
            sb.from('mos_content_v').select('id, ref, title').in('id', contentIds),
            sb.from('mos_publications').select('id', { count: 'exact', head: true })
              .in('content_id', contentIds),
          ]);
          const f = dbFail(contents.error) ?? dbFail(pubsCount.error);
          if (f) return f;
          titleById = new Map(
            ((contents.data ?? []) as unknown as Array<{ id: string; ref: string | null; title: string }>)
              .map((c) => [c.id, c] as const),
          );
          pubsUsing = pubsCount.count ?? 0;
        }

        if (linkRows.length > 0 || pubsUsing > 0) {
          const usedIn = linkRows
            .map((l) => ({
              content_id: l.content_id,
              ref: titleById.get(l.content_id)?.ref ?? null,
              title: titleById.get(l.content_id)?.title ?? '',
              role: l.role,
            }))
            .sort((a, b) => a.title.localeCompare(b.title) || a.role.localeCompare(b.role));
          return new Response(
            JSON.stringify({
              error: 'in_use',
              error_ar: 'المادة مستخدمة في محتوى أو منشورات؛ أرشفها بدل حذفها.',
              used_in: usedIn,
              publications_using: pubsUsing,
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const del = await sb.from('mos_assets').delete().eq('id', id).select('id').maybeSingle();
        const f = dbFail(del.error);
        if (f) return f;
        if (!del.data) return jsonError(404, 'asset not found');
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* The «غير مستخدمة» shelf (s41): not archived, no links,    */
      /* and no publication touches a content it's linked to.      */
      /* -------------------------------------------------------- */
      case 'assets_unused': {
        const [assets, links] = await Promise.all([
          sb.from('mos_assets').select('*').is('archived_at', null)
            .order('created_at', { ascending: false }).limit(cap(body.limit, 200, 500)),
          sb.from('mos_asset_links').select('asset_id, content_id').limit(4000),
        ]);
        const f = dbFail(assets.error) ?? dbFail(links.error);
        if (f) return f;
        const linkRows = (links.data ?? []) as unknown as Array<{ asset_id: string; content_id: string }>;
        const linkedAssetIds = new Set(linkRows.map((l) => l.asset_id));

        // Publications reach assets only through content links — an asset with
        // zero links is already unused, so this only ever refines linked ones.
        const linkedContentIds = Array.from(new Set(linkRows.map((l) => l.content_id)));
        const pubContentIds = new Set<string>();
        if (linkedContentIds.length > 0) {
          const pubs = await sb.from('mos_publications').select('content_id')
            .in('content_id', linkedContentIds).limit(2000);
          const pubsFail = dbFail(pubs.error);
          if (pubsFail) return pubsFail;
          for (const p of (pubs.data ?? []) as unknown as Array<{ content_id: string }>) {
            pubContentIds.add(p.content_id);
          }
        }
        const pubbedAssetIds = new Set(
          linkRows.filter((l) => pubContentIds.has(l.content_id)).map((l) => l.asset_id),
        );

        const rows = ((assets.data ?? []) as unknown as Row[])
          .filter((a) => !linkedAssetIds.has(a.id) && !pubbedAssetIds.has(a.id));
        return jsonOk({ rows });
      }

      /* -------------------------------------------------------- */
      /* Bulk ops on the grid selection (s16): archive, tag, or    */
      /* turn the selection into ONE content item pre-linked to    */
      /* every asset in it.                                        */
      /* -------------------------------------------------------- */
      case 'assets_bulk': {
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
          : [];
        const op = str(body.op);
        if (ids.length === 0) return jsonError(400, 'ids must be a non-empty array');
        if (ids.length > 100) return jsonError(400, 'at most 100 assets per bulk operation');
        if (!op || !['archive', 'tag', 'create_content'].includes(op)) {
          return jsonError(400, 'op must be archive, tag or create_content');
        }

        if (op === 'archive') {
          const upd = await sb.from('mos_assets')
            .update({ archived_at: new Date().toISOString() }).in('id', ids).select('id');
          const f = dbFail(upd.error);
          if (f) return f;
          const done = new Set(((upd.data ?? []) as unknown as Row[]).map((r) => r.id));
          return jsonOk({ results: ids.map((assetId) => ({ id: assetId, ok: done.has(assetId) })) });
        }

        if (op === 'tag') {
          const tag = str(body.tag);
          if (!tag) return jsonError(400, 'tag is required for the tag op');
          const assets = await sb.from('mos_assets').select('id, tags').in('id', ids);
          const f = dbFail(assets.error);
          if (f) return f;
          const results: Array<{ id: string; ok: boolean }> = [];
          for (const a of (assets.data ?? []) as unknown as Array<{ id: string; tags: unknown }>) {
            const current = Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : [];
            const next = current.includes(tag) ? current : [...current, tag];
            const upd = await sb.from('mos_assets').update({ tags: next }).eq('id', a.id);
            // A failed row is reported in results, not swallowed — the UI
            // marks exactly which assets didn't take the tag.
            if (upd.error) {
              console.error('[marketing-os] bulk tag failed for asset', a.id, upd.error.code, upd.error.message);
              results.push({ id: a.id, ok: false });
            } else {
              results.push({ id: a.id, ok: true });
            }
          }
          return jsonOk({ results });
        }

        // create_content — one item carrying every selected asset as source
        // material. Title falls back to the first asset's title.
        const typeKey = str(body.content_type_key);
        if (!typeKey) return jsonError(400, 'content_type_key is required for create_content');
        const typeRes = await sb.from('mos_content_types')
          .select('id, workflow_id').eq('key', typeKey).maybeSingle();
        const typeFail = dbFail(typeRes.error);
        if (typeFail) return typeFail;
        if (!typeRes.data) return jsonError(400, 'unknown content type');
        const type = typeRes.data as { id: string; workflow_id: string | null };

        const assets = await sb.from('mos_assets').select('id, title').in('id', ids);
        const assetsFail = dbFail(assets.error);
        if (assetsFail) return assetsFail;
        const firstTitle = ((assets.data ?? [])[0] as { title?: string } | undefined)?.title;

        const title = str(body.title) ?? str(firstTitle);
        if (!title) return jsonError(400, 'title is required when the selection has none');

        const appUserId = await resolveAppUserId(sb, user.userId);
        const created = await sb.from('mos_content').insert({
          title,
          content_type_id: type.id,
          workflow_id: type.workflow_id,
          created_by_user_id: appUserId,
        }).select('id, ref').maybeSingle();
        const createFail = dbFail(created.error);
        if (createFail) return createFail;
        if (!created.data) return jsonError(500, 'insert returned no row');
        const contentId = (created.data as unknown as Row).id;

        if (type.workflow_id) {
          const openFail = await openFirstTask(sb, contentId, type.workflow_id);
          if (openFail) return openFail;
        }

        const linkRows = ids.map((assetId) => ({ asset_id: assetId, content_id: contentId, role: 'source' }));
        const linkIns = await sb.from('mos_asset_links')
          .upsert(linkRows, { onConflict: 'asset_id,content_id' });
        const linkFail = dbFail(linkIns.error);
        if (linkFail) return linkFail;

        return jsonOk({
          results: ids.map((assetId) => ({ id: assetId, ok: true, content_id: contentId })),
          content_id: contentId,
        });
      }

      case 'asset_link': {
        const assetId = str(body.asset_id);
        const contentId = str(body.content_id);
        if (!assetId || !contentId) return jsonError(400, 'asset_id and content_id are required');
        const role = str(body.role) ?? 'source';
        const up = await sb.from('mos_asset_links')
          .upsert({ asset_id: assetId, content_id: contentId, role }, { onConflict: 'asset_id,content_id' });
        const f = dbFail(up.error);
        if (f) return f;
        const list = await sb.from('mos_asset_links').select('asset_id, content_id, role').eq('content_id', contentId);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ links: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Attach a FILES-library file as content material. The     */
      /* material stays a mos_assets row (so approval/publishing/  */
      /* roles are untouched) — this just find-or-creates the      */
      /* mos_assets WRAPPER for the chosen file and links it.      */
      /* The CONTENT record (mos_content) is never touched.        */
      /* -------------------------------------------------------- */
      case 'asset_link_from_file': {
        const contentId = str(body.content_id);
        const fileId = str(body.file_id);
        if (!contentId || !fileId) return jsonError(400, 'content_id and file_id are required');
        const role = str(body.role) ?? 'source';

        // 1) Find-or-create the mos_assets wrapper for this file.
        const existing = await sb.from('mos_assets')
          .select('*').eq('file_id', fileId).is('archived_at', null).limit(1).maybeSingle();
        const exf = dbFail(existing.error); if (exf) return exf;
        let assetRow = existing.data as Record<string, unknown> | null;

        if (!assetRow) {
          const fileRes = await sb.from('files')
            .select('id, title, original_name, kind, mime_type, size_bytes')
            .eq('id', fileId).maybeSingle();
          const ff = dbFail(fileRes.error); if (ff) return ff;
          const file = fileRes.data as {
            title?: string | null; original_name?: string | null; kind?: string | null;
            mime_type?: string | null; size_bytes?: number | null;
          } | null;
          if (!file) return jsonError(404, 'file not found');
          // Files kind → mos_assets kind vocabulary.
          const KIND_MAP: Record<string, string> = {
            image: 'photo', photo: 'photo', video: 'video', audio: 'audio',
            document: 'document', pdf: 'document',
          };
          const kind = KIND_MAP[(file.kind ?? '').toLowerCase()] ?? 'document';
          const ins = await sb.from('mos_assets').insert({
            title: file.title || file.original_name || 'ملف',
            kind,
            file_id: fileId,
            mime_type: file.mime_type ?? null,
            size_bytes: file.size_bytes ?? null,
            original_name: file.original_name ?? null,
            created_by_user_id: await resolveAppUserId(sb, user.userId),
          }).select('*').maybeSingle();
          const inf = dbFail(ins.error); if (inf) return inf;
          assetRow = ins.data as Record<string, unknown> | null;
        }
        const assetId = str(assetRow?.id);
        if (!assetId) return jsonError(500, 'could not resolve the material for this file');

        // 2) Link the wrapper to the content (idempotent), then return the fresh
        //    links + the asset so the client can render it without a refetch.
        const up = await sb.from('mos_asset_links')
          .upsert({ asset_id: assetId, content_id: contentId, role }, { onConflict: 'asset_id,content_id' });
        const uf = dbFail(up.error); if (uf) return uf;
        const list = await sb.from('mos_asset_links').select('asset_id, content_id, role').eq('content_id', contentId);
        const lf = dbFail(list.error); if (lf) return lf;
        return jsonOk({ links: list.data ?? [], asset: assetRow });
      }

      case 'asset_unlink': {
        const assetId = str(body.asset_id);
        const contentId = str(body.content_id);
        if (!assetId || !contentId) return jsonError(400, 'asset_id and content_id are required');
        const del = await sb.from('mos_asset_links').delete()
          .eq('asset_id', assetId).eq('content_id', contentId);
        const f = dbFail(del.error);
        if (f) return f;
        // Unlinking the material that was submitted for approval clears the
        // pointer, so a later approval can't promote an asset that is no longer
        // attached. The FK is ON DELETE SET NULL only when the ASSET is deleted;
        // an unlink is a link delete, so we clear it here.
        const clear = await sb.from('mos_content')
          .update({ approval_asset_id: null })
          .eq('id', contentId).eq('approval_asset_id', assetId);
        const clearFail = dbFail(clear.error);
        if (clearFail) return clearFail;
        const list = await sb.from('mos_asset_links').select('asset_id, content_id, role').eq('content_id', contentId);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ links: list.data ?? [] });
      }

      // Mark (or clear) the ONE material submitted for approval on a content
      // item. On the next 'approved' task result the API promotes it to a 'final'
      // link (mos_promote_approval_asset). Governed by mos_content UPDATE RLS,
      // the same gate as content_update.
      case 'content_set_approval_asset': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const assetId = str(body.asset_id); // null clears the selection
        if (assetId) {
          const linked = await sb.from('mos_asset_links')
            .select('asset_id').eq('content_id', contentId).eq('asset_id', assetId).maybeSingle();
          const linkFail = dbFail(linked.error);
          if (linkFail) return linkFail;
          if (!linked.data) return jsonError(400, 'asset is not linked to this content');
        }
        const upd = await sb.from('mos_content')
          .update({ approval_asset_id: assetId ?? null })
          .eq('id', contentId).select('id').maybeSingle();
        const updFail = dbFail(upd.error);
        if (updFail) return updFail;
        if (!upd.data) return jsonError(404, 'content item not found');
        return jsonOk({ content_id: contentId, approval_asset_id: assetId ?? null });
      }

      /* -------------------------------------------------------- */
      /* Shoot requests — what missing scenes turn into            */
      /* -------------------------------------------------------- */
      case 'shoot_list': {
        const [reqs, items, shootAssets, links] = await Promise.all([
          sb.from('mos_shoot_requests').select('*')
            .order('created_at', { ascending: false }).limit(cap(body.limit, 100, 300)),
          sb.from('mos_shoot_items').select('*').limit(1000),
          // Delivered files per request — the completed table's «ملفات» count
          // and the usage percentage both come from these.
          sb.from('mos_assets').select('id, shoot_request_id, kind')
            .not('shoot_request_id', 'is', null).is('archived_at', null).limit(2000),
          sb.from('mos_asset_links').select('asset_id, content_id').limit(4000),
        ]);
        const f = dbFail(reqs.error) ?? dbFail(items.error)
          ?? dbFail(shootAssets.error) ?? dbFail(links.error);
        if (f) return f;

        // Every scene still marked missing, whether or not it has been requested
        // yet — the backlog IS the pending shoot list. created_at feeds the
        // "oldest waiting" column that drives the auto-suggest threshold.
        const missing = await sb.from('mos_scenes')
          .select('id, content_id, position, visual, footage_status, created_at')
          .eq('footage_status', 'missing').limit(500);
        const mf = dbFail(missing.error);
        if (mf) return mf;

        const contentIds = Array.from(new Set((missing.data ?? [])
          .map((s) => (s as unknown as Row).content_id as string)));
        let owners: unknown[] = [];
        if (contentIds.length > 0) {
          const o = await sb.from('mos_content_v')
            .select('id, ref, title, project_id, content_type_key').in('id', contentIds);
          const of_ = dbFail(o.error);
          if (of_) return of_;
          owners = o.data ?? [];
        }
        return jsonOk({
          requests: reqs.data ?? [],
          items: items.data ?? [],
          missing_scenes: missing.data ?? [],
          scene_owners: owners,
          shoot_assets: shootAssets.data ?? [],
          asset_links: links.data ?? [],
        });
      }

      /* -------------------------------------------------------- */
      /* Delivery — the wire that makes this NOT Drive. Files      */
      /* arriving is what marks the waiting scenes covered; nobody */
      /* has to notice and connect them by hand.                   */
      /* -------------------------------------------------------- */
      case 'shoot_deliver': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const upd = await sb.from('mos_shoot_requests')
          .update({ status: 'delivered', delivered_at: new Date().toISOString() })
          .eq('id', id).select('id').maybeSingle();
        const uf = dbFail(upd.error);
        if (uf) return uf;
        if (!upd.data) return jsonError(404, 'shoot request not found');

        const itemRows = await sb.from('mos_shoot_items').select('id, scene_id, content_id').eq('request_id', id);
        const irf = dbFail(itemRows.error);
        if (irf) return irf;
        const rows = (itemRows.data ?? []) as unknown as Array<{ id: string; scene_id: string | null }>;

        if (rows.length > 0) {
          const itemsDone = await sb.from('mos_shoot_items')
            .update({ done: true }).eq('request_id', id);
          const idf = dbFail(itemsDone.error);
          if (idf) return idf;

          const sceneIds = rows.map((r) => r.scene_id).filter((s): s is string => Boolean(s));
          if (sceneIds.length > 0) {
            // The scenes that were waiting on this shoot are now covered. If a
            // shot was actually missed, downgrading it back is one click —
            // correction is the exception, connecting is the default.
            const scenes = await sb.from('mos_scenes')
              .update({ footage_status: 'have' }).in('id', sceneIds);
            const sf = dbFail(scenes.error);
            if (sf) return sf;
          }
        }

        const [reqsAfter, itemsAfter] = await Promise.all([
          sb.from('mos_shoot_requests').select('*').order('created_at', { ascending: false }).limit(300),
          sb.from('mos_shoot_items').select('*').limit(1000),
        ]);
        const rf = dbFail(reqsAfter.error) ?? dbFail(itemsAfter.error);
        if (rf) return rf;

        // «وصل التصوير» — the contents whose scenes this shoot covered are
        // unblocked; interrupt whoever holds their open task.
        const shootContentIds = Array.from(new Set(
          ((itemRows.data ?? []) as unknown as Array<{ content_id: string | null }>)
            .map((r) => r.content_id).filter((c): c is string => Boolean(c)),
        ));
        if (shootContentIds.length > 0) {
          const openTasks = await sb.from('workflow_role_tasks')
            .select('subject_id, role_key, assignee_user_id')
            .eq('subject_table', 'mos_content')
            .in('subject_id', shootContentIds)
            .eq('status', 'open');
          if (openTasks.error) {
            console.error('[marketing-os] open-task read for shoot_delivered failed',
              openTasks.error.code, openTasks.error.message);
          } else {
            const taskRows = (openTasks.data ?? []) as unknown as Array<{
              subject_id: string; role_key: string; assignee_user_id: string | null;
            }>;
            const roles = Array.from(new Set(taskRows.map((t) => t.role_key)));
            const users = Array.from(new Set(
              taskRows.map((t) => t.assignee_user_id).filter((u): u is string => Boolean(u)),
            ));
            if (roles.length > 0 || users.length > 0) {
              await emitNotify(sb, {
                event: 'shoot_delivered',
                roles,
                users,
                titleAr: 'وصل التصوير',
                titleEn: 'Shoot delivered',
                bodyAr: 'سُلّمت مواد التصوير وأصبحت اللقطات الناقصة متوفرة.',
                bodyEn: 'Shoot materials were delivered; the missing scenes are now covered.',
                url: `/m/shoots/${id}`,
              });
            }
          }
        }

        return jsonOk({
          requests: reqsAfter.data ?? [],
          items: itemsAfter.data ?? [],
          scenes_marked: rows.filter((r) => r.scene_id).length,
        });
      }

      case 'shoot_save': {
        const raw = (body.request ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'project_id', 'status', 'scheduled_at',
                         'location', 'note', 'assigned_role'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        let requestId = id;
        if (id) {
          const upd = await sb.from('mos_shoot_requests').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'shoot request not found');
        } else {
          if (!str(patch.title)) return jsonError(400, 'title is required');
          patch.requested_by_user_id = await resolveAppUserId(sb, user.userId);
          const ins = await sb.from('mos_shoot_requests').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
          requestId = (ins.data as unknown as Row | null)?.id ?? null;

          // Requests raised from the shoot backlog carry their scenes with them,
          // so the person filming sees the actual shot list.
          const scenes = Array.isArray(body.scene_ids) ? (body.scene_ids as unknown[]) : [];
          if (requestId && scenes.length > 0) {
            const sceneRows = await sb.from('mos_scenes')
              .select('id, content_id, visual, position')
              .in('id', scenes.filter((s): s is string => typeof s === 'string'));
            const sf = dbFail(sceneRows.error);
            if (sf) return sf;
            const payload = (sceneRows.data ?? []).map((s) => {
              const sc = s as unknown as Row;
              return {
                request_id: requestId,
                scene_id: sc.id,
                content_id: sc.content_id,
                description: (sc.visual as string | null) ?? `#${String(sc.position)}`,
              };
            });
            if (payload.length > 0) {
              const itemsIns = await sb.from('mos_shoot_items').insert(payload);
              const itf = dbFail(itemsIns.error);
              if (itf) return itf;
            }
          }
        }
        const list = await sb.from('mos_shoot_requests').select('*')
          .order('created_at', { ascending: false }).limit(300);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ requests: list.data ?? [], request_id: requestId });
      }

      case 'shoot_item_toggle': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const done = body.done === true;
        const upd = await sb.from('mos_shoot_items').update({ done }).eq('id', id).select('*').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'shoot item not found');
        return jsonOk({ item: upd.data });
      }

      /* -------------------------------------------------------- */
      /* One shoot request: the shot list with each item's scene   */
      /* and owning content resolved (screen 24)                   */
      /* -------------------------------------------------------- */
      case 'shoot_detail': {
        const requestId = str(body.request_id);
        if (!requestId) return jsonError(400, 'request_id is required');

        const [request, items, assetsCount] = await Promise.all([
          sb.from('mos_shoot_requests').select('*').eq('id', requestId).maybeSingle(),
          sb.from('mos_shoot_items').select('*').eq('request_id', requestId)
            .order('created_at', { ascending: true }),
          sb.from('mos_assets').select('id', { count: 'exact', head: true })
            .eq('shoot_request_id', requestId).is('archived_at', null),
        ]);
        const f = dbFail(request.error) ?? dbFail(items.error) ?? dbFail(assetsCount.error);
        if (f) return f;
        if (!request.data) return jsonError(404, 'shoot request not found');

        const itemRows = (items.data ?? []) as unknown as Array<Row & {
          scene_id: string | null; content_id: string | null;
        }>;
        const sceneIds = Array.from(new Set(
          itemRows.map((i) => i.scene_id).filter((s): s is string => Boolean(s)),
        ));
        const contentIds = Array.from(new Set(
          itemRows.map((i) => i.content_id).filter((c): c is string => Boolean(c)),
        ));

        const [scenes, contents] = await Promise.all([
          sceneIds.length > 0
            ? sb.from('mos_scenes').select('*').in('id', sceneIds)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          contentIds.length > 0
            ? sb.from('mos_content_v').select('id, ref, title').in('id', contentIds)
            : Promise.resolve({ data: [] as unknown[], error: null }),
        ]);
        const f2 = dbFail(scenes.error) ?? dbFail(contents.error);
        if (f2) return f2;

        const sceneById = new Map(
          ((scenes.data ?? []) as unknown as Row[]).map((s) => [s.id, s] as const),
        );
        const contentById = new Map(
          ((contents.data ?? []) as unknown as Array<{ id: string; ref: string | null; title: string }>)
            .map((c) => [c.id, c] as const),
        );

        return jsonOk({
          request: request.data,
          items: itemRows.map((i) => ({
            ...i,
            scene: i.scene_id ? (sceneById.get(i.scene_id) ?? null) : null,
            content_ref: i.content_id ? (contentById.get(i.content_id)?.ref ?? null) : null,
            content_title: i.content_id ? (contentById.get(i.content_id)?.title ?? null) : null,
          })),
          assets_count: assetsCount.count ?? 0,
        });
      }

      case 'shoot_item_add': {
        const requestId = str(body.request_id);
        const description = str(body.description);
        if (!requestId || !description) {
          return jsonError(400, 'request_id and description are required');
        }
        const ins = await sb.from('mos_shoot_items').insert({
          request_id: requestId,
          description,
          scene_id: str(body.scene_id),
          content_id: str(body.content_id),
        }).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ item: ins.data });
      }

      /* -------------------------------------------------------- */
      /* Comments — the thread                                     */
      /* -------------------------------------------------------- */
      case 'comment_add': {
        const contentId = str(body.content_id);
        const campaignId = str(body.campaign_id);
        const bodyText = str(body.body);
        if (!bodyText) return jsonError(400, 'body is required');
        if (!contentId && !campaignId) return jsonError(400, 'content_id or campaign_id is required');
        const authorId = await resolveAppUserId(sb, user.userId);
        const ins = await sb.from('mos_comments').insert({
          content_id: contentId,
          campaign_id: campaignId,
          body: bodyText,
          author_user_id: authorId,
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;

        // @mention notifications. Never let a notification failure fail the
        // comment write — emitNotify already swallows its own errors, and the
        // validation read below degrades to "no notification", never to a 500.
        const rawMentions = Array.isArray(body.mentions)
          ? Array.from(new Set((body.mentions as unknown[])
              .filter((x): x is string => typeof x === 'string' && x !== '')))
          : [];
        if (rawMentions.length > 0) {
          await notifyCommentMentions(sb, {
            mentionIds: rawMentions,
            authorId,
            contentId,
            campaignId,
            bodyText,
          });
        }

        let q = sb.from('mos_comments').select('*').order('created_at', { ascending: true }).limit(200);
        q = contentId ? q.eq('content_id', contentId) : q.eq('campaign_id', campaignId ?? '');
        const list = await q;
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ comments: list.data ?? [] });
      }

      case 'comment_list': {
        const contentId = str(body.content_id);
        const campaignId = str(body.campaign_id);
        if (!contentId && !campaignId) return jsonError(400, 'content_id or campaign_id is required');
        let q = sb.from('mos_comments').select('*').order('created_at', { ascending: true }).limit(200);
        q = contentId ? q.eq('content_id', contentId) : q.eq('campaign_id', campaignId ?? '');
        const list = await q;
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ comments: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Settings — workflows, types, platforms, surface matrix    */
      /* -------------------------------------------------------- */
      case 'settings_data': {
        const [wfRes, verRes, typesRes, accountsRes, settingsRes, surfRolesRes, surfCellsRes, rulesRes] =
          await Promise.all([
            sb.from('workflows')
              .select('id, label_ar, label_en, is_active, metadata')
              .eq('kind', 'role_path')
              .order('label_en', { ascending: true }),
            sb.from('workflow_versions').select('id, workflow_id, version_no'),
            sb.from('mos_content_types').select('*').is('archived_at', null)
              .order('sort_order', { ascending: true }),
            sb.from('mos_platform_accounts').select('*').is('archived_at', null)
              .order('sort_order', { ascending: true }),
            sb.from('mos_settings').select('key, value'),
            sb.from('roles').select('id, key').like('key', 'mos\\_%').order('key', { ascending: true }),
            sb.from('surface_access').select('role_id, surface_key, level'),
            fetchNotificationRuleRows(sb),
          ]);
        const f = dbFail(wfRes.error) ?? dbFail(verRes.error) ?? dbFail(typesRes.error)
          ?? dbFail(accountsRes.error) ?? dbFail(settingsRes.error)
          ?? dbFail(surfRolesRes.error) ?? dbFail(surfCellsRes.error);
        if (f) return f;
        if ('fail' in rulesRes) return rulesRes.fail;

        const settings: Record<string, unknown> = {};
        for (const row of (settingsRes.data ?? []) as Array<{ key: string; value: unknown }>) {
          settings[row.key] = row.value;
        }
        const roleRows = (surfRolesRes.data ?? []) as unknown as Array<{ id: string; key: string }>;
        const keyById = new Map(roleRows.map((r) => [r.id, stripMosPrefix(r.key)]));
        const cells = ((surfCellsRes.data ?? []) as unknown as Array<{
          role_id: string; surface_key: string; level: string;
        }>)
          .map((c) => ({ role_key: keyById.get(c.role_id) ?? '', surface_key: c.surface_key, level: c.level }))
          .filter((c) => c.role_key !== '');

        return jsonOk({
          workflows: assembleWorkflowDefs(wfRes.data ?? [], verRes.data ?? []),
          content_types: typesRes.data ?? [],
          accounts: accountsRes.data ?? [],
          settings,
          surface: {
            roles: roleRows.map((r) => ({ key: stripMosPrefix(r.key), role_id: r.id })),
            cells,
          },
          notification_rules: rulesRes.rules,
        });
      }

      /* -------------------------------------------------------- */
      /* Module settings — thresholds as data (screen 25 cards)    */
      /* -------------------------------------------------------- */
      case 'settings_save': {
        const key = str(body.key);
        if (!key) return jsonError(400, 'key is required');
        if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
          return jsonError(400, 'value is required');
        }
        const value = body.value;
        // mos_settings.value is jsonb — a scalar or array would break every
        // reader that does value->>'field'. Objects only.
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return jsonError(400, 'value must be a JSON object');
        }
        const up = await sb.from('mos_settings').upsert(
          {
            key,
            value: value as Record<string, unknown>,
            updated_by_user_id: await resolveAppUserId(sb, user.userId),
          },
          { onConflict: 'key' },
        );
        const f = dbFail(up.error);
        if (f) return f;

        const all = await sb.from('mos_settings').select('key, value');
        const allFail = dbFail(all.error);
        if (allFail) return allFail;
        const settings: Record<string, unknown> = {};
        for (const row of (all.data ?? []) as Array<{ key: string; value: unknown }>) {
          settings[row.key] = row.value;
        }
        return jsonOk({ ok: true, settings });
      }

      /* -------------------------------------------------------- */
      /* Execution templates — a reusable AD-CAMPAIGN setup        */
      /* (platform + budget/objective/goal/dates settings + ad     */
      /* sets + ads) that prefills a NEW execution draft. Stored   */
      /* as ONE mos_settings row (`execution_templates` →          */
      /* { items: [...] }) so it needs no schema migration. The    */
      /* `setup` blob is opaque to the server (the client owns its */
      /* shape); we only manage the list.                          */
      /* -------------------------------------------------------- */
      case 'execution_templates_list': {
        const res = await sb.from('mos_settings').select('value').eq('key', 'execution_templates').maybeSingle();
        const f = dbFail(res.error); if (f) return f;
        const value = (res.data as { value?: { items?: unknown } } | null)?.value;
        const items = value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
          ? (value as { items: unknown[] }).items : [];
        return jsonOk({ templates: items });
      }

      case 'execution_template_save': {
        const tpl = (body.template ?? {}) as Record<string, unknown>;
        const name = str(tpl.name);
        if (!name) return jsonError(400, 'template name is required');
        const cur = await sb.from('mos_settings').select('value').eq('key', 'execution_templates').maybeSingle();
        const cf = dbFail(cur.error); if (cf) return cf;
        const curVal = (cur.data as { value?: { items?: unknown[] } } | null)?.value;
        const items: Array<Record<string, unknown>> = Array.isArray(curVal?.items)
          ? [...(curVal!.items as Array<Record<string, unknown>>)] : [];
        const id = str(tpl.id) || crypto.randomUUID();
        const record = { ...tpl, id, name };
        const idx = items.findIndex((t) => str(t.id) === id);
        if (idx >= 0) items[idx] = record; else items.push(record);
        const up = await sb.from('mos_settings').upsert(
          { key: 'execution_templates', value: { items }, updated_by_user_id: await resolveAppUserId(sb, user.userId) },
          { onConflict: 'key' },
        );
        const uf = dbFail(up.error); if (uf) return uf;
        return jsonOk({ templates: items });
      }

      case 'execution_template_delete': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const cur = await sb.from('mos_settings').select('value').eq('key', 'execution_templates').maybeSingle();
        const cf = dbFail(cur.error); if (cf) return cf;
        const curVal = (cur.data as { value?: { items?: unknown[] } } | null)?.value;
        const items: Array<Record<string, unknown>> = Array.isArray(curVal?.items)
          ? (curVal!.items as Array<Record<string, unknown>>).filter((t) => str(t.id) !== id) : [];
        const up = await sb.from('mos_settings').upsert(
          { key: 'execution_templates', value: { items }, updated_by_user_id: await resolveAppUserId(sb, user.userId) },
          { onConflict: 'key' },
        );
        const uf = dbFail(up.error); if (uf) return uf;
        return jsonOk({ templates: items });
      }

      /* -------------------------------------------------------- */
      /* Save a whole role path — steps live in metadata, and the  */
      /* DB trigger snapshots the new version on write             */
      /* -------------------------------------------------------- */
      case 'workflow_save': {
        const labelAr = str(body.label_ar);
        const labelEn = str(body.label_en);
        if (!labelAr || !labelEn) return jsonError(400, 'label_ar and label_en are required');
        const rawSteps = Array.isArray(body.steps) ? (body.steps as unknown[]) : null;
        if (!rawSteps || rawSteps.length === 0) return jsonError(400, 'steps must be a non-empty array');

        const seen = new Set<string>();
        const steps: StepDef[] = [];
        for (const raw of rawSteps) {
          const s = (raw ?? {}) as Record<string, unknown>;
          const key = str(s.key);
          const sLabelAr = str(s.label_ar);
          const sLabelEn = str(s.label_en);
          const roleKey = str(s.role_key);
          if (!key || !sLabelAr || !sLabelEn) {
            return jsonError(400, 'every step needs key, label_ar and label_en');
          }
          if (seen.has(key)) return jsonError(400, `duplicate step key: ${key}`);
          seen.add(key);
          if (!roleKey || !(MOS_ROLE_KEYS as readonly string[]).includes(roleKey)) {
            return jsonError(400, `step ${key} needs a valid role_key`);
          }
          const dueDays = typeof s.due_days === 'number' && Number.isInteger(s.due_days) && s.due_days >= 0
            ? s.due_days
            : null;
          if (dueDays === null) return jsonError(400, `step ${key}: due_days must be an integer >= 0`);
          steps.push({
            key,
            label_ar: sLabelAr,
            label_en: sLabelEn,
            role_key: roleKey,
            due_days: dueDays,
            is_approval: s.is_approval === true,
            approval_kind: str(s.approval_kind),
            require_note_on_reject: s.require_note_on_reject === true,
            creates_revision: s.creates_revision === true,
            required_fields: Array.isArray(s.required_fields) ? (s.required_fields as unknown[]).map(String) : [],
            required_files: Array.isArray(s.required_files) ? (s.required_files as unknown[]).map(String) : [],
            // Notification gate + permitted channels. Absent → notify on, all
            // channels (legacy default). An explicit empty channel array is a
            // real state kept verbatim (the step permits nothing).
            notify: s.notify !== false,
            notify_channels: 'notify_channels' in s ? channelsOf(s.notify_channels) : [...NOTIFY_CHANNELS],
          });
        }

        const id = str(body.id);
        let workflowId: string;
        if (id) {
          const existing = await sb.from('workflows')
            .select('id, kind, metadata').eq('id', id).maybeSingle();
          const existFail = dbFail(existing.error);
          if (existFail) return existFail;
          if (!existing.data || (existing.data as { kind?: string }).kind !== 'role_path') {
            return jsonError(404, 'workflow not found');
          }
          const prevMeta = ((existing.data as { metadata?: Record<string, unknown> }).metadata ?? {});
          const metadata = {
            ...prevMeta,
            managed_by: 'marketing_os',
            key: typeof prevMeta.key === 'string' && prevMeta.key !== '' ? prevMeta.key : slugify(labelEn),
            steps,
          };
          const patch: Record<string, unknown> = { label_ar: labelAr, label_en: labelEn, metadata };
          if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
          const upd = await sb.from('workflows').update(patch).eq('id', id);
          const updFail = dbFail(upd.error);
          if (updFail) return updFail;
          workflowId = id;
        } else {
          const ins = await sb.from('workflows').insert({
            label_ar: labelAr,
            label_en: labelEn,
            kind: 'role_path',
            trigger_model_id: null,
            trigger_event: null,
            conditions: [],
            actions: [],
            is_active: typeof body.is_active === 'boolean' ? body.is_active : true,
            metadata: { managed_by: 'marketing_os', key: slugify(labelEn), steps },
          }).select('id').maybeSingle();
          const insFail = dbFail(ins.error);
          if (insFail) return insFail;
          if (!ins.data) return jsonError(500, 'insert returned no row');
          workflowId = (ins.data as unknown as Row).id;
        }

        // The write above already triggered the version snapshot; read it back.
        const [wfRow, verRow] = await Promise.all([
          sb.from('workflows').select('id, label_ar, label_en, is_active, metadata')
            .eq('id', workflowId).maybeSingle(),
          sb.from('workflow_versions').select('id, version_no')
            .eq('workflow_id', workflowId)
            .order('version_no', { ascending: false }).limit(1).maybeSingle(),
        ]);
        const readFail = dbFail(wfRow.error) ?? dbFail(verRow.error);
        if (readFail) return readFail;
        const w = wfRow.data as {
          id: string; label_ar: string; label_en: string; is_active: boolean; metadata: unknown;
        } | null;
        const v = verRow.data as { id: string; version_no: number } | null;
        return jsonOk({
          workflow: w
            ? {
                id: w.id,
                label_ar: w.label_ar,
                label_en: w.label_en,
                is_active: w.is_active,
                steps: stepsOf(w.metadata),
                current_version_no: v?.version_no ?? 0,
                current_version_id: v?.id ?? null,
              }
            : null,
          version_no: v?.version_no ?? 0,
        });
      }

      case 'content_type_save': {
        const raw = (body.content_type ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['key', 'label_ar', 'label_en', 'prefix', 'workflow_id',
                         'field_schema', 'sort_order', 'is_active'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_content_types').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'content type not found');
        } else {
          if (!str(patch.key) || !str(patch.prefix)) return jsonError(400, 'key and prefix are required');
          const ins = await sb.from('mos_content_types').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_content_types').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ content_types: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Success-measure types — the managed registry a campaign's */
      /* success criteria are picked from (four presets seeded).   */
      /* -------------------------------------------------------- */
      case 'measure_types_list': {
        const list = await sb.from('mos_measure_types').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ measure_types: list.data ?? [] });
      }

      case 'measure_type_save': {
        const raw = (body.measure_type ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['key', 'label_ar', 'label_en', 'direction', 'unit', 'source',
                         'sort_order', 'is_active'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // Direction / unit / source are constrained by the table CHECKs; normalize
        // here so a bad client value fails as a 400 rather than a raw DB error.
        if (patch.direction !== undefined && patch.direction !== 'higher' && patch.direction !== 'lower') {
          return jsonError(400, 'direction must be higher or lower');
        }
        if (patch.unit !== undefined && patch.unit !== 'count' && patch.unit !== 'currency' && patch.unit !== 'percent') {
          return jsonError(400, 'unit must be count, currency, or percent');
        }
        if (patch.source !== undefined && !MEASURE_SOURCES.includes(patch.source as string) && patch.source !== 'none') {
          return jsonError(400, 'source is not a valid measure source');
        }
        if (id) {
          // The key is the stable identity snapshotted onto campaigns — never
          // reslug an existing type.
          delete patch.key;
          const upd = await sb.from('mos_measure_types').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'measure type not found');
        } else {
          if (!str(patch.key) || !str(patch.label_ar) || !str(patch.label_en)) {
            return jsonError(400, 'key and both labels are required');
          }
          const ins = await sb.from('mos_measure_types').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_measure_types').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ measure_types: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Audiences — the managed registry the campaign brief's     */
      /* «الجمهور» is picked from (name + large details).          */
      /* -------------------------------------------------------- */
      case 'audiences_list': {
        const list = await sb.from('mos_audiences').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true }).order('created_at', { ascending: true });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ audiences: list.data ?? [] });
      }

      case 'audience_save': {
        const raw = (body.audience ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['name', 'details', 'sort_order', 'is_active',
                         // Option-B Meta link: the Saved Audience id + its cached
                         // targeting spec (pushed as the ad set targeting).
                         'meta_saved_audience_id', 'meta_targeting'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // `name` is the identity shown everywhere — never let it be blanked.
        if (Object.prototype.hasOwnProperty.call(patch, 'name') && !str(patch.name)) {
          return jsonError(400, 'name is required');
        }
        if (id) {
          const upd = await sb.from('mos_audiences').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'audience not found');
        } else {
          if (!str(patch.name)) return jsonError(400, 'name is required');
          patch.created_by_user_id = await resolveAppUserId(sb, user.userId);
          const ins = await sb.from('mos_audiences').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_audiences').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true }).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ audiences: list.data ?? [] });
      }

      case 'account_save': {
        const raw = (body.account ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['platform', 'handle', 'label_ar', 'label_en', 'sort_order'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // `is_connected` / `can_publish` / `can_read_metrics` are deliberately NOT
        // editable here. Publishing stays manual until a real OAuth flow sets them;
        // a checkbox that claims a connection would be a lie in the UI.
        if (id) {
          const upd = await sb.from('mos_platform_accounts').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'account not found');
        } else {
          if (!str(patch.platform)) return jsonError(400, 'platform is required');
          const ins = await sb.from('mos_platform_accounts').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_platform_accounts').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ accounts: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Projects — names for the brief, from the live CRM          */
      /* -------------------------------------------------------- */
      case 'projects_list': {
        // Our Projects only — a project is "ours" iff all_projects.is_public = true
        // (the same membership flag the website reads). The picker never offers the
        // ~1,000 market/all projects, only the 49 we actually run.
        const rows = await sb.from('v_all_projects').select('id, project_name')
          .eq('is_public', true)
          .order('project_name', { ascending: true }).limit(1000);
        const f = dbFail(rows.error);
        if (f) return f;
        // Map each public master → its Our-Projects record id, so the marketing
        // UI can deep-link into the our_projects module (not all_projects).
        // Best-effort: if v_our_projects is unreadable for this caller, the id
        // stays null and the button falls back to the all_projects page (the
        // same ProjectDetailPage).
        const our = await sb.from('v_our_projects').select('id, project').limit(2000);
        const ourByMaster = new Map<string, string>();
        for (const r of (our.data ?? []) as Array<{ id: string; project: string | null }>) {
          if (r.project) ourByMaster.set(r.project, r.id);
        }
        const projects = ((rows.data ?? []) as Array<{ id: string; project_name: string | null }>)
          .map((p) => ({ id: p.id, project_name: p.project_name, our_project_id: ourByMaster.get(p.id) ?? null }));
        return jsonOk({ projects });
      }

      /* -------------------------------------------------------- */
      /* Project info — the writer's project-facts tab. Resolves a */
      /* curated all_projects field set (labels from schema,       */
      /* values from the record) + the model id (so the sibling    */
      /* «project marketing assets» tab can list linked files) +   */
      /* the developer name + the our_projects deep-link id.       */
      /* -------------------------------------------------------- */
      case 'project_info': {
        const projectId = str(body.project_id);
        if (!projectId) return jsonError(400, 'project_id is required');

        const [modelRes, recRes] = await Promise.all([
          sb.from('models').select('id, schema').eq('name', 'all_projects').maybeSingle(),
          sb.from('unified_records').select('id, data').eq('id', projectId).maybeSingle(),
        ]);
        const mf = dbFail(modelRes.error); if (mf) return mf;
        const rf = dbFail(recRes.error); if (rf) return rf;
        const model = modelRes.data as { id: string; schema: { sections?: Array<{ fields?: SchemaFieldDef[] }> } } | null;
        const rec = recRes.data as { id: string; data: Record<string, unknown> } | null;
        if (!model) return jsonError(404, 'all_projects model not found');
        if (!rec) return jsonOk({ project: null, model_id: model.id });
        const data = rec.data ?? {};

        const fieldDefs = new Map<string, SchemaFieldDef>();
        for (const sec of (model.schema?.sections ?? [])) {
          for (const fdef of (sec.fields ?? [])) if (fdef.name) fieldDefs.set(fdef.name, fdef);
        }

        // Deep-link id into the our_projects module (best-effort).
        let ourProjectId: string | null = null;
        const ourRes = await sb.from('v_our_projects').select('id').eq('project', projectId).maybeSingle();
        if (!ourRes.error) ourProjectId = (ourRes.data as { id: string } | null)?.id ?? null;

        // Developer name (the record stores the developer's record id).
        let developerName: string | null = null;
        const devId = typeof data.developer === 'string' ? data.developer : null;
        if (devId) {
          const dv = await sb.from('unified_records').select('data').eq('id', devId).maybeSingle();
          const dd = (dv.data as { data?: Record<string, unknown> } | null)?.data;
          if (dd) {
            const nm = dd.developer_name ?? dd.name ?? dd.company_name ?? dd.developer;
            developerName = typeof nm === 'string' ? nm : null;
          }
        }

        const fields: ProjectInfoField[] = [];
        for (const key of PROJECT_INFO_KEYS) {
          // `location` is a geography COMPOUND of record ids ({region,city,
          // district}, each a single id or an array) — resolve them to localized
          // names here (the generic builder has no DB access, so raw ids leaked).
          if (key === 'location') {
            const loc = data.location as Record<string, unknown> | null | undefined;
            if (!loc || typeof loc !== 'object') continue;
            const collect = (v: unknown): string[] =>
              Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '')
                : (typeof v === 'string' && v ? [v] : []);
            const districts = collect(loc.district);
            const cities = collect(loc.city);
            const regions = collect(loc.region);
            const allIds = [...districts, ...cities, ...regions];
            if (allIds.length === 0) continue;
            const geoRes = await sb.from('unified_records').select('id, data').in('id', allIds);
            const nameById = new Map<string, { ar: string; en: string }>();
            for (const r of (geoRes.data ?? []) as Array<{ id: string; data: Record<string, unknown> }>) {
              const gd = r.data ?? {};
              const ar = (typeof gd.display_name === 'string' && gd.display_name)
                || (typeof gd.name_ar === 'string' ? gd.name_ar : '');
              const en = typeof gd.name_en === 'string' ? gd.name_en : '';
              if (ar || en) nameById.set(r.id, { ar: ar || en, en: en || ar });
            }
            const namesFor = (ids: string[], lang: 'ar' | 'en'): string[] =>
              ids.map((id) => nameById.get(id)?.[lang]).filter((s): s is string => !!s);
            // Most specific first: district · city · region.
            const arParts = [...namesFor(districts, 'ar'), ...namesFor(cities, 'ar'), ...namesFor(regions, 'ar')];
            const enParts = [...namesFor(districts, 'en'), ...namesFor(cities, 'en'), ...namesFor(regions, 'en')];
            if (arParts.length === 0 && enParts.length === 0) continue;
            const locDef = fieldDefs.get('location');
            fields.push({
              key: 'location',
              label_ar: locDef?.label_ar ?? 'الموقع',
              label_en: locDef?.label_en ?? 'Location',
              kind: 'text',
              value_ar: arParts.join(' · '),
              value_en: enParts.join(' · '),
            });
            continue;
          }
          const built = buildProjectInfoField(key, fieldDefs.get(key), data[key]);
          if (built) fields.push(built);
        }

        return jsonOk({
          project: {
            id: projectId,
            our_project_id: ourProjectId,
            developer_name: developerName,
            fields,
          },
          model_id: model.id,
        });
      }

      /* -------------------------------------------------------- */
      /* Weekly numbers — everything published that has no reading  */
      /* since the given date. This is the Friday data-entry queue. */
      /* -------------------------------------------------------- */
      case 'metrics_queue': {
        const since = str(body.since)
          ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
        const pubs = await sb.from('mos_publication_v').select('*')
          .eq('status', 'published')
          .order('published_at', { ascending: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(pubs.error);
        if (f) return f;

        const rows = (pubs.data ?? []) as unknown as Array<Row & { latest_captured_at: string | null }>;
        const ids = Array.from(new Set(rows.map((p) => p.content_id as string)));
        let titles: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('mos_content_v').select('id, ref, title, content_type_key').in('id', ids);
          const tf = dbFail(t.error);
          if (tf) return tf;
          titles = t.data ?? [];
        }
        return jsonOk({ publications: rows, titles, since });
      }

      /* -------------------------------------------------------- */
      /* Search — one box over every object type the caller may    */
      /* SEE. A hidden surface means its type is absent from both  */
      /* the results and the count chips: search never hints at    */
      /* something the sidebar doesn't show. Each hit carries the  */
      /* field that matched and a <mark>-wrapped excerpt.          */
      /* -------------------------------------------------------- */
      case 'search': {
        const raw = str(body.q);
        // PostgREST's `or=` is a comma/parenthesis-delimited grammar, so a term
        // containing those characters would produce a malformed filter rather
        // than a search. Strip them instead of shipping a broken query.
        const term = raw ? raw.replace(/[(),*]/g, ' ').trim() : null;

        const surf = await callerSurfaces(sb);
        if ('fail' in surf) return surf.fail;
        // Type → the surface that governs its visibility.
        const TYPE_SURFACE = {
          content: 'content',
          campaign: 'campaigns',
          asset: 'library',
          shoot: 'shoots',
        } as const;
        type SearchType = keyof typeof TYPE_SURFACE;
        const TYPE_ORDER: SearchType[] = ['content', 'campaign', 'asset', 'shoot'];
        const visible = TYPE_ORDER.filter((t) => surf.surfaces[TYPE_SURFACE[t]] !== 'hidden');

        if (!term) {
          return jsonOk({
            results: [],
            chips: visible.map((t) => ({ type: t, count: 0 })),
            content: [],
            campaigns: [],
            assets: [],
            shoots: [],
          });
        }
        const like = `%${term}%`;

        const [contentRes, campaignRes, assetRes, shootRes] = await Promise.all([
          visible.includes('content')
            ? sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS)
                .is('archived_at', null).or(`title.ilike.${like},ref.ilike.${like}`)
                .order('updated_at', { ascending: false }).limit(20)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          visible.includes('campaign')
            ? sb.from('mos_campaign_v').select('*')
                .is('archived_at', null).or(`name.ilike.${like},ref.ilike.${like},goal.ilike.${like}`)
                .order('created_at', { ascending: false }).limit(10)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          visible.includes('asset')
            ? sb.from('mos_assets').select('*')
                .is('archived_at', null).or(`title.ilike.${like},ref.ilike.${like},note.ilike.${like}`)
                .order('created_at', { ascending: false }).limit(10)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          visible.includes('shoot')
            ? sb.from('mos_shoot_requests').select('*')
                .or(`title.ilike.${like},ref.ilike.${like},location.ilike.${like}`)
                .order('created_at', { ascending: false }).limit(10)
            : Promise.resolve({ data: [] as unknown[], error: null }),
        ]);
        const f = dbFail(contentRes.error) ?? dbFail(campaignRes.error)
          ?? dbFail(assetRes.error) ?? dbFail(shootRes.error);
        if (f) return f;

        interface SearchHit {
          type: SearchType;
          id: string;
          ref: string | null;
          title: string;
          thumb_url: string | null;
          /** Asset hits only — set when the bytes are a private `files` row, so
           *  the client can sign a thumbnail (there is no stored public url). */
          file_id?: string | null;
          match_reason: string;
          excerpt: string;
        }
        const hits: Record<SearchType, SearchHit[]> = { content: [], campaign: [], asset: [], shoot: [] };

        for (const r of (contentRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const m = matchIn(
            [['title', r.title as string | null], ['ref', r.ref as string | null]],
            term,
          );
          hits.content.push({
            type: 'content',
            id: r.id as string,
            ref: (r.ref as string | null) ?? null,
            title: (r.title as string) ?? '',
            thumb_url: null,
            ...m,
          });
        }
        for (const r of (campaignRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const m = matchIn(
            [['name', r.name as string | null], ['ref', r.ref as string | null], ['goal', r.goal as string | null]],
            term,
          );
          hits.campaign.push({
            type: 'campaign',
            id: r.id as string,
            ref: (r.ref as string | null) ?? null,
            title: (r.name as string) ?? '',
            thumb_url: null,
            ...m,
          });
        }
        for (const r of (assetRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const m = matchIn(
            [['title', r.title as string | null], ['ref', r.ref as string | null], ['note', r.note as string | null]],
            term,
          );
          hits.asset.push({
            type: 'asset',
            id: r.id as string,
            ref: (r.ref as string | null) ?? null,
            title: (r.title as string) ?? '',
            thumb_url: (r.thumb_url as string | null) ?? (r.url as string | null) ?? null,
            // Canonical assets carry neither; the client signs file_id instead.
            file_id: (r.file_id as string | null) ?? null,
            ...m,
          });
        }
        for (const r of (shootRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const m = matchIn(
            [['title', r.title as string | null], ['ref', r.ref as string | null], ['location', r.location as string | null]],
            term,
          );
          hits.shoot.push({
            type: 'shoot',
            id: r.id as string,
            ref: (r.ref as string | null) ?? null,
            title: (r.title as string) ?? '',
            thumb_url: null,
            ...m,
          });
        }

        return jsonOk({
          results: TYPE_ORDER.flatMap((t) => hits[t]),
          chips: TYPE_ORDER.filter((t) => visible.includes(t))
            .map((t) => ({ type: t, count: hits[t].length })),
          // Legacy keys for the pre-s44 search page, populated ONLY for types
          // whose surface the caller may see ([] when hidden — the same rule
          // as results/chips). New UI consumes results/chips above.
          content: contentRes.data ?? [],
          campaigns: campaignRes.data ?? [],
          assets: assetRes.data ?? [],
          shoots: shootRes.data ?? [],
        });
      }

      /* ════════════════════════════════════════════════════════════ */
      /* Performance & load system — spec: docs/marketing-task-load-   */
      /* plan.md. Config grids, rating, XP profile, discipline, leave, */
      /* rewards, KPI bonuses and the coverage calendar. All writes go */
      /* through RLS (config tables) or SECURITY DEFINER RPCs (ledgers)*/
      /* ════════════════════════════════════════════════════════════ */

      /* All capacity/cadence config + toggles in one read. */
      case 'perf_config': {
        const [loadRes, slaRes, bucketsRes, targetsRes, rewardsRes, settingsRes, rolesRes] =
          await Promise.all([
            sb.from('mos_role_load').select('role_id, bucket, daily_new_tasks'),
            sb.from('mos_role_sla').select('role_id, bucket, step_key, sla_hours'),
            sb.from('mos_load_buckets').select('content_type_id, bucket'),
            sb.from('mos_posting_targets').select('*').order('platform').order('bucket'),
            sb.from('mos_rewards').select('*').order('cost_xp'),
            sb.from('mos_perf_settings').select('*').maybeSingle(),
            sb.from('roles').select('id, key, label_ar, label_en').eq('domain', 'marketing'),
          ]);
        const fail = dbFail(loadRes.error) ?? dbFail(slaRes.error) ?? dbFail(bucketsRes.error)
          ?? dbFail(targetsRes.error) ?? dbFail(rewardsRes.error) ?? dbFail(settingsRes.error)
          ?? dbFail(rolesRes.error);
        if (fail) return fail;
        return jsonOk({
          role_load: loadRes.data ?? [],
          role_sla: slaRes.data ?? [],
          buckets: bucketsRes.data ?? [],
          posting_targets: targetsRes.data ?? [],
          rewards: rewardsRes.data ?? [],
          settings: settingsRes.data ?? null,
          roles: rolesRes.data ?? [],
        });
      }

      /* Upsert capacity/SLA/bucket rows (RLS: manage_roles). */
      case 'perf_load_save': {
        const rows = Array.isArray(body.role_load) ? body.role_load as Array<Record<string, unknown>> : [];
        const slas = Array.isArray(body.role_sla) ? body.role_sla as Array<Record<string, unknown>> : [];
        const buckets = Array.isArray(body.buckets) ? body.buckets as Array<Record<string, unknown>> : [];
        if (rows.length > 0) {
          const up = await sb.from('mos_role_load').upsert(
            rows.map((r) => ({
              role_id: r.role_id, bucket: r.bucket,
              daily_new_tasks: Math.max(0, Math.floor(Number(r.daily_new_tasks) || 0)),
              updated_at: new Date().toISOString(),
            })), { onConflict: 'role_id,bucket' });
          const f = dbFail(up.error); if (f) return f;
        }
        if (slas.length > 0) {
          const del = slas.filter((r) => !(Number(r.sla_hours) > 0));
          const keep = slas.filter((r) => Number(r.sla_hours) > 0);
          if (keep.length > 0) {
            const up = await sb.from('mos_role_sla').upsert(
              keep.map((r) => ({
                role_id: r.role_id, bucket: r.bucket ?? '*', step_key: r.step_key ?? '*',
                sla_hours: Number(r.sla_hours), updated_at: new Date().toISOString(),
              })), { onConflict: 'role_id,bucket,step_key' });
            const f = dbFail(up.error); if (f) return f;
          }
          for (const r of del) {
            const dl = await sb.from('mos_role_sla').delete()
              .eq('role_id', r.role_id as string).eq('bucket', (r.bucket as string) ?? '*')
              .eq('step_key', (r.step_key as string) ?? '*');
            const f = dbFail(dl.error); if (f) return f;
          }
        }
        if (buckets.length > 0) {
          const up = await sb.from('mos_load_buckets').upsert(
            buckets.map((r) => ({
              content_type_id: r.content_type_id, bucket: r.bucket,
              updated_at: new Date().toISOString(),
            })), { onConflict: 'content_type_id' });
          const f = dbFail(up.error); if (f) return f;
        }
        return jsonOk({ ok: true });
      }

      /* Posting-cadence targets (RLS: manage_roles). */
      case 'perf_target_save': {
        const t = (body.target ?? {}) as Record<string, unknown>;
        const row: Record<string, unknown> = {
          platform: str(t.platform), bucket: str(t.bucket),
          per_day: Math.max(0, Math.floor(Number(t.per_day) || 0)),
          weekday: typeof t.weekday === 'number' ? t.weekday : null,
          active: t.active !== false,
          updated_at: new Date().toISOString(),
        };
        if (!row.platform || !row.bucket) return jsonError(400, 'platform and bucket are required');
        const id = str(t.id);
        const res = id
          ? await sb.from('mos_posting_targets').update(row).eq('id', id).select('*').maybeSingle()
          : await sb.from('mos_posting_targets').insert(row).select('*').maybeSingle();
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ target: res.data });
      }

      case 'perf_target_delete': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const res = await sb.from('mos_posting_targets').delete().eq('id', id);
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ ok: true });
      }

      /* Performance toggles (RLS: manage_performance). */
      case 'perf_settings_save': {
        const patch: Record<string, unknown> = {};
        for (const k of ['ratings_enabled', 'xp_rewards_enabled', 'discipline_observe',
          'deductions_enabled', 'kpi_bonus_enabled', 'cadence_enabled']) {
          if (typeof body[k] === 'boolean') patch[k] = body[k];
        }
        if (body.production_days_per_week !== undefined) {
          const d = Math.floor(Number(body.production_days_per_week));
          if (!Number.isFinite(d) || d < 1 || d > 7) {
            return jsonError(400, 'production_days_per_week must be an integer 1–7');
          }
          patch.production_days_per_week = d;
        }
        if (Object.keys(patch).length === 0) return jsonError(400, 'no toggles in patch');
        patch.updated_at = new Date().toISOString();
        const res = await sb.from('mos_perf_settings').update(patch).eq('id', true)
          .select('*').maybeSingle();
        const f = dbFail(res.error); if (f) return f;
        if (!res.data) return jsonError(403, 'manage_performance capability required');
        return jsonOk({ settings: res.data });
      }

      /* Contributors + existing ratings for the rating widget. */
      case 'perf_ratings': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const [tasksRes, ratingsRes] = await Promise.all([
          sb.from('workflow_role_tasks')
            .select('assignee_user_id, role_key, closed_at')
            .eq('subject_table', 'mos_content').eq('subject_id', contentId)
            .eq('status', 'done').not('assignee_user_id', 'is', null),
          sb.from('mos_creative_ratings').select('*').eq('content_id', contentId),
        ]);
        const f = dbFail(tasksRes.error) ?? dbFail(ratingsRes.error); if (f) return f;
        const seen = new Map<string, string>();
        for (const t of (tasksRes.data ?? []) as Array<{ assignee_user_id: string; role_key: string }>) {
          if (!seen.has(t.assignee_user_id)) seen.set(t.assignee_user_id, t.role_key);
        }
        const ids = Array.from(seen.keys());
        const users = ids.length > 0
          ? await sb.from('users').select('id, name_ar, name_en').in('id', ids)
          : { data: [], error: null };
        const f2 = dbFail(users.error); if (f2) return f2;
        return jsonOk({
          contributors: ids.map((id) => ({
            user_id: id, role_key: seen.get(id),
            ...( (users.data ?? [] as Array<{ id: string }>).find((u) => (u as { id: string }).id === id) ?? {}),
          })),
          ratings: ratingsRes.data ?? [],
        });
      }

      /* Rate a finished creative (definer RPC gates on rate_creative). */
      case 'perf_rate': {
        const contentId = str(body.content_id);
        const level = str(body.level);
        if (!contentId || !level) return jsonError(400, 'content_id and level are required');
        const overrides = (body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides))
          ? body.overrides : {};
        const res = await sb.rpc('mos_perf_rate_content', {
          p_content_id: contentId, p_level: level, p_overrides: overrides,
        });
        const f = dbFail(res.error); if (f) return f;
        return jsonOk(res.data ?? { rated: 0 });
      }

      /* My profile — XP, rewards, discipline, KPI status, today's load. */
      case 'perf_me': {
        const appUserId = await resolveAppUserId(sb, user.userId);
        if (!appUserId) return jsonError(403, 'no app user');
        const month = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 7);
        const [xpRes, ledgerRes, lateRes, actionsRes, rewardsRes, claimsRes, leavesRes,
          goalsRes, resultsRes, recipientsRes, myTasksRes, settingsRes, myRolesRes] = await Promise.all([
          sb.from('mos_xp_ledger').select('points').eq('user_id', appUserId).limit(10000),
          sb.from('mos_xp_ledger').select('*').eq('user_id', appUserId)
            .order('created_at', { ascending: false }).limit(20),
          sb.from('mos_late_events').select('id').eq('user_id', appUserId).eq('month_key', month),
          sb.from('mos_discipline_actions').select('*').eq('user_id', appUserId)
            .order('created_at', { ascending: false }).limit(50),
          sb.from('mos_rewards').select('*').eq('active', true).order('cost_xp'),
          sb.from('mos_reward_claims').select('*').eq('user_id', appUserId)
            .order('requested_at', { ascending: false }).limit(20),
          sb.from('mos_leaves').select('*').eq('user_id', appUserId)
            .order('start_at', { ascending: false }).limit(20),
          sb.from('mos_perf_kpi_goals').select('*').eq('month_key', month),
          sb.from('mos_perf_kpi_results').select('*'),
          sb.from('mos_perf_kpi_recipients').select('*'),
          sb.from('workflow_role_tasks')
            .select('id, subject_id, step_key, role_key, bucket, opened_at, due_at, late_flag, blocked')
            .eq('status', 'open').eq('assignee_user_id', appUserId)
            .order('due_at', { ascending: true }),
          sb.from('mos_perf_settings').select('*').maybeSingle(),
          sb.rpc('wassell_mos_roles'),
        ]);
        const fail = dbFail(xpRes.error) ?? dbFail(ledgerRes.error) ?? dbFail(lateRes.error)
          ?? dbFail(actionsRes.error) ?? dbFail(rewardsRes.error) ?? dbFail(claimsRes.error)
          ?? dbFail(leavesRes.error) ?? dbFail(goalsRes.error) ?? dbFail(resultsRes.error)
          ?? dbFail(recipientsRes.error) ?? dbFail(myTasksRes.error) ?? dbFail(settingsRes.error)
          ?? dbFail(myRolesRes.error);
        if (fail) return fail;

        const xpTotal = ((xpRes.data ?? []) as Array<{ points: number }>)
          .reduce((s, r) => s + (r.points || 0), 0);

        // KPI goals that include me (directly or through a held role).
        const heldKeys = ((myRolesRes.data as string[] | null) ?? []).map((r) => `mos_${r}`);
        const roleRows = await sb.from('roles').select('id, key').in('key', heldKeys.length > 0 ? heldKeys : ['-']);
        const roleIds = new Set(((roleRows.data ?? []) as Array<{ id: string }>).map((r) => r.id));
        const recips = (recipientsRes.data ?? []) as Array<{ goal_id: string; subject_kind: string; subject_id: string }>;
        const resultById = new Map(((resultsRes.data ?? []) as Array<{ goal_id: string }>).map((r) => [r.goal_id, r]));
        const myGoals = ((goalsRes.data ?? []) as Array<{ id: string }>).filter((g) =>
          recips.some((r) => r.goal_id === g.id
            && ((r.subject_kind === 'user' && r.subject_id === appUserId)
              || (r.subject_kind === 'role' && roleIds.has(r.subject_id)))))
          .map((g) => ({ ...g, result: resultById.get(g.id) ?? null }));

        return jsonOk({
          xp_total: xpTotal,
          ledger: ledgerRes.data ?? [],
          late_this_month: (lateRes.data ?? []).length,
          discipline: actionsRes.data ?? [],
          rewards: rewardsRes.data ?? [],
          claims: claimsRes.data ?? [],
          leaves: leavesRes.data ?? [],
          kpi_goals: myGoals,
          open_tasks: myTasksRes.data ?? [],
          settings: settingsRes.data ?? null,
          month,
        });
      }

      /* The manager desk — everything pending + the load heatmap. */
      case 'perf_desk': {
        const gate = await requireCap(sb, 'manage_performance'); if (gate) return gate;
        const month = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 7);
        const [usersRes, xpRes, lateRes, actionsRes, claimsRes, leavesRes, blockedRes,
          loadRes, rolesRes, openRes, targetsRes, goalsRes, resultsRes, recipientsRes, deskSettingsRes] = await Promise.all([
          sb.from('users').select('id, name_ar, name_en, role_assignments').eq('is_active', true),
          sb.from('mos_xp_ledger').select('user_id, points').limit(50000),
          sb.from('mos_late_events').select('user_id').eq('month_key', month),
          sb.from('mos_discipline_actions').select('*').in('status', ['pending', 'disputed'])
            .order('created_at', { ascending: false }),
          sb.from('mos_reward_claims').select('*').eq('status', 'requested'),
          sb.from('mos_leaves').select('*').eq('status', 'requested'),
          sb.from('workflow_role_tasks')
            .select('id, subject_id, step_key, role_key, bucket, assignee_user_id, due_at, blocked, blocked_reason, late_flag')
            .eq('status', 'open').or('blocked.eq.true,late_flag.eq.true'),
          sb.from('mos_role_load').select('role_id, bucket, daily_new_tasks'),
          sb.from('roles').select('id, key, label_ar, label_en').eq('domain', 'marketing'),
          sb.from('workflow_role_tasks')
            .select('role_key, bucket, assignee_user_id, opened_at, status')
            .eq('status', 'open'),
          sb.from('mos_posting_targets').select('*').eq('active', true),
          sb.from('mos_perf_kpi_goals').select('*').eq('month_key', month),
          sb.from('mos_perf_kpi_results').select('*'),
          sb.from('mos_perf_kpi_recipients').select('*'),
          sb.from('mos_perf_settings').select('production_days_per_week').maybeSingle(),
        ]);
        const fail = dbFail(usersRes.error) ?? dbFail(xpRes.error) ?? dbFail(lateRes.error)
          ?? dbFail(actionsRes.error) ?? dbFail(claimsRes.error) ?? dbFail(leavesRes.error)
          ?? dbFail(blockedRes.error) ?? dbFail(loadRes.error) ?? dbFail(rolesRes.error)
          ?? dbFail(openRes.error) ?? dbFail(targetsRes.error) ?? dbFail(goalsRes.error)
          ?? dbFail(resultsRes.error) ?? dbFail(recipientsRes.error) ?? dbFail(deskSettingsRes.error);
        if (fail) return fail;

        // People = users holding any marketing role; annotate xp + lateness.
        const roleIdSet = new Set(((rolesRes.data ?? []) as Array<{ id: string }>).map((r) => r.id));
        const xpByUser = new Map<string, number>();
        for (const r of (xpRes.data ?? []) as Array<{ user_id: string; points: number }>) {
          xpByUser.set(r.user_id, (xpByUser.get(r.user_id) ?? 0) + (r.points || 0));
        }
        const lateByUser = new Map<string, number>();
        for (const r of (lateRes.data ?? []) as Array<{ user_id: string }>) {
          lateByUser.set(r.user_id, (lateByUser.get(r.user_id) ?? 0) + 1);
        }
        const people = ((usersRes.data ?? []) as Array<{
          id: string; name_ar: string | null; name_en: string | null;
          role_assignments: Array<{ role_id?: string }> | null;
        }>)
          .filter((u) => Array.isArray(u.role_assignments)
            && u.role_assignments.some((a) => a.role_id && roleIdSet.has(a.role_id)))
          .map((u) => ({
            user_id: u.id, name_ar: u.name_ar, name_en: u.name_en,
            roles: (u.role_assignments ?? [])
              .map((a) => ((rolesRes.data ?? []) as Array<{ id: string; key: string }>)
                .find((r) => r.id === a.role_id)?.key ?? null)
              .filter(Boolean),
            xp_total: xpByUser.get(u.id) ?? 0,
            late_this_month: lateByUser.get(u.id) ?? 0,
          }));

        const resultById2 = new Map(((resultsRes.data ?? []) as Array<{ goal_id: string }>).map((r) => [r.goal_id, r]));
        return jsonOk({
          month,
          people,
          pending_actions: actionsRes.data ?? [],
          pending_claims: claimsRes.data ?? [],
          pending_leaves: leavesRes.data ?? [],
          flagged_tasks: blockedRes.data ?? [],
          role_load: loadRes.data ?? [],
          roles: rolesRes.data ?? [],
          open_tasks: openRes.data ?? [],
          posting_targets: targetsRes.data ?? [],
          kpi_goals: ((goalsRes.data ?? []) as Array<{ id: string }>).map((g) => ({
            ...g, result: resultById2.get(g.id) ?? null,
            recipients: ((recipientsRes.data ?? []) as Array<{ goal_id: string }>)
              .filter((r) => r.goal_id === g.id),
          })),
          production_days_per_week: (deskSettingsRes.data as { production_days_per_week?: number } | null)
            ?.production_days_per_week ?? 6,
        });
      }

      /* Decisions — all definer RPCs with their own gates. */
      case 'perf_reward_claim': {
        const rewardId = str(body.reward_id);
        if (!rewardId) return jsonError(400, 'reward_id is required');
        const res = await sb.rpc('mos_perf_claim_reward', { p_reward_id: rewardId });
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ claim_id: res.data });
      }

      case 'perf_reward_decide': {
        const claimId = str(body.claim_id);
        if (!claimId) return jsonError(400, 'claim_id is required');
        const res = await sb.rpc('mos_perf_decide_reward', {
          p_claim_id: claimId, p_approve: body.approve === true,
        });
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ ok: true });
      }

      case 'perf_discipline_decide': {
        const actionId = str(body.action_id);
        if (!actionId) return jsonError(400, 'action_id is required');
        const res = await sb.rpc('mos_perf_decide_discipline', {
          p_action_id: actionId, p_approve: body.approve === true,
        });
        const f = dbFail(res.error); if (f) return f;
        // Tell the person their notice was decided (in-app; grid decides more).
        const row = await sb.from('mos_discipline_actions')
          .select('user_id, kind, status').eq('id', actionId).maybeSingle();
        if (row.data) {
          const a = row.data as { user_id: string; kind: string; status: string };
          if (a.status === 'approved') {
            await emitNotify(sb, {
              event: 'discipline_decided',
              roles: [], users: [a.user_id],
              titleAr: a.kind === 'deduction' ? 'قرار خصم' : 'إنذار تأخير',
              titleEn: a.kind === 'deduction' ? 'Deduction decided' : 'Late warning issued',
              bodyAr: a.kind === 'deduction'
                ? 'اعتُمد خصم يوم بسبب تجاوز مواعيد المهام هذا الشهر.'
                : 'صدر إنذار بسبب مهمة تجاوزت موعدها. راجع ملفك.',
              bodyEn: 'See your performance profile.',
              url: '/m/me',
            });
          }
        }
        return jsonOk({ ok: true });
      }

      case 'perf_discipline_dispute': {
        const actionId = str(body.action_id);
        const note = str(body.note);
        if (!actionId || !note) return jsonError(400, 'action_id and note are required');
        const res = await sb.rpc('mos_perf_dispute_discipline', {
          p_action_id: actionId, p_note: note,
        });
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ ok: true });
      }

      case 'perf_leave_request': {
        const start = str(body.start_at);
        const end = str(body.end_at);
        if (!start || !end) return jsonError(400, 'start_at and end_at are required');
        const res = await sb.rpc('mos_leave_request', {
          p_start: start, p_end: end,
          p_kind: str(body.kind) ?? 'annual', p_note: str(body.note),
        });
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ leave_id: res.data });
      }

      case 'perf_leave_decide': {
        const leaveId = str(body.leave_id);
        if (!leaveId) return jsonError(400, 'leave_id is required');
        const res = await sb.rpc('mos_leave_decide', {
          p_leave_id: leaveId, p_approve: body.approve === true,
        });
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ ok: true });
      }

      case 'perf_task_block': {
        const taskId = str(body.task_id);
        const source = str(body.task_source) ?? 'workflow';
        if (!taskId) return jsonError(400, 'task_id is required');
        const res = await sb.rpc('mos_perf_task_block', {
          p_task_source: source, p_task_id: taskId,
          p_blocked: body.blocked === true, p_reason: str(body.reason),
        });
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ ok: true });
      }

      /* KPI goals (RLS: manage_performance) + evaluation. */
      case 'perf_kpi_save': {
        const g = (body.goal ?? {}) as Record<string, unknown>;
        const row: Record<string, unknown> = {
          month_key: str(g.month_key) ?? new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 7),
          metric: str(g.metric), comparator: str(g.comparator),
          target: Number(g.target), bonus_pct: Number(g.bonus_pct),
          label_ar: str(g.label_ar), label_en: str(g.label_en),
          scope_campaign_ids: Array.isArray(g.scope_campaign_ids) && g.scope_campaign_ids.length > 0
            ? g.scope_campaign_ids : null,
        };
        if (!row.metric || !row.comparator || !Number.isFinite(row.target as number)
          || !Number.isFinite(row.bonus_pct as number)) {
          return jsonError(400, 'metric, comparator, target and bonus_pct are required');
        }
        const appUserId = await resolveAppUserId(sb, user.userId);
        const id = str(g.id);
        const res = id
          ? await sb.from('mos_perf_kpi_goals').update(row).eq('id', id).select('*').maybeSingle()
          : await sb.from('mos_perf_kpi_goals').insert({ ...row, created_by: appUserId })
              .select('*').maybeSingle();
        const f = dbFail(res.error); if (f) return f;
        if (!res.data) return jsonError(403, 'manage_performance capability required');
        const goalId = (res.data as { id: string }).id;
        // Recipients: replace the set when provided.
        if (Array.isArray(body.recipients)) {
          const dl = await sb.from('mos_perf_kpi_recipients').delete().eq('goal_id', goalId);
          const f2 = dbFail(dl.error); if (f2) return f2;
          const recs = (body.recipients as Array<Record<string, unknown>>)
            .filter((r) => str(r.subject_kind) && str(r.subject_id))
            .map((r) => ({ goal_id: goalId, subject_kind: r.subject_kind, subject_id: r.subject_id }));
          if (recs.length > 0) {
            const ins = await sb.from('mos_perf_kpi_recipients').insert(recs);
            const f3 = dbFail(ins.error); if (f3) return f3;
          }
        }
        return jsonOk({ goal: res.data });
      }

      case 'perf_kpi_delete': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const res = await sb.from('mos_perf_kpi_goals').delete().eq('id', id);
        const f = dbFail(res.error); if (f) return f;
        return jsonOk({ ok: true });
      }

      case 'perf_kpi_status': {
        const month = str(body.month)
          ?? new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 7);
        const ev = await sb.rpc('mos_perf_kpi_evaluate', { p_month: month });
        const f = dbFail(ev.error); if (f) return f;
        const [goalsRes, resultsRes, recipientsRes] = await Promise.all([
          sb.from('mos_perf_kpi_goals').select('*').eq('month_key', month),
          sb.from('mos_perf_kpi_results').select('*'),
          sb.from('mos_perf_kpi_recipients').select('*'),
        ]);
        const f2 = dbFail(goalsRes.error) ?? dbFail(resultsRes.error) ?? dbFail(recipientsRes.error);
        if (f2) return f2;
        const byId = new Map(((resultsRes.data ?? []) as Array<{ goal_id: string }>).map((r) => [r.goal_id, r]));
        return jsonOk({
          month,
          goals: ((goalsRes.data ?? []) as Array<{ id: string }>).map((g) => ({
            ...g, result: byId.get(g.id) ?? null,
            recipients: ((recipientsRes.data ?? []) as Array<{ goal_id: string }>)
              .filter((r) => r.goal_id === g.id),
          })),
        });
      }

      /* Coverage calendar — targets vs planned vs published for one month. */
      case 'perf_calendar': {
        // The window is either an explicit [from, to] (both YYYY-MM-DD, `to`
        // INCLUSIVE — the week/month the calendar is showing) or a month.
        const from = str(body.from);
        const to = str(body.to);
        const month = str(body.month)
          ?? new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 7);
        let winStart: string;
        let winEndExcl: string; // exclusive
        if (from && to) {
          winStart = from;
          const ty = Number(to.slice(0, 4));
          const tm = Number(to.slice(5, 7));
          const td = Number(to.slice(8, 10));
          winEndExcl = new Date(Date.UTC(ty, tm - 1, td + 1)).toISOString().slice(0, 10);
        } else {
          winStart = `${month}-01`;
          const y = Number(month.slice(0, 4));
          const m = Number(month.slice(5, 7));
          winEndExcl = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
        }
        const [targetsRes, pubsRes, intentsRes, bucketsRes, typesRes, loadRes, rolesRes, settingsRes] = await Promise.all([
          sb.from('mos_posting_targets').select('*').eq('active', true),
          sb.from('mos_publications')
            .select('id, content_id, platform, status, scheduled_at, published_at')
            .or(`and(published_at.gte.${winStart},published_at.lt.${winEndExcl}),and(scheduled_at.gte.${winStart},scheduled_at.lt.${winEndExcl})`),
          sb.from('mos_content')
            .select('id, content_type_id, target_publish_at, organic_platforms')
            .gte('target_publish_at', winStart).lt('target_publish_at', winEndExcl)
            .is('archived_at', null),
          sb.from('mos_load_buckets').select('content_type_id, bucket'),
          sb.from('mos_content_types').select('id, key'),
          // Production capacity: how many NEW tasks each producer role can start
          // per day, per bucket — the "supply" side of demand-vs-supply.
          sb.from('mos_role_load').select('role_id, bucket, daily_new_tasks'),
          sb.from('roles').select('id, key').eq('domain', 'marketing'),
          sb.from('mos_perf_settings').select('production_days_per_week').maybeSingle(),
        ]);
        const fail = dbFail(targetsRes.error) ?? dbFail(pubsRes.error) ?? dbFail(intentsRes.error)
          ?? dbFail(bucketsRes.error) ?? dbFail(typesRes.error) ?? dbFail(loadRes.error) ?? dbFail(rolesRes.error)
          ?? dbFail(settingsRes.error);
        if (fail) return fail;

        // Bucket for each publication's content (one batched lookup).
        const bucketByType = new Map(((bucketsRes.data ?? []) as Array<{ content_type_id: string; bucket: string }>)
          .map((b) => [b.content_type_id, b.bucket]));
        const keyByType = new Map(((typesRes.data ?? []) as Array<{ id: string; key: string }>)
          .map((t) => [t.id, t.key]));
        const pubContentIds = Array.from(new Set(((pubsRes.data ?? []) as Array<{ content_id: string | null }>)
          .map((p) => p.content_id).filter((c): c is string => Boolean(c))));
        const pubContent = pubContentIds.length > 0
          ? await sb.from('mos_content').select('id, content_type_id').in('id', pubContentIds)
          : { data: [], error: null };
        const f2 = dbFail(pubContent.error); if (f2) return f2;
        const typeByContent = new Map(((pubContent.data ?? []) as Array<{ id: string; content_type_id: string }>)
          .map((c) => [c.id, c.content_type_id]));
        const bucketOf = (typeId: string | undefined): string => {
          if (!typeId) return 'post';
          return bucketByType.get(typeId)
            ?? (keyByType.get(typeId) === 'video' ? 'video' : 'post');
        };

        const roleKeyById = new Map(((rolesRes.data ?? []) as Array<{ id: string; key: string }>)
          .map((r) => [r.id, r.key]));

        return jsonOk({
          month,
          from: winStart,
          // Echo the inclusive `to` the caller asked for (or the month's last day).
          to: to && from ? to : new Date(new Date(winEndExcl).getTime() - 86400000).toISOString().slice(0, 10),
          targets: targetsRes.data ?? [],
          publications: ((pubsRes.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
            ...p, bucket: bucketOf(typeByContent.get(p.content_id as string)),
          })),
          intents: ((intentsRes.data ?? []) as Array<Record<string, unknown>>).map((c) => ({
            id: c.id, date: (c.target_publish_at as string | null)?.slice(0, 10) ?? null,
            bucket: bucketOf(c.content_type_id as string),
            platforms: Array.isArray(c.organic_platforms) ? c.organic_platforms : [],
          })),
          // role_key stripped of the mos_ prefix, per bucket, with the daily
          // intake — the UI derives the production bottleneck from this.
          capacity: ((loadRes.data ?? []) as Array<{ role_id: string; bucket: string; daily_new_tasks: number }>)
            .map((l) => ({
              role_key: (roleKeyById.get(l.role_id) ?? '').replace(/^mos_/, ''),
              bucket: l.bucket,
              per_day: l.daily_new_tasks,
            }))
            .filter((c) => c.role_key && c.per_day > 0),
          production_days_per_week: (settingsRes.data as { production_days_per_week?: number } | null)
            ?.production_days_per_week ?? 6,
        });
      }

      /* ── creative director ─────────────────────────────────────────────
         Post Creative Director (docs/creative-director-contracts.md §4).
         Dispatch only: the capability gate runs here (requireCap, same as
         every other write surface); the handlers live in
         api/_lib/marketing/creative/*.ts and take {sb, svc, body, userId}.
         The mos_creative_* tables carry RLS with NO policies by design, so
         the handlers use the service client after the gate. ─────────────── */
      case 'creative_flags': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return creativeFlags({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_targets': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return creativeTargets({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'write_post_creative': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return writePostCreative({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_concept_select': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return creativeConceptSelect({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_regenerate': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return creativeRegenerate({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_job_status': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return creativeJobStatus({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_package_list': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return creativePackageList({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_package_get': {
        const gate = await requireCap(sb, 'view_content_body'); if (gate) return gate;
        return creativePackageGet({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_package_save': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return creativePackageSave({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_asset_replace': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return creativeAssetReplace({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_package_apply': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return creativePackageApply({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_package_revert': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return creativePackageRevert({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_ai_approve': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return creativeAiApprove({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_ai_dismiss': {
        const gate = await requireCap(sb, 'write_content'); if (gate) return gate;
        return creativeAiDismiss({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_handoff': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return creativeHandoff({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_performance': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return creativePerformance({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'brand_kit_get': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return brandKitGet({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'brand_kit_save': {
        const gate = await requireCap(sb, 'manage_settings'); if (gate) return gate;
        return brandKitSave({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'brand_kit_review': {
        const gate = await requireCap(sb, 'approve_creative'); if (gate) return gate;
        return brandKitReview({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'writer_rules_get': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return writerRulesGet({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'writer_rules_save': {
        const gate = await requireCap(sb, 'manage_settings'); if (gate) return gate;
        return writerRulesSave({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'role_map_get': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return roleMapGet({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'role_map_save': {
        const gate = await requireCap(sb, 'manage_settings'); if (gate) return gate;
        return roleMapSave({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'creative_flags_save': {
        const gate = await requireCap(sb, 'manage_settings'); if (gate) return gate;
        return creativeFlagsSave({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'ai_roles_get': {
        const gate = await requireCap(sb, 'manage_settings'); if (gate) return gate;
        return aiRolesGet({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'ai_roles_save': {
        const gate = await requireCap(sb, 'manage_settings'); if (gate) return gate;
        return aiRolesSave({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'design_example_set': {
        const gate = await requireCap(sb, 'approve_creative'); if (gate) return gate;
        return designExampleSet({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }
      case 'design_example_list': {
        const gate = await requireCap(sb, 'read'); if (gate) return gate;
        return designExampleList({ sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId: user.userId });
      }

      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}

/**
 * Saturday→Friday week containing `iso` (or today). The Saudi working week
 * starts on Sunday, but the publishing week the team plans around runs to
 * Friday, which is the day the numbers get entered.
 */
function weekBounds(iso: string | null): { weekStart: string; weekEnd: string } {
  const base = iso ? new Date(iso) : new Date();
  const day = base.getUTCDay(); // 0 = Sunday
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() - day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { weekStart: start.toISOString(), weekEnd: end.toISOString() };
}

/**
 * Screen 01/34's segmented periods. `week` is the publishing week above;
 * `month` / `quarter` / `year` are calendar UTC bounds, `[start, end)`.
 */
function periodBounds(
  period: 'week' | 'month' | 'quarter' | 'year',
  iso: string | null,
): { weekStart: string; weekEnd: string } {
  if (period === 'week') return weekBounds(iso);
  const base = iso ? new Date(iso) : new Date();
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  if (period === 'month') {
    return {
      weekStart: new Date(Date.UTC(y, m, 1)).toISOString(),
      weekEnd: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
    };
  }
  if (period === 'quarter') {
    const q = Math.floor(m / 3) * 3;
    return {
      weekStart: new Date(Date.UTC(y, q, 1)).toISOString(),
      weekEnd: new Date(Date.UTC(y, q + 3, 1)).toISOString(),
    };
  }
  return {
    weekStart: new Date(Date.UTC(y, 0, 1)).toISOString(),
    weekEnd: new Date(Date.UTC(y + 1, 0, 1)).toISOString(),
  };
}

/** The bounds of the period of the same length immediately before [start, end). */
function previousPeriodBounds(
  period: 'week' | 'month' | 'quarter' | 'year',
  iso: string | null,
): { weekStart: string; weekEnd: string } {
  const base = iso ? new Date(iso) : new Date();
  if (period === 'week') {
    const prev = new Date(base);
    prev.setUTCDate(base.getUTCDate() - 7);
    return weekBounds(prev.toISOString());
  }
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  if (period === 'month') {
    return {
      weekStart: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
      weekEnd: new Date(Date.UTC(y, m, 1)).toISOString(),
    };
  }
  if (period === 'quarter') {
    const q = Math.floor(m / 3) * 3;
    return {
      weekStart: new Date(Date.UTC(y, q - 3, 1)).toISOString(),
      weekEnd: new Date(Date.UTC(y, q, 1)).toISOString(),
    };
  }
  return {
    weekStart: new Date(Date.UTC(y - 1, 0, 1)).toISOString(),
    weekEnd: new Date(Date.UTC(y, 0, 1)).toISOString(),
  };
}
