-- ============================================================================
-- Central AI usage ledger  (2026-09-14)
--
-- WHY: before this migration only 9 of ~44 AI call sites recorded a cost, all
-- of them in Marketing (mkt_cv_cost_ledger, mkt_visual_text, mkt_transcripts,
-- mos_creative_jobs, …). The whole Sales side, every translation call and both
-- Opus agents ran with no telemetry at all, so the AI bill could only be read
-- as a single line on a vendor invoice and never attributed to a feature.
--
-- SHAPE: two tables.
--   ai_price_book — what a model costs. OPERATOR-EDITABLE data, not code.
--   ai_usage      — one append-only row per model call, from every call site.
--
-- The split matters. Tokens are the hard thing to capture and they are
-- captured ALWAYS, even for a provider whose rate we do not know. Price is
-- applied from the price book at insert time, and `ai_usage_recost()` re-prices
-- history whenever a rate is entered or changes. So an unpriced provider still
-- produces a complete token record that becomes costed the moment someone fills
-- in one row — rather than a permanent hole.
--
-- HARD RULE, inherited from worker/src/ai/pricing.ts: an unknown price yields
-- NULL, never 0. `cost_known` states which it is. Unknown is not free.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Price book
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_price_book (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL,
  model                text NOT NULL,
  -- Token pricing, USD per 1M tokens. NULL = not known (never assume 0).
  input_per_m          numeric(12,6),
  output_per_m         numeric(12,6),
  cache_read_per_m     numeric(12,6),
  cache_write_per_m    numeric(12,6),
  -- Unit pricing for providers that do not bill per token (fal images, Modal
  -- GPU seconds, per-minute transcription). USD per single unit.
  unit_price           numeric(12,6),
  unit_kind            text,
  effective_from       timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
  source               text,
  notes                text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT ai_price_book_provider_model_from_key UNIQUE (provider, model, effective_from)
);

COMMENT ON TABLE public.ai_price_book IS
  'Per-model prices used to cost rows in ai_usage. Operator-editable via ai_price_set(). NULL price = unknown, which makes ai_usage.cost_usd NULL and cost_known=false — never 0.';

CREATE INDEX IF NOT EXISTS ai_price_book_lookup_idx
  ON public.ai_price_book (provider, model, effective_from DESC);

-- ---------------------------------------------------------------------------
-- 2. Usage ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_usage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Business attribution. `area` is the coarse bucket a cost report groups by;
  -- `call_site` is the stable slug of the code that made the call, so a spike
  -- points at one file rather than a whole department.
  area               text NOT NULL,
  call_site          text NOT NULL,
  operation          text,

  provider           text NOT NULL,
  model              text NOT NULL,

  -- 'ok' | 'error'. Error rows are kept deliberately: a failed call that burned
  -- input tokens still costs money, and a run of them is the signal that a
  -- fallback is firing constantly.
  status             text NOT NULL DEFAULT 'ok',
  error              text,

  -- True when this call is the fallback leg (e.g. Claude after DeepSeek threw).
  -- `fallback_from` names the provider that failed. Counting these is how you
  -- see the cheap path quietly stopping to carry the traffic.
  is_fallback        boolean NOT NULL DEFAULT false,
  fallback_from      text,

  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,

  -- Non-token billing: 3 images, 12.4 GPU-seconds, 4.2 audio-minutes.
  units              numeric(14,4),
  unit_kind          text,

  cost_usd           numeric(14,6),
  cost_known         boolean NOT NULL DEFAULT false,

  latency_ms         integer,
  user_id            uuid,
  entity_kind        text,
  entity_id          text,
  request_id         text,
  meta               jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT ai_usage_status_chk CHECK (status IN ('ok', 'error')),
  CONSTRAINT ai_usage_tokens_chk CHECK (
    input_tokens >= 0 AND output_tokens >= 0
    AND cache_read_tokens >= 0 AND cache_write_tokens >= 0
  )
);

COMMENT ON TABLE public.ai_usage IS
  'Append-only ledger: one row per model call from every AI call site in api/, worker/ and supabase/functions/. cost_usd NULL means the price is unknown, not that the call was free — see cost_known.';

CREATE INDEX IF NOT EXISTS ai_usage_created_idx     ON public.ai_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_area_idx        ON public.ai_usage (area, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_provider_idx    ON public.ai_usage (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_call_site_idx   ON public.ai_usage (call_site, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_unknown_idx     ON public.ai_usage (provider, model)
  WHERE cost_known = false;
CREATE INDEX IF NOT EXISTS ai_usage_entity_idx      ON public.ai_usage (entity_kind, entity_id)
  WHERE entity_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Costing
-- ---------------------------------------------------------------------------

-- Resolve the price row in force for (provider, model) at a moment in time.
-- Exact model id first, then a prefix row so a dated snapshot
-- ('claude-haiku-4-5-20251001') inherits the alias row's price.
CREATE OR REPLACE FUNCTION public.ai_price_for(
  p_provider text,
  p_model    text,
  p_at       timestamptz DEFAULT now()
)
RETURNS public.ai_price_book
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT *
  FROM public.ai_price_book b
  WHERE b.provider = p_provider
    AND b.effective_from <= p_at
    AND (b.model = p_model OR p_model LIKE b.model || '%')
  ORDER BY (b.model = p_model) DESC, length(b.model) DESC, b.effective_from DESC
  LIMIT 1;
$$;

-- USD for one call. NULL when no price covers it, or when a price row exists
-- but leaves the dimension this call actually used unpriced.
CREATE OR REPLACE FUNCTION public.ai_usage_cost(u public.ai_usage)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  p public.ai_price_book;
  total numeric := 0;
  saw_price boolean := false;
BEGIN
  p := public.ai_price_for(u.provider, u.model, u.created_at);
  IF p.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Unit-billed call (fal image, Modal GPU second, transcription minute).
  IF u.units IS NOT NULL AND u.units > 0 THEN
    IF p.unit_price IS NULL THEN
      RETURN NULL;
    END IF;
    total := total + (u.units * p.unit_price);
    saw_price := true;
  END IF;

  -- Token-billed call. A dimension the call did not use needs no price; a
  -- dimension it DID use and the book does not price makes the whole row
  -- unknown, because a partial sum understates the bill.
  IF u.input_tokens > 0 THEN
    IF p.input_per_m IS NULL THEN RETURN NULL; END IF;
    total := total + (u.input_tokens::numeric / 1000000) * p.input_per_m;
    saw_price := true;
  END IF;
  IF u.output_tokens > 0 THEN
    IF p.output_per_m IS NULL THEN RETURN NULL; END IF;
    total := total + (u.output_tokens::numeric / 1000000) * p.output_per_m;
    saw_price := true;
  END IF;
  IF u.cache_read_tokens > 0 THEN
    IF p.cache_read_per_m IS NULL THEN RETURN NULL; END IF;
    total := total + (u.cache_read_tokens::numeric / 1000000) * p.cache_read_per_m;
    saw_price := true;
  END IF;
  IF u.cache_write_tokens > 0 THEN
    IF p.cache_write_per_m IS NULL THEN RETURN NULL; END IF;
    total := total + (u.cache_write_tokens::numeric / 1000000) * p.cache_write_per_m;
    saw_price := true;
  END IF;

  -- A call that consumed nothing we can price at all (e.g. the runner, which
  -- deliberately reports zero usage) is genuinely $0 only when the price book
  -- says so with an explicit zero row; otherwise it is unknown.
  IF NOT saw_price THEN
    IF p.input_per_m IS NOT NULL OR p.unit_price IS NOT NULL THEN
      RETURN 0;
    END IF;
    RETURN NULL;
  END IF;

  RETURN round(total, 6);
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_ai_usage_cost()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  c numeric;
BEGIN
  -- A caller that already knows its exact cost (the creative lanes compute it
  -- from the same price tier the provider returned) keeps its own number.
  IF NEW.cost_usd IS NOT NULL AND NEW.cost_known THEN
    RETURN NEW;
  END IF;
  c := public.ai_usage_cost(NEW);
  NEW.cost_usd  := c;
  NEW.cost_known := (c IS NOT NULL);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_usage_cost_fill ON public.ai_usage;
CREATE TRIGGER ai_usage_cost_fill
  BEFORE INSERT ON public.ai_usage
  FOR EACH ROW EXECUTE FUNCTION public.tg_ai_usage_cost();

-- Re-price history. Run after entering or changing a rate; returns how many
-- rows changed. Only rewrites rows whose cost actually differs, so a no-op
-- recost writes nothing.
CREATE OR REPLACE FUNCTION public.ai_usage_recost(
  p_from     timestamptz DEFAULT '-infinity'::timestamptz,
  p_to       timestamptz DEFAULT 'infinity'::timestamptz,
  p_provider text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  n integer;
BEGIN
  WITH recomputed AS (
    SELECT u.id, public.ai_usage_cost(u) AS new_cost
    FROM public.ai_usage u
    WHERE u.created_at >= p_from
      AND u.created_at <= p_to
      AND (p_provider IS NULL OR u.provider = p_provider)
  )
  UPDATE public.ai_usage u
  SET cost_usd = r.new_cost,
      cost_known = (r.new_cost IS NOT NULL)
  FROM recomputed r
  WHERE u.id = r.id
    AND (u.cost_usd IS DISTINCT FROM r.new_cost);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.ai_usage_recost IS
  'Re-price ai_usage rows against the current price book. Call after ai_price_set(). Returns the number of rows whose cost changed.';

-- Operator-facing setter. Upserts the open-ended price row for a model and
-- immediately re-prices every affected row, so entering a rate retroactively
-- costs the whole history rather than only future calls.
CREATE OR REPLACE FUNCTION public.ai_price_set(
  p_provider         text,
  p_model            text,
  p_input_per_m      numeric DEFAULT NULL,
  p_output_per_m     numeric DEFAULT NULL,
  p_cache_read_per_m numeric DEFAULT NULL,
  p_cache_write_per_m numeric DEFAULT NULL,
  p_unit_price       numeric DEFAULT NULL,
  p_unit_kind        text DEFAULT NULL,
  p_source           text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  repriced integer;
BEGIN
  IF NOT (auth.uid() IS NULL OR public.wassell_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'ai_price_set: admin only' USING ERRCODE = 'WS403';
  END IF;

  INSERT INTO public.ai_price_book AS b (
    provider, model, input_per_m, output_per_m, cache_read_per_m,
    cache_write_per_m, unit_price, unit_kind, effective_from, source,
    updated_at, updated_by
  )
  VALUES (
    p_provider, p_model, p_input_per_m, p_output_per_m, p_cache_read_per_m,
    p_cache_write_per_m, p_unit_price, p_unit_kind, '-infinity'::timestamptz,
    p_source, now(), auth.uid()
  )
  ON CONFLICT (provider, model, effective_from) DO UPDATE SET
    input_per_m       = EXCLUDED.input_per_m,
    output_per_m      = EXCLUDED.output_per_m,
    cache_read_per_m  = EXCLUDED.cache_read_per_m,
    cache_write_per_m = EXCLUDED.cache_write_per_m,
    unit_price        = EXCLUDED.unit_price,
    unit_kind         = EXCLUDED.unit_kind,
    source            = COALESCE(EXCLUDED.source, b.source),
    updated_at        = now(),
    updated_by        = auth.uid();

  repriced := public.ai_usage_recost('-infinity'::timestamptz, 'infinity'::timestamptz, p_provider);
  RETURN repriced;
END;
$$;

COMMENT ON FUNCTION public.ai_price_set IS
  'Set a model price and retroactively re-cost every ai_usage row for that provider. Returns rows repriced.';

-- ---------------------------------------------------------------------------
-- 4. Reporting views
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_ai_usage_daily
WITH (security_invoker = true) AS
SELECT
  date_trunc('day', created_at)::date       AS day,
  area,
  call_site,
  provider,
  model,
  count(*)                                   AS calls,
  count(*) FILTER (WHERE status = 'error')   AS errors,
  count(*) FILTER (WHERE is_fallback)        AS fallback_calls,
  sum(input_tokens)                          AS input_tokens,
  sum(output_tokens)                         AS output_tokens,
  sum(cache_read_tokens)                     AS cache_read_tokens,
  sum(cache_write_tokens)                    AS cache_write_tokens,
  sum(units)                                 AS units,
  -- Unknown-cost calls are counted, never silently treated as zero: a day with
  -- unpriced_calls > 0 has a cost FLOOR, not a total.
  count(*) FILTER (WHERE NOT cost_known)     AS unpriced_calls,
  round(sum(cost_usd) FILTER (WHERE cost_known), 6) AS cost_usd,
  round(avg(latency_ms)::numeric, 0)         AS avg_latency_ms
FROM public.ai_usage
GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW public.v_ai_usage_daily IS
  'Daily AI spend by area / call site / model. cost_usd sums only priced rows — check unpriced_calls before treating it as a total.';

-- What still has no price. This is the operator worklist: every row here is
-- real usage that cannot be costed until someone enters a rate.
CREATE OR REPLACE VIEW public.v_ai_usage_unpriced
WITH (security_invoker = true) AS
SELECT
  provider,
  model,
  count(*)              AS calls,
  sum(input_tokens)     AS input_tokens,
  sum(output_tokens)    AS output_tokens,
  sum(units)            AS units,
  max(unit_kind)        AS unit_kind,
  min(created_at)       AS first_seen,
  max(created_at)       AS last_seen
FROM public.ai_usage
WHERE cost_known = false
GROUP BY 1, 2
ORDER BY 3 DESC;

COMMENT ON VIEW public.v_ai_usage_unpriced IS
  'Models with recorded usage but no price. Fix each with: select ai_price_set(provider, model, input_per_m, output_per_m);';

-- ---------------------------------------------------------------------------
-- 5. RLS — service-role writes, admins read
-- ---------------------------------------------------------------------------

ALTER TABLE public.ai_usage      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_price_book ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_admin_read ON public.ai_usage;
CREATE POLICY ai_usage_admin_read ON public.ai_usage
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

DROP POLICY IF EXISTS ai_price_book_admin_read ON public.ai_price_book;
CREATE POLICY ai_price_book_admin_read ON public.ai_price_book
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

-- No INSERT/UPDATE/DELETE policy for `authenticated` anywhere: every write
-- comes from a service-role client (which bypasses RLS) or from ai_price_set(),
-- which is SECURITY DEFINER and does its own admin check. A browser cannot
-- forge a usage row.

REVOKE ALL ON public.ai_usage      FROM anon;
REVOKE ALL ON public.ai_price_book FROM anon;
GRANT SELECT ON public.v_ai_usage_daily, public.v_ai_usage_unpriced TO authenticated;
REVOKE ALL ON public.v_ai_usage_daily, public.v_ai_usage_unpriced FROM anon;

-- ---------------------------------------------------------------------------
-- 6. Seed the price book
--
-- Anthropic rates are copied from worker/src/ai/pricing.ts, whose documented
-- source is the claude-api skill's Current Models table (cached 2026-06-24).
-- Cache reads are 0.1x input (0.025x on Fable 5.1); cache writes 1.25x input
-- on the 5-minute TTL, which is what every call site here uses.
--
-- DeepSeek, Moonshot, fal and Modal are seeded with NULL prices ON PURPOSE.
-- Nothing in this repo documents their rates, and the project's standing rule
-- is that an unknown price is NULL and never a guess. Their tokens are still
-- recorded in full; run ai_price_set() with the figure from each vendor's
-- dashboard and the whole history re-costs itself.
-- ---------------------------------------------------------------------------

INSERT INTO public.ai_price_book
  (provider, model, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, source, notes)
VALUES
  ('anthropic', 'claude-opus-5',     5,  25,  0.5,   6.25,  'worker/src/ai/pricing.ts', NULL),
  ('anthropic', 'claude-opus-4-8',   5,  25,  0.5,   6.25,  'worker/src/ai/pricing.ts', NULL),
  ('anthropic', 'claude-opus-4-7',   5,  25,  0.5,   6.25,  'worker/src/ai/pricing.ts', NULL),
  ('anthropic', 'claude-opus-4-6',   5,  25,  0.5,   6.25,  'worker/src/ai/pricing.ts', NULL),
  ('anthropic', 'claude-sonnet-5',   2,  10,  0.2,   2.5,   'worker/src/ai/pricing.ts', NULL),
  ('anthropic', 'claude-sonnet-4-6', 3,  15,  0.3,   3.75,  'worker/src/ai/pricing.ts', NULL),
  ('anthropic', 'claude-haiku-4-5',  1,   5,  0.1,   1.25,  'worker/src/ai/pricing.ts', 'Covers the dated snapshot -20251001 by prefix match.'),
  ('anthropic', 'claude-fable-5-1', 10,  50,  0.25, 12.5,   'worker/src/ai/pricing.ts', 'Cache reads are 0.025x input on Fable 5.1.'),
  ('anthropic', 'claude-fable-5',   10,  50,  1.0,  12.5,   'worker/src/ai/pricing.ts', NULL),
  -- The Claude Code runner spends the paid subscription, not the API. Zero is
  -- a measured fact here, not an unknown, so it gets an explicit zero row.
  ('runner',    'claude-runner',     0,   0,  0,     0,     'paid Claude subscription', 'Runner lanes cost nothing on the API by design.')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

INSERT INTO public.ai_price_book (provider, model, notes)
VALUES
  ('deepseek', 'deepseek-chat',
   'PRICE NOT SET. Highest-volume provider in the app. Get the rate from platform.deepseek.com billing, then: select ai_price_set(''deepseek'',''deepseek-chat'', <input_per_m>, <output_per_m>, <cache_read_per_m>);'),
  ('moonshot', 'kimi-k3',
   'PRICE NOT SET. WhatsApp responder tail + project-message rewrite. Rate from platform.moonshot.ai, then ai_price_set(''moonshot'',''kimi-k3'', …).'),
  ('fal', 'fal-ai/wizper',
   'PRICE NOT SET. Billed per audio minute — units are recorded as unit_kind=''minute''. Set with ai_price_set(''fal'',''fal-ai/wizper'', p_unit_price := <usd_per_minute>, p_unit_kind := ''minute'').'),
  ('fal', 'fal-ai/nano-banana-pro',
   'PRICE NOT SET. Billed per generated image — unit_kind=''image''. ai_price_set(''fal'',''fal-ai/nano-banana-pro'', p_unit_price := <usd_per_image>, p_unit_kind := ''image'').'),
  ('fal', 'fal-ai/flux-2',
   'PRICE NOT SET. Covers the klein/4b/edit watermark-removal model by prefix. unit_kind=''image''.'),
  ('modal', 'modal-gpu',
   'PRICE NOT SET. Billed per GPU-second — unit_kind=''gpu_second''. Largest single line in the September ledger. ai_price_set(''modal'',''modal-gpu'', p_unit_price := <usd_per_gpu_second>, p_unit_kind := ''gpu_second'').')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

COMMIT;
