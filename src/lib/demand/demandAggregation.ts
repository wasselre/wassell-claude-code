/**
 * Shared, PURE demand-vs-supply aggregation (Phase 4).
 *
 * Single source of truth for "active client demand": the canonical Sales
 * `isActive()` resolver is the ONLY active-client definition — never
 * reimplemented here or in SQL (decision #1 + #5). The Command Center AND the
 * project Customer Demand tab both consume this module, so their numbers can
 * never disagree.
 *
 * Design invariants:
 *  - Active filter = `isActive()` applied to a resolved `ClientView`.
 *  - Demand is keyed by DISTRICT ID (from a client's `location.district` ids ∪
 *    each preferred project's district ids) so it lines up with the map's real
 *    district polygons and can't be confused by name collisions.
 *  - Supply uses the AVAILABLE-ONLY project rollups (`available_units`,
 *    `available_price_range`) — never all-unit or archived-listing data.
 *  - Every aggregate keeps the exact contributing client / project IDs, so any
 *    count or gap can drill into the real records behind it.
 *  - No store imports, no `import.meta`, no market_demand_supply_benchmarks — so
 *    this is testable and (if volume ever demands it) portable to a server
 *    function without reimplementing the rule.
 */
import type { AppRecord } from '@/types';
import type { ClientViewCtx } from '@/pages/Clients/lib/clientView';
import { resolveClientView } from '@/pages/Clients/lib/clientView';
import { isActive, EMPTY_RELATED } from '@/pages/Sales/lib/salesClients';
import { emptyFollowupSummary } from '@/pages/Sales/lib/myWork';

export interface NumRange { min: number | null; max: number | null }

/** One active client's demand atoms (traceable by clientId). */
export interface ClientDemand {
  clientId: string;
  name: string | null;
  stage: string | null;
  status: string | null;
  districtIds: string[];
  preferredProjectIds: string[];
  unitTypes: string[];
  budget: NumRange | null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function idArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}
function districtIdsOf(data: Record<string, unknown> | undefined): string[] {
  const loc = data?.location as Record<string, unknown> | undefined;
  return idArray(loc?.district);
}

/** The district ids a project belongs to (usually one). */
export function projectDistrictIds(project: AppRecord): string[] {
  return districtIdsOf(project.data as Record<string, unknown>);
}

/** Districts a client wants: own location.district ids ∪ each preferred
 *  project's district ids. */
function clientDistrictIds(data: Record<string, unknown>, projectsById: Map<string, AppRecord>): string[] {
  const set = new Set<string>(districtIdsOf(data));
  for (const pid of idArray(data.preferred_projects)) {
    const p = projectsById.get(pid);
    if (p) for (const did of districtIdsOf(p.data as Record<string, unknown>)) set.add(did);
  }
  return [...set];
}

/**
 * ACTIVE clients only, with their demand atoms. This is where the canonical
 * `isActive()` gate is applied — the single active-client definition.
 * `clients` MUST be the full set the caller is authorized to analyze (not a
 * paginated slice) — the caller ensures that before calling.
 */
export function buildActiveClientDemand(
  clients: AppRecord[],
  ctx: ClientViewCtx,
  allProjects: AppRecord[],
): ClientDemand[] {
  const projectsById = new Map(allProjects.map((p) => [p.id, p]));
  const out: ClientDemand[] = [];
  for (const rec of clients) {
    const view = resolveClientView(rec, ctx);
    if (!isActive({ view, code: null, related: EMPTY_RELATED, followup: emptyFollowupSummary() })) continue;
    const data = (rec.data ?? {}) as Record<string, unknown>;
    out.push({
      clientId: rec.id,
      name: view.name,
      stage: view.stage,
      status: view.status,
      districtIds: clientDistrictIds(data, projectsById),
      preferredProjectIds: idArray(data.preferred_projects),
      unitTypes: view.preferredUnitType,
      budget: view.budget,
    });
  }
  return out;
}

/** Active clients interested in ONE project — reused by the Customer Demand
 *  tab so it shares the exact active-client definition + atoms. */
export function clientsInterestedInProject(
  demand: ClientDemand[],
  projectId: string,
  projectDistricts: string[],
): { client: ClientDemand; reason: 'preferred' | 'district' }[] {
  const dset = new Set(projectDistricts);
  const out: { client: ClientDemand; reason: 'preferred' | 'district' }[] = [];
  for (const c of demand) {
    if (c.preferredProjectIds.includes(projectId)) out.push({ client: c, reason: 'preferred' });
    else if (c.districtIds.some((d) => dset.has(d))) out.push({ client: c, reason: 'district' });
  }
  return out;
}

// ── Supply ──────────────────────────────────────────────────────────────────

export interface DistrictSupply {
  districtId: string;
  projectIds: string[];
  portfolioProjectIds: string[];
  availableUnits: number;
  availableMin: number | null;
  availableMax: number | null;
}

function readRange(v: unknown): NumRange {
  const r = v as Record<string, unknown> | undefined;
  return { min: num(r?.min), max: num(r?.max) };
}

/** Per-district AVAILABLE supply, summed from the available-only rollups on
 *  each all_projects master. */
export function buildDistrictSupply(allProjects: AppRecord[], portfolioMasterIds: Set<string>): Map<string, DistrictSupply> {
  const map = new Map<string, DistrictSupply>();
  for (const p of allProjects) {
    const data = (p.data ?? {}) as Record<string, unknown>;
    const avail = num(data.available_units) ?? 0;
    const apr = readRange(data.available_price_range);
    for (const did of districtIdsOf(data)) {
      const s = map.get(did) ?? { districtId: did, projectIds: [], portfolioProjectIds: [], availableUnits: 0, availableMin: null, availableMax: null };
      s.projectIds.push(p.id);
      if (portfolioMasterIds.has(p.id)) s.portfolioProjectIds.push(p.id);
      s.availableUnits += avail;
      if (apr.min != null && apr.min > 0) s.availableMin = s.availableMin == null ? apr.min : Math.min(s.availableMin, apr.min);
      if (apr.max != null && apr.max > 0) s.availableMax = s.availableMax == null ? apr.max : Math.max(s.availableMax, apr.max);
      map.set(did, s);
    }
  }
  return map;
}

// ── Demand aggregation + gaps ────────────────────────────────────────────────

export interface DistrictDemand {
  districtId: string;
  clientIds: string[];
  count: number;
}

/** Distinct active clients wanting each district (client ids kept). */
export function aggregateDemandByDistrict(demand: ClientDemand[]): Map<string, DistrictDemand> {
  const map = new Map<string, DistrictDemand>();
  for (const c of demand) {
    for (const did of c.districtIds) {
      const d = map.get(did) ?? { districtId: did, clientIds: [], count: 0 };
      if (!d.clientIds.includes(c.clientId)) { d.clientIds.push(c.clientId); d.count += 1; }
      map.set(did, d);
    }
  }
  return map;
}

/** Deterministic "does the district have suitable available supply for this
 *  client": budget overlaps some available project's available_price_range, and
 *  (when the client asked for unit types) the project offers one. A client with
 *  no budget/type constraint is satisfied as long as the district has any
 *  available unit. */
function clientSatisfied(c: ClientDemand, districtProjects: AppRecord[]): boolean {
  const projs = districtProjects.filter((p) => (num((p.data as Record<string, unknown>)?.available_units) ?? 0) > 0);
  if (projs.length === 0) return false;
  const cMin = c.budget?.min ?? null, cMax = c.budget?.max ?? null;
  const noBudget = cMin == null && cMax == null;
  const noType = c.unitTypes.length === 0;
  if (noBudget && noType) return true;
  return projs.some((p) => {
    const data = p.data as Record<string, unknown>;
    const pr = readRange(data.available_price_range);
    const budgetOk = noBudget || ((cMax == null || pr.min == null || cMax >= pr.min) && (cMin == null || pr.max == null || cMin <= pr.max));
    const types = idArray(data.unit_types);
    const typeOk = noType || types.length === 0 || c.unitTypes.some((t) => types.includes(t));
    return budgetOk && typeOk;
  });
}

export interface OpportunityGap {
  districtId: string;
  demandCount: number;
  demandClientIds: string[];
  availableUnits: number;
  knownProjects: number;
  portfolioProjects: number;
  unsatisfiedClientIds: string[];
  severity: number;
}

/**
 * Per-district demand-vs-supply with the gap. `severity` = number of active
 * clients who want the district but find no suitable available supply — the
 * count that ranks a sourcing opportunity. Every list of ids is real records.
 */
export function computeOpportunityGaps(
  demand: ClientDemand[],
  allProjects: AppRecord[],
  portfolioMasterIds: Set<string>,
): OpportunityGap[] {
  const demandByDistrict = aggregateDemandByDistrict(demand);
  const supply = buildDistrictSupply(allProjects, portfolioMasterIds);
  const byId = new Map(demand.map((c) => [c.clientId, c]));
  const projectsByDistrict = new Map<string, AppRecord[]>();
  for (const p of allProjects) for (const did of projectDistrictIds(p)) {
    const arr = projectsByDistrict.get(did) ?? []; arr.push(p); projectsByDistrict.set(did, arr);
  }

  const out: OpportunityGap[] = [];
  for (const [did, dd] of demandByDistrict) {
    const s = supply.get(did);
    const districtProjects = projectsByDistrict.get(did) ?? [];
    const unsatisfied = dd.clientIds.filter((cid) => {
      const c = byId.get(cid);
      return c ? !clientSatisfied(c, districtProjects) : false;
    });
    out.push({
      districtId: did,
      demandCount: dd.count,
      demandClientIds: dd.clientIds,
      availableUnits: s?.availableUnits ?? 0,
      knownProjects: s?.projectIds.length ?? 0,
      portfolioProjects: s?.portfolioProjectIds.length ?? 0,
      unsatisfiedClientIds: unsatisfied,
      severity: unsatisfied.length,
    });
  }
  // Most-unmet-demand first.
  out.sort((a, b) => b.severity - a.severity || b.demandCount - a.demandCount);
  return out;
}
