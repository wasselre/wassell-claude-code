-- Broker portal: "send the project to your client" from Wassel's sales line.
--
-- A broker on /brokers/:token types their client's phone; the API queues the
-- project message + brochure + photos on the sales WhatsApp line (the same
-- sendProjectViaAiFlow the bot uses). Every one of those is a message to a
-- NUMBER THAT HAS NEVER TALKED TO US — exactly the traffic WhatsApp restricts
-- (463 cold-outreach lock) and bans. So the limits live HERE, in one row-locked
-- claim, not in the page:
--   * portal switch (send_enabled) + a daily cap per portal (daily_send_cap)
--   * the same client + project at most once per 24 h
--   * one client phone at most 3 projects per 24 h
--   * one device/IP (hashed) at most 10 sends per hour
-- Every attempt is logged in broker_portal_sends (who, to whom, outcome).

BEGIN;

ALTER TABLE public.broker_portals
  ADD COLUMN IF NOT EXISTS send_enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS daily_send_cap integer NOT NULL DEFAULT 20;

CREATE TABLE IF NOT EXISTS public.broker_portal_sends (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_id    uuid NOT NULL REFERENCES public.broker_portals(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL,
  client_phone text NOT NULL,
  client_name  text,
  broker_name  text NOT NULL,
  broker_phone text,
  lang         text NOT NULL DEFAULT 'ar',
  ip_hash      text,
  status       text NOT NULL DEFAULT 'claimed',   -- claimed | queued | failed
  error        text,
  media_queued integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS broker_portal_sends_portal_idx ON public.broker_portal_sends (portal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS broker_portal_sends_phone_idx  ON public.broker_portal_sends (client_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS broker_portal_sends_ip_idx     ON public.broker_portal_sends (ip_hash, created_at DESC);

ALTER TABLE public.broker_portal_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS broker_portal_sends_admin_read ON public.broker_portal_sends;
CREATE POLICY broker_portal_sends_admin_read ON public.broker_portal_sends
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));
REVOKE ALL ON public.broker_portal_sends FROM anon;

-- Atomic claim. Returns (ok, reason, send_id). Reasons are stable slugs the
-- page translates. Never raises a retryable SQLSTATE (see CLAUDE.md).
CREATE OR REPLACE FUNCTION public.broker_portal_send_claim(
  p_portal_id uuid, p_project_id uuid, p_client_phone text, p_client_name text,
  p_broker_name text, p_broker_phone text, p_lang text, p_ip_hash text
) RETURNS TABLE (ok boolean, reason text, send_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal public.broker_portals%ROWTYPE;
  v_id uuid;
BEGIN
  -- Serialize claims per portal so the daily cap cannot be raced past.
  SELECT * INTO v_portal FROM public.broker_portals WHERE id = p_portal_id FOR UPDATE;
  IF NOT FOUND OR NOT v_portal.is_active OR (v_portal.expires_at IS NOT NULL AND v_portal.expires_at < now()) THEN
    RETURN QUERY SELECT false, 'portal_unavailable'::text, NULL::uuid; RETURN;
  END IF;
  IF NOT v_portal.send_enabled THEN
    RETURN QUERY SELECT false, 'sending_disabled'::text, NULL::uuid; RETURN;
  END IF;
  IF (SELECT count(*) FROM public.broker_portal_sends s
       WHERE s.portal_id = p_portal_id AND s.status <> 'failed'
         AND s.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')
     >= v_portal.daily_send_cap THEN
    RETURN QUERY SELECT false, 'daily_cap'::text, NULL::uuid; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.broker_portal_sends s
              WHERE s.client_phone = p_client_phone AND s.project_id = p_project_id
                AND s.status <> 'failed' AND s.created_at > now() - interval '24 hours') THEN
    RETURN QUERY SELECT false, 'already_sent'::text, NULL::uuid; RETURN;
  END IF;
  IF (SELECT count(*) FROM public.broker_portal_sends s
       WHERE s.client_phone = p_client_phone AND s.status <> 'failed'
         AND s.created_at > now() - interval '24 hours') >= 3 THEN
    RETURN QUERY SELECT false, 'phone_limit'::text, NULL::uuid; RETURN;
  END IF;
  IF p_ip_hash IS NOT NULL AND (SELECT count(*) FROM public.broker_portal_sends s
       WHERE s.ip_hash = p_ip_hash AND s.created_at > now() - interval '1 hour') >= 10 THEN
    RETURN QUERY SELECT false, 'rate_limited'::text, NULL::uuid; RETURN;
  END IF;

  INSERT INTO public.broker_portal_sends
    (portal_id, project_id, client_phone, client_name, broker_name, broker_phone, lang, ip_hash)
  VALUES (p_portal_id, p_project_id, p_client_phone, NULLIF(btrim(p_client_name), ''),
          btrim(p_broker_name), NULLIF(btrim(p_broker_phone), ''), COALESCE(p_lang, 'ar'), p_ip_hash)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT true, NULL::text, v_id;
END $$;

CREATE OR REPLACE FUNCTION public.broker_portal_send_finish(
  p_send_id uuid, p_status text, p_error text, p_media_queued integer
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.broker_portal_sends
     SET status = p_status, error = p_error, media_queued = p_media_queued
   WHERE id = p_send_id;
$$;

REVOKE ALL ON FUNCTION public.broker_portal_send_claim(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.broker_portal_send_finish(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broker_portal_send_claim(uuid, uuid, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.broker_portal_send_finish(uuid, text, text, integer) TO service_role;

COMMIT;
