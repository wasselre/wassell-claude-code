-- WA-22 — remove the corrupted conversation record (audit 2026-07-28).
--
-- `records.data.wid` held a 2,705-character serialized Haberchat chat OBJECT
-- instead of a wid, so the record id (uuidv5 of that blob) could never match a
-- real conversation. It sat in the chat list as an unopenable row and carried
-- the ONLY non-zero unread_count in the system, which meant the entire unread
-- badge the reps saw came from this artifact.
--
-- Verified before removal: 0 chat_messages (by record id AND by its wid),
-- 0 claude_jobs, 0 scheduled_whatsapp_jobs, 0 follow-ups. Nothing referenced it.
--
-- The structural guard that stops this recurring is in application code:
-- api/_lib/chatIngest.ts#isValidChatWid rejects any wid that is not
-- `<digits>@(c.us|g.us|lid|newsletter|broadcast|status)` before a conversation
-- can be minted.

CREATE TABLE IF NOT EXISTS public._backup_corrupted_chat_20260728 AS
SELECT * FROM public.records WHERE false;

INSERT INTO public._backup_corrupted_chat_20260728
SELECT * FROM public.records WHERE id = '6e0af341-8603-5511-a9ec-c51edcda3a87';

-- The NOT EXISTS is not decoration: if a message ever attaches to this record
-- between the check above and this statement, the row must survive.
DELETE FROM public.records
WHERE id = '6e0af341-8603-5511-a9ec-c51edcda3a87'
  AND NOT EXISTS (
    SELECT 1 FROM public.chat_messages m
    WHERE m.conversation_record_id = '6e0af341-8603-5511-a9ec-c51edcda3a87'
  );
