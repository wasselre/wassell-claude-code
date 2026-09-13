-- WhatsApp follow-up suggestion queue (2026-09-13).
--
-- Claude reviews the client chats and proposes ONE follow-up message per
-- conversation, with the reason and a summary of the whole thread. A human
-- opens the queue page (/sales/follow-up-queue), reads the real WhatsApp
-- thread in the chat popup with the suggested text pre-filled, edits if
-- needed, and confirms the send. Nothing is ever sent automatically from
-- this table — it is a review surface, exactly like `call_result_suggestions`.
--
-- Bespoke ops table (NOT an app model): same posture as `ai_notifications`.
-- Rows are INSERTed by Claude (service role / SQL) or by any authenticated
-- staff member; the status lifecycle is edited from the page.

CREATE TABLE IF NOT EXISTS public.wa_followup_suggestions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- One review batch = one Claude pass over the chats.
  batch_id                 text NOT NULL,
  batch_label              text,
  -- Deep-link triple (same shape as ai_notifications). chat_record_id is the
  -- `chats` records row (what ChatThreadModal takes); chat_wid is what the
  -- store's sendChatMessage / chatMessages slice are keyed by.
  chat_record_id           uuid NOT NULL,
  chat_wid                 text,
  client_record_id         uuid,
  client_name              text,
  phone                    text,
  -- What the review found.
  category                 text NOT NULL,            -- reply | visited | promised | nudge | revive
  priority                 smallint NOT NULL DEFAULT 2, -- 1 = do today, 2 = this week, 3 = low
  project                  text,                     -- project(s) the client was sent / asked about
  chat_summary             text NOT NULL,
  reason                   text NOT NULL,
  suggested_message        text NOT NULL,
  last_client_message_at   timestamptz,
  last_message_at          timestamptz,
  last_message_flow        text,                     -- in | out
  -- Lifecycle.
  status                   text NOT NULL DEFAULT 'pending', -- pending | sent | dismissed | snoozed
  final_message            text,                     -- what actually went out (if edited)
  sent_at                  timestamptz,
  sent_by_user_id          uuid,                     -- public.users.id (NOT auth.uid)
  sent_message_id          text,                     -- chat_messages.id of the outbound bubble
  dismissed_at             timestamptz,
  dismissed_by_user_id     uuid,
  dismiss_reason           text,
  snoozed_until            timestamptz,
  rep_note                 text,
  meta                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT wa_followup_suggestions_category_chk
    CHECK (category IN ('reply', 'visited', 'promised', 'nudge', 'revive')),
  CONSTRAINT wa_followup_suggestions_status_chk
    CHECK (status IN ('pending', 'sent', 'dismissed', 'snoozed')),
  CONSTRAINT wa_followup_suggestions_priority_chk
    CHECK (priority BETWEEN 1 AND 3)
);

CREATE INDEX IF NOT EXISTS wa_followup_suggestions_status_idx
  ON public.wa_followup_suggestions (status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS wa_followup_suggestions_chat_idx
  ON public.wa_followup_suggestions (chat_record_id);
CREATE INDEX IF NOT EXISTS wa_followup_suggestions_batch_idx
  ON public.wa_followup_suggestions (batch_id);

-- One PENDING suggestion per conversation: a second Claude pass replaces the
-- open one rather than stacking two messages for the same client.
CREATE UNIQUE INDEX IF NOT EXISTS wa_followup_suggestions_one_pending_per_chat
  ON public.wa_followup_suggestions (chat_record_id) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.tg_wa_followup_suggestions_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wa_followup_suggestions_touch ON public.wa_followup_suggestions;
CREATE TRIGGER wa_followup_suggestions_touch
  BEFORE UPDATE ON public.wa_followup_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.tg_wa_followup_suggestions_touch();

ALTER TABLE public.wa_followup_suggestions ENABLE ROW LEVEL SECURITY;

-- Internal staff surface: every authenticated user can read, insert and update.
-- The page filters by status; RLS is the gate against anon.
DROP POLICY IF EXISTS wa_followup_suggestions_select ON public.wa_followup_suggestions;
CREATE POLICY wa_followup_suggestions_select ON public.wa_followup_suggestions
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS wa_followup_suggestions_insert ON public.wa_followup_suggestions;
CREATE POLICY wa_followup_suggestions_insert ON public.wa_followup_suggestions
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS wa_followup_suggestions_update ON public.wa_followup_suggestions;
CREATE POLICY wa_followup_suggestions_update ON public.wa_followup_suggestions
  FOR UPDATE USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON public.wa_followup_suggestions TO authenticated;
GRANT ALL ON public.wa_followup_suggestions TO service_role;
