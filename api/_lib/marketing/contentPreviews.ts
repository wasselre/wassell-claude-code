/**
 * ONE preview-asset picker, shared by every endpoint that returns content rows.
 *
 * This logic used to live inline in the `content_list` branch of
 * `api/marketing-os.ts`, which is why the content table was the only surface in
 * the whole workspace that could show a thumbnail: `work_list`,
 * `content_detail`, `campaign_detail`, `calendar`, `publishing`, `search` and
 * `team` all returned content rows with no preview fields at all, so their
 * lists were text-only by omission rather than by design.
 *
 * The rule, unchanged: an asset that can actually be RENDERED beats one that
 * cannot, and among those the final cut beats a source or a reference. A
 * canonical asset has no stored `thumb_url` but is renderable through its
 * `file_id` (the client signs it via `useAssetUrls`), so it must not score as
 * "no preview" behind a thumbless legacy row.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ContentPreview {
  thumb_url: string | null;
  preview_file_id: string | null;
  preview_kind: string | null;
}

/** Renderability first, then how final the asset is. Lower wins. */
const ROLE_RANK: Record<string, number> = {
  final_square: 0, final: 0, final_vertical: 0, source: 1, reference: 2,
};

const EMPTY: ContentPreview = { thumb_url: null, preview_file_id: null, preview_kind: null };

/**
 * Best preview per content id, in ONE pair of queries however many ids you pass.
 *
 * Never throws and never returns a partial lie: a failed read is logged and
 * yields an empty map, so the caller's rows render the typed placeholder
 * instead of a blank box. A thumbnail is decoration — it must not be able to
 * fail a content list.
 */
export async function loadContentPreviews(
  sb: SupabaseClient,
  contentIds: readonly string[],
): Promise<Map<string, ContentPreview>> {
  const out = new Map<string, ContentPreview>();
  const ids = Array.from(new Set(contentIds.filter(Boolean)));
  if (!ids.length) return out;

  const links = await sb
    .from('mos_asset_links')
    .select('asset_id, content_id, role')
    .in('content_id', ids);
  if (links.error) {
    console.error('[content-previews] mos_asset_links read failed',
      links.error.code, links.error.message);
    return out;
  }
  const rows = links.data ?? [];
  const assetIds = Array.from(new Set(rows.map((l) => l.asset_id as string)));
  if (!assetIds.length) return out;

  const assets = await sb
    .from('mos_assets')
    .select('id, thumb_url, kind, url, file_id')
    .in('id', assetIds);
  if (assets.error) {
    console.error('[content-previews] mos_assets read failed',
      assets.error.code, assets.error.message);
    return out;
  }
  const byId = new Map((assets.data ?? []).map((a) => [a.id as string, a]));

  const scored = new Map<string, number>();
  for (const l of rows) {
    const a = byId.get(l.asset_id as string);
    if (!a) continue;
    const renderable = a.thumb_url || a.file_id;
    const score = (renderable ? 0 : 100) + (ROLE_RANK[l.role as string] ?? 3);
    const cid = l.content_id as string;
    const cur = scored.get(cid);
    if (cur !== undefined && cur <= score) continue;
    scored.set(cid, score);
    out.set(cid, {
      thumb_url: (a.thumb_url as string | null) ?? null,
      preview_file_id: (a.file_id as string | null) ?? null,
      preview_kind: (a.kind as string | null) ?? null,
    });
  }
  return out;
}

/** Merge previews onto rows carrying an `id`. Rows without one keep the nulls. */
export function attachContentPreviews<T extends { id?: unknown }>(
  rows: readonly T[],
  previews: Map<string, ContentPreview>,
): Array<T & ContentPreview> {
  return rows.map((r) => ({ ...r, ...(previews.get(String(r.id ?? '')) ?? EMPTY) }));
}

/** The common case: fetch and merge in one call. */
export async function withContentPreviews<T extends { id?: unknown }>(
  sb: SupabaseClient,
  rows: readonly T[],
  idOf: (row: T) => string | null = (r) => (r.id ? String(r.id) : null),
): Promise<Array<T & ContentPreview>> {
  const ids = rows.map(idOf).filter((x): x is string => Boolean(x));
  const previews = await loadContentPreviews(sb, ids);
  return rows.map((r) => {
    const id = idOf(r);
    return { ...r, ...((id && previews.get(id)) || EMPTY) };
  });
}
