-- ============================================================================
-- Audit follow-up batch II — F.2.1 + L4.
--
-- F.2.1 — Frozen-model optimistic concurrency.
--   Closes the gap from Phase F.2: the records table had a `version` column
--   + trigger + RPC enforcement, but frozen tables didn't. Concurrent edits
--   on frozen models silently overwrote each other.
--
--   - Adds `version int NOT NULL DEFAULT 1` to every existing frozen table
--     and a BEFORE UPDATE `bump_version_trigger` that increments it.
--   - `freeze_apply_row` accepts `p_expected_version int` and raises 40001
--     / version_mismatch on mismatch (mirrors the records-table flow).
--   - `record_save` forwards `p_expected_version` to `freeze_apply_row` for
--     frozen models (was silently dropped).
--   - `regenerate_frozen_model_artifacts` projects `t.version` in the
--     JSONB-shape view AND ensures the column + trigger exist on the
--     dedicated table (so freezing a NEW model picks them up automatically).
--   - `rebuild_unified_records` projects actual `version` from frozen views
--     in the UNION (was hardcoded NULL).
--
-- L4 — Per-token rate limit on get_public_dashboard.
--   The token is a UUID (long enough to brute-force-resist), but a leaked
--   token + scrape loop could still hammer the DB indefinitely. Add a
--   per-token, per-minute bucket counter; reject after 60 hits per minute.
-- ============================================================================

-- Drop unified_records first so per-frozen-view DROP+CREATE isn't blocked.
DROP VIEW IF EXISTS public.unified_records;

-- ─── F.2.1.1 — Trigger function: bump version on UPDATE ────────────────────

CREATE OR REPLACE FUNCTION public.frozen_bump_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF OLD.version = NEW.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$fn$;

-- ─── F.2.1.2 — Backfill: every existing frozen table gets column+trigger ───

DO $$
DECLARE v_model record; v_table text;
BEGIN
  FOR v_model IN SELECT name FROM models WHERE is_hardcoded = true LOOP
    v_table := public.freeze_safe_ident(v_model.name);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1', v_table);
    EXECUTE format('DROP TRIGGER IF EXISTS bump_version_trigger ON public.%I', v_table);
    EXECUTE format(
      'CREATE TRIGGER bump_version_trigger BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.frozen_bump_version()',
      v_table);
  END LOOP;
END $$;

-- ─── F.2.1.3 — freeze_apply_row gains p_expected_version ───────────────────

DROP FUNCTION IF EXISTS public.freeze_apply_row(uuid, uuid, jsonb, uuid);
CREATE OR REPLACE FUNCTION public.freeze_apply_row(
  p_model_id          uuid,
  p_id                uuid,
  p_data              jsonb,
  p_created_by        uuid DEFAULT NULL,
  p_expected_version  int  DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
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
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'model % not found in freeze_apply_row', p_model_id; END IF;
  v_table := public.freeze_safe_ident(v_model.name);

  -- Optimistic-concurrency check (F.2.1).
  IF p_expected_version IS NOT NULL THEN
    EXECUTE format('SELECT version FROM public.%I WHERE id = $1', v_table)
      USING p_id INTO v_existing;
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
    IF public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;
    IF v_assignments <> '' THEN v_assignments := v_assignments || ', '; END IF;

    IF v_ftype = 'range' THEN
      v_assignments := v_assignments || format(
        '%I = public.try_numeric(($1->%L)->>''min''), %I = public.try_numeric(($1->%L)->>''max'')',
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

  FOR v_field IN
    SELECT field FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name'; v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
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

-- ─── F.2.1.4 — record_save forwards p_expected_version to freeze_apply_row ─

CREATE OR REPLACE FUNCTION public.record_save(
  p_model_id          uuid,
  p_id                uuid,
  p_data              jsonb,
  p_created_by        uuid DEFAULT NULL,
  p_expected_version  integer DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_model record; v_table text; v_existing_version int;
BEGIN
  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'model % not found', p_model_id; END IF;

  IF v_model.is_hardcoded THEN
    v_table := public.freeze_safe_ident(v_model.name);
    EXECUTE format('INSERT INTO public.%I (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', v_table) USING p_id;
    -- F.2.1: forward the version arg (was previously dropped).
    PERFORM public.freeze_apply_row(p_model_id, p_id, p_data, p_created_by, p_expected_version);
  ELSE
    IF p_expected_version IS NOT NULL THEN
      SELECT version INTO v_existing_version FROM records WHERE id = p_id;
      IF FOUND AND v_existing_version <> p_expected_version THEN
        RAISE EXCEPTION 'version_mismatch: record was edited by another user (loaded v%, current v%)',
          p_expected_version, v_existing_version
        USING ERRCODE = 'serialization_failure', HINT = 'reload the record to see latest changes';
      END IF;
    END IF;

    INSERT INTO records (id, model_id, data, created_by_user_id)
    VALUES (p_id, p_model_id, p_data, p_created_by)
    ON CONFLICT (id) DO UPDATE SET
      data = EXCLUDED.data,
      created_by_user_id = COALESCE(records.created_by_user_id, EXCLUDED.created_by_user_id),
      updated_at = now();
  END IF;
  RETURN p_id;
END;
$fn$;

-- ─── F.2.1.5 — regenerate_frozen_model_artifacts ──────────────────────────

CREATE OR REPLACE FUNCTION public.regenerate_frozen_model_artifacts(p_model_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
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
BEGIN
  SELECT * INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND OR NOT v_model.is_hardcoded THEN RETURN; END IF;
  v_table := public.freeze_safe_ident(v_model.name);
  v_view_name := v_table || '_v';

  -- F.2.1: ensure version column + trigger exist on the parent table for
  -- newly-frozen models (the regen runs as part of every freeze_model).
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1', v_table);
  EXECUTE format('DROP TRIGGER IF EXISTS bump_version_trigger ON public.%I', v_table);
  EXECUTE format(
    'CREATE TRIGGER bump_version_trigger BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.frozen_bump_version()',
    v_table);

  FOR v_field IN
    SELECT field FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name'; v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;
    IF v_view_keys <> '' THEN v_view_keys := v_view_keys || ', '; END IF;

    IF v_ftype = 'range' THEN
      v_view_keys := v_view_keys || format('%L, jsonb_build_object(''min'', t.%I, ''max'', t.%I)', v_fname, v_fname || '_min', v_fname || '_max');
      IF v_data_json <> '' THEN v_data_json := v_data_json || ', '; END IF;
      v_data_json := v_data_json || format('%L, jsonb_build_object(''min'', %I, ''max'', %I)', v_fname, v_fname || '_min', v_fname || '_max');
    ELSIF v_ftype = 'multiselect' THEN
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM public.%I WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname);
    ELSIF v_ftype = 'lookup' AND v_is_multi THEN
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(target_record_id ORDER BY target_record_id) FROM public.%I WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname);
    ELSIF v_ftype = 'table' THEN
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(to_jsonb(s) - ''id'' - ''record_id'' - ''row_index'' ORDER BY row_index) FROM public.%I s WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname);
    ELSE
      v_view_keys := v_view_keys || format('%L, t.%I', v_fname, v_fname);
      IF v_data_json <> '' THEN v_data_json := v_data_json || ', '; END IF;
      v_data_json := v_data_json || format('%L, %I::text', v_fname, v_fname);
    END IF;
  END LOOP;

  IF v_data_json = '' THEN v_data_json := '''{}''::jsonb'; ELSE v_data_json := 'jsonb_build_object(' || v_data_json || ')'; END IF;

  EXECUTE format('DROP VIEW IF EXISTS public.%I', v_view_name);
  -- F.2.1: project t.version into the JSONB-shape view.
  EXECUTE format(
    'CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT t.id, %L::uuid AS model_id, jsonb_strip_nulls(jsonb_build_object(%s)) AS data, t.created_by_user_id, t.created_at, t.updated_at, t.version FROM public.%I t',
    v_view_name, p_model_id, v_view_keys, v_table);
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

-- ─── F.2.1.6 — rebuild_unified_records projects actual version ─────────────

CREATE OR REPLACE FUNCTION public.rebuild_unified_records()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_sql       text := 'SELECT id, model_id, data, created_by_user_id, created_at, updated_at, version FROM public.records';
  v_model     record;
  v_view_name text;
  v_locked    boolean;
BEGIN
  v_locked := pg_try_advisory_xact_lock(hashtext('rebuild_unified_records'));
  IF NOT v_locked THEN PERFORM pg_advisory_xact_lock(hashtext('rebuild_unified_records')); END IF;

  FOR v_model IN SELECT name FROM models WHERE is_hardcoded = true ORDER BY name LOOP
    v_view_name := public.freeze_safe_ident(v_model.name) || '_v';
    IF EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = v_view_name) THEN
      v_sql := v_sql || format(
        ' UNION ALL SELECT id, model_id, data, created_by_user_id, created_at, updated_at, version FROM public.%I',
        v_view_name);
    END IF;
  END LOOP;

  EXECUTE 'DROP VIEW IF EXISTS public.unified_records';
  EXECUTE 'CREATE VIEW public.unified_records WITH (security_invoker = true) AS ' || v_sql;
  EXECUTE 'GRANT SELECT ON public.unified_records TO authenticated, anon, service_role';
END;
$fn$;

-- ─── F.2.1.7 — Re-run regen for every existing frozen model + rebuild ──────

DO $$
DECLARE v_model record;
BEGIN
  FOR v_model IN SELECT id FROM models WHERE is_hardcoded = true LOOP
    PERFORM public.regenerate_frozen_model_artifacts(v_model.id);
  END LOOP;
END $$;

SELECT public.rebuild_unified_records();

-- ============================================================================
-- L4 — Per-token rate limit on get_public_dashboard.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.public_dashboard_rate_limit (
  token         text NOT NULL,
  window_start  timestamptz NOT NULL,
  hit_count     int NOT NULL DEFAULT 0,
  PRIMARY KEY (token, window_start)
);

ALTER TABLE public.public_dashboard_rate_limit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdrl_admin_only ON public.public_dashboard_rate_limit;
CREATE POLICY pdrl_admin_only ON public.public_dashboard_rate_limit
  FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

DROP FUNCTION IF EXISTS public.get_public_dashboard(text);
CREATE OR REPLACE FUNCTION public.get_public_dashboard(p_token text)
RETURNS dashboards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_limit       int := 60;
  v_window      timestamptz := date_trunc('minute', now());
  v_count       int;
  v_dashboard   dashboards;
BEGIN
  IF p_token IS NULL OR length(p_token) < 8 THEN
    RAISE EXCEPTION 'invalid token' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.public_dashboard_rate_limit (token, window_start, hit_count)
  VALUES (p_token, v_window, 1)
  ON CONFLICT (token, window_start)
  DO UPDATE SET hit_count = public_dashboard_rate_limit.hit_count + 1
  RETURNING hit_count INTO v_count;

  IF v_count > v_limit THEN
    RAISE EXCEPTION 'rate limit exceeded for public dashboard token (% per minute)', v_limit
      USING ERRCODE = 'too_many_connections';
  END IF;

  -- Cheap GC every ~50th call.
  IF (v_count % 50) = 0 THEN
    DELETE FROM public.public_dashboard_rate_limit
     WHERE window_start < now() - INTERVAL '1 hour';
  END IF;

  SELECT * INTO v_dashboard FROM dashboards
   WHERE public_token = p_token AND is_public = true
   LIMIT 1;
  RETURN v_dashboard;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_public_dashboard(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_dashboard(text) TO anon, authenticated;
