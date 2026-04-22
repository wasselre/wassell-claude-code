import { useEffect, useMemo, useState } from 'react';
import {
  collectUrlsNeedingResolution,
  resolveLocationWithCache,
  resolveMapsUrlAsync,
  resolvePinColor,
  type LatLng,
} from '@/lib/locationUtils';
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

  // Bumps when a batch of async resolutions finishes — forces recompute.
  const [tick, setTick] = useState(0);
  const [resolvingCount, setResolvingCount] = useState(0);

  useEffect(() => {
    const urls = collectUrlsNeedingResolution(records, cfg, allFields);
    if (urls.length === 0) return;

    let cancelled = false;
    setResolvingCount(urls.length);

    // Resolve in parallel — edge function is cheap and each URL is independent.
    Promise.allSettled(urls.map((u) => resolveMapsUrlAsync(u))).then(() => {
      if (cancelled) return;
      setTick((t) => t + 1);
      setResolvingCount(0);
    });

    return () => {
      cancelled = true;
    };
    // `records` identity changes when the filter pipeline re-runs upstream;
    // `cfg` and `allFields` change when the model is edited in the Builder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, cfg, allFields]);

  const { resolved, unresolved } = useMemo(() => {
    const res: ResolvedPin[] = [];
    const unres: AppRecord[] = [];
    for (const rec of records) {
      const loc: LatLng | null = resolveLocationWithCache(rec, cfg, allFields);
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
  }, [records, cfg, allFields, model.color, tick]);

  return {
    resolved,
    unresolved,
    resolving: resolvingCount > 0,
    resolvingCount,
  };
}
