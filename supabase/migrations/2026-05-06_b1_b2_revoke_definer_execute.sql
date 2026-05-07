-- ============================================================
-- Phase B.1 + B.2 — Revoke EXECUTE from PUBLIC, re-grant explicitly
-- ============================================================
-- THE most important security item in this refactor.
-- The frontend bundle ships the public anon key. With that key,
-- anyone could today curl POST /rest/v1/rpc/freeze_model or
-- /rpc/drop_model_view and either destabilize schema or write
-- arbitrary records. Both flagged exploitable by Supabase advisor
-- (anon_security_definer_function_executable, 24 occurrences).
--
-- Why REVOKE FROM PUBLIC, not FROM anon:
--   PostgreSQL grants EXECUTE to PUBLIC by default for every
--   function. Both anon and authenticated inherit from PUBLIC.
--   `REVOKE FROM anon` is a no-op when the privilege flows through
--   PUBLIC. The correct fix is `REVOKE FROM PUBLIC` and then
--   explicitly GRANT to whoever should have EXECUTE.
--
-- Strategy:
--   1. REVOKE EXECUTE on ALL functions in public from PUBLIC.
--   2. GRANT to anon:           get_public_dashboard
--   3. GRANT to authenticated:  record_save, record_delete (frontend
--                               dispatchers), get_public_dashboard,
--                               wassell_* helpers (referenced by RLS
--                               policies), try_* helpers (referenced
--                               by v_<model> views with
--                               security_invoker), search_all_projects
--   4. service_role is unaffected — it has explicit grants on every
--      function and inherits via SECURITY DEFINER for the rest. Keeps
--      Vercel API routes / webhooks / triggers working unchanged.
--
-- Trigger functions don't need user EXECUTE (the trigger fires as the
-- table owner). Once PUBLIC is revoked, no further grants needed —
-- triggers continue to work because the table owner is postgres
-- (which always has EXECUTE).
--
-- Verification:
--   * mcp__supabase__get_advisors({type:"security"})
--     → anon_security_definer_function_executable: 24 → 1 (just get_public_dashboard)
--     → authenticated_security_definer_function_executable: 24 → ~10 (the legitimate ones)
--   * Frontend save: still works (record_save remains callable from authenticated).
--   * Anon curl POST /rest/v1/rpc/drop_model_view → 42501.
--
-- Rollback:
--   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC;
-- ============================================================

-- 1. Strip default PUBLIC EXECUTE from every function in public schema.
--    This breaks anon's and authenticated's implicit EXECUTE access.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- 2. Grant to anon only the function intentionally exposed to the public role.
--    get_public_dashboard enforces both is_public AND token-match server-side.
GRANT EXECUTE ON FUNCTION public.get_public_dashboard(text) TO anon;

-- 3. Grant to authenticated the functions that signed-in users legitimately call.

-- Frontend store dispatchers (called from src/stores/appStore.ts via .rpc()).
GRANT EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_delete(uuid, uuid)              TO authenticated;

-- Public dashboard read.
GRANT EXECUTE ON FUNCTION public.get_public_dashboard(text)             TO authenticated;

-- wassell_* helpers — referenced by inline RLS policy expressions on
-- records / models / model_groups / etc. Authenticated users hitting
-- those tables trigger the policy, which calls these helpers.
GRANT EXECUTE ON FUNCTION public.wassell_app_user_id(uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_is_admin(uuid)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_user_has_action(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_record_passes_scope(records, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_view_record(uuid, records) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_edit_record(uuid, records) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_create_record(uuid, records) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_delete_record(uuid, records) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_view_jsonb(uuid, uuid, uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_edit_jsonb(uuid, uuid, uuid, uuid, jsonb) TO authenticated;

-- try_* helpers — auto-generated v_<model> views are security_invoker, so the
-- calling authenticated user needs EXECUTE on these casts.
GRANT EXECUTE ON FUNCTION public.try_boolean(text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.try_numeric(text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.try_timestamptz(text)  TO authenticated;

-- User-facing search.
GRANT EXECUTE ON FUNCTION public.search_all_projects(uuid, numeric, numeric, text, text, text, text, numeric, numeric, text, integer) TO authenticated;

-- Everything else (drop_model_view, freeze_*, regenerate_*, rebuild_unified_records,
-- is_freezable_model, models_view_sync_trigger, records_block_frozen_writes,
-- update_updated_at_column, rls_auto_enable, freeze_build_*, freeze_is_*,
-- freeze_safe_ident, freeze_table_columns_dml) — admin/internal only. Callable
-- by service_role via Vercel API routes if needed; never by anon/authenticated
-- via PostgREST.
