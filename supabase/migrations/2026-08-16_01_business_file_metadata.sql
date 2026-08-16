-- ============================================================================
-- Phase 3 · B1 — Business-file metadata foundation
--
-- Ships DARK. Additive only. Nothing reads these columns yet: no UI, no search
-- RPC, no saved views, no authorization branch, no RLS change, no folder freeze,
-- no Marketing canonicalisation. B1 exists so that B2 (search) and B5 (Library)
-- have something to read, and so that every file written from today forward
-- carries defined metadata without any change to the upload UX.
--
-- ── WHY A BEFORE TRIGGER RATHER THAN CODE CHANGES ──────────────────────────
-- Files rows are inserted from at least four places (the Drive dropzone in
-- src/lib/files/client.ts, the document editor in src/lib/documents/client.ts,
-- worker/src/runCompressJob.ts and worker/src/runDocumentJob.ts) and none of
-- them names the new columns. Column DEFAULTs cover the constants, but `title`,
-- `owner_user_id` and `document_type` are derived FROM THE ROW ITSELF and a
-- DEFAULT expression cannot see sibling columns. A BEFORE trigger can, so every
-- existing writer keeps working untouched and still produces a complete row.
-- The trigger is row-local apart from one primary-key probe of a 16-row
-- vocabulary table, so it adds no lock and no measurable cost.
--
-- ── WHY THE BACKFILL IS SAFE UNDER PHASE 2 ─────────────────────────────────
-- Phase 2 put an AFTER trigger on `files` that marks (model_id, record_id)
-- dirty and converges the projection at COMMIT, taking the GLOBAL projection
-- lock exclusively once a transaction dirties more than
-- file_link_bulk_target_threshold() targets. A 7,133-row backfill would be
-- exactly that shape — except tg_files_sync_file_links() opens with
--
--     IF TG_OP = 'UPDATE'
--        AND OLD.model_id  IS NOT DISTINCT FROM NEW.model_id
--        AND OLD.record_id IS NOT DISTINCT FROM NEW.record_id THEN
--       RETURN NULL;                                   -- cheapest exit
--
-- This backfill never touches model_id or record_id, so it marks NOTHING dirty,
-- takes no projection lock and cannot block a concurrent writer. The smoke
-- asserts file_link_dirty_targets is empty and reconcile drift is still zero
-- after the backfill runs — that assertion is the whole reason this migration
-- is allowed to be a single statement per column rather than a batched loop.
--
-- ── IDEMPOTENCY ────────────────────────────────────────────────────────────
-- Every DDL is IF NOT EXISTS or guarded on pg_constraint. Every backfill is
-- guarded so a second run is a no-op UPDATE of zero rows. Re-running this file
-- against a database it has already been applied to changes nothing.
--
-- Rollback: supabase/rollback/2026-08-16_01_business_file_metadata_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The controlled document-type vocabulary.
--
-- src/lib/files/linkRoles.ts already anticipated this: "When manual linking
-- ships, the roles become a real table and file_link_role_for reads it instead."
-- Every value below is asserted somewhere in production today — by a
-- file_links.role, by a folder name, or by the document-template registry.
--
-- `default_confidentiality` is where decision D3 lives. Making it a column
-- rather than an IF in the trigger means changing the policy later is a data
-- edit, not a migration.
--
-- Ships with RLS enabled and NO policies (deny-all) and no grants: nothing in
-- the app may read it during B1. The BEFORE trigger reads it as SECURITY
-- DEFINER. B5 adds the read policy when the Library UI actually needs it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.file_document_types (
  value                   text PRIMARY KEY,
  label_ar                text    NOT NULL,
  label_en                text    NOT NULL,
  applies_to_kinds        text[]  NOT NULL DEFAULT '{}',
  default_confidentiality text    NOT NULL DEFAULT 'internal',
  sort                    integer NOT NULL DEFAULT 0,
  active                  boolean NOT NULL DEFAULT true,
  CONSTRAINT file_document_types_conf_chk
    CHECK (default_confidentiality IN ('public','internal','restricted'))
);

ALTER TABLE public.file_document_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.file_document_types FROM PUBLIC;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN REVOKE ALL ON public.file_document_types FROM anon;          END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.file_document_types FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN REVOKE ALL ON public.file_document_types FROM service_role;  END IF;
END $g$;

INSERT INTO public.file_document_types
  (value, label_ar, label_en, applies_to_kinds, default_confidentiality, sort) VALUES
  ('floor_plan',          'مخطط',            'Floor plan',          '{image,pdf,document}', 'internal',   10),
  ('gallery_image',       'صورة معرض',       'Gallery image',       '{image}',              'internal',   20),
  ('main_image',          'صورة رئيسية',     'Main image',          '{image}',              'internal',   30),
  ('hero_image',          'صورة غلاف',       'Hero image',          '{image}',              'internal',   40),
  ('marketing_asset',     'مادة تسويقية',    'Marketing asset',     '{image,video,pdf,document}', 'internal', 50),
  ('brochure',            'بروشور',          'Brochure',            '{pdf,document}',       'internal',   60),
  ('developer_content',   'محتوى المطوّر',   'Developer content',   '{image,video,pdf,document}', 'internal', 70),
  ('video',               'فيديو',           'Video',               '{video}',              'internal',   80),
  ('price_list',          'قائمة أسعار',     'Price list',          '{pdf,document}',       'internal',   90),
  ('reservation_form',    'نموذج حجز',       'Reservation form',    '{pdf,document}',       'internal',  100),
  ('contract',            'عقد',             'Contract',            '{pdf,document}',       'restricted',110),
  ('id_document',         'هوية',            'ID document',         '{image,pdf}',          'restricted',120),
  ('supporting_document', 'مستند مساند',     'Supporting document', '{}',                   'internal',  130),
  ('reference',           'مرجع',            'Reference',           '{}',                   'internal',  140),
  ('task_attachment',     'مرفق مهمة',       'Task attachment',     '{}',                   'internal',  150),
  ('other',               'أخرى',            'Other',               '{}',                   'internal',  900)
ON CONFLICT (value) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The metadata columns on `files`.
--
-- Every NOT NULL column added here carries a DEFAULT, so PostgreSQL records the
-- default in the catalogue instead of rewriting the heap — this is O(1) on the
-- 7,133-row production table, not a table rewrite.
--
-- title / document_type / owner_user_id are added NULLABLE, backfilled in §4,
-- and promoted to NOT NULL in §5, because their values derive from the row.
--
-- Deliberately NOT here: supersedes_file_id (spec §12 assigns versioning
-- lineage to a later batch) and any generated tsvector/trigram column (spec
-- §7/B2 owns search).
-- ---------------------------------------------------------------------------
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS title            text,
  ADD COLUMN IF NOT EXISTS document_type    text,
  ADD COLUMN IF NOT EXISTS description      text,
  ADD COLUMN IF NOT EXISTS tags             text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status           text        NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS owner_user_id    uuid,
  ADD COLUMN IF NOT EXISTS origin           text        NOT NULL DEFAULT 'user_upload',
  ADD COLUMN IF NOT EXISTS file_class       text        NOT NULL DEFAULT 'business',
  ADD COLUMN IF NOT EXISTS checksum_sha256  text,
  ADD COLUMN IF NOT EXISTS valid_from       timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until      timestamptz,
  ADD COLUMN IF NOT EXISTS confidentiality  text        NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz;

COMMENT ON COLUMN public.files.title           IS 'Display name everywhere. Seeded from original_name minus extension. User-editable.';
COMMENT ON COLUMN public.files.document_type   IS 'What the document IS. FK to file_document_types. Distinct from `kind` (what the bytes are) and `origin` (how it arrived).';
COMMENT ON COLUMN public.files.owner_user_id   IS 'Accountable person, transferable. uploaded_by_user_id stays immutable history.';
COMMENT ON COLUMN public.files.origin          IS 'How the row entered the system. Set by the write path, never user-editable.';
COMMENT ON COLUMN public.files.file_class      IS 'business = eligible for the Library. system = machine artefact, shown only under its parent.';
COMMENT ON COLUMN public.files.confidentiality IS 'Constrains reach, never grants it. `restricted` suppresses the B4 record-derived view branch.';
COMMENT ON COLUMN public.files.checksum_sha256 IS 'Populated at upload from B7 onward. Intentionally NULL for pre-B7 rows: back-computing it would mean downloading 6.3 GB of production objects.';

-- ---------------------------------------------------------------------------
-- 3. Fill-in trigger, so new rows are complete without touching any writer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_files_fill_business_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER                    -- reads file_document_types, which is deny-all
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_conf text;
BEGIN
  -- Title: original_name minus a trailing extension, else the whole name.
  -- The id-based fallback is unreachable in production (original_name is
  -- NOT NULL and CHECKed to length >= 1) and exists so the NOT NULL in §5 can
  -- never be violated by a future writer.
  IF NEW.title IS NULL OR btrim(NEW.title) = '' THEN
    NEW.title := COALESCE(
      NULLIF(btrim(regexp_replace(COALESCE(NEW.original_name,''), '\.[A-Za-z0-9]{1,8}$', '')), ''),
      NULLIF(btrim(COALESCE(NEW.original_name,'')), ''),
      'file-' || left(NEW.id::text, 8));
  END IF;

  IF NEW.owner_user_id IS NULL THEN
    NEW.owner_user_id := NEW.uploaded_by_user_id;
  END IF;

  -- At INSERT time the row has no file_links edges yet (they are derived
  -- afterwards), so the only honest inference is from `kind`.
  IF NEW.document_type IS NULL THEN
    NEW.document_type := CASE NEW.kind
                           WHEN 'image' THEN 'gallery_image'
                           WHEN 'video' THEN 'video'
                           ELSE 'other'
                         END;
  END IF;

  -- D3: the vocabulary decides the default confidentiality. Only applied when
  -- the caller left it at the column default, so an explicit choice always wins.
  IF TG_OP = 'INSERT' AND NEW.confidentiality = 'internal' THEN
    SELECT t.default_confidentiality INTO v_conf
      FROM public.file_document_types t WHERE t.value = NEW.document_type;
    IF v_conf IS NOT NULL AND v_conf <> 'internal' THEN
      NEW.confidentiality := v_conf;
    END IF;
  END IF;

  -- Keeps the archived pair coherent so the CHECK in §5 can be strict.
  IF NEW.status = 'archived' AND NEW.archived_at IS NULL THEN
    NEW.archived_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS files_fill_business_metadata ON public.files;
CREATE TRIGGER files_fill_business_metadata
  BEFORE INSERT OR UPDATE ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.tg_files_fill_business_metadata();

-- ---------------------------------------------------------------------------
-- 4. Backfill. Each statement is guarded so a re-run updates zero rows.
-- ---------------------------------------------------------------------------

-- 4a. title
UPDATE public.files f
   SET title = COALESCE(
         NULLIF(btrim(regexp_replace(f.original_name, '\.[A-Za-z0-9]{1,8}$', '')), ''),
         NULLIF(btrim(f.original_name), ''),
         'file-' || left(f.id::text, 8))
 WHERE f.title IS NULL OR btrim(f.title) = '';

-- 4b. owner = uploader (uploaded_by_user_id is NOT NULL in production)
UPDATE public.files f
   SET owner_user_id = f.uploaded_by_user_id
 WHERE f.owner_user_id IS NULL;

-- 4c. document_type, inferred from the strongest relationship role the file
--     already carries; otherwise from `kind`. Priority is most-specific-first
--     so a file that is both a floor plan and a gallery image reads as a floor
--     plan. `attachment` is a mechanism, not a type, so it maps to the generic
--     supporting_document rather than inventing task_attachment for a file
--     hanging off a client.
WITH role_priority(role, doc_type, prio) AS (
  VALUES ('floor_plan','floor_plan',1),
         ('main_image','main_image',2),
         ('hero_image','hero_image',3),
         ('marketing_asset','marketing_asset',4),
         ('developer_content','developer_content',5),
         ('video','video',6),
         ('gallery_image','gallery_image',7),
         ('reference','reference',8),
         ('supporting_document','supporting_document',9),
         ('attachment','supporting_document',10)
), best AS (
  SELECT DISTINCT ON (l.file_id) l.file_id, rp.doc_type
    FROM public.file_links l
    JOIN role_priority rp ON rp.role = l.role
   ORDER BY l.file_id, rp.prio
)
UPDATE public.files f
   SET document_type = COALESCE(
         (SELECT b.doc_type FROM best b WHERE b.file_id = f.id),
         CASE f.kind WHEN 'image' THEN 'gallery_image'
                     WHEN 'video' THEN 'video'
                     ELSE 'other' END)
 WHERE f.document_type IS NULL;

-- 4d. file_class + origin.
--     Ordered most-specific first. Each is guarded, and each source table is
--     probed with to_regclass so this file also applies to the CI fixture.
DO $b$
BEGIN
  -- Renditions: the ONLY system-class rows today. pdf_compress_jobs.result_file_id
  -- is authoritative — it is written by the worker that creates the copy.
  IF to_regclass('public.pdf_compress_jobs') IS NOT NULL THEN
    UPDATE public.files f
       SET file_class = 'system', origin = 'derived_rendition'
     WHERE EXISTS (SELECT 1 FROM public.pdf_compress_jobs j WHERE j.result_file_id = f.id)
       AND (f.file_class <> 'system' OR f.origin <> 'derived_rendition');
  END IF;

  -- Generated documents. document_jobs.result_file_id is authoritative; the
  -- name pattern is the documented secondary rule for rows generated before
  -- that column was populated. buildPdfName() in worker/src/runDocumentJob.ts
  -- emits "<label> — <record title> · <8 hex>.pdf"; the " · <8 hex>.pdf" suffix
  -- is machine-produced and no human upload in production matches it.
  IF to_regclass('public.document_jobs') IS NOT NULL THEN
    UPDATE public.files f
       SET origin = 'generated_document'
     WHERE f.origin = 'user_upload'
       AND EXISTS (SELECT 1 FROM public.document_jobs j WHERE j.result_file_id = f.id);
  END IF;

  UPDATE public.files f
     SET origin = 'generated_document'
   WHERE f.origin = 'user_upload'
     AND f.kind = 'pdf'
     AND f.original_name ~ ' · [0-9a-f]{8}\.pdf$';

  -- Marketing intake: the canonical library uploads.
  IF to_regclass('public.mos_assets') IS NOT NULL THEN
    UPDATE public.files f
       SET origin = 'marketing_intake'
     WHERE f.origin = 'user_upload'
       AND EXISTS (SELECT 1 FROM public.mos_assets a WHERE a.file_id = f.id);
  END IF;
END $b$;

-- 4e. confidentiality — apply the D3 defaults from the vocabulary.
--     Re-asserts the DEFAULT for a type that demands one; a file explicitly
--     moved off 'internal' by a human is never touched, because the guard only
--     matches rows still sitting on the column default.
UPDATE public.files f
   SET confidentiality = t.default_confidentiality
  FROM public.file_document_types t
 WHERE t.value = f.document_type
   AND t.default_confidentiality <> 'internal'
   AND f.confidentiality = 'internal';

-- ---------------------------------------------------------------------------
-- 5. Constraints. Applied AFTER the backfill so they can be strict.
-- ---------------------------------------------------------------------------
ALTER TABLE public.files ALTER COLUMN title         SET NOT NULL;
ALTER TABLE public.files ALTER COLUMN document_type SET NOT NULL;
ALTER TABLE public.files ALTER COLUMN owner_user_id SET NOT NULL;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_title_len_chk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_title_len_chk
      CHECK (length(btrim(title)) BETWEEN 1 AND 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_status_chk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_status_chk
      CHECK (status IN ('draft','active','superseded','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_confidentiality_chk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_confidentiality_chk
      CHECK (confidentiality IN ('public','internal','restricted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_file_class_chk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_file_class_chk
      CHECK (file_class IN ('business','system'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_origin_chk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_origin_chk
      CHECK (origin IN ('user_upload','marketing_intake','integration_inbound',
                        'generated_document','derived_rendition','system_artifact'));
  END IF;
  -- Archive is a pair: a row is archived exactly when it carries an archived_at.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_archived_pair_chk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_archived_pair_chk
      CHECK ((status = 'archived') = (archived_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_validity_order_chk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_validity_order_chk
      CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_document_type_fk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_document_type_fk
      FOREIGN KEY (document_type) REFERENCES public.file_document_types(value)
      ON UPDATE CASCADE;
  END IF;
  -- users may be absent in the CI fixture; the FK is real in production.
  IF to_regclass('public.users') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='files_owner_user_fk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_owner_user_fk
      FOREIGN KEY (owner_user_id) REFERENCES public.users(id);
  END IF;
END $c$;

-- ---------------------------------------------------------------------------
-- 6. document_links.role — the manual many-to-many write surface gains the
--    vocabulary. NULL means supporting_document (spec §5); it is left nullable
--    rather than defaulted so "the linker did not say" stays distinguishable
--    from "the linker chose supporting_document".
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_links ADD COLUMN IF NOT EXISTS role text;
COMMENT ON COLUMN public.document_links.role IS
  'Document type asserted by the person who made the manual link. NULL = supporting_document.';

DO $d$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='document_links_role_fk') THEN
    ALTER TABLE public.document_links ADD CONSTRAINT document_links_role_fk
      FOREIGN KEY (role) REFERENCES public.file_document_types(value) ON UPDATE CASCADE;
  END IF;
END $d$;

-- ---------------------------------------------------------------------------
-- 7. Indexes for the new columns. The trigram / full-text search indexes named
--    in spec §7 belong to B2, which owns business_files_search().
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_files_document_type   ON public.files (document_type);
CREATE INDEX IF NOT EXISTS idx_files_status          ON public.files (status);
CREATE INDEX IF NOT EXISTS idx_files_owner           ON public.files (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_files_file_class      ON public.files (file_class);
CREATE INDEX IF NOT EXISTS idx_files_origin          ON public.files (origin);
CREATE INDEX IF NOT EXISTS idx_files_confidentiality ON public.files (confidentiality);
CREATE INDEX IF NOT EXISTS idx_files_tags            ON public.files USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_files_checksum        ON public.files (checksum_sha256) WHERE checksum_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_valid_until     ON public.files (valid_until)     WHERE valid_until    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_archived_at     ON public.files (archived_at)     WHERE archived_at    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_links_role   ON public.document_links (role);

COMMIT;
