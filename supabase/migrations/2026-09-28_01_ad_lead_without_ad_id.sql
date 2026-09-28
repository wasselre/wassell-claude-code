-- 2026-09-28 — An ad lead that arrives WITHOUT an ad ID is still an ad lead.
--
-- WHAT HAPPENED. On 28 Sep an Instagram click-to-WhatsApp lead for ريا النخيل
-- (chat 966500700283) arrived with WhatsApp's "came from an ad" mark
-- (entryPointConversionSource 'ctwa_ad', conversionSource 'FB_Ads') but without
-- the externalAdReply card that carries the ad ID. Three hours earlier the SAME
-- ad had delivered a lead with the same greeting and the card. The webhook only
-- recognised the card, so the mark was thrown away: no client was created, no
-- attribution row, no portal registration, and marketing never counted the
-- lead. Rare (1 in ~160 ad greetings since 16 Aug), but silent.
--
-- WHAT THIS DOES (decision "A", 2026-09-28):
--   * The webhook keeps the mark (`meta.ad` with ad_id null, ad_id_missing true)
--     and ONBOARDS the lead like any ad lead (mos_capture_ad_acquisition).
--   * The campaign is inferred from the greeting the ad's WhatsApp buttons send,
--     «مهتم بمشروع <project>», matched against the campaigns running NOW
--     (mos_infer_ad_from_greeting, below). One live campaign → the ledger row
--     names it with source 'inferred' and NO ad. None, or two → no row; the
--     client is still created and tagged.
--   * It is NEVER credited to a single ad: per-ad counts (ourLeads, the weekly
--     ranking, mos_month_metrics' ranking-by-ad) read ad ids only, and an
--     inferred row has none. It DOES count for its campaign and project
--     (mos_campaign_outcomes already joined through the campaign; the month
--     report's clients-per-project join is widened below).
--   * If WhatsApp later delivers a TAGGED copy of the same message (it can send
--     both, the same second — seen 18 Sep), the tagged row supersedes the
--     inferred one instead of stacking a second touch behind it.
--
-- Nothing here raises SQLSTATE 40001/40P01. No view is replaced.

BEGIN;

-- ── 1. 'inferred' is a ledger source ─────────────────────────────────────────
ALTER TABLE public.client_attributions DROP CONSTRAINT IF EXISTS client_attributions_source_check;
ALTER TABLE public.client_attributions
  ADD CONSTRAINT client_attributions_source_check
  CHECK (source = ANY (ARRAY['lead_form'::text, 'manual'::text, 'import'::text, 'inferred'::text]));

-- ── 2. mos_infer_ad_from_greeting — the campaign a no-ID ad lead came from ──
--
-- The Meta ad lane writes each ad's WhatsApp welcome template with the button
-- «مهتم بمشروع <project_name>» (runMetaAdJob.retargetWelcomeTemplate). A lead
-- that taps it sends exactly that line. Validated 2026-09-28 against every
-- TAGGED greeting on record: 89 of 177 name their ad's project exactly; the
-- other 88 are the older مينا 52 template, whose button says «مينا 52» for the
-- project «مينا 52 - النرجس» — hence the second comparison on the part before
-- " - ".
--
-- Only campaigns that are running NOW are candidates (a live ad, a live
-- execution, a live campaign). Returns the mos_resolve_ad shape with every ad
-- field null plus `inferred: true`, or NULL when the text is not the button's
-- one line, names no live campaign, or names more than one.
CREATE OR REPLACE FUNCTION public.mos_infer_ad_from_greeting(p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_text    text := btrim(COALESCE(p_body, ''));
  v_named   text;
  v_key     text;
  v_matches jsonb;
  v_n       int;
  v_first   jsonb;
BEGIN
  -- One line, exactly the button's shape. Free text that merely mentions a
  -- project is not the greeting and is never attributed.
  IF v_text = '' OR strpos(v_text, chr(10)) > 0 OR strpos(v_text, chr(13)) > 0 THEN
    RETURN NULL;
  END IF;
  v_named := substring(v_text FROM '^مهتم[[:space:]]+بمشروع[[:space:]]+(.+)$');
  v_named := btrim(regexp_replace(COALESCE(v_named, ''), '[.!؟?،,]+$', ''));
  IF v_named = '' THEN RETURN NULL; END IF;
  v_key := public.wassell_search_norm(v_named);

  SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.execution_id), '[]'::jsonb)
    INTO v_matches
  FROM (
    SELECT DISTINCT ON (e.id)
           e.id AS execution_id, e.campaign_id, e.platform, e.platform_campaign_id,
           c.name AS campaign_name,
           COALESCE(c.project_id, NULLIF(c.project_ids->>0, '')::uuid) AS project_id
      FROM public.mos_execution_ads a
      JOIN public.mos_campaign_executions e ON e.id = a.execution_id
      JOIN public.mos_campaigns c           ON c.id = e.campaign_id
      JOIN public.v_all_projects pr
        ON pr.id = COALESCE(c.project_id, NULLIF(c.project_ids->>0, '')::uuid)
     WHERE a.archived_at IS NULL AND a.status = 'running' AND a.platform_ad_id IS NOT NULL
       AND e.archived_at IS NULL AND e.status = 'running'
       AND c.archived_at IS NULL
       AND (public.wassell_search_norm(pr.project_name) = v_key
            OR public.wassell_search_norm(btrim(split_part(pr.project_name, ' - ', 1))) = v_key)
     ORDER BY e.id
  ) m;

  v_n := jsonb_array_length(v_matches);
  IF v_n = 0 THEN RETURN NULL; END IF;
  -- Two live campaigns answer to the same name: we cannot tell which, so we
  -- name neither. The lead is still onboarded, just not attributed.
  IF (SELECT count(DISTINCT x->>'campaign_id') FROM jsonb_array_elements(v_matches) x) > 1 THEN
    RETURN NULL;
  END IF;

  v_first := v_matches->0;
  RETURN jsonb_build_object(
    'ad_id', NULL, 'ad_name', NULL, 'ad_set_id', NULL, 'ad_set_name', NULL, 'content_id', NULL,
    -- Two executions of one campaign: the campaign is known, the execution is not.
    'execution_id',         CASE WHEN v_n = 1 THEN v_first->'execution_id' END,
    'platform_campaign_id', CASE WHEN v_n = 1 THEN v_first->'platform_campaign_id' END,
    'platform',      v_first->'platform',
    'campaign_id',   v_first->'campaign_id',
    'campaign_name', v_first->'campaign_name',
    'project_id',    v_first->'project_id',
    'inferred',      true,
    'inferred_from', 'greeting',
    'matched_name',  v_named,
    'resolved_at',   now());
END $function$;

REVOKE ALL ON FUNCTION public.mos_infer_ad_from_greeting(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_infer_ad_from_greeting(text) TO service_role;

-- ── 3. mos_capture_ad_acquisition — inferred touches ─────────────────────────
-- Re-emitted from the LIVE definition. Changes, and only these:
--   * `inferred: true` in p_resolved → the ledger row's source is 'inferred',
--     its ad is forced NULL, and its note says why.
--   * A tagged capture whose client already holds an INFERRED touch for the same
--     execution (or campaign) within 30 minutes supersedes that touch, keeping
--     its first/last position and the earlier time.
-- Grants are untouched (CREATE OR REPLACE keeps them): service_role only.
CREATE OR REPLACE FUNCTION public.mos_capture_ad_acquisition(p_phone text, p_resolved jsonb, p_occurred_at timestamp with time zone DEFAULT now(), p_suggested_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_clients_model uuid;
  v_client_id     uuid;
  v_ad_id         uuid := NULLIF(p_resolved->>'ad_id','')::uuid;
  v_exec_id       uuid := NULLIF(p_resolved->>'execution_id','')::uuid;
  v_camp_id       uuid := NULLIF(p_resolved->>'campaign_id','')::uuid;
  v_inferred      boolean := COALESCE(p_resolved->>'inferred', '') = 'true';
  v_touch         text;
  v_name          text;
  v_note          text;
  v_sup_id        uuid;
  v_sup_touch     text;
  v_sup_at        timestamptz;
BEGIN
  IF p_phone IS NULL OR public.ksa_phone_canon(p_phone) IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_clients_model FROM public.models WHERE name = 'clients' LIMIT 1;
  IF v_clients_model IS NULL THEN RETURN NULL; END IF;

  -- An inferred touch never credits an ad, whatever the caller passed.
  IF v_inferred THEN v_ad_id := NULL; END IF;

  v_client_id := public.find_client_id_by_phone(p_phone);

  IF v_client_id IS NULL THEN
    v_client_id := gen_random_uuid();
    v_name := COALESCE(NULLIF(btrim(p_suggested_name), ''), regexp_replace(p_phone, '[^0-9+]', '', 'g'));
    INSERT INTO public.records (id, model_id, data, created_by_user_id)
    VALUES (v_client_id, v_clients_model,
      jsonb_build_object(
        'client_name',     v_name,
        'phone_number',    p_phone,
        'client_stage',    'جديد',
        'client_sources',  jsonb_build_array('ترويج'),
        'creation_source', 'ad_inbound'
      ), NULL);
  ELSE
    UPDATE public.records
       SET data = jsonb_set(data, '{client_sources}',
             COALESCE(data->'client_sources','[]'::jsonb) || jsonb_build_array('ترويج'))
     WHERE id = v_client_id
       AND NOT (COALESCE(data->'client_sources','[]'::jsonb) ? 'ترويج');
  END IF;

  IF v_ad_id IS NOT NULL OR v_exec_id IS NOT NULL OR v_camp_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_attributions_effective e
      WHERE e.client_record_id = v_client_id
        AND ( (v_ad_id   IS NOT NULL AND e.ad_id        = v_ad_id)
           OR (v_ad_id   IS NULL AND v_exec_id IS NOT NULL AND e.execution_id = v_exec_id)
           OR (v_ad_id   IS NULL AND v_exec_id IS NULL AND v_camp_id IS NOT NULL AND e.campaign_id = v_camp_id) )
    ) THEN
      -- A tagged copy of a message first seen WITHOUT its ad card corrects that
      -- inferred touch rather than stacking a second one behind it.
      IF v_ad_id IS NOT NULL THEN
        SELECT e.id, e.touch_type, e.occurred_at
          INTO v_sup_id, v_sup_touch, v_sup_at
          FROM public.client_attributions_effective e
         WHERE e.client_record_id = v_client_id
           AND e.source = 'inferred' AND e.ad_id IS NULL
           AND ( (v_exec_id IS NOT NULL AND e.execution_id = v_exec_id)
              OR (e.execution_id IS NULL AND v_camp_id IS NOT NULL AND e.campaign_id = v_camp_id) )
           AND abs(extract(epoch FROM (e.occurred_at - p_occurred_at))) <= 1800
         ORDER BY e.occurred_at
         LIMIT 1;
      END IF;

      IF v_sup_id IS NOT NULL THEN
        v_touch := v_sup_touch;
      ELSE
        SELECT CASE WHEN EXISTS (
                 SELECT 1 FROM public.client_attributions_effective e
                 WHERE e.client_record_id = v_client_id
               ) THEN 'last' ELSE 'first' END
          INTO v_touch;
      END IF;
      v_note := left(concat_ws(' · ',
                  NULLIF(p_resolved->>'campaign_name',''),
                  NULLIF(p_resolved->>'ad_name',''),
                  CASE WHEN v_inferred THEN
                    'مستنتج من رسالة العميل «' || COALESCE(p_resolved->>'matched_name', '') || '» — لم يرسل واتساب رقم الإعلان'
                  END), 500);
      INSERT INTO public.client_attributions
        (client_record_id, campaign_id, execution_id, ad_id, touch_type,
         occurred_at, source, channel, note, supersedes_id, created_by_user_id)
      VALUES
        (v_client_id, v_camp_id, v_exec_id, v_ad_id, v_touch,
         CASE WHEN v_sup_id IS NOT NULL THEN LEAST(v_sup_at, p_occurred_at) ELSE p_occurred_at END,
         CASE WHEN v_inferred THEN 'inferred' ELSE 'lead_form' END,
         'paid_ad', v_note, v_sup_id, NULL);
    END IF;
  END IF;

  RETURN v_client_id;
END; $function$;

-- ── 4. mos_month_metrics — inferred touches count for their project ─────────
-- Re-emitted from the LIVE definition; only the `att` CTE (month report) and
-- `lm_att` (next-month ranking, via the new `att_all`) change. Ad-linked
-- touches resolve exactly as before; a touch with no ad resolves through its
-- execution/campaign. No ledger row has ad_id NULL today (283 of 283 name an
-- ad), so existing numbers do not move. Grants are kept by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.mos_month_metrics(p_from date, p_to date, p_excluded_stages text[], p_month date DEFAULT NULL::date, p_project_ids uuid[] DEFAULT NULL::uuid[], p_include_ranking boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today    date := public.mos_perf_today();
  v_projects jsonb;
  v_unattr   jsonb;
  v_hist     jsonb;
  v_totals   jsonb;
  v_ranking  jsonb := '[]'::jsonb;
BEGIN
  IF NOT (public.mos_caller_is_trusted_service() OR public.wassell_mos_can('read')) THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'MOS:BAD_WINDOW % → %', p_from, p_to USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_excluded_stages IS NULL OR cardinality(p_excluded_stages) = 0 THEN
    RAISE EXCEPTION 'MOS:QUALIFIED_STAGES_MISSING — pass the terminal-lost stages from src/lib/salesProcess/'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH
  ads AS (
    SELECT a.id AS ad_row_id, a.status, a.archived_at, e.campaign_id, c.project_id
      FROM public.mos_execution_ads a
      LEFT JOIN public.mos_campaign_executions e ON e.id = a.execution_id
      LEFT JOIN public.mos_campaigns          c ON c.id = e.campaign_id
  ),
  spend AS (
    SELECT ad.project_id,
           sum(d.spend) AS spend, sum(d.impressions) AS impressions,
           sum(d.clicks) AS clicks, sum(d.leads) AS meta_leads,
           min(d.day) AS first_day, max(d.day) AS last_day,
           count(DISTINCT d.ad_row_id) AS ads_with_spend
      FROM public.mos_ad_metrics_daily d
      JOIN ads ad ON ad.ad_row_id = d.ad_row_id
     WHERE d.day BETWEEN p_from AND p_to
     GROUP BY 1
  ),
  ad_counts AS (
    SELECT project_id, count(*) AS ads_total,
           count(*) FILTER (WHERE status = 'running') AS ads_active,
           count(*) FILTER (WHERE status = 'paused')  AS ads_paused
      FROM ads WHERE archived_at IS NULL GROUP BY 1
  ),
  att AS (
    -- 2026-09-28: a touch with no ad (an ad lead whose ad ID WhatsApp did not
    -- send, source 'inferred') counts for its campaign's project too. Ad-linked
    -- touches still take their project from the ad, exactly as before.
    SELECT COALESCE(ad.project_id, ac.project_id) AS project_id, a.client_record_id,
           max(cl.data ->> 'client_stage') AS stage
      FROM public.client_attributions a
      LEFT JOIN ads ad ON ad.ad_row_id = a.ad_id
      LEFT JOIN public.mos_campaign_executions ae ON a.ad_id IS NULL AND ae.id = a.execution_id
      LEFT JOIN public.mos_campaigns ac ON a.ad_id IS NULL AND ac.id = COALESCE(a.campaign_id, ae.campaign_id)
      LEFT JOIN public.records cl ON cl.id = a.client_record_id
     WHERE a.channel = 'paid_ad'
       AND (ad.ad_row_id IS NOT NULL OR (a.ad_id IS NULL AND ac.id IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM public.client_attributions b WHERE b.supersedes_id = a.id)
       AND (a.occurred_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN p_from AND p_to
     GROUP BY 1, 2
  ),
  qual AS (
    SELECT project_id, count(*) AS clients,
           count(*) FILTER (WHERE stage IS NOT NULL AND NOT (stage = ANY (p_excluded_stages))) AS qualified,
           count(*) FILTER (WHERE stage IS NULL) AS ungraded
      FROM att GROUP BY 1
  ),
  pub AS (
    SELECT ct.project_id, count(*) AS releases_published,
           count(DISTINCT p.content_id) AS posts_published
      FROM public.mos_publications p
      JOIN public.mos_content ct ON ct.id = p.content_id
     WHERE p.status = 'published' AND p.published_at IS NOT NULL
       AND (p.published_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN p_from AND p_to
     GROUP BY 1
  ),
  keys AS (
    SELECT project_id FROM spend WHERE project_id IS NOT NULL
    UNION SELECT project_id FROM qual WHERE project_id IS NOT NULL
    UNION SELECT project_id FROM pub  WHERE project_id IS NOT NULL
    UNION SELECT unnest(COALESCE(p_project_ids, ARRAY[]::uuid[]))
  ),
  rows_out AS (
    SELECT k.project_id,
           COALESCE(pr.project_name, left(k.project_id::text, 8)) AS project_name,
           COALESCE(s.spend, 0)::numeric       AS spend,
           COALESCE(s.impressions, 0)::bigint  AS impressions,
           COALESCE(s.clicks, 0)::bigint       AS clicks,
           COALESCE(s.meta_leads, 0)::bigint   AS meta_leads,
           COALESCE(ac.ads_total, 0)::int      AS ads_total,
           COALESCE(ac.ads_active, 0)::int     AS ads_active,
           COALESCE(ac.ads_paused, 0)::int     AS ads_paused,
           COALESCE(q.clients, 0)::int         AS attributed_clients,
           COALESCE(q.qualified, 0)::int       AS qualified_clients,
           COALESCE(q.ungraded, 0)::int        AS ungraded_clients,
           COALESCE(pb.posts_published, 0)::int    AS posts_published,
           COALESCE(pb.releases_published, 0)::int AS releases_published,
           pr.available_units, pr.unit_count
      FROM keys k
      LEFT JOIN spend     s  ON s.project_id  = k.project_id
      LEFT JOIN ad_counts ac ON ac.project_id = k.project_id
      LEFT JOIN qual      q  ON q.project_id  = k.project_id
      LEFT JOIN pub       pb ON pb.project_id = k.project_id
      LEFT JOIN public.v_all_projects pr ON pr.id = k.project_id
     WHERE k.project_id IS NOT NULL
       AND (p_project_ids IS NULL OR k.project_id = ANY (p_project_ids)
            OR COALESCE(s.spend, 0) > 0 OR COALESCE(q.clients, 0) > 0)
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.spend DESC, r.project_name), '[]'::jsonb),
    jsonb_build_object(
      'spend', COALESCE(sum(r.spend), 0), 'impressions', COALESCE(sum(r.impressions), 0),
      'clicks', COALESCE(sum(r.clicks), 0), 'meta_leads', COALESCE(sum(r.meta_leads), 0),
      'attributed_clients', COALESCE(sum(r.attributed_clients), 0),
      'qualified_clients', COALESCE(sum(r.qualified_clients), 0),
      'ungraded_clients', COALESCE(sum(r.ungraded_clients), 0),
      'posts_published', COALESCE(sum(r.posts_published), 0),
      'releases_published', COALESCE(sum(r.releases_published), 0),
      'ads_active', COALESCE(sum(r.ads_active), 0), 'ads_paused', COALESCE(sum(r.ads_paused), 0),
      'projects', count(*))
    INTO v_projects, v_totals
    FROM rows_out r;

  WITH ads AS (
    SELECT a.id AS ad_row_id, c.project_id
      FROM public.mos_execution_ads a
      LEFT JOIN public.mos_campaign_executions e ON e.id = a.execution_id
      LEFT JOIN public.mos_campaigns          c ON c.id = e.campaign_id
  )
  SELECT
    jsonb_build_object(
      'spend',       COALESCE(sum(d.spend)       FILTER (WHERE d.day BETWEEN p_from AND p_to), 0),
      'impressions', COALESCE(sum(d.impressions) FILTER (WHERE d.day BETWEEN p_from AND p_to), 0),
      'leads',       COALESCE(sum(d.leads)       FILTER (WHERE d.day BETWEEN p_from AND p_to), 0),
      'ads',         count(DISTINCT d.ad_row_id) FILTER (WHERE d.day BETWEEN p_from AND p_to)),
    jsonb_build_object(
      'spend',       COALESCE(sum(d.spend)       FILTER (WHERE d.day < p_from), 0),
      'impressions', COALESCE(sum(d.impressions) FILTER (WHERE d.day < p_from), 0),
      'first_day',   min(d.day) FILTER (WHERE d.day < p_from),
      'last_day',    max(d.day) FILTER (WHERE d.day < p_from))
    INTO v_unattr, v_hist
    FROM public.mos_ad_metrics_daily d
    JOIN ads ad ON ad.ad_row_id = d.ad_row_id
   WHERE ad.project_id IS NULL;

  IF p_include_ranking THEN
    WITH ads AS (
      SELECT a.id AS ad_row_id, c.project_id
        FROM public.mos_execution_ads a
        LEFT JOIN public.mos_campaign_executions e ON e.id = a.execution_id
        LEFT JOIN public.mos_campaigns          c ON c.id = e.campaign_id
       WHERE c.project_id IS NOT NULL
    ),
    last_spend AS (
      SELECT ad.project_id, max(d.day) AS day
        FROM public.mos_ad_metrics_daily d JOIN ads ad ON ad.ad_row_id = d.ad_row_id
       GROUP BY 1
    ),
    last_content AS (
      SELECT project_id, max((created_at AT TIME ZONE 'Asia/Riyadh')::date) AS day
        FROM public.mos_content WHERE project_id IS NOT NULL AND archived_at IS NULL GROUP BY 1
    ),
    last_month AS (SELECT project_id, date_trunc('month', day)::date AS m FROM last_spend),
    lm_spend AS (
      SELECT lm.project_id, lm.m, sum(d.spend) AS spend
        FROM last_month lm
        JOIN ads ad ON ad.project_id = lm.project_id
        JOIN public.mos_ad_metrics_daily d ON d.ad_row_id = ad.ad_row_id
       WHERE d.day >= lm.m AND d.day < (lm.m + interval '1 month')::date
       GROUP BY 1, 2
    ),
    att_all AS (
      -- Effective paid-ad touches with the project they count for: through the
      -- ad when there is one, else through the execution/campaign (2026-09-28,
      -- the 'inferred' touches that name no ad).
      SELECT COALESCE(ad.project_id, ac.project_id) AS project_id, a.client_record_id, a.occurred_at
        FROM public.client_attributions a
        LEFT JOIN ads ad ON ad.ad_row_id = a.ad_id
        LEFT JOIN public.mos_campaign_executions ae ON a.ad_id IS NULL AND ae.id = a.execution_id
        LEFT JOIN public.mos_campaigns ac ON a.ad_id IS NULL AND ac.id = COALESCE(a.campaign_id, ae.campaign_id)
       WHERE a.channel = 'paid_ad'
         AND NOT EXISTS (SELECT 1 FROM public.client_attributions b WHERE b.supersedes_id = a.id)
    ),
    lm_att AS (
      SELECT lm.project_id, x.client_record_id, max(cl.data ->> 'client_stage') AS stage
        FROM last_month lm
        JOIN att_all x ON x.project_id = lm.project_id
        LEFT JOIN public.records cl ON cl.id = x.client_record_id
       WHERE (x.occurred_at AT TIME ZONE 'Asia/Riyadh')::date >= lm.m
         AND (x.occurred_at AT TIME ZONE 'Asia/Riyadh')::date < (lm.m + interval '1 month')::date
       GROUP BY 1, 2
    ),
    lm_qual AS (
      SELECT project_id, count(*) AS clients,
             count(*) FILTER (WHERE stage IS NOT NULL AND NOT (stage = ANY (p_excluded_stages))) AS qualified
        FROM lm_att GROUP BY 1
    ),
    cand AS (
      SELECT pr.id AS project_id, pr.project_name,
             COALESCE(pr.available_units, 0)::numeric AS available_units,
             COALESCE(pr.unit_count, 0)::numeric      AS unit_count,
             pr.available_price_range_min             AS price_from,
             GREATEST(ls.day, lc.day)                 AS last_featured_on,
             CASE WHEN ls.day IS NOT NULL AND (lc.day IS NULL OR ls.day >= lc.day) THEN 'spend'
                  WHEN lc.day IS NOT NULL THEN 'content' ELSE NULL END AS last_featured_source,
             lms.m AS last_run_month, lms.spend AS last_run_spend,
             lmq.qualified AS last_run_qualified, lmq.clients AS last_run_clients
        FROM public.v_all_projects pr
        LEFT JOIN last_spend   ls  ON ls.project_id  = pr.id
        LEFT JOIN last_content lc  ON lc.project_id  = pr.id
        LEFT JOIN lm_spend     lms ON lms.project_id = pr.id
        LEFT JOIN lm_qual      lmq ON lmq.project_id = pr.id
       WHERE pr.is_public IS TRUE
    ),
    scored AS (
      SELECT c.*,
             CASE WHEN c.last_featured_on IS NULL THEN NULL ELSE (v_today - c.last_featured_on) END AS days_since_featured,
             CASE WHEN COALESCE(c.last_run_qualified, 0) > 0
                  THEN round(c.last_run_spend / c.last_run_qualified, 2) END AS cost_per_qualified_lead
        FROM cand c
    ),
    ranked AS (
      SELECT s.*,
             round(
               LEAST(s.available_units / 100.0, 1.0)
               + CASE WHEN s.last_featured_on IS NULL THEN 1.0
                      ELSE LEAST(COALESCE(s.days_since_featured, 0) / 180.0, 1.0) END
               + CASE WHEN s.cost_per_qualified_lead IS NULL THEN 0.5
                      ELSE GREATEST(0.0, 1.0 - s.cost_per_qualified_lead / 100.0) END
             , 3) AS score
        FROM scored s WHERE s.available_units > 0
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.score DESC, r.available_units DESC), '[]'::jsonb)
      INTO v_ranking FROM ranked r;
  END IF;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'month', p_month, 'today', v_today),
    'excluded_stages', to_jsonb(p_excluded_stages),
    'projects', COALESCE(v_projects, '[]'::jsonb),
    'totals', COALESCE(v_totals, '{}'::jsonb),
    'unattributed', COALESCE(v_unattr, '{}'::jsonb),
    'unattributed_history', COALESCE(v_hist, '{}'::jsonb),
    'ranking', v_ranking);
END
$function$;

-- ── 5. Assertions — loud, in the same transaction ───────────────────────────
DO $assert$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.client_attributions'::regclass
     AND conname = 'client_attributions_source_check';
  IF v_def IS NULL OR position('inferred' IN v_def) = 0 THEN
    RAISE EXCEPTION 'AD_LEAD_NO_ID: source check does not allow inferred — %', v_def;
  END IF;

  IF to_regprocedure('public.mos_infer_ad_from_greeting(text)') IS NULL THEN
    RAISE EXCEPTION 'AD_LEAD_NO_ID: mos_infer_ad_from_greeting was not created';
  END IF;
  IF has_function_privilege('anon', 'public.mos_infer_ad_from_greeting(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mos_infer_ad_from_greeting(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'AD_LEAD_NO_ID: mos_infer_ad_from_greeting is callable from the browser';
  END IF;
  IF has_function_privilege('anon', 'public.mos_capture_ad_acquisition(text, jsonb, timestamptz, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mos_capture_ad_acquisition(text, jsonb, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'AD_LEAD_NO_ID: mos_capture_ad_acquisition became callable from the browser';
  END IF;
  IF to_regprocedure('public.mos_month_metrics(date, date, text[], date, uuid[], boolean)') IS NULL THEN
    RAISE EXCEPTION 'AD_LEAD_NO_ID: mos_month_metrics signature changed';
  END IF;

  -- Text that is not the button's one line is never attributed. These return
  -- before any table is read, so they hold on an empty database too.
  IF public.mos_infer_ad_from_greeting(NULL) IS NOT NULL
     OR public.mos_infer_ad_from_greeting('') IS NOT NULL
     OR public.mos_infer_ad_from_greeting('السلام عليكم') IS NOT NULL
     OR public.mos_infer_ad_from_greeting('مهتم بمشروع') IS NOT NULL
     OR public.mos_infer_ad_from_greeting('مهتم بمشروع ريا النخيل' || chr(10) || 'كم السعر؟') IS NOT NULL THEN
    RAISE EXCEPTION 'AD_LEAD_NO_ID: mos_infer_ad_from_greeting attributed text that is not a greeting';
  END IF;
END $assert$;

COMMIT;
