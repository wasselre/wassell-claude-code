-- ============================================================================
-- AI provider credit accounts  (2026-09-14)
--
-- WHY: `ai_usage` answers "what did we spend"; it cannot answer "how much is
-- left". No provider here exposes a balance API we can read (Anthropic,
-- DeepSeek, Moonshot, fal and Modal all keep the balance behind their own
-- dashboard login), so the balance is OPERATOR-ENTERED and the spend is
-- SUBTRACTED automatically:
--
--   remaining = (every credit the operator recorded) - (metered spend since the
--                first credit's effective_at)
--
-- SHAPE: two tables.
--   ai_provider_accounts — one account per provider ("Anthropic — main").
--   ai_credit_entries    — append-only money-in ledger: opening balances,
--                          top-ups, and corrections.
--
-- Nothing is ever overwritten. A wrong number is fixed by adding an
-- 'adjustment' entry (which can be negative), so the history of what the
-- operator believed and when stays intact — same posture as ai_usage itself.
--
-- HONESTY RULE: a balance computed from partly-unpriced usage is an UPPER
-- BOUND, not a figure. Every view here carries `unpriced_calls` alongside the
-- remaining balance so the UI can say so rather than quietly overstating it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Accounts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_provider_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  label        text NOT NULL,
  -- Every provider in this app bills in USD. The column exists so a future
  -- SAR-billed vendor does not need a migration, not because it varies today.
  currency     text NOT NULL DEFAULT 'USD',
  is_active    boolean NOT NULL DEFAULT true,
  -- Warn when the remaining balance drops below this. NULL = no warning.
  low_balance_threshold numeric(14,2),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid
);

COMMENT ON TABLE public.ai_provider_accounts IS
  'One credit account per AI provider. Balances are operator-entered (no provider exposes a readable balance API); spend is subtracted from ai_usage automatically.';

-- v1 attributes spend by PROVIDER, so exactly one active account per provider
-- can own that provider's usage. A second account for the same provider is
-- allowed only as history (is_active = false).
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_accounts_one_active_idx
  ON public.ai_provider_accounts (provider) WHERE is_active;

-- ---------------------------------------------------------------------------
-- 2. Credit entries (money in)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_credit_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.ai_provider_accounts(id) ON DELETE CASCADE,
  -- 'opening'    — "this is what the account holds as of now", the starting line
  -- 'topup'      — money added later
  -- 'adjustment' — a correction; MAY be negative
  kind         text NOT NULL,
  amount_usd   numeric(14,2) NOT NULL,
  -- When the money was actually in the account. Spend is counted from the
  -- EARLIEST effective_at on the account, so usage recorded before the operator
  -- started tracking is never subtracted from a balance it predates.
  effective_at timestamptz NOT NULL DEFAULT now(),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  CONSTRAINT ai_credit_entries_kind_chk CHECK (kind IN ('opening', 'topup', 'adjustment')),
  -- Only an explicit correction may be negative; a typo'd top-up should fail
  -- loudly rather than silently reduce the balance.
  CONSTRAINT ai_credit_entries_amount_chk CHECK (kind = 'adjustment' OR amount_usd > 0)
);

COMMENT ON TABLE public.ai_credit_entries IS
  'Append-only money-in ledger per AI account. Never updated in place — a wrong figure is corrected with an adjustment entry so the history stays readable.';

CREATE INDEX IF NOT EXISTS ai_credit_entries_account_idx
  ON public.ai_credit_entries (account_id, effective_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Balances
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_ai_account_balances
WITH (security_invoker = true) AS
WITH credits AS (
  SELECT
    account_id,
    sum(amount_usd)                                       AS credited_usd,
    min(effective_at)                                     AS tracking_since,
    max(effective_at) FILTER (WHERE kind <> 'adjustment')  AS last_topup_at,
    count(*)                                              AS entry_count
  FROM public.ai_credit_entries
  GROUP BY account_id
),
spend AS (
  SELECT
    a.id                                                   AS account_id,
    coalesce(sum(u.cost_usd) FILTER (WHERE u.cost_known), 0) AS spent_usd,
    count(u.id) FILTER (WHERE NOT u.cost_known)            AS unpriced_calls,
    count(u.id)                                            AS total_calls
  FROM public.ai_provider_accounts a
  LEFT JOIN credits c ON c.account_id = a.id
  LEFT JOIN public.ai_usage u
    ON u.provider = a.provider
   AND c.tracking_since IS NOT NULL
   AND u.created_at >= c.tracking_since
  GROUP BY a.id
)
SELECT
  a.id,
  a.provider,
  a.label,
  a.currency,
  a.is_active,
  a.low_balance_threshold,
  a.notes,
  coalesce(c.credited_usd, 0)                              AS credited_usd,
  c.tracking_since,
  c.last_topup_at,
  coalesce(c.entry_count, 0)                               AS entry_count,
  coalesce(s.spent_usd, 0)                                 AS spent_usd,
  -- The headline number. It is only as good as the pricing behind it, which is
  -- why unpriced_calls travels with it everywhere.
  coalesce(c.credited_usd, 0) - coalesce(s.spent_usd, 0)   AS remaining_usd,
  CASE
    WHEN coalesce(c.credited_usd, 0) > 0
      THEN round(100 * coalesce(s.spent_usd, 0) / c.credited_usd, 1)
    ELSE NULL
  END                                                      AS pct_used,
  coalesce(s.unpriced_calls, 0)                            AS unpriced_calls,
  coalesce(s.total_calls, 0)                               AS total_calls,
  -- TRUE when some recorded usage could not be priced, so `remaining_usd` is an
  -- upper bound on what is actually left.
  coalesce(s.unpriced_calls, 0) > 0                        AS remaining_is_upper_bound,
  a.low_balance_threshold IS NOT NULL
    AND (coalesce(c.credited_usd, 0) - coalesce(s.spent_usd, 0)) <= a.low_balance_threshold
                                                           AS is_low
FROM public.ai_provider_accounts a
LEFT JOIN credits c ON c.account_id = a.id
LEFT JOIN spend   s ON s.account_id = a.id;

COMMENT ON VIEW public.v_ai_account_balances IS
  'Remaining credit per AI provider account: operator-entered credits minus metered spend since tracking started. Check remaining_is_upper_bound before quoting remaining_usd as fact.';

/**
 * Daily burn + a runway estimate, so "how long does this last" is answerable
 * without the operator doing the arithmetic. Deliberately based on the last 30
 * days of ACTUAL metered spend rather than a projection.
 */
CREATE OR REPLACE VIEW public.v_ai_account_runway
WITH (security_invoker = true) AS
WITH burn AS (
  SELECT
    a.id AS account_id,
    coalesce(sum(u.cost_usd) FILTER (WHERE u.cost_known), 0) AS spent_30d,
    count(u.id) FILTER (WHERE NOT u.cost_known)              AS unpriced_30d
  FROM public.ai_provider_accounts a
  LEFT JOIN public.ai_usage u
    ON u.provider = a.provider
   AND u.created_at >= now() - interval '30 days'
  GROUP BY a.id
)
SELECT
  b.account_id,
  bal.provider,
  bal.label,
  b.spent_30d,
  b.unpriced_30d,
  round(b.spent_30d / 30.0, 4) AS avg_daily_usd,
  bal.remaining_usd,
  CASE
    WHEN b.spent_30d > 0 AND bal.remaining_usd > 0
      THEN floor(bal.remaining_usd / (b.spent_30d / 30.0))
    ELSE NULL
  END AS days_remaining
FROM burn b
JOIN public.v_ai_account_balances bal ON bal.id = b.account_id;

COMMENT ON VIEW public.v_ai_account_runway IS
  'Days of credit left per account at the last 30 days'' measured burn rate. NULL days_remaining means no spend in the window, or nothing left.';

-- ---------------------------------------------------------------------------
-- 4. Write RPCs (admin-gated, SECURITY DEFINER)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_account_upsert(
  p_provider  text,
  p_label     text,
  p_id        uuid DEFAULT NULL,
  p_threshold numeric DEFAULT NULL,
  p_notes     text DEFAULT NULL,
  p_is_active boolean DEFAULT true
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
    RAISE EXCEPTION 'ai_account_upsert: admin only' USING ERRCODE = 'WS403';
  END IF;
  IF coalesce(btrim(p_provider), '') = '' OR coalesce(btrim(p_label), '') = '' THEN
    RAISE EXCEPTION 'ai_account_upsert: provider and label are required' USING ERRCODE = 'WS400';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.ai_provider_accounts (provider, label, low_balance_threshold, notes, is_active, created_by)
    VALUES (btrim(p_provider), btrim(p_label), p_threshold, p_notes, p_is_active, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.ai_provider_accounts
       SET provider = btrim(p_provider),
           label = btrim(p_label),
           low_balance_threshold = p_threshold,
           notes = p_notes,
           is_active = p_is_active,
           updated_at = now()
     WHERE id = p_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'ai_account_upsert: account % not found', p_id USING ERRCODE = 'WS404';
    END IF;
  END IF;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ai_credit_add(
  p_account_id   uuid,
  p_amount_usd   numeric,
  p_kind         text DEFAULT 'topup',
  p_effective_at timestamptz DEFAULT now(),
  p_note         text DEFAULT NULL
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
    RAISE EXCEPTION 'ai_credit_add: admin only' USING ERRCODE = 'WS403';
  END IF;
  IF p_amount_usd IS NULL OR p_amount_usd = 0 THEN
    RAISE EXCEPTION 'ai_credit_add: amount must be non-zero' USING ERRCODE = 'WS400';
  END IF;

  INSERT INTO public.ai_credit_entries (account_id, kind, amount_usd, effective_at, note, created_by)
  VALUES (p_account_id, p_kind, p_amount_usd, coalesce(p_effective_at, now()), p_note, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

/**
 * Remove a credit entry. Allowed because a fat-fingered entry made seconds ago
 * is noise, not history — but the UI should prefer an 'adjustment' for anything
 * the operator has already acted on.
 */
CREATE OR REPLACE FUNCTION public.ai_credit_delete(p_entry_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  n integer;
BEGIN
  IF NOT (auth.uid() IS NULL OR public.wassell_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'ai_credit_delete: admin only' USING ERRCODE = 'WS403';
  END IF;
  DELETE FROM public.ai_credit_entries WHERE id = p_entry_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. RLS — admins read, writes only through the RPCs above
-- ---------------------------------------------------------------------------

ALTER TABLE public.ai_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_credit_entries    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_provider_accounts_admin_read ON public.ai_provider_accounts;
CREATE POLICY ai_provider_accounts_admin_read ON public.ai_provider_accounts
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

DROP POLICY IF EXISTS ai_credit_entries_admin_read ON public.ai_credit_entries;
CREATE POLICY ai_credit_entries_admin_read ON public.ai_credit_entries
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

REVOKE ALL ON public.ai_provider_accounts FROM anon;
REVOKE ALL ON public.ai_credit_entries    FROM anon;
GRANT SELECT ON public.v_ai_account_balances, public.v_ai_account_runway TO authenticated;
REVOKE ALL  ON public.v_ai_account_balances, public.v_ai_account_runway FROM anon;

-- ---------------------------------------------------------------------------
-- 6. Seed one account per provider the app actually calls
--
-- Seeded with NO credit entries on purpose: an account with no entries reads as
-- "not tracked yet" rather than "zero balance", and the page prompts for an
-- opening balance. Spend only starts counting from the first entry.
-- ---------------------------------------------------------------------------

INSERT INTO public.ai_provider_accounts (provider, label, notes)
SELECT v.provider, v.label, v.notes
FROM (VALUES
  ('anthropic', 'Anthropic — main',  'console.anthropic.com billing'),
  ('deepseek',  'DeepSeek — main',   'platform.deepseek.com billing'),
  ('moonshot',  'Moonshot (Kimi)',   'platform.moonshot.ai billing'),
  ('fal',       'fal.ai — main',     'fal.ai dashboard'),
  ('modal',     'Modal — main',      'modal.com usage; billed per GPU-second')
) AS v(provider, label, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_provider_accounts a WHERE a.provider = v.provider AND a.is_active
);
