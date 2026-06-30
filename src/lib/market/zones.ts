/**
 * Directional zones — the geometric band rule, mirrored from the SQL function
 * public.wassell_city_zone_districts (supabase/migrations/2026-06-30_geo_zone_resolver.sql).
 * KEEP IN SYNC. The SQL is the source of truth used at request time; this mirror
 * exists for typing, labels, and unit-testing the band thresholds.
 */

export type Zone =
  | 'north' | 'south' | 'east' | 'west' | 'center'
  | 'northeast' | 'northwest' | 'southeast' | 'southwest';

export const ZONES: Zone[] = ['north', 'south', 'east', 'west', 'center', 'northeast', 'northwest', 'southeast', 'southwest'];

export const ZONE_LABELS: Record<Zone, { ar: string; en: string }> = {
  north: { ar: 'شمال', en: 'North' },
  south: { ar: 'جنوب', en: 'South' },
  east: { ar: 'شرق', en: 'East' },
  west: { ar: 'غرب', en: 'West' },
  center: { ar: 'وسط', en: 'Center' },
  northeast: { ar: 'شمال شرق', en: 'Northeast' },
  northwest: { ar: 'شمال غرب', en: 'Northwest' },
  southeast: { ar: 'جنوب شرق', en: 'Southeast' },
  southwest: { ar: 'جنوب غرب', en: 'Southwest' },
};

export function zoneLabel(zone: string, isAr: boolean): string {
  const m = ZONE_LABELS[zone as Zone];
  return m ? (isAr ? m.ar : m.en) : zone;
}

/** Relative position of a value within [min,max] → [0,1] (0.5 when degenerate). */
export function relPos(v: number, min: number, max: number): number {
  return max === min ? 0.5 : (v - min) / (max - min);
}

/**
 * Is a district (at relative bounding-box position rlat/rlng, both in [0,1]) in
 * the given zone? Exact mirror of the SQL CASE — change BOTH together.
 */
export function inZone(zone: Zone, rlat: number, rlng: number): boolean {
  switch (zone) {
    case 'north': return rlat >= 0.60;
    case 'south': return rlat <= 0.40;
    case 'east': return rlng >= 0.60;
    case 'west': return rlng <= 0.40;
    case 'center': return rlat >= 0.35 && rlat <= 0.65 && rlng >= 0.35 && rlng <= 0.65;
    case 'northeast': return rlat >= 0.55 && rlng >= 0.55;
    case 'northwest': return rlat >= 0.55 && rlng <= 0.45;
    case 'southeast': return rlat <= 0.45 && rlng >= 0.55;
    case 'southwest': return rlat <= 0.45 && rlng <= 0.45;
  }
}
