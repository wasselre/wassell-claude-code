/**
 * Post Creative Director — shared director input types (A-GEN).
 *
 * `DirectorInput` is the ONE bag every director stage receives
 * (contracts/brief A-GEN §runDirector):
 *
 *   { brief, content:{language,title,content_type_key}, facts, brandKit,
 *     rules, targets, specs, referenceRows, assetRows,
 *     conceptChoice?, previousPackage?, revisionNote? }
 *
 * Everything here is plain data — the caller (A-WORKER io.ts) loads it from
 * the DB; this module never touches the network.
 */
import type {
  BasePackage,
  BrandKit,
  Concept,
  ConceptsOutput,
  DerivativeTarget,
  IntendedUse,
  PostFormat,
  WriterRules,
} from '../contracts.js';
import type { CreativeFacts } from '../facts.js';
import type { PlacementSpec } from '../placementSpecs.js';
import type { CandidateAssetRow } from './assets.js';
import type { CreativeReferenceRow } from './references.js';

/** The content record slice the director needs. */
export interface DirectorContent {
  /** mos_content.language — THE language of every generated string (contracts §0 rule 5). */
  language: string;
  title: string | null;
  content_type_key: string | null;
}

/** Which concept the package stage should build (creative_concept_select). */
export interface ConceptChoice {
  /** id inside `concepts` ('c1'…). */
  concept_id?: string | null;
  /** The full concept object (preferred — no lookup needed). */
  concept?: Concept | null;
  /** A human-written custom concept instead of a generated one. */
  custom?: { title: string; angle: string; format: PostFormat } | null;
}

export interface DirectorInput {
  /** The `mos_script_brief(p_content_id)` jsonb (campaign/audience/objective/platforms/language…). */
  brief: Record<string, unknown> | null;
  content: DirectorContent;
  facts: CreativeFacts;
  brandKit: BrandKit | null;
  rules: WriterRules;
  /** SELECTED derivative targets only — copy exists for these and nothing else. */
  targets: DerivativeTarget[];
  specs: PlacementSpec[];
  /** Ranked `mkt_creative_references` rows (competitor + approved Wassel). */
  referenceRows: CreativeReferenceRow[];
  /** Ranked `creative_candidate_assets` rows (project images with rights trust). */
  assetRows: CandidateAssetRow[];
  /** Post recipe key (feature_spec|lifestyle|offer|event|occasion|launch); from job params or the brief. */
  recipe?: string | null;
  /** Authored intended use (job params); forced onto strategy when present. */
  intendedUse?: IntendedUse;
  /** package stage: the chosen concept. */
  conceptChoice?: ConceptChoice | null;
  /** The concepts round the choice came from (rendered for context when present). */
  concepts?: ConceptsOutput | null;
  /** derivatives stage: the base package to adapt. */
  basePackage?: BasePackage | null;
  /** regenerate stage: the previous package + the reviewer's note. */
  previousPackage?: BasePackage | null;
  revisionNote?: string | null;
}
