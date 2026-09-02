-- ============================================================================
-- Post Creative Director — mos_creative_jobs queue (2026-09-02_20)
--
-- The post-creative pipeline (concepts → package → regenerate → derivatives)
-- is a multi-call Anthropic flow (minutes, not seconds). Per the standing repo
-- rule (decks / image-chats / documents / data-migration / script jobs), no
-- HTTP request may be held open for it: the endpoint ENQUEUES and returns, the
-- Fly worker's creative lane drains the queue and patches the content record;
-- the SPA reads status via Realtime / the status endpoint.
--
-- Shape mirrors mos_script_jobs (2026-09-01_10), plus what the creative lane
-- needs beyond it: a stage column (brief→facts→…→persist), a lease column
-- (watchdog keyed on lease expiry, not started_at), result/roles/cost ledgers,
-- and kind-aware requeue on transient/provider failures.
--
-- RLS enabled with NO policies by design: the endpoint (service client after
-- requireCap) and the worker (service_role) are the only readers/writers.
-- Additive + idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.mos_creative_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id        uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  kind              text NOT NULL
                    CHECK (kind IN ('post_concepts','post_package','post_regenerate','post_derivatives')),
  -- {recipe?, concept_id?, package_id?, targets:[DerivativeTarget], revision_note?, overrides?}
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by      uuid,                 -- public.users.id (notify target); nullable defensively
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','completed','failed','cancelled')),
  stage             text,                 -- brief|facts|brand|references|assets|targets|concepts|package|derivatives|validate|persist
  worker_id         text,
  attempts          int  NOT NULL DEFAULT 0,
  max_attempts      int  NOT NULL DEFAULT 2,
  result            jsonb,
  error             text,
  error_kind        text,                 -- provider|transient|validation_unrepaired|facts_insufficient|rights_blocked|policy_blocked|budget_exceeded|watchdog|cancelled|unknown
  roles             jsonb,                -- role ledger from worker/src/ai (createRoleLedger/ledgerToJson)
  cost_usd          numeric,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  lease_expires_at  timestamptz
);

-- At most ONE active (queued|running) job per content item, so a double-click
-- or a poll race can never fan out duplicate generations.
CREATE UNIQUE INDEX IF NOT EXISTS mos_creative_jobs_one_active
  ON public.mos_creative_jobs (content_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS mos_creative_jobs_claim
  ON public.mos_creative_jobs (created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS mos_creative_jobs_content
  ON public.mos_creative_jobs (content_id, created_at DESC);

ALTER TABLE public.mos_creative_jobs ENABLE ROW LEVEL SECURITY;
-- No policies by design: the endpoint (service client) and the worker
-- (service_role) are the only writers/readers; both bypass RLS.

-- ── enqueue ─────────────────────────────────────────────────────────────────
-- The partial unique index is the race-safe guard; a conflict means an active
-- job already exists for this content — surface it as the stable
-- 'active_job_exists' error the API maps to 409.
CREATE OR REPLACE FUNCTION public.mos_creative_job_enqueue(
  p_content_id   uuid,
  p_kind         text,
  p_params       jsonb,
  p_requested_by uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mos_creative_jobs (content_id, kind, params, requested_by)
  VALUES (p_content_id, p_kind, COALESCE(p_params, '{}'::jsonb), p_requested_by)
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'active_job_exists';
END;
$$;

-- ── claim (worker) ──────────────────────────────────────────────────────────
-- FOR UPDATE SKIP LOCKED guarantees no two worker machines ever claim the same
-- row. The 10-minute lease is what the watchdog sweeps on — a crashed worker's
-- job goes back to 'failed' (kind 'watchdog') once the lease lapses, it does
-- not run forever.
CREATE OR REPLACE FUNCTION public.mos_creative_job_claim_next(p_worker_id text)
RETURNS TABLE (job_id uuid, content_id uuid, kind text, params jsonb, requested_by uuid, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r public.mos_creative_jobs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.mos_creative_jobs
   WHERE status = 'queued'
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.mos_creative_jobs
     SET status = 'running', started_at = now(), worker_id = p_worker_id,
         lease_expires_at = now() + interval '10 minutes',
         attempts = r.attempts + 1  -- qualify: bare `attempts` is ambiguous with the OUT param
   WHERE id = r.id;

  job_id := r.id; content_id := r.content_id; kind := r.kind; params := r.params;
  requested_by := r.requested_by; attempts := r.attempts + 1;
  RETURN NEXT;
END;
$$;

-- ── stage heartbeat ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_creative_job_stage(p_job_id uuid, p_stage text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.mos_creative_jobs
     SET stage = p_stage
   WHERE id = p_job_id AND status = 'running';
$$;

-- ── complete / fail / cancel ────────────────────────────────────────────────
-- Terminal writes only touch a 'running' row — a late finish after a watchdog
-- sweep or a cancel is a harmless no-op (same guard as every other queue).
CREATE OR REPLACE FUNCTION public.mos_creative_job_complete(
  p_job_id uuid, p_result jsonb, p_roles jsonb, p_cost_usd numeric)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.mos_creative_jobs
     SET status = 'completed', result = p_result, roles = p_roles, cost_usd = p_cost_usd,
         error = NULL, error_kind = NULL, finished_at = now(), lease_expires_at = NULL
   WHERE id = p_job_id AND status = 'running';
$$;

-- Transient/provider failures requeue while attempts < max_attempts (a fresh
-- machine picks the job up; the attempt counter was already bumped at claim);
-- everything else is terminal.
CREATE OR REPLACE FUNCTION public.mos_creative_job_fail(
  p_job_id uuid, p_error text, p_error_kind text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.mos_creative_jobs
     SET status = CASE
                    WHEN attempts < max_attempts
                         AND p_error_kind IN ('provider','transient')
                    THEN 'queued' ELSE 'failed' END,
         error = LEFT(COALESCE(p_error, 'unknown'), 2000),
         error_kind = COALESCE(p_error_kind, 'unknown'),
         worker_id = CASE
                    WHEN attempts < max_attempts
                         AND p_error_kind IN ('provider','transient')
                    THEN NULL ELSE worker_id END,
         lease_expires_at = NULL,
         finished_at = CASE
                    WHEN attempts < max_attempts
                         AND p_error_kind IN ('provider','transient')
                    THEN NULL ELSE now() END
   WHERE id = p_job_id AND status = 'running';
$$;

-- Cancel is for a job nobody has claimed yet; a running job is failed by its
-- worker, not cancelled behind its back.
CREATE OR REPLACE FUNCTION public.mos_creative_job_cancel(p_job_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.mos_creative_jobs
     SET status = 'cancelled', error_kind = 'cancelled', finished_at = now()
   WHERE id = p_job_id AND status = 'queued';
$$;

-- ── watchdog ────────────────────────────────────────────────────────────────
-- Sweep jobs whose lease lapsed (worker crash / OOM / machine stop mid-job).
-- Returns the count swept.
CREATE OR REPLACE FUNCTION public.mos_creative_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE n int;
BEGIN
  UPDATE public.mos_creative_jobs
     SET status = 'failed',
         error = 'watchdog: lease expired while running',
         error_kind = 'watchdog',
         finished_at = now()
   WHERE status = 'running' AND lease_expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.mos_creative_job_enqueue(uuid, text, jsonb, uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_creative_job_claim_next(text)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_creative_job_stage(uuid, text)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_creative_job_complete(uuid, jsonb, jsonb, numeric)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_creative_job_fail(uuid, text, text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_creative_job_cancel(uuid)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_creative_jobs_watchdog()                            FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_creative_job_enqueue(uuid, text, jsonb, uuid)     TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_creative_job_claim_next(text)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_creative_job_stage(uuid, text)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_creative_job_complete(uuid, jsonb, jsonb, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_creative_job_fail(uuid, text, text)               TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_creative_job_cancel(uuid)                         TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_creative_jobs_watchdog()                          TO service_role;

COMMIT;
