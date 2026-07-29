-- Web Push for the installed iOS app.
--
-- The app became installable on 2026-07-28. In-app alerts already existed
-- (src/components/SalesNotifications.tsx) but they only fire while the app is
-- OPEN on screen, and they call `new Notification(...)`, which iOS does not
-- support at all. A rep with the phone in their pocket got nothing.
--
-- Reaching a CLOSED phone means the trigger has to be server-side, so this adds
-- the two pieces that were missing: somewhere to record a rep's devices, and a
-- queue of pending notifications for a worker to deliver.
--
-- Delivery runs on the Fly worker rather than from Postgres because neither
-- pg_net nor pg_cron is installed on this project — the database cannot make an
-- HTTP call. That matches the other seven queues on that worker.
--
-- ADDITIVE BY DESIGN: this does not modify reconcile_inbound_whatsapp or any
-- other existing sales function. The enqueue trigger is a separate AFTER
-- trigger, so a bug here cannot corrupt the reconciliation logic.

BEGIN;

-- ── A rep's devices ─────────────────────────────────────────────────────────
-- One row per browser/device. `endpoint` is the push service URL the browser
-- hands us; it is the natural key (re-subscribing on the same device returns
-- the same endpoint, so ON CONFLICT refreshes rather than duplicates).
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Stored alongside user_id so RLS can check ownership without a join.
  auth_uid        uuid NOT NULL,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failure_count   integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- A device registration belongs to the person sitting at it. No cross-user
-- reads: knowing someone else's endpoint + keys is enough to push to them.
DROP POLICY IF EXISTS push_subs_own_select ON public.push_subscriptions;
CREATE POLICY push_subs_own_select ON public.push_subscriptions
  FOR SELECT USING (auth_uid = auth.uid());

-- user_id is bound to the JWT, not taken on trust. Without this a signed-in rep
-- could register their own device under a COLLEAGUE's user_id and start
-- receiving that colleague's lead notifications.
DROP POLICY IF EXISTS push_subs_own_insert ON public.push_subscriptions;
CREATE POLICY push_subs_own_insert ON public.push_subscriptions
  FOR INSERT WITH CHECK (
    auth_uid = auth.uid()
    AND user_id = (SELECT u.id FROM public.users u WHERE u.auth_uid = auth.uid())
  );

DROP POLICY IF EXISTS push_subs_own_update ON public.push_subscriptions;
CREATE POLICY push_subs_own_update ON public.push_subscriptions
  FOR UPDATE USING (auth_uid = auth.uid())
  WITH CHECK (
    auth_uid = auth.uid()
    AND user_id = (SELECT u.id FROM public.users u WHERE u.auth_uid = auth.uid())
  );

DROP POLICY IF EXISTS push_subs_own_delete ON public.push_subscriptions;
CREATE POLICY push_subs_own_delete ON public.push_subscriptions
  FOR DELETE USING (auth_uid = auth.uid());

-- ── The delivery queue ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind        text NOT NULL,           -- hot_lead | customer_replied | test
  title       text NOT NULL,
  body        text NOT NULL,
  url         text,                    -- in-app path opened when tapped
  tag         text,                    -- iOS collapses same-tag notifications
  -- Guards against the same real-world event being enqueued twice (a retried
  -- write, a workflow re-running). NULL opts a row out of deduplication.
  dedupe_key  text,
  status      text NOT NULL DEFAULT 'pending',  -- pending|running|sent|failed
  attempts    integer NOT NULL DEFAULT 0,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at  timestamptz,
  sent_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS push_outbox_dedupe_idx
  ON public.push_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS push_outbox_pending_idx
  ON public.push_outbox (created_at) WHERE status = 'pending';

-- Service-role only: the queue is written by triggers and drained by the
-- worker. No policies are created, so RLS denies everything to normal clients.
ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;

-- ── Enqueue on the two moments that matter ──────────────────────────────────
-- Mirrors the conditions in src/components/SalesNotifications.tsx so the phone
-- and the open app agree about what is worth interrupting someone for. If you
-- change one, change the other.
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
  -- EVERYTHING BELOW THE MODEL CHECK LIVES IN A NESTED BLOCK, and that is
  -- deliberate. A plpgsql BEGIN...EXCEPTION block opens a SUBTRANSACTION for
  -- every row it runs on. This trigger fires on all of `records` — 87k rows
  -- across 48 models, including bulk market-listing scans — so an exception
  -- handler around the whole body would put a savepoint on every write in the
  -- system to guard logic that only concerns follow-ups. The model check runs
  -- unguarded and returns first; only follow-up rows pay for the subtransaction.
  SELECT id INTO v_followups_model FROM models WHERE name = 'followups';
  IF v_followups_model IS NULL OR NEW.model_id <> v_followups_model THEN
    RETURN NULL;
  END IF;

  BEGIN

  -- sales_rep is written as a bare string by some paths and a single-element
  -- array by others; accept both rather than depending on the writer.
  v_rep := NULLIF(
    CASE jsonb_typeof(NEW.data->'sales_rep')
      WHEN 'array'  THEN NEW.data->'sales_rep'->>0
      WHEN 'string' THEN NEW.data->>'sales_rep'
    END, '')::uuid;

  -- Nobody assigned means nobody to wake up.
  IF v_rep IS NULL THEN
    RETURN NULL;
  END IF;

  v_status := COALESCE(NULLIF(NEW.data->>'followup_status', ''), 'open');
  IF v_status IN ('completed', 'cancelled', 'skipped') THEN
    RETURN NULL;
  END IF;

  v_name := COALESCE(NULLIF(NEW.data->>'client_name', ''), 'عميل');

  -- ── 1. HOT LEAD ───────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    v_type := CASE jsonb_typeof(NEW.data->'followup_type')
                WHEN 'array'  THEN NEW.data->'followup_type'->>0
                WHEN 'string' THEN NEW.data->>'followup_type'
              END;

    IF v_type = 'appointment_booking_call'
       -- An escalated old lead also lands as a fresh booking call on a client
       -- still tagged جديد, so type + stage cannot tell them apart. These two
       -- gates are what distinguish a genuine first touch.
       AND COALESCE(NULLIF(NEW.data->>'escalation_reason', ''), '') = ''
       AND COALESCE(NULLIF(NEW.data->>'previous_followup_id', ''), '') = ''
    THEN
      v_client := NULLIF(
        CASE jsonb_typeof(NEW.data->'client_id')
          WHEN 'array'  THEN NEW.data->'client_id'->>0
          WHEN 'string' THEN NEW.data->>'client_id'
        END, '')::uuid;

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

  -- ── 2. CUSTOMER REPLIED ───────────────────────────────────────────────────
  -- "Replied" is either an explicit whatsapp_state, or client_messaged_at
  -- getting stamped on a task that had no state — same rule the in-app watcher
  -- uses.
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
      -- Same task can legitimately go quiet and be replied to again later, so
      -- the key includes the moment rather than only the row.
      'replied:' || NEW.id || ':' || COALESCE(NEW.data->>'client_messaged_at', NEW.updated_at::text)
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  END IF;

  EXCEPTION WHEN OTHERS THEN
    -- A notification must never cost us the follow-up itself. This is NOT a
    -- silent swallow: RAISE WARNING lands in the Postgres logs with the failing
    -- row, so a broken enqueue is visible and diagnosable — it just doesn't
    -- roll back the sales write that triggered it.
    RAISE WARNING 'tg_records_enqueue_push failed for record % : % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS records_enqueue_push ON public.records;
CREATE TRIGGER records_enqueue_push
  AFTER INSERT OR UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_records_enqueue_push();

-- ── Worker RPCs ─────────────────────────────────────────────────────────────
-- Claim a batch. SKIP LOCKED so several worker machines never take the same row.
CREATE OR REPLACE FUNCTION public.push_outbox_claim_next(p_limit integer DEFAULT 10)
RETURNS SETOF public.push_outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE push_outbox
     SET status = 'running', attempts = attempts + 1, claimed_at = now()
   WHERE id IN (
     SELECT id FROM push_outbox
      WHERE status = 'pending'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
   )
   RETURNING *;
$$;

-- Terminal writes only touch rows still 'running', so a late completion after
-- the watchdog has already swept the job is a no-op instead of an overwrite.
-- Same posture as the other seven queues.
CREATE OR REPLACE FUNCTION public.push_outbox_complete(p_id uuid, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE push_outbox
     SET status = CASE WHEN p_error IS NULL THEN 'sent' ELSE 'failed' END,
         sent_at = now(), error = p_error
   WHERE id = p_id AND status = 'running';
$$;

-- Give up after 5 attempts; before that, put it back for another machine.
CREATE OR REPLACE FUNCTION public.push_outbox_fail(p_id uuid, p_error text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE push_outbox
     SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
         error = p_error
   WHERE id = p_id AND status = 'running';
$$;

-- A crashed worker must not strand a notification in 'running' forever.
CREATE OR REPLACE FUNCTION public.push_outbox_watchdog()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH swept AS (
    UPDATE push_outbox
       SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
           error  = 'watchdog: claimed but never completed'
     WHERE status = 'running' AND claimed_at < now() - interval '5 minutes'
     RETURNING 1
  )
  SELECT COALESCE(count(*), 0)::integer FROM swept;
$$;

-- A notification nobody delivered within the hour is stale news; a rep opening
-- the app hours later should not be told to "call within 5 minutes".
CREATE OR REPLACE FUNCTION public.push_outbox_expire_stale()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH expired AS (
    UPDATE push_outbox
       SET status = 'failed', error = 'expired before delivery'
     WHERE status = 'pending' AND created_at < now() - interval '1 hour'
     RETURNING 1
  )
  SELECT COALESCE(count(*), 0)::integer FROM expired;
$$;

-- Diagnostic counter for "this device keeps rejecting pushes". Atomic rather
-- than read-modify-write in the worker, which would race whenever several
-- notifications go out at once.
CREATE OR REPLACE FUNCTION public.increment_push_failure(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE push_subscriptions
     SET failure_count = failure_count + 1
   WHERE id = p_id;
$$;

REVOKE ALL ON FUNCTION public.increment_push_failure(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_outbox_claim_next(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_outbox_complete(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_outbox_fail(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_outbox_watchdog() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_outbox_expire_stale() FROM PUBLIC, anon, authenticated;

COMMIT;
