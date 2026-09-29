-- ============================================================================
-- Call audit: preferences the customer said on a Hatif call that the
-- salesperson never put on the client.
-- ============================================================================
-- Operator decision 2026-09-29: calls are NOT read for a live card (the rep
-- logs during / after the call). The one call feature is an AUDIT — once per
-- finished call (> 20 s, diarized, ≥ 1 h after hang-up), read the call with the
-- preference extractor and propose ONLY the fields that are EMPTY on the
-- client. NEVER overwrite: a value that differs from the saved one is never
-- shown, and at save time a field that is no longer empty is skipped
-- (api/client-prefs/review.ts, buildFillEmptyPatch).
--
-- 1. client_pref_proposals gains `source` ('chat' | 'call'), `call_id`,
--    `call_at`, and trigger 'call_audit'. A call proposal is stored under
--    chat_wid = 'call:' || call_id, so the NOT NULL and the one-pending-per-
--    (chat_wid, client_id) unique index stay valid (= one pending per call).
-- 2. v_client_pref_review_outcomes gains `source` as a grouped column
--    (DROP + CREATE: the column set changes — security_invoker re-asserted).
-- 3. call_pref_audit — one row per call, the "checked once" ledger, written
--    only by the call_audit_* RPCs below.
--
-- Backward-compatible with the currently deployed code: the new columns
-- default to the chat values and the chat writer never names them.
--
-- No function here may raise SQLSTATE 40001/40P01 (CLAUDE.md): plain INSERT …
-- ON CONFLICT / UPDATE under READ COMMITTED never does.
-- ============================================================================
BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. client_pref_proposals: source / call_id / call_at + trigger 'call_audit'
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.client_pref_proposals
  ADD COLUMN IF NOT EXISTS source  text NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS call_id uuid,
  ADD COLUMN IF NOT EXISTS call_at timestamptz;

ALTER TABLE public.client_pref_proposals DROP CONSTRAINT IF EXISTS client_pref_proposals_source_check;
ALTER TABLE public.client_pref_proposals
  ADD CONSTRAINT client_pref_proposals_source_check CHECK (source IN ('chat', 'call'));

-- A call proposal always names its call, lives under 'call:<id>', and was made
-- by the audit; a chat proposal never names a call.
ALTER TABLE public.client_pref_proposals DROP CONSTRAINT IF EXISTS client_pref_proposals_source_shape_check;
ALTER TABLE public.client_pref_proposals
  ADD CONSTRAINT client_pref_proposals_source_shape_check CHECK (
    (source = 'chat' AND call_id IS NULL AND trigger <> 'call_audit')
    OR (source = 'call' AND call_id IS NOT NULL AND chat_wid = 'call:' || call_id::text AND trigger = 'call_audit')
  );

-- The trigger CHECK was declared INLINE in 2026-09-27_06, so its name is the
-- one Postgres generated. Drop whichever CHECK constrains the `trigger` column
-- (found by column, not by a guessed name), then re-add it under a fixed name.
DO $drop_trigger_check$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
    JOIN pg_attribute att ON att.attrelid = cls.oid AND att.attnum = ANY (con.conkey)
    WHERE nsp.nspname = 'public'
      AND cls.relname = 'client_pref_proposals'
      AND con.contype = 'c'
      AND att.attname = 'trigger'
      AND array_length(con.conkey, 1) = 1
  LOOP
    EXECUTE format('ALTER TABLE public.client_pref_proposals DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $drop_trigger_check$;

ALTER TABLE public.client_pref_proposals
  ADD CONSTRAINT client_pref_proposals_trigger_check
  CHECK (trigger IN ('cron', 'open', 'manual', 'call_audit'));

CREATE INDEX IF NOT EXISTS client_pref_proposals_client_source_idx
  ON public.client_pref_proposals (client_id, source, status);

COMMENT ON COLUMN public.client_pref_proposals.source IS
  'chat = read from a WhatsApp chat (chat_wid is the wid); call = the call audit (chat_wid = ''call:'' || call_id). Call proposals only ever carry fields that were EMPTY on the client, and their save is fill-empty-only.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. v_client_pref_review_outcomes + source
-- ────────────────────────────────────────────────────────────────────────────
-- DROP + CREATE (not CREATE OR REPLACE): a new column in the middle of the
-- select list. No CASCADE on purpose — the view is new (2026-09-27) and read
-- only by operators; if anything was built on it since, the DROP fails loudly
-- (2BP01) instead of silently taking the dependent with it.
DROP VIEW IF EXISTS public.v_client_pref_review_outcomes;

CREATE VIEW public.v_client_pref_review_outcomes
WITH (security_invoker = true) AS
WITH per_field AS (
  SELECT
    (p.created_at AT TIME ZONE 'Asia/Riyadh')::date AS day,
    p.source,
    s.slug,
    p.model,
    CASE
      WHEN p.status = 'saved' AND s.slug = ANY(coalesce(p.saved_fields, ARRAY[]::text[])) THEN 'accepted'
      WHEN p.status = 'saved'      THEN 'unticked'
      WHEN p.status = 'dismissed'  THEN 'dismissed'
      WHEN p.status = 'superseded' THEN 'superseded'
      ELSE 'open'
    END AS outcome,
    (p.current_values -> s.slug) IS DISTINCT FROM (s.sug -> 'value') AS was_change
  FROM public.client_pref_proposals p
  CROSS JOIN LATERAL jsonb_each(p.suggestions) AS s(slug, sug)
)
SELECT
  day,
  source,
  slug,
  model,
  count(*)                                           AS suggested,
  count(*) FILTER (WHERE was_change)                 AS suggested_changes,
  count(*) FILTER (WHERE outcome = 'accepted')       AS accepted,
  count(*) FILTER (WHERE outcome = 'unticked')       AS unticked,
  count(*) FILTER (WHERE outcome = 'dismissed')      AS dismissed,
  count(*) FILTER (WHERE outcome = 'superseded')     AS superseded,
  count(*) FILTER (WHERE outcome = 'open')           AS open,
  round(
    count(*) FILTER (WHERE outcome = 'accepted')::numeric
      / nullif(count(*) FILTER (WHERE outcome IN ('accepted', 'unticked', 'dismissed')), 0),
    3
  )                                                  AS acceptance_rate
FROM per_field
GROUP BY day, source, slug, model;

COMMENT ON VIEW public.v_client_pref_review_outcomes IS
  'Per Riyadh day × source (chat | call) × field × model: preference suggestions accepted (saved ticked) / unticked / dismissed / superseded / still open, and acceptance_rate = accepted / (accepted + unticked + dismissed). ACCEPTED IS NOT PROVEN CORRECT — it means a rep kept the line, not that the customer really wants it. For source=call, a ticked line skipped at save because the field was filled since the call is NOT in saved_fields, so it counts as unticked.';

ALTER VIEW public.v_client_pref_review_outcomes SET (security_invoker = true);
GRANT SELECT ON public.v_client_pref_review_outcomes TO authenticated, service_role;
REVOKE ALL ON public.v_client_pref_review_outcomes FROM anon;

DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_client_pref_review_outcomes';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_client_pref_review_outcomes — options are %', v_opts;
  END IF;
END $assert$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. call_pref_audit — the once-per-call ledger
-- ────────────────────────────────────────────────────────────────────────────
--   running   claimed; lease_until bounds a crashed audit
--   done      audited (proposal_id set when something was missing)
--   skipped   will never be audited (no transcript / unlabelled speakers /
--             client gone) — terminal
--   failed    the attempt errored; retried until attempts reaches 3
CREATE TABLE IF NOT EXISTS public.call_pref_audit (
  call_id       uuid PRIMARY KEY,
  client_id     uuid NOT NULL,
  status        text NOT NULL CHECK (status IN ('running', 'done', 'skipped', 'failed')),
  reason        text,
  attempts      int  NOT NULL DEFAULT 0,
  proposal_id   uuid,
  missed_fields text[],
  lease_until   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_pref_audit_client_idx ON public.call_pref_audit (client_id);

ALTER TABLE public.call_pref_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS call_pref_audit_select ON public.call_pref_audit;
CREATE POLICY call_pref_audit_select ON public.call_pref_audit
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.call_pref_audit FROM anon;

COMMENT ON TABLE public.call_pref_audit IS
  'Call audit ledger: one row per Hatif call checked for preferences the customer said but the client does not have. Written only by the call_audit_* RPCs (service role). A call is audited once; a failed attempt is retried at most 3 times.';

-- Which finished calls are due for the audit? Oldest hang-up first.
--   call_logs: > 20 s, diarized words present, hung up ≥ p_grace ago, created
--   within p_window; the phone_calls record with the SAME id links the client
--   (client_link scalar or array[0], uuid-shaped only — same guard as
--   chat_read_candidates); the client record must exist; and the ledger has no
--   terminal row (done / skipped), no live lease, no exhausted failure.
CREATE OR REPLACE FUNCTION public.call_audit_candidates(
  p_now    timestamptz DEFAULT now(),
  p_grace  interval    DEFAULT '60 minutes',
  p_window interval    DEFAULT '60 days',
  p_limit  int         DEFAULT 20
)
RETURNS TABLE (
  call_id          uuid,
  client_id        uuid,
  hangup_time      timestamptz,
  duration_seconds int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  WITH calls AS (
    SELECT l.id, l.hangup_time, l.duration_seconds
    FROM public.call_logs l
    WHERE l.duration_seconds > 20
      AND l.transcription ? 'words'
      AND l.hangup_time IS NOT NULL
      AND l.hangup_time <= p_now - p_grace
      AND l.created_at  >  p_now - p_window
  ),
  linked AS (
    SELECT c.id AS call_id, c.hangup_time, c.duration_seconds,
           CASE WHEN lk.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN lk.v::uuid END AS client_id
    FROM calls c
    JOIN public.records r ON r.id = c.id
    JOIN public.models  m ON m.id = r.model_id AND m.name = 'phone_calls'
    CROSS JOIN LATERAL (
      SELECT CASE jsonb_typeof(r.data->'client_link')
               WHEN 'array'  THEN r.data->'client_link'->>0
               WHEN 'string' THEN r.data->>'client_link'
             END AS v
    ) lk
  )
  SELECT k.call_id, k.client_id, k.hangup_time, k.duration_seconds
  FROM linked k
  WHERE k.client_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.records c
      JOIN public.models clm ON clm.id = c.model_id AND clm.name = 'clients'
      WHERE c.id = k.client_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.call_pref_audit a
      WHERE a.call_id = k.call_id
        AND (
          a.status IN ('done', 'skipped')
          OR (a.status = 'running' AND a.lease_until IS NOT NULL AND a.lease_until > p_now)
          OR (a.status IN ('failed', 'running') AND a.attempts >= 3)
        )
    )
  ORDER BY k.hangup_time ASC, k.call_id
  LIMIT greatest(coalesce(p_limit, 20), 1);
$fn$;

-- Claim one call. Exactly one concurrent caller wins: the loser's ON CONFLICT
-- UPDATE re-checks the WHERE against the winner's committed row, sees a live
-- lease and updates nothing. Re-claims only a failed row (or a running row
-- whose lease expired — a crashed audit) while attempts < 3.
CREATE OR REPLACE FUNCTION public.call_audit_claim(
  p_call_id uuid, p_client_id uuid, p_lease_seconds int
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_call_id IS NULL OR p_client_id IS NULL THEN
    RAISE EXCEPTION 'call_audit_claim: call_id and client_id are required';
  END IF;
  INSERT INTO public.call_pref_audit AS a (call_id, client_id, status, attempts, lease_until, created_at, updated_at)
  VALUES (p_call_id, p_client_id, 'running', 1,
          now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30)), now(), now())
  ON CONFLICT (call_id) DO UPDATE
     SET status      = 'running',
         client_id   = EXCLUDED.client_id,
         attempts    = a.attempts + 1,
         reason      = NULL,
         lease_until = EXCLUDED.lease_until,
         updated_at  = now()
   WHERE a.attempts < 3
     AND (a.status = 'failed'
          OR (a.status = 'running' AND (a.lease_until IS NULL OR a.lease_until < now())));
  RETURN FOUND;
END
$fn$;

-- Record the attempt's result and clear the lease. Only a `running` row is
-- finished (a late finish after another runner took over is a no-op and
-- returns false, which the caller logs).
CREATE OR REPLACE FUNCTION public.call_audit_finish(
  p_call_id uuid, p_status text, p_reason text, p_proposal_id uuid, p_missed text[]
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('done', 'skipped', 'failed') THEN
    RAISE EXCEPTION 'call_audit_finish: status must be done|skipped|failed, got %', p_status;
  END IF;
  UPDATE public.call_pref_audit
     SET status        = p_status,
         reason        = left(p_reason, 2000),
         proposal_id   = p_proposal_id,
         missed_fields = p_missed,
         lease_until   = NULL,
         updated_at    = now()
   WHERE call_id = p_call_id AND status = 'running';
  RETURN FOUND;
END
$fn$;

REVOKE ALL ON FUNCTION public.call_audit_candidates(timestamptz, interval, interval, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_audit_claim(uuid, uuid, int)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_audit_finish(uuid, text, text, uuid, text[])         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_audit_candidates(timestamptz, interval, interval, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.call_audit_claim(uuid, uuid, int)                         TO service_role;
GRANT EXECUTE ON FUNCTION public.call_audit_finish(uuid, text, text, uuid, text[])         TO service_role;

COMMIT;
