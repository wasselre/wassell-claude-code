-- WhatsApp: undo the damage from a second gateway, and register the bridge number.
--
-- A retired companion device (WAHA session `wassel_main`) was still linked to
-- the sales account and kept reporting every message a second time under LID
-- addressing, while the live Doha session (`sales`) addresses the same chats by
-- phone. One physical message therefore landed as TWO rows, in TWO conversation
-- records, with the delivery receipt going to the copy nobody looks at — so the
-- rep saw a permanent "pending" clock on messages the customer had already read.
--
-- The code fix (chatIngest.messageIdHash + applyAck hash fallback) stops new
-- duplicates. This migration repairs what already landed.
--
-- IDENTITY RULE: two rows are the same message iff the trailing HASH segment of
-- their ids matches AND the direction matches. That is WhatsApp's own message
-- id — not a content or timing heuristic. Content matching was tried during the
-- 2026-07-26 LID cleanup and produced false positives, which is why nothing
-- here guesses: an @lid row with no hash-proven twin is LEFT ALONE.

BEGIN;

-- ── 0. Backup everything this migration touches ────────────────────────────
CREATE TABLE IF NOT EXISTS public._backup_lid_dupes_20260727 AS
SELECT * FROM public.chat_messages WHERE false;

CREATE TABLE IF NOT EXISTS public._backup_lid_chat_records_20260727 AS
SELECT * FROM public.records WHERE false;

-- The stable identity of each message.
CREATE TEMP TABLE _norm ON COMMIT DROP AS
SELECT id, chat_wid, flow, ack, created_at,
       CASE WHEN id ~ '^(true|false)_[^_]+@[a-z.]+_'
            THEN split_part(id, '_', 3) ELSE id END AS h
FROM public.chat_messages;

-- Pairs where a phone-addressed row and a LID-addressed row are one message.
CREATE TEMP TABLE _dupes ON COMMIT DROP AS
SELECT keep.id AS keep_id, keep.ack AS keep_ack,
       drop_.id AS drop_id, drop_.ack AS drop_ack, drop_.flow
FROM _norm keep
JOIN _norm drop_ ON keep.h = drop_.h AND keep.flow = drop_.flow AND keep.id <> drop_.id
WHERE keep.chat_wid NOT LIKE '%@lid'
  AND drop_.chat_wid LIKE '%@lid';

INSERT INTO public._backup_lid_dupes_20260727
SELECT m.* FROM public.chat_messages m JOIN _dupes d ON m.id = d.drop_id;

-- ── 1. Rescue the delivery receipt before deleting the copy that holds it ──
-- Outbound only: an inbound ack is meaningless (NOWEB reports -1/ERROR on
-- received messages, which is why inbound stores null).
UPDATE public.chat_messages m
SET ack = d.drop_ack
FROM _dupes d
WHERE m.id = d.keep_id
  AND d.flow = 'out'
  AND d.drop_ack IS NOT NULL
  AND COALESCE(
        (CASE d.drop_ack WHEN 'failed' THEN -1 WHEN 'pending' THEN 0 WHEN 'sent' THEN 1
                         WHEN 'delivered' THEN 2 ELSE 3 END), -1)
    > COALESCE(
        (CASE m.ack WHEN 'failed' THEN -1 WHEN 'pending' THEN 0 WHEN 'sent' THEN 1
                    WHEN 'delivered' THEN 2 WHEN 'played' THEN 3 WHEN 'read' THEN 3 END), -1);

-- ── 2. Drop the duplicate rows ─────────────────────────────────────────────
DELETE FROM public.chat_messages m USING _dupes d WHERE m.id = d.drop_id;

-- ── 3. Drop connectivity-test sends ────────────────────────────────────────
-- `999999999999999@lid` is not a real contact — it is a diagnostic probe from
-- 2026-07-27 that minted a conversation record as a side effect.
INSERT INTO public._backup_lid_dupes_20260727
SELECT * FROM public.chat_messages WHERE chat_wid = '999999999999999@lid';
DELETE FROM public.chat_messages WHERE chat_wid = '999999999999999@lid';

-- ── 4. Remove conversation records left with no messages at all ────────────
-- Only empties. A LID chat that still holds the ONLY copy of a real message is
-- a real conversation (its phone link heals when the LID map fills in) and is
-- deliberately kept.
INSERT INTO public._backup_lid_chat_records_20260727
SELECT r.*
FROM public.records r
JOIN public.models mo ON mo.id = r.model_id AND mo.name = 'chats'
WHERE r.data->>'wid' LIKE '%@lid'
  AND NOT EXISTS (SELECT 1 FROM public.chat_messages m WHERE m.chat_wid = r.data->>'wid');

DELETE FROM public.records r
USING public.models mo
WHERE mo.id = r.model_id AND mo.name = 'chats'
  AND r.data->>'wid' LIKE '%@lid'
  AND NOT EXISTS (SELECT 1 FROM public.chat_messages m WHERE m.chat_wid = r.data->>'wid');

-- ── 5. Un-stick sends whose receipt was lost with the deleted copy ─────────
-- These carry a real gateway-assigned WhatsApp id, so the server did accept
-- them; 'pending' ("not yet sent") is the one thing they demonstrably are not,
-- and it renders as a clock forever because no further ack will ever arrive for
-- an id that is gone. Anything recent is left alone — its ack may still be
-- in flight.
UPDATE public.chat_messages
SET ack = 'sent'
WHERE flow = 'out'
  AND ack = 'pending'
  AND id ~ '^(true|false)_[^_]+@[a-z.]+_'
  AND created_at < now() - interval '1 hour';

-- ── 6. Register the bridge number ──────────────────────────────────────────
-- Session `bridge` (+966533716189) is live on the Doha gateway and has sent
-- messages, but had no row here. Consequence: sendDeviceId() saw an unknown
-- device and rerouted its replies to the default — i.e. answered from the SALES
-- number instead. Registering it inactive-by-default is wrong (that reroutes
-- too); it is a real number we send from, so it is active but not the default.
INSERT INTO public.whatsapp_numbers
  (device_id, phone, friendly_name_ar, friendly_name_en, is_default, is_active, provider, session_name)
VALUES
  ('bridge', '+966533716189', 'وصل — الجسر', 'Wassel — Bridge', false, true, 'waha', 'bridge')
ON CONFLICT (device_id) DO UPDATE
  SET is_active = true,
      provider = 'waha',
      session_name = 'bridge',
      updated_at = now();

COMMIT;
