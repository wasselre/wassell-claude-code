/**
 * Build an id → LocalizedName map from the geography records in the store.
 *
 * ISSUE #8 — several components each hand-rolled `Record<id, arabicString>`
 * via `display_name ?? name_ar`, then handed it to an English-language prompt.
 * This is the ONE place that map gets built; it returns the full localized
 * contract so every consumer picks the language it actually needs.
 */
import type { AppModel, AppRecord } from '@/types';
import { resolveLocalizedName, type LocalizedName } from './localizedName';

/** Geography models whose records carry the localized name fields. */
export type GeoModelName = 'districts' | 'cities' | 'regions';

/**
 * @param levels which geography models to include (default districts + cities —
 *               the two levels client preferences actually reference).
 * Records that cannot be fully localized (no `name_en`) are OMITTED, so a
 * consumer can never accidentally render Arabic under an English label.
 */
export function buildGeoNameMap(
  models: AppModel[],
  records: Record<string, AppRecord[]>,
  levels: GeoModelName[] = ['districts', 'cities'],
): Record<string, LocalizedName> {
  const map: Record<string, LocalizedName> = {};
  for (const level of levels) {
    const m = models.find((mm) => mm.name === level);
    if (!m) continue;
    for (const r of records[m.id] ?? []) {
      const localized = resolveLocalizedName(r.id, r.data as Record<string, unknown> | undefined);
      if (localized) map[r.id] = localized;
    }
  }
  return map;
}

/** Arabic-only view of the same map, for surfaces that never render English. */
export function arabicNamesOf(map: Record<string, LocalizedName>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, n] of Object.entries(map)) out[id] = n.ar;
  return out;
}
