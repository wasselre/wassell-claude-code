/**
 * design_example_set / design_example_list — the human-approved exemplars the
 * creative director boosts in retrieval (approved_wassel) or holds up as study
 * material (study_only). Competitor material can NEVER be an approved example
 * (the DB CHECK forces competitor_post ⇒ study_only; we pre-validate for a
 * clean 400). Listing returns active examples with previews.
 */
import { jsonOk, jsonError } from '../../auth.js';
import { cStr, jsonFail, requireSvc, resolveAppUserId, resolveRefPreview, type CreativeCtx } from './wake.js';

const SUBJECT_KINDS = new Set(['wassel_content', 'wassel_file', 'competitor_post']);
const EXAMPLE_KINDS = new Set(['approved_wassel', 'study_only']);

export async function designExampleSet(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const subjectKind = cStr(ctx.body.subject_kind);
  const subjectId = cStr(ctx.body.subject_id);
  if (!subjectKind || !SUBJECT_KINDS.has(subjectKind)) {
    return jsonError(400, 'subject_kind must be wassel_content | wassel_file | competitor_post');
  }
  if (!subjectId) return jsonError(400, 'subject_id is required');

  const now = new Date().toISOString();
  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);

  // Retire: a separate explicit action on the same row (never a delete).
  if (ctx.body.retire === true) {
    const upd = await svc.from('mos_design_examples')
      .update({ retired_at: now })
      .eq('subject_kind', subjectKind).eq('subject_id', subjectId).is('retired_at', null)
      .select('id').maybeSingle();
    if (upd.error) {
      console.error('[creative] design example retire failed', upd.error.code, upd.error.message);
      return jsonError(500, upd.error.message);
    }
    if (!upd.data) return jsonFail(404, 'No active example for that subject.', 'لا يوجد مثال نشط لهذا العنصر.');
    return jsonOk({ ok: true, retired: true });
  }

  const exampleKind = cStr(ctx.body.example_kind);
  if (!exampleKind || !EXAMPLE_KINDS.has(exampleKind)) {
    return jsonError(400, 'example_kind must be approved_wassel | study_only');
  }
  if (subjectKind === 'competitor_post' && exampleKind !== 'study_only') {
    return jsonFail(400,
      'Competitor material is reference-only — it can be a study example, never an approved one.',
      'مواد المنافسين للاستئناس فقط — يمكن أن تكون مثال دراسة، لا مثالًا معتمدًا أبدًا.');
  }
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

  const ups = await svc.from('mos_design_examples').upsert({
    subject_kind: subjectKind,
    subject_id: subjectId,
    example_kind: exampleKind,
    strengths: strList(ctx.body.strengths),
    caveats: strList(ctx.body.caveats),
    note: cStr(ctx.body.note),
    approved_by_user_id: appUserId,
    approved_at: now,
    retired_at: null,
  }, { onConflict: 'subject_kind,subject_id' }).select('*').maybeSingle();
  if (ups.error) {
    console.error('[creative] design example upsert failed', ups.error.code, ups.error.message);
    return jsonError(500, ups.error.message);
  }
  return jsonOk({ example: ups.data });
}

export async function designExampleList(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const includeRetired = ctx.body.include_retired === true;
  let q = svc.from('mos_design_examples').select('*').order('approved_at', { ascending: false }).limit(200);
  if (!includeRetired) q = q.is('retired_at', null);
  const res = await q;
  if (res.error) {
    console.error('[creative] design example list failed', res.error.code, res.error.message);
    return jsonError(500, res.error.message);
  }
  const rows = (res.data ?? []) as Array<{ subject_kind: string; subject_id: string }>;
  const previews: Record<string, string> = {};
  for (const r of rows) {
    const key = `${r.subject_kind}:${r.subject_id}`;
    if (previews[key]) continue;
    const url = await resolveRefPreview(svc, r.subject_kind, r.subject_id);
    if (url) previews[key] = url;
  }
  return jsonOk({ examples: res.data ?? [], previews });
}
