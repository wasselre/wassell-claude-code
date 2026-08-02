-- ═══════════════════════════════════════════════════════════════════════════
-- Bilingual architecture W1 — migration 05/05: public website publishing
-- contract (REV 4 §B6 / decision D-3 signed 2026-08-02).
--
-- NO generic i18n surface is anon-exposed. The website reads ONE view whose
-- rows are limited to: is_public records × explicitly allowlisted fields ×
-- generation-valid translations. Two-key rule: a field must BOTH be
-- public_publishable in its policy AND have an allowlist row.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.website_publish_fields (
  resource_kind text NOT NULL DEFAULT 'record',
  scope_id uuid NOT NULL,                 -- model_id
  field_path text NOT NULL,
  langs text[] NOT NULL DEFAULT '{ar,en}',
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_kind, scope_id, field_path)
);
ALTER TABLE public.website_publish_fields ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_publish_fields FROM anon, authenticated;
-- Admin management via RPC:
CREATE OR REPLACE FUNCTION public.website_publish_field_set(
  p_scope uuid, p_path text, p_langs text[], p_remove boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT wassell_is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_remove THEN
    DELETE FROM website_publish_fields
    WHERE resource_kind='record' AND scope_id=p_scope AND field_path=p_path;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM translation_field_policies p
                 WHERE p.resource_kind='record' AND p.scope_id=p_scope
                   AND p.field_path=p_path AND p.public_publishable) THEN
    RAISE EXCEPTION 'field_not_publishable';   -- two-key rule
  END IF;
  INSERT INTO website_publish_fields (resource_kind, scope_id, field_path, langs, created_by)
  VALUES ('record', p_scope, p_path, COALESCE(p_langs,'{ar,en}'), auth.uid())
  ON CONFLICT (resource_kind, scope_id, field_path) DO UPDATE SET langs = EXCLUDED.langs;
END $$;
GRANT EXECUTE ON FUNCTION public.website_publish_field_set(uuid, text, text[], boolean) TO authenticated;

-- The single anon-readable localized surface. security_invoker=false is
-- DELIBERATE here (definer-style view): the view itself embeds every
-- restriction (is_public × allowlist × generation-valid), and anon has no
-- other grant on the translation tables.
CREATE OR REPLACE VIEW public.v_website_public
WITH (security_invoker = false) AS
SELECT ur.id AS record_id,
       ur.model_id,
       w.field_path,
       ur.data->>w.field_path AS value_source,
       CASE WHEN 'ar' = ANY (w.langs) THEN
         COALESCE((SELECT v.display_text FROM translation_variants v
                   JOIN translation_units u USING (resource_kind, entity_id, field_path)
                   WHERE v.resource_kind='record' AND v.entity_id=ur.id AND v.field_path=w.field_path
                     AND v.lang='ar' AND v.role='target' AND v.state IN ('translated','approved')
                     AND v.generation = u.generation),
                  CASE WHEN (ur.data->>w.field_path) ~ '[؀-ۿ]' THEN ur.data->>w.field_path END)
       END AS value_ar,
       CASE WHEN 'en' = ANY (w.langs) THEN
         COALESCE((SELECT v.display_text FROM translation_variants v
                   JOIN translation_units u USING (resource_kind, entity_id, field_path)
                   WHERE v.resource_kind='record' AND v.entity_id=ur.id AND v.field_path=w.field_path
                     AND v.lang='en' AND v.role='target' AND v.state IN ('translated','approved')
                     AND v.generation = u.generation),
                  CASE WHEN (ur.data->>w.field_path) !~ '[؀-ۿ]' THEN ur.data->>w.field_path END)
       END AS value_en
FROM public.unified_records ur
JOIN public.website_publish_fields w
  ON w.resource_kind = 'record' AND w.scope_id = ur.model_id
WHERE COALESCE((ur.data->>'is_public')::boolean, false) = true;

GRANT SELECT ON public.v_website_public TO anon, authenticated;

-- NOTE for the frozen-model unwind procedure (CLAUDE.md): v_website_public
-- depends on unified_records — it must be dropped/recreated alongside
-- v_our_projects_scope whenever the view chain is rebuilt, and it is NOT
-- security_invoker (recreating it as invoker would break anon reads).
