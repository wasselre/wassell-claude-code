-- Human review of AI suggestions (posture A): accept (keep + mark approved) or
-- dismiss (remove the AI-applied values). Both gated on EDIT access to the file
-- (mirrors the provenance RLS). Editing a field in the panel already makes it
-- human_modified, which the enrichment complete RPC refuses to overwrite.

-- Accept: every ai_suggested field becomes human_approved. Values stay.
CREATE OR REPLACE FUNCTION public.file_suggestions_approve(p_file_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.wassell_can_access_file(p_file_id, 'edit') THEN
    RAISE EXCEPTION 'not allowed to edit this file';
  END IF;
  UPDATE public.file_metadata_provenance
     SET state = 'human_approved', decided_by = auth.uid(), decided_at = now()
   WHERE file_id = p_file_id AND state = 'ai_suggested';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.file_suggestions_approve(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_suggestions_approve(uuid) TO authenticated;

-- Dismiss: undo the clearly-attributable AI writes (ai_description, asset_nature,
-- AI-added subjects) and drop every ai_suggested provenance row. Additive tags
-- are left in place (they carry no per-tag provenance and are low-stakes); the
-- user can edit them out. document_type (the primary subject) is never touched.
CREATE OR REPLACE FUNCTION public.file_suggestions_dismiss(p_file_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer; v_primary text;
BEGIN
  IF NOT public.wassell_can_access_file(p_file_id, 'edit') THEN
    RAISE EXCEPTION 'not allowed to edit this file';
  END IF;
  SELECT document_type INTO v_primary FROM public.files WHERE id = p_file_id;

  -- ai_description / asset_nature back to null when they were AI-suggested.
  UPDATE public.files SET ai_description = NULL
   WHERE id = p_file_id
     AND EXISTS (SELECT 1 FROM public.file_metadata_provenance
                  WHERE file_id = p_file_id AND field_path = 'ai_description' AND state = 'ai_suggested');
  UPDATE public.files SET asset_nature = NULL
   WHERE id = p_file_id
     AND EXISTS (SELECT 1 FROM public.file_metadata_provenance
                  WHERE file_id = p_file_id AND field_path = 'asset_nature' AND state = 'ai_suggested');

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
END $$;
REVOKE ALL ON FUNCTION public.file_suggestions_dismiss(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_suggestions_dismiss(uuid) TO authenticated;
