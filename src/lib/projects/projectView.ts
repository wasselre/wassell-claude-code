// Reusable, PURE resolver for the Projects + Units experience. Given the store's
// models + records slices, it turns a raw all_projects / units record into a
// fully-resolved view object (display names, option labels+colors, geography
// names, stored rollups) so every Projects surface — list cards, the detail
// page, the units inventory, and the AI actions — reads project facts the SAME
// way. No I/O, no React: unit-testable in isolation.
//
// Design rules honored here:
//   * Source of truth = all_projects. Rollups are STORED on the record (DB
//     trigger maintained) — read them, never recompute (see CLAUDE.md
//     "Persisted project rollups").
//   * Missing data stays missing (null) — callers render "غير متوفر", never a
//     guessed value. The AI layer relies on this to avoid hallucinating facts.
//   * Slugs are resolved defensively (live slug first, seed fallback) because
//     the live models were Builder-rebuilt with drifted slugs.

import type { AppModel, AppRecord, ModelField, FieldOption } from '@/types';

export interface ProjectStoreSlices {
  models: AppModel[];
  records: Record<string, AppRecord[]>;
}

export interface NumericRange {
  min: number;
  max: number;
}

export interface OptionView {
  value: string;
  label_ar: string;
  label_en: string;
  color: string | null;
}

export interface ProjectView {
  id: string;
  raw: AppRecord;
  name: string | null;
  developer: string | null;
  projectId: string | null; // auto_id (human code)
  city: string | null;
  district: string | null;
  status: OptionView | null;
  construction: OptionView | null;
  projectType: OptionView | null;
  unitTypes: OptionView[];
  // Stored rollups (never recomputed here).
  unitCount: number | null;
  availableUnits: number | null;
  soldUnits: number | null;
  reservedUnits: number | null;
  priceRange: NumericRange | null;
  areaRange: NumericRange | null;
  // Media / links.
  imageUrl: string | null;
  brochureDeveloper: string | null;
  brochureOurs: string | null;
  locationLink: string | null;
  // Flags.
  hasGeo: boolean;
  isTargeted: boolean;
  isPublic: boolean;
  dataConfidence: number | null;
  createdAt: string;
}

// ── primitives ────────────────────────────────────────────────────────────

export function modelByName(models: AppModel[], name: string): AppModel | undefined {
  return models.find((m) => m.name === name);
}

export function allFields(model: AppModel | undefined): ModelField[] {
  if (!model) return [];
  return model.schema.sections.flatMap((s) => s.fields);
}

export function fieldBySlug(model: AppModel | undefined, slug: string): ModelField | undefined {
  return allFields(model).find((f) => f.name === slug);
}

/** First field whose slug matches one of the candidates (handles slug drift). */
export function fieldByCandidates(model: AppModel | undefined, candidates: string[]): ModelField | undefined {
  const fields = allFields(model);
  for (const c of candidates) {
    const f = fields.find((x) => x.name === c);
    if (f) return f;
  }
  return undefined;
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asRange(v: unknown): NumericRange | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const min = asFiniteNumber(o.min);
  const max = asFiniteNumber(o.max);
  if (min === null && max === null) return null;
  return { min: min ?? max ?? 0, max: max ?? min ?? 0 };
}

/** Resolve a dropdown raw value to its option (label + color). */
export function optionFor(field: ModelField | undefined, raw: unknown): OptionView | null {
  const value = asString(raw);
  if (!field || !value) return null;
  const opt = (field.options ?? []).find((o: FieldOption) => o.value === value);
  if (!opt) return { value, label_ar: value, label_en: value, color: null };
  return { value, label_ar: opt.label_ar, label_en: opt.label_en, color: opt.color ?? null };
}

export function optionsFor(field: ModelField | undefined, raw: unknown): OptionView[] {
  if (!field) return [];
  const values = Array.isArray(raw) ? raw : raw != null && raw !== '' ? [raw] : [];
  const out: OptionView[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const ov = optionFor(field, v);
    if (ov && !seen.has(ov.value)) {
      seen.add(ov.value);
      out.push(ov);
    }
  }
  return out;
}

function firstId(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' && v ? v : null;
}

/** Resolve a geography record id (cities/districts) to its display name. */
export function geoName(store: ProjectStoreSlices, modelName: 'cities' | 'districts', id: string | null): string | null {
  if (!id) return null;
  const m = modelByName(store.models, modelName);
  if (!m) return null;
  const rec = (store.records[m.id] ?? []).find((r) => r.id === id);
  const dn = rec?.data?.display_name ?? rec?.data?.name_ar ?? rec?.data?.name_en;
  return typeof dn === 'string' && dn ? dn : null;
}

/** Resolve a single lookup id to a display value on its target model. */
export function lookupName(store: ProjectStoreSlices, field: ModelField | undefined, raw: unknown): string | null {
  if (!field || !field.lookup_model_id) return null;
  const id = firstId(raw);
  if (!id) return null;
  const rec = (store.records[field.lookup_model_id] ?? []).find((r) => r.id === id);
  if (!rec) return null;
  const displaySlug = field.lookup_display_field ?? 'name';
  const v = rec.data?.[displaySlug] ?? rec.data?.name ?? rec.data?.project_name;
  return typeof v === 'string' && v ? v : null;
}

/** Read a stored rollup BY its rollup_kind (robust to slug renames). */
export function rollupByKind(model: AppModel | undefined, data: Record<string, unknown>, kind: string): unknown {
  const f = allFields(model).find((x) => (x.rollup_kind ?? (x as { computed_kind?: string }).computed_kind) === kind);
  if (!f) return null;
  return data[f.name] ?? null;
}

// ── the resolver ────────────────────────────────────────────────────────────

export function resolveProjectView(store: ProjectStoreSlices, record: AppRecord): ProjectView {
  const ap = modelByName(store.models, 'all_projects');
  const data = (record.data ?? {}) as Record<string, unknown>;

  const loc = data.location && typeof data.location === 'object' && !Array.isArray(data.location)
    ? (data.location as Record<string, unknown>)
    : {};

  const statusField = fieldByCandidates(ap, ['project_status', 'status']);
  const constructionField = fieldByCandidates(ap, ['construction_status']);
  const typeField = fieldByCandidates(ap, ['project_type']);
  const unitTypesField = fieldByCandidates(ap, ['unit_types', 'unit_type']);
  const developerField = fieldByCandidates(ap, ['developer']);
  const projectIdField = fieldByCandidates(ap, ['project_id']);
  const imageField = fieldByCandidates(ap, ['image_url', 'main_image']);
  const confidenceField = fieldByCandidates(ap, ['data_confidence_score']);

  const imageRaw = imageField ? data[imageField.name] : null;

  return {
    id: record.id,
    raw: record,
    name: asString(data.project_name),
    developer: lookupName(store, developerField, developerField ? data[developerField.name] : null),
    projectId: projectIdField ? asString(data[projectIdField.name]) : null,
    city: geoName(store, 'cities', firstId(loc.city)),
    district: geoName(store, 'districts', firstId(loc.district)),
    status: optionFor(statusField, statusField ? data[statusField.name] : null),
    construction: optionFor(constructionField, constructionField ? data[constructionField.name] : null),
    projectType: optionFor(typeField, typeField ? data[typeField.name] : null),
    unitTypes: optionsFor(unitTypesField, unitTypesField ? data[unitTypesField.name] : null),
    unitCount: asFiniteNumber(rollupByKind(ap, data, 'units_count')),
    availableUnits: asFiniteNumber(rollupByKind(ap, data, 'units_available_count')),
    soldUnits: asFiniteNumber(rollupByKind(ap, data, 'units_sold_count')),
    reservedUnits: asFiniteNumber(rollupByKind(ap, data, 'units_reserved_count')),
    priceRange: asRange(rollupByKind(ap, data, 'price_range')),
    areaRange: asRange(rollupByKind(ap, data, 'area_range')),
    imageUrl: typeof imageRaw === 'string' && /^https?:\/\//i.test(imageRaw) ? imageRaw : null,
    brochureDeveloper: asString(data.broucher_developer),
    brochureOurs: asString(data.brochure_link),
    locationLink: asString(data.project_location),
    hasGeo: !!firstId(loc.city) || !!firstId(loc.district) || asFiniteNumber(data.latitude) !== null,
    isTargeted: data.is_targeted === true,
    isPublic: data.is_public === true,
    dataConfidence: confidenceField ? asFiniteNumber(data[confidenceField.name]) : null,
    createdAt: record.created_at,
  };
}

/** Format a price range bilingually, e.g. "1,200,000 – 1,800,000 ر.س". Missing → null. */
export function formatPriceRange(range: NumericRange | null, isAr: boolean): string | null {
  if (!range) return null;
  const cur = isAr ? 'ر.س' : 'SAR';
  const locale = isAr ? 'ar-SA' : 'en-US';
  if (range.min === range.max) return `${range.min.toLocaleString(locale)} ${cur}`;
  return `${range.min.toLocaleString(locale)} – ${range.max.toLocaleString(locale)} ${cur}`;
}

export function formatRange(range: NumericRange | null, unit: string): string | null {
  if (!range) return null;
  if (range.min === range.max) return `${range.min.toLocaleString()} ${unit}`.trim();
  return `${range.min.toLocaleString()} – ${range.max.toLocaleString()} ${unit}`.trim();
}
