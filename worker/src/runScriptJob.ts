/**
 * Video-script lane v2 — drains public.mos_script_jobs.
 *
 * The in-app «اكتب سكربت» button enqueues a job and returns instantly; this
 * runs the multi-stage pipeline OFF the HTTP request and writes a DRAFT
 * (mos_script_drafts) — never mos_scenes: nothing reaches production scenes
 * without a human Apply (contracts §0).
 *
 * Stages (written via mos_script_job_stage so the SPA progress bar is honest):
 *   brief → facts → retrieve → write → validate → review → repair → draft
 *
 * Errors carry a stable kind prefix (contracts §12): `facts_insufficient:`,
 * `provider:`, `validation_unrepaired:` — index.ts maps them to error_kind.
 * When mos_settings.script_writer_v2.enabled is false, a minimal legacy-
 * equivalent generation runs (facts + writer + validator, no exemplars, no
 * judge, no repair) but STILL saves a draft.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { callRole, createRoleLedger, embed, hasKindPrefix, ledgerToJson, recordRoleUse, resolveRoles, type AiContext } from './ai/index.js';
import { loadBrief } from './marketing/script/brief.js';
import { buildBlocklist, type BlocklistInput } from './marketing/script/entities.js';
import { buildFactsPackage, loadProjectRecord, resolveLookupName } from './marketing/script/facts.js';
import { generateScript } from './marketing/script/generate.js';
import type { WriterPromptInput } from './marketing/script/prompts.js';
import { retrieveExemplars } from './marketing/script/retrieve.js';
import { judgeScript, needsRepair, repair } from './marketing/script/review.js';
import { DEFAULT_RULES, type Brief, type BriefOverrides, type CallRole, type EmbedFn, type Exemplar, type FactsPackage, type GenerationOutput, type ReviewReport, type ScriptWriterRules } from './marketing/script/types.js';
import { validateScript } from './marketing/script/validate.js';

export interface ScriptJob {
  id: string;
  contentId: string;
  recipe: string;
  requestedBy: string | null; // public.users.id (notify target)
  attempts: number;
}

export interface ScriptJobResult {
  draft_id: string;
  scene_count: number;
  hooks: string[];
  /** Summed over every role call; null when ANY call had an unknown price (never coerced to 0). */
  cost_usd: number | null;
  /** ledgerToJson(): {calls, cost_usd, unknown_cost_calls, tokens, latency_ms, roles:{<role>:{provider,model,version,calls,cost_usd,...}}} */
  roles: Record<string, unknown>;
  status: 'draft' | 'needs_attention';
  mode: 'v2' | 'legacy';
}

type Stage = 'brief' | 'facts' | 'retrieve' | 'write' | 'validate' | 'review' | 'repair' | 'draft';

export function withScriptPrefix(prefix: 'facts_insufficient' | 'provider' | 'validation_unrepaired', msg: string): Error {
  return new Error(`${prefix}:${msg}`);
}
const withPrefix = withScriptPrefix;

async function setStage(sb: SupabaseClient, jobId: string, stage: Stage): Promise<void> {
  const { error } = await sb.rpc('mos_script_job_stage', { p_job_id: jobId, p_stage: stage });
  // A stage write must never kill the job — but it must never be silent either.
  if (error) console.error(`[script] mos_script_job_stage(${stage}) failed for job=${jobId}: ${error.message}`);
  else console.log(`[script] job=${jobId} stage=${stage}`);
}

export async function loadSettings(sb: SupabaseClient): Promise<{ rules: ScriptWriterRules; v2Enabled: boolean }> {
  const { data, error } = await sb.from('mos_settings').select('key, value').in('key', ['script_writer_rules', 'script_writer_v2']);
  if (error) throw new Error(`mos_settings read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ key: string; value: unknown }>;
  const rulesRaw = rows.find((r) => r.key === 'script_writer_rules')?.value;
  const v2Raw = rows.find((r) => r.key === 'script_writer_v2')?.value;
  const rules: ScriptWriterRules = { ...DEFAULT_RULES, ...(rulesRaw && typeof rulesRaw === 'object' ? (rulesRaw as Partial<ScriptWriterRules>) : {}) };
  if (!Array.isArray(rules.forbidden_claim_classes)) rules.forbidden_claim_classes = DEFAULT_RULES.forbidden_claim_classes;
  const v2Enabled = !(v2Raw && typeof v2Raw === 'object' && (v2Raw as { enabled?: unknown }).enabled === false);
  return { rules, v2Enabled };
}

async function loadJobOverrides(sb: SupabaseClient, job: ScriptJob): Promise<BriefOverrides> {
  const { data, error } = await sb.from('mos_script_jobs').select('brief').eq('id', job.id).maybeSingle();
  if (error) throw new Error(`job brief read failed: ${error.message}`);
  const b = ((data as { brief?: unknown } | null)?.brief ?? {}) as Record<string, unknown>;
  const o: BriefOverrides = { recipe: job.recipe };
  if (typeof b.duration_sec === 'number') o.duration_sec = b.duration_sec;
  if (typeof b.audience === 'string') o.audience = b.audience;
  if (typeof b.objection === 'string') o.objection = b.objection;
  return o;
}

/** Org identifiers for the entity blocklist: names, website, handles, hashtags/mentions, CTAs. */
export async function loadOrgIdentifiers(sb: SupabaseClient, exemplars: Exemplar[]): Promise<NonNullable<BlocklistInput['orgs']>> {
  const orgIds = Array.from(new Set(exemplars.map((e) => e.organization_id).filter((x): x is string => !!x)));
  const postIds = exemplars.map((e) => e.content_post_id);
  const out = new Map<string, NonNullable<BlocklistInput['orgs']>[number]>();
  if (orgIds.length) {
    const o = await sb.from('mkt_organizations').select('id, name_ar, name_en, website').in('id', orgIds);
    if (o.error) throw new Error(`mkt_organizations read failed: ${o.error.message}`);
    for (const r of (o.data ?? []) as Array<{ id: string; name_ar: string | null; name_en: string | null; website: string | null }>) {
      out.set(r.id, { id: r.id, name_ar: r.name_ar, name_en: r.name_en, website: r.website, handles: [], hashtags: [], mentions: [], ctas: [], phones: [], urls: [] });
    }
    const a = await sb.from('mkt_social_accounts').select('organization_id, handle').in('organization_id', orgIds);
    if (a.error) throw new Error(`mkt_social_accounts read failed: ${a.error.message}`);
    for (const r of (a.data ?? []) as Array<{ organization_id: string; handle: string | null }>) {
      const org = out.get(r.organization_id);
      if (org && r.handle) org.handles!.push(r.handle);
    }
  }
  if (postIds.length) {
    const p = await sb.from('mkt_content_posts').select('id, organization_id, hashtags, mentions').in('id', postIds);
    if (p.error) throw new Error(`mkt_content_posts read failed: ${p.error.message}`);
    for (const r of (p.data ?? []) as Array<{ id: string; organization_id: string | null; hashtags: string[] | null; mentions: string[] | null }>) {
      const org = r.organization_id ? out.get(r.organization_id) : undefined;
      if (!org) continue;
      org.hashtags!.push(...(r.hashtags ?? []));
      org.mentions!.push(...(r.mentions ?? []));
    }
    const e = await sb.from('mkt_content_enrichment').select('content_post_id, organization_id, result').eq('status', 'done').in('content_post_id', postIds);
    if (e.error) throw new Error(`mkt_content_enrichment read failed: ${e.error.message}`);
    for (const r of (e.data ?? []) as Array<{ content_post_id: string; organization_id: string | null; result: Record<string, unknown> | null }>) {
      const ex = exemplars.find((x) => x.content_post_id === r.content_post_id);
      const org = (ex?.organization_id ?? r.organization_id) ? out.get((ex?.organization_id ?? r.organization_id)!) : undefined;
      if (!org) continue;
      const ctas = Array.isArray(r.result?.ctas) ? (r.result!.ctas as unknown[]).filter((c): c is string => typeof c === 'string') : [];
      org.ctas!.push(...ctas);
    }
  }
  return Array.from(out.values());
}

async function discardPendingDrafts(sb: SupabaseClient, contentId: string, jobId: string): Promise<void> {
  const { data, error } = await sb
    .from('mos_script_drafts')
    .update({ status: 'discarded', updated_at: new Date().toISOString() })
    .eq('content_id', contentId)
    .in('status', ['draft', 'needs_attention'])
    .select('id');
  if (error) throw new Error(`discard pending drafts failed: ${error.message}`);
  const n = (data ?? []).length;
  if (n > 0) console.warn(`[script] job=${jobId} discarded ${n} pending draft(s) for content=${contentId} (regenerate)`);
}

export async function runScriptJob(
  { supabase, job }: { supabase: SupabaseClient; env: WorkerEnv; job: ScriptJob },
): Promise<ScriptJobResult> {
  const sb = supabase;
  const ledger = createRoleLedger();
  const roles = await resolveRoles(sb);
  const aiCtx: AiContext = { sb, roles };
  const call: CallRole = async <T,>(role: Parameters<CallRole>[0], input: Parameters<CallRole>[1]) => {
    const r = await callRole<T>(role, input, aiCtx);
    recordRoleUse(ledger, role, r);
    return r;
  };
  const embedFn: EmbedFn = async (role, input) => {
    const r = await embed(role, input, aiCtx);
    recordRoleUse(ledger, role, r);
    return r;
  };

  // ── brief
  await setStage(sb, job.id, 'brief');
  const { rules, v2Enabled } = await loadSettings(sb);
  const overrides = await loadJobOverrides(sb, job);
  let loaded: Awaited<ReturnType<typeof loadBrief>>;
  try {
    loaded = await loadBrief(sb, job.contentId, overrides, rules.cta_default);
  } catch (err) {
    if (hasKindPrefix(err)) throw err;
    throw new Error(`brief failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { brief, recipe } = loaded;
  const mode: ScriptJobResult['mode'] = v2Enabled ? 'v2' : 'legacy';
  if (!v2Enabled) {
    brief.warnings.push('script_writer_v2 is disabled — legacy-equivalent generation (no exemplars, no judge, no repair); draft still saved');
    console.warn(`[script] job=${job.id} script_writer_v2 disabled → legacy mode`);
  }

  // ── facts
  await setStage(sb, job.id, 'facts');
  const record = await loadProjectRecord(sb, brief.project_id);
  if (!record) throw withPrefix('facts_insufficient', `project ${brief.project_id} not found in all_projects`);
  const developerName = await resolveLookupName(sb, record.developer);
  const marketerName = await resolveLookupName(sb, record.marketer);
  const facts: FactsPackage = buildFactsPackage(record, { developerName, marketerName });
  if (!facts.viable) throw withPrefix('facts_insufficient', `missing ${facts.missing.join(', ') || 'core facts'}${facts.warnings.length ? ` — ${facts.warnings.join('; ')}` : ''}`);
  for (const req of recipe.requires_facts) {
    if (!facts.facts.some((f) => f.class === req && f.claimable)) throw withPrefix('facts_insufficient', `recipe '${recipe.key}' requires a claimable '${req}' fact${facts.sold_out ? ' (project is sold out)' : ''}`);
  }

  // ── retrieve
  let exemplars: Exemplar[] = [];
  let retrievalMeta: Record<string, unknown> = { mode: 'skipped' };
  if (v2Enabled) {
    await setStage(sb, job.id, 'retrieve');
    const r = await retrieveExemplars({ sb, embed: embedFn }, brief, facts, recipe);
    exemplars = r.exemplars;
    brief.warnings.push(...r.warnings);
    retrievalMeta = { mode: r.mode, embedding: r.embedding ?? null, query_text: r.query_text, count: r.exemplars.length };
    console.log(`[script] job=${job.id} exemplars=${exemplars.length} mode=${r.mode}`);
  }

  // ── write
  await setStage(sb, job.id, 'write');
  const promptInput: WriterPromptInput = { brief, facts, exemplars, recipe, rules };
  let gen: GenerationOutput;
  try {
    gen = (await generateScript(call, promptInput)).output;
  } catch (err) {
    if (hasKindPrefix(err)) throw err;
    throw withPrefix('provider', err instanceof Error ? err.message : String(err));
  }

  // ── validate
  await setStage(sb, job.id, 'validate');
  const orgs = v2Enabled && exemplars.length ? await loadOrgIdentifiers(sb, exemplars) : [];
  const blocklist = buildBlocklist({ brief, exemplars, orgs, projectRecord: record, developerName, marketerName, rules });
  const validatorCall: CallRole | null = v2Enabled ? call : null;
  let v = await validateScript({ brief, facts, recipe, rules, output: gen, exemplars, blocklist, callRole: validatorCall });
  let scenes = v.scenes;
  const report: ReviewReport = { validator: v.validator, repaired: false, final: v.hasFail ? 'needs_attention' : 'ok' };

  // ── review (independent judge — never sees the exemplars)
  if (v2Enabled) {
    await setStage(sb, job.id, 'review');
    try {
      const j = await judgeScript(call, { brief, facts, recipe, rules, scenes, hooks: gen.hooks, validator: v.validator });
      report.judge = j.judge;
    } catch (err) {
      if (hasKindPrefix(err)) throw err;
      throw withPrefix('provider', err instanceof Error ? err.message : String(err));
    }

    // ── repair (once)
    if (needsRepair(report)) {
      await setStage(sb, job.id, 'repair');
      let repaired: GenerationOutput;
      try {
        repaired = (await repair(call, promptInput, { ...gen, scenes }, report)).output;
      } catch (err) {
        if (hasKindPrefix(err)) throw err;
        throw withPrefix('provider', err instanceof Error ? err.message : String(err));
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
  // the repair must not even be offered as a draft (SKILL decisions log 2026-09-01).
  const stillLeaking = report.validator.checks.filter((c) => c.level === 'fail' && (c.key === 'contact_channel' || c.key === 'entity_leak'));
  if (report.repaired && stillLeaking.length) {
    throw withPrefix('validation_unrepaired', stillLeaking.map((c) => `${c.key}: ${c.detail}`).join(' | '));
  }

  // ── draft
  await setStage(sb, job.id, 'draft');
  await discardPendingDrafts(sb, job.contentId, job.id);
  const status: ScriptJobResult['status'] = report.final === 'ok' ? 'draft' : 'needs_attention';
  const rolesJson = ledgerToJson(ledger);
  const draftRow = {
    job_id: job.id,
    content_id: job.contentId,
    recipe: recipe.key,
    brief: { ...brief, recipe_version: recipe.version, mode, retrieval: retrievalMeta } satisfies Brief & Record<string, unknown>,
    facts,
    exemplars,
    plan: { patterns_learned: gen.patterns_learned, scene_plan: gen.scene_plan, recipe: { key: recipe.key, version: recipe.version, structure: recipe.structure } },
    scenes,
    hooks: gen.hooks,
    chosen_hook: null,
    review: report,
    status,
    roles: rolesJson,
    // mos_script_drafts.cost_usd is NOT NULL DEFAULT 0 (migration 2026-09-02_12) — an
    // explicit null would violate it. Omit when unknown so the DEFAULT applies; the
    // unknown stays LOUD in roles.cost_usd=null + roles.unknown_cost_calls>0 and in
    // the job return value (never coerced there — contracts §12).
    ...(ledger.cost_usd === null ? {} : { cost_usd: ledger.cost_usd }),
  };
  const ins = await sb.from('mos_script_drafts').insert(draftRow).select('id').single();
  if (ins.error) throw new Error(`draft insert failed: ${ins.error.message}`);
  const draftId = (ins.data as { id: string }).id;
  console.log(`[script] job=${job.id} draft=${draftId} status=${status} scenes=${scenes.length} cost=${ledger.cost_usd ?? 'unknown'} calls=${ledger.calls}`);

  // ── notify (best-effort; the draft is already committed — a lost bell must
  //    not fail the job, but it is logged loudly).
  try {
    const title = brief.title ? `«${brief.title}»` : '';
    const attention = status === 'needs_attention';
    await sb.rpc('notify_emit', {
      p_workspace: 'marketing',
      p_event: 'video_script_ready',
      p_role_keys: [],
      p_user_ids: job.requestedBy ? [job.requestedBy] : [],
      p_title_ar: attention ? 'مسودة السكربت جاهزة — تحتاج مراجعة' : 'مسودة السكربت جاهزة للمراجعة',
      p_title_en: attention ? 'Script draft ready — needs attention' : 'Script draft ready for review',
      p_body_ar: `مسودة من ${scenes.length} مشهد${title ? ` لـ${title}` : ''} — راجعها ثم اعتمدها لتدخل المشاهد`,
      p_body_en: `${scenes.length}-scene draft${brief.title ? ` for “${brief.title}”` : ''} — review and apply to create scenes`,
      p_url: `/m/content/${job.contentId}`,
    });
  } catch (e) {
    console.error('[script] video_script_ready notify failed', e);
  }

  return { draft_id: draftId, scene_count: scenes.length, hooks: gen.hooks, cost_usd: ledger.cost_usd, roles: rolesJson, status, mode };
}
