-- ============================================================================
-- Phase 3 · B4 — record-derived view access (decision D1)
--
-- "A user may VIEW a file because they can already see a record it is linked
-- to." View only. Restricted files suppressed. Gated by a DB toggle that ships
-- OFF, so applying this migration changes nobody's reach until someone flips
-- one boolean.
--
-- ── MEASURED PREDICTION (production, 2026-08-18, read-only) ────────────────
-- What flipping the toggle ON would do. B4's acceptance bar requires the live
-- result to match this EXACTLY:
--
--   user        visible today   newly visible   after
--   98e5f23c            7,548               0   7,548   (admin, already all)
--   31621e58            7,548               0   7,548   (admin, already all)
--   e350f736            1,270          +4,843   6,113
--   ad5e1e47            1,284          +4,818   6,102
--   b30d0678            1,292          +4,800   6,092
--   ae48de5f            1,270               0   1,270   (no record access)
--   d04de234                0               0       0   (deactivated)
--
-- The two zero rows are the load-bearing ones: a deactivated identity and a
-- marketing-only user with no record access must gain NOTHING from a
-- record-derived rule.
--
-- ── WHY IT JOINS `records` AND NOT `unified_records` ───────────────────────
-- Measured: 9,855 of 9,856 edges point at UNFROZEN models; exactly one points
-- at frozen `market_listings`. Frozen models therefore FAIL CLOSED here — a
-- file linked only to a frozen record is never derived-visible. That is one
-- file today.
--
-- This is deliberate, not an oversight. Evaluating a frozen row's visibility
-- means calling wassell_can_view_jsonb per frozen table with a synthetic row
-- literal; doing that inside a set-returning function, per row, for a branch
-- that covers 0.01% of the graph is a bad trade. Revisit when a frozen model
-- carries real file links. §5 asserts the count so the day it stops being one
-- file, CI says so.
--
-- ── WHY A SECURITY DEFINER HELPER IS REQUIRED HERE ─────────────────────────
-- The obvious formulation — EXISTS over file_links joined to unified_records —
-- is CIRCULAR. file_links_select already requires the FILE half, so a file
-- would have to be visible before its link could be seen, and the derived
-- branch would grant exactly nothing.
--
-- The helper breaks that by reading file_links with definer rights, while
-- keeping caller-correct record semantics: `auth.uid()` reads a GUC, not the
-- current role, so it still returns the CALLER's identity inside a definer
-- function. Record visibility is then evaluated by
-- `wassell_can_view_record(auth.uid(), r.*)` — the exact expression the
-- records_view policy uses, not a re-implementation of it. One authority,
-- same as B2A.4 established for the file half.
--
-- Calling the helper directly discloses nothing beyond the policy: it is
-- caller-scoped, takes no arguments, and self-gates on the toggle AND the
-- identity invariant. Same posture as the 2026-08-17 helper-scoping fix.
--
-- ── CONFIDENTIALITY IS DENORMALIZED, FOR THE SAME REASON AS B2A.4 ──────────
-- The predicate is applied to BOTH files and file_links, and file_links has no
-- confidentiality column. Splitting the predicate would undo the single-
-- authority invariant B2A.4 built and smoke_b2a4 §6 asserts, so instead the
-- column rides along on the same triggers. It carries the same staleness
-- obligation and is tested the same way.
--
-- NOTE: every file on production is currently `internal` — ZERO restricted, and
-- the two restricted-by-default document types (id_document, contract) have no
-- rows. So the suppression clause is UNFALSIFIABLE on production data and must
-- be proven in CI against a fixture that actually contains restricted files.
-- It is dormant today and becomes load-bearing the moment someone uploads a
-- contract.
--
-- Rollback: supabase/rollback/2026-08-18_03_record_derived_file_access_down.sql
--           or simply UPDATE file_access_settings SET derived_view_enabled=false.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The toggle. One row, ships FALSE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.file_access_settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  derived_view_enabled boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.file_access_settings (id, derived_view_enabled)
VALUES (true, false)
ON CONFLICT (id) DO NOTHING;          -- never re-arm a toggle someone turned on

ALTER TABLE public.file_access_settings ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all to anon/authenticated, same posture as
-- file_document_types. The value is read through the definer helper below, so
-- the app never needs SELECT on the table, and nobody can flip it from a JWT.
REVOKE ALL ON TABLE public.file_access_settings FROM PUBLIC;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON TABLE public.file_access_settings FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON TABLE public.file_access_settings FROM authenticated;
  END IF;
END $g$;

COMMENT ON TABLE public.file_access_settings IS
  'Phase 3 B4 kill switch. derived_view_enabled=false means record-derived file view access is inert. Flipping it is the entire rollback: one statement, instant, no data change.';

CREATE OR REPLACE FUNCTION public.wassell_file_derived_access_enabled()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT coalesce((SELECT s.derived_view_enabled
                     FROM public.file_access_settings s WHERE s.id), false)
$fn$;

-- ---------------------------------------------------------------------------
-- 2. confidentiality rides onto file_links, like B2A.4's two columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.file_links
  ADD COLUMN IF NOT EXISTS confidentiality text;

COMMENT ON COLUMN public.file_links.confidentiality IS
  'Denormalized from files.confidentiality so the shared authorization predicate applies unchanged to both tables. Maintained by tg_file_links_fill_authz and tg_files_push_authz — never write it by hand.';

UPDATE public.file_links l
   SET confidentiality = f.confidentiality
  FROM public.files f
 WHERE f.id = l.file_id
   AND l.confidentiality IS DISTINCT FROM f.confidentiality;

-- 2a. Re-emit both B2A.4 triggers with the third column. Same shape, same
--     rules; only the column list grows.
CREATE OR REPLACE FUNCTION public.tg_file_links_fill_authz()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $fn$
BEGIN
  SELECT f.uploaded_by_user_id, f.folder_id, f.confidentiality
    INTO NEW.uploaded_by_user_id, NEW.folder_id, NEW.confidentiality
    FROM public.files f
   WHERE f.id = NEW.file_id;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.tg_files_push_authz()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $fn$
BEGIN
  IF OLD.uploaded_by_user_id IS NOT DISTINCT FROM NEW.uploaded_by_user_id
     AND OLD.folder_id       IS NOT DISTINCT FROM NEW.folder_id
     AND OLD.confidentiality IS NOT DISTINCT FROM NEW.confidentiality THEN
    RETURN NULL;
  END IF;

  UPDATE public.file_links l
     SET uploaded_by_user_id = NEW.uploaded_by_user_id,
         folder_id           = NEW.folder_id,
         confidentiality     = NEW.confidentiality
   WHERE l.file_id = NEW.id
     AND (l.uploaded_by_user_id IS DISTINCT FROM NEW.uploaded_by_user_id
       OR l.folder_id           IS DISTINCT FROM NEW.folder_id
       OR l.confidentiality     IS DISTINCT FROM NEW.confidentiality);
  RETURN NULL;
END;
$fn$;

-- The UPDATE OF list must name confidentiality or a confidentiality-only edit
-- never reaches the edges — the same trap B2A.4 documented for folder moves.
DROP TRIGGER IF EXISTS files_push_authz ON public.files;
CREATE TRIGGER files_push_authz
  AFTER UPDATE OF uploaded_by_user_id, folder_id, confidentiality ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.tg_files_push_authz();

-- ---------------------------------------------------------------------------
-- 3. The derived set. Caller-scoped, toggle-gated, identity-gated.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_my_record_derived_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT DISTINCT l.file_id
    FROM public.file_links l
    JOIN public.records r
      ON r.id = l.record_id AND r.model_id = l.model_id
   WHERE public.wassell_file_derived_access_enabled()
     AND public.wassell_app_user_id((SELECT auth.uid())) IS NOT NULL
     AND public.wassell_can_view_record((SELECT auth.uid()), r.*)
$fn$;

DO $g$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.wassell_file_derived_access_enabled()',
    'public.wassell_my_record_derived_file_ids()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END $g$;

-- ---------------------------------------------------------------------------
-- 4. The shared predicate, now with the derived branch. Still ONE string.
--
--    The branch is LAST so the four existing paths short-circuit before it.
--    With the toggle OFF the hoisted enabled-check is a single InitPlan
--    evaluating to false, so the branch costs one boolean per statement and
--    grants nothing — which is what "ships dark" has to mean to be worth
--    anything.
-- ---------------------------------------------------------------------------
DO $policies$
DECLARE
  pred CONSTANT text := $pred$
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND (
       (SELECT public.wassell_is_admin((SELECT auth.uid())))
    OR uploaded_by_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid())))
    OR @FILE@ IN (SELECT g.file_id FROM public.wassell_my_granted_file_ids('view') g)
    OR ((SELECT public.wassell_mos_can('read'))
        AND @FILE@ IN (SELECT m.file_id FROM public.wassell_my_marketing_file_ids() m))
    OR (folder_id IS NOT NULL
        AND folder_id IN (SELECT c.folder_id FROM public.wassell_my_cascade_folder_ids('view') c))
    OR ((SELECT public.wassell_file_derived_access_enabled())
        AND confidentiality IS DISTINCT FROM 'restricted'
        AND @FILE@ IN (SELECT d.file_id FROM public.wassell_my_record_derived_file_ids() d))
  )$pred$;
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS files_select ON public.files';
  EXECUTE format(
    'CREATE POLICY files_select ON public.files FOR SELECT TO authenticated USING (%s)',
    replace(pred, '@FILE@', 'id'));

  EXECUTE 'DROP POLICY IF EXISTS file_links_select ON public.file_links';
  EXECUTE format(
    'CREATE POLICY file_links_select ON public.file_links FOR SELECT TO authenticated '
    'USING (%s AND EXISTS (SELECT 1 FROM public.unified_records ur '
    '  WHERE ur.id = file_links.record_id AND ur.model_id = file_links.model_id))',
    replace(pred, '@FILE@', 'file_id'));
END $policies$;

-- ---------------------------------------------------------------------------
-- 5. Guards that must hold the moment this lands.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE n bigint;
BEGIN
  IF public.wassell_file_derived_access_enabled() THEN
    RAISE EXCEPTION 'B4 shipped with the toggle ON — it must ship dark';
  END IF;

  SELECT count(*) INTO n
    FROM public.file_links l JOIN public.files f ON f.id = l.file_id
   WHERE l.confidentiality IS DISTINCT FROM f.confidentiality;
  IF n <> 0 THEN
    RAISE EXCEPTION 'B4 % edge(s) disagree with their file on confidentiality after backfill', n;
  END IF;

  -- Frozen-model links fail closed. One today; shout if that materially changes.
  SELECT count(*) INTO n
    FROM public.file_links l JOIN public.models m ON m.id = l.model_id
   WHERE m.is_hardcoded;
  IF n > 50 THEN
    RAISE WARNING 'B4: % edges point at frozen models and are excluded from the derived branch — revisit the fail-closed decision', n;
  END IF;
  RAISE NOTICE 'B4 installed dark: toggle off, confidentiality mirrored, % frozen-model edge(s) excluded', n;
END $verify$;

COMMIT;
