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

export interface UnitCriteria {
  unit_type?: string;
  /** Exact bedroom count the customer asked for. */
  bedrooms?: number;
  budget_max?: number;
  area_min?: number;
  /** Floor as the customer said it («أرضي», «أول», «روف», «4»). */
  floor?: string;
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
  /** What the project actually has, across ALL its available units. */
  facets: {
    bedrooms: Record<string, number>;
    types: Record<string, number>;
    floors: Record<string, number>;
    price_min: number | null;
    price_max: number | null;
    area_min: number | null;
    area_max: number | null;
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

export async function searchUnits(svc: SupabaseClient, projectId: string, c: UnitCriteria): Promise<UnitSearch> {
  const all = (await loadAvailableUnits(svc, projectId)).map(summarizeUnit);
  const wantType = c.unit_type ? (normalizeUnitType(c.unit_type) ?? c.unit_type.trim()) : null;
  const wantFloor = c.floor ? normalizeFloor(c.floor) : null;

  const matched = all
    .filter((u) => {
      if (wantType && (normalizeUnitType(u.type ?? '') ?? (u.type ?? '').trim()) !== wantType) return false;
      if (c.bedrooms !== undefined && u.bedrooms !== c.bedrooms) return false;
      // A unit with no price cannot be shown as fitting a budget.
      if (c.budget_max !== undefined && (u.price === null || u.price > c.budget_max)) return false;
      if (c.area_min !== undefined && (u.area === null || u.area < c.area_min)) return false;
      if (wantFloor && normalizeFloor(u.floor) !== wantFloor) return false;
      return true;
    })
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  const prices = all.map((u) => u.price).filter((p): p is number => p !== null);
  const areas = all.map((u) => u.area).filter((a): a is number => a !== null);
  return {
    project_id: projectId,
    total_available: all.length,
    matched: matched.length,
    matchedIds: matched.map((u) => u.id),
    units: matched.slice(0, TOP),
    facets: {
      bedrooms: tally(all.map((u) => u.bedrooms)),
      types: tally(all.map((u) => u.type)),
      floors: tally(all.map((u) => (u.floor ? normalizeFloor(u.floor) : null))),
      price_min: prices.length ? Math.min(...prices) : null,
      price_max: prices.length ? Math.max(...prices) : null,
      area_min: areas.length ? Math.round(Math.min(...areas)) : null,
      area_max: areas.length ? Math.round(Math.max(...areas)) : null,
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
    units: r.units.map((u) => ({
      unit_id: u.id, code: u.code, type: u.type, bedrooms: u.bedrooms, bathrooms: u.bathrooms,
      area_m2: u.area === null ? null : Math.round(u.area), price: u.price, floor: u.floor,
    })),
    facets: r.facets,
  };
}
