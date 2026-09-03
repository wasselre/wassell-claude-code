/**
 * Geography Understanding Ability — the three-artifact evaluation harness.
 *
 * Every evaluated turn is compared across THREE artifacts, all keyed on the
 * ontology (./ontology.ts):
 *
 *   1. gold_evidence_and_relations   — the INPUT truth (what the customer meant),
 *                                       adjudicated Evidence[] + EvidenceRelation[].
 *   2. canonical_expected_expression — an INDEPENDENT answer key: a GeoPreference
 *                                       built by hand / a separate interpreter,
 *                                       NEVER by the production compiler (v7 #3).
 *   3. actual_compiler_output        — the production compiler's GeoPreference,
 *                                       the thing under test.
 *
 * The harness scores artifact 3 against artifact 2 (actual ↔ canonical). Using an
 * independent key — not "did the compiler reproduce its own output" — is what
 * keeps the eval honest. Artifact 1 travels with the datum for stage-level
 * scoring and audit.
 *
 * Two disciplines are enforced in code, not just documented:
 *   • CHECKPOINT granularity (temporal). Every checkpoint is scored on its own,
 *     so a wrong intermediate state — a supersession the system botched mid-
 *     conversation but that happened to self-correct by the last turn — is
 *     caught. `evaluateFinalStateOnly` exists precisely to demonstrate what a
 *     naive last-turn-only eval would MISS.
 *   • FROZEN DEV/TEST split. `FrozenTestGuard.reportOnTest` refuses to run while
 *     the harness is in `tuning` mode. You tune on DEV as much as you like; you
 *     may look at TEST exactly once, after calling `freeze()`. This stops the
 *     slow leak where TEST gets peeked at every iteration and silently becomes a
 *     second dev set.
 *
 * Plain-language version: we grade the robot's map answer against a separately
 * written answer key, not against its own scratch work. We grade every step of
 * the conversation, not just the end — because "right at the end" can hide a
 * dangerous wrong turn in the middle. And we lock the final exam in a drawer:
 * you can practice on the practice set forever, but the real exam is opened once,
 * on purpose, so you can't accidentally study it.
 */

import type {
  Checkpoint, Evidence, EvidenceRelation, GeoPreference, GeoGroup, GateDecision,
} from './ontology.js';
import {
  type ScoredUnit, type Channel, type SevereFlags,
  scored, notApplicable, computeGeoMetrics, type GeoMetricsReport, hasSevere,
} from './metrics.js';

// ────────────────────────────────────────────────────────────────────────────
// Split discipline.
// ────────────────────────────────────────────────────────────────────────────
export type EvalSplit = 'dev' | 'test';

export interface EvalDatum {
  checkpoint: Checkpoint;              // carries actual + canonical expressions, required_handling
  channel: Channel;
  client_id: string;
  /** The confidence gate's decision at this checkpoint (what the system DID). */
  predicted_gate: GateDecision;
  split: EvalSplit;

  /** Artifact 1 — input truth. Optional at the harness layer (used for audit / stage scoring). */
  gold_evidence?: Evidence[];
  gold_relations?: EvidenceRelation[];
  /** Per-stage gold-vs-model judgments, when a full pipeline produced them. */
  stage_scores?: ScoredUnit['stages'];
}

// ────────────────────────────────────────────────────────────────────────────
// Expression comparison — the heart of the harness.
// ────────────────────────────────────────────────────────────────────────────
export interface ExprDiff {
  expression_match: boolean;
  hard_include_mismatch: boolean;
  hard_exclude_mismatch: boolean;
  soft_mismatch: boolean;
  supersession_mismatch: boolean;
  geo_entity_mismatch: boolean;
  city_mismatch: boolean;
  details: string[];
}

const EMPTY_PREF: GeoPreference = { schema_version: 'v0', groups: [] };

/** All geometry_ids in include/exclude clauses of groups matching a strength. */
function geomIds(pref: GeoPreference, strength: 'hard' | 'soft', op: 'include' | 'exclude'): Set<string> {
  const out = new Set<string>();
  for (const g of pref.groups) {
    if (g.strength !== strength) continue;
    for (const c of g.clauses) {
      if (c.op !== op) continue;
      for (const a of c.anyOf) out.add(a.geometry_id);
    }
  }
  return out;
}

/** Every resolved element id referenced by any clause of a given strength (entity-level identity). */
function elementIds(pref: GeoPreference, strength: 'hard' | 'soft'): Set<string> {
  const out = new Set<string>();
  for (const g of pref.groups) {
    if (g.strength !== strength) continue;
    for (const c of g.clauses) {
      for (const a of c.anyOf) {
        for (const el of a.recipe.resolved_element_ids) out.add(el);
      }
    }
  }
  return out;
}

/**
 * Supersession signature: the ordered role/strength/priority skeleton of the
 * expression. A supersession that was handled wrongly shows up here — a dropped
 * alternative, a superseded group left as `primary`, or a priority that never
 * shifted. Ordering is by priority then role so an equivalent expression sorts
 * identically.
 */
function supersessionSignature(pref: GeoPreference): string {
  const rows = pref.groups
    .map((g: GeoGroup) => ({
      role: g.role, strength: g.strength, priority: g.priority,
      inc: [...geomIdsForGroup(g, 'include')].sort().join('|'),
      exc: [...geomIdsForGroup(g, 'exclude')].sort().join('|'),
    }))
    .sort((a, b) => a.priority - b.priority || a.role.localeCompare(b.role) || a.inc.localeCompare(b.inc));
  return JSON.stringify(rows);
}

function geomIdsForGroup(g: GeoGroup, op: 'include' | 'exclude'): Set<string> {
  const out = new Set<string>();
  for (const c of g.clauses) {
    if (c.op !== op) continue;
    for (const a of c.anyOf) out.add(a.geometry_id);
  }
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export interface CompareConfig {
  /** Optional map from a resolved element id to its city, to detect a namesake-district city error. */
  cityOfElement?: (elementId: string) => string | null;
}

/** Compare the actual expression against the independent canonical key. */
export function compareExpressions(
  actual: GeoPreference | undefined,
  canonical: GeoPreference | undefined,
  cfg: CompareConfig = {},
): ExprDiff {
  const a = actual ?? EMPTY_PREF;
  const c = canonical ?? EMPTY_PREF;
  const details: string[] = [];

  const hard_include_mismatch = !setsEqual(geomIds(a, 'hard', 'include'), geomIds(c, 'hard', 'include'));
  if (hard_include_mismatch) details.push('hard include set differs');

  const hard_exclude_mismatch = !setsEqual(geomIds(a, 'hard', 'exclude'), geomIds(c, 'hard', 'exclude'));
  if (hard_exclude_mismatch) details.push('hard exclude set differs');

  const soft_mismatch =
    !setsEqual(geomIds(a, 'soft', 'include'), geomIds(c, 'soft', 'include')) ||
    !setsEqual(geomIds(a, 'soft', 'exclude'), geomIds(c, 'soft', 'exclude'));
  if (soft_mismatch) details.push('soft (ranking) set differs');

  const supersession_mismatch = supersessionSignature(a) !== supersessionSignature(c);
  if (supersession_mismatch) details.push('group role/priority skeleton differs (supersession)');

  const geo_entity_mismatch =
    !setsEqual(elementIds(a, 'hard'), elementIds(c, 'hard')) ||
    !setsEqual(elementIds(a, 'soft'), elementIds(c, 'soft'));
  if (geo_entity_mismatch) details.push('resolved element ids differ (wrong entity)');

  let city_mismatch = false;
  if (cfg.cityOfElement) {
    const cityOf = cfg.cityOfElement;
    const cities = (p: GeoPreference): Set<string> => {
      const s = new Set<string>();
      for (const el of [...elementIds(p, 'hard'), ...elementIds(p, 'soft')]) {
        const city = cityOf(el);
        if (city) s.add(city);
      }
      return s;
    };
    city_mismatch = !setsEqual(cities(a), cities(c));
    if (city_mismatch) details.push('resolved city differs (namesake trap)');
  }

  const expression_match =
    !hard_include_mismatch && !hard_exclude_mismatch && !soft_mismatch &&
    !supersession_mismatch && !geo_entity_mismatch && !city_mismatch;

  return {
    expression_match, hard_include_mismatch, hard_exclude_mismatch, soft_mismatch,
    supersession_mismatch, geo_entity_mismatch, city_mismatch, details,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Datum → ScoredUnit.
// ────────────────────────────────────────────────────────────────────────────
function severeFromDiff(diff: ExprDiff): SevereFlags {
  return {
    wrong_hard_include: diff.hard_include_mismatch,
    wrong_hard_exclude: diff.hard_exclude_mismatch,
    wrong_supersession: diff.supersession_mismatch,
    wrong_city: diff.city_mismatch,
    wrong_geo_entity: diff.geo_entity_mismatch,
  };
}

/** Default per-stage scores derived from the expression diff when a full pipeline
 *  did not supply explicit stage judgments. Only the two stages the expression
 *  comparison can actually observe are marked applicable. */
function stagesFromDiff(diff: ExprDiff): ScoredUnit['stages'] {
  const stages: ScoredUnit['stages'] = {
    mention_detection: notApplicable(),
    interpretation: {
      speech_act: notApplicable(), preference_role: notApplicable(),
      commitment: notApplicable(), holder_role: notApplicable(), applicability: notApplicable(),
    },
    anchor_extraction: notApplicable(),
    entity_resolution: scored(!diff.geo_entity_mismatch && !diff.city_mismatch),
    geometry_construction: scored(!diff.hard_include_mismatch && !diff.hard_exclude_mismatch),
    matching: scored(diff.expression_match),
  };
  return stages;
}

export function scoreCheckpoint(d: EvalDatum, cfg: CompareConfig = {}): { unit: ScoredUnit; diff: ExprDiff } {
  const cp = d.checkpoint;
  const diff = compareExpressions(cp.actual_compiler_output, cp.canonical_expected_expression, cfg);
  const unit: ScoredUnit = {
    id: `${cp.conversation_id}:${cp.turn_id}`,
    client_id: d.client_id,
    channel: d.channel,
    gold_handling: cp.required_handling,
    predicted_gate: d.predicted_gate,
    stages: d.stage_scores ?? stagesFromDiff(diff),
    severe: severeFromDiff(diff),
    final_correct: diff.expression_match,
  };
  return { unit, diff };
}

// ────────────────────────────────────────────────────────────────────────────
// Client-clustered aggregation.
// ────────────────────────────────────────────────────────────────────────────
export interface ClientCluster {
  client_id: string;
  checkpoints: number;
  severe_checkpoints: number;
  written_severe_checkpoints: number; // severe AND auto-written = actual profile corruption
  corrupted: boolean;
}

export interface EvalRun {
  units: ScoredUnit[];
  diffs: Map<string, ExprDiff>;   // keyed by unit id
  clients: ClientCluster[];
  metrics: GeoMetricsReport;
}

function cluster(units: ScoredUnit[]): ClientCluster[] {
  const by = new Map<string, ScoredUnit[]>();
  for (const u of units) {
    const arr = by.get(u.client_id) ?? [];
    arr.push(u);
    by.set(u.client_id, arr);
  }
  const out: ClientCluster[] = [];
  for (const [client_id, us] of by) {
    const severe = us.filter((u) => hasSevere(u.severe));
    const written = severe.filter((u) => u.predicted_gate === 'auto_write');
    out.push({
      client_id,
      checkpoints: us.length,
      severe_checkpoints: severe.length,
      written_severe_checkpoints: written.length,
      corrupted: written.length > 0,
    });
  }
  return out.sort((a, b) => a.client_id.localeCompare(b.client_id));
}

function runEval(data: EvalDatum[], cfg: CompareConfig): EvalRun {
  const units: ScoredUnit[] = [];
  const diffs = new Map<string, ExprDiff>();
  for (const d of data) {
    const { unit, diff } = scoreCheckpoint(d, cfg);
    units.push(unit);
    diffs.set(unit.id, diff);
  }
  return { units, diffs, clients: cluster(units), metrics: computeGeoMetrics(units) };
}

/** Score EVERY checkpoint (the correct, temporal evaluation). */
export function evaluateAllCheckpoints(data: EvalDatum[], cfg: CompareConfig = {}): EvalRun {
  return runEval(data, cfg);
}

/**
 * Score ONLY the last checkpoint of each conversation — the naive "final state"
 * eval. Exposed so tests can demonstrate what it MISSES vs the checkpoint eval.
 * NOT for production reporting.
 */
export function evaluateFinalStateOnly(data: EvalDatum[], cfg: CompareConfig = {}): EvalRun {
  const lastByConv = new Map<string, EvalDatum>();
  for (const d of data) {
    const key = d.checkpoint.conversation_id;
    const prev = lastByConv.get(key);
    if (!prev || d.checkpoint.as_of_timestamp > prev.checkpoint.as_of_timestamp) {
      lastByConv.set(key, d);
    }
  }
  return runEval([...lastByConv.values()], cfg);
}

// ────────────────────────────────────────────────────────────────────────────
// Frozen DEV/TEST guard.
// ────────────────────────────────────────────────────────────────────────────
export class FrozenTestGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrozenTestGuardError';
  }
}

/**
 * Holds the DEV/TEST split discipline. Report on DEV freely; TEST is sealed
 * until `freeze()` is called exactly once, after tuning is finished.
 */
export class FrozenTestGuard {
  private mode: 'tuning' | 'frozen' = 'tuning';
  private testReported = false;
  constructor(private readonly cfg: CompareConfig = {}) {}

  /** Current phase. */
  get phase(): 'tuning' | 'frozen' { return this.mode; }

  /** Freeze the model/thresholds. After this, and only after this, TEST may be read — once. */
  freeze(): void { this.mode = 'frozen'; }

  /** DEV reporting is always allowed — that is what DEV is for. */
  reportOnDev(data: EvalDatum[]): EvalRun {
    return evaluateAllCheckpoints(data.filter((d) => d.split === 'dev'), this.cfg);
  }

  /**
   * TEST reporting. Refuses while tuning (peeking at TEST is how it rots into a
   * second dev set), and refuses a second read after the first (no re-runs to
   * cherry-pick a better number).
   */
  reportOnTest(data: EvalDatum[]): EvalRun {
    if (this.mode !== 'frozen') {
      throw new FrozenTestGuardError(
        'TEST split is frozen: call freeze() after DEV tuning is complete before reporting on TEST.',
      );
    }
    if (this.testReported) {
      throw new FrozenTestGuardError('TEST split already reported once this run — no re-reads.');
    }
    this.testReported = true;
    return evaluateAllCheckpoints(data.filter((d) => d.split === 'test'), this.cfg);
  }
}
