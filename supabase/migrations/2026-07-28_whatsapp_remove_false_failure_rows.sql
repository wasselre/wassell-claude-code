-- Remove `failed:` rows for messages that were actually DELIVERED.
--
-- api/_lib/waha.ts read the send response id from `raw.id`, which is GOWS's
-- shape. The Doha gateway runs NOWEB, where the id is a bare hash at `key.id`,
-- so every send threw "returned no id" while WhatsApp had already accepted the
-- message. The 2026-07-28 send-row work then faithfully recorded that as a
-- failure.
--
-- The result was a thread showing a red failed bubble beside the same message
-- delivered -- which is not just noise, it is what tells a rep to send again.
-- Both rows came from one cold outreach, and the customer did receive that
-- message twice.
--
-- Only rows with a PROVEN delivered twin are removed: same chat, same body,
-- within two minutes, non-synthetic id. A `failed:` row without such a twin is
-- a real failure and stays.
--
-- Code fix shipped in the same push: sentMessageWid() handles both engines, and
-- an accepted send whose id cannot be read is recorded as `sent:` and never as
-- `failed:`.

CREATE TABLE IF NOT EXISTS public._backup_false_failures_20260728 AS
SELECT * FROM public.chat_messages WHERE false;

WITH false_failures AS (
  SELECT f.id
  FROM public.chat_messages f
  WHERE f.id LIKE 'failed:%'
    AND EXISTS (
      SELECT 1 FROM public.chat_messages m
      WHERE m.chat_wid = f.chat_wid
        AND m.flow = 'out'
        AND m.id NOT LIKE 'failed:%'
        AND m.body IS NOT DISTINCT FROM f.body
        AND abs(EXTRACT(EPOCH FROM (m.date - f.date))) < 120
    )
)
INSERT INTO public._backup_false_failures_20260728
SELECT c.* FROM public.chat_messages c JOIN false_failures ff ON ff.id = c.id;

DELETE FROM public.chat_messages c
USING public._backup_false_failures_20260728 b
WHERE c.id = b.id;
