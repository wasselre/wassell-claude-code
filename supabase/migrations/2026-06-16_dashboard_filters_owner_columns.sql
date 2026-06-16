-- Phase A analytics builder: dashboards gained two top-level fields on the
-- Dashboard type — `filters` (dashboard-level global filter controls) and
-- `owner_user_id`. The SPA's saveDashboard upserts the whole object, so without
-- these columns the write fails with
--   "Could not find the 'filters' column of 'dashboards' in the schema cache"
-- and the change is queued/lost. (Snapshots live inside the existing `widgets`
-- JSONB, so they need no column.)
--
-- Applied to wassell-prod 2026-06-16 via the Supabase MCP; recorded here so
-- branches / restores / fresh installs get it. Idempotent.

ALTER TABLE public.dashboards ADD COLUMN IF NOT EXISTS filters JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.dashboards ADD COLUMN IF NOT EXISTS owner_user_id UUID;
