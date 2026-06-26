/**
 * Lightweight runtime feature flags, read from the `feature_flags` table.
 *
 * Fail-OPEN by design: a flag is "on" unless an operator has explicitly set its
 * row to `enabled = false`. So a missing table / read error / absent row leaves
 * the feature ON (current behavior) — the row is purely a KILL SWITCH. Rollback
 * for a whole feature = flip its row to false (no schema change, no redeploy).
 *
 * Cached for the tab's lifetime (one read), so gating many components is cheap.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

let cache: Promise<Record<string, boolean>> | null = null;

export function loadFeatureFlags(): Promise<Record<string, boolean>> {
  if (cache) return cache;
  cache = (async () => {
    if (!supabase) return {};
    const { data, error } = await supabase.from('feature_flags').select('key, enabled');
    if (error || !data) {
      // Fail-open: never let a flags read error hide a feature.
      if (error) console.warn('[featureFlags] read failed (failing open):', error.message);
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const row of data as Array<{ key: string; enabled: boolean }>) {
      out[row.key] = row.enabled !== false;
    }
    return out;
  })();
  return cache;
}

/**
 * React hook: returns whether a feature flag is enabled. Defaults to ON
 * (`defaultOn = true`) until the flag row is read; only an explicit
 * `enabled = false` row turns it off.
 */
export function useFeatureFlag(key: string, defaultOn = true): boolean {
  const [enabled, setEnabled] = useState(defaultOn);
  useEffect(() => {
    let alive = true;
    loadFeatureFlags().then((flags) => {
      if (alive && key in flags) setEnabled(flags[key]!);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return enabled;
}
