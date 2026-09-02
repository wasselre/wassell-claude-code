-- ============================================================================
-- Post Creative Director — asset enrich v2 apply + aspect_family search filter
-- (2026-09-02_29) — owner: A-ASSETS. ADDITIVE ONLY, idempotent. NOT YET APPLIED
-- (the lead applies; migrations _20.._26 are already live).
--
-- 1. file_enrichment_apply_v2(p_file_id, p_has_text, p_headline_space,
--    p_ocr_text, p_subjects, p_model) — writes the visual-signal columns the
--    asset_enrich_v2 vision pass produces (files.has_text / headline_space /
--    ocr_text), stamps visual_meta_version='enrich-v2', records an
--    'ai_suggested' provenance row per applied field, and inserts the scene
--    subjects into file_subjects (vocab-guarded, FK-safe). Human edits win:
--    a field whose provenance is 'human_modified' is never overwritten.
-- 2. Scene-subject vocabulary seed (file_document_types) — the CLOSED list the
--    v2 pass may propose. Seeded so the file_subjects inserts above are always
--    FK-safe and the values are searchable/filterable app-wide.
-- 3. business_files_search — full re-emit of the live body
--    (2026-08-31_03_search_primary_category.sql) with ONLY additive changes:
--      a. optional `aspect_family` filter (portrait|landscape|square derived
--         from aspect_ratio W:H), read from p_filters — absent key = no
--         constraint, so every existing caller is unaffected;
--      b. rights_provenance + rights_verified on each returned row (for the
--         file picker's verified/unverified badges). Computed on the ≤200-row
--         page slice, NOT on `base`, so the unfiltered query cost is unchanged.
--    Deliberately NO aspect_family FACET: each facet re-scans the RLS-gated
--    `base` CTE, and the batch of metadata-axis facets tipped the unfiltered
--    query over statement_timeout on 2026-08-23. The filter-bar control for
--    aspect family uses fixed options (like primary_category), not counts.
-- ============================================================================

BEGIN;

-- ── 1. Scene-subject vocabulary seed ────────────────────────────────────────
-- The closed scene_subjects list the enrich-v2 pass may propose (contracts,
-- A-ASSETS brief). applies_to_kinds '{image}' — scenes are an image signal.
INSERT INTO public.file_document_types (value, label_ar, label_en, applies_to_kinds, sort, active) VALUES
  ('exterior',  'خارجي',        'Exterior',       '{image}', 610, true),
  ('interior',  'داخلي',        'Interior',       '{image}', 611, true),
  ('plan',      'مخطط',         'Plan',           '{image}', 612, true),
  ('aerial',    'جوي',          'Aerial',         '{image}', 613, true),
  ('lifestyle', 'أسلوب حياة',   'Lifestyle',      '{image}', 614, true),
  ('people',    'أشخاص',        'People',         '{image}', 615, true),
  ('amenity',   'مرافق',        'Amenity',        '{image}', 616, true),
  ('pool',      'مسبح',         'Pool',           '{image}', 617, true),
  ('kitchen',   'مطبخ',         'Kitchen',        '{image}', 618, true),
  ('bedroom',   'غرفة نوم',     'Bedroom',        '{image}', 619, true),
  ('majlis',    'مجلس',         'Majlis',         '{image}', 620, true),
  ('facade',    'واجهة',        'Facade',         '{image}', 621, true),
  ('garden',    'حديقة',        'Garden',         '{image}', 622, true),
  ('street',    'شارع',         'Street',         '{image}', 623, true),
  ('render',    'رندر',         'Render',         '{image}', 624, true),
  ('logo',      'شعار',         'Logo',           '{image}', 625, true),
  ('text_card', 'بطاقة نصية',   'Text card',      '{image}', 626, true)
ON CONFLICT (value) DO NOTHING;

-- ── 2. file_enrichment_apply_v2 ─────────────────────────────────────────────
-- Worker-only (service_role). Called by runEnrichmentJob AFTER a successful
-- asset_enrich_v2 vision pass. Idempotent: re-running stamps the same version
-- and re-asserts the same provenance/subject rows (ON CONFLICT guards).
CREATE OR REPLACE FUNCTION public.file_enrichment_apply_v2(
  p_file_id        uuid,
  p_has_text       boolean,
  p_headline_space text,
  p_ocr_text       text,
  p_subjects       text[],
  p_model          text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_space  text := nullif(btrim(coalesce(p_headline_space, '')), '');
  v_ocr    text := nullif(btrim(coalesce(p_ocr_text, '')), '');
  v_edited boolean;
  s text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_file_id) THEN
    RETURN false;
  END IF;

  -- has_text — never overwrite a human decision.
  IF p_has_text IS NOT NULL THEN
    SELECT state = 'human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id = p_file_id AND field_path = 'has_text';
    IF v_edited IS NOT TRUE THEN
      UPDATE public.files SET has_text = p_has_text WHERE id = p_file_id;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (p_file_id, 'has_text', 'ai_suggested', p_model, now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=p_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- headline_space — only a value in the CHECKed set lands.
  IF v_space IS NOT NULL AND v_space IN ('none','top','bottom','left','right','center') THEN
    SELECT state = 'human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id = p_file_id AND field_path = 'headline_space';
    IF v_edited IS NOT TRUE THEN
      UPDATE public.files SET headline_space = v_space WHERE id = p_file_id;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (p_file_id, 'headline_space', 'ai_suggested', p_model, now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=p_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- ocr_text — capped at 500 chars (the pass is instructed to cap; enforce here too).
  IF v_ocr IS NOT NULL THEN
    SELECT state = 'human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id = p_file_id AND field_path = 'ocr_text';
    IF v_edited IS NOT TRUE THEN
      UPDATE public.files SET ocr_text = left(v_ocr, 500) WHERE id = p_file_id;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (p_file_id, 'ocr_text', 'ai_suggested', p_model, now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=p_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- Scene subjects — vocab-guarded (seeded above; anything else is skipped,
  -- never a FK violation), additive, provenance per subject.
  IF p_subjects IS NOT NULL THEN
    FOREACH s IN ARRAY p_subjects LOOP
      IF EXISTS (SELECT 1 FROM public.file_document_types WHERE value = s) THEN
        INSERT INTO public.file_subjects(file_id, subject) VALUES (p_file_id, s)
          ON CONFLICT (file_id, subject) DO NOTHING;
        INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
        VALUES (p_file_id, 'subject:' || s, 'ai_suggested', p_model, now())
          ON CONFLICT (file_id, field_path) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  -- The version stamp marks that the enrich-v2 pass RAN for this file (the
  -- backfill targets RPC keys off it). Stamped even when every field came
  -- back null — "we looked and found nothing" is a completed pass, not a
  -- pending one.
  UPDATE public.files SET visual_meta_version = 'enrich-v2' WHERE id = p_file_id;

  RETURN true;
END $function$;

REVOKE ALL ON FUNCTION public.file_enrichment_apply_v2(uuid, boolean, text, text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_enrichment_apply_v2(uuid, boolean, text, text, text[], text) TO service_role;

-- ── 3. business_files_search — re-emit + aspect_family + rights trust ───────
CREATE OR REPLACE FUNCTION public.business_files_search(p_q text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb, p_sort text DEFAULT 'created_desc'::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- Metadata Intelligence axes (Phase B)
  v_nature    text[]      := CASE WHEN f ? 'asset_nature'       THEN ARRAY(SELECT jsonb_array_elements_text(f->'asset_nature'))       END;
  v_source    text[]      := CASE WHEN f ? 'acquisition_source' THEN ARRAY(SELECT jsonb_array_elements_text(f->'acquisition_source')) END;
  v_rights    text[]      := CASE WHEN f ? 'usage_rights'       THEN ARRAY(SELECT jsonb_array_elements_text(f->'usage_rights'))       END;
  v_pstate    text[]      := CASE WHEN f ? 'production_state'    THEN ARRAY(SELECT jsonb_array_elements_text(f->'production_state'))    END;
  v_subject   text[]      := CASE WHEN f ? 'subject'            THEN ARRAY(SELECT jsonb_array_elements_text(f->'subject'))            END;
  v_pcat      text[]      := CASE WHEN f ? 'primary_category'   THEN ARRAY(SELECT jsonb_array_elements_text(f->'primary_category')) END;
  -- ADDED (2026-09-02_29): aspect family filter — portrait|landscape|square,
  -- derived from aspect_ratio W:H (±5% tolerance counts as square).
  v_aspect    text[]      := CASE WHEN f ? 'aspect_family'      THEN ARRAY(SELECT jsonb_array_elements_text(f->'aspect_family'))      END;
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

  WITH base AS (
    SELECT fi.id, fi.title, fi.document_type, fi.kind, fi.origin, fi.status,
           fi.confidentiality, fi.file_class, fi.tags, fi.description,
           fi.original_name, fi.mime_type, fi.size_bytes, fi.owner_user_id,
           fi.uploaded_by_user_id, fi.created_at, fi.updated_at,
           fi.valid_from, fi.valid_until, fi.archived_at, fi.checksum_sha256, fi.content_etag,
           fi.storage_bucket, fi.storage_path, fi.folder_id,
           fi.asset_nature, fi.acquisition_source, fi.usage_rights, fi.production_state,
           fi.primary_category,
           fi.ai_description, fi.width_px, fi.height_px, fi.duration_seconds, fi.page_count, fi.aspect_ratio
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
       AND (v_nature   IS NULL OR fi.asset_nature        = ANY(v_nature))
       AND (v_source   IS NULL OR fi.acquisition_source  = ANY(v_source))
       AND (v_rights   IS NULL OR fi.usage_rights        = ANY(v_rights))
       AND (v_pstate   IS NULL OR fi.production_state     = ANY(v_pstate))
       AND (v_pcat     IS NULL OR fi.primary_category     = ANY(v_pcat))
       -- ADDED (2026-09-02_29): aspect family — parse the snapped W:H label.
       AND (v_aspect   IS NULL OR (
              CASE
                WHEN fi.aspect_ratio ~ '^\d+:\d+$' THEN
                  CASE
                    WHEN split_part(fi.aspect_ratio, ':', 1)::numeric
                       > split_part(fi.aspect_ratio, ':', 2)::numeric * 1.05 THEN 'landscape'
                    WHEN split_part(fi.aspect_ratio, ':', 2)::numeric
                       > split_part(fi.aspect_ratio, ':', 1)::numeric * 1.05 THEN 'portrait'
                    ELSE 'square'
                  END
              END) = ANY(v_aspect))
       AND (v_subject  IS NULL OR EXISTS (SELECT 1 FROM public.file_subjects fs
                                           WHERE fs.file_id = fi.id AND fs.subject = ANY(v_subject)))
       AND (v_tags     IS NULL OR fi.tags @> v_tags)
       AND (v_from     IS NULL OR fi.created_at >= v_from)
       AND (v_to       IS NULL OR fi.created_at <  v_to)
       AND (v_smin     IS NULL OR fi.size_bytes >= v_smin)
       AND (v_smax     IS NULL OR fi.size_bytes <= v_smax)
       AND (v_norm     IS NULL OR fi.search_text LIKE '%' || v_norm || '%'
                                OR fi.linked_search_text LIKE '%' || v_norm || '%')
       AND (NOT v_expired  OR (fi.valid_until IS NOT NULL AND fi.valid_until < now()))
       AND (NOT v_unlinked OR NOT EXISTS (SELECT 1 FROM public.file_links l WHERE l.file_id = fi.id))
       AND (NOT v_dupe OR (fi.content_etag IS NOT NULL AND EXISTS (SELECT 1 FROM public.files d WHERE d.content_etag = fi.content_etag AND d.size_bytes = fi.size_bytes AND d.id <> fi.id)))
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
               'asset_nature', s.asset_nature, 'acquisition_source', s.acquisition_source,
               'usage_rights', s.usage_rights, 'production_state', s.production_state,
               'primary_category', s.primary_category,
               -- ADDED (2026-09-02_29): rights trust for picker badges. Per-row
               -- LATERAL on the ≤200-row slice only — `base` is NOT re-scanned.
               'rights_provenance', COALESCE(rv.state, 'unknown'),
               'rights_verified', (rv.state IN ('human_approved','human_modified')),
               'ai_description', s.ai_description, 'width_px', s.width_px, 'height_px', s.height_px,
               'duration_seconds', s.duration_seconds, 'page_count', s.page_count,
               'aspect_ratio', s.aspect_ratio,
               'subjects', coalesce((SELECT jsonb_agg(fs.subject) FROM public.file_subjects fs WHERE fs.file_id = s.id), '[]'::jsonb),
               'link_count', (SELECT count(*) FROM public.file_links l WHERE l.file_id = s.id)
             ) ORDER BY s.rn)
        FROM slice s
        LEFT JOIN LATERAL (
          SELECT pr.state
            FROM public.file_metadata_provenance pr
           WHERE pr.file_id = s.id AND pr.field_path = 'usage_rights'
           ORDER BY pr.decided_at DESC
           LIMIT 1
        ) rv ON true), '[]'::jsonb),
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
      -- NOTE: facets for the metadata axes (asset_nature / acquisition_source /
      -- usage_rights / production_state / subject / primary_category /
      -- aspect_family) are intentionally NOT computed here — each is a re-scan
      -- of the RLS-gated `base` CTE, and the batch of them tipped the
      -- unfiltered query over the statement timeout (live incident 2026-08-23).
      -- Filtering on them works (WHERE clauses above + the vocab-driven /
      -- fixed-option dropdowns); the facet COUNTS wait on the single-pass
      -- rewrite (the B2 optimization).
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
                      WHERE b7.content_etag IS NOT NULL AND EXISTS (SELECT 1 FROM public.files d WHERE d.content_etag = b7.content_etag AND d.size_bytes = b7.size_bytes AND d.id <> b7.id))
      )
    )
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

COMMIT;
