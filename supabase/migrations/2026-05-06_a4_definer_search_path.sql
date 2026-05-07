-- ============================================================
-- Phase A.4 — Tighten search_path on all public functions
-- ============================================================
-- Sets search_path = 'public, pg_temp' on every public function
-- that doesn't already have it. Closes the search-path attack
-- surface where an unprivileged user could shadow public.records
-- (or any other catalog object) by creating a same-named object
-- in a schema earlier on the search path; the SECURITY DEFINER
-- function would then operate on the attacker's table while
-- running as the function owner.
--
-- Excluded: rls_auto_enable (event trigger needs pg_catalog).
-- regenerate_frozen_model_artifacts (already updated by A.1).
-- get_public_dashboard, wassell_* helpers (already correct).
--
-- Resolves Supabase advisor lints:
--   * function_search_path_mutable (12 INVOKER functions w/o search_path)
--   * + DEFINER functions tightened from public → public, pg_temp
--     for defense-in-depth
--
-- ALTER FUNCTION ... SET ... is metadata-only — sub-millisecond,
-- no plan invalidation, no recompilation. Fully reversible via
-- RESET search_path.
--
-- Verification:
--   mcp__supabase__get_advisors({type:"security"})
--   → expect function_search_path_mutable count: 12 → 0
--
-- Rollback: ALTER FUNCTION public.<name>(<args>) RESET search_path;
-- ============================================================

ALTER FUNCTION public.drop_model_view(p_model_name text)                                                  SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_apply_row(p_model_id uuid, p_id uuid, p_data jsonb, p_created_by uuid)       SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_build_table_subtable_columns(p_columns jsonb)                                SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_check_coercion(p_model_id uuid)                                              SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_copy_records(p_model_id uuid)                                                SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_is_multi_value(p_ftype text, p_is_multi boolean)                             SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_is_virtual(p_ftype text)                                                     SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_model(p_model_id uuid)                                                       SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_safe_ident(p text)                                                           SET search_path = public, pg_temp;
ALTER FUNCTION public.freeze_table_columns_dml(p_columns jsonb, p_values boolean)                         SET search_path = public, pg_temp;
ALTER FUNCTION public.is_freezable_model(p_model_name text)                                               SET search_path = public, pg_temp;
ALTER FUNCTION public.models_view_sync_trigger()                                                          SET search_path = public, pg_temp;
ALTER FUNCTION public.rebuild_unified_records()                                                           SET search_path = public, pg_temp;
ALTER FUNCTION public.record_delete(p_model_id uuid, p_id uuid)                                           SET search_path = public, pg_temp;
ALTER FUNCTION public.record_save(p_model_id uuid, p_id uuid, p_data jsonb, p_created_by uuid)            SET search_path = public, pg_temp;
ALTER FUNCTION public.records_block_frozen_writes()                                                       SET search_path = public, pg_temp;
ALTER FUNCTION public.regenerate_all_model_views()                                                        SET search_path = public, pg_temp;
ALTER FUNCTION public.regenerate_model_view(p_model_id uuid)                                              SET search_path = public, pg_temp;
ALTER FUNCTION public.search_all_projects(p_model_id uuid, p_min_price numeric, p_max_price numeric, p_city text, p_district text, p_status text, p_unit_type text, p_min_size numeric, p_max_size numeric, p_text_query text, p_limit integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.try_boolean(t text)                                                                 SET search_path = public, pg_temp;
ALTER FUNCTION public.try_numeric(t text)                                                                 SET search_path = public, pg_temp;
ALTER FUNCTION public.try_timestamptz(t text)                                                             SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column()                                                          SET search_path = public, pg_temp;
