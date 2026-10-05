/** Pure validation of a fresh portal capture against the developer's entire
 *  CRM inventory. A proposal is returned for inspection; nothing is written. */
import { SQFT_TO_SQM, type BinghattiItem, type BinghattiSnapshot, type BinghattiUnitTypeMap } from './binghatti.js';
import { mapUnitType, num } from './reconcile.js';
import type { CrmUnit } from './types.js';

export interface BinghattiMappingProvenance { captured_at: string; source: string }
export interface BinghattiRegisteredMapping {
  project: string;
  source_project_ids: readonly string[];
  /** Required to keep an old id whose project is absent from today's list. */
  mapping_provenance?: BinghattiMappingProvenance;
}
export interface BinghattiHistoricalMapping extends BinghattiMappingProvenance {
  projects: ReadonlyArray<{ portal_project_id: string; crm_project_id: string }>;
}
export interface BinghattiMappingConflict {
  kind: 'multiple_crm_projects' | 'duplicate_registration' | 'registered_project_changed'
    | 'new_unregistered_phase' | 'unverified_missing_id' | 'unverified_present_id' | 'historical_mapping_conflict';
  portalProjectId: string;
  projectIds: string[];
}
export interface BinghattiAreaEvidence {
  verdict: 'verified' | 'insufficient' | 'ambiguous' | 'conflicting';
  samples: number;
  candidates: Array<{ basis: 'net' | 'total'; unit: 'sqft' | 'sqm'; matchingSamples: number }>;
  verified?: { basis: 'net' | 'total'; unit: 'sqft' | 'sqm' };
}
export interface BinghattiMappingResult {
  held: boolean;
  conflicts: BinghattiMappingConflict[];
  groups: Array<{ projectId: string; portalProjectIds: string[]; joinedUnits: number; retainedPortalIds: string[]; areaEvidence: BinghattiAreaEvidence }>;
  unknownPortalIds: string[];
  unregisteredCrmProjectIds: string[];
  unitTypeMap: BinghattiUnitTypeMap;
  typeConflicts: Array<{ typeId: string; bucket: 'zero' | 'other'; types: string[] }>;
  areaEvidence: BinghattiAreaEvidence;
  /** Codes never used as evidence because either side repeated them. */
  ambiguousCodes: string[];
}

/** Inspected from the genuine imported BWRT rows, not inferred from names:
 *  603.75 sqft -> 56.09 sqm; 603.86 sqft -> 56.10 sqm. The portal total areas
 *  are different. A registry edit cannot silently change this convention. */
export const BINGHATTI_HISTORICAL_AREA_BASELINE = Object.freeze({
  basis: 'net' as const,
  unit: 'sqft' as const,
  squareFeetToSquareMetres: SQFT_TO_SQM,
  source: 'worker/src/projectUpdates/fixtures/binghatti-crm-units.json; imported availability_2026-07-30.xlsx',
  inspected_at: '2026-10-05T08:38:42.578Z',
  crmUnitCodes: ['BWRT-208', 'BWRT-645'] as const,
});

export interface BinghattiAreaRegistryRow {
  id?: string;
  project: string;
  binghatti_area_basis?: unknown;
  binghatti_area_unit?: unknown;
}
export interface BinghattiAreaConventionValidation {
  complete: boolean;
  reasons: string[];
  baseline: typeof BINGHATTI_HISTORICAL_AREA_BASELINE;
  evidence: {
    global: BinghattiAreaEvidence;
    projects: Array<{
      projectId: string;
      registryId: string | null;
      configured: { basis: unknown; unit: unknown };
      areaEvidence: BinghattiAreaEvidence | null;
      usesHistoricalBaseline: boolean;
    }>;
  };
}

/** Area safety gate before any project reconcile. Current comparisons must
 *  not contradict the imported net/sqft convention; sparse or ambiguous
 *  samples can retain that explicit historical baseline, never a new choice.
 *  Full evidence is returned for the run log. No registry row is mutated. */
export function validateBinghattiAreaConventions(
  mapping: BinghattiMappingResult,
  registry: readonly BinghattiAreaRegistryRow[],
): BinghattiAreaConventionValidation {
  const baseline = BINGHATTI_HISTORICAL_AREA_BASELINE;
  const reasons: string[] = [];
  const checkEvidence = (label: string, evidence: BinghattiAreaEvidence, basis: unknown, unit: unknown) => {
    if (evidence.verdict === 'conflicting') {
      reasons.push(`${label}: current area evidence conflicts with the imported area convention (${evidence.samples} samples)`);
    } else if (evidence.verdict === 'verified'
      && (!evidence.verified || evidence.verified.basis !== basis || evidence.verified.unit !== unit)) {
      const inferred = evidence.verified ? `${evidence.verified.basis}/${evidence.verified.unit}` : 'missing verified convention';
      reasons.push(`${label}: verified area evidence ${inferred} disagrees with ${String(basis)}/${String(unit)}`);
    }
  };
  checkEvidence('global', mapping.areaEvidence, baseline.basis, baseline.unit);
  // Check every mapped group's evidence, even if its registry entry is
  // absent. A contradictory group must not disappear into a global verdict.
  for (const group of mapping.groups) {
    checkEvidence(`project ${group.projectId}`, group.areaEvidence, baseline.basis, baseline.unit);
  }
  const projects = registry.map((row) => {
    const configured = { basis: row.binghatti_area_basis ?? null, unit: row.binghatti_area_unit ?? null };
    const label = `registry ${row.id ?? row.project}`;
    if (configured.basis !== baseline.basis || configured.unit !== baseline.unit) {
      reasons.push(`${label}: configured area ${String(configured.basis)}/${String(configured.unit)} must preserve historical ${baseline.basis}/${baseline.unit}`);
    }
    const areaEvidence = mapping.groups.find((group) => group.projectId === row.project)?.areaEvidence ?? null;
    if (areaEvidence) checkEvidence(label, areaEvidence, configured.basis, configured.unit);
    return {
      projectId: row.project, registryId: row.id ?? null, configured, areaEvidence,
      usesHistoricalBaseline: !areaEvidence || areaEvidence.verdict === 'insufficient' || areaEvidence.verdict === 'ambiguous',
    };
  });
  return { complete: reasons.length === 0, reasons, baseline, evidence: { global: mapping.areaEvidence, projects } };
}
interface JoinedUnit { item: BinghattiItem; crm: CrmUnit; projectId: string }

function code(raw: unknown): string {
  // Preserve leading zeroes and punctuation. Project routing demands an
  // exact developer code, not the reconciler's more tolerant unit keys.
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}
function text(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
function verifiedProvenance(raw: BinghattiMappingProvenance | undefined, savedAt: string): boolean {
  return !!raw && !!text(raw.source) && Number.isFinite(Date.parse(raw.captured_at))
    && Date.parse(raw.captured_at) <= Date.parse(savedAt);
}
function sorted(raw: Iterable<string>): string[] { return [...new Set(raw)].sort(); }

/** A convention needs several independent exact-code rows, all agreeing.
 *  Equal net/total areas produce ambiguity, never an arbitrary preference. */
export function inferBinghattiArea(joins: ReadonlyArray<{ item: BinghattiItem; crm: CrmUnit }>, minSamples = 2): BinghattiAreaEvidence {
  const rows = joins.filter(({ crm }) => { const area = num(crm.data.unit_area); return area != null && area > 0; });
  const candidates: BinghattiAreaEvidence['candidates'] = [];
  for (const basis of ['net', 'total'] as const) for (const unit of ['sqft', 'sqm'] as const) {
    let matchingSamples = 0;
    for (const { item, crm } of rows) {
      const raw = num(basis === 'net' ? item.netArea : item.totalArea);
      const area = num(crm.data.unit_area)!;
      if (raw != null && raw > 0) {
        const converted = Math.round(raw * (unit === 'sqft' ? SQFT_TO_SQM : 1) * 100) / 100;
        if (Math.abs(converted - area) < 0.011) matchingSamples++;
      }
    }
    candidates.push({ basis, unit, matchingSamples });
  }
  const matches = candidates.filter((candidate) => candidate.matchingSamples === rows.length);
  const verdict = rows.length < minSamples ? 'insufficient' : matches.length > 1 ? 'ambiguous' : matches.length === 1 ? 'verified' : 'conflicting';
  return { verdict, samples: rows.length, candidates,
    ...(verdict === 'verified' ? { verified: { basis: matches[0]!.basis, unit: matches[0]!.unit } } : {}) };
}

export function rebuildBinghattiMapping(
  snapshot: BinghattiSnapshot,
  crmUnits: readonly CrmUnit[],
  registered: readonly BinghattiRegisteredMapping[],
  historical?: BinghattiHistoricalMapping,
): BinghattiMappingResult {
  if (!snapshot.complete || !snapshot.fresh) throw new Error('binghatti mapping requires a fresh complete snapshot');
  const items = [...snapshot.byProject.values()].flat();
  const crmByCode = new Map<string, CrmUnit[]>(), sourceByCode = new Map<string, BinghattiItem[]>();
  const crmProjects = new Set<string>();
  for (const unit of crmUnits) {
    const projectId = text(unit.data.project_id);
    if (projectId) crmProjects.add(projectId);
    const key = code(unit.data.developer_unit_code);
    if (key) crmByCode.set(key, [...(crmByCode.get(key) ?? []), unit]);
  }
  for (const item of items) {
    const key = code(item.code);
    if (key) sourceByCode.set(key, [...(sourceByCode.get(key) ?? []), item]);
  }
  const joins: JoinedUnit[] = [], ambiguousCodes: string[] = [];
  for (const [key, sourceRows] of sourceByCode) {
    const crmRows = crmByCode.get(key) ?? [];
    if (sourceRows.length > 1 || crmRows.length > 1) { ambiguousCodes.push(key); continue; }
    if (crmRows.length !== 1) continue;
    const projectId = text(crmRows[0]!.data.project_id);
    if (projectId) joins.push({ item: sourceRows[0]!, crm: crmRows[0]!, projectId });
  }
  const candidates = new Map<string, Set<string>>();
  for (const join of joins) {
    const values = candidates.get(join.item.projectId) ?? new Set<string>();
    values.add(join.projectId);
    candidates.set(join.item.projectId, values);
  }
  const conflicts: BinghattiMappingConflict[] = [];
  const assignments = new Map<string, string>();
  for (const [portalProjectId, projects] of candidates) {
    if (projects.size === 1) assignments.set(portalProjectId, [...projects][0]!);
    else conflicts.push({ kind: 'multiple_crm_projects', portalProjectId, projectIds: sorted(projects) });
  }
  const registeredProjects = new Set(registered.map((row) => row.project));
  const registeredByPortal = new Map<string, Set<string>>();
  for (const row of registered) for (const id of row.source_project_ids) {
    const projects = registeredByPortal.get(id) ?? new Set<string>();
    projects.add(row.project); registeredByPortal.set(id, projects);
  }
  for (const [portalProjectId, projects] of registeredByPortal) if (projects.size > 1) {
    conflicts.push({ kind: 'duplicate_registration', portalProjectId, projectIds: sorted(projects) });
  }
  const historicalByPortal = new Map<string, Set<string>>();
  if (historical && verifiedProvenance(historical, snapshot.savedAt)) for (const row of historical.projects) {
    const projects = historicalByPortal.get(row.portal_project_id) ?? new Set<string>();
    projects.add(row.crm_project_id); historicalByPortal.set(row.portal_project_id, projects);
  }
  for (const row of registered) if (verifiedProvenance(row.mapping_provenance, snapshot.savedAt)) for (const id of row.source_project_ids) {
    const projects = historicalByPortal.get(id) ?? new Set<string>();
    projects.add(row.project); historicalByPortal.set(id, projects);
  }
  const retained = new Set<string>();
  for (const [portalProjectId, projects] of historicalByPortal) {
    if (projects.size !== 1) {
      conflicts.push({ kind: 'historical_mapping_conflict', portalProjectId, projectIds: sorted(projects) });
      continue;
    }
    const projectId = [...projects][0]!;
    const joinedProjects = candidates.get(portalProjectId);
    if (joinedProjects && (joinedProjects.size > 1 || !joinedProjects.has(projectId))) {
      if (joinedProjects.size === 1) conflicts.push({ kind: 'historical_mapping_conflict', portalProjectId, projectIds: sorted([...joinedProjects, projectId]) });
      continue;
    }
    // Verified prior identity survives sold-out projects and newly released
    // inventory with no overlapping CRM codes. Conflicting current joins
    // always win a hold instead of being overwritten by historical data.
    if (!assignments.has(portalProjectId) && (crmProjects.has(projectId) || registeredProjects.has(projectId))) {
      assignments.set(portalProjectId, projectId); retained.add(portalProjectId);
    }
  }
  for (const [portalProjectId, projects] of registeredByPortal) {
    if (projects.size !== 1) continue;
    const registeredProject = [...projects][0]!, mappedProject = assignments.get(portalProjectId);
    if (mappedProject && mappedProject !== registeredProject) {
      conflicts.push({ kind: 'registered_project_changed', portalProjectId, projectIds: sorted([registeredProject, mappedProject]) });
    } else if (!mappedProject) {
      conflicts.push({ kind: snapshot.byProject.has(portalProjectId) ? 'unverified_present_id' : 'unverified_missing_id', portalProjectId, projectIds: [registeredProject] });
    }
  }
  for (const [portalProjectId, projectId] of assignments) {
    if (registeredProjects.has(projectId) && !registeredByPortal.has(portalProjectId)) {
      conflicts.push({ kind: 'new_unregistered_phase', portalProjectId, projectIds: [projectId] });
    }
  }

  const types = new Map<string, { zero: Set<string>; other: Set<string> }>();
  for (const join of joins) {
    const rawId = join.item.unitTypeId;
    const typeId = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId).trim() : '';
    let type = mapUnitType(typeof join.crm.data.unit_type === 'string' ? join.crm.data.unit_type : null);
    if (!typeId || !type) continue;
    const bucket = num(join.item.bedroomsCount) === 0 ? 'zero' : 'other';
    if (bucket === 'zero' && type === 'شقة') type = 'استوديو';
    const values = types.get(typeId) ?? { zero: new Set<string>(), other: new Set<string>() };
    values[bucket].add(type); types.set(typeId, values);
  }
  const unitTypeMap: BinghattiUnitTypeMap = {}, typeConflicts: BinghattiMappingResult['typeConflicts'] = [];
  for (const [typeId, buckets] of types) {
    const mapping: { zero?: string; other?: string } = {};
    for (const bucket of ['zero', 'other'] as const) {
      if (buckets[bucket].size === 1) mapping[bucket] = [...buckets[bucket]][0]!;
      else if (buckets[bucket].size > 1) typeConflicts.push({ typeId, bucket, types: sorted(buckets[bucket]) });
    }
    // Preserve bucket scope even when only one has evidence. Observing a
    // studio never assigns that type to nonzero-bedroom releases.
    if (mapping.zero || mapping.other) unitTypeMap[typeId] = mapping;
  }
  const byCrm = new Map<string, string[]>();
  for (const [id, project] of assignments) byCrm.set(project, [...(byCrm.get(project) ?? []), id]);
  const groups = [...byCrm.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([projectId, portalProjectIds]) => {
    const projectJoins = joins.filter((join) => join.projectId === projectId && assignments.get(join.item.projectId) === projectId);
    return { projectId, portalProjectIds: sorted(portalProjectIds), joinedUnits: projectJoins.length,
      retainedPortalIds: sorted(portalProjectIds.filter((id) => retained.has(id))), areaEvidence: inferBinghattiArea(projectJoins) };
  });
  return { held: conflicts.length > 0, conflicts, groups,
    unknownPortalIds: sorted([...snapshot.byProject.keys()].filter((id) => !assignments.has(id))),
    unregisteredCrmProjectIds: sorted([...crmProjects].filter((id) => !registeredProjects.has(id))),
    unitTypeMap, typeConflicts, areaEvidence: inferBinghattiArea(joins), ambiguousCodes: sorted(ambiguousCodes) };
}
