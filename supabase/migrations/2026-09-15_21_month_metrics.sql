-- ============================================================================
-- F2 — `mos_month_metrics`: the month report's numbers, in one read. 2026-09-15.
-- APPLIED TO PRODUCTION 2026-09-15 (migration `month_metrics_f2`). The body below
-- is byte-for-byte what was applied.
--
-- WHY A NEW FUNCTION AND NOT `mos_paid_analytics`. Measured on production
-- 2026-09-15, the existing analytics RPC cannot answer a month question:
--
--   • `mos_execution_daily` has ZERO rows, so its `daily_days = 0` fallback
--     always fires and it returns the LIFETIME `mos_campaign_executions.spend`
--     / `.leads` with `scoped:false` — a number that ignores the window it was
--     asked about.
--   • Every `mos_campaign_executions.starts_on` is NULL, so its
--     current-vs-previous comparison compares a number with itself.
--
-- This function reads `mos_ad_metrics_daily` — 115 rows, 2026-08-25 → 2026-09-15,
-- and read by NO `api/` action before today — which is the only per-day spend we
-- actually hold.
--
-- WHAT IT DOES NOT DO: our WhatsApp leads. Those come from
-- `api/_lib/marketing/ourLeads.ts`, which is the ONE implementation of the
-- `chat_messages.meta.ad.resolved.ad_id` attribution (grouping on
-- `resolved.content_id` drops 74 % of them). Re-deriving that here would be a
-- second implementation of the same recipe, and a divergence would show up as
-- two different lead counts on one screen. The API joins the two.
--
-- THE QUALIFIED SET IS AN ARGUMENT, NEVER A LITERAL (decision D5). The caller
-- passes `p_excluded_stages` — derived in `src/lib/salesProcess/qualifiedStages.ts`
-- as "terminal and not «مغلق ناجح»", so a fourth terminal stage added by the
-- Sales OS is caught by `assertSalesProcessEnums()` instead of quietly inflating
-- the denominator. A NULL or empty array RAISES: counting every stage as
-- qualified is exactly the silent-correctness failure this repo keeps paying for.
--
-- TWO LEAD GRAINS, LABELLED, NEVER MIXED:
--   • a LEAD is a conversation   (ourLeads.ts, in the API)  → cost per lead;
--   • a QUALIFIED lead is a CLIENT RECORD that an ad-attributed conversation
--     created (`client_attributions`) → the count pair «٤٨ مؤهل من ٥١».
-- Both numbers of that pair come from the client grain, so the pair is
-- internally consistent. `ungraded_clients` reports the attributed clients whose
-- record we could not read a stage from — it is never folded into "qualified".
--
-- THE UNATTRIBUTED ROW is the repo's fail-loud guard, scoped to history: after
-- the D2 cutover pause no NEW spend can be unattributed, so `unattributed` (in
-- the window) is an anomaly the page shows in red, while `unattributed_history`
-- (everything before the window) is the pre-cutover record and is expected to be
-- non-zero — measured live at 1,411.15 SAR of `meta-sync` spend on a campaign
-- with no project.
--
-- THE RANKING's three inputs are D6's (available units · days since last
-- featured · last month's cost per qualified lead). The three CONSTANTS in its
-- score are ordering only and are NOT settled by anything — the screen shows the
-- three inputs themselves, never this score. Revisit after one real month,
-- exactly as D6 says.
--
-- SECURITY DEFINER + a `read` capability gate, same posture as
-- `mos_month_exceptions`: it spans `mos_ad_metrics_daily`, `client_attributions`
-- and `records` (client stages), and a marketing role cannot read client rows.
-- Only aggregate counts leave this function — no client id, no name, no phone.
--
-- Never raises SQLSTATE 40001/40P01. Idempotent.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_month_metrics(
  p_from             date,
  p_to               date,
  p_excluded_stages  text[],
  p_month            date    DEFAULT NULL,
  p_project_ids      uuid[]  DEFAULT NULL,
  p_include_ranking  boolean DEFAULT false
)
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
    SELECT ad.project_id, a.client_record_id, max(cl.data ->> 'client_stage') AS stage
      FROM public.client_attributions a
      JOIN ads ad ON ad.ad_row_id = a.ad_id
      LEFT JOIN public.records cl ON cl.id = a.client_record_id
     WHERE a.channel = 'paid_ad' AND a.ad_id IS NOT NULL
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
    lm_att AS (
      SELECT lm.project_id, a.client_record_id, max(cl.data ->> 'client_stage') AS stage
        FROM last_month lm
        JOIN ads ad ON ad.project_id = lm.project_id
        JOIN public.client_attributions a ON a.ad_id = ad.ad_row_id AND a.channel = 'paid_ad'
        LEFT JOIN public.records cl ON cl.id = a.client_record_id
       WHERE NOT EXISTS (SELECT 1 FROM public.client_attributions b WHERE b.supersedes_id = a.id)
         AND (a.occurred_at AT TIME ZONE 'Asia/Riyadh')::date >= lm.m
         AND (a.occurred_at AT TIME ZONE 'Asia/Riyadh')::date < (lm.m + interval '1 month')::date
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

COMMENT ON FUNCTION public.mos_month_metrics(date, date, text[], date, uuid[], boolean) IS
  'The month report''s numbers: per-project spend/impressions/clicks from mos_ad_metrics_daily, attributed + qualified CLIENTS from client_attributions (qualified = stage not in p_excluded_stages, derived by the caller from src/lib/salesProcess/ — NULL/empty raises), published posts and releases, the unattributed guard (in-window anomaly + pre-cutover history), and optionally the project ranking (available units / days since last featured / last month cost per qualified lead). OUR WhatsApp leads are NOT here — api/_lib/marketing/ourLeads.ts is their one implementation.';

-- anon is revoked explicitly: Supabase's default privileges grant it on every
-- new function in `public`, and REVOKE … FROM PUBLIC does not remove that.
REVOKE ALL ON FUNCTION public.mos_month_metrics(date, date, text[], date, uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_month_metrics(date, date, text[], date, uuid[], boolean)
  TO authenticated, service_role;

-- ── the two standing guards, for this function too ────────────────────────
-- Same assertions 2026-09-15_15 carries for the Group-C objects: a definer
-- reader must never be anon-callable, and no function may raise a SQLSTATE
-- PostgREST re-runs forever.
DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'mos_month_metrics'
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'MOS:ANON_CAN_EXECUTE — mos_month_metrics';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'mos_month_metrics'
       AND pg_get_functiondef(p.oid) ~ '''40001''|''40P01''|serialization_failure|deadlock_detected'
  ) THEN
    RAISE EXCEPTION 'MOS:RETRYABLE_SQLSTATE in mos_month_metrics';
  END IF;
END $assert$;

COMMIT;
