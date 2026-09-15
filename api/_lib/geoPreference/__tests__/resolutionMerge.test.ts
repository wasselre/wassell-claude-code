import { describe, it, expect } from 'vitest';
import { compile } from '../compiler.js';
import { mergeResolutionsIntoPreference } from '../orchestrator.js';
import { remapExtractionIds } from '../backfillRunner.js';
import { lexicalVariants } from '../resolverDb.js';
import type { Evidence, EvidenceRelation, ResolutionResult } from '../ontology.js';

/**
 * The compiler emits a STUB recipe per mention (names, geo_data_version='stub').
 * The orchestrator must overwrite it with the resolver's REAL recipe (district
 * ids) when every anchor of that mention resolved, and leave the stub (so the
 * gate's needs_confirm stands) when any anchor did not. Pure, offline.
 */

function ev(id: string, spans: Array<[string, Evidence['anchors'][number]['anchor_type']]>, role: Evidence['preference_role'] = 'positive'): Evidence {
  return {
    id, mention_span: spans.map((s) => s[0]).join(' '),
    anchors: spans.map(([span, anchor_type]) => ({ anchor_type, span, normalized_token: span })),
    speaker: 'client', preference_holder: 'client', holder_role: 'buyer', quoted_speaker: 'none',
    dialogue_act: 'statement', conditionality: 'asserted', temporal_reference: 'present',
    preference_applicability: 'active', preference_role: role, commitment: 'preferred',
    hardness_evidence: 'none', modality: 'explicit',
    source: { channel: 'chat', ref: 'm1', timestamp: '2026-09-01T00:00:00Z' },
  };
}
const resolvedDistrict = (id: string, span: string): ResolutionResult => ({
  status: 'resolved', geometry_id: `geo:fp-${id}`,
  recipe: { operation: 'district_polygon', source_anchors: [{ anchor_type: 'district', span, normalized_token: span }], resolved_element_ids: [id], universe_source: 'established_context', geo_data_version: 'districts@test', resolver_version: 'resolver@test', compiled_at: '2026-09-13T00:00:00Z' },
  candidate_margin: 0.45,
});
const needsConfirm: ResolutionResult = { status: 'needs_confirm', reason: 'ambiguous_entity', candidate_margin: 0 };

describe('mergeResolutionsIntoPreference', () => {
  it('replaces the stub recipe with the resolver recipe (district ids) per mention; leaves unresolved mentions as stubs', () => {
    const e1 = ev('e1', [['النرجس', 'district']]);
    const e2 = ev('e2', [['الياسمين', 'district']]);
    const { preference } = compile([e1, e2], []);
    // resolutions are in evidence × anchor order
    const merged = mergeResolutionsIntoPreference(preference, [e1, e2], [resolvedDistrict('d-narjes', 'النرجس'), needsConfirm]);
    expect(merged.resolved_evidence).toBe(1);
    expect(merged.unresolved_evidence).toBe(1);
    const refs = merged.preference.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf));
    const r1 = refs.find((r) => r.geometry_id === 'geo:e1')!;
    const r2 = refs.find((r) => r.geometry_id === 'geo:e2')!;
    expect(r1.recipe.resolved_element_ids).toEqual(['d-narjes']);
    expect(r1.recipe.geo_data_version).toBe('districts@test');
    expect(r1.recipe.universe_source).toBe('established_context');
    expect(r2.recipe.resolved_element_ids).toEqual(['الياسمين']); // stub kept
    expect(r2.recipe.geo_data_version).toBe('stub');
    // The input preference is not mutated.
    const before = preference.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf)).find((r) => r.geometry_id === 'geo:e1')!;
    expect(before.recipe.geo_data_version).toBe('stub');
  });

  it('a mention with several district anchors becomes ONE district_union of all resolved ids', () => {
    const e1 = ev('e1', [['المهدية', 'district'], ['الجبيلة', 'district']]);
    const { preference } = compile([e1], []);
    const merged = mergeResolutionsIntoPreference(preference, [e1], [resolvedDistrict('d-mahdiya', 'المهدية'), resolvedDistrict('d-jubaylah', 'الجبيلة')]);
    const ref = merged.preference.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf)).find((r) => r.geometry_id === 'geo:e1')!;
    expect(ref.recipe.operation).toBe('district_union');
    expect(ref.recipe.resolved_element_ids).toEqual(['d-mahdiya', 'd-jubaylah']);
    expect(ref.recipe.source_anchors.map((a) => a.span)).toEqual(['المهدية', 'الجبيلة']);
  });

  it('a partially resolved multi-anchor mention keeps the stub (never mixes ids with names)', () => {
    const e1 = ev('e1', [['المهدية', 'district'], ['الجبيلة', 'district']]);
    const { preference } = compile([e1], []);
    const merged = mergeResolutionsIntoPreference(preference, [e1], [resolvedDistrict('d-mahdiya', 'المهدية'), needsConfirm]);
    const ref = merged.preference.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf)).find((r) => r.geometry_id === 'geo:e1')!;
    expect(ref.recipe.geo_data_version).toBe('stub');
    expect(ref.recipe.resolved_element_ids).toEqual(['المهدية', 'الجبيلة']);
    expect(merged.unresolved_evidence).toBe(1);
  });
});

describe('mixed mention: district + side of a road', () => {
  it('«العليا (غرب الملك فهد)» → band ref + an extra include clause with the district (AND), never a district id inside the band', () => {
    const e1 = ev('e1', [['العليا', 'district'], ['غرب الملك فهد', 'direction']]);
    const { preference } = compile([e1], []);
    const band: ResolutionResult = {
      status: 'resolved', geometry_id: 'geo:fp-band',
      recipe: { operation: 'directional_band', source_anchors: [], resolved_element_ids: ['RUH-ROAD-0694'], radius_or_band_m: 1500, universe_source: 'organizational_default', geo_data_version: 'roads@test', resolver_version: 'resolver@test', compiled_at: '2026-09-15T00:00:00Z' },
    };
    const merged = mergeResolutionsIntoPreference(preference, [e1], [resolvedDistrict('d-olaya', 'العليا'), band]);
    const clauses = merged.preference.groups[0]!.clauses;
    expect(clauses).toHaveLength(2);
    const bandRef = clauses[0]!.anyOf[0]!;
    expect(bandRef.recipe.operation).toBe('directional_band');
    expect(bandRef.recipe.resolved_element_ids).toEqual(['RUH-ROAD-0694']);
    expect(bandRef.recipe.source_anchors.map((a) => a.span)).toEqual(['غرب الملك فهد']);
    const adminClause = clauses[1]!;
    expect(adminClause.op).toBe('include');
    expect(adminClause.anyOf[0]!.geometry_id).toBe('geo:e1:admin');
    expect(adminClause.anyOf[0]!.recipe.resolved_element_ids).toEqual(['d-olaya']);
    expect(merged.resolved_evidence).toBe(1);
  });
});

describe('compile(): a target-less exception never inverts a member (2026-09-15, فهد)', () => {
  it('members keep their OWN polarity; needs_confirm is still raised', () => {
    const west = ev('west', [['غرب الملك فهد', 'direction']], 'positive');
    const east = ev('east', [['شرق الملك فهد', 'direction']], 'negative');
    const rel: EvidenceRelation = {
      id: 'r1', relation: 'exception',
      members: [{ type: 'evidence', id: 'east' }, { type: 'evidence', id: 'west' }],
      source_span: 'يستفسر عن شرق الملك فهد ثم يؤكد أنه يبحث عن غرب الملك فهد', explicit_or_inferred: 'explicit',
    };
    const { preference, needs_confirm } = compile([west, east], [rel]);
    expect(needs_confirm).toBe(true);
    const clauses = preference.groups.flatMap((g) => g.clauses);
    const opOf = (id: string) => clauses.find((c) => c.anyOf.some((r) => r.geometry_id === `geo:${id}`))!.op;
    expect(opOf('west')).toBe('include');
    expect(opOf('east')).toBe('exclude');
  });
});

describe('lexicalVariants (resolverDb candidate stage)', () => {
  it('generates ة/ه, ى/ي, hamza and article variants', () => {
    const v = lexicalVariants('المحمديه');
    expect(v).toContain('المحمدية');
    expect(v).toContain('محمديه');
    expect(lexicalVariants('نرجس')).toContain('النرجس');
    expect(lexicalVariants('الياسمين')).toContain('ياسمين');
    expect(lexicalVariants('  ')).toEqual([]);
  });
});

describe('remapExtractionIds', () => {
  it('rewrites evidence ids and every relation member/ordering/target ref to the persisted ids', () => {
    const e1 = ev('e1', [['المهدية', 'district']]);
    const e2 = ev('e2', [['الجبيلة', 'district']]);
    const rel: EvidenceRelation = {
      id: 'r1', relation: 'ranked_alternative',
      members: [{ type: 'evidence', id: 'e1' }, { type: 'evidence', id: 'e2' }],
      ordering: [{ type: 'evidence', id: 'e1' }, { type: 'evidence', id: 'e2' }],
      target: { type: 'evidence', id: 'e1' },
      source_span: 'المهدية أو الجبيلة', explicit_or_inferred: 'explicit',
    };
    const out = remapExtractionIds([e1, e2], [rel], { e1: 'uuid-1', e2: 'uuid-2' });
    expect(out.evidence.map((e) => e.id)).toEqual(['uuid-1', 'uuid-2']);
    expect(out.relations[0]!.members.map((m) => m.id)).toEqual(['uuid-1', 'uuid-2']);
    expect(out.relations[0]!.ordering!.map((m) => m.id)).toEqual(['uuid-1', 'uuid-2']);
    expect(out.relations[0]!.target!.id).toBe('uuid-1');
    // originals untouched
    expect(e1.id).toBe('e1');
    expect(rel.members[0]!.id).toBe('e1');
  });
});
