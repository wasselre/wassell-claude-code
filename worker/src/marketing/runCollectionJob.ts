// ============================================================================
// Marketing collection job runner (worker side). One claimed mkt_collection_jobs
// row → collect (provider) → store raw → upsert (dedup) → snapshot (suppressed by
// rules) → attribute → record ingestion_run. Provider-agnostic; all DB writes go
// through the service-role RPCs. Browserbase fallback obeys the eligibility rules.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../env.js';
import {
  YouTube, ProviderError,
  type NormalizedContentPost, type NormalizedMetrics, type ProviderKey,
} from './providers.js';
import {
  collectViaApify, incrementalWindow, apifyBudgetState, decideBudgetAction, ProviderPausedError, redownloadTikTokVideos,
  fetchPostsByUrl, HISTORY_DAYS, INCREMENTAL_CEILING } from './apifyLifecycle.js';
import { collectMetaAdsByPage, discoverAdvertiser } from './metaAdsLifecycle.js';
import { storeCreative } from './creativeStore.js';
import { normalizeLandingUrl, campaignSignature, urlKey, insightKey } from './adIntel.js';
import { scoreCandidates, decideAutoConfirm, type OrgIdentity } from './advertiserScoring.js';
import {
  attributeCaption, shouldSnapshot, browserbaseFallbackEligible,
  type ProjectAlias, type Metrics,
} from './pipeline.js';
import { runOrganizationDiscovery } from './discovery/discoveryEngine.js';
import { runContentProcess } from './content/runContentProcess.js';
import { loadAttributionContext, publisherProjects, scopedIndex, type AttributionContext } from './content/attributionContext.js';
import { runCampaignGroup } from './content/runCampaignGroup.js';
import { runAssetProcess } from './assets/runAssetProcess.js';

export interface CollectionJob {
  id: string; kind: string; provider: ProviderKey; social_account_id: string | null;
  params: Record<string, unknown>; attempts: number; max_attempts: number;
}
interface Ctx { supabase: SupabaseClient; env: WorkerEnv; job: CollectionJob }
interface RunStats { received: number; inserted: number; updated: number; skipped: number; errors: string[] }

/** Newest published_at we hold for an account — the anchor of the incremental
 *  window. A failed read is thrown: guessing "no history" would drop the date
 *  cutoff and re-buy the account's latest posts, which is the bug this replaces. */
async function newestStoredPost(sb: SupabaseClient, accountId: string): Promise<string | null> {
  const { data, error } = await sb.from('mkt_content_posts').select('published_at')
    .eq('social_account_id', accountId).not('published_at', 'is', null)
    .order('published_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ProviderError(`could not read newest stored post: ${error.message}`, 'unavailable');
  return (data?.published_at as string | undefined) ?? null;
}

/** Which of these external ids do we already store? Drives the TikTok download
 *  pass. Thrown on error: "none known" would download everything (cost), "all
 *  known" would lose new videos (data). */
function knownExternalIdsFor(sb: SupabaseClient, platform: string) {
  return async (ids: string[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();
    const { data, error } = await sb.from('mkt_content_posts').select('external_id').eq('platform', platform).in('external_id', ids);
    if (error) throw new ProviderError(`could not check stored posts: ${error.message}`, 'unavailable');
    return new Set((data ?? []).map((r) => r.external_id as string));
  };
}

/** A long paid run (the one-time 12-month history) can outlast the 10-minute
 *  claim lease. If the lease ran out mid-run, the watchdog would hand the job to
 *  another machine and the same account would be bought TWICE. So before any
 *  long run the lease is pushed past the run's own timeouts; if that write fails
 *  or the job is no longer ours, the run does not start. */
const LONG_RUN_LEASE_MS = 100 * 60_000;
const LONG_RUN_TIMEOUT_MS = 40 * 60_000;
async function extendJobLease(sb: SupabaseClient, jobId: string, ms: number): Promise<void> {
  const { data, error } = await sb.from('mkt_collection_jobs')
    .update({ lease_expires_at: new Date(Date.now() + ms).toISOString() })
    .eq('id', jobId).eq('status', 'running').select('id');
  if (error) throw new ProviderError(`could not extend the job lease before a long run: ${error.message}`, 'unavailable');
  if (!Array.isArray(data) || data.length === 0) throw new ProviderError('job is no longer running (lease lost) — a long paid run was not started', 'unavailable');
}

/** The monthly budget is spent: pause the provider until Apify's cycle renews.
 *  mkt_provider_pause_for_budget cancels its queued jobs, raises one alert and
 *  notifies admins once. Failures here are logged loudly and do not mask the
 *  original error, which the caller re-throws. */
async function pauseForBudget(sb: SupabaseClient, provider: string, detail: string): Promise<{ paused: boolean; reason: string }> {
  let state = null;
  let readNote = '';
  try {
    state = await apifyBudgetState();
  } catch (e) {
    readNote = ` (limit unreadable: ${e instanceof Error ? e.message : String(e)})`;
  }
  const decision = decideBudgetAction(state);
  if (decision.action === 'retry') {
    // Believe the money, not the refusal — see decideBudgetAction.
    console.error(`[collect] ${provider} refused a run but has budget — retrying instead of pausing: ${decision.reason}`);
    return { paused: false, reason: decision.reason };
  }

  let until = decision.until;
  let untilNote = readNote;
  if (!until || new Date(until).getTime() <= Date.now()) {
    until = new Date(Date.now() + 24 * 3_600_000).toISOString();
    untilNote += ' (no future cycle end reported; pausing 24h and re-checking)';
  }
  const { data, error } = await sb.rpc('mkt_provider_pause_for_budget', { p_provider: provider, p_until: until, p_detail: `${detail} — ${decision.reason}${untilNote}`.slice(0, 500) });
  if (error) console.error(`[collect] 🚨 budget pause for ${provider} FAILED — collection will keep hitting the limit: ${error.message}`);
  else console.error(`[collect] 🚨 ${provider} monthly budget spent — paused until ${until}: ${JSON.stringify(data)}`);
  return { paused: true, reason: decision.reason };
}

/** The provider ANSWERED that the account does not exist: a deleted channel, or
 *  a YouTube channel id stored lowercased (ids are case-sensitive). No retry can
 *  fix that, and nothing used to stop it: six accounts were retried to
 *  max_attempts, failed, and re-enqueued by the scheduler every morning — 1,691
 *  failed jobs, and nobody was told. So switch collection off, record why on
 *  the row, and raise ONE operator alert. Every write is checked and logged; none
 *  may mask the original error, which the caller re-throws (index.ts then ends
 *  the job without a retry). */
async function disableMissingAccount(sb: SupabaseClient, job: CollectionJob, accountId: string, acct: Record<string, unknown> | null, detail: string): Promise<void> {
  const at = new Date().toISOString();
  const handle = typeof acct?.handle === 'string' && acct.handle ? acct.handle : accountId;

  // provider_metadata is MERGED, not replaced — discovery stores its provenance
  // there. There is no SQL merge helper for it, so read the current object fresh
  // and add three keys. If that read fails the account is still switched off,
  // just without the note: writing only our keys would wipe the rest.
  const patch: Record<string, unknown> = { collection_enabled: false, scrape_status: 'error' };
  const { data: cur, error: readErr } = await sb.from('mkt_social_accounts').select('provider_metadata').eq('id', accountId).maybeSingle();
  if (readErr) {
    console.error(`[collect] 🚨 account ${accountId} (${handle}) not found — provider_metadata unreadable, disabling it without the reason note: ${readErr.message}`);
  } else {
    const prevMeta: unknown = cur?.provider_metadata;
    const prev = prevMeta && typeof prevMeta === 'object' && !Array.isArray(prevMeta) ? (prevMeta as Record<string, unknown>) : {};
    patch.provider_metadata = { ...prev, disabled_reason: 'not_found', disabled_at: at, disabled_detail: detail };
  }
  // scrape_status is 'error', never 'not_found': the column's CHECK allows only
  // idle|ok|auth_failed|rate_limited|unavailable|error, and a rejected update
  // would leave the account enabled and failing daily again.
  const { error: updErr } = await sb.from('mkt_social_accounts').update(patch).eq('id', accountId);
  if (updErr) console.error(`[collect] 🚨 could not disable missing account ${accountId} (${handle}) — the scheduler will keep enqueuing it: ${updErr.message}`);
  else console.error(`[collect] account ${accountId} (${handle}) disabled — the provider says it does not exist: ${detail}`);

  const { error: alertErr } = await sb.rpc('mkt_alert_emit', {
    p_kind: 'account_not_found',
    p_dedup_key: `account_not_found:${accountId}`,
    p_title: `أُوقف جمع حساب ${handle} — الحساب غير موجود على المنصة`,
    p_severity: 'warning',
    p_subject_type: 'social_account',
    p_subject_id: accountId,
    p_body:
      'ردّت المنصة بأن هذا الحساب غير موجود، فأوقفنا جمعه تلقائياً بدل أن يفشل كل يوم. صحّح المعرّف أو احذف الحساب، ثم أعد تفعيل الجمع.' +
      '\n\nThe platform answered that this account does not exist, so its collection was switched off instead of failing every day. Correct the id or remove the account, then re-enable collection.' +
      `\n\n${detail}`,
    p_evidence: {
      account_id: accountId, handle: acct?.handle ?? null, platform: acct?.platform ?? null,
      provider: job.provider, job_id: job.id, detail, disabled_at: at, account_disabled: !updErr,
    },
  });
  if (alertErr) console.error(`[collect] mkt_alert_emit failed (missing-account alert for ${accountId} not recorded): ${alertErr.message}`);
}

export type CollectionJobFailOutcome =
  | { path: 'terminal'; outcome: 'failed' | 'noop' }
  | { path: 'mkt_job_fail'; outcome: string };

/** Hand a failed collection job back to the queue. Lives here, not in index.ts,
 *  so the terminal path is testable (index.ts starts the server on import).
 *
 *  A 'not_found' failure is TERMINAL: the provider answered that the account is
 *  not there, runCollectionJob has already switched it off and raised the alert,
 *  and mkt_job_fail would requeue it with backoff up to max_attempts — the loop
 *  behind 1,691 failed jobs. mkt_job_fail has no terminal mode, so end the row
 *  with the same write its own terminal branch makes, guarded the same way:
 *  status='running' leaves a job the watchdog already requeued, or a cancelled
 *  one, untouched (outcome 'noop'). If that write fails, fall through to
 *  mkt_job_fail: a retried job is wasteful, a job stuck 'running' is worse.
 *  Everything else goes to mkt_job_fail (backoff) as before. */
export async function failCollectionJob(sb: SupabaseClient, jobId: string, err: unknown): Promise<CollectionJobFailOutcome> {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof ProviderError && err.health === 'not_found') {
    const { data: ended, error: endErr } = await sb.from('mkt_collection_jobs')
      .update({ status: 'failed', error_message: msg, finished_at: new Date().toISOString(), lease_expires_at: null })
      .eq('id', jobId).eq('status', 'running')
      .select('id');
    if (!endErr) {
      const outcome = Array.isArray(ended) && ended.length > 0 ? 'failed' : 'noop';
      console.error(`[worker] marketing job=${jobId} failed terminally (${outcome}) — account not found, not retried: ${msg}`);
      return { path: 'terminal', outcome };
    }
    console.error(`[worker] marketing job=${jobId} terminal not_found write FAILED — falling back to mkt_job_fail (it will retry): ${endErr.message}`);
  }
  const { data: outcome, error: failErr } = await sb.rpc('mkt_job_fail', { p_job_id: jobId, p_error: msg });
  if (failErr) console.error(`[worker] marketing job=${jobId} mkt_job_fail FAILED — the row stays 'running' until the watchdog reclaims its lease: ${failErr.message}`);
  console.error(`[worker] marketing job=${jobId} failed (${failErr ? 'error' : String(outcome)}): ${msg}`);
  return { path: 'mkt_job_fail', outcome: failErr ? 'error' : String(outcome) };
}

// ── project index, SCOPED to a set of project ids ───────────────────────────
// A publisher's post is only attributed to projects that publisher is linked to
// (a developer posts about ITS projects). Matching against all 980 all_projects
// produced hundreds of number-collision false candidates — scoping fixes both the
// noise and the correctness ("don't assign a post to unrelated projects").
/**
 * Everything the matcher needs for one publisher, from the SHARED loader
 * (content/attributionContext.ts) — the same catalog, common-token set, brand /
 * place exclusions and live developer-field project scope the content pipeline
 * uses, so ingest-time attribution and the AI's candidate list can never drift
 * apart again (they did: this file excluded developer names, the content path
 * did not, and the content path is the one that feeds the runner).
 */
async function attributionScope(sb: SupabaseClient, orgId: string | null): Promise<{ ctx: AttributionContext; pubProjects: string[]; index: ProjectAlias[]; matchOpts: Parameters<typeof attributeCaption>[2] }> {
  const ctx = await loadAttributionContext(sb);
  const pubProjects = await publisherProjects(sb, ctx, orgId);
  const index = scopedIndex(ctx, pubProjects);
  return { ctx, pubProjects, index, matchOpts: { publisherProjectIds: pubProjects, commonTokens: ctx.commonTokens, excludedTokens: ctx.excludedTokens, brandPhrases: ctx.brandPhrases } };
}

async function lastSnapshot(sb: SupabaseClient, subjectId: string): Promise<{ metrics: Metrics; capturedAt: string } | null> {
  const { data } = await sb.from('mkt_metric_snapshots').select('metrics, captured_at')
    .eq('subject_type', 'post').eq('subject_id', subjectId).order('captured_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  return { metrics: (data.metrics ?? {}) as Metrics, capturedAt: data.captured_at as string };
}

function toMetricsJson(m?: NormalizedMetrics): Metrics {
  return { views: m?.views, likes: m?.likes, comments: m?.comments, shares: m?.shares, saves: m?.saves, play_count: m?.playCount, followers: m?.followers };
}

// ── ingest one post: raw → upsert → snapshot(suppressed) → attribute ────────
async function ingestPost(
  ctx: Ctx, post: NormalizedContentPost, orgId: string | null, accountId: string | null,
  runId: string, index: ProjectAlias[], matchOpts: Parameters<typeof attributeCaption>[2], minIntervalHours: number, stats: RunStats,
): Promise<string | null> {
  const sb = ctx.supabase;
  const rawId = (await sb.rpc('mkt_raw_ingestion_insert', {
    p_provider: ctx.job.provider, p_source_type: 'post', p_external_identity: post.externalId,
    p_payload: post.raw as object, p_dedup_key: `${post.platform}:${post.externalId}`, p_run_id: runId,
  })).data as string;

  const up = (await sb.rpc('mkt_content_post_upsert', {
    p_platform: post.platform, p_external_id: post.externalId, p_provider: ctx.job.provider,
    p_social_account_id: accountId, p_organization_id: orgId, p_post_url: post.postUrl ?? null,
    p_canonical_url: post.canonicalUrl ?? null, p_post_type: post.postType ?? null, p_caption: post.caption ?? null,
    p_lang: post.lang ?? null, p_published_at: post.publishedAt ?? null,
    p_media_refs: post.mediaRefs ?? [], p_thumbnail_ref: post.thumbnailRef ?? null,
    p_duration_ms: post.durationMs ?? null, p_hashtags: post.hashtags ?? [], p_mentions: post.mentions ?? [],
    p_engagement: {}, p_content_hash: post.contentHash ?? null,
  })).data as Array<{ id: string; was_inserted: boolean }> | null;
  const row = up?.[0];
  if (!row) { stats.errors.push(`upsert failed ${post.externalId}`); return null; }
  if (row.was_inserted) stats.inserted++; else stats.updated++;

  // snapshot with suppression
  const next = toMetricsJson(post.metrics);
  const hasAnyMetric = Object.values(next).some((v) => v !== undefined);
  if (hasAnyMetric) {
    const prev = await lastSnapshot(sb, row.id);
    const decision = shouldSnapshot(prev?.metrics ?? null, next, prev?.capturedAt ?? null, minIntervalHours, Date.now());
    if (decision.snapshot) {
      await sb.rpc('mkt_metric_snapshot_insert', { p_subject_type: 'post', p_subject_id: row.id, p_metrics: next, p_provider: ctx.job.provider, p_raw_ref: rawId });
    }
  }

  // attribution (caption-based; ownership boosts, never proves)
  const candidates = attributeCaption(post.caption ?? '', index, matchOpts);
  for (const c of candidates) {
    await sb.rpc('mkt_attribution_upsert', {
      p_content_post_id: row.id, p_project_id: c.projectId, p_method: c.method, p_confidence: c.confidence,
      p_evidence: c.evidence, p_matched_aliases: c.matchedAliases, p_auto_accept: c.autoAccept,
    });
  }
  return row.id;
}

/** discover looks a YouTube channel up by HANDLE — the handle is what an
 *  operator edits, so when it resolves it wins, even over a stored id (a handle
 *  re-pointed at a new channel must not be overruled by the old id). But a
 *  'not_found' now switches the whole account off, and every incremental
 *  resolves by external_account_id, not the handle (YouTube.collect). So a
 *  renamed channel — stale '@old_handle', valid 'UC…' id — must not be declared
 *  missing on the handle alone: try the stored id before giving up. If the id
 *  resolves, discover succeeds from it and the stale handle is reported (run
 *  'partial'); if the id is missing too, the account really is gone; if the id
 *  lookup hits an outage, that outage is what propagates, so the job retries
 *  rather than disabling an account nobody has proven missing. */
async function resolveDiscoverChannel(acct: Record<string, unknown>, stats: RunStats): ReturnType<typeof YouTube.resolveChannel> {
  const handle = acct.handle as string;
  const storedId = typeof acct.external_account_id === 'string' ? acct.external_account_id.trim() : '';
  try {
    return await YouTube.resolveChannel(handle);
  } catch (e) {
    if (!(e instanceof ProviderError && e.health === 'not_found') || !storedId || storedId === handle.trim()) throw e;
    let ch: Awaited<ReturnType<typeof YouTube.resolveChannel>>;
    try {
      ch = await YouTube.resolveChannel(storedId);
    } catch (e2) {
      if (e2 instanceof ProviderError && e2.health === 'not_found') {
        throw new ProviderError(`${e.message}; the stored channel id was tried too: ${e2.message}`, 'not_found');
      }
      throw e2;
    }
    stats.errors.push(`${e.message} — resolved by the stored channel id ${ch.channelId} instead; the handle is stale, correct it`);
    return ch;
  }
}

// ── main ────────────────────────────────────────────────────────────────────
export async function runCollectionJob(ctx: Ctx): Promise<{ status: string; stats: RunStats }> {
  const { supabase: sb, job } = ctx;
  const stats: RunStats = { received: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };
  let apifyCost: Record<string, unknown> | undefined;

  // account context
  const { data: acct } = job.social_account_id
    ? await sb.from('mkt_social_accounts').select('*').eq('id', job.social_account_id).maybeSingle()
    : { data: null };
  const orgId = (acct?.organization_id as string) ?? null;

  const runId = (await sb.rpc('mkt_ingestion_run_start', {
    p_provider: job.provider, p_source_account_id: job.social_account_id, p_scope: { kind: job.kind, ...job.params }, p_worker_job_ref: job.id,
  })).data as string;

  const minIntervalHours = Number((await sb.from('mkt_settings').select('value').eq('key', 'metric_snapshot_min_interval_hours').maybeSingle()).data?.value ?? 20);

  try {
    if (!acct && ['incremental', 'backfill', 'post_metrics', 'discover'].includes(job.kind)) {
      throw new ProviderError('job requires a social account', 'config_invalid');
    }

    if (job.kind === 'discover') {
      if (job.provider === 'youtube') {
        const ch = await resolveDiscoverChannel(acct!, stats);
        await sb.from('mkt_social_accounts').update({ external_account_id: ch.channelId, display_name: ch.title, followers: ch.subs, scrape_status: 'ok', last_synced_at: new Date().toISOString() }).eq('id', acct!.id);
        stats.received = 1;
      } else {
        stats.errors.push(`discover not implemented for ${job.provider} (handle already known)`);
      }
    } else if (job.kind === 'backfill' && job.params.mode === 'tiktok_redownload') {
      // Recover TikTok videos whose file never arrived (see
      // 2026-09-30_05_tiktok_video_redownload.sql). Only the download pass, only
      // for this account's missing videos, capped per video at 3 attempts.
      if (job.provider !== 'apify' || acct!.platform !== 'tiktok') throw new ProviderError('tiktok_redownload needs an Apify TikTok account', 'config_invalid');
      const want = typeof job.params.limit === 'number' ? Math.min(50, Math.max(1, job.params.limit)) : 25;
      const { data: missingRows, error: missErr } = await sb.rpc('mkt_tiktok_videos_missing', { p_account: acct!.id, p_limit: want, p_max_attempts: 3 });
      if (missErr) throw new ProviderError(`tiktok_redownload: list missing videos: ${missErr.message}`, 'unavailable');
      const missing = (missingRows ?? []) as Array<{ post_id: string; external_id: string; post_url: string }>;
      stats.received = missing.length;
      if (missing.length > 0) {
        const result = await redownloadTikTokVideos(sb, {
          handle: acct!.handle as string, postUrls: missing.map((m) => m.post_url),
          operatorApproved: job.params.operator_approved === true,
        });
        apifyCost = result.cost;
        for (const w of result.warnings) stats.errors.push(`apify: ${w}`);
        // The attempt is spent whether or not a file came back — that is what
        // stops a deleted video being re-bought on every sweep.
        const { error: markErr } = await sb.rpc('mkt_tiktok_redownload_mark', { p_post_ids: missing.map((m) => m.post_id) });
        if (markErr) stats.errors.push(`tiktok_redownload: could not record attempts: ${markErr.message}`);

        const { index, matchOpts } = await attributionScope(sb, orgId);
        const wanted = new Set(missing.map((m) => m.external_id));
        for (const post of result.posts) {
          if (!wanted.has(post.externalId)) continue; // never ingest something we did not ask for
          try {
            const id = await ingestPost(ctx, post, orgId, acct!.id as string, runId, index, matchOpts, minIntervalHours, stats);
            // FULL processing, not media_only: the post was processed long ago
            // without its video, so it needs the file stored, a transcript, its
            // frames queued and its project match redone — and the file link
            // expires, so it goes ahead of routine work.
            if (id) await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: id, organization_id: orgId, from: 'tiktok_redownload' }, p_priority: 20, p_requested_by: null, p_fallback_of: null });
          } catch (e) { stats.errors.push(`${post.externalId}: ${e instanceof Error ? e.message : String(e)}`); }
        }
      }
    } else if (job.kind === 'incremental' || job.kind === 'backfill') {
      const { index, matchOpts } = await attributionScope(sb, orgId);
      // Explicit params.limit wins (capped 50) — used for bounded validation runs;
      // else backfill uses the settings default, incremental a fixed recent window.
      const paramLimit = typeof job.params.limit === 'number' ? Math.min(50, Math.max(1, job.params.limit)) : null;
      let limit = paramLimit ?? (job.kind === 'backfill' ? Number((await sb.from('mkt_settings').select('value').eq('key', 'default_backfill_limit').maybeSingle()).data?.value ?? 30) : 30);
      const platform = acct!.platform as NormalizedContentPost['platform'];
      // Scheduled Apify incrementals ask only for what can have changed: posts
      // newer than the last one stored, and at least the last 14 days (for fresh
      // engagement). An explicit params.limit is a bounded validation run and
      // keeps the old "latest N" behaviour.
      let newerThan: string | undefined;
      // 'history' = this account's one-time 12-month collection (operator
      // decision 2026-10-04); marked done on the account when it succeeds.
      let windowMode: 'history' | 'new_only' | null = null;
      let timeoutMs: number | undefined;
      if (job.provider === 'apify' && job.kind === 'incremental' && paramLimit == null) {
        const w = incrementalWindow(await newestStoredPost(sb, acct!.id as string), (acct!.history_done_at as string | null) ?? null);
        newerThan = w.newerThan;
        limit = w.limit;
        windowMode = w.mode;
        if (w.mode === 'history' || w.limit > INCREMENTAL_CEILING) {
          await extendJobLease(sb, job.id, LONG_RUN_LEASE_MS);
          timeoutMs = LONG_RUN_TIMEOUT_MS;
        }
      }
      if (job.provider === 'youtube' && job.kind === 'incremental' && paramLimit == null && !acct!.history_done_at) {
        windowMode = 'history';
        // Free, but a big channel (up to 40 pages) can outlast the 10-minute
        // lease; a second machine would then repeat the whole walk.
        await extendJobLease(sb, job.id, LONG_RUN_LEASE_MS);
      }

      // INCREMENTAL always fetches the newest page (cursor null) so repeat runs
      // re-see recent posts and dedup UPDATES them — idempotent. Only BACKFILL
      // walks pages via the stored cursor.
      const useCursor = job.kind === 'backfill' ? ((acct!.sync_cursor as string) ?? null) : null;
      let batch: { posts: NormalizedContentPost[]; nextCursor?: string | null };
      if (job.provider === 'youtube' && windowMode === 'history') {
        // YouTube is free: walk the uploads list page by page back to 12 months.
        const cutoff = Date.now() - HISTORY_DAYS * 86_400_000;
        const all: NormalizedContentPost[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 40; page++) {
          const b = await YouTube.collect({ platform: 'youtube', handle: acct!.handle as string, externalAccountId: acct!.external_account_id as string | undefined, cursor, mode: 'backfill', limit: 50 });
          const inRange = b.posts.filter((p) => !p.publishedAt || new Date(p.publishedAt).getTime() >= cutoff);
          all.push(...inRange);
          // uploads are newest-first: once a page reaches past the cutoff, stop
          if (inRange.length < b.posts.length || !b.nextCursor) break;
          cursor = b.nextCursor;
          if (page === 39) stats.errors.push('youtube history: stopped after 40 pages (2,000 videos); older videos inside 12 months were not fetched');
        }
        batch = { posts: all, nextCursor: null };
      } else if (job.provider === 'youtube') {
        batch = await YouTube.collect({ platform: 'youtube', handle: acct!.handle as string, externalAccountId: acct!.external_account_id as string | undefined, cursor: useCursor, mode: job.kind as 'incremental' | 'backfill', limit });
      } else if (job.provider === 'apify') {
        // Full Apify lifecycle (start run → poll → dataset) — the ONE implementation.
        const result = await collectViaApify(sb, {
          platform, handle: acct!.handle as string, limit, newerThan, timeoutMs,
          knownExternalIds: knownExternalIdsFor(sb, platform),
        });
        apifyCost = result.cost;
        // Partial problems (ceiling hit, a video with no file, storage left
        // behind) mark the run 'partial' so they show up, instead of vanishing.
        for (const w of result.warnings) stats.errors.push(`apify: ${w}`);
        batch = { posts: result.posts, nextCursor: null };
      } else {
        // browserbase fallback path: items pre-scraped into params.items
        const items = Array.isArray(job.params.items) ? (job.params.items as NormalizedContentPost[]) : [];
        batch = { posts: items, nextCursor: null };
      }
      stats.received = batch.posts.length;
      const ingestedIds: string[] = [];
      for (const post of batch.posts) {
        try { const id = await ingestPost(ctx, post, orgId, acct!.id as string, runId, index, matchOpts, minIntervalHours, stats); if (id) ingestedIds.push(id); }
        catch (e) { stats.errors.push(`${post.externalId}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      // Media recovery for each freshly-collected post, RIGHT NOW, so ephemeral
      // CDN URLs (TikTok no-watermark links, Instagram signed URLs) are downloaded
      // within minutes. Higher priority than routine collection so the download
      // wins the race against expiry.
      //
      // This used to be gated on `params.process_content === true` — a flag NO
      // enqueue path ever set. `mkt_enqueue_due_accounts` passes only
      // {"reason":"scheduled"}, so every scheduled collection ingested posts and
      // silently never downloaded their media: 1,104 posts sat at 'collected'
      // with zero media rows while their URLs aged out. Opt-in was the bug, so
      // recovery is now the default and `process_content: false` is the explicit
      // opt-OUT (used by validation runs that must not touch storage).
      //
      // media_only: recovering bytes is cheap, has no AI cost and is time-critical;
      // OCR + enrichment are neither, and are driven afterwards by the backlog
      // sweep off permanent storage. See sweepContentBacklog.
      if (job.params.process_content !== false && orgId) {
        for (const pid of ingestedIds) {
          await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: pid, organization_id: orgId, from: 'collection', media_only: true }, p_priority: 30, p_requested_by: null, p_fallback_of: null });
        }
      }
      // Only backfill advances the page cursor; incremental leaves it untouched.
      const cursorUpdate = job.kind === 'backfill' ? { sync_cursor: batch.nextCursor ?? null } : {};
      // The history run is done once, even when it hit its ceiling (that is
      // reported on the run): repeating it would re-buy the same 12 months.
      const historyUpdate = windowMode === 'history' ? { history_done_at: new Date().toISOString() } : {};
      const { error: acctErr } = await sb.from('mkt_social_accounts').update({ ...cursorUpdate, ...historyUpdate, last_incremental_at: new Date().toISOString(), scrape_status: 'ok', last_synced_at: new Date().toISOString() }).eq('id', acct!.id);
      // Unrecorded, the next run would think the 12 months were never collected
      // and buy them again — fail loudly instead.
      if (acctErr) throw new ProviderError(`collected, but could not record it on the account: ${acctErr.message}`, 'unavailable');
    } else if (job.kind === 'post_metrics') {
      // Views/likes re-check: each post is read twice, at 7 and 30 days old
      // (operator decision 2026-10-04), instead of re-buying every post of the
      // last 14 days on every run. mkt_posts_due_for_metrics picks the posts.
      // This branch used to be a placeholder that only counted posts.
      const { data: due, error: dueErr } = await sb.rpc('mkt_posts_due_for_metrics', { p_account: acct!.id, p_limit: 50 });
      if (dueErr) throw new ProviderError(`could not list posts due for a views check: ${dueErr.message}`, 'unavailable');
      const rows = (due ?? []) as Array<{ post_id: string; external_id: string; post_url: string | null; stage: '7d' | '30d' }>;
      stats.received = rows.length;
      if (rows.length > 0) {
        let fetched: NormalizedContentPost[] = [];
        const platform = acct!.platform as string;
        if (job.provider === 'youtube') {
          fetched = await YouTube.videosByIds(rows.map((r) => r.external_id));
        } else if (job.provider === 'apify' && (platform === 'instagram' || platform === 'tiktok')) {
          const urls = rows.map((r) => r.post_url).filter((u): u is string => !!u);
          const res = await fetchPostsByUrl(sb, { platform, handle: acct!.handle as string, postUrls: urls });
          apifyCost = res.cost;
          for (const w of res.warnings) stats.errors.push(`apify: ${w}`);
          fetched = res.posts;
        } else {
          throw new ProviderError(`views check not supported for ${job.provider}/${platform}`, 'config_invalid');
        }
        const byExt = new Map(fetched.map((p) => [p.externalId, p]));
        const done: Record<'7d' | '30d', string[]> = { '7d': [], '30d': [] };
        let missing = 0;
        for (const r of rows) {
          const p = byExt.get(r.external_id);
          const m = toMetricsJson(p?.metrics);
          if (p && Object.values(m).some((v) => v !== undefined)) {
            const { error: snapErr } = await sb.rpc('mkt_metric_snapshot_insert', { p_subject_type: 'post', p_subject_id: r.post_id, p_metrics: m, p_provider: job.provider, p_raw_ref: null });
            if (snapErr) { stats.errors.push(`snapshot ${r.external_id}: ${snapErr.message}`); continue; }
            stats.updated++;
          } else {
            // Deleted, made private, or not returned. Mark it checked anyway:
            // asking again would only pay for the same empty answer.
            missing++;
          }
          done[r.stage].push(r.post_id);
        }
        for (const stage of ['7d', '30d'] as const) {
          if (done[stage].length === 0) continue;
          const { error: markErr } = await sb.rpc('mkt_post_metrics_mark', { p_post_ids: done[stage], p_stage: stage });
          if (markErr) throw new ProviderError(`views were read but not recorded as checked (${stage}): ${markErr.message}`, 'unavailable');
        }
        if (missing > 0) stats.errors.push(`views check: ${missing} of ${rows.length} post(s) came back empty (deleted or private?)`);
      }
      const { error: metErr } = await sb.from('mkt_social_accounts').update({ last_metrics_at: new Date().toISOString() }).eq('id', acct!.id);
      if (metErr) console.error(`[collect] could not stamp last_metrics_at on ${acct!.id}: ${metErr.message}`);
    } else if (job.kind === 'discover_advertiser') {
      // Keyword search is the DISCOVERY tool only. Candidates are scored against
      // the org's real identity (names, official domain, known FB URL, aliases)
      // and auto-confirmed ONLY when a strong, unambiguous, non-marketplace
      // anchor exists (decideAutoConfirm). Otherwise: store scored candidates for
      // a human decision. This is what prevents another "Almajdiah → Bayut".
      const adOrgId = (job.params.organization_id as string) ?? orgId;
      const advertiser = (job.params.advertiser as string) ?? (acct?.handle as string);
      if (!adOrgId || !advertiser) throw new ProviderError('discover_advertiser needs organization_id + advertiser', 'config_invalid');

      const { data: orgRow } = await sb.from('mkt_organizations')
        .select('name_ar, name_en, website, org_type, metadata, meta_confirmed').eq('id', adOrgId).maybeSingle();
      // known official Facebook page URLs from stored social accounts (identity anchor)
      const { data: fbAccts } = await sb.from('mkt_social_accounts')
        .select('profile_url').eq('organization_id', adOrgId).in('platform', ['facebook', 'meta']);
      const meta = (orgRow?.metadata ?? {}) as Record<string, unknown>;
      const orgIdentity: OrgIdentity = {
        nameAr: (orgRow?.name_ar as string) ?? null, nameEn: (orgRow?.name_en as string) ?? null,
        website: (orgRow?.website as string) ?? null, orgType: (orgRow?.org_type as string) ?? null,
        aliases: Array.isArray(meta.aliases) ? (meta.aliases as string[]) : [],
        facebookUrls: [
          ...((fbAccts ?? []).map((a) => a.profile_url as string).filter(Boolean)),
          ...(Array.isArray(meta.facebook_urls) ? (meta.facebook_urls as string[]) : []),
        ],
      };

      const disc = await discoverAdvertiser(sb, { advertiser, country: (job.params.country as string) ?? 'SA', limit: 30 });
      apifyCost = disc.cost;
      const scored = scoreCandidates(disc.candidates, orgIdentity);
      const decision = decideAutoConfirm(scored);
      stats.received = scored.length;

      // Never silently overwrite an already-confirmed identity from a discovery run.
      if (orgRow?.meta_confirmed) {
        stats.skipped = scored.length;
        stats.errors.push('org already has a confirmed advertiser — discovery did not overwrite it');
      } else if (decision.confirm && decision.winner) {
        const w = decision.winner;
        await sb.rpc('mkt_org_set_advertiser', {
          p_org: adOrgId, p_page_id: w.pageId, p_advertiser_id: w.pageId, p_page_url: w.pageUrl,
          p_display_name: w.pageName, p_confirmed: true,
          p_verification: { source: 'auto', confidence: w.confidence, score: w.score, decision: decision.reason, evidence: w.reasons, confirmed_at: new Date().toISOString() },
          p_candidates: scored,
        });
        stats.inserted = 1;
      } else {
        await sb.rpc('mkt_org_set_advertiser', {
          p_org: adOrgId, p_page_id: null, p_advertiser_id: null, p_page_url: null, p_display_name: null,
          p_confirmed: false,
          p_verification: { source: 'auto', decision: decision.reason, top_confidence: scored[0]?.confidence ?? null },
          p_candidates: scored,
        });
        stats.skipped = scored.length; // needs a human decision (marketplace/ambiguous/low-confidence)
      }
    } else if (job.kind === 'content_process') {
      // Per-post content understanding: permanent media → transcribe videos →
      // sample frames + OCR images → enrich → attribute. Idempotent.
      const postId = job.params.content_post_id as string | undefined;
      if (!postId) throw new ProviderError('content_process needs content_post_id', 'config_invalid');
      // params.media_only: recover the bytes and stop (see ContentProcessOptions).
      const r = await runContentProcess(sb, postId, { mediaOnly: job.params.media_only === true, narrowOnly: job.params.mode === 'narrow_only', framesOnly: job.params.mode === 'frames_only' });
      stats.received = r.media_total;
      stats.inserted = r.media_stored;
      stats.skipped = r.media_failed + r.transcribe_failed;
      if (r.errors.length) stats.errors.push(...r.errors.slice(0, 10));
      apifyCost = { usage_total_usd: r.cost_usd, status: r.status, transcribed: r.transcribed, images: r.images_analyzed, frames: r.frames_analyzed, primary_project: r.primary_project, degraded: r.degraded };
      // A post that produced nothing usable, lost its whole OCR step, or was left
      // unroutable is NOT a succeeded job. Until this throw existed, every one of
      // those returned normally and index.ts called mkt_job_complete — which is
      // how four days of exhausted Anthropic credits read as 66 green jobs.
      // Throwing routes it to mkt_job_fail: bounded exponential-backoff retries
      // (media/OCR writes are idempotent, so a retry is cheap and re-uses what
      // already landed), then a terminal `failed` row the queue actually shows.
      // Degradation that retrying cannot fix — an expired TikTok URL, a
      // datacenter-blocked YouTube download — stays in `errors` and does NOT
      // throw, so those never become a retry storm.
      if (r.fatal_errors.length > 0) {
        throw new ProviderError(`content_process ${postId} did not complete: ${r.fatal_errors.slice(0, 3).join('; ')}`);
      }
    } else if (job.kind === 'asset_process') {
      // Raw-asset analysis: OCR / transcript / description for one uploaded file.
      // Terminal state is written by runAssetProcess through the completion RPC,
      // so the honest-state vocabulary lives in one place.
      const assetId = job.params.asset_id as string | undefined;
      if (!assetId) throw new ProviderError('asset_process needs asset_id', 'config_invalid');
      const r = await runAssetProcess(sb, assetId);
      stats.received = 1;
      stats.inserted = r.status === 'completed' ? 1 : 0;
      stats.skipped = r.status === 'unsupported' ? 1 : 0;
      if (r.notes.length) stats.errors.push(...r.notes.slice(0, 5));
      apifyCost = { usage_total_usd: r.cost_usd, status: r.status, kind: r.kind,
                    ocr_chars: r.ocr_chars, transcript_chars: r.transcript_chars,
                    frames: r.frames_analyzed, degraded: r.status !== 'completed' };
      // 'failed' means the analyser broke — surface it as a failed JOB so the
      // queue shows it, exactly like content_process. 'unsupported' and
      // 'degraded' are legitimate outcomes and must not retry-storm.
      if (r.status === 'failed') {
        throw new ProviderError(`asset_process ${assetId} failed: ${r.notes.slice(0,2).join('; ') || 'unknown'}`);
      }
    } else if (job.kind === 'campaign_group') {
      // Deterministic cross-platform campaign grouping for one org (organic + paid).
      const cgOrgId = (job.params.organization_id as string) ?? orgId;
      if (!cgOrgId) throw new ProviderError('campaign_group needs organization_id', 'config_invalid');
      const r = await runCampaignGroup(sb, cgOrgId);
      stats.received = r.members; stats.inserted = r.new_campaigns; stats.skipped = r.campaigns - r.new_campaigns;
      apifyCost = { campaigns: r.campaigns, new_campaigns: r.new_campaigns, reused_creatives: r.reused_creatives, organic_to_paid: r.organic_to_paid, ended: r.ended };
    } else if (job.kind === 'organization_discovery') {
      // Automated identity discovery: one Browserbase session crawls the org's
      // site + runs structured Google searches + inspects candidate profiles,
      // stores ALL evidence, scores deterministically, and auto-confirms ONLY
      // link-back-anchored non-marketplace winners. Replaces manual browsing.
      const discOrgId = (job.params.organization_id as string) ?? orgId;
      if (!discOrgId) throw new ProviderError('organization_discovery needs organization_id', 'config_invalid');
      const res = await runOrganizationDiscovery(sb, ctx.env, discOrgId, (job.params.trigger as string) ?? 'queue');
      stats.received = res.candidates;
      stats.inserted = res.confirmed;
      stats.skipped = Math.max(0, res.candidates - res.confirmed);
      if (res.candidates === 0) stats.errors.push('discovery found no candidate accounts (site + search returned nothing linkable)');
    } else if (job.kind === 'paid_ads') {
      // PRODUCTION: collect a CONFIRMED advertiser PAGE (never keyword). Downloads
      // creatives permanently, fingerprints them, groups ads into campaigns, tracks
      // landing pages, and emits deterministic intelligence + notification events.
      const adOrgId = (job.params.organization_id as string) ?? orgId;
      if (!adOrgId) throw new ProviderError('paid_ads needs organization_id', 'config_invalid');
      const { data: orgRow } = await sb.from('mkt_organizations').select('meta_page_id, meta_confirmed, name_en, name_ar').eq('id', adOrgId).maybeSingle();
      if (!orgRow?.meta_page_id || !orgRow.meta_confirmed) throw new ProviderError('advertiser page not confirmed — run discover_advertiser first', 'config_invalid');
      const advertiserLabel = (orgRow.name_en as string) ?? (orgRow.name_ar as string) ?? 'advertiser';
      const limit = typeof job.params.limit === 'number' ? Math.min(200, Math.max(1, job.params.limit)) : 50;
      const result = await collectMetaAdsByPage(sb, { pageId: orgRow.meta_page_id as string, country: (job.params.country as string) ?? 'SA', limit });
      apifyCost = result.cost;
      const { index, matchOpts } = await attributionScope(sb, adOrgId);
      const seen: string[] = [];
      const touchedCampaigns = new Set<string>();
      const newCampaignIds = new Set<string>();
      const fpCounts = new Map<string, number>();
      let newLandings = 0;
      stats.received = result.ads.length;
      for (const ad of result.ads) {
        try {
          if (!ad.externalAdId) { stats.errors.push('malformed ad (no id)'); continue; }
          const rawId = (await sb.rpc('mkt_raw_ingestion_insert', { p_provider: 'apify', p_source_type: 'ad', p_external_identity: ad.externalAdId, p_payload: ad.raw as object, p_dedup_key: `meta:${ad.externalAdId}`, p_run_id: runId })).data as string;
          // permanent creative: reuse if the creative URL-key is unchanged (no re-download)
          const { data: existing } = await sb.from('mkt_paid_ads').select('creative_original_url, creative_stored_url, creative_fingerprint, creative_phash').eq('platform', 'meta').eq('external_ad_id', ad.externalAdId).maybeSingle();
          let stored: { storedUrl: string; fingerprint: string | null; phash: string | null } | null = null;
          if (ad.creativeMediaRef) {
            if (existing?.creative_stored_url && urlKey(existing.creative_original_url as string) === urlKey(ad.creativeMediaRef)) {
              stored = { storedUrl: existing.creative_stored_url as string, fingerprint: existing.creative_fingerprint as string, phash: existing.creative_phash as string };
            } else {
              stored = await storeCreative(ad.creativeMediaRef);
            }
          }
          // landing page (normalized)
          const ln = normalizeLandingUrl(ad.landingUrl);
          let landingId: string | null = null;
          if (ln.canonical) {
            const before = (await sb.from('mkt_landing_pages').select('id').eq('canonical_url', ln.canonical).maybeSingle()).data;
            landingId = (await sb.rpc('mkt_landing_upsert', { p_canonical_url: ln.canonical, p_destination_domain: ln.domain, p_project_id: null, p_organization_id: adOrgId })).data as string;
            if (!before) newLandings++;
          }
          // campaign grouping
          const sig = campaignSignature({ organizationId: adOrgId, advertiserName: ad.advertiserName, landingCanonical: ln.canonical, cta: ad.cta, headline: ad.headline });
          const camp = ((await sb.rpc('mkt_campaign_upsert', { p_signature: sig, p_organization_id: adOrgId, p_advertiser_name: ad.advertiserName ?? advertiserLabel, p_landing_page_id: landingId, p_cta: ad.cta ?? null, p_headline: ad.headline ?? null, p_run_id: runId })).data as Array<{ id: string; was_inserted: boolean }>)[0]!;
          touchedCampaigns.add(camp.id);
          if (camp.was_inserted) newCampaignIds.add(camp.id);
          // core upsert (dedup + change history)
          const up = ((await sb.rpc('mkt_paid_ad_upsert', {
            p_platform: 'meta', p_external_ad_id: ad.externalAdId, p_provider: 'apify', p_organization_id: adOrgId,
            p_advertiser_name: ad.advertiserName ?? advertiserLabel, p_creative_media_ref: ad.creativeMediaRef ?? null,
            p_creative_type: ad.creativeType ?? null, p_headline: ad.headline ?? null, p_body: ad.body ?? null,
            p_description: ad.description ?? null, p_cta: ad.cta ?? null, p_landing_url: ad.landingUrl ?? null,
            p_languages: ad.languages ?? [], p_platform_started_at: ad.platformStartedAt ?? null, p_is_active: ad.isActive,
            p_reach_info: ad.reachInfo ?? {}, p_raw_ref: rawId, p_run_id: runId,
          })).data as Array<{ id: string; was_inserted: boolean; changes: string[] }> | null)?.[0];
          if (!up) { stats.errors.push(`ad upsert failed ${ad.externalAdId}`); continue; }
          if (up.was_inserted) stats.inserted++; else stats.updated++;
          seen.push(ad.externalAdId);
          // intel fields (not in the core RPC)
          await sb.from('mkt_paid_ads').update({ campaign_id: camp.id, landing_page_id: landingId, creative_original_url: ad.creativeMediaRef ?? null, creative_stored_url: stored?.storedUrl ?? null, creative_fingerprint: stored?.fingerprint ?? null, creative_phash: stored?.phash ?? null }).eq('id', up.id);
          if (stored?.fingerprint) fpCounts.set(stored.fingerprint, (fpCounts.get(stored.fingerprint) ?? 0) + 1);
          // attribution (ad text → monitored developer's projects)
          const text = [ad.headline, ad.body, ad.description].filter(Boolean).join(' ');
          for (const c of attributeCaption(text, index, matchOpts)) {
            await sb.rpc('mkt_ad_attribution_upsert', { p_paid_ad_id: up.id, p_project_id: c.projectId, p_method: c.method, p_confidence: c.confidence, p_evidence: c.evidence, p_auto_accept: c.autoAccept });
          }
          // per-new-creative insight + notification
          if (up.was_inserted) {
            const iid = (await sb.rpc('mkt_insight_emit', { p_kind: 'new_creative', p_dedup_key: insightKey('new_creative', ad.externalAdId), p_title: `إعلان جديد — ${advertiserLabel}`, p_body: ad.headline ?? null, p_severity: 'info', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: camp.id, p_evidence: { ad: ad.externalAdId } })).data as string | null;
            if (iid) await sb.rpc('mkt_notification_emit', { p_insight_id: iid, p_kind: 'new_creative', p_dedup_key: insightKey('notif', 'new_creative', ad.externalAdId), p_organization_id: adOrgId, p_project_id: null, p_payload: { advertiser: advertiserLabel } });
          }
        } catch (e) { stats.errors.push(`${ad.externalAdId}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      // page scan → removed-detection over THIS org's ads
      if (seen.length > 0) {
        const removed = (await sb.rpc('mkt_ad_mark_removed', { p_organization_id: adOrgId, p_platform: 'meta', p_seen_ids: seen, p_run_id: runId })).data as number;
        stats.skipped = Number(removed ?? 0);
      }
      // refresh campaign rollups + campaign-ended (competitor inactive) insights
      for (const cid of touchedCampaigns) {
        await sb.rpc('mkt_campaign_refresh', { p_campaign: cid });
        const { data: c } = await sb.from('mkt_ad_campaigns').select('is_active, ended_at, primary_headline').eq('id', cid).maybeSingle();
        if (c && !c.is_active && c.ended_at) {
          const iid = (await sb.rpc('mkt_insight_emit', { p_kind: 'campaign_ended', p_dedup_key: insightKey('campaign_ended', cid), p_title: `توقّفت حملة — ${advertiserLabel}`, p_body: (c.primary_headline as string) ?? null, p_severity: 'warning', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: cid, p_evidence: {} })).data as string | null;
          if (iid) await sb.rpc('mkt_notification_emit', { p_insight_id: iid, p_kind: 'campaign_ended', p_dedup_key: insightKey('notif', 'campaign_ended', cid), p_organization_id: adOrgId, p_project_id: null, p_payload: {} });
        }
      }
      // deterministic run-level insights
      for (const cid of newCampaignIds) {
        await sb.rpc('mkt_insight_emit', { p_kind: 'new_campaign', p_dedup_key: insightKey('new_campaign', cid), p_title: `حملة جديدة — ${advertiserLabel}`, p_body: null, p_severity: 'opportunity', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: cid, p_evidence: {} });
      }
      for (const [fp, n] of fpCounts) if (n >= 2) {
        await sb.rpc('mkt_insight_emit', { p_kind: 'creative_reused', p_dedup_key: insightKey('creative_reused', fp), p_title: `تصميم مُعاد استخدامه (${n}) — ${advertiserLabel}`, p_body: null, p_severity: 'info', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: null, p_evidence: { fingerprint: fp, count: n } });
      }
      if (newLandings > 0) {
        const dk = insightKey('new_landing', adOrgId, new Date().toISOString().slice(0, 10));
        await sb.rpc('mkt_insight_emit', { p_kind: 'new_landing_page', p_dedup_key: dk, p_title: `صفحات هبوط جديدة (${newLandings}) — ${advertiserLabel}`, p_body: null, p_severity: 'info', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: null, p_evidence: { count: newLandings } });
      }
      if (stats.inserted >= 5) {
        const dk = insightKey('burst', adOrgId, new Date().toISOString().slice(0, 10));
        const iid = (await sb.rpc('mkt_insight_emit', { p_kind: 'creative_burst', p_dedup_key: dk, p_title: `${advertiserLabel} أطلق ${stats.inserted} إعلانًا اليوم`, p_body: null, p_severity: 'opportunity', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: null, p_evidence: { count: stats.inserted } })).data as string | null;
        if (iid) await sb.rpc('mkt_notification_emit', { p_insight_id: iid, p_kind: 'creative_burst', p_dedup_key: insightKey('notif', dk), p_organization_id: adOrgId, p_project_id: null, p_payload: { count: stats.inserted } });
      }
    } else if (job.kind === 'attribution' || job.kind === 'reprocess') {
      const { data: posts } = await sb.from('mkt_content_posts').select('id, caption, organization_id').limit(500);
      stats.received = posts?.length ?? 0;
      const scopeCache = new Map<string, Awaited<ReturnType<typeof attributionScope>>>();
      for (const p of posts ?? []) {
        const org = (p.organization_id as string) ?? '';
        let scope = scopeCache.get(org);
        if (!scope) { scope = await attributionScope(sb, org || null); scopeCache.set(org, scope); }
        for (const c of attributeCaption((p.caption as string) ?? '', scope.index, scope.matchOpts)) {
          await sb.rpc('mkt_attribution_upsert', { p_content_post_id: p.id, p_project_id: c.projectId, p_method: c.method, p_confidence: c.confidence, p_evidence: c.evidence, p_matched_aliases: c.matchedAliases, p_auto_accept: c.autoAccept });
        }
      }
    } else {
      stats.errors.push(`kind ${job.kind} not implemented in this phase (paid_ads/account_metrics are Phase 2)`);
      stats.skipped = 1;
    }

    await sb.rpc('mkt_ingestion_run_finish', { p_run_id: runId, p_status: stats.errors.length ? 'partial' : 'succeeded', p_received: stats.received, p_inserted: stats.inserted, p_updated: stats.updated, p_skipped: stats.skipped, p_errors: stats.errors.slice(0, 20), p_cost: apifyCost ?? null });
    return { status: 'ok', stats };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e));
    // Carry the cost through on the failure path too — spend that already happened
    // is still spend, and dropping it here would under-report the cost dashboard
    // for exactly the runs most worth accounting for.
    await sb.rpc('mkt_ingestion_run_finish', { p_run_id: runId, p_status: 'failed', p_received: stats.received, p_inserted: stats.inserted, p_updated: stats.updated, p_skipped: stats.skipped, p_errors: [err.message], p_cost: apifyCost ?? null });
    if (err.health === 'budget_exhausted') {
      // The ACCOUNT is fine; the budget is spent. Leave its status alone, pause
      // the provider (unless this error came FROM the pause), and let index.ts
      // cancel the job instead of retrying it.
      if (!(err instanceof ProviderPausedError)) {
        const outcome = await pauseForBudget(sb, job.provider, err.message);
        if (!outcome.paused) {
          // Apify says there is budget left, so this is an outage, not a spent
          // month: hand it back as one so the queue retries with backoff rather
          // than cancelling the job and stopping collection.
          throw new ProviderError(`${err.message} — ${outcome.reason}`, 'unavailable');
        }
      }
      throw err;
    }
    if (err.health === 'not_found') {
      // The account is not there, so neither a retry nor a Browserbase scrape can
      // find it — and browserbaseFallbackEligible does not know this health, so
      // it must never reach that check. Switch the account off and let index.ts
      // end the job terminally.
      if (job.social_account_id) await disableMissingAccount(sb, job, job.social_account_id, (acct as Record<string, unknown> | null) ?? null, err.message);
      throw err;
    }
    await sb.from('mkt_social_accounts').update({ scrape_status: err.health === 'auth_failed' ? 'auth_failed' : err.health === 'rate_limited' ? 'rate_limited' : 'error' }).eq('id', job.social_account_id ?? '00000000-0000-0000-0000-000000000000');

    // Browserbase fallback — only when eligible per the strict rules.
    const attemptsExhausted = job.attempts >= job.max_attempts;
    const elig = browserbaseFallbackEligible({ primaryHealth: err.health, attemptsExhausted });
    if (elig.eligible && job.provider !== 'browserbase' && job.social_account_id) {
      await sb.rpc('mkt_job_enqueue', { p_kind: job.kind, p_provider: 'browserbase', p_social_account_id: job.social_account_id, p_params: { fallback_reason: elig.reason, primary_error: err.message }, p_priority: 90, p_requested_by: null, p_fallback_of: job.id });
    }
    throw err; // let index.ts call mkt_job_fail (backoff)
  }
}
