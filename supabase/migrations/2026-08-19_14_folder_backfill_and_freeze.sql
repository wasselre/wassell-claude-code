-- ============================================================================
-- Phase 3 · B9 — derive metadata from folder names, then freeze folder creation
--
-- B9 is the last batch of Phase 3, and it DELETES NOTHING. Every existing
-- folder stays browsable under the Legacy tab, the three folder-cascade
-- permission grants keep working, and the 463 foldered files keep their
-- folder_id. All this does is:
--
--   1. TAG every foldered file with the names of the folders above it, so the
--      metadata a folder path encoded ("مينا 52", "الماجدية 178") survives as
--      a searchable tag once folders stop being where things live.
--   2. UPGRADE the document_type of foldered files that still carry the generic
--      'other', using what the folder name says they are — but NEVER overwrite
--      a type that is already specific.
--   3. FREEZE folder creation at the database, so no new folder can be made.
--
-- ── WHY THE TYPE BACKFILL ONLY EVER UPGRADES ──────────────────────────────
-- B1 already inferred document_type from `kind` for every file, so most
-- foldered files carry a real type (gallery_image, video, ...). The folder name
-- is a WEAKER signal than an explicit type a human or a field set — so it may
-- only fill in 'other', the honest "we did not know". A file explicitly typed
-- gallery_image inside a folder called فيديو keeps gallery_image: the type is
-- the stronger claim. Measured: 93 foldered files are 'other' today; those are
-- the only ones this can touch.
--
-- ── WHY TAGS ARE ADDITIVE ─────────────────────────────────────────────────
-- `tags = tags || new` with de-dup, never `tags = new`. A file may already
-- carry tags from B7's bulk editor or a future upload strip; a folder backfill
-- that replaced them would be silent data loss. array containment (@>) skips a
-- tag already present, so re-running this migration is a no-op.
--
-- ── PHASE 2 SAFETY (the usual two) ────────────────────────────────────────
-- This touches neither model_id nor record_id, so tg_files_sync_file_links()
-- exits on its first test and marks NOTHING dirty — no projection lock. And
-- updated_at is history: files_set_updated_at is disabled BY NAME for the
-- backfill and restored to its exact prior state, never via
-- session_replication_role (which would also silence the Phase 2 sync trigger).
-- Both lessons are B1's, paid for once.
--
-- Idempotent. Rollback: supabase/rollback/2026-08-19_14_folder_backfill_and_freeze_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The folder-name → document_type vocabulary.
--
-- A small function rather than an inline CASE so the type backfill and any
-- future reader agree on ONE classifier. Keywords are the ones actually
-- present in the 102 folder names, both Arabic and the odd Latin word; an
-- unrecognised name returns NULL and the file keeps whatever type it had.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.b9_folder_name_to_type(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_name ~ 'صور|الصور|معرض|gallery|صوره'          THEN 'gallery_image'
    WHEN p_name ~ 'فيديو|video|مقطع'                     THEN 'video'
    WHEN p_name ~ 'دور|مخطط|floor|plan|طابق'             THEN 'floor_plan'
    WHEN p_name ~ 'بروش|brochure|كتيب'                   THEN 'brochure'
    WHEN p_name ~ 'علامة|هوية|brand|شعار|logo'           THEN 'reference'
    WHEN p_name ~ 'محتوى|محتوي|تسويق|marketing|اعلان|إعلان' THEN 'marketing_asset'
    ELSE NULL
  END
$$;

-- ---------------------------------------------------------------------------
-- 1. Ancestry: every folder above each file, as one row per (file, ancestor).
--    A recursive walk up parent_folder_id, capped by depth (the tree is 7 deep).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _b9_ancestry ON COMMIT DROP AS
WITH RECURSIVE up AS (
  SELECT fi.id AS file_id, f.id AS folder_id, f.name AS folder_name,
         f.parent_folder_id, 1 AS depth
    FROM public.files fi
    JOIN public.folders f ON f.id = fi.folder_id
   WHERE fi.folder_id IS NOT NULL AND fi.file_class = 'business'
  UNION ALL
  SELECT u.file_id, p.id, p.name, p.parent_folder_id, u.depth + 1
    FROM up u
    JOIN public.folders p ON p.id = u.parent_folder_id
   WHERE u.depth < 12
)
SELECT file_id, folder_id, folder_name, depth FROM up;

CREATE INDEX ON _b9_ancestry (file_id);

-- ---------------------------------------------------------------------------
-- 2. Disable the timestamp trigger (by name) for the backfill.
-- ---------------------------------------------------------------------------
DO $ts$
DECLARE v_state "char";
BEGIN
  SELECT t.tgenabled INTO v_state FROM pg_trigger t
   WHERE t.tgrelid='public.files'::regclass AND t.tgname='files_set_updated_at' AND NOT t.tgisinternal;
  IF v_state IS NULL THEN PERFORM set_config('wassell.b9_ts', 'absent', true);
  ELSE PERFORM set_config('wassell.b9_ts', v_state::text, true);
       ALTER TABLE public.files DISABLE TRIGGER files_set_updated_at;
  END IF;
END $ts$;

-- ---------------------------------------------------------------------------
-- 3. TYPE backfill — only files whose type is the generic 'other', and only
--    to a type the folder ancestry actually names. The nearest ancestor with
--    a recognisable name wins (smallest depth), because the immediate folder
--    is the strongest signal.
-- ---------------------------------------------------------------------------
WITH derived AS (
  SELECT DISTINCT ON (a.file_id) a.file_id,
         public.b9_folder_name_to_type(a.folder_name) AS doc_type
    FROM _b9_ancestry a
   WHERE public.b9_folder_name_to_type(a.folder_name) IS NOT NULL
   ORDER BY a.file_id, a.depth
)
UPDATE public.files fi
   SET document_type = d.doc_type
  FROM derived d
 WHERE fi.id = d.file_id
   AND fi.document_type = 'other'          -- upgrade ONLY the honest unknown
   AND d.doc_type IS DISTINCT FROM 'other';

-- ---------------------------------------------------------------------------
-- 4. TAG backfill — every ancestor folder name becomes a tag, additive and
--    de-duplicated. Folder names that are just a document-type word (صور,
--    فيديو) are excluded: they are captured as the TYPE and would be noise as
--    a tag. What is left is the useful part — project names, floor labels.
-- ---------------------------------------------------------------------------
-- Generic ORGANISATIONAL parents that describe nothing about the file — the
-- top of the tree, not a project. Measured: المشاريع was on 343 files and
-- مشاريع تحت الإدراج on 103, pure noise as a tag. An explicit small list, not a
-- pattern, because the useful project names contain the same words a generic
-- parent does.
WITH file_tags AS (
  SELECT a.file_id,
         array_agg(DISTINCT btrim(a.folder_name)) FILTER (
           WHERE public.b9_folder_name_to_type(a.folder_name) IS NULL
             AND btrim(a.folder_name) <> ''
             AND btrim(a.folder_name) NOT IN (
               'المشاريع', 'مشاريع تحت الإدراج', 'مشاريع', 'الملفات', 'ملفات', 'Files'
             )
         ) AS names
    FROM _b9_ancestry a
   GROUP BY a.file_id
)
UPDATE public.files fi
   SET tags = (
     SELECT array_agg(DISTINCT tag ORDER BY tag)
       FROM (
         SELECT unnest(coalesce(fi.tags, '{}')) AS tag
         UNION
         SELECT unnest(ft.names) AS tag
       ) u
   )
  FROM file_tags ft
 WHERE fi.id = ft.file_id
   AND ft.names IS NOT NULL
   AND NOT (fi.tags @> ft.names);           -- skip if every name already present

-- ---------------------------------------------------------------------------
-- 5. Restore the timestamp trigger to EXACTLY its prior state, and self-check.
-- ---------------------------------------------------------------------------
DO $ts$
DECLARE v text := current_setting('wassell.b9_ts', true);
BEGIN
  IF v IS NULL OR v = 'absent' THEN RETURN;
  ELSIF v='O' THEN ALTER TABLE public.files ENABLE TRIGGER files_set_updated_at;
  ELSIF v='R' THEN ALTER TABLE public.files ENABLE REPLICA TRIGGER files_set_updated_at;
  ELSIF v='A' THEN ALTER TABLE public.files ENABLE ALWAYS TRIGGER files_set_updated_at;
  ELSIF v='D' THEN NULL;
  ELSE RAISE EXCEPTION 'B9: unknown prior tgenabled state %', v;
  END IF;
END $ts$;
DO $ts$
DECLARE v_state "char"; v_exp text := current_setting('wassell.b9_ts', true);
BEGIN
  IF v_exp IS NULL OR v_exp='absent' THEN RETURN; END IF;
  SELECT t.tgenabled INTO v_state FROM pg_trigger t
   WHERE t.tgrelid='public.files'::regclass AND t.tgname='files_set_updated_at' AND NOT t.tgisinternal;
  IF v_state IS DISTINCT FROM v_exp::"char" THEN
    RAISE EXCEPTION 'B9: files_set_updated_at is % after backfill, expected %', coalesce(v_state::text,'<missing>'), v_exp;
  END IF;
END $ts$;

-- ---------------------------------------------------------------------------
-- 6. FREEZE folder creation.
--
-- A BEFORE INSERT trigger, not a revoked grant: the app still needs SELECT /
-- UPDATE / DELETE on folders (browse, rename, delete stay allowed — B9 freezes
-- CREATION, not management), and folder_permissions still cascade. service_role
-- passes through so a migration or the seed can still create the odd system
-- folder; a browser JWT cannot.
--
-- The check keys on the JWT role exactly like models_guard_schema_shrink (the
-- guard that closed the units re-seed hole), so the two read consistently.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.folders_block_creation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE jwt_role text;
BEGIN
  BEGIN
    jwt_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
  EXCEPTION WHEN OTHERS THEN jwt_role := NULL;
  END;
  -- Trusted server-side writers (migrations, seed, workers) pass through.
  IF jwt_role IS NULL OR jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'folders are frozen (Phase 3 · B9): new folders can no longer be created. Organise files by metadata in the Library instead. Existing folders stay browsable under Legacy folders.'
    USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER IF EXISTS folders_freeze_creation ON public.folders;
CREATE TRIGGER folders_freeze_creation
  BEFORE INSERT ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.folders_block_creation();

COMMIT;
