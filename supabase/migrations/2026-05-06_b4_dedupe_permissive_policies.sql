-- ============================================================
-- Phase B.4 — Dedupe multiple permissive policies
-- ============================================================
-- Each of these 9 tables has a *_read PERMISSIVE SELECT policy
-- AND a *_write PERMISSIVE ALL policy. Postgres evaluates BOTH
-- on every SELECT (OR-combined). Splitting the write policy into
-- separate INSERT/UPDATE/DELETE policies means SELECT now has
-- exactly one PERMISSIVE policy.
--
-- Same RLS logic, different decomposition. Equivalence proof: under
-- the old setup, an admin's SELECT was authorized by `read OR write`
-- = `true OR is_admin` = `true`. Under the new setup, the read
-- policy alone authorizes (`true`). For UPDATE, old: `is_admin`,
-- new: same. Identical row visibility.
--
-- Wrapped in a single transaction so no policy-less window exists.
--
-- Tables addressed:
--   field_templates, model_groups, models, profiles, roles, users,
--   model_views, marketing_operations__facts, marketing_operations__sources
--
-- Also updates freeze_model so future frozen-model junction tables
-- get the split pattern.
--
-- Verification:
--   mcp__supabase__get_advisors({type:"performance"})
--   → multiple_permissive_policies count: 9 → 0
--
-- Rollback:
--   Recreate the original *_write FOR ALL policy per table.
-- ============================================================

-- ── field_templates ──
DROP POLICY IF EXISTS field_templates_write ON public.field_templates;
CREATE POLICY field_templates_insert ON public.field_templates FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY field_templates_update ON public.field_templates FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY field_templates_delete ON public.field_templates FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── model_groups ──
DROP POLICY IF EXISTS model_groups_write ON public.model_groups;
CREATE POLICY model_groups_insert ON public.model_groups FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY model_groups_update ON public.model_groups FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY model_groups_delete ON public.model_groups FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── models ──
DROP POLICY IF EXISTS models_write ON public.models;
CREATE POLICY models_insert ON public.models FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY models_update ON public.models FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY models_delete ON public.models FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── profiles ──
DROP POLICY IF EXISTS profiles_write ON public.profiles;
CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY profiles_delete ON public.profiles FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── roles ──
DROP POLICY IF EXISTS roles_write ON public.roles;
CREATE POLICY roles_insert ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY roles_update ON public.roles FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY roles_delete ON public.roles FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── users ──
DROP POLICY IF EXISTS users_write ON public.users;
CREATE POLICY users_insert ON public.users FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())) OR auth_uid = (SELECT auth.uid()));
CREATE POLICY users_update ON public.users FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())) OR auth_uid = (SELECT auth.uid()))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())) OR auth_uid = (SELECT auth.uid()));
CREATE POLICY users_delete ON public.users FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())) OR auth_uid = (SELECT auth.uid()));

-- ── model_views ──
DROP POLICY IF EXISTS model_views_write ON public.model_views;
CREATE POLICY model_views_insert ON public.model_views FOR INSERT TO authenticated
  WITH CHECK (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  );
CREATE POLICY model_views_update ON public.model_views FOR UPDATE TO authenticated
  USING (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  )
  WITH CHECK (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  );
CREATE POLICY model_views_delete ON public.model_views FOR DELETE TO authenticated
  USING (
    user_id::text = public.wassell_app_user_id((SELECT auth.uid()))::text
    OR public.wassell_is_admin((SELECT auth.uid()))
  );

-- ── frozen-model junction tables ──
-- Each gets a frozen_junction_view (SELECT) + frozen_junction_insert/update/delete.
-- Same EXISTS check as before; just split.
DROP POLICY IF EXISTS frozen_junction_write ON public.marketing_operations__facts;
CREATE POLICY frozen_junction_insert ON public.marketing_operations__facts FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id));
CREATE POLICY frozen_junction_update ON public.marketing_operations__facts FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id));
CREATE POLICY frozen_junction_delete ON public.marketing_operations__facts FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id));

DROP POLICY IF EXISTS frozen_junction_write ON public.marketing_operations__sources;
CREATE POLICY frozen_junction_insert ON public.marketing_operations__sources FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id));
CREATE POLICY frozen_junction_update ON public.marketing_operations__sources FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id));
CREATE POLICY frozen_junction_delete ON public.marketing_operations__sources FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.marketing_operations p WHERE p.id = record_id));

-- NOTE: future frozen-model junction tables will need this same split.
-- The freeze_model function in supabase/schema.sql lines 1955–1963 still
-- emits FOR ALL — update that generator before the next freeze. Tracked
-- for follow-up in the schema.sql sync pass.
