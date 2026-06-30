/**
 * Client location-preference items (clients.data.location_items).
 *
 * The deterministic Project Finder gate. Each item is one location preference;
 * multiple items combine as OR (union); excludes subtract. v1 supports:
 *   • district include / exclude
 *   • within_radius of a point geo_element (by its stable external_id)
 *
 * This is the FRONTEND shape mirror of api/_lib/geoMatch.ts. The matcher ignores
 * the display-only `*_label` fields we stash here so chips render without a refetch.
 */
import { v4 as uuid } from 'uuid';

export type GeoPolarity = 'include' | 'exclude';

export interface DistrictLocationItem {
  id: string;
  kind: 'district';
  polarity: GeoPolarity;
  district_id: string;
  /** display-only — the district name at the time it was added. */
  district_label?: string;
}

export interface WithinRadiusCondition {
  rule: 'within_radius';
  /** geo_elements.external_id (NOT the uuid). */
  element_id: string;
  distance_m: number;
}

export interface ElementRuleLocationItem {
  id: string;
  kind: 'element_rule';
  polarity: GeoPolarity;
  logic?: 'AND';
  conditions: WithinRadiusCondition[];
  /** display-only — the anchor name at the time it was added. */
  element_label?: string;
}

export type LocationItem = DistrictLocationItem | ElementRuleLocationItem;

export const newDistrictItem = (
  district_id: string,
  district_label: string,
  polarity: GeoPolarity,
): DistrictLocationItem => ({ id: uuid(), kind: 'district', polarity, district_id, district_label });

export const newRadiusItem = (
  element_id: string,
  element_label: string,
  distance_m: number,
  polarity: GeoPolarity,
): ElementRuleLocationItem => ({
  id: uuid(),
  kind: 'element_rule',
  polarity,
  logic: 'AND',
  conditions: [{ rule: 'within_radius', element_id, distance_m }],
  element_label,
});

/** Safe parse from a record's JSONB value (never throws; drops malformed items). */
export function parseLocationItems(v: unknown): LocationItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (it): it is LocationItem =>
      !!it && typeof it === 'object' &&
      ((it as { kind?: string }).kind === 'district' || (it as { kind?: string }).kind === 'element_rule'),
  );
}

/** Human-readable, bilingual chip label for a saved item. */
export function describeLocationItem(item: LocationItem, isAr: boolean): string {
  const ex = item.polarity === 'exclude';
  if (item.kind === 'district') {
    const name = item.district_label || (isAr ? 'حي' : 'district');
    if (isAr) return ex ? `استثناء حي ${name}` : `حي ${name}`;
    return ex ? `Exclude ${name}` : name;
  }
  const c = item.conditions?.[0];
  const km = c ? Math.round((c.distance_m / 1000) * 10) / 10 : 0;
  const name = item.element_label || (isAr ? 'عنصر' : 'element');
  if (isAr) return ex ? `خارج ${km} كم من ${name}` : `ضمن ${km} كم من ${name}`;
  return ex ? `Outside ${km} km of ${name}` : `Within ${km} km of ${name}`;
}
