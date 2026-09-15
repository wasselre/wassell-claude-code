-- ════════════════════════════════════════════════════════════════════════════
-- Group A of the monthly-operating-model build plan — the data model.
--
--   A1  mos_content_rows — the row as a real workflow subject
--   A2  RLS widened to the row subject (a row task was invisible to browsers)
--   A3  a reservation can name a row, and exactly one subject
--   A4  a same-day effort spread (a row is three slots on ONE day)
--   A5  per-step effort for posts deleted (it double-counted the designer)
--   A6  the manager uncapped
--   A7  mos_month_notes, keyed on the template coordinate, lane-aware (D7)
--   A8  mos_month_template, incl. the Saturday topic bank
--   A8b the general row: mos_content_rows.project_id is nullable
--   A9  feed/story on mos_publications, and room for the pair in the unique key
--   A10 the video content type gains a caption field
--   C2  (data half) the manager's daily_new_tasks was 0, so EVERY approval task
--       opened unassigned — the thing blocking a person-keyed queue
--
-- Rationale for each is in docs/plans/monthly-operating-model-build.md §4.
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A1. the row as a real subject ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mos_content_rows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid REFERENCES public.mos_campaigns(id) ON DELETE SET NULL,
  -- NULLABLE on purpose (A8b): the Saturday general row belongs to no project.
  project_id          uuid,
  plan_id             uuid,
  kind                text NOT NULL CHECK (kind IN ('organic_row','paid_batch','general_row')),
  batch_day           date,
  -- Its OWN pinned version: workflow_advance_role_path reads the step
  -- definition off the SUBJECT, and a row has no mos_content to read it from.
  workflow_version_id uuid REFERENCES public.workflow_versions(id),
  row_key             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_content_rows_key
  ON public.mos_content_rows (row_key) WHERE row_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_mos_content_rows_batch
  ON public.mos_content_rows (batch_day, kind);

ALTER TABLE public.mos_content ADD COLUMN IF NOT EXISTS row_id uuid
  REFERENCES public.mos_content_rows(id) ON DELETE SET NULL;
-- The writer's reading order. Publish order is its REVERSE: Instagram shows
-- newest first, so the post placed first must go out last.
ALTER TABLE public.mos_content ADD COLUMN IF NOT EXISTS row_order int;
CREATE INDEX IF NOT EXISTS ix_mos_content_row ON public.mos_content (row_id, row_order);

-- ── A2. RLS — a row task must be visible to a browser session ─────────────
-- All four policies pinned subject_table to 'mos_content', so a row task the
-- SECURITY DEFINER functions create perfectly would be invisible to every
-- session: an empty queue, not an error. workflow_role_tasks_upd_own had no
-- subject clause at all, letting a person update a row task they cannot read.
DROP POLICY IF EXISTS workflow_role_tasks_read    ON public.workflow_role_tasks;
DROP POLICY IF EXISTS workflow_role_tasks_ins     ON public.workflow_role_tasks;
DROP POLICY IF EXISTS workflow_role_tasks_upd     ON public.workflow_role_tasks;
DROP POLICY IF EXISTS workflow_role_tasks_del     ON public.workflow_role_tasks;
DROP POLICY IF EXISTS workflow_role_tasks_upd_own ON public.workflow_role_tasks;

CREATE POLICY workflow_role_tasks_read ON public.workflow_role_tasks FOR SELECT
  USING (wassell_mos_can('read') AND subject_table IN ('mos_content','mos_content_rows'));
CREATE POLICY workflow_role_tasks_ins ON public.workflow_role_tasks FOR INSERT
  WITH CHECK (wassell_mos_can('assign') AND subject_table IN ('mos_content','mos_content_rows'));
CREATE POLICY workflow_role_tasks_upd ON public.workflow_role_tasks FOR UPDATE
  USING      (wassell_mos_can('assign') AND subject_table IN ('mos_content','mos_content_rows'))
  WITH CHECK (wassell_mos_can('assign') AND subject_table IN ('mos_content','mos_content_rows'));
CREATE POLICY workflow_role_tasks_del ON public.workflow_role_tasks FOR DELETE
  USING (wassell_mos_can('assign') AND subject_table IN ('mos_content','mos_content_rows'));
CREATE POLICY workflow_role_tasks_upd_own ON public.workflow_role_tasks FOR UPDATE
  USING      (assignee_user_id = wassell_app_user_id(auth.uid())
              AND subject_table IN ('mos_content','mos_content_rows'))
  WITH CHECK (assignee_user_id = wassell_app_user_id(auth.uid())
              AND subject_table IN ('mos_content','mos_content_rows'));

-- ── A3. a reservation names a row, and exactly one subject ────────────────
ALTER TABLE public.mos_task_reservations ADD COLUMN IF NOT EXISTS row_id uuid
  REFERENCES public.mos_content_rows(id) ON DELETE CASCADE;

ALTER TABLE public.mos_task_reservations
  DROP CONSTRAINT IF EXISTS mos_task_reservations_one_subject;
ALTER TABLE public.mos_task_reservations
  ADD CONSTRAINT mos_task_reservations_one_subject
  CHECK (num_nonnulls(content_id, row_id) = 1) NOT VALID;

-- ── A4. the same-day spread ───────────────────────────────────────────────
-- mos_spread_effort turns N into 1.0 on each of N working days, so a row of
-- weight 3 reserved one slot on each of three days — the opposite of a row.
-- ADDED rather than substituted. The JS twin effortWeightsSameDay() in
-- src/lib/marketingOS/scheduling/ledger.ts must agree EXACTLY: the preview
-- computes load in JS and mos_campaign_plan_commit's conflict test recomputes
-- it in SQL, and a divergence surfaces as a WS409 on a plan that fits.
CREATE OR REPLACE FUNCTION public.mos_spread_effort_same_day(p_start date, p_effort numeric)
RETURNS TABLE (day date, weight numeric)
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT p_start, GREATEST(COALESCE(p_effort, 0), 0); $$;

REVOKE ALL ON FUNCTION public.mos_spread_effort_same_day(date, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_spread_effort_same_day(date, numeric) TO authenticated, service_role;

-- ── A5. per-step effort for posts was a second capacity knob ──────────────
DELETE FROM public.mos_step_effort WHERE workflow_key LIKE 'post%';

-- ── A6 + C2 (data). the manager's caps ────────────────────────────────────
-- daily_slots is NOT NULL and deleting the row falls back to the role default
-- rather than uncapping, so "no practical cap" is a sentinel well above any
-- reachable load — the month's own arithmetic is ~9 slots a day.
UPDATE public.mos_user_capacity c
   SET daily_slots = 999, updated_at = now()
  FROM public.users u
 WHERE u.id = c.user_id AND u.email = 'r.abanumay@wassel.re' AND c.bucket = 'approvals';

-- mos_perf_place_open_task assigns a task ONLY when the role's daily_new_tasks
-- > 0, and it was 0 for mos_marketing_manager on both buckets — so every
-- approval task opened with assignee_user_id NULL and was reachable only by
-- role, which is what blocks a person-keyed queue.
UPDATE public.mos_role_load l
   SET daily_new_tasks = 999, updated_at = now()
  FROM public.roles r
 WHERE r.id = l.role_id AND r.key = 'mos_marketing_manager';

WITH sole AS (
  SELECT r.key AS role_key, (array_agg(u.id))[1] AS user_id
    FROM public.users u
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(u.role_assignments,'[]'::jsonb)) ra
    JOIN public.roles r ON r.id = (ra->>'role_id')::uuid
   WHERE r.domain = 'marketing' AND u.is_active
     AND u.email <> 'rayan.abanumay@gmail.com'
   GROUP BY r.key
  HAVING COUNT(*) = 1
)
UPDATE public.workflow_role_tasks t
   SET assignee_user_id = sole.user_id
  FROM sole
 WHERE t.status = 'open' AND t.assignee_user_id IS NULL AND t.role_key = sole.role_key;

-- ── A7. month notes, keyed on the TEMPLATE coordinate ─────────────────────
-- Not on mos_campaign_plans.input (campaignPlanRevise rewrites it wholesale and
-- parsePlanInput drops unknown keys) and not on mos_comments (content/campaign
-- only). `lane` is load-bearing per decision D7: paid notes are a separate
-- channel, so a project-column note belongs to exactly one lane, and
-- lane IS NULL is the month note, which reaches both.
CREATE TABLE IF NOT EXISTS public.mos_month_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month          date NOT NULL,
  lane           text CHECK (lane IN ('organic','paid')),
  project_id     uuid,
  batch_date     date,
  kind           text NOT NULL CHECK (kind IN ('month','project','row','paid_batch')),
  body           text NOT NULL,
  author_user_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mos_month_notes_shape CHECK (
    (kind = 'month'      AND lane IS NULL     AND project_id IS NULL AND batch_date IS NULL) OR
    (kind = 'project'    AND lane IS NOT NULL AND project_id IS NOT NULL AND batch_date IS NULL) OR
    (kind = 'row'        AND lane = 'organic' AND batch_date IS NOT NULL) OR
    (kind = 'paid_batch' AND lane = 'paid'    AND batch_date IS NOT NULL AND project_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_month_notes_coord ON public.mos_month_notes
  (month, COALESCE(lane,''), COALESCE(project_id,'00000000-0000-0000-0000-000000000000'::uuid),
   COALESCE(batch_date,'1900-01-01'::date), kind);

-- ── A8. the standing month as data, incl. the Saturday topic bank ─────────
CREATE TABLE IF NOT EXISTS public.mos_month_template (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled                    boolean NOT NULL DEFAULT false,
  posting_weekdays           int[]   NOT NULL DEFAULT ARRAY[0,2,4,6],
  posts_per_row              int     NOT NULL DEFAULT 3,
  projects_per_month         int     NOT NULL DEFAULT 3,
  creatives_per_project_week int     NOT NULL DEFAULT 5,
  campaign_length_days       int     NOT NULL DEFAULT 30,
  budget_per_project         numeric NOT NULL DEFAULT 2000,
  meta_template              jsonb   NOT NULL DEFAULT '{}'::jsonb,
  lead_time_working_days     int     NOT NULL DEFAULT 10,
  safety_margin_days         int     NOT NULL DEFAULT 2,
  publish_time               time    NOT NULL DEFAULT '18:00',
  intra_row_gap_minutes      int     NOT NULL DEFAULT 5,
  min_spend_sar              numeric NOT NULL DEFAULT 150,
  min_impressions            int     NOT NULL DEFAULT 2000,
  min_leader_leads           int     NOT NULL DEFAULT 5,
  leader_margin_pct          numeric NOT NULL DEFAULT 20,
  -- §3.7's promised fallback for a Saturday cell left blank.
  general_topic_bank         text[]  NOT NULL DEFAULT ARRAY[]::text[],
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_month_template_singleton
  ON public.mos_month_template ((true));

INSERT INTO public.mos_month_template (enabled, general_topic_bank)
SELECT false, ARRAY[
  'نصائح شراء العقار',
  'أسئلة التمويل العقاري',
  'مقارنة أحياء الرياض',
  'خلف الكواليس',
  'إجابة سؤال متكرر'
]
WHERE NOT EXISTS (SELECT 1 FROM public.mos_month_template);

-- ── A9. feed vs story on the organic side ─────────────────────────────────
-- mos_publications had no shape discriminator at all; the paid side already has
-- this exact vocabulary on mos_ad_sets. grid_row/grid_col are Instagram
-- PROFILE-grid coordinates, not publish order — deliberately not reused.
ALTER TABLE public.mos_publications ADD COLUMN IF NOT EXISTS placement_variant text
  CHECK (placement_variant IN ('feed','story'));
ALTER TABLE public.mos_publications ADD COLUMN IF NOT EXISTS pair_id uuid;
CREATE INDEX IF NOT EXISTS ix_mos_publications_pair
  ON public.mos_publications (pair_id) WHERE pair_id IS NOT NULL;

-- The pair needs room in the idempotency key. UNIQUE (content_id, platform,
-- account_id) never actually fired while account_id was NULL (Postgres treats
-- NULLs as distinct); once 2026-09-15_01 resolved the account on every insert,
-- a post's FEED and STORY releases — same content, same platform, same account —
-- would have collided and the second been swallowed by ON CONFLICT DO NOTHING.
-- The month would publish feeds and no stories, with no error anywhere.
ALTER TABLE public.mos_publications
  DROP CONSTRAINT IF EXISTS mos_publications_content_id_platform_account_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_publications_destination
  ON public.mos_publications (content_id, platform, account_id, COALESCE(placement_variant, ''));

-- ── A10. the video type had no caption in its field_schema ────────────────
-- mos_content_writing_hash, mos_tg_content_locked_guard and the required_fields
-- check all iterate field_schema, so a video's caption was invisible to all
-- three. "Every item carries a caption" cannot be true without this.
UPDATE public.mos_content_types
   SET field_schema = field_schema || '["caption"]'::jsonb,
       updated_at   = now()
 WHERE key = 'video'
   AND NOT (field_schema @> '["caption"]'::jsonb);

COMMIT;
