import { useEffect, useMemo, useState } from 'react';
import {
  collectUrlsNeedingResolution,
  resolveLocationWithCache,
  resolveMapsUrlAsync,
  resolvePinColor,
  type LatLng,
  type LocationResolveCtx,
} from '@/lib/locationUtils';
import { useAppStore } from '@/stores/appStore';
import { VIRTUAL_FIELD_SEPARATOR } from '@/lib/sectionMirrorExpand';
import type { AppModel, AppRecord } from '@/types';

export interface ResolvedPin {
  record: AppRecord;
  lat: number;
  lng: number;
  color: string;
}

export interface UseResolvedLocationsResult {
  resolved: ResolvedPin[];
  unresolved: AppRecord[];
  resolving: boolean; // true while any async resolution is in-flight
  resolvingCount: number;
  /** Re-run async resolution for records that haven't placed yet. Short
   *  `maps.app.goo.gl` links need a server round-trip that can transiently
   *  fail (rate-limit/timeout); failures aren't cached, so a retry re-fires
   *  them. */
  retry: () => void;
}

/**
 * Resolve every record to lat/lng using (1) sync URL parse, (2) manual lat/lng
 * fields, (3) localStorage cache of prior server-side resolutions, and
 * (4) async call to `/api/resolve-maps-url` for short URLs that need a
 * server-side redirect hop. Async resolutions are cached forever so each unique
 * URL only hits the server once.
 *
 * Shared by MapsView and MapsBuilder so both pick up short-URL resolutions
 * without duplicate work.
 */
export function useResolvedLocations(model: AppModel, records: AppRecord[]): UseResolvedLocationsResult {
  const cfg = model.maps_config;
  const allFields = useMemo(() => model.schema.sections.flatMap((s) => s.fields), [model]);

  // Cross-model context is only needed when the location field reaches into
  // another model — a `mirror` field OR a `section_mirror` child (compound
  // `container::child` id). Both resolve their live value off another model's
  // record via the sibling lookup (e.g. a project's location mirrored/surfaced
  // from the master All Projects record). For plain url/text location fields we
  // keep `ctx` undefined so resolution stays local and pins don't recompute
  // when unrelated records elsewhere change.
  const allRecords = useAppStore((s) => s.records);
  const allModels = useAppStore((s) => s.models);
  const locationNeedsCtx = useMemo(() => {
    const id = cfg.location_url_field_id;
    if (!id) return false;
    if (id.includes(VIRTUAL_FIELD_SEPARATOR)) return true; // section-mirror child
    return allFields.find((f) => f.id === id)?.type === 'mirror';
  }, [cfg.location_url_field_id, allFields]);
  const ctx = useMemo<LocationResolveCtx | undefined>(
    () => (locationNeedsCtx ? { allRecords, allModels } : undefined),
    [locationNeedsCtx, allRecords, allModels],
  );

  // Bumps when a batch of async resolutions finishes — forces recompute.
  const [tick, setTick] = useState(0);
  const [resolvingCount, setResolvingCount] = useState(0);
  // Bumps when the user hits "retry" on the unplaced-records chip — re-fires
  // the resolution effect so transiently-failed short links get another go.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const urls = collectUrlsNeedingResolution(records, cfg, allFields, ctx);
    if (urls.length === 0) return;

    let cancelled = false;
    let remaining = urls.length;
    setResolvingCount(remaining);

    // Run with limited concurrency so we don't hammer the edge function (or
    // Google's redirect endpoint for short URLs) in parallel — 40+ simultaneous
    // fetches to `maps.app.goo.gl` trips anti-abuse rate limiting. Each result
    // bumps `tick` so pins render live as they land, not only at the end.
    const CONCURRENCY = 6;
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (!cancelled) {
        const i = nextIndex++;
        if (i >= urls.length) return;
        try {
          await resolveMapsUrlAsync(urls[i]!);
        } catch {
          // resolveMapsUrlAsync swallows its own errors and returns null.
          // This catch is defensive only.
        }
        if (cancelled) return;
        remaining -= 1;
        setResolvingCount(remaining);
        setTick((t) => t + 1);
      }
    }

    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));

    return () => {
      cancelled = true;
    };
    // `records` identity changes when the filter pipeline re-runs upstream;
    // `cfg` and `allFields` change when the model is edited in the Builder;
    // `ctx` changes only for mirror-location models when the source records do.
    // `retryNonce` bumps on a manual retry to re-fire failed short-link lookups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, cfg, allFields, ctx, retryNonce]);

  const { resolved, unresolved } = useMemo(() => {
    const res: ResolvedPin[] = [];
    const unres: AppRecord[] = [];
    for (const rec of records) {
      const loc: LatLng | null = resolveLocationWithCache(rec, cfg, allFields, ctx);
      if (loc) {
        res.push({
          record: rec,
          lat: loc.lat,
          lng: loc.lng,
          color: resolvePinColor(rec, cfg, allFields, model.color),
        });
      } else {
        unres.push(rec);
      }
    }
    return { resolved: res, unresolved: unres };
    // `tick` is the signal that async resolutions finished — deliberately in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, cfg, allFields, model.color, tick, ctx]);

  return {
    resolved,
    unresolved,
    resolving: resolvingCount > 0,
    resolvingCount,
    retry: () => setRetryNonce((n) => n + 1),
  };
}
