-- ============================================================================
-- SEPARATE cleanup — stale rating_request timers in status='scheduled'
-- (kept OUT of the WhatsApp Phase A patch on purpose — this touches only the
--  visit-rating follow-up rows, and changes NO visit-rating behavior/logic.)
-- ============================================================================
-- Context: `rating_request` follow-ups use followup_status='scheduled', which
-- is in NEITHER the open set (queue/next-action) NOR the done set — so they sit
-- in limbo forever: invisible to the Sales Queue, ignored by the client
-- next-action trigger, never cleaned. This is a one-time sweep of the stale
-- ones. It does NOT alter the "Send Visit Rating" workflow, the visits model,
-- rating tokens, or any rating scoring.
--
-- Rows found on prod (queried 2026-07-04), followups model
-- 764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63 — ALL belong to one client
-- (5ada52e7-35f3-4b48-8d2e-7f725c818978), a single visit day (2026-06-21):
--
--   id8       scheduled          actual  result  rating_token
--   0ae7b1f7  2026-06-21T14:40   null    null    null
--   aefacb1d  2026-06-21T14:45   null    null    null
--   ec44d42f  2026-06-21T14:51   null    null    null
--
-- Why each is safe to CANCEL (not complete):
--   * They are DUPLICATES — three rating timers armed within 11 minutes for the
--     same client/visit (the after-visit workflow fired repeatedly during a
--     2026-06-21 test window). At most one rating request per visit is intended.
--   * actual_datetime = null AND rating_token = null → NONE of them ever sent a
--     rating link or collected a score. There is no rating data to preserve and
--     nothing was delivered to the customer. Cancelling loses no signal.
--   * scheduled 2026-06-21, i.e. ~2 weeks in the past → the visit is long over;
--     re-sending a rating link now would be noise, so "complete" (which implies
--     a real outcome) is wrong; "cancelled" is the honest terminal state.
--   * The "Send Visit Rating" workflow is gated separately and is unaffected —
--     future visits still arm and send ratings normally.
--
-- Chosen action: CANCEL all three (followup_status='cancelled' +
-- cancel_reason='stale_duplicate_rating_timer'). Cancelled, not deleted —
-- history preserved; they simply leave the 'scheduled' limbo.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_rating_scheduled_20260704 AS
SELECT * FROM records
WHERE model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND data->>'followup_type' LIKE '%rating_request%'
  AND data->>'followup_status' = 'scheduled';

SELECT 'before' AS phase, count(*) AS rating_scheduled
FROM records WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND data->>'followup_type' LIKE '%rating_request%' AND data->>'followup_status'='scheduled';

UPDATE records
SET data = data
         || jsonb_build_object('followup_status','cancelled')
         || jsonb_build_object('cancel_reason','stale_duplicate_rating_timer')
WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND data->>'followup_type' LIKE '%rating_request%'
  AND data->>'followup_status'='scheduled'
  AND COALESCE(data->>'actual_datetime','')=''   -- guard: only un-fired timers
  AND COALESCE(data->>'rating_token','')='';       -- guard: only ones with no link/score

SELECT 'after' AS phase, count(*) AS rating_scheduled
FROM records WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND data->>'followup_type' LIKE '%rating_request%' AND data->>'followup_status'='scheduled';

-- Expect before=3 → after=0. If correct: COMMIT; otherwise ROLLBACK;
COMMIT;
