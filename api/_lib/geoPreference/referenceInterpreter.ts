/**
 * Reference interpreter for the v7 geo-preference spec — an INDEPENDENT second
 * implementation used only to establish a canonical answer key for evaluation.
 *
 * It deliberately does NOT import `compiler.ts`. Where the compiler keeps the
 * expression factored ((A ∨ B) ∧ ¬C in one group with `anyOf`/`exclude`
 * clauses), this module normalizes straight to **disjunctive normal form**: a
 * disjunction of conjunctive terms of signed literals. Two structurally
 * different code paths that must agree on meaning — that is the point.
 *
 * The only thing shared with the compiler is the ontology contract (types +
 * `isActivePreference`) and the geometry-id CONVENTION (`geo:<evidence id>`),
 * which is a data convention, not shared code.
 *
 * Pure. Reads no database, writes to no client record.
 */

import {
  isActivePreference,
  type Evidence,
  type EvidenceRelation,
  type RelationMemberRef,
  type GeoPreference,
  type GeoGroup,
} from './ontology.js';

export const REFERENCE_SCHEMA_VERSION = 'geo-pref/v7';

/** Same convention the compiler uses — independently derived, not imported. */
export function referenceGeometryId(evidenceId: string): string {
  return `geo:${evidenceId}`;
}

export interface Literal {
  geometry_id: string;
  negated: boolean;
}
/** A conjunction of literals. */
export type Term = Literal[];
/** Disjunctive normal form: OR of {@link Term}s. */
export type Dnf = Term[];

export interface ReferenceBranch {
  role: 'primary' | 'alternative' | 'fallback';
  strength: 'hard' | 'soft';
  priority: number;
  dnf: Dnf;
}

export interface ReferenceExpression {
  schema_version: string;
  /** Ranked branches (priority order). OR across branches = ranked alternatives. */
  branches: ReferenceBranch[];
  /** Flat union of every branch's terms — the canonical DNF of the whole thing. */
  dnf: Dnf;
  /** A GeoPreference emitted DNF-natively (one group per term) for parity. */
  preference: GeoPreference;
}

/** Normalize adjudicated evidence + relations to DNF and ranked branches. */
export function interpret(evidence: Evidence[], relations: EvidenceRelation[]): ReferenceExpression {
  const evById = new Map<string, Evidence>();
  for (const e of evidence) evById.set(e.id, e);
  const relById = new Map<string, EvidenceRelation>();
  for (const r of relations) relById.set(r.id, r);

  const active = new Set<string>();
  for (const e of evidence) if (isActivePreference(e)) active.add(e.id);

  const ctx: RefCtx = { evById, relById, active };

  // Top level = anything no relation owns.
  const owned = new Set<string>();
  for (const r of relations) {
    for (const ref of [...r.members, ...(r.target ? [r.target] : [])]) owned.add(`${ref.type}:${ref.id}`);
  }
  const topItems: RelationMemberRef[] = [];
  for (const r of relations) if (!owned.has(`relation:${r.id}`)) topItems.push({ type: 'relation', id: r.id });
  for (const e of evidence) {
    if (active.has(e.id) && !owned.has(`evidence:${e.id}`)) topItems.push({ type: 'evidence', id: e.id });
  }

  const branches: ReferenceBranch[] = [];
  for (const item of topItems) branches.push(...branchesOf(item, ctx));

  // Global priority, single primary.
  branches.forEach((b, i) => {
    b.priority = i + 1;
  });
  let primarySeen = false;
  for (const b of branches) {
    if (b.role === 'primary') {
      if (primarySeen) b.role = 'alternative';
      else primarySeen = true;
    }
  }
  if (!primarySeen && branches.length) branches[0]!.role = 'primary';

  const flat: Dnf = [];
  for (const b of branches) for (const t of b.dnf) flat.push(t);

  return {
    schema_version: REFERENCE_SCHEMA_VERSION,
    branches,
    dnf: dedupeDnf(flat),
    preference: toPreference(branches),
  };
}

interface RefCtx {
  evById: Map<string, Evidence>;
  relById: Map<string, EvidenceRelation>;
  active: Set<string>;
}

/** A top-level item → ranked branches. Only ranked/comparison fan out. */
function branchesOf(ref: RelationMemberRef, ctx: RefCtx): ReferenceBranch[] {
  if (ref.type === 'relation') {
    const r = ctx.relById.get(ref.id);
    if (!r) return [];
    if (r.relation === 'ranked_alternative') {
      const order = r.ordering && r.ordering.length ? r.ordering : r.members;
      const out: ReferenceBranch[] = [];
      order.forEach((m, i) => {
        const dnf = dnfOf(m, ctx);
        if (!dnf.length) return;
        out.push({ role: i === 0 ? 'primary' : 'fallback', strength: strengthOf(m, ctx), priority: i + 1, dnf });
      });
      return out;
    }
    if (r.relation === 'comparison') {
      const out: ReferenceBranch[] = [];
      r.members.forEach((m, i) => {
        const dnf = dnfOf(m, ctx);
        if (!dnf.length) return;
        // commitment 'considered' ⇒ never hard.
        out.push({ role: 'alternative', strength: 'soft', priority: i + 1, dnf });
      });
      return out;
    }
  }
  const dnf = dnfOf(ref, ctx);
  if (!dnf.length) return [];
  return [{ role: 'primary', strength: strengthOf(ref, ctx), priority: 1, dnf }];
}

/** Boolean → DNF, computed bottom-up via ∧/∨ on term lists. */
function dnfOf(ref: RelationMemberRef, ctx: RefCtx): Dnf {
  if (ref.type === 'evidence') {
    const e = ctx.evById.get(ref.id);
    if (!e || !ctx.active.has(e.id)) return [];
    const negated = e.preference_role === 'negative';
    return [[{ geometry_id: referenceGeometryId(e.id), negated }]];
  }
  const r = ctx.relById.get(ref.id);
  if (!r) return [];

  switch (r.relation) {
    case 'any_of': {
      // OR: concatenate the members' term lists.
      const out: Dnf = [];
      for (const m of r.members) for (const t of dnfOf(m, ctx)) out.push(t);
      return dedupeDnf(out);
    }
    case 'all_of': {
      // AND across members: distribute.
      let acc: Dnf = [[]];
      for (const m of r.members) {
        const d = dnfOf(m, ctx);
        if (!d.length) continue; // an inactive/empty member drops out of the AND
        acc = andDnf(acc, d);
      }
      return dedupeDnf(acc);
    }
    case 'exception': {
      const base = r.target ? dnfOf(r.target, ctx) : [[]];
      // Build ¬x ∧ ¬y … as a single conjunctive term, then AND it in.
      const neg: Term = [];
      for (const m of r.members) {
        for (const t of dnfOf(m, ctx)) {
          for (const lit of t) neg.push({ geometry_id: lit.geometry_id, negated: true });
        }
      }
      const negDnf: Dnf = neg.length ? [neg] : [[]];
      return dedupeDnf(andDnf(base.length ? base : [[]], negDnf));
    }
    case 'ranked_alternative':
    case 'comparison':
      // Nested where a scalar DNF was expected (only on an invalid DAG). Fold
      // the first member so the reference still yields SOMETHING to compare.
      return r.members.length ? dnfOf(r.members[0]!, ctx) : [];
    default:
      return [];
  }
}

/** Cartesian AND of two DNFs. */
function andDnf(a: Dnf, b: Dnf): Dnf {
  const out: Dnf = [];
  for (const ta of a) {
    for (const tb of b) out.push([...ta, ...tb]);
  }
  return out;
}

/** Strength: hard iff every positive contributing literal is explicit_force. */
function strengthOf(ref: RelationMemberRef, ctx: RefCtx): 'hard' | 'soft' {
  const positives: Evidence[] = [];
  const walk = (rf: RelationMemberRef) => {
    if (rf.type === 'evidence') {
      const e = ctx.evById.get(rf.id);
      if (e && ctx.active.has(e.id) && e.preference_role === 'positive') positives.push(e);
      return;
    }
    const r = ctx.relById.get(rf.id);
    if (!r) return;
    if (r.relation === 'exception') {
      if (r.target) walk(r.target);
      return;
    }
    for (const m of r.members) walk(m);
  };
  walk(ref);
  if (!positives.length) return 'soft';
  return positives.every((e) => e.hardness_evidence === 'explicit_force') ? 'hard' : 'soft';
}

/** Canonical key for a term: signed geometry ids, sorted. */
export function termKey(t: Term): string {
  const lits = t.map((l) => `${l.negated ? '-' : '+'}${l.geometry_id}`);
  lits.sort();
  // collapse duplicate literals inside a term
  return Array.from(new Set(lits)).join('&');
}

function dedupeDnf(d: Dnf): Dnf {
  const seen = new Set<string>();
  const out: Dnf = [];
  for (const t of d) {
    const k = termKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    // rebuild the term from the canonical key so duplicate literals are dropped
    const lits: Term = k
      .split('&')
      .filter((s) => s.length > 0)
      .map((s) => ({ geometry_id: s.slice(1), negated: s[0] === '-' }));
    out.push(lits);
  }
  return out;
}

/** Emit a GeoPreference DNF-natively: one group per term (OR across groups). */
function toPreference(branches: ReferenceBranch[]): GeoPreference {
  const groups: GeoGroup[] = [];
  let priority = 1;
  branches.forEach((b, bi) => {
    b.dnf.forEach((term, ti) => {
      groups.push({
        id: `rg${bi + 1}_${ti + 1}`,
        role: b.role,
        strength: b.strength,
        priority: priority++,
        clauses: term.map((lit) => ({
          op: lit.negated ? 'exclude' : 'include',
          anyOf: [{ geometry_id: lit.geometry_id, recipe: stubRecipe() }],
        })),
      });
    });
  });
  return { schema_version: REFERENCE_SCHEMA_VERSION, groups };
}

function stubRecipe() {
  return {
    operation: 'district_polygon' as const,
    source_anchors: [],
    resolved_element_ids: [] as string[],
    universe_source: 'unknown' as const,
    geo_data_version: 'stub',
    resolver_version: 'reference@v7',
    compiled_at: '',
  };
}

/** Canonical DNF as a sorted set of term keys — the comparison surface. */
export function dnfKeySet(d: Dnf): string[] {
  const keys = d.map(termKey);
  keys.sort();
  return Array.from(new Set(keys));
}
