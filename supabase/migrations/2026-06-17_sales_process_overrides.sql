-- ============================================================================
-- sales_process_overrides — manager-editable follow-up instruction text.
--
-- Each row overrides ONE follow-up type's objective (the "Goal" the rep sees in
-- the Follow-up Workspace mission header). `id` = the follow-up type key
-- (e.g. 'appointment_booking_call'). applyOverridesToConfig() in
-- src/lib/salesProcess/config.ts merges these over DEFAULT_SALES_PROCESS — a
-- null/blank field falls back to the hardcoded default, so a partial override
-- never blanks the instruction.
--
-- Loaded by the SPA store (the salesProcessOverrides slice) for ALL
-- authenticated users (reps must see the manager's edits); written only by
-- admins from the admin-only Sales Manager page. Mirrors the scheduled_reports
-- slice's load + upsert posture exactly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sales_process_overrides (
  id           text PRIMARY KEY,         -- follow-up type key
  objective_ar text,
  objective_en text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sales_process_overrides ENABLE ROW LEVEL SECURITY;

-- Everyone authenticated reads (reps see the instructions in the Workspace).
DROP POLICY IF EXISTS sales_process_overrides_select ON public.sales_process_overrides;
CREATE POLICY sales_process_overrides_select ON public.sales_process_overrides
  FOR SELECT TO authenticated USING (true);

-- Only admins write (the Sales Manager page is admin-only; RLS is the gate).
DROP POLICY IF EXISTS sales_process_overrides_write ON public.sales_process_overrides;
CREATE POLICY sales_process_overrides_write ON public.sales_process_overrides
  FOR ALL TO authenticated
  USING (public.wassell_is_admin(auth.uid()))
  WITH CHECK (public.wassell_is_admin(auth.uid()));
