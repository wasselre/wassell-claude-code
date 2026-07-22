// ============================================================================
// Orphaned ad-creative storage cleanup.
//
// Creatives are stored at marketing-assets/ad-creatives/<sha256>.<ext> and keyed
// by fingerprint (creativeStore.ts). When ads are removed/re-attributed the bytes
// stay behind. This detects objects whose fingerprint is referenced by NO current
// ad, respects a retention window, DEFAULTS TO DRY-RUN, never deletes a referenced
// (active OR historical) creative, records every run, and is idempotent.
//
// Safety posture: production runs dry-run only unless a caller explicitly opts in.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'marketing-assets';
const PREFIX = 'ad-creatives';

export interface StorageObject { name: string; updatedAt: string | null }
export interface OrphanSelection { orphans: string[]; keptReferenced: number; keptTooRecent: number; scanned: number }

/** Extract the fingerprint (filename without extension) from an object path. */
export function fingerprintOf(name: string): string | null {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  const fp = dot > 0 ? base.slice(0, dot) : base;
  return /^[a-f0-9]{16,64}$/i.test(fp) ? fp.toLowerCase() : null;
}

/**
 * PURE core: given the objects, the set of fingerprints still referenced by any
 * ad, and a retention window, decide which objects are safe to delete. An object
 * is an orphan only when its fingerprint is unreferenced AND it is older than the
 * retention window (young files may belong to an in-flight collection).
 */
export function selectOrphans(
  objects: StorageObject[], referenced: Set<string>, opts: { retentionDays: number; now: number },
): OrphanSelection {
  const cutoff = opts.now - opts.retentionDays * 86400_000;
  const orphans: string[] = [];
  let keptReferenced = 0, keptTooRecent = 0;
  for (const o of objects) {
    const fp = fingerprintOf(o.name);
    if (fp && referenced.has(fp)) { keptReferenced++; continue; }
    const ts = o.updatedAt ? Date.parse(o.updatedAt) : NaN;
    // Fail safe: keep when the timestamp is unknown OR within the retention
    // window (an unknown-age object may belong to an in-flight collection).
    if (!Number.isFinite(ts) || ts > cutoff) { keptTooRecent++; continue; }
    orphans.push(o.name);
  }
  return { orphans, keptReferenced, keptTooRecent, scanned: objects.length };
}

/**
 * Every fingerprint referenced by a current ad (active or historical row).
 * MUST paginate: an incomplete reference set (PostgREST's 1000-row cap) would
 * mark a referenced creative as an orphan and delete it on a non-dry-run pass.
 */
async function referencedFingerprints(sb: SupabaseClient): Promise<Set<string>> {
  const set = new Set<string>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb.from('mkt_paid_ads')
      .select('creative_fingerprint, creative_stored_url').range(offset, offset + PAGE - 1);
    if (error) throw new Error(`referencedFingerprints: ${error.message}`); // fail LOUD — never delete on a partial set
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.creative_fingerprint) set.add(String(r.creative_fingerprint).toLowerCase());
      const url = r.creative_stored_url as string | null;
      if (url) { const fp = fingerprintOf(url); if (fp) set.add(fp); }
    }
    if (data.length < PAGE) break;
  }
  return set;
}

export interface CleanupResult { dryRun: boolean; scanned: number; orphans: number; deleted: number; keptReferenced: number; keptTooRecent: number; errors: string[] }

/**
 * List ad-creative objects, select orphans, optionally delete, and record the run
 * in mkt_storage_cleanup_runs. Dry-run by default.
 */
export async function runCreativeCleanup(
  sb: SupabaseClient, opts: { dryRun?: boolean; retentionDays?: number; now?: number } = {},
): Promise<CleanupResult> {
  const dryRun = opts.dryRun !== false; // default TRUE
  const retentionDays = opts.retentionDays ?? 7;
  const now = opts.now ?? Date.now();
  const errors: string[] = [];

  // page through the bucket prefix
  const objects: StorageObject[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(BUCKET).list(PREFIX, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) { errors.push(`list: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const o of data) {
      if (o.id === null && !o.name.includes('.')) continue; // skip folders
      objects.push({ name: `${PREFIX}/${o.name}`, updatedAt: (o.updated_at as string | undefined) ?? (o.created_at as string | undefined) ?? null });
    }
    if (data.length < 100) break;
    offset += 100;
  }

  const referenced = await referencedFingerprints(sb);
  const sel = selectOrphans(objects, referenced, { retentionDays, now });

  let deleted = 0;
  if (!dryRun && sel.orphans.length > 0) {
    // delete in batches; never touch referenced objects (already excluded)
    for (let i = 0; i < sel.orphans.length; i += 100) {
      const batch = sel.orphans.slice(i, i + 100);
      const { error } = await sb.storage.from(BUCKET).remove(batch);
      if (error) errors.push(`remove: ${error.message}`);
      else deleted += batch.length;
    }
  }

  const result: CleanupResult = { dryRun, scanned: sel.scanned, orphans: sel.orphans.length, deleted, keptReferenced: sel.keptReferenced, keptTooRecent: sel.keptTooRecent, errors };
  // best-effort record (table may not exist in older envs — never fail cleanup on this)
  const { error: recErr } = await sb.from('mkt_storage_cleanup_runs').insert({
    kind: 'ad_creatives', dry_run: dryRun, scanned: result.scanned, orphans: result.orphans,
    deleted: result.deleted, detail: { keptReferenced: result.keptReferenced, keptTooRecent: result.keptTooRecent, retentionDays, sample: sel.orphans.slice(0, 20), errors },
  });
  if (recErr) result.errors.push(`record: ${recErr.message}`);
  return result;
}
