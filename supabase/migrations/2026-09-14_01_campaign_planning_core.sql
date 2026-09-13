-- ============================================================================
-- Campaign planning — CORE SCHEMA (2026-09-14, part 1 of 4)
-- ----------------------------------------------------------------------------
-- Implements docs/campaign-planning-contracts.md §2.1 / §2.2 / §2.3:
--   * 12 new tables (plans, batches, production plans, the PLANNING ledger,
--     refresh cycles, creative slots, per-ad daily metrics, approvals, events,
--     per-person capacity, holidays, explicit step effort)
--   * backward-compatible ALTERs on 8 existing tables (columns with defaults
--     only — nothing is dropped or renamed in this pass)
--   * the calendar / effort / capacity helper functions
--   * the FOUR views: mos_work_ledger_v, mos_publish_batch_v,
--     mos_creative_perf_v and the mos_content_v replacement.
--
-- THE ONE LEDGER RULE (plan §4.3, and the thing every review turned on):
--   remaining effort = effort_days - progress_days, floored at 0.5, projected
--   forward from TODAY, one slot per working day. ELAPSED TIME IS NEVER
--   PROGRESS. A two-day task nobody touched still costs two slot-days, and it
--   costs them from today, never on the days it already missed.
--
-- Idempotent: every object is IF NOT EXISTS / CREATE OR REPLACE / DO-guarded.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 0. Work-calendar + effort + capacity helpers
-- ────────────────────────────────────────────────────────────────────────────

-- The planning settings blob (seeded in part 4). Missing = '{}', so every
-- reader falls back to its own documented default and nothing breaks before
-- the seed lands.
CREATE OR REPLACE FUNCTION public.mos_planning_cfg()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT value FROM public.mos_settings WHERE key = 'planning'), '{}'::jsonb);
$$;

-- Weekend weekdays, Postgres dow convention (0 = Sunday … 6 = Saturday).
-- Default {5} = Friday, matching mos_settings.planning.weekend_days.
CREATE OR REPLACE FUNCTION public.mos_weekend_days()
RETURNS int[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT array_agg((x)::int)
       FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(public.mos_planning_cfg() -> 'weekend_days') = 'array'
                   THEN public.mos_planning_cfg() -> 'weekend_days'
                   ELSE '[5]'::jsonb END) AS t(x)),
    ARRAY[5]);
$$;

CREATE TABLE IF NOT EXISTS public.mos_holidays (
  day        date PRIMARY KEY,
  label_ar   text NOT NULL DEFAULT '',
  label_en   text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.mos_is_working_day(p_day date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_day IS NOT NULL
     AND NOT (EXTRACT(dow FROM p_day)::int = ANY (public.mos_weekend_days()))
     AND NOT EXISTS (SELECT 1 FROM public.mos_holidays h WHERE h.day = p_day);
$$;

-- The first p_count working days on/after p_start. Bounded scan: p_count*3+30
-- calendar days always contains p_count working days for any sane calendar
-- (it would take a 2-in-3 weekend plus a month of holidays to break it).
CREATE OR REPLACE FUNCTION public.mos_working_days_from(p_start date, p_count int)
RETURNS SETOF date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT g.d::date
    FROM generate_series(p_start, p_start + (GREATEST(COALESCE(p_count, 0), 0) * 3 + 30), interval '1 day') g(d)
   WHERE public.mos_is_working_day(g.d::date)
   ORDER BY g.d
   LIMIT GREATEST(COALESCE(p_count, 0), 0);
$$;

CREATE OR REPLACE FUNCTION public.mos_working_days_between(p_from date, p_to date)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT count(*)::int
                     FROM generate_series(p_from, p_to, interval '1 day') g(d)
                    WHERE public.mos_is_working_day(g.d::date)), 0);
$$;

-- Spread `p_effort` working days over consecutive working days from p_start,
-- ONE SLOT PER DAY. 2.0 → two days at 1. 0.5 → one day at 0.5. 1.5 → 1 then 0.5.
CREATE OR REPLACE FUNCTION public.mos_spread_effort(p_start date, p_effort numeric)
RETURNS TABLE (day date, weight numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT w.d,
         CASE WHEN w.rn < ceil(COALESCE(p_effort, 0))::int THEN 1::numeric
              ELSE COALESCE(p_effort, 0) - (ceil(COALESCE(p_effort, 0))::int - 1)::numeric END
    FROM (SELECT dd AS d, row_number() OVER (ORDER BY dd) AS rn
            FROM public.mos_working_days_from(p_start, ceil(COALESCE(p_effort, 0))::int) dd) w
   WHERE COALESCE(p_effort, 0) > 0;
$$;

-- EXPLICIT effort estimates. NOT the step's due_days (that is a deadline
-- allowance, not effort — conflating the two was the v2 mistake).
CREATE TABLE IF NOT EXISTS public.mos_step_effort (
  workflow_key text    NOT NULL,
  step_key     text    NOT NULL,
  bucket       text    NOT NULL,
  working_days numeric NOT NULL DEFAULT 1 CHECK (working_days > 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_key, step_key, bucket)
);

CREATE OR REPLACE FUNCTION public.mos_step_effort_days(p_workflow_key text, p_step_key text, p_bucket text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT working_days FROM public.mos_step_effort
      WHERE workflow_key = p_workflow_key AND step_key = p_step_key AND bucket = p_bucket),
    (SELECT working_days FROM public.mos_step_effort
      WHERE workflow_key = p_workflow_key AND step_key = p_step_key ORDER BY bucket LIMIT 1),
    1::numeric);
$$;

-- Mirrors CONTENT_TYPE_WORKFLOW in src/lib/marketingOS/scheduling/defaults.ts.
CREATE OR REPLACE FUNCTION public.mos_workflow_key_of(p_content_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN public.mos_perf_bucket_of(p_content_id) = 'video' THEN 'video_std' ELSE 'post_std' END;
$$;

-- Approval steps consume the 'approvals' budget, not the designer-shaped one
-- (bucketOfStep() in types.ts). Reads the PINNED workflow version.
CREATE OR REPLACE FUNCTION public.mos_step_is_approval(p_version_id uuid, p_step_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT (e.elem ->> 'is_approval')::boolean
                     FROM public.workflow_versions v,
                          LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') e(elem)
                    WHERE v.id = p_version_id AND e.elem ->> 'key' = p_step_key
                    LIMIT 1), false);
$$;

CREATE OR REPLACE FUNCTION public.mos_ledger_bucket(p_version_id uuid, p_step_key text, p_content_bucket text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN public.mos_step_is_approval(p_version_id, p_step_key)
              THEN 'approvals' ELSE COALESCE(p_content_bucket, 'post') END;
$$;

-- Caption hash — ONE definition shared by the DB and the API/SPA. md5 of the
-- trimmed caption. (Deliberately md5, not pgcrypto digest(): the records
-- capture trigger taught us that digest() + SET search_path is a trap, and
-- this value is a change-detector, never a security token.)
CREATE OR REPLACE FUNCTION public.mos_caption_hash(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN NULLIF(btrim(COALESCE(p_text, '')), '') IS NULL
              THEN NULL ELSE md5(btrim(p_text)) END;
$$;

-- Per-person daily slots. Override first, then the role default, then the
-- approvals cap from settings, then 0 ("cannot take that work").
CREATE TABLE IF NOT EXISTS public.mos_user_capacity (
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bucket      text NOT NULL,
  daily_slots numeric NOT NULL DEFAULT 0 CHECK (daily_slots >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket)
);

CREATE OR REPLACE FUNCTION public.mos_user_daily_slots(p_user_id uuid, p_bucket text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT uc.daily_slots FROM public.mos_user_capacity uc
      WHERE uc.user_id = p_user_id AND uc.bucket = p_bucket),
    (SELECT max(rl.daily_new_tasks)::numeric
       FROM public.users u
       JOIN public.roles r
         ON r.key LIKE 'mos\_%' ESCAPE '\'
        AND r.id::text IN (SELECT e ->> 'role_id'
                             FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
       JOIN public.mos_role_load rl ON rl.role_id = r.id AND rl.bucket = p_bucket
      WHERE u.id = p_user_id),
    CASE WHEN p_bucket = 'approvals'
         THEN COALESCE((public.mos_planning_cfg() ->> 'approvals_cap_per_day')::numeric, 20)
         ELSE NULL END,
    0::numeric);
$$;

-- Which budget a HAND-ASSIGNED task eats. Bucketing every manual task as
-- 'approvals' would let a designer's manual work vanish from their post/video
-- budget entirely — the planner would then book their whole day on top of it,
-- which is exactly the "unfinished work disappears from the count" failure the
-- review told us to avoid. So: a production-role holder's manual task lands in
-- the production bucket they have the most capacity in (tie → 'post'); an
-- approval-only role (marketing_manager / ceo) lands in 'approvals'. System
-- tasks (caption_review / refresh_decision / plan_conflict) are manager-shaped
-- and therefore land in 'approvals' by the same rule.
CREATE OR REPLACE FUNCTION public.mos_manual_task_bucket(p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.users u
                  JOIN public.roles r
                    ON r.key IN ('mos_montage','mos_writer','mos_ops_supervisor')
                   AND r.id::text IN (SELECT e ->> 'role_id'
                                        FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
                 WHERE u.id = p_user_id)
    THEN (SELECT b.bucket FROM (VALUES ('post'), ('video')) b(bucket)
           ORDER BY public.mos_user_daily_slots(p_user_id, b.bucket) DESC, b.bucket
           LIMIT 1)
    ELSE 'approvals' END;
$$;

CREATE OR REPLACE FUNCTION public.mos_on_leave(p_user_id uuid, p_day date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.mos_leaves l
                  WHERE l.user_id = p_user_id AND l.status = 'approved'
                    AND (l.start_at AT TIME ZONE 'Asia/Riyadh')::date <= p_day
                    AND (l.end_at   AT TIME ZONE 'Asia/Riyadh')::date >= p_day);
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. New tables
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mos_campaign_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid REFERENCES public.mos_campaigns(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','approved','superseded','discarded')),
  input               jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan                jsonb NOT NULL DEFAULT '{}'::jsonb,
  feasibility         jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_hash       text,
  engine_version      text,
  created_by_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  approved_at         timestamptz,
  approved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  superseded_by       uuid REFERENCES public.mos_campaign_plans(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_mos_campaign_plans_campaign ON public.mos_campaign_plans (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_mos_campaign_plans_status   ON public.mos_campaign_plans (status);

CREATE TABLE IF NOT EXISTS public.mos_publish_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid REFERENCES public.mos_campaign_plans(id) ON DELETE SET NULL,
  campaign_id  uuid REFERENCES public.mos_campaigns(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES public.mos_campaign_executions(id) ON DELETE SET NULL,
  platform     text NOT NULL,
  day          date NOT NULL,
  sequence     int  NOT NULL DEFAULT 1,
  batch_key    text,
  status       text NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','on_track','at_risk','late','done')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_mos_publish_batches_campaign ON public.mos_publish_batches (campaign_id, day);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_publish_batches_plan_key
  ON public.mos_publish_batches (plan_id, batch_key) WHERE plan_id IS NOT NULL AND batch_key IS NOT NULL;

-- 1:1 with content. The PRODUCTION plan (one per creative); placements are
-- many and live on mos_publications (plan v2 correction 4).
CREATE TABLE IF NOT EXISTS public.mos_content_plan (
  content_id         uuid PRIMARY KEY REFERENCES public.mos_content(id) ON DELETE CASCADE,
  plan_id            uuid REFERENCES public.mos_campaign_plans(id) ON DELETE SET NULL,
  campaign_id        uuid REFERENCES public.mos_campaigns(id) ON DELETE SET NULL,
  need_at            timestamptz,
  required_ready_at  date,
  production_start   date,
  priority           int  NOT NULL DEFAULT 1000,
  stage_deadlines    jsonb NOT NULL DEFAULT '{}'::jsonb,
  stage_assignees    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned','in_production','ready','published','at_risk','late')),
  content_key        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_mos_content_plan_campaign ON public.mos_content_plan (campaign_id);
CREATE INDEX IF NOT EXISTS ix_mos_content_plan_start    ON public.mos_content_plan (production_start) WHERE status = 'planned';

-- The PLANNING ledger. content_key lets a reservation exist before its content
-- shell does (paid replacement slots); content_id is filled when it is created.
CREATE TABLE IF NOT EXISTS public.mos_task_reservations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           uuid REFERENCES public.mos_campaign_plans(id) ON DELETE CASCADE,
  cycle_id          uuid,
  content_id        uuid REFERENCES public.mos_content(id) ON DELETE CASCADE,
  content_key       text,
  step_key          text NOT NULL,
  role_key          text NOT NULL,
  assignee_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  bucket            text NOT NULL DEFAULT 'post',
  planned_start     date NOT NULL,
  planned_end       date NOT NULL,
  weight            numeric NOT NULL DEFAULT 1 CHECK (weight > 0),
  status            text NOT NULL DEFAULT 'reserved'
                      CHECK (status IN ('reserved','stale','consumed','released')),
  consumed_task_id  uuid REFERENCES public.workflow_role_tasks(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_mos_task_res_open      ON public.mos_task_reservations (assignee_user_id, planned_start)
  WHERE status IN ('reserved','stale');
CREATE INDEX IF NOT EXISTS ix_mos_task_res_content   ON public.mos_task_reservations (content_id, step_key)
  WHERE status IN ('reserved','stale');
CREATE INDEX IF NOT EXISTS ix_mos_task_res_key       ON public.mos_task_reservations (plan_id, content_key, step_key);
CREATE INDEX IF NOT EXISTS ix_mos_task_res_cycle     ON public.mos_task_reservations (cycle_id) WHERE cycle_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.mos_refresh_cycles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id        uuid NOT NULL REFERENCES public.mos_campaign_executions(id) ON DELETE CASCADE,
  plan_id             uuid REFERENCES public.mos_campaign_plans(id) ON DELETE SET NULL,
  round               int  NOT NULL,
  refresh_on          date,
  ready_by            date,
  production_start_on date,
  decision_due_on     date,
  status              text NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled','producing','ready','deciding','decided',
                                          'applying','applied','partial','skipped','cancelled')),
  decision            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_refresh_cycles_round ON public.mos_refresh_cycles (execution_id, round);
CREATE INDEX IF NOT EXISTS ix_mos_refresh_cycles_due ON public.mos_refresh_cycles (decision_due_on)
  WHERE status IN ('scheduled','producing','ready','deciding');

CREATE TABLE IF NOT EXISTS public.mos_creative_slots (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id            uuid NOT NULL REFERENCES public.mos_campaign_executions(id) ON DELETE CASCADE,
  cycle_id                uuid REFERENCES public.mos_refresh_cycles(id) ON DELETE SET NULL,
  plan_id                 uuid REFERENCES public.mos_campaign_plans(id) ON DELETE SET NULL,
  slot_index              int  NOT NULL DEFAULT 0,
  kind                    text NOT NULL DEFAULT 'initial'
                            CHECK (kind IN ('initial','replacement','fifth','spare')),
  status                  text NOT NULL DEFAULT 'reserved'
                            CHECK (status IN ('reserved','producing','ready','active','retired','released')),
  content_id              uuid REFERENCES public.mos_content(id) ON DELETE SET NULL,
  content_key             text,
  ad_row_id               uuid REFERENCES public.mos_execution_ads(id) ON DELETE SET NULL,
  activate_on             date,
  activated_at            timestamptz,
  retired_at              timestamptz,
  bank_reserved_for_cycle_id uuid REFERENCES public.mos_refresh_cycles(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- v2.1 correction 2: only a READY fifth/spare may be earmarked to a cycle.
  CONSTRAINT mos_creative_slots_bank_check CHECK (
    bank_reserved_for_cycle_id IS NULL
    OR (status = 'ready' AND kind IN ('fifth','spare')))
);
-- A banked spare belongs to AT MOST ONE cycle. This index is the exclusivity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_creative_slots_bank_cycle
  ON public.mos_creative_slots (bank_reserved_for_cycle_id)
  WHERE bank_reserved_for_cycle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_mos_creative_slots_exec  ON public.mos_creative_slots (execution_id, status);
CREATE INDEX IF NOT EXISTS ix_mos_creative_slots_cycle ON public.mos_creative_slots (cycle_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_creative_slots_cycle_index
  ON public.mos_creative_slots (cycle_id, slot_index) WHERE cycle_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.mos_ad_metrics_daily (
  ad_row_id   uuid NOT NULL REFERENCES public.mos_execution_ads(id) ON DELETE CASCADE,
  day         date NOT NULL,
  spend       numeric NOT NULL DEFAULT 0,
  impressions bigint  NOT NULL DEFAULT 0,
  clicks      bigint  NOT NULL DEFAULT 0,
  leads       bigint  NOT NULL DEFAULT 0,
  reach       bigint  NOT NULL DEFAULT 0,
  frequency   numeric NOT NULL DEFAULT 0,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ad_row_id, day)
);
CREATE INDEX IF NOT EXISTS ix_mos_ad_metrics_daily_day ON public.mos_ad_metrics_daily (day);

CREATE TABLE IF NOT EXISTS public.mos_content_approvals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id          uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  step_key            text NOT NULL,
  round               int  NOT NULL DEFAULT 1,
  approved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at         timestamptz NOT NULL DEFAULT now(),
  writing_hash        text,
  design_hash         text,
  caption_hash        text,
  package_hash        text
);
CREATE INDEX IF NOT EXISTS ix_mos_content_approvals_content ON public.mos_content_approvals (content_id, approved_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_content_approvals_round
  ON public.mos_content_approvals (content_id, step_key, round);

CREATE TABLE IF NOT EXISTS public.mos_content_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id    uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ix_mos_content_events_content ON public.mos_content_events (content_id, at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Altered tables — additive only (contract §2.2)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.mos_campaign_executions
  ADD COLUMN IF NOT EXISTS refresh_policy   jsonb,
  ADD COLUMN IF NOT EXISTS publishing_rules jsonb,
  -- The contract's uniqueness predicate references archived_at; the column did
  -- not exist. Added here (nullable, no default) so nothing changes for the 10
  -- live rows and the partial index can be built.
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_campaign_executions_platform_check') THEN
    ALTER TABLE public.mos_campaign_executions ADD CONSTRAINT mos_campaign_executions_platform_check
      CHECK (platform IN ('meta','google','instagram','tiktok','snapchat','x','youtube','website'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_campaign_executions_child
  ON public.mos_campaign_executions (campaign_id, platform, COALESCE(label, ''))
  WHERE archived_at IS NULL;

ALTER TABLE public.mos_campaigns
  ADD COLUMN IF NOT EXISTS requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS plan_id      uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_campaigns_plan_id_fkey') THEN
    ALTER TABLE public.mos_campaigns ADD CONSTRAINT mos_campaigns_plan_id_fkey
      FOREIGN KEY (plan_id) REFERENCES public.mos_campaign_plans(id) ON DELETE SET NULL;
  END IF;
END $$;

-- plan §14.2: mos_content.campaign_id had no FK at all (verified 2026-09-14 —
-- 0 orphan rows), so a deleted campaign left dangling ids.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_content_campaign_id_fkey')
     AND NOT EXISTS (SELECT 1 FROM public.mos_content c
                      WHERE c.campaign_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM public.mos_campaigns g WHERE g.id = c.campaign_id)) THEN
    ALTER TABLE public.mos_content ADD CONSTRAINT mos_content_campaign_id_fkey
      FOREIGN KEY (campaign_id) REFERENCES public.mos_campaigns(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Lifecycle states that are NOT workflow steps (plan §9.2 / §9.4). Nothing
-- else can carry them: mos_content_plan.status has no on_hold/rejected member.
ALTER TABLE public.mos_content
  ADD COLUMN IF NOT EXISTS on_hold_at  timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

ALTER TABLE public.mos_publications
  ADD COLUMN IF NOT EXISTS execution_id uuid REFERENCES public.mos_campaign_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_id     uuid REFERENCES public.mos_publish_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS planned_at   timestamptz,
  ADD COLUMN IF NOT EXISTS grid_row     int,
  ADD COLUMN IF NOT EXISTS grid_col     int,
  ADD COLUMN IF NOT EXISTS scheduled_timezone text NOT NULL DEFAULT 'Asia/Riyadh';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_pub_status_check') THEN
    ALTER TABLE public.mos_publications DROP CONSTRAINT mos_pub_status_check;
  END IF;
  ALTER TABLE public.mos_publications ADD CONSTRAINT mos_pub_status_check
    CHECK (status IN ('planned','draft','scheduled','published','cancelled'));
END $$;

CREATE INDEX IF NOT EXISTS ix_mos_publications_batch ON public.mos_publications (batch_id) WHERE batch_id IS NOT NULL;

ALTER TABLE public.workflow_role_tasks
  ADD COLUMN IF NOT EXISTS scheduled_start date,
  ADD COLUMN IF NOT EXISTS scheduled_end   date,
  ADD COLUMN IF NOT EXISTS effort_days     numeric,
  ADD COLUMN IF NOT EXISTS progress_days   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reservation_id  uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_role_tasks_progress_check') THEN
    ALTER TABLE public.workflow_role_tasks ADD CONSTRAINT workflow_role_tasks_progress_check
      CHECK (progress_days >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_role_tasks_reservation_id_fkey') THEN
    ALTER TABLE public.workflow_role_tasks ADD CONSTRAINT workflow_role_tasks_reservation_id_fkey
      FOREIGN KEY (reservation_id) REFERENCES public.mos_task_reservations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_wrt_open_ledger ON public.workflow_role_tasks (assignee_user_id, scheduled_start)
  WHERE status = 'open';

ALTER TABLE public.mos_manual_tasks
  ADD COLUMN IF NOT EXISTS entity_kind text,
  ADD COLUMN IF NOT EXISTS entity_id   uuid,
  ADD COLUMN IF NOT EXISTS action      text;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_manual_tasks_kind_check') THEN
    ALTER TABLE public.mos_manual_tasks DROP CONSTRAINT mos_manual_tasks_kind_check;
  END IF;
  ALTER TABLE public.mos_manual_tasks ADD CONSTRAINT mos_manual_tasks_kind_check
    CHECK (kind IN ('manual','caption_review','refresh_decision','plan_conflict','ad_failed'));
END $$;

ALTER TABLE public.mos_execution_ads
  ADD COLUMN IF NOT EXISTS slot_id                uuid REFERENCES public.mos_creative_slots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS activated_at           timestamptz,
  ADD COLUMN IF NOT EXISTS retired_at             timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_by_ad_row_id  uuid REFERENCES public.mos_execution_ads(id) ON DELETE SET NULL;

ALTER TABLE public.mos_asset_links
  ADD COLUMN IF NOT EXISTS version            int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS superseded_at      timestamptz,
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- DEVIATION from contract §2.2, deliberate: the contract's unique index is
-- (content_id, role) WHERE superseded_at IS NULL over EVERY role. Live data
-- refutes that — P-135 legitimately carries two role='source' links (a content
-- may reference many sources/references), so the index would neither build nor
-- be correct. Uniqueness is a property of the FINAL SLOTS (the versioned
-- design slots §9.3 is about), so it is scoped to them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_asset_links_slot_current
  ON public.mos_asset_links (content_id, role)
  WHERE superseded_at IS NULL AND role IN ('final','final_square','final_vertical');

ALTER TABLE public.mos_content_types
  ADD COLUMN IF NOT EXISTS design_fields text[] NOT NULL DEFAULT '{}'::text[];

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Row level security
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
  -- table, read capability, write capability ('' = no direct write policy;
  -- every real write goes through a SECURITY DEFINER RPC or service_role)
  specs text[][] := ARRAY[
    ARRAY['mos_campaign_plans',    'read', 'plan_campaign'],
    ARRAY['mos_publish_batches',   'read', 'plan_campaign'],
    ARRAY['mos_content_plan',      'read', 'plan_campaign'],
    ARRAY['mos_task_reservations', 'read', 'plan_campaign'],
    ARRAY['mos_refresh_cycles',    'read', 'plan_campaign'],
    ARRAY['mos_creative_slots',    'read', 'plan_campaign'],
    ARRAY['mos_ad_metrics_daily',  'read', ''],
    ARRAY['mos_content_approvals', 'read', ''],
    ARRAY['mos_content_events',    'read', ''],
    ARRAY['mos_user_capacity',     'read', 'manage_capacity'],
    ARRAY['mos_holidays',          'read', 'manage_capacity'],
    ARRAY['mos_step_effort',       'read', 'manage_capacity']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(specs, 1) LOOP
    t := specs[i][1];
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.wassell_mos_can(%L))',
      t || '_read', t, specs[i][2]);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_ins', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_upd', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_del', t);
    IF specs[i][3] <> '' THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.wassell_mos_can(%L))',
        t || '_ins', t, specs[i][3]);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.wassell_mos_can(%L)) WITH CHECK (public.wassell_mos_can(%L))',
        t || '_upd', t, specs[i][3], specs[i][3]);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.wassell_mos_can(%L))',
        t || '_del', t, specs[i][3]);
    END IF;
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. mos_work_ledger_v — THE ONE DEFINITION OF CAPACITY (plan §4.3)
-- ----------------------------------------------------------------------------
-- Exactly three sources; every unit of REMAINING work appears exactly ONCE;
-- never a past day.
--
--  1. workflow_role_tasks status='open' — remaining effort
--     (effort_days - progress_days, floored at 0.5) projected one slot per
--     working day from max(scheduled_start, today). A task that is three days
--     late is NOT counted on those three days; elapsed time is not progress.
--  2. mos_task_reservations status IN ('reserved','stale') — the planned
--     window from today forward; a STALE one (window already past) re-projects
--     its FULL remaining span from today at full weight.
--  3. mos_manual_tasks status='open' — its due day, or today when overdue, at
--     mos_settings.planning.manual_task_weight (default 0.5).
--
-- NOT security_invoker, by design: the commit RPC's independent capacity
-- re-check and mos_workload_snapshot_hash() must see the WHOLE team's load or
-- they would under-count for a non-admin writer and let two plans book the
-- same slot. anon is revoked below; authenticated may read (that is the
-- workload calendar).
-- ────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.mos_work_ledger_v;
CREATE VIEW public.mos_work_ledger_v AS
-- (1) open workflow tasks
SELECT t.assignee_user_id                                   AS user_id,
       s.day                                                AS day,
       public.mos_ledger_bucket(
         t.workflow_version_id, t.step_key,
         COALESCE(t.bucket, public.mos_perf_bucket_of(t.subject_id)))  AS bucket,
       s.weight                                             AS weight,
       'task'::text                                         AS source,
       t.id                                                 AS ref_id
  FROM public.workflow_role_tasks t
  CROSS JOIN LATERAL public.mos_spread_effort(
        GREATEST(COALESCE(t.scheduled_start, public.mos_perf_today()), public.mos_perf_today()),
        GREATEST(
          COALESCE(t.effort_days,
                   public.mos_step_effort_days(
                     public.mos_workflow_key_of(t.subject_id), t.step_key,
                     public.mos_ledger_bucket(t.workflow_version_id, t.step_key,
                       COALESCE(t.bucket, public.mos_perf_bucket_of(t.subject_id)))))
          - COALESCE(t.progress_days, 0),
          0.5)) s
 WHERE t.status = 'open'
   AND t.subject_table = 'mos_content'
   AND t.assignee_user_id IS NOT NULL

UNION ALL

-- (2) reservations, spread by THE SAME mos_spread_effort() the task branch
--     uses. `mos_task_reservations.weight` is the reservation's TOTAL effort
--     in slot-days (what the API sends and what a human reading the row
--     expects), so it must be SPREAD one slot per working day — emitting the
--     scalar once per day of the window double-counted every multi-day step
--     (a 2-day design scored 2 on each of its 2 days).
--     `reserved` starts at the later of planned_start / today; `stale` (and a
--     `reserved` whose window already passed) re-projects the full remaining
--     effort from today.
SELECT r.assignee_user_id AS user_id,
       s.day,
       r.bucket,
       s.weight,
       'reservation'::text AS source,
       r.id                AS ref_id
  FROM public.mos_task_reservations r
  CROSS JOIN LATERAL public.mos_spread_effort(
        GREATEST(r.planned_start, public.mos_perf_today()), r.weight) s
 WHERE r.status = 'reserved'
   AND r.planned_end >= public.mos_perf_today()
   AND r.assignee_user_id IS NOT NULL

UNION ALL

SELECT r.assignee_user_id AS user_id,
       s.day,
       r.bucket,
       s.weight,
       'reservation'::text AS source,
       r.id                AS ref_id
  FROM public.mos_task_reservations r
  CROSS JOIN LATERAL public.mos_spread_effort(public.mos_perf_today(), r.weight) s
 WHERE (r.status = 'stale'
        OR (r.status = 'reserved' AND r.planned_end < public.mos_perf_today()))
   AND r.assignee_user_id IS NOT NULL

UNION ALL

-- (3) open manual tasks
SELECT m.assignee_user_id AS user_id,
       GREATEST(COALESCE((m.due_at AT TIME ZONE 'Asia/Riyadh')::date, public.mos_perf_today()),
                public.mos_perf_today())                    AS day,
       public.mos_manual_task_bucket(m.assignee_user_id)    AS bucket,
       COALESCE((public.mos_planning_cfg() ->> 'manual_task_weight')::numeric, 0.5) AS weight,
       'manual'::text                                       AS source,
       m.id                                                 AS ref_id
  FROM public.mos_manual_tasks m
 WHERE m.status = 'open'
   AND m.assignee_user_id IS NOT NULL;

REVOKE ALL ON public.mos_work_ledger_v FROM PUBLIC, anon;
GRANT SELECT ON public.mos_work_ledger_v TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. mos_publish_batch_v — batch + risk rollup
-- ────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.mos_publish_batch_v;
CREATE VIEW public.mos_publish_batch_v AS
SELECT b.id,
       b.plan_id,
       b.campaign_id,
       b.execution_id,
       b.platform,
       b.day,
       b.sequence,
       b.batch_key,
       b.status,
       COALESCE(x.items, 0)      AS items,
       COALESCE(x.ready, 0)      AS ready_items,
       COALESCE(x.at_risk, 0)    AS at_risk_items,
       COALESCE(x.late, 0)       AS late_items,
       COALESCE(x.published, 0)  AS published_items,
       CASE
         WHEN COALESCE(x.items, 0) = 0                       THEN b.status
         WHEN COALESCE(x.published, 0) = x.items             THEN 'done'
         WHEN COALESCE(x.late, 0) > 0                        THEN 'late'
         WHEN COALESCE(x.at_risk, 0) > 0                     THEN 'at_risk'
         WHEN b.day < public.mos_perf_today()
              AND COALESCE(x.published, 0) < x.items         THEN 'late'
         ELSE 'on_track'
       END                                                   AS risk,
       b.created_at,
       b.updated_at
  FROM public.mos_publish_batches b
  LEFT JOIN LATERAL (
        SELECT count(DISTINCT p.content_id)                                                      AS items,
               count(DISTINCT p.content_id) FILTER (WHERE cp.status IN ('ready','published'))    AS ready,
               count(DISTINCT p.content_id) FILTER (WHERE cp.status = 'at_risk')                 AS at_risk,
               count(DISTINCT p.content_id) FILTER (WHERE cp.status = 'late')                    AS late,
               count(DISTINCT p.content_id) FILTER (WHERE p.status = 'published')                AS published
          FROM public.mos_publications p
          LEFT JOIN public.mos_content_plan cp ON cp.content_id = p.content_id
         WHERE p.batch_id = b.id) x ON true;

REVOKE ALL ON public.mos_publish_batch_v FROM PUBLIC, anon;
GRANT SELECT ON public.mos_publish_batch_v TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. mos_creative_perf_v — per creative windowed performance (plan §7.7)
-- ----------------------------------------------------------------------------
-- CPL = spend ÷ leads. ZERO LEADS → CPL NULL (undefined), never 0 and never
-- infinity — the ranking orders those below every creative that has leads.
-- ────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.mos_creative_perf_v;
CREATE VIEW public.mos_creative_perf_v AS
SELECT a.id                        AS ad_row_id,
       a.execution_id,
       a.content_id,
       a.slot_id,
       a.status                    AS ad_status,
       a.activated_at,
       a.retired_at,
       w7.spend                    AS spend_7d,
       w7.impressions              AS impressions_7d,
       w7.clicks                   AS clicks_7d,
       w7.leads                    AS leads_7d,
       w7.reach                    AS reach_7d,
       w7.frequency                AS frequency_7d,
       CASE WHEN w7.leads > 0 THEN w7.spend / w7.leads END                             AS cpl_7d,
       CASE WHEN w7.impressions > 0 THEN (w7.clicks::numeric / w7.impressions) * 100 END AS ctr_7d,
       CASE WHEN w7.impressions > 0 THEN (w7.spend / w7.impressions) * 1000 END        AS cpm_7d,
       lt.spend                    AS spend_lifetime,
       lt.impressions              AS impressions_lifetime,
       lt.clicks                   AS clicks_lifetime,
       lt.leads                    AS leads_lifetime,
       lt.reach                    AS reach_lifetime,
       lt.frequency                AS frequency_lifetime,
       CASE WHEN lt.leads > 0 THEN lt.spend / lt.leads END                             AS cpl_lifetime,
       CASE WHEN lt.impressions > 0 THEN (lt.clicks::numeric / lt.impressions) * 100 END AS ctr_lifetime,
       CASE WHEN lt.impressions > 0 THEN (lt.spend / lt.impressions) * 1000 END        AS cpm_lifetime,
       lt.first_day,
       lt.last_day
  FROM public.mos_execution_ads a
  LEFT JOIN LATERAL (
        SELECT COALESCE(sum(m.spend), 0)       AS spend,
               COALESCE(sum(m.impressions), 0) AS impressions,
               COALESCE(sum(m.clicks), 0)      AS clicks,
               COALESCE(sum(m.leads), 0)       AS leads,
               COALESCE(sum(m.reach), 0)       AS reach,
               COALESCE(max(m.frequency), 0)   AS frequency
          FROM public.mos_ad_metrics_daily m
         WHERE m.ad_row_id = a.id
           AND m.day > public.mos_perf_today() - 7) w7 ON true
  LEFT JOIN LATERAL (
        SELECT COALESCE(sum(m.spend), 0)       AS spend,
               COALESCE(sum(m.impressions), 0) AS impressions,
               COALESCE(sum(m.clicks), 0)      AS clicks,
               COALESCE(sum(m.leads), 0)       AS leads,
               COALESCE(sum(m.reach), 0)       AS reach,
               COALESCE(max(m.frequency), 0)   AS frequency,
               min(m.day)                      AS first_day,
               max(m.day)                      AS last_day
          FROM public.mos_ad_metrics_daily m
         WHERE m.ad_row_id = a.id) lt ON true
 WHERE a.archived_at IS NULL;

REVOKE ALL ON public.mos_creative_perf_v FROM PUBLIC, anon;
GRANT SELECT ON public.mos_creative_perf_v TO authenticated, service_role;

-- Windowed metrics between two days — the ranking function's input (§7.6).
CREATE OR REPLACE FUNCTION public.mos_creative_window_metrics(p_ad_row_id uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'spend',       COALESCE(sum(m.spend), 0),
    'impressions', COALESCE(sum(m.impressions), 0),
    'clicks',      COALESCE(sum(m.clicks), 0),
    'leads',       COALESCE(sum(m.leads), 0),
    'reach',       COALESCE(sum(m.reach), 0),
    'frequency',   COALESCE(max(m.frequency), 0),
    'cpl',         CASE WHEN COALESCE(sum(m.leads), 0) > 0
                        THEN COALESCE(sum(m.spend), 0) / sum(m.leads) END,
    'ctr',         CASE WHEN COALESCE(sum(m.impressions), 0) > 0
                        THEN (COALESCE(sum(m.clicks), 0)::numeric / sum(m.impressions)) * 100 END,
    'cpm',         CASE WHEN COALESCE(sum(m.impressions), 0) > 0
                        THEN (COALESCE(sum(m.spend), 0) / sum(m.impressions)) * 1000 END)
    FROM public.mos_ad_metrics_daily m
   WHERE m.ad_row_id = p_ad_row_id
     AND (p_from IS NULL OR m.day >= p_from)
     AND (p_to   IS NULL OR m.day <= p_to);
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. mos_content_v — replacement (contract §2.3 / plan §14.9)
-- ----------------------------------------------------------------------------
-- Same columns as before PLUS plan_status / required_ready_at / need_at /
-- production_start / priority / caption / caption_confirmed, and status_key
-- gains 'planned' | 'on_hold' | 'rejected'.
--
-- security_invoker=true is RESTORED (it was lost 2026-08-06). Behaviour change:
-- the view now runs under the CALLER's RLS instead of the owner's. mos_content,
-- mos_content_types and workflow_role_tasks all gate SELECT on
-- wassell_mos_can('read'), which every MOS role and the 'viewer' read-floor
-- satisfies, so no signed-in role loses rows — but `anon`, which holds a bare
-- SELECT grant and no policy, stops seeing the whole content table. Test per
-- role after deploy.
-- ────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.mos_content_v;
CREATE VIEW public.mos_content_v WITH (security_invoker = true) AS
 SELECT c.id,
    c.ref,
    c.content_type_id,
    c.workflow_id,
    c.title,
    c.project_id,
    c.campaign_id,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM mos_execution_ads ea
              WHERE ea.content_id = c.id AND ea.archived_at IS NULL)) AND ((EXISTS ( SELECT 1
               FROM mos_publications pp
              WHERE pp.content_id = c.id)) OR COALESCE(array_length(c.organic_platforms, 1), 0) > 0) THEN 'both'::text
            WHEN (EXISTS ( SELECT 1
               FROM mos_execution_ads ea
              WHERE ea.content_id = c.id AND ea.archived_at IS NULL)) THEN 'paid'::text
            WHEN (EXISTS ( SELECT 1
               FROM mos_publications pp
              WHERE pp.content_id = c.id)) OR COALESCE(array_length(c.organic_platforms, 1), 0) > 0 THEN 'organic'::text
            ELSE c.purpose
        END AS purpose,
    c.language,
    c.goal,
    c.audience,
    c.angle,
    c.cta,
    c.target_publish_at,
    c.due_at,
    c.data,
    c.created_by_user_id,
    c.created_at,
    c.updated_at,
    c.archived_at,
    c.workflow_version_id,
    ct.key AS content_type_key,
    ct.label_ar AS content_type_label_ar,
    ct.label_en AS content_type_label_en,
    t.id AS open_task_id,
    t.role_key AS owner_role,
    t.assignee_user_id AS current_assignee_user_id,
    t.due_at AS current_task_due_at,
    t.round AS current_round,
    t.step_key AS current_step_key,
    s.elem ->> 'label_ar'::text AS current_step_label_ar,
    s.elem ->> 'label_en'::text AS current_step_label_en,
    s."position" AS current_step_position,
        CASE
            WHEN c.rejected_at IS NOT NULL THEN 'rejected'::text
            WHEN c.on_hold_at  IS NOT NULL THEN 'on_hold'::text
            WHEN s.elem IS NOT NULL THEN t.step_key
            WHEN t.id IS NOT NULL THEN 'unassigned'::text
            WHEN tc.total_tasks > 0 THEN 'done'::text
            WHEN cp.content_id IS NOT NULL AND cp.status = 'planned' THEN 'planned'::text
            ELSE 'draft'::text
        END AS status_key,
    c.project_ids,
    c.approval_asset_id,
    c.organic_platforms,
    -- plan columns
    cp.status            AS plan_status,
    cp.plan_id           AS plan_id,
    cp.required_ready_at AS required_ready_at,
    cp.need_at           AS need_at,
    cp.production_start  AS production_start,
    cp.priority          AS plan_priority,
    -- caption + its confirmation, both derived from data (§9.1)
    NULLIF(btrim(COALESCE(c.data ->> 'caption', '')), '')                       AS caption,
    -- EXACT string comparison, no trimming on either side. The writing page
    -- writes caption_confirmed_text on the writer's confirmation and clears it
    -- whenever the caption changes. Trimming here and not there is exactly how
    -- the 2026-08-05 twin-fill bug shipped.
    (NULLIF(c.data ->> 'caption', '') IS NOT NULL
     AND c.data ->> 'caption_confirmed_text' = c.data ->> 'caption')            AS caption_confirmed,
    c.on_hold_at,
    c.rejected_at
   FROM mos_content c
     JOIN mos_content_types ct ON ct.id = c.content_type_id
     LEFT JOIN workflow_role_tasks t ON t.subject_table = 'mos_content'::text AND t.subject_id = c.id AND t.status = 'open'::text
     LEFT JOIN workflow_versions v ON v.id = c.workflow_version_id
     LEFT JOIN public.mos_content_plan cp ON cp.content_id = c.id
     LEFT JOIN LATERAL ( SELECT e.elem,
            e.ord::integer AS "position"
           FROM jsonb_array_elements((v.definition -> 'metadata'::text) -> 'steps'::text) WITH ORDINALITY e(elem, ord)
          WHERE (e.elem ->> 'key'::text) = t.step_key) s ON true
     LEFT JOIN LATERAL ( SELECT count(*) AS total_tasks
           FROM workflow_role_tasks tt
          WHERE tt.subject_table = 'mos_content'::text AND tt.subject_id = c.id) tc ON true;

REVOKE ALL ON public.mos_content_v FROM PUBLIC, anon;
GRANT SELECT ON public.mos_content_v TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. updated_at touch triggers on the new tables that carry the column
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mos_campaign_plans','mos_publish_batches','mos_content_plan',
                           'mos_task_reservations','mos_refresh_cycles','mos_creative_slots',
                           'mos_user_capacity','mos_step_effort'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.mos_tg_touch_updated_at()',
      t || '_touch', t);
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Function grants — Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to
--    anon on every new function, so revoking from PUBLIC alone is not enough.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('mos_planning_cfg','mos_weekend_days','mos_is_working_day',
                         'mos_working_days_from','mos_working_days_between','mos_spread_effort',
                         'mos_step_effort_days','mos_workflow_key_of','mos_step_is_approval',
                         'mos_ledger_bucket','mos_caption_hash','mos_user_daily_slots',
                         'mos_manual_task_bucket','mos_on_leave','mos_creative_window_metrics')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;
