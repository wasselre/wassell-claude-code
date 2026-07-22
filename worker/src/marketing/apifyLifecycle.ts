// ============================================================================
// Apify collection lifecycle — the SINGLE server-only implementation.
// ----------------------------------------------------------------------------
// Collection runs ONLY in the worker (all mkt_collection_jobs are worker jobs),
// so this is the one place the Apify start→poll→dataset flow lives. The API-side
// ApifyProvider is health-only (its collect path throws "runs in worker"), so
// there are NOT two divergent implementations. Actor IDs come from the DB
// (mkt_actor_configs) — never hardcoded. Secrets (APIFY_API_TOKEN) are read from
// process.env server-side and never returned to any caller.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseTiktokVideo, parseInstagramPost, ProviderError,
  type NormalizedContentPost, type Platform,
} from './providers.js';

const APIFY = 'https://api.apify.com/v2';
const POLL_MS = 3000;

function token(): string {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) throw new ProviderError('APIFY_API_TOKEN not set', 'not_configured');
  return t;
}

async function apify<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${APIFY}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new ProviderError('Apify auth failed (401)', 'auth_failed');
  if (res.status === 429) throw new ProviderError('Apify rate limited (429)', 'rate_limited');
  if (!res.ok) throw new ProviderError(`Apify ${res.status}: ${(await res.text()).slice(0, 200)}`, 'unavailable');
  const txt = await res.text();
  return (txt ? JSON.parse(txt) : {}) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function buildInput(sourceType: string, handle: string, limit: number): Record<string, unknown> {
  switch (sourceType) {
    case 'instagram_profile': return { directUrls: [`https://www.instagram.com/${handle}/`], resultsType: 'posts', resultsLimit: limit };
    case 'tiktok_profile': return { profiles: [handle], resultsPerPage: limit, shouldDownloadVideos: false, shouldDownloadCovers: false };
    case 'facebook_posts': return { startUrls: [{ url: `https://www.facebook.com/${handle}` }], maxPosts: limit };
    default: return { handle, limit };
  }
}

type Parser = (item: Record<string, unknown>, handle: string) => NormalizedContentPost | null;
const PARSERS: Record<string, Parser> = {
  parseTiktokVideos: parseTiktokVideo,
  parseInstagramPosts: parseInstagramPost,
  // parseFacebookPosts wired when FB is validated
};

interface ApifyRun {
  data: { id: string; status: string; defaultDatasetId?: string; stats?: Record<string, unknown>; usageTotalUsd?: number };
}

/** Poll a run to a terminal state; abort on our own timeout (stops runaway cost). */
async function pollRun(runId: string, timeoutMs: number): Promise<ApifyRun['data']> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await apify<ApifyRun>('GET', `/actor-runs/${runId}`);
    const st = r.data.status;
    if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(st)) return r.data;
    await sleep(POLL_MS);
  }
  await apify<unknown>('POST', `/actor-runs/${runId}/abort`).catch(() => {}); // best-effort stop
  throw new ProviderError('Apify run poll timeout (aborted)', 'unavailable');
}

export interface ApifyCollectResult {
  posts: NormalizedContentPost[];
  runId: string;
  rawItems: Array<Record<string, unknown>>;
  cost: Record<string, unknown>; // provider-reported usage only (never estimated)
}

/**
 * Full lifecycle: config → input → START one run → poll (with timeout+abort) →
 * dataset → parse. `limit` bounds posts (validation caps at 10–20). Returns raw
 * items so the caller stores raw ingestion records before normalizing.
 */
export async function collectViaApify(
  sb: SupabaseClient,
  input: { platform: Platform; handle: string; limit: number; timeoutMs?: number },
): Promise<ApifyCollectResult> {
  const sourceType = sourceTypeFor(input.platform);
  const cfg = await readActorConfig(sb, sourceType);
  if (!cfg) throw new ProviderError(`No actor configured for ${sourceType}`, 'config_invalid');
  if (!cfg.isEnabled) throw new ProviderError(`Actor for ${sourceType} is disabled (vet + enable in mkt_actor_configs)`, 'config_invalid');
  const parser = PARSERS[cfg.resultParser];
  if (!parser) throw new ProviderError(`No parser named "${cfg.resultParser}"`, 'config_invalid');

  const runInput = buildInput(sourceType, input.handle, input.limit);
  // START one run (async — no sync-timeout ceiling).
  const started = await apify<ApifyRun>('POST', `/acts/${cfg.actorId.replace('/', '~')}/runs`, runInput);
  const runId = started.data.id;
  const finished = await pollRun(runId, input.timeoutMs ?? 180000);
  if (finished.status !== 'SUCCEEDED') {
    throw new ProviderError(`Apify run ${finished.status} (run ${runId})`, 'unavailable');
  }
  const datasetId = finished.defaultDatasetId;
  if (!datasetId) throw new ProviderError('Apify run has no dataset', 'unavailable');
  const rawItems = await apify<Array<Record<string, unknown>>>('GET', `/datasets/${datasetId}/items?clean=true&limit=${input.limit}`);
  const posts = rawItems.map((it) => parser(it, input.handle)).filter((p): p is NormalizedContentPost => p !== null);
  const cost: Record<string, unknown> = {
    run_id: runId,
    dataset_items: rawItems.length,
    compute_units: (finished.stats as { computeUnits?: number } | undefined)?.computeUnits ?? null,
    usage_total_usd: finished.usageTotalUsd ?? null,
  };
  return { posts, runId, rawItems, cost };
}
