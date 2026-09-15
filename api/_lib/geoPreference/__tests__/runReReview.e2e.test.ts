import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { makeSupabaseBackfillDeps } from '../backfillPorts.js';
import type { Evidence, EvidenceRelation } from '../ontology.js';

/**
 * OPERATIONAL re-review (RUN_REREVIEW=1 CALIB_BATCH_ID=<batch>). Re-runs ONLY the
 * review-first step (resolve → compile → gate → proposal) over the evidence a
 * batch already holds — no extraction, no LLM, evidence + checkpoint ids kept,
 * so grades already entered on the batch survive. Use it after a resolver /
 * compiler / orchestrator change. Purge the clients' `pending` proposals first
 * (the store dedups per client+checkpoint and would otherwise return the old
 * row). auto_write stays false; nothing writes a client record.
 */

try {
  const env = readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch { /* env optional */ }

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_ID = process.env.CALIB_BATCH_ID?.trim() || '';

let supabase: SupabaseClient;
beforeAll(() => { if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } }); });

type Row = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

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
    interpretation_confidence: typeof r.interpretation_confidence === 'number' ? r.interpretation_confidence : undefined,
    source: { channel: (s(r.source_channel) === 'call' ? 'call' : 'chat'), ref: s(r.source_ref), timestamp: s(r.source_timestamp) },
    extraction_version: s(r.extraction_version) || undefined,
  };
}
function rowToRelation(r: Row): EvidenceRelation {
  return {
    id: s(r.id),
    relation: s(r.relation) as EvidenceRelation['relation'],
    members: Array.isArray(r.members) ? (r.members as EvidenceRelation['members']) : [],
    ...(Array.isArray(r.ordering) && r.ordering.length ? { ordering: r.ordering as EvidenceRelation['ordering'] } : {}),
    ...(r.target && typeof r.target === 'object' ? { target: r.target as EvidenceRelation['target'] } : {}),
    source_span: s(r.source_span),
    explicit_or_inferred: s(r.explicit_or_inferred) === 'inferred' ? 'inferred' : 'explicit',
    interpretation_confidence: typeof r.interpretation_confidence === 'number' ? r.interpretation_confidence : undefined,
  };
}

describe.skipIf(!process.env.RUN_REREVIEW || !URL_ || !KEY || !BATCH_ID)('RE-REVIEW a batch (no extraction; evidence ids kept)', () => {
  it('rebuilds one pending proposal per conversation from the stored evidence', async () => {
    const { data: batch } = await supabase.from('geo_pref_calibration_batch').select('id, subjects').eq('id', BATCH_ID).single();
    const evIds = ((batch?.subjects ?? []) as Array<{ subject_kind: string; subject_ref: string }>).filter((x) => x.subject_kind === 'evidence').map((x) => x.subject_ref);
    expect(evIds.length).toBeGreaterThan(0);

    const { data: evRows, error: evErr } = await supabase.from('geo_pref_evidence').select('*').in('id', evIds);
    expect(evErr).toBeNull();
    const byConv = new Map<string, Row[]>();
    for (const r of (evRows ?? []) as Row[]) {
      const k = s(r.conversation_id);
      byConv.set(k, [...(byConv.get(k) ?? []), r]);
    }
    const convIds = [...byConv.keys()];
    const { data: relRows } = await supabase.from('geo_pref_relations').select('*').in('conversation_id', convIds).eq('origin', 'model');
    const { data: cpRows } = await supabase.from('geo_pref_checkpoints').select('id, conversation_id').in('conversation_id', convIds).eq('origin_tag', 'model');
    const cpOf = new Map<string, string>((cpRows ?? []).map((c) => [s((c as Row).conversation_id), s((c as Row).id)]));

    const deps = makeSupabaseBackfillDeps(supabase, 'rereview', { log: (m) => console.log(m) });
    let proposals = 0;
    const decisions: Record<string, number> = {};
    for (const [conv, rows] of byConv) {
      const evidence = rows.map(rowToEvidence);
      const relations = ((relRows ?? []) as Row[]).filter((r) => s(r.conversation_id) === conv).map(rowToRelation);
      const clientId = s(rows[0]!.client_id);
      const ctx = await deps.buildRunContext(clientId, evidence.length);
      ctx.checkpoint_id = cpOf.get(conv) ?? null;
      const result = await deps.runReviewFirst(evidence, relations, ctx, { proposals: deps.proposals });
      decisions[result.decision] = (decisions[result.decision] ?? 0) + 1;
      if (result.proposal) proposals += 1;
      console.log(`[REREVIEW] ${conv} decision=${result.decision} evidence=${evidence.length} proposal=${result.proposal?.id ?? 'none'}`);
    }
    console.log('[REREVIEW] conversations:', convIds.length, 'proposals:', proposals, 'decisions:', JSON.stringify(decisions));
    expect(proposals).toBeGreaterThan(0);
  }, 900000);
});
