-- ============================================================================
-- 2026-07-01: rega_lookup_jobs queue — on-demand advertiser-phone lookup
-- ----------------------------------------------------------------------------
-- Powers the "التواصل مع المعلن" button on a market_listings record. When
-- clicked, the SPA enqueues ONE job; the Fly worker drives a Browserbase session
-- that reads the listing's Aqar page → follows the official REGA advertising-
-- license link (eservicesredp.rega.gov.sa/.../ElanDetails/<guid>) → scrapes the
-- publicly-disclosed advertiser name + agent mobile → writes them onto the
-- listing (advertiser_phone / advertiser_name). The SPA watches the record via
-- Supabase Realtime and, when the phone lands, opens an in-app WhatsApp chat.
--
-- WHY a queue + worker (not a synchronous endpoint): the scrape is ~30-60s
-- (Browserbase session + Cloudflare clear + two page loads) and can occasionally
-- exceed a minute if REGA challenges. Holding a Vercel function open that long
-- violates the repo's "never hold an HTTP request open for a long call" rule
-- (see CLAUDE.md) and risks a timeout. So this follows the exact deck_jobs /
-- data_migration_jobs pattern: slim enqueue endpoint (202) → worker claims via
-- FOR UPDATE SKIP LOCKED → scrapes with no wall-clock ceiling → patches the
-- record → Realtime fans it to the SPA. No SSE, no held HTTP.
--
-- Auth: the worker uses the service-role key (writes bypass RLS). Ownership was
-- validated by /api/rega-lookup (the caller's JWT could SELECT the listing)
-- before enqueue.
--
-- Legitimacy note: the REGA page is a PUBLIC government registry that discloses
-- the advertiser BY LAW — no login, no token, no per-account cap (unlike Aqar's
-- own WhatsApp contact flow, which is Nafath-gated). Browserbase is pointed only
-- at public Aqar + gov REGA pages.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- Table
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rega_lookup_jobs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The market_listings record (in public.records) this job enriches.
  -- CASCADE so deleting the listing cancels any pending/running job.
  listing_record_id uuid        NOT NULL REFERENCES public.records(id) ON DELETE CASCADE,
  -- auth.users id of the submitter (who clicked the button).
  user_id           uuid        NOT NULL,
  status            text        NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued','running','done','failed','cancelled')),
  attempts          int         NOT NULL DEFAULT 0,
  result            jsonb,
  error_message     text,
  worker_id         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);

-- ────────────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────────────
-- Worker claim hot path (queued tail only).
CREATE INDEX IF NOT EXISTS rega_lookup_jobs_queued_by_age_idx
  ON public.rega_lookup_jobs (created_at)
  WHERE status = 'queued';

-- Watchdog hot path.
CREATE INDEX IF NOT EXISTS rega_lookup_jobs_running_by_started_idx
  ON public.rega_lookup_jobs (started_at)
  WHERE status = 'running';

-- ONE-ACTIVE-JOB-PER-LISTING guarantee — collapses a double-click into one job.
CREATE UNIQUE INDEX IF NOT EXISTS rega_lookup_jobs_one_active_per_listing_idx
  ON public.rega_lookup_jobs (listing_record_id)
  WHERE status IN ('queued','running');

-- Per-listing lookup (status reads / debugging).
CREATE INDEX IF NOT EXISTS rega_lookup_jobs_listing_idx
  ON public.rega_lookup_jobs (listing_record_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────
-- RLS — users may SELECT their own jobs; all writes are service-role only.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.rega_lookup_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rega_lookup_jobs_owner_select" ON public.rega_lookup_jobs;
CREATE POLICY "rega_lookup_jobs_owner_select"
  ON public.rega_lookup_jobs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- RPC: rega_lookup_job_enqueue — idempotent one-active-per-listing insert.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rega_lookup_job_enqueue(
  p_listing_record_id uuid,
  p_user_id           uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.rega_lookup_jobs (listing_record_id, user_id)
  VALUES (p_listing_record_id, p_user_id)
  ON CONFLICT (listing_record_id) WHERE status IN ('queued','running') DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- An active job already exists — return it (idempotent enqueue).
    SELECT id INTO v_id
      FROM public.rega_lookup_jobs
     WHERE listing_record_id = p_listing_record_id
       AND status IN ('queued','running')
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.rega_lookup_job_enqueue(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rega_lookup_job_enqueue(uuid, uuid) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: rega_lookup_job_claim_next — FOR UPDATE SKIP LOCKED single-row claim.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rega_lookup_job_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id            uuid,
  listing_record_id uuid,
  user_id           uuid,
  attempts          int
) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.rega_lookup_jobs
     SET status     = 'running',
         worker_id  = p_worker_id,
         started_at = now(),
         attempts   = rega_lookup_jobs.attempts + 1
   WHERE id = (
     SELECT id
       FROM public.rega_lookup_jobs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
   RETURNING id, listing_record_id, user_id, attempts;
$$;

REVOKE ALL ON FUNCTION public.rega_lookup_job_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rega_lookup_job_claim_next(text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: rega_lookup_job_complete / _fail — both guarded by status='running'
-- so a late finish after the watchdog/cancel already moved the job is a no-op.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rega_lookup_job_complete(p_job_id uuid, p_result jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.rega_lookup_jobs
       SET status = 'done', finished_at = now(), result = p_result, error_message = NULL
     WHERE id = p_job_id AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.rega_lookup_job_complete(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rega_lookup_job_complete(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.rega_lookup_job_fail(p_job_id uuid, p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.rega_lookup_jobs
       SET status = 'failed', finished_at = now(), error_message = p_error
     WHERE id = p_job_id AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.rega_lookup_job_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rega_lookup_job_fail(uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Watchdog — sweep jobs stuck 'running' >10 min (worker crash / machine stop)
-- to 'failed', and reflect the failure onto the listing record (only if it is
-- still marked 'running') so the SPA button exits its spinner via Realtime.
-- 10 min is well above the worst-case scrape (~1-2 min with Cloudflare retries).
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rega_lookup_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count int := 0;
  v_msg   text := 'تعذّر جلب رقم المعلن — لم يكمل العامل خلال 10 دقائق. حاول مرة أخرى.';
BEGIN
  CREATE TEMP TABLE _stale_rega ON COMMIT DROP AS
    SELECT id, listing_record_id
      FROM public.rega_lookup_jobs
     WHERE status = 'running'
       AND started_at < now() - interval '10 minutes';

  UPDATE public.rega_lookup_jobs j
     SET status = 'failed', finished_at = now(), error_message = v_msg
    FROM _stale_rega s
   WHERE j.id = s.id;

  UPDATE public.records r
     SET data = r.data || jsonb_build_object('rega_lookup_status','failed','rega_lookup_error',v_msg),
         updated_at = now()
    FROM _stale_rega s
   WHERE r.id = s.listing_record_id
     AND COALESCE(r.data->>'rega_lookup_status','') = 'running';

  SELECT COUNT(*) INTO v_count FROM _stale_rega;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.rega_lookup_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rega_lookup_jobs_watchdog() TO service_role;

-- pg_cron is NOT enabled on wassell-prod (no-op guard); the Fly worker calls
-- rega_lookup_jobs_watchdog() on its watchdog interval like every other queue.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('rega_lookup_jobs_watchdog');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule(
      'rega_lookup_jobs_watchdog',
      '*/5 * * * *',
      $cmd$SELECT public.rega_lookup_jobs_watchdog();$cmd$
    );
  END IF;
END $$;

COMMIT;
