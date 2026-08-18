-- WhatsApp inbound push: one notification PER MESSAGE, not per 5-minute burst.
--
-- WHY THIS EXISTS (live finding, 2026-08-18): the operator sent three WhatsApp
-- messages inside one minute and was alerted for the FIRST only. That was
-- 2026-08-18_09 working exactly as written — its dedupe_key bucketed the
-- message time into 300s windows, so a burst produced ONE push_outbox row.
--
-- The bucket was the wrong instrument. Suppressing the PUSH is not what stops
-- three notifications stacking on the phone — `tag` already does that: the
-- device REPLACES the previous alert for the same tag. So the bucket bought no
-- tidiness that tag wasn't already providing, and cost the rep every message
-- after the first: no buzz, and the one visible notification still showing the
-- stale text of message #1. For a salesperson that is the whole point missed —
-- the second and third messages are usually where the intent is.
--
-- CORRECT SHAPE: dedupe on the MESSAGE, collapse on the DEVICE.
--   dedupe_key = 'wa_in:' || chat_messages.id  → one push per distinct message
--   tag        = 'chat-' || conversation        → device shows ONE row, latest text
--
-- Idempotency is not weakened. chat_messages.id is the WhatsApp message id and
-- the PRIMARY KEY, and this trigger is AFTER INSERT ONLY — a webhook retry or
-- re-delivery upserts the existing row as an UPDATE, which never fires the
-- trigger. The 09 migration keyed the bucket on NEW.date rather than now() to
-- survive retries; keying on the primary key is strictly stronger.
--
-- Everything else in 09 (rep resolution, the inbound/age/kind guards, the
-- anti-double-buzz stand-down against customer_replied, the kill switch, the
-- non-fatal exception posture) is UNCHANGED. This migration re-emits the
-- function verbatim from the LIVE definition with the dedupe_key expression as
-- the only edit.

BEGIN;

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_old_expr text := $old$'wa_in:' || NEW.conversation_record_id || ':' ||
      (floor(extract(epoch FROM NEW.date) / 300))::bigint::text$old$;
  v_new_expr text := $new$'wa_in:' || NEW.id$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_chat_messages_enqueue_push';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'tg_chat_messages_enqueue_push not found — apply 2026-08-18_09 first';
  END IF;

  -- Already migrated? Then this is a no-op re-run.
  IF position(v_new_expr in v_src) > 0 AND position(v_old_expr in v_src) = 0 THEN
    RAISE NOTICE 'already per-message — no change';
    RETURN;
  END IF;

  IF position(v_old_expr in v_src) = 0 THEN
    RAISE EXCEPTION 'the 5-minute bucket expression was not found in the live function — it has been edited since 2026-08-18_09. Refusing to guess; re-derive the patch by hand.';
  END IF;

  v_new := replace(v_src, v_old_expr, v_new_expr);
  EXECUTE v_new;
END
$mig$;

-- ── Validation — fail loudly inside the transaction ─────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_chat_messages_enqueue_push';

  IF position($chk$'wa_in:' || NEW.id$chk$ in v_src) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: dedupe_key is not per-message';
  END IF;
  IF position('/ 300' in v_src) > 0 THEN
    RAISE EXCEPTION 'post-condition failed: the 5-minute bucket is still present';
  END IF;
  -- The collapse-on-device behaviour must survive.
  IF position($chk$'chat-' || NEW.conversation_record_id$chk$ in v_src) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: the per-conversation tag was lost';
  END IF;
  -- The trigger must still be INSERT-only, or dedupe-by-PK stops being idempotent.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'chat_messages'
       AND t.tgname  = 'chat_messages_enqueue_push'
       AND (t.tgtype & 16) <> 0   -- UPDATE bit
  ) THEN
    RAISE EXCEPTION 'post-condition failed: trigger now fires on UPDATE — per-message dedupe would re-push on every edit';
  END IF;
END $$;

COMMIT;
