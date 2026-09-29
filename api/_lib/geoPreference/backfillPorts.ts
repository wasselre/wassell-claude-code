/**
 * Supabase-backed wiring for the review-first backfill runner.
 *
 * This is the ONLY file in the backfill path that touches Postgres. It reuses the
 * EXISTING ability pieces verbatim — `extract` (Stage-A), `runReviewFirst` (the
 * orchestrator), and `createSupabaseResolverDb` (the same resolver the Finder
 * uses) — and adds the three things a run needs on top of them:
 *   1. a dedup-aware {@link ProposalStore} (no second proposal for an already-open
 *      client+checkpoint),
 *   2. server-side history gathering — ONE conversation per call and per chat
 *      thread (never merged; see gatherClientConversations),
 *   3. a per-client {@link RunContext} whose gate config forces auto_write OFF.
 *
 * It NEVER contacts a customer and NEVER writes a client record — see the runner.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_GEO_COUNTRY } from '../matchAgent.js';
import { createSupabaseResolverDb } from './resolverDb.js';
import { extract, type Conversation, type ConversationTurn } from './extractor.js';
import { deriveProjectHeads } from './projectGuard.js';
import { hatifWordsToTurns, isoUtc } from './hatifDialogue.js';
import { runReviewFirst } from './orchestrator.js';
import type {
  ProposalStore, ProposalInput, ProposalRecord, RunContext,
} from './orchestrator.js';
import type { GateConfig, WriteAction } from './gate.js';
import type { SatUniverse } from './satisfiability.js';
import type { Speaker, Evidence, EvidenceRelation, RelationMemberRef, GeoPreference, GeometryRecipe } from './ontology.js';
import type { BackfillDeps, BackfillJob } from './backfillRunner.js';
import { placementsByEvidence, placementElementIds, verifierMentionsFor, type PlaceName } from './placementText.js';
import { verifyConversationMap, VERIFIER_VERSION, type VerifierResult } from './verifier.js';

const randomUuid = (): string => globalThis.crypto.randomUUID();

/**
 * Persist ONE conversation's extraction (evidence + relations + one checkpoint)
 * as `origin='model'` rows, so the labeling workflow has real subjects to label
 * and the proposal can link to a checkpoint. `conversation_id` is the REAL source
 * conversation — the phone_calls record id or the chat_wid — never the client
 * (that was the 2026-09-13 provenance bug: every mention stamped `chat` +
 * `client:<id>`). Idempotent per conversation: a re-run replaces the prior model
 * rows for THIS conversation only. Evidence ids are re-minted to fresh uuids and
 * relation member refs of kind 'evidence' are remapped to them, so the persisted
 * graph is self-consistent regardless of what the extractor emitted.
 * NEVER touches a client record.
 */
export async function persistExtraction(
  supabase: SupabaseClient,
  clientId: string,
  conversation: Conversation,
  evidence: Evidence[],
  relations: EvidenceRelation[],
): Promise<{ checkpointId: string; evidenceIds: string[]; idMap: Record<string, string> }> {
  const conversationId = conversation.id;
  if (!conversationId) throw new Error('persistExtraction: conversation has no id (expected a phone_calls id or chat_wid)');

  // Idempotency: clear this conversation's prior MODEL rows (never touches gold).
  for (const [table, col] of [['geo_pref_evidence', 'origin'], ['geo_pref_relations', 'origin'], ['geo_pref_checkpoints', 'origin_tag']] as const) {
    const { error } = await supabase.from(table).delete().eq('conversation_id', conversationId).eq(col, 'model');
    if (error) throw new Error(`persist: clearing prior ${table} rows failed: ${error.message}`);
  }

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
      // Per-mention provenance: the conversation's channel + the turn's ref/timestamp
      // (attributed by the extractor). For a call the ref IS the phone_calls id.
      source_channel: e.source.channel, source_ref: e.source.ref, source_timestamp: e.source.timestamp || null,
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

  // One checkpoint per conversation, dated by the conversation's LAST turn so
  // versioning's "newer evidence supersedes" compares real conversation times,
  // not the wall clock of the backfill.
  const stamps = conversation.turns.map((t) => t.timestamp ?? '').filter(Boolean).sort();
  const asOf = stamps.length ? new Date(stamps[stamps.length - 1]!) : new Date();
  const memberIds = Array.from(new Set(conversation.turns.map((t) => t.ref ?? '').filter(Boolean)));
  const evidenceIds = evRows.map((r) => r.id);
  const { data: cp, error: cpErr } = await supabase.from('geo_pref_checkpoints').insert({
    conversation_id: conversationId, client_id: clientId, turn_id: 'aggregate',
    as_of_timestamp: (Number.isNaN(asOf.getTime()) ? new Date() : asOf).toISOString(),
    member_message_ids: memberIds,
    expected_processing: 'evaluate_now', evidence_visible_so_far: evidenceIds,
    lifecycle_by_mention: {}, origin_tag: 'model',
  }).select('id').single();
  if (cpErr) throw new Error(`persist checkpoint failed: ${cpErr.message}`);
  return { checkpointId: cp!.id as string, evidenceIds, idMap: Object.fromEntries(idMap) };
}

/** Organisational default universe: Wassel sells in Riyadh, so a bare district
 *  name («النرجس» — 6 namesakes across the Kingdom) resolves against Riyadh
 *  unless the client record says otherwise. */
export const DEFAULT_ESTABLISHED_CITY = 'الرياض';

/**
 * The client's established city for the resolver: the ONE city in their
 * `location` cascade (`data.location.city` — a `cities` record uuid, resolved to
 * its Arabic name) when exactly one is set, else the organisational default.
 * Without this every namesake district was needs_confirm (margin 0) and no
 * proposal ever carried a real district id. (The old free-text city field was
 * retired 2026-09-27; its values were migrated into `location.city`.)
 */
export async function clientEstablishedCity(
  supabase: SupabaseClient, clientId: string,
): Promise<{ city: string; universe: 'explicit' | 'organizational_default' }> {
  const { data, error } = await supabase.from('unified_records').select('data').eq('id', clientId).maybeSingle();
  if (error) throw new Error(`gather: client read for established city failed: ${error.message}`);
  const loc = (data?.data as Record<string, unknown> | null)?.location;
  const cityIds = loc && typeof loc === 'object' && !Array.isArray(loc)
    ? (Array.isArray((loc as Record<string, unknown>).city)
      ? ((loc as Record<string, unknown>).city as unknown[])
      : [(loc as Record<string, unknown>).city]
    ).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
  if (cityIds.length === 1) {
    const { data: cityRow, error: cityErr } = await supabase
      .from('unified_records').select('data').eq('id', cityIds[0]!).maybeSingle();
    if (cityErr) throw new Error(`gather: city read for established city failed: ${cityErr.message}`);
    const cd = (cityRow?.data as Record<string, unknown> | null) ?? null;
    const name = asStr(cd?.name_ar) || asStr(cd?.display_name);
    if (name) return { city: name, universe: 'explicit' };
  }
  return { city: DEFAULT_ESTABLISHED_CITY, universe: 'organizational_default' };
}

// Bounds so a very chatty client can't blow the extractor's token budget.
const MAX_MESSAGES_PER_CHAT = 120;
const MAX_CALLS = 30;
const MAX_TURNS_PER_CONVERSATION = 300;

const asStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

async function modelId(supabase: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await supabase.from('models').select('id').eq('name', name).maybeSingle();
  if (error) throw new Error(`gather: models lookup for ${name} failed: ${error.message}`);
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
  // Loud, not silent: a failed read must fail the job (it retries), never
  // masquerade as "this client has no history".
  if (error) throw new Error(`gather: ${modelName} read failed: ${error.message}`);
  return (data ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
}

/** A finished call's transcript → turns. Real transcripts are ONE unlabelled
 *  line (no speaker labels, no newlines), which yields exactly ONE 'unknown'
 *  turn — so a call's provenance is the call itself. Labelled/multi-line
 *  transcripts (if a provider ever adds diarization) split per line. Every
 *  turn carries the phone_calls record id as its ref. */
function transcriptToTurns(text: string, timestamp: string, callRecordId: string): ConversationTurn[] {
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
    if (body) out.push({ speaker, text: body, timestamp, ref: callRecordId });
  }
  return out;
}

/** The customer-line prefix for a transcribed inbound voice note (the prefs prompt names it too). */
export const VOICE_NOTE_PREFIX = '(رسالة صوتية)';

/**
 * ONE WhatsApp thread → a chat {@link Conversation}, or null when the customer
 * never wrote in it (agent-only broadcast — nothing to interpret).
 *
 * The NEWEST {@link MAX_MESSAGES_PER_CHAT} messages are read (ordered
 * descending, limited, then put back in chronological order): an ascending
 * `.limit()` keeps the OLDEST ones, so on a long chat the customer's latest
 * messages — the ones a fresh reading exists for — were never seen.
 *
 * An inbound voice note with a transcript (chat_messages.transcript, filled by
 * the inbound-media worker) is a customer text line «(رسالة صوتية) <text>».
 * A read error THROWS — never "this chat is empty".
 */
export async function gatherChatConversation(supabase: SupabaseClient, wid: string): Promise<Conversation | null> {
  const { data: msgs, error } = await supabase
    .from('chat_messages')
    .select('id, flow, kind, body, transcript, date')
    .eq('chat_wid', wid)
    .order('date', { ascending: false })
    .limit(MAX_MESSAGES_PER_CHAT);
  if (error) throw new Error(`gather: chat_messages read for ${wid} failed: ${error.message}`);
  const rows = [...((msgs ?? []) as Array<{
    id: string; flow: string | null; kind: string | null; body: string | null; transcript: string | null; date: string | null;
  }>)].reverse();
  const turns: ConversationTurn[] = [];
  for (const m of rows) {
    const speaker: Speaker = m.flow === 'in' ? 'client' : 'agent';
    const body = asStr(m.body);
    if (body) {
      turns.push({ speaker, text: body, timestamp: asStr(m.date), ref: m.id });
      continue;
    }
    const transcript = asStr(m.transcript);
    if (m.flow === 'in' && m.kind === 'audio' && transcript) {
      turns.push({ speaker: 'client', text: `${VOICE_NOTE_PREFIX} ${transcript}`, timestamp: asStr(m.date), ref: m.id });
    }
  }
  if (!turns.some((t) => t.speaker === 'client')) return null; // agent-only thread — nothing to interpret
  return { channel: 'chat', id: wid, turns: turns.slice(0, MAX_TURNS_PER_CONVERSATION) };
}

/**
 * Gather a client's history as SEPARATE conversations — one per phone call and
 * one per WhatsApp thread — each on its own channel with its real id, ordered
 * oldest-first. NEVER merged: a call and a chat are extracted + reviewed apart.
 * Calls are built from Hatif's DIARIZED words in call_logs (speaker-labelled
 * turns, agent decided by hatifDialogue.ts) and fall back to the flattened
 * transcription_text — unlabelled — only when no diarized words exist; a chat
 * has `flow` per message, so the speaker is a fact. Returns [] when there is
 * nothing to interpret.
 *
 * Chat threads where the customer never wrote (agent-only broadcasts, 14 of the
 * 20 calibration threads) are skipped: the extractor only records CLIENT
 * mentions, so such a thread can only cost an LLM call and yield nothing.
 */
export async function gatherClientConversations(
  supabase: SupabaseClient, clientId: string,
): Promise<Conversation[]> {
  const out: Conversation[] = [];

  // ── WhatsApp: the client's linked chats → one conversation per thread ──
  const chatRecs = await linkedRecords(supabase, 'chats', clientId);
  const wids = Array.from(new Set(chatRecs.map((r) => asStr(r.data.wid)).filter(Boolean)));
  for (const wid of wids) {
    const conversation = await gatherChatConversation(supabase, wid);
    if (conversation) out.push(conversation);
  }

  // ── Calls: one conversation per phone_calls transcript ──
  const callRecs = await linkedRecords(supabase, 'phone_calls', clientId);
  // call_time is UTC without a zone suffix — normalise (isoUtc) or a Riyadh
  // machine reads it 3 h early (measured 2026-09-13).
  const calls = callRecs
    .map((r) => ({
      id: r.id,
      ts: isoUtc(asStr(r.data.call_time) || asStr(r.data.creation_time)) ?? '',
      text: asStr(r.data.transcription_text),
      direction: asStr(r.data.direction) || null,
    }))
    .filter((c) => c.text)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(0, MAX_CALLS);

  // Hatif's DIARIZED transcript lives in call_logs.transcription (same id as the
  // phone_calls record). It gives speaker-labelled turns; the flattened
  // transcription_text is the fallback when a call has no diarized words.
  const logs = new Map<string, { direction: string | null; transcription: unknown; creation_time: string | null }>();
  if (calls.length) {
    const { data, error } = await supabase
      .from('call_logs')
      .select('id, direction, transcription, creation_time')
      .in('id', calls.map((c) => c.id));
    if (error) throw new Error(`gather: call_logs read failed: ${error.message}`);
    for (const l of (data ?? []) as Array<{ id: string; direction: string | null; transcription: unknown; creation_time: string | null }>) {
      logs.set(l.id, { direction: l.direction, transcription: l.transcription, creation_time: l.creation_time });
    }
  }
  for (const c of calls) {
    const conversation = buildCallConversation(c, logs.get(c.id) ?? null);
    if (conversation) out.push(conversation);
  }

  // Oldest conversation first (by its first timestamp; blanks sort first, stable).
  const firstTs = (c: Conversation): string => c.turns.find((t) => t.timestamp)?.timestamp ?? '';
  return out.sort((a, b) => firstTs(a).localeCompare(firstTs(b)));
}

/** The phone_calls record's parts a call conversation is built from. */
export interface CallRecordParts {
  id: string;
  /** call_time (normalised UTC ISO) or '' */
  ts: string;
  /** Hatif's flattened transcription_text ('' when none). */
  text: string;
  direction: string | null;
}

/** The call_logs row's parts (same id as the phone_calls record). */
export interface CallLogParts {
  direction: string | null;
  transcription: unknown;
  creation_time: string | null;
}

/**
 * PURE: ONE call → a call {@link Conversation}, or null when there is nothing
 * to read. Hatif's DIARIZED words (call_logs.transcription) win — speaker
 * labelled, agent decided by hatifDialogue.ts; the flattened
 * transcription_text is the fallback and is UNLABELLED (`speaker_labels:
 * 'none'`). Shared by {@link gatherClientConversations} and
 * {@link gatherCallConversation} so the diarization path exists once.
 */
export function buildCallConversation(call: CallRecordParts, log: CallLogParts | null): Conversation | null {
  // call_logs.creation_time is a real timestamptz — prefer it as the time base.
  const callTime = (log && isoUtc(log.creation_time)) || call.ts || null;
  const dialogue = log ? hatifWordsToTurns(log.transcription, { direction: log.direction ?? call.direction, ref: call.id, callTimeIso: callTime }) : null;
  if (dialogue) {
    return { channel: 'call', id: call.id, speaker_labels: dialogue.labelSource, turns: dialogue.turns.slice(0, MAX_TURNS_PER_CONVERSATION) };
  }
  const turns = transcriptToTurns(call.text, call.ts, call.id).slice(0, MAX_TURNS_PER_CONVERSATION);
  if (turns.length === 0) return null;
  return { channel: 'call', id: call.id, speaker_labels: 'none', turns };
}

/**
 * ONE call by id → its {@link Conversation} (see {@link buildCallConversation}),
 * or null when neither the phone_calls record nor the call_logs row carries a
 * readable transcript. Reads the phone_calls record (via unified_records, the
 * same read gatherClientConversations does) and the call_logs row in parallel.
 * A read error THROWS — never "this call is empty".
 */
export async function gatherCallConversation(supabase: SupabaseClient, callId: string): Promise<Conversation | null> {
  const mId = await modelId(supabase, 'phone_calls');
  const [recRes, logRes] = await Promise.all([
    mId
      ? supabase.from('unified_records').select('id, data').eq('id', callId).eq('model_id', mId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from('call_logs').select('id, direction, transcription, creation_time').eq('id', callId).maybeSingle(),
  ]);
  if (recRes.error) throw new Error(`gather: phone_calls read for ${callId} failed: ${recRes.error.message}`);
  if (logRes.error) throw new Error(`gather: call_logs read for ${callId} failed: ${logRes.error.message}`);
  const data = ((recRes.data as { data?: Record<string, unknown> } | null)?.data) ?? {};
  const call: CallRecordParts = {
    id: callId,
    ts: isoUtc(asStr(data.call_time) || asStr(data.creation_time)) ?? '',
    text: asStr(data.transcription_text),
    direction: asStr(data.direction) || null,
  };
  const l = logRes.data as { direction: string | null; transcription: unknown; creation_time: string | null } | null;
  const log: CallLogParts | null = l ? { direction: l.direction, transcription: l.transcription, creation_time: l.creation_time } : null;
  return buildCallConversation(call, log);
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

interface ClipPart { district_id: string; name: string; name_en: string; crossed: boolean; kept: boolean; kept_km2: number | null; total_km2: number | null; geojson: { type: string; coordinates: unknown } | null }

/**
 * Fill `clip_geojson` / `clip_parts` on every district_side_clip recipe of an
 * expression by calling wassell_districts_side_of_road (PostGIS: split each
 * district by the road, keep the pieces on the requested side). Mutates the
 * given expression. A failure throws — a proposal must never be stored with a
 * silently missing shape (the reviewer would see districts the customer did
 * not ask for).
 */
export async function hydrateClipGeometry(supabase: SupabaseClient, expression: GeoPreference): Promise<number> {
  let n = 0;
  for (const g of expression.groups ?? []) {
    for (const c of g.clauses ?? []) {
      for (const ref of c.anyOf ?? []) {
        const r: GeometryRecipe | undefined = ref.recipe;
        if (!r || r.operation !== 'district_side_clip' || r.clip_geojson) continue;
        const road = r.resolved_element_ids[r.resolved_element_ids.length - 1];
        const districts = r.resolved_element_ids.slice(0, -1);
        if (!road || !r.side || districts.length === 0) continue;
        const { data, error } = await supabase.rpc('wassell_districts_side_of_road', { p_district_ids: districts, p_road_external_id: road, p_side: r.side });
        if (error) throw new Error(`districts_side_of_road failed: ${error.message}`);
        if (data == null) throw new Error(`districts_side_of_road refused road=${road} side=${r.side}`);
        const parts = (Array.isArray(data) ? data : []) as ClipPart[];
        const polys: unknown[] = [];
        for (const p of parts) {
          if (!p.kept || !p.geojson) continue;
          if (p.geojson.type === 'MultiPolygon') polys.push(...(p.geojson.coordinates as unknown[]));
          else if (p.geojson.type === 'Polygon') polys.push(p.geojson.coordinates);
        }
        r.clip_geojson = { type: 'MultiPolygon', coordinates: polys };
        r.clip_parts = parts.map((p) => ({ district_id: p.district_id, name: p.name, crossed: p.crossed, kept: p.kept, kept_km2: p.kept_km2, total_km2: p.total_km2 }));
        n += 1;
      }
    }
  }
  return n;
}

/**
 * Dedup-aware proposal store: before inserting, it checks for an already-open
 * (`status='pending'`) proposal for the same (client, checkpoint) and returns
 * that instead — so a re-run never creates a duplicate proposal. Clip recipes
 * get their shapes here (hydrateClipGeometry) before the row is written.
 */
export function createSupabaseProposalStore(supabase: SupabaseClient): ProposalStore {
  return {
    async createProposal(input: ProposalInput): Promise<ProposalRecord> {
      await hydrateClipGeometry(supabase, input.proposed_expression);
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
          source_evidence_ids: input.source_evidence_ids ?? [],
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

/**
 * Arabic names for a placement's element ids — the SAME lookups the grader does
 * (simple-grade.ts): uuids → `districts` (name + city), anything else →
 * `geo_elements.external_id` (roads, landmarks). A read failure throws.
 */
export async function loadPlaceNames(
  supabase: SupabaseClient, districtIds: readonly string[], elementIds: readonly string[],
): Promise<Record<string, PlaceName>> {
  const names: Record<string, PlaceName> = {};
  if (districtIds.length) {
    const { data, error } = await supabase.from('districts').select('id, name_ar, city_name_ar').in('id', [...districtIds]);
    if (error) throw new Error(`districts read failed: ${error.message}`);
    for (const d of (data ?? []) as Array<{ id: string; name_ar: string | null; city_name_ar: string | null }>) {
      names[d.id] = { name_ar: String(d.name_ar ?? ''), city: String(d.city_name_ar ?? '') };
    }
  }
  if (elementIds.length) {
    const { data, error } = await supabase.from('geo_elements').select('external_id, name_ar').in('external_id', [...elementIds]);
    if (error) throw new Error(`geo_elements read failed: ${error.message}`);
    for (const e of (data ?? []) as Array<{ external_id: string; name_ar: string | null }>) {
      names[e.external_id] = { name_ar: String(e.name_ar ?? '') };
    }
  }
  return names;
}

/**
 * ADVISORY verifier port: read the proposal's map, render each mention as an
 * Arabic sentence, ask the verifier (verifier.ts) and store its opinion on the
 * proposal row (`verifier`, `verifier_version`, `verified_at`). Never touches
 * `proposed_expression`, the status, or any client record.
 *
 * Error contract: anything that stops the CHECK (proposal read, name lookup,
 * every LLM provider failing) is stored as `{status:'error', overall:'unknown'}`
 * and logged — the job does not fail over an advisory opinion. A failure to
 * WRITE the row throws: a result that silently never lands is the one failure
 * we refuse.
 */
export async function verifyProposal(
  supabase: SupabaseClient,
  conversation: Conversation,
  evidence: ReadonlyArray<Pick<Evidence, 'id' | 'mention_span' | 'preference_role'>>,
  proposalId: string,
  opts: { projectNames?: () => Promise<string[]>; log?: (msg: string) => void } = {},
): Promise<VerifierResult> {
  let result: VerifierResult;
  try {
    const { data: prop, error } = await supabase.from('geo_pref_proposals').select('proposed_expression').eq('id', proposalId).maybeSingle();
    if (error) throw new Error(`proposal read failed: ${error.message}`);
    if (!prop) throw new Error(`proposal ${proposalId} not found`);
    const expr = prop.proposed_expression as GeoPreference;
    const { districtIds, elementIds } = placementElementIds(placementsByEvidence(expr));
    const names = await loadPlaceNames(supabase, districtIds, elementIds);
    const mentions = verifierMentionsFor(evidence, expr, names);
    const projectNames = opts.projectNames ? await opts.projectNames() : [];
    result = await verifyConversationMap({ conversation, mentions, projectNames });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { status: 'error', overall: 'unknown', mentions: [], missed: [], error: msg };
  }
  if (result.status === 'error') {
    opts.log?.(`[geo-verify] proposal=${proposalId} verifier could not run: ${result.error ?? 'unknown error'}`);
    console.error(`[geo-verify] proposal=${proposalId} verifier could not run:`, result.error);
  }
  const { data: written, error: wErr } = await supabase
    .from('geo_pref_proposals')
    .update({ verifier: result, verifier_version: VERIFIER_VERSION, verified_at: new Date().toISOString() })
    .eq('id', proposalId)
    .select('id');
  if (wErr) throw new Error(`geo_pref_proposals verifier write failed: ${wErr.message}`);
  if (!written || written.length === 0) throw new Error(`geo_pref_proposals verifier write matched no row (id=${proposalId})`);
  return result;
}

/**
 * OUR project names, reduced to guard "heads" (projectGuard.ts): every
 * all_projects name, paged in full (never a silent cap), minus any head that is
 * also a district name. A read failure throws — a backfill that silently ran
 * without the guard would re-create the very defect it exists to stop.
 */
export async function loadProjectHeads(supabase: SupabaseClient): Promise<string[]> {
  const { data: model, error: mErr } = await supabase.from('models').select('id').eq('name', 'all_projects').maybeSingle();
  if (mErr) throw new Error(`project guard: models read failed: ${mErr.message}`);
  if (!model?.id) return [];
  const names: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('unified_records').select('data->>project_name').eq('model_id', model.id as string)
      .order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`project guard: all_projects read failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ project_name: string | null }>) if (r.project_name) names.push(String(r.project_name));
    if (!data || data.length < 1000) break;
  }
  const districts: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('districts').select('name_ar').eq('is_active', true)
      .order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`project guard: districts read failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ name_ar: string | null }>) if (r.name_ar) districts.push(String(r.name_ar));
    if (!data || data.length < 1000) break;
  }
  return deriveProjectHeads(names, districts);
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
  // Loaded once per deps instance, on first use; a failed load is retried on
  // the next call rather than cached as "no projects".
  let headsPromise: Promise<string[]> | null = null;
  const projectHeads = (): Promise<string[]> => {
    if (!headsPromise) {
      headsPromise = loadProjectHeads(supabase).then((h) => {
        opts.log?.(`[geo-backfill] project guard: ${h.length} project heads loaded`);
        return h;
      }).catch((e: unknown) => { headsPromise = null; throw e; });
    }
    return headsPromise;
  };

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
    gatherConversations: (clientId: string) => gatherClientConversations(supabase, clientId),
    extract: async (conversation: Conversation) => extract(conversation, { projectNames: await projectHeads() }),
    async buildRunContext(clientId: string, evidenceCount: number): Promise<RunContext> {
      const config = await loadGateConfig(supabase);
      const established = await clientEstablishedCity(supabase, clientId);
      return {
        client_id: clientId,
        checkpoint_id: null,
        // Nothing to propose for an empty extraction ⇒ 'ignore' (gate → no
        // proposal). Any active evidence ⇒ 'propose' (gate → 'confirm', a
        // review-first pending proposal, since auto_write is off).
        maximum_safe_action: evidenceCount > 0 ? 'propose' : 'ignore',
        resolution: {
          db: resolverDb,
          preferCountry: DEFAULT_GEO_COUNTRY,
          established_city: established.city,
          universe_hint: established.universe,
        },
        universe: INERT_UNIVERSE,
        config,
      };
    },
    runReviewFirst,
    proposals,
    persistExtraction: (clientId, conversation, evidence, relations) =>
      persistExtraction(supabase, clientId, conversation, evidence, relations),
    async verify(conversation, evidence, proposalId): Promise<void> {
      const r = await verifyProposal(supabase, conversation, evidence, proposalId, { projectNames: projectHeads, log: opts.log });
      opts.log?.(`[geo-verify] proposal=${proposalId} status=${r.status} overall=${r.overall} doubts=${r.mentions.filter((m) => m.verdict !== 'right').length} missed=${r.missed.length}`);
    },
    log: opts.log,
  };
}
