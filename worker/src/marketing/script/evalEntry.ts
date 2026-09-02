/**
 * Script Writer v2 — evaluation entry point (no queue, no draft row).
 *
 * Runs the SAME pipeline as runScriptJob (brief → facts → retrieve → write →
 * validate → review → repair) but touches NO job infrastructure: nothing is
 * written to mos_script_jobs, mos_script_drafts, and no notification is sent.
 * Used by the EVAL harness to score the writer against golden sets, with
 * optional per-role model overrides (A/B of writer/reviewer/classifier).
 *
 * When `input.content_id` is absent a synthetic brief is built from the
 * project record alone (same buildBrief code path, with an empty RawBrief
 * shell) so evals can run against a project without a content item.
 *
 * KEEP IN SYNC with runScriptJob.ts — the stage order and gating rules are
 * deliberately identical; only the persistence/notify steps are removed.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  callRole, createRoleLedger, embed, hasKindPrefix, ledgerToJson, recordRoleUse, resolveRoles,
  PROVIDER_KINDS, type AiContext, type ProviderKind, type RoleConfig, type RoleKey,
} from '../../ai/index.js';
import { loadOrgIdentifiers, loadSettings, withScriptPrefix } from '../../runScriptJob.js';
import { buildBrief, DEFAULT_RECIPE, loadBrief, loadRecipes, type RawBrief } from './brief.js';
import { buildBlocklist } from './entities.js';
import { buildFactsPackage, loadProjectRecord, resolveLookupName } from './facts.js';
import { generateScript } from './generate.js';
import type { WriterPromptInput } from './prompts.js';
import { retrieveExemplars } from './retrieve.js';
import { judgeScript, needsRepair, repair } from './review.js';
import {
  type Brief, type BriefOverrides, type CallRole, type EmbedFn, type Exemplar,
  type FactsPackage, type GenerationOutput, type RecipeRow, type ReviewReport,
} from './types.js';
import { validateScript } from './validate.js';

export interface ScriptEvalInput {
  /** When set, the brief comes from mos_script_brief exactly like a real job. */
  content_id?: string;
  /** Required when content_id is absent — the brief is synthesised from this project. */
  project_id?: string;
  recipe: string;
  duration_sec?: number;
}

export type ScriptEvalRoleKey = 'script_writer' | 'script_reviewer' | 'claim_classifier';
export type ScriptEvalRoleOverrides = Partial<Record<ScriptEvalRoleKey, { provider: string; model: string }>>;

export interface ScriptEvalResult {
  /** The would-be mos_script_drafts row (brief, facts, exemplars, plan, scenes, hooks, review, status, roles, cost_usd). NOT inserted. */
  draft: Record<string, unknown>;
  review: ReviewReport;
  /** Summed over every role call; null when ANY call had an unknown price (never coerced to 0). */
  cost_usd: number | null;
  /** Wall-clock milliseconds for the whole pipeline. */
  latency_ms: number;
  roles: Record<string, unknown>;
}

/** Service client from env — loud when misconfigured (never a silent default). */
function serviceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('eval misconfigured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment');
  return createClient(url, key);
}

/** Validate + map role overrides into RoleConfigs for AiContext.roles. */
function toRoleConfigs(o: ScriptEvalRoleOverrides | undefined): Partial<Record<RoleKey, RoleConfig>> | undefined {
  if (!o) return undefined;
  const out: Partial<Record<RoleKey, RoleConfig>> = {};
  for (const k of ['script_writer', 'script_reviewer', 'claim_classifier'] as const) {
    const v = o[k];
    if (!v) continue;
    if (!(PROVIDER_KINDS as readonly string[]).includes(v.provider)) {
      throw new Error(`eval role override '${k}' has invalid provider '${v.provider}' (expected ${PROVIDER_KINDS.join(' | ')})`);
    }
    if (!v.model.trim()) throw new Error(`eval role override '${k}' has an empty model`);
    out[k] = { provider: v.provider as ProviderKind, model: v.model };
  }
  return out;
}

interface SyntheticBrief { brief: Brief; recipe: RecipeRow; record: Record<string, unknown> }

/**
 * Brief without a content item: recipe from mos_script_recipes (unknown key →
 * walkthrough with a warning, mirroring loadBrief), then the same buildBrief
 * normalisation over an empty RawBrief shell anchored on the project.
 */
async function buildSyntheticBrief(sb: SupabaseClient, input: ScriptEvalInput, ctaDefault: string): Promise<SyntheticBrief> {
  const projectId = input.project_id;
  if (!projectId) throw new Error('facts_insufficient: eval needs content_id or project_id');
  const record = await loadProjectRecord(sb, projectId);
  if (!record) throw withScriptPrefix('facts_insufficient', `project ${projectId} not found in all_projects`);

  const recipes = await loadRecipes(sb);
  const wanted = input.recipe.trim() || DEFAULT_RECIPE;
  let recipe = recipes.find((r) => r.key === wanted);
  const warnings: string[] = [];
  if (!recipe) {
    recipe = recipes.find((r) => r.key === DEFAULT_RECIPE);
    if (!recipe) throw new Error('no active recipes in mos_script_recipes');
    warnings.push(`recipe '${wanted}' not found/active — using '${recipe.key}'`);
  }

  const raw: RawBrief = {
    content_id: `eval:${projectId}`,
    title: null,
    content_type_key: null,
    project_id: projectId,
    project_ids: [projectId],
    project_name: typeof record.project_name === 'string' ? record.project_name : null,
    multi_project_warning: false,
    campaign: null,
    purpose: null,
    platforms: [],
    objective: null,
    audience: null,
    language: 'ar',
    cta: null,
    angle: null,
    core_message: null,
    idea: null,
    hook: null,
    existing_scenes: [],
    assets_summary: null,
  };
  const brief = buildBrief(raw, recipe, { recipe: wanted, duration_sec: input.duration_sec ?? null }, ctaDefault);
  brief.warnings.push(...warnings);
  brief.warnings.push('synthetic eval brief — no content item, campaign, or existing scenes');
  return { brief, recipe, record };
}

export async function runScriptEval(input: ScriptEvalInput, roleOverrides?: ScriptEvalRoleOverrides): Promise<ScriptEvalResult> {
  const startedAt = Date.now();
  const sb = serviceClient();
  const ledger = createRoleLedger();
  const mapped = toRoleConfigs(roleOverrides);
  // Overrides go straight into ctx.roles (per the contract); everything else
  // resolves through mos_settings.ai_roles exactly like a production job.
  const aiCtx: AiContext = mapped ? { sb, roles: mapped } : { sb, roles: await resolveRoles(sb) };
  const call: CallRole = async <T,>(role: Parameters<CallRole>[0], req: Parameters<CallRole>[1]) => {
    const r = await callRole<T>(role, req, aiCtx);
    recordRoleUse(ledger, role, r);
    return r;
  };
  const embedFn: EmbedFn = async (role, req) => {
    const r = await embed(role, req, aiCtx);
    recordRoleUse(ledger, role, r);
    return r;
  };

  // ── brief (+ settings)
  const { rules, v2Enabled } = await loadSettings(sb);
  const overrides: BriefOverrides = { recipe: input.recipe, duration_sec: input.duration_sec ?? null };
  let brief: Brief;
  let recipe: RecipeRow;
  let record: Record<string, unknown> | null;
  if (input.content_id) {
    let loaded: Awaited<ReturnType<typeof loadBrief>>;
    try {
      loaded = await loadBrief(sb, input.content_id, overrides, rules.cta_default);
    } catch (err) {
      if (hasKindPrefix(err)) throw err;
      throw new Error(`brief failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    brief = loaded.brief;
    recipe = loaded.recipe;
    record = await loadProjectRecord(sb, brief.project_id);
  } else {
    const syn = await buildSyntheticBrief(sb, input, rules.cta_default);
    brief = syn.brief;
    recipe = syn.recipe;
    record = syn.record;
  }
  const mode: 'v2' | 'legacy' = v2Enabled ? 'v2' : 'legacy';
  if (!v2Enabled) {
    brief.warnings.push('script_writer_v2 is disabled — legacy-equivalent generation (no exemplars, no judge, no repair)');
    console.warn('[script/eval] script_writer_v2 disabled → legacy mode');
  }

  // ── facts
  if (!record) throw withScriptPrefix('facts_insufficient', `project ${brief.project_id} not found in all_projects`);
  const developerName = await resolveLookupName(sb, record.developer);
  const marketerName = await resolveLookupName(sb, record.marketer);
  const facts: FactsPackage = buildFactsPackage(record, { developerName, marketerName });
  if (!facts.viable) throw withScriptPrefix('facts_insufficient', `missing ${facts.missing.join(', ') || 'core facts'}${facts.warnings.length ? ` — ${facts.warnings.join('; ')}` : ''}`);
  for (const req of recipe.requires_facts) {
    if (!facts.facts.some((f) => f.class === req && f.claimable)) throw withScriptPrefix('facts_insufficient', `recipe '${recipe.key}' requires a claimable '${req}' fact${facts.sold_out ? ' (project is sold out)' : ''}`);
  }

  // ── retrieve
  let exemplars: Exemplar[] = [];
  let retrievalMeta: Record<string, unknown> = { mode: 'skipped' };
  if (v2Enabled) {
    const r = await retrieveExemplars({ sb, embed: embedFn }, brief, facts, recipe);
    exemplars = r.exemplars;
    brief.warnings.push(...r.warnings);
    retrievalMeta = { mode: r.mode, embedding: r.embedding ?? null, query_text: r.query_text, count: r.exemplars.length };
    console.log(`[script/eval] exemplars=${exemplars.length} mode=${r.mode}`);
  }

  // ── write
  const promptInput: WriterPromptInput = { brief, facts, exemplars, recipe, rules };
  let gen: GenerationOutput;
  try {
    gen = (await generateScript(call, promptInput)).output;
  } catch (err) {
    if (hasKindPrefix(err)) throw err;
    throw withScriptPrefix('provider', err instanceof Error ? err.message : String(err));
  }

  // ── validate
  const orgs = v2Enabled && exemplars.length ? await loadOrgIdentifiers(sb, exemplars) : [];
  const blocklist = buildBlocklist({ brief, exemplars, orgs, projectRecord: record, developerName, marketerName, rules });
  const validatorCall: CallRole | null = v2Enabled ? call : null;
  let v = await validateScript({ brief, facts, recipe, rules, output: gen, exemplars, blocklist, callRole: validatorCall });
  let scenes = v.scenes;
  const report: ReviewReport = { validator: v.validator, repaired: false, final: v.hasFail ? 'needs_attention' : 'ok' };

  // ── review + repair (v2 only; the judge never sees the exemplars)
  if (v2Enabled) {
    try {
      const j = await judgeScript(call, { brief, facts, recipe, rules, scenes, hooks: gen.hooks, validator: v.validator });
      report.judge = j.judge;
    } catch (err) {
      if (hasKindPrefix(err)) throw err;
      throw withScriptPrefix('provider', err instanceof Error ? err.message : String(err));
    }
    if (needsRepair(report)) {
      let repaired: GenerationOutput;
      try {
        repaired = (await repair(call, promptInput, { ...gen, scenes }, report)).output;
      } catch (err) {
        if (hasKindPrefix(err)) throw err;
        throw withScriptPrefix('provider', err instanceof Error ? err.message : String(err));
      }
      const v2 = await validateScript({ brief, facts, recipe, rules, output: repaired, exemplars, blocklist, callRole: call });
      gen = repaired;
      v = v2;
      scenes = v2.scenes;
      report.validator = v2.validator;
      report.repaired = true;
      report.final = v2.hasFail ? 'needs_attention' : 'ok';
    }
  }

  // A script that STILL routes contact elsewhere or names a third party after
  // the repair is a hard failure, not a draft (same rule as runScriptJob).
  const stillLeaking = report.validator.checks.filter((c) => c.level === 'fail' && (c.key === 'contact_channel' || c.key === 'entity_leak'));
  if (report.repaired && stillLeaking.length) {
    throw withScriptPrefix('validation_unrepaired', stillLeaking.map((c) => `${c.key}: ${c.detail}`).join(' | '));
  }

  const status: 'draft' | 'needs_attention' = report.final === 'ok' ? 'draft' : 'needs_attention';
  const rolesJson = ledgerToJson(ledger);
  const draft: Record<string, unknown> = {
    content_id: brief.content_id,
    project_id: brief.project_id,
    recipe: recipe.key,
    brief: { ...brief, recipe_version: recipe.version, mode, retrieval: retrievalMeta },
    facts,
    exemplars,
    plan: { patterns_learned: gen.patterns_learned, scene_plan: gen.scene_plan, recipe: { key: recipe.key, version: recipe.version, structure: recipe.structure } },
    scenes,
    hooks: gen.hooks,
    chosen_hook: null,
    review: report,
    status,
    roles: rolesJson,
    cost_usd: ledger.cost_usd, // null stays null — unknown ≠ free
  };
  console.log(`[script/eval] status=${status} scenes=${scenes.length} cost=${ledger.cost_usd ?? 'unknown'} calls=${ledger.calls} latency=${Date.now() - startedAt}ms`);
  return { draft, review: report, cost_usd: ledger.cost_usd, latency_ms: Date.now() - startedAt, roles: rolesJson };
}
