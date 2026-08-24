-- AI notifications inbox — the WhatsApp AI agent posts messages here for the
-- operator to read in the Tasks page "AI notifications" tab. Distinct from web
-- push (push_outbox) and from tasks/follow-ups: this is a simple internal feed
-- the agent writes when it hands a chat off or wants a human's attention.

CREATE TABLE IF NOT EXISTS public.ai_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL DEFAULT 'whatsapp',      -- which agent/channel
  severity          text NOT NULL DEFAULT 'info',          -- info | action | warning
  title             text,
  body              text NOT NULL,
  -- Linkage back to the conversation / people, so the UI can deep-link.
  chat_wid          text,
  chat_record_id    uuid,
  client_record_id  uuid,
  -- Optional per-user routing; NULL = visible to all operators (v1 default).
  target_user_id    uuid,
  -- Read state.
  read_at           timestamptz,
  read_by           uuid,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ai_notifications_created_idx ON public.ai_notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_notifications_unread_idx  ON public.ai_notifications (read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_notifications_chat_idx    ON public.ai_notifications (chat_wid);

ALTER TABLE public.ai_notifications ENABLE ROW LEVEL SECURITY;

-- Internal ops feed: any authenticated staff member can read it (v1). Rows with
-- a target_user_id still show to everyone in v1 — routing is future work.
DROP POLICY IF EXISTS ai_notifications_select ON public.ai_notifications;
CREATE POLICY ai_notifications_select ON public.ai_notifications
  FOR SELECT USING (auth.role() = 'authenticated');

-- Mark-as-read is the only field a human edits; allow authenticated UPDATE.
-- (INSERTs come from the runner via service role, which bypasses RLS.)
DROP POLICY IF EXISTS ai_notifications_update ON public.ai_notifications;
CREATE POLICY ai_notifications_update ON public.ai_notifications
  FOR UPDATE USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Mark one (or all) notifications read for the caller — SECURITY DEFINER so the
-- read stamp is attributable and can't be forged past RLS. p_id NULL = mark all.
CREATE OR REPLACE FUNCTION public.ai_notification_mark_read(p_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  UPDATE public.ai_notifications
     SET read_at = now(), read_by = v_uid
   WHERE read_at IS NULL
     AND (p_id IS NULL OR id = p_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

GRANT EXECUTE ON FUNCTION public.ai_notification_mark_read(uuid) TO authenticated;
