-- ============================================================================
-- Marketing OS — core: roles, workflow configuration, content, tasks, scenes.
--
-- A GROUND-UP module. It deliberately shares NOTHING with the `mkt_*` marketing
-- tables: new prefix (`mos_`), own role grants, own capability function, own
-- content/task/scene tables. The only things reused are app-wide primitives that
-- belong to no module — `public.users`, `public.files`, `wassell_app_user_id()`
-- and `wassell_is_admin()`.
--
-- FIVE ROLES, AND WHY THE APPROVAL SPLIT MATTERS
-- The design review measured that five of nine elapsed days on a content item
-- were spent waiting on review, not producing. So approval is split rather than
-- funnelled through one person: the Marketing Manager owns every CREATIVE
-- judgement (idea, script, copy, design, final cut); the Operations Supervisor
-- owns PROCESS sign-off (assets complete, scheduling correct, link captured);
-- the CEO signs off budget above a threshold and approves no content at all.
--
-- STATUS AND OWNER ARE NOT STORED
-- `mos_content` has no status column and no owner column on purpose. Both are
-- derived from the open row in `mos_tasks` and exposed through `mos_content_v`.
-- Storing them is exactly how the spreadsheet this replaces drifted out of sync
-- with reality: someone edits the status field, nobody moves the work.
--
-- ONE BOUNDED JSONB COLUMN
-- `mos_content.data` holds only type-specific creative prose — headlines,
-- caption, script, voice-over text. Those are documents: never filtered, sorted
-- or joined on. Everything the app queries IS a real typed column. That line is
-- where the previous module went wrong and this one does not.
--
-- REFERENCES ARE ALLOCATED IN THE DATABASE
-- `V-004` style refs come from a row-locked counter on `mos_content_types`, not
-- from the client. The repo has a documented open bug where client-side
-- read-modify-write on `auto_id_counters` produces duplicate IDs under
-- concurrency; this cannot reproduce it.
--
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Roles and capabilities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_role_grants (
  user_id             uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  mos_role            text NOT NULL,
  granted_by_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_role_grants_role_check') THEN
    ALTER TABLE public.mos_role_grants ADD CONSTRAINT mos_role_grants_role_check
      CHECK (mos_role IN ('ceo','marketing_manager','ops_supervisor','writer','montage','viewer'));
  END IF;
END $$;

COMMENT ON TABLE public.mos_role_grants IS
  'Marketing OS role per user. Five working roles + viewer. App admins resolve to '
  'administrator without a grant. Steps point at ROLES, never people — replacing '
  'who fills a role is one row here.';

-- Resolve the caller's marketing role.
CREATE OR REPLACE FUNCTION public.wassell_mos_role(p_auth_uid uuid DEFAULT auth.uid())
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_auth_uid IS NULL THEN 'none'
    WHEN public.wassell_is_admin(p_auth_uid) THEN 'administrator'
    ELSE COALESCE(
      (SELECT g.mos_role FROM public.mos_role_grants g
        WHERE g.user_id = public.wassell_app_user_id(p_auth_uid)),
      'viewer')
  END;
$function$;

-- The capability matrix. This is the authorization boundary; the UI only mirrors it.
CREATE OR REPLACE FUNCTION public.wassell_mos_can(
  p_capability text,
  p_auth_uid   uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT CASE public.wassell_mos_role(p_auth_uid)
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
  END;
$function$;

GRANT EXECUTE ON FUNCTION public.wassell_mos_role(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wassell_mos_can(text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Shared updated_at trigger for the module
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mos_tg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- 3. Workflow configuration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  label_ar    text NOT NULL,
  label_en    text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.mos_workflow_steps (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id            uuid NOT NULL REFERENCES public.mos_workflows(id) ON DELETE CASCADE,
  position               integer NOT NULL,
  key                    text NOT NULL,
  label_ar               text NOT NULL,
  label_en               text NOT NULL,
  -- The role that performs this step. NEVER a user id.
  role                   text NOT NULL,
  due_days               integer NOT NULL DEFAULT 2,
  is_approval            boolean NOT NULL DEFAULT false,
  -- 'creative' → Marketing Manager, 'process' → Operations Supervisor.
  approval_kind          text,
  require_note_on_reject boolean NOT NULL DEFAULT true,
  creates_revision       boolean NOT NULL DEFAULT true,
  required_fields        jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_files         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, position),
  UNIQUE (workflow_id, key)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_workflow_steps_role_check') THEN
    ALTER TABLE public.mos_workflow_steps ADD CONSTRAINT mos_workflow_steps_role_check
      CHECK (role IN ('ceo','marketing_manager','ops_supervisor','writer','montage'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_workflow_steps_approval_check') THEN
    ALTER TABLE public.mos_workflow_steps ADD CONSTRAINT mos_workflow_steps_approval_check
      CHECK (
        (is_approval = false AND approval_kind IS NULL)
        OR (is_approval = true AND approval_kind IN ('creative','process','budget'))
      );
  END IF;
END $$;

COMMENT ON COLUMN public.mos_workflow_steps.approval_kind IS
  'creative = Marketing Manager, process = Operations Supervisor, budget = CEO. '
  'Splitting these is what stops one person becoming the queue for everything.';

-- ---------------------------------------------------------------------------
-- 4. Content types — adding a type is a row, not a module
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_content_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  label_ar     text NOT NULL,
  label_en     text NOT NULL,
  -- Ref prefix: 'P-', 'V-', 'S-'. Several types may share one (post/carousel).
  prefix       text NOT NULL,
  workflow_id  uuid REFERENCES public.mos_workflows(id) ON DELETE SET NULL,
  -- Which creative fields this type shows, and their order. Configuration, not data.
  field_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Row-locked counter. See the ref trigger below.
  next_number  integer NOT NULL DEFAULT 1,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- 5. Content
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_content (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Allocated by trigger. 'V-004'.
  ref                text UNIQUE,
  content_type_id    uuid NOT NULL REFERENCES public.mos_content_types(id) ON DELETE RESTRICT,
  workflow_id        uuid REFERENCES public.mos_workflows(id) ON DELETE SET NULL,
  title              text NOT NULL,

  -- all_projects record id. JSONB row in `records`, so no FK is possible.
  project_id         uuid,
  campaign_id        uuid,

  purpose            text NOT NULL DEFAULT 'organic',
  language           text NOT NULL DEFAULT 'ar',

  -- The brief. Typed because every one of these is filtered or reported on.
  goal               text,
  audience           text,
  angle              text,
  cta                text,

  target_publish_at  timestamptz,
  due_at             timestamptz,

  -- Type-specific creative prose ONLY (headlines, caption, script, voice-over).
  -- Never filtered, sorted or joined on. See the header note.
  data               jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_content_purpose_check') THEN
    ALTER TABLE public.mos_content ADD CONSTRAINT mos_content_purpose_check
      CHECK (purpose IN ('organic','paid','both'));
  END IF;
END $$;

COMMENT ON COLUMN public.mos_content.project_id IS 'all_projects record id (JSONB in `records`: no FK possible)';
COMMENT ON COLUMN public.mos_content.data IS
  'Type-specific creative prose only. Anything the app filters, sorts or reports '
  'on must be a real column instead.';

CREATE INDEX IF NOT EXISTS idx_mos_content_type    ON public.mos_content(content_type_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mos_content_project ON public.mos_content(project_id)      WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mos_content_due     ON public.mos_content(due_at)          WHERE archived_at IS NULL;

-- Atomic ref allocation. The UPDATE ... RETURNING takes a row lock on the type,
-- so two concurrent inserts cannot receive the same number.
CREATE OR REPLACE FUNCTION public.mos_tg_assign_ref()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_prefix text; v_num integer;
BEGIN
  IF NEW.ref IS NOT NULL THEN RETURN NEW; END IF;
  UPDATE public.mos_content_types
     SET next_number = next_number + 1
   WHERE id = NEW.content_type_id
   RETURNING prefix, next_number - 1 INTO v_prefix, v_num;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'MOS:UNKNOWN_CONTENT_TYPE' USING ERRCODE = 'check_violation';
  END IF;
  NEW.ref := v_prefix || lpad(v_num::text, 3, '0');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mos_content_ref_tg ON public.mos_content;
CREATE TRIGGER mos_content_ref_tg
  BEFORE INSERT ON public.mos_content
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_assign_ref();

-- ---------------------------------------------------------------------------
-- 6. Tasks — generated by the workflow, never hand-assigned
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id       uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  step_id          uuid REFERENCES public.mos_workflow_steps(id) ON DELETE SET NULL,
  -- The role responsible. assignee is resolved from the role, and may be null
  -- when nobody currently fills it — that is a visible gap, not an error.
  role             text NOT NULL,
  assignee_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'open',
  result           text,
  note             text,
  -- Review round. 2 means this came back once.
  round            integer NOT NULL DEFAULT 1,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  due_at           timestamptz,
  closed_at        timestamptz,
  closed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_tasks_status_check') THEN
    ALTER TABLE public.mos_tasks ADD CONSTRAINT mos_tasks_status_check
      CHECK (status IN ('open','done','skipped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_tasks_result_check') THEN
    ALTER TABLE public.mos_tasks ADD CONSTRAINT mos_tasks_result_check
      CHECK (result IS NULL OR result IN ('submitted','approved','changes_requested'));
  END IF;
  -- A rejection without a reason just restarts the loop blind.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_tasks_reject_note_check') THEN
    ALTER TABLE public.mos_tasks ADD CONSTRAINT mos_tasks_reject_note_check
      CHECK (result IS DISTINCT FROM 'changes_requested' OR note IS NOT NULL);
  END IF;
END $$;

-- At most ONE open task per content item: that open row IS the item's status and
-- current owner, so two would make both ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_tasks_one_open
  ON public.mos_tasks(content_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_mos_tasks_assignee ON public.mos_tasks(assignee_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_mos_tasks_role     ON public.mos_tasks(role)             WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_mos_tasks_due      ON public.mos_tasks(due_at)           WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- 7. Scenes — a real table because the shoot list is derived from it
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_scenes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id      uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  start_sec       numeric(6,2),
  end_sec         numeric(6,2),
  visual          text,
  voiceover       text,
  on_screen_text  text,
  -- 'have' | 'to_make' | 'missing'. 'missing' is what rolls up into a shoot request.
  footage_status  text NOT NULL DEFAULT 'missing',
  asset_id        uuid,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, position)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_scenes_footage_check') THEN
    ALTER TABLE public.mos_scenes ADD CONSTRAINT mos_scenes_footage_check
      CHECK (footage_status IN ('have','to_make','missing'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mos_scenes_missing ON public.mos_scenes(content_id) WHERE footage_status = 'missing';

-- ---------------------------------------------------------------------------
-- 8. updated_at triggers
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mos_role_grants','mos_workflows','mos_workflow_steps','mos_content_types',
    'mos_content','mos_tasks','mos_scenes'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch_tg', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.mos_tg_touch_updated_at()',
      t || '_touch_tg', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Derived view — status and current owner come from the open task
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.mos_content_v
WITH (security_invoker = true) AS
SELECT
  c.*,
  ct.key         AS content_type_key,
  ct.label_ar    AS content_type_label_ar,
  ct.label_en    AS content_type_label_en,
  t.id           AS open_task_id,
  t.role         AS current_role,
  t.assignee_user_id AS current_assignee_user_id,
  t.due_at       AS current_task_due_at,
  t.round        AS current_round,
  s.key          AS current_step_key,
  s.label_ar     AS current_step_label_ar,
  s.label_en     AS current_step_label_en,
  s.position     AS current_step_position,
  -- The item's status IS its open step. No stored status column to drift.
  --
  -- "No open task" is ambiguous on its own: it means either the workflow
  -- finished or it never started. Those must not collapse into the same value —
  -- reporting brand-new content as 'done' is exactly the silent wrongness this
  -- module exists to avoid — so the total task count disambiguates them.
  CASE
    WHEN s.key IS NOT NULL   THEN s.key
    WHEN t.id  IS NOT NULL   THEN 'unassigned'
    WHEN tc.total_tasks > 0  THEN 'done'
    ELSE 'draft'
  END AS status_key
FROM public.mos_content c
JOIN public.mos_content_types ct ON ct.id = c.content_type_id
LEFT JOIN public.mos_tasks t ON t.content_id = c.id AND t.status = 'open'
LEFT JOIN public.mos_workflow_steps s ON s.id = t.step_id
LEFT JOIN LATERAL (
  SELECT count(*) AS total_tasks FROM public.mos_tasks tt WHERE tt.content_id = c.id
) tc ON true;

COMMENT ON VIEW public.mos_content_v IS
  'Content with status and current owner DERIVED from the open task. There is no '
  'stored status column anywhere in this module — that is what kept the previous '
  'spreadsheet out of sync with the actual work.';

-- ---------------------------------------------------------------------------
-- 10. RLS — the database is the authorization boundary
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text; cap text;
BEGIN
  FOR t, cap IN SELECT * FROM (VALUES
    ('mos_role_grants',    'manage_roles'),
    ('mos_workflows',      'manage_settings'),
    ('mos_workflow_steps', 'manage_settings'),
    ('mos_content_types',  'manage_settings'),
    ('mos_content',        'write_content'),
    ('mos_tasks',          'assign'),
    ('mos_scenes',         'write_content')
  ) v(t, cap)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
         USING (public.wassell_mos_can('read'))$p$, t || '_read', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_ins', t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
         WITH CHECK (public.wassell_mos_can(%L))$p$, t || '_ins', t, cap);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_upd', t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
         USING (public.wassell_mos_can(%L)) WITH CHECK (public.wassell_mos_can(%L))$p$,
      t || '_upd', t, cap, cap);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_del', t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
         USING (public.wassell_mos_can(%L))$p$, t || '_del', t, cap);
  END LOOP;
END $$;

-- A task may also be closed by the person it is assigned to, even when their
-- role lacks the broad 'assign' capability — otherwise a Writer could never
-- submit their own work.
DROP POLICY IF EXISTS mos_tasks_upd_own ON public.mos_tasks;
CREATE POLICY mos_tasks_upd_own ON public.mos_tasks FOR UPDATE TO authenticated
  USING (assignee_user_id = public.wassell_app_user_id(auth.uid()))
  WITH CHECK (assignee_user_id = public.wassell_app_user_id(auth.uid()));

COMMIT;
