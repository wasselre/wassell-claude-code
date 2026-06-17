-- ============================================================================
-- Remove the spurious duplicate WhatsApp chat for client "ريان".
--
-- Two chats records were linked to the same client because "Start New Chat"
-- open-coded its phone normalization and only prepended the 966 country code
-- when the number began with "0". Typing the bare 9-digit Saudi number
-- "554446109" therefore minted a SECOND chat record with wid "554446109@c.us"
-- + a bogus e164 "+554446109", distinct from the real Haberchat thread
-- "966554446109@c.us". The code fix (use normalizePhone() in startNewChat,
-- src/stores/appStore.ts) stops new duplicates; this removes the existing one.
--
--   • KEEP   1e1d90f0-8058-5aa5-b3ad-5034ec3d7287  wid 966554446109@c.us (29 msgs, real)
--   • DELETE a7e88905-c629-59bf-84ba-90f006bac7e1  wid 554446109@c.us    (0 msgs, junk)
--
-- The junk record has ZERO chat_messages and Haberchat will never send to
-- "+554446109", so deleting it loses nothing. The NOT EXISTS guard makes the
-- delete a no-op if any message ever attached to that wid (fail-safe).
-- ============================================================================

-- Backup the row(s) before deleting.
CREATE TABLE IF NOT EXISTS public._backup_dupe_chat_20260617 AS
  SELECT * FROM public.records WHERE id = 'a7e88905-c629-59bf-84ba-90f006bac7e1';

DELETE FROM public.records r
WHERE r.id = 'a7e88905-c629-59bf-84ba-90f006bac7e1'
  AND r.model_id = (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1)
  AND r.data->>'wid' = '554446109@c.us'
  AND NOT EXISTS (
    SELECT 1 FROM public.chat_messages m WHERE m.chat_wid = '554446109@c.us'
  );
