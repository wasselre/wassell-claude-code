-- ════════════════════════════════════════════════════════════════════════════
-- W8 (bilingual): publish all_projects.project_name to the public website.
--
-- The two-key rule (REV 4 §B6): a field reaches the anon v_website_public view
-- only when it is BOTH public_publishable in its translation policy AND has a
-- website_publish_fields allowlist row. This enables the project NAME — its
-- approved English transliteration exists for every project (541 variants) and
-- is the single most-visible piece of dynamic text on the site (cards, hero,
-- detail, map, OG/WhatsApp card). project_analysis / marketing_document stay
-- UNpublished — they are internal; the site's project prose comes from the
-- separate project_details model.
--
-- Guarded so the CI ephemeral DB (which has neither all_projects seeded nor the
-- website_publish_fields table populated) is a no-op if the model is absent.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_model uuid;
BEGIN
  SELECT id INTO v_model FROM public.models WHERE name = 'all_projects';
  IF v_model IS NULL THEN
    RAISE NOTICE 'all_projects model absent — skipping website publish';
    RETURN;
  END IF;

  UPDATE public.translation_field_policies
  SET public_publishable = true, updated_at = now()
  WHERE resource_kind='record' AND scope_id = v_model AND field_path = 'project_name';

  INSERT INTO public.website_publish_fields (resource_kind, scope_id, field_path, langs)
  VALUES ('record', v_model, 'project_name', '{ar,en}')
  ON CONFLICT (resource_kind, scope_id, field_path) DO UPDATE SET langs = EXCLUDED.langs;
END $$;
