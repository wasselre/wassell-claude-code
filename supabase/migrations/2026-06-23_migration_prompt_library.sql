-- Migration: prompt library for the Data Migration prep step.
-- A small SHARED library of reusable extraction-instruction templates the
-- operator can pick from (or save the current instructions into) before
-- starting an AI analysis. Stored server-side (the browser's localStorage is an
-- unreliable, per-device cache); readable by everyone, editable by the author.

BEGIN;

CREATE TABLE IF NOT EXISTS public.migration_prompts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label              text NOT NULL,
  body               text NOT NULL,
  created_by_user_id uuid,                       -- = auth.uid() of the author
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.migration_prompts ENABLE ROW LEVEL SECURITY;

-- Shared library: everyone signed in can read + use the templates.
DROP POLICY IF EXISTS migration_prompts_select ON public.migration_prompts;
CREATE POLICY migration_prompts_select ON public.migration_prompts
  FOR SELECT TO authenticated USING (true);

-- Anyone can add a template, stamped with their own id.
DROP POLICY IF EXISTS migration_prompts_insert ON public.migration_prompts;
CREATE POLICY migration_prompts_insert ON public.migration_prompts
  FOR INSERT TO authenticated WITH CHECK (created_by_user_id = auth.uid());

-- Only the author edits/deletes their own template.
DROP POLICY IF EXISTS migration_prompts_update ON public.migration_prompts;
CREATE POLICY migration_prompts_update ON public.migration_prompts
  FOR UPDATE TO authenticated
  USING (created_by_user_id = auth.uid())
  WITH CHECK (created_by_user_id = auth.uid());

DROP POLICY IF EXISTS migration_prompts_delete ON public.migration_prompts;
CREATE POLICY migration_prompts_delete ON public.migration_prompts
  FOR DELETE TO authenticated USING (created_by_user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.migration_prompts TO authenticated;

COMMIT;
