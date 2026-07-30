-- Kill switch for the two BUILT-IN notifications (hot lead, customer replied).
--
-- Those two are produced by tg_records_enqueue_push, not by a workflow. Now that
-- a Notification action can be configured per workflow (see the send_notification
-- recipient work), someone building their own "new lead" rule would receive TWO
-- alerts for one event — one from their rule, one from the trigger. This switch
-- lets the built-ins be turned off, so a hand-built rule can REPLACE a built-in
-- instead of competing with it.
--
-- Workspace-wide and admin-only: one rep switching it off would silence every
-- other rep, so RLS restricts UPDATE to admin profiles.
--
-- Supersedes the function in 2026-07-29b. Only the two guards are new;
-- everything else is carried over unchanged (see 2026-07-29_web_push.sql for
-- why the exception handler sits in a nested block below the model check).

BEGIN;

CREATE TABLE IF NOT EXISTS public.push_builtin_settings (
  id                       integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hot_lead_enabled         boolean NOT NULL DEFAULT true,
  customer_replied_enabled boolean NOT NULL DEFAULT true,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid
);

INSERT INTO public.push_builtin_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.push_builtin_settings ENABLE ROW LEVEL SECURITY;

-- Readable by anyone signed in, so a rep can see why they are (or aren't)
-- getting the built-in alerts.
DROP POLICY IF EXISTS push_builtin_read ON public.push_builtin_settings;
CREATE POLICY push_builtin_read ON public.push_builtin_settings
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Admin-only writes. NOTE for callers: an RLS-denied UPDATE does NOT raise — it
-- matches zero rows. Verified against production. Any client writing this table
-- must read the affected rows back (`.select()`) and treat 0 as a failure, or it
-- will report success while changing nothing. See src/lib/push/builtinSettings.ts.
DROP POLICY IF EXISTS push_builtin_admin_update ON public.push_builtin_settings;
CREATE POLICY push_builtin_admin_update ON public.push_builtin_settings
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.users u
      JOIN public.profiles p ON p.id = u.profile_id
      WHERE u.auth_uid = auth.uid() AND u.is_active AND p.is_admin
    )
  );

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
  v_hot_on          boolean;
  v_replied_on      boolean;
BEGIN
  SELECT id INTO v_followups_model FROM models WHERE name = 'followups';
  IF v_followups_model IS NULL OR NEW.model_id <> v_followups_model THEN
    RETURN NULL;
  END IF;

  BEGIN

  -- Missing row ⇒ both ON. A deleted settings row must degrade to today's
  -- behaviour, never to silently muting every alert in the system.
  SELECT COALESCE(s.hot_lead_enabled, true), COALESCE(s.customer_replied_enabled, true)
    INTO v_hot_on, v_replied_on
    FROM push_builtin_settings s WHERE s.id = 1;
  v_hot_on     := COALESCE(v_hot_on, true);
  v_replied_on := COALESCE(v_replied_on, true);

  IF NOT v_hot_on AND NOT v_replied_on THEN
    RETURN NULL;
  END IF;

  v_rep := NULLIF(
    CASE jsonb_typeof(NEW.data->'sales_rep')
      WHEN 'array'  THEN NEW.data->'sales_rep'->>0
      WHEN 'string' THEN NEW.data->>'sales_rep'
    END, '')::uuid;
  IF v_rep IS NULL THEN RETURN NULL; END IF;

  v_status := COALESCE(NULLIF(NEW.data->>'followup_status', ''), 'open');
  IF v_status IN ('completed', 'cancelled', 'skipped') THEN RETURN NULL; END IF;

  v_client := NULLIF(
    CASE jsonb_typeof(NEW.data->'client_id')
      WHEN 'array'  THEN NEW.data->'client_id'->>0
      WHEN 'string' THEN NEW.data->>'client_id'
    END, '')::uuid;

  v_name := NULLIF(NEW.data->>'client_name', '');
  IF v_name IS NULL AND v_client IS NOT NULL THEN
    SELECT NULLIF(r.data->>'client_name', '') INTO v_name FROM records r WHERE r.id = v_client;
  END IF;
  v_name := COALESCE(v_name, 'عميل');

  IF TG_OP = 'INSERT' THEN
    IF NOT v_hot_on THEN RETURN NULL; END IF;

    v_type := CASE jsonb_typeof(NEW.data->'followup_type')
                WHEN 'array'  THEN NEW.data->'followup_type'->>0
                WHEN 'string' THEN NEW.data->>'followup_type'
              END;

    IF v_type = 'appointment_booking_call'
       AND COALESCE(NULLIF(NEW.data->>'escalation_reason', ''), '') = ''
       AND COALESCE(NULLIF(NEW.data->>'previous_followup_id', ''), '') = ''
    THEN
      SELECT r.data->>'client_stage' INTO v_stage FROM records r WHERE r.id = v_client;

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
        VALUES (v_rep, 'hot_lead', '🔥 عميل جديد — اتصل خلال ٥ دقائق', v_name,
                '/model/followups/' || NEW.id || '?returnTo=%2Fsales%2Fmy-tasks',
                'followup-' || NEW.id, 'hot_lead:' || NEW.id)
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
      END IF;
    END IF;

    RETURN NULL;
  END IF;

  IF NOT v_replied_on THEN RETURN NULL; END IF;

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
    VALUES (v_rep, 'customer_replied', '💬 العميل رد — دورك الآن', v_name,
            '/model/followups/' || NEW.id || '?returnTo=%2Fsales%2Fmy-tasks',
            'followup-' || NEW.id,
            'replied:' || NEW.id || ':' || COALESCE(NEW.data->>'client_messaged_at', NEW.updated_at::text))
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
