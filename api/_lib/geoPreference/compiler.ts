/**
 * Boolean preference compiler (v7).
 *
 * Turns adjudicated per-utterance {@link Evidence} + a typed {@link EvidenceRelation}
 * DAG into a {@link GeoPreference} Boolean expression (groups = ranked OR, clauses =
 * AND, `anyOf` = OR-within-clause, `op:'exclude'` = NOT).
 *
 * Contract (see the task spec + `ontology.ts`):
 *  - Only evidence with {@link isActivePreference} === true contributes.
 *  - Relations compile as:
 *      any_of             → ONE include clause with an `anyOf` set
 *      all_of             → several AND clauses inside ONE group
 *      ranked_alternative → several groups, ranked by `ordering`
 *      exception          → an `exclude` clause added to the target's group
 *      comparison         → the members as `alternative` groups (commitment
 *                           `considered`, so always soft)
 *  - The typed DAG is validated (acyclic, depth ≤ 2, per-operator arity, single
 *    unambiguous parent). On ANY violation `needs_confirm` is set true and the
 *    function returns a best-effort preference — it NEVER throws.
 *  - Group strength is `hard` ONLY when the contributing evidence carries
 *    `hardness_evidence === 'explicit_force'`. `implied` → `soft` + an advisory
 *    reason ("needs confirmation to harden"); `none` → `soft`.
 *
 * This module is PURE. It reads no database and writes to no client record.
 */

import {
  isActivePreference,
  type Evidence,
  type EvidenceRelation,
  type RelationMemberRef,
  type GeoPreference,
  type GeoGroup,
  type GeoClause,
  type AnchorRef,
  type GeometryRecipe,
  type GeoOperation,
  type AnchorToken,
  type Polarity,
} from './ontology';

export const COMPILER_SCHEMA_VERSION = 'geo-pref/v7';
const RESOLVER_VERSION = 'compiler@v7';
const GEO_DATA_VERSION = 'stub';
/** Deterministic sentinel so two compile() runs (and compiler-vs-reference) agree. */
const COMPILED_AT = '';
/** Maximum relation-nesting depth the compiler will accept without confirmation. */
export const MAX_RELATION_DEPTH = 2;

export interface CompileResult {
  preference: GeoPreference;
  needs_confirm: boolean;
  reasons: string[];
}

/**
 * Compile adjudicated evidence + relations into a Boolean {@link GeoPreference}.
 * Never throws — structural problems surface as `needs_confirm` + reasons.
 */
export function compile(evidence: Evidence[], relations: EvidenceRelation[]): CompileResult {
  const violationReasons: string[] = [];
  const adviceReasons: string[] = [];

  const evById = new Map<string, Evidence>();
  for (const e of evidence) evById.set(e.id, e);
  const relById = new Map<string, EvidenceRelation>();
  for (const r of relations) relById.set(r.id, r);

  // Active-preference gate (v7): grammar/tense never decide, semantics do.
  const activeIds = new Set<string>();
  for (const e of evidence) if (isActivePreference(e)) activeIds.add(e.id);

  // ── Validate the typed DAG. Any violation ⇒ needs_confirm, no throw. ────────
  validateDag(relations, relById, evById, violationReasons);

  let preference: GeoPreference = { schema_version: COMPILER_SCHEMA_VERSION, groups: [] };
  try {
    preference = build(evidence, relations, relById, evById, activeIds, adviceReasons);
  } catch (err) {
    // Defensive: the validator should have caught structural faults, but a
    // best-effort build must never throw out of compile().
    violationReasons.push(
      `compile_aborted: ${(err as Error)?.message ?? 'unknown error'} — manual review required`,
    );
    preference = { schema_version: COMPILER_SCHEMA_VERSION, groups: [] };
  }

  return {
    preference,
    needs_confirm: violationReasons.length > 0,
    reasons: [...violationReasons, ...adviceReasons],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// DAG validation
// ────────────────────────────────────────────────────────────────────────────

/** Every child ref a relation owns (members ∪ target). ordering ⊆ members. */
function childRefs(r: EvidenceRelation): RelationMemberRef[] {
  const refs: RelationMemberRef[] = [...r.members];
  if (r.target) refs.push(r.target);
  return refs;
}

function refExists(
  ref: RelationMemberRef,
  relById: Map<string, EvidenceRelation>,
  evById: Map<string, Evidence>,
): boolean {
  return ref.type === 'relation' ? relById.has(ref.id) : evById.has(ref.id);
}

function validateDag(
  relations: EvidenceRelation[],
  relById: Map<string, EvidenceRelation>,
  evById: Map<string, Evidence>,
  reasons: string[],
): void {
  // 1. Per-operator arity + references exist.
  for (const r of relations) {
    for (const ref of childRefs(r)) {
      if (!refExists(ref, relById, evById)) {
        reasons.push(`relation ${r.id}: references unknown ${ref.type} ${ref.id}`);
      }
    }
    switch (r.relation) {
      case 'any_of':
      case 'all_of':
      case 'comparison':
        if (r.members.length < 2) {
          reasons.push(`relation ${r.id} (${r.relation}): needs ≥2 members, has ${r.members.length}`);
        }
        break;
      case 'ranked_alternative':
        if (r.members.length < 2) {
          reasons.push(`relation ${r.id} (ranked_alternative): needs ≥2 members, has ${r.members.length}`);
        }
        if (!r.ordering || r.ordering.length !== r.members.length) {
          reasons.push(`relation ${r.id} (ranked_alternative): ordering must rank every member`);
        } else {
          const memberKeys = new Set(r.members.map((m) => `${m.type}:${m.id}`));
          for (const o of r.ordering) {
            if (!memberKeys.has(`${o.type}:${o.id}`)) {
              reasons.push(`relation ${r.id} (ranked_alternative): ordering ref ${o.id} is not a member`);
            }
          }
        }
        break;
      case 'exception':
        if (!r.target) reasons.push(`relation ${r.id} (exception): missing target to except FROM`);
        if (r.members.length < 1) {
          reasons.push(`relation ${r.id} (exception): needs ≥1 excepted member`);
        }
        break;
    }
  }

  // 2. Single unambiguous parent: no child owned by two relations.
  const parentOf = new Map<string, string>();
  for (const r of relations) {
    const seen = new Set<string>();
    for (const ref of childRefs(r)) {
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) continue; // ordering/target overlap within one relation is fine
      seen.add(key);
      const existing = parentOf.get(key);
      if (existing && existing !== r.id) {
        reasons.push(`ambiguous parent: ${ref.type} ${ref.id} is claimed by relations ${existing} and ${r.id}`);
      } else {
        parentOf.set(key, r.id);
      }
    }
  }

  // 3. Acyclicity + depth ≤ MAX_RELATION_DEPTH, measured from each top-level relation.
  const childrenIds = new Set<string>();
  for (const r of relations) {
    for (const ref of childRefs(r)) if (ref.type === 'relation') childrenIds.add(ref.id);
  }
  const topRelations = relations.filter((r) => !childrenIds.has(r.id));

  const depthCache = new Map<string, number>();
  const reportedCycle = new Set<string>();
  const depthOf = (ref: RelationMemberRef, stack: Set<string>): number => {
    if (ref.type === 'evidence') return 0;
    const r = relById.get(ref.id);
    if (!r) return 0; // unknown ref already reported above
    if (stack.has(r.id)) {
      if (!reportedCycle.has(r.id)) {
        reportedCycle.add(r.id);
        reasons.push(`cycle detected through relation ${r.id}`);
      }
      return Number.POSITIVE_INFINITY;
    }
    const cached = depthCache.get(r.id);
    if (cached !== undefined) return cached;
    stack.add(r.id);
    let maxChild = 0;
    for (const c of childRefs(r)) maxChild = Math.max(maxChild, depthOf(c, stack));
    stack.delete(r.id);
    const d = 1 + maxChild;
    if (Number.isFinite(d)) depthCache.set(r.id, d);
    return d;
  };

  for (const r of topRelations) {
    const d = depthOf({ type: 'relation', id: r.id }, new Set<string>());
    if (Number.isFinite(d) && d > MAX_RELATION_DEPTH) {
      reasons.push(`relation ${r.id}: nesting depth ${d} exceeds max ${MAX_RELATION_DEPTH} — manual review required`);
    }
  }
  // A pure cycle has NO top-level relation, so the loop above never enters it.
  // Sweep any relation not yet reached to catch such cycles.
  for (const r of relations) {
    if (!depthCache.has(r.id) && !reportedCycle.has(r.id)) {
      depthOf({ type: 'relation', id: r.id }, new Set<string>());
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Compilation
// ────────────────────────────────────────────────────────────────────────────

function build(
  evidence: Evidence[],
  relations: EvidenceRelation[],
  relById: Map<string, EvidenceRelation>,
  evById: Map<string, Evidence>,
  activeIds: Set<string>,
  advice: string[],
): GeoPreference {
  // Top level = evidence/relations never owned by any relation.
  const ownedEvidence = new Set<string>();
  const ownedRelations = new Set<string>();
  for (const r of relations) {
    for (const ref of childRefs(r)) {
      if (ref.type === 'relation') ownedRelations.add(ref.id);
      else ownedEvidence.add(ref.id);
    }
  }

  const topItems: RelationMemberRef[] = [];
  for (const r of relations) if (!ownedRelations.has(r.id)) topItems.push({ type: 'relation', id: r.id });
  for (const e of evidence) {
    if (activeIds.has(e.id) && !ownedEvidence.has(e.id)) topItems.push({ type: 'evidence', id: e.id });
  }

  const ctx = { relById, evById, activeIds, advice };
  const groups: GeoGroup[] = [];
  for (const item of topItems) groups.push(...groupsOf(item, ctx));

  // Global priority + a single primary. Preserve sub-compiler roles otherwise.
  let priority = 1;
  let primaryAssigned = false;
  for (const g of groups) {
    g.priority = priority++;
    if (g.role === 'primary') {
      if (primaryAssigned) g.role = 'alternative';
      else primaryAssigned = true;
    }
  }
  if (!primaryAssigned && groups.length > 0) groups[0]!.role = 'primary';

  return { schema_version: COMPILER_SCHEMA_VERSION, groups };
}

interface Ctx {
  relById: Map<string, EvidenceRelation>;
  evById: Map<string, Evidence>;
  activeIds: Set<string>;
  advice: string[];
}

let GROUP_SEQ = 0;
function nextGroupId(): string {
  GROUP_SEQ += 1;
  return `g${GROUP_SEQ}`;
}

/** A top-level item → one or more groups (ranked_alternative/comparison fan out). */
function groupsOf(ref: RelationMemberRef, ctx: Ctx): GeoGroup[] {
  if (ref.type === 'relation') {
    const r = ctx.relById.get(ref.id);
    if (!r) return [];
    if (r.relation === 'ranked_alternative') return rankedGroups(r, ctx);
    if (r.relation === 'comparison') return comparisonGroups(r, ctx);
  }
  // any_of / all_of / exception / bare evidence → a single group.
  const clauses = clausesOf(ref, ctx);
  if (clauses.length === 0) return [];
  return [
    {
      id: nextGroupId(),
      role: 'primary',
      strength: strengthOf(includeEvidenceOf(ref, ctx), ctx),
      priority: 1,
      clauses,
    },
  ];
}

function rankedGroups(r: EvidenceRelation, ctx: Ctx): GeoGroup[] {
  const order = r.ordering && r.ordering.length ? r.ordering : r.members;
  const out: GeoGroup[] = [];
  order.forEach((ref, i) => {
    const clauses = clausesOf(ref, ctx);
    if (clauses.length === 0) return;
    out.push({
      id: nextGroupId(),
      role: i === 0 ? 'primary' : 'fallback',
      strength: strengthOf(includeEvidenceOf(ref, ctx), ctx),
      priority: i + 1,
      clauses,
    });
  });
  return out;
}

function comparisonGroups(r: EvidenceRelation, ctx: Ctx): GeoGroup[] {
  ctx.advice.push(
    `relation ${r.id} (comparison): members emitted as 'considered' alternatives (soft) — not committed preferences`,
  );
  const out: GeoGroup[] = [];
  r.members.forEach((ref, i) => {
    const clauses = clausesOf(ref, ctx);
    if (clauses.length === 0) return;
    out.push({
      id: nextGroupId(),
      role: 'alternative',
      strength: 'soft', // commitment 'considered' is never an eligibility filter
      priority: i + 1,
      clauses,
    });
  });
  return out;
}

/**
 * Flatten a ref into the clauses of ONE group.
 *  evidence  → one clause (include|exclude by preference_role)
 *  any_of    → one include clause, anyOf = each active member's geometry
 *  all_of    → the members' clauses concatenated (AND)
 *  exception → target's clauses + one exclude clause per excepted member
 */
function clausesOf(ref: RelationMemberRef, ctx: Ctx): GeoClause[] {
  if (ref.type === 'evidence') {
    const e = ctx.evById.get(ref.id);
    if (!e || !ctx.activeIds.has(e.id)) return [];
    return [{ op: polarityOf(e), anyOf: [anchorRefOf(e)] }];
  }
  const r = ctx.relById.get(ref.id);
  if (!r) return [];

  switch (r.relation) {
    case 'any_of': {
      const refs: AnchorRef[] = [];
      for (const m of r.members) {
        if (m.type !== 'evidence') continue;
        const e = ctx.evById.get(m.id);
        if (e && ctx.activeIds.has(e.id)) refs.push(anchorRefOf(e));
      }
      if (refs.length === 0) return [];
      // any_of members are alternatives for the SAME positive slot ⇒ include.
      return [{ op: 'include', anyOf: refs }];
    }
    case 'all_of': {
      const clauses: GeoClause[] = [];
      for (const m of r.members) clauses.push(...clausesOf(m, ctx));
      return clauses;
    }
    case 'exception': {
      const base = r.target ? clausesOf(r.target, ctx) : [];
      const excludes: GeoClause[] = [];
      for (const m of r.members) {
        if (m.type === 'evidence') {
          const e = ctx.evById.get(m.id);
          if (e && ctx.activeIds.has(e.id)) excludes.push({ op: 'exclude', anyOf: [anchorRefOf(e)] });
        } else {
          // an excepted sub-expression: exclude each of its include anchors
          for (const c of clausesOf(m, ctx)) excludes.push({ op: 'exclude', anyOf: c.anyOf });
        }
      }
      return [...base, ...excludes];
    }
    case 'ranked_alternative':
    case 'comparison':
      // Only reachable on an invalid (depth-violating) DAG; needs_confirm is
      // already set. Best-effort: fold the first member's clauses in.
      ctx.advice.push(`relation ${r.id} (${r.relation}) nested where a single group was expected — folded first member`);
      return r.members.length ? clausesOf(r.members[0]!, ctx) : [];
    default:
      return [];
  }
}

/** The active include-evidence a ref rests on — drives group strength. */
function includeEvidenceOf(ref: RelationMemberRef, ctx: Ctx): Evidence[] {
  const out: Evidence[] = [];
  const walk = (rf: RelationMemberRef) => {
    if (rf.type === 'evidence') {
      const e = ctx.evById.get(rf.id);
      if (e && ctx.activeIds.has(e.id) && e.preference_role === 'positive') out.push(e);
      return;
    }
    const r = ctx.relById.get(rf.id);
    if (!r) return;
    if (r.relation === 'exception') {
      if (r.target) walk(r.target); // strength from what's kept, not what's excepted
      return;
    }
    for (const m of r.members) walk(m);
  };
  walk(ref);
  return out;
}

function strengthOf(includeEvidence: Evidence[], ctx: Ctx): 'hard' | 'soft' {
  if (includeEvidence.length === 0) return 'soft';
  let allExplicit = true;
  let anyImplied = false;
  for (const e of includeEvidence) {
    if (e.hardness_evidence !== 'explicit_force') allExplicit = false;
    if (e.hardness_evidence === 'implied') anyImplied = true;
  }
  if (allExplicit) return 'hard';
  if (anyImplied) {
    ctx.advice.push(
      `hardness 'implied' present — group kept soft; needs customer confirmation to harden into an eligibility filter`,
    );
  }
  return 'soft';
}

function polarityOf(e: Evidence): Polarity {
  return e.preference_role === 'negative' ? 'exclude' : 'include';
}

// ────────────────────────────────────────────────────────────────────────────
// Anchor → geometry stub. The real resolver (client_pref_geometry) is a
// separate component; the compiler emits a deterministic, recomputable recipe
// keyed by evidence id so satisfiability's injected universe can address it.
// ────────────────────────────────────────────────────────────────────────────

export function anchorRefOf(e: Evidence): AnchorRef {
  return { geometry_id: geometryIdOf(e), recipe: recipeOf(e) };
}

export function geometryIdOf(e: Evidence): string {
  return `geo:${e.id}`;
}

function recipeOf(e: Evidence): GeometryRecipe {
  return {
    operation: operationFor(e.anchors),
    source_anchors: e.anchors,
    resolved_element_ids: e.anchors.map((a) => a.normalized_token),
    universe_source: 'unknown',
    geo_data_version: GEO_DATA_VERSION,
    resolver_version: RESOLVER_VERSION,
    compiled_at: COMPILED_AT,
  };
}

/** Heuristic operation from anchor mix — structural only; the resolver refines. */
function operationFor(anchors: AnchorToken[]): GeoOperation {
  const types = new Set(anchors.map((a) => a.anchor_type));
  if (types.has('pin')) return 'pin_point';
  if (types.has('direction')) return 'directional_band';
  if (types.has('landmark')) return 'within_radius';
  if (types.has('road')) return 'corridor';
  const areaCount = anchors.filter((a) =>
    a.anchor_type === 'district' || a.anchor_type === 'city' || a.anchor_type === 'region' || a.anchor_type === 'town',
  ).length;
  if (areaCount > 1) return 'district_union';
  return 'district_polygon';
}
