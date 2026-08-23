// Pure helpers for the live inventory meter — band thresholds + the deterministic
// "which core preference is still unset" hint. No I/O, no React, so it's unit-tested
// directly. The meter never does its own matching; the count comes from the finder.

import type { MatchRequirementsInput } from './requirements';

/** Own-inventory band. Tunable — initial cut for the ~93-project own portfolio. */
export type InventoryBand = 'zero' | 'narrow' | 'healthy' | 'broad';

/** 1–3 = narrow, 4–14 = healthy, 15+ = broad. Tune from real usage. */
export const NARROW_MAX = 3;
export const BROAD_MIN = 15;

export function inventoryBand(count: number): InventoryBand {
  if (count <= 0) return 'zero';
  if (count <= NARROW_MAX) return 'narrow';
  if (count < BROAD_MIN) return 'healthy';
  return 'broad';
}

/** The core qualification preferences a rep leans on. Bedrooms/area are secondary,
 *  so they are intentionally NOT surfaced as "still missing" hints (factual, not
 *  a checklist of mandatory fields). */
export type CorePref = 'location' | 'budget' | 'unit_type';

/** Which of the three core prefs are not set in the derived requirements. Order is
 *  stable (location · budget · unit type) for a predictable hint row. */
export function missingCorePrefs(req: MatchRequirementsInput): CorePref[] {
  const out: CorePref[] = [];
  const hasLocation =
    !!req.district ||
    (req.districts?.length ?? 0) > 0 ||
    (req.district_ids?.length ?? 0) > 0 ||
    !!req.city ||
    (req.cities?.length ?? 0) > 0;
  const hasBudget = req.budget_min != null || req.budget_max != null;
  const hasUnitType = !!req.property_type || (req.property_types?.length ?? 0) > 0;
  if (!hasLocation) out.push('location');
  if (!hasBudget) out.push('budget');
  if (!hasUnitType) out.push('unit_type');
  return out;
}

/** True when the requirements carry at least one matchable preference. Mirrors the
 *  server's `hasAnyCriteria` (api/_lib/projectFinder.ts) — used ONLY to skip a
 *  pointless request on an empty draft. The server's `needs_preferences` stays
 *  authoritative and corrects any disagreement, so this can never desync the count. */
export function hasAnyCriteria(req: MatchRequirementsInput): boolean {
  return !!(
    req.district ||
    req.districts?.length ||
    req.district_ids?.length ||
    req.city ||
    req.cities?.length ||
    req.property_type ||
    req.property_types?.length ||
    req.budget_min != null ||
    req.budget_max != null ||
    req.area_min != null ||
    req.area_max != null ||
    req.bedrooms != null ||
    req.amenities?.length ||
    req.required_amenities?.length
  );
}
