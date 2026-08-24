-- AI link suggestions for UNLINKED files.
--
-- Split of concerns (same posture as market ingest: extraction ≠ adapter):
--   * the AI EXTRACTS the project/developer names it can read in a file (it is
--     good at reading "مينا 52" off a brochure) — it never guesses a record id;
--   * file_link_suggest() MATCHES those names to real records DETERMINISTICALLY
--     (normalized, so Arabic folding is identical to search);
--   * file_enrichment_complete STAGES the matches in files.ai_suggestions.links,
--     and ONLY when the file is unlinked — a linked file already has its record,
--     so a suggestion there is noise. Nothing is ever auto-linked; the operator
--     approves each suggestion in the AI review tab.

-- ── The matcher ────────────────────────────────────────────────────────────
-- Candidates: all_projects (project_name) + developers (name). Ranked exact →
-- edge-prefix → contained; pure-substring only when both sides are ≥4 chars, so
-- a two-letter token can't drag in half the table. SECURITY DEFINER: the worker
-- (service role) calls it, and matching must see every project regardless of the
-- file owner's scope; applying a suggestion is still RLS-gated (attach needs
-- edit rights). Returns a jsonb array, newest-strongest first, capped at 5.
CREATE OR REPLACE FUNCTION public.file_link_suggest(p_names text[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH q AS (
    SELECT DISTINCT btrim(n) AS raw, public.wassell_search_norm(btrim(n)) AS norm
      FROM unnest(coalesce(p_names, '{}'::text[])) n
     WHERE length(public.wassell_search_norm(btrim(n))) >= 2
  ),
  cand AS (
    SELECT m.id AS model_id, m.name AS model_name, r.id AS record_id,
           r.data->>'project_name' AS label,
           public.wassell_search_norm(r.data->>'project_name') AS nlabel
      FROM public.records r JOIN public.models m ON m.id = r.model_id
     WHERE m.name = 'all_projects' AND coalesce(r.data->>'project_name', '') <> ''
    UNION ALL
    SELECT m.id, m.name, r.id, r.data->>'name',
           public.wassell_search_norm(r.data->>'name')
      FROM public.records r JOIN public.models m ON m.id = r.model_id
     WHERE m.name = 'developers' AND coalesce(r.data->>'name', '') <> ''
  ),
  matched AS (
    SELECT c.model_id, c.model_name, c.record_id, c.label, q.raw AS matched_name,
           CASE
             WHEN c.nlabel = q.norm THEN 0
             WHEN c.nlabel LIKE q.norm || '%' OR q.norm LIKE c.nlabel || '%' THEN 1
             ELSE 2
           END AS rank,
           length(c.nlabel) AS nlen
      FROM cand c
      JOIN q ON c.nlabel = q.norm
             OR c.nlabel LIKE q.norm || '%' OR q.norm LIKE c.nlabel || '%'
             OR (length(q.norm) >= 4 AND length(c.nlabel) >= 4
                 AND (c.nlabel LIKE '%' || q.norm || '%' OR q.norm LIKE '%' || c.nlabel || '%'))
  ),
  ranked AS (
    SELECT DISTINCT ON (record_id) model_id, model_name, record_id, label, matched_name, rank
      FROM matched
     ORDER BY record_id, rank, nlen
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'model_id', model_id, 'model_name', model_name,
           'record_id', record_id, 'label', label, 'matched_name', matched_name
         ) ORDER BY rank), '[]'::jsonb)
    FROM (SELECT * FROM ranked ORDER BY rank LIMIT 5) x;
$$;
REVOKE ALL ON FUNCTION public.file_link_suggest(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_link_suggest(text[]) TO authenticated, service_role;

-- ── Stage the suggestions in the enrichment-complete path ──────────────────
-- Verbatim re-emit of the live function with ONE added block: link_suggestions
-- → ai_suggestions.links, gated on the file being unlinked.
CREATE OR REPLACE FUNCTION public.file_enrichment_complete(p_job_id uuid, p_result jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_file  uuid;
  v_model text := p_result->>'model';
  v_desc  text := nullif(btrim(coalesce(p_result->>'description','')), '');
  v_nature text := nullif(p_result->>'asset_nature','');
  v_tags  text[] := CASE WHEN p_result ? 'tags' THEN ARRAY(SELECT jsonb_array_elements_text(p_result->'tags')) END;
  v_subs  text[] := CASE WHEN p_result ? 'subjects' THEN ARRAY(SELECT jsonb_array_elements_text(p_result->'subjects')) END;
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

  -- link suggestions → STAGING only, and ONLY for an UNLINKED file. A linked
  -- file already has its record; a suggestion there would be noise (the operator
  -- rule: linked → don't suggest, unlinked → suggest). Never auto-links.
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
