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
