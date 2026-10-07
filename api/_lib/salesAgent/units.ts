/**
 * Unit search inside ONE project, for the sales agent.
 *
 * The agent already finds projects (catalog.ts). Once a customer is looking at
 * a project they ask about its units — «وش المتاح 3 غرف؟», «ابي دور أرضي»,
 * «أرخص وحدة» — and this answers from the real inventory: AVAILABLE units only
 * (the same set the customer's units page shows), filtered by what they said,
 * cheapest first, with facets so the agent can say what exists when nothing
 * matches. Nothing here invents a number; every figure is a stored field.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAvailableUnits, summarizeUnit, type UnitSummary } from '../trackedLinks.js';
import { normalizeUnitType } from './decide.js';
import { componentsOf, resolveFeatures } from './features.js';
import { amenityAnswers, amenityLabels, splitAmenities } from './amenities.js';

export interface UnitCriteria {
  unit_type?: string;
  /** Exact bedroom count the customer asked for. */
  bedrooms?: number;
  budget_max?: number;
  area_min?: number;
  /** Floor as the customer said it («أرضي», «أول», «روف», «4»). */
  floor?: string;
  /** «فوق الدور 5» → floor_min 6; «الأدوار العليا». Ground = 0, roof = top. */
  floor_min?: number;
  floor_max?: number;
  /** «مو أرضي» → ['ارضي']. */
  exclude_floors?: string[];
  /** Features in the customer's words («غرفة خادمة», «روف», «مصعد»). */
  features?: string[];
}

export interface UnitSearch {
  project_id: string;
  total_available: number;
  /** How many available units match every criterion given. */
  matched: number;
  /** Ids of ALL matching units (for a list link), cheapest first. */
  matchedIds: string[];
  /** The cheapest few, for the agent to quote. */
  units: UnitSummary[];
  /** Features asked: stored components matched, and words we don't record
   *  (only the floor plan can answer those — check_unit_plans). */
  features?: { matched: string[]; unknown: string[]; units_without_component_data: number };
  /** PROJECT amenities asked (pool, gym...): true = the project lists it, false =
   *  it lists its amenities and not this, null = none recorded. Not a unit filter. */
  project_amenities?: { asked: Record<string, boolean | null>; listed: string[] | null };
  /** What the project actually has, across ALL its available units. */
  facets: {
    bedrooms: Record<string, number>;
    types: Record<string, number>;
    floors: Record<string, number>;
    price_min: number | null;
    price_max: number | null;
    area_min: number | null;
    area_max: number | null;
    /** The 15 most common recorded components (folded) → unit count. */
    components?: Record<string, number>;
  };
}

const TOP = 6;

const FLOOR_ALIASES: Array<[RegExp, string]> = [
  [/ground|ارضي|أرضي|الارضي|الأرضي/i, 'ارضي'],
  [/roof|روف|سطح/i, 'روف'],
  [/^(first|1st|اول|أول|الاول|الأول)$/i, 'اول'],
  [/^(second|2nd|ثاني|الثاني)$/i, 'ثاني'],
  [/^(third|3rd|ثالث|الثالث)$/i, 'ثالث'],
];

/** One spelling per floor, so «الأرضي», «ارضي» and "ground" all match. */
export function normalizeFloor(raw: string | null | undefined): string {
  const t = String(raw ?? '').trim().toLowerCase().replace(/^(ال)?دور\s+/, '').replace(/\s+/g, ' ');
  if (!t) return '';
  for (const [re, v] of FLOOR_ALIASES) if (re.test(t)) return v;
  return t.replace(/^ال/, '');
}

function tally(values: Array<string | number | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    if (v === null || v === '') continue;
    const k = String(v);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Floor → a number for ranges: ground 0, first 1 …, roof above everything. */
export function floorNumber(raw: string | null | undefined): number | null {
  const f = normalizeFloor(raw);
  if (!f) return null;
  if (f === 'ارضي') return 0;
  if (f === 'اول') return 1;
  if (f === 'ثاني') return 2;
  if (f === 'ثالث') return 3;
  if (f === 'روف') return 1000;
  const n = parseInt(f.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))), 10);
  return Number.isFinite(n) ? n : null;
}

export async function searchUnits(svc: SupabaseClient, projectId: string, c: UnitCriteria): Promise<UnitSearch> {
  const rows = await loadAvailableUnits(svc, projectId);
  const comps = new Map(rows.map((r) => [r.id, componentsOf(r.data?.unit_components)]));
  const all = rows.map(summarizeUnit);
  const wantType = c.unit_type ? (normalizeUnitType(c.unit_type) ?? c.unit_type.trim()) : null;
  const wantFloor = c.floor ? normalizeFloor(c.floor) : null;
  const notFloors = new Set((c.exclude_floors ?? []).map(normalizeFloor).filter(Boolean));
  const feats0 = resolveFeatures(c.features);
  const amen = splitAmenities(feats0.unknown);
  const feats = { known: feats0.known, unknown: amen.unknown };
  let projectAmenities: UnitSearch['project_amenities'];
  if (amen.asks.length) {
    const { data: p, error: pErr } = await svc.from('records').select('data').eq('id', projectId).maybeSingle();
    if (pErr) throw new Error(`units: project read failed: ${pErr.message}`);
    const d = ((p as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
    projectAmenities = { asked: amenityAnswers(d, amen.asks), listed: amenityLabels(d) };
  }

  const matched = all
    .filter((u) => {
      if (wantType && (normalizeUnitType(u.type ?? '') ?? (u.type ?? '').trim()) !== wantType) return false;
      if (c.bedrooms !== undefined && u.bedrooms !== c.bedrooms) return false;
      // A unit with no price cannot be shown as fitting a budget.
      if (c.budget_max !== undefined && (u.price === null || u.price > c.budget_max)) return false;
      if (c.area_min !== undefined && (u.area === null || u.area < c.area_min)) return false;
      if (wantFloor && normalizeFloor(u.floor) !== wantFloor) return false;
      if (notFloors.size && notFloors.has(normalizeFloor(u.floor))) return false;
      if (c.floor_min !== undefined || c.floor_max !== undefined) {
        const n = floorNumber(u.floor);
        if (n === null) return false;
        if (c.floor_min !== undefined && n < c.floor_min) return false;
        if (c.floor_max !== undefined && n > c.floor_max) return false;
      }
      // A unit with no recorded components cannot be shown as having a feature.
      if (feats.known.length) {
        const have = comps.get(u.id) ?? [];
        if (!feats.known.every((k) => have.includes(k))) return false;
      }
      return true;
    })
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  const compTally: Record<string, number> = {};
  for (const list of comps.values()) for (const k of list) compTally[k] = (compTally[k] ?? 0) + 1;
  const topComponents = Object.fromEntries(Object.entries(compTally).sort((a, b) => b[1] - a[1]).slice(0, 15));
  const prices = all.map((u) => u.price).filter((p): p is number => p !== null);
  const areas = all.map((u) => u.area).filter((a): a is number => a !== null);
  return {
    project_id: projectId,
    total_available: all.length,
    matched: matched.length,
    matchedIds: matched.map((u) => u.id),
    units: matched.slice(0, TOP),
    ...(c.features?.length ? { features: {
      matched: feats.known, unknown: feats.unknown,
      units_without_component_data: [...comps.values()].filter((l) => l.length === 0).length,
    } } : {}),
    ...(projectAmenities ? { project_amenities: projectAmenities } : {}),
    facets: {
      bedrooms: tally(all.map((u) => u.bedrooms)),
      types: tally(all.map((u) => u.type)),
      floors: tally(all.map((u) => (u.floor ? normalizeFloor(u.floor) : null))),
      price_min: prices.length ? Math.min(...prices) : null,
      price_max: prices.length ? Math.max(...prices) : null,
      area_min: areas.length ? Math.round(Math.min(...areas)) : null,
      area_max: areas.length ? Math.round(Math.max(...areas)) : null,
      components: topComponents,
    },
  };
}

/** What the model sees: whole-metre areas (the voice rule), no internal ids
 *  beyond the unit_id it needs to send. */
export function unitSearchView(r: UnitSearch): Record<string, unknown> {
  return {
    project_id: r.project_id,
    total_available: r.total_available,
    matched: r.matched,
    showing: r.units.length,
    ...(r.features ? { features: r.features } : {}),
    ...(r.project_amenities ? { project_amenities: r.project_amenities } : {}),
    units: r.units.map((u) => ({
      unit_id: u.id, code: u.code, type: u.type, bedrooms: u.bedrooms, bathrooms: u.bathrooms,
      area_m2: u.area === null ? null : Math.round(u.area), price: u.price, floor: u.floor,
    })),
    facets: r.facets,
  };
}
