-- Per-profile access to the custom (non-model) Sales Operations pages.
--
-- Sales Tasks, Sales Process (Studio) and Sales Manager are React pages, not
-- models, so they can't be gated through the per-model `model_permissions`
-- matrix. This adds a `page_access` map on `profiles` that holds explicit
-- per-page on/off overrides. A page id ABSENT from the map falls back to the
-- page's `default_access` defined in `src/lib/customPages.ts`:
--   sales_tasks   → 'all'   (visible to everyone unless revoked)
--   sales_process → 'admin' (admin-only unless granted)
--   sales_manager → 'admin' (admin-only unless granted)
-- Admin profiles see every page regardless. Default '{}' = no overrides, so
-- every existing profile keeps the exact pre-change behavior.
--
-- Additive + idempotent. Safe to run on prod before the frontend deploy — the
-- column simply sits unused until the new build (which sends `page_access` on
-- every profile save) goes live.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS page_access JSONB NOT NULL DEFAULT '{}'::jsonb;
