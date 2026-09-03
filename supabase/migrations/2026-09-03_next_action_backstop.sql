-- Next-Action Backstop — the safety net that owns the invariant
-- "every active client has exactly one open next-action".
--
-- Root cause it closes: the sales-task lifecycle DESTROYS tasks deterministically
-- (SQL trigger bridges: reconcile_outbound_whatsapp, supersede, retire) but only
-- CREATES the next task best-effort (the workflow engine, on a matching branch).
-- Nothing owned the rule that a live client must always have one open next-action,
-- so a task cancelled by a bridge or completed without a create-branch left the
-- client stranded — and the only self-heal (reconcile_inbound_whatsapp) fires only
-- when the CUSTOMER messages again. Live case: منيرة عبدالله (no-show → recovery
-- call auto-cancelled by an outbound message → zero open tasks). See
-- docs/next-action-backstop-spec.md.
--
-- Operator decisions (2026-09-03): grace window 60 min · cadence once daily 08:00
-- Asia/Riyadh (wired as a Vercel cron at 05:00 UTC → /api/cron/reconcile-stranded-
-- clients) · generic fallback = a whatsapp_follow_up · ownerless clients → the
-- System Admin default queue.
--
-- Design notes:
--   * A daily cadence means the workflow engine (which acts in seconds) has ALWAYS
--     already run by the next morning, so this can never race it; the 60-min grace
--     is belt-and-suspenders (only excludes someone stranded in the 07:00-08:00 hr).
--   * NO-SHOW branch must REOPEN an existing recovery call rather than INSERT a new
--     one: tg_records_dedup_noshow_recovery returns NULL for a second recovery call
--     on the same appointment_id (any status), so a fresh insert would be silently
--     swallowed. (This is exactly how منيرة was fixed by hand.)
--   * created_by_user_id / sales_rep must be a public.users.id (NOT auth.uid) — the
--     server-runner FK lesson. Owner = the client's client_owner if it is a real
--     active user, else the resolved default (admin).
--   * SECURITY DEFINER so it sees + writes every client's rows regardless of RLS
--     (same posture as the other reconcile_* bridges).
--   * Idempotent two ways: the "zero open tasks" predicate (a client with a fresh
--     task no longer qualifies) AND a once-per-Riyadh-day state guard (skipped in
--     dry-run so it can be previewed anytime).
--   * Every task it creates carries creation_source='next_action_backstop' — the
--     leak counter that finally makes the drop-rate measurable.

BEGIN;

-- ── 1. Once-a-day run guard (singleton row) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.next_action_backstop_state (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_run_on date
);
INSERT INTO public.next_action_backstop_state (singleton, last_run_on)
VALUES (true, NULL)
ON CONFLICT (singleton) DO NOTHING;

-- ── 2. The reconciler ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconcile_stranded_clients(
  p_default_owner uuid    DEFAULT NULL,   -- NULL → resolve the System Admin
  p_grace_minutes int     DEFAULT 60,
  p_dry_run       boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_clients   uuid;
  v_followups uuid;
  v_appts     uuid;
  v_today     date        := (now() AT TIME ZONE 'Asia/Riyadh')::date;
  v_now_local text        := to_char((now() AT TIME ZONE 'Asia/Riyadh'), 'YYYY-MM-DD"T"HH24:MI');
  v_now_iso   text        := to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_cutoff    timestamptz := now() - make_interval(mins => GREATEST(p_grace_minutes, 0));
  v_default   uuid        := p_default_owner;
  r           record;
  v_owner     uuid;
  v_defaulted boolean;
  v_appt_id   text;
  v_appt_stat text;
  v_existing  uuid;
  v_branch    text;
  v_actions   jsonb := '[]'::jsonb;
  v_created   int := 0;
  v_reopened  int := 0;
  v_skipped   int := 0;
BEGIN
  SELECT id INTO v_clients   FROM models WHERE name = 'clients'      LIMIT 1;
  SELECT id INTO v_followups FROM models WHERE name = 'followups'    LIMIT 1;
  SELECT id INTO v_appts     FROM models WHERE name = 'appointments' LIMIT 1;
  IF v_clients IS NULL OR v_followups IS NULL THEN
    RETURN jsonb_build_object('error', 'clients/followups model missing');
  END IF;

  -- Resolve the default queue owner (System Admin) when not supplied.
  IF v_default IS NULL THEN
    SELECT u.id INTO v_default
    FROM users u JOIN profiles pr ON pr.id = u.profile_id
    WHERE pr.is_admin AND u.is_active
    ORDER BY (u.email = 'r.abanumay@wassel.re') DESC, u.created_at ASC
    LIMIT 1;
  END IF;

  -- Once-a-day guard (a real run only; dry-run may preview anytime).
  IF NOT p_dry_run AND EXISTS (
        SELECT 1 FROM next_action_backstop_state WHERE last_run_on = v_today) THEN
    RETURN jsonb_build_object('skipped', 'already_ran_today', 'date', v_today);
  END IF;

  FOR r IN
    SELECT * FROM (
      SELECT c.id AS client_id,
             NULLIF(c.data->>'client_owner', '') AS owner_raw,
             c.data->>'client_stage' AS stage,
             GREATEST(
               c.updated_at,
               COALESCE((SELECT max(f.updated_at) FROM records f
                          WHERE f.model_id = v_followups
                            AND f.data->>'client_id' = c.id::text), c.updated_at)
             ) AS last_activity
      FROM records c
      WHERE c.model_id = v_clients
        AND COALESCE(c.data->>'is_retired', 'false') <> 'true'
        AND COALESCE(c.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'غير مؤهل')
        AND NOT EXISTS (
          SELECT 1 FROM records f
          WHERE f.model_id = v_followups
            AND f.data->>'client_id' = c.id::text
            AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress'))
        AND (v_appts IS NULL OR NOT EXISTS (
          SELECT 1 FROM records a
          WHERE a.model_id = v_appts
            AND a.data->>'client_id' = c.id::text
            AND COALESCE(a.data->>'appointment_status', '') IN ('scheduled', 'confirmed', 'rescheduled')
            AND a.data->>'appointment_date' ~ '^\d{4}-\d{2}-\d{2}'
            AND left(a.data->>'appointment_date', 10)::date >= v_today))
    ) s
    WHERE s.last_activity <= v_cutoff
  LOOP
    -- Owner: the client's rep if it is a real active user, else the default queue.
    v_owner := NULL;
    IF r.owner_raw ~ '^[0-9a-fA-F-]{36}$' THEN
      SELECT id INTO v_owner FROM users WHERE id = r.owner_raw::uuid AND is_active;
    END IF;
    v_defaulted := (v_owner IS NULL);
    IF v_owner IS NULL THEN v_owner := v_default; END IF;

    -- Most recent appointment → decides the branch.
    v_appt_id := NULL; v_appt_stat := NULL;
    IF v_appts IS NOT NULL THEN
      SELECT a.id::text, a.data->>'appointment_status'
        INTO v_appt_id, v_appt_stat
      FROM records a
      WHERE a.model_id = v_appts AND a.data->>'client_id' = r.client_id::text
      ORDER BY a.created_at DESC LIMIT 1;
    END IF;

    v_branch := CASE WHEN v_appt_stat = 'no_show' AND v_appt_id IS NOT NULL
                     THEN 'no_show_recovery_call' ELSE 'whatsapp_follow_up' END;

    -- Dry-run: record what WOULD happen, write nothing.
    IF p_dry_run THEN
      v_actions := v_actions || jsonb_build_object(
        'client_id', r.client_id, 'stage', r.stage,
        'owner', v_owner, 'owner_defaulted', v_defaulted,
        'branch', v_branch,
        'appointment_id', CASE WHEN v_branch = 'no_show_recovery_call' THEN v_appt_id END,
        'last_activity', r.last_activity);
      CONTINUE;
    END IF;

    -- No owner and no default resolvable → report-only (cannot assign to nobody).
    IF v_owner IS NULL THEN
      v_skipped := v_skipped + 1;
      v_actions := v_actions || jsonb_build_object('client_id', r.client_id, 'branch', 'SKIPPED_no_owner');
      CONTINUE;
    END IF;

    IF v_branch = 'no_show_recovery_call' THEN
      -- Reopen the existing recovery call for this appointment (dedup trigger
      -- forbids a second insert); create only if none exists.
      SELECT f.id INTO v_existing
      FROM records f
      WHERE f.model_id = v_followups
        AND f.data->>'appointment_id' = v_appt_id
        AND ((jsonb_typeof(f.data->'followup_type') = 'array' AND f.data->'followup_type' ? 'no_show_recovery_call')
              OR f.data->>'followup_type' = 'no_show_recovery_call')
      ORDER BY f.created_at DESC LIMIT 1;

      IF v_existing IS NOT NULL THEN
        UPDATE records
        SET data = (data - 'cancelled_at' - 'cancel_reason' - 'cancelled_by_system'
                        - 'cancelled_by_event_type' - 'cancelled_by_event_id' - 'fired_at')
                   || jsonb_build_object(
                        'followup_status', 'open',
                        'scheduled_datetime', v_now_local,
                        'sales_rep', v_owner::text,
                        'creation_source', 'next_action_backstop',
                        'backstop_reopened_at', v_now_iso),
            updated_at = now()
        WHERE id = v_existing;
        v_reopened := v_reopened + 1;
      ELSE
        INSERT INTO records (id, model_id, data, created_by_user_id)
        VALUES (gen_random_uuid(), v_followups, jsonb_build_object(
                  'client_id', r.client_id::text,
                  'sales_rep', v_owner::text,
                  'followup_type', jsonb_build_array('no_show_recovery_call'),
                  'followup_status', 'open',
                  'appointment_id', v_appt_id,
                  'scheduled_datetime', v_now_local,
                  'creation_source', 'next_action_backstop'),
                v_owner);
        v_created := v_created + 1;
      END IF;
    ELSE
      INSERT INTO records (id, model_id, data, created_by_user_id)
      VALUES (gen_random_uuid(), v_followups, jsonb_build_object(
                'client_id', r.client_id::text,
                'sales_rep', v_owner::text,
                'followup_type', jsonb_build_array('whatsapp_follow_up'),
                'followup_status', 'open',
                'scheduled_datetime', v_now_local,
                'creation_source', 'next_action_backstop'),
              v_owner);
      v_created := v_created + 1;
    END IF;

    v_actions := v_actions || jsonb_build_object(
      'client_id', r.client_id, 'owner', v_owner,
      'owner_defaulted', v_defaulted, 'branch', v_branch);
  END LOOP;

  IF NOT p_dry_run THEN
    UPDATE next_action_backstop_state SET last_run_on = v_today WHERE singleton;
  END IF;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run, 'date', v_today, 'grace_minutes', p_grace_minutes,
    'default_owner', v_default,
    'created', v_created, 'reopened', v_reopened, 'skipped_no_owner', v_skipped,
    'count', jsonb_array_length(v_actions), 'actions', v_actions);
END;
$$;

-- Callable only by the cron endpoint's service-role client (never a browser JWT).
REVOKE ALL ON FUNCTION public.reconcile_stranded_clients(uuid, int, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_stranded_clients(uuid, int, boolean) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_stranded_clients(uuid, int, boolean) TO service_role;

COMMIT;
