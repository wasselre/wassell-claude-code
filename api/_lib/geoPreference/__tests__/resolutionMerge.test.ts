import { describe, it, expect } from 'vitest';
import { compile } from '../compiler.js';
import { mergeResolutionsIntoPreference } from '../orchestrator.js';
import { remapExtractionIds } from '../backfillRunner.js';
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
