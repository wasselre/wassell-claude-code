-- ═══════════════════════════════════════════════════════════════════════════
-- Value translations — durable cache for AI-translated RECORD VALUES
-- (2026-07-31)
--
-- Schema labels (label_ar/label_en) are already bilingual at rest. This table
-- closes the other half of the bilingual experience: free-typed record data
-- (project names, notes, analyses). Rows are keyed by a sha256 of the SOURCE
-- TEXT, not by record — identical strings translate once, and an edited value
-- simply misses the cache (new text = new hash), so there is no invalidation
-- logic anywhere.
--
-- Writers: /api/value-translate (service role, on-demand batches from the SPA)
-- and scripts/backfill-value-translations.mjs (service role, bulk). The SPA
-- only ever SELECTs. Translations are a DISPLAY OVERLAY — records.data is
-- never touched by any of this.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.value_translations (
  -- sha256 hex digest of source_text (exact bytes, no normalization — the
  -- API endpoint and the backfill script compute the same digest in JS).
  source_hash text NOT NULL,
  target_lang text NOT NULL CHECK (target_lang IN ('ar', 'en')),
  source_text text NOT NULL CHECK (char_length(source_text) BETWEEN 1 AND 4000),
  translated_text text NOT NULL,
  -- 'name' = transliterated proper noun (project/person/brand),
  -- 'text' = natural translation of prose.
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('name', 'text')),
  provider text NOT NULL DEFAULT 'deepseek',
  -- Provenance hints from the first requester (model name / field slug).
  -- Informational only — the same string may appear in many fields.
  model_hint text,
  field_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_lang, source_hash)
);

COMMENT ON TABLE public.value_translations IS
  'Display-overlay cache of AI-translated record values, keyed by sha256(source_text). Never a source of truth — records.data always holds what the user typed.';

ALTER TABLE public.value_translations ENABLE ROW LEVEL SECURITY;

-- Every signed-in user may read translations (they are derived display text
-- for content the app shows; record access itself is still gated by record
-- RLS — knowing a translation requires already knowing the source text).
DROP POLICY IF EXISTS value_translations_select ON public.value_translations;
CREATE POLICY value_translations_select ON public.value_translations
  FOR SELECT TO authenticated USING (true);

-- No INSERT/UPDATE/DELETE policies: all writes go through the service role
-- (/api/value-translate, backfill script).

GRANT SELECT ON public.value_translations TO authenticated;
GRANT ALL ON public.value_translations TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Backfill candidates — distinct untranslated Arabic strings across every
-- translatable text/textarea field. SERVICE-ROLE ONLY (reads all records
-- regardless of RLS; the backfill script is the only caller).
--
-- "Translatable" mirrors src/lib/valueTranslation/config.ts — keep in sync:
--   * field type text/textarea
--   * slug does not end in _ar/_en (those fields are bilingual by design)
--   * model is not excluded (chat/media/system models, external market data,
--     website copy, geo models that already carry name_ar/name_en)
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.value_translation_candidates(p_limit integer DEFAULT 500)
RETURNS TABLE (source_text text, kind text, model_hint text, field_hint text)
LANGUAGE sql
SECURITY DEFINER
-- `extensions` is on the path because Supabase installs pgcrypto (digest) there.
SET search_path = public, extensions
AS $$
  WITH excluded AS (
    SELECT unnest(ARRAY[
      'chats','ai_chats','image_chats','copywriter_chats','matching_chats',
      'data_migration','decks','market_listings','real_estate_offices',
      'posts_content','project_details','chat_templates','site_settings',
      'districts','cities','regions','countries','developer_knowledge',
      'prompt_snippets','design_templates','image_presets','reel_scripts'
    ]) AS name
  ),
  flds AS (
    SELECT m.id AS model_id, m.name AS model, f->>'name' AS slug, f->>'type' AS ftype
    FROM models m,
         jsonb_array_elements(m.schema->'sections') s,
         jsonb_array_elements(s->'fields') f
    WHERE f->>'type' IN ('text','textarea')
      AND f->>'name' !~ '_(ar|en)$'
      AND m.name NOT IN (SELECT name FROM excluded)
  ),
  vals AS (
    SELECT DISTINCT ON (ur.data->>fl.slug)
      ur.data->>fl.slug AS source_text,
      CASE
        WHEN fl.ftype = 'textarea' THEN 'text'
        WHEN fl.slug ~ '(^|_)(name|title|block|model|project|developer|client)' THEN 'name'
        ELSE 'text'
      END AS kind,
      fl.model AS model_hint,
      fl.slug AS field_hint
    FROM flds fl
    JOIN unified_records ur ON ur.model_id = fl.model_id
    WHERE ur.data->>fl.slug ~ '[؀-ۿ]'
      AND char_length(ur.data->>fl.slug) BETWEEN 1 AND 4000
  )
  SELECT v.source_text, v.kind, v.model_hint, v.field_hint
  FROM vals v
  WHERE NOT EXISTS (
    SELECT 1 FROM value_translations t
    WHERE t.target_lang = 'en'
      AND t.source_hash = encode(digest(v.source_text, 'sha256'::text), 'hex')
  )
  ORDER BY v.source_text
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.value_translation_candidates(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.value_translation_candidates(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.value_translation_candidates(integer) TO service_role;
