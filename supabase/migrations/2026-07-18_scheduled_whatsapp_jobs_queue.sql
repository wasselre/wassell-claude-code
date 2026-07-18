-- ============================================================================
-- 2026-07-18: scheduled_whatsapp_jobs — Wassell-owned scheduled-send queue
-- ----------------------------------------------------------------------------
-- WAHA has NO server-side scheduled sends (no deliverAt / queue / cancel — the
-- one confirmed functional gap vs Haberchat, per the 2026-07-18 evaluation). So
-- for WAHA numbers we hold scheduled messages ourselves and fire them at the due
-- time from the always-on Fly worker — the 8th queue on that worker, same
-- pattern as data_migration_jobs / generation_jobs / document_jobs.
--
-- Haberchat numbers keep using Haberchat's native deliverAt queue (untouched);
-- ONLY WAHA numbers route through this table. The SPA's scheduled-message strip
-- dispatches by provider (Haberchat listQueuedMessages vs this table's
-- _list_for_chat) behind the same ScheduledChatMessage shape, so the UI is
-- unchanged.
--
-- Claim model mirrors scheduled_report_claim_due: a TIME-GATED claim that only
-- returns rows whose deliver_at has passed, with FOR UPDATE SKIP LOCKED so the
-- 5-machine worker fleet never double-claims. Media rides as a jsonb array so a
-- text + gallery scheduled send is one row; the worker sends the text then the
-- media (matching sendProjectImageMessages' +10s stagger at delivery time).
--
-- Auth: enqueue is called by /api/whatsapp/schedule after RLS-gating the caller;
-- claim/complete/fail/cancel/list/watchdog are service-role only (worker + the
-- scheduled proxy). RLS lets a user SELECT their own rows for good measure, but
-- the SPA reads the strip via the service-role _list_for_chat proxy (parity with
-- Haberchat, where any team member sees a chat's queued messages).
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- Table
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduled_whatsapp_jobs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- WAHA session name (== whatsapp_numbers.device_id for the WAHA number).
  device_id           text        NOT NULL,
  -- Conversation wid, e.g. "9665...@c.us". Kept so the worker sends to the exact
  -- chat and the strip can filter by conversation.
  chat_wid            text        NOT NULL,
  -- Recipient E.164 (digits filtered for the strip lookup).
  phone               text,
  body                text,
  -- Array of { fileId?, url?, kind: 'image'|'video'|'audio'|'document', caption? }
  -- fileId  = a temp Supabase-Storage ref produced by the WAHA uploadFile adapter
  -- url     = a directly-sendable public URL (project/listing gallery items)
  media               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Optimistic-send correlation key echoed by the webhook (same role as on the
  -- Haberchat send path).
  reference           text,
  deliver_at          timestamptz NOT NULL,
  status              text        NOT NULL DEFAULT 'queued'
                                  CHECK (status IN ('queued','running','sent','failed','cancelled')),
  attempts            int         NOT NULL DEFAULT 0,
  -- auth.users id of the scheduler (RLS owner scope + audit).
  created_by_user_id  uuid        NOT NULL,
  result              jsonb,
  error_message       text,
  worker_id           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz
);

-- ────────────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────────────
-- Worker DUE-claim hot path: soonest-due queued rows. Ordering by deliver_at so
-- claim_due pulls the earliest overdue message first.
CREATE INDEX IF NOT EXISTS scheduled_whatsapp_jobs_due_idx
  ON public.scheduled_whatsapp_jobs (deliver_at)
  WHERE status = 'queued';

-- Watchdog hot path.
CREATE INDEX IF NOT EXISTS scheduled_whatsapp_jobs_running_by_started_idx
  ON public.scheduled_whatsapp_jobs (started_at)
  WHERE status = 'running';

-- Strip lookup: queued messages for one conversation (device + chat).
CREATE INDEX IF NOT EXISTS scheduled_whatsapp_jobs_chat_idx
  ON public.scheduled_whatsapp_jobs (device_id, chat_wid)
  WHERE status = 'queued';

-- Per-user (RLS reads / audit).
CREATE INDEX IF NOT EXISTS scheduled_whatsapp_jobs_user_idx
  ON public.scheduled_whatsapp_jobs (created_by_user_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────
-- RLS — owner SELECT; all writes service-role (proxy enqueues, worker updates).
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.scheduled_whatsapp_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scheduled_whatsapp_jobs_owner_select" ON public.scheduled_whatsapp_jobs;
CREATE POLICY "scheduled_whatsapp_jobs_owner_select"
  ON public.scheduled_whatsapp_jobs FOR SELECT
  TO authenticated
  USING (created_by_user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- RPC: scheduled_whatsapp_enqueue — one row per scheduled send.
-- (No one-active-per-record collapse: multiple scheduled messages per chat are
-- legitimate, exactly like Haberchat's queue.)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_enqueue(
  p_device_id  text,
  p_chat_wid   text,
  p_phone      text,
  p_body       text,
  p_media      jsonb,
  p_reference  text,
  p_deliver_at timestamptz,
  p_user_id    uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.scheduled_whatsapp_jobs
    (device_id, chat_wid, phone, body, media, reference, deliver_at, created_by_user_id)
  VALUES
    (p_device_id, p_chat_wid, p_phone, p_body, COALESCE(p_media, '[]'::jsonb),
     p_reference, p_deliver_at, p_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_enqueue(text, text, text, text, jsonb, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_enqueue(text, text, text, text, jsonb, text, timestamptz, uuid) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: scheduled_whatsapp_claim_due — atomically claim up to p_limit rows whose
-- deliver_at has passed. FOR UPDATE SKIP LOCKED so the worker fleet never
-- double-claims. Returns 0 rows when nothing is due.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_claim_due(p_worker_id text, p_limit int DEFAULT 5)
RETURNS TABLE (
  job_id     uuid,
  device_id  text,
  chat_wid   text,
  phone      text,
  body       text,
  media      jsonb,
  reference  text,
  attempts   int
) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.scheduled_whatsapp_jobs
     SET status     = 'running',
         worker_id  = p_worker_id,
         started_at = now(),
         attempts   = scheduled_whatsapp_jobs.attempts + 1
   WHERE id IN (
     SELECT id
       FROM public.scheduled_whatsapp_jobs
      WHERE status = 'queued'
        AND deliver_at <= now()
      ORDER BY deliver_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(p_limit, 1)
   )
   RETURNING id, device_id, chat_wid, phone, body, media, reference, attempts;
$$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_claim_due(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_claim_due(text, int) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: _complete / _fail — guarded by status='running' so a late finish after
-- a cancel/watchdog is a harmless no-op.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_complete(p_job_id uuid, p_result jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.scheduled_whatsapp_jobs
       SET status = 'sent', finished_at = now(), result = p_result, error_message = NULL
     WHERE id = p_job_id AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_complete(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_complete(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_fail(p_job_id uuid, p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.scheduled_whatsapp_jobs
       SET status = 'failed', finished_at = now(), error_message = p_error
     WHERE id = p_job_id AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_fail(uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: _cancel — cancel a still-queued message (the strip's per-chip cancel).
-- Only queued rows are cancelable; a running/sent row returns false so the strip
-- re-syncs (it may already be delivering), matching the Haberchat cancel posture.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_cancel(p_job_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.scheduled_whatsapp_jobs
       SET status = 'cancelled', finished_at = now()
     WHERE id = p_job_id AND status = 'queued'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_cancel(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_cancel(uuid) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: _list_for_chat — the SPA strip's live read of queued messages for one
-- conversation. Service-role (called by the scheduled proxy after withAuth),
-- returns the ScheduledChatMessage shape. Phone filter is digits-only so
-- "+9665…" and "9665…" match, mirroring listQueuedMessages.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_list_for_chat(p_device_id text, p_chat_wid text)
RETURNS TABLE (
  id          uuid,
  phone       text,
  body        text,
  deliver_at  timestamptz,
  created_at  timestamptz,
  has_media   boolean
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, phone, body, deliver_at, created_at,
         (jsonb_array_length(COALESCE(media, '[]'::jsonb)) > 0) AS has_media
    FROM public.scheduled_whatsapp_jobs
   WHERE device_id = p_device_id
     AND chat_wid  = p_chat_wid
     AND status    = 'queued'
   ORDER BY deliver_at;
$$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_list_for_chat(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_list_for_chat(text, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Watchdog — sweep jobs stuck 'running' >15 min (worker crash mid-send) to
-- 'failed'. 15 min is well above the worst-case text+gallery staggered run.
-- The Fly worker invokes this on its watchdog interval (pg_cron NOT enabled).
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH swept AS (
    UPDATE public.scheduled_whatsapp_jobs
       SET status = 'failed', finished_at = now(),
           error_message = 'Send worker did not finish within 15 minutes — likely crashed mid-send.'
     WHERE status = 'running'
       AND started_at < now() - interval '15 minutes'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM swept;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.scheduled_whatsapp_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_whatsapp_watchdog() TO service_role;

-- pg_cron schedule (best-effort — extension NOT enabled on wassell-prod, so this
-- is a no-op; the Fly worker calls scheduled_whatsapp_watchdog() on its interval).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('scheduled_whatsapp_watchdog');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule(
      'scheduled_whatsapp_watchdog',
      '*/5 * * * *',
      $cmd$SELECT public.scheduled_whatsapp_watchdog();$cmd$
    );
  END IF;
END $$;

COMMIT;
