-- ============================================================
-- Phase A.1 — RLS init-plan wrap
-- ============================================================
-- Wraps auth.uid() in (SELECT auth.uid()) on all 24 RLS policies
-- flagged by Supabase advisor lint `auth_rls_initplan`. Forces
-- Postgres to evaluate auth.uid() ONCE per query (as an InitPlan
-- node) instead of re-evaluating per row. Logically identical RLS;
-- ~10–100× planner improvement at scale.
--
-- Also updates the policy generator inside
-- regenerate_frozen_model_artifacts() so future freeze
-- regenerations emit the wrapped form, then re-regenerates
-- artifacts for every existing frozen model so their policies
-- pick up the wrap immediately.
--
-- Latent bug fixed: regenerate_frozen_model_artifacts on a model
-- whose <name>_v view is already part of unified_records would
-- fail with "cannot drop view marketing_operations_v because
-- other objects depend on it" (unified_records depends on it).
-- The DO block at the bottom drops unified_records first, then
-- regenerates each frozen model, then rebuilds unified_records.
-- This is the same sequence required for any future schema edit
-- to a frozen model (CLAUDE.md "Frozen models" section).
--
-- Verification:
--   mcp__supabase__get_advisors({type:"performance"})
--   → expect auth_rls_initplan count: 24 → 0
--
-- Rollback:
--   Re-apply the original schema.sql RLS block (lines 646–731)
--   and the original regenerate_frozen_model_artifacts function.
-- ============================================================

-- ── records: per-row gating via wassell_can_*_record helpers ──────
DROP POLICY IF EXISTS records_view   ON public.records;
DROP POLICY IF EXISTS records_insert ON public.records;
DROP POLICY IF EXISTS records_update ON public.records;
DROP POLICY IF EXISTS records_delete ON public.records;

CREATE POLICY records_view   ON public.records FOR SELECT TO authenticated
  USING (public.wassell_can_view_record((SELECT auth.uid()), records.*));
CREATE POLICY records_insert ON public.records FOR INSERT TO authenticated
  WITH CHECK (public.wassell_can_create_record((SELECT auth.uid()), records.*));
CREATE POLICY records_update ON public.records FOR UPDATE TO authenticated
  USING (public.wassell_can_edit_record((SELECT auth.uid()), records.*))
  WITH CHECK (public.wassell_can_edit_record((SELECT auth.uid()), records.*));
CREATE POLICY records_delete ON public.records FOR DELETE TO authenticated
  USING (public.wassell_can_delete_record((SELECT auth.uid()), records.*));

-- ── models / model_groups: read for UI, write for admins ──────────
DROP POLICY IF EXISTS models_write       ON public.models;
DROP POLICY IF EXISTS model_groups_write ON public.model_groups;

CREATE POLICY models_write ON public.models FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY model_groups_write ON public.model_groups FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

-- ── profiles / roles: write admin-only ────────────────────────────
DROP POLICY IF EXISTS profiles_write ON public.profiles;
DROP POLICY IF EXISTS roles_write    ON public.roles;

CREATE POLICY profiles_write ON public.profiles FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY roles_write ON public.roles FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

-- ── users: write admin OR self ────────────────────────────────────
DROP POLICY IF EXISTS users_write ON public.users;

CREATE POLICY users_write ON public.users FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())) OR users.auth_uid = (SELECT auth.uid()))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())) OR users.auth_uid = (SELECT auth.uid()));

-- ── model_views: own/shared read, own/admin write ─────────────────
DROP POLICY IF EXISTS model_views_read  ON public.model_views;
DROP POLICY IF EXISTS model_views_write ON public.model_views;

CREATE POLICY model_views_read ON public.model_views FOR SELECT TO authenticated
  USING (
    is_shared = true
    OR user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  );
CREATE POLICY model_views_write ON public.model_views FOR ALL TO authenticated
  USING (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  )
  WITH CHECK (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  );

-- ── field_templates: write admin-only ────────────────────────────
DROP POLICY IF EXISTS field_templates_write ON public.field_templates;

CREATE POLICY field_templates_write ON public.field_templates FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

-- ── workflows / workflow_groups / dashboards: admin-only ──────────
DROP POLICY IF EXISTS workflows_admin       ON public.workflows;
DROP POLICY IF EXISTS workflow_groups_admin ON public.workflow_groups;
DROP POLICY IF EXISTS dashboards_admin      ON public.dashboards;

CREATE POLICY workflows_admin ON public.workflows FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY workflow_groups_admin ON public.workflow_groups FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY dashboards_admin ON public.dashboards FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

-- ── workflow_runs: admin read/modify/delete; any-user insert ─────
-- workflow_runs_insert (WITH CHECK true) does NOT use auth.uid(); leave it.
DROP POLICY IF EXISTS workflow_runs_read   ON public.workflow_runs;
DROP POLICY IF EXISTS workflow_runs_modify ON public.workflow_runs;
DROP POLICY IF EXISTS workflow_runs_delete ON public.workflow_runs;

CREATE POLICY workflow_runs_read   ON public.workflow_runs FOR SELECT TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY workflow_runs_modify ON public.workflow_runs FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY workflow_runs_delete ON public.workflow_runs FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── audit_log: admin read; admin or self insert ───────────────────
DROP POLICY IF EXISTS audit_log_admin_read   ON public.audit_log;
DROP POLICY IF EXISTS audit_log_admin_insert ON public.audit_log;

CREATE POLICY audit_log_admin_read ON public.audit_log FOR SELECT TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY audit_log_admin_insert ON public.audit_log FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_is_admin((SELECT auth.uid()))
    OR actor_auth_uid = (SELECT auth.uid())
  );

-- ============================================================
-- Update regenerate_frozen_model_artifacts so future freeze
-- regenerations emit (SELECT auth.uid()) instead of bare auth.uid().
-- Same body as schema.sql v1 except for the wrapped form in the
-- four EXECUTE format() policy templates. SET search_path is also
-- tightened to "public, pg_temp" (was just "public") to address
-- function_search_path_mutable lint preemptively.
-- ============================================================

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

  v_table     := public.freeze_safe_ident(v_model.name);
  v_view_name := v_table || '_v';

  FOR v_field IN
    SELECT field
    FROM jsonb_array_elements(v_model.schema->'sections') AS sec(value),
         LATERAL jsonb_array_elements(sec.value->'fields') AS field
  LOOP
    v_fname := v_field->>'name';
    v_ftype := v_field->>'type';
    v_is_multi := COALESCE((v_field->>'is_multi')::boolean, false);
    IF v_fname IS NULL OR v_fname = '' THEN CONTINUE; END IF;
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;

    IF v_view_keys <> '' THEN v_view_keys := v_view_keys || ', '; END IF;

    IF v_ftype = 'range' THEN
      v_view_keys := v_view_keys || format(
        '%L, jsonb_build_object(''min'', t.%I, ''max'', t.%I)',
        v_fname, v_fname || '_min', v_fname || '_max'
      );
      IF v_data_json <> '' THEN v_data_json := v_data_json || ', '; END IF;
      v_data_json := v_data_json || format(
        '%L, jsonb_build_object(''min'', %I, ''max'', %I)',
        v_fname, v_fname || '_min', v_fname || '_max'
      );
    ELSIF v_ftype = 'multiselect' THEN
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM public.%I WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname
      );
    ELSIF v_ftype = 'lookup' AND v_is_multi THEN
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(target_record_id ORDER BY target_record_id) FROM public.%I WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname
      );
    ELSIF v_ftype = 'table' THEN
      v_view_keys := v_view_keys || format(
        '%L, COALESCE((SELECT jsonb_agg(to_jsonb(s) - ''id'' - ''record_id'' - ''row_index'' ORDER BY row_index) FROM public.%I s WHERE record_id = t.id), ''[]''::jsonb)',
        v_fname, v_table || '__' || v_fname
      );
    ELSE
      v_view_keys := v_view_keys || format('%L, t.%I', v_fname, v_fname);
      IF v_data_json <> '' THEN v_data_json := v_data_json || ', '; END IF;
      v_data_json := v_data_json || format('%L, %I::text', v_fname, v_fname);
    END IF;
  END LOOP;

  IF v_data_json = '' THEN v_data_json := '''{}''::jsonb'; ELSE v_data_json := 'jsonb_build_object(' || v_data_json || ')'; END IF;

  EXECUTE format('DROP VIEW IF EXISTS public.%I', v_view_name);
  EXECUTE format(
    'CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT t.id, %L::uuid AS model_id, jsonb_strip_nulls(jsonb_build_object(%s)) AS data, t.created_by_user_id, t.created_at, t.updated_at FROM public.%I t',
    v_view_name, p_model_id, v_view_keys, v_table
  );
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated, anon, service_role', v_view_name);

  EXECUTE format('DROP POLICY IF EXISTS "frozen_view"   ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_insert" ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_update" ON public.%I', v_table);
  EXECUTE format('DROP POLICY IF EXISTS "frozen_delete" ON public.%I', v_table);

  -- (SELECT auth.uid()) replaces bare auth.uid() — Phase A.1 init-plan wrap.
  EXECUTE format(
    $pol$CREATE POLICY "frozen_view" ON public.%I FOR SELECT TO authenticated USING (
      public.wassell_can_view_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s)
    )$pol$,
    v_table, p_model_id, v_data_json
  );
  EXECUTE format(
    $pol$CREATE POLICY "frozen_insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (
      public.wassell_user_has_action((SELECT auth.uid()), %L::uuid, 'create')
    )$pol$,
    v_table, p_model_id
  );
  EXECUTE format(
    $pol$CREATE POLICY "frozen_update" ON public.%I FOR UPDATE TO authenticated
      USING (public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s))
      WITH CHECK (public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s))$pol$,
    v_table, p_model_id, v_data_json, p_model_id, v_data_json
  );
  EXECUTE format(
    $pol$CREATE POLICY "frozen_delete" ON public.%I FOR DELETE TO authenticated USING (
      public.wassell_can_edit_jsonb((SELECT auth.uid()), %L::uuid, id, created_by_user_id, %s)
      AND public.wassell_user_has_action((SELECT auth.uid()), %L::uuid, 'delete')
    )$pol$,
    v_table, p_model_id, v_data_json, p_model_id
  );
END;
$fn$;

-- Re-regenerate every existing frozen model. Drop unified_records first
-- (it depends on each <model>_v view), regenerate each frozen model's
-- artifacts, then rebuild unified_records. This same sequence is what
-- future migrations should use whenever a frozen model's schema is edited.
DO $do$
DECLARE
  m record;
BEGIN
  DROP VIEW IF EXISTS public.unified_records;
  FOR m IN SELECT id, name FROM public.models WHERE is_hardcoded = true LOOP
    PERFORM public.regenerate_frozen_model_artifacts(m.id);
    RAISE NOTICE 'Regenerated frozen artifacts for model: %', m.name;
  END LOOP;
  PERFORM public.rebuild_unified_records();
END
$do$;
