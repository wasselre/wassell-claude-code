-- Marketing performance & load system — CORE (tables, columns, seeds, RLS).
-- ============================================================================
-- Spec: docs/marketing-task-load-plan.md. Two engines (capacity + cadence) and
-- three ledgers (XP/rating, discipline, KPI bonus) on top of the existing
-- workflow_role_tasks chain. This migration is pure structure + seeds; every
-- behavior (placement, SLA due dates, late sweep, rating XP) lands in
-- 2026-08-28_02_mos_perf_engine.sql.
--
-- Consequences ship DARK: mos_perf_settings.discipline_observe=true and
-- deductions_enabled=false, so the discipline engine records but nothing
-- punitive can be approved until the operator flips the toggles.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Stage-task columns (workflow_role_tasks + mos_manual_tasks)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.workflow_role_tasks
  ADD COLUMN IF NOT EXISTS bucket         text,
  ADD COLUMN IF NOT EXISTS blocked        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_reason text,
  ADD COLUMN IF NOT EXISTS blocked_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS blocked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS late_flag      boolean NOT NULL DEFAULT false;

-- Manual tasks are measurable too (late sweep + blocked), but carry no bucket:
-- they are coordination work outside the content-type capacity buckets.
ALTER TABLE public.mos_manual_tasks
  ADD COLUMN IF NOT EXISTS blocked        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_reason text,
  ADD COLUMN IF NOT EXISTS blocked_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS blocked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS late_flag      boolean NOT NULL DEFAULT false;

-- Intake counting: how many tasks OPENED for a person on a given day. Counts
-- regardless of current status (a task opened and closed today still consumed
-- that day's intake).
CREATE INDEX IF NOT EXISTS idx_wrt_intake
  ON public.workflow_role_tasks (assignee_user_id, bucket, opened_at);

-- Late sweep scans open tasks only.
CREATE INDEX IF NOT EXISTS idx_wrt_open_due
  ON public.workflow_role_tasks (due_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_mmt_open_due
  ON public.mos_manual_tasks (due_at) WHERE status = 'open';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Capacity engine config
-- ────────────────────────────────────────────────────────────────────────────

-- Content type → load bucket. The operator thinks in two buckets (post/video);
-- every mos_content_types row maps to one.
CREATE TABLE IF NOT EXISTS public.mos_load_buckets (
  content_type_id uuid PRIMARY KEY REFERENCES public.mos_content_types(id) ON DELETE CASCADE,
  bucket          text NOT NULL CHECK (bucket IN ('post','video')),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Daily intake limit per (role, bucket): how many NEW stage-tasks may land in
-- one person's queue per day. A rate limit on intake, never on backlog.
CREATE TABLE IF NOT EXISTS public.mos_role_load (
  role_id         uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  bucket          text NOT NULL CHECK (bucket IN ('post','video')),
  daily_new_tasks int  NOT NULL DEFAULT 0 CHECK (daily_new_tasks >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, bucket)
);

-- SLA hours per (role, bucket, step). due_at = opened_at + sla_hours.
-- Precedence at lookup: (role,bucket,step) → (role,bucket,'*') → (role,'*','*').
CREATE TABLE IF NOT EXISTS public.mos_role_sla (
  role_id   uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  bucket    text NOT NULL DEFAULT '*' CHECK (bucket IN ('post','video','*')),
  step_key  text NOT NULL DEFAULT '*',
  sla_hours numeric NOT NULL CHECK (sla_hours > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, bucket, step_key)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Posting cadence (demand)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mos_posting_targets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform   text NOT NULL,
  bucket     text NOT NULL CHECK (bucket IN ('post','video')),
  per_day    int  NOT NULL CHECK (per_day >= 0),
  -- 0=Sunday … 6=Saturday; NULL = every day. A weekday row overrides the
  -- every-day row for that weekday.
  weekday    smallint CHECK (weekday BETWEEN 0 AND 6),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_posting_targets
  ON public.mos_posting_targets (platform, bucket, COALESCE(weekday, -1));

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Ledger A — ratings, XP, rewards
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mos_creative_ratings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id          uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  contributor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  contributor_role_key text,
  level               text NOT NULL CHECK (level IN ('normal','good','very_good','excellent','very_excellent')),
  is_override         boolean NOT NULL DEFAULT false,
  points              int NOT NULL,
  rated_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, contributor_user_id)
);

-- Append-only XP ledger. Total = sum(points). Never resets.
CREATE TABLE IF NOT EXISTS public.mos_xp_ledger (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source     text NOT NULL CHECK (source IN ('rating','on_time','reward_spend','adjustment')),
  ref_id     uuid,
  points     int NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mos_xp_user ON public.mos_xp_ledger (user_id, created_at);
-- One on-time bonus per task, one base grant per rating — idempotent by ref.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_xp_on_time
  ON public.mos_xp_ledger (ref_id) WHERE source = 'on_time';
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_xp_rating
  ON public.mos_xp_ledger (ref_id) WHERE source = 'rating';

CREATE TABLE IF NOT EXISTS public.mos_rewards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label_ar   text NOT NULL,
  label_en   text NOT NULL,
  cost_xp    int NOT NULL CHECK (cost_xp > 0),
  kind       text NOT NULL DEFAULT 'day_off' CHECK (kind IN ('day_off','other')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mos_reward_claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reward_id    uuid NOT NULL REFERENCES public.mos_rewards(id) ON DELETE CASCADE,
  cost_xp      int NOT NULL,
  status       text NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested','approved','rejected','consumed')),
  decided_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mos_reward_claims_user ON public.mos_reward_claims (user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Ledger B — discipline
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mos_late_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_source text NOT NULL CHECK (task_source IN ('workflow','manual')),
  task_id     uuid NOT NULL,
  content_id  uuid,
  month_key   text NOT NULL,                 -- 'YYYY-MM' (Asia/Riyadh)
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id)                           -- a task is late at most once
);
CREATE INDEX IF NOT EXISTS idx_mos_late_month ON public.mos_late_events (user_id, month_key);

CREATE TABLE IF NOT EXISTS public.mos_discipline_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  month_key     text NOT NULL,
  ordinal       int  NOT NULL,               -- 1..3 warning, 4+ deduction
  kind          text NOT NULL CHECK (kind IN ('warning','deduction')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','disputed')),
  amount_days   numeric,
  late_event_id uuid REFERENCES public.mos_late_events(id) ON DELETE SET NULL,
  dispute_note  text,
  decided_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (late_event_id)                     -- one action per late event
);
CREATE INDEX IF NOT EXISTS idx_mos_discipline_month
  ON public.mos_discipline_actions (user_id, month_key);

CREATE TABLE IF NOT EXISTS public.mos_leaves (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  kind        text NOT NULL DEFAULT 'annual' CHECK (kind IN ('annual','sick','other')),
  status      text NOT NULL DEFAULT 'requested'
              CHECK (status IN ('requested','approved','rejected')),
  note        text,
  approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_mos_leaves_user ON public.mos_leaves (user_id, start_at);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Ledger C — KPI bonus (mos_perf_ prefix: the campaign mos_goals table is a
--    different thing and must not be touched)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mos_perf_kpi_goals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month_key  text NOT NULL,
  metric     text NOT NULL CHECK (metric IN ('cpl','ctr','cpc','leads','spend')),
  comparator text NOT NULL CHECK (comparator IN ('lte','gte')),
  target     numeric NOT NULL,
  bonus_pct  numeric NOT NULL CHECK (bonus_pct > 0),
  label_ar   text,
  label_en   text,
  -- Optional per-goal campaign scope; NULL = account-wide.
  scope_campaign_ids uuid[],
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mos_perf_kpi_month ON public.mos_perf_kpi_goals (month_key);

CREATE TABLE IF NOT EXISTS public.mos_perf_kpi_recipients (
  goal_id      uuid NOT NULL REFERENCES public.mos_perf_kpi_goals(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('user','role')),
  subject_id   uuid NOT NULL,
  PRIMARY KEY (goal_id, subject_kind, subject_id)
);

CREATE TABLE IF NOT EXISTS public.mos_perf_kpi_results (
  goal_id      uuid PRIMARY KEY REFERENCES public.mos_perf_kpi_goals(id) ON DELETE CASCADE,
  actual       numeric,
  hit          boolean NOT NULL DEFAULT false,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

-- Monthly paid-ads snapshot: the audit trail every KPI bonus is judged against.
-- Written by the perf cron from a RANGED Meta insights pull (the live
-- mos_campaign_executions numbers are LIFETIME totals — see the spec §8.1).
CREATE TABLE IF NOT EXISTS public.mos_perf_paid_monthly (
  month_key    text NOT NULL,
  execution_id uuid NOT NULL REFERENCES public.mos_campaign_executions(id) ON DELETE CASCADE,
  campaign_id  uuid,
  spend        numeric,
  impressions  bigint,
  clicks       bigint,
  leads        bigint,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month_key, execution_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Global toggles — one row, consequences dark by default
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mos_perf_settings (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  ratings_enabled    boolean NOT NULL DEFAULT true,
  xp_rewards_enabled boolean NOT NULL DEFAULT true,
  discipline_observe boolean NOT NULL DEFAULT true,   -- record, no consequences UI
  deductions_enabled boolean NOT NULL DEFAULT false,  -- money moves only when true
  kpi_bonus_enabled  boolean NOT NULL DEFAULT true,
  cadence_enabled    boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.mos_perf_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. RLS
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.mos_load_buckets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_role_load          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_role_sla           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_posting_targets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_creative_ratings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_xp_ledger          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_rewards            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_reward_claims      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_late_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_discipline_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_leaves             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_perf_kpi_goals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_perf_kpi_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_perf_kpi_results   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_perf_paid_monthly  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_perf_settings      ENABLE ROW LEVEL SECURITY;

-- Config: every marketing reader sees it; manage_roles edits capacity/cadence.
DROP POLICY IF EXISTS mos_load_buckets_read ON public.mos_load_buckets;
CREATE POLICY mos_load_buckets_read ON public.mos_load_buckets
  FOR SELECT USING (public.wassell_mos_can('read'));
DROP POLICY IF EXISTS mos_load_buckets_write ON public.mos_load_buckets;
CREATE POLICY mos_load_buckets_write ON public.mos_load_buckets
  FOR ALL USING (public.wassell_mos_can('manage_roles'))
  WITH CHECK (public.wassell_mos_can('manage_roles'));

DROP POLICY IF EXISTS mos_role_load_read ON public.mos_role_load;
CREATE POLICY mos_role_load_read ON public.mos_role_load
  FOR SELECT USING (public.wassell_mos_can('read'));
DROP POLICY IF EXISTS mos_role_load_write ON public.mos_role_load;
CREATE POLICY mos_role_load_write ON public.mos_role_load
  FOR ALL USING (public.wassell_mos_can('manage_roles'))
  WITH CHECK (public.wassell_mos_can('manage_roles'));

DROP POLICY IF EXISTS mos_role_sla_read ON public.mos_role_sla;
CREATE POLICY mos_role_sla_read ON public.mos_role_sla
  FOR SELECT USING (public.wassell_mos_can('read'));
DROP POLICY IF EXISTS mos_role_sla_write ON public.mos_role_sla;
CREATE POLICY mos_role_sla_write ON public.mos_role_sla
  FOR ALL USING (public.wassell_mos_can('manage_roles'))
  WITH CHECK (public.wassell_mos_can('manage_roles'));

DROP POLICY IF EXISTS mos_posting_targets_read ON public.mos_posting_targets;
CREATE POLICY mos_posting_targets_read ON public.mos_posting_targets
  FOR SELECT USING (public.wassell_mos_can('read'));
DROP POLICY IF EXISTS mos_posting_targets_write ON public.mos_posting_targets;
CREATE POLICY mos_posting_targets_write ON public.mos_posting_targets
  FOR ALL USING (public.wassell_mos_can('manage_roles'))
  WITH CHECK (public.wassell_mos_can('manage_roles'));

-- Personal ledgers: own rows, or the performance manager.
DROP POLICY IF EXISTS mos_ratings_read ON public.mos_creative_ratings;
CREATE POLICY mos_ratings_read ON public.mos_creative_ratings
  FOR SELECT USING (
    contributor_user_id = public.wassell_app_user_id(auth.uid())
    OR public.wassell_mos_can('manage_performance')
    OR public.wassell_mos_can('review_performance'));

DROP POLICY IF EXISTS mos_xp_read ON public.mos_xp_ledger;
CREATE POLICY mos_xp_read ON public.mos_xp_ledger
  FOR SELECT USING (
    user_id = public.wassell_app_user_id(auth.uid())
    OR public.wassell_mos_can('manage_performance')
    OR public.wassell_mos_can('review_performance'));

DROP POLICY IF EXISTS mos_rewards_read ON public.mos_rewards;
CREATE POLICY mos_rewards_read ON public.mos_rewards
  FOR SELECT USING (public.wassell_mos_can('read'));
DROP POLICY IF EXISTS mos_rewards_write ON public.mos_rewards;
CREATE POLICY mos_rewards_write ON public.mos_rewards
  FOR ALL USING (public.wassell_mos_can('manage_performance'))
  WITH CHECK (public.wassell_mos_can('manage_performance'));

DROP POLICY IF EXISTS mos_reward_claims_read ON public.mos_reward_claims;
CREATE POLICY mos_reward_claims_read ON public.mos_reward_claims
  FOR SELECT USING (
    user_id = public.wassell_app_user_id(auth.uid())
    OR public.wassell_mos_can('manage_performance'));

DROP POLICY IF EXISTS mos_late_events_read ON public.mos_late_events;
CREATE POLICY mos_late_events_read ON public.mos_late_events
  FOR SELECT USING (
    user_id = public.wassell_app_user_id(auth.uid())
    OR public.wassell_mos_can('manage_performance'));

DROP POLICY IF EXISTS mos_discipline_read ON public.mos_discipline_actions;
CREATE POLICY mos_discipline_read ON public.mos_discipline_actions
  FOR SELECT USING (
    user_id = public.wassell_app_user_id(auth.uid())
    OR public.wassell_mos_can('manage_performance'));

DROP POLICY IF EXISTS mos_leaves_read ON public.mos_leaves;
CREATE POLICY mos_leaves_read ON public.mos_leaves
  FOR SELECT USING (
    user_id = public.wassell_app_user_id(auth.uid())
    OR public.wassell_mos_can('manage_performance'));

-- KPI goals/results are team-visible: recipients need to see what they can earn.
DROP POLICY IF EXISTS mos_perf_kpi_goals_read ON public.mos_perf_kpi_goals;
CREATE POLICY mos_perf_kpi_goals_read ON public.mos_perf_kpi_goals
  FOR SELECT USING (public.wassell_mos_can('read'));
DROP POLICY IF EXISTS mos_perf_kpi_goals_write ON public.mos_perf_kpi_goals;
CREATE POLICY mos_perf_kpi_goals_write ON public.mos_perf_kpi_goals
  FOR ALL USING (public.wassell_mos_can('manage_performance'))
  WITH CHECK (public.wassell_mos_can('manage_performance'));

DROP POLICY IF EXISTS mos_perf_kpi_recipients_read ON public.mos_perf_kpi_recipients;
CREATE POLICY mos_perf_kpi_recipients_read ON public.mos_perf_kpi_recipients
  FOR SELECT USING (public.wassell_mos_can('read'));
DROP POLICY IF EXISTS mos_perf_kpi_recipients_write ON public.mos_perf_kpi_recipients;
CREATE POLICY mos_perf_kpi_recipients_write ON public.mos_perf_kpi_recipients
  FOR ALL USING (public.wassell_mos_can('manage_performance'))
  WITH CHECK (public.wassell_mos_can('manage_performance'));

DROP POLICY IF EXISTS mos_perf_kpi_results_read ON public.mos_perf_kpi_results;
CREATE POLICY mos_perf_kpi_results_read ON public.mos_perf_kpi_results
  FOR SELECT USING (public.wassell_mos_can('read'));

DROP POLICY IF EXISTS mos_perf_paid_monthly_read ON public.mos_perf_paid_monthly;
CREATE POLICY mos_perf_paid_monthly_read ON public.mos_perf_paid_monthly
  FOR SELECT USING (
    public.wassell_mos_can('review_performance')
    OR public.wassell_mos_can('manage_performance'));

DROP POLICY IF EXISTS mos_perf_settings_read ON public.mos_perf_settings;
CREATE POLICY mos_perf_settings_read ON public.mos_perf_settings
  FOR SELECT USING (public.wassell_mos_can('read'));
DROP POLICY IF EXISTS mos_perf_settings_write ON public.mos_perf_settings;
CREATE POLICY mos_perf_settings_write ON public.mos_perf_settings
  FOR UPDATE USING (public.wassell_mos_can('manage_performance'))
  WITH CHECK (public.wassell_mos_can('manage_performance'));

-- Grants. Ledger writes happen ONLY through the SECURITY DEFINER engine
-- functions (migration _02); authenticated gets SELECT + the config writes RLS
-- allows. service_role bypasses RLS as everywhere else.
GRANT SELECT ON public.mos_creative_ratings, public.mos_xp_ledger,
  public.mos_reward_claims, public.mos_late_events, public.mos_discipline_actions,
  public.mos_leaves, public.mos_perf_kpi_results, public.mos_perf_paid_monthly
  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mos_load_buckets,
  public.mos_role_load, public.mos_role_sla, public.mos_posting_targets,
  public.mos_rewards, public.mos_perf_kpi_goals, public.mos_perf_kpi_recipients
  TO authenticated;
GRANT SELECT, UPDATE ON public.mos_perf_settings TO authenticated;
GRANT ALL ON public.mos_load_buckets, public.mos_role_load, public.mos_role_sla,
  public.mos_posting_targets, public.mos_creative_ratings, public.mos_xp_ledger,
  public.mos_rewards, public.mos_reward_claims, public.mos_late_events,
  public.mos_discipline_actions, public.mos_leaves, public.mos_perf_kpi_goals,
  public.mos_perf_kpi_recipients, public.mos_perf_kpi_results,
  public.mos_perf_paid_monthly, public.mos_perf_settings
  TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Seeds (locked values from the approved spec)
-- ────────────────────────────────────────────────────────────────────────────

-- Bucket map: video→video; post/carousel/story→post.
INSERT INTO public.mos_load_buckets (content_type_id, bucket)
SELECT id, CASE WHEN key = 'video' THEN 'video' ELSE 'post' END
FROM public.mos_content_types
ON CONFLICT (content_type_id) DO NOTHING;

-- Daily load: montage 4 post + 2 video; writer 10 post + 3 video.
INSERT INTO public.mos_role_load (role_id, bucket, daily_new_tasks)
SELECT r.id, v.bucket, v.n
FROM (VALUES
  ('mos_montage', 'post', 4), ('mos_montage', 'video', 2),
  ('mos_writer',  'post', 10), ('mos_writer',  'video', 3)
) AS v(role_key, bucket, n)
JOIN public.roles r ON r.key = v.role_key
ON CONFLICT (role_id, bucket) DO NOTHING;

-- SLA: writer post 4h / video 8h; montage post 6h / video 24h; review-ish
-- roles (manager, ops, ceo) 4h on any step.
INSERT INTO public.mos_role_sla (role_id, bucket, step_key, sla_hours)
SELECT r.id, v.bucket, '*', v.hours
FROM (VALUES
  ('mos_writer',  'post',  4::numeric), ('mos_writer',  'video',  8::numeric),
  ('mos_montage', 'post',  6::numeric), ('mos_montage', 'video', 24::numeric),
  ('mos_marketing_manager', '*', 4::numeric),
  ('mos_ops_supervisor',    '*', 4::numeric),
  ('mos_ceo',               '*', 4::numeric)
) AS v(role_key, bucket, hours)
JOIN public.roles r ON r.key = v.role_key
ON CONFLICT (role_id, bucket, step_key) DO NOTHING;

-- Cadence example (locked shape): Instagram 2 video + 1 post per day.
INSERT INTO public.mos_posting_targets (platform, bucket, per_day)
SELECT v.platform, v.bucket, v.n
FROM (VALUES ('instagram', 'video', 2), ('instagram', 'post', 1)) AS v(platform, bucket, n)
WHERE NOT EXISTS (
  SELECT 1 FROM public.mos_posting_targets t
  WHERE t.platform = v.platform AND t.bucket = v.bucket AND t.weekday IS NULL
);

-- One seed reward: a day off for 250 XP.
INSERT INTO public.mos_rewards (label_ar, label_en, cost_xp, kind)
SELECT 'يوم إجازة', 'Day off', 250, 'day_off'
WHERE NOT EXISTS (SELECT 1 FROM public.mos_rewards WHERE kind = 'day_off');

-- New capabilities (data, like every other capability): rating + the manager desk.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT r.id, v.capability
FROM (VALUES
  ('mos_marketing_manager', 'rate_creative'),
  ('mos_marketing_manager', 'manage_performance'),
  ('mos_ceo',               'manage_performance')
) AS v(role_key, capability)
JOIN public.roles r ON r.key = v.role_key
ON CONFLICT (role_id, capability) DO NOTHING;

-- New rail surfaces: myperf (own profile — every role) and performance (the
-- manager desk — manager + ceo; admin bypasses via wassell_mos_surface_level).
INSERT INTO public.surface_access (role_id, surface_key, level)
SELECT r.id, 'myperf', 'full'
FROM public.roles r WHERE r.domain = 'marketing'
ON CONFLICT (role_id, surface_key) DO NOTHING;

INSERT INTO public.surface_access (role_id, surface_key, level)
SELECT r.id, 'performance', 'full'
FROM public.roles r WHERE r.key IN ('mos_marketing_manager', 'mos_ceo')
ON CONFLICT (role_id, surface_key) DO NOTHING;

COMMIT;
