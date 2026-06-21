-- ============================================================================
-- Sales Studio 2.0 — the business-facing Sales Strategy operating layer.
--
-- Sales Studio CONFIGURES strategy (processes, versions, experiments, client
-- assignment). The Workflow engine still EXECUTES every stage/status transition
-- and next-action creation — these tables are an OVERLAY the engine reads at
-- run time (timing / message / assignment / branch-enabled), never a second
-- transition path. A client with no active assignment runs the legacy/default
-- hardcoded workflow behavior unchanged.
--
-- Four tables (all top-level, NOT JSONB `records` rows — they mirror the
-- scheduled_reports / sales_process_overrides slice posture):
--   sales_processes                  — named strategies (one default active)
--   sales_process_versions           — versioned config_json (draft/active/archived)
--   sales_experiments                — A/B of two process versions
--   client_sales_process_assignments — which process/version/experiment a client is on
--
-- Plus a clients-schema patch: 4 read-only JSONB keys so the assignment is
-- visible in the Builder + the v_clients view (current_sales_process_id,
-- current_sales_process_version_id, current_sales_experiment_id, experiment_group).
--
-- RLS: admin-write, authenticated-read (Sales Studio is an admin/manager
-- surface; reps read the config the Workspace overlays). Mirrors the
-- sales_process_overrides posture exactly.
--
-- Apply to wassell-prod via the Supabase MCP. Idempotent.
-- ============================================================================

-- ── 1. sales_processes ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_processes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_ar      TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  description_ar TEXT,
  description_en TEXT,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','active','archived')),
  is_default   BOOLEAN NOT NULL DEFAULT false,
  active_version_id UUID,        -- denormalized pointer to the live version (nullable)
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only ONE default process can exist (partial unique index on the flag).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_processes_one_default
  ON public.sales_processes ((is_default)) WHERE is_default = true;

-- ── 2. sales_process_versions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_process_versions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sales_process_id UUID NOT NULL REFERENCES public.sales_processes(id) ON DELETE CASCADE,
  version_number   INT NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','active','archived')),
  config_json      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- the overlay (steps + per-workflow overrides)
  published_at     TIMESTAMPTZ,
  published_by     UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_process_versions_process
  ON public.sales_process_versions (sales_process_id, version_number DESC);

-- At most one DRAFT and one ACTIVE version per process (partial unique indexes).
CREATE UNIQUE INDEX IF NOT EXISTS uq_spv_one_draft_per_process
  ON public.sales_process_versions (sales_process_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS uq_spv_one_active_per_process
  ON public.sales_process_versions (sales_process_id) WHERE status = 'active';

-- ── 3. sales_experiments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_experiments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  hypothesis_ar   TEXT,
  hypothesis_en   TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','paused','completed','archived')),
  start_date      TIMESTAMPTZ,
  end_date        TIMESTAMPTZ,
  target_rules_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  control_process_version_id UUID REFERENCES public.sales_process_versions(id) ON DELETE SET NULL,
  variant_process_version_id UUID REFERENCES public.sales_process_versions(id) ON DELETE SET NULL,
  primary_metric  TEXT,
  guardrail_metrics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  assignment_mode TEXT NOT NULL DEFAULT 'manual'
                    CHECK (assignment_mode IN ('manual','rules','random_split')),
  split_percentage NUMERIC NOT NULL DEFAULT 50
                    CHECK (split_percentage >= 0 AND split_percentage <= 100),
  owner_id        UUID,
  result_summary_json JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_experiments_status
  ON public.sales_experiments (status);

-- ── 4. client_sales_process_assignments ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_sales_process_assignments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID NOT NULL,                    -- records.id of the client
  sales_process_id UUID REFERENCES public.sales_processes(id) ON DELETE CASCADE,
  sales_process_version_id UUID REFERENCES public.sales_process_versions(id) ON DELETE SET NULL,
  sales_experiment_id UUID REFERENCES public.sales_experiments(id) ON DELETE SET NULL,
  experiment_group TEXT CHECK (experiment_group IN ('control','variant')),
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by     UUID,
  assignment_reason TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cspa_client ON public.client_sales_process_assignments (client_id);
-- Only ONE active assignment per client (history rows are deactivated, never deleted).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cspa_one_active_per_client
  ON public.client_sales_process_assignments (client_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_cspa_experiment ON public.client_sales_process_assignments (sales_experiment_id) WHERE sales_experiment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cspa_process ON public.client_sales_process_assignments (sales_process_id) WHERE is_active = true;

-- ── updated_at triggers (reuse the shared function) ─────────────────────────
DROP TRIGGER IF EXISTS set_updated_at_sales_processes ON public.sales_processes;
CREATE TRIGGER set_updated_at_sales_processes BEFORE UPDATE ON public.sales_processes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_sales_process_versions ON public.sales_process_versions;
CREATE TRIGGER set_updated_at_sales_process_versions BEFORE UPDATE ON public.sales_process_versions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_sales_experiments ON public.sales_experiments;
CREATE TRIGGER set_updated_at_sales_experiments BEFORE UPDATE ON public.sales_experiments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS — authenticated-read, admin-write (mirrors sales_process_overrides) ──
ALTER TABLE public.sales_processes                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_process_versions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_experiments                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_sales_process_assignments ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sales_processes','sales_process_versions','sales_experiments','client_sales_process_assignments'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
      'USING (public.wassell_is_admin(auth.uid())) '
      'WITH CHECK (public.wassell_is_admin(auth.uid()))', t || '_write', t);
  END LOOP;
END $$;

-- ── RPC: set a process as the single default (atomic flip) ──────────────────
CREATE OR REPLACE FUNCTION public.sales_process_set_default(p_process_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT public.wassell_is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  UPDATE public.sales_processes SET is_default = false WHERE is_default = true AND id <> p_process_id;
  UPDATE public.sales_processes SET is_default = true, status = 'active', updated_at = now() WHERE id = p_process_id;
END;
$$;

-- ── RPC: publish a draft version (archive the prior active, activate draft) ──
-- Existing customers are NOT auto-migrated — their assignment keeps pointing at
-- the version they were assigned to until explicitly migrated.
CREATE OR REPLACE FUNCTION public.sales_process_publish_version(p_version_id UUID)
RETURNS public.sales_process_versions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_process UUID;
  v_row public.sales_process_versions;
BEGIN
  IF NOT public.wassell_is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT sales_process_id INTO v_process FROM public.sales_process_versions WHERE id = p_version_id;
  IF v_process IS NULL THEN RAISE EXCEPTION 'version not found'; END IF;
  -- Archive the currently active version for this process (if any, and not the one we're publishing).
  UPDATE public.sales_process_versions
     SET status = 'archived', updated_at = now()
   WHERE sales_process_id = v_process AND status = 'active' AND id <> p_version_id;
  -- Activate the target.
  UPDATE public.sales_process_versions
     SET status = 'active', published_at = now(), published_by = auth.uid(), updated_at = now()
   WHERE id = p_version_id
  RETURNING * INTO v_row;
  -- Point the process at the new active version + ensure the process is active.
  UPDATE public.sales_processes
     SET active_version_id = p_version_id,
         status = CASE WHEN status = 'archived' THEN status ELSE 'active' END,
         updated_at = now()
   WHERE id = v_process;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sales_process_set_default(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sales_process_publish_version(UUID) TO authenticated;

-- ── clients-schema patch: 4 read-only assignment keys ───────────────────────
-- Appends to the clients model's FIRST section (matches the freeze-migration
-- template). Hidden from the table, read-only in the Builder. The models_view_sync
-- trigger regenerates v_clients automatically on this schema UPDATE, so the keys
-- become typed columns for BI without any extra call. No-op if a key already exists.
DO $$
DECLARE
  v_schema   JSONB;
  v_fields   JSONB;
  v_section  TEXT;
  v_existing JSONB;
  v_add      JSONB := '[]'::jsonb;
  v_def      JSONB;
  v_key      TEXT;
  v_label_ar TEXT;
  v_label_en TEXT;
  v_pairs    JSONB := jsonb_build_array(
    jsonb_build_array('current_sales_process_id',         'مسار المبيعات الحالي',  'Current Sales Process'),
    jsonb_build_array('current_sales_process_version_id', 'إصدار المسار الحالي',    'Current Process Version'),
    jsonb_build_array('current_sales_experiment_id',      'التجربة الحالية',        'Current Experiment'),
    jsonb_build_array('experiment_group',                 'مجموعة التجربة',         'Experiment Group')
  );
  v_pair     JSONB;
  v_order    INT := 990;
BEGIN
  SELECT schema INTO v_schema FROM public.models WHERE name = 'clients';
  IF v_schema IS NULL THEN
    RAISE NOTICE 'clients model not found — skipping schema patch (SPA will add keys at runtime)';
    RETURN;
  END IF;
  v_fields  := COALESCE(v_schema->'sections'->0->'fields', '[]'::jsonb);
  v_section := v_schema->'sections'->0->>'id';

  FOR v_pair IN SELECT * FROM jsonb_array_elements(v_pairs) LOOP
    v_key      := v_pair->>0;
    v_label_ar := v_pair->>1;
    v_label_en := v_pair->>2;
    -- Skip if a field with this slug already exists.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_fields) f WHERE f->>'name' = v_key) THEN
      CONTINUE;
    END IF;
    v_def := jsonb_build_object(
      'id', gen_random_uuid()::text,
      'name', v_key,
      'label_ar', v_label_ar,
      'label_en', v_label_en,
      'type', 'text',
      'required', false,
      'order', v_order,
      'section_id', v_section,
      'width', 'half',
      'show_in_table', false,
      'read_only', true
    );
    v_add := v_add || v_def;
    v_order := v_order + 1;
  END LOOP;

  IF jsonb_array_length(v_add) > 0 THEN
    v_schema := jsonb_set(v_schema, '{sections,0,fields}', v_fields || v_add);
    UPDATE public.models SET schema = v_schema, updated_at = now() WHERE name = 'clients';
  END IF;
END $$;

-- ============================================================================
-- Verification:
--   SELECT count(*) FROM public.sales_processes;
--   SELECT jsonb_array_length(schema->'sections'->0->'fields') FROM models WHERE name='clients';
-- ============================================================================
