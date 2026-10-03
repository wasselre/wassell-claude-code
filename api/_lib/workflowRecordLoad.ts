/**
 * Record reads shared by the two server-side workflow engines — the `on_due`
 * sweeper (`workflowSweeper.ts`, edge runtime) and the server-authoritative
 * runner (`workflowRunner.ts`, node). Only supabase-js + plain TS in here, so
 * it loads on both runtimes.
 *
 * WHY THIS FILE EXISTS (live incident, fixed 2026-10-03):
 * both engines used to resolve an `update_record` target by loading the WHOLE
 * target model with a bare `.select().eq('model_id', …)` and searching it in
 * memory. PostgREST silently caps a response at 1,000 rows (no error), so once
 * a model grew past 1,000 the target was simply absent from the list and the
 * action was skipped with `no_matching_record`. On `followups` (3,755 rows)
 * that skipped ~80% of the WhatsApp no-response escalation's "close the
 * waiting task" updates for months: the task stayed open, every later rep
 * message re-armed it, and each re-arm minted another booking call. Same bug
 * class as the 2026-04-26 `supabaseLoad` truncation (CLAUDE.md "Silent
 * Failures").
 *
 * Two rules follow, and both engines go through this file to keep them:
 *   1. A target known BY ID is read BY ID — one indexed row, always fresh,
 *      independent of how big the model is.
 *   2. A whole-model read is keyset-paginated to exhaustion and THROWS on
 *      error. It never returns a short or empty list as if it were complete.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppRecord } from '../../src/types/index.js';

const RECORD_COLUMNS = 'id, model_id, data, created_by_user_id, created_at, updated_at';

/** PostgREST's `db-max-rows` on this project. A page can never be larger. */
export const WORKFLOW_RECORD_PAGE_SIZE = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RecordRow {
  id: string;
  model_id: string;
  data: Record<string, unknown> | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

function toAppRecord(r: RecordRow): AppRecord {
  return {
    id: r.id,
    model_id: r.model_id,
    data: r.data ?? {},
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by_user_id: r.created_by_user_id ?? undefined,
  };
}

/**
 * Every record of one model, read through `unified_records` (covers frozen and
 * unfrozen models alike).
 *
 * Keyset pagination (`id > cursor ORDER BY id`), the same posture as the
 * store's `supabaseLoad`: it seeks straight to the cursor on
 * `idx_records_model_id_id` (~6 ms a page, measured) and — unlike OFFSET — a
 * row inserted or deleted mid-walk cannot shift the window and make us skip or
 * repeat a row.
 *
 * The walk ends on an EMPTY page, not a short one. A short page only proves
 * "the server returned fewer rows than I asked for", which is also exactly
 * what a server-side row cap lower than our page size looks like — the very
 * truncation this function exists to defeat. One extra tiny query buys
 * certainty.
 *
 * Throws on any error. A caller that gets a list back may treat it as complete.
 */
export async function loadAllRecordsForModel(
  supabase: SupabaseClient,
  modelId: string,
): Promise<AppRecord[]> {
  const out: AppRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from('unified_records')
      .select(RECORD_COLUMNS)
      .eq('model_id', modelId);
    if (cursor !== null) query = query.gt('id', cursor);
    const { data, error } = await query
      .order('id', { ascending: true })
      .limit(WORKFLOW_RECORD_PAGE_SIZE);
    if (error) {
      throw new Error(
        `load records (${modelId}) failed after ${out.length} rows: ${error.message}`,
      );
    }
    const batch = (data ?? []) as unknown as RecordRow[];
    if (batch.length === 0) return out;
    const last: string = batch[batch.length - 1]!.id;
    // A cursor that does not advance would loop forever inside a cron. It can
    // only happen if the response is not ordered by id — fail loudly instead.
    if (cursor !== null && last <= cursor) {
      throw new Error(
        `load records (${modelId}) failed: keyset cursor did not advance (${cursor} -> ${last})`,
      );
    }
    for (const row of batch) out.push(toAppRecord(row));
    cursor = last;
  }
}

/**
 * One record by id, scoped to its model. Returns `null` when there is no such
 * record; throws on a query error (a failed read is not "no match").
 *
 * A value that is not uuid-shaped can never equal a record id, so it returns
 * `null` without a round trip — PostgREST would otherwise reject the uuid cast
 * with a 400 and turn "no match" into an error.
 */
export async function loadRecordById(
  supabase: SupabaseClient,
  modelId: string,
  id: string,
): Promise<AppRecord | null> {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await supabase
    .from('unified_records')
    .select(RECORD_COLUMNS)
    .eq('model_id', modelId)
    .eq('id', id)
    .limit(1);
  if (error) {
    throw new Error(`load record ${id} (${modelId}) failed: ${error.message}`);
  }
  const row = ((data ?? []) as unknown as RecordRow[])[0];
  return row ? toAppRecord(row) : null;
}

/** `undefined`, `null` and `''` — a filter value that names no record. */
export function isEmptyFilterValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export interface ResolveUpdateTargetArgs {
  supabase: SupabaseClient;
  targetModelId: string;
  /** The action's `filter_field_id` — `'id'` means "the record's own id". */
  filterFieldId: string;
  /** The resolved filter value (static, or read off the trigger record). */
  filterValue: unknown;
  /**
   * True when the engine knows the filter value IS a target record id even
   * though `filterFieldId` is not `'id'` — the lookup-aware case, where the
   * trigger field is a lookup whose stored value is the target's id.
   */
  matchById: boolean;
  /** The engine's whole-model loader (the sweeper passes its per-sweep cache). */
  loadAll: () => Promise<AppRecord[]>;
}

/**
 * Find the single record an `update_record` action targets. Same three-step
 * order both engines (and the client engine) have always used — id via a
 * lookup, id via a literal `id` filter, then field equality — with two
 * differences from the old in-memory search:
 *
 *   - The id steps read ONE row by id instead of searching a list that was
 *     silently cut at 1,000 rows.
 *   - An empty filter value matches nothing, and a literal `id` filter never
 *     falls through to the field scan. The old fall-through compared
 *     `record.data[field] === undefined`, which is TRUE for the first record
 *     that merely lacks the field — an empty trigger field would have updated
 *     an arbitrary record. (Checked 2026-10-03: no logged run ever did.)
 */
export async function resolveUpdateTarget(
  args: ResolveUpdateTargetArgs,
): Promise<AppRecord | undefined> {
  const { supabase, targetModelId, filterFieldId, filterValue } = args;
  if (isEmptyFilterValue(filterValue)) return undefined;

  const isIdFilter = filterFieldId === 'id';
  if ((args.matchById || isIdFilter) && typeof filterValue === 'string') {
    const byId = await loadRecordById(supabase, targetModelId, filterValue);
    if (byId) return byId;
  }
  // Records do not carry their own id inside `data`, so there is nothing for a
  // field scan to find — and no reason to pull the whole model to learn that.
  if (isIdFilter) return undefined;

  const all = await args.loadAll();
  return all.find((r) => r.data[filterFieldId] === filterValue);
}
