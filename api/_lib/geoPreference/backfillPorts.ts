/**
 * Supabase-backed wiring for the review-first backfill runner.
 *
 * This is the ONLY file in the backfill path that touches Postgres. It reuses the
 * EXISTING ability pieces verbatim — `extract` (Stage-A), `runReviewFirst` (the
 * orchestrator), and `createSupabaseResolverDb` (the same resolver the Finder
 * uses) — and adds the three things a run needs on top of them:
 *   1. a dedup-aware {@link ProposalStore} (no second proposal for an already-open
 *      client+checkpoint),
 *   2. server-side history gathering (chats + phone_calls linked to the client),
 *   3. a per-client {@link RunContext} whose gate config forces auto_write OFF.
 *
 * It NEVER contacts a customer and NEVER writes a client record — see the runner.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_GEO_COUNTRY } from '../matchAgent.js';
import { createSupabaseResolverDb } from './resolverDb.js';
import { extract, type Conversation, type ConversationTurn } from './extractor.js';
import { runReviewFirst } from './orchestrator.js';
import type {
  ProposalStore, ProposalInput, ProposalRecord, RunContext,
} from './orchestrator.js';
import type { GateConfig, WriteAction } from './gate.js';
import type { SatUniverse } from './satisfiability.js';
import type { Speaker, Evidence, EvidenceRelation, RelationMemberRef } from './ontology.js';
import type { BackfillDeps, BackfillJob } from './backfillRunner.js';

const randomUuid = (): string => globalThis.crypto.randomUUID();

/**
 * Persist a run's extraction (evidence + relations + one checkpoint) as
 * `origin='model'` rows, so the labeling workflow has real subjects to label and
 * the proposal can link to a checkpoint. Idempotent per client: a re-run replaces
 * the prior model rows for this conversation. Evidence ids are re-minted to fresh
 * uuids and relation member refs of kind 'evidence' are remapped to them, so the
 * persisted graph is self-consistent regardless of what the extractor emitted.
 * NEVER touches a client record.
 */
export async function persistExtraction(
  supabase: SupabaseClient,
  clientId: string,
  evidence: Evidence[],
  relations: EvidenceRelation[],
): Promise<{ checkpointId: string; evidenceIds: string[] }> {
  const conversationId = clientId; // one aggregate conversation per client for a backfill run

  // Idempotency: clear this conversation's prior MODEL rows (never touches gold).
  await supabase.from('geo_pref_evidence').delete().eq('conversation_id', conversationId).eq('origin', 'model');
  await supabase.from('geo_pref_relations').delete().eq('conversation_id', conversationId).eq('origin', 'model');
  await supabase.from('geo_pref_checkpoints').delete().eq('conversation_id', conversationId).eq('origin_tag', 'model');

  const idMap = new Map<string, string>();
  const evRows = evidence.map((e) => {
    const id = randomUuid();
    idMap.set(e.id, id);
    return {
      id, origin: 'model' as const, conversation_id: conversationId, client_id: clientId,
      mention_span: e.mention_span, anchors: e.anchors,
      speaker: e.speaker, preference_holder: e.preference_holder, holder_role: e.holder_role,
      quoted_speaker: e.quoted_speaker, dialogue_act: e.dialogue_act, conditionality: e.conditionality,
      temporal_reference: e.temporal_reference, preference_applicability: e.preference_applicability,
      preference_role: e.preference_role, commitment: e.commitment, hardness_evidence: e.hardness_evidence,
      modality: e.modality, interpretation_confidence: e.interpretation_confidence ?? null,
      source_channel: e.source.channel, source_ref: e.source.ref, source_timestamp: e.source.timestamp,
      extraction_version: e.extraction_version ?? null,
    };
  });
  if (evRows.length) {
    const { error } = await supabase.from('geo_pref_evidence').insert(evRows);
    if (error) throw new Error(`persist evidence failed: ${error.message}`);
  }

  const remap = (r: RelationMemberRef): RelationMemberRef =>
    r.type === 'evidence' ? { type: 'evidence', id: idMap.get(r.id) ?? r.id } : r;
  const relRows = relations.map((r) => ({
    origin: 'model' as const, conversation_id: conversationId, relation: r.relation,
    members: r.members.map(remap), ordering: r.ordering ? r.ordering.map(remap) : null,
    target: r.target ? remap(r.target) : null, source_span: r.source_span,
    explicit_or_inferred: r.explicit_or_inferred, interpretation_confidence: r.interpretation_confidence ?? null,
  }));
  if (relRows.length) {
    const { error } = await supabase.from('geo_pref_relations').insert(relRows);
    if (error) throw new Error(`persist relations failed: ${error.message}`);
  }

  const evidenceIds = evRows.map((r) => r.id);
  const { data: cp, error: cpErr } = await supabase.from('geo_pref_checkpoints').insert({
    conversation_id: conversationId, client_id: clientId, turn_id: 'aggregate',
    as_of_timestamp: new Date().toISOString(), member_message_ids: [],
    expected_processing: 'evaluate_now', evidence_visible_so_far: evidenceIds,
    lifecycle_by_mention: {}, origin_tag: 'model',
  }).select('id').single();
  if (cpErr) throw new Error(`persist checkpoint failed: ${cpErr.message}`);
  return { checkpointId: cp!.id as string, evidenceIds };
}

// Bounds so a very chatty client can't blow the extractor's token budget.
const MAX_MESSAGES_PER_CHAT = 120;
const MAX_CALLS = 30;
const MAX_TURNS = 300;

const asStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

async function modelId(supabase: SupabaseClient, name: string): Promise<string | null> {
  const { data } = await supabase.from('models').select('id').eq('name', name).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** Records of a model whose `client_link` (scalar OR first array element) = clientId. */
async function linkedRecords(
  supabase: SupabaseClient, modelName: string, clientId: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const mId = await modelId(supabase, modelName);
  if (!mId) return [];
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, data')
    .eq('model_id', mId)
    .or(`data->>client_link.eq.${clientId},data->client_link->>0.eq.${clientId}`)
    .limit(500);
  if (error || !data) return [];
  return data as Array<{ id: string; data: Record<string, unknown> }>;
}

/** A finished call's transcript → speaker-labelled turns. Falls back to one
 *  'unknown' turn for an unlabelled blob (the extractor tolerates that). */
function transcriptToTurns(text: string, timestamp: string): ConversationTurn[] {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const out: ConversationTurn[] = [];
  for (const line of lines) {
    let speaker: Speaker = 'unknown';
    let body = line;
    const m = /^(العميل|الزبون|المتصل|customer|client|المندوب|الموظف|agent|rep)\s*[:：-]\s*(.*)$/i.exec(line);
    if (m) {
      const label = m[1]!.toLowerCase();
      speaker = /العميل|الزبون|المتصل|customer|client/.test(label) ? 'client' : 'agent';
      body = m[2]!.trim();
    }
    if (body) out.push({ speaker, text: body, timestamp });
  }
  return out;
}

/**
 * Gather a client's chat + call history into ONE conversation (rendered
 * chat-like), chronologically ordered and bounded. Returns null when there is
 * nothing to interpret.
 */
export async function gatherClientConversation(
  supabase: SupabaseClient, clientId: string,
): Promise<Conversation | null> {
  const turns: ConversationTurn[] = [];

  // ── WhatsApp: the client's linked chats → their messages ──
  const chatRecs = await linkedRecords(supabase, 'chats', clientId);
  const wids = Array.from(new Set(chatRecs.map((r) => asStr(r.data.wid)).filter(Boolean)));
  for (const wid of wids) {
    const { data: msgs, error } = await supabase
      .from('chat_messages')
      .select('flow, body, date')
      .eq('chat_wid', wid)
      .order('date', { ascending: true })
      .limit(MAX_MESSAGES_PER_CHAT);
    if (error || !msgs) continue;
    for (const m of msgs as Array<{ flow: string | null; body: string | null; date: string | null }>) {
      const body = asStr(m.body);
      if (!body) continue;
      turns.push({
        speaker: m.flow === 'in' ? 'client' : 'agent',
        text: body,
        timestamp: asStr(m.date),
      });
    }
  }

  // ── Calls: the client's phone_calls transcripts ──
  const callRecs = await linkedRecords(supabase, 'phone_calls', clientId);
  const calls = callRecs
    .map((r) => ({
      ts: asStr(r.data.call_time) || asStr(r.data.creation_time) || '',
      text: asStr(r.data.transcription_text),
    }))
    .filter((c) => c.text)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(0, MAX_CALLS);
  for (const c of calls) {
    for (const t of transcriptToTurns(c.text, c.ts)) turns.push(t);
  }

  if (turns.length === 0) return null;

  // Chronological across both channels; blank timestamps sort first (stable).
  turns.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  const bounded = turns.slice(0, MAX_TURNS);
  return { channel: 'chat', id: `client:${clientId}`, turns: bounded };
}

/** The gate config row → {@link GateConfig}, with auto_write FORCED off. The
 *  backfill only ever produces review-first proposals, never a direct write. */
export async function loadGateConfig(supabase: SupabaseClient): Promise<GateConfig> {
  const { data } = await supabase
    .from('geo_pref_gate_config')
    .select('t_lexical_margin, t_geo_margin, t_source_quality, min_action_assurance')
    .eq('id', true)
    .maybeSingle();
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const raw = (data?.min_action_assurance ?? {}) as Record<string, unknown>;
  const assurance: Partial<Record<WriteAction, number>> = {};
  for (const k of ['write_soft', 'write_hard', 'supersede'] as WriteAction[]) {
    if (typeof raw[k] === 'number') assurance[k] = raw[k] as number;
  }
  return {
    auto_write_enabled: false, // hard OFF — backfill never auto-writes
    t_lexical_margin: num(data?.t_lexical_margin, 0.9),
    t_geo_margin: num(data?.t_geo_margin, 0.9),
    t_source_quality: num(data?.t_source_quality, 0.9),
    min_action_assurance: Object.keys(assurance).length
      ? assurance
      : { write_soft: 0.9, write_hard: 0.98, supersede: 0.99 },
  };
}

/** Satisfiability is computed by runReviewFirst but does not gate the decision
 *  and is not persisted, so a trivial universe is correct here (and cheap). */
const INERT_UNIVERSE: SatUniverse = {
  universe: [],
  cellsOf: () => [],
  inventoryIn: () => 0,
};

/**
 * Dedup-aware proposal store: before inserting, it checks for an already-open
 * (`status='pending'`) proposal for the same (client, checkpoint) and returns
 * that instead — so a re-run never creates a duplicate proposal.
 */
export function createSupabaseProposalStore(supabase: SupabaseClient): ProposalStore {
  return {
    async createProposal(input: ProposalInput): Promise<ProposalRecord> {
      let q = supabase
        .from('geo_pref_proposals')
        .select('id, client_id, checkpoint_id, proposed_action, proposed_expression, gate_signals, status')
        .eq('client_id', input.client_id)
        .eq('status', 'pending');
      q = input.checkpoint_id == null ? q.is('checkpoint_id', null) : q.eq('checkpoint_id', input.checkpoint_id);
      const { data: existing } = await q.limit(1).maybeSingle();
      if (existing) {
        return {
          id: existing.id as string,
          client_id: existing.client_id as string,
          checkpoint_id: (existing.checkpoint_id as string | null) ?? null,
          proposed_action: existing.proposed_action as ProposalRecord['proposed_action'],
          proposed_expression: existing.proposed_expression as ProposalRecord['proposed_expression'],
          gate_signals: (existing.gate_signals ?? input.gate_signals) as ProposalRecord['gate_signals'],
          status: 'pending',
        };
      }
      const { data: inserted, error } = await supabase
        .from('geo_pref_proposals')
        .insert({
          client_id: input.client_id,
          checkpoint_id: input.checkpoint_id,
          proposed_action: input.proposed_action,
          proposed_expression: input.proposed_expression,
          gate_signals: input.gate_signals,
          status: 'pending',
        })
        .select('id, client_id, checkpoint_id, proposed_action, proposed_expression, gate_signals, status')
        .single();
      if (error || !inserted) {
        throw new Error(`geo_pref_proposals insert failed: ${error?.message ?? 'unknown'}`);
      }
      return {
        id: inserted.id as string,
        client_id: inserted.client_id as string,
        checkpoint_id: (inserted.checkpoint_id as string | null) ?? null,
        proposed_action: inserted.proposed_action as ProposalRecord['proposed_action'],
        proposed_expression: inserted.proposed_expression as ProposalRecord['proposed_expression'],
        gate_signals: (inserted.gate_signals ?? input.gate_signals) as ProposalRecord['gate_signals'],
        status: 'pending',
      };
    },
  };
}

/** Assemble the full {@link BackfillDeps} against a service-role Supabase client. */
export function makeSupabaseBackfillDeps(
  supabase: SupabaseClient,
  workerId: string,
  opts: { maxAttempts?: number; log?: (msg: string) => void } = {},
): BackfillDeps {
  const maxAttempts = opts.maxAttempts ?? 3;
  const resolverDb = createSupabaseResolverDb(supabase);
  const proposals = createSupabaseProposalStore(supabase);

  return {
    async claimNext(runId: string): Promise<BackfillJob | null> {
      const { data, error } = await supabase.rpc('geo_pref_backfill_claim_next', {
        p_worker_id: workerId,
        p_run_id: runId,
        p_max_attempts: maxAttempts,
      });
      if (error) throw new Error(`geo_pref_backfill_claim_next failed: ${error.message}`);
      const rows = (data ?? []) as Array<{ job_id: string; run_id: string; client_id: string; attempts: number }>;
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return { jobId: r.job_id, runId: r.run_id, clientId: r.client_id, attempts: r.attempts };
    },
    async completeJob(jobId: string): Promise<void> {
      const { error } = await supabase.rpc('geo_pref_backfill_complete', { p_job_id: jobId });
      if (error) throw new Error(`geo_pref_backfill_complete failed: ${error.message}`);
    },
    async failJob(jobId: string, err: string): Promise<void> {
      const { error } = await supabase.rpc('geo_pref_backfill_fail', { p_job_id: jobId, p_error: err.slice(0, 1000) });
      if (error) throw new Error(`geo_pref_backfill_fail failed: ${error.message}`);
    },
    gatherConversation: (clientId: string) => gatherClientConversation(supabase, clientId),
    extract,
    async buildRunContext(clientId: string, evidenceCount: number): Promise<RunContext> {
      const config = await loadGateConfig(supabase);
      return {
        client_id: clientId,
        checkpoint_id: null,
        // Nothing to propose for an empty extraction ⇒ 'ignore' (gate → no
        // proposal). Any active evidence ⇒ 'propose' (gate → 'confirm', a
        // review-first pending proposal, since auto_write is off).
        maximum_safe_action: evidenceCount > 0 ? 'propose' : 'ignore',
        resolution: { db: resolverDb, preferCountry: DEFAULT_GEO_COUNTRY },
        universe: INERT_UNIVERSE,
        config,
      };
    },
    runReviewFirst,
    proposals,
    persistExtraction: (clientId, evidence, relations) => persistExtraction(supabase, clientId, evidence, relations),
    log: opts.log,
  };
}
