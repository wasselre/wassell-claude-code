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

/** Mirror of api/_lib/matchAgent.MatchRequirements (the fields the SPA fills). */
export interface MatchRequirementsInput {
  city?: string;
  district?: string;
  property_type?: string;
  budget_min?: number;
  budget_max?: number;
  area_min?: number;
  area_max?: number;
  bedrooms?: number;
  amenities?: string[];
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

const firstString = (v: unknown): string | undefined => {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (Array.isArray(v)) {
    for (const x of v) if (typeof x === 'string' && x.trim() !== '') return x.trim();
  }
  return undefined;
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
  //    Take the first district/city id and resolve it to a name. ──
  const locVal = pick('location');
  const loc = locVal && typeof locVal === 'object' && !Array.isArray(locVal)
    ? (locVal as Record<string, unknown>) : {};
  const districtLookupId = firstString(loc.district);
  const districtName = districtLookupId ? resolveLookupName?.(districtLookupId, 'districts') ?? undefined : undefined;
  if (districtName) out.district = districtName;

  const cityLookupId = firstString(loc.city);
  const cityName = cityLookupId ? resolveLookupName?.(cityLookupId, 'cities') ?? undefined : undefined;
  if (cityName) out.city = cityName;

  // ── Property type (multiselect of Arabic labels — first is enough; the matcher
  //    expands synonyms/Arabic↔English). ──
  const unitType = firstString(pick('preferred_unit_type'));
  if (unitType) out.property_type = unitType;

  // ── Budget / area ranges ──
  const budget = rangeBounds(pick('budget'));
  if (budget.min != null) out.budget_min = budget.min;
  if (budget.max != null) out.budget_max = budget.max;

  const area = rangeBounds(pick('preferred_area'));
  if (area.min != null) out.area_min = area.min;
  if (area.max != null) out.area_max = area.max;

  // ── Amenities (best-effort; low weight in scoring) ──
  const amenities = pick('preferred_amenities');
  if (Array.isArray(amenities)) {
    const list = amenities.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (list.length) out.amenities = list;
  }

  return out;
}
