-- WhatsApp inbound push: deliver UNASSIGNED inbound to a designated inbox user.
--
-- WHY THIS EXISTS (operator report, 2026-08-18)
-- ─────────────────────────────────────────────
-- 2026-08-18_09 wakes the ASSIGNED salesperson, resolved through
--   client_owner mirror → linked client's client_owner → phone match → chat owner.
-- Every rung ends at an *assigned rep*, and "assigned" means the client has a
-- follow-up whose sales_rep is set (client_owner is auto-derived from exactly
-- that — 2026-06-30_client_owner_sales_consultant_auto.sql). So two very common
-- shapes produced NO notification at all:
--   * a chat with no linked client (a brand-new number in an open conversation —
--     rung 3's phone match is skipped once the conversation record exists), and
--   * a freshly created client linked to a chat but with no follow-up yet, so it
--     has no client_owner to resolve.
-- The operator hit both live: only pre-existing chats whose client already had
-- an assigned consultant ever buzzed.
--
-- THE FIX: one designated INBOX USER, chosen by an admin in Profile →
-- Notifications. When — and only when — none of the four rungs resolves an
-- assigned rep, the push is delivered to that inbox user instead of being
-- dropped. Assigned chats are completely unaffected: they still go straight to
-- their consultant and never touch the inbox user. Unset inbox user ⇒ the old
-- behaviour (no push for unassigned) is preserved exactly.
--
-- SHAPE: re-emit tg_chat_messages_enqueue_push VERBATIM from 2026-08-18_09 with
-- the 2026-08-18_10 per-message dedupe_key ('wa_in:' || NEW.id) already folded
-- in, plus ONE new rung (5) and a v_is_fallback flag. Everything else — the
-- inbound/age/kind guards, the kill switch, rep resolution rungs 1–4, the
-- anti-double-buzz stand-down, the who/what preview, the non-fatal exception
-- posture — is unchanged. Re-emitting the whole function (rather than a
-- pg_get_functiondef string-patch) keeps the new definition auditable in one
-- place.
--
-- The anti-double-buzz block is intentionally left untouched: on the fallback
-- path v_rep is the inbox user, and a client reachable only via fallback has NO
-- follow-up carrying that user as sales_rep (if it did, client_owner would have
-- resolved at rung 2), so the block's EXISTS can never match — it is a proven
-- no-op there, not a code path worth complicating.

BEGIN;

-- ── 1. The designated inbox user ────────────────────────────────────────────
-- Nullable: NULL means "no fallback" (the pre-2026-08-18_11 behaviour). ON
-- DELETE SET NULL so removing a user can never leave a dangling recipient — and
-- the trigger's is_active check below is the second line of defence.
ALTER TABLE public.push_builtin_settings
  ADD COLUMN IF NOT EXISTS whatsapp_inbox_user_id uuid
    REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.push_builtin_settings.whatsapp_inbox_user_id IS
  'Fallback recipient for «رسالة واتساب جديدة» when no sales rep is assigned to '
  'the chat (unlinked, or a client with no follow-up yet). NULL = no fallback. '
  'Assigned chats bypass this and go to their consultant. Set 2026-08-18.';

-- ── 2. Re-emit the enqueue with the inbox-user fallback rung ─────────────────
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
  v_is_fallback boolean := false;
BEGIN
  -- ── Cheap guards. No queries, no subtransaction. ─────────────────────────
  IF TG_OP <> 'INSERT' THEN RETURN NULL; END IF;
  IF NEW.flow <> 'in' THEN RETURN NULL; END IF;

  IF NEW.kind IN ('reaction', 'notification_template', 'e2e_notification', 'protocol', 'revoked') THEN
    RETURN NULL;
  END IF;

  -- Backfill / historical-import guard — see 2026-08-18_09 header.
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

  -- ── Resolve the assigned salesperson (rungs 1–4, unchanged) ──────────────
  --   1. conversation.client_owner mirror.
  v_owner := CASE jsonb_typeof(v_conv->'client_owner')
               WHEN 'array'  THEN nullif(v_conv->'client_owner'->>0, '')
               WHEN 'string' THEN nullif(v_conv->>'client_owner', '')
             END;

  v_client_txt := public._link_client_id_of(v_conv);
  IF v_client_txt IS NOT NULL THEN
    BEGIN
      v_client := v_client_txt::uuid;
    EXCEPTION WHEN others THEN
      v_client := NULL;
    END;
  END IF;

  --   2. the LINKED CLIENT's own client_owner.
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

  --   4. the chat's own `owner` assignee.
  IF v_owner IS NULL THEN
    v_owner := CASE jsonb_typeof(v_conv->'owner')
                 WHEN 'array'  THEN nullif(v_conv->'owner'->>0, '')
                 WHEN 'string' THEN nullif(v_conv->>'owner', '')
               END;
  END IF;

  --   5. NEW: designated inbox user. Only when nothing above assigned a rep —
  --      this is precisely the unlinked / unassigned inbound the operator was
  --      missing. Flagged so the (already no-op) anti-double-buzz block is
  --      skipped and this path always delivers.
  IF v_owner IS NULL THEN
    SELECT nullif(s.whatsapp_inbox_user_id::text, '')
      INTO v_owner
      FROM push_builtin_settings s WHERE s.id = 1;
    IF v_owner IS NOT NULL THEN
      v_is_fallback := true;
    END IF;
  END IF;

  IF v_owner IS NULL THEN
    RETURN NULL;  -- No assigned rep and no inbox user: nobody to wake.
  END IF;

  IF v_owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE WARNING 'tg_chat_messages_enqueue_push: unusable owner "%" on conversation %',
      v_owner, NEW.conversation_record_id;
    RETURN NULL;
  END IF;
  v_rep := v_owner::uuid;

  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = v_rep AND u.is_active) THEN
    RETURN NULL;
  END IF;

  -- ── Don't double-buzz for one event (unchanged; skipped on the fallback) ──
  IF NOT v_is_fallback AND v_replied_on AND v_client IS NOT NULL THEN
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
         AND (CASE jsonb_typeof(f.data->'sales_rep')
                WHEN 'array'  THEN f.data->'sales_rep'->>0
                WHEN 'string' THEN f.data->>'sales_rep'
              END) = v_rep::text
         AND (
              (f.data->>'whatsapp_state' = 'message_sent_waiting_response'
               AND NEW.date >= COALESCE(public.try_timestamptz(f.data->>'sent_at'), '-infinity'::timestamptz))
           OR
              (COALESCE(f.data->>'whatsapp_state', '') = ''
               AND COALESCE(public.try_timestamptz(f.data->>'client_messaged_at'), '-infinity'::timestamptz) < NEW.date)
         )
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  -- ── Who + what (unchanged) ───────────────────────────────────────────────
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
    '/model/chats/' || NEW.conversation_record_id,
    'chat-' || NEW.conversation_record_id,
    -- Per-message (2026-08-18_10): chat_messages.id is the PK; INSERT-only, so a
    -- webhook retry re-delivers as UPDATE and never re-fires.
    'wa_in:' || NEW.id
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_chat_messages_enqueue_push failed for message % : % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;

  RETURN NULL;
END;
$$;

-- ── 3. Validation — fail loudly inside the transaction ──────────────────────
DO $$
DECLARE v_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'push_builtin_settings'
       AND column_name = 'whatsapp_inbox_user_id'
  ) THEN
    RAISE EXCEPTION 'WA_PUSH:INBOX_COL_MISSING — whatsapp_inbox_user_id was not added';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_chat_messages_enqueue_push';

  -- The fallback rung must be present…
  IF position('whatsapp_inbox_user_id' in v_src) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: inbox-user fallback rung is missing from the function';
  END IF;
  -- …and the per-message dedupe + device tag from _10/_09 must survive.
  IF position($chk$'wa_in:' || NEW.id$chk$ in v_src) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: per-message dedupe_key was lost';
  END IF;
  IF position($chk$'chat-' || NEW.conversation_record_id$chk$ in v_src) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: the per-conversation tag was lost';
  END IF;

  -- Trigger must still be INSERT-only.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'chat_messages'
       AND t.tgname  = 'chat_messages_enqueue_push'
       AND (t.tgtype & 16) <> 0   -- UPDATE bit
  ) THEN
    RAISE EXCEPTION 'post-condition failed: trigger now fires on UPDATE';
  END IF;
END $$;

COMMIT;
