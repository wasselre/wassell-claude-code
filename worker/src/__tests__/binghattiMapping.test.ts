import { describe, expect, it } from 'vitest';
import { fetchBinghattiProject, parseBinghattiSnapshot } from '../projectUpdates/binghatti';
import { rebuildBinghattiMapping, validateBinghattiAreaConventions } from '../projectUpdates/binghattiMapping';
import type { CrmUnit } from '../projectUpdates/types';
import realCapture from '../projectUpdates/fixtures/binghatti-real-inventory.json';
import realCrm from '../projectUpdates/fixtures/binghatti-crm-units.json';

const SAVED_AT = '2026-10-05T08:00:00Z';
const NOW = Date.parse(SAVED_AT);
const PROVENANCE = { captured_at: '2026-08-07T04:55:00Z', source: 'Synthetic verified history for tests' };
function row(id: string, portal = 'phase-1', extra: Record<string, unknown> = {}) {
  return { id, projectId: portal, code: `EXAMPLE-${id}`, number: id.replace(/\D/g, '') || '1', actualPrice: 1_000_000,
    unitTypeId: 2, bedroomsCount: 1, netArea: 603.86, totalArea: 663.27, floorNumber: 6, ...extra };
}
function snapshot(items = [row('one')]) {
  return parseBinghattiSnapshot({ saved_at: SAVED_AT, totalCount: items.length, items }, NOW);
}
function crm(id: string, project = 'crm-one', extra: Record<string, unknown> = {}): CrmUnit {
  return { id, data: { developer_unit_code: `EXAMPLE-${id}`, project_id: project, unit_type: 'شقة', unit_area: 56.1, ...extra } };
}

describe('Binghatti operational capture mapping (synthetic contract cases)', () => {
  it('joins globally by unique exact code, merges phases, and reports unknown / unregistered projects', () => {
    const result = rebuildBinghattiMapping(snapshot([row('one'), row('two', 'phase-2'), row('unknown', 'portal-only')]),
      [crm('one'), crm('two'), crm('unregistered', 'crm-new')], [{ project: 'crm-one', source_project_ids: ['phase-1', 'phase-2'] }]);
    expect(result.held).toBe(false);
    expect(result.groups[0]).toMatchObject({ projectId: 'crm-one', portalProjectIds: ['phase-1', 'phase-2'], joinedUnits: 2 });
    expect(result.unknownPortalIds).toEqual(['portal-only']);
    expect(result.unregisteredCrmProjectIds).toEqual(['crm-new']);
    expect(result.areaEvidence).toMatchObject({ verdict: 'verified', samples: 2, verified: { basis: 'net', unit: 'sqft' } });
  });
  it('never routes from a duplicate source or CRM code, or from leading-zero normalization', () => {
    const result = rebuildBinghattiMapping(snapshot([row('one'), row('two', 'phase-2', { code: 'EXAMPLE-one' }), row('zero', 'phase-3', { code: 'EXAMPLE-001' })]),
      [crm('one'), crm('duplicate', 'crm-other', { developer_unit_code: 'EXAMPLE-one' }), crm('zero', 'crm-zero', { developer_unit_code: 'EXAMPLE-1' })], []);
    expect(result.groups).toEqual([]);
    expect(result.unknownPortalIds).toEqual(['phase-1', 'phase-2', 'phase-3']);
    expect(result.ambiguousCodes).toEqual(['EXAMPLE-ONE']);
  });
  it('holds a portal project whose exact codes lead to two CRM projects', () => {
    const result = rebuildBinghattiMapping(snapshot([row('one'), row('two')]), [crm('one'), crm('two', 'crm-other')], []);
    expect(result.held).toBe(true);
    expect(result.conflicts).toEqual([{ kind: 'multiple_crm_projects', portalProjectId: 'phase-1', projectIds: ['crm-one', 'crm-other'] }]);
    expect(result.groups).toEqual([]);
  });
  it('holds a reassigned registered id, duplicate registration, and omitted newly joined phase', () => {
    const result = rebuildBinghattiMapping(snapshot([row('one'), row('two', 'phase-2')]), [crm('one'), crm('two')], [
      { project: 'wrong', source_project_ids: ['phase-1'] }, { project: 'crm-one', source_project_ids: ['other'] },
      { project: 'second', source_project_ids: ['other'] },
    ]);
    expect(result.held).toBe(true);
    expect(result.conflicts.map((conflict) => conflict.kind)).toEqual(['duplicate_registration', 'registered_project_changed', 'new_unregistered_phase']);
  });
  it('retains verified sold-out IDs and present newly released inventory with no overlapping code', () => {
    const result = rebuildBinghattiMapping(snapshot([row('new-release', 'present-no-overlap')]), [crm('old')],
      [{ project: 'crm-one', source_project_ids: ['sold-out', 'present-no-overlap'], mapping_provenance: PROVENANCE }]);
    expect(result.held).toBe(false);
    expect(result.groups[0]).toMatchObject({ portalProjectIds: ['present-no-overlap', 'sold-out'], retainedPortalIds: ['present-no-overlap', 'sold-out'], joinedUnits: 0 });
    expect(result.unknownPortalIds).toEqual([]);
  });
  it('requires recorded provenance to retain an old ID and refuses contradictory history', () => {
    const missing = rebuildBinghattiMapping(snapshot(), [crm('one')], [{ project: 'crm-one', source_project_ids: ['phase-1', 'old-id'] }]);
    expect(missing.held).toBe(true);
    expect(missing.conflicts).toEqual([{ kind: 'unverified_missing_id', portalProjectId: 'old-id', projectIds: ['crm-one'] }]);
    const conflict = rebuildBinghattiMapping(snapshot(), [crm('one'), crm('old', 'old-crm')], [],
      { ...PROVENANCE, projects: [{ portal_project_id: 'phase-1', crm_project_id: 'old-crm' }] });
    expect(conflict.held).toBe(true);
    expect(conflict.conflicts[0]?.kind).toBe('historical_mapping_conflict');
    expect(conflict.groups[0]?.projectId).toBe('crm-one');
  });
  it('keeps studio / apartment type evidence in separate buckets and skips conflicting types', async () => {
    const source = snapshot([row('one', 'phase-1', { bedroomsCount: 0 }), row('two'), row('three', 'phase-1', { unitTypeId: 4 }), row('four', 'phase-1', { unitTypeId: 4 })]);
    const result = rebuildBinghattiMapping(source, [crm('one', 'crm-one', { unit_type: 'استوديو' }), crm('two'),
      crm('three', 'crm-one', { unit_type: 'مكتب' }), crm('four', 'crm-one', { unit_type: 'فيلا' })], [{ project: 'crm-one', source_project_ids: ['phase-1'] }]);
    expect(result.unitTypeMap).toEqual({ '2': { zero: 'استوديو', other: 'شقة' } });
    expect(result.typeConflicts).toEqual([{ typeId: '4', bucket: 'other', types: ['فيلا', 'مكتب'] }]);
    const project = await fetchBinghattiProject('phase-1', source, { areaBasis: 'net', areaUnit: 'sqft', unitTypeMap: result.unitTypeMap });
    expect(project.units.map((unit) => unit.unitType)).toEqual(['استوديو', 'شقة', null, null]);
  });
  it('does not infer an area from one row or resolve identical net / total by guessing', () => {
    const one = rebuildBinghattiMapping(snapshot(), [crm('one')], []);
    expect(one.areaEvidence.verdict).toBe('insufficient');
    const ambiguous = rebuildBinghattiMapping(snapshot([row('one', 'phase-1', { totalArea: 603.86 }), row('two', 'phase-1', { totalArea: 603.86 })]), [crm('one'), crm('two')], []);
    expect(ambiguous.areaEvidence.verdict).toBe('ambiguous');
    expect(ambiguous.areaEvidence.verified).toBeUndefined();
    const conflict = rebuildBinghattiMapping(snapshot([row('one'), row('two')]), [crm('one'), crm('two', 'crm-one', { unit_area: 70 })], []);
    expect(conflict.areaEvidence.verdict).toBe('conflicting');
  });
  it('rejects stale inventory before proposing a mapping', () => {
    const old = { ...snapshot(), fresh: false };
    expect(() => rebuildBinghattiMapping(old, [], [])).toThrow(/fresh complete/);
  });
});

describe('Binghatti real captured-code mapping', () => {
  it('routes the genuine August BWRT-645 row to Wraith while leaving area inference unverified from one example', () => {
    const source = parseBinghattiSnapshot({ saved_at: realCapture.saved_at, totalCount: 1, items: realCapture.items }, Date.parse(realCapture.saved_at));
    const result = rebuildBinghattiMapping(source, realCrm.units, [{ project: '3ce466d0-42d4-409b-825f-fa7eb152621f', source_project_ids: ['10101'] }]);
    expect(result.held).toBe(false);
    expect(result.groups[0]).toMatchObject({ projectId: '3ce466d0-42d4-409b-825f-fa7eb152621f', portalProjectIds: ['10101'], joinedUnits: 1 });
    expect(result.unitTypeMap).toEqual({ '2': { other: 'شقة' } });
    expect(result.areaEvidence.verdict).toBe('insufficient');
  });
});

describe('Binghatti area convention safety gate', () => {
  const registry = [{ id: 'registry-one', project: 'crm-one', binghatti_area_basis: 'net', binghatti_area_unit: 'sqft' }];
  function mapping() {
    return rebuildBinghattiMapping(snapshot([row('one'), row('two')]), [crm('one'), crm('two')], [{ project: 'crm-one', source_project_ids: ['phase-1'] }]);
  }
  it('accepts current net/sqft evidence and returns an auditable historical baseline', () => {
    const validation = validateBinghattiAreaConventions(mapping(), registry);
    expect(validation.complete).toBe(true);
    expect(validation.reasons).toEqual([]);
    expect(validation.baseline).toMatchObject({ basis: 'net', unit: 'sqft', squareFeetToSquareMetres: 0.09290304, crmUnitCodes: ['BWRT-208', 'BWRT-645'] });
    expect(validation.evidence.global.verdict).toBe('verified');
    expect(validation.evidence.projects[0]).toMatchObject({ projectId: 'crm-one', registryId: 'registry-one', usesHistoricalBaseline: false });
  });
  it('rejects changed or missing registry conventions even if no current area rows exist', () => {
    const sparse = rebuildBinghattiMapping(snapshot(), [crm('one')], []);
    for (const bad of [
      { ...registry[0]!, binghatti_area_basis: 'total' },
      { ...registry[0]!, binghatti_area_unit: 'sqm' },
      { project: 'crm-one' },
    ]) {
      const validation = validateBinghattiAreaConventions(sparse, [bad]);
      expect(validation.complete).toBe(false);
      expect(validation.reasons.some((reason) => reason.includes('must preserve historical net/sqft'))).toBe(true);
    }
  });
  it('rejects conflicting current comparisons and retains their sample evidence', () => {
    const conflicting = rebuildBinghattiMapping(snapshot([row('one'), row('two')]), [crm('one'), crm('two', 'crm-one', { unit_area: 70 })], []);
    const validation = validateBinghattiAreaConventions(conflicting, registry);
    expect(validation.complete).toBe(false);
    expect(validation.reasons.some((reason) => reason.startsWith('global:') && reason.includes('conflicts'))).toBe(true);
    expect(validation.reasons.some((reason) => reason.includes('project crm-one') && reason.includes('conflicts'))).toBe(true);
    expect(validation.evidence.global).toEqual(conflicting.areaEvidence);
  });
  it('rejects a globally verified different convention and a contradictory group even when global agrees', () => {
    const total = rebuildBinghattiMapping(snapshot([row('one'), row('two')]),
      [crm('one', 'crm-one', { unit_area: 61.62 }), crm('two', 'crm-one', { unit_area: 61.62 })], []);
    expect(total.areaEvidence.verified).toEqual({ basis: 'total', unit: 'sqft' });
    const totalValidation = validateBinghattiAreaConventions(total, registry);
    expect(totalValidation.complete).toBe(false);
    expect(totalValidation.reasons.some((reason) => reason.startsWith('global:') && reason.includes('total/sqft'))).toBe(true);
    const mixed = mapping();
    mixed.groups[0]!.areaEvidence = total.groups[0]!.areaEvidence;
    const mixedValidation = validateBinghattiAreaConventions(mixed, registry);
    expect(mixedValidation.complete).toBe(false);
    expect(mixedValidation.reasons.some((reason) => reason.includes('project crm-one') && reason.includes('total/sqft'))).toBe(true);
    expect(mixedValidation.reasons.some((reason) => reason.includes('registry registry-one') && reason.includes('disagrees'))).toBe(true);
  });
  it('permits sparse and ambiguous evidence only through the explicit net/sqft baseline', () => {
    const insufficient = rebuildBinghattiMapping(snapshot(), [crm('one')], []);
    const ambiguous = rebuildBinghattiMapping(snapshot([row('one', 'phase-1', { totalArea: 603.86 }), row('two', 'phase-1', { totalArea: 603.86 })]), [crm('one'), crm('two')], []);
    for (const current of [insufficient, ambiguous]) {
      const validation = validateBinghattiAreaConventions(current, registry);
      expect(validation.complete).toBe(true);
      expect(validation.evidence.projects[0]?.usesHistoricalBaseline).toBe(true);
      expect(validation.baseline.source).toContain('binghatti-crm-units.json');
    }
  });
  it('does not mutate registry or mapping inputs and cannot accept malformed verified evidence', () => {
    const current = mapping();
    const registryBefore = JSON.stringify(registry), mappingBefore = JSON.stringify(current);
    validateBinghattiAreaConventions(current, registry);
    expect(JSON.stringify(registry)).toBe(registryBefore);
    expect(JSON.stringify(current)).toBe(mappingBefore);
    const malformed = { ...current, areaEvidence: { ...current.areaEvidence, verified: undefined } };
    const validation = validateBinghattiAreaConventions(malformed, registry);
    expect(validation.complete).toBe(false);
    expect(validation.reasons[0]).toContain('missing verified convention');
  });
});
