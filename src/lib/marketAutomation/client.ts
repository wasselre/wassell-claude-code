/**
 * Market Listings Automation — read layer over the Gate A tables.
 *
 * The cockpit only READS here (raw evidence, field decisions, health). Extraction
 * and adapter code live in the repo/engine, never in the app. Decision WRITES
 * (Pane B) will go through a scoped RPC in a later phase — this module is the
 * read-only observability foundation.
 */
import { supabase } from '@/lib/supabase';

/** One observed source field, reconciled across catalog × mappings × gaps. */
export interface FieldStatus {
  platform: string;
  source_path: string;
  source_label: string | null;
  page_section: string | null;
  raw_data_type: string | null;
  language: string | null;
  occurrence_count: number | null;
  last_seen: string | null;
  example_values: unknown; // jsonb array of sample values
  authoritative_status: string | null; // mapped_existing_field | candidate_new_field | review_required | …
  canonical_field: string | null;
  reviewer: string | null;
  reason: string | null;
  decided_at: string | null;
  gap_status: string | null;
  criticality: string | null;
  affected_record_count: number | null;
  replayable: boolean | null;
}

/** Every observed field with its current decision state, ordered by path. */
export async function fetchFieldStatus(): Promise<FieldStatus[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('v_source_field_status')
    .select(
      'platform,source_path,source_label,page_section,raw_data_type,language,occurrence_count,last_seen,example_values,authoritative_status,canonical_field,reviewer,reason,decided_at,gap_status,criticality,affected_record_count,replayable',
    )
    .order('source_path');
  if (error) throw new Error(error.message);
  return (data ?? []) as FieldStatus[];
}

/** The five disposition buckets, plus the undecided queue, for the health strip. */
export interface HealthSummary {
  total: number;
  mapped: number;
  candidateNew: number;
  keptOrSourceSpecific: number;
  ignored: number;
  needsReview: number; // review_required + no decision — the queue
  byPlatform: Record<string, number>;
}

const NEEDS_REVIEW = new Set(['review_required', null as unknown as string, '']);

export function summarize(rows: FieldStatus[]): HealthSummary {
  const s: HealthSummary = {
    total: rows.length, mapped: 0, candidateNew: 0, keptOrSourceSpecific: 0,
    ignored: 0, needsReview: 0, byPlatform: {},
  };
  for (const r of rows) {
    s.byPlatform[r.platform] = (s.byPlatform[r.platform] ?? 0) + 1;
    const st = r.authoritative_status;
    if (st === 'mapped_existing_field') s.mapped++;
    else if (st === 'candidate_new_field') s.candidateNew++;
    else if (st === 'reviewed_source_specific' || st === 'kept_in_extras') s.keptOrSourceSpecific++;
    else if (st === 'intentionally_ignored' || st === 'technical_excluded') s.ignored++;
    else if (NEEDS_REVIEW.has(st ?? '')) s.needsReview++;
  }
  return s;
}

/** Coerce the jsonb example array into a short list of display strings. */
export function exampleList(v: unknown, max = 4): string[] {
  const arr = Array.isArray(v) ? v : [];
  return arr.slice(0, max).map((x) => (x == null ? '∅' : String(x)));
}

/** The valid dispositions the operator can pick (matches the DB status CHECK). */
export const DISPOSITIONS = [
  'mapped_existing_field',
  'candidate_new_field',
  'reviewed_source_specific',
  'intentionally_ignored',
  'technical_excluded',
  'review_required',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface DecisionInput {
  platform: string;
  source_path: string;
  status: Disposition;
  canonical_field?: string | null;
  transformation?: string | null;
  reason?: string | null;
}

/** Write one field decision (upserts the mapping + resolves the gap) via the RPC. */
export async function decideField(input: DecisionInput): Promise<void> {
  if (!supabase) throw new Error('offline — no Supabase connection');
  const { error } = await supabase.rpc('source_field_decide', {
    p_platform: input.platform,
    p_source_path: input.source_path,
    p_status: input.status,
    p_canonical_field: input.canonical_field ?? null,
    p_transformation: input.transformation ?? null,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.message);
}

/** One publish-ledger row — whether a canonical_field is released to the live table. */
export interface PublishLedgerRow {
  platform: string;
  canonical_field: string;
  status: 'held' | 'released';
  released_at: string | null;
  released_by: string | null;
  reason: string | null;
}

/** The publish allowlist: which canonical_fields are released per platform. */
export async function fetchPublishLedger(): Promise<PublishLedgerRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('market_listing_publish_ledger')
    .select('platform,canonical_field,status,released_at,released_by,reason');
  if (error) throw new Error(error.message);
  return (data ?? []) as PublishLedgerRow[];
}

/** Release or hold one canonical_field for a platform (the publish gate toggle). */
export async function setPublishStatus(
  platform: string,
  canonical_field: string,
  status: 'held' | 'released',
  reason?: string | null,
): Promise<void> {
  if (!supabase) throw new Error('offline — no Supabase connection');
  const { error } = await supabase.rpc('market_listing_publish_set', {
    p_platform: platform,
    p_canonical_field: canonical_field,
    p_status: status,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
}

/**
 * The publisher: dry-run returns how many rows would change (staged value differs
 * from live); release (dryRun=false) backfills the live column from staging, flips
 * the ledger to released, and clears staging for the field. Returns the diff count.
 */
export async function publishField(
  platform: string,
  canonical_field: string,
  dryRun: boolean,
): Promise<number> {
  if (!supabase) throw new Error('offline — no Supabase connection');
  const { data, error } = await supabase.rpc('market_listing_publish', {
    p_platform: platform,
    p_canonical_field: canonical_field,
    p_dry_run: dryRun,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

/** The market_listings field slugs — the target columns for "map to existing". */
export async function fetchTargetFields(): Promise<string[]> {
  return Object.keys(await fetchTargetFieldTypes()).sort();
}

/** Map of market_listings field slug → coercion class (how a raw value lands).
 *  'location' + 'structured' are fields the app COMPOSES (geography cascade, lookups,
 *  multi-value, mirrors) — a raw scalar does NOT drop into them, so the preview flags them. */
export type CoerceClass = 'numeric' | 'boolean' | 'timestamp' | 'text' | 'location' | 'structured';
export async function fetchTargetFieldTypes(): Promise<Record<string, CoerceClass>> {
  if (!supabase) return {};
  const { data, error } = await supabase.from('models').select('schema').eq('name', 'market_listings').maybeSingle();
  if (error) throw new Error(error.message);
  const schema = (data?.schema ?? {}) as { sections?: { fields?: { name?: string; type?: string }[] }[] };
  const out: Record<string, CoerceClass> = {};
  const STRUCT = ['multiselect', 'table', 'notes', 'multi_image', 'multi_video', 'lookup',
    'section_selector', 'section_mirror', 'mirror', 'assignee'];
  const cls = (t?: string): CoerceClass =>
    t === 'number' || t === 'currency' || t === 'formula' ? 'numeric'
      : t === 'checkbox' ? 'boolean'
      : t === 'date' || t === 'datetime' ? 'timestamp'
      : t === 'location' ? 'location'
      : t && STRUCT.includes(t) ? 'structured'
      : 'text';
  for (const sec of schema.sections ?? []) for (const f of sec.fields ?? []) if (f.name) out[f.name] = cls(f.type);
  return out;
}

/** market_listings field slug → its bilingual UI label (for readable field tables). */
export async function fetchTargetLabels(): Promise<Record<string, { ar: string; en: string }>> {
  if (!supabase) return {};
  const { data, error } = await supabase.from('models').select('schema').eq('name', 'market_listings').maybeSingle();
  if (error) throw new Error(error.message);
  const schema = (data?.schema ?? {}) as { sections?: { fields?: { name?: string; label_ar?: string; label_en?: string }[] }[] };
  const out: Record<string, { ar: string; en: string }> = {};
  for (const sec of schema.sections ?? []) for (const f of sec.fields ?? []) {
    if (f.name) out[f.name] = { ar: f.label_ar ?? f.name, en: f.label_en ?? f.name };
  }
  return out;
}

/** Mirror of the DB coercions (try_numeric/boolean/timestamptz) for the live preview.
 *  Returns { ok, out } — ok=false means a non-empty value would land as NULL (a
 *  type mismatch the operator should see before mapping). */
export function coercePreview(raw: string, cls: CoerceClass): { ok: boolean; out: string } {
  const s = (raw ?? '').trim();
  if (s === '') return { ok: true, out: '∅' };
  // Composed fields: a raw scalar does NOT land here — the app builds them (e.g.
  // location = city/region/district from the district lookup, not from raw text).
  if (cls === 'location') return { ok: false, out: '⚠ الموقع (يُبنى من الحي)' };
  if (cls === 'structured') return { ok: false, out: '⚠ حقل مركّب' };
  if (cls === 'numeric') {
    const n = Number(s.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) && /\d/.test(s) ? { ok: true, out: String(n) } : { ok: false, out: '✗ (blank)' };
  }
  if (cls === 'boolean') {
    const t = s.toLowerCase();
    if (['true', 't', '1', 'yes'].includes(t)) return { ok: true, out: 'true' };
    if (['false', 'f', '0', 'no'].includes(t)) return { ok: true, out: 'false' };
    return { ok: false, out: '✗ (blank)' };
  }
  if (cls === 'timestamp') {
    const d = Date.parse(s);
    return Number.isFinite(d) ? { ok: true, out: new Date(d).toISOString().slice(0, 10) } : { ok: false, out: '✗ (blank)' };
  }
  return { ok: true, out: s.slice(0, 60) };
}

/** Sample real staged values for a held field + their current live value. */
export interface StagedSample { staged: string | null; live: string | null }
export async function fetchStagedSample(canonical_field: string, limit = 8): Promise<StagedSample[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('market_listing_staging_sample', { p_canonical_field: canonical_field, p_limit: limit });
  if (error) throw new Error(error.message);
  return (data ?? []) as StagedSample[];
}
