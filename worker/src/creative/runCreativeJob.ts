/**
 * runCreativeJob — the mos_creative_jobs pipeline (contracts §3; brief
 * A-WORKER deliverable 2). ONE claimed job → ONE new package version.
 *
 * Kinds:
 *   post_concepts    brief→facts→brand→references→assets→targets→concepts→validate→persist
 *                    (package row stage='concepts' — the 2–3 concept cards)
 *   post_package     concepts package + params.concept_id | params.custom →
 *                    runPackage + runDerivatives → version stage='package' + derivatives + refs
 *   post_regenerate  previous package + params.revision_note → runRegenerate (+ derivatives
 *                    for the same targets) → NEW version; the old one → superseded
 *   post_derivatives new params.targets on an existing package → runDerivatives only →
 *                    NEW version carrying the same base + the new derivatives + refs
 *
 * Guarantees:
 *  - `mos_creative_job_stage` fires at every step (the SPA progress reads it).
 *  - A failed job leaves mos_content and existing packages UNTOUCHED. The one
 *    persist half-write (package inserted, derivatives/refs failed) marks that
 *    package `rejected` with revision_note='persist_failed: …' — never a silent
 *    orphan that looks like a usable draft.
 *  - Validation failure after the director's one retry NEVER throws (contracts
 *    §8): the draft is persisted with warnings and the job completes with
 *    result.needs_attention=true.
 *  - Roles ledger + cost land on BOTH the job row (result of this function,
 *    written by the lane) and the package row.
 *
 * Errors are classified by `classifyCreativeError` into the stable error_kind
 * vocabulary; the lane passes it to mos_creative_job_fail, which requeues only
 * 'provider'/'transient' while attempts < max_attempts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../env.js';
import {
  runConcepts,
  runDerivatives,
  runPackage,
  runRegenerate,
  type DirectorDeps,
  type DirectorStageResult,
} from './director/runDirector.js';
import type { DirectorInput } from './director/types.js';
import { callCreativeRole } from './roles.js';
import type { ValidationResult } from './grounding.js';
import type {
  BasePackage,
  Concept,
  ConceptsOutput,
  CreativeJobStage,
  DerivativesOutput,
  DerivativeTarget,
  PackageStage,
} from './contracts.js';
import * as defaultIo from './io.js';
import type { CreativeJobContext, CreativeJobLike } from './io.js';

// ── Error classification ─────────────────────────────────────────────────────

export type CreativeErrorKind =
  | 'provider'
  | 'provider_fatal'
  | 'transient'
  | 'output_truncated'
  | 'facts_insufficient'
  | 'validation_unrepaired'
  | 'rights_blocked'
  | 'policy_blocked'
  | 'budget_exceeded'
  | 'unknown';

const PREFIX_KINDS: ReadonlyArray<[prefix: string, kind: CreativeErrorKind]> = [
  ['provider:', 'provider'],
  ['facts_insufficient:', 'facts_insufficient'],
  ['validation_unrepaired:', 'validation_unrepaired'],
  ['rights_blocked:', 'rights_blocked'],
  ['policy_blocked:', 'policy_blocked'],
  ['budget_exceeded:', 'budget_exceeded'],
];

const TRANSIENT_RE = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|upstream request timeout|gateway timeout|503|502|504|rate.?limit|overloaded/i;

/**
 * A max_tokens truncation is DETERMINISTIC given the same role config — retrying
 * it fails identically (same lesson as the Hatif-webhook loop), while burning a
 * full model call each attempt. It arrives as `provider:anthropic max_tokens
 * reached …`, which would otherwise be classified 'provider' (retryable), so we
 * catch it FIRST and mark it non-retryable. Fix is to raise the role's
 * max_tokens, not to retry.
 */
const OUTPUT_TRUNCATED_RE = /max_tokens reached before the JSON was complete/i;

/**
 * DETERMINISTIC provider failures — a 4xx client error (bad request, invalid
 * schema, auth/permission) or an exhausted credit balance fails identically on
 * every retry (same lesson as the Hatif-webhook loop). They arrive `provider:`-
 * prefixed, which would otherwise requeue; catch them and mark 'provider_fatal'
 * so the job fails fast with a clear signal (fix billing / the request, not a
 * retry). The transient 429/5xx/overloaded/network cases are NOT matched here —
 * they stay 'provider' and requeue.
 */
const PROVIDER_FATAL_RE = /credit balance is too low|(BadRequest|Authentication|PermissionDenied|NotFound|UnprocessableEntity)Error\b|\binvalid_request_error\b/i;

/** Map a thrown error to the mos_creative_jobs.error_kind vocabulary (the RPC requeues only provider/transient). */
export function classifyCreativeError(err: unknown): { message: string; kind: CreativeErrorKind } {
  const message = err instanceof Error ? err.message : String(err);
  if (OUTPUT_TRUNCATED_RE.test(message)) return { message, kind: 'output_truncated' };
  // A deterministic provider 4xx must not requeue — check before the generic
  // `provider:` prefix (which would classify it retryable).
  if (message.startsWith('provider:') && PROVIDER_FATAL_RE.test(message)) return { message, kind: 'provider_fatal' };
  for (const [prefix, kind] of PREFIX_KINDS) {
    if (message.startsWith(prefix) || message.includes(` ${prefix}`)) return { message, kind };
  }
  if (TRANSIENT_RE.test(message)) return { message, kind: 'transient' };
  return { message, kind: 'unknown' };
}

// ── Injectable seams (tests fake these; production uses io.ts + runDirector) ──

export interface CreativeJobIo {
  loadJobContext(sb: SupabaseClient, job: CreativeJobLike, opts?: defaultIo.LoadJobContextOpts): Promise<CreativeJobContext>;
  loadPackageRow(sb: SupabaseClient, packageId: string): ReturnType<typeof defaultIo.loadPackageRow>;
  loadPackageTargets(sb: SupabaseClient, packageId: string): Promise<DerivativeTarget[]>;
  nextVersion(sb: SupabaseClient, contentId: string): Promise<number>;
  insertPackage(sb: SupabaseClient, args: defaultIo.InsertPackageArgs): Promise<string>;
  insertDerivatives(sb: SupabaseClient, packageId: string, derivatives: DerivativesOutput['derivatives']): Promise<void>;
  insertRefs(sb: SupabaseClient, packageId: string, base: BasePackage): Promise<void>;
  supersedePackage(sb: SupabaseClient, packageId: string): Promise<void>;
  rejectPackage(sb: SupabaseClient, packageId: string, note: string): Promise<void>;
  notifyRequester(sb: SupabaseClient, args: { requestedBy: string | null; contentId: string; contentTitle: string | null; stage: PackageStage }): Promise<void>;
  setStage(sb: SupabaseClient, jobId: string, stage: CreativeJobStage): Promise<void>;
}

export interface CreativeDirector {
  runConcepts(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<ConceptsOutput>>;
  runPackage(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<BasePackage>>;
  runRegenerate(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<BasePackage>>;
  runDerivatives(input: DirectorInput & { basePackage: BasePackage }, deps: DirectorDeps): Promise<DirectorStageResult<DerivativesOutput>>;
}

const realDirector: CreativeDirector = { runConcepts, runPackage, runRegenerate, runDerivatives };

/** Default io: the io.ts functions plus the stage-heartbeat RPC. */
function makeDefaultIo(): CreativeJobIo {
  return {
    loadJobContext: (sb, job, opts) => defaultIo.loadJobContext(sb, job, opts),
    loadPackageRow: (sb, id) => defaultIo.loadPackageRow(sb, id),
    loadPackageTargets: (sb, id) => defaultIo.loadPackageTargets(sb, id),
    nextVersion: (sb, id) => defaultIo.nextVersion(sb, id),
    insertPackage: (sb, args) => defaultIo.insertPackage(sb, args),
    insertDerivatives: (sb, id, d) => defaultIo.insertDerivatives(sb, id, d),
    insertRefs: (sb, id, b) => defaultIo.insertRefs(sb, id, b),
    supersedePackage: (sb, id) => defaultIo.supersedePackage(sb, id),
    rejectPackage: (sb, id, note) => defaultIo.rejectPackage(sb, id, note),
    notifyRequester: (sb, args) => defaultIo.notifyRequester(sb, args),
    setStage: async (sb, jobId, stage) => {
      const { error } = await sb.rpc('mos_creative_job_stage', { p_job_id: jobId, p_stage: stage });
      if (error) throw new Error(`provider:supabase mos_creative_job_stage failed: ${error.message}`);
    },
  };
}

// ── Outcome ──────────────────────────────────────────────────────────────────

export interface CreativeJobOutcome {
  /** mos_creative_job_complete p_result. */
  result: Record<string, unknown>;
  /** mos_creative_job_complete p_roles (stage-keyed when several stages ran). */
  roles: Record<string, unknown>;
  /** mos_creative_job_complete p_cost_usd — null when any stage's cost was unknown. */
  cost_usd: number | null;
}

export interface RunCreativeJobArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: CreativeJobLike;
  /** Test seam — production uses io.ts. */
  io?: CreativeJobIo;
  /** Test seam — production uses A-GEN runDirector with callCreativeRole. */
  director?: CreativeDirector;
  log?: (msg: string, extra?: unknown) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface StageAggregate {
  needsAttention: boolean;
  roles: Record<string, unknown>;
  cost: number | null;
  errors: ValidationResult['errors'];
  warnings: ValidationResult['warnings'];
  retried: boolean;
}

function newAggregate(): StageAggregate {
  return { needsAttention: false, roles: {}, cost: 0, errors: [], warnings: [], retried: false };
}

function fold<T>(agg: StageAggregate, stageKey: string, res: DirectorStageResult<T>): void {
  agg.needsAttention = agg.needsAttention || res.needs_attention;
  agg.retried = agg.retried || res.retried;
  agg.roles[stageKey] = res.rolesJson;
  if (agg.cost !== null) {
    agg.cost = res.cost_usd === null ? null : agg.cost + res.cost_usd;
  }
  agg.errors.push(...res.validation.errors);
  agg.warnings.push(...res.validation.warnings);
}

function mergedValidation(agg: StageAggregate): ValidationResult {
  return { ok: agg.errors.length === 0, errors: agg.errors, warnings: agg.warnings };
}

function factsUsedOf(base: BasePackage, derivatives: DerivativesOutput['derivatives']): string[] {
  const ids = new Set<string>(base.facts_used ?? []);
  for (const d of derivatives) {
    for (const f of (d.copy as { fact_refs?: string[] }).fact_refs ?? []) ids.add(f);
  }
  return [...ids];
}

// ── The job runner ───────────────────────────────────────────────────────────

export async function runCreativeJob(args: RunCreativeJobArgs): Promise<CreativeJobOutcome> {
  const { supabase: sb, job } = args;
  const io = args.io ?? makeDefaultIo();
  const director = args.director ?? realDirector;
  const log = args.log ?? ((msg: string, extra?: unknown) => { if (extra !== undefined) console.log(`[creative] ${msg}`, extra); else console.log(`[creative] ${msg}`); });
  const directorDeps: DirectorDeps = {
    callRole: (key, req) => callCreativeRole(key, req, { sb }),
    log,
  };

  /** Stage heartbeat — observability only; a failed heartbeat must never kill the job. */
  const stage = async (s: CreativeJobStage): Promise<void> => {
    try {
      await io.setStage(sb, job.id, s);
    } catch (e) {
      console.error(`[creative] mos_creative_job_stage('${s}') failed (non-fatal):`, e instanceof Error ? e.message : e);
    }
  };

  const agg = newAggregate();

  // ── Shared context (brief→facts→brand→references→assets→targets heartbeats
  //    fire inside loadJobContext via onStage). ──
  let ctx: CreativeJobContext | null = null;
  const loadCtx = async (concept?: Concept | null): Promise<CreativeJobContext> => {
    if (ctx && !concept) return ctx;
    const loaded = await io.loadJobContext(sb, job, {
      onStage: (s) => { void stage(s); },
      concept: concept ?? null,
      log,
    });
    if (!concept) ctx = loaded;
    return loaded;
  };

  /** Persist + notify + build the outcome. On a derivatives/refs failure AFTER
   *  the package insert, the package is marked rejected (persist_failed) and
   *  the error rethrown — never a silent half-written draft. */
  const persistAndFinish = async (opts: {
    packageStage: PackageStage;
    insert: defaultIo.InsertPackageArgs;
    base: BasePackage | null;
    derivatives: DerivativesOutput['derivatives'];
    supersede?: string | null;
    notifyStage: PackageStage;
    contentTitle: string | null;
  }): Promise<CreativeJobOutcome> => {
    await stage('persist');
    const packageId = await io.insertPackage(sb, opts.insert);
    try {
      if (opts.base) {
        await io.insertDerivatives(sb, packageId, opts.derivatives);
        await io.insertRefs(sb, packageId, opts.base);
      }
    } catch (e) {
      const note = `persist_failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      try {
        await io.rejectPackage(sb, packageId, note);
      } catch (rejectErr) {
        console.error(`[creative] could not mark package ${packageId} rejected after a persist failure:`, rejectErr instanceof Error ? rejectErr.message : rejectErr);
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
    if (opts.supersede) await io.supersedePackage(sb, opts.supersede);
    await io.notifyRequester(sb, {
      requestedBy: job.requested_by,
      contentId: job.content_id,
      contentTitle: opts.contentTitle,
      stage: opts.notifyStage,
    });
    const validation = mergedValidation(agg);
    return {
      result: {
        package_id: packageId,
        stage: opts.packageStage,
        needs_attention: agg.needsAttention,
        retried: agg.retried,
        validation,
      },
      roles: agg.roles,
      cost_usd: agg.cost,
    };
  };

  const baseInsertArgs = (
    context: CreativeJobContext,
    over: Partial<defaultIo.InsertPackageArgs> & Pick<defaultIo.InsertPackageArgs, 'version' | 'stage' | 'concepts' | 'base' | 'facts_used'>,
  ): defaultIo.InsertPackageArgs => ({
    content_id: job.content_id,
    intended_use: context.intendedUse ?? 'organic',
    language: context.content.language,
    recipe: context.recipe,
    concept_id: null,
    facts: { package: context.facts.package, refs: context.facts.refs } as unknown as Record<string, unknown>,
    brand_kit_version: context.brandKit?.version ?? null,
    brand_kit_mode: context.brandKit?.mode ?? null,
    roles: agg.roles,
    cost_usd: agg.cost,
    job_id: job.id,
    created_by_user_id: job.requested_by,
    revision_note: null,
    ...over,
  });

  switch (job.kind) {
    // ── concepts ────────────────────────────────────────────────────────────
    case 'post_concepts': {
      const context = await loadCtx();
      await stage('concepts');
      const res = await director.runConcepts(context.toDirectorInput(), directorDeps);
      fold(agg, 'concepts', res);
      await stage('validate');
      const version = await io.nextVersion(sb, job.content_id);
      return persistAndFinish({
        packageStage: 'concepts',
        insert: baseInsertArgs(context, {
          version,
          stage: 'concepts',
          concepts: res.output as unknown as Record<string, unknown>,
          base: null,
          facts_used: [],
        }),
        base: null,
        derivatives: [],
        notifyStage: 'concepts',
        contentTitle: context.content.title,
      });
    }

    // ── package (chosen concept → base + derivatives) ───────────────────────
    case 'post_package': {
      const sourcePackageId = typeof job.params.package_id === 'string' ? job.params.package_id : null;
      if (!sourcePackageId) throw new Error('post_package job is missing params.package_id (the concepts package)');
      const conceptsRow = await io.loadPackageRow(sb, sourcePackageId);
      if (!conceptsRow || !conceptsRow.concepts) {
        throw new Error(`post_package: concepts package ${sourcePackageId} not found or has no concepts`);
      }
      const concepts = conceptsRow.concepts as ConceptsOutput;
      const conceptId = typeof job.params.concept_id === 'string' ? job.params.concept_id : null;
      const custom = job.params.custom && typeof job.params.custom === 'object'
        ? (job.params.custom as { title: string; angle: string; format: Concept['format'] })
        : null;
      if (!conceptId && !custom) throw new Error('post_package job needs params.concept_id or params.custom');
      const concept = conceptId ? (concepts.concepts ?? []).find((c) => c.id === conceptId) ?? null : null;
      if (conceptId && !concept && !custom) {
        throw new Error(`post_package: concept '${conceptId}' is not in the concepts package ${sourcePackageId}`);
      }
      const context = await loadCtx(concept);

      await stage('package');
      const pkgRes = await director.runPackage(
        context.toDirectorInput({
          conceptChoice: { concept_id: conceptId, concept, custom },
          concepts,
        }),
        directorDeps,
      );
      fold(agg, 'package', pkgRes);

      await stage('derivatives');
      const derRes = await director.runDerivatives(
        { ...context.toDirectorInput(), basePackage: pkgRes.output },
        directorDeps,
      );
      fold(agg, 'derivatives', derRes);
      await stage('validate');

      const version = await io.nextVersion(sb, job.content_id);
      return persistAndFinish({
        packageStage: 'package',
        insert: baseInsertArgs(context, {
          version,
          stage: 'package',
          concept_id: conceptId,
          concepts: null,
          base: pkgRes.output as unknown as Record<string, unknown>,
          facts_used: factsUsedOf(pkgRes.output, derRes.output.derivatives),
        }),
        base: pkgRes.output,
        derivatives: derRes.output.derivatives,
        notifyStage: 'package',
        contentTitle: context.content.title,
      });
    }

    // ── regenerate (previous package + note → new version; old superseded) ──
    case 'post_regenerate': {
      const prevId = typeof job.params.package_id === 'string' ? job.params.package_id : null;
      if (!prevId) throw new Error('post_regenerate job is missing params.package_id');
      const prev = await io.loadPackageRow(sb, prevId);
      if (!prev || !prev.base) throw new Error(`post_regenerate: package ${prevId} not found or has no base`);
      const revisionNote = typeof job.params.revision_note === 'string' ? job.params.revision_note : '';
      const context = await loadCtx();

      await stage('package');
      const pkgRes = await director.runRegenerate(
        context.toDirectorInput({ previousPackage: prev.base, revisionNote }),
        directorDeps,
      );
      fold(agg, 'package', pkgRes);

      // The regenerated base invalidates the old derivatives — re-run them for
      // the same targets (params.targets override), so the new version is a
      // COMPLETE deliverable (there is no separate "re-derive" UI action).
      const inherited = context.targets.length === 0;
      const targets = inherited ? await io.loadPackageTargets(sb, prevId) : context.targets;
      const specs = inherited ? defaultIo.specsForTargets(targets) : context.specs;
      let derivatives: DerivativesOutput['derivatives'] = [];
      if (targets.length > 0) {
        await stage('derivatives');
        const derRes = await director.runDerivatives(
          { ...context.toDirectorInput(), targets, specs, basePackage: pkgRes.output },
          directorDeps,
        );
        fold(agg, 'derivatives', derRes);
        derivatives = derRes.output.derivatives;
      } else {
        log('post_regenerate: previous package had no derivative targets — new version carries the base only');
      }
      await stage('validate');

      const version = await io.nextVersion(sb, job.content_id);
      return persistAndFinish({
        packageStage: 'package',
        insert: baseInsertArgs(context, {
          version,
          stage: 'package',
          intended_use: context.intendedUse ?? prev.intended_use,
          concept_id: prev.concept_id,
          concepts: null,
          base: pkgRes.output as unknown as Record<string, unknown>,
          facts_used: factsUsedOf(pkgRes.output, derivatives),
          revision_note: revisionNote || null,
        }),
        base: pkgRes.output,
        derivatives,
        supersede: prevId,
        notifyStage: 'package',
        contentTitle: context.content.title,
      });
    }

    // ── derivatives (new targets on an existing package → new version) ──────
    case 'post_derivatives': {
      const prevId = typeof job.params.package_id === 'string' ? job.params.package_id : null;
      if (!prevId) throw new Error('post_derivatives job is missing params.package_id');
      const prev = await io.loadPackageRow(sb, prevId);
      if (!prev || !prev.base) throw new Error(`post_derivatives: package ${prevId} not found or has no base`);
      const context = await loadCtx();
      if (context.targets.length === 0) {
        throw new Error('post_derivatives job needs params.targets — the new selected targets');
      }

      await stage('derivatives');
      const derRes = await director.runDerivatives(
        { ...context.toDirectorInput(), basePackage: prev.base },
        directorDeps,
      );
      fold(agg, 'derivatives', derRes);
      await stage('validate');

      const version = await io.nextVersion(sb, job.content_id);
      return persistAndFinish({
        packageStage: 'package',
        insert: baseInsertArgs(context, {
          version,
          stage: 'package',
          intended_use: context.intendedUse ?? prev.intended_use,
          concept_id: prev.concept_id,
          concepts: null,
          base: prev.base as unknown as Record<string, unknown>,
          facts_used: factsUsedOf(prev.base, derRes.output.derivatives),
          revision_note: typeof job.params.revision_note === 'string' ? job.params.revision_note : null,
        }),
        base: prev.base,
        derivatives: derRes.output.derivatives,
        // NOT superseded: a derivatives version EXTENDS the deliverable to new
        // targets — the previous version may carry applied captions/creative.
        supersede: null,
        notifyStage: 'package',
        contentTitle: context.content.title,
      });
    }
  }
}
