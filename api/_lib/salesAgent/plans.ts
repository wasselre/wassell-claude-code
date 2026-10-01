/**
 * Read FLOOR PLANS for a feature our data does not record («مطبخ مفتوح»,
 * «غرفة مكتب», «حمام بالروف»). The unit's `unit_plan` is a `files` row (an
 * image in the private wassel-files bucket); one plan is usually shared by
 * several units of the same model, so we read each DISTINCT plan once per
 * question and cache the answer in `unit_plan_checks`.
 *
 * Bounded on purpose: at most MAX_PLANS uncached plans per call (most-shared
 * plans first, so one read answers the most units). Units whose plan we did
 * not read are reported as unchecked — never as yes or no.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { trackedAnthropic } from '../aiUsage.js';
import { loadAvailableUnits } from '../trackedLinks.js';
import { normFeature } from './features.js';
import { clip } from './clip.js';

const MAX_PLANS = 8;
const CONCURRENCY = 4;
const PLAN_MODEL = 'claude-sonnet-5-5';
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export type PlanAnswer = 'yes' | 'no' | 'unclear';

export interface PlanCheck {
  project_id: string;
  feature: string;
  units_considered: number;
  /** Units whose plan shows the feature — sendable with send_units. */
  yes_unit_ids: string[];
  no_units: number;
  unclear_units: number;
  /** Units whose plan was not read this time (over the per-call cap). */
  unchecked_units: number;
  /** Units with no floor plan on file — only a colleague can answer. */
  units_without_plan: number;
  plans_read: number;
  /** What the reader saw, a few lines. */
  evidence: Array<{ answer: PlanAnswer; units: number; note: string }>;
}

interface FileRow { id: string; storage_bucket: string | null; storage_path: string | null; mime_type: string | null }

async function readPlan(client: Anthropic, svc: SupabaseClient, file: FileRow, feature: string): Promise<{ answer: PlanAnswer; evidence: string }> {
  if (!file.storage_bucket || !file.storage_path || !IMAGE_MIMES.has(String(file.mime_type ?? '').toLowerCase())) {
    return { answer: 'unclear', evidence: 'المخطط ليس صورة يمكن قراءتها' };
  }
  const { data: blob, error } = await svc.storage.from(file.storage_bucket).download(file.storage_path);
  if (error || !blob) throw new Error(`plan download failed (${file.id}): ${error?.message ?? 'empty'}`);
  const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
  const res = await client.messages.create({
    model: PLAN_MODEL,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: file.mime_type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: b64 } },
        { type: 'text', text: `This is the floor plan of one residential unit (labels are usually Arabic).\nQuestion: does this unit have «${feature}»?\nAnswer ONLY with JSON: {"answer":"yes"|"no"|"unclear","evidence":"<one short Arabic line saying what in the plan shows it>"}.\n"unclear" when the plan cannot tell (unreadable, the feature is not something a plan shows).` },
      ],
    }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { answer: 'unclear', evidence: clip(text.trim(), 120) };
  try {
    const j = JSON.parse(m[0]) as { answer?: string; evidence?: string };
    const answer: PlanAnswer = j.answer === 'yes' || j.answer === 'no' ? j.answer : 'unclear';
    return { answer, evidence: clip(String(j.evidence ?? ''), 160) };
  } catch (e) {
    console.error('[salesAgent] plan answer was not JSON:', (e as Error).message, clip(text, 200));
    return { answer: 'unclear', evidence: '' };
  }
}

export async function checkUnitPlans(
  svc: SupabaseClient,
  a: { projectId: string; feature: string; unitIds?: string[] | null; chatWid?: string },
): Promise<PlanCheck> {
  const feature = a.feature.trim();
  const key = normFeature(feature);
  let units = await loadAvailableUnits(svc, a.projectId);
  if (a.unitIds?.length) { const want = new Set(a.unitIds); units = units.filter((u) => want.has(u.id)); }

  // Distinct plans, most-shared first.
  const byPlan = new Map<string, string[]>();
  let withoutPlan = 0;
  for (const u of units) {
    const plan = typeof u.data?.unit_plan === 'string' && /^[0-9a-f-]{36}$/i.test(u.data.unit_plan) ? u.data.unit_plan : null;
    if (!plan) { withoutPlan++; continue; }
    const list = byPlan.get(plan) ?? [];
    list.push(u.id);
    byPlan.set(plan, list);
  }
  const plans = [...byPlan.entries()].sort((x, y) => y[1].length - x[1].length);

  // Cached answers first.
  const answers = new Map<string, { answer: PlanAnswer; evidence: string }>();
  const ids = plans.map(([id]) => id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await svc.from('unit_plan_checks').select('file_id, answer, evidence').eq('question_key', key).in('file_id', ids.slice(i, i + 200));
    if (error) throw new Error(`plan cache read failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ file_id: string; answer: PlanAnswer; evidence: string | null }>) answers.set(r.file_id, { answer: r.answer, evidence: r.evidence ?? '' });
  }

  const toRead = plans.filter(([id]) => !answers.has(id)).slice(0, MAX_PLANS).map(([id]) => id);
  let read = 0;
  if (toRead.length) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
    const client = trackedAnthropic(new Anthropic({ apiKey }), {
      area: 'sales', callSite: 'salesAgent/planCheck', operation: 'plan_check', entityKind: 'project', entityId: a.projectId,
      meta: { feature, chat_wid: a.chatWid ?? null },
    });
    const { data: files, error } = await svc.from('files').select('id, storage_bucket, storage_path, mime_type').in('id', toRead);
    if (error) throw new Error(`plan files read failed: ${error.message}`);
    const fileById = new Map(((files ?? []) as FileRow[]).map((f) => [f.id, f]));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toRead.length) }, async () => {
      while (next < toRead.length) {
        const id = toRead[next++]!;
        const f = fileById.get(id);
        try {
          const r = f ? await readPlan(client, svc, f, feature) : { answer: 'unclear' as PlanAnswer, evidence: 'ملف المخطط غير موجود' };
          answers.set(id, r);
          read++;
          const { error: wErr } = await svc.from('unit_plan_checks').upsert({ file_id: id, question_key: key, answer: r.answer, evidence: r.evidence, model: PLAN_MODEL });
          if (wErr) console.error(`[salesAgent] plan cache write failed file=${id}:`, wErr.message);
        } catch (e) {
          // One unreadable plan leaves its units unchecked; it never fails the turn.
          console.error(`[salesAgent] plan read failed file=${id}:`, e instanceof Error ? e.message : String(e));
        }
      }
    }));
  }

  const out: PlanCheck = {
    project_id: a.projectId, feature, units_considered: units.length, yes_unit_ids: [], no_units: 0, unclear_units: 0,
    unchecked_units: 0, units_without_plan: withoutPlan, plans_read: read, evidence: [],
  };
  const notes = new Map<string, { answer: PlanAnswer; units: number; note: string }>();
  for (const [plan, unitIds] of plans) {
    const ans = answers.get(plan);
    if (!ans) { out.unchecked_units += unitIds.length; continue; }
    if (ans.answer === 'yes') out.yes_unit_ids.push(...unitIds);
    else if (ans.answer === 'no') out.no_units += unitIds.length;
    else out.unclear_units += unitIds.length;
    const k = `${ans.answer}|${ans.evidence}`;
    const n = notes.get(k) ?? { answer: ans.answer, units: 0, note: ans.evidence };
    n.units += unitIds.length;
    notes.set(k, n);
  }
  out.evidence = [...notes.values()].sort((x, y) => y.units - x.units).slice(0, 4);
  return out;
}
