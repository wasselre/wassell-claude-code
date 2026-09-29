/**
 * The sales agent's CATALOG: what the brain (brain.ts) sees when it searches our
 * projects or asks about one. Everything here is read from live data — the brain
 * may only quote a number that one of these results returned (guard.ts checks).
 *
 *  · searchProjects — the Project Finder over OUR projects, then each candidate
 *    checked against its OWN data (projectFits: listed unit type, bedroom range,
 *    AVAILABLE price, never sold out). Returns ALL fits (ranked by the Finder),
 *    the top few with customer-facing facts, and FACETS — how the set splits by
 *    district / ready-vs-off-plan / price band — so the brain can ask the one
 *    question that narrows a big set instead of sending the first match.
 *  · projectFacts — one project's selling facts: available units per bedroom
 *    count with price and area ranges, payment plan, handover, district.
 *
 * Customer-facing prices are the AVAILABLE family only (CLAUDE.md, project
 * rollups): a sold-out project shows no price, never a stale one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { findMatchingProjects, FINDER_GROUP_KEYS, type FinderMatch } from '../projectFinder.js';
import type { MatchRequirements } from '../matchAgent.js';
import { normalizeUnitType } from './decide.js';
import { num, projectFits, range, type FitCheck, type Master } from './search.js';
import type { Zone } from './texts.js';
import { clip } from './clip.js';

export type Readiness = 'ready' | 'off_plan';

export interface SearchCriteria {
  city?: string | null;
  zone?: Zone | null;
  /** District names exactly as a previous search's facets listed them. */
  districts?: string[];
  unit_types?: string[];
  bedrooms_min?: number | null;
  budget_max?: number | null;
  /** Minimum unit size in m². */
  area_min?: number | null;
  readiness?: Readiness | null;
}

export interface CatalogProject {
  project_id: string;
  name: string;
  district: string | null;
  in_requested_area: boolean;
  readiness: Readiness | null;
  handover_date: string | null;
  unit_types: string[];
  bedrooms: { min: number | null; max: number | null } | null;
  /** AVAILABLE units only. null = none available / unknown. */
  price_from: number | null;
  price_to: number | null;
  available_units: number | null;
  down_payment_percent: number | null;
  payment_plan: string | null;
}

export interface PriceBand { from: number | null; to: number | null; count: number }

export interface CatalogSearch {
  criteria: SearchCriteria;
  /** How many of OUR projects fit, after every filter. */
  total: number;
  /** What had to be widened to find anything: null = exact. */
  relaxed: null | 'unit_type' | 'specs_and_budget' | 'budget' | 'area';
  /** The best few (Finder order), with selling facts. */
  projects: CatalogProject[];
  /** How the WHOLE fitting set splits — the brain narrows on these. */
  facets: {
    districts: Record<string, number>;
    readiness: { ready: number; off_plan: number; unknown: number };
    price_bands: PriceBand[];
    unit_types: Record<string, number>;
    /** Riyadh-wide search (no zone asked): how many fit per region — the
     *  overview for a general «وش عندكم مشاريع؟». Absent when a zone was asked. */
    zones?: Record<string, number>;
  };
  /** Projects already sent in this chat that also fit (not repeated in `projects`). */
  already_sent: string[];
}

const TOP = 6;

/** Ready vs off-plan from the project's own status fields. */
export function readinessOf(d: Record<string, unknown>): Readiness | null {
  const cs = String(d.construction_status ?? '').trim().toLowerCase();
  const ps = String(d.project_status ?? '').trim().toLowerCase();
  if (cs === 'ready' || cs === 'جاهز' || ps === 'available' || ps === 'ready') return 'ready';
  if (cs || ps) return 'off_plan';
  return null;
}

function unitTypesOf(d: Record<string, unknown>): string[] {
  const raw = Array.isArray(d.unit_types) ? d.unit_types : [];
  const out = new Set<string>();
  for (const x of raw) if (typeof x === 'string') { const t = normalizeUnitType(x); if (t) out.add(t); }
  return [...out];
}

function toProject(master: Master, m: FinderMatch, inArea: boolean): CatalogProject {
  const d = master.data;
  const price = range(d.available_price_range);
  const beds = range(d.bedroom_range);
  const district = typeof m.facts?.district === 'string' && m.facts.district.trim() ? m.facts.district.trim() : null;
  const plan = typeof d.payment_plan_summary === 'string' && d.payment_plan_summary.trim() ? clip(d.payment_plan_summary.trim(), 200) : null;
  const handover = typeof d.handover_date === 'string' && d.handover_date ? d.handover_date.slice(0, 10) : null;
  return {
    project_id: master.id,
    name: typeof d.project_name === 'string' && d.project_name.trim() ? d.project_name.trim() : m.project_name,
    district,
    in_requested_area: inArea,
    readiness: readinessOf(d),
    handover_date: handover,
    unit_types: unitTypesOf(d),
    bedrooms: beds.min === null && beds.max === null ? null : beds,
    price_from: price.min,
    price_to: price.max,
    available_units: num(d.available_units),
    down_payment_percent: num(d.down_payment_percent),
    payment_plan: plan,
  };
}

/** Customer-meaningful price bands over the fits' starting prices. */
export function priceBands(prices: Array<number | null>): PriceBand[] {
  const edges = [0, 800_000, 1_200_000, 1_600_000, 2_500_000, Infinity];
  const bands: PriceBand[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]!; const hi = edges[i + 1]!;
    const count = prices.filter((p) => p !== null && p >= lo && p < hi).length;
    if (count) bands.push({ from: lo || null, to: Number.isFinite(hi) ? hi : null, count });
  }
  const unknown = prices.filter((p) => p === null).length;
  if (unknown) bands.push({ from: null, to: null, count: unknown });
  return bands;
}

function facetsOf(ps: CatalogProject[]): CatalogSearch['facets'] {
  const districts: Record<string, number> = {};
  const unit_types: Record<string, number> = {};
  const readiness = { ready: 0, off_plan: 0, unknown: 0 };
  for (const p of ps) {
    const k = p.district ?? 'غير محدد';
    districts[k] = (districts[k] ?? 0) + 1;
    for (const t of p.unit_types) unit_types[t] = (unit_types[t] ?? 0) + 1;
    if (p.readiness) readiness[p.readiness] += 1; else readiness.unknown += 1;
  }
  return { districts, readiness, unit_types, price_bands: priceBands(ps.map((p) => p.price_from)) };
}

async function zoneDistricts(svc: SupabaseClient, city: string, zone: Zone): Promise<Array<{ district_id: string; district_name: string }>> {
  const { data, error } = await svc.rpc('wassell_city_zone_districts', { p_city: city, p_zone: zone });
  if (error) throw new Error(`catalog: zone → districts failed: ${error.message}`);
  return (data ?? []) as Array<{ district_id: string; district_name: string }>;
}

const ZONE_LIST: Zone[] = ['north', 'south', 'east', 'west', 'center'];
const zoneNameCache = new Map<string, { at: number; value: Promise<Set<string>> }>();

async function zoneNames(svc: SupabaseClient, city: string, zone: Zone): Promise<Set<string>> {
  const key = `${city}|${zone}`;
  const hit = zoneNameCache.get(key);
  if (hit && Date.now() - hit.at < UNIVERSE_TTL_MS) return hit.value;
  const value = zoneDistricts(svc, city, zone).then((rows) => new Set(rows.map((r) => districtKey(r.district_name))));
  zoneNameCache.set(key, { at: Date.now(), value });
  value.catch(() => zoneNameCache.delete(key));
  return value;
}

/** Count fitting projects per Riyadh region by their own district. */
async function zoneFacet(svc: SupabaseClient, city: string, ps: CatalogProject[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const sets = await Promise.all(ZONE_LIST.map((z) => zoneNames(svc, city, z)));
  for (const p of ps) {
    const d = p.district ? districtKey(p.district) : '';
    const i = d ? sets.findIndex((s) => s.has(d)) : -1;
    const k = i >= 0 ? ZONE_LIST[i]! : 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** «حي النرجس» and «النرجس» are the same district. */
export function districtKey(s: string): string {
  return s.replace(/^\s*حي\s+/, '').replace(/\s+/g, ' ').trim();
}

interface Resolved { master: Master; m: FinderMatch; inArea: boolean }
interface Universe { items: Resolved[]; zoneNames: Set<string> | null }

// The candidate universe depends only on (city, zone): every later filter is
// applied in memory. A brain turn searches several times in one area, so cache
// it briefly per process — the Finder + master reads are the slow part (~12 s).
const UNIVERSE_TTL_MS = 5 * 60_000;
const universeCache = new Map<string, { at: number; value: Promise<Universe> }>();

async function candidateUniverse(svc: SupabaseClient, city: string, zone: Zone | null): Promise<Universe> {
  const key = `${city}|${zone ?? ''}`;
  const hit = universeCache.get(key);
  if (hit && Date.now() - hit.at < UNIVERSE_TTL_MS) return hit.value;
  const value = buildUniverse(svc, city, zone);
  universeCache.set(key, { at: Date.now(), value });
  // A failed build must not be served from the cache.
  value.catch(() => universeCache.delete(key));
  return value;
}

async function buildUniverse(svc: SupabaseClient, city: string, zone: Zone | null): Promise<Universe> {
  const base: MatchRequirements = { city };
  let zoneNames: Set<string> | null = null;
  if (zone) {
    const rows = await zoneDistricts(svc, city, zone);
    if (rows.length) {
      base.zone = zone;
      base.district_ids = rows.map((r) => r.district_id).filter(Boolean);
      base.districts = rows.map((r) => r.district_name).filter(Boolean);
      if (base.districts.length) base.district = base.districts[0];
      zoneNames = new Set(base.districts.map(districtKey));
    }
  }

  // ONE Finder run (unlimited per group) — the candidate universe in Finder order.
  // Our projects are matched loosely, so type/bedroom/budget are enforced later
  // from each project's own data, not trusted from the group it landed in.
  const out = await findMatchingProjects(svc, { ...base }, { perGroup: 0, sources: ['our_projects'], locale: 'ar' });
  if (!out.ok) throw new Error(`catalog: finder failed: ${out.error}`);
  const ordered: FinderMatch[] = [];
  const groupOf = new Map<FinderMatch, string>();
  for (const g of FINDER_GROUP_KEYS) for (const m of out.result.groups[g] ?? []) { ordered.push(m); groupOf.set(m, g); }

  const masters = await resolveMasters(svc, ordered.map((m) => m.project_id));
  const items: Resolved[] = [];
  const seen = new Set<string>();
  for (const m of ordered) {
    const master = masters.get(m.project_id);
    if (!master || seen.has(master.id)) continue;
    seen.add(master.id);
    // "In the requested area" = the project's OWN district is one of the zone's
    // districts. The Finder's "nearby" group crosses region lines (an east search
    // returned النرجس), so it is not trusted for this; the exact group is the
    // fallback only when the project has no district on record.
    const d = typeof m.facts?.district === 'string' ? districtKey(m.facts.district) : '';
    const inArea = zoneNames === null ? true : d ? zoneNames.has(d) : groupOf.get(m) === 'exact_district_matches';
    items.push({ master, m, inArea });
  }
  return { items, zoneNames };
}

/** Finder ids → all_projects master rows in two batched reads (was one read per
 *  candidate). For source 'our_projects' the engine may hand back either the
 *  our_projects record (whose `project` links the master) or the master itself. */
async function resolveMasters(svc: SupabaseClient, ids: string[]): Promise<Map<string, Master>> {
  const { data: models, error } = await svc.from('models').select('id, name').in('name', ['all_projects', 'our_projects']);
  if (error) throw new Error(`catalog: models lookup failed: ${error.message}`);
  const apId = (models ?? []).find((m) => m.name === 'all_projects')?.id as string | undefined;
  const opId = (models ?? []).find((m) => m.name === 'our_projects')?.id as string | undefined;
  const read = async (keys: string[]) => {
    const rows: Array<{ id: string; model_id: string; data: Record<string, unknown> }> = [];
    for (let i = 0; i < keys.length; i += 150) {
      const { data, error: rErr } = await svc.from('records').select('id, model_id, data').in('id', keys.slice(i, i + 150));
      if (rErr) throw new Error(`catalog: project read failed: ${rErr.message}`);
      rows.push(...((data ?? []) as typeof rows));
    }
    return rows;
  };
  const unique = [...new Set(ids)];
  const first = await read(unique);
  const out = new Map<string, Master>();
  const linkOf = new Map<string, string>();
  for (const r of first) {
    if (apId && r.model_id === apId) out.set(r.id, { id: r.id, data: r.data ?? {} });
    else if (opId && r.model_id === opId) {
      const link = r.data?.project;
      const mid = typeof link === 'string' ? link : Array.isArray(link) && typeof link[0] === 'string' ? link[0] : null;
      if (mid) linkOf.set(r.id, mid);
    }
  }
  const need = [...new Set([...linkOf.values()].filter((id) => !out.has(id)))];
  const second = need.length ? await read(need) : [];
  const byId = new Map(second.filter((r) => apId && r.model_id === apId).map((r) => [r.id, { id: r.id, data: r.data ?? {} } as Master]));
  for (const [opRecord, mid] of linkOf) {
    const master = out.get(mid) ?? byId.get(mid);
    if (master) out.set(opRecord, master);
  }
  return out;
}

/**
 * Search OUR projects for the criteria. `exclude` = projects that must never be
 * offered (the ad's project the lead passed on). `sent` = projects already sent
 * in this chat: counted in the total/facets (the customer's options) but listed
 * separately so the brain doesn't send them twice.
 */
export async function searchProjects(
  svc: SupabaseClient,
  criteria: SearchCriteria,
  opts: { exclude?: string[]; sent?: string[] } = {},
): Promise<CatalogSearch> {
  const city = (criteria.city ?? '').trim() || 'الرياض';
  const types = (criteria.unit_types ?? []).map(normalizeUnitType).filter((x): x is string => !!x);
  const wantDistricts = new Set((criteria.districts ?? []).map(districtKey).filter(Boolean));

  const universe = await candidateUniverse(svc, city, criteria.zone ?? null);
  const zoneKnown = universe.zoneNames !== null;
  const excluded = new Set(opts.exclude ?? []);
  const sentSet = new Set(opts.sent ?? []);
  const resolved = universe.items.filter((r) => !excluded.has(r.master.id));

  const pick = (check: FitCheck, areaOnly: boolean): Array<{ master: Master; m: FinderMatch; inArea: boolean }> =>
    resolved.filter((r) => (!areaOnly || r.inArea)
      && projectFits(r.master.data, check)
      && (!criteria.readiness || readinessOf(r.master.data) === criteria.readiness)
      && (!wantDistricts.size || (typeof r.m.facts?.district === 'string' && wantDistricts.has(districtKey(r.m.facts.district)))));

  const beds = criteria.bedrooms_min ?? null;
  const budget = criteria.budget_max ?? null;
  const areaMin = criteria.area_min ?? null;
  const fit = (o: Partial<FitCheck>): FitCheck => ({ types, strictType: false, checkType: true, bedroomsMin: beds, budgetMax: budget, requireKnownPrice: true, areaMin, ...o });

  // Ladder: exact (type listed) → type unrecorded → any type → widened specs →
  // outside the requested area. Each rung only if the previous found nothing.
  const ladder: Array<{ check: FitCheck; areaOnly: boolean; relaxed: CatalogSearch['relaxed'] }> = [
    { check: fit({ strictType: true }), areaOnly: true, relaxed: null },
    { check: fit({}), areaOnly: true, relaxed: null },
  ];
  if (types.length) ladder.push({ check: fit({ checkType: false }), areaOnly: true, relaxed: 'unit_type' });
  if (beds || budget || areaMin) {
    ladder.push({
      check: fit({ checkType: false, bedroomsMin: null, areaMin: null, budgetMax: budget ? Math.round(budget * 1.15) : null }),
      areaOnly: true, relaxed: 'specs_and_budget',
    });
  }
  // Nothing within the budget → what we DO have, above it (said honestly —
  // live test: a 500k villa ask got a villa of unknown price).
  if (budget) ladder.push({ check: fit({ budgetMax: null }), areaOnly: true, relaxed: 'budget' });
  if (zoneKnown) ladder.push({ check: fit({}), areaOnly: false, relaxed: 'area' });

  let fits: Array<{ master: Master; m: FinderMatch; inArea: boolean }> = [];
  let relaxed: CatalogSearch['relaxed'] = null;
  for (const rung of ladder) {
    fits = pick(rung.check, rung.areaOnly);
    if (fits.length) { relaxed = rung.relaxed; break; }
  }

  const all = fits.map((f) => toProject(f.master, f.m, f.inArea));
  const fresh = all.filter((p) => !sentSet.has(p.project_id));
  const facets = facetsOf(all);
  if (!criteria.zone && /رياض|riyadh/i.test(city)) facets.zones = await zoneFacet(svc, city, all);
  return {
    criteria: { ...criteria, city, unit_types: types },
    total: all.length,
    relaxed,
    projects: fresh.slice(0, TOP),
    facets,
    already_sent: all.filter((p) => sentSet.has(p.project_id)).map((p) => p.name),
  };
}

export interface ProjectFacts {
  project_id: string;
  name: string;
  district: string | null;
  city: string | null;
  readiness: Readiness | null;
  handover_date: string | null;
  unit_types: string[];
  available_units: number | null;
  price_from: number | null;
  price_to: number | null;
  /** Available units grouped by bedroom count. */
  by_bedrooms: Array<{ bedrooms: number | null; units: number; price_from: number | null; price_to: number | null; area_from: number | null; area_to: number | null }>;
  down_payment_percent: number | null;
  during_construction_percent: number | null;
  on_handover_percent: number | null;
  payment_plan: string | null;
}

const AVAILABLE = new Set(['available', 'متاح', 'متاحة', 'متوفر', 'متوفرة']);

/** One project's selling facts. Throws on a read error — never an empty answer. */
export async function projectFacts(svc: SupabaseClient, projectId: string): Promise<ProjectFacts | null> {
  const { data: row, error } = await svc.from('records').select('id, data').eq('id', projectId).maybeSingle();
  if (error) throw new Error(`catalog: project read failed: ${error.message}`);
  if (!row) return null;
  const d = ((row as { data: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;

  const { data: unitModel, error: mErr } = await svc.from('models').select('id').eq('name', 'units').maybeSingle();
  if (mErr) throw new Error(`catalog: units model lookup failed: ${mErr.message}`);

  // Page every unit — a project can have hundreds; never cut silently.
  const units: Array<Record<string, unknown>> = [];
  if (unitModel?.id) {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: uErr } = await svc
        .from('records').select('id, data')
        .eq('model_id', unitModel.id as string).eq('data->>project_id', projectId)
        .order('id').range(from, from + PAGE - 1);
      if (uErr) throw new Error(`catalog: units read failed: ${uErr.message}`);
      for (const u of page ?? []) units.push(((u as { data: Record<string, unknown> }).data ?? {}) as Record<string, unknown>);
      if (!page || page.length < PAGE) break;
    }
  }

  const groups = new Map<string, { bedrooms: number | null; prices: number[]; areas: number[]; units: number }>();
  for (const u of units) {
    if (!AVAILABLE.has(String(u.unit_status ?? '').trim().toLowerCase())) continue;
    const b = num(u.bedrooms);
    const key = b === null ? '?' : String(b);
    const g = groups.get(key) ?? { bedrooms: b, prices: [], areas: [], units: 0 };
    g.units += 1;
    const p = num(u.total_price); if (p !== null && p > 0) g.prices.push(p);
    const a = num(u.unit_area); if (a !== null && a > 0) g.areas.push(a);
    groups.set(key, g);
  }
  const mm = (xs: number[]) => (xs.length ? { from: Math.min(...xs), to: Math.max(...xs) } : { from: null, to: null });
  const by_bedrooms = [...groups.values()]
    .sort((x, y) => (x.bedrooms ?? 99) - (y.bedrooms ?? 99))
    .map((g) => { const p = mm(g.prices); const a = mm(g.areas); return { bedrooms: g.bedrooms, units: g.units, price_from: p.from, price_to: p.to, area_from: a.from, area_to: a.to }; });

  const price = range(d.available_price_range);
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // `location` holds geography IDS ({region, city, district}); names come from the
  // districts table. A missing row just means no district line — never a guess.
  const loc = d.location && typeof d.location === 'object' ? (d.location as Record<string, unknown>) : {};
  let district: string | null = null;
  let city: string | null = null;
  const districtId = text(loc.district);
  if (districtId) {
    const { data: dist, error: dErr } = await svc
      .from('districts').select('display_name, name_ar, city_name_ar').eq('id', districtId).maybeSingle();
    if (dErr) console.error('[catalog] district name lookup failed:', dErr.message);
    const dd = dist as { display_name?: string | null; name_ar?: string | null; city_name_ar?: string | null } | null;
    district = text(dd?.display_name) ?? text(dd?.name_ar) ?? null;
    city = text(dd?.city_name_ar) ?? null;
  }
  return {
    project_id: projectId,
    name: text(d.project_name) ?? '',
    district,
    city,
    readiness: readinessOf(d),
    handover_date: text(d.handover_date)?.slice(0, 10) ?? null,
    unit_types: unitTypesOf(d),
    available_units: num(d.available_units),
    price_from: price.min,
    price_to: price.max,
    by_bedrooms,
    down_payment_percent: num(d.down_payment_percent),
    during_construction_percent: num(d.during_construction_percent),
    on_handover_percent: num(d.on_handover_percent),
    payment_plan: (() => { const p = text(d.payment_plan_summary); return p ? clip(p, 300) : null; })(),
  };
}
