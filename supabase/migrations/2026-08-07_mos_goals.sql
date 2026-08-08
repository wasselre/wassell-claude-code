-- Marketing OS — GOALS: a lightweight, managed registry of marketing goals, and
-- a many-to-many link from every campaign to one or more of them.
--
-- The design decision (2026-08-07): a Goal is SIMPLE — a name plus a description
-- (same single-language, translation-overlay posture as the brief's goal/offer
-- fields and `mos_audiences`). Its whole job is to GROUP campaigns under a shared
-- objective, so the spend side can answer «أي حملات تخدم هذا الهدف؟». Every
-- campaign links to AT LEAST ONE goal (enforced on create in the API/UI), and a
-- campaign may serve several goals at once — hence a junction, not a column.
--
-- Storage/RLS mirror `mos_audiences` (2026-08-05) exactly:
--   * `mos_goals` — the reusable records (name + description).
--   * `mos_campaign_goals` — the (campaign_id, goal_id) links.
-- Reads open to anyone who can READ the workspace; goal writes and campaign↔goal
-- links gated by `approve_budget` (the SAME capability that gates writing a
-- campaign — see mos_campaigns_write), so anyone who can create/edit a campaign
-- can create a goal and attach it.
--
-- Additive, idempotent (safe to re-run).

BEGIN;

/* ------------------------------------------------------------------ */
/* 1. The managed goals registry.                                     */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public."mos_goals" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  -- The goal's short name/title (e.g. «إطلاق مينا ٥٢» أو «نمو مؤهلي الرياض»).
  -- Free text, single-language — rendered through the on-demand translation
  -- overlay at read time, not stored bilingually.
  "name" text NOT NULL,
  -- The larger description — what the goal is, why it matters, how we know it is met.
  "description" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  -- Deactivating is hide-not-erase (same as audiences / measure types):
  -- is_active flips off, the row stays, and existing campaign links survive.
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at" timestamp with time zone,
  CONSTRAINT "mos_goals_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."mos_goals" ENABLE ROW LEVEL SECURITY;

-- Anyone who can READ the workspace sees the goals (the campaign brief must list
-- them for every role that can create a campaign). Writes gated by approve_budget
-- — the same capability that gates writing a campaign.
DROP POLICY IF EXISTS "mos_goals_read" ON public."mos_goals";
CREATE POLICY "mos_goals_read" ON public."mos_goals" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (wassell_mos_can('read'::text));
DROP POLICY IF EXISTS "mos_goals_ins" ON public."mos_goals";
CREATE POLICY "mos_goals_ins" ON public."mos_goals" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (wassell_mos_can('approve_budget'::text));
DROP POLICY IF EXISTS "mos_goals_upd" ON public."mos_goals";
CREATE POLICY "mos_goals_upd" ON public."mos_goals" AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING (wassell_mos_can('approve_budget'::text))
  WITH CHECK (wassell_mos_can('approve_budget'::text));
DROP POLICY IF EXISTS "mos_goals_del" ON public."mos_goals";
CREATE POLICY "mos_goals_del" ON public."mos_goals" AS PERMISSIVE FOR DELETE TO "authenticated"
  USING (wassell_mos_can('approve_budget'::text));

GRANT SELECT, INSERT, UPDATE, DELETE ON public."mos_goals" TO "authenticated";
GRANT SELECT ON public."mos_goals" TO "anon";
GRANT ALL ON public."mos_goals" TO "service_role";

/* ------------------------------------------------------------------ */
/* 2. The campaign ↔ goal links (many-to-many).                       */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public."mos_campaign_goals" (
  "campaign_id" uuid NOT NULL REFERENCES public.mos_campaigns(id) ON DELETE CASCADE,
  "goal_id" uuid NOT NULL REFERENCES public.mos_goals(id) ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mos_campaign_goals_pkey" PRIMARY KEY (campaign_id, goal_id)
);

CREATE INDEX IF NOT EXISTS mos_campaign_goals_goal_id_idx
  ON public.mos_campaign_goals (goal_id);

ALTER TABLE public."mos_campaign_goals" ENABLE ROW LEVEL SECURITY;

-- Read with the workspace; link/unlink gated by approve_budget (the campaign
-- write capability). No per-row parent join in the policy — the campaign's own
-- RLS already governs who can see/edit it, and a link carries no data beyond
-- the two ids, so gating on the capability is sufficient and index-friendly.
DROP POLICY IF EXISTS "mos_campaign_goals_read" ON public."mos_campaign_goals";
CREATE POLICY "mos_campaign_goals_read" ON public."mos_campaign_goals" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (wassell_mos_can('read'::text));
DROP POLICY IF EXISTS "mos_campaign_goals_ins" ON public."mos_campaign_goals";
CREATE POLICY "mos_campaign_goals_ins" ON public."mos_campaign_goals" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (wassell_mos_can('approve_budget'::text));
DROP POLICY IF EXISTS "mos_campaign_goals_del" ON public."mos_campaign_goals";
CREATE POLICY "mos_campaign_goals_del" ON public."mos_campaign_goals" AS PERMISSIVE FOR DELETE TO "authenticated"
  USING (wassell_mos_can('approve_budget'::text));

GRANT SELECT, INSERT, UPDATE, DELETE ON public."mos_campaign_goals" TO "authenticated";
GRANT SELECT ON public."mos_campaign_goals" TO "anon";
GRANT ALL ON public."mos_campaign_goals" TO "service_role";

/* ------------------------------------------------------------------ */
/* 3. The Goals rail surface — visible per the roles matrix.          */
/* ------------------------------------------------------------------ */

-- Seed surface_access for the new 'goals' surface, transcribed to match the
-- Spend group's posture: the CEO and marketing manager see it fully (strategy),
-- the ops supervisor reads it, the writer and montage never see it. Absence of a
-- row already means hidden (computeSurfaces), so writer/montage are simply omitted.
INSERT INTO public.surface_access (role_id, surface_key, level)
SELECT r.id, 'goals', u.lvl
  FROM (VALUES
    ('mos_ceo',               'full'),
    ('mos_marketing_manager', 'full'),
    ('mos_ops_supervisor',    'read')
  ) AS u(role_key, lvl)
  JOIN public.roles r ON r.key = u.role_key
ON CONFLICT (role_id, surface_key) DO NOTHING;

COMMIT;
