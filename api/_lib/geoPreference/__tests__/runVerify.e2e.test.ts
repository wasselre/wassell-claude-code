import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { makeSupabaseBackfillDeps, gatherClientConversations } from '../backfillPorts.js';
import type { Conversation } from '../extractor.js';
import type { Evidence } from '../ontology.js';
import type { VerifierResult } from '../verifier.js';

/**
 * OPERATIONAL verifier run (RUN_VERIFY=1 CALIB_BATCH_ID=<batch>). For every
 * conversation in a graded batch it runs the ADVISORY verifier (verifier.ts) on
 * the NEWEST pending proposal of that conversation's model checkpoint — through
 * the real port, so the result is also stored on the proposal row — then joins
 * the verifier's per-mention verdicts with the human `overall.verdict` grades
 * and prints the agreement.
 *
 * Never creates a proposal (a conversation without one is logged + skipped),
 * never re-extracts (the graded evidence is untouched), never writes a client
 * record. Real LLM calls: one per conversation.
 */

try {
  const env = readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch { /* env optional: the describe below skips without SUPABASE_URL + key */ }

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_ID = process.env.CALIB_BATCH_ID?.trim() || '';

let supabase: SupabaseClient;
beforeAll(() => { if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } }); });

type Row = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Only the fields the verifier port reads (id, span, role) matter; the rest are carried for type completeness. */
function rowToEvidence(r: Row): Evidence {
  return {
    id: s(r.id),
    mention_span: s(r.mention_span),
    anchors: Array.isArray(r.anchors) ? (r.anchors as Evidence['anchors']) : [],
    speaker: s(r.speaker) as Evidence['speaker'],
    preference_holder: s(r.preference_holder) as Evidence['preference_holder'],
    holder_role: s(r.holder_role) as Evidence['holder_role'],
    quoted_speaker: s(r.quoted_speaker) as Evidence['quoted_speaker'],
    dialogue_act: s(r.dialogue_act) as Evidence['dialogue_act'],
    conditionality: s(r.conditionality) as Evidence['conditionality'],
    temporal_reference: s(r.temporal_reference) as Evidence['temporal_reference'],
    preference_applicability: s(r.preference_applicability) as Evidence['preference_applicability'],
    preference_role: s(r.preference_role) as Evidence['preference_role'],
    commitment: s(r.commitment) as Evidence['commitment'],
    hardness_evidence: s(r.hardness_evidence) as Evidence['hardness_evidence'],
    modality: s(r.modality) as Evidence['modality'],
    source: { channel: (s(r.source_channel) === 'call' ? 'call' : 'chat'), ref: s(r.source_ref), timestamp: s(r.source_timestamp) },
    extraction_version: s(r.extraction_version) || undefined,
  };
}

describe.skipIf(!process.env.RUN_VERIFY || !URL_ || !KEY || !BATCH_ID)('VERIFY a graded batch and measure agreement with the human grades', () => {
  it('runs the verifier per conversation and prints the confusion table', async () => {
    const { data: batch, error: bErr } = await supabase.from('geo_pref_calibration_batch').select('id, label, subjects').eq('id', BATCH_ID).single();
    expect(bErr).toBeNull();
    const evIds = ((batch?.subjects ?? []) as Array<{ subject_kind: string; subject_ref: string }>).filter((x) => x.subject_kind === 'evidence').map((x) => x.subject_ref);
    expect(evIds.length).toBeGreaterThan(0);

    const { data: evRows, error: evErr } = await supabase.from('geo_pref_evidence').select('*').in('id', evIds)
      .order('source_timestamp', { ascending: true }).order('id', { ascending: true });
    expect(evErr).toBeNull();
    const byConv = new Map<string, Row[]>();
    for (const r of (evRows ?? []) as Row[]) byConv.set(s(r.conversation_id), [...(byConv.get(s(r.conversation_id)) ?? []), r]);
    const convIds = [...byConv.keys()];

    const { data: cps, error: cpErr } = await supabase.from('geo_pref_checkpoints').select('id, conversation_id').in('conversation_id', convIds).eq('origin_tag', 'model');
    expect(cpErr).toBeNull();
    const cpOf = new Map<string, string>(((cps ?? []) as Row[]).map((c) => [s(c.conversation_id), s(c.id)]));
    const { data: props, error: pErr } = await supabase.from('geo_pref_proposals').select('id, checkpoint_id, created_at')
      .in('checkpoint_id', [...cpOf.values()]).eq('status', 'pending').order('created_at', { ascending: false });
    expect(pErr).toBeNull();
    const propOf = new Map<string, string>();
    for (const p of (props ?? []) as Row[]) if (!propOf.has(s(p.checkpoint_id))) propOf.set(s(p.checkpoint_id), s(p.id)); // newest wins

    const deps = makeSupabaseBackfillDeps(supabase, 'verify-run', { log: (m) => console.log(m) });
    const convCache = new Map<string, Conversation[]>();
    const verdictOf = new Map<string, { verdict: string; reason: string }>();
    const results: Array<{ conv: string; result: VerifierResult }> = [];
    const skipped: string[] = [];

    for (const [convId, rows] of byConv) {
      const cp = cpOf.get(convId);
      const proposalId = cp ? propOf.get(cp) : undefined;
      if (!proposalId) { skipped.push(`${convId}: no pending proposal`); console.log(`[VERIFY] skip ${convId} — no pending proposal`); continue; }
      const clientId = s(rows[0]!.client_id);
      if (!convCache.has(clientId)) convCache.set(clientId, await gatherClientConversations(supabase, clientId));
      const conversation = convCache.get(clientId)!.find((c) => c.id === convId);
      if (!conversation) { skipped.push(`${convId}: conversation not found in the client's history`); console.log(`[VERIFY] skip ${convId} — conversation not in history`); continue; }

      await deps.verify!(conversation, rows.map(rowToEvidence), proposalId);
      const { data: stored, error: rErr } = await supabase.from('geo_pref_proposals').select('verifier, verifier_version, verified_at').eq('id', proposalId).single();
      expect(rErr).toBeNull();
      expect(stored?.verifier_version).toBe('geo-verify/v1');
      const result = stored!.verifier as VerifierResult;
      results.push({ conv: convId, result });
      for (const m of result.mentions ?? []) verdictOf.set(m.evidence_id, { verdict: m.verdict, reason: m.reason });
      console.log(`[VERIFY] ${conversation.channel} ${convId} status=${result.status} overall=${result.overall} model=${result.model ?? '-'} mentions=${rows.length}${result.error ? ` error=${result.error}` : ''}`);
      for (const m of result.missed ?? []) console.log(`[VERIFY]    missed «${m.span}» — ${m.reason}`);
    }

    // ── Join with the human grades ──
    const { data: labels, error: lErr } = await supabase.from('geo_pref_labels').select('subject_ref, value, annotator_id')
      .eq('batch_id', BATCH_ID).eq('field', 'overall.verdict');
    expect(lErr).toBeNull();
    const humanOf = new Map<string, string>();
    for (const l of (labels ?? []) as Row[]) humanOf.set(s(l.subject_ref), s(l.value));
    const annotators = new Set(((labels ?? []) as Row[]).map((l) => s(l.annotator_id)));

    const cell: Record<string, number> = {};
    const bump = (k: string): void => { cell[k] = (cell[k] ?? 0) + 1; };
    const disagreements: string[] = [];
    const unverified: string[] = [];
    for (const r of (evRows ?? []) as Row[]) {
      const id = s(r.id);
      const human = humanOf.get(id) ?? 'ungraded';
      const v = verdictOf.get(id);
      const vcol = !v ? 'no_verdict' : v.verdict === 'right' ? 'right' : 'not_right';
      bump(`${human}|${vcol}`);
      if (!v) { unverified.push(`«${s(r.mention_span)}» human=${human}`); continue; }
      const agree = (human === 'right' && v.verdict === 'right') || (human === 'wrong' && v.verdict !== 'right');
      if (!agree && (human === 'right' || human === 'wrong')) {
        disagreements.push(`«${s(r.mention_span)}» | human=${human} | verifier=${v.verdict} | ${v.reason}`);
      }
    }
    const humans = ['right', 'wrong', 'unsure', 'ungraded'].filter((h) => Object.keys(cell).some((k) => k.startsWith(`${h}|`)));
    console.log('\n[VERIFY] ===== agreement: human grade × verifier =====');
    console.log('[VERIFY] human \\ verifier |  right | not_right | no_verdict');
    for (const h of humans) {
      console.log(`[VERIFY] ${h.padEnd(16)} | ${String(cell[`${h}|right`] ?? 0).padStart(6)} | ${String(cell[`${h}|not_right`] ?? 0).padStart(9)} | ${String(cell[`${h}|no_verdict`] ?? 0).padStart(10)}`);
    }
    const errors = results.filter((r) => r.result.status === 'error').length;
    const overall = results.reduce<Record<string, number>>((a, r) => { a[r.result.overall] = (a[r.result.overall] ?? 0) + 1; return a; }, {});
    console.log(`[VERIFY] conversations verified=${results.length} skipped=${skipped.length} verifier status=error: ${errors} overall=${JSON.stringify(overall)} annotators=${annotators.size}`);
    console.log(`[VERIFY] missed places reported: ${results.reduce((n, r) => n + (r.result.missed?.length ?? 0), 0)}`);
    console.log(`[VERIFY] ===== disagreements (${disagreements.length}) =====`);
    for (const d of disagreements) console.log(`[VERIFY] ${d}`);
    if (unverified.length) {
      console.log(`[VERIFY] ===== mentions with no verifier verdict (${unverified.length}) =====`);
      for (const u of unverified) console.log(`[VERIFY] ${u}`);
    }
    if (skipped.length) for (const k of skipped) console.log(`[VERIFY] skipped ${k}`);

    expect(results.length).toBeGreaterThan(0);
  }, 1_800_000);
});
