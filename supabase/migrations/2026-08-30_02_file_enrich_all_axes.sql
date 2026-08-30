-- AI enrichment fills EVERY structured field, not just description/subjects/nature.
--
-- Adds acquisition_source (مصدر الحصول), usage_rights (حقوق الاستخدام) and
-- production_state (حالة الإنتاج) to the auto-applied layers (same NULL-guarded,
-- vocab-validated, human-modified-respecting rule as asset_nature), stages an AI
-- title, and exposes all of it + the top link suggestion through the peek RPC so
-- the post-upload modal can PRE-FILL its fields. The worker (runEnrichmentJob.ts)
-- proposes the new values; this migration applies/serves them.

BEGIN;

-- ── 1. Completion: apply the three new axes + stage a title ─────────────────
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
  v_title  text := nullif(btrim(coalesce(p_result->>'title','')), '');
  v_tags   text[] := CASE WHEN p_result ? 'tags' THEN ARRAY(SELECT jsonb_array_elements_text(p_result->'tags')) END;
  v_subs   text[] := CASE WHEN p_result ? 'subjects' THEN ARRAY(SELECT jsonb_array_elements_text(p_result->'subjects')) END;
  v_edited boolean;
  s text;
BEGIN
  UPDATE public.file_enrichment_jobs
     SET status='completed', finished_at=now(), error=NULL
   WHERE id=p_job_id AND status='running'
  RETURNING file_id INTO v_file;
  IF v_file IS NULL THEN RETURN false; END IF;

  -- ai_description (safe, auto-apply unless a human edited it)
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

  -- asset_nature (only when unset + valid vocab + not human-edited)
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

  -- acquisition_source — same rule as asset_nature.
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

  -- usage_rights — same rule.
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

  -- production_state — same rule.
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

  -- title → STAGED into ai_suggestions (never overwrites files.title, which is
  -- human-owned). The post-upload modal pre-fills its title input from this.
  IF v_title IS NOT NULL THEN
    UPDATE public.files
       SET ai_suggestions = coalesce(ai_suggestions,'{}'::jsonb)
                            || jsonb_build_object('title', v_title, 'title_model', v_model)
     WHERE id=v_file;
  END IF;

  -- tags (additive union; add-only, never remove)
  IF v_tags IS NOT NULL AND array_length(v_tags,1) > 0 THEN
    UPDATE public.files
       SET tags = ARRAY(SELECT DISTINCT unnest(coalesce(tags,'{}') || v_tags))
     WHERE id=v_file;
    INSERT INTO public.file_metadata_provenance(file_id, field_path, state, model, decided_at)
    VALUES (v_file,'tags','ai_suggested',v_model,now())
    ON CONFLICT (file_id, field_path) DO UPDATE SET state='ai_suggested', model=v_model, decided_at=now()
      WHERE public.file_metadata_provenance.state <> 'human_modified';
  END IF;

  -- subjects (add valid ones to file_subjects; skip unknown vocab values)
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

  -- relationship suggestions → STAGING only (never auto-linked). Legacy shape.
  IF p_result ? 'relationship_suggestions' THEN
    UPDATE public.files
       SET ai_suggestions = coalesce(ai_suggestions,'{}'::jsonb)
                            || jsonb_build_object('relationships', p_result->'relationship_suggestions',
                                                  'model', v_model, 'at', now())
     WHERE id=v_file;
  END IF;

  -- link suggestions → STAGING only, and ONLY for an UNLINKED file.
  IF p_result ? 'link_suggestions'
     AND jsonb_typeof(p_result->'link_suggestions') = 'array'
     AND jsonb_array_length(p_result->'link_suggestions') > 0
     AND NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id = v_file) THEN
    UPDATE public.files
       SET ai_suggestions = coalesce(ai_suggestions,'{}'::jsonb)
                            || jsonb_build_object('links', p_result->'link_suggestions',
                                                  'links_model', v_model, 'links_at', now())
     WHERE id=v_file;
  END IF;

  RETURN true;
END $function$;

-- ── 2. Peek: serve the new axes, the staged title, and the top link ─────────
CREATE OR REPLACE FUNCTION public.file_enrichment_peek(p_file_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'file_id', f.id,
    'status', coalesce(
      (SELECT j.status FROM public.file_enrichment_jobs j
        WHERE j.file_id = f.id ORDER BY j.created_at DESC LIMIT 1), 'none'),
    'ai_description', f.ai_description,
    'asset_nature', f.asset_nature,
    'acquisition_source', f.acquisition_source,
    'usage_rights', f.usage_rights,
    'production_state', f.production_state,
    'ai_title', f.ai_suggestions->>'title',
    'tags', to_jsonb(coalesce(f.tags, '{}'::text[])),
    'ai_subjects', coalesce((
      SELECT jsonb_agg(substr(p.field_path, 9))
        FROM public.file_metadata_provenance p
       WHERE p.file_id = f.id AND p.state = 'ai_suggested' AND p.field_path LIKE 'subject:%'), '[]'::jsonb),
    'has_link_suggestions', (f.ai_suggestions ? 'links'),
    -- the single top link suggestion, unlinked files only, for the modal to prefill
    'link_suggestion', CASE
      WHEN jsonb_typeof(f.ai_suggestions->'links') = 'array'
       AND jsonb_array_length(f.ai_suggestions->'links') > 0
       AND NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id = f.id)
      THEN f.ai_suggestions->'links'->0 ELSE NULL END
  )), '[]'::jsonb)
    FROM public.files f
   WHERE f.id = ANY(p_file_ids)
     AND public.wassell_can_access_file(f.id, 'view');
$function$;

-- ── 3. Dismiss: revert the three new axes + drop the staged title ───────────
CREATE OR REPLACE FUNCTION public.file_suggestions_dismiss(p_file_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n integer; v_primary text;
BEGIN
  IF NOT public.wassell_can_access_file(p_file_id, 'edit') THEN
    RAISE EXCEPTION 'not allowed to edit this file';
  END IF;
  SELECT document_type INTO v_primary FROM public.files WHERE id = p_file_id;

  UPDATE public.files SET ai_description = NULL
   WHERE id = p_file_id
     AND EXISTS (SELECT 1 FROM public.file_metadata_provenance
                  WHERE file_id = p_file_id AND field_path = 'ai_description' AND state = 'ai_suggested');
  UPDATE public.files SET asset_nature = NULL
   WHERE id = p_file_id
     AND EXISTS (SELECT 1 FROM public.file_metadata_provenance
                  WHERE file_id = p_file_id AND field_path = 'asset_nature' AND state = 'ai_suggested');
  UPDATE public.files SET acquisition_source = NULL
   WHERE id = p_file_id
     AND EXISTS (SELECT 1 FROM public.file_metadata_provenance
                  WHERE file_id = p_file_id AND field_path = 'acquisition_source' AND state = 'ai_suggested');
  UPDATE public.files SET usage_rights = NULL
   WHERE id = p_file_id
     AND EXISTS (SELECT 1 FROM public.file_metadata_provenance
                  WHERE file_id = p_file_id AND field_path = 'usage_rights' AND state = 'ai_suggested');
  UPDATE public.files SET production_state = NULL
   WHERE id = p_file_id
     AND EXISTS (SELECT 1 FROM public.file_metadata_provenance
                  WHERE file_id = p_file_id AND field_path = 'production_state' AND state = 'ai_suggested');

  -- drop the staged AI title (never touched files.title)
  UPDATE public.files
     SET ai_suggestions = (ai_suggestions - 'title' - 'title_model')
   WHERE id = p_file_id AND ai_suggestions ? 'title';

  -- Remove AI-added subjects (never the primary document_type).
  DELETE FROM public.file_subjects fs
   WHERE fs.file_id = p_file_id
     AND fs.subject <> coalesce(v_primary, '')
     AND EXISTS (SELECT 1 FROM public.file_metadata_provenance p
                  WHERE p.file_id = p_file_id AND p.field_path = 'subject:' || fs.subject AND p.state = 'ai_suggested');

  DELETE FROM public.file_metadata_provenance
   WHERE file_id = p_file_id AND state = 'ai_suggested';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $function$;

COMMIT;
