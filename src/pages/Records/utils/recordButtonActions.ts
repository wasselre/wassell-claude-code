import { supabase } from '@/lib/supabase';
import type {
  AppRecord,
  CustomButtonActionCreateRecord,
  CustomButtonActionFindOrCreateRecord,
  CustomButtonFieldMap,
} from '@/types';

/**
 * Helpers for the `create_record` and `find_or_create_record` custom-button
 * actions wired up in `RecordFormPage.handleCustomButtonClick`. Kept in their
 * own module so the page file doesn't grow another 100-line block, and so the
 * search query is unit-testable without mounting React.
 *
 * Reads go through the `unified_records` view (UNION over `records` +
 * `<frozen>_v` views) so the right rows are returned whether the target
 * model is currently frozen or not. Per CLAUDE.md "Silent Failures" rules,
 * Supabase errors are surfaced — never swallowed.
 */

/**
 * Build the `prefill` map a button action wants applied to a new target
 * record. Iterates the `prefill` field-mappings and copies values from the
 * trigger record's data into a fresh map keyed by target slug. Missing
 * source values are skipped (don't write `undefined` to the map) so the
 * target form treats the slot as empty rather than as a string-cast
 * "undefined".
 *
 * Pure — exposed for tests.
 */
export function buildPrefill(
  mapping: CustomButtonFieldMap[] | undefined,
  triggerData: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!mapping) return out;
  for (const m of mapping) {
    const v = triggerData[m.source_field_name];
    if (v === undefined || v === null || v === '') continue;
    out[m.target_field_name] = v;
  }
  return out;
}

/**
 * Find the latest matching record in the target model for a
 * `find_or_create_record` button. Returns `null` when nothing matches OR
 * when a search criterion has no value on the trigger record (we don't
 * "find any record" — we find one that matches the user's current
 * context). Returns `null` AND surfaces a Supabase error on query failure
 * so the caller can fall back to a blank-create flow without confusing the
 * user with a green-light "found a match" state.
 *
 * Equality-only by design: the action's `search_by` array is AND-joined
 * across `data->>field = value`. Lookup-id comparisons use the stored UUID
 * string. Not intended for fuzzy search — the visits-model use case is
 * "find the latest visit for this client_id" which is exact-match.
 */
export async function findLatestMatch(
  action: CustomButtonActionFindOrCreateRecord,
  triggerData: Record<string, unknown>,
  reportError: (msg: string) => void,
): Promise<AppRecord | null> {
  if (!supabase) return null;
  if (action.search_by.length === 0) return null;

  // If any criterion's source value is empty, we have no context to find
  // by — treat as "no match" so the caller falls through to create.
  for (const m of action.search_by) {
    const v = triggerData[m.source_field_name];
    if (v === undefined || v === null || v === '') return null;
  }

  let q = supabase
    .from('unified_records')
    .select('*')
    .eq('model_id', action.target_model_id);

  for (const m of action.search_by) {
    const raw = triggerData[m.source_field_name];
    // .eq on JSONB-arrow text. Stringify scalars; arrays / objects are
    // not supported as criteria in v1 (no use case yet).
    q = q.eq(`data->>${m.target_field_name}`, String(raw));
  }

  const orderColumn = action.order_by === 'updated_at_desc' ? 'updated_at' : 'created_at';
  const { data, error } = await q.order(orderColumn, { ascending: false }).limit(1);

  if (error) {
    reportError(error.message ?? String(error));
    return null;
  }
  if (!data || data.length === 0) return null;
  return data[0] as AppRecord;
}

/**
 * Convenience wrapper used by `create_record`: just builds the prefill map
 * from the action's spec. Kept as a thin function so the page-side dispatch
 * reads symmetrically (`buildCreatePrefill` / `findLatestMatch`).
 */
export function buildCreatePrefill(
  action: CustomButtonActionCreateRecord,
  triggerData: Record<string, unknown>,
): Record<string, unknown> {
  return buildPrefill(action.prefill, triggerData);
}
