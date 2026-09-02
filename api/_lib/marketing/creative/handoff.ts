/**
 * creative_handoff — the DesignerHandoff a designer (role_map.design_owner)
 * works from: the latest APPLIED package, falling back to the latest draft
 * (marked draft:true). Asset rows carry preview URLs + file names; targets
 * carry dims + requires_separate_design; only APPROVED/executed AI production
 * is listed, with the count of suggestions nobody approved.
 */
import { jsonOk, jsonError } from '../../auth.js';
import type {
  AiRecommendation, BasePackage, CreativeDerivativeRow, CreativePackageRow,
  DesignerHandoff, DerivativeTarget, RoleMap,
} from '../../../../src/lib/creative/contracts.js';
import { cStr, jsonFail, requireSvc, resolveRefPreview, type CreativeCtx } from './wake.js';

const DEFAULT_ROLE_MAP: RoleMap = { design_owner: 'montage', design_reviewer: 'marketing_manager' };

export async function creativeHandoff(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const contentId = cStr(ctx.body.content_id);
  if (!contentId) return jsonError(400, 'content_id is required');

  // Latest applied package wins; otherwise the latest draft (draft:true).
  const applied = await svc.from('mos_creative_packages').select('*')
    .eq('content_id', contentId).eq('stage', 'package').eq('status', 'applied')
    .order('version', { ascending: false }).limit(1).maybeSingle();
  if (applied.error) {
    console.error('[creative] handoff package read failed', applied.error.code, applied.error.message);
    return jsonError(500, applied.error.message);
  }
  let pkg = applied.data as unknown as CreativePackageRow | null;
  let draft = false;
  if (!pkg) {
    const d = await svc.from('mos_creative_packages').select('*')
      .eq('content_id', contentId).eq('stage', 'package').eq('status', 'draft')
      .order('version', { ascending: false }).limit(1).maybeSingle();
    if (d.error) {
      console.error('[creative] handoff draft read failed', d.error.code, d.error.message);
      return jsonError(500, d.error.message);
    }
    pkg = d.data as unknown as CreativePackageRow | null;
    draft = true;
  }
  if (!pkg || !pkg.base) {
    return jsonFail(404,
      'No creative package exists for this content yet.',
      'لا توجد حزمة إبداعية لهذا المحتوى بعد.');
  }
  const base = pkg.base as unknown as BasePackage;

  const [contentRes, derivsRes, roleMapRes] = await Promise.all([
    svc.from('mos_content').select('id, title').eq('id', contentId).maybeSingle(),
    svc.from('mos_creative_derivatives').select('*').eq('package_id', pkg.id),
    svc.from('mos_settings').select('value').eq('key', 'role_map').maybeSingle(),
  ]);
  if (contentRes.error || derivsRes.error) {
    const e = contentRes.error ?? derivsRes.error;
    console.error('[creative] handoff reads failed', e?.code, e?.message);
    return jsonError(500, e?.message ?? 'read failed');
  }
  if (roleMapRes.error) {
    console.error('[creative] handoff role_map read failed', roleMapRes.error.code, roleMapRes.error.message);
  }
  const roleMapValue = (roleMapRes.data as { value?: Record<string, unknown> } | null)?.value ?? {};
  const role_map: RoleMap = {
    design_owner: typeof roleMapValue.design_owner === 'string' && roleMapValue.design_owner
      ? roleMapValue.design_owner : DEFAULT_ROLE_MAP.design_owner,
    design_reviewer: typeof roleMapValue.design_reviewer === 'string' && roleMapValue.design_reviewer
      ? roleMapValue.design_reviewer : DEFAULT_ROLE_MAP.design_reviewer,
  };

  const derivs = (derivsRes.data ?? []) as unknown as CreativeDerivativeRow[];

  // Asset previews + file names (signed 1h URLs for our private files).
  const assets: DesignerHandoff['assets'] = [];
  for (const a of base.assets ?? []) {
    let preview_url: string | null = null;
    let file_name: string | null = null;
    if (typeof a.file_id === 'string' && a.file_id) {
      const fr = await svc.from('files').select('original_name, title').eq('id', a.file_id).maybeSingle();
      if (fr.error) {
        console.error('[creative] handoff file read failed', a.file_id, fr.error.message);
      } else {
        const f = fr.data as { original_name: string | null; title: string | null } | null;
        file_name = f?.original_name ?? f?.title ?? null;
      }
      preview_url = await resolveRefPreview(svc, 'file', a.file_id);
    }
    assets.push({ ...a, preview_url, file_name });
  }

  const aiRecs = base.ai_recommendations ?? [];
  const ai_production = aiRecs.filter((r: AiRecommendation) =>
    r.status === 'approved' || r.status === 'queued' || r.status === 'running' || r.status === 'completed');
  const ai_suggested_not_approved = aiRecs.filter((r) => r.status === 'recommended').length;

  const handoff: DesignerHandoff = {
    content_id: contentId,
    package_id: pkg.id,
    title: (contentRes.data as { title: string } | null)?.title ?? '',
    message: base.strategy?.main_message ?? '',
    objective: base.strategy?.objective ?? '',
    audience: base.strategy?.audience ?? '',
    intended_use: pkg.intended_use,
    targets: derivs.map((d) => ({
      platform: d.platform,
      placement_type: d.placement_type,
      aspect: d.dimensions?.aspect ?? '',
      px: d.dimensions?.px ?? [1080, 1080],
      requires_separate_design: d.adaptation?.requires_separate_design === true,
    })),
    master_aspect: base.strategy?.master_aspect ?? '',
    design_text: base.design_text,
    slides: base.slides ?? [],
    palette: base.palette ?? [],
    assets,
    references: base.references ?? [],
    visual_direction: base.visual_direction,
    adaptations: derivs.map((d) => ({
      target: {
        target_kind: d.target_kind,
        platform: d.platform,
        placement_type: d.placement_type,
        target_ref: (d.target_ref ?? {}) as DerivativeTarget['target_ref'],
      },
      adaptation: d.adaptation,
    })),
    ai_production,
    ai_suggested_not_approved,
    warnings: base.warnings ?? [],
    missing: base.missing ?? [],
    language: pkg.language,
  };

  return jsonOk({ handoff, role_map, draft, package_status: pkg.status });
}
