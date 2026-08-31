/**
 * Snapshot the display FACTS for a client-property-option's source record —
 * the same keys the Project Finder puts on its cards (price/area/beds/etc.), so
 * a manually-saved or unit-saved option renders identically in the Client
 * Options tab without re-resolving the source catalogue.
 *
 * Extracted from AddOptionModal (2026-08-31) so BOTH the manual picker and the
 * "save this unit to the client" action in UnitsInventory build byte-identical
 * facts. Pure + deterministic, no store writes, no AI.
 */

import {
  modelByName, geoName, rollupByKind, asString, asFiniteNumber,
  type ProjectStoreSlices,
} from '@/lib/projects/projectView';
import type { AppRecord } from '@/types';
import type { ClientOptionSourceType } from '@/lib/matching/clientOptions';

const firstId = (v: unknown): string | null =>
  Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : typeof v === 'string' && v ? v : null;

const locOf = (data: Record<string, unknown>): Record<string, unknown> =>
  data.location && typeof data.location === 'object' && !Array.isArray(data.location)
    ? (data.location as Record<string, unknown>)
    : {};

const scalarRange = (v: unknown): { min: number; max: number } | undefined => {
  const n = asFiniteNumber(v);
  return n != null ? { min: n, max: n } : undefined;
};

/** Facts snapshot per source — same keys the Project Finder puts on its cards
 *  (only present values), so manual/unit options render identically in the tab. */
export function buildOptionFacts(
  store: ProjectStoreSlices,
  sourceType: ClientOptionSourceType,
  rec: AppRecord,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v) && v.length === 0) return;
    facts[k] = v;
  };
  const data = rec.data as Record<string, unknown>;

  if (sourceType === 'project') {
    const ap = modelByName(store.models, 'all_projects');
    const loc = locOf(data);
    put('city', geoName(store, 'cities', firstId(loc.city)));
    put('district', geoName(store, 'districts', firstId(loc.district)));
    put('unit_types', Array.isArray(data.unit_types) ? data.unit_types : undefined);
    put('project_status', asString(data.project_status));
    put('price_range', rollupByKind(ap, data, 'price_range') ?? data.price_range);
    put('area_range', rollupByKind(ap, data, 'area_range') ?? data.area_range);
    put('bedroom_range', rollupByKind(ap, data, 'bedroom_range') ?? data.bedroom_range);
    put('bathroom_range', rollupByKind(ap, data, 'bathroom_range') ?? data.bathroom_range);
    put('unit_count', asFiniteNumber(rollupByKind(ap, data, 'units_count') ?? data.unit_count));
    put('available_units', asFiniteNumber(rollupByKind(ap, data, 'units_available_count') ?? data.available_units));
    const firstImage = Array.isArray(data.project_images)
      ? (data.project_images.find((x) => typeof x === 'string' && x) as string | undefined)
      : undefined;
    put('image', asString(data.main_image) ?? firstImage);
    return facts;
  }

  if (sourceType === 'market_listing') {
    const loc = locOf(data);
    put('city', geoName(store, 'cities', firstId(loc.city)));
    put('district', geoName(store, 'districts', firstId(loc.district)));
    const types = [asString(data.property_type), asString(data.listing_type), asString(data.category)].filter(Boolean);
    put('unit_types', types);
    put('price_range', scalarRange(data.price));
    put('area_range', scalarRange(data.area));
    put('bedroom_range', scalarRange(data.bedrooms));
    put('bathroom_range', scalarRange(data.bathrooms));
    put('available_units', data.is_active === true ? 1 : 0);
    put('image', asString(data.main_image_url));
    put('external_id', asString(data.external_id));
    put('quality_score', asFiniteNumber(data.quality_score));
    put('quality_grade', asString(data.quality_grade));
    return facts;
  }

  // unit — a single unit; geography comes from its parent project.
  const project = firstId(data.project_id);
  if (project) {
    const ap = modelByName(store.models, 'all_projects');
    const projRec = ap ? (store.records[ap.id] ?? []).find((r) => r.id === project) : undefined;
    if (projRec) {
      const loc = locOf(projRec.data as Record<string, unknown>);
      put('city', geoName(store, 'cities', firstId(loc.city)));
      put('district', geoName(store, 'districts', firstId(loc.district)));
    }
  }
  const unitType = asString(data.unit_type);
  put('unit_types', unitType ? [unitType] : undefined);
  put('price_range', scalarRange(data.total_price));
  put('area_range', scalarRange(data.unit_area));
  put('bedroom_range', scalarRange(data.bedrooms));
  put('bathroom_range', scalarRange(data.bathrooms));
  return facts;
}
