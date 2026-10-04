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

export interface ApifyBudgetState {
  /** Spend so far this billing cycle, as Apify reports it. */
  usedUsd: number | null;
  /** The plan's monthly spending limit. */
  capUsd: number | null;
  /** When the limit renews — how long a genuinely spent budget should pause. */
  cycleEnd: string | null;
}

/** Apify's own view of the money: used, limit, and when the cycle rolls. */
export async function apifyBudgetState(): Promise<ApifyBudgetState> {
  const r = await apify<{ data?: {
    monthlyUsageCycle?: { endAt?: string };
    limits?: { maxMonthlyUsageUsd?: number };
    current?: { monthlyUsageUsd?: number };
  } }>('GET', '/users/me/limits');
  const d = r.data ?? {};
  return {
    usedUsd: typeof d.current?.monthlyUsageUsd === 'number' ? d.current.monthlyUsageUsd : null,
    capUsd: typeof d.limits?.maxMonthlyUsageUsd === 'number' ? d.limits.maxMonthlyUsageUsd : null,
    cycleEnd: d.monthlyUsageCycle?.endAt ?? null,
  };
}

/** Headroom below which we believe a budget refusal. Covers rounding and the
 *  cost of the refused run itself. */
const BUDGET_SPENT_MARGIN_USD = 0.5;

export type BudgetAction =
  | { action: 'pause'; until: string | null; reason: string }
  | { action: 'retry'; reason: string };

/**
 * A provider refusal that SAYS "no budget" is not always true.
 *
 * On 2026-09-23 at 00:00:19 UTC — nineteen seconds into a fresh billing cycle —
 * Apify answered 402 "Your remaining usage of $0.00 this billing cycle isn't
 * enough for this run" while its own limits endpoint reported $29 available.
 * The pause took the refusal at face value, read the NEW cycle's end date, and
 * stopped all collection until 2026-10-22. Four days were lost before anyone
 * looked. The bug was pausing for a month on a single refusal at the one moment
 * a refusal is least trustworthy.
 *
 * So the money is checked against Apify's own figures before pausing: real
 * exhaustion pauses to the cycle end; anything else is an outage and goes back
 * to the queue's ordinary bounded retries.
 */
export function decideBudgetAction(state: ApifyBudgetState | null): BudgetAction {
  if (!state || state.capUsd == null || state.usedUsd == null) {
    // Cannot read the limit: pause, but only until the cycle end we know of
    // (or, with none, let the caller fall back to a short pause).
    return { action: 'pause', until: state?.cycleEnd ?? null, reason: 'limit unreadable — pausing on the provider word' };
  }
  const remaining = state.capUsd - state.usedUsd;
  if (remaining > BUDGET_SPENT_MARGIN_USD) {
    return {
      action: 'retry',
      reason: `provider refused but its own limit reports $${state.usedUsd.toFixed(2)} of $${state.capUsd} used ($${remaining.toFixed(2)} left) — treating as a transient refusal, not a spent budget`,
    };
  }
  return {
    action: 'pause', until: state.cycleEnd,
    reason: `budget spent: $${state.usedUsd.toFixed(2)} of $${state.capUsd} used`,
  };
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
  /** Fetch exactly these posts (Instagram post links / TikTok video links). */
  postUrls?: string[];
  /** TikTok + postUrls: re-host the video file too (charged add-on). Defaults to
   *  true, which is what the download pass and the redownload need; the views
   *  and likes re-check passes false (it only wants the numbers). */
  download?: boolean;
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
      // Post links in directUrls return exactly those posts (verified live
      // 2026-10-04: two post links in, two posts with likes/comments out).
      if (opts.postUrls && opts.postUrls.length > 0) {
        return { directUrls: opts.postUrls, resultsType: 'posts', resultsLimit: opts.postUrls.length };
      }
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
        const download = opts.download !== false;
        return { postURLs: opts.postUrls, resultsPerPage: opts.postUrls.length, shouldDownloadVideos: download, shouldDownloadCovers: download };
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
//
// Operator decision 2026-10-04: collect each account's last 12 months ONCE,
// then only posts newer than the newest one we hold. Views and likes are NOT
// refreshed by re-reading recent posts any more — that re-bought every post of
// the last 14 days on every run (about 14 paid reads per post for a daily
// account). They are re-checked twice per post instead, at 7 and 30 days old
// (the post_metrics job), so every post is measured at the same ages.

/** How far back the first collection of an account reaches. */
export const HISTORY_DAYS = 365;
/** Ceiling for the one-time history run. The busiest tracked account posted
 *  ~260 times in 12 months; hitting this is reported on the run, never silent. */
export const HISTORY_CEILING = 1500;
/** Ceiling for a normal run: the new posts since the last one. */
export const INCREMENTAL_CEILING = 100;
/** Ask again for the day before our newest post, so a post the platform lists
 *  late is not skipped. Posts are de-duplicated by id: the overlap costs at most
 *  a post or two, never a duplicate row. */
export const OVERLAP_HOURS = 24;
/** A gap longer than this (collection paused) is caught up with the history
 *  ceiling instead of the normal one. */
export const LONG_GAP_DAYS = 30;

export interface IncrementalWindow { newerThan: string; limit: number; mode: 'history' | 'new_only' }

/**
 * What an incremental run should ask for.
 *   - history not collected yet → the last 12 months, once (mode 'history').
 *   - otherwise → everything since our newest post (or since the history run,
 *     whichever is later) minus a one-day overlap, never older than 12 months.
 */
export function incrementalWindow(newestStoredIso: string | null, historyDoneAtIso: string | null, now: Date = new Date()): IncrementalWindow {
  const historyStart = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const historyDone = historyDoneAtIso ? new Date(historyDoneAtIso) : null;
  if (!historyDone || Number.isNaN(historyDone.getTime())) {
    return { newerThan: historyStart.toISOString(), limit: HISTORY_CEILING, mode: 'history' };
  }
  const newest = newestStoredIso ? new Date(newestStoredIso) : null;
  const anchor = newest && !Number.isNaN(newest.getTime()) && newest > historyDone ? newest : historyDone;
  let from = new Date(anchor.getTime() - OVERLAP_HOURS * 3_600_000);
  if (from < historyStart) from = historyStart;
  const longGap = now.getTime() - anchor.getTime() > LONG_GAP_DAYS * 86_400_000;
  return { newerThan: from.toISOString(), limit: longGap ? HISTORY_CEILING : INCREMENTAL_CEILING, mode: 'new_only' };
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

export interface RedownloadInput {
  handle: string;
  /** TikTok post links whose video file we never received. */
  postUrls: string[];
  timeoutMs?: number;
  /**
   * Run even though the provider is paused. ONLY for a recovery the operator
   * explicitly approved while regular collection is stopped — the standing
   * sweep never sets it (mkt_enqueue_tiktok_redownloads refuses while paused).
   */
  operatorApproved?: boolean;
}

/**
 * The TikTok download pass on its own, for videos collected earlier whose file
 * never arrived (the pass only ever ran for the NEW videos of a run, so a miss
 * was permanent). No metadata pass, no date window: exactly these links.
 * The run's storage holds the files until our copy exists — it is returned in
 * pending_storage_runs so the storage sweep cleans it up like any download run.
 */
export async function redownloadTikTokVideos(sb: SupabaseClient, input: RedownloadInput): Promise<ApifyCollectResult> {
  const sourceType = sourceTypeFor('tiktok');
  const cfg = await readActorConfig(sb, sourceType);
  if (!cfg) throw new ProviderError(`No actor configured for ${sourceType}`, 'config_invalid');
  if (!cfg.isEnabled) throw new ProviderError(`Actor for ${sourceType} is disabled (vet + enable in mkt_actor_configs)`, 'config_invalid');
  const parser = PARSERS[cfg.resultParser];
  if (!parser) throw new ProviderError(`No parser named "${cfg.resultParser}"`, 'config_invalid');
  if (!input.operatorApproved) await assertProviderNotPaused(sb);
  if (input.postUrls.length === 0) return { posts: [], runId: '', rawItems: [], cost: {}, warnings: [] };

  const dl = await runApifyActor(cfg.actorId, buildInput(sourceType, input.handle, input.postUrls.length, { postUrls: input.postUrls }), input.postUrls.length, input.timeoutMs);
  const posts = dl.rawItems.map((it) => parser(it, input.handle)).filter((p): p is NormalizedContentPost => p !== null);
  const warnings: string[] = [];
  // Match on the video id, not the URL string: TikTok hands links back in more
  // than one spelling, and a string mismatch would report a delivered video as lost.
  const returned = new Set(posts.map((p) => p.externalId));
  const videoId = (u: string): string => /\/video\/(\d+)/.exec(u)?.[1] ?? u;
  const missing = input.postUrls.filter((u) => !returned.has(videoId(u)));
  if (missing.length > 0) warnings.push(`re-download returned nothing for ${missing.length} of ${input.postUrls.length} video(s) (deleted or private?): ${missing.slice(0, 5).join(', ')}`);
  const cost: Record<string, unknown> = {
    ...dl.cost,
    runs: [{ run_id: dl.runId, pass: 'redownload', items: dl.rawItems.length, usage_total_usd: dl.cost.usage_total_usd ?? null }],
    storage_deleted_runs: [],
    pending_storage_runs: [dl.runId],
  };
  return { posts, runId: dl.runId, rawItems: dl.rawItems, cost, warnings };
}

export interface FetchByUrlInput {
  platform: 'instagram' | 'tiktok';
  handle: string;
  /** The posts to re-read (their own links). */
  postUrls: string[];
  timeoutMs?: number;
}

/**
 * Re-read specific posts for their current views/likes (the 7- and 30-day
 * checks). No files, no date window: exactly these links, billed per post
 * returned. The run holds nothing we need once read, so its storage is
 * deleted straight away, like the metadata pass.
 */
export async function fetchPostsByUrl(sb: SupabaseClient, input: FetchByUrlInput): Promise<ApifyCollectResult> {
  const sourceType = sourceTypeFor(input.platform);
  const cfg = await readActorConfig(sb, sourceType);
  if (!cfg) throw new ProviderError(`No actor configured for ${sourceType}`, 'config_invalid');
  if (!cfg.isEnabled) throw new ProviderError(`Actor for ${sourceType} is disabled (vet + enable in mkt_actor_configs)`, 'config_invalid');
  const parser = PARSERS[cfg.resultParser];
  if (!parser) throw new ProviderError(`No parser named "${cfg.resultParser}"`, 'config_invalid');
  await assertProviderNotPaused(sb);
  if (input.postUrls.length === 0) return { posts: [], runId: '', rawItems: [], cost: {}, warnings: [] };

  const r = await runApifyActor(cfg.actorId, buildInput(sourceType, input.handle, input.postUrls.length, { postUrls: input.postUrls, download: false }), input.postUrls.length, input.timeoutMs);
  const posts = r.rawItems.map((it) => parser(it, input.handle)).filter((p): p is NormalizedContentPost => p !== null);
  const warnings: string[] = [];
  const storageDeleted: string[] = [];
  try {
    await deleteApifyRunStorage(r.runId);
    storageDeleted.push(r.runId);
  } catch (e) {
    const msg = `storage cleanup of run ${r.runId} failed (the sweep retries it): ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[apify] ${msg}`);
    warnings.push(msg);
  }
  const cost: Record<string, unknown> = {
    ...r.cost,
    runs: [{ run_id: r.runId, pass: 'metrics', items: r.rawItems.length, usage_total_usd: r.cost.usage_total_usd ?? null }],
    storage_deleted_runs: storageDeleted,
    pending_storage_runs: storageDeleted.length ? [] : [r.runId],
  };
  return { posts, runId: r.runId, rawItems: r.rawItems, cost, warnings };
}
