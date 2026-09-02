-- Client retirement — Part 5b: bulk-retire every pre-Aug-2026 client.
--
-- Per the operator: any client acquired before 1 Aug 2026 (record created_at in
-- KSA time) is considered retired — hidden from lists + every count. They are
-- NOT deleted, keep all their data, and auto-un-retire the moment they message
-- us again (chat_messages_auto_unretire trigger).
--
-- clients is unfrozen. Snapshot first (reversible). Idempotent: skips rows
-- already retired, so re-running is a no-op and never re-stamps retired_at.

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_clients_pre_aug_retire_20260908 AS
SELECT r.id, r.data, now() AS backed_up_at
FROM public.records r
WHERE r.model_id = '2e86f197-385f-4853-908f-b4cb7237f7d8'
  AND (r.created_at AT TIME ZONE 'Asia/Riyadh')::date < '2026-08-01'
  AND (r.data->>'is_retired') IS DISTINCT FROM 'true';

UPDATE public.records r
SET data = r.data || jsonb_build_object(
             'is_retired', true,
             'retired_at', now(),
             'retired_reason', 'pre_aug_2026_bulk'
           )
WHERE r.id IN (SELECT id FROM public._backup_clients_pre_aug_retire_20260908);

COMMIT;
