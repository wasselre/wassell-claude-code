-- Unit-PDF send queue — the basic WhatsApp bot's "customer sent a unit code →
-- send that unit's PDF one-pager" lane. The bot cannot render a PDF (no browser
-- server-side), so it ENQUEUES here and the Fly worker renders the exact rep
-- one-pager with headless Chromium, uploads it to wassel-files, and sends it over
-- WhatsApp via the existing scheduled_whatsapp_enqueue path. Same shape/rationale
-- as the other worker queues (generation_jobs, file_preview_jobs, …).
--
-- Service-role only (the bot enqueues with the shared secret; the worker drains).

CREATE TABLE IF NOT EXISTS public.unit_pdf_jobs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The units record (public.records id) to render. Resolved by the bot from the
  -- unit_code the customer sent, so a stale/renamed code can't drift the render.
  unit_id      uuid        NOT NULL,
  unit_code    text,
  -- Where to send it.
  chat_wid     text        NOT NULL,
  phone        text,
  device_id    text,
  -- Language for the intro line + PDF (the customer's message language).
  lang         text        NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  status       text        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','completed','failed','cancelled')),
  attempts     int         NOT NULL DEFAULT 0,
  result       jsonb,
  error        text,
  worker_id    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

-- Worker DUE-claim hot path: oldest queued first.
CREATE INDEX IF NOT EXISTS unit_pdf_jobs_claim_idx
  ON public.unit_pdf_jobs (created_at) WHERE status = 'queued';
-- Dedup guard: at most one active job per (chat, unit) so a double-send of the
-- same code doesn't render+send twice.
CREATE UNIQUE INDEX IF NOT EXISTS unit_pdf_jobs_active_uniq
  ON public.unit_pdf_jobs (chat_wid, unit_id) WHERE status IN ('queued','running');

ALTER TABLE public.unit_pdf_jobs ENABLE ROW LEVEL SECURITY;
-- No policies: only service-role (which bypasses RLS) touches this table.

-- ── enqueue ────────────────────────────────────────────────────────────────
-- Returns the job id, or NULL when an active job for this (chat, unit) already
-- exists (dedup — turning a duplicate away is free, the bot just moves on).
CREATE OR REPLACE FUNCTION public.unit_pdf_job_enqueue(
  p_unit_id   uuid,
  p_unit_code text,
  p_chat_wid  text,
  p_phone     text,
  p_device_id text,
  p_lang      text DEFAULT 'ar'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.unit_pdf_jobs (unit_id, unit_code, chat_wid, phone, device_id, lang)
  VALUES (p_unit_id, p_unit_code, p_chat_wid, p_phone, p_device_id,
          CASE WHEN p_lang = 'en' THEN 'en' ELSE 'ar' END)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;  -- NULL when the dedup unique index blocked the insert
END $$;
REVOKE ALL ON FUNCTION public.unit_pdf_job_enqueue(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unit_pdf_job_enqueue(uuid, text, text, text, text, text) TO service_role;

-- ── claim_next ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unit_pdf_job_claim_next(p_worker_id text)
RETURNS SETOF public.unit_pdf_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.unit_pdf_jobs j
     SET status = 'running', attempts = j.attempts + 1,
         worker_id = p_worker_id, started_at = now()
   WHERE j.id = (
     SELECT id FROM public.unit_pdf_jobs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING j.*;
END $$;
REVOKE ALL ON FUNCTION public.unit_pdf_job_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unit_pdf_job_claim_next(text) TO service_role;

-- ── complete / fail — only touch a 'running' row (worker vs watchdog race) ───
CREATE OR REPLACE FUNCTION public.unit_pdf_job_complete(p_job_id uuid, p_result jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.unit_pdf_jobs
     SET status = 'completed', result = p_result, finished_at = now()
   WHERE id = p_job_id AND status = 'running';
END $$;
REVOKE ALL ON FUNCTION public.unit_pdf_job_complete(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unit_pdf_job_complete(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.unit_pdf_job_fail(p_job_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.unit_pdf_jobs
     SET status = 'failed', error = p_error, finished_at = now()
   WHERE id = p_job_id AND status = 'running';
END $$;
REVOKE ALL ON FUNCTION public.unit_pdf_job_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unit_pdf_job_fail(uuid, text) TO service_role;

-- ── watchdog — sweep jobs stuck 'running' > 10 min (well above a ~30s render) ──
CREATE OR REPLACE FUNCTION public.unit_pdf_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.unit_pdf_jobs
     SET status = 'failed', error = 'watchdog: stuck running > 10 min', finished_at = now()
   WHERE status = 'running' AND started_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.unit_pdf_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unit_pdf_jobs_watchdog() TO service_role;
