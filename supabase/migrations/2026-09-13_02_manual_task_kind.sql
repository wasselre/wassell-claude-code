-- ============================================================================
-- Caption review is a TASK in «مهامي» (2026-09-13)
-- ----------------------------------------------------------------------------
-- The Meta-ad caption the worker parks for approval used to be visible only
-- inside the creative's Placements tab. The operator: "this task should act
-- like the rest of the tasks when they appear in my task list". So the worker
-- now opens a hand-assigned task (mos_manual_tasks) for the approver when a
-- caption is parked, and the approval closes it. Two columns tell a system
-- task from a person's coordination task:
--   kind   — 'manual' (default, every existing row) | 'caption_review'
--   ref_id — the mos_execution_ads row the caption lives on (one open task per
--            ad row; the worker upserts on retry/rewrite).
-- The guard trigger (mos_tg_manual_task_guard) does not reference these
-- columns; service-role writes bypass it anyway (auth.uid() IS NULL).
-- Idempotent.
-- ============================================================================

ALTER TABLE public.mos_manual_tasks
  ADD COLUMN IF NOT EXISTS kind   text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS ref_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_manual_tasks_kind_check') THEN
    ALTER TABLE public.mos_manual_tasks ADD CONSTRAINT mos_manual_tasks_kind_check
      CHECK (kind IN ('manual', 'caption_review'));
  END IF;
END $$;

-- One OPEN system task per referenced row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_manual_tasks_open_ref
  ON public.mos_manual_tasks (kind, ref_id)
  WHERE status = 'open' AND ref_id IS NOT NULL;
