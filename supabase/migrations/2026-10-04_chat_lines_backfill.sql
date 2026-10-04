-- Chats number switcher (2026-10-04): fill records.data.lines on every chat
-- conversation with the WhatsApp numbers its messages actually used.
--
-- A conversation record is ONE per contact, shared by every number we own, and
-- data.device_id keeps only the FIRST number it was ever seen on — so an office
-- that once wrote to the sales number would only show under Sales. The webhook
-- now keeps data.lines up to date on every message (api/_lib/chatIngest.ts
-- withLine); this fills it for the history.
--
-- Union of: numbers seen in chat_messages + any lines already stored + the
-- first number (device_id). Never removes a number. Idempotent: rows whose
-- lines already match are not touched, so re-running after the deploy (to
-- catch messages that arrived in between) only updates what changed.
BEGIN;

-- Machine write: lets the record triggers that honour this flag (translation
-- capture) skip the rows.
SET LOCAL wassell.system_write = 'chat_lines_backfill';

WITH chats AS (
  SELECT id FROM public.models WHERE name = 'chats'
),
used AS (
  SELECT m.conversation_record_id AS id, array_agg(DISTINCT m.device_id) AS devs
    FROM public.chat_messages m
   WHERE m.device_id IS NOT NULL AND m.device_id <> ''
   GROUP BY m.conversation_record_id
),
target AS (
  SELECT r.id,
         (SELECT jsonb_agg(x ORDER BY x)
            FROM (SELECT DISTINCT x
                    FROM unnest(
                           u.devs
                           || ARRAY(SELECT jsonb_array_elements_text(
                                     CASE WHEN jsonb_typeof(r.data->'lines') = 'array'
                                          THEN r.data->'lines' ELSE '[]'::jsonb END))
                           || CASE WHEN jsonb_typeof(r.data->'device_id') = 'string'
                                   THEN ARRAY[r.data->>'device_id'] ELSE '{}'::text[] END
                         ) AS x
                   WHERE x <> '') s) AS lines
    FROM public.records r
    JOIN used u ON u.id = r.id
   WHERE r.model_id = (SELECT id FROM chats)
)
UPDATE public.records r
   SET data = r.data || jsonb_build_object('lines', t.lines)
  FROM target t
 WHERE r.id = t.id
   AND r.data->'lines' IS DISTINCT FROM t.lines;

COMMIT;
