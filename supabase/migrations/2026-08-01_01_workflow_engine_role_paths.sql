-- ============================================================================
-- Workflow engine: role-paths become CANONICAL workflows, marketing roles
-- become CANONICAL roles, and the mos_* engine tables are retired.
--
-- WHAT
-- The Marketing OS shipped with its own workflow engine (`mos_workflows` +
-- `mos_workflow_steps` + `mos_tasks` + `mos_role_grants`) beside the platform's
-- canonical one (`workflows` + `roles` + `users.role_assignments`). Two engines
-- means two permission stacks, two task lists, and no shared versioning. This
-- migration folds the marketing engine INTO the canonical one:
--
--   * `workflows.kind` distinguishes 'automation' (the original kind) from
--     'role_path' (a ordered chain of role-owned steps, what mos_workflows was).
--   * `workflow_versions` snapshots every workflow definition on every change,
--     for BOTH kinds — in-flight records pin the version they started under so
--     an edit to the path never rewrites history beneath a running item.
--   * The five marketing roles become rows in canonical `roles` (key 'mos_*'),
--     and `mos_role_grants` folds into `users.role_assignments` (already a
--     multi-role array — one person can now be Writer AND Ops Supervisor).
--   * `surface_access` is the three-state (full/read/hidden) screen matrix from
--     design screen 33, keyed by role so it works for any future canonical role.
--   * `workflow_role_tasks` is mos_tasks promoted to an engine-generic table
--     (subject_table + subject_id instead of a hard FK to mos_content), with
--     the transition logic itself moved into SQL as
--     `workflow_advance_role_path` — ported from api/marketing-os.ts
--     'task_complete' so the API becomes a thin caller.
--
-- WHY VERSIONS ARE ENGINE-LEVEL, NOT MARKETING-LEVEL
-- Automation workflows have the same drift problem role-paths do: edit a live
-- workflow and in-flight records silently change behavior. Versioning only the
-- marketing tables would re-create the two-stack split one level down. Every
-- workflow kind gets versions; role-paths are merely the first consumer that
-- pins them (mos_content.workflow_version_id, ON DELETE RESTRICT — a pinned
-- version cannot be deleted out from under a running item).
--
-- RETIRED (section 12): mos_tasks, mos_workflow_steps, mos_role_grants,
-- mos_workflows. Their concerns now live in: workflow_role_tasks,
-- workflows.metadata->'steps' (+ workflow_versions), and roles/users.role_assignments.
-- `mos_content` / `mos_content_types` / `mos_scenes` and the campaigns/assets/
-- shoots tables STAY — only the engine moved.
-- ============================================================================
BEGIN;

-- Pre-migration task count, checked again in the validation block at the
-- bottom: the mos_tasks -> workflow_role_tasks move must be lossless.
CREATE TEMP TABLE _mos_pre_task_count ON COMMIT DROP AS
  SELECT count(*) AS n FROM public.mos_tasks;

-- ---------------------------------------------------------------------------
-- 1. workflows.kind — one table, two workflow kinds
-- ---------------------------------------------------------------------------

ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'automation';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_kind_check') THEN
    ALTER TABLE public.workflows ADD CONSTRAINT workflows_kind_check
      CHECK (kind IN ('automation','role_path'));
  END IF;
END $$;

COMMENT ON COLUMN public.workflows.kind IS
  'automation = trigger/condition/action engine (the original kind). role_path = '
  'an ordered chain of role-owned steps in metadata->''steps'', advanced by '
  'workflow_advance_role_path().';

-- Role-path rows carry no trigger: trigger_event must accept NULL (the CHECK
-- constraint passes on NULL). Guarded so re-running is safe.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.workflows'::regclass
       AND attname = 'trigger_event' AND attnotnull
  ) THEN
    ALTER TABLE public.workflows ALTER COLUMN trigger_event DROP NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. workflow_versions — definition snapshots for EVERY workflow kind
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id        uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  version_no         integer NOT NULL,
  definition         jsonb NOT NULL,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow
  ON public.workflow_versions(workflow_id);

COMMENT ON TABLE public.workflow_versions IS
  'Append-only snapshot of a workflow definition, written by trigger on every '
  'definition change. In-flight records pin a version so editing a path never '
  'rewrites the rules beneath running work.';

-- Definitions are internal app data every role must be able to render (the
-- whole point is that a pinned version stays readable by the people working
-- under it). Writes come only from the SECURITY DEFINER trigger / service role.
ALTER TABLE public.workflow_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_versions_read ON public.workflow_versions;
CREATE POLICY workflow_versions_read ON public.workflow_versions
  FOR SELECT TO authenticated USING (true);

-- Snapshot on INSERT and on any UPDATE that changes the definition. A bare
-- is_active flip is NOT a definition change — pausing a path must not fork
-- a new version under running records.
CREATE OR REPLACE FUNCTION public.workflows_tg_write_version()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_def     jsonb;
  v_old_def jsonb;
BEGIN
  v_def := jsonb_build_object(
    'label_ar',         NEW.label_ar,
    'label_en',         NEW.label_en,
    'kind',             NEW.kind,
    'trigger_model_id', NEW.trigger_model_id,
    'trigger_event',    NEW.trigger_event,
    'conditions',       NEW.conditions,
    'actions',          NEW.actions,
    'branches',         NEW.branches,
    'metadata',         NEW.metadata);

  IF TG_OP = 'UPDATE' THEN
    v_old_def := jsonb_build_object(
      'label_ar',         OLD.label_ar,
      'label_en',         OLD.label_en,
      'kind',             OLD.kind,
      'trigger_model_id', OLD.trigger_model_id,
      'trigger_event',    OLD.trigger_event,
      'conditions',       OLD.conditions,
      'actions',          OLD.actions,
      'branches',         OLD.branches,
      'metadata',         OLD.metadata);
    IF v_def IS NOT DISTINCT FROM v_old_def THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO public.workflow_versions
    (workflow_id, version_no, definition, created_by_user_id)
  SELECT NEW.id,
         COALESCE(MAX(v.version_no), 0) + 1,
         v_def,
         public.wassell_app_user_id(auth.uid())
    FROM public.workflow_versions v
   WHERE v.workflow_id = NEW.id;

  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS workflows_write_version_tg ON public.workflows;
CREATE TRIGGER workflows_write_version_tg
  AFTER INSERT OR UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.workflows_tg_write_version();

-- Backfill version 1 for every pre-existing workflow that has none. (The
-- role-path rows inserted in section 7 get their version 1 from the trigger
-- itself, after this backfill has run.)
INSERT INTO public.workflow_versions
  (workflow_id, version_no, definition, created_by_user_id)
SELECT w.id, 1,
       jsonb_build_object(
         'label_ar',         w.label_ar,
         'label_en',         w.label_en,
         'kind',             w.kind,
         'trigger_model_id', w.trigger_model_id,
         'trigger_event',    w.trigger_event,
         'conditions',       w.conditions,
         'actions',          w.actions,
         'branches',         w.branches,
         'metadata',         w.metadata),
       NULL
  FROM public.workflows w
 WHERE NOT EXISTS (
   SELECT 1 FROM public.workflow_versions v WHERE v.workflow_id = w.id);

-- ---------------------------------------------------------------------------
-- 3. Marketing roles become canonical roles; grants fold into role_assignments
-- ---------------------------------------------------------------------------

ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_key
  ON public.roles(key) WHERE key IS NOT NULL;

COMMENT ON COLUMN public.roles.key IS
  'Stable machine key for system-seeded roles (e.g. mos_writer). NULL for '
  'user-created roles.';

-- Fixed ids so migrations, seeds and code can reference the roles literally.
INSERT INTO public.roles (id, key, label_ar, label_en, schema, is_system) VALUES
  ('c0febe01-0000-4000-8000-000000000001', 'mos_ceo',               'الرئيس التنفيذي', 'CEO',               '{"sections":[]}'::jsonb, true),
  ('c0febe01-0000-4000-8000-000000000002', 'mos_marketing_manager', 'مدير التسويق',    'Marketing Manager', '{"sections":[]}'::jsonb, true),
  ('c0febe01-0000-4000-8000-000000000003', 'mos_ops_supervisor',    'مشرف العمليات',   'Ops Supervisor',    '{"sections":[]}'::jsonb, true),
  ('c0febe01-0000-4000-8000-000000000004', 'mos_writer',            'الكاتب',          'Writer',            '{"sections":[]}'::jsonb, true),
  ('c0febe01-0000-4000-8000-000000000005', 'mos_montage',           'المونتاج',        'Montage',           '{"sections":[]}'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

-- mos_role_grants (one row per user) -> users.role_assignments (jsonb array,
-- multi-role). 'viewer' grants migrate to NOTHING: viewer is the default when
-- no marketing role is held, so a row for it would be noise. Users who already
-- hold the role (idempotent re-run, or a pre-seeded assignment) are skipped.
UPDATE public.users u
   SET role_assignments =
         COALESCE(u.role_assignments, '[]'::jsonb)
         || jsonb_build_object('role_id', m.role_id::text, 'field_values', '{}'::jsonb)
  FROM public.mos_role_grants g
  JOIN (VALUES
    ('ceo',               'c0febe01-0000-4000-8000-000000000001'::uuid),
    ('marketing_manager', 'c0febe01-0000-4000-8000-000000000002'::uuid),
    ('ops_supervisor',    'c0febe01-0000-4000-8000-000000000003'::uuid),
    ('writer',            'c0febe01-0000-4000-8000-000000000004'::uuid),
    ('montage',           'c0febe01-0000-4000-8000-000000000005'::uuid)
  ) AS m(mos_role, role_id) ON m.mos_role = g.mos_role
 WHERE g.user_id = u.id
   AND NOT EXISTS (
     SELECT 1
       FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) elem
      WHERE elem->>'role_id' = m.role_id::text);

-- ---------------------------------------------------------------------------
-- 4. surface_access — the three-state screen matrix (design screen 33)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.surface_access (
  role_id     uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  surface_key text NOT NULL,
  level       text NOT NULL CHECK (level IN ('full','read','hidden')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, surface_key)
);

COMMENT ON TABLE public.surface_access IS
  'Per-role, per-surface visibility: full / read / hidden. ''hidden'' means the '
  'surface does not exist in the user''s sidebar at all — no disabled button '
  'leading to a refusal. Absence of a row means hidden.';

ALTER TABLE public.surface_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS surface_access_read ON public.surface_access;
CREATE POLICY surface_access_read ON public.surface_access
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS surface_access_ins ON public.surface_access;
CREATE POLICY surface_access_ins ON public.surface_access
  FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('manage_roles'));

DROP POLICY IF EXISTS surface_access_upd ON public.surface_access;
CREATE POLICY surface_access_upd ON public.surface_access
  FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('manage_roles'))
  WITH CHECK (public.wassell_mos_can('manage_roles'));

DROP POLICY IF EXISTS surface_access_del ON public.surface_access;
CREATE POLICY surface_access_del ON public.surface_access
  FOR DELETE TO authenticated
  USING (public.wassell_mos_can('manage_roles'));

DROP TRIGGER IF EXISTS surface_access_touch_tg ON public.surface_access;
CREATE TRIGGER surface_access_touch_tg
  BEFORE UPDATE ON public.surface_access
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_touch_updated_at();

-- Seed transcribed from docs/marketing-reference/source/screens/s33.html
-- (column order there: الرئيس التنفيذي, مدير التسويق, مشرف العمليات, الكاتب, المونتير;
--  ● = full, ○ = read, — = hidden). Row-label -> surface_key mapping:
--   نظرة عامة                  -> overview
--   مهامي                      -> mywork
--   متابعة الفريق              -> team
--   مكتبة المحتوى              -> content
--   الجدولة والنشر             -> calendar
--   مكتبة المواد               -> library
--   طلبات التصوير              -> shoots
--   الحملات والتنفيذات         -> campaigns
--   الأداء والعائد             -> numbers
--   مسارات العمل وأنواع المحتوى -> settings
--   الأدوار والصلاحيات         -> roles
-- s33 rows that are ACTIONS, not surfaces (إنشاء محتوى, كتابة النص والكابشن,
-- رفع التصميم والمونتاج, اعتماد إبداعي, اعتماد إجرائي, الرفع والإدخال,
-- حذف أو أرشفة مادة, إنشاء حملة وتحويل ميزانية, توقيع ميزانية فوق ٥٠ ألف,
-- المنصات والحسابات) are governed by capabilities, not this matrix, and are
-- omitted. Keys with no s33 row (search, notifications) are omitted per design.
INSERT INTO public.surface_access (role_id, surface_key, level)
SELECT r.id, g.surface_key, u.lvl
  FROM (VALUES
    --  surface_key    ceo        mm         ops        writer     montage
    ('overview',   'full',   'full',   'full',   'hidden',  'hidden'),
    ('mywork',     'read',   'full',   'full',   'full',    'full'),
    ('team',       'read',   'full',   'full',   'hidden',  'hidden'),
    ('content',    'read',   'full',   'full',   'full',    'full'),
    ('calendar',   'hidden', 'full',   'full',   'full',    'hidden'),
    ('library',    'hidden', 'full',   'full',   'read',    'full'),
    ('shoots',     'hidden', 'full',   'full',   'read',    'full'),
    ('campaigns',  'read',   'full',   'read',   'hidden',  'hidden'),
    ('numbers',    'full',   'full',   'full',   'read',    'hidden'),
    ('settings',   'hidden', 'full',   'hidden', 'hidden',  'hidden'),
    ('roles',      'read',   'full',   'hidden', 'hidden',  'hidden')
  ) AS g(surface_key, ceo, mm, ops, wr, mo)
  CROSS JOIN LATERAL (VALUES
    ('mos_ceo',               g.ceo),
    ('mos_marketing_manager', g.mm),
    ('mos_ops_supervisor',    g.ops),
    ('mos_writer',            g.wr),
    ('mos_montage',           g.mo)
  ) AS u(role_key, lvl)
  JOIN public.roles r ON r.key = u.role_key
ON CONFLICT (role_id, surface_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. The mos capability stack, rewritten over canonical role assignment
-- ---------------------------------------------------------------------------

-- ALL marketing roles the caller holds (multi-role is now possible — a person
-- can be Writer AND Ops Supervisor). App admins resolve to 'administrator'
-- without any assignment, as before. A user holding no marketing role is a
-- 'viewer'. An anonymous caller (NULL uid) gets the EMPTY set — no roles at
-- all — which is what keeps wassell_mos_can(NULL) false for everything.
CREATE OR REPLACE FUNCTION public.wassell_mos_roles(p_auth_uid uuid DEFAULT auth.uid())
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_auth_uid IS NULL THEN '{}'::text[]
    WHEN public.wassell_is_admin(p_auth_uid) THEN ARRAY['administrator']
    ELSE COALESCE(
      (SELECT array_agg(substring(r.key from 5))
         FROM public.users u
         JOIN public.roles r
           ON r.key LIKE 'mos\_%' ESCAPE '\'
          AND r.id::text IN (
                SELECT elem->>'role_id'
                  FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) elem)
        WHERE u.auth_uid = p_auth_uid),
      ARRAY['viewer'])
  END;
$function$;

-- Compat single-role resolver (the UI still asks "what is my role?"): the
-- highest-privilege role held, in a fixed order. 'none' for anonymous callers,
-- preserving the pre-migration behavior where NULL uid granted nothing.
CREATE OR REPLACE FUNCTION public.wassell_mos_role(p_auth_uid uuid DEFAULT auth.uid())
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN 'administrator'     = ANY(held) THEN 'administrator'
    WHEN 'marketing_manager' = ANY(held) THEN 'marketing_manager'
    WHEN 'ops_supervisor'    = ANY(held) THEN 'ops_supervisor'
    WHEN 'ceo'               = ANY(held) THEN 'ceo'
    WHEN 'writer'            = ANY(held) THEN 'writer'
    WHEN 'montage'           = ANY(held) THEN 'montage'
    WHEN 'viewer'            = ANY(held) THEN 'viewer'
    ELSE 'none'
  END
  FROM (SELECT public.wassell_mos_roles(p_auth_uid) AS held) AS r;
$function$;

-- The capability matrix. This is the authorization boundary; the UI only
-- mirrors it. Multi-role callers get the UNION of their roles' capabilities —
-- bool_or over the same per-role grants as before. CREATE OR REPLACE keeps
-- every existing RLS policy (mos_content, scenes, assets, shoots...) working
-- unchanged against the new assignment source.
CREATE OR REPLACE FUNCTION public.wassell_mos_can(
  p_capability text,
  p_auth_uid   uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(bool_or(
    CASE role_name
      WHEN 'administrator'     THEN true
      WHEN 'marketing_manager' THEN true
      -- Watches outcomes and signs off money. Approves no content.
      WHEN 'ceo' THEN p_capability IN (
          'read','comment','approve_budget','review_performance')
      -- Owns process, not creative judgement.
      WHEN 'ops_supervisor' THEN p_capability IN (
          'read','comment','assign','schedule','publish',
          'approve_process','manage_assets','enter_metrics','review_performance')
      -- Writes, schedules and publishes. Approves nothing.
      WHEN 'writer' THEN p_capability IN (
          'read','comment','write_content','schedule','publish')
      -- Design and montage. Produces, approves nothing.
      WHEN 'montage' THEN p_capability IN (
          'read','comment','write_content','manage_assets')
      WHEN 'viewer' THEN p_capability IN ('read')
      ELSE false
    END), false)
  FROM unnest(public.wassell_mos_roles(p_auth_uid)) AS role_name;
$function$;

-- Screen visibility for the caller: full / read / hidden. Administrators and
-- the Marketing Manager see everything. Otherwise the MAX level across held
-- marketing roles wins (full > read > hidden); a held role with NO row in
-- surface_access counts as hidden for that surface — absence is denial, not
-- inheritance. Viewers (no marketing role at all) get a read-only floor on
-- 'overview' alone so the app has somewhere to land them; everything else is
-- hidden.
CREATE OR REPLACE FUNCTION public.wassell_mos_surface_level(
  p_surface_key text,
  p_auth_uid    uuid DEFAULT auth.uid()
)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH held AS (
    SELECT unnest(public.wassell_mos_roles(p_auth_uid)) AS role_key
  ),
  levels AS (
    SELECT sa.level
      FROM held h
      JOIN public.roles r ON r.key = 'mos_' || h.role_key
      JOIN public.surface_access sa
        ON sa.role_id = r.id AND sa.surface_key = p_surface_key
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM held WHERE role_key IN ('administrator','marketing_manager'))
      THEN 'full'
    WHEN EXISTS (SELECT 1 FROM levels WHERE level = 'full') THEN 'full'
    WHEN EXISTS (SELECT 1 FROM levels WHERE level = 'read') THEN 'read'
    WHEN EXISTS (SELECT 1 FROM held WHERE role_key = 'viewer') AND p_surface_key = 'overview'
      THEN 'read'
    ELSE 'hidden'
  END;
$function$;

GRANT EXECUTE ON FUNCTION public.wassell_mos_roles(uuid)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wassell_mos_role(uuid)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wassell_mos_can(text, uuid)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wassell_mos_surface_level(text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. workflow_role_tasks — mos_tasks promoted to an engine-generic table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_role_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the task is about. 'mos_content' today; future consumers (any record,
  -- any module) reuse the same engine with their own subject_table + policies.
  subject_table       text NOT NULL DEFAULT 'mos_content',
  subject_id          uuid NOT NULL,
  -- The pinned definition this task was opened under. NULL only for legacy
  -- rows mid-migration; section 8 backfills it.
  workflow_version_id uuid REFERENCES public.workflow_versions(id),
  step_key            text,
  -- The role responsible. assignee is resolved from the role, and may be null
  -- when nobody currently fills it — that is a visible gap, not an error.
  role_key            text NOT NULL,
  assignee_user_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'open',
  result              text,
  note                text,
  -- On a changes_requested close, the reviewer may name the steps the rework
  -- must touch; stored here so the reopened step sees its scope.
  revision_targets    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Review round. 2 means this came back once.
  round               integer NOT NULL DEFAULT 1,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  due_at              timestamptz,
  closed_at           timestamptz,
  closed_by_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_role_tasks_status_check') THEN
    ALTER TABLE public.workflow_role_tasks ADD CONSTRAINT workflow_role_tasks_status_check
      CHECK (status IN ('open','done','skipped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_role_tasks_result_check') THEN
    ALTER TABLE public.workflow_role_tasks ADD CONSTRAINT workflow_role_tasks_result_check
      CHECK (result IS NULL OR result IN ('submitted','approved','changes_requested'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_role_tasks_role_check') THEN
    ALTER TABLE public.workflow_role_tasks ADD CONSTRAINT workflow_role_tasks_role_check
      CHECK (role_key IN ('ceo','marketing_manager','ops_supervisor','writer','montage'));
  END IF;
  -- A rejection without a reason just restarts the loop blind.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_role_tasks_reject_note_check') THEN
    ALTER TABLE public.workflow_role_tasks ADD CONSTRAINT workflow_role_tasks_reject_note_check
      CHECK (result IS DISTINCT FROM 'changes_requested' OR note IS NOT NULL);
  END IF;
END $$;

-- At most ONE open task per subject: that open row IS the subject's status and
-- current owner, so two would make both ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_role_tasks_one_open
  ON public.workflow_role_tasks(subject_table, subject_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_workflow_role_tasks_role     ON public.workflow_role_tasks(role_key)         WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_workflow_role_tasks_assignee ON public.workflow_role_tasks(assignee_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_workflow_role_tasks_due      ON public.workflow_role_tasks(due_at)           WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_workflow_role_tasks_subject  ON public.workflow_role_tasks(subject_table, subject_id);

DROP TRIGGER IF EXISTS workflow_role_tasks_touch_tg ON public.workflow_role_tasks;
CREATE TRIGGER workflow_role_tasks_touch_tg
  BEFORE UPDATE ON public.workflow_role_tasks
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_touch_updated_at();

-- RLS mirrors the mos_tasks policies, scoped to the marketing subject. Future
-- non-marketing consumers add their OWN policies for their subject_table —
-- these four never widen.
ALTER TABLE public.workflow_role_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_role_tasks_read ON public.workflow_role_tasks;
CREATE POLICY workflow_role_tasks_read ON public.workflow_role_tasks
  FOR SELECT TO authenticated
  USING (public.wassell_mos_can('read') AND subject_table = 'mos_content');

DROP POLICY IF EXISTS workflow_role_tasks_ins ON public.workflow_role_tasks;
CREATE POLICY workflow_role_tasks_ins ON public.workflow_role_tasks
  FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('assign') AND subject_table = 'mos_content');

DROP POLICY IF EXISTS workflow_role_tasks_upd ON public.workflow_role_tasks;
CREATE POLICY workflow_role_tasks_upd ON public.workflow_role_tasks
  FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('assign') AND subject_table = 'mos_content')
  WITH CHECK (public.wassell_mos_can('assign') AND subject_table = 'mos_content');

DROP POLICY IF EXISTS workflow_role_tasks_del ON public.workflow_role_tasks;
CREATE POLICY workflow_role_tasks_del ON public.workflow_role_tasks
  FOR DELETE TO authenticated
  USING (public.wassell_mos_can('assign') AND subject_table = 'mos_content');

-- A task may also be closed by the person it is assigned to, even when their
-- role lacks the broad 'assign' capability — otherwise a Writer could never
-- submit their own work.
DROP POLICY IF EXISTS workflow_role_tasks_upd_own ON public.workflow_role_tasks;
CREATE POLICY workflow_role_tasks_upd_own ON public.workflow_role_tasks
  FOR UPDATE TO authenticated
  USING (assignee_user_id = public.wassell_app_user_id(auth.uid()))
  WITH CHECK (assignee_user_id = public.wassell_app_user_id(auth.uid()));

-- Data move: mos_tasks -> workflow_role_tasks. step_id (a row in the retiring
-- mos_workflow_steps) becomes step_key (stable across versions); ids carry
-- over so any external reference to a task id keeps working.
-- workflow_version_id is backfilled in section 8, after content pinning.
INSERT INTO public.workflow_role_tasks
  (id, subject_table, subject_id, workflow_version_id, step_key, role_key,
   assignee_user_id, status, result, note, revision_targets, round,
   opened_at, due_at, closed_at, closed_by_user_id, created_at, updated_at)
SELECT t.id, 'mos_content', t.content_id, NULL,
       (SELECT s.key FROM public.mos_workflow_steps s WHERE s.id = t.step_id),
       t.role, t.assignee_user_id, t.status, t.result, t.note, '[]'::jsonb,
       t.round, t.opened_at, t.due_at, t.closed_at, t.closed_by_user_id,
       t.created_at, t.updated_at
  FROM public.mos_tasks t;

-- ---------------------------------------------------------------------------
-- 7. The mos workflows become canonical workflows (kind='role_path')
-- ---------------------------------------------------------------------------
-- SAME uuids, so existing mos_content.workflow_id / mos_content_types.workflow_id
-- values keep pointing at the right row after the FK swap in section 8. Steps
-- denormalize into metadata->'steps' — the trigger (section 2) snapshots this
-- insert as version 1, which is exactly what in-flight content pins to.
-- `branches` is deliberately omitted from the column list (NULL is correct for
-- role-paths).

INSERT INTO public.workflows
  (id, label_ar, label_en, kind, trigger_model_id, trigger_event,
   conditions, actions, is_active, metadata)
SELECT w.id, w.label_ar, w.label_en, 'role_path', NULL, NULL,
       '[]'::jsonb, '[]'::jsonb, w.is_active,
       jsonb_build_object(
         'managed_by', 'marketing_os',
         'key', w.key,
         'steps', (SELECT COALESCE(jsonb_agg(
                     jsonb_build_object(
                       'key',                   s.key,
                       'label_ar',              s.label_ar,
                       'label_en',              s.label_en,
                       'role_key',              s.role,
                       'due_days',              s.due_days,
                       'is_approval',           s.is_approval,
                       'approval_kind',         s.approval_kind,
                       'require_note_on_reject', s.require_note_on_reject,
                       'creates_revision',      s.creates_revision,
                       'required_fields',       s.required_fields,
                       'required_files',        s.required_files)
                     ORDER BY s.position), '[]'::jsonb)
                   FROM public.mos_workflow_steps s
                  WHERE s.workflow_id = w.id))
  FROM public.mos_workflows w
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Re-point FKs at canonical workflows; pin in-flight content to version 1
-- ---------------------------------------------------------------------------

ALTER TABLE public.mos_content
  DROP CONSTRAINT IF EXISTS mos_content_workflow_id_fkey;
ALTER TABLE public.mos_content
  ADD CONSTRAINT mos_content_workflow_id_fkey
  FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE SET NULL;

ALTER TABLE public.mos_content_types
  DROP CONSTRAINT IF EXISTS mos_content_types_workflow_id_fkey;
ALTER TABLE public.mos_content_types
  ADD CONSTRAINT mos_content_types_workflow_id_fkey
  FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE SET NULL;

-- RESTRICT, not SET NULL: deleting a version that running items are pinned to
-- is refused. Versions are append-only anyway.
ALTER TABLE public.mos_content
  ADD COLUMN IF NOT EXISTS workflow_version_id uuid
  REFERENCES public.workflow_versions(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.mos_content.workflow_version_id IS
  'The workflow definition this item is running under. Pinned at start time; '
  'editing the workflow creates a new version and never moves running items.';

-- Freeze every in-flight item on the exact definition it has been running
-- under (version 1 = the mos_workflow_steps snapshot from section 7).
UPDATE public.mos_content c
   SET workflow_version_id = (
     SELECT v.id FROM public.workflow_versions v
      WHERE v.workflow_id = c.workflow_id AND v.version_no = 1)
 WHERE c.workflow_id IS NOT NULL
   AND c.workflow_version_id IS NULL;

-- Tasks inherit the pin of their subject.
UPDATE public.workflow_role_tasks t
   SET workflow_version_id = c.workflow_version_id
  FROM public.mos_content c
 WHERE t.subject_table = 'mos_content'
   AND t.subject_id = c.id
   AND t.workflow_version_id IS NULL;

-- ---------------------------------------------------------------------------
-- 9. Rebuild mos_content_v over the new task table + pinned versions
-- ---------------------------------------------------------------------------
-- Same output columns as before — api/marketing-os.ts selects them by name —
-- but the open task now comes from workflow_role_tasks and the current step's
-- labels/position come from the PINNED version's steps array, never from the
-- live workflow row. An edit to the path therefore cannot relabel a step out
-- from under a running item.

DROP VIEW public.mos_content_v;

CREATE VIEW public.mos_content_v
WITH (security_invoker = true) AS
SELECT
  c.*,
  ct.key              AS content_type_key,
  ct.label_ar         AS content_type_label_ar,
  ct.label_en         AS content_type_label_en,
  t.id                AS open_task_id,
  t.role_key          AS owner_role,
  t.assignee_user_id  AS current_assignee_user_id,
  t.due_at            AS current_task_due_at,
  t.round             AS current_round,
  t.step_key          AS current_step_key,
  s.elem->>'label_ar' AS current_step_label_ar,
  s.elem->>'label_en' AS current_step_label_en,
  s.position          AS current_step_position,
  -- The item's status IS its open step. No stored status column to drift.
  -- "No open task" stays disambiguated by total task count (done vs draft),
  -- exactly as before.
  CASE
    WHEN s.elem IS NOT NULL THEN t.step_key
    WHEN t.id   IS NOT NULL THEN 'unassigned'
    WHEN tc.total_tasks > 0 THEN 'done'
    ELSE 'draft'
  END AS status_key
FROM public.mos_content c
JOIN public.mos_content_types ct ON ct.id = c.content_type_id
LEFT JOIN public.workflow_role_tasks t
  ON t.subject_table = 'mos_content' AND t.subject_id = c.id AND t.status = 'open'
LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
LEFT JOIN LATERAL (
  SELECT elem, ord::int AS position
    FROM jsonb_array_elements(v.definition->'metadata'->'steps')
         WITH ORDINALITY AS e(elem, ord)
   WHERE elem->>'key' = t.step_key
) s ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS total_tasks
    FROM public.workflow_role_tasks tt
   WHERE tt.subject_table = 'mos_content' AND tt.subject_id = c.id
) tc ON true;

COMMENT ON VIEW public.mos_content_v IS
  'Content with status and current owner DERIVED from the open task, with step '
  'labels read from the item''s PINNED workflow version. There is no stored '
  'status column anywhere in this module — that is what kept the previous '
  'spreadsheet out of sync with the actual work.';

-- ---------------------------------------------------------------------------
-- 10. workflow_advance_role_path — the transition, in SQL, transactional
-- ---------------------------------------------------------------------------
-- Ported from api/marketing-os.ts case 'task_complete': submit/approve opens
-- the next step by position; changes_requested (note mandatory) routes back to
-- the LAST prior step whose creates_revision=true — falling back to the first
-- step — and increments the round; completing the last step leaves no open
-- task, which mos_content_v derives as 'done'. Moving it into one SECURITY
-- DEFINER call makes close+open atomic and puts task-level authorization in
-- the same transaction as the mutation.

CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(
  p_subject_table text,
  p_subject_id    uuid,
  p_result        text,
  p_note          text  DEFAULT NULL,
  p_targets       jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_task      public.workflow_role_tasks%ROWTYPE;
  v_roles     text[];
  v_steps     jsonb;
  v_version   uuid;
  v_idx       integer;
  v_next      jsonb;
  v_new_id    uuid;
  v_round     integer;
  v_closed_by uuid;
BEGIN
  -- The engine is generic; only the marketing subject is wired up so far.
  IF p_subject_table <> 'mos_content' THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  SELECT * INTO v_task
    FROM public.workflow_role_tasks
   WHERE subject_table = p_subject_table
     AND subject_id    = p_subject_id
     AND status        = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:NO_OPEN_TASK';
  END IF;

  -- Definer rights bypass RLS, so the task-level authorization lives here:
  -- admins and the Marketing Manager may move anyone's task; otherwise the
  -- caller must HOLD the task's role or BE its assignee.
  v_roles := public.wassell_mos_roles(auth.uid());
  IF NOT (
       'administrator'     = ANY(v_roles)
    OR 'marketing_manager' = ANY(v_roles)
    OR v_task.role_key     = ANY(v_roles)
    OR v_task.assignee_user_id = public.wassell_app_user_id(auth.uid())
  ) THEN
    RAISE EXCEPTION 'MOS:NOT_YOUR_TASK' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_result NOT IN ('submitted','approved','changes_requested') THEN
    RAISE EXCEPTION 'MOS:BAD_RESULT %', p_result;
  END IF;
  -- Mirrors the reject-note CHECK so the caller gets a sentence, not a violation.
  IF p_result = 'changes_requested'
     AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;

  -- The PINNED definition, never the live workflow row.
  SELECT c.workflow_version_id, v.definition->'metadata'->'steps'
    INTO v_version, v_steps
    FROM public.mos_content c
    LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
   WHERE c.id = p_subject_id;

  v_closed_by := public.wassell_app_user_id(auth.uid());

  UPDATE public.workflow_role_tasks
     SET status           = 'done',
         result           = p_result,
         note             = p_note,
         revision_targets = COALESCE(p_targets, '[]'::jsonb),
         closed_at        = now(),
         closed_by_user_id = v_closed_by
   WHERE id = v_task.id;

  -- Content not bound to a version (no workflow): close and stop — 'done'.
  IF v_steps IS NULL
     OR jsonb_typeof(v_steps) <> 'array'
     OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  -- 0-based index of the current step within the pinned array.
  SELECT ord - 1 INTO v_idx
    FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
   WHERE elem->>'key' = v_task.step_key;

  IF p_result = 'changes_requested' THEN
    -- Back to the LAST step before the current one that creates revisions;
    -- if none does, the first step. The round increments so the loop stays
    -- visible in the task chain rather than overwriting the record it came from.
    SELECT elem INTO v_next
      FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
     WHERE ord - 1 < COALESCE(v_idx, 0)
       AND COALESCE((elem->>'creates_revision')::boolean, false)
     ORDER BY ord DESC
     LIMIT 1;
    IF v_next IS NULL THEN
      v_next := v_steps -> 0;
    END IF;
    v_round := v_task.round + 1;
  ELSE
    IF v_idx IS NOT NULL AND v_idx < jsonb_array_length(v_steps) - 1 THEN
      v_next := v_steps -> (v_idx + 1);
    ELSE
      v_next := NULL;  -- last step: no successor, the record is done
    END IF;
    v_round := v_task.round;
  END IF;

  IF v_next IS NOT NULL THEN
    INSERT INTO public.workflow_role_tasks
      (subject_table, subject_id, workflow_version_id, step_key, role_key,
       round, due_at)
    VALUES
      (p_subject_table, p_subject_id, v_version,
       v_next->>'key', v_next->>'role_key', v_round,
       now() + COALESCE((v_next->>'due_days')::int, 2) * interval '1 day')
    RETURNING id INTO v_new_id;
  END IF;

  RETURN jsonb_build_object(
    'closed_task_id', v_task.id,
    'opened_task_id', v_new_id,
    'next_step_key',  CASE WHEN v_next IS NULL THEN NULL ELSE v_next->>'key' END,
    'round',          v_round,
    'done',           v_next IS NULL);
END $function$;

COMMENT ON FUNCTION public.workflow_advance_role_path(text, uuid, text, text, jsonb) IS
  'Close the open role-path task and open the next one, atomically. Ported from '
  'api/marketing-os.ts task_complete; authorization is enforced inside because '
  'definer rights bypass RLS.';

GRANT EXECUTE ON FUNCTION public.workflow_advance_role_path(text, uuid, text, text, jsonb)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 11. workflow_role_task_transfer — hand an open task to a specific person
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_role_task_transfer(
  p_task_id    uuid,
  p_to_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.workflow_role_tasks%ROWTYPE;
BEGIN
  IF NOT (public.wassell_mos_can('manage_roles') OR public.wassell_mos_can('assign')) THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_task FROM public.workflow_role_tasks
   WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:TASK_NOT_FOUND';
  END IF;
  IF v_task.status <> 'open' THEN
    RAISE EXCEPTION 'MOS:TASK_NOT_OPEN';
  END IF;

  UPDATE public.workflow_role_tasks
     SET assignee_user_id = p_to_user_id,
         note = COALESCE(note, '')
              || E'\ntransferred by ' || public.wassell_app_user_id(auth.uid())::text
              || ' at ' || now()::text,
         updated_at = now()
   WHERE id = p_task_id;
END $function$;

GRANT EXECUTE ON FUNCTION public.workflow_role_task_transfer(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 12. Retirement — the marketing-branded engine tables
-- ---------------------------------------------------------------------------
-- Drop order respects the FKs among them: mos_tasks (-> steps), then steps
-- (-> mos_workflows), then role_grants, then mos_workflows. Every FK INTO
-- these tables from surviving tables was re-pointed at canonical `workflows`
-- in section 8, and mos_content_v was rebuilt over workflow_role_tasks in
-- section 9, so nothing else references them.
--
-- Where each concern now lives:
--   mos_tasks           -> workflow_role_tasks (engine-generic task table)
--   mos_workflow_steps  -> workflows.metadata->'steps' (+ workflow_versions)
--   mos_workflows       -> workflows WHERE kind = 'role_path'
--   mos_role_grants     -> canonical roles (key 'mos_*') + users.role_assignments
-- mos_content, mos_content_types, mos_scenes, mos_campaigns/executions/assets/
-- shoots/comments STAY — only the engine moved.

DROP TABLE IF EXISTS public.mos_tasks;
DROP TABLE IF EXISTS public.mos_workflow_steps;
DROP TABLE IF EXISTS public.mos_role_grants;
DROP TABLE IF EXISTS public.mos_workflows;

-- ---------------------------------------------------------------------------
-- Validation — fail the transaction loudly rather than migrate partially
-- ---------------------------------------------------------------------------

DO $$
DECLARE v_bad integer;
BEGIN
  -- (a) every content row bound to a workflow must be pinned to a version.
  SELECT count(*) INTO v_bad FROM public.mos_content
   WHERE workflow_id IS NOT NULL AND workflow_version_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'MOS-MIGRATION: % content rows have workflow_id but no workflow_version_id', v_bad;
  END IF;

  -- (b) the task move must be lossless.
  IF (SELECT count(*) FROM public.workflow_role_tasks)
     <> (SELECT n FROM _mos_pre_task_count) THEN
    RAISE EXCEPTION 'MOS-MIGRATION: task count drift: pre=% post=%',
      (SELECT n FROM _mos_pre_task_count),
      (SELECT count(*) FROM public.workflow_role_tasks);
  END IF;

  -- (c) every role-path workflow must carry a non-empty steps array.
  SELECT count(*) INTO v_bad FROM public.workflows
   WHERE kind = 'role_path'
     AND (metadata->'steps' IS NULL
          OR jsonb_typeof(metadata->'steps') <> 'array'
          OR jsonb_array_length(metadata->'steps') = 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'MOS-MIGRATION: % role_path workflows have no steps', v_bad;
  END IF;
END $$;

COMMIT;
