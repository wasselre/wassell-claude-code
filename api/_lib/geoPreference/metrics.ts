/**
 * Geography Understanding Ability — ACTION-SENSITIVE safety metrics.
 *
 * These metrics score the ability the way a reviewer cares about it: not "how
 * often is a field right" alone, but "how often does a WRONG field reach a
 * client profile", and "how much can we safely automate without a human". They
 * are computed PER CHANNEL (chat vs call) because a spoken transcript and a
 * typed WhatsApp thread fail in different ways (ASR noise vs typos, fragmented
 * sends vs long turns), and a single blended number hides the worse channel.
 *
 * ── The must_confirm invariant (the whole safety story) ──────────────────────
 * A case the correct system should NOT auto-write (it needs the customer to
 * confirm, or a human to review the geometry) is a `must_confirm` case. The one
 * way a dishonest system could fake a good coverage number is to relabel every
 * hard case as must_confirm and then quietly drop it from the denominator —
 * "we only score the easy ones". So the rule enforced here, in code:
 *
 *   must_confirm cases stay in EVERY denominator — total volume, the coverage
 *   denominator, the confirmation rate, the review burden. They are removed
 *   ONLY from the auto-write-ALLOWED subset (where, by definition, they don't
 *   belong). `proveCoverageNotInflatableByMustConfirm` demonstrates that moving
 *   a case into must_confirm can only ever LOWER coverage, never raise it.
 *
 * NOTHING here writes to a client. This module reads scored units and returns
 * numbers. See ./evalHarness.ts for how scored units are produced from the
 * three evaluation artifacts.
 *
 * Plain-language version: we count how much geography work the robot did on its
 * own AND got right, out of ALL the work — including the tricky cases it was
 * supposed to hand to a person. If it "handles" a tricky case by pretending it
 * doesn't count, the tricky case is still in the total, so its score drops. It
 * cannot look better by ducking the hard ones.
 */

import type { RequiredHandling, GateDecision } from './ontology.js';

// ────────────────────────────────────────────────────────────────────────────
// Channel + stage vocabulary.
// ────────────────────────────────────────────────────────────────────────────
export type Channel = 'chat' | 'call';

/** The five interpretation sub-fields scored independently (v6/v7 axes). */
export type InterpretationField =
  | 'speech_act' | 'preference_role' | 'commitment' | 'holder_role' | 'applicability';

/** One scored field: whether it was in scope, and whether it was right. */
export interface StageScore {
  /** was this stage/field applicable to this unit at all? (e.g. no anchor ⇒ resolution N/A) */
  applicable: boolean;
  /** gold === predicted. Only meaningful when applicable. */
  correct: boolean;
}

const okScore = (correct: boolean): StageScore => ({ applicable: true, correct });
const naScore = (): StageScore => ({ applicable: false, correct: true });
export { okScore as scored, naScore as notApplicable };

/**
 * The five profile-corrupting mistake classes. A `true` here is a SEVERE error:
 * a wrong preference that, if written, changes which properties the client is
 * shown (hard filters) or rewrites their stated intent.
 */
export interface SevereFlags {
  wrong_hard_include: boolean;   // wrote/kept a HARD include the customer didn't set
  wrong_hard_exclude: boolean;   // wrote/kept a HARD exclude the customer didn't set
  wrong_supersession: boolean;   // failed to replace an old preference, or replaced a live one
  wrong_city: boolean;           // resolved to the wrong city (namesake district trap)
  wrong_geo_entity: boolean;     // resolved to the wrong district/road/landmark
}

export const NO_SEVERE: SevereFlags = {
  wrong_hard_include: false, wrong_hard_exclude: false,
  wrong_supersession: false, wrong_city: false, wrong_geo_entity: false,
};

export function hasSevere(s: SevereFlags): boolean {
  return s.wrong_hard_include || s.wrong_hard_exclude ||
    s.wrong_supersession || s.wrong_city || s.wrong_geo_entity;
}

/**
 * One evaluated unit = one location mention scored at one checkpoint. Produced
 * by the eval harness; consumed by the metrics below.
 */
export interface ScoredUnit {
  id: string;
  client_id: string;
  channel: Channel;

  /** Gold answer to "what should a correct system do with this?" (Checkpoint.required_handling). */
  gold_handling: RequiredHandling;
  /** What the system-under-test's confidence gate actually decided. */
  predicted_gate: GateDecision;

  /** Per-stage / per-field correctness. */
  stages: {
    mention_detection: StageScore;
    interpretation: Record<InterpretationField, StageScore>;
    anchor_extraction: StageScore;
    entity_resolution: StageScore;
    geometry_construction: StageScore;
    matching: StageScore;
  };

  /** Which of the five severe mistakes this unit made (per the actual output). */
  severe: SevereFlags;

  /** Did the FINAL compiled expression for this unit match the canonical key end-to-end? */
  final_correct: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Handling classification — the must_confirm partition.
// ────────────────────────────────────────────────────────────────────────────

/** A case the correct system must NOT auto-write (customer/human must weigh in). */
export function isMustConfirm(u: Pick<ScoredUnit, 'gold_handling'>): boolean {
  return u.gold_handling === 'customer_confirmation_required'
    || u.gold_handling === 'human_geo_review_required';
}

/** A case a correct system MAY resolve autonomously (this is the ONLY auto-write-allowed subset). */
export function isAutoWriteAllowed(u: Pick<ScoredUnit, 'gold_handling'>): boolean {
  return u.gold_handling === 'resolvable_without_customer';
}

/** Did the system handle this unit WITHOUT a human? (auto-write or auto-ignore, both are automation.) */
function autoHandled(u: ScoredUnit): boolean {
  return u.predicted_gate === 'auto_write' || u.predicted_gate === 'ignore';
}

/** Did the system route this unit to a person? */
function routedToReview(u: ScoredUnit): boolean {
  return u.predicted_gate === 'confirm' || u.predicted_gate === 'human_review';
}

/** Did the system actually WRITE a preference? (only writes can corrupt a profile). */
function autoWrote(u: ScoredUnit): boolean {
  return u.predicted_gate === 'auto_write';
}

// ────────────────────────────────────────────────────────────────────────────
// Rate helpers. `rate` → 0 on empty (a fraction of nothing is 0). `acc` → 1 on
// empty (nothing to get wrong is vacuously perfect). Kept distinct on purpose.
// ────────────────────────────────────────────────────────────────────────────
const rate = (num: number, den: number): number => (den === 0 ? 0 : num / den);
const acc = (num: number, den: number): number => (den === 0 ? 1 : num / den);

function flatFieldScores(u: ScoredUnit): StageScore[] {
  return [
    u.stages.mention_detection,
    u.stages.interpretation.speech_act,
    u.stages.interpretation.preference_role,
    u.stages.interpretation.commitment,
    u.stages.interpretation.holder_role,
    u.stages.interpretation.applicability,
    u.stages.anchor_extraction,
    u.stages.entity_resolution,
    u.stages.geometry_construction,
    u.stages.matching,
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// Report shapes.
// ────────────────────────────────────────────────────────────────────────────
export interface StageAccuracy {
  mention_detection: number;
  interpretation: {
    overall: number;
    speech_act: number;
    preference_role: number;
    commitment: number;
    holder_role: number;
    applicability: number;
  };
  anchor_extraction: number;
  entity_resolution: number;
  geometry_construction: number;
  matching: number;
}

export interface ChannelMetrics {
  channel: Channel | 'combined';

  /** ALL units in scope for this channel — must_confirm included. This is the denominator. */
  total_volume: number;
  /** How many of total_volume are must_confirm. Reported for auditing; NOT removed from total_volume. */
  must_confirm_volume: number;
  /** How many are auto-write-allowed (the only subset must_confirm cases may be dropped from). */
  auto_write_allowed_volume: number;

  field_level_error: number;      // wrong fields / applicable fields
  record_level_error: number;     // units with ≥1 wrong field / total
  client_level_corruption: number;// clients with ≥1 WRITTEN severe error / clients
  severe_error_rate: number;      // units with ≥1 severe error / total

  automation_coverage: number;    // correctly auto-handled / TOTAL (must_confirm in denom)
  review_burden: number;          // routed to human / TOTAL (must_confirm in denom)
  confirmation_rate: number;      // gate = confirm / TOTAL (must_confirm in denom)

  /** Coverage restricted to the auto-write-allowed subset — the ONLY place must_confirm is excluded. */
  auto_write_allowed_coverage: number;

  stage_accuracy: StageAccuracy;
}

export interface GeoMetricsReport {
  chat: ChannelMetrics;
  call: ChannelMetrics;
  combined: ChannelMetrics;
}

// ────────────────────────────────────────────────────────────────────────────
// Core computation for one bucket of units.
// ────────────────────────────────────────────────────────────────────────────
export function computeChannelMetrics(
  units: ScoredUnit[],
  channel: Channel | 'combined',
): ChannelMetrics {
  const total = units.length;
  const mustConfirm = units.filter(isMustConfirm);
  const allowed = units.filter(isAutoWriteAllowed);

  // ── field / record level ──
  let wrongFields = 0, applicableFields = 0, recordsWithError = 0;
  for (const u of units) {
    const fields = flatFieldScores(u);
    let unitHasError = false;
    for (const f of fields) {
      if (!f.applicable) continue;
      applicableFields += 1;
      if (!f.correct) { wrongFields += 1; unitHasError = true; }
    }
    if (unitHasError) recordsWithError += 1;
  }

  // ── severe / client corruption ──
  const severeUnits = units.filter((u) => hasSevere(u.severe)).length;
  const clientIds = new Set(units.map((u) => u.client_id));
  const corruptedClients = new Set(
    units.filter((u) => autoWrote(u) && hasSevere(u.severe)).map((u) => u.client_id),
  );

  // ── automation / review — denominator is ALWAYS `total` ──
  const coveredCount = units.filter((u) => autoHandled(u) && u.final_correct).length;
  const reviewCount = units.filter(routedToReview).length;
  const confirmCount = units.filter((u) => u.predicted_gate === 'confirm').length;

  // auto-write-allowed coverage: within the allowed subset only.
  const allowedCovered = allowed.filter((u) => autoHandled(u) && u.final_correct).length;

  return {
    channel,
    total_volume: total,
    must_confirm_volume: mustConfirm.length,
    auto_write_allowed_volume: allowed.length,

    field_level_error: rate(wrongFields, applicableFields),
    record_level_error: rate(recordsWithError, total),
    client_level_corruption: rate(corruptedClients.size, clientIds.size),
    severe_error_rate: rate(severeUnits, total),

    automation_coverage: rate(coveredCount, total),
    review_burden: rate(reviewCount, total),
    confirmation_rate: rate(confirmCount, total),

    auto_write_allowed_coverage: rate(allowedCovered, allowed.length),

    stage_accuracy: computeStageAccuracy(units),
  };
}

function computeStageAccuracy(units: ScoredUnit[]): StageAccuracy {
  const tally = () => ({ correct: 0, applicable: 0 });
  const md = tally(), ae = tally(), er = tally(), gc = tally(), mt = tally();
  const sa = tally(), pr = tally(), cm = tally(), hr = tally(), ap = tally();

  const bump = (t: { correct: number; applicable: number }, s: StageScore) => {
    if (!s.applicable) return;
    t.applicable += 1;
    if (s.correct) t.correct += 1;
  };

  for (const u of units) {
    bump(md, u.stages.mention_detection);
    bump(ae, u.stages.anchor_extraction);
    bump(er, u.stages.entity_resolution);
    bump(gc, u.stages.geometry_construction);
    bump(mt, u.stages.matching);
    bump(sa, u.stages.interpretation.speech_act);
    bump(pr, u.stages.interpretation.preference_role);
    bump(cm, u.stages.interpretation.commitment);
    bump(hr, u.stages.interpretation.holder_role);
    bump(ap, u.stages.interpretation.applicability);
  }

  const interpCorrect = sa.correct + pr.correct + cm.correct + hr.correct + ap.correct;
  const interpApplicable = sa.applicable + pr.applicable + cm.applicable + hr.applicable + ap.applicable;

  return {
    mention_detection: acc(md.correct, md.applicable),
    interpretation: {
      overall: acc(interpCorrect, interpApplicable),
      speech_act: acc(sa.correct, sa.applicable),
      preference_role: acc(pr.correct, pr.applicable),
      commitment: acc(cm.correct, cm.applicable),
      holder_role: acc(hr.correct, hr.applicable),
      applicability: acc(ap.correct, ap.applicable),
    },
    anchor_extraction: acc(ae.correct, ae.applicable),
    entity_resolution: acc(er.correct, er.applicable),
    geometry_construction: acc(gc.correct, gc.applicable),
    matching: acc(mt.correct, mt.applicable),
  };
}

/** Full per-channel report (chat, call, and the combined pool). */
export function computeGeoMetrics(units: ScoredUnit[]): GeoMetricsReport {
  return {
    chat: computeChannelMetrics(units.filter((u) => u.channel === 'chat'), 'chat'),
    call: computeChannelMetrics(units.filter((u) => u.channel === 'call'), 'call'),
    combined: computeChannelMetrics(units, 'combined'),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Anti-gaming proof: coverage cannot be inflated by reclassifying hard cases as
// must_confirm.
//
// The mechanism: `automation_coverage` divides by TOTAL volume, and total does
// not change when a case's handling changes. Reclassifying a unit to must_confirm
// is only honest if the system then ROUTES it to a human (predicted_gate =
// confirm) — which removes it from the coverage numerator (auto-handled) while
// leaving it in the denominator. Numerator can only shrink; denominator is fixed;
// so coverage can only fall or stay. This function demonstrates that on real data.
// ────────────────────────────────────────────────────────────────────────────
export interface CoverageInflationProof {
  baseline_coverage: number;
  reclassified_coverage: number;
  baseline_total: number;
  reclassified_total: number;
  /** total is invariant under reclassification — must_confirm never leaves the denominator. */
  total_unchanged: boolean;
  /** the property we care about: coverage did not go UP. */
  monotone_non_increasing: boolean;
}

export function proveCoverageNotInflatableByMustConfirm(
  units: ScoredUnit[],
  reclassifyIds: string[],
): CoverageInflationProof {
  const before = computeChannelMetrics(units, 'combined');
  const ids = new Set(reclassifyIds);
  const after = computeChannelMetrics(
    units.map((u) =>
      ids.has(u.id)
        // Honest reclassification: mark it must_confirm AND route it to a human.
        ? { ...u, gold_handling: 'customer_confirmation_required' as RequiredHandling, predicted_gate: 'confirm' as GateDecision }
        : u,
    ),
    'combined',
  );
  return {
    baseline_coverage: before.automation_coverage,
    reclassified_coverage: after.automation_coverage,
    baseline_total: before.total_volume,
    reclassified_total: after.total_volume,
    total_unchanged: before.total_volume === after.total_volume,
    monotone_non_increasing: after.automation_coverage <= before.automation_coverage + 1e-12,
  };
}
