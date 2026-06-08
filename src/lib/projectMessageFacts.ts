// Resolve the 9 project facts a WhatsApp message template needs, for one
// `our_projects` record. Pure: derives entirely from the passed models +
// records slices; no I/O. Used by the AI Project Message generator
// (ProjectMessageGeneratorModal) and unit-testable in isolation.
//
// Data lives across THREE models (the spec's "read it all from all_projects"
// isn't how the schema works):
//   - our_projects (the selected record): links to a master via the `project`
//     lookup, and carries the auto-calculated unit rollups (bedroom_range,
//     bathroom_range, price_range) — computed at read time, never stored.
//   - all_projects (the linked master): project_name, city, district,
//     min_price, brochure_link, location.
//   - units (project_id → all_projects.id): the source of the rollups AND the
//     distinct unit types available.

import type { AppModel, AppRecord, ModelField } from '@/types';
import { applyProjectRollups } from './ourProjectsRollup';
import { parseGoogleMapsUrl } from './locationUtils';

export interface Bilingual {
  ar: string;
  en: string;
}

export interface NumericRange {
  min: number;
  max: number;
}

/**
 * Bilingual, pre-resolved facts handed to the generation endpoint. Every
 * dropdown value is already resolved to its ar/en label so the server never
 * resolves anything (and so it cannot invent a label). Prices are pre-formatted
 * per language. `null` / empty = genuinely missing → the prompt renders the
 * "not available" placeholder and the preview shows a warning.
 */
export interface ProjectMessageFacts {
  /** The our_projects record this was generated from. */
  ourProjectId: string;
  /** The linked all_projects master id — what the template links to. */
  allProjectId: string | null;
  name: string | null;
  city: Bilingual | null;
  district: Bilingual | null;
  unitTypes: Bilingual[];
  bedrooms: NumericRange | null;
  bathrooms: NumericRange | null;
  /** Pre-formatted starting price per language (e.g. "1,200,000 ر.س" / "SAR 1,200,000"). */
  minPrice: Bilingual | null;
  brochureLink: string | null;
  locationLink: string | null;
  /** Human-readable keys of the required fields that came back empty. */
  missing: string[];
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Resolve a dropdown option `value` to its bilingual labels via the field's
 *  options. Falls back to the raw value for both languages if the option was
 *  removed/renamed (stale data), so the message still shows something real. */
function resolveOptionLabels(field: ModelField | undefined, value: unknown): Bilingual | null {
  const v = asString(value);
  if (!v) return null;
  const opt = (field?.options ?? []).find((o) => o.value === v || o.id === v);
  if (!opt) return { ar: v, en: v };
  return { ar: opt.label_ar || opt.label_en || v, en: opt.label_en || opt.label_ar || v };
}

function fieldBySlug(model: AppModel | undefined, slug: string): ModelField | undefined {
  return model?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === slug);
}

/** Format a number with thousands separators + currency, per language. */
function formatPrice(n: number): Bilingual {
  const grouped = Math.round(n).toLocaleString('en-US');
  return { ar: `${grouped} ر.س`, en: `SAR ${grouped}` };
}

/** Turn the all_projects `location` value (a Google-Maps URL or a bare
 *  "lat,lng") into a clickable link, or null. A full http(s) URL is used
 *  as-is; a coordinate pair becomes a maps query URL. */
function resolveLocationLink(raw: string | null): string | null {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const parsed = parseGoogleMapsUrl(raw);
  if (parsed) return `https://www.google.com/maps?q=${parsed.lat},${parsed.lng}`;
  return null;
}

export function resolveProjectFacts(
  ourProject: AppRecord,
  models: AppModel[],
  records: Record<string, AppRecord[]>,
): ProjectMessageFacts {
  const ourProjectsModel = models.find((m) => m.name === 'our_projects');
  const allProjectsModel = models.find((m) => m.name === 'all_projects');
  const unitsModel = models.find((m) => m.name === 'units');

  // Linked all_projects master (the `project` lookup on our_projects).
  const linkedRaw = ourProject.data?.project;
  const allProjectId =
    typeof linkedRaw === 'string' && linkedRaw
      ? linkedRaw
      : Array.isArray(linkedRaw) && typeof linkedRaw[0] === 'string'
        ? (linkedRaw[0] as string)
        : null;
  const allProject =
    allProjectId && allProjectsModel
      ? (records[allProjectsModel.id] ?? []).find((r) => r.id === allProjectId) ?? null
      : null;
  const ap = (allProject?.data ?? {}) as Record<string, unknown>;

  // Name — prefer the master's name, fall back to the our_projects name.
  const name = asString(ap.project_name) ?? asString(ourProject.data?.project_name);

  // City / district — dropdowns on all_projects, resolved to bilingual labels.
  const city = resolveOptionLabels(fieldBySlug(allProjectsModel, 'city'), ap.city);
  const district = resolveOptionLabels(fieldBySlug(allProjectsModel, 'district'), ap.district);

  // Units linked to this project (project_id → all_projects.id).
  const units = unitsModel ? (records[unitsModel.id] ?? []) : [];
  const projectUnits = allProjectId
    ? units.filter((u) => {
        const pid = u.data?.project_id;
        if (typeof pid === 'string') return pid === allProjectId;
        if (Array.isArray(pid)) return pid.includes(allProjectId);
        return false;
      })
    : [];

  // Unit types available — distinct unit_type values across the project's units,
  // resolved to bilingual labels (preserve first-seen order).
  const unitTypeField = fieldBySlug(unitsModel, 'unit_type');
  const seenTypes = new Set<string>();
  const unitTypes: Bilingual[] = [];
  for (const u of projectUnits) {
    const v = asString(u.data?.unit_type);
    if (!v || seenTypes.has(v)) continue;
    seenTypes.add(v);
    const label = resolveOptionLabels(unitTypeField, v);
    if (label) unitTypes.push(label);
  }

  // Bedroom / bathroom ranges — the auto-calculated rollups. They're stripped
  // from stored data, so recompute them from the units via the shared engine.
  const rolled =
    ourProjectsModel != null ? applyProjectRollups(ourProject, ourProjectsModel, units) : ourProject;
  const bedrooms = rolled.data?.bedroom_range as NumericRange | null | undefined;
  const bathrooms = rolled.data?.bathroom_range as NumericRange | null | undefined;
  const priceRange = rolled.data?.price_range as NumericRange | null | undefined;

  // Minimum price — the calculated floor from real units wins; fall back to the
  // master's manually-entered min_price when the project has no priced units.
  const minPriceNum =
    (priceRange && Number.isFinite(priceRange.min) ? priceRange.min : null) ?? asFiniteNumber(ap.min_price);
  const minPrice = minPriceNum != null ? formatPrice(minPriceNum) : null;

  const brochureLink = asString(ap.brochure_link);
  const locationLink = resolveLocationLink(asString(ap.location));

  // Which required fields are genuinely empty → drives the preview warnings +
  // the "not available" placeholder in the message.
  const missing: string[] = [];
  if (!name) missing.push('name');
  if (!city) missing.push('city');
  if (!district) missing.push('district');
  if (unitTypes.length === 0) missing.push('unit_types');
  if (!bedrooms) missing.push('bedrooms');
  if (!bathrooms) missing.push('bathrooms');
  if (!minPrice) missing.push('min_price');
  if (!brochureLink) missing.push('brochure');
  if (!locationLink) missing.push('location');

  return {
    ourProjectId: ourProject.id,
    allProjectId,
    name,
    city,
    district,
    unitTypes,
    bedrooms: bedrooms ?? null,
    bathrooms: bathrooms ?? null,
    minPrice,
    brochureLink,
    locationLink,
    missing,
  };
}
