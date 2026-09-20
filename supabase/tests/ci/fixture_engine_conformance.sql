-- ============================================================================
-- Fixture for `assert_engine_conformance.sql`.
--
-- The CI database is the translation bootstrap: it has no Marketing OS tables.
-- This builds the smallest shape the conformance assertions need — the two
-- rate tables, the roles they key off, and `mos_task_units` — so the assertion
-- tests the RULE rather than whatever production happens to contain.
--
-- The rates here deliberately MATCH (design 5/5, writing 10/10). A mutation
-- that breaks the planner/dispatcher agreement must make the assertion fail;
-- seeding them already disagreeing would make it pass for the wrong reason.
-- ============================================================================

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.roles (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key  text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS public.users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_active        boolean NOT NULL DEFAULT true,
  role_assignments jsonb   NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS public.mos_step_rules (
  step_key        text PRIMARY KEY,
  capacity_key    text,
  daily_limit     int,
  allowance_hours numeric
);

CREATE TABLE IF NOT EXISTS public.mos_role_load (
  role_id         uuid NOT NULL,
  bucket          text NOT NULL,
  daily_new_tasks int  NOT NULL,
  PRIMARY KEY (role_id, bucket)
);

CREATE TABLE IF NOT EXISTS public.mos_user_capacity (
  user_id     uuid NOT NULL,
  bucket      text NOT NULL,
  daily_slots int  NOT NULL,
  PRIMARY KEY (user_id, bucket)
);

CREATE TABLE IF NOT EXISTS public.mos_content (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id      uuid,
  archived_at timestamptz
);

-- The dispatcher's cost function, verbatim in shape: a row costs one unit per
-- live member (never less than one); everything else costs one.
CREATE OR REPLACE FUNCTION public.mos_task_units(p_subject_table text, p_subject_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN p_subject_table = 'mos_content_rows' THEN
           GREATEST((SELECT count(*) FROM public.mos_content c
                      WHERE c.row_id = p_subject_id AND c.archived_at IS NULL), 1)::numeric
         ELSE 1::numeric END
$$;

INSERT INTO public.roles (key) VALUES ('mos_montage'), ('mos_writer')
  ON CONFLICT (key) DO NOTHING;

INSERT INTO public.mos_step_rules (step_key, capacity_key, daily_limit, allowance_hours) VALUES
  ('writing',              'writing', 10,   24),
  ('writing_review',       NULL,      NULL, 12),
  ('design',               'design',  5,    24),
  ('design_writer_review', NULL,      NULL, 12),
  ('design_review',        NULL,      NULL, 12)
  ON CONFLICT (step_key) DO UPDATE
    SET capacity_key = EXCLUDED.capacity_key, daily_limit = EXCLUDED.daily_limit;

INSERT INTO public.mos_role_load (role_id, bucket, daily_new_tasks)
SELECT id, 'post', CASE WHEN key = 'mos_montage' THEN 5 ELSE 10 END FROM public.roles
  ON CONFLICT (role_id, bucket) DO UPDATE SET daily_new_tasks = EXCLUDED.daily_new_tasks;

-- One designer at the gate's rate, and one approver at a deliberate ZERO —
-- holding the montage role while doing no production work. A capacity change
-- that raises "every montage holder" must not turn that zero into a producer
-- (it did, on the first run of the 2026-09-20 migration).
WITH montage AS (SELECT id FROM public.roles WHERE key = 'mos_montage')
INSERT INTO public.users (role_assignments)
SELECT jsonb_build_array(jsonb_build_object('role_id', id::text)) FROM montage
UNION ALL
SELECT jsonb_build_array(jsonb_build_object('role_id', id::text)) FROM montage;

INSERT INTO public.mos_user_capacity (user_id, bucket, daily_slots)
SELECT u.id, 'post', CASE WHEN row_number() OVER (ORDER BY u.id) = 1 THEN 5 ELSE 0 END
  FROM public.users u
  ON CONFLICT (user_id, bucket) DO UPDATE SET daily_slots = EXCLUDED.daily_slots;
