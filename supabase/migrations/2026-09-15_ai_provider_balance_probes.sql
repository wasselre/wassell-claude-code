-- ============================================================================
-- Provider balance probes — "is anything spending that we are not counting?"
-- (2026-09-15)
--
-- WHY THIS EXISTS. On 2026-09-15 the Anthropic console said $0.45 had left the
-- account while `ai_usage` accounted for $0.02 of it. Nothing was broken: the
-- money went on an operator-run calibration batch
-- (api/_lib/geoPreference/__tests__/runCalibration.e2e.test.ts, 26 clients x 2
-- channels of live extraction) executed from a laptop with .env.local. The
-- metering guard could never have caught it — it scans `api`, `worker/src` and
-- `supabase/functions` and deliberately skips `__tests__`, and it does not look
-- at `scripts/` at all.
--
-- The lesson is that a ledger can only ever see the call sites someone wired.
-- The ONLY way to know that nothing is unmetered is to ask the vendor what is
-- actually left and compare it with what we think is left. That is this table.
--
-- ours_remaining - provider_balance = money that left the account without
-- passing through `ai_usage`. A positive drift is the alarm.
--
-- SOURCE OF TRUTH per provider (measured 2026-09-15):
--   deepseek  API   GET  api.deepseek.com/user/balance            (Bearer key)
--   moonshot  API   GET  api.moonshot.ai/v1/users/me/balance      (Bearer key)
--   fal       API   GET  api.fal.ai/v1/account/billing?expand=credits ("Key k")
--   anthropic BROWSER — no balance endpoint exists. The Console shows
--             "Credits $x.xx"; the Admin API is unavailable to individual
--             accounts entirely (see CLAUDE.md "Every AI call is metered" #13).
--   modal     BROWSER — no balance endpoint; usage-billed, not prepaid.
-- `source` records which of those produced a row so a scraped number is never
-- mistaken for a vendor API reading.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_provider_balance_probes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  checked_at   timestamptz NOT NULL DEFAULT now(),

  -- How the number was obtained. 'api' is a vendor endpoint; 'browser' is a
  -- Browserbase session reading the dashboard; 'manual' is a human typing what
  -- they saw. They are NOT interchangeable and the page labels them.
  source       text NOT NULL CHECK (source IN ('api', 'browser', 'manual')),
  status       text NOT NULL CHECK (status IN ('ok', 'error', 'unsupported')),

  -- Always dollars. A provider reporting another currency is converted by the
  -- caller, which must also record the rate it used in `raw`.
  balance_usd  numeric(14,6),
  currency     text,

  raw          jsonb,   -- the vendor payload, verbatim, so a reading is auditable
  error        text
);

COMMENT ON TABLE public.ai_provider_balance_probes IS
  'What the VENDOR says is LEFT in each account. Compared against our computed remaining in v_ai_balance_reconciliation; a gap is spend that never reached ai_usage.';

CREATE INDEX IF NOT EXISTS ai_provider_balance_probes_latest_idx
  ON public.ai_provider_balance_probes (provider, checked_at DESC);

ALTER TABLE public.ai_provider_balance_probes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_balance_probes_admin_read ON public.ai_provider_balance_probes;
CREATE POLICY ai_balance_probes_admin_read ON public.ai_provider_balance_probes
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

REVOKE ALL ON public.ai_provider_balance_probes FROM anon;

/**
 * Record one probe. Append-only by design: a balance reading is an observation
 * at a point in time, and the history is what lets you see the drift growing
 * rather than only its current value.
 */
CREATE OR REPLACE FUNCTION public.ai_balance_probe_add(
  p_provider text,
  p_source   text,
  p_status   text,
  p_balance  numeric DEFAULT NULL,
  p_currency text    DEFAULT 'USD',
  p_raw      jsonb   DEFAULT NULL,
  p_error    text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF NOT (auth.uid() IS NULL OR public.wassell_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'ai_balance_probe_add: admin only' USING ERRCODE = 'WS403';
  END IF;

  -- A successful probe without a number is a contradiction: it would read as
  -- "the vendor says nothing is left" on the page.
  IF p_status = 'ok' AND p_balance IS NULL THEN
    RAISE EXCEPTION 'ai_balance_probe_add: status=ok requires a balance' USING ERRCODE = 'WS400';
  END IF;

  INSERT INTO public.ai_provider_balance_probes
    (provider, source, status, balance_usd, currency, raw, error)
  VALUES
    (p_provider, p_source, p_status, p_balance,
     COALESCE(NULLIF(p_currency, ''), 'USD'), p_raw, p_error)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

/**
 * Our number beside the vendor's, per provider.
 *
 * READ `verdict` BEFORE `drift_usd` — most rows cannot support a comparison at
 * all, and a bare number would be read as if they could:
 *
 *   match            the two agree within tolerance. Nothing is unmetered.
 *   UNMETERED_SPEND  the vendor has LESS than we think. Money left the account
 *                    without passing through ai_usage. This is the alarm.
 *   credit_added     the vendor has MORE than we think — almost always a top-up
 *                    nobody entered as a credit entry, not a metering fault.
 *   ours_is_upper_bound   our side contains unpriced calls, so our remaining is
 *                    an upper bound and the drift cannot be attributed.
 *   no_probe         nobody has asked the vendor yet.
 *   not_tracked      no opening balance entered, so there is nothing to compare.
 *   stale_probe      the last reading is older than 24h.
 */
CREATE OR REPLACE VIEW public.v_ai_balance_reconciliation
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT DISTINCT ON (provider)
         provider, checked_at, source, status, balance_usd, currency, error
  FROM public.ai_provider_balance_probes
  ORDER BY provider, checked_at DESC
)
SELECT
  b.provider,
  b.label,
  b.credited_usd,
  b.spent_usd,
  b.remaining_usd                       AS ours_remaining_usd,
  b.remaining_is_upper_bound,
  b.unpriced_calls,
  p.balance_usd                         AS provider_balance_usd,
  p.checked_at                          AS probe_checked_at,
  p.source                              AS probe_source,
  p.status                              AS probe_status,
  p.error                               AS probe_error,
  round(b.remaining_usd - p.balance_usd, 6) AS drift_usd,
  CASE
    WHEN b.entry_count = 0                      THEN 'not_tracked'
    WHEN p.provider IS NULL                     THEN 'no_probe'
    WHEN p.status <> 'ok'                       THEN 'no_probe'
    WHEN p.checked_at < now() - interval '24 hours' THEN 'stale_probe'
    WHEN b.remaining_is_upper_bound             THEN 'ours_is_upper_bound'
    -- One cent of tolerance: vendors round their dashboards, and our own
    -- figure is a sum of six-decimal rows. Anything inside that is agreement.
    WHEN abs(b.remaining_usd - p.balance_usd) <= 0.01 THEN 'match'
    WHEN b.remaining_usd > p.balance_usd        THEN 'UNMETERED_SPEND'
    ELSE 'credit_added'
  END                                   AS verdict
FROM public.v_ai_account_balances b
LEFT JOIN latest p ON p.provider = b.provider;

COMMENT ON VIEW public.v_ai_balance_reconciliation IS
  'Our computed remaining beside the vendor''s real balance. verdict=UNMETERED_SPEND means money left the account without passing through ai_usage. Always read verdict before drift_usd.';

GRANT SELECT ON public.v_ai_balance_reconciliation TO authenticated;
REVOKE ALL  ON public.v_ai_balance_reconciliation FROM anon;
