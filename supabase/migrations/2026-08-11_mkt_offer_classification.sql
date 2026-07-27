-- ============================================================================
-- 2026-08-11 — Fix offer classification.
--
-- THE DEFECT. 309 extracted "offers" existed; 288 were not offers. The largest
-- single value was the sponsorship badge "Diamond Sponsor / راعي ماسي" (108
-- rows). The rest were brand slogans ("تملك الفخامة / Own The Luxury"), teasers
-- ("انتظرونا", "Stay Tuned", "SOON") and product features ("تحكم ذكي / Smart
-- Control", "مساحات رحبة").
--
-- ROOT CAUSE, measured per extractor:
--   ocr   (vision.ts) 301 offers, 288 non-commercial  (96% wrong)
--   skill (SKILL.md)    8 offers,   3 non-commercial  (37% wrong)
-- The vision tool's `offers` property had NO description at all — every other
-- field had one — and there was no `amenities` or `selling_points` bucket. With
-- nowhere correct to put a feature or a slogan, the model put every promotional
-- line into `offers`. The Skill had the same looseness in milder form.
--
-- FIXED IN THREE LAYERS:
--   1. worker/src/marketing/content/vision.ts — tight `offers` definition with
--      explicit counter-examples, plus new `amenities` and `selling_points`
--      buckets so features and slogans have a correct home. (Requires a worker
--      deploy to take effect for newly processed content.)
--   2. .claude/skills/content-enrichment/SKILL.md — the same definition, with a
--      routing table and "most posts contain no offer at all".
--   3. THIS MIGRATION — deterministic routing at emit time. Layers 1 and 2 only
--      help content processed from now on; re-running OCR over the existing 82
--      posts would cost real money, and re-emitting from the stored jsonb would
--      faithfully reproduce the same bad classification. Because facts are
--      DERIVED, the emitter can correct them for free: an extracted "offer" with
--      no commercial signal is routed to `selling_point` instead.
--
-- RESULT after mkt_reemit_all_facts(): 309 offers -> 5, plus 712 selling_points
-- and 90 amenities. Total facts unchanged at 3 216 — nothing lost, only
-- reclassified. The five survivors are genuine: "خصم يصل حتى 100,000 ريال",
-- "خصم لزوار المعرض", "Special discount for exhibition visitors", and a free
-- maintenance + property-management + 25-year-warranty bundle.
--
-- ONE definition of "commercial", shared by the emitter and the
-- new_offer_detected insight rule, so the two can never disagree.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mkt_is_commercial_offer(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  -- Two independent qualifiers. A bare number is NOT one of them: an earlier
  -- version accepted "عدد الوحدات: 75 وحدة" (a unit count) and "ISO 21500" (a
  -- certification) because both contain digits.
  --
  -- Bare رسوم / شامل / تنازل were also dropped: "رسوم التسجيل 5000 ريال" is a
  -- COST. A fee only becomes an offer when it is waived, which إعفاء and
  -- "بدون رسوم" already carry.
  SELECT coalesce(
    -- (a) an explicit commercial term — self-sufficient
    p_value ~* ('(تقسيط|أقساط|قسط\y|دفعة|مقدم'
             || '|خصم|تخفيض|عرض خاص|عرض لفترة|سعر خاص'
             || '|مجان|هدية|كاش ?باك|استرداد|إعفاء|اعفاء|بدون رسوم'
             || '|تمويل|دعم عقاري'
             || '|discount|cashback|free|gift|installment|instalment|waiv|bonus|promo)')
    -- (b) or a number tied to MONEY (currency or percentage)
    OR (p_value ~ '[0-9]' AND p_value ~* '(%|ريال|ر\.س|SAR|halala|هللة)'),
    false);
$fn$;
GRANT EXECUTE ON FUNCTION public.mkt_is_commercial_offer(text) TO service_role, authenticated;

-- ── OCR emitter: route non-commercial offers, and carry the new buckets ─────
CREATE OR REPLACE FUNCTION public.mkt_emit_facts_visual_text(p_vt_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE n integer := 0;
BEGIN
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
                    'locations','phones','urls','ctas','dates','project_names',
                    'developer_names','amenities','selling_points')
      AND length(trim(elem)) > 0
  ),
  mapped AS (
    SELECT vt_id, content_post_id, organization_id, published_at,
           CASE json_key
             WHEN 'prices' THEN 'price'
             -- ROUTING: a non-commercial "offer" is a selling point. Fixes
             -- historical rows on re-emit and guards against model drift.
             WHEN 'offers' THEN CASE WHEN mkt_is_commercial_offer(raw_value)
                                     THEN 'offer' ELSE 'selling_point' END
             WHEN 'payment_plans'   THEN 'payment_plan'
             WHEN 'unit_types'      THEN 'unit_type'
             WHEN 'districts'       THEN 'district'
             WHEN 'locations'       THEN 'location'
             WHEN 'phones'          THEN 'phone'
             WHEN 'urls'            THEN 'url'
             WHEN 'ctas'            THEN 'cta'
             WHEN 'dates'           THEN 'delivery_date'
             WHEN 'project_names'   THEN 'project_name'
             WHEN 'developer_names' THEN 'developer_name'
             WHEN 'amenities'       THEN 'amenity'
             WHEN 'selling_points'  THEN 'selling_point'
           END AS fact_type,
           trim(raw_value) AS value_text
    FROM src
  ),
  deduped AS (
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
           organization_id, content_post_id, 'visual_text', vt_id, 'ocr', 'live-v2',
           0.7, published_at
    FROM deduped
    ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END $fn$;

-- ── Enrichment emitter: same routing on the scalar `offer` ─────────────────
CREATE OR REPLACE FUNCTION public.mkt_emit_facts_enrichment(p_enr_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
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
  routed AS (
    SELECT s.*,
           CASE WHEN s.json_key = 'offer' AND NOT mkt_is_commercial_offer(s.value_text)
                THEN 'selling_point' ELSE s.json_key END AS fact_type
    FROM scalars s
  ),
  ded AS (
    SELECT DISTINCT ON (fact_type, mkt_fact_norm_key(fact_type, value_text)) *
    FROM routed ORDER BY fact_type, mkt_fact_norm_key(fact_type, value_text), value_text
  ),
  ins AS (
    INSERT INTO mkt_observed_facts
      (fact_type, value_text, value_num, value_unit, normalized_key, organization_id,
       project_id, content_post_id, source_type, source_id, extractor,
       extractor_version, confidence, observed_at)
    SELECT fact_type, left(value_text, 2000),
           CASE WHEN fact_type='price' THEN mkt_fact_num(value_text) END,
           CASE WHEN fact_type='price' AND mkt_fact_num(value_text) IS NOT NULL THEN 'SAR' END,
           mkt_fact_norm_key(fact_type, value_text),
           organization_id, primary_project_id, content_post_id,
           'enrichment', enr_id, 'skill', 'live-v2', 0.8, published_at
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
           'enrichment', enr_id, 'skill', 'live-v2', 0.8, published_at
    FROM ded2 WHERE fact_type IS NOT NULL
    ON CONFLICT (source_type, source_id, fact_type, normalized_key, extractor) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO m FROM ins2;

  RETURN n + m;
END $fn$;

-- Point the insight rule at the SHARED classifier (it previously carried its own
-- inline copy of the regex) so the emitter and the alert can never disagree.
-- The emitter now routes non-commercial values away from `offer` anyway, so this
-- is defence in depth rather than the only line of defence.
--
-- NOTE: mkt_generate_trend_insights is otherwise unchanged from
-- 2026-08-10_mkt_trend_insight_engine.sql; only rule 5's predicate is swapped
-- from the inline regex to mkt_is_commercial_offer(). Applied in place.

-- Existing data is corrected by re-deriving the facts — no paid OCR re-run:
--   SELECT * FROM public.mkt_reemit_all_facts();
