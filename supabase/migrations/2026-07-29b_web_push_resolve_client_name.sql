-- Notification bodies were showing the bare word "عميل".
--
-- Observed on a REAL delivered push, not in review: the enqueue trigger read
-- the denormalized `client_name` off the follow-up, and a follow-up created by
-- a path that doesn't copy that field down produced a notification saying only
-- "a client" — which tells a rep nothing and makes the alert worse than useless
-- (they have to open the app to learn who it is, defeating the point).
--
-- The follow-up already carries client_id, so follow the link. The generic word
-- is now only reached when the follow-up genuinely has no client attached.
--
-- Supersedes the function defined in 2026-07-29_web_push.sql. Everything else
-- about it is unchanged — see that file for why the exception handler sits in a
-- nested block below the model check (subtransaction-per-row cost).

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_records_enqueue_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_followups_model uuid;
  v_rep             uuid;
  v_type            text;
  v_stage           text;
  v_client          uuid;
  v_name            text;
  v_old_state       text;
  v_new_state       text;
  v_status          text;
BEGIN
  -- Unguarded and first — only follow-up rows may pay for the subtransaction
  -- that the EXCEPTION block below opens.
  SELECT id INTO v_followups_model FROM models WHERE name = 'followups';
  IF v_followups_model IS NULL OR NEW.model_id <> v_followups_model THEN
    RETURN NULL;
  END IF;

  BEGIN

  v_rep := NULLIF(
    CASE jsonb_typeof(NEW.data->'sales_rep')
      WHEN 'array'  THEN NEW.data->'sales_rep'->>0
      WHEN 'string' THEN NEW.data->>'sales_rep'
    END, '')::uuid;

  IF v_rep IS NULL THEN
    RETURN NULL;
  END IF;

  v_status := COALESCE(NULLIF(NEW.data->>'followup_status', ''), 'open');
  IF v_status IN ('completed', 'cancelled', 'skipped') THEN
    RETURN NULL;
  END IF;

  -- Resolved once, for both branches (the UPDATE branch previously never
  -- looked at the client at all).
  v_client := NULLIF(
    CASE jsonb_typeof(NEW.data->'client_id')
      WHEN 'array'  THEN NEW.data->'client_id'->>0
      WHEN 'string' THEN NEW.data->>'client_id'
    END, '')::uuid;

  -- Denormalized name first, then the LINKED CLIENT's name, then the generic
  -- word as a last resort.
  v_name := NULLIF(NEW.data->>'client_name', '');
  IF v_name IS NULL AND v_client IS NOT NULL THEN
    SELECT NULLIF(r.data->>'client_name', '') INTO v_name
      FROM records r WHERE r.id = v_client;
  END IF;
  v_name := COALESCE(v_name, 'عميل');

  IF TG_OP = 'INSERT' THEN
    v_type := CASE jsonb_typeof(NEW.data->'followup_type')
                WHEN 'array'  THEN NEW.data->'followup_type'->>0
                WHEN 'string' THEN NEW.data->>'followup_type'
              END;

    IF v_type = 'appointment_booking_call'
       AND COALESCE(NULLIF(NEW.data->>'escalation_reason', ''), '') = ''
       AND COALESCE(NULLIF(NEW.data->>'previous_followup_id', ''), '') = ''
    THEN
      SELECT r.data->>'client_stage' INTO v_stage
        FROM records r WHERE r.id = v_client;

      IF (v_stage IS NULL OR v_stage = 'جديد')
         AND NOT EXISTS (
           SELECT 1 FROM records o
            WHERE o.model_id = v_followups_model
              AND o.id <> NEW.id
              AND o.created_at <= NEW.created_at
              AND (CASE jsonb_typeof(o.data->'client_id')
                     WHEN 'array'  THEN o.data->'client_id'->>0
                     WHEN 'string' THEN o.data->>'client_id'
                   END)::uuid = v_client
              AND (CASE jsonb_typeof(o.data->'followup_type')
                     WHEN 'array'  THEN o.data->'followup_type'->>0
                     WHEN 'string' THEN o.data->>'followup_type'
                   END) = 'appointment_booking_call'
         )
      THEN
        INSERT INTO push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
        VALUES (
          v_rep, 'hot_lead',
          '🔥 عميل جديد — اتصل خلال ٥ دقائق',
          v_name,
          '/model/followups/' || NEW.id || '?returnTo=%2Fsales%2Fmy-tasks',
          'followup-' || NEW.id,
          'hot_lead:' || NEW.id
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
      END IF;
    END IF;

    RETURN NULL;
  END IF;

  v_old_state := CASE
    WHEN COALESCE(OLD.data->>'whatsapp_state', '') <> '' THEN OLD.data->>'whatsapp_state'
    WHEN COALESCE(OLD.data->>'client_messaged_at', '') <> '' THEN 'replied'
    ELSE '' END;
  v_new_state := CASE
    WHEN COALESCE(NEW.data->>'whatsapp_state', '') <> '' THEN NEW.data->>'whatsapp_state'
    WHEN COALESCE(NEW.data->>'client_messaged_at', '') <> '' THEN 'replied'
    ELSE '' END;

  IF v_new_state = 'replied' AND v_old_state <> 'replied' THEN
    INSERT INTO push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
    VALUES (
      v_rep, 'customer_replied',
      '💬 العميل رد — دورك الآن',
      v_name,
      '/model/followups/' || NEW.id || '?returnTo=%2Fsales%2Fmy-tasks',
      'followup-' || NEW.id,
      'replied:' || NEW.id || ':' || COALESCE(NEW.data->>'client_messaged_at', NEW.updated_at::text)
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  END IF;

  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_records_enqueue_push failed for record % : % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;

  RETURN NULL;
END;
$$;

COMMIT;
