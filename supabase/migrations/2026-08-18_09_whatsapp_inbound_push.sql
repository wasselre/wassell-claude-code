-- Push the ASSIGNED SALESPERSON when a customer sends a new inbound WhatsApp
-- message.
--
-- THE GAP THIS CLOSES
-- ───────────────────
-- The two built-in pushes (2026-07-29_web_push.sql) both hang off the
-- `followups` model, so a rep is only woken when the follow-up ENGINE notices
-- something:
--   * hot_lead          — a first booking call is created.
--   * customer_replied  — a follow-up transitions to "replied".
-- `customer_replied` fires ONLY on an UPDATE of an existing open WhatsApp
-- task. But `reconcile_inbound_whatsapp` CREATES a fresh follow-up (already
-- stamped whatsapp_state='replied') when the client has no open task at all —
-- an INSERT, which that branch never looks at. So the most common shape of
-- "a customer just messaged us" produced NO notification whatsoever. Measured
-- on production 2026-08-18: 4 `customer_replied` rows in push_outbox across
-- three weeks, against 436 inbound messages in 30 days (92 of them on a chat
-- whose linked client has an assigned owner).
--
-- WHY A TRIGGER ON chat_messages, NOT AN ENQUEUE IN api/_lib/chatIngest.ts
-- ──────────────────────────────────────────────────────────────────────
-- `chat_messages` is the ONE place every inbound message must land, whatever
-- wrote it: the WAHA webhook (api/webhook/waha.ts), a chats-list sync, a
-- backfill script, or a future provider. Enqueueing from chatIngest.ts covers
-- only the webhook path and silently misses the others, and it would put the
-- notification decision in an edge function that must return in milliseconds.
-- A trigger also inherits the posture the rest of this queue already has:
-- push_outbox is written by triggers and drained by the Fly worker.
--
-- BACKFILL SAFETY: a historical import inserts thousands of inbound rows at
-- once. `NEW.date < now() - interval '15 minutes'` turns every one of them
-- into a no-op before any query runs, so importing history can never carpet-
-- bomb a rep's phone. (push_outbox_expire_stale() already refuses to deliver
-- anything older than an hour — this stops the rows being created at all.)
--
-- PERFORMANCE POSTURE — copied deliberately from tg_records_enqueue_push:
-- the cheap NEW-field guards run UNGUARDED and RETURN first, and only then
-- does the body enter a nested BEGIN…EXCEPTION. A plpgsql exception handler
-- opens a subtransaction per row it runs on; putting one around the whole
-- body would make every ack/echo/backfill write pay a savepoint. The handler
-- itself is non-negotiable: RAISE WARNING keeps a broken enqueue visible in
-- the Postgres log (this is NOT a silent swallow) while guaranteeing a
-- notification bug can never roll back the message write itself.

BEGIN;

-- ── 1. Kill switch, alongside the two existing built-ins ────────────────────
-- Workspace-wide + admin-only, exactly like hot_lead / customer_replied; the
-- RLS policies on the table already enforce that. Defaults ON.
ALTER TABLE public.push_builtin_settings
  ADD COLUMN IF NOT EXISTS whatsapp_inbound_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.push_builtin_settings.whatsapp_inbound_enabled IS
  'Built-in «رسالة واتساب جديدة» push, produced by tg_chat_messages_enqueue_push. '
  'Missing/NULL degrades to ON — a deleted settings row must never silently mute alerts.';

-- ── 2. The enqueue ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_chat_messages_enqueue_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_on          boolean;
  v_replied_on  boolean;
  v_conv        jsonb;
  v_conv_found  boolean := false;
  v_owner       text;
  v_client      uuid;
  v_client_txt  text;
  v_rep         uuid;
  v_name        text;
  v_preview     text;
  v_digits      text;
  v_followups   uuid;
BEGIN
  -- ── Cheap guards. No queries, no subtransaction. ─────────────────────────
  -- Only genuinely new INBOUND traffic. An echo/ack/edit arrives as an UPDATE
  -- (see upsertChatMessage's merge path) and must never re-notify.
  IF TG_OP <> 'INSERT' THEN RETURN NULL; END IF;
  IF NEW.flow <> 'in' THEN RETURN NULL; END IF;

  -- Not messages: reactions, WhatsApp's own system events (e.g.
  -- biz_privacy_mode_init_fb lands as notification_template), encryption
  -- notices and revocations. Waking a rep for a thumbs-up is how an alert
  -- channel gets muted.
  IF NEW.kind IN ('reaction', 'notification_template', 'e2e_notification', 'protocol', 'revoked') THEN
    RETURN NULL;
  END IF;

  -- Backfill / historical-import guard — see the header.
  IF NEW.date < now() - interval '15 minutes' THEN RETURN NULL; END IF;

  BEGIN

  -- Missing row ⇒ ON, same fallback the other two built-ins use.
  SELECT COALESCE(s.whatsapp_inbound_enabled, true), COALESCE(s.customer_replied_enabled, true)
    INTO v_on, v_replied_on
    FROM push_builtin_settings s WHERE s.id = 1;
  v_on         := COALESCE(v_on, true);
  v_replied_on := COALESCE(v_replied_on, true);
  IF NOT v_on THEN RETURN NULL; END IF;

  SELECT ch.data INTO v_conv FROM records ch WHERE ch.id = NEW.conversation_record_id;
  v_conv_found := FOUND;

  -- ── Resolve the assigned salesperson ─────────────────────────────────────
  -- Documented fallback chain. EVERY rung ending empty means NO PUSH — never
  -- an error, never a guess. Most inbound traffic is on chats with no linked
  -- client at all (measured 2026-08-18: 266 of 436 messages client-linked, 92
  -- of those on a client with an owner), and inventing a recipient for the
  -- rest would be worse than staying quiet.
  --
  --   1. conversation.client_owner — the mirror maintained by
  --      tg_records_fill_chat_client_owner (2026-08-14). Cheapest, and already
  --      the value the chats view-scope engine gates on.
  v_owner := CASE jsonb_typeof(v_conv->'client_owner')
               WHEN 'array'  THEN nullif(v_conv->'client_owner'->>0, '')
               WHEN 'string' THEN nullif(v_conv->>'client_owner', '')
             END;

  -- The linked client id is wanted either way (name + the anti-double-buzz
  -- check below), so resolve it once here.
  v_client_txt := public._link_client_id_of(v_conv);
  IF v_client_txt IS NOT NULL THEN
    BEGIN
      v_client := v_client_txt::uuid;
    EXCEPTION WHEN others THEN
      v_client := NULL;  -- hand-edited junk in client_link: treat as unlinked
    END;
  END IF;

  --   2. the LINKED CLIENT's own client_owner — covers a conversation whose
  --      mirror has not been stamped yet (chat written before 2026-08-14, or
  --      a client that only just gained an owner).
  IF v_owner IS NULL AND v_client IS NOT NULL THEN
    SELECT CASE jsonb_typeof(cl.data->'client_owner')
             WHEN 'array'  THEN nullif(cl.data->'client_owner'->>0, '')
             WHEN 'string' THEN nullif(cl.data->>'client_owner', '')
           END
      INTO v_owner
      FROM records cl
     WHERE cl.id = v_client AND cl.model_id = public._sales_clients_model_id();
  END IF;

  --   3. phone match, ONLY when the conversation record does not exist yet.
  --      api/_lib/chatIngest.ts writes the message BEFORE it upserts the
  --      conversation, so an existing client's very FIRST message arrives
  --      with nothing to read — and that is precisely the message a rep must
  --      not miss. Gated on the record being absent because
  --      find_client_id_by_phone scans unified_records: paying that once per
  --      brand-new conversation is fine, paying it on every message of every
  --      unlinked (spam / advertiser) chat is not.
  IF v_owner IS NULL AND NOT v_conv_found THEN
    v_digits := split_part(NEW.chat_wid, '@', 1);
    IF v_digits ~ '^[0-9]{8,15}$' THEN
      v_client := public.find_client_id_by_phone('+' || v_digits);
      IF v_client IS NOT NULL THEN
        SELECT CASE jsonb_typeof(cl.data->'client_owner')
                 WHEN 'array'  THEN nullif(cl.data->'client_owner'->>0, '')
                 WHEN 'string' THEN nullif(cl.data->>'client_owner', '')
               END
          INTO v_owner
          FROM records cl WHERE cl.id = v_client;
      END IF;
    END IF;
  END IF;

  --   4. the chat's own `owner` assignee — a conversation deliberately handed
  --      to somebody in the Chats UI, with no client record behind it. Unset
  --      on every conversation today (measured 2026-08-18), so this rung is
  --      forward-looking rather than load-bearing.
  IF v_owner IS NULL THEN
    v_owner := CASE jsonb_typeof(v_conv->'owner')
                 WHEN 'array'  THEN nullif(v_conv->'owner'->>0, '')
                 WHEN 'string' THEN nullif(v_conv->>'owner', '')
               END;
  END IF;

  IF v_owner IS NULL THEN
    RETURN NULL;  -- Nobody assigned means nobody to wake up.
  END IF;

  -- A malformed owner is a data bug worth SEEING, but it must not turn into a
  -- cast exception on every message in that conversation.
  IF v_owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE WARNING 'tg_chat_messages_enqueue_push: unusable owner "%" on conversation %',
      v_owner, NEW.conversation_record_id;
    RETURN NULL;
  END IF;
  v_rep := v_owner::uuid;

  -- push_outbox.user_id is FK-bound to public.users; a stale id would raise
  -- and land in the exception handler. Check it instead, and skip deactivated
  -- reps while we are here.
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = v_rep AND u.is_active) THEN
    RETURN NULL;
  END IF;

  -- ── Don't double-buzz for one event ──────────────────────────────────────
  -- This same message is about to run reconcile_inbound_whatsapp, which can
  -- flip an open WhatsApp task and make tg_records_enqueue_push fire
  -- `customer_replied` for the SAME rep about the SAME client, roughly a
  -- second later. The message row is written BEFORE the conversation bump, so
  -- we cannot look back at push_outbox — we look forward instead, at exactly
  -- the two conditions mark_whatsapp_replied acts on.
  --
  -- KEEP IN SYNC with public.mark_whatsapp_replied (2026-07-18) — if its two
  -- UPDATE predicates change, change these. Skipped entirely when the
  -- customer_replied built-in is switched off, so turning that one off can
  -- never leave a rep with no notification at all.
  IF v_replied_on AND v_client IS NOT NULL THEN
    SELECT id INTO v_followups FROM models WHERE name = 'followups';
    IF v_followups IS NOT NULL AND EXISTS (
      SELECT 1 FROM records f
       WHERE f.model_id = v_followups
         AND (CASE jsonb_typeof(f.data->'client_id')
                WHEN 'array'  THEN f.data->'client_id'->>0
                WHEN 'string' THEN f.data->>'client_id'
              END) = v_client::text
         AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
         AND jsonb_typeof(f.data->'followup_type') = 'array'
         AND f.data->'followup_type' ? 'whatsapp_follow_up'
         -- Compared as TEXT on purpose: a ::uuid cast on hand-edited data
         -- would raise rather than simply not match.
         AND (CASE jsonb_typeof(f.data->'sales_rep')
                WHEN 'array'  THEN f.data->'sales_rep'->>0
                WHEN 'string' THEN f.data->>'sales_rep'
              END) = v_rep::text
         AND (
              -- mark_whatsapp_replied step 1: a real reply to a check-in.
              (f.data->>'whatsapp_state' = 'message_sent_waiting_response'
               AND NEW.date >= COALESCE(public.try_timestamptz(f.data->>'sent_at'), '-infinity'::timestamptz))
           OR -- step 2: first early message on a task with no check-in sent.
              (COALESCE(f.data->>'whatsapp_state', '') = ''
               AND COALESCE(public.try_timestamptz(f.data->>'client_messaged_at'), '-infinity'::timestamptz) < NEW.date)
         )
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  -- ── Who + what ───────────────────────────────────────────────────────────
  -- The linked client's name first (the CRM's own name for them), then
  -- WhatsApp's profile name, then the number. "عميل" is the last resort — a
  -- notification that only says "a client" is worse than useless, which is the
  -- lesson of 2026-07-29b.
  -- btrim on every rung: hand-entered client names routinely carry a trailing
  -- space, which renders as «تجربة : …» on the phone.
  IF v_client IS NOT NULL THEN
    SELECT NULLIF(btrim(cl.data->>'client_name'), '') INTO v_name FROM records cl WHERE cl.id = v_client;
  END IF;
  v_name := COALESCE(v_name, NULLIF(btrim(v_conv->>'name'), ''), NULLIF(btrim(NEW.from_phone), ''),
                     NULLIF(split_part(NEW.chat_wid, '@', 1), ''), 'عميل');

  v_preview := NULLIF(btrim(COALESCE(NEW.body, NEW.media_caption, '')), '');
  IF v_preview IS NULL THEN
    v_preview := CASE NEW.kind
                   WHEN 'image'    THEN 'صورة'
                   WHEN 'video'    THEN 'مقطع فيديو'
                   WHEN 'audio'    THEN 'رسالة صوتية'
                   WHEN 'ptt'      THEN 'رسالة صوتية'
                   WHEN 'document' THEN 'مستند'
                   WHEN 'location' THEN 'موقع'
                   WHEN 'sticker'  THEN 'ملصق'
                   WHEN 'contact'  THEN 'جهة اتصال'
                   ELSE NULL
                 END;
  ELSIF length(v_preview) > 120 THEN
    v_preview := left(v_preview, 119) || '…';
  END IF;

  INSERT INTO push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
  VALUES (
    v_rep,
    'whatsapp_inbound',
    '💬 رسالة واتساب جديدة',
    v_name || COALESCE(': ' || v_preview, ''),
    -- Verified against src/App.tsx: /model/chats/:recordId is dispatched to
    -- ChatsSplitPage, which reads :recordId itself and opens that thread.
    '/model/chats/' || NEW.conversation_record_id,
    -- One tag per conversation: the device REPLACES the previous alert for
    -- this chat instead of stacking one per message.
    'chat-' || NEW.conversation_record_id,
    -- …and a 5-minute bucket keyed on the MESSAGE time (not now(), so webhook
    -- retries and re-deliveries are idempotent) means a burst of five messages
    -- creates ONE outbox row, not five. Same "row + moment" shape as the
    -- customer_replied key.
    'wa_in:' || NEW.conversation_record_id || ':' ||
      (floor(extract(epoch FROM NEW.date) / 300))::bigint::text
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  EXCEPTION WHEN OTHERS THEN
    -- A notification must never cost us the MESSAGE. Loud in the Postgres log,
    -- never fatal to the write that triggered it.
    RAISE WARNING 'tg_chat_messages_enqueue_push failed for message % : % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_enqueue_push ON public.chat_messages;
CREATE TRIGGER chat_messages_enqueue_push
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_chat_messages_enqueue_push();

-- ── 3. Validation — fail loudly inside the transaction ──────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'chat_messages' AND t.tgname = 'chat_messages_enqueue_push'
  ) THEN
    RAISE EXCEPTION 'WA_PUSH:TRIGGER_MISSING — chat_messages_enqueue_push was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'push_builtin_settings'
       AND column_name = 'whatsapp_inbound_enabled'
  ) THEN
    RAISE EXCEPTION 'WA_PUSH:SETTING_MISSING — whatsapp_inbound_enabled was not added';
  END IF;
END $$;

COMMIT;
