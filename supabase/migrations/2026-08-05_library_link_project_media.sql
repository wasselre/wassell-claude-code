-- ============================================================================
-- Library ↔ project media: "link, don't copy"
--
-- THE PROBLEM
-- A photo/PDF uploaded to a project record lives as a `files` row (bytes in the
-- private `wassel-files` bucket). The marketing library is a SEPARATE store
-- (`mos_assets`, bytes in the public `marketing-assets` bucket) whose usage
-- link (`mos_asset_links`) can only point at marketing CONTENT pieces
-- (`mos_content`), never at a project record. So the same image gets uploaded
-- twice — once per system — and the library can never show "used in project X".
--
-- THE FIX (no second copy)
-- When a file is attached to a project record, register it in the library by
-- REFERENCING the same `files` row (`mos_assets.file_id`) instead of copying
-- bytes, and record the usage in a new record-link table. Nothing moves, the
-- bytes stay private (the library resolves a signed URL on read), and the
-- library gains one view of which media belongs to which project.
--
-- WHAT THIS ADDS
--  A. mos_asset_record_links — the missing "asset ↔ any record" usage link.
--  B. A unique index on mos_assets.file_id — one library asset per underlying
--     file, so re-linking the same file never duplicates the asset row.
--  C. mos_register_record_file(file_id) — SECURITY DEFINER upsert: ensure the
--     library asset for a file + the record-link, idempotently.
--  D. An AFTER trigger on `files` that calls C for project photos/PDFs.
--
-- Scope: project models only — all_projects / our_projects / targeted_projects,
-- and only image/pdf files (photos + brochures). Units and other records are
-- intentionally excluded (per product decision 2026-08-05).
--
-- Idempotent: re-running is a no-op. NON-DESTRUCTIVE: this only ADDS rows/links;
-- it never deletes or mutates existing files or assets.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- A. The record-link table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mos_asset_record_links (
  asset_id   uuid NOT NULL REFERENCES public.mos_assets(id) ON DELETE CASCADE,
  model_id   uuid,
  record_id  uuid NOT NULL,
  role       text NOT NULL DEFAULT 'source',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mos_asset_record_links_role_check
    CHECK (role = ANY (ARRAY['source'::text, 'final'::text, 'reference'::text])),
  CONSTRAINT mos_asset_record_links_pkey PRIMARY KEY (asset_id, record_id)
);

CREATE INDEX IF NOT EXISTS mos_asset_record_links_record_idx
  ON public.mos_asset_record_links (record_id);

ALTER TABLE public.mos_asset_record_links ENABLE ROW LEVEL SECURITY;

-- The marketing library is behind app auth; reads are open to authenticated
-- users the same way mos_asset_links is consumed. Writes go only through the
-- SECURITY DEFINER function below (the trigger / the backfill), never directly.
DROP POLICY IF EXISTS mos_asset_record_links_select ON public.mos_asset_record_links;
CREATE POLICY mos_asset_record_links_select
  ON public.mos_asset_record_links FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- B. One library asset per underlying file
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS mos_assets_file_id_uidx
  ON public.mos_assets (file_id) WHERE file_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- C. Register a file into the library (idempotent, SECURITY DEFINER)
--
-- Returns the mos_assets id, or NULL when the file is out of scope (not a
-- project model, or not an image/pdf). SECURITY DEFINER so the trigger and the
-- backfill can create the library row + link regardless of the writer's RLS —
-- the asset mirrors a file the writer was already allowed to create.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mos_register_record_file(p_file_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f            record;
  v_model_name text;
  v_asset_id   uuid;
  v_kind       text;
  v_project    uuid;
  v_title      text;
BEGIN
  SELECT id, model_id, record_id, kind, mime_type, original_name, size_bytes,
         uploaded_by_user_id
    INTO f
    FROM public.files
   WHERE id = p_file_id;
  IF NOT FOUND OR f.record_id IS NULL OR f.model_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Only project photos and brochures (images + PDFs on the project models).
  IF f.kind NOT IN ('image', 'pdf') THEN
    RETURN NULL;
  END IF;
  SELECT name INTO v_model_name FROM public.models WHERE id = f.model_id;
  IF v_model_name IS NULL
     OR v_model_name NOT IN ('all_projects', 'our_projects', 'targeted_projects') THEN
    RETURN NULL;
  END IF;

  -- image → photo, pdf → document (the mos_assets kind vocabulary).
  v_kind := CASE WHEN f.kind = 'pdf' THEN 'document' ELSE 'photo' END;
  -- mos_assets.project_id is an all_projects id; only stamp it when the record
  -- IS an all_projects row. For our_projects/targeted_projects the record-link
  -- carries the usage instead (project_id stays null).
  v_project := CASE WHEN v_model_name = 'all_projects' THEN f.record_id ELSE NULL END;
  v_title := regexp_replace(COALESCE(f.original_name, 'ملف'), '\.[^.]+$', '');

  -- Ensure exactly one library asset per file (the unique index backs this).
  SELECT id INTO v_asset_id FROM public.mos_assets WHERE file_id = p_file_id;
  IF v_asset_id IS NULL THEN
    INSERT INTO public.mos_assets
      (title, kind, source, project_id, file_id, size_bytes, mime_type, original_name,
       created_by_user_id)
    VALUES
      (v_title, v_kind, 'developer', v_project, f.id, f.size_bytes, f.mime_type, f.original_name,
       f.uploaded_by_user_id)
    ON CONFLICT (file_id) WHERE file_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_asset_id;
    -- Lost the race to a concurrent writer → read the winner's row.
    IF v_asset_id IS NULL THEN
      SELECT id INTO v_asset_id FROM public.mos_assets WHERE file_id = p_file_id;
    END IF;
  END IF;

  INSERT INTO public.mos_asset_record_links (asset_id, model_id, record_id, role)
  VALUES (v_asset_id, f.model_id, f.record_id, 'source')
  ON CONFLICT (asset_id, record_id) DO NOTHING;

  RETURN v_asset_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- D. Auto-register on file attach
--
-- Fires only when a file carries a record_id (a record-field upload). The
-- function early-returns for out-of-scope models/kinds, so the cost for a
-- non-project file is a single indexed models lookup. Never touches `files`,
-- so no recursion.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_files_autoregister_library()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.mos_register_record_file(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS files_autoregister_library ON public.files;
CREATE TRIGGER files_autoregister_library
  AFTER INSERT OR UPDATE OF record_id, model_id, kind ON public.files
  FOR EACH ROW
  WHEN (NEW.record_id IS NOT NULL)
  EXECUTE FUNCTION public.tg_files_autoregister_library();

GRANT EXECUTE ON FUNCTION public.mos_register_record_file(uuid) TO authenticated, service_role;

COMMIT;
