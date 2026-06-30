/**
 * Client location-preference items (clients.data.location_items).
 *
 * The deterministic Project Finder gate. Each item is one location preference;
 * multiple items combine as OR (union); excludes subtract. Supported:
 *   • district include / exclude
 *   • element_rule conditions, geometry-aware:
 *       - within_radius   (point-like elements: KAFD, mall, hospital, metro…)
 *       - within_distance (line or polygon elements: roads, zones — within X of the geom)
 *       - inside_area     (polygon elements: inside the zone/boundary)
 *       - north_of / south_of / east_of / west_of (line elements: roads)
 *
 * This is the FRONTEND shape mirror of api/_lib/geoMatch.ts (the tested TS twin)
 * and of the SQL wassell_compile_client_geo / wassell_geo_match. The matcher
 * ignores the display-only `*_label` fields we stash here so chips render without
 * a refetch. KEEP all three (this file, geoMatch.ts, the SQL) semantically aligned.
 */
import { v4 as uuid } from 'uuid';

export type GeoPolarity = 'include' | 'exclude';

export type DirectionRule = 'north_of' | 'south_of' | 'east_of' | 'west_of';
export type ConditionRule = 'within_radius' | 'within_distance' | 'inside_area' | DirectionRule;

export const DIRECTION_RULES: DirectionRule[] = ['north_of', 'south_of', 'east_of', 'west_of'];
export const isDirectionRule = (r: string): r is DirectionRule =>
  (DIRECTION_RULES as string[]).includes(r);

export interface DistrictLocationItem {
  id: string;
  kind: 'district';
  polarity: GeoPolarity;
  district_id: string;
  /** display-only — the district name at the time it was added. */
  district_label?: string;
}

/** Within X metres of a POINT element's centroid (KAFD, mall, hospital, metro…). */
export interface WithinRadiusCondition {
  rule: 'within_radius';
  /** geo_elements.external_id (NOT the uuid). */
  element_id: string;
  distance_m: number;
}
/** Within X metres of a LINE or POLYGON element's full geometry (roads, zones). */
export interface WithinDistanceCondition {
  rule: 'within_distance';
  element_id: string;
  distance_m: number;
}
/** Inside a POLYGON element (zone / boundary). */
export interface InsideAreaCondition {
  rule: 'inside_area';
  element_id: string;
}
/** Cardinal side of a LINE element (road) — relative to the closest point on it. */
export interface DirectionalCondition {
  rule: DirectionRule;
  element_id: string;
}

export type ElementCondition =
  | WithinRadiusCondition
  | WithinDistanceCondition
  | InsideAreaCondition
  | DirectionalCondition;

export interface ElementRuleLocationItem {
  id: string;
  kind: 'element_rule';
  polarity: GeoPolarity;
  logic?: 'AND';
  conditions: ElementCondition[];
  /** display-only — the anchor name at the time it was added. */
  element_label?: string;
}

export type LocationItem = DistrictLocationItem | ElementRuleLocationItem;

export const newDistrictItem = (
  district_id: string,
  district_label: string,
  polarity: GeoPolarity,
): DistrictLocationItem => ({ id: uuid(), kind: 'district', polarity, district_id, district_label });

/** Generic constructor: one element_rule item wrapping exactly one condition. */
export const newElementRuleItem = (
  element_label: string,
  condition: ElementCondition,
  polarity: GeoPolarity,
): ElementRuleLocationItem => ({
  id: uuid(),
  kind: 'element_rule',
  polarity,
  logic: 'AND',
  conditions: [condition],
  element_label,
});

/** within_radius (point element). Kept as a named helper for the common case. */
export const newRadiusItem = (
  element_id: string,
  element_label: string,
  distance_m: number,
  polarity: GeoPolarity,
): ElementRuleLocationItem =>
  newElementRuleItem(element_label, { rule: 'within_radius', element_id, distance_m }, polarity);

const KNOWN_RULES: ConditionRule[] = [
  'within_radius', 'within_distance', 'inside_area', 'north_of', 'south_of', 'east_of', 'west_of',
];

/** Safe parse from a record's JSONB value (never throws; drops malformed items). */
export function parseLocationItems(v: unknown): LocationItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (it): it is LocationItem =>
      !!it && typeof it === 'object' &&
      ((it as { kind?: string }).kind === 'district' || (it as { kind?: string }).kind === 'element_rule'),
  );
}

const kmOf = (m: number | undefined): number => Math.round(((m ?? 0) / 1000) * 10) / 10;

/** Bilingual label for a single element condition (no polarity applied). */
function describeCondition(cond: ElementCondition, name: string, isAr: boolean): string {
  switch (cond.rule) {
    case 'within_radius':
    case 'within_distance': {
      const km = kmOf((cond as WithinRadiusCondition | WithinDistanceCondition).distance_m);
      return isAr ? `ضمن ${km} كم من ${name}` : `Within ${km} km of ${name}`;
    }
    case 'inside_area':
      return isAr ? `داخل ${name}` : `Inside ${name}`;
    case 'north_of':
      return isAr ? `شمال ${name}` : `North of ${name}`;
    case 'south_of':
      return isAr ? `جنوب ${name}` : `South of ${name}`;
    case 'east_of':
      return isAr ? `شرق ${name}` : `East of ${name}`;
    case 'west_of':
      return isAr ? `غرب ${name}` : `West of ${name}`;
    default:
      return name;
  }
}

/** Bilingual label for an EXCLUDE element condition (the negation). */
function describeExcludeCondition(cond: ElementCondition, name: string, isAr: boolean): string {
  switch (cond.rule) {
    case 'within_radius':
    case 'within_distance': {
      const km = kmOf((cond as WithinRadiusCondition | WithinDistanceCondition).distance_m);
      return isAr ? `خارج ${km} كم من ${name}` : `Outside ${km} km of ${name}`;
    }
    case 'inside_area':
      return isAr ? `خارج ${name}` : `Outside ${name}`;
    case 'north_of':
      return isAr ? `ليس شمال ${name}` : `Not north of ${name}`;
    case 'south_of':
      return isAr ? `ليس جنوب ${name}` : `Not south of ${name}`;
    case 'east_of':
      return isAr ? `ليس شرق ${name}` : `Not east of ${name}`;
    case 'west_of':
      return isAr ? `ليس غرب ${name}` : `Not west of ${name}`;
    default:
      return isAr ? `استثناء ${name}` : `Exclude ${name}`;
  }
}

/** Human-readable, bilingual chip label for a saved item. */
export function describeLocationItem(item: LocationItem, isAr: boolean): string {
  const ex = item.polarity === 'exclude';
  if (item.kind === 'district') {
    const name = item.district_label || (isAr ? 'حي' : 'district');
    if (isAr) return ex ? `استثناء حي ${name}` : `حي ${name}`;
    return ex ? `Exclude ${name}` : name;
  }
  const cond = Array.isArray(item.conditions) ? item.conditions[0] : undefined;
  const name = item.element_label || (isAr ? 'عنصر' : 'element');
  if (!cond) return name;
  return ex ? describeExcludeCondition(cond, name, isAr) : describeCondition(cond, name, isAr);
}

export { KNOWN_RULES };
