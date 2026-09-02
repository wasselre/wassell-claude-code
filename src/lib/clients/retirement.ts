import type { AppRecord } from '@/types';

/**
 * Client retirement — the single source of truth for "is this client retired?"
 * and the filters that exclude retired clients from lists and counts.
 *
 * A retired client is NOT deleted — it keeps all its data and relationships. It
 * is merely hidden from every client list and excluded from every "number of
 * clients" metric, until the client contacts us again (an inbound WhatsApp
 * message auto-un-retires them via a DB trigger — see
 * `2026-09-08_03_client_auto_unretire_trigger.sql`).
 *
 * The flag lives in the (unfrozen) clients record JSONB as `data.is_retired`,
 * with `data.retired_at` (ISO) and `data.retired_reason` for provenance. These
 * three slugs are action-driven, not free-form form fields — they're listed in
 * `DERIVED_READONLY_SLUGS` (clientView.ts) so the Preferences editor never
 * exposes them.
 */

/** Reason stamped on the one-time bulk retirement of pre-Aug-2026 clients. */
export const BULK_PRE_AUG_REASON = 'pre_aug_2026_bulk';
/** Reason stamped when an operator retires a client by hand. */
export const MANUAL_RETIRE_REASON = 'manual';

/** True when the record carries the retirement flag. Safe on a sparse record. */
export function isRetiredClient(rec: Pick<AppRecord, 'data'> | null | undefined): boolean {
  if (!rec || !rec.data) return false;
  return (rec.data as Record<string, unknown>).is_retired === true;
}

/** Every client record that is NOT retired. Retired clients keep loading in the
 *  store (so the detail page + un-retire + a "show retired" toggle work) — this
 *  is the view-layer filter every count/list applies. */
export function activeClientsOnly<T extends Pick<AppRecord, 'data'>>(recs: readonly T[]): T[] {
  return recs.filter((r) => !isRetiredClient(r));
}

/** The set of retired client record ids (for filtering related records, e.g. a
 *  retired client's follow-ups out of manager metrics). */
export function retiredClientIdSet(recs: readonly AppRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of recs) if (isRetiredClient(r)) out.add(r.id);
  return out;
}
