/**
 * sweepApifyStorage — delete what our Apify runs left in Apify storage.
 *
 * Every run leaves a dataset, a key-value store and a request queue behind, and
 * Apify bills them by the GB-hour for 31 days. For TikTok the key-value store
 * holds the downloaded video files. In the cycle 2026-08-23 → 09-22 that was
 * $4.98 of a $29 budget, and it kept charging ~$0.17/day while collection was
 * blocked. Our copy lives in our own bucket; Apify's copy is only needed until
 * the media step has fetched it.
 *
 * Metadata-only runs are deleted inline by collectViaApify. This sweep handles
 * the rest: TikTok download runs, anything whose inline delete failed, and every
 * historical run from before 2026-09-21.
 *
 * Safety rule for runs that may hold video files: delete only once every TikTok
 * post from that run has a media row (stored OR failed — both are final). If a
 * post still has none after 7 days, stop waiting: recovery has had its chance,
 * and Apify deletes the files itself at 31 days anyway.
 *
 * Bounded (small batch per tick) and idempotent: a swept run is stamped in
 * provider_cost.storage_swept_at and never looked at again.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deleteApifyRunStorage } from './apifyLifecycle.js';

/** Give the media step this long before touching a run's storage at all. */
const MIN_AGE_MS = 6 * 3_600_000;
/** After this, a post still without media is not coming; free the storage. */
const GIVE_UP_MS = 7 * 86_400_000;

export interface StorageSweepStats { examined: number; swept: number; deferred: number; errors: string[] }

interface RunRow {
  id: string; finished_at: string; source_account_id: string | null;
  provider_cost: Record<string, unknown> | null;
}

/** Apify run ids recorded on one of our ingestion runs, minus those already deleted. */
export function apifyRunIdsToSweep(cost: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  if (typeof cost.run_id === 'string') ids.add(cost.run_id);
  if (Array.isArray(cost.runs)) for (const r of cost.runs as Array<{ run_id?: unknown }>) if (typeof r?.run_id === 'string') ids.add(r.run_id);
  if (Array.isArray(cost.pending_storage_runs)) for (const r of cost.pending_storage_runs) if (typeof r === 'string') ids.add(r);
  if (Array.isArray(cost.storage_deleted_runs)) for (const r of cost.storage_deleted_runs) ids.delete(r as string);
  return [...ids];
}

/** Could this run hold video files we still need? New-style runs say so
 *  explicitly (pending_storage_runs); pre-2026-09-21 TikTok runs downloaded
 *  every video, so they all might. Instagram media never lives in Apify. */
export function mayHoldMedia(cost: Record<string, unknown>, platform: string | null): boolean {
  if (Array.isArray(cost.runs)) return Array.isArray(cost.pending_storage_runs) && cost.pending_storage_runs.length > 0;
  return platform === 'tiktok';
}

/** How many TikTok posts ingested by this run have no media row yet. */
async function postsAwaitingMedia(sb: SupabaseClient, ingestionRunId: string): Promise<number> {
  const { data: raws, error: rErr } = await sb.from('mkt_raw_ingestions').select('external_identity')
    .eq('ingestion_run_id', ingestionRunId);
  if (rErr) throw new Error(`raw ingestions: ${rErr.message}`);
  const ext = [...new Set((raws ?? []).map((r) => r.external_identity as string).filter(Boolean))];
  if (ext.length === 0) return 0;
  const { data: posts, error: pErr } = await sb.from('mkt_content_posts').select('id')
    .eq('platform', 'tiktok').in('external_id', ext);
  if (pErr) throw new Error(`posts: ${pErr.message}`);
  const postIds = (posts ?? []).map((p) => p.id as string);
  if (postIds.length === 0) return 0;
  const { data: media, error: mErr } = await sb.from('mkt_content_media').select('content_post_id')
    .in('content_post_id', postIds);
  if (mErr) throw new Error(`media: ${mErr.message}`);
  const withMedia = new Set((media ?? []).map((m) => m.content_post_id as string));
  return postIds.filter((id) => !withMedia.has(id)).length;
}

export async function sweepApifyStorage(sb: SupabaseClient, opts: { limit?: number; now?: number } = {}): Promise<StorageSweepStats> {
  const limit = opts.limit ?? 25;
  const now = opts.now ?? Date.now();
  const stats: StorageSweepStats = { examined: 0, swept: 0, deferred: 0, errors: [] };
  if (!process.env.APIFY_API_TOKEN) return stats; // nothing we could delete with

  const { data, error } = await sb.from('mkt_ingestion_runs')
    .select('id, finished_at, source_account_id, provider_cost')
    .eq('provider', 'apify')
    .not('provider_cost->>run_id', 'is', null)
    .is('provider_cost->>storage_swept_at', null)
    .lt('finished_at', new Date(now - MIN_AGE_MS).toISOString())
    .order('finished_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`apify storage sweep: load runs: ${error.message}`);

  const platformOf = new Map<string, string>();
  const accountIds = [...new Set((data ?? []).map((r) => r.source_account_id as string | null).filter((x): x is string => !!x))];
  if (accountIds.length > 0) {
    const { data: accts, error: aErr } = await sb.from('mkt_social_accounts').select('id, platform').in('id', accountIds);
    if (aErr) throw new Error(`apify storage sweep: load accounts: ${aErr.message}`);
    for (const a of accts ?? []) platformOf.set(a.id as string, a.platform as string);
  }

  for (const row of (data ?? []) as RunRow[]) {
    stats.examined++;
    const cost = row.provider_cost ?? {};
    try {
      const platform = row.source_account_id ? platformOf.get(row.source_account_id) ?? null : null;
      if (mayHoldMedia(cost, platform)) {
        const waiting = await postsAwaitingMedia(sb, row.id);
        const age = now - new Date(row.finished_at).getTime();
        if (waiting > 0 && age < GIVE_UP_MS) { stats.deferred++; continue; }
      }
      const deleted: string[] = []; const gone: string[] = [];
      for (const runId of apifyRunIdsToSweep(cost)) {
        const r = await deleteApifyRunStorage(runId);
        deleted.push(...r.deleted); gone.push(...r.gone);
      }
      const { error: uErr } = await sb.from('mkt_ingestion_runs').update({
        provider_cost: { ...cost, storage_swept_at: new Date(now).toISOString(), storage_swept: { deleted: deleted.length, already_gone: gone.length } },
      }).eq('id', row.id);
      if (uErr) throw new Error(`stamp run: ${uErr.message}`);
      stats.swept++;
    } catch (e) {
      stats.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return stats;
}
