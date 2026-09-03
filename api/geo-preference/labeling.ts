/**
 * POST /api/geo-preference/labeling — the operational LABELING INSTRUMENT backend
 * for the Geography Understanding Ability gold set.
 *
 * ONE dispatch endpoint, `{ action }` in the body. It renders the ontology-driven
 * FieldDescriptor config (api/_lib/geoPreference/labelingInstrument.ts — REUSED,
 * never duplicated) into an assignable workflow with three roles:
 *
 *   meaning       — labels the LocationMention (Evidence/Relation/Checkpoint) fields
 *                   with full conversation context (PII redacted).
 *   geo_operator  — provides resolution/geometry truth on the Anchor fields
 *                   (coordinates/pins visible but pseudonymized).
 *   adjudicator   — after the blind rounds close, sees disagreements + Cohen's κ +
 *                   confusion matrices and picks the canonical answer.
 *
 * Blindness: a blind-round label is private to its author until the batch's
 * `adjudication_open` flips true — enforced HERE (visibleBlindLabels) before any
 * row leaves the server, not by RLS.
 *
 * Actions:
 *   list_subjects        — the subjects assigned to the caller's role in a batch,
 *                          each with its FieldDescriptors, redacted context, and
 *                          the caller's OWN labels (never a peer's, pre-adjudication).
 *   submit_label         — upsert one BLIND label (round='blind').
 *   agreement            — κ + confusion + surviving disagreements for a batch
 *                          (reuses labelingInstrument.adjudicate / cohenKappa).
 *   submit_adjudication  — the adjudicator's canonical pick (round='adjudication').
 *   write_canonical      — write canonical_expected_expression onto a checkpoint.
 *   export               — gold_evidence_and_relations + canonical_expected_expression
 *                          as JSON, refusing TEST/holdout answers while the auto-write
 *                          gate is closed (the frozen-TEST tuning guard).
 *
 * PII posture (CLAUDE.md): person identity (name/phone/email/ids) is pseudonymized
 * for EVERY role — never raw in the labeling tool. Precise geometry (coords/pins)
 * is hidden from meaning annotators and pseudonymized for geo operators/adjudicators.
 *
 * Auth: caller's Supabase JWT (withAuth). Reads + writes go through a service-role
 * client because blindness/redaction are enforced in code, above RLS.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk, type AuthenticatedUser } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import {
  EVIDENCE_FIELDS, ANCHOR_FIELDS, RELATION_FIELDS, CHECKPOINT_FIELDS,
  adjudicate, type FieldDescriptor, type LabelPair, type AdjudicationResult,
  type LabeledEntity,
} from '../_lib/geoPreference/labelingInstrument.js';

export const config = { runtime: 'edge' };

const SERVICE = 'api:geo-pref-labeling';

// ────────────────────────────────────────────────────────────────────────────
// Roles ↔ the entity fields each is responsible for.
// meaning owns the interpretive Evidence/Relation/Checkpoint axes; geo_operator
// owns the Anchor resolution axes. Adjudicator ranges over whatever disagreed.
// ────────────────────────────────────────────────────────────────────────────
export type LabelRole = 'meaning' | 'geo_operator' | 'adjudicator';
export type LabelRound = 'blind' | 'adjudication';

const FIELDS_BY_ENTITY: Record<LabeledEntity, readonly FieldDescriptor[]> = {
  evidence: EVIDENCE_FIELDS,
  anchor: ANCHOR_FIELDS,
  relation: RELATION_FIELDS,
  checkpoint: CHECKPOINT_FIELDS,
};

/** Which entity kinds a role labels. */
export const ENTITIES_FOR_ROLE: Record<LabelRole, readonly LabeledEntity[]> = {
  meaning: ['evidence', 'relation', 'checkpoint'],
  geo_operator: ['anchor'],
  adjudicator: ['evidence', 'anchor', 'relation', 'checkpoint'],
};

/** FieldDescriptors a given role should render for a given subject kind. */
export function fieldsForRoleAndKind(role: LabelRole, kind: LabeledEntity): readonly FieldDescriptor[] {
  if (!ENTITIES_FOR_ROLE[role].includes(kind)) return [];
  return FIELDS_BY_ENTITY[kind];
}

// ────────────────────────────────────────────────────────────────────────────
// Subject / batch / label shapes (mirror the SQL in
// supabase/migrations/2026-09-03b_geo_pref_labeling_instrument.sql).
// ────────────────────────────────────────────────────────────────────────────
export interface BatchSubject {
  subject_kind: LabeledEntity;
  subject_ref: string;               // evidence/relation/checkpoint id; anchor = '<evidenceId>#<idx>'
  conversation_id?: string;
  client_id?: string;
}
export interface BatchAssignment { annotator_id: string; role: LabelRole; }

export interface CalibrationBatch {
  id: string;
  label: string;
  split: 'dev' | 'test' | 'drift_holdout';
  status: 'open' | 'labeling' | 'adjudication' | 'closed';
  adjudication_open: boolean;
  frozen: boolean;
  subjects: BatchSubject[];
  assignments: BatchAssignment[];
}

export interface LabelRow {
  id?: string;
  batch_id: string;
  subject_kind: LabeledEntity;
  subject_ref: string;
  field: string;                     // qualified: 'evidence.holder_role'
  value: string | null;
  is_escape: boolean;
  annotator_id: string;
  role: LabelRole;
  round: LabelRound;
  certainty?: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// PII redaction — pure + testable. Person identity is pseudonymized for EVERY
// role; precise geometry is hidden from meaning, pseudonymized for geo/adjudicator.
// ────────────────────────────────────────────────────────────────────────────
const PII_KEY = /^(full_?name|client_?name|customer_?name|contact_?name|name|contact|phone|mobile|msisdn|tel|whats_?app|whatsapp|wa_?id|chat_?wid|email|e_?mail|national_?id|iqama|id_?number)$/i;
const GEO_KEY = /^(lat|latitude|lng|lon|long|longitude|coord|coords|coordinates|geom|geometry|centroid|point|pin|pin_?id|pins|place_?id|location_?pin)$/i;
const PIN_KEY = /^(pin|pin_?id|pins|place_?id|location_?pin)$/i;
const PHONE_IN_TEXT = /(\+?\d[\d\s().-]{6,}\d)/g;

/** Deterministic short pseudonym (FNV-1a → base36). Same input → same token, so
 *  annotators can co-refer without ever seeing the raw value. Edge-safe (sync). */
export function pseudonym(prefix: string, raw: unknown): string {
  const s = String(raw);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}_${h.toString(36)}`;
}

function scrubText(s: string): string {
  return s.replace(PHONE_IN_TEXT, '[phone]');
}

/**
 * Redact an arbitrary context blob for a role. Never mutates its input.
 * - person identity keys → pseudonymized token (ALL roles)
 * - geometry keys → hidden for `meaning`; pins pseudonymized + coords rounded for
 *   `geo_operator`/`adjudicator`
 * - any embedded phone number inside a free-text string → '[phone]'
 */
export function redactContextForRole(ctx: unknown, role: LabelRole): unknown {
  const geoVisible = role === 'geo_operator' || role === 'adjudicator';

  const walk = (node: unknown, keyHint?: string): unknown => {
    if (node == null) return node;
    if (typeof node === 'string') {
      if (keyHint && PII_KEY.test(keyHint)) return pseudonym('person', node);
      if (keyHint && PIN_KEY.test(keyHint)) return geoVisible ? pseudonym('pin', node) : '[geo-hidden]';
      if (keyHint && GEO_KEY.test(keyHint)) return geoVisible ? node : '[geo-hidden]';
      return scrubText(node);
    }
    if (typeof node === 'number') {
      if (keyHint && GEO_KEY.test(keyHint)) {
        if (!geoVisible) return '[geo-hidden]';
        // Light coordinate pseudonymization: reduce precision to ~100m.
        return Math.round(node * 1000) / 1000;
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((v) => walk(v, keyHint));
    if (typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (PII_KEY.test(k)) { out[k] = typeof v === 'string' ? pseudonym('person', v) : '[redacted]'; continue; }
        if (PIN_KEY.test(k)) { out[k] = geoVisible ? pseudonym('pin', v) : '[geo-hidden]'; continue; }
        if (GEO_KEY.test(k)) { out[k] = geoVisible ? walk(v, k) : '[geo-hidden]'; continue; }
        out[k] = walk(v, k);
      }
      return out;
    }
    return node;
  };
  return walk(ctx);
}

// ────────────────────────────────────────────────────────────────────────────
// Blindness — a blind label is private to its author until adjudication opens.
// ────────────────────────────────────────────────────────────────────────────
/**
 * Filter blind-round labels to what `requesterId` (holding `requesterRole`) may
 * READ. Adjudication rows are always visible to adjudicators. Blind rows are
 * visible to their author always, and to everyone once `adjudicationOpen`.
 */
export function visibleBlindLabels<T extends { annotator_id: string; round: LabelRound }>(
  rows: readonly T[],
  requesterId: string,
  requesterRole: LabelRole,
  adjudicationOpen: boolean,
): T[] {
  return rows.filter((r) => {
    if (r.round === 'adjudication') return requesterRole === 'adjudicator' || adjudicationOpen;
    if (adjudicationOpen) return true;
    return r.annotator_id === requesterId; // blind + closed → own only
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Agreement — pair blind labels into the LabelPair shape adjudicate() consumes.
// ────────────────────────────────────────────────────────────────────────────
/**
 * For each (subject_ref, field) with ≥2 blind labels from DISTINCT annotators,
 * emit one LabelPair per unordered annotator pair, carrying their two VALUES.
 * adjudicate() then scores raw agreement + Cohen's κ + confusion per field and
 * surfaces the survivors (genuine disagreements) mapped to must-confirm gates.
 */
export function pairBlindLabels(rows: readonly LabelRow[]): LabelPair[] {
  const groups = new Map<string, LabelRow[]>();
  for (const r of rows) {
    if (r.round !== 'blind') continue;
    const key = `${r.subject_ref} ${r.field}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const pairs: LabelPair[] = [];
  for (const [, arr] of groups) {
    // Dedupe to one label per annotator (latest write wins is already enforced by
    // the unique index; here we just guard against accidental dupes).
    const byAnnotator = new Map<string, LabelRow>();
    for (const r of arr) byAnnotator.set(r.annotator_id, r);
    const list = [...byAnnotator.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        pairs.push({
          item_id: list[i]!.subject_ref,
          field: list[i]!.field,
          labeler_a: list[i]!.value ?? '∅',
          labeler_b: list[j]!.value ?? '∅',
        });
      }
    }
  }
  return pairs;
}

export function computeAgreement(rows: readonly LabelRow[]): AdjudicationResult {
  return adjudicate(pairBlindLabels(rows));
}

// ────────────────────────────────────────────────────────────────────────────
// Export guard — never leak frozen TEST/holdout answers during tuning.
// ────────────────────────────────────────────────────────────────────────────
export class ExportGuardError extends Error {}

/**
 * The frozen-DEV/TEST discipline. TEST + drift_holdout gold is the sealed answer
 * key; emitting it while the system is still being tuned (the auto-write gate is
 * closed) would let it leak into training/tuning. Refuse it unless the caller
 * explicitly asks AND the gate has been cleared.
 */
export function assertTestExportAllowed(includeTest: boolean, gateCleared: boolean): void {
  if (includeTest && !gateCleared) {
    throw new ExportGuardError(
      'TEST/holdout gold cannot be exported while the auto-write gate is closed (tuning). ' +
      'Clear the gate (geo_pref_gate_config.auto_write_enabled) before a final-eval export.',
    );
  }
}

export interface GoldExportInput {
  evidence: Array<Record<string, unknown> & { client_id?: string | null; conversation_id?: string }>;
  relations: Array<Record<string, unknown> & { conversation_id?: string }>;
  checkpoints: Array<Record<string, unknown> & { client_id?: string | null; conversation_id?: string; canonical_expected_expression?: unknown }>;
  /** client_id → split, from geo_pref_gold_split. */
  splitByClient: Record<string, 'dev' | 'test' | 'drift_holdout'>;
  includeTest: boolean;
  gateCleared: boolean;
}

export interface GoldExport {
  schema: 'geo_pref_gold_export_v1';
  generated_at: string;
  included_splits: string[];
  gold_evidence_and_relations: { evidence: unknown[]; relations: unknown[] };
  canonical_expected_expression: Array<{ checkpoint_id: unknown; conversation_id?: unknown; expression: unknown }>;
  excluded_frozen_count: number;
}

/**
 * Assemble the export, dropping frozen (TEST/holdout) rows unless allowed. Rows
 * are matched to a split via client_id; rows whose client is in a frozen split
 * (or whose conversation belongs to such a client) are excluded during tuning.
 */
export function buildGoldExport(input: GoldExportInput): GoldExport {
  assertTestExportAllowed(input.includeTest, input.gateCleared);

  const frozenClients = new Set(
    Object.entries(input.splitByClient)
      .filter(([, s]) => s === 'test' || s === 'drift_holdout')
      .map(([c]) => c),
  );
  // Conversations belonging to a frozen client (so relations without a client_id
  // can still be filtered).
  const frozenConversations = new Set<string>();
  for (const e of input.evidence) {
    if (e.client_id && frozenClients.has(String(e.client_id)) && e.conversation_id) {
      frozenConversations.add(String(e.conversation_id));
    }
  }
  for (const c of input.checkpoints) {
    if (c.client_id && frozenClients.has(String(c.client_id)) && c.conversation_id) {
      frozenConversations.add(String(c.conversation_id));
    }
  }

  const keep = input.includeTest; // if true (and allowed), keep everything
  let excluded = 0;
  const isFrozenByClient = (client_id?: string | null) => !!client_id && frozenClients.has(String(client_id));
  const isFrozenByConv = (conv?: string) => !!conv && frozenConversations.has(String(conv));

  const evidence = input.evidence.filter((e) => {
    const frozen = isFrozenByClient(e.client_id) || isFrozenByConv(e.conversation_id);
    if (frozen && !keep) { excluded++; return false; }
    return true;
  });
  const relations = input.relations.filter((r) => {
    const frozen = isFrozenByConv(r.conversation_id);
    if (frozen && !keep) { excluded++; return false; }
    return true;
  });
  const checkpoints = input.checkpoints.filter((c) => {
    const frozen = isFrozenByClient(c.client_id) || isFrozenByConv(c.conversation_id);
    if (frozen && !keep) { excluded++; return false; }
    return c.canonical_expected_expression != null;
  });

  const included = new Set<string>(['dev']);
  if (keep) { included.add('test'); included.add('drift_holdout'); }

  return {
    schema: 'geo_pref_gold_export_v1',
    generated_at: new Date().toISOString(),
    included_splits: [...included],
    gold_evidence_and_relations: { evidence, relations },
    canonical_expected_expression: checkpoints.map((c) => ({
      checkpoint_id: c.id,
      conversation_id: c.conversation_id,
      expression: c.canonical_expected_expression,
    })),
    excluded_frozen_count: excluded,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Handler.
// ────────────────────────────────────────────────────────────────────────────
interface Body { action?: string; [k: string]: unknown; }

function roleOfRequester(batch: CalibrationBatch, userId: string, wanted?: LabelRole): LabelRole | null {
  const held = batch.assignments.filter((a) => a.annotator_id === userId).map((a) => a.role);
  if (held.length === 0) return null;
  if (wanted) return held.includes(wanted) ? wanted : null;
  // Prefer the most privileged single role deterministically.
  if (held.includes('adjudicator')) return 'adjudicator';
  if (held.includes('meaning')) return 'meaning';
  return held.includes('geo_operator') ? 'geo_operator' : null;
}

async function loadBatch(db: SupabaseClient, batchId: string): Promise<CalibrationBatch | null> {
  const { data, error } = await db
    .from('geo_pref_calibration_batch')
    .select('id,label,split,status,adjudication_open,frozen,subjects,assignments')
    .eq('id', batchId)
    .maybeSingle();
  if (error) throw new Error(`batch load failed: ${error.message}`);
  if (!data) return null;
  return data as unknown as CalibrationBatch;
}

async function gateCleared(db: SupabaseClient): Promise<boolean> {
  const { data } = await db.from('geo_pref_gate_config').select('auto_write_enabled').eq('id', true).maybeSingle();
  return !!(data as { auto_write_enabled?: boolean } | null)?.auto_write_enabled;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user: AuthenticatedUser) => {
    const db = makeServiceClient(SERVICE);
    if (!db) return jsonError(500, 'Supabase service env vars missing');

    let body: Body;
    try { body = (await req.json()) as Body; } catch { return jsonError(400, 'invalid JSON body'); }
    const action = String(body.action ?? '');

    try {
      switch (action) {
        case 'list_subjects':   return await listSubjects(db, user, body);
        case 'submit_label':    return await submitLabel(db, user, body, 'blind');
        case 'agreement':       return await agreement(db, user, body);
        case 'submit_adjudication': return await submitLabel(db, user, body, 'adjudication');
        case 'write_canonical': return await writeCanonical(db, user, body);
        case 'export':          return await exportGold(db, body);
        default: return jsonError(400, `unknown action: ${action || '(none)'}`);
      }
    } catch (err) {
      if (err instanceof ExportGuardError) return jsonError(403, err.message);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[geo-pref-labeling] ${action} failed:`, msg);
      return jsonError(502, msg);
    }
  });
}

// ── list_subjects ─────────────────────────────────────────────────────────────
async function listSubjects(db: SupabaseClient, user: AuthenticatedUser, body: Body): Promise<Response> {
  const batchId = String(body.batch_id ?? '');
  if (!batchId) return jsonError(400, 'batch_id required');
  const batch = await loadBatch(db, batchId);
  if (!batch) return jsonError(404, 'batch not found');

  const role = roleOfRequester(batch, user.userId, body.role as LabelRole | undefined);
  if (!role) return jsonError(403, 'you are not assigned to this batch (or not in that role)');

  // The caller's own blind labels (+ adjudication rows if visible).
  const { data: labelRows, error } = await db
    .from('geo_pref_labels')
    .select('*')
    .eq('batch_id', batchId);
  if (error) return jsonError(502, `labels load failed: ${error.message}`);
  const visible = visibleBlindLabels(
    (labelRows ?? []) as LabelRow[], user.userId, role, batch.adjudication_open,
  );

  // Only the subjects this role is responsible for.
  const kinds = ENTITIES_FOR_ROLE[role];
  const subjects = batch.subjects.filter((s) => kinds.includes(s.subject_kind));

  // Load + redact context for each subject (evidence/relation/checkpoint rows).
  const enriched = await Promise.all(subjects.map(async (s) => {
    const context = await loadSubjectContext(db, s);
    const own = visible.filter((l) => l.subject_ref === s.subject_ref && (l.annotator_id === user.userId || batch.adjudication_open));
    return {
      subject: s,
      fields: fieldsForRoleAndKind(role, s.subject_kind),
      context: redactContextForRole(context, role),
      my_labels: own,
    };
  }));

  return jsonOk({
    batch: { id: batch.id, label: batch.label, split: batch.split, status: batch.status, adjudication_open: batch.adjudication_open, frozen: batch.frozen },
    role,
    subjects: enriched,
  });
}

/** Load the underlying ontology row for a subject as its labeling context. */
async function loadSubjectContext(db: SupabaseClient, s: BatchSubject): Promise<unknown> {
  if (s.subject_kind === 'evidence' || s.subject_kind === 'anchor') {
    const evId = s.subject_ref.split('#')[0]!;
    const { data } = await db.from('geo_pref_evidence').select('*').eq('id', evId).maybeSingle();
    if (s.subject_kind === 'anchor' && data) {
      const idx = Number(s.subject_ref.split('#')[1] ?? 0);
      const anchors = (data as { anchors?: unknown[] }).anchors ?? [];
      return { anchor: anchors[idx] ?? null, mention_span: (data as { mention_span?: string }).mention_span, conversation_id: (data as { conversation_id?: string }).conversation_id };
    }
    return data;
  }
  if (s.subject_kind === 'relation') {
    const { data } = await db.from('geo_pref_relations').select('*').eq('id', s.subject_ref).maybeSingle();
    return data;
  }
  const { data } = await db.from('geo_pref_checkpoints').select('*').eq('id', s.subject_ref).maybeSingle();
  return data;
}

// ── submit_label / submit_adjudication ────────────────────────────────────────
async function submitLabel(db: SupabaseClient, user: AuthenticatedUser, body: Body, round: LabelRound): Promise<Response> {
  const batchId = String(body.batch_id ?? '');
  if (!batchId) return jsonError(400, 'batch_id required');
  const batch = await loadBatch(db, batchId);
  if (!batch) return jsonError(404, 'batch not found');

  const subjectKind = body.subject_kind as LabeledEntity;
  const subjectRef = String(body.subject_ref ?? '');
  const field = String(body.field ?? '');
  if (!subjectKind || !subjectRef || !field) return jsonError(400, 'subject_kind, subject_ref, field required');

  const wantedRole: LabelRole = round === 'adjudication' ? 'adjudicator' : (body.role as LabelRole);
  const role = roleOfRequester(batch, user.userId, wantedRole);
  if (!role) {
    return jsonError(403, round === 'adjudication'
      ? 'only an assigned adjudicator may submit an adjudication'
      : 'you are not assigned to this batch in that role');
  }
  if (round === 'adjudication' && !batch.adjudication_open) {
    return jsonError(409, 'adjudication is not open for this batch yet');
  }

  // The field must belong to the role×kind per the instrument (no free-form fields).
  const allowed = fieldsForRoleAndKind(role, subjectKind);
  const descriptor = allowed.find((d) => `${d.entity}.${d.field}` === field || d.field === field);
  if (!descriptor && round === 'blind') {
    return jsonError(400, `field ${field} is not labelable by role ${role} on a ${subjectKind}`);
  }

  const rawValue = body.value == null ? null : String(body.value);
  const isEscape = ['unknown', 'insufficient_context', 'must_confirm'].includes(rawValue ?? '');

  // Validate an enum value against the descriptor (escapes always allowed).
  if (descriptor && descriptor.kind === 'enum' && rawValue != null && !isEscape) {
    if (descriptor.allowed_values && !descriptor.allowed_values.includes(rawValue)) {
      return jsonError(400, `value "${rawValue}" not allowed for ${field}`);
    }
  }

  const certainty = body.certainty == null ? null : String(body.certainty);

  const row = {
    batch_id: batchId,
    subject_kind: subjectKind,
    subject_ref: subjectRef,
    field,
    value: rawValue,
    is_escape: isEscape,
    annotator_id: user.userId,
    role,
    round,
    certainty,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from('geo_pref_labels')
    .upsert(row, { onConflict: 'batch_id,subject_ref,field,annotator_id,round' })
    .select()
    .maybeSingle();
  if (error) return jsonError(502, `label save failed: ${error.message}`);
  return jsonOk({ saved: data });
}

// ── agreement ─────────────────────────────────────────────────────────────────
async function agreement(db: SupabaseClient, user: AuthenticatedUser, body: Body): Promise<Response> {
  const batchId = String(body.batch_id ?? '');
  if (!batchId) return jsonError(400, 'batch_id required');
  const batch = await loadBatch(db, batchId);
  if (!batch) return jsonError(404, 'batch not found');

  const role = roleOfRequester(batch, user.userId);
  // Agreement (which reveals every annotator's blind values) is an adjudicator /
  // opened-batch view — protect blindness for peers still labeling.
  if (role !== 'adjudicator' && !batch.adjudication_open) {
    return jsonError(403, 'agreement is available to adjudicators, or after adjudication opens');
  }

  const { data: labelRows, error } = await db
    .from('geo_pref_labels').select('*').eq('batch_id', batchId).eq('round', 'blind');
  if (error) return jsonError(502, `labels load failed: ${error.message}`);

  let rows = (labelRows ?? []) as LabelRow[];
  if (body.field) rows = rows.filter((r) => r.field === String(body.field));

  return jsonOk({ batch_id: batchId, ...computeAgreement(rows) });
}

// ── write_canonical ───────────────────────────────────────────────────────────
async function writeCanonical(db: SupabaseClient, user: AuthenticatedUser, body: Body): Promise<Response> {
  const checkpointId = String(body.checkpoint_id ?? '');
  const expression = body.canonical_expected_expression;
  if (!checkpointId || expression == null) return jsonError(400, 'checkpoint_id and canonical_expected_expression required');

  // Must be an assigned adjudicator on the batch that owns this checkpoint.
  if (body.batch_id) {
    const batch = await loadBatch(db, String(body.batch_id));
    if (!batch) return jsonError(404, 'batch not found');
    if (roleOfRequester(batch, user.userId, 'adjudicator') !== 'adjudicator') {
      return jsonError(403, 'only an assigned adjudicator may write the canonical expression');
    }
  }

  // Only the canonical expression is written — origin_tag is left untouched to
  // avoid colliding with the checkpoints' UNIQUE(conversation_id,turn_id,origin_tag).
  const { data, error } = await db
    .from('geo_pref_checkpoints')
    .update({ canonical_expected_expression: expression })
    .eq('id', checkpointId)
    .select('id')
    .maybeSingle();
  if (error) return jsonError(502, `canonical write failed: ${error.message}`);
  if (!data) return jsonError(404, 'checkpoint not found');
  return jsonOk({ checkpoint_id: (data as { id: string }).id, written: true });
}

// ── export ────────────────────────────────────────────────────────────────────
async function exportGold(db: SupabaseClient, body: Body): Promise<Response> {
  const includeTest = body.include_test === true;
  const cleared = await gateCleared(db);

  // Guard runs FIRST so a tuning-time TEST request is refused before any read.
  try { assertTestExportAllowed(includeTest, cleared); }
  catch (e) { if (e instanceof ExportGuardError) return jsonError(403, e.message); throw e; }

  const [{ data: ev }, { data: rel }, { data: cp }, { data: splits }] = await Promise.all([
    db.from('geo_pref_evidence').select('*').in('origin', ['gold', 'adjudicated']),
    db.from('geo_pref_relations').select('*').in('origin', ['gold', 'adjudicated']),
    db.from('geo_pref_checkpoints').select('*').not('canonical_expected_expression', 'is', null),
    db.from('geo_pref_gold_split').select('client_id,split'),
  ]);

  const splitByClient: Record<string, 'dev' | 'test' | 'drift_holdout'> = {};
  for (const s of (splits ?? []) as Array<{ client_id: string; split: 'dev' | 'test' | 'drift_holdout' }>) {
    splitByClient[s.client_id] = s.split;
  }

  const out = buildGoldExport({
    evidence: (ev ?? []) as GoldExportInput['evidence'],
    relations: (rel ?? []) as GoldExportInput['relations'],
    checkpoints: (cp ?? []) as GoldExportInput['checkpoints'],
    splitByClient,
    includeTest,
    gateCleared: cleared,
  });
  return jsonOk(out);
}
