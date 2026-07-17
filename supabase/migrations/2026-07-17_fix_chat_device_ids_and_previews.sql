-- 2026-07-17 — Chats repair: corrupt device ids + wiped list previews
--
-- Context (live incident, diagnosed 2026-07-17):
--  1. Haberchat's webhook envelope sends `device` as an OBJECT
--     ({id, plan, alias, phone}). The webhook handler cast it to string, so
--     records.data.device_id on webhook-created chats and
--     chat_messages.device_id (1,513 rows) stored the whole object / its
--     JSON text. The SPA then called the proxy with
--     "deviceId=[object Object]" — thread loads and sends 400'd on new
--     inbound chats until a list sync repaired the record.
--     Code fix: api/webhook/haberchat.ts resolves via pickId(). This
--     migration repairs the stored rows.
--  2. The chats-list sync normalizer read unread from fields Haberchat
--     doesn't send (real one: chat.meta.unreadCount) and there is NO
--     preview field in their chat object at all — so every list sync wrote
--     unread_count = 0 and last_message_preview = NULL over what the
--     webhook had stamped. Code fix: api/_lib/haberchat.ts +
--     src/lib/haberchat/normalize.ts. This migration backfills the wiped
--     previews (and last_message_flow) from the chat_messages mirror.
--     unread_count is left at 0 — the true "which messages has the CRM user
--     not seen" state is unrecoverable; it self-corrects from the next
--     inbound message.

BEGIN;

-- 1a. records.data.device_id: object → its id string.
UPDATE public.records r
SET data = jsonb_set(r.data, '{device_id}', r.data->'device_id'->'id')
FROM public.models m
WHERE m.id = r.model_id
  AND m.name = 'chats'
  AND jsonb_typeof(r.data->'device_id') = 'object'
  AND jsonb_typeof(r.data->'device_id'->'id') = 'string';

-- 1b. chat_messages.device_id: JSON text of the device object → the id.
UPDATE public.chat_messages
SET device_id = (device_id::jsonb)->>'id'
WHERE device_id LIKE '{%'
  AND (device_id::jsonb)->>'id' IS NOT NULL;

-- 2. Backfill last_message_preview / last_message_flow from the newest
--    mirrored message per chat, only where the sync wiped the preview.
WITH latest AS (
  SELECT DISTINCT ON (chat_wid) chat_wid, body, flow
  FROM public.chat_messages
  ORDER BY chat_wid, date DESC
)
UPDATE public.records r
SET data = r.data || jsonb_build_object(
      'last_message_preview', left(coalesce(nullif(l.body, ''), '[media]'), 120),
      'last_message_flow', l.flow
    )
FROM public.models m, latest l
WHERE m.id = r.model_id
  AND m.name = 'chats'
  AND r.data->>'wid' = l.chat_wid
  AND (r.data->>'last_message_preview') IS NULL;

COMMIT;
