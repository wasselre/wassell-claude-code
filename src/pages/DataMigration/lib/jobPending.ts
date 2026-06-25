// ── In-flight marker for the migration wizard's Realtime-independent poll ─────
//
// The file-heavy AI steps (plan / discuss / extract) run on the Fly worker; the
// SPA learns the result ONLY through Supabase Realtime. When the Realtime socket
// isn't reaching a browser (a corporate proxy / firewall blocking wss://, or a
// silently dropped socket), the wizard would sit forever on a spinner that has
// already stopped — the job finishes and persists, but the tab never sees it.
//
// The wizard (MigrationWizard.tsx) falls back to polling the record, but ONLY
// while a job is plausibly running, so the per-request cost stays negligible
// (the poll is READ-ONLY — see appStore.refreshRecordById — and so cannot touch
// the record_save conflict-storm machinery; docs/conflict-storm-hardening.md).
//
// `prep_busy` / `discuss_busy` / `status='extracting'` are set SERVER-SIDE and
// arrive via the very Realtime channel that may be down — so the busy flags
// alone can't tell the poll to start. This local marker, stamped the moment a
// worker job is ENQUEUED (in client.ts), bridges the gap between enqueue and the
// first server ack the poll pulls. It self-expires so a never-acked enqueue
// can't keep polling forever.
//
// Standalone module (no imports) to avoid a client.ts ⇄ jobRunner.ts cycle —
// client.ts already imports jobRunner indirectly via the enqueue helpers.

const jobEnqueuedAt = new Map<string, number>();

/** Worker plan/discuss turns settle well under this; extraction can run longer,
 * but once the poll observes `status='extracting'` / a busy flag it keeps going
 * on that signal — this TTL is only the pre-ack bridge window. */
const PENDING_TTL_MS = 8 * 60_000;

/** Mark that a worker job was just enqueued for this record (starts the poll). */
export function markMigrationJobEnqueued(recordId: string): void {
  jobEnqueuedAt.set(recordId, Date.now());
}

/** Whether a worker job was enqueued for this record recently enough that the
 * wizard should keep polling for its result even if Realtime is silent. */
export function isMigrationJobPending(recordId: string): boolean {
  const at = jobEnqueuedAt.get(recordId);
  if (at == null) return false;
  if (Date.now() - at > PENDING_TTL_MS) {
    jobEnqueuedAt.delete(recordId);
    return false;
  }
  return true;
}

/** Clear the in-flight marker — called once the poll has observed the job land
 * (or the wizard reaches a terminal state), so polling stops promptly. */
export function clearMigrationJobPending(recordId: string): void {
  jobEnqueuedAt.delete(recordId);
}
