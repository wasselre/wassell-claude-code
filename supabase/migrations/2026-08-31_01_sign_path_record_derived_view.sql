-- ============================================================================
-- Fix: the signing path must honor record-derived VIEW access (B4 parity)
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- Phase 3 · B4 (2026-08-18_03) added a record-derived branch to `files_select`
-- and `file_links_select`: "a user may VIEW a file because they can already see
-- a record it is linked to." That toggle (file_access_settings.derived_view_
-- enabled) is now ON in production.
--
-- But B4 never updated `wassell_can_access_file` — the SECURITY DEFINER gate
-- the file-signing endpoints call before minting a signed URL
-- (api/files/sign-view-url + sign-download-url → assertCanAccessFile(...,'view')
-- → wassell_can_access_file(id,'view')). That function is still on the pre-B4
-- predicate (admin / uploader / explicit grant / mos_asset / folder cascade).
--
-- Result: a marketing user on the content record's "Project assets" tab can
-- LIST the project's linked files (RecordFilesPanel reads `files` under RLS,
-- which honors the derived branch) and even see image thumbnails (the batch
-- /api/files/sign-view-urls gates via an RLS-filtered SELECT, which also honors
-- it) — but clicking Download or opening the preview fails with "not allowed",
-- because those go through the single-file signing gate that B4 skipped.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Add the SAME record-derived VIEW branch to wassell_can_access_file so the
-- signing path agrees with what the caller can already SELECT. Mirrors the
-- files_select predicate exactly: derived toggle ON, file not 'restricted', and
-- the file is in the caller's wassell_my_record_derived_file_ids() set.
--
-- Scoped to p_kind = 'view' only — download uses 'view', and edit/delete must
-- NOT gain reach from a record-derived rule (B4 is view-only by design). The
-- branch is a top-level OR after the existing COALESCE, so for admins /
-- uploaders / granted users the primary check short-circuits and the derived
-- set-returning function is never evaluated; it runs only for exactly the
-- derived-access callers this fixes, once per signing request.
--
-- No behavior change while the toggle is off: wassell_file_derived_access_
-- enabled() is a single InitPlan false, and the branch grants nothing.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_can_access_file(p_file_id uuid, p_kind text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT public.wassell_can_access_file_row(
              p_file_id, p_kind, f.uploaded_by_user_id, f.folder_id,
              public.wassell_app_user_id((SELECT auth.uid())),
              public.wassell_is_admin((SELECT auth.uid())),
              NULL, NULL, NULL)
       FROM public.files f WHERE f.id = p_file_id),
    public.wassell_is_admin((SELECT auth.uid())) AND p_file_id IS NOT NULL)
  -- B4 parity: record-derived VIEW access. Mirrors the files_select branch so
  -- the signing endpoints agree with what the caller can already SELECT.
  OR (
    p_kind = 'view'
    AND p_file_id IS NOT NULL
    AND (SELECT public.wassell_file_derived_access_enabled())
    AND EXISTS (
      SELECT 1 FROM public.files f
       WHERE f.id = p_file_id
         AND f.confidentiality IS DISTINCT FROM 'restricted')
    AND p_file_id IN (SELECT d.file_id FROM public.wassell_my_record_derived_file_ids() d)
  )
$function$;

COMMIT;
