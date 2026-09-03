import { describe, it, expect } from 'vitest';
import { compile } from '../compiler';
import { interpret, dnfKeySet, termKey, type Term, type Dnf } from '../referenceInterpreter';
import { classify, type SatUniverse } from '../satisfiability';
import type {
  Evidence,
  EvidenceRelation,
  GeoPreference,
  AnchorToken,
  AnchorType,
  PreferenceRole,
  HardnessEvidence,
} from '../ontology';

// ────────────────────────────────────────────────────────────────────────────
// Builders — one active buyer preference by default; override per case.
// ────────────────────────────────────────────────────────────────────────────

function anchor(type: AnchorType, token: string): AnchorToken {
  return { anchor_type: type, span: token, normalized_token: token };
}

function ev(
  id: string,
  opts: {
    role?: PreferenceRole;
    hardness?: HardnessEvidence;
    anchors?: AnchorToken[];
    active?: boolean; // set false to make isActivePreference() fail
  } = {},
): Evidence {
  const active = opts.active ?? true;
  return {
    id,
    mention_span: id,
    anchors: opts.anchors ?? [anchor('district', id)],
    speaker: 'client',
    preference_holder: 'client',
    holder_role: active ? 'buyer' : 'unrelated_third_party',
    quoted_speaker: 'none',
    dialogue_act: 'statement',
    conditionality: 'asserted',
    temporal_reference: 'present',
    preference_applicability: active ? 'active' : 'exploratory',
    preference_role: opts.role ?? 'positive',
    commitment: 'preferred',
    hardness_evidence: opts.hardness ?? 'none',
    modality: 'explicit',
    source: { channel: 'chat', ref: `${id}-msg`, timestamp: '2026-09-03T00:00:00Z' },
  };
}

const G = (id: string) => `geo:${id}`; // geometry-id convention shared by both impls

// Expand a compiled GeoPreference to DNF term keys, independently of the
// reference interpreter, so the property test compares two derivations.
function compilerDnf(pref: GeoPreference): Dnf {
  const terms: Dnf = [];
  for (const g of pref.groups) {
    const includeClauses = g.clauses.filter((c) => c.op === 'include');
    const excludeClauses = g.clauses.filter((c) => c.op === 'exclude');
    // cartesian over include clauses (each anyOf is an OR)
    let base: Term[] = [[]];
    for (const c of includeClauses) {
      const next: Term[] = [];
      for (const partial of base) {
        for (const ref of c.anyOf) next.push([...partial, { geometry_id: ref.geometry_id, negated: false }]);
      }
      base = next;
    }
    // NOT(a OR b) = ¬a ∧ ¬b — append every excluded id (negated) to each term
    for (const term of base) {
      for (const c of excludeClauses) {
        for (const ref of c.anyOf) term.push({ geometry_id: ref.geometry_id, negated: true });
      }
    }
    for (const t of base) terms.push(t);
  }
  return terms;
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures — the six required natural-language cases.
// ────────────────────────────────────────────────────────────────────────────

interface Fixture {
  label: string;
  evidence: Evidence[];
  relations: EvidenceRelation[];
}

// «النرجس أو العارض» — any_of
const F_any_of: Fixture = {
  label: 'النرجس أو العارض (any_of)',
  evidence: [
    ev('narjis', { hardness: 'explicit_force' }),
    ev('ard', { hardness: 'explicit_force' }),
  ],
  relations: [
    {
      id: 'R_anyof',
      relation: 'any_of',
      members: [
        { type: 'evidence', id: 'narjis' },
        { type: 'evidence', id: 'ard' },
      ],
      source_span: 'النرجس أو العارض',
      explicit_or_inferred: 'explicit',
    },
  ],
};

// «شمال طريق الملك سلمان وقريب من المطار» — all_of
const F_all_of: Fixture = {
  label: 'شمال طريق الملك سلمان وقريب من المطار (all_of)',
  evidence: [
    ev('north_ksrd', {
      hardness: 'implied',
      anchors: [anchor('direction', 'north'), anchor('road', 'king_salman_rd')],
    }),
    ev('near_airport', {
      hardness: 'explicit_force',
      anchors: [anchor('landmark', 'airport')],
    }),
  ],
  relations: [
    {
      id: 'R_allof',
      relation: 'all_of',
      members: [
        { type: 'evidence', id: 'north_ksrd' },
        { type: 'evidence', id: 'near_airport' },
      ],
      source_span: 'شمال طريق الملك سلمان وقريب من المطار',
      explicit_or_inferred: 'explicit',
    },
  ],
};

// «شمال الرياض إلا حي النرجس» — exception (must be VALID, not a contradiction)
const F_exception: Fixture = {
  label: 'شمال الرياض إلا حي النرجس (exception)',
  evidence: [
    ev('north_riyadh', { hardness: 'explicit_force', anchors: [anchor('direction', 'north'), anchor('city', 'riyadh')] }),
    ev('ex_narjis', { role: 'negative', hardness: 'explicit_force' }),
  ],
  relations: [
    {
      id: 'R_exc',
      relation: 'exception',
      members: [{ type: 'evidence', id: 'ex_narjis' }],
      target: { type: 'evidence', id: 'north_riyadh' },
      source_span: 'شمال الرياض إلا حي النرجس',
      explicit_or_inferred: 'explicit',
    },
  ],
};

// «المهدية أول وإذا ما حصل فالجبيلة» — ranked_alternative
const F_ranked: Fixture = {
  label: 'المهدية أول وإذا ما حصل فالجبيلة (ranked_alternative)',
  evidence: [
    ev('mahdiyah', { hardness: 'explicit_force' }),
    ev('jubaila', { hardness: 'implied' }),
  ],
  relations: [
    {
      id: 'R_rank',
      relation: 'ranked_alternative',
      members: [
        { type: 'evidence', id: 'mahdiyah' },
        { type: 'evidence', id: 'jubaila' },
      ],
      ordering: [
        { type: 'evidence', id: 'mahdiyah' },
        { type: 'evidence', id: 'jubaila' },
      ],
      source_span: 'المهدية أول وإذا ما حصل فالجبيلة',
      explicit_or_inferred: 'explicit',
    },
  ],
};

// «(النرجس أو العارض) بس مو قريب الدائري» — exception over any_of, depth 2
const F_nested: Fixture = {
  label: '(النرجس أو العارض) بس مو قريب الدائري (exception over any_of)',
  evidence: [
    ev('n_narjis', { hardness: 'explicit_force' }),
    ev('n_ard', { hardness: 'explicit_force' }),
    ev('ring', { role: 'negative', hardness: 'explicit_force', anchors: [anchor('road', 'ring_road')] }),
  ],
  relations: [
    {
      id: 'R_inner_anyof',
      relation: 'any_of',
      members: [
        { type: 'evidence', id: 'n_narjis' },
        { type: 'evidence', id: 'n_ard' },
      ],
      source_span: 'النرجس أو العارض',
      explicit_or_inferred: 'explicit',
    },
    {
      id: 'R_outer_exc',
      relation: 'exception',
      members: [{ type: 'evidence', id: 'ring' }],
      target: { type: 'relation', id: 'R_inner_anyof' },
      source_span: 'بس مو قريب الدائري',
      explicit_or_inferred: 'explicit',
    },
  ],
};

// depth-3 — exception ▸ ranked_alternative ▸ any_of ▸ evidence → needs_confirm
const F_depth3: Fixture = {
  label: 'depth-3 nesting (must need confirm)',
  evidence: [
    ev('d_a', { hardness: 'explicit_force' }),
    ev('d_b', { hardness: 'explicit_force' }),
    ev('d_c', { hardness: 'explicit_force' }),
    ev('d_x', { role: 'negative', hardness: 'explicit_force' }),
  ],
  relations: [
    {
      id: 'D_anyof',
      relation: 'any_of',
      members: [
        { type: 'evidence', id: 'd_a' },
        { type: 'evidence', id: 'd_b' },
      ],
      source_span: 'a أو b',
      explicit_or_inferred: 'explicit',
    },
    {
      id: 'D_rank',
      relation: 'ranked_alternative',
      members: [
        { type: 'relation', id: 'D_anyof' },
        { type: 'evidence', id: 'd_c' },
      ],
      ordering: [
        { type: 'relation', id: 'D_anyof' },
        { type: 'evidence', id: 'd_c' },
      ],
      source_span: '(a أو b) وإلا c',
      explicit_or_inferred: 'explicit',
    },
    {
      id: 'D_exc',
      relation: 'exception',
      members: [{ type: 'evidence', id: 'd_x' }],
      target: { type: 'relation', id: 'D_rank' },
      source_span: '… إلا x',
      explicit_or_inferred: 'explicit',
    },
  ],
};

const VALID_FIXTURES = [F_any_of, F_all_of, F_exception, F_ranked, F_nested];
const ALL_FIXTURES = [...VALID_FIXTURES, F_depth3];

// ────────────────────────────────────────────────────────────────────────────
// compile() — structural expectations per fixture
// ────────────────────────────────────────────────────────────────────────────

describe('compile() — any_of', () => {
  it('«النرجس أو العارض» → one group, one include clause OR-ing both anchors', () => {
    const { preference, needs_confirm } = compile(F_any_of.evidence, F_any_of.relations);
    expect(needs_confirm).toBe(false);
    expect(preference.groups).toHaveLength(1);
    const g = preference.groups[0]!;
    expect(g.role).toBe('primary');
    expect(g.strength).toBe('hard'); // both explicit_force
    expect(g.clauses).toHaveLength(1);
    expect(g.clauses[0]!.op).toBe('include');
    expect(g.clauses[0]!.anyOf.map((a) => a.geometry_id).sort()).toEqual([G('ard'), G('narjis')]);
  });
});

describe('compile() — all_of', () => {
  it('«شمال … وقريب من المطار» → one group, two AND include clauses', () => {
    const { preference, needs_confirm, reasons } = compile(F_all_of.evidence, F_all_of.relations);
    expect(needs_confirm).toBe(false);
    expect(preference.groups).toHaveLength(1);
    const g = preference.groups[0]!;
    expect(g.clauses).toHaveLength(2);
    expect(g.clauses.every((c) => c.op === 'include')).toBe(true);
    const ids = g.clauses.map((c) => c.anyOf[0]!.geometry_id).sort();
    expect(ids).toEqual([G('near_airport'), G('north_ksrd')]);
    // one member is 'implied' ⇒ group stays soft and a hardening reason is recorded
    expect(g.strength).toBe('soft');
    expect(reasons.some((r) => /implied/.test(r))).toBe(true);
  });
});

describe('compile() — exception (VALID, not a contradiction)', () => {
  it('«شمال الرياض إلا حي النرجس» → include north + exclude narjis in one group', () => {
    const { preference, needs_confirm } = compile(F_exception.evidence, F_exception.relations);
    expect(needs_confirm).toBe(false);
    expect(preference.groups).toHaveLength(1);
    const g = preference.groups[0]!;
    const include = g.clauses.filter((c) => c.op === 'include');
    const exclude = g.clauses.filter((c) => c.op === 'exclude');
    expect(include).toHaveLength(1);
    expect(exclude).toHaveLength(1);
    expect(include[0]!.anyOf[0]!.geometry_id).toBe(G('north_riyadh'));
    expect(exclude[0]!.anyOf[0]!.geometry_id).toBe(G('ex_narjis'));
    // The include and exclude target DIFFERENT geometries → not a self-contradiction.
    expect(include[0]!.anyOf[0]!.geometry_id).not.toBe(exclude[0]!.anyOf[0]!.geometry_id);
  });

  it('is satisfiable against a universe where north minus narjis still has cells', () => {
    const { preference } = compile(F_exception.evidence, F_exception.relations);
    const universe = makeUniverse({
      universe: ['n1', 'n2', 'n3', 'n4'],
      cells: { [G('north_riyadh')]: ['n1', 'n2', 'n3', 'n4'], [G('ex_narjis')]: ['n2'] },
      inventory: { n1: 1, n3: 2, n4: 1 },
    });
    expect(classify(preference, universe)).toBe('satisfiable');
  });
});

describe('compile() — ranked_alternative', () => {
  it('«المهدية أول … فالجبيلة» → two groups, primary then fallback, ranked', () => {
    const { preference, needs_confirm } = compile(F_ranked.evidence, F_ranked.relations);
    expect(needs_confirm).toBe(false);
    expect(preference.groups).toHaveLength(2);
    const [g1, g2] = preference.groups;
    expect(g1!.role).toBe('primary');
    expect(g1!.priority).toBe(1);
    expect(g1!.strength).toBe('hard'); // mahdiyah explicit_force
    expect(g1!.clauses[0]!.anyOf[0]!.geometry_id).toBe(G('mahdiyah'));
    expect(g2!.role).toBe('fallback');
    expect(g2!.priority).toBe(2);
    expect(g2!.strength).toBe('soft'); // jubaila implied
    expect(g2!.clauses[0]!.anyOf[0]!.geometry_id).toBe(G('jubaila'));
  });
});

describe('compile() — nested exception over any_of (depth 2)', () => {
  it('«(النرجس أو العارض) بس مو قريب الدائري» → one group: (narjis∨ard) ∧ ¬ring', () => {
    const { preference, needs_confirm } = compile(F_nested.evidence, F_nested.relations);
    expect(needs_confirm).toBe(false);
    expect(preference.groups).toHaveLength(1);
    const g = preference.groups[0]!;
    const include = g.clauses.filter((c) => c.op === 'include');
    const exclude = g.clauses.filter((c) => c.op === 'exclude');
    expect(include).toHaveLength(1);
    expect(include[0]!.anyOf.map((a) => a.geometry_id).sort()).toEqual([G('n_ard'), G('n_narjis')]);
    expect(exclude).toHaveLength(1);
    expect(exclude[0]!.anyOf[0]!.geometry_id).toBe(G('ring'));
  });
});

describe('compile() — depth-3 nesting is refused (needs_confirm), never throws', () => {
  it('returns needs_confirm=true with a depth reason and does not throw', () => {
    let result!: ReturnType<typeof compile>;
    expect(() => {
      result = compile(F_depth3.evidence, F_depth3.relations);
    }).not.toThrow();
    expect(result.needs_confirm).toBe(true);
    expect(result.reasons.some((r) => /depth/.test(r))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DAG validation — a few more violation modes (all ⇒ needs_confirm, no throw)
// ────────────────────────────────────────────────────────────────────────────

describe('compile() — DAG validation violations set needs_confirm without throwing', () => {
  it('flags an ambiguous parent (one evidence owned by two relations)', () => {
    const evidence = [ev('a'), ev('b'), ev('c')];
    const relations: EvidenceRelation[] = [
      { id: 'r1', relation: 'any_of', members: [{ type: 'evidence', id: 'a' }, { type: 'evidence', id: 'b' }], source_span: '', explicit_or_inferred: 'explicit' },
      { id: 'r2', relation: 'any_of', members: [{ type: 'evidence', id: 'b' }, { type: 'evidence', id: 'c' }], source_span: '', explicit_or_inferred: 'explicit' },
    ];
    const res = compile(evidence, relations);
    expect(res.needs_confirm).toBe(true);
    expect(res.reasons.some((r) => /ambiguous parent/.test(r))).toBe(true);
  });

  it('flags a cycle', () => {
    const evidence = [ev('a'), ev('b')];
    const relations: EvidenceRelation[] = [
      { id: 'r1', relation: 'any_of', members: [{ type: 'relation', id: 'r2' }, { type: 'evidence', id: 'a' }], source_span: '', explicit_or_inferred: 'explicit' },
      { id: 'r2', relation: 'any_of', members: [{ type: 'relation', id: 'r1' }, { type: 'evidence', id: 'b' }], source_span: '', explicit_or_inferred: 'explicit' },
    ];
    let res!: ReturnType<typeof compile>;
    expect(() => { res = compile(evidence, relations); }).not.toThrow();
    expect(res.needs_confirm).toBe(true);
    expect(res.reasons.some((r) => /cycle/.test(r))).toBe(true);
  });

  it('flags wrong arity (any_of with a single member)', () => {
    const evidence = [ev('a')];
    const relations: EvidenceRelation[] = [
      { id: 'r1', relation: 'any_of', members: [{ type: 'evidence', id: 'a' }], source_span: '', explicit_or_inferred: 'explicit' },
    ];
    const res = compile(evidence, relations);
    expect(res.needs_confirm).toBe(true);
    expect(res.reasons.some((r) => /needs ≥2/.test(r))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Active-preference gate
// ────────────────────────────────────────────────────────────────────────────

describe('compile() — only active preferences contribute', () => {
  it('drops an inactive (non-buyer / exploratory) member of an any_of', () => {
    const evidence = [ev('keep', { hardness: 'explicit_force' }), ev('drop', { active: false })];
    const relations: EvidenceRelation[] = [
      { id: 'r1', relation: 'any_of', members: [{ type: 'evidence', id: 'keep' }, { type: 'evidence', id: 'drop' }], source_span: '', explicit_or_inferred: 'explicit' },
    ];
    const { preference } = compile(evidence, relations);
    const ids = preference.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf.map((a) => a.geometry_id)));
    expect(ids).toContain(G('keep'));
    expect(ids).not.toContain(G('drop'));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PROPERTY: compile() ≡ referenceInterpreter() on the valid fixture set
// ────────────────────────────────────────────────────────────────────────────

describe('PROPERTY: compiler and reference interpreter agree (same DNF)', () => {
  for (const f of VALID_FIXTURES) {
    it(`equivalent DNF for: ${f.label}`, () => {
      const compiled = compile(f.evidence, f.relations);
      const reference = interpret(f.evidence, f.relations);
      const compiledKeys = dnfKeySet(compilerDnf(compiled.preference));
      const referenceKeys = dnfKeySet(reference.dnf);
      expect(compiledKeys).toEqual(referenceKeys);
    });
  }

  it('preserves ranking order for the ranked_alternative fixture', () => {
    const compiled = compile(F_ranked.evidence, F_ranked.relations);
    const reference = interpret(F_ranked.evidence, F_ranked.relations);
    // primary term is the same on both sides, in first position
    const compiledFirst = termKey(compilerDnf(compiled.preference)[0]!);
    const referenceFirst = termKey(reference.branches[0]!.dnf[0]!);
    expect(compiledFirst).toBe(referenceFirst);
    expect(compiledFirst).toBe(`+${G('mahdiyah')}`);
    expect(compiled.preference.groups[0]!.role).toBe('primary');
    expect(reference.branches[0]!.role).toBe('primary');
  });

  it('agrees on group strength (hard/soft) for every valid fixture', () => {
    for (const f of VALID_FIXTURES) {
      const compiled = compile(f.evidence, f.relations);
      const reference = interpret(f.evidence, f.relations);
      const compiledStrengths = compiled.preference.groups.map((g) => g.strength);
      const referenceStrengths = reference.branches.map((b) => b.strength);
      // reference may split one factored group into several DNF branches, so
      // compare the SET of strengths present, not posit-by-position.
      expect(new Set(compiledStrengths)).toEqual(new Set(referenceStrengths));
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// satisfiability.classify() — the four flags
// ────────────────────────────────────────────────────────────────────────────

function makeUniverse(spec: {
  universe: string[];
  cells: Record<string, string[]>;
  inventory: Record<string, number>;
  narrowThreshold?: number;
}): SatUniverse {
  return {
    universe: spec.universe,
    narrowThreshold: spec.narrowThreshold,
    cellsOf: (id) => spec.cells[id] ?? [],
    inventoryIn: (cells) => {
      let n = 0;
      for (const c of cells) n += spec.inventory[c] ?? 0;
      return n;
    },
  };
}

// A single active explicit_force positive evidence → one hard group.
function hardSingle(id: string): GeoPreference {
  return compile([ev(id, { hardness: 'explicit_force' })], []).preference;
}

describe('satisfiability.classify()', () => {
  it('satisfiable — non-empty eligible set with inventory, above the narrow threshold', () => {
    const pref = hardSingle('area');
    const universe = makeUniverse({
      universe: ['c1', 'c2', 'c3', 'c4'],
      cells: { [G('area')]: ['c1', 'c2', 'c3', 'c4'] },
      inventory: { c1: 1, c2: 1 },
    });
    expect(classify(pref, universe)).toBe('satisfiable');
  });

  it('unsatisfiable_expression — an include fully cancelled by an exclusion', () => {
    // include(small) ∧ exclude(big ⊇ small) ⇒ empty eligible set.
    const pref = compile(
      [ev('small', { hardness: 'explicit_force' }), ev('big', { role: 'negative', hardness: 'explicit_force' })],
      [
        {
          id: 'r', relation: 'exception',
          members: [{ type: 'evidence', id: 'big' }],
          target: { type: 'evidence', id: 'small' },
          source_span: '', explicit_or_inferred: 'explicit',
        },
      ],
    ).preference;
    const universe = makeUniverse({
      universe: ['c1', 'c2'],
      cells: { [G('small')]: ['c1'], [G('big')]: ['c1', 'c2'] },
      inventory: { c1: 5, c2: 5 },
    });
    expect(classify(pref, universe)).toBe('unsatisfiable_expression');
  });

  it('spatially_narrow — a small area is satisfiable, NOT unsatisfiable', () => {
    const pref = hardSingle('tiny');
    const universe = makeUniverse({
      universe: ['c1', 'c2', 'c3'],
      cells: { [G('tiny')]: ['c1'] },
      inventory: { c1: 3 },
      narrowThreshold: 2,
    });
    expect(classify(pref, universe)).toBe('spatially_narrow');
  });

  it('no_current_inventory — eligible area exists but nothing is available', () => {
    const pref = hardSingle('empty_stock');
    const universe = makeUniverse({
      universe: ['c1', 'c2', 'c3', 'c4'],
      cells: { [G('empty_stock')]: ['c1', 'c2', 'c3', 'c4'] },
      inventory: {}, // zero everywhere
    });
    expect(classify(pref, universe)).toBe('no_current_inventory');
  });

  it('all-soft preference imposes no hard filter → whole universe is eligible', () => {
    // ranked fixture: group1 hard (mahdiyah), so make a purely-soft one instead.
    const pref = compile([ev('soft_area', { hardness: 'none' })], []).preference;
    expect(pref.groups[0]!.strength).toBe('soft');
    const universe = makeUniverse({
      universe: ['c1', 'c2', 'c3', 'c4', 'c5'],
      cells: { [G('soft_area')]: ['c1'] }, // ignored for eligibility (soft)
      inventory: { c3: 1 },
    });
    // no hard group ⇒ eligible = universe (5 cells) with inventory ⇒ satisfiable
    expect(classify(pref, universe)).toBe('satisfiable');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Reference interpreter direct checks (independent DNF shape)
// ────────────────────────────────────────────────────────────────────────────

describe('referenceInterpreter — DNF normalization', () => {
  it('expands exception-over-any_of into DNF: (a∧¬ring) ∨ (b∧¬ring)', () => {
    const r = interpret(F_nested.evidence, F_nested.relations);
    expect(dnfKeySet(r.dnf)).toEqual(
      [
        [`+${G('n_narjis')}`, `-${G('ring')}`].sort().join('&'),
        [`+${G('n_ard')}`, `-${G('ring')}`].sort().join('&'),
      ].sort(),
    );
  });

  it('any_of stays a two-term disjunction', () => {
    const r = interpret(F_any_of.evidence, F_any_of.relations);
    expect(dnfKeySet(r.dnf)).toEqual([`+${G('ard')}`, `+${G('narjis')}`].sort());
  });
});
