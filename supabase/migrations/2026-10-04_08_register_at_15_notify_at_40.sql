-- Two thresholds (operator, 2026-10-04): "15+ should result in registering,
-- 40+ results in notifying."
--
--   · portal_score_threshold (15): a client × project whose interest score
--     (v_client_project_interest) reaches it gets a high-interest EVENT, which
--     the 5-minute cron turns into an automatic portal registration.
--   · interest_score_threshold (40, unchanged column): the officer is told only
--     when the pair's CURRENT score reaches it — or the event came from the AI's
--     reading of a follow-up (interested / booked / offer + a main project).
--     v_interest_officer_due lists exactly those events; an event below 40 waits
--     there (officer_done_at stays NULL) and is drafted the tick its score
--     reaches 40.
--
-- Also: 5 portal registrations still said 'failed' for runs that the portal
-- refused as "already registered" before that status existed (2026-09-29).
-- Our own records show no registration by us for them, so they are another
-- broker's: corrected to 'already_registered' so they are not retried.
--
-- security_invoker on the new view + assertion. No 40001/40P01.

BEGIN;

ALTER TABLE public.ai_automation_settings
  ADD COLUMN IF NOT EXISTS portal_score_threshold integer NOT NULL DEFAULT 15;

DROP VIEW IF EXISTS public.v_interest_officer_due;
CREATE VIEW public.v_interest_officer_due WITH (security_invoker = true) AS
SELECT x.id, x.client_id, x.project_id, x.source, x.chat_wid, x.detected_at,
       COALESCE(i.score, x.score) AS score
  FROM public.client_project_interest x
  LEFT JOIN public.v_client_project_interest i ON i.client_id = x.client_id AND i.project_id = x.project_id
 WHERE x.officer_done_at IS NULL
   AND (x.source = 'ai_outcome'
        OR COALESCE(i.score, x.score, 0) >= COALESCE((SELECT interest_score_threshold FROM public.ai_automation_settings WHERE id = 1), 40));

ALTER VIEW public.v_interest_officer_due SET (security_invoker = true);
REVOKE ALL ON public.v_interest_officer_due FROM anon, authenticated;
GRANT SELECT ON public.v_interest_officer_due TO service_role;

DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_interest_officer_due';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_interest_officer_due — options are %', v_opts;
  END IF;
END $assert$;

-- Stale "failed" rows that were really "already registered" (another broker's).
UPDATE public.client_portal_registrations r
   SET our_status = 'already_registered', updated_at = now()
  FROM public.portal_registration_jobs j
 WHERE j.id = r.last_job_id
   AND r.our_status = 'failed'
   AND r.registered_at IS NULL
   AND (j.error_message LIKE '%مسجّل بالفعل%' OR j.error_message ILIKE '%already registered%');

COMMIT;
