-- ============================================================================
-- Phase 3 · B6 — document_links becomes a real write surface
--
-- B6 builds manual linking on `document_links`, which spec §5 chose over a new
-- table for a good reason: it is already unique on (file_id, model_id,
-- record_id), indexed both directions, RLS-gated on file access, and already a
-- Phase 2 trigger source. Manual linking therefore inherits convergence for
-- free — every insert and delete is recomputed into `file_links` inside the
-- writing transaction.
--
-- It has ten rows because it has almost no UI, not because it is the wrong
-- shape. This migration prepares it for having one.
--
-- Three changes, and the first is the one that matters most.
--
-- ── 1. THE GRANT LAYER IS WRONG, AND RLS DOES NOT COVER IT ─────────────────
-- Measured on production 2026-08-19:
--
--     has_table_privilege('authenticated','document_links','TRUNCATE') = true
--     has_table_privilege('anon',         'document_links','TRUNCATE') = true
--
-- These come from Supabase's ALTER DEFAULT PRIVILEGES, which grants ALL on
-- every new table in `public` to anon and authenticated. `REVOKE ... FROM
-- PUBLIC` does not touch a role-specific grant, so the table has carried them
-- since it was created. Phase 1 hit exactly this on file_links and wrote the
-- rule down: "The grant layer must name the roles explicitly."
--
-- Why it is not merely untidy: **TRUNCATE is not subject to row-level
-- security.** PostgreSQL applies RLS to SELECT/INSERT/UPDATE/DELETE; TRUNCATE
-- is a table-level privilege and bypasses policies entirely. So the three
-- careful per-row policies on this table do not stand between a holder of that
-- grant and an empty table. The same is true of the UPDATE grant, which is
-- merely inert today because no UPDATE policy exists — remove that accident and
-- it becomes live.
--
-- What stops it TODAY is that PostgREST emits no TRUNCATE for any HTTP verb,
-- so the grant is unreachable over the API. That is a property of the
-- middleware, not of the database, and it is the only thing standing there.
-- B6 is the batch that turns this table into something users write to every
-- day, so the second line of defence gets restored here.
--
-- NOTE FOR WHOEVER READS THIS NEXT: the same measurement showed `records`,
-- `files` and `folders` in the identical state. They are NOT touched here —
-- re-granting the CRM's core tables is not a Files batch's business and needs
-- its own change with its own verification. It is reported, not silently
-- fixed.
--
-- ── 2. A ROLE MAY BE CORRECTED WITHOUT UNLINKING ───────────────────────────
-- B1 added `document_links.role` (NULL = supporting_document). The B6 panel
-- GROUPS by role, so a link filed under the wrong heading is visible and
-- irritating, and "unlink then relink to fix a dropdown" is a poor answer.
--
-- This is a deliberate WIDENING and is called out as such. It is gated on the
-- same predicate as insert and delete — edit rights on the FILE — so it grants
-- no reach: anyone who can change a role could already delete the link and
-- create it again with the role they wanted. It is strictly an ergonomic
-- shortcut for something already permitted.
--
-- The identity story is unaffected: `file_link_sources.source_key` for a
-- manual link is `manual:<file>:<model>:<record>` and does not contain the
-- role, so correcting a role does not change what the source asserts and
-- cannot report as drift.
--
-- ── 3. ONE INDEX, FOR THE PANEL'S OWN QUERY ────────────────────────────────
-- Already present: idx_document_links_record (model_id, record_id) and
-- file_links_record_idx (model_id, record_id). The panel needs nothing new;
-- this migration adds NO index and says so here so nobody adds a duplicate.
--
-- Idempotent. Rollback: supabase/rollback/2026-08-19_11_manual_link_write_surface_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Grants: name the roles explicitly.
--
--    anon loses everything. It holds no policy on this table, so it can
--    already do nothing through RLS — but it holds TRUNCATE, which RLS does
--    not mediate, and an anonymous caller has no business being one statement
--    away from every manual link in the system.
--
--    authenticated keeps exactly the three verbs the policies gate, plus the
--    UPDATE that §2 introduces. TRUNCATE, REFERENCES and TRIGGER go.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.document_links FROM PUBLIC;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.document_links FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.document_links FROM authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_links TO authenticated;
  END IF;
  -- service_role keeps its full grant: the document-generation worker inserts
  -- links for the PDFs it produces, and the Phase 1 backfill reads the table.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_links TO service_role;
  END IF;
END $g$;

-- ---------------------------------------------------------------------------
-- 2. The UPDATE policy.
--
--    Deliberately NOT `USING (true)`. Both halves name the file-edit predicate,
--    so a caller can neither move a link they may not edit nor retarget one
--    onto a file they may not edit.
--
--    `created_by_user_id` is history and must not move: WITH CHECK pins it to
--    its existing value via the OLD row, which in a policy is expressed by
--    leaving it out of the writable set — so it is enforced by the trigger
--    below rather than by the policy, because a policy cannot see OLD.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS document_links_update ON public.document_links;
CREATE POLICY document_links_update ON public.document_links FOR UPDATE TO authenticated
  USING      (public.wassell_can_access_file(file_id, 'edit'))
  WITH CHECK (public.wassell_can_access_file(file_id, 'edit'));

-- ---------------------------------------------------------------------------
-- 3. An UPDATE may change the ROLE and nothing else.
--
--    Without this, the policy above would also permit retargeting a link's
--    file_id / model_id / record_id in place. That is not a role correction —
--    it is a different relationship, and Phase 1 was explicit that the app
--    "unlinks-and-relinks rather than updating" precisely so a source_key
--    round-trip of an unchanged relationship cannot report false drift.
--
--    Rewriting the triple in place would ALSO be invisible to Phase 2's
--    convergence for the OLD target: tg_document_links_sync_file_links marks
--    the row's target dirty, and on UPDATE the row carries only the NEW triple,
--    so the record the link used to belong to would keep a stale edge until
--    the next unrelated write to it. Blocking the rewrite is what keeps that
--    from ever being reachable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_document_links_role_only_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.file_id   IS DISTINCT FROM OLD.file_id
     OR NEW.model_id  IS DISTINCT FROM OLD.model_id
     OR NEW.record_id IS DISTINCT FROM OLD.record_id THEN
    RAISE EXCEPTION 'document_links: a link may not be retargeted in place'
      USING HINT = 'Delete the link and create a new one. Phase 2 converges the old target only on delete.',
            ERRCODE = 'check_violation';
  END IF;
  -- Who made the link is history, like files.uploaded_by_user_id.
  NEW.created_by_user_id := OLD.created_by_user_id;
  NEW.created_at         := OLD.created_at;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS document_links_role_only_update ON public.document_links;
CREATE TRIGGER document_links_role_only_update
  BEFORE UPDATE ON public.document_links
  FOR EACH ROW EXECUTE FUNCTION public.tg_document_links_role_only_update();

COMMIT;
