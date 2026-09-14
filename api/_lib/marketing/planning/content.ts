/**
 * Content-side planning actions: AI caption generation, the revision flow, and
 * the refresh-cycle reads/decisions the manager acts on.
 *
 * Caption ownership (plan v2.1 §10): the CANONICAL caption lives on the content
 * record (`mos_content.data.caption`), is written during the WRITING stage, and
 * is confirmed by the writer before the stage can close. Per-platform captions
 * on `mos_publications.caption` and `mos_execution_ads.creative.primary_text`
 * become overrides seeded from it. This is why the Meta worker no longer needs
 * its own AI caption phase for new content.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonOk, jsonError } from '../../auth.js';
import { llmText } from '../../textLlm.js';
import type { PlanCtx } from './actions.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asRecord = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

function fail(where: string, e: { code?: string; message: string } | null): Response {
  console.error(`[planning] ${where} failed`, e?.code, e?.message);
  return jsonError(500, e?.message ?? `${where} failed`);
}

/* ------------------------------------------------------------------ */
/* content_caption_generate                                            */
/* ------------------------------------------------------------------ */

const CAPTION_SYSTEM = `أنت كاتب محتوى عقاري سعودي لشركة «وصل العقارية».
اكتب كابشن واحدًا لمنشور عن المشروع المعطى.
قواعد صارمة:
- بالعربية الفصحى المبسّطة بنبرة سعودية، من ٣ إلى ٦ أسطر قصيرة.
- لا تخترع أي رقم. استخدم فقط الأرقام الواردة في الحقائق أدناه.
- لا وعود بعائد أو تمويل أو ضمان.
- اذكر «على الخارطة» صراحةً إذا كان المشروع على الخارطة.
- أنهِ بدعوة للتواصل، دون رقم هاتف.
أعد الكابشن فقط، بلا مقدمات ولا علامات اقتباس.`;

/** Every digit sequence in a text — used to prove the model invented nothing. */
function digitsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d.,]*/g)) {
    const norm = m[0].replace(/[.,]$/, '');
    if (norm.length >= 2) out.add(norm.replace(/[.,]/g, ''));
  }
  return out;
}

export async function contentCaptionGenerate(ctx: PlanCtx): Promise<Response> {
  const contentId = str(ctx.body.content_id);
  if (!contentId) return jsonError(400, 'content_id is required');

  const { data: row, error } = await ctx.sb
    .from('mos_content_v')
    .select('id, ref, title, project_id, project_ids, data, content_type_key, goal, audience, angle, cta')
    .eq('id', contentId).maybeSingle();
  if (error) return fail('mos_content_v read', error);
  if (!row) return jsonError(404, 'content not found');

  const content = row as {
    title: string; data: Record<string, unknown>; project_ids: unknown;
    goal: string | null; audience: string | null; angle: string | null; cta: string | null;
  };

  // Project facts — the ONLY numbers the caption may contain.
  const projectIds = Array.isArray(content.project_ids) ? content.project_ids.map(String) : [];
  let facts: Record<string, unknown> = {};
  if (projectIds.length) {
    const { data: rec, error: recErr } = await ctx.sb
      .from('unified_records').select('data').eq('id', projectIds[0]).maybeSingle();
    if (recErr) console.error('[planning] project facts read failed', recErr.code, recErr.message);
    else facts = asRecord((rec as { data?: unknown } | null)?.data);
  }

  const headlines = Array.isArray(content.data?.headlines)
    ? (content.data.headlines as unknown[]).map(String) : [];
  const brief = str(content.data?.design_brief) ?? '';

  const factLines = [
    facts.project_name ? `اسم المشروع: ${String(facts.project_name)}` : null,
    facts.district_name ? `الحي: ${String(facts.district_name)}` : null,
    facts.city_name ? `المدينة: ${String(facts.city_name)}` : null,
    facts.available_units != null ? `الوحدات المتاحة: ${String(facts.available_units)}` : null,
    facts.construction_status ? `الحالة: ${String(facts.construction_status)}` : null,
    facts.handover_date ? `التسليم: ${String(facts.handover_date)}` : null,
  ].filter(Boolean).join('\n');

  const prompt = [
    `العنوان الداخلي: ${content.title}`,
    content.goal ? `الهدف: ${content.goal}` : null,
    content.audience ? `الجمهور: ${content.audience}` : null,
    content.angle ? `الزاوية: ${content.angle}` : null,
    headlines.length ? `العناوين المعتمدة على التصميم:\n- ${headlines.join('\n- ')}` : null,
    brief ? `بريف التصميم: ${brief}` : null,
    factLines ? `حقائق المشروع (المصدر الوحيد للأرقام):\n${factLines}` : 'لا تتوفر حقائق رقمية — لا تذكر أي رقم.',
  ].filter(Boolean).join('\n\n');

  const allowed = digitsIn(`${factLines}\n${headlines.join('\n')}\n${brief}`);
  let caption = '';
  let source: 'ai' | 'fallback' = 'ai';

  for (let attempt = 0; attempt < 2 && !caption; attempt += 1) {
    let out = '';
    try {
      out = await llmText({
        track: { area: 'marketing', callSite: 'api/_lib/marketing/planning/content', operation: 'caption' },
        system: attempt === 0 ? CAPTION_SYSTEM
          : `${CAPTION_SYSTEM}\nتنبيه: المحاولة السابقة احتوت رقمًا غير وارد في الحقائق. لا تذكر أي رقم غير موجود حرفيًا في الحقائق.`,
        user: prompt,
        maxTokens: 700,
        temperature: 0.4,
      });
    } catch (e) {
      console.error('[planning] caption LLM failed', e instanceof Error ? e.message : String(e));
      break;
    }
    const text = out.trim();
    if (!text) continue;
    const invented = [...digitsIn(text)].filter((d) => !allowed.has(d));
    if (invented.length) {
      console.error('[planning] caption rejected — invented numbers', invented.join(','));
      continue;
    }
    caption = text;
  }

  if (!caption) {
    // Deterministic fallback: the approved headlines, which a human already saw.
    source = 'fallback';
    caption = [
      headlines[0] ?? content.title,
      ...headlines.slice(1, 4),
      content.cta ?? 'للاستفسار والحجز تواصل معنا.',
    ].filter(Boolean).join('\n');
  }

  return jsonOk({ caption, source });
}

/* ------------------------------------------------------------------ */
/* content_revise                                                      */
/* ------------------------------------------------------------------ */

/**
 * Open a revision on an approved item.
 *
 * The SCOPE is derived by the database from what actually changed — the writer
 * cannot narrow it. A caption-only edit re-runs writing review + final review;
 * an edit to any field flagged `affects_design` also re-runs design and the
 * writer's design review, because the existing image still shows the old text
 * (the second review's example: a changed price).
 */
export async function contentRevise(ctx: PlanCtx): Promise<Response> {
  const contentId = str(ctx.body.content_id);
  const note = str(ctx.body.note);
  if (!contentId) return jsonError(400, 'content_id is required');
  if (!note) return jsonError(400, 'a note explaining the revision is required');
  const scope = Array.isArray(ctx.body.scope)
    ? (ctx.body.scope as unknown[]).map(String).filter((s) => ['writing', 'caption', 'design'].includes(s))
    : [];

  const { data, error } = await ctx.sb.rpc('content_revise', {
    p_content_id: contentId,
    p_scope: scope,
    p_note: note,
  });
  if (error) {
    const msg = error.message ?? '';
    if (/MOS:NOT_APPROVED/.test(msg)) return jsonError(409, 'this item has no approved package to revise');
    if (/MOS:NOT_ALLOWED/.test(msg)) return jsonError(403, 'revise_approved_content capability required');
    return fail('content_revise', error);
  }
  return jsonOk({ revision: data });
}

/* ------------------------------------------------------------------ */
/* refresh cycles                                                      */
/* ------------------------------------------------------------------ */

export async function refreshCycleList(ctx: PlanCtx): Promise<Response> {
  const executionId = str(ctx.body.execution_id);
  if (!executionId) return jsonError(400, 'execution_id is required');

  const [cyclesRes, slotsRes, perfRes] = await Promise.all([
    ctx.sb.from('mos_refresh_cycles')
      .select('*').eq('execution_id', executionId).order('round'),
    ctx.sb.from('mos_creative_slots')
      .select('*').eq('execution_id', executionId).order('cycle_id').order('slot_index'),
    ctx.sb.from('mos_creative_perf_v')
      .select('*').eq('execution_id', executionId),
  ]);
  for (const [label, res] of [
    ['mos_refresh_cycles', cyclesRes], ['mos_creative_slots', slotsRes],
    ['mos_creative_perf_v', perfRes],
  ] as const) {
    if (res.error) return fail(label, res.error);
  }
  return jsonOk({
    cycles: cyclesRes.data ?? [],
    slots: slotsRes.data ?? [],
    performance: perfRes.data ?? [],
  });
}

export async function refreshCycleDecide(ctx: PlanCtx): Promise<Response> {
  const cycleId = str(ctx.body.cycle_id);
  if (!cycleId) return jsonError(400, 'cycle_id is required');
  const keep = Array.isArray(ctx.body.keep_ad_ids) ? (ctx.body.keep_ad_ids as unknown[]).map(String) : [];
  const replace = Array.isArray(ctx.body.replace_ad_ids) ? (ctx.body.replace_ad_ids as unknown[]).map(String) : [];
  if (!replace.length) return jsonError(400, 'at least one creative must be replaced');

  const { data, error } = await ctx.sb.rpc('mos_refresh_cycle_decide', {
    p_cycle_id: cycleId,
    p_keep_ad_ids: keep,
    p_replace_ad_ids: replace,
  });
  if (error) {
    const msg = error.message ?? '';
    if (/MOS:MIN_ACTIVE/.test(msg)) {
      return jsonError(409, 'that decision would leave the ad set below its minimum active creatives');
    }
    if (/MOS:NOT_READY/.test(msg)) {
      return jsonError(409, 'not every replacement is built and verified yet');
    }
    return fail('mos_refresh_cycle_decide', error);
  }
  // The worker performs the Meta side on its next sweep; nothing here touches Graph.
  return jsonOk({ decision: data });
}

/** Shared by both callers so the LLM routing lives in one place. */
export type { SupabaseClient };
