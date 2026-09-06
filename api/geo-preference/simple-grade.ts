/**
 * /api/geo-preference/simple-grade — the DEAD-SIMPLE grading surface.
 *
 * The full labeling instrument (labeling.ts) asks a specialist to label every
 * ontology field, blind. That's too much for a quick "is the AI any good?" pass.
 * This endpoint serves ONE coarse question per item — is the AI's read of this
 * mention Right / Wrong / Not sure — reading the AI's actual guess straight off
 * geo_pref_evidence and saving a single `overall.verdict` label. Admin-only.
 *
 *   GET  ?batch=<id>   → { batch, items:[{ id, client, mention, role, commitment,
 *                          holder, applicability, anchor_type, my_verdict }], total, graded }
 *   POST { batch, evidence_id, verdict:'right'|'wrong'|'unsure', note? } → { ok }
 *
 * NEVER writes a client record. Nothing here is auto-write.
 */
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';

export const config = { runtime: 'edge' };

interface BatchSubject { subject_kind: string; subject_ref: string }
const VERDICTS = new Set(['right', 'wrong', 'unsure']);

function firstName(full: string): string {
  const t = full.trim().split(/\s+/);
  return t.length ? t[0]! : '';
}

export default async function handler(req: Request): Promise<Response> {
  return withAuth(req, async (user) => {
    const sb = makeServiceClient('api:geo-simple-grade');
    if (!sb) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    const { data: isAdmin, error: adminErr } = await sb.rpc('wassell_is_admin', { auth_user_id: user.userId });
    if (adminErr) return jsonError(500, `admin check failed: ${adminErr.message}`);
    if (isAdmin !== true) return jsonError(403, 'grading is admin-only');

    // ── GET: the batch's items with the AI's guess + my existing verdicts ──
    if (req.method === 'GET') {
      const batchId = new URL(req.url).searchParams.get('batch') ?? '';
      if (!batchId) return jsonError(400, 'a batch query param is required');

      const { data: b, error: bErr } = await sb
        .from('geo_pref_calibration_batch').select('id, label, subjects').eq('id', batchId).maybeSingle();
      if (bErr) return jsonError(500, `batch read failed: ${bErr.message}`);
      if (!b) return jsonError(404, 'batch not found');

      const evIds = ((b.subjects ?? []) as BatchSubject[])
        .filter((s) => s.subject_kind === 'evidence').map((s) => s.subject_ref);
      if (evIds.length === 0) return jsonOk({ batch: { id: b.id, label: b.label }, items: [], total: 0, graded: 0 });

      const { data: evs, error: evErr } = await sb
        .from('geo_pref_evidence')
        .select('id, client_id, mention_span, preference_role, commitment, holder_role, preference_applicability, anchors, source_timestamp')
        .in('id', evIds)
        .order('client_id', { ascending: true }).order('source_timestamp', { ascending: true });
      if (evErr) return jsonError(500, `evidence read failed: ${evErr.message}`);

      const clientIds = [...new Set((evs ?? []).map((e) => e.client_id).filter(Boolean))] as string[];
      const nameOf = new Map<string, string>();
      if (clientIds.length) {
        const { data: clients } = await sb.from('records').select('id, data').in('id', clientIds);
        for (const c of clients ?? []) {
          nameOf.set(c.id as string, firstName(String((c.data as Record<string, unknown>)?.client_name ?? '')));
        }
      }

      const { data: mine } = await sb.from('geo_pref_labels')
        .select('subject_ref, value').eq('batch_id', batchId).eq('annotator_id', user.userId).eq('field', 'overall.verdict');
      const verdictOf = new Map<string, string | null>((mine ?? []).map((m) => [m.subject_ref as string, m.value as string | null]));

      const items = (evs ?? []).map((e) => ({
        id: e.id,
        client: nameOf.get(e.client_id as string) ?? '',
        mention: e.mention_span,
        role: e.preference_role,
        commitment: e.commitment,
        holder: e.holder_role,
        applicability: e.preference_applicability,
        anchor_type: (Array.isArray(e.anchors) && e.anchors[0] ? (e.anchors[0] as { anchor_type?: string }).anchor_type : null) ?? null,
        my_verdict: verdictOf.get(e.id as string) ?? null,
      }));
      return jsonOk({ batch: { id: b.id, label: b.label }, items, total: items.length, graded: items.filter((i) => i.my_verdict).length });
    }

    // ── POST: save one verdict (upsert; re-grading edits) ──
    if (req.method === 'POST') {
      let body: { batch?: string; evidence_id?: string; verdict?: string; note?: string };
      try { body = (await req.json()) as typeof body; } catch { return jsonError(400, 'invalid JSON'); }
      if (!body.batch || !body.evidence_id) return jsonError(400, 'batch + evidence_id required');
      if (!body.verdict || !VERDICTS.has(body.verdict)) return jsonError(400, "verdict must be right|wrong|unsure");

      const base = {
        batch_id: body.batch, subject_kind: 'evidence' as const, subject_ref: body.evidence_id,
        annotator_id: user.userId, role: 'meaning' as const, round: 'blind' as const, is_escape: false,
      };
      const { error } = await sb.from('geo_pref_labels').upsert(
        { ...base, field: 'overall.verdict', value: body.verdict },
        { onConflict: 'batch_id,subject_ref,field,annotator_id,round' },
      );
      if (error) return jsonError(500, `save failed: ${error.message}`);
      if (typeof body.note === 'string' && body.note.trim()) {
        await sb.from('geo_pref_labels').upsert(
          { ...base, field: 'overall.note', value: body.note.trim().slice(0, 500) },
          { onConflict: 'batch_id,subject_ref,field,annotator_id,round' },
        );
      }
      return jsonOk({ ok: true });
    }

    return jsonError(405, 'Method not allowed');
  });
}
