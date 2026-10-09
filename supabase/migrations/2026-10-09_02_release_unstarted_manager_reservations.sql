-- 2026-10-09 — follow-up to 2026-10-09_01_remove_manager_content_approval.
--
-- 01 released the manager's booked capacity for items it re-pinned, but the
-- planner also holds reservations for work that is planned and NOT YET
-- materialised (no content_id, no row_id — a cycle slot waiting for its
-- production_start). Those items will be created on the newest path, which has
-- no manager step, so their writing_review / design_review bookings would sit
-- in the manager's calendar forever as phantom load. Release them.
--
-- Bookings tied to an item still pinned to an older path (the three sitting at
-- the manager's final approval right now) are left alone.

BEGIN;

UPDATE public.mos_task_reservations
   SET status = 'released', updated_at = now()
 WHERE role_key = 'marketing_manager'
   AND step_key IN ('writing_review', 'design_review', 'idea_review', 'script_review', 'review')
   AND status = 'reserved'
   AND superseded_at IS NULL
   AND content_id IS NULL
   AND row_id IS NULL;

COMMIT;
