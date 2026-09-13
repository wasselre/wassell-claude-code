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
 *                          holder, applicability, anchor_type, source_channel,
 *                          conversation_id, my_verdict }], transcripts, total, graded }
 *        `transcripts` is keyed by conversation_id — the phone_calls record id for a
 *        call, the chat_wid for a WhatsApp thread — so each card shows the ONE
 *        conversation its mention came from (a client-keyed merge is also emitted
 *        for legacy batches whose conversation_id is the client id).
 *   POST { batch, evidence_id, verdict:'right'|'wrong'|'unsure', note? } → { ok }
 *
 * NEVER writes a client record. Nothing here is auto-write.
 */
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { geoPreferenceToLocationItems } from './review.js';
import type { GeoPreference } from '../_lib/geoPreference/ontology.js';

const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Per-mention placement from a compiled expression: `geo:<evidence id>` refs → recipe. */
interface Placement { polarity: 'include' | 'exclude'; operation: string; element_ids: string[]; resolved: boolean; label: string }
function placementsByEvidence(expr: GeoPreference | null | undefined): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  if (!expr || !Array.isArray(expr.groups)) return out;
  for (const g of expr.groups) {
    for (const c of g.clauses ?? []) {
      for (const ref of c.anyOf ?? []) {
        const eid = typeof ref.geometry_id === 'string' && ref.geometry_id.startsWith('geo:') ? ref.geometry_id.slice(4) : '';
        const r = ref.recipe;
        if (!eid || !r) continue;
        const ids = Array.isArray(r.resolved_element_ids) ? r.resolved_element_ids.map(String) : [];
        out[eid] = {
          polarity: c.op === 'exclude' ? 'exclude' : 'include',
          operation: String(r.operation ?? ''),
          element_ids: ids,
          resolved: r.geo_data_version !== 'stub' && ids.length > 0,
          label: (Array.isArray(r.source_anchors) ? r.source_anchors : []).map((a) => a.span).filter(Boolean).join(' / '),
        };
      }
    }
  }
  return out;
}

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
        .select('id, client_id, conversation_id, source_channel, mention_span, preference_role, commitment, holder_role, preference_applicability, anchors, source_timestamp')
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
      const { data: mapMine } = await sb.from('geo_pref_labels')
        .select('subject_ref, value').eq('batch_id', batchId).eq('annotator_id', user.userId).eq('field', 'map.verdict');
      const mapVerdictOf = new Map<string, string | null>((mapMine ?? []).map((m) => [m.subject_ref as string, m.value as string | null]));

      // ── Conversation view: checkpoint + proposal (what the AI put on the map) per conversation ──
      const convIds = [...new Set((evs ?? []).map((e) => e.conversation_id as string).filter(Boolean))];
      const cpByConv = new Map<string, string>();
      if (convIds.length) {
        const { data: cps, error: cpErr } = await sb.from('geo_pref_checkpoints').select('id, conversation_id').in('conversation_id', convIds).eq('origin_tag', 'model');
        if (cpErr) return jsonError(500, `checkpoints read failed: ${cpErr.message}`);
        for (const c of cps ?? []) cpByConv.set(c.conversation_id as string, c.id as string);
      }
      const propByCp = new Map<string, { id: string; proposed_action: string; expression: GeoPreference }>();
      const cpIds = [...cpByConv.values()];
      if (cpIds.length) {
        const { data: props, error: pErr } = await sb.from('geo_pref_proposals')
          .select('id, checkpoint_id, proposed_action, proposed_expression, final_expression, status, created_at')
          .in('checkpoint_id', cpIds).order('created_at', { ascending: false });
        if (pErr) return jsonError(500, `proposals read failed: ${pErr.message}`);
        for (const p of props ?? []) {
          const cp = p.checkpoint_id as string;
          if (propByCp.has(cp)) continue; // newest wins
          propByCp.set(cp, { id: p.id as string, proposed_action: p.proposed_action as string, expression: ((p.final_expression ?? p.proposed_expression) as GeoPreference) });
        }
      }
      const districtIds = new Set<string>();
      const conversations = convIds.map((cid) => {
        const rows = (evs ?? []).filter((e) => e.conversation_id === cid);
        const first = rows[0]!;
        const cpId = cpByConv.get(cid) ?? null;
        const prop = cpId ? propByCp.get(cpId) : undefined;
        let proposal: null | { id: string; action: string; items: ReturnType<typeof geoPreferenceToLocationItems>; by_evidence: Record<string, Placement> } = null;
        if (prop) {
          const items = geoPreferenceToLocationItems(prop.expression).filter((li) => li.kind !== 'district' || isUuid(li.district_id));
          const by_evidence = placementsByEvidence(prop.expression);
          for (const li of items) if (li.kind === 'district') districtIds.add(li.district_id);
          for (const pl of Object.values(by_evidence)) for (const id of pl.element_ids) if (isUuid(id)) districtIds.add(id);
          proposal = { id: prop.id, action: prop.proposed_action, items, by_evidence };
        }
        return {
          conversation_id: cid,
          client_id: first.client_id as string,
          client: nameOf.get(first.client_id as string) ?? '',
          channel: first.source_channel === 'call' ? 'call' : 'chat',
          timestamp: (first.source_timestamp as string | null) ?? null,
          evidence_ids: rows.map((e) => e.id as string),
          checkpoint_id: cpId,
          proposal,
          map_verdict: cpId ? (mapVerdictOf.get(cpId) ?? null) : null,
        };
      });
      const districts: Record<string, { name_ar: string; name_en: string; city: string }> = {};
      if (districtIds.size) {
        const { data: ds, error: dErr } = await sb.from('districts').select('id, name_ar, name_en, city_name_ar').in('id', [...districtIds]);
        if (dErr) return jsonError(500, `districts read failed: ${dErr.message}`);
        for (const d of ds ?? []) districts[d.id as string] = { name_ar: String(d.name_ar ?? ''), name_en: String(d.name_en ?? ''), city: String(d.city_name_ar ?? '') };
      }

      // The SOURCE the AI read — so a grader can verify — keyed by the REAL
      // conversation: one entry per phone call (its record id) and per WhatsApp
      // thread (its chat_wid). A call and a chat are never shown merged, because
      // they were never extracted merged. Phone numbers scrubbed. The client-keyed
      // merge is kept only for legacy batches (conversation_id = client id).
      const PHONE = /(\+?\d[\d\s().-]{6,}\d)/g;
      const transcripts: Record<string, string> = {};
      const legacyByClient: Record<string, string> = {};
      const mdl = await sb.from('models').select('id, name').in('name', ['phone_calls', 'chats']);
      const pcId = (mdl.data ?? []).find((m) => m.name === 'phone_calls')?.id as string | undefined;
      const chatId = (mdl.data ?? []).find((m) => m.name === 'chats')?.id as string | undefined;
      if (pcId) {
        const { data: calls } = await sb.from('records').select('id, data').eq('model_id', pcId).in('data->>client_link', clientIds);
        for (const c of calls ?? []) {
          const cid = String((c.data as Record<string, unknown>).client_link ?? '');
          const t = String((c.data as Record<string, unknown>).transcription_text ?? '').trim();
          if (!cid || !t) continue;
          transcripts[c.id as string] = t;
          legacyByClient[cid] = (legacyByClient[cid] ? legacyByClient[cid] + '\n\n──────\n\n' : '') + t;
        }
      }
      if (chatId) {
        const { data: chatRecs } = await sb.from('records').select('data').eq('model_id', chatId).in('data->>client_link', clientIds);
        const widToClient = new Map<string, string>();
        for (const ct of chatRecs ?? []) {
          const cid = String((ct.data as Record<string, unknown>).client_link ?? '');
          const wid = String((ct.data as Record<string, unknown>).wid ?? '');
          if (cid && wid) widToClient.set(wid, cid);
        }
        const wids = [...widToClient.keys()];
        if (wids.length) {
          // Both sides — the agent's question is what makes a one-word reply gradeable.
          const { data: msgs } = await sb.from('chat_messages').select('chat_wid, body, flow, date').in('chat_wid', wids).order('date', { ascending: true }).limit(600);
          for (const m of msgs ?? []) {
            const wid = m.chat_wid as string;
            const cid = widToClient.get(wid);
            const bd = String(m.body ?? '').trim();
            if (!cid || !bd) continue;
            const line = (m.flow === 'in' ? '🧑 ' : '🏢 ') + bd;
            transcripts[wid] = (transcripts[wid] ? transcripts[wid] + '\n' : '') + line;
            legacyByClient[cid] = (legacyByClient[cid] ? legacyByClient[cid] + '\n' : '') + line;
          }
        }
      }
      for (const [cid, t] of Object.entries(legacyByClient)) if (!transcripts[cid]) transcripts[cid] = t;
      for (const k of Object.keys(transcripts)) transcripts[k] = (transcripts[k] ?? '').replace(PHONE, '[رقم]').slice(0, 8000);

      const items = (evs ?? []).map((e) => ({
        id: e.id,
        client_id: e.client_id,
        client: nameOf.get(e.client_id as string) ?? '',
        mention: e.mention_span,
        role: e.preference_role,
        commitment: e.commitment,
        holder: e.holder_role,
        applicability: e.preference_applicability,
        anchor_type: (Array.isArray(e.anchors) && e.anchors[0] ? (e.anchors[0] as { anchor_type?: string }).anchor_type : null) ?? null,
        source_channel: e.source_channel === 'call' ? 'call' : 'chat',
        conversation_id: e.conversation_id,
        my_verdict: verdictOf.get(e.id as string) ?? null,
      }));
      return jsonOk({ batch: { id: b.id, label: b.label }, items, transcripts, conversations, districts, total: items.length, graded: items.filter((i) => i.my_verdict).length });
    }

    // ── POST: save one verdict (upsert; re-grading edits) — a mention's, or a conversation's MAP verdict ──
    if (req.method === 'POST') {
      let body: { batch?: string; evidence_id?: string; verdict?: string; note?: string; checkpoint_id?: string; map_verdict?: string };
      try { body = (await req.json()) as typeof body; } catch { return jsonError(400, 'invalid JSON'); }
      if (body.checkpoint_id && body.map_verdict) {
        if (!body.batch) return jsonError(400, 'batch required');
        if (!VERDICTS.has(body.map_verdict)) return jsonError(400, 'map_verdict must be right|wrong|unsure');
        const { error } = await sb.from('geo_pref_labels').upsert(
          { batch_id: body.batch, subject_kind: 'checkpoint', subject_ref: body.checkpoint_id, annotator_id: user.userId, role: 'geo_operator', round: 'blind', is_escape: false, field: 'map.verdict', value: body.map_verdict },
          { onConflict: 'batch_id,subject_ref,field,annotator_id,round' },
        );
        if (error) return jsonError(500, `save failed: ${error.message}`);
        return jsonOk({ ok: true });
      }
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
