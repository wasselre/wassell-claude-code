/**
 * Workspace data helpers (Image Chats v3).
 *
 * A Creative Session's generations live in `record.data.generations[]` (synced
 * via the Zustand store + Realtime). Their OUTPUT images are either:
 *   - first-class `media_assets` rows (v3 generations) — referenced by
 *     `output_asset_ids`; we fetch those rows for provenance + public_url, OR
 *   - inline `output_urls` (generations migrated from v2 chat messages).
 *
 * `useSessionAssets` loads the media_assets for a session and refetches when a
 * generation completes (its `output_asset_ids` change). `generationOutputs`
 * resolves a generation to a flat list of output items regardless of source.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Generation, MediaAsset } from '@/lib/imageChat/client';

export function useSessionAssets(
  sessionId: string,
  generations: Generation[],
): Map<string, MediaAsset> {
  const [assetsById, setAssetsById] = useState<Map<string, MediaAsset>>(new Map());

  // Refetch only when the SET of referenced asset ids changes (a generation
  // completed), not on every record update.
  const idsKey = useMemo(
    () =>
      Array.from(new Set(generations.flatMap((g) => g.output_asset_ids ?? [])))
        .sort()
        .join(','),
    [generations],
  );

  useEffect(() => {
    if (!supabase || !sessionId) {
      setAssetsById(new Map());
      return;
    }
    let cancelled = false;
    void supabase
      .from('media_assets')
      .select('*')
      .eq('source_session_id', sessionId)
      .then(({ data }) => {
        if (cancelled || !data) return;
        setAssetsById(new Map((data as MediaAsset[]).map((a) => [a.id, a])));
      });
    return () => {
      cancelled = true;
    };
    // idsKey drives the refetch; sessionId scopes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, idsKey]);

  return assetsById;
}

export interface OutputItem {
  /** media_assets.id (absent for migrated inline outputs). */
  assetId?: string;
  url: string;
  asset?: MediaAsset;
}

/** Resolve a generation's outputs to a flat list (first-class assets first,
 *  else migrated inline URLs). */
export function generationOutputs(
  gen: Generation,
  assetsById: Map<string, MediaAsset>,
): OutputItem[] {
  if (gen.output_asset_ids && gen.output_asset_ids.length > 0) {
    return gen.output_asset_ids
      .map((id): OutputItem | null => {
        const asset = assetsById.get(id);
        return asset ? { assetId: id, url: asset.public_url, asset } : null;
      })
      .filter((o): o is OutputItem => o !== null);
  }
  if (gen.output_urls && gen.output_urls.length > 0) {
    return gen.output_urls.map((url) => ({ url }));
  }
  return [];
}

/** First output URL of a generation (for session/timeline thumbnails). */
export function generationThumbUrl(
  gen: Generation,
  assetsById: Map<string, MediaAsset>,
): string | null {
  return generationOutputs(gen, assetsById)[0]?.url ?? null;
}
