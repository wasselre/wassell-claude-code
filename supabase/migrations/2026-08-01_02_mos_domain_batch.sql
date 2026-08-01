-- ============================================================================
-- Marketing OS — domain batch: content versions, campaign brief/signature,
-- campaign event ledger, execution/asset/shoot/scene extensions, settings.
--
-- Runs AFTER 2026-08-01_01_workflow_engine_role_paths.sql (workflow_versions,
-- workflow_role_tasks, surface_access). Section H below REFUSES to run if
-- migration 01 has not created workflow_role_tasks yet.
--
-- WHAT THIS ADDS, AND WHY
-- A. mos_content_versions — a frozen snapshot of `data` + the scene list taken
--    every time a round is submitted. Review history stops being "trust me, I
--    changed it": the manager compares round N against round N-1.
-- B. Campaign brief columns + signature — the brief (audience/offer/destination/
--    measured_by) lives ON the campaign, and budget above the settings
--    threshold needs a named sign-off (signed_by/signed_at), not a hallway yes.
-- C. mos_campaign_events — the «ما الذي تغيّر» ledger. Append-only: nobody can
--    rewrite history, only add to it.
-- D-F. Small typed columns on executions / assets / shoots. Anything the app
--    filters or reports on is a real column — same rule as mos_core.
-- G. Scenes gain a 'template' footage status (reusable branded segments).
-- I. mos_settings — module-level key/value so thresholds are data, not code.
--
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- A. mos_content_versions — round snapshots written on submit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_content_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id          uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  -- Review round. 1 = first submission; matches mos_tasks.round.
  round               integer NOT NULL,
  -- Frozen copy of mos_content.data at submit time.
  data                jsonb NOT NULL,
  -- Frozen scene list at submit time (mos_scenes rows as jsonb).
  scenes              jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- Filled when THIS round got rejected — the reason lives with the version
  -- it rejected, not in a chat thread.
  rejected_note       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, round)
);

COMMENT ON TABLE public.mos_content_versions IS
  'One frozen snapshot per submit round: creative data + scene list as they were '
  'when submitted. The reviewer compares rounds instead of trusting memory.';

CREATE INDEX IF NOT EXISTS idx_mos_content_versions_content
  ON public.mos_content_versions(content_id);

ALTER TABLE public.mos_content_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mos_content_versions_read ON public.mos_content_versions;
CREATE POLICY mos_content_versions_read ON public.mos_content_versions
  FOR SELECT TO authenticated
  USING (public.wassell_mos_can('read'));

DROP POLICY IF EXISTS mos_content_versions_ins ON public.mos_content_versions;
CREATE POLICY mos_content_versions_ins ON public.mos_content_versions
  FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('write_content'));

-- UPDATE exists only to attach the rejection note to the round it rejected.
DROP POLICY IF EXISTS mos_content_versions_upd ON public.mos_content_versions;
CREATE POLICY mos_content_versions_upd ON public.mos_content_versions
  FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('assign'))
  WITH CHECK (public.wassell_mos_can('assign'));

-- No DELETE policy: version history is not erasable.

-- ---------------------------------------------------------------------------
-- B. Campaign brief + signature columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.mos_campaigns ADD COLUMN IF NOT EXISTS audience          text;
ALTER TABLE public.mos_campaigns ADD COLUMN IF NOT EXISTS offer             text;
ALTER TABLE public.mos_campaigns ADD COLUMN IF NOT EXISTS destination_url   text;
ALTER TABLE public.mos_campaigns ADD COLUMN IF NOT EXISTS measured_by       text;
-- Budget above mos_settings.signature_threshold requires a named signature.
ALTER TABLE public.mos_campaigns ADD COLUMN IF NOT EXISTS requires_signature boolean NOT NULL DEFAULT false;
ALTER TABLE public.mos_campaigns ADD COLUMN IF NOT EXISTS signed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.mos_campaigns ADD COLUMN IF NOT EXISTS signed_at         timestamptz;

COMMENT ON COLUMN public.mos_campaigns.requires_signature IS
  'Set when budget_total crosses mos_settings.signature_threshold. The campaign '
  'does not go live until signed_by_user_id/signed_at are filled.';

-- ---------------------------------------------------------------------------
-- C. mos_campaign_events — the «ما الذي تغيّر» ledger (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_campaign_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES public.mos_campaigns(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  summary_ar    text NOT NULL,
  summary_en    text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_campaign_events_kind_check') THEN
    ALTER TABLE public.mos_campaign_events ADD CONSTRAINT mos_campaign_events_kind_check
      CHECK (kind IN ('budget_shift','execution_added','execution_paused',
                      'execution_resumed','content_linked','content_unlinked',
                      'signed','note'));
  END IF;
END $$;

COMMENT ON TABLE public.mos_campaign_events IS
  'Append-only ledger of what changed on a campaign. No UPDATE/DELETE policies — '
  'history is corrected by appending, never by rewriting.';

CREATE INDEX IF NOT EXISTS idx_mos_campaign_events_campaign
  ON public.mos_campaign_events(campaign_id, created_at DESC);

ALTER TABLE public.mos_campaign_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mos_campaign_events_read ON public.mos_campaign_events;
CREATE POLICY mos_campaign_events_read ON public.mos_campaign_events
  FOR SELECT TO authenticated
  USING (public.wassell_mos_can('read'));

DROP POLICY IF EXISTS mos_campaign_events_ins ON public.mos_campaign_events;
CREATE POLICY mos_campaign_events_ins ON public.mos_campaign_events
  FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_mos_can('enter_metrics')
    OR public.wassell_mos_can('approve_budget')
  );

-- No UPDATE/DELETE policies: append-only.

-- ---------------------------------------------------------------------------
-- D. Executions: platform id + purpose
-- ---------------------------------------------------------------------------

ALTER TABLE public.mos_campaign_executions ADD COLUMN IF NOT EXISTS platform_campaign_id text;
ALTER TABLE public.mos_campaign_executions ADD COLUMN IF NOT EXISTS purpose              text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_campaign_executions_purpose_check') THEN
    ALTER TABLE public.mos_campaign_executions ADD CONSTRAINT mos_campaign_executions_purpose_check
      CHECK (purpose IS NULL OR purpose IN ('conversion','awareness','retargeting','traffic'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- E. Assets: provenance + derivatives
-- ---------------------------------------------------------------------------

ALTER TABLE public.mos_assets ADD COLUMN IF NOT EXISTS shot_by          text;
ALTER TABLE public.mos_assets ADD COLUMN IF NOT EXISTS rights_expiry    date;
-- A derivative (cut, resize, subtitle burn) points at its source asset.
ALTER TABLE public.mos_assets ADD COLUMN IF NOT EXISTS parent_asset_id  uuid REFERENCES public.mos_assets(id) ON DELETE SET NULL;
ALTER TABLE public.mos_assets ADD COLUMN IF NOT EXISTS duration_seconds numeric;

CREATE INDEX IF NOT EXISTS idx_mos_assets_parent ON public.mos_assets(parent_asset_id);

-- ---------------------------------------------------------------------------
-- F. Shoot requests: crew + duration estimate
-- ---------------------------------------------------------------------------

ALTER TABLE public.mos_shoot_requests ADD COLUMN IF NOT EXISTS crew              text;
ALTER TABLE public.mos_shoot_requests ADD COLUMN IF NOT EXISTS duration_estimate text;

-- ---------------------------------------------------------------------------
-- G. Scenes: widen footage_status to include 'template'
-- ---------------------------------------------------------------------------
-- 'template' = a reusable branded segment (intro/outro/lower-third) that needs
-- neither footage nor a shoot. Drop + re-add under the SAME constraint name.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_scenes_footage_check') THEN
    ALTER TABLE public.mos_scenes DROP CONSTRAINT mos_scenes_footage_check;
  END IF;
  ALTER TABLE public.mos_scenes ADD CONSTRAINT mos_scenes_footage_check
    CHECK (footage_status IN ('have','to_make','missing','template'));
END $$;

-- ---------------------------------------------------------------------------
-- H. workflow_role_tasks.revision_targets (from migration 01's table)
-- ---------------------------------------------------------------------------
-- Which fields a rejection on this task sends the item back to fix. Guarded:
-- this migration MUST run after 2026-08-01_01_workflow_engine_role_paths.sql.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'workflow_role_tasks'
  ) THEN
    RAISE EXCEPTION 'MOS:MIGRATION_01_REQUIRED — workflow_role_tasks does not exist; run 2026-08-01_01_workflow_engine_role_paths.sql first';
  END IF;
  ALTER TABLE public.workflow_role_tasks
    ADD COLUMN IF NOT EXISTS revision_targets jsonb NOT NULL DEFAULT '[]'::jsonb;
END $$;

-- ---------------------------------------------------------------------------
-- I. mos_settings — module settings as data, not code
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mos_settings (
  key                text PRIMARY KEY,
  value              jsonb NOT NULL,
  updated_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mos_settings IS
  'Marketing OS module settings. Thresholds and toggles live here so changing '
  'them is a row edit, not a deploy.';

DROP TRIGGER IF EXISTS mos_settings_touch_tg ON public.mos_settings;
CREATE TRIGGER mos_settings_touch_tg
  BEFORE UPDATE ON public.mos_settings
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_touch_updated_at();

ALTER TABLE public.mos_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mos_settings_read ON public.mos_settings;
CREATE POLICY mos_settings_read ON public.mos_settings
  FOR SELECT TO authenticated
  USING (public.wassell_mos_can('read'));

DROP POLICY IF EXISTS mos_settings_ins ON public.mos_settings;
CREATE POLICY mos_settings_ins ON public.mos_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('manage_settings'));

DROP POLICY IF EXISTS mos_settings_upd ON public.mos_settings;
CREATE POLICY mos_settings_upd ON public.mos_settings
  FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('manage_settings'))
  WITH CHECK (public.wassell_mos_can('manage_settings'));

-- No DELETE policy: settings are flipped, not removed.

INSERT INTO public.mos_settings (key, value) VALUES
  -- Campaign budget at/above this amount requires signature (see mos_campaigns.requires_signature).
  ('signature_threshold',       '{"amount": 50000, "currency": "SAR"}'::jsonb),
  -- Missing scenes roll up into a shoot request once either bound is hit.
  ('shoot_grouping_thresholds', '{"min_shots": 4, "max_wait_days": 14}'::jsonb),
  -- Attribution window + touch model; exclude_cancelled honored by mos_campaign_outcomes.
  ('attribution',               '{"window_days": 90, "touch": "first", "exclude_cancelled": true}'::jsonb),
  -- Branch/fixture envs flip to false; the notify dispatch checks it before sending.
  ('external_effects',          '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Validation — fail loudly inside the transaction if the seed did not land
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF (SELECT count(*) FROM public.mos_settings) < 4 THEN
    RAISE EXCEPTION 'MOS:SETTINGS_SEED_MISSING — mos_settings has % rows, expected at least 4',
      (SELECT count(*) FROM public.mos_settings);
  END IF;
END $$;

COMMIT;
