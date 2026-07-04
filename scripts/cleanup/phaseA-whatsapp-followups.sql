-- ============================================================================
-- Phase A — WhatsApp follow-up data cleanup (REVIEW BEFORE RUNNING)
-- ============================================================================
-- Run ONCE, manually, against wassell-prod, AFTER the Phase A code + the
-- mark_whatsapp_replied migration are deployed. Every step backs up first and
-- prints before/after counts. This does NOT touch visit-rating rows — those are
-- in scripts/cleanup/rating-request-scheduled-rows.sql (separate, per request).
--
-- followups model_id = 764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63
--
-- What it fixes:
--   1. Completed follow-ups that still carry whatsapp_state='message_sent_
--      waiting_response' (the R1 bug seed). The code fix (clear on completion)
--      + the sweep's done-status filter already prevent NEW ones and stop these
--      from ghost-escalating; this clears the stale flag for tidiness.
--   2. Clients with MORE THAN ONE open whatsapp_follow_up (the R1 ghost chains).
--      Keep the most-recently-CREATED open one (the latest conversation state);
--      cancel the older duplicates with cancel_reason='phaseA_duplicate_cleanup'
--      (cancelled, NOT deleted — history preserved).
--   3. Delete the broken inactive legacy workflow "1" (34af4560…).
-- ============================================================================

BEGIN;

-- ---- Backup every row this script may touch --------------------------------
CREATE TABLE IF NOT EXISTS public._backup_phaseA_followups_20260704 AS
SELECT * FROM records
WHERE model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND (
    (data->>'whatsapp_state' = 'message_sent_waiting_response' AND data->>'followup_status' = 'completed')
    OR data->>'client_id' IN (
      SELECT data->>'client_id'
      FROM records
      WHERE model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
        AND jsonb_typeof(data->'followup_type') = 'array'
        AND data->'followup_type' ? 'whatsapp_follow_up'
        AND COALESCE(NULLIF(data->>'followup_status',''),'open') IN ('open','in_progress')
      GROUP BY data->>'client_id'
      HAVING count(*) > 1
    )
  );

-- ---- BEFORE counts ---------------------------------------------------------
SELECT 'before' AS phase,
 (SELECT count(*) FROM records WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
    AND data->>'whatsapp_state'='message_sent_waiting_response' AND data->>'followup_status'='completed') AS completed_but_waiting,
 (SELECT count(*) FROM (
    SELECT data->>'client_id' cid FROM records WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
      AND jsonb_typeof(data->'followup_type')='array' AND data->'followup_type' ? 'whatsapp_follow_up'
      AND COALESCE(NULLIF(data->>'followup_status',''),'open') IN ('open','in_progress')
    GROUP BY 1 HAVING count(*)>1) x) AS clients_with_multi_open_wa;

-- ---- Fix 1: clear stale waiting flag on completed rows ----------------------
UPDATE records
SET data = data - 'whatsapp_state'
WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND data->>'whatsapp_state'='message_sent_waiting_response'
  AND data->>'followup_status'='completed';

-- ---- Fix 2: cancel older duplicate open WhatsApp follow-ups -----------------
-- Keep the newest-created open WA task per client; cancel the rest.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY data->>'client_id' ORDER BY created_at DESC) AS rn
  FROM records
  WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
    AND jsonb_typeof(data->'followup_type')='array' AND data->'followup_type' ? 'whatsapp_follow_up'
    AND COALESCE(NULLIF(data->>'followup_status',''),'open') IN ('open','in_progress')
)
UPDATE records r
SET data = r.data
         || jsonb_build_object('followup_status','cancelled')
         || jsonb_build_object('cancel_reason','phaseA_duplicate_cleanup')
FROM ranked
WHERE r.id = ranked.id AND ranked.rn > 1;

-- ---- Fix 3: delete the broken inactive legacy workflow "1" ------------------
DELETE FROM workflows WHERE id::text LIKE '34af4560%' AND is_active = false;

-- ---- AFTER counts ----------------------------------------------------------
SELECT 'after' AS phase,
 (SELECT count(*) FROM records WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
    AND data->>'whatsapp_state'='message_sent_waiting_response' AND data->>'followup_status'='completed') AS completed_but_waiting,
 (SELECT count(*) FROM (
    SELECT data->>'client_id' cid FROM records WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
      AND jsonb_typeof(data->'followup_type')='array' AND data->'followup_type' ? 'whatsapp_follow_up'
      AND COALESCE(NULLIF(data->>'followup_status',''),'open') IN ('open','in_progress')
    GROUP BY 1 HAVING count(*)>1) x) AS clients_with_multi_open_wa;

-- Review the two result rows (before → after should show both counts drop to 0).
-- If correct: COMMIT;  otherwise: ROLLBACK;
COMMIT;
