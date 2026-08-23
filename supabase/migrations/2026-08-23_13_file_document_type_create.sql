-- Inline creation of a classification (file_document_types) from the picker,
-- so a user can type "unit plan" / "brochure" and have it saved — no settings
-- page needed. Writes to file_document_types are otherwise closed (the value is
-- FK'd), so this is a SECURITY DEFINER RPC that controls the slug and is safe to
-- expose to any authenticated user: it only ADDS a term, never edits or removes.

CREATE OR REPLACE FUNCTION public.file_document_type_create(p_label text)
RETURNS public.file_document_types
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_label text := btrim(coalesce(p_label, ''));
  v_value text;
  v_row   public.file_document_types;
BEGIN
  IF v_label = '' THEN
    RAISE EXCEPTION 'file_document_type_create: label is required';
  END IF;

  -- Deterministic slug (the "inline-create UUID drift" lesson: a value must be
  -- stable, never random). Latin labels → a readable slug; an all-Arabic label
  -- (no a–z0–9 left) → a stable hash-based key, since the value is a text key.
  v_value := btrim(regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g'), '_');
  IF v_value IS NULL OR v_value = '' THEN
    v_value := 'type_' || substr(md5(v_label), 1, 12);
  END IF;

  -- Add if new; reuse (and re-activate) if the value already exists. Either way
  -- return the row so the caller can select it immediately.
  INSERT INTO public.file_document_types (value, label_ar, label_en, applies_to_kinds, default_confidentiality, sort, active)
  VALUES (v_value, v_label, v_label, '{}', 'internal', 500, true)
  ON CONFLICT (value) DO UPDATE SET active = true
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.file_document_type_create(text) FROM public;
GRANT EXECUTE ON FUNCTION public.file_document_type_create(text) TO authenticated;
