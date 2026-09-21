// ============================================================================
// Apify collection lifecycle — the SINGLE server-only implementation.
// ----------------------------------------------------------------------------
// Collection runs ONLY in the worker (all mkt_collection_jobs are worker jobs),
// so this is the one place the Apify start→poll→dataset flow lives. The API-side
// ApifyProvider is health-only (its collect path throws "runs in worker"), so
// there are NOT two divergent implementations. Actor IDs come from the DB
// (mkt_actor_configs) — never hardcoded. Secrets (APIFY_API_TOKEN) are read from
// process.env server-side and never returned to any caller.
//
// Cost posture (rewritten 2026-09-21). Measured against Apify's own billing for
// the cycle 2026-08-23 → 09-22: $31.65 against a $29 limit, 9,961 posts paid
// for, 221 of them new (2.2%). The budget ran out on day 14 and the rest of the
// month collected nothing. Three habits here caused it:
//
//   1. Every run asked for an account's latest 30 posts with no date cutoff.
//      These accounts post 0–1 times a day, so ~98% of each run was re-buying
//      posts we already had. Incremental runs now pass a cutoff — see
//      incrementalWindow(): newer than the last stored post, and never less
//      than the last 14 days so recent posts' like/view counts keep updating.
//   2. TikTok downloaded EVERY video on EVERY run (shouldDownloadVideos applies
//      to all results). It is now two passes: a metadata pass with the date
//      filter and no downloads, then a download pass over ONLY the new videos'
//      links (postURLs). Instagram media comes from Instagram's CDN, not Apify.
//   3. Downloaded videos stayed in Apify storage for 31 days, billed hourly
//      ($4.98 of the cycle, still accruing while collection was blocked). The
//      metadata pass's storage is deleted as soon as it is read; the download
//      pass's is deleted by sweepApifyStorage once our copy exists.
//
// And a spent budget is now recognised as such (classifyApifyError) instead of
// being retried as an outage — see mkt_provider_pause_for_budget.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseTiktokVideo, parseInstagramPost, ProviderError,
  type NormalizedContentPost, type Platform, type ProviderHealth,
} from './providers.js';

const APIFY = 'https://api.apify.com/v2';
const POLL_MS = 3000;

function token(): string {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) throw new ProviderError('APIFY_API_TOKEN not set', 'not_configured');
  return t;
}

/**
 * Map an Apify HTTP failure to a health code. A spent monthly limit arrives as
 *   403 {"error":{"type":"platform-feature-disabled","message":"Monthly usage hard limit exceeded"}}
 * or, for a run that cannot start,
 *   402 {"error":{"type":"not-enough-usage-to-run-paid-actor", …}}
 * Both are 'budget_exhausted' — NOT 'unavailable', which the queue retries.
 * Retrying a spent budget produced ~450 failed jobs a day for 16 days.
 */
export function classifyApifyError(status: number, body: string): ProviderHealth {
  if (status === 401) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if ((status === 402 || status === 403) && /monthly usage|hard limit|usage limit|not-enough-usage/i.test(body)) {
    return 'budget_exhausted';
  }
  return 'unavailable';
}

async function apify<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${APIFY}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const health = classifyApifyError(res.status, text);
    if (health === 'auth_failed') throw new ProviderError('Apify auth failed (401)', health);
    if (health === 'rate_limited') throw new ProviderError('Apify rate limited (429)', health);
    throw new ProviderError(`Apify ${res.status}: ${text.slice(0, 200)}`, health);
  }
  const txt = await res.text();
  return (txt ? JSON.parse(txt) : {}) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── budget ──────────────────────────────────────────────────────────────────

/** Thrown when we refuse to start a run because the provider is paused. It is
 *  a budget error for the queue (cancel, don't retry) but must NOT re-trigger
 *  the pause, which is already in force. */
export class ProviderPausedError extends ProviderError {
  constructor(message: string) { super(message, 'budget_exhausted'); this.name = 'ProviderPausedError'; }
}

/** When does Apify's current billing cycle end? This is when a spent limit
 *  renews, so it is how long collection should stay paused. */
export async function apifyCycleEnd(): Promise<string | null> {
  const r = await apify<{ data?: { monthlyUsageCycle?: { endAt?: string } } }>('GET', '/users/me/limits');
  return r.data?.monthlyUsageCycle?.endAt ?? null;
}

/** Refuse to start a paid run while the provider is paused. A failed read is
 *  thrown, not ignored: guessing "not paused" is how a paused account gets
 *  hammered, and guessing "paused" would silently stop collection. */
export async function assertProviderNotPaused(sb: SupabaseClient, provider = 'apify'): Promise<void> {
  const { data, error } = await sb.from('mkt_providers').select('paused_until, pause_reason').eq('provider_key', provider).maybeSingle();
  if (error) throw new ProviderError(`could not read ${provider} pause state: ${error.message}`, 'unavailable');
  const until = (data as { paused_until?: string | null } | null)?.paused_until;
  if (until && new Date(until).getTime() > Date.now()) {
    throw new ProviderPausedError(`paused: ${provider} monthly budget used up until ${until}`);
  }
}

// ── actor config + inputs ───────────────────────────────────────────────────

export interface ActorConfig { sourceType: string; actorId: string; resultParser: string; isEnabled: boolean }

export async function readActorConfig(sb: SupabaseClient, sourceType: string): Promise<ActorConfig | null> {
  const { data, error } = await sb
    .from('mkt_actor_configs')
    .select('source_type, actor_id, result_parser, is_enabled')
    .eq('source_type', sourceType)
    .order('is_enabled', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { sourceType: data.source_type as string, actorId: data.actor_id as string, resultParser: data.result_parser as string, isEnabled: Boolean(data.is_enabled) };
}

function sourceTypeFor(platform: Platform): string {
  switch (platform) {
    case 'instagram': return 'instagram_profile';
    case 'tiktok': return 'tiktok_profile';
    case 'facebook': return 'facebook_posts';
    default: throw new ProviderError(`Apify: no actor family for platform ${platform}`, 'config_invalid');
  }
}

export interface InputOptions {
  /** ISO instant; only posts published on/after it are returned (and billed). */
  newerThan?: string;
  /** TikTok only: fetch exactly these videos, WITH the video file downloaded. */
  postUrls?: string[];
}

/**
 * Actor input. Field names are from each actor's published input schema
 * (read 2026-09-21): apify/instagram-scraper `onlyPostsNewerThan`;
 * clockworks/tiktok-scraper `oldestPostDateUnified` (a date, inclusive),
 * `profileSorting` (date filters only apply to latest/oldest) and `postURLs`.
 */
export function buildInput(sourceType: string, handle: string, limit: number, opts: InputOptions = {}): Record<string, unknown> {
  switch (sourceType) {
    case 'instagram_profile':
      return {
        directUrls: [`https://www.instagram.com/${handle}/`], resultsType: 'posts', resultsLimit: limit,
        ...(opts.newerThan ? { onlyPostsNewerThan: opts.newerThan } : {}),
      };
    case 'tiktok_profile':
      if (opts.postUrls && opts.postUrls.length > 0) {
        // Download pass. shouldDownloadVideos makes clockworks re-host the file
        // in the run's key-value store (TikTok's own links need cookies and
        // expire), which is the only way we can store TikTok videos. It is a
        // charged add-on, so it runs for new videos only.
        return { postURLs: opts.postUrls, resultsPerPage: opts.postUrls.length, shouldDownloadVideos: true, shouldDownloadCovers: true };
      }
      // Metadata pass: engagement + ids, no files.
      return {
        profiles: [handle], resultsPerPage: limit, profileSorting: 'latest',
        shouldDownloadVideos: false, shouldDownloadCovers: false,
        ...(opts.newerThan ? { oldestPostDateUnified: opts.newerThan.slice(0, 10) } : {}),
      };
    case 'facebook_posts': return { startUrls: [{ url: `https://www.facebook.com/${handle}` }], maxPosts: limit };
    default: return { handle, limit };
  }
}

// ── the incremental window ──────────────────────────────────────────────────

/** Recent posts keep collecting likes/views; refreshing them is the one useful
 *  thing re-reading does. Past two weeks the numbers barely move. */
export const ENGAGEMENT_WINDOW_DAYS = 14;
/** Ceiling for a normal daily run. The busiest tracked account posts ~0.9/day,
 *  so a 14-day window holds ~13 posts. */
export const INCREMENTAL_CEILING = 30;
/** Ceiling when catching up after a gap (e.g. a paused month). Hitting it is
 *  reported as a warning on the run, never silently accepted. */
export const CATCH_UP_CEILING = 100;

export interface IncrementalWindow { newerThan?: string; limit: number; mode: 'window' | 'catch_up' | 'no_history' }

/**
 * What an incremental run should ask for: everything newer than the last post
 * we stored (so a gap is always filled), and at least the last 14 days (so
 * engagement on recent posts stays current). No stored posts → no cutoff.
 */
export function incrementalWindow(newestStoredIso: string | null, now: Date = new Date()): IncrementalWindow {
  const windowStart = new Date(now.getTime() - ENGAGEMENT_WINDOW_DAYS * 86_400_000);
  const newest = newestStoredIso ? new Date(newestStoredIso) : null;
  if (!newest || Number.isNaN(newest.getTime())) return { limit: INCREMENTAL_CEILING, mode: 'no_history' };
  if (newest < windowStart) return { newerThan: newest.toISOString(), limit: CATCH_UP_CEILING, mode: 'catch_up' };
  return { newerThan: windowStart.toISOString(), limit: INCREMENTAL_CEILING, mode: 'window' };
}

// ── one run ─────────────────────────────────────────────────────────────────

type Parser = (item: Record<string, unknown>, handle: string) => NormalizedContentPost | null;
const PARSERS: Record<string, Parser> = {
  parseTiktokVideos: parseTiktokVideo,
  parseInstagramPosts: parseInstagramPost,
  // parseFacebookPosts wired when FB is validated
};

interface ApifyRunData {
  id: string; status: string; defaultDatasetId?: string; defaultKeyValueStoreId?: string; defaultRequestQueueId?: string;
  stats?: Record<string, unknown>; usageTotalUsd?: number;
}
interface ApifyRun { data: ApifyRunData }

/** Poll a run to a terminal state; abort on our own timeout (stops runaway cost). */
async function pollRun(runId: string, timeoutMs: number): Promise<ApifyRunData> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await apify<ApifyRun>('GET', `/actor-runs/${runId}`);
    const st = r.data.status;
    if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(st)) return r.data;
    await sleep(POLL_MS);
  }
  try {
    await apify<unknown>('POST', `/actor-runs/${runId}/abort`);
  } catch (e) {
    // The run keeps billing until it ends on its own; say so rather than hide it.
    console.error(`[apify] abort of timed-out run ${runId} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new ProviderError('Apify run poll timeout (aborted)', 'unavailable');
}

export interface ApifyActorResult {
  runId: string;
  rawItems: Array<Record<string, unknown>>;
  cost: Record<string, unknown>; // provider-reported usage only (never estimated)
}
export interface ApifyCollectResult extends ApifyActorResult {
  posts: NormalizedContentPost[];
  /** Things that went partly wrong and must be visible on the run (never silent). */
  warnings: string[];
}

/**
 * SHARED lifecycle primitive: START one run → poll (timeout+abort) → dataset.
 * Both organic collection (collectViaApify) and the Meta Ad Library provider use
 * this — one implementation of the Apify run flow. `limit` bounds dataset items.
 */
export async function runApifyActor(
  actorId: string, input: Record<string, unknown>, limit: number, timeoutMs = 180000,
): Promise<ApifyActorResult> {
  const started = await apify<ApifyRun>('POST', `/acts/${actorId.replace('/', '~')}/runs`, input);
  const runId = started.data.id;
  const finished = await pollRun(runId, timeoutMs);
  if (finished.status !== 'SUCCEEDED') throw new ProviderError(`Apify run ${finished.status} (run ${runId})`, 'unavailable');
  const datasetId = finished.defaultDatasetId;
  if (!datasetId) throw new ProviderError('Apify run has no dataset', 'unavailable');
  const rawItems = await apify<Array<Record<string, unknown>>>('GET', `/datasets/${datasetId}/items?clean=true&limit=${limit}`);
  return {
    runId, rawItems,
    cost: { run_id: runId, dataset_items: rawItems.length,
      compute_units: (finished.stats as { computeUnits?: number } | undefined)?.computeUnits ?? null,
      usage_total_usd: finished.usageTotalUsd ?? null },
  };
}

// ── storage ─────────────────────────────────────────────────────────────────

/** DELETE that treats "already gone" as success (Apify expires storage itself). */
async function apifyDelete(path: string): Promise<'deleted' | 'gone'> {
  const res = await fetch(`${APIFY}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
  if (res.status === 404) return 'gone';
  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(`Apify DELETE ${path} → ${res.status}: ${text.slice(0, 200)}`, classifyApifyError(res.status, text));
  }
  return 'deleted';
}

export interface StorageDeletion { runId: string; deleted: string[]; gone: string[] }

/**
 * Delete everything a run left in Apify storage: its dataset (our results),
 * key-value store (TikTok videos + covers) and request queue. Throws on a real
 * failure so the caller can record it; a run Apify already expired is 'gone'.
 */
export async function deleteApifyRunStorage(runId: string): Promise<StorageDeletion> {
  const out: StorageDeletion = { runId, deleted: [], gone: [] };
  const res = await fetch(`${APIFY}/actor-runs/${runId}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (res.status === 404) { out.gone.push(`run:${runId}`); return out; }
  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(`Apify GET run ${runId} → ${res.status}: ${text.slice(0, 200)}`, classifyApifyError(res.status, text));
  }
  const run = ((await res.json()) as ApifyRun).data;
  const targets: Array<[string, string | undefined]> = [
    ['datasets', run.defaultDatasetId], ['key-value-stores', run.defaultKeyValueStoreId], ['request-queues', run.defaultRequestQueueId],
  ];
  for (const [kind, id] of targets) {
    if (!id) continue;
    const r = await apifyDelete(`/${kind}/${id}`);
    (r === 'deleted' ? out.deleted : out.gone).push(`${kind}:${id}`);
  }
  return out;
}

// ── organic collection ──────────────────────────────────────────────────────

export interface CollectInput {
  platform: Platform; handle: string; limit: number; timeoutMs?: number;
  /** ISO instant — see incrementalWindow(). Omit for "latest `limit` posts". */
  newerThan?: string;
  /** Which of these external ids are already stored? Decides which TikTok
   *  videos get downloaded. Required for TikTok. */
  knownExternalIds?: (ids: string[]) => Promise<Set<string>>;
}

/**
 * Organic collection: config → metadata pass (date-filtered, no downloads) →
 * delete that run's storage → [TikTok only] download pass for new videos.
 */
export async function collectViaApify(sb: SupabaseClient, input: CollectInput): Promise<ApifyCollectResult> {
  const sourceType = sourceTypeFor(input.platform);
  const cfg = await readActorConfig(sb, sourceType);
  if (!cfg) throw new ProviderError(`No actor configured for ${sourceType}`, 'config_invalid');
  if (!cfg.isEnabled) throw new ProviderError(`Actor for ${sourceType} is disabled (vet + enable in mkt_actor_configs)`, 'config_invalid');
  const parser = PARSERS[cfg.resultParser];
  if (!parser) throw new ProviderError(`No parser named "${cfg.resultParser}"`, 'config_invalid');
  await assertProviderNotPaused(sb);

  const warnings: string[] = [];

  // 1. metadata pass
  const meta = await runApifyActor(cfg.actorId, buildInput(sourceType, input.handle, input.limit, { newerThan: input.newerThan }), input.limit, input.timeoutMs);
  let posts = meta.rawItems.map((it) => parser(it, input.handle)).filter((p): p is NormalizedContentPost => p !== null);
  if (meta.rawItems.length >= input.limit) {
    warnings.push(`hit the ${input.limit}-post ceiling${input.newerThan ? ` inside the window from ${input.newerThan}` : ''}; older posts in that range were not fetched`);
  }

  // 2. the metadata pass holds nothing we need once read — drop it now rather
  //    than pay to keep it for 31 days.
  const storageDeleted: string[] = [];
  try {
    await deleteApifyRunStorage(meta.runId);
    storageDeleted.push(meta.runId);
  } catch (e) {
    const msg = `storage cleanup of run ${meta.runId} failed (the sweep retries it): ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[apify] ${msg}`);
    warnings.push(msg);
  }

  const runs: Array<Record<string, unknown>> = [{ run_id: meta.runId, pass: 'metadata', items: meta.rawItems.length, usage_total_usd: meta.cost.usage_total_usd ?? null }];
  const pendingStorage: string[] = [];
  let downloadRaw: Array<Record<string, unknown>> = [];

  // 3. TikTok: download only the videos we do not have yet.
  if (input.platform === 'tiktok' && posts.length > 0) {
    if (!input.knownExternalIds) throw new ProviderError('TikTok collection needs knownExternalIds to decide what to download', 'config_invalid');
    const known = await input.knownExternalIds(posts.map((p) => p.externalId));
    const fresh = posts.filter((p) => !known.has(p.externalId) && p.postUrl);
    if (fresh.length > 0) {
      const dl = await runApifyActor(cfg.actorId, buildInput(sourceType, input.handle, fresh.length, { postUrls: fresh.map((p) => p.postUrl!) }), fresh.length, input.timeoutMs);
      downloadRaw = dl.rawItems;
      pendingStorage.push(dl.runId); // holds the video files until our copy exists
      runs.push({ run_id: dl.runId, pass: 'download', items: dl.rawItems.length, usage_total_usd: dl.cost.usage_total_usd ?? null });
      const withFiles = new Map<string, NormalizedContentPost>();
      for (const it of dl.rawItems) { const p = parser(it, input.handle); if (p) withFiles.set(p.externalId, p); }
      const missing = fresh.filter((p) => !withFiles.has(p.externalId)).map((p) => p.externalId);
      if (missing.length > 0) warnings.push(`download pass returned no file for ${missing.length} new video(s): ${missing.slice(0, 5).join(', ')}`);
      posts = posts.map((p) => withFiles.get(p.externalId) ?? p);
    }
  }

  const totalUsd = runs.reduce((s, r) => s + (typeof r.usage_total_usd === 'number' ? r.usage_total_usd : 0), 0);
  const cost: Record<string, unknown> = {
    ...meta.cost,                     // run_id = the metadata run (kept for existing reports)
    // One run: pass Apify's figure through untouched (null stays "unknown").
    usage_total_usd: runs.length > 1 ? totalUsd : meta.cost.usage_total_usd,
    runs,
    newer_than: input.newerThan ?? null,
    storage_deleted_runs: storageDeleted,
    pending_storage_runs: pendingStorage,
  };
  return { posts, runId: meta.runId, rawItems: [...meta.rawItems, ...downloadRaw], cost, warnings };
}
