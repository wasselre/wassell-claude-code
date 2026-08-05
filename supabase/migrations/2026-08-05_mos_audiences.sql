-- Marketing OS — the campaign brief's «الجمهور» becomes a SAVED, REUSABLE record.
--
-- Before: `mos_campaigns.audience` was a free-text one-liner typed fresh on every
-- campaign. Now it is picked from a managed registry (`mos_audiences`) — a title
-- (the audience name) plus a large details field — OR defined inline on the brief,
-- which persists it so the next campaign can reuse it and it shows in
-- Settings → Audiences.
--
-- Same "managed registry + snapshot" posture as `mos_measure_types`
-- (2026-08-04_mos_success_measures.sql):
--   * `mos_audiences` — the reusable records (name + details).
--   * `mos_campaigns.audience_id` — a nullable FK to the chosen record.
--   * `mos_campaigns.audience` (text, KEPT) — the audience NAME is snapshotted here
--     on every save, so every existing read surface (the brief read grid, search's
--     `audience` match_reason, list/overview) keeps rendering a concise label with
--     NO join and NO history rewrite when a record is later renamed/archived.
--
-- Back-compat: legacy campaigns that carry a free-text `audience` with no
-- `audience_id` keep showing that text until someone edits the brief and picks or
-- creates a saved audience. Nothing is dropped.
--
-- Additive, idempotent (safe to re-run).

BEGIN;

/* ------------------------------------------------------------------ */
/* 1. The managed audiences registry.                                 */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public."mos_audiences" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  -- The audience's short name/title (e.g. «مستثمرون خارج الرياض»). Free text,
  -- single-language — the same posture as the brief's goal/offer fields, which are
  -- rendered through the on-demand translation overlay, not stored bilingually.
  "name" text NOT NULL,
  -- The large details field — who they are, why they buy, what moves them.
  "details" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  -- Deactivating is hide-not-erase (same as measure types / content types):
  -- is_active flips off, the row stays, and campaigns keep their snapshot.
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at" timestamp with time zone,
  CONSTRAINT "mos_audiences_pkey" PRIMARY KEY (id)
);

-- RLS mirrors mos_measure_types exactly: anyone who can READ the workspace sees
-- the list; only manage_settings can create/edit/deactivate.
ALTER TABLE public."mos_audiences" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mos_audiences_read" ON public."mos_audiences";
CREATE POLICY "mos_audiences_read" ON public."mos_audiences" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (wassell_mos_can('read'::text));
DROP POLICY IF EXISTS "mos_audiences_ins" ON public."mos_audiences";
CREATE POLICY "mos_audiences_ins" ON public."mos_audiences" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (wassell_mos_can('manage_settings'::text));
DROP POLICY IF EXISTS "mos_audiences_upd" ON public."mos_audiences";
CREATE POLICY "mos_audiences_upd" ON public."mos_audiences" AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING (wassell_mos_can('manage_settings'::text))
  WITH CHECK (wassell_mos_can('manage_settings'::text));
DROP POLICY IF EXISTS "mos_audiences_del" ON public."mos_audiences";
CREATE POLICY "mos_audiences_del" ON public."mos_audiences" AS PERMISSIVE FOR DELETE TO "authenticated"
  USING (wassell_mos_can('manage_settings'::text));

GRANT SELECT, INSERT, UPDATE, DELETE ON public."mos_audiences" TO "authenticated";
GRANT SELECT ON public."mos_audiences" TO "anon";
GRANT ALL ON public."mos_audiences" TO "service_role";

/* ------------------------------------------------------------------ */
/* 2. The campaign's link to a saved audience.                        */
/* ------------------------------------------------------------------ */

-- Nullable: a legacy free-text audience has no id, and clearing the field is
-- allowed. ON DELETE SET NULL so hard-deleting a record (rare — the UI archives)
-- never orphans a campaign; the snapshotted `audience` text label survives.
ALTER TABLE public.mos_campaigns
  ADD COLUMN IF NOT EXISTS audience_id uuid
    REFERENCES public.mos_audiences(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS mos_campaigns_audience_id_idx
  ON public.mos_campaigns (audience_id);

COMMIT;
