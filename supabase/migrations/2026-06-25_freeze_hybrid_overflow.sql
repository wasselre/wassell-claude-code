-- ════════════════════════════════════════════════════════════════════
-- Freeze mechanism: hybrid typed models with custom_data JSONB overflow
-- ════════════════════════════════════════════════════════════════════
-- Phase 1 of the model-migration plan (docs/model-migration-phase1.md).
--
-- WHAT THIS DOES
--   Adds a `custom_data jsonb NOT NULL DEFAULT '{}'` overflow column to every
--   frozen table, plus a field-level `storage: 'column' | 'overflow'` discriminator
--   (default 'column'). Engineer-owned fields → typed columns (unchanged).
--   Admin-added fields on a frozen model → keys in custom_data, NO DDL required.
--   The <name>_v view merges custom_data back into `data`, so every consumer
--   (unified_records, record_save, forms, dashboards, AI, RLS scope) sees overflow
--   fields exactly like column fields. The overflow is invisible above the view.
--
-- BLAST RADIUS (deliberately confined)
--   Replaces only three functions, all of which run ONLY for frozen models:
--     - freeze_model                          (runs during a freeze)
--     - freeze_apply_row                      (runs only when is_hardcoded)
--     - regenerate_frozen_model_artifacts     (runs on freeze / frozen-schema-change)
--   record_save is NOT changed — its frozen branch does INSERT(id) (custom_data
--   takes its DEFAULT) then calls freeze_apply_row. The universal write path for
--   all unfrozen models is untouched. At apply time ZERO models are frozen, so
--   these replacements change no live behavior until the first freeze.
--
-- BASIS
--   Each function below is the LIVE prod definition (pg_get_functiondef, fetched
--   2026-06-25 — schema.sql had drifted) with surgical `-- HYBRID` edits only.
--   The live defs already carry the frozen `version` column + bump trigger
--   (added after schema.sql); that logic is preserved verbatim.
--
-- DEFERRED (not in this migration, by design)
--   - models_frozen_artifacts_sync trigger (ships with the Builder UI relaxation).
--     Until then, call regenerate_frozen_model_artifacts(model_id) manually after
--     editing a frozen model's schema.
--   - Mirror JOIN columns in _v (Phase 3, before any mirror-bearing model).
--   - Rollup trigger port (Phase 3, with all_projects/units).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- 1. freeze_model — add custom_data to CREATE TABLE; skip overflow fields
--    from the column + junction loops.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.freeze_model(p_model_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_model       record;
  v_table       text;
  v_columns     text := '';
  v_field       jsonb;
  v_fname       text;
  v_ftype       text;
  v_is_multi    boolean;
  v_failures    int;
  v_record_count int;
  v_seq_name    text;
  v_max_num     bigint;
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'model % not found', p_model_id; END IF;
  IF v_model.is_hardcoded THEN RAISE EXCEPTION 'model "%" is already frozen', v_model.name; END IF;
  IF NOT public.is_freezable_model(v_model.name) THEN
    RAISE EXCEPTION 'model "%" is not freezable (custom-UI model)', v_model.name;
  END IF;

  v_table := public.freeze_safe_ident(v_model.name);

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = v_table) THEN
    RAISE EXCEPTION 'table public.% already exists — drop it before re-freezing', v_table;
  END IF;

  SELECT count(*) INTO v_failures FROM public.freeze_check_coercion(p_model_id);
  IF v_failures > 0 THEN
    RAISE EXCEPTION 'freeze aborted: % records have coercion failures (call freeze_check_coercion to see them)', v_failures;
  END IF;

  FOR v_field IN
    SELECT field FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
                      LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;
    IF public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;
    IF COALESCE(v_field->>'storage','column') = 'overflow' THEN CONTINUE; END IF;  -- HYBRID: overflow → custom_data, no column
    PERFORM public.freeze_safe_ident(v_fname);
    IF v_columns <> '' THEN v_columns := v_columns || ', '; END IF;
    IF v_ftype = 'range' THEN
      v_columns := v_columns || format('%I numeric, %I numeric', v_fname || '_min', v_fname || '_max');
    ELSIF v_ftype IN ('number', 'currency', 'formula') THEN
      v_columns := v_columns || format('%I numeric', v_fname);
    ELSIF v_ftype IN ('date', 'datetime') THEN
      v_columns := v_columns || format('%I timestamptz', v_fname);
    ELSIF v_ftype = 'checkbox' THEN
      v_columns := v_columns || format('%I boolean', v_fname);
    ELSIF v_ftype IN ('notes', 'section_mirror', 'section_selector', 'assignee') THEN
      v_columns := v_columns || format('%I jsonb', v_fname);
    ELSE
      v_columns := v_columns || format('%I text', v_fname);
    END IF;
  END LOOP;

  -- HYBRID: custom_data overflow column included in every frozen table.
  EXECUTE format(
    'CREATE TABLE public.%I (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), %s, custom_data jsonb NOT NULL DEFAULT ''{}''::jsonb, created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())',
    v_table,
    CASE WHEN v_columns = '' THEN 'placeholder_unused boolean' ELSE v_columns END
  );

  EXECUTE format(
    'CREATE TRIGGER set_updated_at_%I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
    v_table, v_table
  );

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', v_table);

  FOR v_field IN
    SELECT field FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
                      LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF NOT public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;
    IF COALESCE(v_field->>'storage','column') = 'overflow' THEN CONTINUE; END IF;  -- HYBRID: overflow never becomes a junction
    PERFORM public.freeze_safe_ident(v_fname);

    IF v_ftype = 'multiselect' THEN
      EXECUTE format('CREATE TABLE public.%I (record_id uuid NOT NULL REFERENCES public.%I(id) ON DELETE CASCADE, value text NOT NULL, PRIMARY KEY (record_id, value))',
        v_table || '__' || v_fname, v_table);
    ELSIF v_ftype = 'lookup' THEN
      EXECUTE format('CREATE TABLE public.%I (record_id uuid NOT NULL REFERENCES public.%I(id) ON DELETE CASCADE, target_record_id uuid NOT NULL, PRIMARY KEY (record_id, target_record_id))',
        v_table || '__' || v_fname, v_table);
    ELSIF v_ftype = 'table' THEN
      EXECUTE format('CREATE TABLE public.%I (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES public.%I(id) ON DELETE CASCADE, row_index int NOT NULL, %s, created_at timestamptz NOT NULL DEFAULT now())',
        v_table || '__' || v_fname, v_table,
        public.freeze_build_table_subtable_columns(v_field->'table_columns'));
      EXECUTE format('CREATE INDEX %I ON public.%I (record_id, row_index)',
        'idx_' || v_table || '__' || v_fname || '_record', v_table || '__' || v_fname);
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table || '__' || v_fname);
    EXECUTE format('CREATE POLICY "frozen_junction_view" ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.%I p WHERE p.id = record_id))',
      v_table || '__' || v_fname, v_table);
    EXECUTE format('CREATE POLICY "frozen_junction_write" ON public.%I FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM public.%I p WHERE p.id = record_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.%I p WHERE p.id = record_id))',
      v_table || '__' || v_fname, v_table, v_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', v_table || '__' || v_fname);
  END LOOP;

  FOR v_field IN
    SELECT field FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
                      LATERAL jsonb_array_elements(sec.value->'fields') AS field
    WHERE field->>'type' = 'auto_id'
  LOOP
    v_fname    := v_field->>'name';
    v_seq_name := v_table || '__' || v_fname || '_seq';
    EXECUTE format(
      $q$SELECT COALESCE(max((regexp_replace(data->>%L, '^.*?(\d+)$', '\1'))::bigint), 0)
         FROM records WHERE model_id = $1 AND data->>%L ~ '\d+'$q$,
      v_fname, v_fname
    ) USING p_model_id INTO v_max_num;
    EXECUTE format('CREATE SEQUENCE public.%I START WITH %s', v_seq_name, GREATEST(v_max_num + 1, 1));
    EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO authenticated', v_seq_name);
  END LOOP;

  UPDATE models SET is_hardcoded = true, table_name = v_table WHERE id = p_model_id;
  PERFORM public.freeze_copy_records(p_model_id);
  EXECUTE format('DROP VIEW IF EXISTS public.%I', 'v_' || v_table);
  PERFORM public.regenerate_frozen_model_artifacts(p_model_id);
  SELECT count(*) INTO v_record_count FROM records WHERE model_id = p_model_id;
  DELETE FROM records WHERE model_id = p_model_id;
  PERFORM public.rebuild_unified_records();

  RETURN jsonb_build_object('model_id', p_model_id, 'model_name', v_model.name,
    'table_name', v_table, 'rows_copied', v_record_count, 'frozen_at', now());
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────
-- 2. freeze_apply_row — collect overflow-flagged fields and write them to
--    custom_data (wholesale replace), skipping them from column/junction writes.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.freeze_apply_row(p_model_id uuid, p_id uuid, p_data jsonb, p_created_by uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_model       record;
  v_table       text;
  v_field       jsonb;
  v_fname       text;
  v_ftype       text;
  v_is_multi    boolean;
  v_assignments text := '';
  v_arr         jsonb;
  v_row         jsonb;
  v_row_index   int;
  v_existing    int;
  v_overflow    text[] := ARRAY[]::text[];   -- HYBRID
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'model % not found in freeze_apply_row', p_model_id; END IF;
  v_table := public.freeze_safe_ident(v_model.name);

  IF p_expected_version IS NOT NULL THEN
    EXECUTE format('SELECT version FROM public.%I WHERE id = $1', v_table) USING p_id INTO v_existing;
    IF v_existing IS NOT NULL AND v_existing <> p_expected_version THEN
      RAISE EXCEPTION 'version_mismatch: record was edited by another user (loaded v%, current v%)',
        p_expected_version, v_existing
      USING ERRCODE = 'serialization_failure', HINT = 'reload the record to see latest changes';
    END IF;
  END IF;

  IF p_created_by IS NOT NULL THEN
    EXECUTE format('UPDATE public.%I SET created_by_user_id = COALESCE(created_by_user_id, $1) WHERE id = $2', v_table)
      USING p_created_by, p_id;
  END IF;

  FOR v_field IN
    SELECT field FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name'; v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;
    IF COALESCE(v_field->>'storage','column') = 'overflow' THEN          -- HYBRID
      v_overflow := array_append(v_overflow, v_fname); CONTINUE;
    END IF;
    IF public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;
    IF v_assignments <> '' THEN v_assignments := v_assignments || ', '; END IF;

    IF v_ftype = 'range' THEN
      v_assignments := v_assignments || format('%I = public.try_numeric(($1->%L)->>''min''), %I = public.try_numeric(($1->%L)->>''max'')',
        v_fname || '_min', v_fname, v_fname || '_max', v_fname);
    ELSIF v_ftype IN ('number', 'currency', 'formula') THEN
      v_assignments := v_assignments || format('%I = public.try_numeric($1->>%L)', v_fname, v_fname);
    ELSIF v_ftype IN ('date', 'datetime') THEN
      v_assignments := v_assignments || format('%I = public.try_timestamptz($1->>%L)', v_fname, v_fname);
    ELSIF v_ftype = 'checkbox' THEN
      v_assignments := v_assignments || format('%I = public.try_boolean($1->>%L)', v_fname, v_fname);
    ELSIF v_ftype IN ('notes', 'section_mirror', 'section_selector', 'assignee') THEN
      v_assignments := v_assignments || format('%I = $1->%L', v_fname, v_fname);
    ELSE
      v_assignments := v_assignments || format('%I = $1->>%L', v_fname, v_fname);
    END IF;
  END LOOP;

  IF v_assignments <> '' THEN
    EXECUTE format('UPDATE public.%I SET %s, updated_at = now() WHERE id = $2', v_table, v_assignments)
      USING p_data, p_id;
  END IF;

  -- HYBRID: write overflow-flagged keys into custom_data (wholesale replace,
  -- same posture as the scalar UPDATE — a removed key clears).
  IF array_length(v_overflow, 1) IS NOT NULL THEN
    EXECUTE format('UPDATE public.%I SET custom_data = COALESCE((SELECT jsonb_object_agg(k, $1->k) FROM unnest($2::text[]) AS k WHERE $1 ? k), ''{}''::jsonb), updated_at = now() WHERE id = $3', v_table)
      USING p_data, v_overflow, p_id;
  END IF;

  FOR v_field IN
    SELECT field FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name'; v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF COALESCE(v_field->>'storage','column') = 'overflow' THEN CONTINUE; END IF;  -- HYBRID
    IF NOT public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;
    EXECUTE format('DELETE FROM public.%I WHERE record_id = $1', v_table || '__' || v_fname) USING p_id;

    v_arr := p_data->v_fname;
    IF v_arr IS NULL OR jsonb_typeof(v_arr) <> 'array' THEN CONTINUE; END IF;

    IF v_ftype = 'multiselect' THEN
      EXECUTE format('INSERT INTO public.%I (record_id, value) SELECT $1, value::text FROM jsonb_array_elements_text($2)',
        v_table || '__' || v_fname) USING p_id, v_arr;
    ELSIF v_ftype = 'lookup' THEN
      EXECUTE format('INSERT INTO public.%I (record_id, target_record_id) SELECT $1, value::uuid FROM jsonb_array_elements_text($2) WHERE value <> ''''',
        v_table || '__' || v_fname) USING p_id, v_arr;
    ELSIF v_ftype = 'table' THEN
      v_row_index := 0;
      FOR v_row IN SELECT * FROM jsonb_array_elements(v_arr) LOOP
        EXECUTE format('INSERT INTO public.%I (record_id, row_index, %s) VALUES ($1, $2, %s)',
          v_table || '__' || v_fname,
          public.freeze_table_columns_dml(v_field->'table_columns', false),
          public.freeze_table_columns_dml(v_field->'table_columns', true)
        ) USING p_id, v_row_index, v_row;
        v_row_index := v_row_index + 1;
      END LOOP;
    END IF;
  END LOOP;
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────
-- 3. regenerate_frozen_model_artifacts — ensure custom_data exists; merge it
--    into the _v view's `data` and the RLS policy's synthetic row; skip overflow
--    fields from the column-key + policy-key loops (they flow via the merge).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.regenerate_frozen_model_artifacts(p_model_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_model        record;
  v_table        text;
  v_view_name    text;
  v_field        jsonb;
  v_fname        text;
  v_ftype        text;
  v_is_multi     boolean;
  v_view_keys    text := '';
  v_data_json    text := '';
  v_view_data_expr text;   -- HYBRID
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND OR NOT v_model.is_hardcoded THEN RETURN; END IF;
  v_table := public.freeze_safe_ident(v_model.name);
  v_view_name := v_table || '_v';

  EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1', v_table);
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT ''{}''::jsonb', v_table);  -- HYBRID
  EXECUTE format('DROP TRIGGER IF EXISTS bump_version_trigger ON public.%I', v_table);
  EXECUTE format('CREATE TRIGGER bump_version_trigger BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.frozen_bump_version()', v_table);

  FOR v_field IN
    SELECT field FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name'; v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;
    IF COALESCE(v_field->>'storage','column') = 'overflow' THEN CONTINUE; END IF;  -- HYBRID: surfaced via custom_data merge
    IF v_view_keys <> '' THEN v_view_keys := v_view_keys || ', '; END IF;

    IF v_ftype = 'range' THEN
      v_view_keys := v_view_keys || format('%L, jsonb_build_object(''min'', t.%I, ''max'', t.%I)', v_fname, v_fname || '_min', v_fname || '_max');
      IF v_data_json <> '' THEN v_data_json := v_data_json || ', '; END IF;
      v_data_json := v_data_json || format('%L, jsonb_build_object(''min'', %I, ''max'', %I)', v_fname, v_fname || '_min', v_fname || '_max');
    ELSIF v_ftype = 'multiselect' THEN
      v_view_keys := v_view_keys || format('%L, COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM public.%I WHERE record_id = t.id), ''[]''::jsonb)', v_fname, v_table || '__' || v_fname);
    ELSIF v_ftype = 'lookup' AND v_is_multi THEN
      v_view_keys := v_view_keys || format('%L, COALESCE((SELECT jsonb_agg(target_record_id ORDER BY target_record_id) FROM public.%I WHERE record_id = t.id), ''[]''::jsonb)', v_fname, v_table || '__' || v_fname);
    ELSIF v_ftype = 'table' THEN
      v_view_keys := v_view_keys || format('%L, COALESCE((SELECT jsonb_agg(to_jsonb(s) - ''id'' - ''record_id'' - ''row_index'' ORDER BY row_index) FROM public.%I s WHERE record_id = t.id), ''[]''::jsonb)', v_fname, v_table || '__' || v_fname);
    ELSE
      v_view_keys := v_view_keys || format('%L, t.%I', v_fname, v_fname);
      IF v_data_json <> '' THEN v_data_json := v_data_json || ', '; END IF;
      v_data_json := v_data_json || format('%L, %I::text', v_fname, v_fname);
    END IF;
  END LOOP;

  -- HYBRID: merge custom_data into the view's data (guard the all-overflow empty case).
  IF v_view_keys = '' THEN
    v_view_data_expr := 'COALESCE(t.custom_data, ''{}''::jsonb)';
  ELSE
    v_view_data_expr := '(jsonb_strip_nulls(jsonb_build_object(' || v_view_keys || ')) || COALESCE(t.custom_data, ''{}''::jsonb))';
  END IF;

  -- HYBRID: merge custom_data into the policy's synthetic row too, so scope rules
  -- can address overflow fields.
  IF v_data_json = '' THEN
    v_data_json := 'COALESCE(custom_data, ''{}''::jsonb)';
  ELSE
    v_data_json := '(jsonb_build_object(' || v_data_json || ') || COALESCE(custom_data, ''{}''::jsonb))';
  END IF;

  EXECUTE format('DROP VIEW IF EXISTS public.%I', v_view_name);
  EXECUTE format(
    'CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT t.id, %L::uuid AS model_id, %s AS data, t.created_by_user_id, t.created_at, t.updated_at, t.version FROM public.%I t',
    v_view_name, p_model_id, v_view_data_expr, v_table);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated, anon, service_role', v_view_name);

  EXECUTE format('DROP POLICY IF EXISTS "frozen_view"   ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_insert" ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_update" ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_delete" ON public.%I', v_table);

  EXECUTE format(
    $pol$CREATE POLICY "frozen_view" ON public.%I FOR SELECT TO authenticated USING (
      public.wassell_can_view_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s)
    )$pol$, v_table, p_model_id, v_data_json);
  EXECUTE format(
    $pol$CREATE POLICY "frozen_insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (
      public.wassell_user_has_action((SELECT auth.uid()), %L::uuid, 'create')
    )$pol$, v_table, p_model_id);
  EXECUTE format(
    $pol$CREATE POLICY "frozen_update" ON public.%I FOR UPDATE TO authenticated
      USING (public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s))
      WITH CHECK (public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s))$pol$,
    v_table, p_model_id, v_data_json, p_model_id, v_data_json);
  EXECUTE format(
    $pol$CREATE POLICY "frozen_delete" ON public.%I FOR DELETE TO authenticated USING (
      public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s)
      AND public.wassell_user_has_action((SELECT auth.uid()), %L::uuid, 'delete')
    )$pol$, v_table, p_model_id, v_data_json, p_model_id);
END;
$fn$;

COMMIT;
