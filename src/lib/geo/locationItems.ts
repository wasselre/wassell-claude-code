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
/** Cardinal side of a LINE element (road) — relative to the closest point on
 *  it, BOUNDED to within `distance_m` of the road (a band, never a half-plane —
 *  user decision 2026-07-18). Missing distance_m compiles with the default. */
export interface DirectionalCondition {
  rule: DirectionRule;
  element_id: string;
  distance_m?: number;
}

/** Default band depth for direction rules saved without a distance. */
export const DIRECTION_DEFAULT_M = 5000;

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

/** A free-drawn polygon from the map picker. One item per shape — multiple
 *  drawn shapes are independent OR-union items, exactly like districts. */
export interface DrawnAreaLocationItem {
  id: string;
  kind: 'drawn_area';
  polarity: GeoPolarity;
  /** CLOSED outer ring in GeoJSON order [lng, lat] — first point === last point. */
  coordinates: [number, number][];
  /** display-only — e.g. "منطقة مرسومة 1". */
  label?: string;
}

export type LocationItem = DistrictLocationItem | ElementRuleLocationItem | DrawnAreaLocationItem;

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

/** Free-drawn polygon. `ring` must be CLOSED ([lng,lat], first === last) —
 *  the SQL compiler treats an open ring as needs_review. */
export const newDrawnAreaItem = (
  ring: [number, number][],
  label: string,
  polarity: GeoPolarity,
): DrawnAreaLocationItem => ({ id: uuid(), kind: 'drawn_area', polarity, coordinates: ring, label });

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
    (it): it is LocationItem => {
      if (!it || typeof it !== 'object') return false;
      const k = (it as { kind?: string }).kind;
      return k === 'district' || k === 'element_rule' || k === 'drawn_area';
    },
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
    case 'south_of':
    case 'east_of':
    case 'west_of': {
      const km = kmOf((cond as DirectionalCondition).distance_m ?? DIRECTION_DEFAULT_M);
      const side = cond.rule === 'north_of' ? (isAr ? 'شمال' : 'North of')
        : cond.rule === 'south_of' ? (isAr ? 'جنوب' : 'South of')
        : cond.rule === 'east_of' ? (isAr ? 'شرق' : 'East of')
        : (isAr ? 'غرب' : 'West of');
      return isAr ? `${side} ${name} (حتى ${km} كم)` : `${side} ${name} (up to ${km} km)`;
    }
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
    case 'south_of':
    case 'east_of':
    case 'west_of': {
      const km = kmOf((cond as DirectionalCondition).distance_m ?? DIRECTION_DEFAULT_M);
      const side = cond.rule === 'north_of' ? (isAr ? 'ليس شمال' : 'Not north of')
        : cond.rule === 'south_of' ? (isAr ? 'ليس جنوب' : 'Not south of')
        : cond.rule === 'east_of' ? (isAr ? 'ليس شرق' : 'Not east of')
        : (isAr ? 'ليس غرب' : 'Not west of');
      return isAr ? `${side} ${name} (حتى ${km} كم)` : `${side} ${name} (up to ${km} km)`;
    }
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
  if (item.kind === 'drawn_area') {
    const name = item.label || (isAr ? 'منطقة مرسومة' : 'Drawn area');
    // Exclude labels from the picker already read "منطقة مستثناة N" / "Excluded
    // area N" — don't prefix them into "استثناء منطقة مستثناة" doubles.
    const alreadyNegated = /مستثناة|excluded/i.test(name);
    if (!ex || alreadyNegated) return name;
    return isAr ? `استثناء ${name}` : `Exclude ${name}`;
  }
  const cond = Array.isArray(item.conditions) ? item.conditions[0] : undefined;
  const name = item.element_label || (isAr ? 'عنصر' : 'element');
  if (!cond) return name;
  return ex ? describeExcludeCondition(cond, name, isAr) : describeCondition(cond, name, isAr);
}

export { KNOWN_RULES };
