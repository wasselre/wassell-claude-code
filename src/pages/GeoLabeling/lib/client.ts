/**
 * Bearer-attached client for /api/geo-preference/labeling — the Geography
 * Understanding Ability gold-set labeling instrument.
 *
 * The FieldDescriptors that drive the form are RENDERED BY THE SERVER (the
 * ontology-driven config lives in api/_lib/geoPreference/labelingInstrument.ts and
 * is never re-declared here) and returned per-subject in `list_subjects`. This
 * module only carries the transport + the response shapes the UI renders.
 */
import { supabase } from '@/lib/supabase';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/geo-preference/labeling', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b?.error ?? `${action} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export type LabelRole = 'meaning' | 'geo_operator' | 'adjudicator';
export type LabeledEntity = 'evidence' | 'anchor' | 'relation' | 'checkpoint';
export type Escape = 'unknown' | 'insufficient_context' | 'must_confirm';

/** Mirrors api/_lib/geoPreference/labelingInstrument.FieldDescriptor (server-served). */
export interface FieldDescriptor {
  entity: LabeledEntity;
  field: string;
  label: string;
  kind: 'enum' | 'text' | 'number' | 'list' | 'boolean' | 'ref';
  allowed_values?: string[];
  required: boolean;
  fuzzy: boolean;
  escapes: Escape[];
  help: string;
}

export interface BatchSubject {
  subject_kind: LabeledEntity;
  subject_ref: string;
  conversation_id?: string;
  client_id?: string;
}

export interface LabelRow {
  id?: string;
  batch_id: string;
  subject_kind: LabeledEntity;
  subject_ref: string;
  field: string;
  value: string | null;
  is_escape: boolean;
  annotator_id: string;
  role: LabelRole;
  round: 'blind' | 'adjudication';
  certainty?: string | null;
}

export interface EnrichedSubject {
  subject: BatchSubject;
  fields: FieldDescriptor[];
  context: unknown;         // already PII-redacted for the caller's role
  my_labels: LabelRow[];
}

export interface BatchMeta {
  id: string;
  label: string;
  split: 'dev' | 'test' | 'drift_holdout';
  status: 'open' | 'labeling' | 'adjudication' | 'closed';
  adjudication_open: boolean;
  frozen: boolean;
}

export interface ListSubjectsResult {
  batch: BatchMeta;
  role: LabelRole;
  subjects: EnrichedSubject[];
}

export interface FieldAgreement {
  field: string;
  n: number;
  raw_agreement: number;
  cohen_kappa: number;
  confusion: Record<string, Record<string, number>>;
}
export interface Survivor {
  item_id: string;
  field: string;
  labeler_a: string;
  labeler_b: string;
  must_confirm_condition: string;
}
export interface AgreementResult {
  batch_id: string;
  per_field: FieldAgreement[];
  survivors: Survivor[];
}

export function listSubjects(batchId: string, role?: LabelRole): Promise<ListSubjectsResult> {
  return call('list_subjects', { batch_id: batchId, ...(role ? { role } : {}) });
}

export function submitLabel(input: {
  batch_id: string; subject_kind: LabeledEntity; subject_ref: string;
  field: string; value: string | null; role: LabelRole; certainty?: string | null;
}): Promise<{ saved: LabelRow }> {
  return call('submit_label', input);
}

export function agreement(batchId: string, field?: string): Promise<AgreementResult> {
  return call('agreement', { batch_id: batchId, ...(field ? { field } : {}) });
}

export function submitAdjudication(input: {
  batch_id: string; subject_kind: LabeledEntity; subject_ref: string;
  field: string; value: string | null; certainty?: string | null;
}): Promise<{ saved: LabelRow }> {
  return call('submit_adjudication', input);
}

export function writeCanonical(input: {
  batch_id?: string; checkpoint_id: string; canonical_expected_expression: unknown;
}): Promise<{ checkpoint_id: string; written: boolean }> {
  return call('write_canonical', input);
}

export function exportGold(includeTest = false): Promise<unknown> {
  return call('export', { include_test: includeTest });
}
