-- ============================================================================
-- workflows.trigger_event check constraint: add 'on_due' + 'button_click'
-- (2026-05-11)
--
-- The constraint pre-dated both events. Without this update, the new
-- on_due workflow (driven by /api/sweep-due-followups every 5 min)
-- couldn't be persisted — INSERT raised SQLSTATE 23514. Same for
-- button_click, which had been live in the TypeScript types for a
-- while but never got its DB-side validation.
--
-- Drop + recreate the constraint with the full enum.
-- ============================================================================

ALTER TABLE public.workflows
  DROP CONSTRAINT IF EXISTS workflows_trigger_event_check;

ALTER TABLE public.workflows
  ADD CONSTRAINT workflows_trigger_event_check
  CHECK (trigger_event = ANY (ARRAY[
    'create'::text,
    'update'::text,
    'delete'::text,
    'webhook'::text,
    'button_click'::text,
    'on_due'::text
  ]));
