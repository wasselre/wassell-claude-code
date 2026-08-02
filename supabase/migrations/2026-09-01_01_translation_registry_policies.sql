-- ═══════════════════════════════════════════════════════════════════════════
-- Bilingual architecture W1 — migration 01/05: resource registry + field
-- policies (REV 4 plan §4/§5, DDL validated on PG17 via BEGIN/ROLLBACK
-- 2026-08-02; decision sheet signed 2026-08-02 — D-1 "DeepSeek for
-- everything", listings/chats/AI-chat/offices/prompts/archived excluded,
-- competitors + developer_knowledge included).
--
-- Ships DARK: nothing processes until translation_settings.is_enabled (mig 03)
-- AND per-resource `enabled`, AND a field's policy is `confirmed`.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Arabic-folding + digit-unifying normalizer shared by search + matching.
-- IMMUTABLE — used in expression GIN indexes (mig 04).
CREATE OR REPLACE FUNCTION public.wassell_search_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(translate(regexp_replace(COALESCE(t,''),'[ـ]','','g'),
    'أإآةى٠١٢٣٤٥٦٧٨٩', 'اا هي0123456789'));
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Registry: one row per parent store a translation unit can belong to.
-- Static — RLS/search dispatch is a hardcoded CASE (translation_visible,
-- mig 02), NEVER a registry-supplied executable (REV 4 blocker 5).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.translation_resources (
  resource_kind text PRIMARY KEY,
  parent_table text NOT NULL,
  parent_pk text NOT NULL DEFAULT 'id',
  enabled boolean NOT NULL DEFAULT false,     -- capture/enqueue gate
  read_live boolean NOT NULL DEFAULT false,   -- per-kind read-path cutover flag (mig-plan §D5)
  notes text
);
ALTER TABLE public.translation_resources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.translation_resources FROM anon, authenticated;

INSERT INTO public.translation_resources (resource_kind, parent_table, parent_pk, notes) VALUES
  ('record',     'records (via unified_records)', 'id',      'dynamic JSONB models incl. frozen geo (geo fields themselves are official — never AI)'),
  ('wassel_doc', 'wassel_documents',              'file_id',  'W-Docs workstream: block-level units, read-only localized rendering')
ON CONFLICT (resource_kind) DO NOTHING;
-- mkt_* kinds are registered by W6-M with their capture triggers.

-- ───────────────────────────────────────────────────────────────────────────
-- Field policies: the ONE classification source (TS config + SQL both read
-- this; collapses the config.ts ↔ candidates-RPC duplication).
-- scope_id: model_id for resource_kind='record'; zero-uuid for fixed-schema
-- tables (avoids a NULLable PK column).
-- Only classification_status='confirmed' rows are ever processed.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.translation_field_policies (
  resource_kind text NOT NULL REFERENCES public.translation_resources(resource_kind),
  scope_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  field_path text NOT NULL,
  ftype text,
  semantic_class text NOT NULL,
  treatment text NOT NULL CHECK (treatment IN ('translate','transliterate','copy','skip')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('normal','pii','financial','internal','restricted')),
  external_provider_allowed boolean NOT NULL,
  redaction_required boolean NOT NULL DEFAULT false,
  provider_route text NOT NULL CHECK (provider_route IN ('deepseek','anthropic','none')),
  tm_reuse text NOT NULL CHECK (tm_reuse IN ('org','global_terms','never','service_only')),
  require_approval boolean NOT NULL DEFAULT false,
  public_publishable boolean NOT NULL DEFAULT false,
  official_counterpart_path text,
  twin_counterpart_path text,
  classification_status text NOT NULL DEFAULT 'proposed' CHECK (classification_status IN ('proposed','confirmed')),
  confirmed_by uuid, confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_kind, scope_id, field_path)
);
ALTER TABLE public.translation_field_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.translation_field_policies FROM anon, authenticated;
-- Review UI reads/writes go through admin-checked RPCs (mig 02); direct
-- client access is deliberately impossible.

-- ───────────────────────────────────────────────────────────────────────────
-- Policy proposal seeding for resource_kind='record', refreshed from
-- models.schema. Heuristics ONLY produce `proposed` rows; a human confirms
-- in the Review UI before anything processes (REV 3 blocker 5). Explicit
-- `translate_policy` on the field schema wins over every heuristic.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_model_translation_policies(p_model_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_model record;
  v_excluded boolean;
BEGIN
  SELECT id, name, schema INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    -- Model deleted: drop its policies (units GC'd by translation_gc).
    DELETE FROM translation_field_policies WHERE resource_kind = 'record' AND scope_id = p_model_id;
    RETURN;
  END IF;

  -- Signed exclusions (decision sheet 2026-08-02: D-2, D-4, D-5, D-8, D-12)
  -- + bilingual-by-official-columns geo + website singleton handled by W8.
  v_excluded := v_model.name IN (
    'chats','ai_chats','copywriter_chats','matching_chats','image_chats',   -- D-4
    'market_listings',                                                       -- D-2
    'real_estate_offices',                                                   -- D-5
    'prompt_snippets','design_templates','image_presets',                    -- D-8
    'decks','data_migration',                                                -- D-12
    'regions','cities','districts','countries',                              -- geo: official name_ar/name_en
    'marketing_operations','site_settings'                                   -- virtual surface / W8 dynamic-twin adapter
  );

  -- Rebuild this model's rows, PRESERVING confirmations for unchanged paths.
  WITH fields AS (
    SELECT f->>'name' AS slug, f->>'type' AS ftype,
           f->>'translate_policy' AS explicit_policy
    FROM jsonb_array_elements(v_model.schema->'sections') s,
         jsonb_array_elements(s->'fields') f
    WHERE COALESCE(f->>'name','') <> ''
  ),
  proposed AS (
    SELECT
      slug AS field_path, ftype,
      CASE
        WHEN v_excluded OR explicit_policy = 'skip' THEN 'skip'
        WHEN explicit_policy = 'transliterate' THEN 'transliterate'
        WHEN explicit_policy = 'copy' THEN 'copy'
        WHEN explicit_policy = 'auto' THEN
          CASE WHEN ftype = 'text' AND slug ~ '(^|_)(name|title)' THEN 'transliterate' ELSE 'translate' END
        -- Heuristic defaults (audited in Review before confirmation):
        WHEN ftype NOT IN ('text','textarea','notes','table') THEN 'skip'
        WHEN slug ~ '_(ar|en)$' THEN 'skip'                                   -- twin sides get pair rows below
        WHEN slug ~ '(^|_)(id|url|slug|token|hash|key|code|number|source_)' AND slug !~ 'name' THEN 'skip'
        WHEN ftype = 'text' AND slug ~ '(^|_)(name|title|block|model)($|_)' THEN 'transliterate'
        ELSE 'translate'
      END AS treatment,
      CASE
        WHEN v_model.name IN ('clients','contacts','visits','appointments') AND slug ~ 'name' THEN 'pii'
        WHEN slug ~ 'client_name' THEN 'pii'
        WHEN v_model.name IN ('financing','offer_prices','reservations','ownership_transfer') THEN 'financial'
        WHEN v_model.name = 'phone_calls' AND slug IN ('transcription_text','ai_summary') THEN 'restricted'
        WHEN slug ~ '(internal|coaching|commission|objection|rep_note|manager_summary|improvement)' THEN 'internal'
        ELSE 'normal'
      END AS sensitivity
    FROM fields
  )
  INSERT INTO translation_field_policies AS tfp
    (resource_kind, scope_id, field_path, ftype, semantic_class, treatment, sensitivity,
     external_provider_allowed, redaction_required, provider_route, tm_reuse,
     require_approval, public_publishable, classification_status)
  SELECT
    'record', v_model.id, field_path, ftype,
    CASE WHEN treatment = 'transliterate' THEN 'name' ELSE 'prose' END,
    treatment, sensitivity,
    -- D-1 signed 2026-08-02: DeepSeek for everything (incl. pii/financial/
    -- restricted). Sensitivity stays recorded; re-routing later is a row edit.
    true, false,
    CASE WHEN treatment = 'skip' THEN 'none' ELSE 'deepseek' END,
    CASE WHEN sensitivity IN ('pii','financial','restricted') THEN 'service_only'
         WHEN treatment = 'transliterate' THEN 'org'
         ELSE 'org' END,
    false, false, 'proposed'
  FROM proposed
  ON CONFLICT (resource_kind, scope_id, field_path) DO UPDATE SET
    ftype = EXCLUDED.ftype,
    updated_at = now()
    -- Deliberately NOT overwriting treatment/sensitivity/status: once a human
    -- confirmed (or edited) a row, refresh only tracks the field's continued
    -- existence. New fields insert as fresh proposals.
  ;

  -- Drop policies for fields that no longer exist in the schema (their units
  -- are swept by translation_gc, mig 03).
  DELETE FROM translation_field_policies tfp
  WHERE tfp.resource_kind = 'record' AND tfp.scope_id = v_model.id
    AND tfp.field_path !~ '\['   -- element-path rows are managed by the worker
    AND split_part(tfp.field_path, '[', 1) NOT IN (
      SELECT f->>'name'
      FROM jsonb_array_elements(v_model.schema->'sections') s,
           jsonb_array_elements(s->'fields') f
    )
    AND tfp.field_path NOT LIKE 'pair:%';
END $$;

REVOKE ALL ON FUNCTION public.refresh_model_translation_policies(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_model_translation_policies(uuid) TO service_role;

-- Keep policies in sync with Builder schema edits (models_view_sync pattern;
-- errors degrade to WARNING so a policy-refresh failure never blocks a model
-- save — the daily reconcile re-runs it).
CREATE OR REPLACE FUNCTION public.tg_models_refresh_translation_policies()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_model_translation_policies(OLD.id);
    RETURN OLD;
  END IF;
  PERFORM refresh_model_translation_policies(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'translation policy refresh failed for model %: %', COALESCE(NEW.id, OLD.id), SQLERRM;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS models_refresh_translation_policies ON public.models;
CREATE TRIGGER models_refresh_translation_policies
AFTER INSERT OR UPDATE OF name, schema OR DELETE ON public.models
FOR EACH ROW EXECUTE FUNCTION public.tg_models_refresh_translation_policies();

-- One-time seeding for all existing models.
DO $$
DECLARE m record;
BEGIN
  FOR m IN SELECT id FROM public.models LOOP
    PERFORM public.refresh_model_translation_policies(m.id);
  END LOOP;
END $$;

-- Twin-pair logical units (REV 4 §B9): one pair row per schema twin.
-- chat_templates.body + posts_content ×4 (site_settings handled by W8).
INSERT INTO public.translation_field_policies
  (resource_kind, scope_id, field_path, ftype, semantic_class, treatment, sensitivity,
   external_provider_allowed, redaction_required, provider_route, tm_reuse,
   require_approval, public_publishable, twin_counterpart_path, classification_status)
SELECT 'record', m.id, 'pair:' || base, 'twin', 'prose', 'translate', 'normal',
       true, false, 'deepseek', 'org', false, false, base || '_ar|' || base || '_en', 'proposed'
FROM public.models m,
     LATERAL (VALUES ('body'), ('headline'), ('prose'), ('spec')) t(base)
WHERE (m.name = 'chat_templates' AND base = 'body')
   OR (m.name = 'posts_content' AND base IN ('body','headline','prose','spec'))
ON CONFLICT (resource_kind, scope_id, field_path) DO NOTHING;

-- Official-name counterparts (REV 4 §B7): link name fields to the (new,
-- human-filled) official_name_en fields. The Builder fields themselves are
-- added by the app seeding in W1 code (optional fields; harmless if absent —
-- the worker treats a missing counterpart as "no official value").
UPDATE public.translation_field_policies tfp
SET official_counterpart_path = 'official_name_en', updated_at = now()
FROM public.models m
WHERE tfp.resource_kind = 'record' AND tfp.scope_id = m.id
  AND ((m.name = 'all_projects' AND tfp.field_path = 'project_name')
    OR (m.name = 'developers'  AND tfp.field_path = 'name'));
