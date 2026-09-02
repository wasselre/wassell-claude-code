/**
 * Director orchestrator — the four generation stages.
 *
 *   runConcepts(input, deps)     stage 1 → ConceptsOutput
 *   runPackage(input, deps)      stage 2 → BasePackage   (chosen concept)
 *   runDerivatives(input, deps)  stage 3 → DerivativesOutput (base required)
 *   runRegenerate(input, deps)   stage 2 again with previousPackage + revisionNote
 *
 * Every stage: build prompt → role call with the stage's JSON schema →
 * post-process (assets sanitized / references guarded / AI policy dismissals /
 * deterministic adaptation geometry) → validators → on errors retry ONCE with
 * `buildViolationFeedback` → return `{ output, validation, needs_attention,
 * retried, rolesJson, cost_usd }`. Validation failure after the retry NEVER
 * throws — the caller saves the draft with warnings + needs_attention
 * (contracts §8). Throws only:
 *
 *   facts_insufficient:  — facts.package.viable is false, or the recipe needs
 *                          a price and no claimable price fact exists.
 *
 * PURE with respect to I/O: deps.callRole is injected (A-WORKER binds
 * `callCreativeRole` + `{ sb }`); no DB access here.
 */
import { buildBlocklist } from '../../marketing/script/entities.js';
import type { BlockEntry } from '../../marketing/script/entities.js';
import type { JSONSchema } from '../../ai/index.js';
import {
  createRoleLedger,
  ledgerToJson,
  recordCreativeRoleUse,
  type CallRequest,
  type CreativeCallResult,
  type CreativeRoleKey,
  type RoleUseLedger,
} from '../roles.js';
import type {
  AiRecommendation,
  AssetPick,
  BasePackage,
  ConceptsOutput,
  Derivative,
  DerivativesOutput,
  ReferencePick,
} from '../contracts.js';
import {
  buildViolationFeedback,
  validateBase,
  validateConcepts,
  validateDerivatives,
  type GroundingCtx,
  type ValidationResult,
  type Violation,
} from '../grounding.js';
import { masterAspectFor } from '../placementSpecs.js';
import {
  finalizeAdaptation,
  planAdaptations,
  targetKey,
  type PlannedDerivative,
} from './adaptation.js';
import { sanitizeAssetPicks, type ModelAssetPick } from './assets.js';
import { checkAiRecommendation } from './policy.js';
import {
  conceptsSystem,
  conceptsUser,
  derivativesSystem,
  derivativesUser,
  packageSystem,
  packageUser,
  recipeByKey,
  regenerateUser,
  type DirectorPromptCtx,
} from './prompts.js';
import { selectReferences, type ModelReferencePick } from './references.js';
import {
  BASE_PACKAGE_SCHEMA,
  CONCEPTS_OUTPUT_SCHEMA,
  DERIVATIVES_OUTPUT_SCHEMA,
} from './schemas.js';
import type { DirectorInput } from './types.js';

// ── Deps + result ────────────────────────────────────────────────────────────
export type DirectorCallRole = <T>(key: CreativeRoleKey, req: CallRequest) => Promise<CreativeCallResult<T>>;

export interface DirectorDeps {
  /** Bound role caller (A-WORKER: `(key, req) => callCreativeRole(key, req, { sb })`). Tests inject a fake. */
  callRole: DirectorCallRole;
  /** Optional shared ledger — a fresh one is created per stage when absent. */
  ledger?: RoleUseLedger;
  log?: (msg: string, extra?: unknown) => void;
}

export interface DirectorStageResult<T> {
  output: T;
  validation: ValidationResult;
  /** true when validation still has errors after the one retry — the caller saves a draft, never throws. */
  needs_attention: boolean;
  /** true when the violation-feedback retry ran. */
  retried: boolean;
  /** ledgerToJson of this stage's ledger (model/cost/token provenance for the job row). */
  rolesJson: Record<string, unknown>;
  /** USD; null when any call's cost was unknown (never a guessed number). */
  cost_usd: number | null;
}

// ── Facts gate ───────────────────────────────────────────────────────────────
function recipeFor(input: DirectorInput): string | null {
  if (input.recipe) return input.recipe;
  const fromBrief = input.brief?.recipe;
  return typeof fromBrief === 'string' ? fromBrief : null;
}

/**
 * Throw `facts_insufficient:` when the facts cannot support the stage:
 * non-viable package, or a price-led recipe (offer/launch) without a claimable
 * price fact.
 */
export function assertFactsViable(input: DirectorInput): void {
  const pkg = input.facts.package;
  if (!pkg.viable) {
    throw new Error(
      `facts_insufficient: facts package for «${pkg.project_name}» is not viable` +
      (pkg.missing.length > 0 ? ` — missing: ${pkg.missing.join(', ')}` : ''),
    );
  }
  const recipe = recipeByKey(recipeFor(input));
  if (recipe?.requires_price) {
    const hasPrice = pkg.facts.some((f) => f.class === 'price' && f.claimable);
    if (!hasPrice) {
      throw new Error(
        `facts_insufficient: recipe '${recipe.key}' needs a claimable price fact but the package has none`,
      );
    }
  }
}

// ── Grounding context (built from the input bag — no I/O) ────────────────────
export function buildGroundingCtx(input: DirectorInput): GroundingCtx {
  const pkg = input.facts.package;
  const marketerName = pkg.marketer_name ?? 'وصل العقارية';
  const briefCta = typeof input.brief?.cta === 'string' ? (input.brief.cta as string) : 'للحجز والاستفسار: وصل العقارية';
  const blocklist: BlockEntry[] = buildBlocklist({
    brief: { cta: briefCta },
    exemplars: input.referenceRows.map((r) => ({ org_name: r.org_name, organization_id: null })),
    orgs: [],
    projectRecord: {},
    developerName: pkg.developer_name ?? null,
    marketerName,
    rules: { allow_developer_name: true, marketer_name: marketerName },
  });
  const competitorMediaIds = new Set(
    input.referenceRows
      .filter((r) => r.ref_kind === 'competitor_post' || r.ref_kind === 'competitor_media')
      .map((r) => r.ref_id),
  );
  const assetMeta = new Map(
    input.assetRows.map((r) => [
      r.file_id,
      { rights: r.usage_rights ?? null, rights_verified: r.rights_verified === true, nature: r.asset_nature ?? null },
    ]),
  );
  return {
    facts: pkg,
    refs: input.facts.refs,
    language: input.content.language,
    selectedTargets: input.targets,
    specs: input.specs,
    brandKit: input.brandKit,
    rules: input.rules,
    blocklist,
    allowedTerms: [pkg.developer_name].filter((x): x is string => !!x),
    competitorMediaIds,
    assetMeta,
    // policyCheck intentionally NOT injected: policy violations are handled by
    // the orchestrator as status:'dismissed' + warning (contracts §7), not as
    // retryable validation errors.
  };
}

// ── Stage call helper (call → post-process → validate → one retry) ───────────
interface StageRun<T> {
  output: T;
  validation: ValidationResult;
  retried: boolean;
}

async function runStage<T>(
  stageName: string,
  key: CreativeRoleKey,
  system: string,
  buildUser: (violationFeedback: string | null) => string,
  schema: JSONSchema,
  postProcess: (raw: T) => T,
  validate: (out: T) => ValidationResult,
  deps: DirectorDeps,
  ledger: RoleUseLedger,
): Promise<StageRun<T>> {
  const call = async (feedback: string | null): Promise<T> => {
    const res = await deps.callRole<T>(key, { system, user: buildUser(feedback), schema });
    recordCreativeRoleUse(ledger, key, res);
    return res.output;
  };

  let output = postProcess(await call(null));
  let validation = validate(output);
  let retried = false;

  if (!validation.ok) {
    retried = true;
    const feedback = buildViolationFeedback(validation.errors);
    deps.log?.(`[director] ${stageName}: ${validation.errors.length} violation(s) — retrying once with feedback`);
    output = postProcess(await call(feedback));
    validation = validate(output);
    if (!validation.ok) {
      // Never throw (contracts §8) — but never silently either.
      console.error(
        `[director] ${stageName}: validation_unrepaired after one retry — ${validation.errors.length} error(s) remain: ` +
        validation.errors.map((e) => `[${e.rule}] ${e.path}`).join('; '),
      );
    }
  }
  return { output, validation, retried };
}

function stageResult<T>(run: StageRun<T>, ledger: RoleUseLedger): DirectorStageResult<T> {
  return {
    output: run.output,
    validation: run.validation,
    needs_attention: !run.validation.ok,
    retried: run.retried,
    rolesJson: ledgerToJson(ledger),
    cost_usd: ledger.cost_usd,
  };
}

function promptCtx(input: DirectorInput): DirectorPromptCtx {
  return { language: input.content.language, rules: input.rules, brandKit: input.brandKit };
}

// ── Base package post-processing ─────────────────────────────────────────────
/**
 * Deterministic corrections applied to every model BasePackage BEFORE
 * validation (and again after the retry):
 *  - assets sanitized against the candidate rows (hallucination guard,
 *    competitor/blocked-rights rejection, rights copied from rows);
 *  - references mapped through selectReferences (id guard, org diversity,
 *    carousel post-level rule, preview_url from rows);
 *  - AI recommendations checked against the §7 policy — a violation DISMISSES
 *    the recommendation (status 'dismissed' + `policy_blocked:` warning),
 *    it is never a retryable error;
 *  - master_aspect forced to masterAspectFor(targets) when the model picked an
 *    aspect no selected spec carries;
 *  - brand_kit version/mode + strategy.language + intended_use forced to the
 *    authoritative values (a correction, recorded as a warning).
 */
export function sanitizeBasePackage(input: DirectorInput, raw: BasePackage): BasePackage {
  const warnings: string[] = [];

  // Assets — the model authors placement/usage/treatment/why/is_production only.
  const modelPicks: ModelAssetPick[] = (raw.assets ?? []).map((a) => ({
    file_id: a.file_id,
    placement: a.placement,
    usage: a.usage,
    treatment: a.treatment,
    why: a.why,
    is_production: a.is_production,
  }));
  const assetResult = sanitizeAssetPicks(modelPicks, input.assetRows);
  warnings.push(...assetResult.warnings);
  const assets: AssetPick[] = assetResult.assets;

  // References — id guard + diversity + carousel post-level, preview from rows.
  const modelRefs: ModelReferencePick[] = (raw.references ?? []).map((r) => ({
    ref_id: r.ref_id,
    aspect: r.aspect,
    why: r.why,
    study: r.study,
    adapt: r.adapt,
    do_not_copy: r.do_not_copy,
    differ: r.differ,
  }));
  // raw.strategy can be absent if the model returned an incomplete object
  // (e.g. a forced-tool fallback). Never throw here — a missing strategy is
  // caught downstream by validateBase (structural error → retry / needs_attention).
  const refResult = selectReferences(input.referenceRows, { format: raw.strategy?.format }, { picks: modelRefs });
  for (const d of refResult.dropped) warnings.push(`reference ${d.ref_id} dropped (${d.reason})`);
  warnings.push(...refResult.warnings);
  const references: ReferencePick[] = refResult.references;

  // AI recommendations — §7 policy gate → dismissed, never queued.
  const aiRecommendations: AiRecommendation[] = (raw.ai_recommendations ?? []).map((rec) => {
    const verdict = checkAiRecommendation(rec);
    if (verdict.ok) return rec;
    warnings.push(`policy_blocked: ai_recommendations.${rec.index} dismissed — ${verdict.reason}`);
    return { ...rec, status: 'dismissed' as const };
  });

  // Strategy corrections.
  const strategy = { ...raw.strategy };
  const knownAspects = new Set(input.specs.flatMap((s) => s.aspects));
  if (input.specs.length > 0 && !knownAspects.has(strategy.master_aspect)) {
    const forced = masterAspectFor(input.targets);
    warnings.push(`master_aspect '${strategy.master_aspect}' is not carried by any selected spec — forced to '${forced}'`);
    strategy.master_aspect = forced;
  }
  if (strategy.language !== input.content.language) {
    warnings.push(`strategy.language '${strategy.language}' corrected to the content language '${input.content.language}'`);
    strategy.language = input.content.language;
  }
  if (input.intendedUse && strategy.intended_use !== input.intendedUse) {
    warnings.push(`intended_use '${strategy.intended_use}' corrected to the authorised '${input.intendedUse}'`);
    strategy.intended_use = input.intendedUse;
  }

  // Brand kit identity fields are facts about the SETTINGS, not model choices.
  const brandKit = input.brandKit
    ? { version: input.brandKit.version, mode: input.brandKit.mode, deviations: raw.brand_kit?.deviations ?? [] }
    : (raw.brand_kit ?? { version: 0, mode: 'advisory' as const, deviations: [] });

  return {
    ...raw,
    strategy,
    brand_kit: brandKit,
    assets,
    references,
    ai_recommendations: aiRecommendations,
    warnings: [...(raw.warnings ?? []), ...warnings],
  };
}

// ── Derivatives post-processing ──────────────────────────────────────────────
interface DerivativePostResult {
  output: DerivativesOutput;
  missingTargets: string[];
  droppedTargets: string[];
}

/**
 * Rebuild the model's derivatives against the plan: only SELECTED targets
 * survive (extras dropped with a warning), geometry comes from the skeleton,
 * and every VisualAdaptation ends complete (explicit "no change" wording).
 */
export function finalizeDerivatives(
  input: DirectorInput & { basePackage: BasePackage },
  raw: DerivativesOutput,
  planned: PlannedDerivative[],
): DerivativePostResult {
  const byKey = new Map((raw.derivatives ?? []).map((d) => [targetKey(d.target), d]));
  const selectedKeys = new Set(planned.map((p) => targetKey(p.target)));
  const droppedTargets: string[] = [];
  for (const d of raw.derivatives ?? []) {
    if (!selectedKeys.has(targetKey(d.target))) droppedTargets.push(targetKey(d.target));
  }

  const slideCount = input.basePackage.slides.length;
  const missingTargets: string[] = [];
  const derivatives: Derivative[] = [];

  for (const p of planned) {
    const key = targetKey(p.target);
    const model = byKey.get(key);
    if (!model) {
      missingTargets.push(key);
      continue;
    }
    const warnings: string[] = [...(model.warnings ?? [])];
    if (!p.spec) warnings.push(`no PLACEMENT_SPECS entry for ${key} — geometry unverified`);
    derivatives.push({
      target: p.target, // authoritative — includes the real target_ref ids
      dimensions: p.dimensions ?? model.dimensions,
      adaptation: finalizeAdaptation(model.adaptation, p, slideCount),
      copy: model.copy,
      limits: { ...(model.limits ?? {}), ...p.limits }, // spec ceilings win
      warnings,
    });
  }

  return { output: { derivatives }, missingTargets, droppedTargets };
}

// ── Stage 1: concepts ────────────────────────────────────────────────────────
export async function runConcepts(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<ConceptsOutput>> {
  assertFactsViable(input);
  const ledger = deps.ledger ?? createRoleLedger();
  const ctx = buildGroundingCtx(input);
  const system = conceptsSystem(promptCtx(input));
  const run = await runStage<ConceptsOutput>(
    'concepts',
    'creative_concepts',
    system,
    (feedback) => conceptsUser(input) + (feedback ? `\n\n${feedback}` : ''),
    CONCEPTS_OUTPUT_SCHEMA as JSONSchema,
    (raw) => raw,
    (out) => validateConcepts(out, ctx),
    deps,
    ledger,
  );
  return stageResult(run, ledger);
}

// ── Stage 2: package (+ regenerate) ──────────────────────────────────────────
async function runPackageStage(
  input: DirectorInput,
  deps: DirectorDeps,
  userBuilder: (feedback: string | null) => string,
): Promise<DirectorStageResult<BasePackage>> {
  assertFactsViable(input);
  const ledger = deps.ledger ?? createRoleLedger();
  const ctx = buildGroundingCtx(input);
  const system = packageSystem(promptCtx(input));
  const run = await runStage<BasePackage>(
    'package',
    'creative_package',
    system,
    userBuilder,
    BASE_PACKAGE_SCHEMA as JSONSchema,
    (raw) => sanitizeBasePackage(input, raw),
    (out) => validateBase(out, ctx),
    deps,
    ledger,
  );
  return stageResult(run, ledger);
}

export async function runPackage(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<BasePackage>> {
  return runPackageStage(input, deps, (feedback) => packageUser(input) + (feedback ? `\n\n${feedback}` : ''));
}

export async function runRegenerate(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<BasePackage>> {
  if (!input.previousPackage) {
    throw new Error('facts_insufficient: runRegenerate requires input.previousPackage — nothing to regenerate from');
  }
  return runPackageStage(input, deps, (feedback) => regenerateUser(input) + (feedback ? `\n\n${feedback}` : ''));
}

// ── Stage 3: derivatives ─────────────────────────────────────────────────────
export async function runDerivatives(
  input: DirectorInput & { basePackage: BasePackage },
  deps: DirectorDeps,
): Promise<DirectorStageResult<DerivativesOutput>> {
  assertFactsViable(input);
  const ledger = deps.ledger ?? createRoleLedger();
  const ctx = buildGroundingCtx(input);
  const planned = planAdaptations(input.basePackage, input.targets, input.specs);
  const system = derivativesSystem(promptCtx(input));

  let missing: string[] = [];
  let dropped: string[] = [];
  const run = await runStage<DerivativesOutput>(
    'derivatives',
    'creative_derivatives',
    system,
    (feedback) => derivativesUser(input, planned) + (feedback ? `\n\n${feedback}` : ''),
    DERIVATIVES_OUTPUT_SCHEMA as JSONSchema,
    (raw) => {
      const post = finalizeDerivatives(input, raw, planned);
      missing = post.missingTargets;
      dropped = post.droppedTargets;
      return post.output;
    },
    (out) => {
      const v = validateDerivatives(out, ctx);
      const errors: Violation[] = [...v.errors];
      for (const key of missing) {
        errors.push({ path: 'derivatives', rule: 'target_missing', detail: `selected target ${key} has no derivative — every selected target needs one` });
      }
      const warnings: Violation[] = [
        ...v.warnings,
        ...dropped.map((key) => ({ path: 'derivatives', rule: 'target_not_selected', detail: `model emitted a derivative for non-selected target ${key} — dropped` })),
      ];
      return { ok: errors.length === 0, errors, warnings };
    },
    deps,
    ledger,
  );
  return stageResult(run, ledger);
}
