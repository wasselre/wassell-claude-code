/**
 * Creative jobs + packages — enqueue actions (write_post_creative,
 * creative_concept_select, creative_regenerate), status/list reads, and the
 * package editor actions (creative_package_get / _save / asset_replace).
 *
 * mos_creative_jobs / mos_creative_packages / mos_creative_derivatives /
 * mos_creative_refs have RLS with NO policies by design — every access goes
 * through the service client AFTER the dispatch block's requireCap gate.
 * The content-visibility check still runs as the CALLER (RLS) so a user who
 * cannot see the content gets a 404, never its creative data.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonOk, jsonError } from '../../auth.js';
import { classifyRights } from './rights.js';
import type { CreativeFlags, CreativeJobKind, DerivativeTarget } from '../../../../src/lib/creative/contracts.js';
import {
  cStr, jsonFail, requireSvc, resolveAppUserId, resolveRefPreview, wakeWorker,
  type CreativeCtx,
} from './wake.js';

/* ------------------------------------------------------------------ */
/* shared reads                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_FLAGS: CreativeFlags = {
  post_enabled: false,
  ai_image_execution: false,
  design_reads_enabled: false,
  asset_enrich_v2: false,
  backfill_enabled: false,
};

/** mos_settings.creative_writer with the all-false default (ship DARK). */
export async function readCreativeFlags(sb: SupabaseClient): Promise<CreativeFlags> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'creative_writer').maybeSingle();
  if (error) {
    console.error('[creative] creative_writer flags read failed', error.code, error.message);
    return DEFAULT_FLAGS;
  }
  const v = (data as { value?: Record<string, unknown> } | null)?.value ?? {};
  return {
    post_enabled: v.post_enabled === true,
    ai_image_execution: v.ai_image_execution === true,
    design_reads_enabled: v.design_reads_enabled === true,
    asset_enrich_v2: v.asset_enrich_v2 === true,
    backfill_enabled: v.backfill_enabled === true,
  };
}

/** Minimal DerivativeTarget[] shape check — the worker revalidates in full. */
function validTargets(raw: unknown): DerivativeTarget[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DerivativeTarget[] = [];
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) return null;
    const r = t as Record<string, unknown>;
    if (r.target_kind !== 'organic' && r.target_kind !== 'paid') return null;
    if (typeof r.platform !== 'string' || !r.platform) return null;
    if (typeof r.placement_type !== 'string' || !r.placement_type) return null;
    out.push({
      target_kind: r.target_kind,
      platform: r.platform,
      placement_type: r.placement_type as DerivativeTarget['placement_type'],
      target_ref: (typeof r.target_ref === 'object' && r.target_ref !== null ? r.target_ref : {}) as DerivativeTarget['target_ref'],
    });
  }
  return out;
}

/** Enqueue one mos_creative_jobs row; map the one-active-job race to a 409. */
async function enqueueJob(
  ctx: CreativeCtx,
  svc: SupabaseClient,
  contentId: string,
  kind: CreativeJobKind,
  params: Record<string, unknown>,
): Promise<Response> {
  const requestedBy = await resolveAppUserId(ctx.sb, ctx.userId);
  const { data: jobId, error } = await svc.rpc('mos_creative_job_enqueue', {
    p_content_id: contentId,
    p_kind: kind,
    p_params: params,
    p_requested_by: requestedBy,
  });
  if (error) {
    if (error.message.includes('active_job_exists')) {
      return jsonFail(409,
        'A creative job is already running for this content — wait for it to finish.',
        'هناك مهمة إبداعية قيد التنفيذ لهذا المحتوى — انتظر اكتمالها.');
    }
    console.error('[creative] mos_creative_job_enqueue failed', error.code, error.message, error.details);
    return jsonError(500, error.message);
  }
  const job = await svc.from('mos_creative_jobs').select('*').eq('id', jobId as string).maybeSingle();
  if (job.error) {
    console.error('[creative] job re-read failed', job.error.code, job.error.message);
    return jsonError(500, job.error.message);
  }
  await wakeWorker('creative');
  return jsonOk({ job: job.data });
}

/** Load the content as the CALLER (RLS) — the visibility gate every action shares. */
async function loadVisibleContent(
  ctx: CreativeCtx,
  contentId: string,
  columns: string,
): Promise<{ row: Record<string, unknown> } | { fail: Response }> {
  const c = await ctx.sb.from('mos_content_v').select(columns).eq('id', contentId).maybeSingle();
  if (c.error) {
    console.error('[creative] content read failed', c.error.code, c.error.message);
    return { fail: jsonError(500, c.error.message) };
  }
  if (!c.data) return { fail: jsonError(404, 'content item not found') };
  return { row: c.data as unknown as Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/* write_post_creative — enqueue post_concepts                          */
/* ------------------------------------------------------------------ */

export async function writePostCreative(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const contentId = cStr(ctx.body.content_id);
  if (!contentId) return jsonError(400, 'content_id is required');

  // Feature flag first — a dark lane refuses BEFORE any work (bilingual 403).
  const flags = await readCreativeFlags(ctx.sb);
  if (!flags.post_enabled) {
    return jsonFail(403,
      'The post creative director is switched off (creative_writer.post_enabled).',
      'المدير الإبداعي للمنشورات متوقف حاليًا (creative_writer.post_enabled).');
  }

  const loaded = await loadVisibleContent(ctx, contentId, 'id, project_id, language, content_type_key');
  if ('fail' in loaded) return loaded.fail;
  const content = loaded.row as { project_id: string | null; language: string | null; content_type_key: string | null };
  if (!content.project_id) {
    return jsonFail(400,
      'Link a project to this content first — the creative director grounds every fact on the project.',
      'اربط مشروعًا بهذا المحتوى أولًا — المدير الإبداعي يستند إلى حقائق المشروع.');
  }
  if (content.content_type_key !== 'post' && content.content_type_key !== 'carousel') {
    return jsonFail(400,
      `The creative director writes posts and carousels, not "${content.content_type_key ?? 'this type'}".`,
      'المدير الإبداعي يكتب المنشورات والكاروسيل فقط، لا هذا النوع من المحتوى.');
  }

  const targets = validTargets(ctx.body.targets);
  if (!targets || targets.length === 0) {
    return jsonFail(400,
      'Pick at least one target placement (organic or paid).',
      'اختر موضع نشر واحدًا على الأقل (عضوي أو مدفوع).');
  }
  const intendedUse = cStr(ctx.body.intended_use);
  if (intendedUse && !['organic', 'paid', 'both'].includes(intendedUse)) {
    return jsonError(400, 'intended_use must be organic | paid | both');
  }

  return enqueueJob(ctx, svc, contentId, 'post_concepts', {
    targets,
    recipe: cStr(ctx.body.recipe),
    intended_use: intendedUse ?? 'organic',
    language: content.language ?? 'ar',
  });
}

/* ------------------------------------------------------------------ */
/* creative_concept_select / creative_regenerate                        */
/* ------------------------------------------------------------------ */

async function loadPackage(
  svc: SupabaseClient,
  packageId: string,
): Promise<{ pkg: Record<string, unknown> } | { fail: Response }> {
  const p = await svc.from('mos_creative_packages').select('*').eq('id', packageId).maybeSingle();
  if (p.error) {
    console.error('[creative] package read failed', p.error.code, p.error.message);
    return { fail: jsonError(500, p.error.message) };
  }
  if (!p.data) {
    return { fail: jsonFail(404, 'Creative package not found.', 'حزمة المحتوى الإبداعي غير موجودة.') };
  }
  return { pkg: p.data as Record<string, unknown> };
}

export async function creativeConceptSelect(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  if (!packageId) return jsonError(400, 'package_id is required');

  const loaded = await loadPackage(svc, packageId);
  if ('fail' in loaded) return loaded.fail;
  const pkg = loaded.pkg;
  if (pkg.stage !== 'concepts' || pkg.status !== 'draft') {
    return jsonFail(409,
      'This concepts round is no longer selectable.',
      'جولة الأفكار هذه لم تعد قابلة للاختيار.');
  }

  const conceptId = cStr(ctx.body.concept_id);
  let custom: { title: string; angle: string; format: string } | null = null;
  if (!conceptId) {
    const raw = ctx.body.custom;
    if (typeof raw !== 'object' || raw === null) {
      return jsonFail(400,
        'Choose a concept or send a custom one (title + angle + format).',
        'اختر فكرة من المقترحات أو أرسل فكرة مخصصة (عنوان + زاوية + شكل).');
    }
    const r = raw as Record<string, unknown>;
    const title = cStr(r.title); const angle = cStr(r.angle); const format = cStr(r.format);
    if (!title || !angle || (format !== 'single' && format !== 'carousel')) {
      return jsonFail(400,
        'A custom concept needs a title, an angle, and format single|carousel.',
        'الفكرة المخصصة تحتاج عنوانًا وزاوية وشكلًا (مفرد أو كاروسيل).');
    }
    custom = { title, angle, format };
  }

  return enqueueJob(ctx, svc, pkg.content_id as string, 'post_package', {
    package_id: packageId,
    concept_id: conceptId,
    custom,
  });
}

export async function creativeRegenerate(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  const revisionNote = cStr(ctx.body.revision_note);
  if (!packageId) return jsonError(400, 'package_id is required');
  if (!revisionNote) {
    return jsonFail(400,
      'A revision note is required — tell the director what to change.',
      'ملاحظة التعديل مطلوبة — وضّح للمدير الإبداعي ما الذي يجب تغييره.');
  }

  const loaded = await loadPackage(svc, packageId);
  if ('fail' in loaded) return loaded.fail;
  const pkg = loaded.pkg;
  if (pkg.stage !== 'package') {
    return jsonFail(409, 'Only a full package can be regenerated.', 'يمكن إعادة توليد الحزمة المكتملة فقط.');
  }

  return enqueueJob(ctx, svc, pkg.content_id as string, 'post_regenerate', {
    package_id: packageId,
    revision_note: revisionNote,
  });
}

/* ------------------------------------------------------------------ */
/* status / list / get                                                  */
/* ------------------------------------------------------------------ */

export async function creativeJobStatus(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const contentId = cStr(ctx.body.content_id);
  if (!contentId) return jsonError(400, 'content_id is required');
  const j = await svc.from('mos_creative_jobs').select('*')
    .eq('content_id', contentId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (j.error) {
    console.error('[creative] job status read failed', j.error.code, j.error.message);
    return jsonError(500, j.error.message);
  }
  return jsonOk({ job: j.data ?? null });
}

export async function creativePackageList(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const contentId = cStr(ctx.body.content_id);
  if (!contentId) return jsonError(400, 'content_id is required');
  const p = await svc.from('mos_creative_packages').select('*')
    .eq('content_id', contentId)
    .order('version', { ascending: false });
  if (p.error) {
    console.error('[creative] package list read failed', p.error.code, p.error.message);
    return jsonError(500, p.error.message);
  }
  return jsonOk({ packages: p.data ?? [] });
}

export async function creativePackageGet(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  if (!packageId) return jsonError(400, 'package_id is required');

  const loaded = await loadPackage(svc, packageId);
  if ('fail' in loaded) return loaded.fail;
  const pkg = loaded.pkg;

  const [derivs, refs] = await Promise.all([
    svc.from('mos_creative_derivatives').select('*').eq('package_id', packageId)
      .order('target_kind', { ascending: true }).order('platform', { ascending: true }),
    svc.from('mos_creative_refs').select('*').eq('package_id', packageId)
      .order('created_at', { ascending: true }),
  ]);
  if (derivs.error || refs.error) {
    const e = derivs.error ?? refs.error;
    console.error('[creative] package children read failed', e?.code, e?.message);
    return jsonError(500, e?.message ?? 'read failed');
  }
  const refRows = (refs.data ?? []) as Array<{ ref_kind: string; ref_id: string }>;

  const previews: Record<string, string> = {};
  for (const r of refRows) {
    if (previews[r.ref_id]) continue;
    const url = await resolveRefPreview(svc, r.ref_kind, r.ref_id);
    if (url) previews[r.ref_id] = url;
  }

  return jsonOk({ package: pkg, derivatives: derivs.data ?? [], refs: refs.data ?? [], previews });
}

/* ------------------------------------------------------------------ */
/* creative_package_save — human edit → NEW version                     */
/* ------------------------------------------------------------------ */

/** Minimal BasePackage shape check: an object whose known sub-objects quack. */
function baseShapeProblem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'base must be an object';
  const b = raw as Record<string, unknown>;
  if (b.design_text !== undefined) {
    const dt = b.design_text as Record<string, unknown> | null;
    if (typeof dt !== 'object' || dt === null || !Array.isArray(dt.headlines)) {
      return 'base.design_text.headlines must be an array';
    }
  }
  if (b.strategy !== undefined && (typeof b.strategy !== 'object' || b.strategy === null)) {
    return 'base.strategy must be an object';
  }
  if (b.assets !== undefined && !Array.isArray(b.assets)) return 'base.assets must be an array';
  if (b.references !== undefined && !Array.isArray(b.references)) return 'base.references must be an array';
  if (b.ai_recommendations !== undefined && !Array.isArray(b.ai_recommendations)) return 'base.ai_recommendations must be an array';
  return null;
}

const DERIVATIVE_EDITABLE = ['target_ref', 'dimensions', 'adaptation', 'copy', 'limits', 'warnings'] as const;

export async function creativePackageSave(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  if (!packageId) return jsonError(400, 'package_id is required');

  const loaded = await loadPackage(svc, packageId);
  if ('fail' in loaded) return loaded.fail;
  const old = loaded.pkg;
  if (old.status !== 'draft') {
    return jsonFail(409,
      'Only a draft package can be edited — an applied package is immutable history (revert it first).',
      'يمكن تعديل المسودة فقط — الحزمة المطبَّقة سجل ثابت (تراجع عنها أولًا).');
  }

  const hasBase = Object.prototype.hasOwnProperty.call(ctx.body, 'base');
  if (hasBase) {
    const problem = baseShapeProblem(ctx.body.base);
    if (problem) return jsonError(400, problem);
  }
  const hasDerivs = Object.prototype.hasOwnProperty.call(ctx.body, 'derivatives');
  if (hasDerivs && !Array.isArray(ctx.body.derivatives)) return jsonError(400, 'derivatives must be an array');

  const contentId = old.content_id as string;
  const ver = await svc.rpc('mos_creative_package_next_version', { p_content_id: contentId });
  if (ver.error) {
    console.error('[creative] next_version failed', ver.error.code, ver.error.message);
    return jsonError(500, ver.error.message);
  }

  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const now = new Date().toISOString();

  // Insert the NEW version first; supersede the old draft only once the
  // successor exists — a failed insert must never leave the user with no draft.
  const insert: Record<string, unknown> = {
    content_id: contentId,
    round: old.round,
    version: ver.data as number,
    stage: old.stage,
    status: 'draft',
    intended_use: old.intended_use,
    language: old.language,
    recipe: old.recipe,
    concept_id: old.concept_id,
    concepts: old.concepts,
    base: hasBase ? ctx.body.base : old.base,
    facts: old.facts,
    facts_used: old.facts_used,
    brand_kit_version: old.brand_kit_version,
    brand_kit_mode: old.brand_kit_mode,
    roles: old.roles,
    cost_usd: old.cost_usd,
    generated_by: 'human',
    created_by_user_id: appUserId,
    revision_note: cStr(ctx.body.revision_note),
  };
  const ins = await svc.from('mos_creative_packages').insert(insert).select('*').maybeSingle();
  if (ins.error || !ins.data) {
    console.error('[creative] human-version insert failed', ins.error?.code, ins.error?.message);
    return jsonError(500, ins.error?.message ?? 'insert returned no row');
  }
  const newPkg = ins.data as Record<string, unknown>;
  const newPackageId = newPkg.id as string;

  // The successor exists — the old draft is now history.
  const sup = await svc.from('mos_creative_packages')
    .update({ status: 'superseded', updated_at: now }).eq('id', packageId).eq('status', 'draft');
  if (sup.error) {
    console.error('[creative] supersede-on-save failed (new version already saved)', sup.error.code, sup.error.message);
    return jsonError(500, sup.error.message);
  }

  // Derivatives: carry forward with edits. Match on (target_kind, platform,
  // placement_type); an edit entry may also ADD a derivative the AI did not
  // produce (then dimensions/adaptation/copy are required).
  const oldDerivs = await svc.from('mos_creative_derivatives').select('*').eq('package_id', packageId);
  if (oldDerivs.error) {
    console.error('[creative] derivative carry-over read failed', oldDerivs.error.code, oldDerivs.error.message);
    return jsonError(500, oldDerivs.error.message);
  }
  type DerivRow = Record<string, unknown> & { target_kind: string; platform: string; placement_type: string };
  const oldRows = (oldDerivs.data ?? []) as DerivRow[];
  const edits = (Array.isArray(ctx.body.derivatives) ? ctx.body.derivatives : []) as DerivRow[];
  const editKey = (d: DerivRow) => `${d.target_kind}|${d.platform}|${d.placement_type}`;
  const editByKey = new Map<string, DerivRow>();
  for (const e of edits) {
    if (e && typeof e === 'object' && e.target_kind && e.platform && e.placement_type) editByKey.set(editKey(e), e);
  }

  const newRows: Array<Record<string, unknown>> = [];
  for (const d of oldRows) {
    const e = editByKey.get(editKey(d));
    editByKey.delete(editKey(d));
    const row: Record<string, unknown> = {
      package_id: newPackageId,
      target_kind: d.target_kind,
      platform: d.platform,
      placement_type: d.placement_type,
      target_ref: d.target_ref,
      dimensions: d.dimensions,
      adaptation: d.adaptation,
      copy: d.copy,
      limits: d.limits,
      warnings: d.warnings,
      status: 'draft',
    };
    if (e) {
      for (const k of DERIVATIVE_EDITABLE) {
        if (Object.prototype.hasOwnProperty.call(e, k)) row[k] = e[k];
      }
    }
    newRows.push(row);
  }
  for (const e of editByKey.values()) {
    if (!e.dimensions || !e.adaptation || !e.copy) {
      return jsonFail(400,
        `A new derivative for ${e.platform}/${e.placement_type} needs dimensions + adaptation + copy.`,
        'الموضع الجديد يحتاج أبعادًا وتكيّفًا ونصًا كاملين.');
    }
    newRows.push({
      package_id: newPackageId,
      target_kind: e.target_kind,
      platform: e.platform,
      placement_type: e.placement_type,
      target_ref: e.target_ref ?? {},
      dimensions: e.dimensions,
      adaptation: e.adaptation,
      copy: e.copy,
      limits: e.limits ?? {},
      warnings: e.warnings ?? [],
      status: 'draft',
    });
  }

  let newDerivs: unknown[] = [];
  if (newRows.length > 0) {
    const dIns = await svc.from('mos_creative_derivatives').insert(newRows).select('*');
    if (dIns.error) {
      console.error('[creative] derivative carry-over insert failed', dIns.error.code, dIns.error.message);
      return jsonError(500, dIns.error.message);
    }
    newDerivs = dIns.data ?? [];
  }

  // Refs carry forward verbatim (the rights snapshot travels with them).
  const oldRefs = await svc.from('mos_creative_refs').select('*').eq('package_id', packageId);
  if (oldRefs.error) {
    console.error('[creative] ref carry-over read failed', oldRefs.error.code, oldRefs.error.message);
    return jsonError(500, oldRefs.error.message);
  }
  const refRows = ((oldRefs.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    package_id: newPackageId,
    role: r.role,
    ref_kind: r.ref_kind,
    ref_id: r.ref_id,
    slide_index: r.slide_index,
    level: r.level,
    aspect: r.aspect,
    usage: r.usage,
    rights_snapshot: r.rights_snapshot,
    rationale: r.rationale,
  }));
  if (refRows.length > 0) {
    const rIns = await svc.from('mos_creative_refs').insert(refRows);
    if (rIns.error) {
      console.error('[creative] ref carry-over insert failed', rIns.error.code, rIns.error.message);
      return jsonError(500, rIns.error.message);
    }
  }

  return jsonOk({ package: newPkg, derivatives: newDerivs });
}

/* ------------------------------------------------------------------ */
/* creative_asset_replace — swap one picked asset, re-snapshot rights   */
/* ------------------------------------------------------------------ */

export async function creativeAssetReplace(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  const fileId = cStr(ctx.body.file_id);
  const index = typeof ctx.body.asset_index === 'number' && Number.isInteger(ctx.body.asset_index)
    ? ctx.body.asset_index : -1;
  if (!packageId || !fileId || index < 0) {
    return jsonError(400, 'package_id, asset_index (int) and file_id are required');
  }

  const loaded = await loadPackage(svc, packageId);
  if ('fail' in loaded) return loaded.fail;
  const pkg = loaded.pkg;
  if (pkg.status !== 'draft') {
    return jsonFail(409,
      'Only a draft package can be edited.',
      'يمكن تعديل المسودة فقط.');
  }
  const base = pkg.base as { assets?: Array<Record<string, unknown>> } | null;
  const assets = base?.assets;
  if (!Array.isArray(assets) || index >= assets.length) {
    return jsonError(400, `asset_index ${index} is out of range`);
  }

  // The file + its rights truth (files_rights_v resolves the LATEST provenance).
  const [fileRes, rightsRes] = await Promise.all([
    svc.from('files').select('id, usage_rights, asset_nature, acquisition_source, production_state')
      .eq('id', fileId).maybeSingle(),
    svc.from('files_rights_v').select('file_id, usage_rights, rights_provenance, rights_verified')
      .eq('file_id', fileId).maybeSingle(),
  ]);
  if (fileRes.error) {
    console.error('[creative] replace-asset file read failed', fileRes.error.code, fileRes.error.message);
    return jsonError(500, fileRes.error.message);
  }
  if (!fileRes.data) return jsonFail(404, 'File not found.', 'الملف غير موجود.');
  if (rightsRes.error) {
    console.error('[creative] replace-asset rights read failed', rightsRes.error.code, rightsRes.error.message);
    return jsonError(500, rightsRes.error.message);
  }
  const file = fileRes.data as {
    usage_rights: string | null; asset_nature: string | null;
    acquisition_source: string | null; production_state: string | null;
  };
  const rights = rightsRes.data as {
    usage_rights: string | null; rights_provenance: string | null; rights_verified: boolean | null;
  } | null;

  const cls = classifyRights({
    usage_rights: rights?.usage_rights ?? file.usage_rights,
    rights_provenance: rights?.rights_provenance ?? null,
    rights_verified: rights?.rights_verified ?? null,
    acquisition_source: file.acquisition_source,
    asset_nature: file.asset_nature,
  });

  const next = {
    ...assets[index],
    file_id: fileId,
    nature: file.asset_nature,
    source: file.acquisition_source,
    rights: rights?.usage_rights ?? file.usage_rights,
    rights_verified: rights?.rights_verified === true,
    production_state: file.production_state,
    is_production: cls.selectable_for_production,
    needs_rights_confirmation: cls.needs_rights_confirmation,
    rights_reason: cls.reason,
  };

  const patch = await svc.rpc('mos_creative_package_patch', {
    p_package_id: packageId,
    p_path: ['assets', String(index)],
    p_value: next,
  });
  if (patch.error) {
    console.error('[creative] asset replace patch failed', patch.error.code, patch.error.message);
    return jsonError(500, patch.error.message);
  }

  const fresh = await loadPackage(svc, packageId);
  if ('fail' in fresh) return fresh.fail;
  return jsonOk({ package: fresh.pkg });
}
