/**
 * Auto Meta ad on manager approval — the API-side half (2026-09-10).
 *
 * When the marketing manager approves a step flagged `auto_meta_ad`, the app
 * resolves WHERE the ad should be created (which Meta ad set) and enqueues a
 * `generation_jobs` row of kind 'meta-ad'. The Fly worker
 * (worker/src/runMetaAdJob.ts) does the long part: uploads the square +
 * vertical designs, writes the caption with AI, creates the creative + ad on
 * Meta, and records the result on the mos_execution_ads row.
 *
 * This module is PURE resolution + enqueue — no Graph calls, no LLM. It never
 * holds the approval request open for anything slower than a few DB reads.
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
interface AdSetRow { id: string; execution_id: string; name: string; platform_adset_id: string | null }
interface AdRow { id: string; execution_id: string; ad_set_id: string | null; platform_ad_id: string | null }

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
    .select('id, execution_id, ad_set_id, platform_ad_id')
    .eq('content_id', contentId).is('archived_at', null);
  if (adsRes.error) throw adsRes.error;
  const ads = (adsRes.data ?? []) as AdRow[];

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
    .select('id, execution_id, name, platform_adset_id')
    .in('execution_id', linkedExecs.map((e) => e.id)).is('archived_at', null)
    .order('sort_order', { ascending: true });
  if (setsRes.error) throw setsRes.error;
  const sets = ((setsRes.data ?? []) as AdSetRow[]).filter((s) => s.platform_adset_id);
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

export interface EnqueueMetaAdInput {
  contentId: string;
  contentTitle: string;
  target: AutoAdTarget;
  /** auth.users id of the approver — stamped on the job (generation_jobs.user_id). */
  approvedByAuthUid: string;
  /** public.users id of the approver — who gets the result notification. */
  approvedByUserId: string | null;
}

/**
 * Ensure the mos_execution_ads row exists (status 'waiting', creative.auto_ad
 * queued) and insert the 'meta-ad' job. Returns the ad row + job ids.
 */
export async function enqueueMetaAdJob(
  svc: SupabaseClient,
  input: EnqueueMetaAdInput,
): Promise<{ ad_row_id: string; job_id: string }> {
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  let adRowId = input.target.ad_row_id;

  const autoAd = {
    state: 'queued',
    job_id: jobId,
    queued_at: now,
    approved_by_user_id: input.approvedByUserId,
    error: null,
  };

  if (adRowId) {
    const prevRes = await svc.from('mos_execution_ads').select('creative').eq('id', adRowId).maybeSingle();
    if (prevRes.error) throw prevRes.error;
    const prev = ((prevRes.data as { creative?: Record<string, unknown> } | null)?.creative ?? {}) as Record<string, unknown>;
    const upd = await svc.from('mos_execution_ads')
      .update({
        content_id: input.contentId,
        ad_set_id: input.target.ad_set_id,
        status: 'waiting',
        creative: { ...prev, auto_ad: autoAd },
        updated_at: now,
      })
      .eq('id', adRowId).select('id').maybeSingle();
    if (upd.error) throw upd.error;
  } else {
    const ins = await svc.from('mos_execution_ads').insert({
      execution_id: input.target.execution_id,
      ad_set_id: input.target.ad_set_id,
      content_id: input.contentId,
      label: input.contentTitle,
      status: 'waiting',
      creative: { auto_ad: autoAd },
    }).select('id').maybeSingle();
    if (ins.error) throw ins.error;
    adRowId = (ins.data as { id: string } | null)?.id ?? null;
    if (!adRowId) throw new Error('mos_execution_ads insert returned no row');
  }

  const job = await svc.from('generation_jobs').insert({
    id: jobId,
    record_id: input.contentId,
    message_id: adRowId,
    generation_id: null,
    user_id: input.approvedByAuthUid,
    kind: 'meta-ad',
    status: 'queued',
    prompt: null,
    params: {
      content_id: input.contentId,
      ad_row_id: adRowId,
      execution_id: input.target.execution_id,
      ad_set_id: input.target.ad_set_id,
      platform_adset_id: input.target.platform_adset_id,
      approved_by_user_id: input.approvedByUserId,
    },
  });
  if (job.error) throw job.error;

  return { ad_row_id: adRowId, job_id: jobId };
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
