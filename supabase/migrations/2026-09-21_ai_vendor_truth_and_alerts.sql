-- ============================================================================
-- AI spend: the vendor's number is the truth, plus low-balance alerts
-- (2026-09-21)
--
-- WHY THE MODEL CHANGES. Until today "remaining" was a hand-entered opening
-- balance minus our metered spend, compared against the vendor. It was right
-- only while someone recorded every top-up, and nobody did:
--
--   anthropic  ledger said $0.06 left; the vendor said $99.63  (a ~$100 top-up
--              nobody entered)
--   fal        off by $0.53                                    (same)
--   moonshot   off by $11.58                                  (Kimi coder
--              spend, which no call site of ours can see)
--   modal      $0 in the ledger; $220.18 on the bill          (postpaid, and a
--              batch that ran before the ledger existed)
--
-- The hand-entered balance was also the source of two false readings: a top-up
-- looks exactly like "the vendor has more than we think".
--
-- NEW MODEL (operator decision 2026-09-21):
--   * "How much is left?"       -> the vendor's latest GOOD reading. Full stop.
--   * "What did each feature spend?" -> ai_usage, unchanged.
--   * "Did anything spend that we did not meter?" -> compare how much the
--     vendor's balance FELL between consecutive readings with what we metered
--     in the same window. A top-up makes the balance RISE, which is plainly not
--     spending, so it is detected and counted separately instead of corrupting
--     the comparison. No top-up ever has to be typed in again.
--
-- The hand-entered credit tables (ai_provider_accounts / ai_credit_entries) are
-- NOT dropped: v_ai_account_balances still reads them and history stays
-- readable. They simply stop being the source of "remaining".
--
-- The alert recipient's phone number is deliberately NOT in this file. This
-- repository is public; the number is set with a one-off UPDATE against the
-- live database and lives only there.
-- ============================================================================

-- ── 1. Alert settings: one row, admin-only ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_alert_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),  -- singleton
  -- E.164 digits only, no '+'. Set in the database, never in this repo.
  whatsapp_to     text,
  -- The OPS number, not `sales`: an internal cost alert must not land in the
  -- inbox reps use to talk to customers.
  whatsapp_device text NOT NULL DEFAULT 'wassel_ops',
  enabled         boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ai_alert_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.ai_alert_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_alert_settings_admin_read ON public.ai_alert_settings;
CREATE POLICY ai_alert_settings_admin_read ON public.ai_alert_settings
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));
REVOKE ALL ON public.ai_alert_settings FROM anon;

COMMENT ON TABLE public.ai_alert_settings IS
  'Where AI balance alerts are sent. whatsapp_to is PII and is set only in the database - never commit it (the repo is public).';

-- ── 2. Prepaid vs postpaid, and per-provider thresholds ─────────────────────
-- Modal bills AFTER use: there is no balance to fall, only a cycle total that
-- rises. The two need opposite alert logic, so the mode is explicit data.
ALTER TABLE public.ai_provider_accounts
  ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'prepaid';
ALTER TABLE public.ai_provider_accounts
  DROP CONSTRAINT IF EXISTS ai_provider_accounts_billing_mode_check;
ALTER TABLE public.ai_provider_accounts
  ADD CONSTRAINT ai_provider_accounts_billing_mode_check
  CHECK (billing_mode IN ('prepaid', 'postpaid'));
-- Postpaid only: alert when the current billing cycle's spend passes this.
ALTER TABLE public.ai_provider_accounts
  ADD COLUMN IF NOT EXISTS spend_alert_threshold numeric;

UPDATE public.ai_provider_accounts SET billing_mode = 'postpaid' WHERE provider = 'modal';

-- Starting thresholds, editable on the page. Chosen from measured burn, not
-- round numbers:
--   anthropic $15 - the Files enrichment lane has burned $0.34/min in a burst
--                   (measured 2026-09-15/16); $15 is ~45 min of that, enough to
--                   react. The 2026-09-17 outage happened at $0.18.
--   deepseek / moonshot $5, fal $3 - slow, steady consumers.
--   modal (postpaid) $150 cycle spend - one CV batch cost $220 in ~2 days.
UPDATE public.ai_provider_accounts SET low_balance_threshold = 15
  WHERE provider = 'anthropic' AND low_balance_threshold IS NULL;
UPDATE public.ai_provider_accounts SET low_balance_threshold = 5
  WHERE provider IN ('deepseek', 'moonshot') AND low_balance_threshold IS NULL;
UPDATE public.ai_provider_accounts SET low_balance_threshold = 3
  WHERE provider = 'fal' AND low_balance_threshold IS NULL;
UPDATE public.ai_provider_accounts SET spend_alert_threshold = 150
  WHERE provider = 'modal' AND spend_alert_threshold IS NULL;

-- ── 3. Alert state: one alert per CROSSING, not one per hour ────────────────
-- Without this the hourly probe would WhatsApp the admin every hour for as long
-- as a balance stayed low - and an alert that fires constantly gets muted,
-- which is worse than no alert. An alert fires once when a provider crosses
-- into the danger zone and re-arms only after it recovers.
CREATE TABLE IF NOT EXISTS public.ai_balance_alert_state (
  provider     text PRIMARY KEY,
  in_alert     boolean NOT NULL DEFAULT false,
  alert_kind   text,            -- 'low_balance' | 'over_budget'
  alerted_at   timestamptz,
  alert_value  numeric,
  resolved_at  timestamptz,
  job_id       uuid             -- the scheduled_whatsapp_jobs row that carried it
);
ALTER TABLE public.ai_balance_alert_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_balance_alert_state_admin_read ON public.ai_balance_alert_state;
CREATE POLICY ai_balance_alert_state_admin_read ON public.ai_balance_alert_state
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));
REVOKE ALL ON public.ai_balance_alert_state FROM anon;

-- ── 4. The status view (replaces the hand-entered-balance comparison) ────────
--
-- MASKING FIX. The old view took each provider's LATEST row regardless of
-- status. Two probes write for Anthropic: the worker's browser probe (~:17/:27,
-- the real balance) and the Vercel cron (:47, "no API endpoint", useless). So
-- every hour the useless row buried the real one, and the page said "Not
-- checked yet" over 18 correct readings. Here the balance always comes from the
-- latest status='ok' row; the latest row of any status is kept separately only
-- to say whether the probe is currently healthy.
DROP VIEW IF EXISTS public.v_ai_balance_reconciliation;

CREATE VIEW public.v_ai_balance_reconciliation
WITH (security_invoker = true) AS
WITH
latest_ok AS (
  SELECT DISTINCT ON (provider) provider, checked_at, balance_usd, source
  FROM public.ai_provider_balance_probes
  WHERE status = 'ok'
  ORDER BY provider, checked_at DESC
),
latest_any AS (
  SELECT DISTINCT ON (provider) provider, checked_at, status, error, source
  FROM public.ai_provider_balance_probes
  ORDER BY provider, checked_at DESC
),
-- Consecutive GOOD readings, so a failed probe never reads as a jump.
steps AS (
  SELECT provider, checked_at, balance_usd,
         lag(balance_usd) OVER w AS prev_balance,
         lag(checked_at)  OVER w AS prev_at
  FROM public.ai_provider_balance_probes
  WHERE status = 'ok'
  WINDOW w AS (PARTITION BY provider ORDER BY checked_at)
),
window_24h AS (
  SELECT s.provider,
         a.billing_mode,
         -- PREPAID: spend is the balance FALLING; a rise is a top-up.
         -- POSTPAID: the reading is the cycle total, so spend is the reading
         -- RISING; a fall is the cycle resetting, where the new reading itself
         -- is the spend so far in the new cycle.
         sum(CASE
               WHEN a.billing_mode = 'postpaid' THEN
                 CASE WHEN s.balance_usd >= s.prev_balance THEN s.balance_usd - s.prev_balance
                      ELSE s.balance_usd END
               ELSE greatest(s.prev_balance - s.balance_usd, 0)
             END)                                              AS vendor_spent,
         sum(CASE WHEN a.billing_mode = 'prepaid'
                  THEN greatest(s.balance_usd - s.prev_balance, 0) ELSE 0 END) AS topups,
         min(s.prev_at)                                         AS window_from,
         max(s.checked_at)                                      AS window_to
  FROM steps s
  JOIN public.ai_provider_accounts a ON a.provider = s.provider AND a.is_active
  WHERE s.prev_balance IS NOT NULL
    AND s.checked_at > now() - interval '24 hours'
  GROUP BY s.provider, a.billing_mode
),
metered_24h AS (
  -- Compare over the SAME window the vendor readings cover, not a fixed 24h:
  -- with a flaky probe the covered window can be much shorter.
  SELECT w.provider,
         coalesce(sum(u.cost_usd) FILTER (WHERE u.cost_known), 0) AS metered,
         count(*) FILTER (WHERE NOT u.cost_known)                  AS unpriced_calls
  FROM window_24h w
  LEFT JOIN public.ai_usage u
    ON u.provider = w.provider
   AND u.created_at >  w.window_from
   AND u.created_at <= w.window_to
  GROUP BY w.provider
)
SELECT
  a.provider,
  a.label,
  a.billing_mode,
  a.low_balance_threshold,
  a.spend_alert_threshold,

  -- The vendor's own number: balance for prepaid, cycle spend for postpaid.
  o.balance_usd                          AS vendor_value_usd,
  o.checked_at                           AS vendor_value_at,
  o.source                               AS vendor_value_source,

  -- Probe health, independent of the value above.
  l.checked_at                           AS probe_checked_at,
  l.status                               AS probe_status,
  l.source                               AS probe_source,
  l.error                                AS probe_error,

  round(w.vendor_spent, 4)               AS vendor_spent_24h,
  round(m.metered, 4)                    AS metered_24h,
  round(w.topups, 4)                     AS topups_24h,
  round(w.vendor_spent - m.metered, 4)   AS unmetered_24h,
  coalesce(m.unpriced_calls, 0)          AS unpriced_calls_24h,
  w.window_from, w.window_to,

  CASE WHEN a.billing_mode = 'prepaid'
       THEN o.balance_usd IS NOT NULL AND a.low_balance_threshold IS NOT NULL
            AND o.balance_usd < a.low_balance_threshold
       ELSE o.balance_usd IS NOT NULL AND a.spend_alert_threshold IS NOT NULL
            AND o.balance_usd > a.spend_alert_threshold
  END                                    AS needs_alert,

  CASE
    WHEN o.balance_usd IS NULL AND l.status = 'unsupported' THEN 'unsupported'
    WHEN o.balance_usd IS NULL                              THEN 'no_reading'
    WHEN o.checked_at < now() - interval '24 hours'         THEN 'stale'
    WHEN a.billing_mode = 'prepaid' AND a.low_balance_threshold IS NOT NULL
         AND o.balance_usd < a.low_balance_threshold        THEN 'LOW_BALANCE'
    WHEN a.billing_mode = 'postpaid' AND a.spend_alert_threshold IS NOT NULL
         AND o.balance_usd > a.spend_alert_threshold        THEN 'OVER_BUDGET'
    -- Vendors round their dashboards to the cent while our rows carry six
    -- decimals, so a small gap is noise. Flag only a gap that is both > $0.50
    -- and > 20% of what we metered. Unpriced calls no longer SILENCE this: in
    -- the old view one unpriced call overrode any gap, and three calls worth
    -- cents hid $11.58. They are reported in unpriced_calls_24h instead.
    WHEN w.vendor_spent IS NOT NULL
         AND (w.vendor_spent - m.metered) > greatest(0.50, 0.20 * m.metered) THEN 'UNMETERED_SPEND'
    ELSE 'ok'
  END                                    AS verdict
FROM public.ai_provider_accounts a
LEFT JOIN latest_ok   o ON o.provider = a.provider
LEFT JOIN latest_any  l ON l.provider = a.provider
LEFT JOIN window_24h  w ON w.provider = a.provider
LEFT JOIN metered_24h m ON m.provider = a.provider
WHERE a.is_active;

COMMENT ON VIEW public.v_ai_balance_reconciliation IS
  'Per provider: the vendor''s own latest good reading, what the vendor says was spent in the last 24h, what we metered in the same window, and the gap. The vendor number is the truth; hand-entered balances are no longer consulted. Read verdict before any number.';

GRANT SELECT ON public.v_ai_balance_reconciliation TO authenticated;
REVOKE ALL  ON public.v_ai_balance_reconciliation FROM anon;

-- ── 5. Evaluate alerts and send them ─────────────────────────────────────────
-- Called from BOTH probe paths (the Vercel cron after the API probes, the Fly
-- worker after the browser probes). Safe to call from two places at once: the
-- state row is taken FOR UPDATE, so exactly one caller sends a given alert.
--
-- It sends through the existing scheduled-WhatsApp lane rather than a new
-- sender: that lane is already monitored, already retries, and already falls
-- back to the active number if a session was re-paired.
CREATE OR REPLACE FUNCTION public.ai_balance_alerts_evaluate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_cfg     public.ai_alert_settings%ROWTYPE;
  v_row     record;
  v_state   public.ai_balance_alert_state%ROWTYPE;
  v_body    text;
  v_job     uuid;
  v_sent    jsonb := '[]'::jsonb;
  v_cleared jsonb := '[]'::jsonb;
BEGIN
  IF NOT (auth.uid() IS NULL OR public.wassell_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'ai_balance_alerts_evaluate: admin only' USING ERRCODE = 'WS403';
  END IF;

  SELECT * INTO v_cfg FROM public.ai_alert_settings WHERE id;

  FOR v_row IN
    SELECT provider, label, billing_mode, vendor_value_usd, verdict,
           low_balance_threshold, spend_alert_threshold, needs_alert
    FROM public.v_ai_balance_reconciliation
  LOOP
    INSERT INTO public.ai_balance_alert_state (provider) VALUES (v_row.provider)
      ON CONFLICT (provider) DO NOTHING;
    SELECT * INTO v_state FROM public.ai_balance_alert_state
      WHERE provider = v_row.provider FOR UPDATE;

    IF v_row.needs_alert AND NOT v_state.in_alert THEN
      -- Crossed INTO the danger zone: alert once.
      v_body := CASE v_row.billing_mode
        WHEN 'prepaid' THEN
          format(E'⚠️ Low AI credit: %s\nBalance $%s is below your $%s alert.\nTop up before it runs out - when it hits zero, features that use it stop.',
                 coalesce(v_row.label, v_row.provider),
                 to_char(v_row.vendor_value_usd, 'FM999990.00'),
                 to_char(v_row.low_balance_threshold, 'FM999990.00'))
        ELSE
          format(E'⚠️ AI spend alert: %s\nThis billing cycle is at $%s, past your $%s alert.\nThis provider bills after use, so the cost keeps rising while work runs.',
                 coalesce(v_row.label, v_row.provider),
                 to_char(v_row.vendor_value_usd, 'FM999990.00'),
                 to_char(v_row.spend_alert_threshold, 'FM999990.00'))
      END;

      v_job := NULL;
      IF v_cfg.enabled AND coalesce(v_cfg.whatsapp_to, '') <> '' THEN
        v_job := public.scheduled_whatsapp_enqueue(
          v_cfg.whatsapp_device,
          v_cfg.whatsapp_to || '@c.us',
          v_cfg.whatsapp_to,
          v_body,
          '[]'::jsonb,
          'ai-balance-alert:' || v_row.provider,
          now(),
          NULL
        );
      END IF;

      -- State flips even when no recipient is configured, so a later-added
      -- number does not trigger a flood of stale alerts - the page banner still
      -- shows the condition in the meantime.
      UPDATE public.ai_balance_alert_state
         SET in_alert = true,
             alert_kind = CASE v_row.billing_mode WHEN 'prepaid' THEN 'low_balance' ELSE 'over_budget' END,
             alerted_at = now(), alert_value = v_row.vendor_value_usd,
             resolved_at = NULL, job_id = v_job
       WHERE provider = v_row.provider;

      v_sent := v_sent || jsonb_build_object('provider', v_row.provider,
                  'value', v_row.vendor_value_usd, 'job_id', v_job,
                  'delivered', v_job IS NOT NULL);

    ELSIF NOT coalesce(v_row.needs_alert, false) AND v_state.in_alert
          AND v_row.vendor_value_usd IS NOT NULL THEN
      -- Recovered (e.g. topped up): re-arm so the NEXT crossing alerts again.
      -- Only on a real reading - a failed probe must not look like a recovery.
      UPDATE public.ai_balance_alert_state
         SET in_alert = false, resolved_at = now()
       WHERE provider = v_row.provider;
      v_cleared := v_cleared || to_jsonb(v_row.provider);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('sent', v_sent, 'cleared', v_cleared,
                            'recipient_configured', coalesce(v_cfg.whatsapp_to, '') <> '');
END;
$fn$;

COMMENT ON FUNCTION public.ai_balance_alerts_evaluate IS
  'Sends ONE WhatsApp per provider when it crosses into low balance / over budget, re-arms on recovery. Safe to call from several places concurrently (row lock on the state row).';

-- ── 6. Kimi cache-write rate ────────────────────────────────────────────────
-- Three Kimi calls since 2026-09-19 reported cache_write tokens, and kimi-k3
-- had no cache_write rate, so the cost trigger correctly refused to price them.
--
-- $3.00/M is an INFERENCE, stated as one: Moonshot publishes input (cache miss)
-- $3.00, cache hit $0.30, output $15.00 (platform.kimi.ai/docs/pricing/chat)
-- and NO separate write price. A cache write is the cache MISS that populates
-- the cache, so it is billed at the miss rate. Revisit if Moonshot ever
-- publishes a distinct write price.
SELECT public.ai_price_set(
  'moonshot', 'kimi-k3',
  p_input_per_m       := 3.00,
  p_output_per_m      := 15.00,
  p_cache_read_per_m  := 0.30,
  p_cache_write_per_m := 3.00,
  p_source            := 'platform.kimi.ai/docs/pricing/chat, read 2026-09-15. cache_write = the published cache-MISS input rate ($3.00): Moonshot lists no separate write price, and a write is the miss that fills the cache. Inference, not a quoted figure.'
);

-- ── 7. Modal: calibrate our estimate against the real bill ───────────────────
-- Measured 2026-09-21: the 2026-09-02/03 CV batch (237 videos) was estimated at
-- $53.27; Modal billed $220.18 for that same window - 4.13x. The whole
-- September Modal bill came from that one batch, so the comparison is clean.
--
-- Why the estimate is low: infra/modal/video-cv/app.py prices OCR as
-- frames x 2.5 s x the L40S GPU rate. The OCR runs on the separate `wassel-ocr`
-- app via `.parse.map(...)`, which fans out across many L40S containers, each
-- paying a cold start plus an idle window before scale-down. Per-frame GPU
-- seconds cannot see that overhead, and at fan-out scale it is most of the bill
-- (L40S alone: $134.33 billed vs ~$30 estimated).
--
-- ONE batch is one data point: fan-out overhead depends on batch size, so this
-- factor is a correction, not a law. The live Modal browser probe reads the
-- REAL cycle total every hour; this factor only keeps the per-video split close
-- to reality in between. Recalibrate when a new batch gives a new data point.
INSERT INTO public.mkt_settings (key, value)
VALUES ('cv.modal_cost_calibration',
        '{"factor": 4.13, "measured": "2026-09-21", "estimate_usd": 53.27, "billed_usd": 220.18, "videos": 237, "window": "2026-09-02 10:48 to 2026-09-03 04:53 UTC"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- mkt_cv_cost_add: apply the calibration at the single point Modal cost enters,
-- so BOTH the CV ledger (which the $30/day CV budget reads) and the central
-- ai_usage mirror get the corrected figure. Without this the budget guard was
-- ~4x too loose: "$30/day" really allowed ~$124/day of actual spend.
-- The raw manifest estimate is kept in ai_usage.meta so the correction stays
-- auditable and reversible.
CREATE OR REPLACE FUNCTION public.mkt_cv_cost_add(
  p_kind text, p_video_id uuid, p_role text,
  p_provider text, p_model text, p_cost numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_factor numeric := 1;
  v_cost   numeric := coalesce(p_cost, 0);
BEGIN
  IF p_provider = 'modal' THEN
    SELECT coalesce((value->>'factor')::numeric, 1) INTO v_factor
      FROM public.mkt_settings WHERE key = 'cv.modal_cost_calibration';
    v_cost := coalesce(p_cost, 0) * coalesce(v_factor, 1);
  END IF;

  INSERT INTO public.mkt_cv_cost_ledger (kind, video_id, role, provider, model, cost_usd)
  VALUES (p_kind, p_video_id, p_role, p_provider, p_model, v_cost);

  UPDATE public.mkt_cv_videos
     SET cost_usd = cost_usd + v_cost, updated_at = now()
   WHERE id = p_video_id;

  -- Claude kinds are NOT mirrored: callRole() already records those.
  IF p_provider = 'modal' THEN
    INSERT INTO public.ai_usage (
      area, call_site, operation, provider, model, status,
      cost_usd, cost_known, entity_kind, entity_id, meta
    ) VALUES (
      'competitors', 'worker/cv/' || coalesce(p_kind, 'unknown'), p_role,
      'modal', coalesce(nullif(p_model, ''), 'modal-gpu'), 'ok',
      v_cost, true, 'mkt_cv_video', p_video_id::text,
      jsonb_build_object(
        'cost_source', 'modal manifest estimate x calibration factor (mkt_settings cv.modal_cost_calibration)',
        'raw_estimate_usd', coalesce(p_cost, 0),
        'calibration_factor', v_factor,
        'cv_kind', p_kind)
    );
  END IF;
END;
$function$;

-- ── 8. Record Modal's real September bill as vendor truth ────────────────────
-- ai_vendor_cost is where the vendor's own figure lives. The September batch
-- predates the ledger (built 2026-09-14), so it has no ai_usage rows; this puts
-- the real number on record without fabricating per-call rows from a total.
SELECT public.ai_vendor_cost_replace_day(
  'modal', DATE '2026-09-02', 'modal billing page (Usage & billing, cycle Sep 1 - Oct 1 2026), read 2026-09-21',
  jsonb_build_array(
    jsonb_build_object('model', 'L40S',   'cost_type', 'gpu',    'amount_usd', 134.33, 'raw', jsonb_build_object('resource','L40S')),
    jsonb_build_object('model', 'T4',     'cost_type', 'gpu',    'amount_usd',  55.13, 'raw', jsonb_build_object('resource','T4')),
    jsonb_build_object('model', 'CPU',    'cost_type', 'cpu',    'amount_usd',  20.78, 'raw', jsonb_build_object('resource','CPU')),
    jsonb_build_object('model', 'Memory', 'cost_type', 'memory', 'amount_usd',   9.80, 'raw', jsonb_build_object('resource','Memory')),
    -- The four lines captured sum to $220.04 against $220.18 billed. The page
    -- lists at least one more small resource line that was not captured. It is
    -- recorded as its own labelled row so the vendor total equals the bill,
    -- rather than silently understating it by $0.14.
    jsonb_build_object('model', 'unattributed', 'cost_type', 'other',  'amount_usd',   0.14,
                       'raw', jsonb_build_object('note','billed total minus the four captured resource lines'))
  )
);
