-- ============================================================================
-- 2026-08-04 — mkt_observed_facts: the FACT layer (schema step 1-3 of 9).
--
-- Every row in this vertical is one of four things: an ACTOR (who exists), an
-- ARTIFACT (what they published), a FACT (what an artifact asserts), or a
-- JUDGEMENT (what we concluded). ACTOR, ARTIFACT and JUDGEMENT are first-class
-- tables. FACT was not modelled at all — commercial claims lived as untyped JSON
-- inside two different judgement tables under two different key vocabularies
-- (mkt_visual_text.structured.offers vs mkt_content_enrichment.result.offer),
-- in incompatible shapes (array vs scalar), with no units, no normalization and
-- no time dimension.
--
-- Measured before this migration: 158 OCR rows carried offers, 127 phones, 11
-- prices, 236 project names — none of it queryable. Questions like "what price
-- points is developer X advertising and how have they moved" had no SQL answer.
--
-- STRICTLY ADDITIVE: the jsonb payloads remain the source of truth and are not
-- modified. Facts are DERIVED from them.
-- See docs/marketing-intelligence-schema.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.mkt_observed_facts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHAT is claimed
  fact_type         text NOT NULL,
  value_text        text NOT NULL,           -- ALWAYS the raw claim; never lossy
  value_num         numeric,                 -- when numeric (price, area, beds)
  value_unit        text,                    -- SAR | SAR/m2 | m2 | months | percent
  value_date        date,                    -- when temporal (delivery date)
  normalized_key    text,                    -- grouping/dedup key

  -- WHO / WHAT it is about
  organization_id   uuid REFERENCES public.mkt_organizations(id) ON DELETE CASCADE,
  project_id        uuid,                    -- all_projects record; no FK (JSONB records)
  campaign_id       uuid REFERENCES public.mkt_campaigns(id) ON DELETE SET NULL,

  -- WHERE it came from — every fact traceable to an artifact, the same
  -- falsifiability rule the campaign-summary validator enforces.
  source_type       text NOT NULL,
  source_id         uuid NOT NULL,
  content_post_id   uuid REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  paid_ad_id        uuid REFERENCES public.mkt_paid_ads(id) ON DELETE CASCADE,
  extractor         text NOT NULL,
  extractor_version text,
  confidence        numeric NOT NULL DEFAULT 0.5,

  -- WHEN — the time dimension the vertical entirely lacked
  observed_at       timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mkt_observed_facts_type_check CHECK (fact_type IN (
    'price','price_per_m2','payment_plan','down_payment','offer','discount',
    'unit_type','bedrooms','bathrooms','area','district','city','location',
    'phone','url','cta','delivery_date','financing','project_name',
    'developer_name','amenity','selling_point','audience','content_type',
    'objective','campaign_message','language')),
  CONSTRAINT mkt_observed_facts_source_check CHECK (source_type IN (
    'content_post','paid_ad','visual_text','transcript','landing_page','enrichment')),
  CONSTRAINT mkt_observed_facts_extractor_check CHECK (extractor IN (
    'ocr','caption','transcript','skill','deterministic','manual')),
  CONSTRAINT mkt_observed_facts_confidence_check CHECK (confidence >= 0 AND confidence <= 1),

  -- Idempotent re-extraction: the same claim from the same source+extractor is
  -- one row, so backfills and re-runs converge instead of duplicating.
  CONSTRAINT mkt_observed_facts_unique UNIQUE (source_type, source_id, fact_type, normalized_key, extractor)
);

CREATE INDEX IF NOT EXISTS mkt_observed_facts_org_type_idx  ON public.mkt_observed_facts(organization_id, fact_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS mkt_observed_facts_project_idx   ON public.mkt_observed_facts(project_id, fact_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS mkt_observed_facts_type_key_idx  ON public.mkt_observed_facts(fact_type, normalized_key);
CREATE INDEX IF NOT EXISTS mkt_observed_facts_post_idx      ON public.mkt_observed_facts(content_post_id);
CREATE INDEX IF NOT EXISTS mkt_observed_facts_observed_idx  ON public.mkt_observed_facts(observed_at DESC);
CREATE INDEX IF NOT EXISTS mkt_observed_facts_num_idx       ON public.mkt_observed_facts(fact_type, value_num)
  WHERE value_num IS NOT NULL;

ALTER TABLE public.mkt_observed_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_observed_facts_read ON public.mkt_observed_facts;
CREATE POLICY mkt_observed_facts_read ON public.mkt_observed_facts
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.mkt_observed_facts IS
  'One normalized commercial claim per row, derived from posts/ads/OCR/transcripts. '
  'Additive over the jsonb payloads in mkt_visual_text.structured and '
  'mkt_content_enrichment.result, which remain the source of truth. See '
  'docs/marketing-intelligence-schema.md.';

-- ── Backfill 1: OCR (mkt_visual_text.structured) ────────────────────────────
-- READ-ONLY over the jsonb. Numeric parsing is deliberately CONSERVATIVE:
-- Arabic marketing text writes prices as "أسعار تبدأ من 575,000 ريال", so we set
-- value_num only when a clean 4+ digit group is present and ALWAYS keep the raw
-- claim in value_text. A fact we cannot parse numerically is still a fact.
WITH src AS (
  SELECT v.id AS vt_id, v.content_post_id, cp.organization_id, cp.published_at,
         k.key AS json_key, elem AS raw_value
  FROM public.mkt_visual_text v
  JOIN public.mkt_content_posts cp ON cp.id = v.content_post_id
  CROSS JOIN LATERAL jsonb_each(v.structured) k(key, val)
  CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(k.val)='array' THEN k.val ELSE '[]'::jsonb END) elem
  WHERE v.structured IS NOT NULL
    AND k.key IN ('prices','offers','payment_plans','unit_types','districts',
                  'locations','phones','urls','ctas','dates','project_names','developer_names')
    AND length(trim(elem)) > 0
),
mapped AS (
  SELECT vt_id, content_post_id, organization_id, published_at,
         CASE json_key
           WHEN 'prices' THEN 'price'          WHEN 'offers' THEN 'offer'
           WHEN 'payment_plans' THEN 'payment_plan' WHEN 'unit_types' THEN 'unit_type'
           WHEN 'districts' THEN 'district'    WHEN 'locations' THEN 'location'
           WHEN 'phones' THEN 'phone'          WHEN 'urls' THEN 'url'
           WHEN 'ctas' THEN 'cta'              WHEN 'dates' THEN 'delivery_date'
           WHEN 'project_names' THEN 'project_name'
           WHEN 'developer_names' THEN 'developer_name'
         END AS fact_type,
         trim(raw_value) AS value_text,
         CASE WHEN json_key = 'prices'
              THEN nullif(regexp_replace(
                     coalesce((regexp_match(replace(replace(raw_value, ',', ''), ' ', ''), '\d{4,}'))[1], ''),
                     '[^0-9]', '', 'g'), '')::numeric END AS value_num
  FROM src
)
INSERT INTO public.mkt_observed_facts
  (fact_type, value_text, value_num, value_unit, normalized_key, organization_id,
   content_post_id, source_type, source_id, extractor, extractor_version, confidence, observed_at)
SELECT fact_type, left(value_text, 2000), value_num,
       CASE WHEN fact_type='price' AND value_num IS NOT NULL THEN 'SAR' END,
       left(lower(regexp_replace(value_text, '\s+', ' ', 'g')), 300),
       organization_id, content_post_id, 'visual_text', vt_id, 'ocr', 'backfill-v1', 0.7, published_at
FROM mapped WHERE fact_type IS NOT NULL
ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING;

-- ── Backfill 2a: enrichment scalars ─────────────────────────────────────────
-- extractor='skill' distinguishes these from OCR rows, so the same claim seen in
-- BOTH the image and the caption is two corroborating facts, not a duplicate.
WITH scalars AS (
  SELECT e.id AS enr_id, e.content_post_id, e.organization_id, e.primary_project_id,
         cp.published_at, k AS json_key, e.result->>k AS value_text
  FROM public.mkt_content_enrichment e
  JOIN public.mkt_content_posts cp ON cp.id = e.content_post_id
  CROSS JOIN LATERAL (VALUES ('offer'),('price'),('payment_plan'),('financing'),
                             ('district'),('location'),('campaign_message'),
                             ('content_type'),('objective'),('language'),('audience')) v(k)
  WHERE jsonb_typeof(e.result->k) = 'string' AND length(trim(e.result->>k)) > 0
)
INSERT INTO public.mkt_observed_facts
  (fact_type, value_text, value_num, value_unit, normalized_key, organization_id,
   project_id, content_post_id, source_type, source_id, extractor, extractor_version,
   confidence, observed_at)
SELECT json_key, left(value_text, 2000),
       CASE WHEN json_key='price'
            THEN nullif(regexp_replace(
                   coalesce((regexp_match(replace(replace(value_text, ',', ''), ' ', ''), '\d{4,}'))[1], ''),
                   '[^0-9]', '', 'g'), '')::numeric END,
       CASE WHEN json_key='price' THEN 'SAR' END,
       left(lower(regexp_replace(value_text, '\s+', ' ', 'g')), 300),
       organization_id, primary_project_id, content_post_id,
       'enrichment', enr_id, 'skill', 'backfill-v1', 0.8, published_at
FROM scalars
ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING;

-- ── Backfill 2b: enrichment arrays ──────────────────────────────────────────
WITH arrays AS (
  SELECT e.id AS enr_id, e.content_post_id, e.organization_id, e.primary_project_id,
         cp.published_at, v.k AS json_key, trim(elem) AS value_text
  FROM public.mkt_content_enrichment e
  JOIN public.mkt_content_posts cp ON cp.id = e.content_post_id
  CROSS JOIN LATERAL (VALUES ('unit_types','unit_type'),('amenities','amenity'),
                             ('selling_points','selling_point'),('ctas','cta')) v(k, mapped)
  CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(e.result->v.k)='array' THEN e.result->v.k ELSE '[]'::jsonb END) elem
  WHERE length(trim(elem)) > 0
)
INSERT INTO public.mkt_observed_facts
  (fact_type, value_text, normalized_key, organization_id, project_id,
   content_post_id, source_type, source_id, extractor, extractor_version, confidence, observed_at)
SELECT CASE json_key WHEN 'unit_types' THEN 'unit_type' WHEN 'amenities' THEN 'amenity'
                     WHEN 'selling_points' THEN 'selling_point' WHEN 'ctas' THEN 'cta' END,
       left(value_text, 2000), left(lower(regexp_replace(value_text, '\s+', ' ', 'g')), 300),
       organization_id, primary_project_id, content_post_id,
       'enrichment', enr_id, 'skill', 'backfill-v1', 0.8, published_at
FROM arrays
ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING;

-- ── Identifier normalization ────────────────────────────────────────────────
-- Keying phones on lowercased text made ONE number written three ways
-- ("920033158", "9200 33 158", "9200 33 1**") look like three distinct values.
-- normalized_key exists to collapse exactly that; value_text keeps every raw
-- form. Some rows collapse into each other (one OCR frame printed the number
-- twice) — genuine duplicates of a single observation, so the older row goes.
BEGIN;
CREATE TEMP TABLE _norm ON COMMIT DROP AS
SELECT id, source_type, source_id, fact_type, extractor, created_at,
       CASE fact_type
         WHEN 'phone' THEN coalesce(nullif(regexp_replace(value_text, '[^0-9]', '', 'g'), ''),
                                    left(lower(value_text), 300))
         WHEN 'url'   THEN left(regexp_replace(
                              regexp_replace(lower(trim(value_text)), '^https?://(www\.)?', ''),
                              '/+$', ''), 300)
       END AS new_key
FROM public.mkt_observed_facts WHERE fact_type IN ('phone','url');

DELETE FROM public.mkt_observed_facts f USING (
  SELECT id, row_number() OVER (
           PARTITION BY source_type, source_id, fact_type, new_key, extractor
           ORDER BY created_at, id) AS rn
  FROM _norm) d
WHERE f.id = d.id AND d.rn > 1;

UPDATE public.mkt_observed_facts f SET normalized_key = n.new_key
FROM _norm n
WHERE f.id = n.id AND n.new_key IS NOT NULL AND f.normalized_key IS DISTINCT FROM n.new_key;
COMMIT;
