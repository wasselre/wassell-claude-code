-- Let the portal auto-register sweep record a lead it could NOT run because
-- nobody owns it (no client_owner, and the portal signs in as no CRM user).
--
-- Until now that case was only console.error-ed: no row, nothing in the
-- client's portal history, so a lead could silently never reach the portal
-- (caught 2026-09-28 on a hand-created ad lead). The sweep now writes ONE
-- failed row per (client, portal) with result.skip_reason = 'no_owner' and
-- user_id NULL — there is no user to put there, which is the whole point.
--
-- Safe for existing readers:
--   * the worker only claims status='queued' rows; these are born 'failed';
--   * cancel / submit_input compare user_id = caller, so a NULL row matches no one;
--   * RLS owner_select (user_id = auth.uid()) hides it from browser reads, and
--     the history the chat card shows is read server-side by client_record_id.
-- Backward compatible: dropping a NOT NULL never breaks the deployed code.

BEGIN;

ALTER TABLE public.portal_registration_jobs ALTER COLUMN user_id DROP NOT NULL;

-- Only the no-owner marker may leave user_id empty; every real run still needs one.
ALTER TABLE public.portal_registration_jobs
  DROP CONSTRAINT IF EXISTS portal_registration_jobs_user_required;
ALTER TABLE public.portal_registration_jobs
  ADD CONSTRAINT portal_registration_jobs_user_required
  CHECK (user_id IS NOT NULL OR (status = 'failed' AND result->>'skip_reason' = 'no_owner'));

COMMIT;
