-- scheduled_whatsapp_requeue — put a running job back in the queue with a delay.
--
-- Why (2026-07-23 incident): the entire 10:00 batch (36 jobs) died on ONE
-- attempt because the WAHA session was a zombie at fire time ("server returned
-- error 463") and scheduled_whatsapp_fail is permanent. The worker now requeues
-- transient WAHA 5xx / network failures (max 3 total attempts, 2/4-min backoff)
-- and only hard-fails app-level errors. attempts increments on CLAIM
-- (scheduled_whatsapp_claim_due), so this function deliberately leaves the
-- counter alone; the worker stops requeueing at attempts >= 3.
--
-- Guarded by status='running' like _complete/_fail, so a requeue racing the
-- queue watchdog's sweep is a harmless no-op.

CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_requeue(p_job_id uuid, p_error text, p_delay_s int)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.scheduled_whatsapp_jobs
       SET status        = 'queued',
           deliver_at    = now() + make_interval(secs => GREATEST(p_delay_s, 10)),
           error_message = p_error,
           worker_id     = NULL,
           started_at    = NULL
     WHERE id = p_job_id AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_requeue(uuid, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_requeue(uuid, text, int) TO service_role;
