/**
 * Apply / revert / AI-execution actions for the Post Creative Director.
 *
 * creative_package_apply is AUDITABLE and REVERSIBLE (contracts §0 rule 10):
 * every field it touches is snapshotted BEFORE the first write; a mid-way
 * failure restores what was already written and says so; creative_package_revert
 * replays the same snapshot backwards. Nothing non-empty is ever overwritten
 * without an explicit `overwrite` flag per field.
 *
 * The publication / ad-creative / asset-link writes replicate the minimal
 * upsert semantics of `content_caption_save`, `content_ad_creative_save` and
 * `asset_link_from_file` in api/marketing-os.ts — the code is NOT moved here;
 * each site below carries a comment pointing at the case it mirrors.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonOk, jsonError } from '../../auth.js';
import { recheckRightsForFinal } from './rights.js';
import { checkAiRecommendation } from '../../../../src/lib/creative/policy.js';
import type {
  AiRecommendation, AssetPick, BasePackage, CreativeDerivativeRow,
  CreativePackageRow, OrganicCopy, PaidCopy,
} from '../../../../src/lib/creative/contracts.js';
import {
  cStr, jsonFail, requireSvc, resolveAppUserId, wakeWorker, type CreativeCtx,
} from './wake.js';
import { readCreativeFlags } from './packages.js';

/* ------------------------------------------------------------------ */
/* snapshot + restore                                                 */
/* ------------------------------------------------------------------ */

interface PriorValue { present: boolean; value: unknown }

interface ApplySnapshot {
  content_data: {
    headlines: PriorValue;
    design_brief: PriorValue;
    hashtags: PriorValue;
    design_reference_file_ids: PriorValue;
  };
  publications: Array<{ id: string; platform: string; caption: string | null; existed: boolean }>;
  ads: Array<{
    ad_id: string | null; execution_id: string | null;
    creative: Record<string, unknown> | null; existed: boolean;
  }>;
  asset_links_created: Array<{ asset_id: string }>;
}

const prior = (data: Record<string, unknown>, key: string): PriorValue =>
  ({ present: Object.prototype.hasOwnProperty.call(data, key), value: data[key] });

/**
 * Undo everything an apply (partial or complete) did, from its snapshot.
 * Returns the list of restored/removed things; failures are logged + listed,
 * never swallowed (the operator must know what could NOT be rolled back).
 */
async function restoreFromSnapshot(
  svc: SupabaseClient,
  contentId: string,
  snap: ApplySnapshot,
): Promise<{ restored: string[]; failed: string[] }> {
  const restored: string[] = [];
  const failed: string[] = [];

  // 1. content data keys.
  const cur = await svc.from('mos_content').select('data').eq('id', contentId).maybeSingle();
  if (cur.error) {
    console.error('[creative] restore: content read failed', cur.error.code, cur.error.message);
    failed.push('content.data (read failed)');
  } else {
    const data = { ...((cur.data as { data?: Record<string, unknown> } | null)?.data ?? {}) };
    for (const [key, p] of Object.entries(snap.content_data)) {
      if (p.present) data[key] = p.value;
      else delete data[key];
    }
    const upd = await svc.from('mos_content')
      .update({ data, updated_at: new Date().toISOString() }).eq('id', contentId);
    if (upd.error) {
      console.error('[creative] restore: content update failed', upd.error.code, upd.error.message);
      failed.push('content.data (update failed)');
    } else {
      restored.push('content.data (headlines, design_brief, hashtags, design_reference_file_ids)');
    }
  }

  // 2. publications — restore prior captions; delete the rows apply created.
  for (const p of snap.publications) {
    if (p.existed) {
      const upd = await svc.from('mos_publications')
        .update({ caption: p.caption, updated_at: new Date().toISOString() }).eq('id', p.id);
      if (upd.error) {
        console.error('[creative] restore: publication caption failed', p.id, upd.error.message);
        failed.push(`publication ${p.platform} caption`);
      } else {
        restored.push(`publication ${p.platform} caption`);
      }
    } else {
      const del = await svc.from('mos_publications').delete().eq('id', p.id);
      if (del.error) {
        console.error('[creative] restore: publication delete failed', p.id, del.error.message);
        failed.push(`publication ${p.platform} (created row)`);
      } else {
        restored.push(`publication ${p.platform} (created row removed)`);
      }
    }
  }

  // 3. ads — restore prior creative; delete the rows apply created.
  for (const a of snap.ads) {
    if (a.existed && a.ad_id) {
      const upd = await svc.from('mos_execution_ads')
        .update({ creative: a.creative ?? {}, updated_at: new Date().toISOString() }).eq('id', a.ad_id);
      if (upd.error) {
        console.error('[creative] restore: ad creative failed', a.ad_id, upd.error.message);
        failed.push(`ad ${a.ad_id} creative`);
      } else {
        restored.push(`ad ${a.ad_id} creative`);
      }
    } else if (!a.existed && a.ad_id) {
      const del = await svc.from('mos_execution_ads').delete().eq('id', a.ad_id);
      if (del.error) {
        console.error('[creative] restore: ad delete failed', a.ad_id, del.error.message);
        failed.push(`ad ${a.ad_id} (created row)`);
      } else {
        restored.push(`ad ${a.ad_id} (created row removed)`);
      }
    }
  }

  // 4. asset links apply created.
  for (const l of snap.asset_links_created) {
    const del = await svc.from('mos_asset_links').delete()
      .eq('asset_id', l.asset_id).eq('content_id', contentId);
    if (del.error) {
      console.error('[creative] restore: asset link delete failed', l.asset_id, del.error.message);
      failed.push(`asset link ${l.asset_id}`);
    } else {
      restored.push(`asset link ${l.asset_id}`);
    }
  }

  return { restored, failed };
}

/* ------------------------------------------------------------------ */
/* small pure helpers                                                 */
/* ------------------------------------------------------------------ */

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** 6 → «٦» — carousel slide prefixes use Arabic-Indic numerals. */
const toArDigits = (n: number): string => String(n).replace(/\d/g, (d) => AR_DIGITS.charAt(Number(d)));

const asStringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** The lines apply adds to data.headlines (cover + «١/٦ »-prefixed slide lines). */
export function generatedHeadlines(base: BasePackage): string[] {
  const cover = asStringList(base.design_text?.headlines).filter((h) => h.trim() !== '');
  if (base.strategy?.format !== 'carousel' || !Array.isArray(base.slides)) return cover;
  const total = base.slides.length;
  const slideLines = base.slides
    .filter((s) => typeof s.headline === 'string' && s.headline.trim() !== '')
    .map((s) => `«${toArDigits(s.index)}/${toArDigits(total)} »${s.headline}`);
  return [...cover, ...slideLines];
}

/** Render the design brief text (the language follows the package, rule 5). */
export function renderDesignBrief(base: BasePackage, language: string): string {
  const ar = language === 'ar';
  const vd = base.visual_direction;
  const t = (a: string, e: string): string => (ar ? a : e);
  const lines: string[] = [];
  lines.push(`${t('الفكرة', 'Concept')}: ${vd.concept}`);
  if (vd.mood?.length) lines.push(`${t('المزاج', 'Mood')}: ${vd.mood.join(ar ? '، ' : ', ')}`);
  lines.push(`${t('التكوين', 'Composition')}: ${vd.composition}`);
  lines.push(`${t('التخطيط', 'Layout')}: ${vd.layout}`);
  lines.push(`${t('معالجة الصورة', 'Image treatment')}: ${vd.image_treatment}`);
  lines.push(`${t('الخلفية', 'Background')}: ${vd.background}`);
  lines.push(`${t('الشعار', 'Logo')}: ${vd.logo.variant} — ${vd.logo.position} — ${vd.logo.color}`);
  lines.push(`${t('موضع الدعوة', 'CTA placement')}: ${vd.cta_placement}`);
  if (base.palette?.length) {
    lines.push(`${t('الألوان', 'Palette')}:`);
    for (const p of base.palette) lines.push(`- ${p.hex} ${p.name} — ${p.role}`);
  }
  return lines.join('\n');
}

/** PaidCopy → the standardized ad-creative keys (message mirrors primary_text,
 *  same as content_ad_creative_save in api/marketing-os.ts). */
function paidCreativeFrom(copy: PaidCopy): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['primary_text', 'headline', 'description', 'cta', 'destination_url'] as const) {
    const v = copy[k];
    if (typeof v === 'string' && v.trim() !== '') out[k] = v;
  }
  if (out.primary_text) out.message = out.primary_text;
  return out;
}

/* ------------------------------------------------------------------ */
/* creative_package_apply                                             */
/* ------------------------------------------------------------------ */

export async function creativePackageApply(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  if (!packageId) return jsonError(400, 'package_id is required');
  const rawOverwrite = (typeof ctx.body.overwrite === 'object' && ctx.body.overwrite !== null
    ? ctx.body.overwrite : {}) as Record<string, unknown>;
  const overwrite = {
    headlines: rawOverwrite.headlines === true,
    design_brief: rawOverwrite.design_brief === true,
    captions: rawOverwrite.captions === true,
    ad_copy: rawOverwrite.ad_copy === true,
  };
  const confirmUnverified = ctx.body.confirm_unverified_rights === true;

  const pkgRes = await svc.from('mos_creative_packages').select('*').eq('id', packageId).maybeSingle();
  if (pkgRes.error) {
    console.error('[creative] apply: package read failed', pkgRes.error.code, pkgRes.error.message);
    return jsonError(500, pkgRes.error.message);
  }
  if (!pkgRes.data) return jsonFail(404, 'Creative package not found.', 'حزمة المحتوى الإبداعي غير موجودة.');
  const pkg = pkgRes.data as unknown as CreativePackageRow;
  if (pkg.stage !== 'package' || pkg.status !== 'draft') {
    return jsonFail(409,
      'Only a draft package can be applied.',
      'يمكن تطبيق المسودة فقط.');
  }
  const base = pkg.base as BasePackage | null;
  if (!base) {
    return jsonFail(400, 'This package has no base creative.', 'هذه الحزمة لا تحتوي إبداعًا أساسيًا.');
  }
  const contentId = pkg.content_id;

  const derivsRes = await svc.from('mos_creative_derivatives').select('*').eq('package_id', packageId);
  if (derivsRes.error) {
    console.error('[creative] apply: derivatives read failed', derivsRes.error.code, derivsRes.error.message);
    return jsonError(500, derivsRes.error.message);
  }
  const derivs = (derivsRes.data ?? []) as unknown as CreativeDerivativeRow[];

  const contentRes = await svc.from('mos_content').select('id, title, data').eq('id', contentId).maybeSingle();
  if (contentRes.error || !contentRes.data) {
    console.error('[creative] apply: content read failed', contentRes.error?.code, contentRes.error?.message);
    return jsonError(contentRes.error ? 500 : 404, contentRes.error?.message ?? 'content item not found');
  }
  const content = contentRes.data as { id: string; title: string; data: Record<string, unknown> };

  // ── rights re-check on the PRODUCTION assets (rule 9) ────────────────
  const productionIds = (base.assets ?? [])
    .filter((a) => a.is_production && typeof a.file_id === 'string')
    .map((a) => a.file_id);
  const rights = await recheckRightsForFinal(svc, productionIds);
  if (rights.blocked.length > 0) {
    return jsonFail(422,
      `rights_blocked: ${rights.blocked.length} asset(s) carry restricted/do_not_use rights — replace them before applying.`,
      'حقوق بعض المواد محظورة — استبدلها قبل التطبيق.',
      { blocked: rights.blocked });
  }
  if (rights.unconfirmed.length > 0 && !confirmUnverified) {
    return jsonFail(422,
      `rights_blocked: ${rights.unconfirmed.length} asset(s) have unverified rights — confirm them explicitly to apply.`,
      'حقوق بعض المواد غير موثّقة — أكّدها صراحة قبل التطبيق.',
      { unconfirmed: rights.unconfirmed });
  }

  // ── snapshot BEFORE any write ─────────────────────────────────────────
  const snapshot: ApplySnapshot = {
    content_data: {
      headlines: prior(content.data, 'headlines'),
      design_brief: prior(content.data, 'design_brief'),
      hashtags: prior(content.data, 'hashtags'),
      design_reference_file_ids: prior(content.data, 'design_reference_file_ids'),
    },
    publications: [],
    ads: [],
    asset_links_created: [],
  };

  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const now = new Date().toISOString();

  try {
    // ── 1. mos_content.data merge ───────────────────────────────────────
    const data = { ...content.data };
    const generated = generatedHeadlines(base);
    if (overwrite.headlines) {
      data.headlines = generated;
    } else {
      const existing = asStringList(data.headlines);
      data.headlines = [...existing, ...generated.filter((g) => !existing.includes(g))];
    }
    const briefEmpty = typeof data.design_brief !== 'string' || (data.design_brief as string).trim() === '';
    if (overwrite.design_brief || briefEmpty) {
      data.design_brief = renderDesignBrief(base, pkg.language);
    }
    const organicCopies = derivs
      .filter((d) => d.target_kind === 'organic')
      .map((d) => d.copy as OrganicCopy);
    const firstHashtags = organicCopies.map((c) => asStringList(c?.hashtags)).find((h) => h.length > 0) ?? [];
    const hashtagsEmpty = typeof data.hashtags !== 'string' || (data.hashtags as string).trim() === '';
    if (firstHashtags.length > 0 && (overwrite.headlines || hashtagsEmpty)) {
      data.hashtags = firstHashtags.join(' ');
    }
    const ourFileRefIds = ((base.references ?? []) as Array<{ ref_kind: string; ref_id: string }>)
      .filter((r) => r.ref_kind === 'wassel_file' || r.ref_kind === 'file')
      .map((r) => r.ref_id);
    const existingRefIds = asStringList(data.design_reference_file_ids);
    data.design_reference_file_ids = [...new Set([...existingRefIds, ...ourFileRefIds])];

    const updContent = await svc.from('mos_content')
      .update({ data, updated_at: now }).eq('id', contentId);
    if (updContent.error) throw new Error(`content data merge failed: ${updContent.error.message}`);

    // ── 2. organic derivatives → draft publication captions ─────────────
    // Mirrors the lazy-upsert in the `content_caption_save` case of
    // api/marketing-os.ts (caption-only; set when empty unless overwrite).
    for (const d of derivs.filter((x) => x.target_kind === 'organic')) {
      const copy = d.copy as OrganicCopy;
      const caption = typeof copy?.caption === 'string' ? copy.caption : '';
      if (!caption) continue;
      const platform = d.platform;
      const existing = await svc.from('mos_publications').select('id, caption')
        .eq('content_id', contentId).eq('platform', platform)
        .order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (existing.error) throw new Error(`publication read (${platform}) failed: ${existing.error.message}`);
      const pub = existing.data as { id: string; caption: string | null } | null;
      if (pub) {
        snapshot.publications.push({ id: pub.id, platform, caption: pub.caption, existed: true });
        const empty = !pub.caption || pub.caption.trim() === '';
        if (overwrite.captions || empty) {
          const upd = await svc.from('mos_publications')
            .update({ caption, updated_at: now }).eq('id', pub.id);
          if (upd.error) throw new Error(`publication caption (${platform}) failed: ${upd.error.message}`);
        }
      } else {
        const acct = await svc.from('mos_platform_accounts').select('id')
          .eq('platform', platform).is('archived_at', null)
          .order('is_connected', { ascending: false }).order('sort_order', { ascending: true })
          .limit(1).maybeSingle();
        if (acct.error) throw new Error(`default account (${platform}) failed: ${acct.error.message}`);
        const ins = await svc.from('mos_publications').insert({
          content_id: contentId, platform,
          account_id: (acct.data as { id: string } | null)?.id ?? null,
          status: 'draft', caption,
        }).select('id').maybeSingle();
        if (ins.error || !ins.data) throw new Error(`publication insert (${platform}) failed: ${ins.error?.message ?? 'no row'}`);
        snapshot.publications.push({ id: (ins.data as { id: string }).id, platform, caption: null, existed: false });
      }
    }

    // ── 3. paid derivatives → mos_execution_ads creative ────────────────
    // Mirrors `content_ad_creative_save` (fill empty keys unless overwrite;
    // create the waiting ad when only execution_id is known).
    for (const d of derivs.filter((x) => x.target_kind === 'paid')) {
      const ref = (d.target_ref ?? {}) as { ad_id?: string; execution_id?: string; ad_set_id?: string };
      const adId = typeof ref.ad_id === 'string' && ref.ad_id ? ref.ad_id : null;
      const executionId = typeof ref.execution_id === 'string' && ref.execution_id ? ref.execution_id : null;
      if (!adId && !executionId) continue;
      const creative = paidCreativeFrom(d.copy as PaidCopy);
      if (Object.keys(creative).length === 0) continue;

      if (adId) {
        const existing = await svc.from('mos_execution_ads').select('id, creative, content_id')
          .eq('id', adId).is('archived_at', null).maybeSingle();
        if (existing.error) throw new Error(`ad read failed: ${existing.error.message}`);
        const ad = existing.data as { id: string; creative: Record<string, unknown> | null; content_id: string | null } | null;
        if (!ad) throw new Error(`ad ${adId} not found`);
        snapshot.ads.push({ ad_id: adId, execution_id: null, creative: ad.creative, existed: true });
        const prev = ad.creative ?? {};
        const next = { ...prev };
        for (const [k, v] of Object.entries(creative)) {
          const cur = prev[k];
          const empty = typeof cur !== 'string' || cur.trim() === '';
          if (overwrite.ad_copy || empty) next[k] = v;
        }
        const upd = await svc.from('mos_execution_ads')
          .update({ content_id: contentId, creative: next, updated_at: now }).eq('id', adId);
        if (upd.error) throw new Error(`ad creative update failed: ${upd.error.message}`);
      } else if (executionId) {
        const ins = await svc.from('mos_execution_ads').insert({
          execution_id: executionId,
          ad_set_id: typeof ref.ad_set_id === 'string' && ref.ad_set_id ? ref.ad_set_id : null,
          content_id: contentId,
          label: content.title, status: 'waiting', creative,
        }).select('id').maybeSingle();
        if (ins.error || !ins.data) throw new Error(`ad insert failed: ${ins.error?.message ?? 'no row'}`);
        snapshot.ads.push({
          ad_id: (ins.data as { id: string }).id, execution_id: executionId, creative: null, existed: false,
        });
      }
    }

    // ── 4. production assets → mos_assets wrapper + source link ─────────
    // Mirrors `asset_link_from_file` (find-or-create the wrapper, link 'source').
    const KIND_MAP: Record<string, string> = {
      image: 'photo', photo: 'photo', video: 'video', audio: 'audio',
      document: 'document', pdf: 'document',
    };
    for (const a of (base.assets ?? []).filter((x: AssetPick) => x.is_production && typeof x.file_id === 'string')) {
      const fileId = a.file_id;
      const existing = await svc.from('mos_assets').select('id')
        .eq('file_id', fileId).is('archived_at', null).limit(1).maybeSingle();
      if (existing.error) throw new Error(`asset lookup (${fileId}) failed: ${existing.error.message}`);
      let assetId = (existing.data as { id: string } | null)?.id ?? null;
      if (!assetId) {
        const fileRes = await svc.from('files')
          .select('id, title, original_name, kind, mime_type, size_bytes').eq('id', fileId).maybeSingle();
        if (fileRes.error || !fileRes.data) throw new Error(`file ${fileId} not found for asset wrapper`);
        const f = fileRes.data as {
          title: string | null; original_name: string | null; kind: string | null;
          mime_type: string | null; size_bytes: number | null;
        };
        const ins = await svc.from('mos_assets').insert({
          title: f.title || f.original_name || 'ملف',
          kind: KIND_MAP[(f.kind ?? '').toLowerCase()] ?? 'document',
          file_id: fileId,
          mime_type: f.mime_type ?? null,
          size_bytes: f.size_bytes ?? null,
          original_name: f.original_name ?? null,
          created_by_user_id: appUserId,
        }).select('id').maybeSingle();
        if (ins.error || !ins.data) throw new Error(`asset wrapper insert (${fileId}) failed: ${ins.error?.message ?? 'no row'}`);
        assetId = (ins.data as { id: string }).id;
      }
      const linkExists = await svc.from('mos_asset_links').select('asset_id')
        .eq('asset_id', assetId).eq('content_id', contentId).maybeSingle();
      if (linkExists.error) throw new Error(`asset link check (${assetId}) failed: ${linkExists.error.message}`);
      const up = await svc.from('mos_asset_links')
        .upsert({ asset_id: assetId, content_id: contentId, role: 'source' }, { onConflict: 'asset_id,content_id' });
      if (up.error) throw new Error(`asset link (${assetId}) failed: ${up.error.message}`);
      if (!linkExists.data) snapshot.asset_links_created.push({ asset_id: assetId });
    }
  } catch (e) {
    // Mid-way failure: restore everything already written, then say what happened.
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[creative] apply failed mid-way — restoring from snapshot', packageId, msg);
    const undo = await restoreFromSnapshot(svc, contentId, snapshot);
    return jsonFail(500,
      `Apply failed (${msg}) — the partial changes were rolled back.`,
      'فشل التطبيق — تم التراجع عن التغييرات الجزئية.',
      { restored: undo.restored, restore_failed: undo.failed });
  }

  // ── 5. mark the package + derivatives applied (with the snapshot) ──────
  const updPkg = await svc.from('mos_creative_packages').update({
    status: 'applied',
    applied_at: now,
    applied_by_user_id: appUserId,
    applied_snapshot: snapshot,
    updated_at: now,
  }).eq('id', packageId);
  if (updPkg.error) {
    console.error('[creative] apply: package stamp failed', updPkg.error.code, updPkg.error.message);
    return jsonError(500, updPkg.error.message);
  }
  const updDerivs = await svc.from('mos_creative_derivatives')
    .update({ status: 'applied', applied_at: now })
    .eq('package_id', packageId).eq('status', 'draft');
  if (updDerivs.error) {
    console.error('[creative] apply: derivative stamp failed', updDerivs.error.code, updDerivs.error.message);
    return jsonError(500, updDerivs.error.message);
  }

  return jsonOk({ applied: true, package_id: packageId });
}

/* ------------------------------------------------------------------ */
/* creative_package_revert                                            */
/* ------------------------------------------------------------------ */

export async function creativePackageRevert(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  if (!packageId) return jsonError(400, 'package_id is required');

  const pkgRes = await svc.from('mos_creative_packages')
    .select('id, content_id, status, applied_snapshot').eq('id', packageId).maybeSingle();
  if (pkgRes.error) {
    console.error('[creative] revert: package read failed', pkgRes.error.code, pkgRes.error.message);
    return jsonError(500, pkgRes.error.message);
  }
  if (!pkgRes.data) return jsonFail(404, 'Creative package not found.', 'حزمة المحتوى الإبداعي غير موجودة.');
  const pkg = pkgRes.data as {
    id: string; content_id: string; status: string; applied_snapshot: ApplySnapshot | null;
  };
  if (pkg.status !== 'applied' || !pkg.applied_snapshot) {
    return jsonFail(409,
      'Only an applied package with a snapshot can be reverted.',
      'يمكن التراجع عن حزمة مطبَّقة لها لقطة فقط.');
  }

  const undo = await restoreFromSnapshot(svc, pkg.content_id, pkg.applied_snapshot);
  const upd = await svc.from('mos_creative_packages')
    .update({ status: 'superseded', updated_at: new Date().toISOString() }).eq('id', packageId);
  if (upd.error) {
    console.error('[creative] revert: status flip failed', upd.error.code, upd.error.message);
    return jsonError(500, upd.error.message);
  }
  return jsonOk({ ok: true, restored: undo.restored, restore_failed: undo.failed });
}

/* ------------------------------------------------------------------ */
/* creative_ai_approve / creative_ai_dismiss                          */
/* ------------------------------------------------------------------ */

function loadAiRec(pkg: { base: unknown }, index: number): AiRecommendation | null {
  const recs = (pkg.base as { ai_recommendations?: AiRecommendation[] } | null)?.ai_recommendations;
  if (!Array.isArray(recs) || index < 0 || index >= recs.length) return null;
  return recs[index] ?? null;
}

export async function creativeAiApprove(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  const index = typeof ctx.body.index === 'number' && Number.isInteger(ctx.body.index) ? ctx.body.index : -1;
  if (!packageId || index < 0) return jsonError(400, 'package_id and index (int) are required');

  // Flag: AI image EXECUTION stays dark until explicitly enabled.
  const flags = await readCreativeFlags(ctx.sb);
  if (!flags.ai_image_execution) {
    return jsonFail(403,
      'AI image execution is switched off (creative_writer.ai_image_execution).',
      'تنفيذ الصور بالذكاء الاصطناعي متوقف حاليًا (creative_writer.ai_image_execution).');
  }

  const pkgRes = await svc.from('mos_creative_packages').select('id, content_id, base').eq('id', packageId).maybeSingle();
  if (pkgRes.error) {
    console.error('[creative] ai_approve: package read failed', pkgRes.error.code, pkgRes.error.message);
    return jsonError(500, pkgRes.error.message);
  }
  if (!pkgRes.data) return jsonFail(404, 'Creative package not found.', 'حزمة المحتوى الإبداعي غير موجودة.');
  const pkg = pkgRes.data as { id: string; content_id: string; base: unknown };

  const rec = loadAiRec(pkg, index);
  if (!rec) return jsonError(404, `ai_recommendations[${index}] does not exist`);
  if (rec.status !== 'recommended') {
    return jsonFail(409,
      `This recommendation is "${rec.status}" — only a recommended one can be approved.`,
      'هذه التوصية ليست في حالة «مقترحة» — لا يمكن اعتمادها.');
  }

  // Policy re-check (contracts §7) — the API refuses what the worker would.
  const verdict = checkAiRecommendation({ mode: rec.mode, prompt: rec.prompt, must_keep: rec.must_keep ?? [] });
  if (!verdict.ok) return jsonError(422, verdict.reason);

  const jobId = crypto.randomUUID();
  const ins = await svc.from('generation_jobs').insert({
    id: jobId,
    record_id: pkg.content_id,
    message_id: `${packageId}:${index}`,
    generation_id: null,
    user_id: ctx.userId,
    kind: 'creative-image',
    status: 'queued',
    prompt: rec.prompt ?? null,
    params: {
      package_id: packageId,
      index,
      mode: rec.mode,
      source_file_ids: rec.source_file_ids ?? [],
      aspect: rec.aspect ?? null,
      must_keep: rec.must_keep ?? [],
      must_change: rec.must_change ?? [],
      constraints: rec.constraints ?? [],
    },
  });
  if (ins.error) {
    console.error('[creative] ai_approve: generation_jobs insert failed', ins.error.code, ins.error.message);
    return jsonError(500, ins.error.message);
  }

  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const next: AiRecommendation = {
    ...rec,
    status: 'queued',
    execution: {
      job_id: jobId,
      output_file_id: rec.execution?.output_file_id ?? null,
      error: null,
      approved_by: appUserId,
      approved_at: new Date().toISOString(),
    },
  };
  const patch = await svc.rpc('mos_creative_package_patch', {
    p_package_id: packageId,
    p_path: ['ai_recommendations', String(index)],
    p_value: next,
  });
  if (patch.error) {
    console.error('[creative] ai_approve: recommendation patch failed', patch.error.code, patch.error.message);
    return jsonError(500, patch.error.message);
  }

  await wakeWorker('creative-image');
  return jsonOk({ job_id: jobId });
}

export async function creativeAiDismiss(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const packageId = cStr(ctx.body.package_id);
  const index = typeof ctx.body.index === 'number' && Number.isInteger(ctx.body.index) ? ctx.body.index : -1;
  if (!packageId || index < 0) return jsonError(400, 'package_id and index (int) are required');

  const pkgRes = await svc.from('mos_creative_packages').select('id, base').eq('id', packageId).maybeSingle();
  if (pkgRes.error) {
    console.error('[creative] ai_dismiss: package read failed', pkgRes.error.code, pkgRes.error.message);
    return jsonError(500, pkgRes.error.message);
  }
  if (!pkgRes.data) return jsonFail(404, 'Creative package not found.', 'حزمة المحتوى الإبداعي غير موجودة.');

  const rec = loadAiRec(pkgRes.data as { base: unknown }, index);
  if (!rec) return jsonError(404, `ai_recommendations[${index}] does not exist`);

  const patch = await svc.rpc('mos_creative_package_patch', {
    p_package_id: packageId,
    p_path: ['ai_recommendations', String(index)],
    p_value: { ...rec, status: 'dismissed' },
  });
  if (patch.error) {
    console.error('[creative] ai_dismiss: patch failed', patch.error.code, patch.error.message);
    return jsonError(500, patch.error.message);
  }
  return jsonOk({ ok: true });
}
