-- WA-01 follow-up — activity_log rejected the category the send audit writes.
--
-- activity_log_category_check allowed only
-- auth|record|workflow|ai_agent|api|webhook|system|file, so every
-- logSendAttempt() insert violated the constraint. logServerActivity catches
-- its own insert errors by design (an audit failure must not break a customer
-- reply), so the rows vanished leaving only a console line: the send audit
-- shipped in the same change was writing NOTHING.
--
-- And silently disabling a guard: the WA-01 rate limiter COUNTS rows with
-- category='whatsapp'. With none ever written the count was permanently 0, so
-- the ceiling could never trigger. A limiter that cannot fire is worse than no
-- limiter, because it reads as protection.
--
-- 'whatsapp' must be its own category rather than reusing 'api', or unrelated
-- request logging would pollute the rate-limit count.
--
-- Verified after applying: a denied send now writes
--   outcome=denied, reason=no_recipient, recipient masked, no raw phone.

ALTER TABLE public.activity_log DROP CONSTRAINT IF EXISTS activity_log_category_check;
ALTER TABLE public.activity_log ADD CONSTRAINT activity_log_category_check
  CHECK (category = ANY (ARRAY[
    'auth','record','workflow','ai_agent','api','webhook','system','file','whatsapp'
  ]));

-- Without this the limiter scans a 65k-row, 62 MB table on every send.
CREATE INDEX IF NOT EXISTS activity_log_whatsapp_send_idx
  ON public.activity_log (actor_user_id, created_at DESC)
  WHERE category = 'whatsapp' AND event_type = 'send_attempt';
