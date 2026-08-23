/**
 * Map a client's DRAFT preferences (the unsaved Follow-up form buffer) into the
 * deterministic matcher's `MatchRequirements` shape — the input to
 * /api/suggest-projects. Draft-first: an unsaved edit in the Follow-up Workspace
 * beats the saved client value beats nothing (same priority as
 * `buildAssistantContext`, which this mirrors).
 *
 * Geography is the `location` cascade compound ({ region:[], city:[], district:[] }
 * of record ids). We take the first district/city id and resolve it to the
 * district/city NAME (via the caller-supplied resolver, wired to the loaded
 * districts/cities records). The matcher resolves the name back to the
 * authoritative district id + centroid internally.
 *
 * This is the SHAPE contract the client mirror (suggestions.ts) feeds the
 * endpoint; the field SLUGS are verified against the live `clients` model.
 */

import type { AppModel } from '@/types';
import type { RequirementConstraints } from './constraints';

/** Mirror of api/_lib/matchAgent.MatchRequirements (the fields the SPA fills). */
export interface MatchRequirementsInput {
  /** Primary city name (= cities[0]); kept for single-city code paths. */
  city?: string;
  /** ALL acceptable city names — alternatives (OR); the engine treats a project in
   *  ANY of them as a city match. */
  cities?: string[];
  /** Primary district name (= districts[0]); kept for single-district code paths. */
  district?: string;
  /** ALL requested district names — the engine resolves each and treats a project
   *  in ANY of them as an exact match (our_projects + all_projects + market). */
  districts?: string[];
  /** The AUTHORITATIVE `districts` record ids the client actually selected. When
   *  present the engine matches on these ids directly — no fuzzy name resolution,
   *  which could pick a same-named district in another city. Names above stay for
   *  display + fallback. */
  district_ids?: string[];
  /** Primary unit type (= property_types[0]); kept for single-type code paths. */
  property_type?: string;
  /** ALL acceptable unit types — alternatives (OR); a project offering ANY of them
   *  is a type match (e.g. client accepts شقة أو دور). */
  property_types?: string[];
  budget_min?: number;
  budget_max?: number;
  area_min?: number;
  area_max?: number;
  bedrooms?: number;
  /** Max acceptable unit age in YEARS (عمر العقار) — 0 = new only. */
  max_unit_age?: number;
  amenities?: string[];
  /** MUST-HAVE amenities — the engine drops any candidate that doesn't list ALL
   *  of them (hard gate, fails closed on no-amenity-data). Set by the finder UIs'
   *  "must have" toggle from the selected `amenities`; never stored on the client. */
  required_amenities?: string[];
  /** PER-FIELD strictness (hard/soft + tolerance band). Omitted fields fall back
   *  to DEFAULT_CONSTRAINTS in the engine. See `./constraints`. */
  constraints?: RequirementConstraints;
}

export interface DraftToRequirementsArgs {
  clientsModel: AppModel | null;
  /** Lifted, draft-first preference buffer (seeded from the saved client). */
  prefDraft: Record<string, unknown>;
  /** The saved client record's data — fallback when a draft slot is empty. */
  savedClientData: Record<string, unknown> | null;
  /** Resolve a lookup record id to its display name. Wired by the caller to the
   *  loaded districts/cities records (id → data.display_name). */
  resolveLookupName?: (id: string, target: 'districts' | 'cities') => string | null;
}

const isPresent = (v: unknown): boolean => {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.some((x) => x !== null && x !== undefined && x !== '');
  // Objects: a range {min,max} OR a `location` compound { city:[], district:[] }
  // is present when any nested value is present.
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).some((x) => isPresent(x));
  return true;
};

/** Every non-empty string id in a value (single string or array of ids). */
const allStrings = (v: unknown): string[] => {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return [];
};

const rangeBounds = (v: unknown): { min?: number; max?: number } => {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const min = typeof o.min === 'number' ? o.min : Number(o.min);
  const max = typeof o.max === 'number' ? o.max : Number(o.max);
  const out: { min?: number; max?: number } = {};
  if (Number.isFinite(min) && min > 0) out.min = min;
  if (Number.isFinite(max) && max > 0) out.max = max;
  return out;
};

export function draftToMatchRequirements(args: DraftToRequirementsArgs): MatchRequirementsInput {
  const { prefDraft, savedClientData, resolveLookupName } = args;

  const pick = (slug: string): unknown => {
    const draftVal = prefDraft[slug];
    if (isPresent(draftVal)) return draftVal;
    const savedVal = savedClientData?.[slug];
    return isPresent(savedVal) ? savedVal : undefined;
  };

  const out: MatchRequirementsInput = {};

  // ── Geography: the `location` cascade compound { region:[], city:[], district:[] }.
  //    Collect ALL requested district ids — from the location cascade's district
  //    array, the separate `preferred_districts` multi-lookup, AND the include-district
  //    rules in `location_items` — resolve each to a name, dedupe, and send them all.
  //    The engine treats a project in ANY of them as an exact match. `district` stays
  //    = districts[0] for single-district paths. ──
  const locVal = pick('location');
  const loc = locVal && typeof locVal === 'object' && !Array.isArray(locVal)
    ? (locVal as Record<string, unknown>) : {};

  // A district picked in the location box is stored as a `location_items` district
  // include-rule (it drives the geo gate), NOT the `location` cascade. Without
  // mirroring those ids into requirements.districts the tier scoring has no requested
  // district, so every gated result falls to the "same city / different district" tier
  // even though it sits inside the requested district. Pull the include-rules here.
  const itemDistrictIds: string[] = [];
  const itemDistrictLabels: Record<string, string> = {};
  const itemsVal = pick('location_items');
  if (Array.isArray(itemsVal)) {
    for (const it of itemsVal) {
      if (!it || typeof it !== 'object') continue;
      const rec = it as Record<string, unknown>;
      if (rec.kind !== 'district' || rec.polarity === 'exclude') continue;
      const did = typeof rec.district_id === 'string' ? rec.district_id.trim() : '';
      if (!did) continue;
      itemDistrictIds.push(did);
      if (typeof rec.district_label === 'string' && rec.district_label.trim()) {
        itemDistrictLabels[did] = rec.district_label.trim();
      }
    }
  }

  const districtIds = [...new Set([
    ...allStrings(loc.district), ...allStrings(pick('preferred_districts')), ...itemDistrictIds,
  ])];
  const districtNames = [...new Set(
    districtIds
      // Prefer the live districts record's name; fall back to the label stashed on the
      // location_item (so a district still resolves even if its record isn't loaded).
      .map((id) => resolveLookupName?.(id, 'districts') ?? itemDistrictLabels[id] ?? undefined)
      .filter((n): n is string => !!n),
  )];
  if (districtNames.length) {
    out.districts = districtNames;
    out.district = districtNames[0];
  }
  // Send the record ids too: they're the districts the client ACTUALLY selected.
  // The engine matches on ids (exact, city-safe); the names remain a fallback for
  // any id that no longer resolves.
  if (districtIds.length) out.district_ids = districtIds;

  // Multiple selected cities are alternatives (OR) — send them ALL; the engine
  // city-matches a project in ANY of them. `city` stays = cities[0] for
  // single-city paths (zone expansion, district disambiguation).
  const cityNames = [...new Set(
    allStrings(loc.city)
      .map((id) => resolveLookupName?.(id, 'cities') ?? undefined)
      .filter((n): n is string => !!n),
  )];
  if (cityNames.length) {
    out.cities = cityNames;
    out.city = cityNames[0];
  }

  // ── Property type (multiselect of Arabic labels). Multiple selections are
  //    alternatives (OR) — the client accepts ANY of them — so send them ALL;
  //    the matcher expands synonyms/Arabic↔English per type and a project offering
  //    any one gets full type credit. `property_type` stays = the first for
  //    single-type code paths. ──
  const unitTypes = [...new Set(allStrings(pick('preferred_unit_type')))];
  if (unitTypes.length) {
    out.property_types = unitTypes;
    out.property_type = unitTypes[0];
  }

  // ── Budget / area ranges ──
  const budget = rangeBounds(pick('budget'));
  if (budget.min != null) out.budget_min = budget.min;
  if (budget.max != null) out.budget_max = budget.max;

  const area = rangeBounds(pick('preferred_area'));
  if (area.min != null) out.area_min = area.min;
  if (area.max != null) out.area_max = area.max;

  // ── Bedrooms: the client stores a range; the matcher wants a single AT-LEAST
  //    value → its minimum. Centralized here (was duplicated in the finder view's
  //    buildReqs) so every caller — the finder AND the live inventory meter — sends
  //    the same `bedrooms` and can never disagree on eligibility. ──
  const bedsV = pick('preferred_bedrooms');
  if (bedsV && typeof bedsV === 'object' && !Array.isArray(bedsV)) {
    const mn = Number((bedsV as Record<string, unknown>).min);
    if (Number.isFinite(mn) && mn > 0) out.bedrooms = mn;
  } else if (typeof bedsV === 'number' && bedsV > 0) {
    out.bedrooms = bedsV;
  }

  // ── Unit age (عمر العقار) — the dropdown stores the max years as a STRING
  //    option value ('0' = new only, '2', '5', '10'). '0' is meaningful, so the
  //    check is Number.isFinite, not truthiness. ──
  const ageV = pick('preferred_max_unit_age');
  if (typeof ageV === 'string' || typeof ageV === 'number') {
    const n = Number(ageV);
    if (Number.isFinite(n) && n >= 0) out.max_unit_age = n;
  }

  // ── Amenities (best-effort; low weight in scoring) ──
  const amenities = pick('preferred_amenities');
  if (Array.isArray(amenities)) {
    const list = amenities.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (list.length) out.amenities = list;
  }

  // ── Per-field strictness bands, registered WITH the client's preferences
  //    (persisted as `preference_constraints` on the client record, edited via
  //    the band controls under each preference field). Draft-first like the rest.
  //    An amenities band set to 'hard' also fills `required_amenities` — the
  //    explicit wire format the engine's must-have gate reads. ──
  const pc = pick('preference_constraints');
  if (pc && typeof pc === 'object' && !Array.isArray(pc)) {
    out.constraints = pc as RequirementConstraints;
    const amenC = (pc as RequirementConstraints).amenities;
    if (amenC?.mode === 'hard' && out.amenities?.length) out.required_amenities = out.amenities;
  }

  return out;
}
