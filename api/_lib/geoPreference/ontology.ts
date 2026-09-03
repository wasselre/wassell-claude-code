/**
 * Geography Understanding Ability — the v7 evidence ontology as TypeScript types.
 *
 * This is the SHARED CONTRACT every component compiles against: the AI Stage-A
 * extractor, the deterministic anchor→geometry resolver, the Boolean compiler,
 * the independent reference interpreter, the confidence gate, and the evaluation
 * harness. It is the single source of truth for the label + data shapes; the SQL
 * schema (supabase/migrations/2026-09-03_geo_preference_ability.sql) mirrors it,
 * and the labeling instrument renders from it.
 *
 * Design principle (unchanged through v1–v7): AI interprets what the customer
 * meant (per-utterance Evidence + typed relations); deterministic code resolves
 * that meaning against the map and executes matching. Grammar (dialogue act,
 * conditionality, tense) NEVER gates whether a preference is active — semantics do.
 *
 * NOTHING here writes to a client. Active preferences change only through the
 * review-first path until the frozen-TEST safety gate is cleared.
 */

// ────────────────────────────────────────────────────────────────────────────
// Anchors — repeatable, typed (v6 fix #7): one mention may carry many.
// ────────────────────────────────────────────────────────────────────────────
export type AnchorType =
  | 'district' | 'city' | 'region' | 'town'
  | 'direction' | 'road' | 'landmark' | 'pin' | 'relative_ref';

export interface AnchorToken {
  anchor_type: AnchorType;
  /** verbatim span text as the customer said it */
  span: string;
  /** normalized/canonicalized token (folded ة→ه, ى→ي, stripped حي, etc.) */
  normalized_token: string;
  /** how this anchor participates in a relation, when relevant */
  role_in_relation?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Evidence — one record per location mention (Stage A / AI output).
// Grammar and semantics are ORTHOGONAL axes (v6 #1, v7 #1/#2).
// ────────────────────────────────────────────────────────────────────────────
export type Speaker = 'client' | 'agent' | 'unknown';

/** WHOSE preference this is — decoupled from who spoke it (v6 #2). */
export type PreferenceHolder = 'client' | 'other_person' | 'unknown';

/** Purchase authority — replaces "family = decision maker" (v6 #2). */
export type HolderRole =
  | 'buyer' | 'co_decision_maker' | 'beneficiary_occupant'
  | 'influencer' | 'unrelated_third_party' | 'unknown';

export type QuotedSpeaker = 'client' | 'agent' | 'third_party' | 'none' | 'unknown';

/** Grammatical form only — kept for analysis, never gates meaning (v6 #1). */
export type DialogueAct = 'statement' | 'question' | 'request' | 'answer';

/** Grammatical conditionality — analysis only, does NOT decide active (v7 #1). */
export type Conditionality = 'asserted' | 'hypothetical' | 'conditional' | 'unknown';

/** Linguistic time reference — separated from applicability (v7 #2). */
export type TemporalReference = 'present' | 'past' | 'future' | 'none_explicit';

/** THE semantic gate for "is this a live preference" (v7 #1/#2). */
export type PreferenceApplicability = 'active' | 'exploratory' | 'counterfactual' | 'unclear';

export type PreferenceRole = 'positive' | 'negative' | 'exploratory' | 'none';

export type Commitment = 'required' | 'preferred' | 'acceptable' | 'considered' | 'unknown';

/** Basis for treating a preference as hard — force words are ONE signal (v4 C5). */
export type HardnessEvidence = 'explicit_force' | 'implied' | 'none';

export type Modality = 'explicit' | 'inferred';

/** Human label certainty — NOT model confidence, which never enters gold (v5 5a). */
export type AnnotatorCertainty = 'clear' | 'ambiguous' | 'insufficient_context';

export interface Evidence {
  id: string;
  mention_span: string;
  anchors: AnchorToken[];

  speaker: Speaker;
  preference_holder: PreferenceHolder;
  holder_role: HolderRole;
  quoted_speaker: QuotedSpeaker;

  dialogue_act: DialogueAct;
  conditionality: Conditionality;
  temporal_reference: TemporalReference;
  preference_applicability: PreferenceApplicability;

  preference_role: PreferenceRole;
  commitment: Commitment;
  hardness_evidence: HardnessEvidence;
  modality: Modality;

  annotator_certainty?: AnnotatorCertainty; // gold only
  interpretation_confidence?: number;        // MODEL output only — never in gold

  source: {
    channel: 'chat' | 'call';
    ref: string;        // message_id | transcript_segment id
    timestamp: string;  // ISO
  };
  extraction_version?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Relations — typed DAG (v4 A2 / v6 #1). comparison lives HERE, not on the act.
// ────────────────────────────────────────────────────────────────────────────
export type RelationKind =
  | 'any_of' | 'all_of' | 'ranked_alternative' | 'exception' | 'comparison';

export interface RelationMemberRef {
  type: 'evidence' | 'relation';
  id: string;
}

export interface EvidenceRelation {
  id: string;
  relation: RelationKind;
  members: RelationMemberRef[];
  ordering?: RelationMemberRef[]; // ranked_alternative
  target?: RelationMemberRef;     // exception: what it excepts FROM
  source_span: string;
  explicit_or_inferred: 'explicit' | 'inferred';
  interpretation_confidence?: number; // model only
}

// ────────────────────────────────────────────────────────────────────────────
// Boolean preference expression — compiler OUTPUT (v2 §1b, v4 C3).
// ────────────────────────────────────────────────────────────────────────────
export type Polarity = 'include' | 'exclude';

/** A resolved shape reference produced by the anchor→geometry resolver. */
export interface AnchorRef {
  /** id into the resolved-geometry store (client_pref_geometry successor). */
  geometry_id: string;
  /** provenance recipe so the shape can be recomputed (v4 A6/#8). */
  recipe: GeometryRecipe;
}

export interface GeoClause {
  op: Polarity;           // exclude = NOT
  anyOf: AnchorRef[];     // OR within a clause
}

export interface GeoGroup {
  id: string;
  role: 'primary' | 'alternative' | 'fallback';
  strength: 'hard' | 'soft'; // hard = eligibility filter; soft = ranking only (v4 C3)
  priority: number;          // 1 = strongest
  clauses: GeoClause[];      // AND
}

export interface GeoPreference {
  schema_version: string;
  groups: GeoGroup[]; // OR across groups = ranked alternatives
}

// ────────────────────────────────────────────────────────────────────────────
// Geometry recipe / provenance — never store only the polygon (v4 #8).
// ────────────────────────────────────────────────────────────────────────────
export type GeoOperation =
  | 'district_polygon' | 'zone_union' | 'within_radius' | 'within_distance'
  | 'directional_band' | 'corridor' | 'pin_point' | 'district_union' | 'pin_containing_district';

export interface GeometryRecipe {
  operation: GeoOperation;
  source_anchors: AnchorToken[];
  resolved_element_ids: string[];    // district_ids / road element_ids / landmark ids
  radius_or_band_m?: number;
  universe_source?: UniverseSource;  // v6 #8
  geo_data_version: string;
  resolver_version: string;
  compiled_at: string;
}

export type UniverseSource = 'explicit' | 'established_context' | 'organizational_default' | 'unknown';

// ────────────────────────────────────────────────────────────────────────────
// Resolution outcome — the anchor→geometry resolver (v4 C6, v4 A3: no ID tiebreak).
// ────────────────────────────────────────────────────────────────────────────
export interface ResolutionResult {
  status: 'resolved' | 'needs_confirm' | 'unresolvable';
  geometry_id?: string;
  recipe?: GeometryRecipe;
  candidate_margin?: number;   // gap to 2nd candidate; below threshold ⇒ needs_confirm
  reason?: string;             // e.g. tie, missing_radius, outside_admin, ambiguous_entity
}

// ────────────────────────────────────────────────────────────────────────────
// Checkpoint — turn-level, lifecycle & profile DERIVED (v6 #3/#6, v7 #3).
// ────────────────────────────────────────────────────────────────────────────
export type Lifecycle = 'active' | 'candidate' | 'superseded' | 'rejected' | 'unresolved';

export type RequiredHandling =
  | 'no_profile_effect' | 'resolvable_without_customer'
  | 'customer_confirmation_required' | 'human_geo_review_required';

/** What a PERFECT system could at most do — NOT whether THIS system may (v6 #5). */
export type MaximumSafeAction =
  | 'ignore' | 'retain_as_candidate' | 'propose'
  | 'write_soft' | 'write_hard' | 'supersede';

export type ExpectedProcessing = 'evaluate_now' | 'wait_for_continuation';

export interface Checkpoint {
  conversation_id: string;
  turn_id: string;
  as_of_timestamp: string;
  member_message_ids: string[];              // fragmented sends grouped (v6 #6)
  expected_processing: ExpectedProcessing;
  evidence_visible_so_far: string[];         // evidence ids
  lifecycle_by_mention: Record<string, Lifecycle>; // DERIVED per checkpoint
  /** COMPILED from adjudicated evidence — the production compiler's output. */
  actual_compiler_output?: GeoPreference;
  /** INDEPENDENT answer key — never the production compiler (v7 #3). */
  canonical_expected_expression?: GeoPreference;
  required_handling: RequiredHandling;
  maximum_safe_action: MaximumSafeAction;
  universe_source: UniverseSource;
}

// ────────────────────────────────────────────────────────────────────────────
// Static satisfiability — full Boolean, per-group (v5 #4).
// ────────────────────────────────────────────────────────────────────────────
export type SatisfiabilityFlag =
  | 'satisfiable' | 'unsatisfiable_expression' | 'spatially_narrow' | 'no_current_inventory';

// ────────────────────────────────────────────────────────────────────────────
// Confidence gate signals — deterministic, AI confidence is veto-only (v2 §5).
// ────────────────────────────────────────────────────────────────────────────
export interface GateSignals {
  interpretation_confidence: number;   // veto-only
  lexical_candidate_quality: number;
  geo_resolution_margin: number;
  context_consistency: number;
  contradiction_signal: number;
  source_quality: number;
}

export type GateDecision = 'auto_write' | 'confirm' | 'human_review' | 'ignore';

// Operational ambiguity conditions → deterministic confirm gates (v5 5c).
export type AmbiguityCondition =
  | 'unresolved_reference' | 'multiple_plausible_entities' | 'missing_radius'
  | 'unclear_preference_holder' | 'uncertain_commitment_question'
  | 'contradiction_without_replacement';

/** The active-preference predicate (v7 final rule). Grammar/tense never gate. */
export function isActivePreference(e: Evidence): boolean {
  return (
    (e.preference_role === 'positive' || e.preference_role === 'negative') &&
    (e.holder_role === 'buyer' || e.holder_role === 'co_decision_maker' || e.holder_role === 'beneficiary_occupant') &&
    e.preference_applicability === 'active' &&
    e.commitment !== 'unknown'
  );
}
