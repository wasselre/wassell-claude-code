-- ============================================================================
-- sales_process_overrides — add manager-editable Call Guidance (script) columns.
--
-- The base table (2026-06-17_sales_process_overrides.sql) let managers override
-- only a follow-up type's objective (the "Goal" in the Workspace mission header).
-- These two columns extend the same row so managers can ALSO edit the call/
-- message guidance bullets the rep sees in the Workspace "Call Guidance"
-- (إرشادات المكالمة) panel — the same field as FollowUpTypeConfig.script.
--
-- Stored as newline-separated text: ONE guidance bullet per line. A null/blank
-- value falls back to the hardcoded default script in
-- src/lib/salesProcess/config.ts (parseScriptOverride + applyOverridesToConfig),
-- so a partial override never blanks the guidance. Same RLS as the base table
-- (all-authenticated read, admin-only write) — no policy change needed.
-- ============================================================================

ALTER TABLE public.sales_process_overrides
  ADD COLUMN IF NOT EXISTS script_ar text,
  ADD COLUMN IF NOT EXISTS script_en text;
