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

/**
 * Resolve a field slug from a list of candidates (first one present on the
 * model wins). The LIVE all_projects model was rebuilt in the Builder with
 * different slugs than the seed (e.g. `preferred_city` not `city`), so we
 * try the live slug first and fall back to the seed slug — works for both.
 */
function slugByCandidates(model: AppModel | undefined, candidates: string[]): string | null {
  if (!model) return null;
  const fields = model.schema.sections.flatMap((s) => s.fields);
  for (const c of candidates) if (fields.some((f) => f.name === c)) return c;
  return null;
}

/**
 * Find a computed field's slug by its `computed_kind` (stable across renames
 * and independent of which model it lives on). Used to read the auto-calculated
 * unit rollups — price/bedroom/bathroom ranges, unit counts — which on the
 * live model live on all_projects, and on the seed live on our_projects.
 */
function slugByComputedKind(model: AppModel | undefined, kind: string): string | null {
  if (!model) return null;
  return (
    model.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => (f.is_rollup ?? f.is_computed) && (f.rollup_kind ?? f.computed_kind) === kind)?.name ?? null
  );
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

  // Resolve scalar field slugs from the LIVE model (live slug first, seed
  // fallback). The live all_projects was rebuilt in the Builder, so the seed
  // slugs (city/district/brochure_link/location) don't exist there.
  const citySlug = slugByCandidates(allProjectsModel, ['preferred_city', 'city']);
  const districtSlug = slugByCandidates(allProjectsModel, ['preferred_neighborhoods', 'district', 'neighborhood']);
  const unitTypesSlug = slugByCandidates(allProjectsModel, ['unit_types', 'unit_type']);
  const brochureSlug = slugByCandidates(allProjectsModel, ['brochure_url', 'brochure_link', 'brochure']);
  const locationSlug = slugByCandidates(allProjectsModel, ['project_location', 'location', 'location_url']);

  // City / district — dropdowns on all_projects, resolved to bilingual labels.
  const city = resolveOptionLabels(citySlug ? fieldBySlug(allProjectsModel, citySlug) : undefined, citySlug ? ap[citySlug] : null);
  const district = resolveOptionLabels(districtSlug ? fieldBySlug(allProjectsModel, districtSlug) : undefined, districtSlug ? ap[districtSlug] : null);

  // Units linked to this project (project_id → all_projects.id).
  const units = unitsModel ? (records[unitsModel.id] ?? []) : [];

  // Unit types available — prefer the curated all_projects `unit_types`
  // multiselect; fall back to the distinct unit_type across the project's units.
  const unitTypes: Bilingual[] = [];
  const seenTypes = new Set<string>();
  const utField = unitTypesSlug ? fieldBySlug(allProjectsModel, unitTypesSlug) : undefined;
  const utRaw = unitTypesSlug ? ap[unitTypesSlug] : null;
  const utValues = Array.isArray(utRaw) ? utRaw : utRaw != null && utRaw !== '' ? [utRaw] : [];
  for (const v of utValues) {
    const key = asString(v);
    if (!key || seenTypes.has(key)) continue;
    seenTypes.add(key);
    const label = resolveOptionLabels(utField, v);
    if (label) unitTypes.push(label);
  }
  if (unitTypes.length === 0 && allProjectId) {
    const unitTypeField = fieldBySlug(unitsModel, 'unit_type');
    for (const u of units) {
      const pid = u.data?.project_id;
      const matches = typeof pid === 'string' ? pid === allProjectId : Array.isArray(pid) && pid.includes(allProjectId);
      if (!matches) continue;
      const v = asString(u.data?.unit_type);
      if (!v || seenTypes.has(v)) continue;
      seenTypes.add(v);
      const label = resolveOptionLabels(unitTypeField, v);
      if (label) unitTypes.push(label);
    }
  }

  // Auto-calculated unit rollups (bedroom/bathroom/price ranges). They're
  // `is_computed` and never stored, so recompute via the shared engine. On the
  // LIVE model they live on all_projects; on the seed on our_projects. Compute
  // both, then read each rollup BY its computed_kind from whichever model
  // defines it — robust to slug renames and to the field moving between models.
  const apRolled = allProject && allProjectsModel ? applyProjectRollups(allProject, allProjectsModel, units) : null;
  const opRolled = ourProjectsModel ? applyProjectRollups(ourProject, ourProjectsModel, units) : null;
  const readRollup = (kind: string): unknown => {
    const apSlug = slugByComputedKind(allProjectsModel, kind);
    if (apSlug && apRolled?.data?.[apSlug] != null) return apRolled.data[apSlug];
    const opSlug = slugByComputedKind(ourProjectsModel, kind);
    if (opSlug && opRolled?.data?.[opSlug] != null) return opRolled.data[opSlug];
    return null;
  };

  const bedrooms = (readRollup('bedroom_range') as NumericRange | null) ?? null;
  const bathrooms = (readRollup('bathroom_range') as NumericRange | null) ?? null;
  const priceRange = readRollup('price_range') as NumericRange | null;

  // Minimum price — the calculated floor from real units. Fall back to a plain
  // min_price field only if the model still has one (the seed did; the live
  // model derives price entirely from the computed price_range).
  const minPriceSlug = slugByCandidates(allProjectsModel, ['min_price', 'starting_price']);
  const minPriceNum =
    (priceRange && Number.isFinite(priceRange.min) ? priceRange.min : null) ??
    (minPriceSlug ? asFiniteNumber(ap[minPriceSlug]) : null);
  const minPrice = minPriceNum != null ? formatPrice(minPriceNum) : null;

  const brochureLink = brochureSlug ? asString(ap[brochureSlug]) : null;
  const locationLink = resolveLocationLink(locationSlug ? asString(ap[locationSlug]) : null);

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

function rangeText(r: NumericRange): string {
  return r.min === r.max ? String(r.min) : `${r.min} - ${r.max}`;
}

/**
 * Compose the WhatsApp message DETERMINISTICALLY from resolved facts — no AI,
 * no greeting line, no closing line, exact labels. A field that's missing is
 * OMITTED entirely (never written as "not available"; the preview surfaces
 * what's missing separately, via `facts.missing`). Structure: the project name
 * on its own line, a blank line, then one labeled line per PRESENT field.
 *
 * Per the user's exact spec (2026-06-08): price label is "الأسعار تبدأ من" /
 * "Prices start from"; nothing extra is ever added to the body.
 */
export function composeProjectMessage(
  facts: ProjectMessageFacts,
  opts?: { nameEn?: string | null },
): { body_ar: string; body_en: string } {
  const ar: string[] = [];
  const en: string[] = [];
  if (facts.city) { ar.push(`المدينة: ${facts.city.ar}`); en.push(`City: ${facts.city.en}`); }
  if (facts.district) { ar.push(`الحي: ${facts.district.ar}`); en.push(`District: ${facts.district.en}`); }
  if (facts.unitTypes.length > 0) {
    ar.push(`أنواع الوحدات: ${facts.unitTypes.map((u) => u.ar).join('، ')}`);
    en.push(`Unit Types: ${facts.unitTypes.map((u) => u.en).join(', ')}`);
  }
  if (facts.bedrooms) { ar.push(`غرف النوم: ${rangeText(facts.bedrooms)}`); en.push(`Bedrooms: ${rangeText(facts.bedrooms)}`); }
  if (facts.bathrooms) { ar.push(`دورات المياه: ${rangeText(facts.bathrooms)}`); en.push(`Bathrooms: ${rangeText(facts.bathrooms)}`); }
  if (facts.minPrice) { ar.push(`الأسعار تبدأ من: ${facts.minPrice.ar}`); en.push(`Prices start from: ${facts.minPrice.en}`); }
  if (facts.brochureLink) { ar.push(`البروشور: ${facts.brochureLink}`); en.push(`Brochure: ${facts.brochureLink}`); }
  if (facts.locationLink) { ar.push(`الموقع: ${facts.locationLink}`); en.push(`Location: ${facts.locationLink}`); }
  // The project name is a single (Arabic) text field with no stored English
  // form, so the English body uses a translated/transliterated name when one
  // is supplied (e.g. "مينا 52" → "Mena 52"); falls back to the Arabic name.
  const titleAr = facts.name ?? '';
  const titleEn = (opts?.nameEn || facts.name) ?? '';
  return {
    body_ar: [titleAr, '', ...ar].join('\n').trim(),
    body_en: [titleEn, '', ...en].join('\n').trim(),
  };
}
