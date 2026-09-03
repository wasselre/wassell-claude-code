-- Deleting a mos_content row must also close the tasks attached to it.
--
-- The task→content link is POLYMORPHIC (workflow_role_tasks.subject_table +
-- subject_id), so there is NO foreign key to cascade. Before this migration,
-- deleting a content item hard-deleted the mos_content row but left its open
-- workflow tasks dangling as orphans (subject_id pointing at a gone row, status
-- still 'open'). Those orphans kept inflating the Performance desk "load vs
-- capacity" panel — e.g. deleted videos still counted in the writer/montage
-- video columns, and in the weekly production tally. The 2026-08-30 SLA
-- migration cleaned the orphan batch that existed then, but nothing stopped new
-- deletions from re-creating them (measured 2026-09-03: 27 orphan open tasks,
-- 24 of them video, from recently-deleted video content).
--
-- Fix, two parts:
--   1. Close the CURRENT orphan tasks (content row already gone).
--   2. An AFTER DELETE trigger on mos_content that closes a row's open tasks
--      whenever it is deleted, by ANY path (API button, bulk delete, manual SQL).

BEGIN;

-- 1a. Drop pending/disputed discipline fallout tied to orphan workflow tasks —
--     an orphan can never be worked or closed by a human, so a late flag on it is
--     noise. Same posture as the 2026-08-30 cleanup. Approved decisions are left
--     alone.
DELETE FROM public.mos_discipline_actions da
 USING public.mos_late_events le
 WHERE da.late_event_id = le.id
   AND da.status IN ('pending', 'disputed')
   AND le.task_source = 'workflow'
   AND le.task_id IN (
     SELECT t.id FROM public.workflow_role_tasks t
      WHERE t.status = 'open' AND t.subject_table = 'mos_content'
        AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id));

DELETE FROM public.mos_late_events le
 WHERE le.task_source = 'workflow'
   AND le.task_id IN (
     SELECT t.id FROM public.workflow_role_tasks t
      WHERE t.status = 'open' AND t.subject_table = 'mos_content'
        AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id));

-- 1b. Close the orphan tasks: workflow tasks → 'skipped', manual → 'cancelled'.
UPDATE public.workflow_role_tasks t
   SET status = 'skipped', late_flag = false, closed_at = now(), updated_at = now()
 WHERE t.status = 'open' AND t.subject_table = 'mos_content'
   AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id);

UPDATE public.mos_manual_tasks m
   SET status = 'cancelled', late_flag = false, closed_at = now(), updated_at = now()
 WHERE m.status = 'open' AND m.content_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = m.content_id);

-- 2. Permanent guard: close a content row's open tasks the moment it is deleted.
--    SECURITY DEFINER so the close succeeds regardless of the deleter's RLS on
--    the task tables (the deleter already passed mos_content's delete policy).
CREATE OR REPLACE FUNCTION public.mos_tg_content_delete_close_tasks()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.workflow_role_tasks
     SET status = 'skipped', late_flag = false, closed_at = now(), updated_at = now()
   WHERE subject_table = 'mos_content' AND subject_id = OLD.id AND status = 'open';

  UPDATE public.mos_manual_tasks
     SET status = 'cancelled', late_flag = false, closed_at = now(), updated_at = now()
   WHERE content_id = OLD.id AND status = 'open';

  RETURN OLD;
END $$;

REVOKE ALL ON FUNCTION public.mos_tg_content_delete_close_tasks() FROM PUBLIC;

DROP TRIGGER IF EXISTS mos_content_delete_close_tasks_tg ON public.mos_content;
CREATE TRIGGER mos_content_delete_close_tasks_tg
  AFTER DELETE ON public.mos_content
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_content_delete_close_tasks();

COMMIT;
