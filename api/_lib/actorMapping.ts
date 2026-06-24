/**
 * Map a workflow job's actor — the raw `auth.uid()` the capture trigger stamps
 * into `workflow_jobs.actor_user_id` — to the `public.users.id` that
 * `records.created_by_user_id` FKs to, and that user-reference fields
 * (assignee, `current_user`) store.
 *
 * The link is `public.users.auth_uid = actorAuthUserId`.
 *
 *   - null/undefined actor (service-role / cron / webhook) → null
 *   - an auth.uid with NO matching public.users row        → null
 *
 * A null result is intentional and must NEVER fail the workflow: the record is
 * still created with `created_by = null` (the caller logs a missing mapping
 * loudly so it's visible, but proceeds).
 */
export function resolveActorPublicUserId(
  actorAuthUserId: string | null | undefined,
  users: ReadonlyArray<{ id: string; auth_uid?: string | null }>,
): string | null {
  if (!actorAuthUserId) return null;
  return users.find((u) => u.auth_uid === actorAuthUserId)?.id ?? null;
}
