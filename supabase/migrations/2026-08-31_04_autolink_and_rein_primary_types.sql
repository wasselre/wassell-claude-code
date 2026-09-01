-- Two operator decisions (2026-08-31):
--  B) Auto-link a file to a project when the AI's deterministic matcher returns
--     exactly ONE all_projects match (unambiguous). Gated by a kill switch,
--     reversible (it writes an ordinary document_links row + provenance), and
--     only for still-unlinked files. This deliberately relaxes the standing
--     "AI never auto-applies relationships" rule for the single-match case.
--  C) Stop the AI inventing new PRIMARY types: the worker now sends a closed enum,
--     and this drops the new_primary_category create path from the complete RPC.
--     Plus a data cleanup folding the 6 AI-invented types back into the 9.

BEGIN;

-- ─── B: kill switch (default ON per the operator) ───────────────────────────
ALTER TABLE public.file_enrichment_settings
  ADD COLUMN IF NOT EXISTS auto_link_enabled boolean NOT NULL DEFAULT true;

-- ─── B + C: complete RPC — add auto-link, remove new-primary creation ────────
CREATE OR REPLACE FUNCTION public.file_enrichment_complete(p_job_id uuid, p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_file   uuid;
  v_model  text := p_result->>'model';
  v_desc   text := nullif(btrim(coalesce(p_result->>'description','')), '');
  v_nature text := nullif(p_result->>'asset_nature','');
  v_acq    text := nullif(p_result->>'acquisition_source','');
  v_rights text := nullif(p_result->>'usage_rights','');
  v_state  text := nullif(p_result->>'production_state','');
  v_pcat   text := nullif(p_result->>'primary_category','');
  v_title  text := nullif(btrim(coalesce(p_result->>'title','')), '');
  v_tags   text[] := CASE WHEN p_result ? 'tags' THEN ARRAY(SELECT jsonb_array_elements_text(p_result->'tags')) END;
  v_subs   text[] := CASE WHEN p_result ? 'subjects' THEN ARRAY(SELECT jsonb_array_elements_text(p_result->'subjects')) END;
  v_edited boolean;
  v_new    text;
  v_autolink boolean;
  v_proj_count int;
  v_proj_model uuid;
  v_proj_rec   uuid;
  v_owner  uuid;
  s text;
  e jsonb;
BEGIN
  UPDATE public.file_enrichment_jobs
     SET status='completed', finished_at=now(), error=NULL
   WHERE id=p_job_id AND status='running'
  RETURNING file_id INTO v_file;
  IF v_file IS NULL THEN RETURN false; END IF;

  -- ai_description
  IF v_desc IS NOT NULL THEN
    SELECT state='human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id=v_file AND field_path='ai_description';
    IF v_edited IS NOT TRUE THEN
      UPDATE public.files SET ai_description=v_desc WHERE id=v_file;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (v_file,'ai_description','ai_suggested',v_model,now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- primary_category — CLOSED list now (no new-type creation). Apply only when
  -- the value is a real vocab row, the file has none yet, and no human set it.
  IF v_pcat IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.file_vocabularies WHERE dimension='primary_category' AND value=v_pcat) THEN
    SELECT state='human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id=v_file AND field_path='primary_category';
    IF v_edited IS NOT TRUE AND (SELECT primary_category IS NULL FROM public.files WHERE id=v_file) THEN
      UPDATE public.files SET primary_category=v_pcat WHERE id=v_file;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (v_file,'primary_category','ai_suggested',v_model,now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- asset_nature
  IF v_nature IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.file_vocabularies WHERE dimension='asset_nature' AND value=v_nature) THEN
    SELECT state='human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id=v_file AND field_path='asset_nature';
    IF v_edited IS NOT TRUE AND (SELECT asset_nature IS NULL FROM public.files WHERE id=v_file) THEN
      UPDATE public.files SET asset_nature=v_nature WHERE id=v_file;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (v_file,'asset_nature','ai_suggested',v_model,now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- acquisition_source
  IF v_acq IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.file_vocabularies WHERE dimension='acquisition_source' AND value=v_acq) THEN
    SELECT state='human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id=v_file AND field_path='acquisition_source';
    IF v_edited IS NOT TRUE AND (SELECT acquisition_source IS NULL FROM public.files WHERE id=v_file) THEN
      UPDATE public.files SET acquisition_source=v_acq WHERE id=v_file;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (v_file,'acquisition_source','ai_suggested',v_model,now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- usage_rights
  IF v_rights IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.file_vocabularies WHERE dimension='usage_rights' AND value=v_rights) THEN
    SELECT state='human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id=v_file AND field_path='usage_rights';
    IF v_edited IS NOT TRUE AND (SELECT usage_rights IS NULL FROM public.files WHERE id=v_file) THEN
      UPDATE public.files SET usage_rights=v_rights WHERE id=v_file;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (v_file,'usage_rights','ai_suggested',v_model,now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- production_state
  IF v_state IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.file_vocabularies WHERE dimension='production_state' AND value=v_state) THEN
    SELECT state='human_modified' INTO v_edited FROM public.file_metadata_provenance
      WHERE file_id=v_file AND field_path='production_state';
    IF v_edited IS NOT TRUE AND (SELECT production_state IS NULL FROM public.files WHERE id=v_file) THEN
      UPDATE public.files SET production_state=v_state WHERE id=v_file;
      INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
      VALUES (v_file,'production_state','ai_suggested',v_model,now())
      ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
        WHERE public.file_metadata_provenance.state <> 'human_modified';
    END IF;
  END IF;

  -- title → staged
  IF v_title IS NOT NULL THEN
    UPDATE public.files
       SET ai_suggestions = coalesce(ai_suggestions,'{}'::jsonb)
                            || jsonb_build_object('title', v_title, 'title_model', v_model)
     WHERE id=v_file;
  END IF;

  -- tags (additive)
  IF v_tags IS NOT NULL AND array_length(v_tags,1) > 0 THEN
    UPDATE public.files
       SET tags = ARRAY(SELECT DISTINCT unnest(coalesce(tags,'{}') || v_tags))
     WHERE id=v_file;
    INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
    VALUES (v_file,'tags','ai_suggested',v_model,now())
    ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
      WHERE public.file_metadata_provenance.state <> 'human_modified';
  END IF;

  -- subjects (existing vocab values)
  IF v_subs IS NOT NULL THEN
    FOREACH s IN ARRAY v_subs LOOP
      IF EXISTS (SELECT 1 FROM public.file_document_types WHERE value=s) THEN
        INSERT INTO public.file_subjects(file_id, subject) VALUES (v_file, s)
          ON CONFLICT (file_id, subject) DO NOTHING;
        INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
        VALUES (v_file,'subject:'||s,'ai_suggested',v_model,now())
        ON CONFLICT (file_id, field_path) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  -- new_subjects (AI may still create SECONDARY types — unchanged)
  IF p_result ? 'new_subjects' AND jsonb_typeof(p_result->'new_subjects') = 'array' THEN
    FOR e IN SELECT * FROM jsonb_array_elements(p_result->'new_subjects') LOOP
      IF jsonb_typeof(e) = 'object' THEN
        SELECT value INTO v_new FROM public.file_document_type_create(
          coalesce(nullif(btrim(coalesce(e->>'label_ar','')),''),
                   nullif(btrim(coalesce(e->>'label_en','')),''),
                   nullif(btrim(coalesce(e->>'value','')),'')));
        IF v_new IS NOT NULL THEN
          INSERT INTO public.file_subjects(file_id, subject) VALUES (v_file, v_new)
            ON CONFLICT (file_id, subject) DO NOTHING;
          INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
          VALUES (v_file,'subject:'||v_new,'ai_suggested',v_model,now())
          ON CONFLICT (file_id, field_path) DO NOTHING;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- relationship suggestions → staging (legacy shape)
  IF p_result ? 'relationship_suggestions' THEN
    UPDATE public.files
       SET ai_suggestions = coalesce(ai_suggestions,'{}'::jsonb)
                            || jsonb_build_object('relationships', p_result->'relationship_suggestions',
                                                  'model', v_model, 'at', now())
     WHERE id=v_file;
  END IF;

  -- link suggestions → staging, UNLINKED files only
  IF p_result ? 'link_suggestions'
     AND jsonb_typeof(p_result->'link_suggestions') = 'array'
     AND jsonb_array_length(p_result->'link_suggestions') > 0
     AND NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id = v_file) THEN
    UPDATE public.files
       SET ai_suggestions = coalesce(ai_suggestions,'{}'::jsonb)
                            || jsonb_build_object('links', p_result->'link_suggestions',
                                                  'links_model', v_model, 'links_at', now())
     WHERE id=v_file;

    -- ── B: AUTO-LINK a SINGLE unambiguous project match ──────────────────────
    -- Gated by the kill switch. Best-effort: a failure here (RLS, FK) must not
    -- fail the whole enrichment, which already wrote all the metadata — it RAISEs
    -- a WARNING (logged) rather than swallowing silently.
    SELECT auto_link_enabled INTO v_autolink FROM public.file_enrichment_settings WHERE id;
    IF coalesce(v_autolink, false) THEN
      WITH proj AS (
        SELECT DISTINCT (x->>'model_id')::uuid AS model_id, (x->>'record_id')::uuid AS record_id
          FROM jsonb_array_elements(p_result->'link_suggestions') x
         WHERE x->>'model_name' = 'all_projects'
           AND coalesce(x->>'record_id','') <> ''
      )
      SELECT count(*), min(model_id), min(record_id) INTO v_proj_count, v_proj_model, v_proj_rec FROM proj;

      IF v_proj_count = 1 THEN
        SELECT uploaded_by_user_id INTO v_owner FROM public.files WHERE id = v_file;
        IF v_owner IS NOT NULL THEN
          BEGIN
            INSERT INTO public.document_links (file_id, model_id, record_id, created_by_user_id, role)
            VALUES (v_file, v_proj_model, v_proj_rec, v_owner, NULL)
            ON CONFLICT (file_id, model_id, record_id) DO NOTHING;
            INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
            VALUES (v_file, 'link:'||v_proj_rec::text, 'ai_suggested', v_model, now())
            ON CONFLICT (file_id, field_path) DO NOTHING;
          EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'auto-link failed for file % -> record %: %', v_file, v_proj_rec, SQLERRM;
          END;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN true;
END $function$;

-- ─── C: fold the 6 AI-invented primary types back into the 9 ─────────────────
UPDATE public.files SET primary_category = CASE primary_category
    WHEN 'architectural_visualization'   THEN 'design'
    WHEN 'marketing_presentation'        THEN 'design'
    WHEN 'branding_logo'                 THEN 'design'
    WHEN 'project_progress_documentation' THEN 'raw_photo'
    WHEN 'exam_paper'                    THEN 'raw_photo'
    WHEN 'market_research_report'         THEN 'brochure'
    ELSE primary_category END
 WHERE primary_category IN ('architectural_visualization','marketing_presentation','branding_logo',
                            'project_progress_documentation','exam_paper','market_research_report');

DELETE FROM public.file_vocabularies
 WHERE dimension='primary_category'
   AND value IN ('architectural_visualization','marketing_presentation','branding_logo',
                 'project_progress_documentation','exam_paper','market_research_report');

COMMIT;
