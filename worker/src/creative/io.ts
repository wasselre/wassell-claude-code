/**
 * Creative Director I/O — ALL database access for the mos_creative_jobs
 * pipeline (contracts §2/§3; brief A-WORKER deliverable 1).
 *
 * Everything the director needs is loaded HERE into a plain-data bag
 * (`CreativeJobContext`) — the director stages (A-GEN runDirector) stay pure.
 * Everything the pipeline writes goes through the dedicated RPCs / narrow
 * helpers below — never a read-modify-write of a shared blob from JS
 * (`mos_creative_package_patch` is the single-row jsonb_set for `base`).
 *
 * Error posture: a failed READ throws (loud — a lane that cannot read its
 * inputs must not guess them); `notifyRequester` is the ONE best-effort
 * writer (a lost bell must never fail a job that already committed — same
 * posture as runScriptJob's video_script_ready).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '../ai/index.js';
import { loadBrandKit } from './brandKit.js';
import { loadCreativeFacts, type CreativeFacts } from './facts.js';
import { rankCandidateAssets, type CandidateAssetRow } from './director/assets.js';
import type { CreativeReferenceRow } from './director/references.js';
import type { DirectorInput } from './director/types.js';
import { placementSpec, type PlacementSpec } from './placementSpecs.js';
import type {
  BasePackage,
  BrandKit,
  Concept,
  CreativeFlags,
  CreativeJobKind,
  CreativeJobStage,
  CreativePackageRow,
  Derivative,
  DerivativeTarget,
  IntendedUse,
  WriterRules,
} from './contracts.js';

// ── Job + content shapes ─────────────────────────────────────────────────────

/** The claimed mos_creative_jobs row (mos_creative_job_claim_next output). */
export interface CreativeJobLike {
  id: string;
  content_id: string;
  kind: CreativeJobKind;
  params: Record<string, unknown>;
  requested_by: string | null;
  attempts: number;
}

/** The mos_content_v slice the pipeline needs. */
export interface CreativeContentSlice {
  id: string;
  title: string | null;
  language: string;
  content_type_key: string | null;
  project_id: string | null;
  project_ids: string[];
  campaign_id: string | null;
  organic_platforms: string[];
}

/** Everything a job run needs, loaded once. */
export interface CreativeJobContext {
  content: CreativeContentSlice;
  /** Raw `mos_script_brief` jsonb (campaign/audience/platforms/language…). */
  brief: Record<string, unknown> | null;
  facts: CreativeFacts;
  brandKit: BrandKit | null;
  writerRules: WriterRules;
  flags: CreativeFlags;
  /** SELECTED targets (params.targets, target_ref enriched from publications/ads). */
  targets: DerivativeTarget[];
  /** PLACEMENT_SPECS entries matching the selected targets (deduped). */
  specs: PlacementSpec[];
  referenceRows: CreativeReferenceRow[];
  assetRows: CandidateAssetRow[];
  /** SigLIP-2 intent vector for the references RPC (null when unavailable). */
  qvec: number[] | null;
  /** The recipe key this run uses (job params win over the brief). */
  recipe: string | null;
  intendedUse: IntendedUse | null;
  /** Assemble the A-GEN director input bag (stage extras merged in). Callers that
   *  need a NON-nullable extra (e.g. basePackage for the derivatives stage) spread
   *  the result: `{ ...ctx.toDirectorInput(), basePackage }`. */
  toDirectorInput(extra?: Partial<DirectorInput>): DirectorInput;
}

// ── Small readers ────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** mos_settings.creative_writer — unreadable row throws (a lane must not guess its flags). */
export async function loadCreativeFlags(sb: SupabaseClient): Promise<CreativeFlags> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'creative_writer').maybeSingle();
  if (error) throw new Error(`provider:supabase mos_settings.creative_writer read failed: ${error.message}`);
  const v = asRecord((data as { value?: unknown } | null)?.value);
  return {
    post_enabled: v.post_enabled === true,
    ai_image_execution: v.ai_image_execution === true,
    design_reads_enabled: v.design_reads_enabled === true,
    asset_enrich_v2: v.asset_enrich_v2 === true,
    backfill_enabled: v.backfill_enabled === true,
  };
}

/** mos_settings.writer_rules — missing/malformed is logged and degrades to EMPTY rules (never a crash). */
export async function loadWriterRules(sb: SupabaseClient): Promise<WriterRules> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'writer_rules').maybeSingle();
  if (error) throw new Error(`provider:supabase mos_settings.writer_rules read failed: ${error.message}`);
  const v = (data as { value?: unknown } | null)?.value;
  const strArr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
  if (v === null || v === undefined) {
    console.error('[creative/io] mos_settings.writer_rules is missing — running with EMPTY rules (the 2026-09-02_25 seed should have created it)');
    return { shared: [], post: [], decisions_log: [] };
  }
  const r = asRecord(v);
  return {
    shared: strArr(r.shared),
    post: strArr(r.post),
    video: strArr(r.video),
    decisions_log: Array.isArray(r.decisions_log) ? (r.decisions_log as WriterRules['decisions_log']) : [],
  };
}

// ── Targets ──────────────────────────────────────────────────────────────────

const TARGET_KINDS = new Set(['organic', 'paid']);

/** Parse + validate job params.targets. Bad params are a caller bug — plain Error (terminal 'unknown', never retried). */
export function parseTargets(params: Record<string, unknown>): DerivativeTarget[] {
  const raw = params.targets;
  if (!Array.isArray(raw)) return [];
  const out: DerivativeTarget[] = [];
  for (const [i, t] of raw.entries()) {
    const r = asRecord(t);
    const kind = typeof r.target_kind === 'string' ? r.target_kind : '';
    const platform = typeof r.platform === 'string' ? r.platform : '';
    const placement = typeof r.placement_type === 'string' ? r.placement_type : '';
    if (!TARGET_KINDS.has(kind) || !platform || !placement) {
      throw new Error(
        `job params.targets[${i}] is not a DerivativeTarget (target_kind='${kind}', platform='${platform}', placement_type='${placement}')`,
      );
    }
    out.push({
      target_kind: kind as DerivativeTarget['target_kind'],
      platform,
      placement_type: placement as DerivativeTarget['placement_type'],
      target_ref: asRecord(r.target_ref) as DerivativeTarget['target_ref'],
    });
  }
  return out;
}

/**
 * Fill missing target_ref ids from the content's existing publications (organic)
 * and execution ads (paid). Best-effort enrichment: the API normally stamps
 * these at enqueue; this covers hand-built jobs. Only unambiguous matches fill
 * (latest publication per platform; a paid target only when exactly ONE
 * non-archived ad row exists) — anything else is left for the model/UI as-is.
 */
export async function enrichTargetRefs(
  sb: SupabaseClient,
  contentId: string,
  targets: DerivativeTarget[],
): Promise<DerivativeTarget[]> {
  if (targets.length === 0) return targets;
  const [pubs, ads] = await Promise.all([
    sb.from('mos_publications').select('id, platform, created_at').eq('content_id', contentId),
    sb.from('mos_execution_ads').select('id, execution_id, ad_set_id').eq('content_id', contentId).is('archived_at', null),
  ]);
  if (pubs.error) throw new Error(`provider:supabase mos_publications read failed: ${pubs.error.message}`);
  if (ads.error) throw new Error(`provider:supabase mos_execution_ads read failed: ${ads.error.message}`);
  const pubRows = (pubs.data ?? []) as Array<{ id: string; platform: string | null; created_at: string | null }>;
  const adRows = (ads.data ?? []) as Array<{ id: string; execution_id: string | null; ad_set_id: string | null }>;

  return targets.map((t) => {
    const ref = { ...(t.target_ref ?? {}) };
    if (t.target_kind === 'organic' && !ref.publication_id) {
      const matches = pubRows
        .filter((p) => p.platform === t.platform)
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      if (matches.length > 0) ref.publication_id = matches[0]!.id;
    }
    if (t.target_kind === 'paid' && adRows.length === 1) {
      const ad = adRows[0]!;
      if (!ref.execution_id && ad.execution_id) ref.execution_id = ad.execution_id;
      if (!ref.ad_set_id && ad.ad_set_id) ref.ad_set_id = ad.ad_set_id;
      if (!ref.ad_id) ref.ad_id = ad.id;
    }
    return { ...t, target_ref: ref };
  });
}

/** The deduped PLACEMENT_SPECS entries covering the selected targets (geometry is NEVER model-invented, contracts §0.7). */
export function specsForTargets(targets: DerivativeTarget[]): PlacementSpec[] {
  const seen = new Set<string>();
  const out: PlacementSpec[] = [];
  for (const t of targets) {
    const key = `${t.platform}:${t.placement_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spec = placementSpec(t.platform, t.placement_type);
    if (spec) out.push(spec);
    else console.error(`[creative/io] no PLACEMENT_SPECS entry for ${key} — the derivative for it will carry a 'geometry unverified' warning`);
  }
  return out;
}

// ── Intent vector (optional, never fatal) ────────────────────────────────────

const PUBLIC_BUCKETS = new Set(['marketing-assets', 'listing-photos']);

/** A fetchable URL for a files-row storage location: public bucket → public URL; private → short-lived signed URL (service client). */
export async function resolveFileUrl(sb: SupabaseClient, bucket: string, path: string): Promise<string | null> {
  if (PUBLIC_BUCKETS.has(bucket)) {
    const { data } = sb.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl ?? null;
  }
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 600);
  if (error) {
    console.error(`[creative/io] createSignedUrl failed for ${bucket}/${path}: ${error.message}`);
    return null;
  }
  return data?.signedUrl ?? null;
}

/**
 * SigLIP-2 intent vector off the TOP candidate asset (contracts §6) — only when
 * MODAL_CV_URL is set, and NEVER fatal: any failure logs and returns null
 * (the references RPC then ranks without cosine, p_qvec=null).
 */
export async function intentVector(
  sb: SupabaseClient,
  assetRows: CandidateAssetRow[],
  log?: (msg: string, extra?: unknown) => void,
): Promise<number[] | null> {
  if (!process.env.MODAL_CV_URL) return null;
  const top = assetRows.find((r) => !!r.storage_bucket && !!r.storage_path);
  if (!top) return null;
  try {
    const url = await resolveFileUrl(sb, top.storage_bucket as string, top.storage_path as string);
    if (!url) return null;
    const res = await embed('embed_image', { image_urls: [url] }, { sb });
    const vec = res.vectors?.[0] ?? null;
    if (vec) log?.(`intent vector embedded from top candidate asset ${top.file_id} (dim=${vec.length})`);
    return vec;
  } catch (e) {
    // Scoped to THIS call: a Modal outage must not lose the references ranking.
    console.error(`[creative/io] embed('embed_image') for the intent vector failed — continuing with p_qvec=null:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ── loadJobContext ───────────────────────────────────────────────────────────

export interface LoadJobContextOpts {
  /** Stage heartbeat hook (brief→facts→brand→references→assets→targets). */
  onStage?: (stage: CreativeJobStage) => void;
  /** Concept already chosen (post_package) — shapes the references intent. */
  concept?: Concept | null;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * Load everything a creative job needs, as plain data. Throws on any unreadable
 * input (content missing, no project, facts RPC failed…) — the caller maps the
 * error kind; `facts_insufficient:` propagates from loadCreativeFacts.
 */
export async function loadJobContext(
  sb: SupabaseClient,
  job: CreativeJobLike,
  opts: LoadJobContextOpts = {},
): Promise<CreativeJobContext> {
  // ── brief ── content row + the SQL brief.
  opts.onStage?.('brief');
  const [contentRes, briefRes] = await Promise.all([
    sb.from('mos_content_v')
      .select('id, title, language, content_type_key, project_id, project_ids, campaign_id, organic_platforms')
      .eq('id', job.content_id)
      .maybeSingle(),
    sb.rpc('mos_script_brief', { p_content_id: job.content_id }),
  ]);
  if (contentRes.error) throw new Error(`provider:supabase mos_content_v read failed: ${contentRes.error.message}`);
  if (!contentRes.data) throw new Error(`content ${job.content_id} not found in mos_content_v`);
  if (briefRes.error) throw new Error(`provider:supabase mos_script_brief failed: ${briefRes.error.message}`);
  const crow = contentRes.data as Record<string, unknown>;
  const content: CreativeContentSlice = {
    id: job.content_id,
    title: (crow.title as string | null) ?? null,
    language: typeof crow.language === 'string' && crow.language ? crow.language : 'ar',
    content_type_key: (crow.content_type_key as string | null) ?? null,
    project_id: (crow.project_id as string | null) ?? null,
    project_ids: Array.isArray(crow.project_ids) ? (crow.project_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    campaign_id: (crow.campaign_id as string | null) ?? null,
    organic_platforms: Array.isArray(crow.organic_platforms) ? (crow.organic_platforms as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  };
  const brief = (briefRes.data ?? null) as Record<string, unknown> | null;
  const projectId = content.project_id ?? content.project_ids[0] ?? null;
  if (!projectId) throw new Error('facts_insufficient: no project linked to this content item');

  const recipe = typeof job.params.recipe === 'string' && job.params.recipe.trim()
    ? job.params.recipe.trim()
    : (typeof brief?.recipe === 'string' ? (brief.recipe as string) : null);
  const intendedUseRaw = job.params.intended_use;
  const intendedUse: IntendedUse | null =
    intendedUseRaw === 'organic' || intendedUseRaw === 'paid' || intendedUseRaw === 'both' ? intendedUseRaw : null;

  // ── facts ──
  opts.onStage?.('facts');
  const facts = await loadCreativeFacts(sb, projectId);

  // ── brand ── (null = no usable kit; loadBrandKit already logged why)
  opts.onStage?.('brand');
  const brandKit = await loadBrandKit(sb);

  // ── references ── intent from the concept/recipe; wassel examples included.
  opts.onStage?.('references');
  const flags = await loadCreativeFlags(sb);
  const locationFact = facts.package.facts.find((f) => f.key === 'location');
  const locationVal = locationFact && typeof locationFact.value === 'object' && locationFact.value !== null
    ? (locationFact.value as { district?: unknown }).district
    : null;
  const intent: Record<string, unknown> = {};
  if (recipe) intent.recipe = recipe;
  if (opts.concept?.format) intent.format = opts.concept.format;
  else if (typeof job.params.format === 'string') intent.format = job.params.format;

  // ── assets ── candidate project images (RPC-ranked, then worker-ranked for the prompt cap).
  opts.onStage?.('assets');
  const { data: assetData, error: assetErr } = await sb.rpc('creative_candidate_assets', {
    p_project_id: projectId,
    p_limit: 40,
  });
  if (assetErr) throw new Error(`provider:supabase creative_candidate_assets failed: ${assetErr.message}`);
  const assetRows = rankCandidateAssets((assetData ?? []) as CandidateAssetRow[], {
    recipe,
    format: opts.concept?.format,
    limit: 12,
  });

  // Intent vector off the top candidate asset (needs the asset rows → after the assets step).
  const qvecFinal = await intentVector(sb, assetRows, opts.log);

  const { data: refData, error: refErr } = await sb.rpc('mkt_creative_references', {
    p_project_id: projectId,
    p_district: typeof locationVal === 'string' ? locationVal : null,
    p_unit_types: [],
    p_purpose: recipe ? [recipe] : [],
    p_intent: intent,
    p_include_wassel: true,
    p_qvec: qvecFinal ? `[${qvecFinal.join(',')}]` : null,
    p_limit: 24,
  });
  if (refErr) throw new Error(`provider:supabase mkt_creative_references failed: ${refErr.message}`);
  const referenceRows = (refData ?? []) as CreativeReferenceRow[];

  // ── targets ── selected targets + their specs.
  opts.onStage?.('targets');
  const targets = await enrichTargetRefs(sb, job.content_id, parseTargets(job.params));
  const specs = specsForTargets(targets);
  const writerRules = await loadWriterRules(sb);

  const ctx: CreativeJobContext = {
    content,
    brief,
    facts,
    brandKit,
    writerRules,
    flags,
    targets,
    specs,
    referenceRows,
    assetRows,
    qvec: qvecFinal,
    recipe,
    intendedUse,
    toDirectorInput(extra) {
      const input: DirectorInput = {
        brief,
        content: { language: content.language, title: content.title, content_type_key: content.content_type_key },
        facts,
        brandKit,
        rules: writerRules,
        targets,
        specs,
        referenceRows,
        assetRows,
      };
      if (recipe) input.recipe = recipe;
      if (intendedUse) input.intendedUse = intendedUse;
      return { ...input, ...extra };
    },
  };
  return ctx;
}

// ── Package row reads ────────────────────────────────────────────────────────

/** A full package row (null when it does not exist). */
export async function loadPackageRow(sb: SupabaseClient, packageId: string): Promise<CreativePackageRow | null> {
  const { data, error } = await sb.from('mos_creative_packages').select('*').eq('id', packageId).maybeSingle();
  if (error) throw new Error(`provider:supabase mos_creative_packages read failed: ${error.message}`);
  return (data as CreativePackageRow | null) ?? null;
}

/** The derivative targets of an existing package (for regenerate/derivatives re-runs). */
export async function loadPackageTargets(sb: SupabaseClient, packageId: string): Promise<DerivativeTarget[]> {
  const { data, error } = await sb
    .from('mos_creative_derivatives')
    .select('target_kind, platform, placement_type, target_ref')
    .eq('package_id', packageId);
  if (error) throw new Error(`provider:supabase mos_creative_derivatives read failed: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    target_kind: r.target_kind as DerivativeTarget['target_kind'],
    platform: String(r.platform),
    placement_type: r.placement_type as DerivativeTarget['placement_type'],
    target_ref: asRecord(r.target_ref) as DerivativeTarget['target_ref'],
  }));
}

// ── Package writes ───────────────────────────────────────────────────────────

export async function nextVersion(sb: SupabaseClient, contentId: string): Promise<number> {
  const { data, error } = await sb.rpc('mos_creative_package_next_version', { p_content_id: contentId });
  if (error) throw new Error(`provider:supabase mos_creative_package_next_version failed: ${error.message}`);
  return typeof data === 'number' ? data : 1;
}

export interface InsertPackageArgs {
  content_id: string;
  version: number;
  stage: 'concepts' | 'package';
  intended_use: IntendedUse;
  language: string;
  recipe: string | null;
  concept_id: string | null;
  concepts: Record<string, unknown> | null;
  base: Record<string, unknown> | null;
  facts: Record<string, unknown>;
  facts_used: string[];
  brand_kit_version: number | null;
  brand_kit_mode: 'advisory' | 'constraint' | null;
  roles: Record<string, unknown>;
  cost_usd: number | null;
  job_id: string;
  created_by_user_id: string | null;
  revision_note: string | null;
}

/** Insert one versioned package row (status 'draft', generated_by 'ai'). Returns the new id. */
export async function insertPackage(sb: SupabaseClient, args: InsertPackageArgs): Promise<string> {
  const { data, error } = await sb
    .from('mos_creative_packages')
    .insert({
      content_id: args.content_id,
      round: 1,
      version: args.version,
      stage: args.stage,
      status: 'draft',
      intended_use: args.intended_use,
      language: args.language,
      recipe: args.recipe,
      concept_id: args.concept_id,
      concepts: args.concepts,
      base: args.base,
      facts: args.facts,
      facts_used: args.facts_used,
      brand_kit_version: args.brand_kit_version,
      brand_kit_mode: args.brand_kit_mode,
      roles: args.roles,
      cost_usd: args.cost_usd,
      generated_by: 'ai',
      job_id: args.job_id,
      created_by_user_id: args.created_by_user_id,
      revision_note: args.revision_note,
    })
    .select('id')
    .single();
  if (error) throw new Error(`provider:supabase mos_creative_packages insert failed: ${error.message}`);
  return (data as { id: string }).id;
}

/** Insert the derivative rows of one package (one per selected target). */
export async function insertDerivatives(sb: SupabaseClient, packageId: string, derivatives: Derivative[]): Promise<void> {
  if (derivatives.length === 0) return;
  const rows = derivatives.map((d) => ({
    package_id: packageId,
    target_kind: d.target.target_kind,
    platform: d.target.platform,
    placement_type: d.target.placement_type,
    target_ref: d.target.target_ref ?? {},
    dimensions: d.dimensions,
    adaptation: d.adaptation,
    copy: d.copy,
    limits: d.limits ?? {},
    warnings: d.warnings ?? [],
    status: 'draft',
  }));
  const { error } = await sb.from('mos_creative_derivatives').insert(rows);
  if (error) throw new Error(`provider:supabase mos_creative_derivatives insert failed: ${error.message}`);
}

/**
 * Insert the refs of one package: every `base.references` pick
 * (role='reference') and every `base.assets` pick (role='selected_asset',
 * ref_kind 'file', usage from the pick, rights snapshot AS PICKED — contracts
 * §0.9: re-checked at final approval).
 */
export async function insertRefs(sb: SupabaseClient, packageId: string, base: BasePackage): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  for (const r of base.references ?? []) {
    rows.push({
      package_id: packageId,
      role: 'reference',
      ref_kind: r.ref_kind,
      ref_id: r.ref_id,
      slide_index: r.slide_index,
      level: r.level,
      aspect: r.aspect,
      usage: null,
      rights_snapshot: null,
      rationale: { why: r.why, study: r.study, adapt: r.adapt, do_not_copy: r.do_not_copy, differ: r.differ },
    });
  }
  for (const a of base.assets ?? []) {
    rows.push({
      package_id: packageId,
      role: 'selected_asset',
      ref_kind: 'file',
      ref_id: a.file_id,
      slide_index: null,
      level: null,
      aspect: null,
      usage: a.usage,
      rights_snapshot: {
        usage_rights: a.rights,
        rights_verified: a.rights_verified,
        nature: a.nature,
        source: a.source,
        production_state: a.production_state,
        needs_rights_confirmation: a.needs_rights_confirmation,
      },
      rationale: { placement: a.placement, treatment: a.treatment, why: a.why, is_production: a.is_production },
    });
  }
  if (rows.length === 0) return;
  const { error } = await sb.from('mos_creative_refs').insert(rows);
  if (error) throw new Error(`provider:supabase mos_creative_refs insert failed: ${error.message}`);
}

/** Status flip — never a delete (versions are immutable history). */
export async function supersedePackage(sb: SupabaseClient, packageId: string): Promise<void> {
  const { error } = await sb.from('mos_creative_packages').update({ status: 'superseded' }).eq('id', packageId);
  if (error) throw new Error(`provider:supabase mos_creative_packages supersede failed: ${error.message}`);
}

/** Mark a package rejected (persist_failed path — the row exists but its satellites failed). */
export async function rejectPackage(sb: SupabaseClient, packageId: string, note: string): Promise<void> {
  const { error } = await sb
    .from('mos_creative_packages')
    .update({ status: 'rejected', revision_note: note })
    .eq('id', packageId);
  if (error) throw new Error(`provider:supabase mos_creative_packages reject failed: ${error.message}`);
}

/** Single-row jsonb_set on `base` (the image lane's ai_recommendations[i].execution write). */
export async function patchPackage(sb: SupabaseClient, packageId: string, path: string[], value: unknown): Promise<void> {
  const { error } = await sb.rpc('mos_creative_package_patch', {
    p_package_id: packageId,
    p_path: path,
    p_value: value,
  });
  if (error) throw new Error(`provider:supabase mos_creative_package_patch failed: ${error.message}`);
}

// ── Notify ───────────────────────────────────────────────────────────────────

/**
 * In-app bell for the requester (event 'post_creative_ready'). Exactly the
 * runScriptJob posture: BEST-EFFORT — a lost notification must never fail a
 * job that already committed its package. (No notification_rules row exists
 * for this event by design — the bell always fires through notify_emit; see
 * the _25 migration note.)
 */
export async function notifyRequester(
  sb: SupabaseClient,
  args: { requestedBy: string | null; contentId: string; contentTitle: string | null; stage: 'concepts' | 'package' },
): Promise<void> {
  try {
    const title = args.contentTitle ? `«${args.contentTitle}»` : '';
    const isConcepts = args.stage === 'concepts';
    const { error } = await sb.rpc('notify_emit', {
      p_workspace: 'marketing',
      p_event: 'post_creative_ready',
      p_role_keys: [],
      p_user_ids: args.requestedBy ? [args.requestedBy] : [],
      p_title_ar: isConcepts ? 'مقترحات المنشور جاهزة' : 'الحزمة الإبداعية جاهزة',
      p_title_en: isConcepts ? 'Post concepts ready' : 'Creative package ready',
      p_body_ar: isConcepts ? `تم تجهيز مقترحات المنشور${title ? ` لـ${title}` : ''}` : `تم تجهيز الحزمة الإبداعية${title ? ` لـ${title}` : ''}`,
      p_body_en: isConcepts
        ? `Post concepts are ready${args.contentTitle ? ` for “${args.contentTitle}”` : ''}`
        : `The creative package is ready${args.contentTitle ? ` for “${args.contentTitle}”` : ''}`,
      p_url: `/m/content/${args.contentId}`,
    });
    // PostgREST returns errors instead of throwing — surface them (no silent
    // failure), but never throw: the package is already committed.
    if (error) console.error(`[creative/io] post_creative_ready notify returned an error: ${error.message}`);
  } catch (e) {
    console.error('[creative/io] post_creative_ready notify failed', e);
  }
}
