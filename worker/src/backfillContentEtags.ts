/**
 * backfillContentEtags — fill `files.content_etag` (the duplicate-detection key)
 * for rows that never got one, WITHOUT downloading a single byte.
 *
 * Duplicate detection (src/lib/files/client.ts `findDuplicatesByEtag`) matches
 * on `content_etag` + `size_bytes`. The etag is Supabase Storage's own eTag for
 * the object — for an ordinary single-part upload that eTag IS the MD5 of the
 * content, and reading it back is one indexed `storage.list` lookup, not a
 * fetch. The browser upload path already records it (`readStorageEtag`), and the
 * pre-B7 corpus was backfilled from the same field — but every SERVER-side
 * creator (compressed PDFs, generated documents, the social-intake bridge,
 * worker outputs) leaves it NULL, so those files are invisible to the duplicate
 * check. Measured 2026-09-27: 1,753 active files with NULL content_etag.
 *
 * Same self-healing posture as the media-metadata sweep next to it: look at the
 * DATA (rows with no etag) rather than trust that every creator set it, so a
 * future path that forgets is caught on the next tick.
 *
 * A multipart upload's eTag carries a `-<parts>` suffix and is a hash OF hashes,
 * comparable only to an identically-chunked upload — so it is NOT a usable dedup
 * key and is skipped (left NULL), exactly as the browser path does. Skipping is
 * counted, never retried in a loop.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const FILES_BUCKET = 'wassel-files';

export interface EtagBackfillStats {
  examined: number;
  filled: number;
  no_usable_etag: number;
  errors: string[];
}

interface Row { id: string; storage_bucket: string | null; storage_path: string }

export async function backfillContentEtags(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<EtagBackfillStats> {
  const limit = opts.limit ?? 100;
  const stats: EtagBackfillStats = { examined: 0, filled: 0, no_usable_etag: 0, errors: [] };

  const { data: rows, error } = await supabase
    .from('files')
    .select('id, storage_bucket, storage_path')
    .is('content_etag', null)
    .not('storage_path', 'is', null)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`etag-backfill: load files: ${error.message}`);
  if (!rows || rows.length === 0) return stats;

  for (const row of rows as Row[]) {
    stats.examined++;
    try {
      const bucket = row.storage_bucket ?? FILES_BUCKET;
      const slash = row.storage_path.lastIndexOf('/');
      const prefix = slash >= 0 ? row.storage_path.slice(0, slash) : '';
      const name = slash >= 0 ? row.storage_path.slice(slash + 1) : row.storage_path;

      const { data: listed, error: listErr } = await supabase.storage
        .from(bucket).list(prefix, { search: name, limit: 1 });
      if (listErr) throw new Error(`list: ${listErr.message}`);

      const meta = (listed?.[0]?.metadata ?? null) as { eTag?: unknown } | null;
      const raw = typeof meta?.eTag === 'string' ? meta.eTag.replace(/"/g, '') : null;
      // Only a clean 32-hex MD5 is a usable dedup key. A multipart `-<n>` suffix
      // or a missing object leaves the row NULL — not dedup-able, not an error.
      if (!raw || !/^[0-9a-f]{32}$/.test(raw)) { stats.no_usable_etag++; continue; }

      const { error: uErr } = await supabase.from('files')
        .update({ content_etag: raw }).eq('id', row.id);
      if (uErr) throw new Error(`update: ${uErr.message}`);
      stats.filled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push(`${row.id}: ${msg}`);
      console.error(`[etag-backfill] file=${row.id} failed — ${msg}`);
    }
  }

  console.log(`[etag-backfill] examined=${stats.examined} filled=${stats.filled} no_usable_etag=${stats.no_usable_etag} errors=${stats.errors.length}`);
  return stats;
}
