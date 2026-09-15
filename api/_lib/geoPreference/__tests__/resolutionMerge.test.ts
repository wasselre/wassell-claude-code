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

const westBand = (span = 'غرب الملك فهد'): ResolutionResult => ({
  status: 'resolved', geometry_id: 'geo:fp-band',
  recipe: { operation: 'directional_band', source_anchors: [{ anchor_type: 'direction', span, normalized_token: span }], resolved_element_ids: ['RUH-ROAD-0694'], radius_or_band_m: 5000, universe_source: 'organizational_default', geo_data_version: 'roads@test', resolver_version: 'resolver@test', compiled_at: '2026-09-15T00:00:00Z' },
});

describe('district + side of a road = the district CLIPPED to that side (district_side_clip)', () => {
  it('«العليا (غرب الملك فهد)» → ONE district_side_clip ref: [district…, road], side=west, no band left', () => {
    const e1 = ev('e1', [['العليا', 'district'], ['غرب الملك فهد', 'direction']]);
    const { preference } = compile([e1], []);
    const merged = mergeResolutionsIntoPreference(preference, [e1], [resolvedDistrict('d-olaya', 'العليا'), westBand()]);
    const clauses = merged.preference.groups[0]!.clauses;
    expect(clauses).toHaveLength(1);
    const ref = clauses[0]!.anyOf[0]!;
    expect(ref.recipe.operation).toBe('district_side_clip');
    expect(ref.recipe.resolved_element_ids).toEqual(['d-olaya', 'RUH-ROAD-0694']);
    expect(ref.recipe.side).toBe('west');
    expect(ref.recipe.source_anchors.map((a) => a.span)).toEqual(['العليا', 'غرب الملك فهد']);
    expect(ref.recipe.clip_geojson).toBeUndefined(); // computed at proposal time, not here
  });

  it('a standalone «غرب الملك فهد» in a group of districts clips EVERY district and drops the whole-road band (فهد, 2026-09-15)', () => {
    const d1 = ev('d1', [['المعذر الشمالي', 'district']]);
    const d2 = ev('d2', [['المحمديه', 'district']]);
    const w = ev('w', [['غرب الملك فهد', 'direction']]);
    const anyOf: EvidenceRelation = { id: 'r1', relation: 'any_of', members: [{ type: 'evidence', id: 'd1' }, { type: 'evidence', id: 'd2' }], source_span: 'المعذر الشمالي او المحمديه', explicit_or_inferred: 'explicit' };
    const { preference } = compile([d1, d2, w], [anyOf]);
    const merged = mergeResolutionsIntoPreference(preference, [d1, d2, w], [resolvedDistrict('d-maathar', 'المعذر الشمالي'), resolvedDistrict('d-mohammadiyah', 'المحمدية'), westBand()]);
    // The compiler put the standalone band in its OWN group (OR); distribution
    // works across groups, so that group is now gone and every district is clipped.
    const refs = merged.preference.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf));
    expect(merged.preference.groups).toHaveLength(1);
    expect(refs.every((r) => r.recipe.operation === 'district_side_clip')).toBe(true);
    expect(refs.map((r) => r.recipe.resolved_element_ids)).toEqual([['d-maathar', 'RUH-ROAD-0694'], ['d-mohammadiyah', 'RUH-ROAD-0694']]);
    expect(refs.every((r) => r.recipe.side === 'west')).toBe(true);
    expect(merged.preference.groups[0]!.role).toBe('primary');
    expect(merged.preference.groups[0]!.priority).toBe(1);
  });

  it('an EXCLUDE band («مو شرق الملك فهد») is left alone — never distributed', () => {
    const d1 = ev('d1', [['المعذر الشمالي', 'district']]);
    const east = ev('east', [['شرق الملك فهد', 'direction']], 'negative');
    const { preference } = compile([d1, east], []);
    const eastBand: ResolutionResult = { ...westBand('شرق الملك فهد'), recipe: { ...westBand('شرق الملك فهد').recipe } };
    const merged = mergeResolutionsIntoPreference(preference, [d1, east], [resolvedDistrict('d-maathar', 'المعذر الشمالي'), eastBand]);
    const refs = merged.preference.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf.map((r) => ({ op: c.op, o: r.recipe.operation }))));
    expect(refs).toEqual([{ op: 'include', o: 'district_polygon' }, { op: 'exclude', o: 'directional_band' }]);
  });

  it('two different sides in one include group are ambiguous → left as districts + bands', () => {
    const d1 = ev('d1', [['المعذر الشمالي', 'district']]);
    const w = ev('w', [['غرب الملك فهد', 'direction']]);
    const n = ev('n', [['شمال الملك سلمان', 'direction']]);
    const { preference } = compile([d1, w, n], []);
    const northBand: ResolutionResult = { ...westBand('شمال الملك سلمان'), recipe: { ...westBand('شمال الملك سلمان').recipe, resolved_element_ids: ['RUH-ROAD-0001'] } };
    const merged = mergeResolutionsIntoPreference(preference, [d1, w, n], [resolvedDistrict('d-maathar', 'المعذر الشمالي'), westBand(), northBand]);
    const ops = merged.preference.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf.map((r) => r.recipe.operation))).sort();
    expect(ops).toEqual(['directional_band', 'directional_band', 'district_polygon']);
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
