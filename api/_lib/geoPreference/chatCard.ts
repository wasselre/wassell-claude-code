/**
 * The geography CONFIRM CARD inside a WhatsApp chat — server core.
 *
 * A rep opens a client-linked chat; the card reads that ONE conversation
 * (the chat's wid is the conversation id the backfill already uses), shows
 * «العميل يريد: … — لا يريد: …», and one tap saves it to the client's
 * location preferences through `/api/geo-preference/review` (the ONLY
 * sanctioned client writer). This module never writes a client record and
 * never sends a message: it reads, and it writes exactly what the backfill
 * writes — evidence / relations / checkpoint (extract mode), a pending
 * proposal, the verifier's opinion, and `superseded` on older pending
 * proposals of THIS conversation.
 *
 *   loadChatCard            — the card's state (throws on any read error; never
 *                             a half-filled card that looks like "nothing here")
 *   analyzeChatConversation — (re)read the conversation, mint a new proposal,
 *                             verify it, return the fresh card
 *   decideAnalyzeMode       — PURE: full extraction vs review-only rerun
 *   computeStale            — PURE: has the customer written since the reading?
 *   pruneExpression         — PURE: drop unticked mentions (→ review `edit`)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation } from './extractor.js';
import type { Evidence, EvidenceRelation, GeoPreference } from './ontology.js';
import type { VerifierResult } from './verifier.js';
import type { BackfillDeps } from './backfillRunner.js';
import { remapExtractionIds } from './backfillRunner.js';
import { makeSupabaseBackfillDeps } from './backfillPorts.js';
import { placementsByEvidence, isUuid, type Placement } from './placementText.js';
import { geoPreferenceToLocationItems } from '../../geo-preference/review.js';
import { pruneGeoExpression } from '../../../src/lib/geo/pruneGeoExpression.js';
import type { LocationItem } from '../../../src/lib/geo/locationItems.js';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/**
 * `none`  — this chat has never been read.
 * `empty` — it was read, and there was nothing to propose (no proposal row).
 * Every other value is the newest proposal's own status.
 */
export type ChatCardStatus =
  | 'none' | 'empty'
  | 'pending' | 'confirmed' | 'edited' | 'rejected' | 'applied' | 'superseded' | 'must_confirm';

export interface ChatCardProposal {
  id: string;
  version: number | null;
  status: string;
  proposed_action: string;
  /** final_expression when a rep edited it, else proposed_expression. */
  expression: GeoPreference;
  by_evidence: Record<string, Placement>;
  /** What a confirm would write (district items with a non-uuid id dropped, as in the grader). */
  items: LocationItem[];
  /** The same items split per mention, so the card's map can show only the ticked lines. */
  items_by_evidence: Record<string, LocationItem[]>;
  /** The advisory verifier's opinion; null = never verified. */
  verifier: VerifierResult | null;
}

export interface ChatCardMention {
  evidence_id: string;
  mention_span: string;
  preference_role: string;
}

export interface PlaceNameInfo { name_ar: string; name_en: string; city: string }

export interface ChatCard {
  status: ChatCardStatus;
  checkpoint_id: string | null;
  proposal: ChatCardProposal | null;
  mentions: ChatCardMention[];
  names: Record<string, PlaceNameInfo>;
  /** When this conversation was last read (checkpoint or newest proposal, whichever is later). */
  analyzed_at: string | null;
  /** The customer has written since the reading. */
  stale: boolean;
  /** This conversation's evidence is graded / in a calibration batch — a re-read
   *  is review-only and cannot pick up new messages (re-extraction would delete
   *  the graded rows). */
  graded: boolean;
  /** false inside the cost/concurrency cool-down after a reading. */
  can_reanalyze: boolean;
  /** How many text messages the CUSTOMER has sent in this chat — lets the card
   *  decide on its own whether the chat is worth reading yet. */
  customer_messages: number;
}

export type AnalyzeMode = 'extract' | 're_review';

export interface AnalyzeOutcome extends ChatCard {
  /** What ran: a full extraction, a review-only rerun, or nothing (cool-down). */
  mode: AnalyzeMode | 'skipped_recent';
}

/** An error with the HTTP status the endpoint should answer with. */
export class ChatCardError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** A conversation read within this window is not read again (cost + double-click guard). */
export const REANALYZE_COOLDOWN_MS = 60_000;

// ────────────────────────────────────────────────────────────────────────────
// PURE logic (unit-tested in __tests__/chatCard.test.ts)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Full extraction or a review-only rerun?
 *
 * `re_review` rebuilds evidence + relations from the stored rows (NO LLM
 * extraction) when the conversation already has a model checkpoint AND either
 * nothing new was said since, or its evidence is graded. **Graded data must
 * never be re-extracted**: persistExtraction deletes this conversation's model
 * evidence + checkpoint, which orphans every label that points at them.
 */
export function decideAnalyzeMode(input: {
  hasCheckpoint: boolean;
  hasNewerMessage: boolean;
  hasProtectedEvidence: boolean;
}): AnalyzeMode {
  if (input.hasCheckpoint && (!input.hasNewerMessage || input.hasProtectedEvidence)) return 're_review';
  return 'extract';
}

/**
 * Has the customer written since the reading? `checkpointCreatedAt` is when the
 * conversation was read; `newestCustomerMessageAt` is the newest INBOUND
 * message's date (null = none). No checkpoint ⇒ not stale (it was never read).
 * An unparseable date is treated as "cannot tell" ⇒ not stale.
 */
export function computeStale(checkpointCreatedAt: string | null, newestCustomerMessageAt: string | null): boolean {
  if (!checkpointCreatedAt || !newestCustomerMessageAt) return false;
  const cp = Date.parse(checkpointCreatedAt);
  const msg = Date.parse(newestCustomerMessageAt);
  if (Number.isNaN(cp) || Number.isNaN(msg)) return false;
  return msg > cp;
}

/** Remove every `geo:<dropped id>` ref; drop emptied clauses and groups. PURE. */
export function pruneExpression(expr: GeoPreference, dropEvidenceIds: string[]): GeoPreference {
  return pruneGeoExpression(expr, dropEvidenceIds);
}

/** The later of two ISO timestamps (either may be null). */
export function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

// ────────────────────────────────────────────────────────────────────────────
// Row → ontology (same mapping as runReReview.e2e.test.ts)
// ────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function rowToEvidence(r: Row): Evidence {
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

export function rowToRelation(r: Row): EvidenceRelation {
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

// ────────────────────────────────────────────────────────────────────────────
// Supabase reads — every error THROWS
// ────────────────────────────────────────────────────────────────────────────

interface CheckpointRow { id: string; created_at: string; evidence_visible_so_far: string[] | null }
interface ProposalDbRow {
  id: string; status: string; version: number | null; proposed_action: string;
  proposed_expression: GeoPreference; final_expression: GeoPreference | null;
  verifier: VerifierResult | null; created_at: string;
}

/** This client's newest MODEL checkpoint for the conversation (null = never read). */
async function readCheckpoint(supabase: SupabaseClient, clientId: string, chatWid: string): Promise<CheckpointRow | null> {
  const { data, error } = await supabase
    .from('geo_pref_checkpoints')
    .select('id, created_at, evidence_visible_so_far')
    .eq('conversation_id', chatWid).eq('client_id', clientId).eq('origin_tag', 'model')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`chat card: checkpoint read failed: ${error.message}`);
  return (data as CheckpointRow | null) ?? null;
}

/** Newest proposal (any status) for the checkpoint. */
async function readNewestProposal(supabase: SupabaseClient, checkpointId: string): Promise<ProposalDbRow | null> {
  const { data, error } = await supabase
    .from('geo_pref_proposals')
    .select('id, status, version, proposed_action, proposed_expression, final_expression, verifier, created_at')
    .eq('checkpoint_id', checkpointId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`chat card: proposal read failed: ${error.message}`);
  return (data as ProposalDbRow | null) ?? null;
}

/** The conversation's model evidence rows (full rows), in checkpoint order. */
async function readEvidenceRows(supabase: SupabaseClient, clientId: string, chatWid: string, cp: CheckpointRow): Promise<Row[]> {
  const { data, error } = await supabase
    .from('geo_pref_evidence')
    .select('*')
    .eq('conversation_id', chatWid).eq('client_id', clientId).eq('origin', 'model')
    .order('source_timestamp', { ascending: true }).order('id', { ascending: true });
  if (error) throw new Error(`chat card: evidence read failed: ${error.message}`);
  const rows = (data ?? []) as Row[];
  // Keep the checkpoint's own order when it lists the ids (it always does for model rows).
  const order = cp.evidence_visible_so_far ?? [];
  if (order.length === 0) return rows;
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (pos.get(s(a.id)) ?? Number.MAX_SAFE_INTEGER) - (pos.get(s(b.id)) ?? Number.MAX_SAFE_INTEGER));
}

/**
 * PostgREST filter: a message with text — a non-empty body OR a voice note's
 * transcript (chat_messages.transcript, filled by the inbound-media worker).
 * A NULL column fails `neq`, so NULLs are excluded without a separate test.
 */
export const CUSTOMER_TEXT_FILTER = 'body.neq."",transcript.neq.""';

/** Number of INBOUND (customer) text messages (incl. transcribed voice notes) in the chat. A read error throws. */
async function readCustomerMessageCount(supabase: SupabaseClient, chatWid: string): Promise<number> {
  const { count, error } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('chat_wid', chatWid).eq('flow', 'in')
    .or(CUSTOMER_TEXT_FILTER);
  if (error) throw new Error(`chat card: chat_messages count failed: ${error.message}`);
  return count ?? 0;
}

/** Date of the newest INBOUND (customer) message with text (or a transcribed voice note); null when none. */
async function readNewestCustomerMessageAt(supabase: SupabaseClient, chatWid: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('date')
    .eq('chat_wid', chatWid).eq('flow', 'in')
    .or(CUSTOMER_TEXT_FILTER)
    .order('date', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`chat card: chat_messages read failed: ${error.message}`);
  return (data?.date as string | null | undefined) ?? null;
}

/**
 * Is any of these subjects (evidence ids + the checkpoint id) graded, or in a
 * calibration batch? Either way re-extraction would destroy it.
 */
async function readIsProtected(supabase: SupabaseClient, subjectIds: string[]): Promise<boolean> {
  if (subjectIds.length === 0) return false;
  const { data: labels, error } = await supabase
    .from('geo_pref_labels').select('id').in('subject_ref', subjectIds).limit(1);
  if (error) throw new Error(`chat card: labels read failed: ${error.message}`);
  if ((labels ?? []).length > 0) return true;
  const wanted = new Set(subjectIds);
  for (let from = 0; ; from += 1000) {
    const { data, error: bErr } = await supabase
      .from('geo_pref_calibration_batch').select('id, subjects')
      .order('id', { ascending: true }).range(from, from + 999);
    if (bErr) throw new Error(`chat card: calibration batch read failed: ${bErr.message}`);
    for (const b of (data ?? []) as Array<{ subjects: unknown }>) {
      for (const sub of Array.isArray(b.subjects) ? b.subjects : []) {
        const ref = (sub as { subject_ref?: unknown })?.subject_ref;
        if (typeof ref === 'string' && wanted.has(ref)) return true;
      }
    }
    if (!data || data.length < 1000) break;
  }
  return false;
}

/** Names for every id a placement / item references (districts + roads/landmarks). */
async function readNames(supabase: SupabaseClient, byEvidence: Record<string, Placement>, items: LocationItem[]): Promise<Record<string, PlaceNameInfo>> {
  const districtIds = new Set<string>();
  const elementIds = new Set<string>();
  for (const li of items) if (li.kind === 'district') districtIds.add(li.district_id);
  for (const pl of Object.values(byEvidence)) {
    if (!pl.resolved) continue; // unresolved ids are bare names, not ids
    for (const id of pl.element_ids) (isUuid(id) ? districtIds : elementIds).add(id);
  }
  const names: Record<string, PlaceNameInfo> = {};
  if (districtIds.size) {
    const { data, error } = await supabase.from('districts').select('id, name_ar, name_en, city_name_ar').in('id', [...districtIds]);
    if (error) throw new Error(`chat card: districts read failed: ${error.message}`);
    for (const d of (data ?? []) as Row[]) names[s(d.id)] = { name_ar: s(d.name_ar), name_en: s(d.name_en), city: s(d.city_name_ar) };
  }
  if (elementIds.size) {
    const { data, error } = await supabase.from('geo_elements').select('external_id, name_ar, name_en').in('external_id', [...elementIds]);
    if (error) throw new Error(`chat card: geo_elements read failed: ${error.message}`);
    for (const e of (data ?? []) as Row[]) names[s(e.external_id)] = { name_ar: s(e.name_ar), name_en: s(e.name_en), city: '' };
  }
  return names;
}

/** Pending proposal ids tied to a checkpoint. */
async function readPendingProposalIds(supabase: SupabaseClient, checkpointId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('geo_pref_proposals').select('id').eq('checkpoint_id', checkpointId).eq('status', 'pending');
  if (error) throw new Error(`chat card: pending proposals read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Mark proposals `superseded` — ONLY while they are still `pending` (the
 * status guard is in the UPDATE, so a proposal a rep resolved a moment ago is
 * never touched). `supersededBy` links them to the new proposal when known.
 */
async function markSuperseded(supabase: SupabaseClient, ids: string[], supersededBy: string | null): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('geo_pref_proposals')
    .update({ status: 'superseded', superseded_by: supersededBy })
    .in('id', ids).eq('status', 'pending');
  if (error) throw new Error(`chat card: superseding older proposals failed: ${error.message}`);
}

/** Link already-superseded proposals to the proposal that replaced them. */
async function linkSuperseded(supabase: SupabaseClient, ids: string[], supersededBy: string): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('geo_pref_proposals').update({ superseded_by: supersededBy })
    .in('id', ids).eq('status', 'superseded');
  if (error) throw new Error(`chat card: linking superseded proposals failed: ${error.message}`);
}

/** Undo {@link markSuperseded} (review-only rerun failed before minting a replacement). */
async function restorePending(supabase: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('geo_pref_proposals').update({ status: 'pending', superseded_by: null })
    .in('id', ids).eq('status', 'superseded');
  if (error) throw new Error(`restoring superseded proposals to pending failed: ${error.message}`);
}

/** Is this chat (by wid) linked to this client? Distinguishes "not yours" from "nothing to read". */
export async function chatLinkedToClient(supabase: SupabaseClient, clientId: string, chatWid: string): Promise<boolean> {
  const { data: model, error: mErr } = await supabase.from('models').select('id').eq('name', 'chats').maybeSingle();
  if (mErr) throw new Error(`chat card: models read failed: ${mErr.message}`);
  if (!model?.id) return false;
  const { data, error } = await supabase
    .from('unified_records').select('data').eq('model_id', model.id as string).eq('data->>wid', chatWid).limit(50);
  if (error) throw new Error(`chat card: chats read failed: ${error.message}`);
  for (const r of (data ?? []) as Array<{ data: Row | null }>) {
    const link = r.data?.client_link;
    if (link === clientId || (Array.isArray(link) && link.includes(clientId))) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// loadChatCard
// ────────────────────────────────────────────────────────────────────────────

export async function loadChatCard(
  supabase: SupabaseClient,
  clientId: string,
  chatWid: string,
  opts: { now?: () => Date } = {},
): Promise<ChatCard> {
  const now = (opts.now ?? (() => new Date()))();
  const [cp, customer_messages] = await Promise.all([
    readCheckpoint(supabase, clientId, chatWid),
    readCustomerMessageCount(supabase, chatWid),
  ]);
  if (!cp) {
    return {
      status: 'none', checkpoint_id: null, proposal: null, mentions: [], names: {},
      analyzed_at: null, stale: false, graded: false, can_reanalyze: true, customer_messages,
    };
  }

  const [prop, evRows, newestIn] = await Promise.all([
    readNewestProposal(supabase, cp.id),
    readEvidenceRows(supabase, clientId, chatWid, cp),
    readNewestCustomerMessageAt(supabase, chatWid),
  ]);
  const graded = await readIsProtected(supabase, [...evRows.map((r) => s(r.id)), cp.id]);

  let proposal: ChatCardProposal | null = null;
  let names: Record<string, PlaceNameInfo> = {};
  if (prop) {
    const expression = (prop.final_expression ?? prop.proposed_expression) as GeoPreference;
    const by_evidence = placementsByEvidence(expression);
    const toItems = (e: GeoPreference) => geoPreferenceToLocationItems(e).filter((li) => li.kind !== 'district' || isUuid(li.district_id));
    const items = toItems(expression);
    const evIds = Object.keys(by_evidence);
    const items_by_evidence: Record<string, LocationItem[]> = {};
    for (const id of evIds) items_by_evidence[id] = toItems(pruneExpression(expression, evIds.filter((x) => x !== id)));
    names = await readNames(supabase, by_evidence, items);
    proposal = {
      id: prop.id, version: prop.version ?? null, status: prop.status, proposed_action: prop.proposed_action,
      expression, by_evidence, items, items_by_evidence, verifier: prop.verifier ?? null,
    };
  }

  const analyzed_at = laterOf(cp.created_at, prop?.created_at ?? null);
  const since = analyzed_at ? now.getTime() - Date.parse(analyzed_at) : Number.POSITIVE_INFINITY;
  return {
    status: (prop ? prop.status : 'empty') as ChatCardStatus,
    checkpoint_id: cp.id,
    proposal,
    mentions: evRows.map((r) => ({ evidence_id: s(r.id), mention_span: s(r.mention_span), preference_role: s(r.preference_role) })),
    names,
    analyzed_at,
    stale: computeStale(cp.created_at, newestIn),
    graded,
    can_reanalyze: !(since < REANALYZE_COOLDOWN_MS),
    customer_messages,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// analyzeChatConversation
// ────────────────────────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  /** Injected pipeline (tests); default = makeSupabaseBackfillDeps(supabase, …). */
  deps?: BackfillDeps;
  /** The already-gathered conversation (the chat auto-read gathers it once for both agents). */
  conversation?: Conversation | null;
  workerId?: string;
  log?: (msg: string) => void;
  now?: () => Date;
}

/**
 * (Re)read ONE chat for ONE client and mint a new pending proposal:
 *   - cool-down: read within {@link REANALYZE_COOLDOWN_MS} ⇒ return the card, run nothing;
 *   - mode ({@link decideAnalyzeMode}): `extract` = the backfill's per-conversation
 *     path (extract → persist → remap → review), `re_review` = rebuild evidence +
 *     relations from the stored rows and rerun review only (no LLM extraction);
 *   - this conversation's older `pending` proposals become `superseded`
 *     (non-pending ones are never touched);
 *   - the verifier runs on the new proposal (a verifier failure is STORED on
 *     the row by the port, not thrown).
 * NEVER writes a client record and NEVER contacts the customer.
 */
export async function analyzeChatConversation(
  supabase: SupabaseClient,
  clientId: string,
  chatWid: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeOutcome> {
  const nowFn = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const deps = opts.deps ?? makeSupabaseBackfillDeps(supabase, opts.workerId ?? 'chat-card', { log });

  // Cool-down (cost + double-click guard).
  const current = await loadChatCard(supabase, clientId, chatWid, { now: nowFn });
  if (current.status !== 'none' && !current.can_reanalyze) {
    log(`[geo-chat-card] client=${clientId} chat=${chatWid} read ${current.analyzed_at} — within cool-down, skipped`);
    return { ...current, mode: 'skipped_recent' };
  }

  const given = opts.conversation && opts.conversation.id === chatWid && opts.conversation.turns.length > 0 ? opts.conversation : null;
  const conversation = given ?? (await deps.gatherConversations(clientId)).find((c) => c.id === chatWid && c.turns.length > 0);
  if (!conversation) {
    if (await chatLinkedToClient(supabase, clientId, chatWid)) {
      throw new ChatCardError(422, 'the customer has not written anything in this chat yet — there is nothing to read');
    }
    throw new ChatCardError(404, 'this chat is not linked to this client');
  }

  const cp = await readCheckpoint(supabase, clientId, chatWid);
  const newestIn = await readNewestCustomerMessageAt(supabase, chatWid);
  const evRows = cp ? await readEvidenceRows(supabase, clientId, chatWid, cp) : [];
  const hasProtectedEvidence = cp ? await readIsProtected(supabase, [...evRows.map((r) => s(r.id)), cp.id]) : false;
  const mode = decideAnalyzeMode({
    hasCheckpoint: cp !== null,
    hasNewerMessage: computeStale(cp?.created_at ?? null, newestIn),
    hasProtectedEvidence,
  });

  if (mode === 're_review' && cp) {
    await runReReview(supabase, deps, clientId, conversation, cp, evRows, log);
  } else {
    await runExtract(supabase, deps, clientId, conversation, cp, log);
  }

  const card = await loadChatCard(supabase, clientId, chatWid, { now: nowFn });
  return { ...card, mode };
}

/** Review-only rerun over the stored evidence (no LLM extraction; evidence + checkpoint ids kept). */
async function runReReview(
  supabase: SupabaseClient, deps: BackfillDeps, clientId: string, conversation: Conversation,
  cp: CheckpointRow, evRows: Row[], log: (m: string) => void,
): Promise<void> {
  const evidence = evRows.map(rowToEvidence);
  const { data: relRows, error: relErr } = await supabase
    .from('geo_pref_relations').select('*').eq('conversation_id', conversation.id ?? '').eq('origin', 'model');
  if (relErr) throw new Error(`chat card: relations read failed: ${relErr.message}`);
  const relations = ((relRows ?? []) as Row[]).map(rowToRelation);

  // The proposal store dedups on (client, checkpoint, pending) — supersede the
  // open one FIRST or the rerun would just hand it back.
  const older = await readPendingProposalIds(supabase, cp.id);
  await markSuperseded(supabase, older, null);
  let proposalId: string | null = null;
  try {
    const ctx = await deps.buildRunContext(clientId, evidence.length);
    ctx.checkpoint_id = cp.id;
    const result = await deps.runReviewFirst(evidence, relations, ctx, { proposals: deps.proposals });
    proposalId = result.proposal?.id ?? null;
    log(`[geo-chat-card] client=${clientId} chat=${conversation.id} mode=re_review decision=${result.decision} evidence=${evidence.length} proposal=${proposalId ?? 'none'}`);
  } catch (err) {
    // Nothing replaced them — put the superseded proposals back, then fail loudly.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await restorePending(supabase, older);
    } catch (restoreErr) {
      const rmsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      console.error('[geo-chat-card] restore after failed re-review also failed:', rmsg);
      throw new Error(`${msg} (and ${rmsg}: proposals ${older.join(', ')} are left superseded)`);
    }
    throw err;
  }
  if (proposalId) {
    await linkSuperseded(supabase, older, proposalId);
    if (deps.verify) await deps.verify(conversation, evidence, proposalId);
  }
}

/** The backfill's per-conversation path: extract → persist → remap → review → verify. */
async function runExtract(
  supabase: SupabaseClient, deps: BackfillDeps, clientId: string, conversation: Conversation,
  cp: CheckpointRow | null, log: (m: string) => void,
): Promise<void> {
  // Capture the open proposals BEFORE persisting: persistExtraction deletes the
  // old checkpoint and their checkpoint_id becomes NULL (FK ON DELETE SET NULL).
  const older = cp ? await readPendingProposalIds(supabase, cp.id) : [];
  const extracted = await deps.extract(conversation);
  let { evidence, relations } = extracted;
  let checkpointId: string | null = null;
  if (deps.persistExtraction) {
    const persisted = await deps.persistExtraction(clientId, conversation, evidence, relations);
    checkpointId = persisted.checkpointId;
    if (persisted.idMap) ({ evidence, relations } = remapExtractionIds(evidence, relations, persisted.idMap));
  }
  const ctx = await deps.buildRunContext(clientId, evidence.length);
  if (checkpointId) ctx.checkpoint_id = checkpointId;
  const result = await deps.runReviewFirst(evidence, relations, ctx, { proposals: deps.proposals });
  const proposalId = result.proposal?.id ?? null;
  // Superseded AFTER the new reading succeeded, so a failed extraction leaves
  // the rep's previous proposal untouched. (The new checkpoint is fresh, so the
  // store's dedup cannot hand an old one back — no need to do it first here.)
  await markSuperseded(supabase, older.filter((id) => id !== proposalId), proposalId);
  log(`[geo-chat-card] client=${clientId} chat=${conversation.id} mode=extract decision=${result.decision} evidence=${evidence.length} proposal=${proposalId ?? 'none'} superseded=${older.length}`);
  if (proposalId && deps.verify) await deps.verify(conversation, evidence, proposalId);
}
