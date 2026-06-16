-- Backfill followup_status='completed' for HISTORICAL follow-ups that were
-- actually done (have actual_datetime or call_result) but predate Phase 1's
-- followup_status field — all 221 old rows had a null status. Without this they
-- render as fake-open/overdue in the Sales Queue and are uncounted by the Sales
-- Manager dashboard. Additive (null -> 'completed'); a DIRECT DB write, so it
-- does NOT fire client-side workflows (which is correct — these are already
-- done; we don't want to re-trigger automation on them). The 110 rows with no
-- actual_datetime AND no call_result stay null (treated as 'open'). Affected ids
-- are snapshotted for reversibility.

CREATE TABLE IF NOT EXISTS public._backup_followup_status_20260616 AS
SELECT id FROM public.records
WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND data->>'followup_status' IS NULL
  AND (data->>'actual_datetime' IS NOT NULL OR data->>'call_result' IS NOT NULL);

UPDATE public.records
SET data = jsonb_set(data, '{followup_status}', '"completed"'::jsonb)
WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND data->>'followup_status' IS NULL
  AND (data->>'actual_datetime' IS NOT NULL OR data->>'call_result' IS NOT NULL);
