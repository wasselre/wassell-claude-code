-- The record Files panel labels its groups from the document-type vocabulary
-- (documentTypeLabel(role, types)); the new derived link role `social_post`
-- needs a vocabulary row or the heading renders the raw key ("SOCIAL_POST").
INSERT INTO public.file_document_types (value, label_ar, label_en, applies_to_kinds, default_confidentiality, sort, active)
VALUES ('social_post', 'منشور تواصل اجتماعي', 'Social media post', ARRAY['image','video'], 'internal', 90, true)
ON CONFLICT (value) DO UPDATE SET label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, active = true;
