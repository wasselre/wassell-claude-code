// PURE resolver for `units` records — the twin of projectView for the inventory
// engine. Resolves a raw unit into display-ready facts (option labels, computed
// price/m²) so the inventory table, the unit drawer, comparison, and the AI
// WhatsApp/compare actions all read units the SAME way. No I/O, no React.
//
// Rules (same as projectView): missing facts return null — never guessed. The
// only DERIVED value is price/m² (total_price ÷ unit_area), which is explicitly
// allowed by the spec ("price_per_m2 if available or computable").

import type { AppRecord } from '@/types';
import {
  type ProjectStoreSlices,
  type ProjectViewOpts,
  type OptionView,
  modelByName,
  fieldByCandidates,
  optionFor,
  optionsFor,
  asString,
  asFiniteNumber,
  lookupNameLocalized,
} from './projectView';

export interface UnitView {
  id: string;
  raw: AppRecord;
  projectId: string | null;
  code: string | null;
  unitNumber: string | null;
  model: string | null;
  developer: string | null;
  type: OptionView | null;
  status: OptionView | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floor: OptionView | null;
  area: number | null; // unit_area (m²)
  privateArea: number | null;
  totalArea: number | null;
  yardArea: number | null;
  deedArea: number | null;
  totalPrice: number | null;
  pricePerM2: number | null; // derived
  components: OptionView[];
  facade: OptionView[];
  parking: OptionView[];
  elevator: OptionView | null;
  building: string | null;
  block: string | null;
  streetWidth: string | null;
  planImage: string | null;
  unitBrochure: string | null;
  projectBrochure: string | null;
  locationLink: string | null;
  notes: string | null;
  createdAt: string;
}

/** First lookup field on the units model that points at all_projects. */
export function unitsForProject(store: ProjectStoreSlices, projectId: string): AppRecord[] {
  const unitsModel = modelByName(store.models, 'units');
  const allProjects = modelByName(store.models, 'all_projects');
  if (!unitsModel || !allProjects) return [];
  const lookupFields = unitsModel.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'lookup' && f.lookup_model_id === allProjects.id);
  if (lookupFields.length === 0) return [];
  const list = store.records[unitsModel.id] ?? [];
  return list.filter((r) =>
    lookupFields.some((f) => {
      const v = (r.data as Record<string, unknown>)[f.name];
      return Array.isArray(v) ? v.includes(projectId) : v === projectId;
    }),
  );
}

export function resolveUnitView(
  store: ProjectStoreSlices,
  record: AppRecord,
  opts: ProjectViewOpts = {},
): UnitView {
  const um = modelByName(store.models, 'units');
  const data = (record.data ?? {}) as Record<string, unknown>;
  const lang: 'ar' | 'en' = opts.isAr === false ? 'en' : 'ar';
  // W6: prefer the field's translation for the current language, else the source.
  const tr = (fieldPath: string, source: string | null): string | null =>
    (opts.translate?.(record.id, fieldPath, lang) ?? null) || source;

  const projectField = fieldByCandidates(um, ['project_id']);
  const developerField = fieldByCandidates(um, ['developer_id', 'developer']);
  const typeField = fieldByCandidates(um, ['unit_type']);
  const statusField = fieldByCandidates(um, ['unit_status']);
  const floorField = fieldByCandidates(um, ['floor']);
  const componentsField = fieldByCandidates(um, ['unit_components']);
  const facadeField = fieldByCandidates(um, ['facade']);
  const parkingField = fieldByCandidates(um, ['parking_space']);
  const elevatorField = fieldByCandidates(um, ['elevator_status']);

  const area = asFiniteNumber(data.unit_area);
  const totalPrice = asFiniteNumber(data.total_price);
  const pricePerM2 = totalPrice !== null && area !== null && area > 0 ? Math.round(totalPrice / area) : null;

  const pid = projectField ? (data[projectField.name] as unknown) : null;
  const projectId = Array.isArray(pid) ? (typeof pid[0] === 'string' ? pid[0] : null) : (typeof pid === 'string' ? pid : null);


  return {
    id: record.id,
    raw: record,
    projectId,
    code: asString(data.unit_code) ?? asString(data.unit_number),
    unitNumber: data.unit_number != null ? String(data.unit_number) : null,
    model: tr('unit_model', asString(data.unit_model)),
    developer: lookupNameLocalized(store, developerField, developerField ? data[developerField.name] : null, opts),
    type: optionFor(typeField, typeField ? data[typeField.name] : null),
    status: optionFor(statusField, statusField ? data[statusField.name] : null),
    bedrooms: asFiniteNumber(data.bedrooms),
    bathrooms: asFiniteNumber(data.bathrooms),
    floor: optionFor(floorField, floorField ? data[floorField.name] : null),
    area,
    privateArea: asFiniteNumber(data.private_area),
    totalArea: asFiniteNumber(data.total_area),
    yardArea: asFiniteNumber(data.yard_area),
    deedArea: asFiniteNumber(data.deed_area),
    totalPrice,
    pricePerM2,
    components: optionsFor(componentsField, componentsField ? data[componentsField.name] : null),
    facade: optionsFor(facadeField, facadeField ? data[facadeField.name] : null),
    parking: optionsFor(parkingField, parkingField ? data[parkingField.name] : null),
    elevator: optionFor(elevatorField, elevatorField ? data[elevatorField.name] : null),
    building: asString(data.building_number),
    block: asString(data.block),
    streetWidth: asString(data.street_width),
    planImage: asString(data.unit_plan), // raw value: a files.id UUID or a legacy http URL; resolved at render
    unitBrochure: asString(data.unit_brochure),
    projectBrochure: asString(data.project_brochure),
    locationLink: asString(data.location_url) ?? asString(data.project_location),
    notes: tr('notes', asString(data.notes)),
    createdAt: record.created_at,
  };
}

/** id of the unit with the best (min/max) finite value of `pick`. Deterministic. */
export function bestUnitBy(units: UnitView[], pick: (u: UnitView) => number | null, want: 'min' | 'max'): string | null {
  let bestId: string | null = null;
  let bestVal: number | null = null;
  for (const u of units) {
    const v = pick(u);
    if (v === null) continue;
    if (bestVal === null || (want === 'min' ? v < bestVal : v > bestVal)) {
      bestVal = v;
      bestId = u.id;
    }
  }
  return bestId;
}

export type UnitSortKey = 'cheapest' | 'largest' | 'best_per_m2' | 'newest';

export function sortUnits(units: UnitView[], key: UnitSortKey): UnitView[] {
  const arr = [...units];
  const nn = (v: number | null, fallback: number) => (v === null ? fallback : v);
  switch (key) {
    case 'cheapest':
      return arr.sort((a, b) => nn(a.totalPrice, Infinity) - nn(b.totalPrice, Infinity));
    case 'largest':
      return arr.sort((a, b) => nn(b.area, -1) - nn(a.area, -1));
    case 'best_per_m2':
      return arr.sort((a, b) => nn(a.pricePerM2, Infinity) - nn(b.pricePerM2, Infinity));
    case 'newest':
      return arr.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
    default:
      return arr;
  }
}
