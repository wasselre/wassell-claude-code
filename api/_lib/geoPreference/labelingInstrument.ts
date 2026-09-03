/**
 * Geography Understanding Ability — the ONTOLOGY-DRIVEN labeling instrument.
 *
 * This is a DATA config, not a React UI. It is the machine-readable description
 * of the human-labeling form: one FieldDescriptor per labelable field of every
 * ontology object (LocationMention/Evidence, AnchorToken, EvidenceRelation,
 * Checkpoint), each carrying its allowed values (straight from the ontology
 * enums), whether it is a "fuzzy" judgment (subject to double-label adjudication),
 * and the escape hatches a labeler may always reach for: `unknown`,
 * `insufficient_context`, and `must_confirm`.
 *
 * The runtime enum arrays below are pinned to the ontology's TYPES with
 * `satisfies readonly X[]`, so if the ontology adds a value and this file is not
 * updated, the build breaks — the form can never silently drift from the schema.
 *
 * The second half is the ADJUDICATION module: given two labelers' blind labels,
 * it reports raw agreement + Cohen's κ + a confusion matrix per fuzzy field, and
 * maps the disagreements that SURVIVE (the genuinely ambiguous items) onto the
 * six operational must-confirm conditions — so labeling ambiguity becomes a
 * runtime "ask the customer / send to human" gate rather than a coin-flip write.
 *
 * Plain-language version: this is the answer sheet's blueprint — every question a
 * human labeler is asked, the choices they can pick, and a "not sure" button.
 * Two people label the same conversations without seeing each other's answers;
 * we measure how often they agree (beyond luck), and every case where two careful
 * people genuinely disagree becomes a case the robot must ask about, not guess.
 */

import type {
  AnchorType, Speaker, PreferenceHolder, HolderRole, QuotedSpeaker, DialogueAct,
  Conditionality, TemporalReference, PreferenceApplicability, PreferenceRole,
  Commitment, HardnessEvidence, Modality, AnnotatorCertainty, RelationKind,
  Lifecycle, RequiredHandling, MaximumSafeAction, ExpectedProcessing, UniverseSource,
  AmbiguityCondition,
} from './ontology.js';

// ────────────────────────────────────────────────────────────────────────────
// Runtime enum arrays — pinned to the ontology types (drift breaks the build).
// ────────────────────────────────────────────────────────────────────────────
export const ANCHOR_TYPES = ['district', 'city', 'region', 'town', 'direction', 'road', 'landmark', 'pin', 'relative_ref'] as const satisfies readonly AnchorType[];
export const SPEAKERS = ['client', 'agent', 'unknown'] as const satisfies readonly Speaker[];
export const PREFERENCE_HOLDERS = ['client', 'other_person', 'unknown'] as const satisfies readonly PreferenceHolder[];
export const HOLDER_ROLES = ['buyer', 'co_decision_maker', 'beneficiary_occupant', 'influencer', 'unrelated_third_party', 'unknown'] as const satisfies readonly HolderRole[];
export const QUOTED_SPEAKERS = ['client', 'agent', 'third_party', 'none', 'unknown'] as const satisfies readonly QuotedSpeaker[];
export const DIALOGUE_ACTS = ['statement', 'question', 'request', 'answer'] as const satisfies readonly DialogueAct[];
export const CONDITIONALITIES = ['asserted', 'hypothetical', 'conditional', 'unknown'] as const satisfies readonly Conditionality[];
export const TEMPORAL_REFERENCES = ['present', 'past', 'future', 'none_explicit'] as const satisfies readonly TemporalReference[];
export const PREFERENCE_APPLICABILITIES = ['active', 'exploratory', 'counterfactual', 'unclear'] as const satisfies readonly PreferenceApplicability[];
export const PREFERENCE_ROLES = ['positive', 'negative', 'exploratory', 'none'] as const satisfies readonly PreferenceRole[];
export const COMMITMENTS = ['required', 'preferred', 'acceptable', 'considered', 'unknown'] as const satisfies readonly Commitment[];
export const HARDNESS_EVIDENCE = ['explicit_force', 'implied', 'none'] as const satisfies readonly HardnessEvidence[];
export const MODALITIES = ['explicit', 'inferred'] as const satisfies readonly Modality[];
export const ANNOTATOR_CERTAINTIES = ['clear', 'ambiguous', 'insufficient_context'] as const satisfies readonly AnnotatorCertainty[];
export const RELATION_KINDS = ['any_of', 'all_of', 'ranked_alternative', 'exception', 'comparison'] as const satisfies readonly RelationKind[];
export const LIFECYCLES = ['active', 'candidate', 'superseded', 'rejected', 'unresolved'] as const satisfies readonly Lifecycle[];
export const REQUIRED_HANDLINGS = ['no_profile_effect', 'resolvable_without_customer', 'customer_confirmation_required', 'human_geo_review_required'] as const satisfies readonly RequiredHandling[];
export const MAXIMUM_SAFE_ACTIONS = ['ignore', 'retain_as_candidate', 'propose', 'write_soft', 'write_hard', 'supersede'] as const satisfies readonly MaximumSafeAction[];
export const EXPECTED_PROCESSINGS = ['evaluate_now', 'wait_for_continuation'] as const satisfies readonly ExpectedProcessing[];
export const UNIVERSE_SOURCES = ['explicit', 'established_context', 'organizational_default', 'unknown'] as const satisfies readonly UniverseSource[];

/** Escape hatches every labeler may always pick. `unknown` and `insufficient_context`
 *  are annotator states; `must_confirm` flags an item the labeler believes the
 *  system must not auto-resolve regardless of the chosen value. */
export const ESCAPES = ['unknown', 'insufficient_context', 'must_confirm'] as const;
export type Escape = typeof ESCAPES[number];

// ────────────────────────────────────────────────────────────────────────────
// Field descriptors.
// ────────────────────────────────────────────────────────────────────────────
export type LabeledEntity = 'evidence' | 'anchor' | 'relation' | 'checkpoint';
export type FieldKind = 'enum' | 'text' | 'number' | 'list' | 'boolean' | 'ref';

export interface FieldDescriptor {
  entity: LabeledEntity;
  field: string;
  label: string;
  kind: FieldKind;
  /** For enum fields, the allowed values (NOT including escapes). */
  allowed_values?: readonly string[];
  required: boolean;
  /** Fuzzy = an interpretive judgment scored by inter-annotator κ. */
  fuzzy: boolean;
  /** Escapes offered on this field (fuzzy fields always offer all three). */
  escapes: readonly Escape[];
  help: string;
}

const FUZZY_ESCAPES = ESCAPES;
const NONE_ESCAPE: readonly Escape[] = [];

export const EVIDENCE_FIELDS: readonly FieldDescriptor[] = [
  { entity: 'evidence', field: 'mention_span', label: 'Mention span', kind: 'text', required: true, fuzzy: false, escapes: NONE_ESCAPE, help: 'Verbatim text of the location mention.' },
  { entity: 'evidence', field: 'speaker', label: 'Speaker', kind: 'enum', allowed_values: SPEAKERS, required: true, fuzzy: false, escapes: ['unknown'], help: 'Who uttered the mention (grammar axis).' },
  { entity: 'evidence', field: 'preference_holder', label: 'Preference holder', kind: 'enum', allowed_values: PREFERENCE_HOLDERS, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'WHOSE preference this is — decoupled from who spoke it.' },
  { entity: 'evidence', field: 'holder_role', label: 'Holder purchase role', kind: 'enum', allowed_values: HOLDER_ROLES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Purchase authority of the holder (buyer / co-decision / occupant / influencer / third party).' },
  { entity: 'evidence', field: 'quoted_speaker', label: 'Quoted speaker', kind: 'enum', allowed_values: QUOTED_SPEAKERS, required: false, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'If the mention is reported speech, who is being quoted.' },
  { entity: 'evidence', field: 'dialogue_act', label: 'Dialogue act', kind: 'enum', allowed_values: DIALOGUE_ACTS, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Grammatical form only — never gates whether a preference is active.' },
  { entity: 'evidence', field: 'conditionality', label: 'Conditionality', kind: 'enum', allowed_values: CONDITIONALITIES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Grammatical conditionality — analysis only, does NOT decide active.' },
  { entity: 'evidence', field: 'temporal_reference', label: 'Temporal reference', kind: 'enum', allowed_values: TEMPORAL_REFERENCES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Linguistic time reference — separated from applicability.' },
  { entity: 'evidence', field: 'preference_applicability', label: 'Preference applicability', kind: 'enum', allowed_values: PREFERENCE_APPLICABILITIES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'THE semantic gate for "is this a live preference".' },
  { entity: 'evidence', field: 'preference_role', label: 'Preference role', kind: 'enum', allowed_values: PREFERENCE_ROLES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Positive (want) / negative (avoid) / exploratory / none.' },
  { entity: 'evidence', field: 'commitment', label: 'Commitment', kind: 'enum', allowed_values: COMMITMENTS, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Required / preferred / acceptable / considered.' },
  { entity: 'evidence', field: 'hardness_evidence', label: 'Hardness evidence', kind: 'enum', allowed_values: HARDNESS_EVIDENCE, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Basis for treating the preference as HARD — force words are one signal.' },
  { entity: 'evidence', field: 'modality', label: 'Modality', kind: 'enum', allowed_values: MODALITIES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Explicit vs inferred.' },
  { entity: 'evidence', field: 'annotator_certainty', label: 'Annotator certainty', kind: 'enum', allowed_values: ANNOTATOR_CERTAINTIES, required: false, fuzzy: false, escapes: ['insufficient_context'], help: 'Human label certainty — NOT model confidence. Gold only.' },
];

export const ANCHOR_FIELDS: readonly FieldDescriptor[] = [
  { entity: 'anchor', field: 'anchor_type', label: 'Anchor type', kind: 'enum', allowed_values: ANCHOR_TYPES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'District / city / region / road / landmark / pin / direction / relative reference.' },
  { entity: 'anchor', field: 'span', label: 'Anchor span', kind: 'text', required: true, fuzzy: false, escapes: NONE_ESCAPE, help: 'Verbatim anchor text as said.' },
  { entity: 'anchor', field: 'normalized_token', label: 'Normalized token', kind: 'text', required: true, fuzzy: false, escapes: ['unknown'], help: 'Canonicalized token (folded ة→ه, ى→ي, stripped حي).' },
  { entity: 'anchor', field: 'role_in_relation', label: 'Role in relation', kind: 'text', required: false, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'How this anchor participates in a relation, when relevant.' },
];

export const RELATION_FIELDS: readonly FieldDescriptor[] = [
  { entity: 'relation', field: 'relation', label: 'Relation kind', kind: 'enum', allowed_values: RELATION_KINDS, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'any_of / all_of / ranked_alternative / exception / comparison.' },
  { entity: 'relation', field: 'members', label: 'Members', kind: 'list', required: true, fuzzy: false, escapes: NONE_ESCAPE, help: 'Evidence/relation ids that are members of this relation.' },
  { entity: 'relation', field: 'ordering', label: 'Ordering (ranked)', kind: 'list', required: false, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Ranked order for ranked_alternative.' },
  { entity: 'relation', field: 'target', label: 'Exception target', kind: 'ref', required: false, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'For exception: what it excepts FROM.' },
  { entity: 'relation', field: 'explicit_or_inferred', label: 'Explicit or inferred', kind: 'enum', allowed_values: ['explicit', 'inferred'], required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Was the relation stated or inferred?' },
];

export const CHECKPOINT_FIELDS: readonly FieldDescriptor[] = [
  { entity: 'checkpoint', field: 'expected_processing', label: 'Expected processing', kind: 'enum', allowed_values: EXPECTED_PROCESSINGS, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Evaluate now vs wait for continuation (fragmented sends).' },
  { entity: 'checkpoint', field: 'lifecycle_by_mention', label: 'Lifecycle per mention', kind: 'enum', allowed_values: LIFECYCLES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'DERIVED per checkpoint: active / candidate / superseded / rejected / unresolved.' },
  { entity: 'checkpoint', field: 'required_handling', label: 'Required handling', kind: 'enum', allowed_values: REQUIRED_HANDLINGS, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'What a correct system must do: ignore / resolve alone / confirm with customer / human geo review.' },
  { entity: 'checkpoint', field: 'maximum_safe_action', label: 'Maximum safe action', kind: 'enum', allowed_values: MAXIMUM_SAFE_ACTIONS, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'What a PERFECT system could AT MOST do — not whether THIS system may.' },
  { entity: 'checkpoint', field: 'universe_source', label: 'Universe source', kind: 'enum', allowed_values: UNIVERSE_SOURCES, required: true, fuzzy: true, escapes: FUZZY_ESCAPES, help: 'Where the search universe came from (explicit / context / org default / unknown).' },
];

/** The complete instrument — every labelable field of every ontology object. */
export const LABELING_INSTRUMENT: readonly FieldDescriptor[] = [
  ...EVIDENCE_FIELDS, ...ANCHOR_FIELDS, ...RELATION_FIELDS, ...CHECKPOINT_FIELDS,
];

/** The fuzzy fields, by qualified name — the ones adjudication scores with κ. */
export const FUZZY_FIELDS: readonly string[] =
  LABELING_INSTRUMENT.filter((d) => d.fuzzy).map((d) => `${d.entity}.${d.field}`);

// ────────────────────────────────────────────────────────────────────────────
// Adjudication — blind double-label → agreement, κ, confusion, survivors.
// ────────────────────────────────────────────────────────────────────────────
export interface LabelPair {
  item_id: string;
  /** qualified field name, e.g. "evidence.holder_role". */
  field: string;
  labeler_a: string;
  labeler_b: string;
}

export interface FieldAgreement {
  field: string;
  n: number;
  raw_agreement: number;
  cohen_kappa: number;
  confusion: Record<string, Record<string, number>>;
}

export interface Survivor {
  item_id: string;
  field: string;
  labeler_a: string;
  labeler_b: string;
  must_confirm_condition: AmbiguityCondition;
}

export interface AdjudicationResult {
  per_field: FieldAgreement[];
  survivors: Survivor[];
}

/** Observed + chance-expected agreement → Cohen's κ. Empty/degenerate → defined, not NaN. */
export function cohenKappa(pairs: readonly [string, string][]): number {
  const n = pairs.length;
  if (n === 0) return 1; // nothing to disagree on

  let observedAgree = 0;
  const countA: Record<string, number> = {};
  const countB: Record<string, number> = {};
  for (const [a, b] of pairs) {
    if (a === b) observedAgree += 1;
    countA[a] = (countA[a] ?? 0) + 1;
    countB[b] = (countB[b] ?? 0) + 1;
  }
  const po = observedAgree / n;

  const categories = new Set<string>([...Object.keys(countA), ...Object.keys(countB)]);
  let pe = 0;
  for (const c of categories) {
    pe += ((countA[c] ?? 0) / n) * ((countB[c] ?? 0) / n);
  }

  if (pe >= 1) return po >= 1 ? 1 : 0; // both labelers used a single category
  return (po - pe) / (1 - pe);
}

export function confusionMatrix(pairs: readonly [string, string][]): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const [a, b] of pairs) {
    const row = m[a] ?? {};
    row[b] = (row[b] ?? 0) + 1;
    m[a] = row;
  }
  return m;
}

/**
 * Map a surviving disagreement (two careful labelers, different answers) onto the
 * operational must-confirm condition it implies. Field-name driven so it stays in
 * lockstep with the instrument.
 */
export function mapDisagreementToMustConfirm(
  field: string, _aVal: string, _bVal: string,
): AmbiguityCondition {
  const bare = field.includes('.') ? field.split('.')[1]! : field;

  // Holder / authority ambiguity.
  if (bare === 'preference_holder' || bare === 'holder_role' || bare === 'quoted_speaker') {
    return 'unclear_preference_holder';
  }
  // Commitment strength, or a question mistaken for a statement.
  if (bare === 'commitment' || bare === 'hardness_evidence' || bare === 'dialogue_act') {
    return 'uncertain_commitment_question';
  }
  // Which real-world entity the anchor points at.
  if (bare === 'anchor_type' || bare === 'normalized_token' || bare === 'role_in_relation') {
    return 'multiple_plausible_entities';
  }
  // A supersession/contradiction where the two labelers disagree on lifecycle,
  // or one asserts a replacement and the other does not.
  if (bare === 'lifecycle_by_mention' || bare === 'relation' || bare === 'ordering' || bare === 'target') {
    return 'contradiction_without_replacement';
  }
  // Radius/geometry underspecified (a "near X" with no distance the labelers read differently).
  if (bare === 'universe_source' || bare === 'expected_processing') {
    return 'missing_radius';
  }
  // Everything else interpretive (applicability, role, temporal, conditionality,
  // required_handling, maximum_safe_action) → the reference does not resolve cleanly.
  return 'unresolved_reference';
}

/** Group blind double-labels by field, score each fuzzy field, and surface survivors. */
export function adjudicate(pairs: readonly LabelPair[]): AdjudicationResult {
  const byField = new Map<string, LabelPair[]>();
  for (const p of pairs) {
    const arr = byField.get(p.field) ?? [];
    arr.push(p);
    byField.set(p.field, arr);
  }

  const per_field: FieldAgreement[] = [];
  const survivors: Survivor[] = [];

  for (const [field, ps] of byField) {
    const tuples: [string, string][] = ps.map((p) => [p.labeler_a, p.labeler_b]);
    const n = ps.length;
    const agree = tuples.filter(([a, b]) => a === b).length;
    per_field.push({
      field,
      n,
      raw_agreement: n === 0 ? 1 : agree / n,
      cohen_kappa: cohenKappa(tuples),
      confusion: confusionMatrix(tuples),
    });

    for (const p of ps) {
      if (p.labeler_a !== p.labeler_b) {
        survivors.push({
          item_id: p.item_id,
          field: p.field,
          labeler_a: p.labeler_a,
          labeler_b: p.labeler_b,
          must_confirm_condition: mapDisagreementToMustConfirm(p.field, p.labeler_a, p.labeler_b),
        });
      }
    }
  }

  per_field.sort((a, b) => a.field.localeCompare(b.field));
  return { per_field, survivors };
}
