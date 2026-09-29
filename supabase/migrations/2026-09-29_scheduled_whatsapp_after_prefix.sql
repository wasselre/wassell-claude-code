-- Scheduled WhatsApp: an optional "send only after these" hold (2026-09-29).
--
-- The queue sends a chat's jobs in parallel across the worker machines, ordered
-- only by deliver_at. So the sales agent's follow-up «ناسبك؟» — timed to land
-- "after" a project package — overtook the package's slow media: live test
-- 2026-09-29, المشرقية 2's video finished 40 s after the question, and أكنان 25's
-- video 4 minutes after it. A timer cannot know how long a video upload takes.
--
-- `after_prefix`: a job carrying it is not claimed while any OTHER job for the
-- same chat whose reference starts with that prefix is still queued or running.
-- The agent sets it to its package prefix ('ai-project:agent:<project id>:').
-- Ceiling: 10 minutes past deliver_at the hold releases anyway, so a stuck media
-- job can never silence the chat (the watchdog marks a >15 min running job
-- 'unknown', which also releases it). NULL = today's behaviour, unchanged.
--
-- Backward compatible: the new enqueue argument defaults to NULL, and the
-- deployed code calls both RPCs by name. Service-role only, as before.

ALTER TABLE public.scheduled_whatsapp_jobs ADD COLUMN IF NOT EXISTS after_prefix text;
-- The hold looks up a chat's LIVE jobs; keep that an index probe.
CREATE INDEX IF NOT EXISTS scheduled_whatsapp_jobs_live_by_chat_idx
  ON public.scheduled_whatsapp_jobs (chat_wid) WHERE status IN ('queued', 'running');

-- The enqueue gains a 10th, defaulted argument. Drop the 9-arg form first — two
-- overloads that both accept 9 named arguments would be ambiguous to PostgREST.
DROP FUNCTION IF EXISTS public.scheduled_whatsapp_enqueue(text, text, text, text, jsonb, text, timestamptz, uuid, uuid);

CREATE FUNCTION public.scheduled_whatsapp_enqueue(
  p_device_id text, p_chat_wid text, p_phone text, p_body text, p_media jsonb,
  p_reference text, p_deliver_at timestamptz, p_user_id uuid,
  p_project_id uuid DEFAULT NULL, p_after_prefix text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.scheduled_whatsapp_jobs
    (device_id, chat_wid, phone, body, media, reference, deliver_at, created_by_user_id, project_id, after_prefix)
  VALUES
    (p_device_id, p_chat_wid, p_phone, p_body, COALESCE(p_media, '[]'::jsonb),
     p_reference, p_deliver_at, p_user_id, p_project_id, NULLIF(p_after_prefix, ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_enqueue(text, text, text, text, jsonb, text, timestamptz, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_enqueue(text, text, text, text, jsonb, text, timestamptz, uuid, uuid, text) TO service_role;

-- Claim: unchanged except the hold. `left(reference, length(prefix)) = prefix`
-- rather than LIKE, so a '_' or '%' in a reference can never act as a wildcard.
CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_claim_due(p_worker_id text, p_limit integer DEFAULT 5)
 RETURNS TABLE(job_id uuid, device_id text, chat_wid text, phone text, body text, media jsonb, reference text, attempts integer, project_id uuid)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  UPDATE public.scheduled_whatsapp_jobs
     SET status     = 'running',
         worker_id  = p_worker_id,
         started_at = now(),
         attempts   = scheduled_whatsapp_jobs.attempts + 1
   WHERE id IN (
     SELECT j.id
       FROM public.scheduled_whatsapp_jobs j
      WHERE j.status = 'queued'
        AND j.deliver_at <= now()
        AND (j.after_prefix IS NULL
             OR j.deliver_at < now() - interval '10 minutes'
             OR NOT EXISTS (
               SELECT 1 FROM public.scheduled_whatsapp_jobs x
                WHERE x.chat_wid = j.chat_wid
                  AND x.id <> j.id
                  AND x.status IN ('queued', 'running')
                  AND left(x.reference, length(j.after_prefix)) = j.after_prefix))
      ORDER BY j.deliver_at
      FOR UPDATE OF j SKIP LOCKED
      LIMIT GREATEST(p_limit, 1)
   )
   RETURNING id, device_id, chat_wid, phone, body, media, reference, attempts, project_id;
$function$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_claim_due(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_claim_due(text, integer) TO service_role;
