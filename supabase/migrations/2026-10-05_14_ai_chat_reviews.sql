-- ============================================================================
-- Daily review of the AI agent's WhatsApp work (operator, 2026-10-05).
--
-- The sales agent no longer works WhatsApp tasks — the AI does. Their WhatsApp
-- job is two start-of-day tasks: approve the AI's drafted messages, and review
-- every client chat the AI replied in since the last review (read the whole
-- chat in a pop-up, rate 1–5, note any issue).
--
-- ai_review_tick() — run by the 5-minute AI cron. On a working day after
-- 08:00 Riyadh it lists, ONCE, every client chat with an AI-sent message
-- (chat_messages.send_source = 'ai') since the previous run's window end
-- (first run: the last 24 h) — so Sunday's list covers Thursday evening to
-- Sunday morning. One row per chat per review day, assigned to the campaign
-- agent (else the default rep).
-- ai_chat_review_submit(id, rating, note) — the reviewer (or an admin) closes it.
-- ============================================================================

BEGIN;

ALTER TABLE public.sales_call_campaign_settings
  ADD COLUMN IF NOT EXISTS review_enabled         boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_review_run        date,
  ADD COLUMN IF NOT EXISTS last_review_window_end timestamptz;

CREATE TABLE IF NOT EXISTS public.ai_chat_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_day       date NOT NULL,
  chat_wid         text NOT NULL,
  chat_record_id   uuid,
  client_id        uuid,
  reviewer_user_id uuid,
  window_start     timestamptz NOT NULL,
  window_end       timestamptz NOT NULL,
  ai_messages      int NOT NULL DEFAULT 0,
  last_ai_at       timestamptz,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  rating           int CHECK (rating BETWEEN 1 AND 5),
  note             text,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_day, chat_wid)
);
CREATE INDEX IF NOT EXISTS ai_chat_reviews_pending ON public.ai_chat_reviews (reviewer_user_id, review_day) WHERE status = 'pending';
ALTER TABLE public.ai_chat_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_chat_reviews_read ON public.ai_chat_reviews;
CREATE POLICY ai_chat_reviews_read ON public.ai_chat_reviews
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid()))
         OR reviewer_user_id = public.wassell_app_user_id((SELECT auth.uid())));
REVOKE ALL ON public.ai_chat_reviews FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.ai_chat_reviews FROM authenticated;

CREATE OR REPLACE FUNCTION public.ai_review_tick()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  s         public.sales_call_campaign_settings%ROWTYPE;
  v_today   date := (now() AT TIME ZONE 'Asia/Riyadh')::date;
  v_from    timestamptz;
  v_to      timestamptz := now();
  v_rev     uuid;
  v_chats   uuid := (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1);
  v_n       int;
BEGIN
  SELECT * INTO s FROM public.sales_call_campaign_settings WHERE id = 1 FOR UPDATE;
  IF NOT FOUND OR NOT s.review_enabled THEN RETURN jsonb_build_object('skipped', 'disabled'); END IF;
  IF NOT (extract(dow FROM v_today)::int = ANY (s.working_days)) THEN RETURN jsonb_build_object('skipped', 'not_a_working_day'); END IF;
  IF (now() AT TIME ZONE 'Asia/Riyadh')::time < s.morning_from THEN RETURN jsonb_build_object('skipped', 'before_morning'); END IF;
  IF s.last_review_run = v_today THEN RETURN jsonb_build_object('skipped', 'already_ran_today'); END IF;

  v_rev  := COALESCE(CASE WHEN s.enabled THEN s.agent_user_id END, public.wassell_default_sales_rep());
  v_from := COALESCE(s.last_review_window_end, now() - interval '24 hours');

  INSERT INTO public.ai_chat_reviews
    (review_day, chat_wid, chat_record_id, client_id, reviewer_user_id, window_start, window_end, ai_messages, last_ai_at)
  SELECT v_today, m.chat_wid, ch.id,
         CASE WHEN ch.data->>'client_link' ~* '^[0-9a-f-]{36}$' THEN (ch.data->>'client_link')::uuid END,
         v_rev, v_from, v_to, count(*), max(m.date)
    FROM public.chat_messages m
    JOIN LATERAL (
      SELECT c.id, c.data FROM public.records c
       WHERE c.model_id = v_chats AND c.data->>'wid' = m.chat_wid
       ORDER BY c.updated_at DESC LIMIT 1
    ) ch ON true
   WHERE m.flow = 'out' AND m.send_source = 'ai'
     AND m.date >= v_from AND m.date < v_to
     -- Client chats only (the agent answers clients only).
     AND COALESCE(ch.data->>'client_link', '') <> ''
   GROUP BY m.chat_wid, ch.id, ch.data
  ON CONFLICT (review_day, chat_wid) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.sales_call_campaign_settings
     SET last_review_run = v_today, last_review_window_end = v_to, updated_at = now()
   WHERE id = 1;
  RETURN jsonb_build_object('day', v_today, 'chats', v_n, 'from', v_from, 'to', v_to, 'reviewer', v_rev);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ai_chat_review_submit(p_id uuid, p_rating int, p_note text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_me uuid := public.wassell_app_user_id(auth.uid());
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'rating must be 1–5' USING ERRCODE = '22023';
  END IF;
  UPDATE public.ai_chat_reviews
     SET status = 'done', rating = p_rating, note = NULLIF(btrim(p_note), ''),
         reviewed_by = v_me, reviewed_at = now()
   WHERE id = p_id
     AND (reviewer_user_id = v_me OR public.wassell_is_admin(auth.uid()));
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ai_review_tick()                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_chat_review_submit(uuid, int, text)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_review_tick()                     TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_chat_review_submit(uuid, int, text) TO authenticated, service_role;

COMMIT;
