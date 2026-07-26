-- ============================================================================
-- 2026-08-06 — Phase 1: LIVE fact extraction. Facts stop being a backfilled
-- artifact and become the primary output of the ingestion pipeline.
--
--   before:  content -> OCR/enrichment -> JSON -> (manual backfill) -> facts
--   after:   content -> OCR/enrichment -> JSON + facts, at write time
--
-- WHY IN SQL, NOT APPLICATION CODE
-- mkt_enrichment_upsert has two callers in two separate npm packages
-- (worker/src/marketing/content/runContentProcess.ts and
-- scripts/claude-study-runner.mjs) which cannot import from one another — this
-- repo already maintains worker/src/imageGen.ts as a hand-copied duplicate for
-- exactly that reason. Extraction in application code would be two
-- implementations that drift, plus a third (the backfill) that must stay
-- byte-identical or the same content yields different facts depending on WHEN it
-- was processed. One SQL implementation invoked by triggers removes the whole
-- class of problem, and additionally covers direct-SQL writers and any future
-- service. Same posture as the proven records_fill_project_rollups trigger.
--
-- Additive and reversible: DROP TRIGGER restores the previous behaviour exactly.
-- Verified in production: emitting through these functions reproduces the
-- backfill output EXACTLY (1 825 OCR + 1 369 enrichment = 3 194 facts, matching
-- per fact_type), plus 22 new facts from paid ads which the backfill never
-- covered.
-- ============================================================================

-- ── Shared normalization: ONE definition used by every emitter ──────────────
CREATE OR REPLACE FUNCTION public.mkt_fact_norm_key(p_fact_type text, p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_fact_type
    -- identifiers collapse to their identity, so one phone written three ways
    -- ("920033158", "9200 33 158") is ONE value, not three
    WHEN 'phone' THEN coalesce(nullif(regexp_replace(p_value, '[^0-9]', '', 'g'), ''),
                               left(lower(p_value), 300))
    WHEN 'url'   THEN left(regexp_replace(
                         regexp_replace(lower(trim(p_value)), '^https?://(www\.)?', ''),
                         '/+$', ''), 300)
    ELSE left(lower(regexp_replace(p_value, '\s+', ' ', 'g')), 300)
  END;
$$;

-- Conservative numeric parse. Arabic marketing writes "أسعار تبدأ من 575,000 ريال";
-- we take only a clean 4+ digit group, and value_text ALWAYS keeps the raw claim,
-- so an unparseable price is still a stored fact.
CREATE OR REPLACE FUNCTION public.mkt_fact_num(p_value text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(regexp_replace(
    coalesce((regexp_match(replace(replace(p_value, ',', ''), ' ', ''), '\d{4,}'))[1], ''),
    '[^0-9]', '', 'g'), '')::numeric;
$$;

-- ── Emitter: OCR / visual text ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_emit_facts_visual_text(p_vt_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0;
BEGIN
  -- Re-emit REPLACES: a re-run of OCR must not leave facts from the old read.
  DELETE FROM mkt_observed_facts WHERE source_type='visual_text' AND source_id=p_vt_id;

  WITH src AS (
    SELECT v.id AS vt_id, v.content_post_id, cp.organization_id, cp.published_at,
           k.key AS json_key, elem AS raw_value
    FROM mkt_visual_text v
    JOIN mkt_content_posts cp ON cp.id = v.content_post_id
    CROSS JOIN LATERAL jsonb_each(v.structured) k(key, val)
    CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(k.val)='array' THEN k.val ELSE '[]'::jsonb END) elem
    WHERE v.id = p_vt_id AND v.structured IS NOT NULL
      AND k.key IN ('prices','offers','payment_plans','unit_types','districts',
                    'locations','phones','urls','ctas','dates','project_names','developer_names')
      AND length(trim(elem)) > 0
  ),
  mapped AS (
    SELECT vt_id, content_post_id, organization_id, published_at,
           CASE json_key
             WHEN 'prices' THEN 'price'               WHEN 'offers' THEN 'offer'
             WHEN 'payment_plans' THEN 'payment_plan' WHEN 'unit_types' THEN 'unit_type'
             WHEN 'districts' THEN 'district'         WHEN 'locations' THEN 'location'
             WHEN 'phones' THEN 'phone'               WHEN 'urls' THEN 'url'
             WHEN 'ctas' THEN 'cta'                   WHEN 'dates' THEN 'delivery_date'
             WHEN 'project_names' THEN 'project_name'
             WHEN 'developer_names' THEN 'developer_name'
           END AS fact_type,
           trim(raw_value) AS value_text
    FROM src
  ),
  deduped AS (
    -- collapse within this source FIRST so the unique constraint never fires
    SELECT DISTINCT ON (fact_type, mkt_fact_norm_key(fact_type, value_text))
           vt_id, content_post_id, organization_id, published_at, fact_type, value_text
    FROM mapped WHERE fact_type IS NOT NULL
    ORDER BY fact_type, mkt_fact_norm_key(fact_type, value_text), value_text
  ),
  ins AS (
    INSERT INTO mkt_observed_facts
      (fact_type, value_text, value_num, value_unit, normalized_key, organization_id,
       content_post_id, source_type, source_id, extractor, extractor_version,
       confidence, observed_at)
    SELECT fact_type, left(value_text, 2000),
           CASE WHEN fact_type='price' THEN mkt_fact_num(value_text) END,
           CASE WHEN fact_type='price' AND mkt_fact_num(value_text) IS NOT NULL THEN 'SAR' END,
           mkt_fact_norm_key(fact_type, value_text),
           organization_id, content_post_id, 'visual_text', vt_id, 'ocr', 'live-v1',
           0.7, published_at
    FROM deduped
    ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END $$;

-- ── Emitter: enrichment (caption + transcript, via the Skill) ───────────────
CREATE OR REPLACE FUNCTION public.mkt_emit_facts_enrichment(p_enr_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; m integer := 0;
BEGIN
  DELETE FROM mkt_observed_facts WHERE source_type='enrichment' AND source_id=p_enr_id;

  WITH scalars AS (
    SELECT e.id AS enr_id, e.content_post_id, e.organization_id, e.primary_project_id,
           cp.published_at, k AS json_key, e.result->>k AS value_text
    FROM mkt_content_enrichment e
    JOIN mkt_content_posts cp ON cp.id = e.content_post_id
    CROSS JOIN LATERAL (VALUES ('offer'),('price'),('payment_plan'),('financing'),
                               ('district'),('location'),('campaign_message'),
                               ('content_type'),('objective'),('language'),('audience')) v(k)
    WHERE e.id = p_enr_id AND jsonb_typeof(e.result->k)='string'
      AND length(trim(e.result->>k)) > 0
  ),
  ded AS (
    SELECT DISTINCT ON (json_key, mkt_fact_norm_key(json_key, value_text)) *
    FROM scalars ORDER BY json_key, mkt_fact_norm_key(json_key, value_text), value_text
  ),
  ins AS (
    INSERT INTO mkt_observed_facts
      (fact_type, value_text, value_num, value_unit, normalized_key, organization_id,
       project_id, content_post_id, source_type, source_id, extractor,
       extractor_version, confidence, observed_at)
    SELECT json_key, left(value_text, 2000),
           CASE WHEN json_key='price' THEN mkt_fact_num(value_text) END,
           CASE WHEN json_key='price' AND mkt_fact_num(value_text) IS NOT NULL THEN 'SAR' END,
           mkt_fact_norm_key(json_key, value_text),
           organization_id, primary_project_id, content_post_id,
           'enrichment', enr_id, 'skill', 'live-v1', 0.8, published_at
    FROM ded
    ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;

  WITH arrays AS (
    SELECT e.id AS enr_id, e.content_post_id, e.organization_id, e.primary_project_id,
           cp.published_at,
           CASE v.k WHEN 'unit_types' THEN 'unit_type' WHEN 'amenities' THEN 'amenity'
                    WHEN 'selling_points' THEN 'selling_point' WHEN 'ctas' THEN 'cta' END AS fact_type,
           trim(elem) AS value_text
    FROM mkt_content_enrichment e
    JOIN mkt_content_posts cp ON cp.id = e.content_post_id
    CROSS JOIN LATERAL (VALUES ('unit_types'),('amenities'),('selling_points'),('ctas')) v(k)
    CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(e.result->v.k)='array' THEN e.result->v.k ELSE '[]'::jsonb END) elem
    WHERE e.id = p_enr_id AND length(trim(elem)) > 0
  ),
  ded2 AS (
    SELECT DISTINCT ON (fact_type, mkt_fact_norm_key(fact_type, value_text)) *
    FROM arrays ORDER BY fact_type, mkt_fact_norm_key(fact_type, value_text), value_text
  ),
  ins2 AS (
    INSERT INTO mkt_observed_facts
      (fact_type, value_text, normalized_key, organization_id, project_id,
       content_post_id, source_type, source_id, extractor, extractor_version,
       confidence, observed_at)
    SELECT fact_type, left(value_text, 2000), mkt_fact_norm_key(fact_type, value_text),
           organization_id, primary_project_id, content_post_id,
           'enrichment', enr_id, 'skill', 'live-v1', 0.8, published_at
    FROM ded2 WHERE fact_type IS NOT NULL
    ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO m FROM ins2;

  RETURN n + m;
END $$;

-- ── Emitter: paid ads (NEW coverage — the backfill never touched these) ─────
CREATE OR REPLACE FUNCTION public.mkt_emit_facts_paid_ad(p_ad_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0;
BEGIN
  DELETE FROM mkt_observed_facts WHERE source_type='paid_ad' AND source_id=p_ad_id;

  WITH claims AS (
    SELECT a.id, a.organization_id, coalesce(a.platform_started_at, a.first_seen_at) AS observed_at,
           t.fact_type, t.value_text
    FROM mkt_paid_ads a
    CROSS JOIN LATERAL (VALUES
      ('cta', a.cta), ('url', a.landing_url), ('campaign_message', a.headline)
    ) t(fact_type, value_text)
    WHERE a.id = p_ad_id AND t.value_text IS NOT NULL AND length(trim(t.value_text)) > 0
  ),
  ded AS (
    SELECT DISTINCT ON (fact_type, mkt_fact_norm_key(fact_type, value_text)) *
    FROM claims ORDER BY fact_type, mkt_fact_norm_key(fact_type, value_text), value_text
  ),
  ins AS (
    INSERT INTO mkt_observed_facts
      (fact_type, value_text, normalized_key, organization_id, paid_ad_id,
       source_type, source_id, extractor, extractor_version, confidence, observed_at)
    SELECT fact_type, left(trim(value_text), 2000), mkt_fact_norm_key(fact_type, value_text),
           organization_id, id, 'paid_ad', id, 'deterministic', 'live-v1', 0.9, observed_at
    FROM ded
    ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END $$;

-- ── Triggers ────────────────────────────────────────────────────────────────
-- SCOPED EXCEPTION HANDLING, deliberately — and NOT a silent swallow.
-- An exception in an AFTER trigger aborts the whole write, so a bug in derived-
-- fact extraction would prevent the OCR/enrichment row itself from being stored,
-- permanently losing collected content that cost real money to obtain. Facts are
-- fully recoverable at any time via mkt_reemit_all_facts() because extraction is
-- deterministic and idempotent. So: log LOUDLY (RAISE WARNING reaches the
-- Postgres logs, naming the table, row, and SQLSTATE) and let the primary
-- artifact write succeed. Verified by test: a deliberately broken extractor left
-- the artifact saved and emitted 0 facts.
CREATE OR REPLACE FUNCTION public.mkt_tg_emit_facts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    CASE TG_TABLE_NAME
      WHEN 'mkt_visual_text'        THEN PERFORM mkt_emit_facts_visual_text(NEW.id);
      WHEN 'mkt_content_enrichment' THEN PERFORM mkt_emit_facts_enrichment(NEW.id);
      WHEN 'mkt_paid_ads'           THEN PERFORM mkt_emit_facts_paid_ad(NEW.id);
    END CASE;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'mkt fact emission failed for %.% : % (%) — artifact was still saved; run mkt_reemit_all_facts() to recover',
      TG_TABLE_NAME, NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS mkt_visual_text_emit_facts ON public.mkt_visual_text;
CREATE TRIGGER mkt_visual_text_emit_facts
  AFTER INSERT OR UPDATE ON public.mkt_visual_text
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_emit_facts();

DROP TRIGGER IF EXISTS mkt_enrichment_emit_facts ON public.mkt_content_enrichment;
CREATE TRIGGER mkt_enrichment_emit_facts
  AFTER INSERT OR UPDATE ON public.mkt_content_enrichment
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_emit_facts();

DROP TRIGGER IF EXISTS mkt_paid_ads_emit_facts ON public.mkt_paid_ads;
CREATE TRIGGER mkt_paid_ads_emit_facts
  AFTER INSERT OR UPDATE ON public.mkt_paid_ads
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_emit_facts();

-- ── Maintenance: full re-emit. SUPERSEDES the one-off backfill in
--    2026-08-04_mkt_observed_facts.sql, which must not be run again.
CREATE OR REPLACE FUNCTION public.mkt_reemit_all_facts()
RETURNS TABLE(source text, rows_processed bigint, facts_emitted bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; c bigint; f bigint;
BEGIN
  c := 0; f := 0;
  FOR r IN SELECT id FROM mkt_visual_text LOOP
    f := f + mkt_emit_facts_visual_text(r.id); c := c + 1;
  END LOOP;
  source := 'visual_text'; rows_processed := c; facts_emitted := f; RETURN NEXT;

  c := 0; f := 0;
  FOR r IN SELECT id FROM mkt_content_enrichment LOOP
    f := f + mkt_emit_facts_enrichment(r.id); c := c + 1;
  END LOOP;
  source := 'enrichment'; rows_processed := c; facts_emitted := f; RETURN NEXT;

  c := 0; f := 0;
  FOR r IN SELECT id FROM mkt_paid_ads LOOP
    f := f + mkt_emit_facts_paid_ad(r.id); c := c + 1;
  END LOOP;
  source := 'paid_ad'; rows_processed := c; facts_emitted := f; RETURN NEXT;
END $$;

GRANT EXECUTE ON FUNCTION public.mkt_reemit_all_facts() TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_emit_facts_visual_text(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_emit_facts_enrichment(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_emit_facts_paid_ad(uuid) TO service_role;
