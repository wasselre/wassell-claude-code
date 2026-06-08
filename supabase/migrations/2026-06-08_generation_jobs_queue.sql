-- ============================================================================
-- 2026-06-08: generation_jobs queue for per-message, concurrent image generation
-- ----------------------------------------------------------------------------
-- Image Chats v2. Replaces the synchronous, conversation-blocking
-- `POST /api/image-chat/send` (which awaited the full ~300s fal.ai call and
-- locked the whole conversation) with a Postgres-backed job queue drained by
-- the existing Fly.io worker — the SAME pattern as deck_jobs
-- (2026-05-17_deck_jobs_queue.sql), with two deliberate differences:
--
--   1. PER-MESSAGE, not per-record. Each user turn appends an assistant
--      PLACEHOLDER message (status='queued') to records.data.messages and
--      enqueues ONE generation_jobs row that fills exactly that message
--      (keyed by message_id). Many jobs run concurrently; the composer never
--      blocks. The watchdog/cancel paths patch ONLY their own message — the
--      conversation is never globally failed.
--
--   2. MEDIA-GENERIC. `kind` ('image' now; room for 'video'/'audio') so the
--      same queue + worker can host future generators (Image Chats v2 Part 6).
--
-- Flow:
--   1. POST /api/image-chat/send (slim, nodejs, ≤60s) validates auth + input,
--      resolves attachments under the caller's JWT, appends the user message
--      + assistant placeholder via record_save (SERVER-SIDE — not the browser
--      store, so the realtime echo-dedup never suppresses it), inserts one
--      generation_jobs row (service-role), best-effort /wake's the worker, and
--      returns 202 { job_id, message_id }.
--   2. The Fly.io worker's image poll loop claims via generation_job_claim_next
--      (FOR UPDATE SKIP LOCKED), runs fal.ai, re-hosts outputs to
--      marketing-assets, and patches the assistant message in place
--      (status='completed' + images) via record_save.
--   3. The SPA receives the record update via Supabase Realtime — the
--      placeholder fills in with no refresh, even if the user is viewing a
--      different conversation.
--   4. generation_jobs_watchdog() sweeps jobs stuck in 'running' >15 min and
--      marks the affected message failed so its spinner exits.
--
-- Auth: worker uses the service-role key (writes bypass RLS). It enforces
-- ownership by reading the record's created_by_user_id and comparing against
-- the job's user_id before writing back (see worker/src/runImageJob.ts).
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- Table
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.generation_jobs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The image_chats conversation (in public.records) this job writes into.
  -- CASCADE so deleting the conversation cancels any queued/running job.
  record_id    uuid        NOT NULL REFERENCES public.records(id) ON DELETE CASCADE,
  -- The assistant placeholder message (records.data.messages[*].id) this job
  -- fills. Text, because message ids are crypto.randomUUID() strings in JSONB.
  message_id   text        NOT NULL,
  -- auth.users id of the submitter. Worker validates ownership against the
  -- record's created_by_user_id before writing back.
  user_id      uuid        NOT NULL,
  -- Media type. 'image' today; 'video'/'audio' reserved for Part 6 so the
  -- same queue + worker hosts future generators without a schema change.
  kind         text        NOT NULL DEFAULT 'image'
                           CHECK (kind IN ('image','video','audio')),
  status       text        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','completed','failed','cancelled')),
  attempts     int         NOT NULL DEFAULT 0,
  -- Final merged prompt (brand-preset text + the user's prompt).
  prompt       text,
  -- Frozen request snapshot so user edits between enqueue and claim can't
  -- drift the generation:
  --   { aspect_ratio, num_variations, model_id,
  --     attachments: [{ url, source }], prev_image_url, preset_id, preset_name }
  params       jsonb       NOT NULL,
  -- On success: { images: [{ url, name, source }] }.
  result       jsonb,
  -- Worker process that claimed the job (debugging when >1 machine runs).
  worker_id    text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

-- ────────────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────────────
-- Hot path: the worker's claim query —
--   SELECT ... WHERE status='queued' AND kind=? ORDER BY created_at
--   FOR UPDATE SKIP LOCKED. Partial index keeps it tiny (in-flight tail only).
CREATE INDEX IF NOT EXISTS generation_jobs_queued_by_age_idx
  ON public.generation_jobs (kind, created_at)
  WHERE status = 'queued';

-- Watchdog hot path: find stale running jobs every tick.
CREATE INDEX IF NOT EXISTS generation_jobs_running_by_started_idx
  ON public.generation_jobs (started_at)
  WHERE status = 'running';

-- Per-record lookup (in-flight count for the optional server-side cap; latest
-- job for a conversation).
CREATE INDEX IF NOT EXISTS generation_jobs_record_idx
  ON public.generation_jobs (record_id, created_at DESC);

-- Per-message lookup (cancel/retry/debug by the message a job fills).
CREATE INDEX IF NOT EXISTS generation_jobs_message_idx
  ON public.generation_jobs (message_id);

-- Per-user lookup (debugging / future "my jobs" admin view).
CREATE INDEX IF NOT EXISTS generation_jobs_user_idx
  ON public.generation_jobs (user_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.generation_jobs ENABLE ROW LEVEL SECURITY;

-- Users can only SELECT their own jobs (so the SPA can read job status if it
-- ever needs to). They cannot insert/update/delete directly — the API
-- endpoint (service role) inserts, the worker (service role) updates, cancel
-- goes through the owner-gated generation_job_cancel RPC, and CASCADE on the
-- record handles delete.
DROP POLICY IF EXISTS "generation_jobs_owner_select" ON public.generation_jobs;
CREATE POLICY "generation_jobs_owner_select"
  ON public.generation_jobs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- RPC: generation_job_claim_next
-- ----------------------------------------------------------------------
-- Atomically claims the oldest queued job of the given kind for the calling
-- worker. FOR UPDATE SKIP LOCKED so multiple worker loops/machines never
-- claim the same row. Returns 0 rows if the queue (for that kind) is empty.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generation_job_claim_next(
  p_worker_id text,
  p_kind      text DEFAULT 'image'
)
RETURNS TABLE (
  job_id      uuid,
  record_id   uuid,
  message_id  text,
  user_id     uuid,
  kind        text,
  prompt      text,
  params      jsonb,
  attempts    int
) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.generation_jobs
     SET status     = 'running',
         worker_id  = p_worker_id,
         started_at = now(),
         attempts   = generation_jobs.attempts + 1
   WHERE id = (
     SELECT id
       FROM public.generation_jobs
      WHERE status = 'queued'
        AND kind = p_kind
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
   RETURNING id, record_id, message_id, user_id, kind, prompt, params, attempts;
$$;

REVOKE ALL ON FUNCTION public.generation_job_claim_next(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generation_job_claim_next(text, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: generation_job_complete
-- ----------------------------------------------------------------------
-- Marks a running job completed. Guarded by status='running' so a late finish
-- after the watchdog already failed it (or the user cancelled it) is a no-op,
-- not an overwrite — same race-protection posture as deck_job_complete.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generation_job_complete(p_job_id uuid, p_result jsonb)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.generation_jobs
       SET status      = 'completed',
           finished_at = now(),
           result      = p_result,
           error       = NULL
     WHERE id = p_job_id
       AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.generation_job_complete(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generation_job_complete(uuid, jsonb) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: generation_job_fail
-- ----------------------------------------------------------------------
-- Marks a running job failed with an error. Same status='running' guard.
-- (The worker patches the assistant message to status='failed' itself before
-- calling this — see runImageJob.ts — so the UI exits its spinner via
-- Realtime. This RPC just closes the job row.)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generation_job_fail(p_job_id uuid, p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  WITH updated AS (
    UPDATE public.generation_jobs
       SET status      = 'failed',
           finished_at = now(),
           error       = p_error
     WHERE id = p_job_id
       AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

REVOKE ALL ON FUNCTION public.generation_job_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generation_job_fail(uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: generation_job_cancel
-- ----------------------------------------------------------------------
-- User-initiated cancel of a queued or running job. SECURITY DEFINER (bypasses
-- RLS) but OWNER-GATED in-function (user_id = auth.uid()). Transitions
-- queued|running → cancelled AND patches the assistant message in
-- records.data.messages to status='cancelled' (with a fresh updated_at so the
-- realtime merge accepts it) — so the bubble updates purely via Realtime.
--
-- Returns the PRIOR status on success, or NULL if the job doesn't exist / the
-- caller doesn't own it. Already-terminal jobs (completed/failed/cancelled)
-- return their status unchanged and are not re-patched.
--
-- Race note: if the worker calls generation_job_complete first, that wins (the
-- row is 'completed'); this function's status IN ('queued','running') check
-- then makes cancel a no-op and the user keeps the finished image.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generation_job_cancel(p_job_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_status  text;
  v_record  uuid;
  v_message text;
BEGIN
  SELECT status, record_id, message_id
    INTO v_status, v_record, v_message
    FROM public.generation_jobs
   WHERE id = p_job_id
     AND user_id = auth.uid()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;                         -- not found / not the caller's job
  END IF;
  IF v_status NOT IN ('queued','running') THEN
    RETURN v_status;                     -- already terminal — no-op
  END IF;

  UPDATE public.generation_jobs
     SET status = 'cancelled', finished_at = now()
   WHERE id = p_job_id;

  UPDATE public.records r
     SET data = jsonb_set(r.data, '{messages}', (
           SELECT jsonb_agg(
             CASE WHEN msg->>'id' = v_message
                  THEN msg || jsonb_build_object('status','cancelled')
                  ELSE msg END)
           FROM jsonb_array_elements(r.data->'messages') AS msg
         ), true),
         updated_at = now()
   WHERE r.id = v_record
     AND r.data ? 'messages';

  RETURN v_status;                        -- prior status (queued|running)
END;
$$;

REVOKE ALL ON FUNCTION public.generation_job_cancel(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generation_job_cancel(uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Watchdog
-- ----------------------------------------------------------------------
-- Flips any job stuck in 'running' for >15 min to 'failed' AND patches ONLY
-- the affected assistant message(s) to status='failed' (with a fresh
-- updated_at) so their spinners exit via Realtime — the rest of the
-- conversation (and the composer) is untouched. 15 min is well above any
-- realistic fal.ai run (Nano Banana ~30-90s; GPT Image 2 routinely 3-5 min,
-- pathological ~8 min); it's a backstop for worker crashes / fly machine stop.
--
-- Multiple stale jobs in the SAME conversation are grouped per record so one
-- record UPDATE patches all of their messages (UPDATE ... FROM with a 1:N join
-- would otherwise patch only one).
--
-- pg_cron is NOT enabled on wassell-prod, so the schedule block below is a
-- no-op and the Fly.io worker invokes this every WATCHDOG_INTERVAL_MS itself
-- (see worker/src/index.ts). Also callable manually from the SQL editor.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generation_jobs_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count int  := 0;
  v_msg   text := 'watchdog: generation did not finish within 15 minutes — likely crashed mid-run. Press Retry to try again.';
BEGIN
  WITH stale AS (
    UPDATE public.generation_jobs
       SET status      = 'failed',
           finished_at = now(),
           error       = v_msg
     WHERE status = 'running'
       AND started_at < now() - interval '15 minutes'
    RETURNING id, record_id, message_id
  ),
  -- Group stale message ids per record so each record is patched once and ALL
  -- its stale messages flip to failed.
  by_record AS (
    SELECT record_id, array_agg(message_id) AS msg_ids
      FROM stale
     GROUP BY record_id
  ),
  recs AS (
    UPDATE public.records r
       SET data = jsonb_set(r.data, '{messages}', (
             SELECT jsonb_agg(
               CASE WHEN msg->>'id' = ANY(b.msg_ids)
                    THEN msg || jsonb_build_object('status','failed','error',v_msg)
                    ELSE msg END)
             FROM jsonb_array_elements(r.data->'messages') AS msg
           ), true),
           updated_at = now()
      FROM by_record b
     WHERE r.id = b.record_id
       AND r.data ? 'messages'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM stale;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.generation_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generation_jobs_watchdog() TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- pg_cron schedule (best-effort — extension not enabled on this Supabase)
-- ----------------------------------------------------------------------
-- No-op on wassell-prod (pg_cron not installed); the Fly.io worker runs
-- generation_jobs_watchdog() on its own interval instead.
-- ────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('generation_jobs_watchdog');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule(
      'generation_jobs_watchdog',
      '*/5 * * * *',
      $cmd$SELECT public.generation_jobs_watchdog();$cmd$
    );
  END IF;
END $$;

COMMIT;
