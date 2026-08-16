-- ============================================================================
-- Phase 3 · B2 — business_files_search: server-side search, filters and facets
--
-- Ships DARK. B1 gave `files` its metadata; B2 makes that metadata queryable.
-- Nothing calls this yet: no Library UI, no saved views, no folder change, no
-- Marketing migration, and NO permission change of any kind.
--
-- ── WHY SECURITY INVOKER IS THE WHOLE DESIGN ───────────────────────────────
-- The function runs as the CALLER, so every read of `files` and `file_links`
-- goes through the caller's own RLS policies. RLS remains the ONLY authority on
-- visibility; this function cannot return a row the caller could not already
-- SELECT directly, and it deliberately contains no authorization logic of its
-- own to get out of step with `wassell_can_access_file`. The record-derived
-- view branch is B4's decision and is not anticipated here in any way.
--
-- A consequence worth stating: two users calling the same query legitimately
-- get different totals and different facet counts. That is correct, and the
-- smoke asserts it rather than treating it as a bug.
--
-- ── FACETS ARE COUNTED OVER THE WHOLE FILTERED SET, NOT THE PAGE ───────────
-- so the filter bar can show real numbers and dead options can be hidden. The
-- smoke checks every facet bucket against an independent naive count.
--
-- ── ARABIC FOLDING REUSES THE EXISTING NORMALISER ──────────────────────────
-- `wassell_search_norm` (IMMUTABLE, PARALLEL SAFE) already folds أ/إ/آ→ا,
-- ة→ه, ى→ي, strips tatweel and unifies Arabic-Indic digits, and the client's
-- normalizeForSearch in src/lib/recordSearch.ts is kept identical to it. B2
-- reuses it rather than inventing a second folding rule — the same reason the
-- translation search layer reuses it. Because it is IMMUTABLE it can back both
-- a generated column and a GIN trigram index.
--
-- Rollback: supabase/rollback/2026-08-16_02_business_files_search_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The searchable text, folded once at write time.
--
--    STORED (not VIRTUAL) because it must be indexable. Adding a stored
--    generated column REWRITES the table under ACCESS EXCLUSIVE — acceptable at
--    7,133 rows, and worth knowing before scheduling the production apply.
--    ADD COLUMN fires no row trigger, so files.updated_at is untouched (B1's
--    preserved history stays preserved).
-- ---------------------------------------------------------------------------
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS search_text text
  GENERATED ALWAYS AS (
    public.wassell_search_norm(
      coalesce(title,'')         || ' ' ||
      coalesce(description,'')   || ' ' ||
      coalesce(original_name,'') || ' ' ||
      coalesce(array_to_string(tags,' '),'')
    )
  ) STORED;

COMMENT ON COLUMN public.files.search_text IS
  'Folded search haystack (title + description + original_name + tags), maintained by the database. Never written by the app.';

-- ---------------------------------------------------------------------------
-- 2. Indexes. The btree set for the metadata columns landed in B1; B2 adds the
--    trigram index that makes free text work and the two btrees the sort and
--    role filters need.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_files_search_trgm
  ON public.files USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_files_kind        ON public.files (kind);
CREATE INDEX IF NOT EXISTS idx_files_created_at  ON public.files (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_links_role   ON public.file_links (role);

-- ---------------------------------------------------------------------------
-- 3. business_files_search
--
--    Returns ONE jsonb document: { page, page_size, total, rows[], facets{} }.
--    A single round trip for the grid, the count and the filter bar.
--
--    Filters arrive as jsonb so the signature never has to change again:
--      document_type, status, kind, origin, confidentiality, role  → text[]
--      tags                                                        → text[] (ALL must match)
--      owner_user_id, uploaded_by_user_id                          → uuid[]
--      model_id, record_id                                         → uuid  (a specific record)
--      linked_model                                                → text  (e.g. 'all_projects')
--      created_from, created_to                                    → timestamptz
--      size_min, size_max                                          → bigint
--      file_class                                                  → text  (default 'business')
--      unlinked, expired, duplicate, include_archived              → boolean
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_files_search(
  p_q         text    DEFAULT NULL,
  p_filters   jsonb   DEFAULT '{}'::jsonb,
  p_sort      text    DEFAULT 'created_desc',
  p_page      integer DEFAULT 1,
  p_page_size integer DEFAULT 60
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_norm    text    := nullif(btrim(public.wassell_search_norm(p_q)), '');
  v_page    integer := greatest(coalesce(p_page, 1), 1);
  v_size    integer := least(greatest(coalesce(p_page_size, 60), 1), 200);
  v_off     integer := (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 60), 1), 200);
  v_sort    text    := coalesce(p_sort, 'created_desc');
  f         jsonb   := coalesce(p_filters, '{}'::jsonb);

  v_class     text        := coalesce(f->>'file_class', 'business');
  v_doc       text[]      := CASE WHEN f ? 'document_type'   THEN ARRAY(SELECT jsonb_array_elements_text(f->'document_type'))   END;
  v_status    text[]      := CASE WHEN f ? 'status'          THEN ARRAY(SELECT jsonb_array_elements_text(f->'status'))          END;
  v_kind      text[]      := CASE WHEN f ? 'kind'            THEN ARRAY(SELECT jsonb_array_elements_text(f->'kind'))            END;
  v_origin    text[]      := CASE WHEN f ? 'origin'          THEN ARRAY(SELECT jsonb_array_elements_text(f->'origin'))          END;
  v_conf      text[]      := CASE WHEN f ? 'confidentiality' THEN ARRAY(SELECT jsonb_array_elements_text(f->'confidentiality')) END;
  v_role      text[]      := CASE WHEN f ? 'role'            THEN ARRAY(SELECT jsonb_array_elements_text(f->'role'))            END;
  v_tags      text[]      := CASE WHEN f ? 'tags'            THEN ARRAY(SELECT jsonb_array_elements_text(f->'tags'))            END;
  v_owner     uuid[]      := CASE WHEN f ? 'owner_user_id'   THEN ARRAY(SELECT (jsonb_array_elements_text(f->'owner_user_id'))::uuid) END;
  v_uploader  uuid[]      := CASE WHEN f ? 'uploaded_by_user_id' THEN ARRAY(SELECT (jsonb_array_elements_text(f->'uploaded_by_user_id'))::uuid) END;
  v_model     uuid        := nullif(f->>'model_id','')::uuid;
  v_record    uuid        := nullif(f->>'record_id','')::uuid;
  v_lmodel    text        := nullif(f->>'linked_model','');
  v_from      timestamptz := nullif(f->>'created_from','')::timestamptz;
  v_to        timestamptz := nullif(f->>'created_to','')::timestamptz;
  v_smin      bigint      := nullif(f->>'size_min','')::bigint;
  v_smax      bigint      := nullif(f->>'size_max','')::bigint;
  v_unlinked  boolean     := coalesce((f->>'unlinked')::boolean, false);
  v_expired   boolean     := coalesce((f->>'expired')::boolean, false);
  v_dupe      boolean     := coalesce((f->>'duplicate')::boolean, false);
  v_archived  boolean     := coalesce((f->>'include_archived')::boolean, false);

  v_out jsonb;
BEGIN
  IF v_sort NOT IN ('created_desc','created_asc','updated_desc','title_asc',
                    'title_desc','size_desc','size_asc') THEN
    RAISE EXCEPTION 'business_files_search: unknown sort %', v_sort
      USING HINT = 'created_desc | created_asc | updated_desc | title_asc | title_desc | size_desc | size_asc';
  END IF;

  -- `base` is evaluated under the CALLER's RLS. Everything below reads from it.
  WITH base AS (
    SELECT fi.id, fi.title, fi.document_type, fi.kind, fi.origin, fi.status,
           fi.confidentiality, fi.file_class, fi.tags, fi.description,
           fi.original_name, fi.mime_type, fi.size_bytes, fi.owner_user_id,
           fi.uploaded_by_user_id, fi.created_at, fi.updated_at,
           fi.valid_from, fi.valid_until, fi.archived_at, fi.checksum_sha256,
           fi.storage_bucket, fi.storage_path, fi.folder_id
      FROM public.files fi
     WHERE fi.file_class = v_class
       AND (v_archived OR fi.status <> 'archived')
       AND (v_doc      IS NULL OR fi.document_type       = ANY(v_doc))
       AND (v_status   IS NULL OR fi.status              = ANY(v_status))
       AND (v_kind     IS NULL OR fi.kind                = ANY(v_kind))
       AND (v_origin   IS NULL OR fi.origin              = ANY(v_origin))
       AND (v_conf     IS NULL OR fi.confidentiality     = ANY(v_conf))
       AND (v_owner    IS NULL OR fi.owner_user_id       = ANY(v_owner))
       AND (v_uploader IS NULL OR fi.uploaded_by_user_id = ANY(v_uploader))
       AND (v_tags     IS NULL OR fi.tags @> v_tags)
       AND (v_from     IS NULL OR fi.created_at >= v_from)
       AND (v_to       IS NULL OR fi.created_at <  v_to)
       AND (v_smin     IS NULL OR fi.size_bytes >= v_smin)
       AND (v_smax     IS NULL OR fi.size_bytes <= v_smax)
       AND (v_norm     IS NULL OR fi.search_text LIKE '%' || v_norm || '%')
       AND (NOT v_expired  OR (fi.valid_until IS NOT NULL AND fi.valid_until < now()))
       AND (NOT v_unlinked OR NOT EXISTS (SELECT 1 FROM public.file_links l WHERE l.file_id = fi.id))
       AND (NOT v_dupe OR (fi.checksum_sha256 IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.files d
               WHERE d.checksum_sha256 = fi.checksum_sha256 AND d.id <> fi.id)))
       AND (v_record IS NULL OR EXISTS (
              SELECT 1 FROM public.file_links l
               WHERE l.file_id = fi.id AND l.record_id = v_record
                 AND (v_model IS NULL OR l.model_id = v_model)))
       AND (v_lmodel IS NULL OR EXISTS (
              SELECT 1 FROM public.file_links l JOIN public.models m ON m.id = l.model_id
               WHERE l.file_id = fi.id AND m.name = v_lmodel))
       AND (v_role IS NULL OR EXISTS (
              SELECT 1 FROM public.file_links l
               WHERE l.file_id = fi.id AND l.role = ANY(v_role)))
  ),
  -- The page. `id` is the final ORDER BY term on every sort so that two rows
  -- with an identical sort key can never swap between page 1 and page 2 — the
  -- classic duplicate/missing-row bug in offset pagination.
  page AS (
    SELECT b.*, row_number() OVER (
             ORDER BY
               CASE WHEN v_sort = 'created_asc'  THEN b.created_at END ASC,
               CASE WHEN v_sort = 'created_desc' THEN b.created_at END DESC,
               CASE WHEN v_sort = 'updated_desc' THEN b.updated_at END DESC,
               CASE WHEN v_sort = 'title_asc'    THEN b.title END ASC,
               CASE WHEN v_sort = 'title_desc'   THEN b.title END DESC,
               CASE WHEN v_sort = 'size_desc'    THEN b.size_bytes END DESC,
               CASE WHEN v_sort = 'size_asc'     THEN b.size_bytes END ASC,
               b.id
           ) AS rn
      FROM base b
  ),
  slice AS (
    SELECT * FROM page WHERE rn > v_off AND rn <= v_off + v_size
  )
  SELECT jsonb_build_object(
    'page',      v_page,
    'page_size', v_size,
    'total',     (SELECT count(*) FROM base),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'title', s.title, 'document_type', s.document_type,
               'kind', s.kind, 'origin', s.origin, 'status', s.status,
               'confidentiality', s.confidentiality, 'tags', to_jsonb(s.tags),
               'description', s.description, 'original_name', s.original_name,
               'mime_type', s.mime_type, 'size_bytes', s.size_bytes,
               'owner_user_id', s.owner_user_id, 'uploaded_by_user_id', s.uploaded_by_user_id,
               'created_at', s.created_at, 'updated_at', s.updated_at,
               'valid_from', s.valid_from, 'valid_until', s.valid_until,
               'archived_at', s.archived_at, 'folder_id', s.folder_id,
               'storage_bucket', s.storage_bucket, 'storage_path', s.storage_path,
               'link_count', (SELECT count(*) FROM public.file_links l WHERE l.file_id = s.id)
             ) ORDER BY s.rn)
        FROM slice s), '[]'::jsonb),
    'facets', jsonb_build_object(
      'document_type', coalesce((SELECT jsonb_object_agg(k, n) FROM
          (SELECT document_type k, count(*) n FROM base GROUP BY 1) x), '{}'::jsonb),
      'kind', coalesce((SELECT jsonb_object_agg(k, n) FROM
          (SELECT kind k, count(*) n FROM base GROUP BY 1) x), '{}'::jsonb),
      'origin', coalesce((SELECT jsonb_object_agg(k, n) FROM
          (SELECT origin k, count(*) n FROM base GROUP BY 1) x), '{}'::jsonb),
      'status', coalesce((SELECT jsonb_object_agg(k, n) FROM
          (SELECT status k, count(*) n FROM base GROUP BY 1) x), '{}'::jsonb),
      'confidentiality', coalesce((SELECT jsonb_object_agg(k, n) FROM
          (SELECT confidentiality k, count(*) n FROM base GROUP BY 1) x), '{}'::jsonb),
      'owner_user_id', coalesce((SELECT jsonb_object_agg(k::text, n) FROM
          (SELECT owner_user_id k, count(*) n FROM base GROUP BY 1) x), '{}'::jsonb),
      'tag', coalesce((SELECT jsonb_object_agg(k, n) FROM
          (SELECT t k, count(*) n FROM base b2, unnest(b2.tags) t GROUP BY 1) x), '{}'::jsonb),
      'linked_model', coalesce((SELECT jsonb_object_agg(k, n) FROM
          (SELECT m.name k, count(DISTINCT l.file_id) n
             FROM base b3
             JOIN public.file_links l ON l.file_id = b3.id
             JOIN public.models m     ON m.id = l.model_id
            GROUP BY 1) x), '{}'::jsonb),
      'role', coalesce((SELECT jsonb_object_agg(k, n) FROM
          (SELECT l.role k, count(DISTINCT l.file_id) n
             FROM base b4 JOIN public.file_links l ON l.file_id = b4.id
            GROUP BY 1) x), '{}'::jsonb),
      'health', jsonb_build_object(
        'unlinked', (SELECT count(*) FROM base b5
                      WHERE NOT EXISTS (SELECT 1 FROM public.file_links l WHERE l.file_id = b5.id)),
        'expired',  (SELECT count(*) FROM base b6
                      WHERE b6.valid_until IS NOT NULL AND b6.valid_until < now()),
        'duplicate',(SELECT count(*) FROM base b7
                      WHERE b7.checksum_sha256 IS NOT NULL
                        AND EXISTS (SELECT 1 FROM public.files d
                                     WHERE d.checksum_sha256 = b7.checksum_sha256 AND d.id <> b7.id))
      )
    )
  ) INTO v_out;

  RETURN v_out;
END;
$fn$;

-- SECURITY INVOKER means this grant cannot widen anything: the function reads
-- `files` and `file_links` as the caller, so it returns a strict subset of what
-- the caller could already SELECT. The smoke proves that per user rather than
-- asserting it. anon is explicitly excluded — the Library is authenticated-only.
REVOKE ALL ON FUNCTION public.business_files_search(text, jsonb, text, integer, integer) FROM PUBLIC;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.business_files_search(text, jsonb, text, integer, integer) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.business_files_search(text, jsonb, text, integer, integer) TO authenticated;
  END IF;
END $g$;

COMMIT;
