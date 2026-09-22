/**
 * Auto Meta ad on final approval — the API-side half (2026-09-10; rewritten
 * for plan-driven assignment 2026-09-22, decision D4).
 *
 * The final approval of a paid creative LAUNCHES its ad with the caption the
 * writer confirmed — there is no separate caption approval any more. The
 * approval RPC (`workflow_advance_role_path`) snapshots that caption (text +
 * the hash the database computed) onto the completion event's side-effects
 * manifest; the runner (completionEffects.ts) then calls
 * `mos_meta_ad_enqueue`, which is the ONE writer of the ad row + the
 * `generation_jobs` row for a Meta ad:
 *
 *   • replay-first: a job id that already exists changes nothing;
 *   • admission by STATE, not by caller: an ad already built with the same
 *     caption is `already_done`; one built with another caption is
 *     `superseded`; a live job with the same payload `satisfied_by`; a row
 *     mid-transition `retry_later` (the sweep tries again);
 *   • the approved caption travels IN the job (`params.approved_caption`) and
 *     is stamped on the row as `approval_hash` — the worker builds exactly
 *     that text and never re-reads a caption that may have changed since.
 *
 * The Fly worker (worker/src/runMetaAdJob.ts) does the long part: uploads the
 * square + vertical designs, builds the creative + ad, records the result.
 *
 * This module is PURE resolution + one RPC call — no Graph calls, no LLM. It
 * never holds the approval request open for anything slower than a few DB
 * reads.
 *
 * Resolution order for the target ad set (first hit wins):
 *   1. an existing mos_execution_ads row for this creative that is NOT yet on
 *      Meta (no platform_ad_id) under a linked Meta execution → its ad set;
 *   2. the content's own campaign (provenance) → its Meta executions that are
 *      linked (platform_campaign_id set) → their linked ad sets.
 *   When several ad sets qualify, the caller must pick one (`adSetId`) — the
 *   approval dialog asks. Exactly one → chosen automatically.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type AutoAdSkipReason =
  | 'no_campaign'        // the creative is linked to no paid campaign at all
  | 'no_meta_execution'  // the campaign has no Meta/Instagram execution
  | 'not_linked'         // the execution / ad set was never pushed to Meta
  | 'already_created';   // this creative already has a Meta ad

export interface AutoAdChoice {
  ad_set_id: string;
  ad_set_name: string;
  execution_id: string;
  execution_label: string | null;
  campaign_id: string;
  campaign_name: string | null;
  platform_adset_id: string;
}

export interface AutoAdTarget {
  execution_id: string;
  ad_set_id: string;
  ad_set_name: string;
  campaign_id: string;
  campaign_name: string | null;
  platform_adset_id: string;
  /** An existing placeholder ad row to fill (never a row already on Meta). */
  ad_row_id: string | null;
}

export type AutoAdResolution =
  | { kind: 'target'; target: AutoAdTarget; choices: AutoAdChoice[] }
  | { kind: 'choose'; choices: AutoAdChoice[] }
  | { kind: 'skip'; reason: AutoAdSkipReason; choices: AutoAdChoice[] };

interface ExecRow {
  id: string; campaign_id: string; platform: string; label: string | null; platform_campaign_id: string | null;
}
interface AdSetRow { id: string; execution_id: string; name: string; platform_adset_id: string | null; placement_variant: string | null }
interface AdRow { id: string; execution_id: string; ad_set_id: string | null; platform_ad_id: string | null; placement_variant: string | null }

const META_PLATFORMS = new Set(['meta', 'instagram']);

/**
 * Resolve the Meta ad set an approval should create the ad in. Reads with the
 * SERVICE client: the approver may not hold RLS on the campaign rows, and the
 * outcome is a display/enqueue decision, not a data grant.
 */
export async function resolveAutoAdTarget(
  svc: SupabaseClient,
  contentId: string,
  adSetIdChoice: string | null,
): Promise<AutoAdResolution> {
  const contentRes = await svc.from('mos_content')
    .select('id, campaign_id').eq('id', contentId).maybeSingle();
  if (contentRes.error) throw contentRes.error;
  const content = contentRes.data as { id: string; campaign_id: string | null } | null;
  if (!content) throw new Error('content not found');

  // Existing placements of this creative (any campaign).
  const adsRes = await svc.from('mos_execution_ads')
    .select('id, execution_id, ad_set_id, platform_ad_id, placement_variant')
    .eq('content_id', contentId).is('archived_at', null);
  if (adsRes.error) throw adsRes.error;
  // The stories shadow of a feed/story pair is never a target of its own.
  const ads = ((adsRes.data ?? []) as AdRow[]).filter((a) => a.placement_variant !== 'story');

  const execIds = new Set<string>(ads.map((a) => a.execution_id));
  const campaignIds = new Set<string>();
  if (content.campaign_id) campaignIds.add(content.campaign_id);

  // Executions: those behind existing placements + those of the campaign.
  let execQ = svc.from('mos_campaign_executions')
    .select('id, campaign_id, platform, label, platform_campaign_id');
  const orParts: string[] = [];
  if (execIds.size > 0) orParts.push(`id.in.(${[...execIds].join(',')})`);
  if (campaignIds.size > 0) orParts.push(`campaign_id.in.(${[...campaignIds].join(',')})`);
  if (orParts.length === 0) return { kind: 'skip', reason: 'no_campaign', choices: [] };
  execQ = execQ.or(orParts.join(','));
  const execRes = await execQ;
  if (execRes.error) throw execRes.error;
  const execs = ((execRes.data ?? []) as ExecRow[]).filter((e) => META_PLATFORMS.has(e.platform));
  if (execs.length === 0) {
    return { kind: 'skip', reason: campaignIds.size > 0 || execIds.size > 0 ? 'no_meta_execution' : 'no_campaign', choices: [] };
  }

  // An ad already on Meta for this creative → nothing to do.
  const metaExecIds = new Set(execs.map((e) => e.id));
  if (ads.some((a) => a.platform_ad_id && metaExecIds.has(a.execution_id))) {
    return { kind: 'skip', reason: 'already_created', choices: [] };
  }

  const linkedExecs = execs.filter((e) => e.platform_campaign_id);
  if (linkedExecs.length === 0) return { kind: 'skip', reason: 'not_linked', choices: [] };

  const setsRes = await svc.from('mos_ad_sets')
    .select('id, execution_id, name, platform_adset_id, placement_variant')
    .in('execution_id', linkedExecs.map((e) => e.id)).is('archived_at', null)
    .order('sort_order', { ascending: true });
  if (setsRes.error) throw setsRes.error;
  // Only the FEED (primary) half of a pair — or a legacy single set — is a
  // choice; the worker finds the story half by pair_id.
  const sets = ((setsRes.data ?? []) as AdSetRow[]).filter((s) => s.platform_adset_id && s.placement_variant !== 'story');
  if (sets.length === 0) return { kind: 'skip', reason: 'not_linked', choices: [] };

  const campNames = new Map<string, string>();
  const campIdsAll = [...new Set(linkedExecs.map((e) => e.campaign_id))];
  const campRes = await svc.from('mos_campaigns').select('id, name').in('id', campIdsAll);
  if (campRes.error) throw campRes.error;
  for (const c of (campRes.data ?? []) as Array<{ id: string; name: string }>) campNames.set(c.id, c.name);

  const execById = new Map(linkedExecs.map((e) => [e.id, e]));
  const choices: AutoAdChoice[] = sets.map((s) => {
    const e = execById.get(s.execution_id)!;
    return {
      ad_set_id: s.id,
      ad_set_name: s.name,
      execution_id: s.execution_id,
      execution_label: e.label,
      campaign_id: e.campaign_id,
      campaign_name: campNames.get(e.campaign_id) ?? null,
      platform_adset_id: s.platform_adset_id as string,
    };
  });

  // A placeholder row (not on Meta yet) pins the ad set when it names one that
  // is linked; it is filled by the job instead of creating a second row.
  const placeholder = ads.find((a) => !a.platform_ad_id && a.ad_set_id && choices.some((c) => c.ad_set_id === a.ad_set_id))
    ?? null;

  const pick = (c: AutoAdChoice): AutoAdResolution => ({
    kind: 'target',
    choices,
    target: {
      execution_id: c.execution_id,
      ad_set_id: c.ad_set_id,
      ad_set_name: c.ad_set_name,
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name,
      platform_adset_id: c.platform_adset_id,
      ad_row_id: ads.find((a) => !a.platform_ad_id && a.ad_set_id === c.ad_set_id)?.id
        ?? ads.find((a) => !a.platform_ad_id && a.execution_id === c.execution_id && !a.ad_set_id)?.id
        ?? null,
    },
  });

  if (adSetIdChoice) {
    const chosen = choices.find((c) => c.ad_set_id === adSetIdChoice);
    if (chosen) return pick(chosen);
  }
  if (placeholder) {
    const c = choices.find((x) => x.ad_set_id === placeholder.ad_set_id);
    if (c) return pick(c);
  }
  if (choices.length === 1) return pick(choices[0]!);
  return { kind: 'choose', choices };
}

/* ------------------------------------------------------------------ */
/* the approved caption                                                */
/* ------------------------------------------------------------------ */

/** The caption an ad is built from, as bound at approval time. */
export interface ApprovedCaption {
  /** RAW text, untrimmed — the database hashes `btrim(text)` itself. */
  text: string;
  /** `mos_caption_hash(text)` when known; the enqueue RPC recomputes it anyway. */
  hash?: string | null;
  source: 'writer' | string;
  approved_at: string;
  /** public.users id of the approver. */
  approved_by: string | null;
}

/**
 * The writer's CONFIRMED caption of a creative, or null when there is none.
 * The rule is the database's own (`data->>'caption_confirmed_text' =
 * data->>'caption'`, exact and untrimmed) — the same test the advance RPC
 * applies when it refuses a paid approval with `caption_confirmed`.
 */
export async function loadConfirmedCaption(
  svc: SupabaseClient,
  contentId: string,
): Promise<{ text: string; confirmed_at: string | null } | null> {
  const res = await svc.from('mos_content').select('data').eq('id', contentId).maybeSingle();
  if (res.error) throw res.error;
  const d = ((res.data as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const caption = typeof d.caption === 'string' ? d.caption : '';
  const confirmed = typeof d.caption_confirmed_text === 'string' ? d.caption_confirmed_text : null;
  if (!caption.trim() || confirmed === null || confirmed !== caption) return null;
  return {
    text: caption,
    confirmed_at: typeof d.caption_confirmed_at === 'string' ? d.caption_confirmed_at : null,
  };
}

/* ------------------------------------------------------------------ */
/* enqueue — a thin wrapper over mos_meta_ad_enqueue                    */
/* ------------------------------------------------------------------ */

export interface EnqueueMetaAdInput {
  /** The job id. Derived from the event (`mos_meta_job_id`) on the approval
   *  path so a re-run cannot enqueue twice; a fresh uuid for a manual retry. */
  jobId: string;
  /** The completion event this ad belongs to, when there is one. */
  eventId: string | null;
  contentId: string;
  contentTitle: string;
  target: AutoAdTarget;
  /** auth.users id of the approver — stamped on the job (generation_jobs.user_id). */
  approvedByAuthUid: string | null;
  /** public.users id of the approver — who gets the result notification. */
  approvedByUserId: string | null;
  approvedCaption: ApprovedCaption;
}

export type EnqueueMetaAdReason =
  | 'enqueued' | 'replay' | 'already_done' | 'satisfied_by' | 'superseded' | 'retry_later';

export interface EnqueueMetaAdOutcome {
  enqueued: boolean;
  reason: EnqueueMetaAdReason;
  job_id: string | null;
  ad_row_id: string | null;
  ad_state: string | null;
  detail: string | null;
}

/**
 * Hand the ad to the worker through the admission RPC. Never throws on a
 * refused admission — the outcome says why; throws only when the RPC itself
 * fails (a real error the caller must surface).
 */
export async function enqueueMetaAdJob(
  svc: SupabaseClient,
  input: EnqueueMetaAdInput,
): Promise<EnqueueMetaAdOutcome> {
  const res = await svc.rpc('mos_meta_ad_enqueue', {
    p_job_id: input.jobId,
    p_phase: 'create',
    p_event_id: input.eventId,
    p_content_id: input.contentId,
    p_content_title: input.contentTitle,
    p_ad_row_id: input.target.ad_row_id,
    p_execution_id: input.target.execution_id,
    p_ad_set_id: input.target.ad_set_id,
    p_platform_adset_id: input.target.platform_adset_id,
    p_ad_set_name: input.target.ad_set_name,
    p_approved_by_auth_uid: input.approvedByAuthUid,
    p_approved_by_user_id: input.approvedByUserId,
    p_approved_caption: {
      text: input.approvedCaption.text,
      source: input.approvedCaption.source,
      approved_at: input.approvedCaption.approved_at,
      approved_by: input.approvedCaption.approved_by,
    },
  });
  if (res.error) throw res.error;
  const d = (res.data ?? {}) as Record<string, unknown>;
  const reason = typeof d.reason === 'string' ? d.reason : 'retry_later';
  const known: EnqueueMetaAdReason[] = ['enqueued', 'replay', 'already_done', 'satisfied_by', 'superseded', 'retry_later'];
  return {
    enqueued: d.enqueued === true,
    reason: (known as string[]).includes(reason) ? (reason as EnqueueMetaAdReason) : 'retry_later',
    job_id: typeof d.job_id === 'string' ? d.job_id : null,
    ad_row_id: typeof d.ad_row_id === 'string' ? d.ad_row_id : null,
    ad_state: typeof d.ad_state === 'string' ? d.ad_state : null,
    detail: typeof d.detail === 'string' ? d.detail : null,
  };
}

/** Bilingual sentence for a skip reason — shown in the approval dialog / toast. */
export function autoAdSkipText(reason: AutoAdSkipReason): { ar: string; en: string } {
  switch (reason) {
    case 'no_campaign':
      return { ar: 'المحتوى غير مرتبط بحملة مدفوعة — لن يُنشأ إعلان تلقائيًا.', en: 'This creative is not linked to a paid campaign — no ad will be created automatically.' };
    case 'no_meta_execution':
      return { ar: 'الحملة لا تحتوي منصة ميتا — لن يُنشأ إعلان تلقائيًا.', en: 'The campaign has no Meta placement — no ad will be created automatically.' };
    case 'not_linked':
      return { ar: 'الحملة غير مرتبطة بميتا بعد (لم تُنشأ في ميتا) — لن يُنشأ إعلان تلقائيًا.', en: 'The campaign is not linked to Meta yet (never pushed) — no ad will be created automatically.' };
    case 'already_created':
      return { ar: 'يوجد إعلان في ميتا لهذا المحتوى بالفعل.', en: 'This creative already has an ad on Meta.' };
  }
}

/** What a refused/deferred enqueue means to the manager, in one sentence. */
export function enqueueOutcomeText(o: EnqueueMetaAdOutcome): { ar: string; en: string } {
  switch (o.reason) {
    case 'enqueued':
    case 'replay':
    case 'satisfied_by':
      return { ar: 'أُرسل الإعلان إلى ميتا للإنشاء.', en: 'The ad was handed to Meta for creation.' };
    case 'already_done':
      return { ar: 'يوجد إعلان في ميتا لهذا المحتوى بالفعل.', en: 'This creative already has an ad on Meta.' };
    case 'superseded':
      return { ar: 'أُنشئ هذا الإعلان بكابشن مختلف — راجع تبويب المواضع.', en: 'This ad was built with a different caption — see the Placements tab.' };
    case 'retry_later':
      return { ar: 'صف الإعلان مشغول الآن — سيُعاد الإرسال تلقائيًا خلال دقائق.', en: 'The ad row is busy — the hand-off will be retried automatically in a few minutes.' };
  }
}
