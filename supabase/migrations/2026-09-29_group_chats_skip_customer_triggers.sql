-- WhatsApp GROUP posts are stored as their own conversation (`<id>@g.us`) from
-- 2026-09-29 (api/webhook/waha.ts). Until then they were filed under the
-- SENDER's private chat. A group post is not a message to us, so the three
-- insert triggers that treat an inbound row as "this person wrote to us" must
-- skip it:
--   * chat_messages_auto_unretire      — would un-retire a client who merely
--                                        posted in a group
--   * chat_messages_office_outreach_reply — would mark an office as having
--                                        replied to our outreach
--   * chat_messages_enqueue_push       — would push "new WhatsApp message" to
--                                        the inbox owner for every group post
-- Only the trigger WHEN clauses change; the functions are untouched.
-- (chat_messages_enqueue_outcome already skips groups: it needs a client link
-- or an 8–15 digit phone wid, and a group wid has neither.)

BEGIN;

DROP TRIGGER IF EXISTS chat_messages_auto_unretire ON public.chat_messages;
CREATE TRIGGER chat_messages_auto_unretire
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  WHEN (new.flow = 'in' AND new.chat_wid NOT LIKE '%@g.us')
  EXECUTE FUNCTION public.clients_auto_unretire_on_inbound();

DROP TRIGGER IF EXISTS chat_messages_office_outreach_reply ON public.chat_messages;
CREATE TRIGGER chat_messages_office_outreach_reply
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  WHEN (new.flow = 'in' AND new.chat_wid NOT LIKE '%@g.us')
  EXECUTE FUNCTION public.tg_office_outreach_reply();

DROP TRIGGER IF EXISTS chat_messages_enqueue_push ON public.chat_messages;
CREATE TRIGGER chat_messages_enqueue_push
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  WHEN (new.chat_wid NOT LIKE '%@g.us')
  EXECUTE FUNCTION public.tg_chat_messages_enqueue_push();

COMMIT;
