-- ============================================================================
-- Vendor cost reconciliation  (2026-09-15)
--
-- `ai_usage` records what we BELIEVE each call cost: exact provider-reported
-- token counts multiplied by a rate somebody typed into `ai_price_book`. That
-- answers "which feature spent it". It cannot answer "what do we actually owe"
-- — it knows nothing about discounts, committed-spend pricing, batch rates, a
-- rate that changed, credits, or minimum charges.
--
-- This table holds the other number: what the VENDOR says. For Anthropic that
-- comes from the Usage & Cost Admin API
-- (GET /v1/organizations/cost_report), pulled by
-- scripts/sync-anthropic-cost.mjs. Other providers can be entered by hand from
-- their dashboards — the table does not care where a row came from, only that
-- `source` says.
--
-- The two are deliberately NOT merged. A reconciliation is only useful while
-- the estimate and the invoice remain separately visible; averaging them would
-- destroy the only signal it carries, which is the DIFFERENCE.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_vendor_cost (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  day           date NOT NULL,

  -- Dimensions, as the vendor reports them. All nullable: they are only
  -- populated when the fetch grouped by that dimension.
  model         text,
  cost_type     text,          -- anthropic: tokens | web_search | code_execution | session_usage
  token_type    text,          -- anthropic: uncached_input_tokens | output_tokens | cache_read_input_tokens | ...
  service_tier  text,          -- anthropic: standard | batch
  workspace_id  text,

  -- ALWAYS dollars here. Anthropic's API reports `amount` in the currency's
  -- LOWEST UNIT as a decimal string — "123.45" means $1.2345, not $123.45.
  -- The fetcher divides by 100 exactly once; this column is the result, and
  -- `raw` keeps the untouched item so the conversion stays auditable.
  amount_usd    numeric(14,6) NOT NULL,
  currency      text NOT NULL DEFAULT 'USD',

  source        text NOT NULL,          -- e.g. 'anthropic cost_report'
  raw           jsonb,                  -- the vendor's result item, verbatim
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_vendor_cost IS
  'What the VENDOR says a day cost, for reconciliation against ai_usage (what we estimated). amount_usd is always dollars — Anthropic reports cents, and the fetcher converts.';

CREATE INDEX IF NOT EXISTS ai_vendor_cost_day_idx      ON public.ai_vendor_cost (provider, day DESC);
CREATE INDEX IF NOT EXISTS ai_vendor_cost_model_idx    ON public.ai_vendor_cost (provider, model, day DESC);

ALTER TABLE public.ai_vendor_cost ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_vendor_cost_admin_read ON public.ai_vendor_cost;
CREATE POLICY ai_vendor_cost_admin_read ON public.ai_vendor_cost
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

REVOKE ALL ON public.ai_vendor_cost FROM anon;

/**
 * Replace one provider-day wholesale.
 *
 * Idempotent by construction: re-syncing a day deletes that day's rows and
 * writes the fresh set, so a re-run can never double the total. That matters
 * because Anthropic's data keeps settling for a while after the calls happen —
 * the correct habit is to re-pull the last several days every time, and a
 * merge-on-conflict scheme across six nullable dimensions would be far easier
 * to get wrong than a delete-and-insert.
 */
CREATE OR REPLACE FUNCTION public.ai_vendor_cost_replace_day(
  p_provider text,
  p_day      date,
  p_source   text,
  p_rows     jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  n integer;
BEGIN
  IF NOT (auth.uid() IS NULL OR public.wassell_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'ai_vendor_cost_replace_day: admin only' USING ERRCODE = 'WS403';
  END IF;

  DELETE FROM public.ai_vendor_cost WHERE provider = p_provider AND day = p_day;

  INSERT INTO public.ai_vendor_cost
    (provider, day, model, cost_type, token_type, service_tier, workspace_id,
     amount_usd, currency, source, raw)
  SELECT
    p_provider, p_day,
    NULLIF(e->>'model', ''),
    NULLIF(e->>'cost_type', ''),
    NULLIF(e->>'token_type', ''),
    NULLIF(e->>'service_tier', ''),
    NULLIF(e->>'workspace_id', ''),
    (e->>'amount_usd')::numeric,
    COALESCE(NULLIF(e->>'currency', ''), 'USD'),
    p_source,
    e->'raw'
  FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) e;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

/**
 * The comparison, per provider per day.
 *
 * `ours` counts only rows we could price — an unpriced call contributes 0, so
 * a day with unpriced calls understates our side and the delta will look like
 * vendor overcharge. `ours_unpriced_calls` is carried so that reading is
 * available rather than inferred.
 *
 * `coverage` names the honest state of each day rather than leaving a blank to
 * be misread:
 *   both        — a real comparison
 *   ours_only   — vendor data not pulled for that day yet
 *   vendor_only — spend that predates our ledger, or a provider we do not meter
 */
CREATE OR REPLACE VIEW public.v_ai_cost_reconciliation
WITH (security_invoker = true) AS
WITH ours AS (
  SELECT provider,
         created_at::date                                   AS day,
         round(sum(cost_usd) FILTER (WHERE cost_known), 6)   AS ours_usd,
         count(*)                                           AS ours_calls,
         count(*) FILTER (WHERE NOT cost_known)             AS ours_unpriced_calls
  FROM public.ai_usage
  GROUP BY 1, 2
),
vendor AS (
  SELECT provider, day,
         round(sum(amount_usd), 6) AS vendor_usd,
         max(fetched_at)           AS vendor_fetched_at
  FROM public.ai_vendor_cost
  GROUP BY 1, 2
)
SELECT
  COALESCE(o.provider, v.provider)                  AS provider,
  COALESCE(o.day, v.day)                            AS day,
  o.ours_usd,
  o.ours_calls,
  o.ours_unpriced_calls,
  v.vendor_usd,
  v.vendor_fetched_at,
  round(COALESCE(v.vendor_usd, 0) - COALESCE(o.ours_usd, 0), 6) AS delta_usd,
  CASE
    WHEN o.ours_usd IS NULL OR v.vendor_usd IS NULL THEN NULL
    WHEN o.ours_usd = 0 THEN NULL
    ELSE round(100 * (v.vendor_usd - o.ours_usd) / o.ours_usd, 1)
  END                                               AS delta_pct,
  CASE
    WHEN o.provider IS NOT NULL AND v.provider IS NOT NULL THEN 'both'
    WHEN o.provider IS NOT NULL THEN 'ours_only'
    ELSE 'vendor_only'
  END                                               AS coverage
FROM ours o
FULL OUTER JOIN vendor v ON v.provider = o.provider AND v.day = o.day;

COMMENT ON VIEW public.v_ai_cost_reconciliation IS
  'Our estimate (ai_usage) beside the vendor invoice (ai_vendor_cost), per provider per day. Check `coverage` before reading delta_usd — only rows marked both are a real comparison.';

GRANT SELECT ON public.v_ai_cost_reconciliation TO authenticated;
REVOKE ALL  ON public.v_ai_cost_reconciliation FROM anon;
