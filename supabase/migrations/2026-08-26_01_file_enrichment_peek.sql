-- Lets the post-upload modal show AI progress + results live: one round trip
-- returns, per requested file, its latest enrichment-job status and whatever the
-- AI has applied so far (description / nature / tags / suggested subjects / link
-- suggestions). Gated on VIEW access (cheap for the handful of just-uploaded
-- files the modal polls); SECURITY DEFINER so the status join isn't blocked.
CREATE OR REPLACE FUNCTION public.file_enrichment_peek(p_file_ids uuid[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'file_id', f.id,
    'status', coalesce(
      (SELECT j.status FROM public.file_enrichment_jobs j
        WHERE j.file_id = f.id ORDER BY j.created_at DESC LIMIT 1), 'none'),
    'ai_description', f.ai_description,
    'asset_nature', f.asset_nature,
    'tags', to_jsonb(coalesce(f.tags, '{}'::text[])),
    'ai_subjects', coalesce((
      SELECT jsonb_agg(substr(p.field_path, 9))
        FROM public.file_metadata_provenance p
       WHERE p.file_id = f.id AND p.state = 'ai_suggested' AND p.field_path LIKE 'subject:%'), '[]'::jsonb),
    'has_link_suggestions', (f.ai_suggestions ? 'links')
  )), '[]'::jsonb)
    FROM public.files f
   WHERE f.id = ANY(p_file_ids)
     AND public.wassell_can_access_file(f.id, 'view');
$$;
REVOKE ALL ON FUNCTION public.file_enrichment_peek(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_enrichment_peek(uuid[]) TO authenticated;
