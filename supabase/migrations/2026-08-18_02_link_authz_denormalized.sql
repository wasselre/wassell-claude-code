-- ============================================================================
-- Phase 3 · B2A.4 — carry the authorization inputs ON file_links
--
-- Replaces the abandoned B2A.3 set-based attempt (2026-08-18_01, deleted: it
-- was measured, it made aggregate scans 3.6x faster and per-file point lookups
-- 59x SLOWER, so it was never applied anywhere).
--
-- ── WHY THE SET APPROACH FAILED ────────────────────────────────────────────
-- B2A.3 materialised the ANSWER — the set of files this caller may see — and
-- then tested membership. Producing that set means scanning every row of
-- `files` and evaluating all five branches, which costs about the same as the
-- per-row check it replaced. A scan amortises that over thousands of edges and
-- wins. A query that checks sixty files pays it and loses badly.
--
--   facet                       B2A.2      B2A.3
--   aggregate by model         5972 ms -> 1640 ms
--   aggregate by role          7026 ms -> 1824 ms
--   per-file link counts (60)    62 ms -> 3669 ms   <-- 59x worse
--
-- ── WHAT THIS DOES INSTEAD ─────────────────────────────────────────────────
-- Materialise the INPUTS, not the answer. The only reason evaluating a link
-- required work was that the authorization inputs (who uploaded the file, which
-- folder it is in) live on `files`, so every edge had to reach across. Carry
-- those two columns on `file_links` and the reach disappears: the policy tests
-- columns already on the row.
--
-- The three grant sets stay as hashed subplans, but they are built from SMALL
-- tables the caller actually has rows in (file_permissions, folder_permissions,
-- mos_assets) rather than by scanning all of `files`. That is the whole
-- difference: B2A.3 built a 4,000-row set out of a full table scan; this builds
-- a 15-row set out of an index lookup.
--
-- Fast for scans AND for point lookups, because neither shape has a join.
--
-- ── ONE AUTHORITY, ENFORCED STRUCTURALLY ───────────────────────────────────
-- The predicate below is written ONCE, as text, and applied to both policies.
-- The only substitution is which column names the file: `id` on files,
-- `file_id` on file_links. Everything else -- branch order, the identity
-- invariant, the MOS short-circuit -- is character-for-character identical
-- because it is literally the same string. Drift is not possible without
-- editing this block, and smoke_b2a4 asserts the two quals still agree.
--
-- ── IT ALSO CLOSES THE SIDE DOOR ───────────────────────────────────────────
-- Until now file_links_select called wassell_can_access_file, a wrapper over
-- the B2A-era wassell_can_access_file_row -- i.e. the decision from BEFORE
-- B2A.2 restored the identity invariant. files_select was corrected on
-- 2026-08-17; file_links_select was not. No reach difference is known (the two
-- agree on every corpus measured, and B2A.3's fingerprints were identical
-- across all 8 personas), but they were two different authorities, which is
-- precisely the condition B2A.2 was meant to end. After this migration there
-- is one.
--
-- Rollback: supabase/rollback/2026-08-18_02_link_authz_denormalized_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The denormalized authorization inputs.
--    Nullable on purpose: `folder_id` is genuinely null for unfiled files, and
--    a NOT NULL on uploaded_by_user_id would make this a table rewrite for no
--    benefit. Both are maintained by §3.
-- ---------------------------------------------------------------------------
ALTER TABLE public.file_links
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS folder_id           uuid;

COMMENT ON COLUMN public.file_links.uploaded_by_user_id IS
  'Denormalized from files.uploaded_by_user_id so file_links_select needs no join. Maintained by tg_file_links_fill_authz and tg_files_push_authz — never write it by hand.';
COMMENT ON COLUMN public.file_links.folder_id IS
  'Denormalized from files.folder_id so file_links_select needs no join. Maintained by tg_file_links_fill_authz and tg_files_push_authz — never write it by hand.';

-- ---------------------------------------------------------------------------
-- 2. Backfill. Runs BEFORE the triggers exist, so it cannot recurse.
-- ---------------------------------------------------------------------------
UPDATE public.file_links l
   SET uploaded_by_user_id = f.uploaded_by_user_id,
       folder_id           = f.folder_id
  FROM public.files f
 WHERE f.id = l.file_id
   AND (l.uploaded_by_user_id IS DISTINCT FROM f.uploaded_by_user_id
     OR l.folder_id           IS DISTINCT FROM f.folder_id);

-- ---------------------------------------------------------------------------
-- 3. Maintenance. Two directions, because the inputs change on both sides.
-- ---------------------------------------------------------------------------

-- 3a. A new (or retargeted) edge fills itself from the file.
CREATE OR REPLACE FUNCTION public.tg_file_links_fill_authz()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $fn$
BEGIN
  SELECT f.uploaded_by_user_id, f.folder_id
    INTO NEW.uploaded_by_user_id, NEW.folder_id
    FROM public.files f
   WHERE f.id = NEW.file_id;
  -- No row found means the FK is about to reject this insert anyway; leaving
  -- the columns null here is correct and fails closed (null never matches a
  -- caller's app-user id, and the folder branch requires NOT NULL).
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS file_links_fill_authz ON public.file_links;
CREATE TRIGGER file_links_fill_authz
  BEFORE INSERT OR UPDATE OF file_id ON public.file_links
  FOR EACH ROW EXECUTE FUNCTION public.tg_file_links_fill_authz();

-- 3b. Moving a file between folders, or changing its owner, pushes down to its
--     edges. Phase 2's files_sync_file_links CANNOT do this: it early-exits
--     unless model_id/record_id changed, which is exactly what a folder move is
--     not. Narrow UPDATE OF list so ordinary file writes (a rename, a B1
--     metadata backfill) pay nothing.
CREATE OR REPLACE FUNCTION public.tg_files_push_authz()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $fn$
BEGIN
  IF OLD.uploaded_by_user_id IS NOT DISTINCT FROM NEW.uploaded_by_user_id
     AND OLD.folder_id       IS NOT DISTINCT FROM NEW.folder_id THEN
    RETURN NULL;                                   -- cheapest exit
  END IF;

  UPDATE public.file_links l
     SET uploaded_by_user_id = NEW.uploaded_by_user_id,
         folder_id           = NEW.folder_id
   WHERE l.file_id = NEW.id
     AND (l.uploaded_by_user_id IS DISTINCT FROM NEW.uploaded_by_user_id
       OR l.folder_id           IS DISTINCT FROM NEW.folder_id);
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS files_push_authz ON public.files;
CREATE TRIGGER files_push_authz
  AFTER UPDATE OF uploaded_by_user_id, folder_id ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.tg_files_push_authz();

-- ---------------------------------------------------------------------------
-- 4. Indexes. The folder branch is the one that benefits: a caller with a
--    folder grant filters a large edge set down to one folder.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS file_links_uploaded_by_idx
  ON public.file_links (uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS file_links_folder_idx
  ON public.file_links (folder_id) WHERE folder_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. The single predicate, applied to both policies.
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
  )$pred$;
BEGIN
  -- files: identical to the B2A.2 policy already in production. Rebuilt from
  -- the shared text so the two can never drift apart again.
  EXECUTE 'DROP POLICY IF EXISTS files_select ON public.files';
  EXECUTE format(
    'CREATE POLICY files_select ON public.files FOR SELECT TO authenticated USING (%s)',
    replace(pred, '@FILE@', 'id'));

  -- file_links: the same authority, plus the record half. Both sides must be
  -- visible for an edge to be — an edge discloses that a file is attached to a
  -- record, which is information about both ends.
  EXECUTE 'DROP POLICY IF EXISTS file_links_select ON public.file_links';
  EXECUTE format(
    'CREATE POLICY file_links_select ON public.file_links FOR SELECT TO authenticated '
    'USING (%s AND EXISTS (SELECT 1 FROM public.unified_records ur '
    '  WHERE ur.id = file_links.record_id AND ur.model_id = file_links.model_id))',
    replace(pred, '@FILE@', 'file_id'));
END $policies$;

COMMIT;
