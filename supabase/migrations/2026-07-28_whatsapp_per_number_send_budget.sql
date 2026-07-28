-- WA-31 -- a per-NUMBER send budget, enforced centrally in the queue.
--
-- Nothing paced sending. Five worker machines each claim up to 5 due jobs per
-- poll, so a bulk enqueue drained at whatever rate the gateway accepted -- and
-- WhatsApp's answer to a burst on an unofficial client is error 463 or a ban.
-- The per-USER ceiling added for WA-01 does not help: it counts one person's
-- API calls, while the thing WhatsApp rates is the NUMBER.
--
-- Deliberately NOT an invented "WhatsApp limit" -- no published figure exists
-- for an unofficial multi-device client. The defaults come from THIS account's
-- measured traffic: busiest day 379 outbound, busiest hour 65. 40/min and
-- 600/hour sit well above normal working behaviour while refusing a runaway,
-- and are per-number configurable so a 463'd number can be slowed without a
-- deploy.
--
-- Verified: with the budget squeezed to zero, a due job is left UNCLAIMED.

CREATE TABLE IF NOT EXISTS public.whatsapp_send_budget (
  device_id        text PRIMARY KEY,
  max_per_minute   integer NOT NULL DEFAULT 40,
  max_per_hour     integer NOT NULL DEFAULT 600,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.whatsapp_send_budget ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_send_budget_read ON public.whatsapp_send_budget;
CREATE POLICY whatsapp_send_budget_read ON public.whatsapp_send_budget
  FOR SELECT TO authenticated USING (true);

-- Counts what ACTUALLY went out (chat_messages) rather than what was claimed,
-- so a burst that failed does not consume budget the customer never received.
CREATE OR REPLACE FUNCTION public.whatsapp_send_budget_remaining(p_device_id text)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  WITH b AS (
    SELECT COALESCE(max_per_minute, 40) AS pm, COALESCE(max_per_hour, 600) AS ph
    FROM public.whatsapp_send_budget WHERE device_id = p_device_id
    UNION ALL SELECT 40, 600
    LIMIT 1
  ),
  used AS (
    SELECT
      count(*) FILTER (WHERE date > now() - interval '1 minute') AS m,
      count(*) FILTER (WHERE date > now() - interval '1 hour')   AS h
    FROM public.chat_messages
    WHERE device_id = p_device_id AND flow = 'out' AND date > now() - interval '1 hour'
  )
  SELECT GREATEST(0, LEAST(b.pm - used.m, b.ph - used.h))::int FROM b, used
$$;

REVOKE ALL ON FUNCTION public.whatsapp_send_budget_remaining(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_send_budget_remaining(text) TO service_role, authenticated;

-- The cap is applied INSIDE the claim, so five machines competing cannot
-- collectively exceed it -- each sees the budget already consumed by the
-- others' delivered messages.
CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_claim_due(p_worker_id text, p_limit integer DEFAULT 5)
RETURNS TABLE(job_id uuid, device_id text, chat_wid text, phone text, body text, media jsonb, reference text, attempts integer)
LANGUAGE sql SECURITY DEFINER
AS $function$
  UPDATE public.scheduled_whatsapp_jobs
     SET status='running', worker_id=p_worker_id, started_at=now(),
         attempts=scheduled_whatsapp_jobs.attempts+1
   WHERE id IN (
     SELECT j.id FROM public.scheduled_whatsapp_jobs j
      WHERE j.status='queued' AND j.deliver_at <= now()
        AND public.whatsapp_send_budget_remaining(j.device_id) > 0
      ORDER BY j.deliver_at FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(p_limit,1))
   RETURNING id, device_id, chat_wid, phone, body, media, reference, attempts;
$function$;
