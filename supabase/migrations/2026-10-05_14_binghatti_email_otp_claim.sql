-- ============================================================================
-- 2026-10-05_14: Binghatti email OTP — atomic message-claim surface.
-- ----------------------------------------------------------------------------
-- The Binghatti portal is configured for email OTP; its actual new delivery
-- channel and message format remain unverified. The worker's Gmail reader
-- (gmail.readonly, read-only) can find a fresh code — but FIVE
-- worker machines (plus a rep typing the code by hand at the same moment) can
-- all try to consume the same message. This migration adds:
--
--   1. `portal_email_otp_claims` — one row per (mailbox, Gmail message) ever
--      claimed. Stores ONLY opaque ids (a SHA256 fingerprint of the mailbox,
--      the Gmail message id), the job that won, and when. NEVER the code, the
--      mailbox address, the raw sender, the body, or the request nonce.
--   2. `portal_email_otp_claim(...)` — the service-role-only atomic RPC. It
--      locks the portal then job, re-checks the exact live OTP request (fixed Binghatti
--      portal, awaiting_input, key/kind otp, exact request nonce, no manual
--      answer yet), binds the fingerprint to the CURRENT portal login_id, and
--      only the winning INSERT resumes the job. Manual input always wins: a
--      rep's answer already on the row (even whitespace — deliberately NOT
--      trimmed) makes the claim return false without touching the job.
--
-- Additive and backward compatible: nothing here changes the manual/WhatsApp
-- relay. No retryable SQLSTATE is ever raised (no 40001/40P01).
-- ============================================================================

BEGIN;

-- ── 1. Claim table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_email_otp_claims (
  -- SHA256(lower(trim(portal login_id))) — the mailbox is never stored.
  mailbox_fingerprint text        NOT NULL,
  -- Gmail's opaque message id (hex) — never the message itself.
  message_id          text        NOT NULL,
  -- Keep the unique replay marker even when queue cleanup deletes the job.
  job_id              uuid        REFERENCES public.portal_registration_jobs(id) ON DELETE SET NULL,
  claimed_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_fingerprint, message_id)
);

ALTER TABLE public.portal_email_otp_claims ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: RLS denies every direct read/write, and the claim
-- mutation happens inside the SECURITY DEFINER RPC (owner = migration role).
-- The SELECT/INSERT grants below are the "only rights actually needed" floor
-- for the service role the worker connects as; UPDATE/DELETE are never given.
-- Also remove Supabase's default service_role table grants before narrowing.
REVOKE ALL ON public.portal_email_otp_claims FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.portal_email_otp_claims TO service_role;

-- ── 2. Atomic claim RPC (service-role only) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.portal_email_otp_claim(
  p_job_id              uuid,
  p_key                 text,
  p_mailbox_fingerprint text,
  p_message_id          text,
  p_request_nonce       text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- The ONLY portal this claim surface exists for (Binghatti), its model and
  -- developer — same fixed ids as the capture recipe migrations.
  v_portal    uuid := '0f828ff1-c3b9-482c-8b1d-215bef4b4d43';
  v_model     uuid := '1ead0000-0000-4000-8000-000000000001';
  v_developer text := '759fa833-e60e-4775-86ab-292005c8d517';
  v_job       public.portal_registration_jobs%ROWTYPE;
  v_login_id  text;
  v_schema    text;
  v_expected  text;
  v_claimed   text;
BEGIN
  -- 1. Argument validation. Anything wrong → false, and every raised error in
  --    this function is a STATIC message (never built from the input).
  IF p_job_id IS NULL
     OR p_key IS NULL OR p_key <> 'otp'
     OR p_mailbox_fingerprint IS NULL OR p_mailbox_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_message_id IS NULL OR p_message_id !~ '^[0-9a-f]{1,128}$'
     OR p_request_nonce IS NULL
     OR p_request_nonce !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;

  -- 2. Lock the parent portal BEFORE its job, matching portal deletion's
  --    parent → child cascade order. FOR SHARE also makes a concurrent login
  --    edit wait rather than racing the fingerprint below. Must be the fixed
  --    Binghatti portal with otp_channel=email and a usable login_id.
  SELECT lower(trim(r.data ->> 'login_id')) INTO v_login_id
    FROM public.records r
   WHERE r.id = v_portal
     AND r.model_id = v_model
     AND r.data ->> 'developer' = v_developer
     AND r.data ->> 'otp_channel' = 'email'
   FOR SHARE;
  IF v_login_id IS NULL OR v_login_id = '' THEN
    RETURN false;
  END IF;

  -- 3. Lock the job and require the exact live OTP request it was prepared
  --    for. input_value NULL-or-exactly-empty on purpose: whitespace a rep
  --    typed is STILL manual input and must win over the mail reader.
  SELECT * INTO v_job
    FROM public.portal_registration_jobs
   WHERE id = p_job_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_job.portal_record_id <> v_portal
     OR v_job.status <> 'awaiting_input'
     OR v_job.input_request ->> 'key' IS DISTINCT FROM p_key
     OR v_job.input_request ->> 'kind' IS DISTINCT FROM 'otp'
     OR v_job.input_request ->> 'email_otp_nonce' IS DISTINCT FROM p_request_nonce
     OR NOT (v_job.input_value IS NULL OR v_job.input_value = '') THEN
    RETURN false;
  END IF;

  -- 4. Bind the fingerprint to the CURRENT normalized login_id. digest() lives
  --    wherever pgcrypto was installed (usually `extensions`) — resolve its
  --    schema from the catalog and schema-qualify the call; never rely on an
  --    unqualified digest under this function's fixed search_path.
  SELECT n.nspname INTO v_schema
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pgcrypto';
  IF v_schema IS NULL THEN
    RAISE EXCEPTION 'email OTP claim requires the pgcrypto extension' USING ERRCODE = 'WS500';
  END IF;
  EXECUTE pg_catalog.format('SELECT pg_catalog.encode(%I.digest($1, ''sha256''::text), ''hex'')', v_schema)
    INTO v_expected
    USING v_login_id;
  IF v_expected IS DISTINCT FROM p_mailbox_fingerprint THEN
    RETURN false;
  END IF;

  -- 5. One claim per (mailbox, message), ever. ON CONFLICT is what makes
  --    exactly one of five racing machines the winner.
  INSERT INTO public.portal_email_otp_claims (mailbox_fingerprint, message_id, job_id)
  VALUES (p_mailbox_fingerprint, p_message_id, p_job_id)
  ON CONFLICT (mailbox_fingerprint, message_id) DO NOTHING
  RETURNING message_id INTO v_claimed;
  IF v_claimed IS NULL THEN
    RETURN false; -- already claimed: a reused message or a replayed job
  END IF;

  -- 6. Only the winner resumes the job: awaiting_input → running, the request
  --    and any stale input cleared. The status guard is the last belt over the
  --    row lock above; it can only fail if the row changed in ways the lock
  --    already forbids, and false is the honest answer then.
  UPDATE public.portal_registration_jobs
     SET status = 'running', input_request = NULL, input_value = NULL,
         heartbeat_at = now(), updated_at = now()
   WHERE id = p_job_id AND status = 'awaiting_input';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.portal_email_otp_claim(uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_email_otp_claim(uuid,text,text,text,text) TO service_role;

-- ── 3. Replay-safety assertions (no operator rows required) ─────────────────
DO $assert$
DECLARE v_secdef boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'portal_email_otp_claims'
       AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'EMAIL_OTP_CLAIM: RLS is not enabled on portal_email_otp_claims';
  END IF;

  IF has_table_privilege('anon', 'public.portal_email_otp_claims', 'SELECT')
     OR has_table_privilege('anon', 'public.portal_email_otp_claims', 'INSERT')
     OR has_table_privilege('authenticated', 'public.portal_email_otp_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'public.portal_email_otp_claims', 'INSERT')
     OR has_table_privilege('service_role', 'public.portal_email_otp_claims', 'UPDATE')
     OR has_table_privilege('service_role', 'public.portal_email_otp_claims', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.portal_email_otp_claims', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.portal_email_otp_claims', 'INSERT') THEN
    RAISE EXCEPTION 'EMAIL_OTP_CLAIM: table grants widened beyond service_role SELECT/INSERT';
  END IF;

  SELECT p.prosecdef INTO v_secdef
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_email_otp_claim'
     AND p.pronargs = 5;
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'EMAIL_OTP_CLAIM: portal_email_otp_claim must be SECURITY DEFINER';
  END IF;

  IF has_function_privilege('anon', 'public.portal_email_otp_claim(uuid,text,text,text,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_email_otp_claim(uuid,text,text,text,text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.portal_email_otp_claim(uuid,text,text,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'EMAIL_OTP_CLAIM: function EXECUTE widened beyond service_role';
  END IF;
END $assert$;

COMMIT;
