/**
 * The client's SELECTED AREA — every location preference that shapes a Project
 * Finder search, as location items the matcher's compiler can turn into geometry.
 *
 * Two sources feed it, mirroring `draftToMatchRequirements`:
 *   • `location_items` — district include/exclude, element rules, drawn shapes.
 *   • the legacy district picks — `location.district` (cascade) + the
 *     `preferred_districts` multi-lookup — mapped to synthetic include-district
 *     items so an old client record still gets its districts drawn.
 *
 * Draft values win over the saved record, field by field (same `pick` rule as
 * the requirements builder), so the area drawn is the area that was searched.
 */
import { parseLocationItems, type DistrictLocationItem, type LocationItem } from './locationItems';

/** A field value counts as "present" only if it carries real content — an empty
 *  string / empty array / empty object in the draft must NOT shadow the saved
 *  value (a cleared draft field means "not specified here", not "override with
 *  nothing"). */
const isPresent = (v: unknown): boolean => {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
};

/** A string OR string[] field → a clean list of ids (legacy picks saved both shapes). */
const allStrings = (v: unknown): string[] => {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim());
  }
  return [];
};

export interface CollectClientAreaArgs {
  /** The preference draft the search was run with (may be partial). */
  draft: Record<string, unknown> | null | undefined;
  /** The client's saved data — the fallback for fields the draft doesn't carry. */
  savedClientData: Record<string, unknown> | null | undefined;
  /** Optional district-id → display-name resolver for the legacy picks' labels. */
  resolveDistrictName?: (id: string) => string | null | undefined;
}

/** Location items describing the client's selected area (empty when none). */
export function collectClientAreaItems(args: CollectClientAreaArgs): LocationItem[] {
  const { draft, savedClientData, resolveDistrictName } = args;
  // Draft wins field-by-field; fall back to the saved record per field.
  const pick = (slug: string): unknown => {
    const d = draft?.[slug];
    if (isPresent(d)) return d;
    const s = savedClientData?.[slug];
    return isPresent(s) ? s : undefined;
  };

  const items = parseLocationItems(pick('location_items'));
  const seenDistricts = new Set(
    items.filter((i): i is DistrictLocationItem => i.kind === 'district').map((i) => i.district_id),
  );

  // Legacy district picks: the location cascade's district (compound
  // {region, city, district}) plus the preferred_districts multi-lookup. A
  // district already saved as a location item is NOT duplicated.
  const locVal = pick('location');
  const loc = locVal && typeof locVal === 'object' && !Array.isArray(locVal)
    ? (locVal as Record<string, unknown>)
    : {};
  const legacyIds = [
    ...new Set([...allStrings(loc.district), ...allStrings(pick('preferred_districts'))]),
  ];

  const legacy: DistrictLocationItem[] = legacyIds
    .filter((id) => !seenDistricts.has(id))
    .map((id) => ({
      id: `legacy-district:${id}`,
      kind: 'district',
      polarity: 'include',
      district_id: id,
      district_label: resolveDistrictName?.(id) ?? undefined,
    }));

  return [...items, ...legacy];
}

/** Stable content key for an item list (so effects don't refire on identity churn —
 *  parents rebuild these arrays every render). */
export function clientAreaSignature(items: LocationItem[]): string {
  return items
    .map((i) => {
      if (i.kind === 'district') return `d:${i.polarity}:${i.district_id}`;
      if (i.kind === 'drawn_area') {
        return `a:${i.polarity}:${i.coordinates.length}:${i.coordinates.slice(0, 3).flat().join(',')}`;
      }
      return `e:${i.polarity}:${(i.conditions ?? [])
        .map((c) => `${c.rule}:${c.element_id}:${(c as { distance_m?: number }).distance_m ?? ''}`)
        .join('+')}`;
    })
    .join('|');
}
