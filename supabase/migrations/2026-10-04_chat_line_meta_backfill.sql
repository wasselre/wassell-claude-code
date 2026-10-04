-- One chat per number (2026-10-04): fill records.data.line_meta on every chat
-- conversation from chat_messages.
--
-- A contact who talked to two of our numbers is now two chats in the Chats
-- list, each with its own preview, time and unread count. The webhook keeps
-- data.line_meta up to date per message (api/_lib/chatIngest.ts withLineMeta);
-- this fills it for the history:
--
--   last_message_at / _preview / _flow — the newest non-reaction message on
--     that number (preview = body, or '[media]', cut to 120 chars like the
--     webhook does)
--   unread_count — the conversation's existing unread_count, split over the
--     numbers its newest INBOUND messages arrived on (the newest N inbound
--     messages, N = unread_count). The per-number counts therefore always add
--     up to the conversation total the app showed before.
--
-- Idempotent: rows whose line_meta already matches are not touched, so
-- re-running after the deploy (for messages that arrived in between) only
-- updates what changed. It REPLACES line_meta with the recomputed value.
BEGIN;

-- Machine write: lets the record triggers that honour this flag (translation
-- capture) skip the rows.
SET LOCAL wassell.system_write = 'chat_line_meta_backfill';

WITH chats AS (
  SELECT id FROM public.models WHERE name = 'chats'
),
conv AS (
  SELECT r.id,
         GREATEST(COALESCE(public.try_numeric(r.data->>'unread_count'), 0), 0)::int AS unread
    FROM public.records r
   WHERE r.model_id = (SELECT id FROM chats)
),
latest AS (
  SELECT DISTINCT ON (m.conversation_record_id, m.device_id)
         m.conversation_record_id AS id,
         m.device_id,
         m.date,
         m.flow,
         COALESCE(m.body, '[media]') AS body
    FROM public.chat_messages m
    JOIN conv c ON c.id = m.conversation_record_id
   WHERE m.device_id IS NOT NULL AND m.device_id <> ''
     AND m.kind IS DISTINCT FROM 'reaction'
   ORDER BY m.conversation_record_id, m.device_id, m.date DESC
),
recent_in AS (
  SELECT m.conversation_record_id AS id,
         m.device_id,
         row_number() OVER (PARTITION BY m.conversation_record_id ORDER BY m.date DESC) AS rn
    FROM public.chat_messages m
    JOIN conv c ON c.id = m.conversation_record_id AND c.unread > 0
   WHERE m.device_id IS NOT NULL AND m.device_id <> ''
     AND m.flow = 'in'
     AND m.kind IS DISTINCT FROM 'reaction'
),
unread AS (
  SELECT ri.id, ri.device_id, count(*)::int AS n
    FROM recent_in ri
    JOIN conv c ON c.id = ri.id
   WHERE ri.rn <= c.unread
   GROUP BY ri.id, ri.device_id
),
target AS (
  SELECT l.id,
         jsonb_object_agg(
           l.device_id,
           jsonb_build_object(
             'last_message_at', to_char(l.date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'last_message_preview',
               CASE WHEN char_length(l.body) <= 120 THEN l.body
                    ELSE left(l.body, 119) || '…' END,
             'last_message_flow', l.flow,
             'unread_count', COALESCE(u.n, 0)
           )
         ) AS meta
    FROM latest l
    LEFT JOIN unread u ON u.id = l.id AND u.device_id = l.device_id
   GROUP BY l.id
)
UPDATE public.records r
   SET data = r.data || jsonb_build_object('line_meta', t.meta)
  FROM target t
 WHERE r.id = t.id
   AND r.data->'line_meta' IS DISTINCT FROM t.meta;

COMMIT;
