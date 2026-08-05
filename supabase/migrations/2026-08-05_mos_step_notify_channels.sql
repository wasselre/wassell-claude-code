-- ============================================================================
-- Per-step notification channels for role-path workflows.
--
-- Adds an optional `p_channels text[]` mask to notify_emit. Each role-path step
-- now carries `notify` (a master on/off) and `notify_channels` (a subset of
-- inapp/push/whatsapp) in workflows.metadata.steps — a pure JSONB change that
-- needs no DDL. What DOES change is emission: when the workflow-step advance
-- path passes a channel mask, notify_emit AND-s each channel with the
-- recipient's own role grid (Settings → Notifications). A step can therefore
-- NARROW what a role already allows, never widen it.
--
-- BACKWARD COMPATIBLE. p_channels defaults to NULL, and NULL means exactly the
-- old behavior: in-app is written unconditionally and push/whatsapp follow the
-- role grid. Every existing caller (the sweeps digest, budget-signature, shoot
-- deliveries, mentions) passes no mask and is untouched. Legacy steps with no
-- notify_channels key resolve to "all three" in the API, so in-flight records
-- behave exactly as before.
--
-- Signature change (9 → 10 args) means DROP + CREATE, not CREATE OR REPLACE.
-- Function-to-function calls are late-bound, so the plpgsql callers in
-- 2026-08-01_06_notification_sweeps.sql keep resolving (their 9 positional args
-- fill the new default).
--
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

DROP FUNCTION IF EXISTS public.notify_emit(
  text, text, text[], uuid[], text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.notify_emit(
  p_workspace text,
  p_event     text,
  p_role_keys text[],
  p_user_ids  uuid[],
  p_title_ar  text,
  p_title_en  text,
  p_body_ar   text,
  p_body_en   text,
  p_url       text,
  -- Per-step channel mask. NULL = no restriction (in-app unconditional, push /
  -- whatsapp per grid — the original behavior). A non-null subset of
  -- {inapp,push,whatsapp} gates each channel AGAINST the grid: a channel fires
  -- only when the step permits it AND the recipient's role settings enable it.
  p_channels  text[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_external    boolean;
  v_uid         uuid;
  v_nid         uuid;
  v_count       integer := 0;
  v_role_ids    uuid[];
  v_grid_inapp  boolean;
  v_grid_push   boolean;
  v_grid_wa     boolean;
  v_wa_pref     boolean;
  v_fire_inapp  boolean;
  v_fire_push   boolean;
  v_fire_wa     boolean;
  -- Step-permitted channels. When p_channels IS NULL every channel is permitted
  -- and in-app stays unconditional (grid ignored for in-app, as before).
  v_allow_inapp boolean := (p_channels IS NULL) OR ('inapp'    = ANY(p_channels));
  v_allow_push  boolean := (p_channels IS NULL) OR ('push'     = ANY(p_channels));
  v_allow_wa    boolean := (p_channels IS NULL) OR ('whatsapp' = ANY(p_channels));
BEGIN
  v_external := COALESCE(
    (SELECT (value->>'enabled')::boolean FROM public.mos_settings WHERE key = 'external_effects'),
    true);

  FOR v_uid IN
    SELECT DISTINCT s.uid
      FROM (
        SELECT unnest(p_user_ids) AS uid
        UNION
        SELECT u.id
          FROM public.users u
         WHERE u.is_active
           AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
               JOIN public.roles r ON r.id::text = e->>'role_id'
              WHERE r.key = ANY(p_role_keys))
      ) s
     WHERE s.uid IS NOT NULL
  LOOP
    -- The recipient's own roles decide which channels the grid enables.
    SELECT array_agg((e->>'role_id')::uuid)
      INTO v_role_ids
      FROM public.users u,
           jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
     WHERE u.id = v_uid;

    SELECT COALESCE(bool_or(nr.enabled), false) INTO v_grid_push
      FROM public.notification_rules nr
     WHERE nr.event = p_event AND nr.channel = 'push'
       AND nr.role_id = ANY(COALESCE(v_role_ids, '{}'));

    SELECT COALESCE(bool_or(nr.enabled), false) INTO v_grid_wa
      FROM public.notification_rules nr
     WHERE nr.event = p_event AND nr.channel = 'whatsapp'
       AND nr.role_id = ANY(COALESCE(v_role_ids, '{}'));

    -- In-app: unconditional in the legacy (NULL-mask) path; under a mask it is
    -- gated by BOTH the step and the role grid, so a step can silence the
    -- in-app inbox entry for its owner just like any other channel.
    IF p_channels IS NULL THEN
      v_fire_inapp := true;
    ELSE
      SELECT COALESCE(bool_or(nr.enabled), false) INTO v_grid_inapp
        FROM public.notification_rules nr
       WHERE nr.event = p_event AND nr.channel = 'inapp'
         AND nr.role_id = ANY(COALESCE(v_role_ids, '{}'));
      v_fire_inapp := v_allow_inapp AND v_grid_inapp;
    END IF;

    v_fire_push := v_allow_push AND v_grid_push;
    v_fire_wa   := v_allow_wa   AND v_grid_wa;

    -- Nothing on any channel → this recipient is not interrupted at all, and no
    -- inbox row is written. (In the NULL path v_fire_inapp is always true, so an
    -- in-app row is always written — identical to the previous behavior.)
    IF NOT (v_fire_inapp OR v_fire_push OR v_fire_wa) THEN
      CONTINUE;
    END IF;

    -- The notifications row is the canonical event record AND the anchor that
    -- push_outbox / notification_deliveries reference. It is written whenever
    -- anything fires; when in-app itself is masked off it is stamped read so it
    -- never counts as an unread inbox item (the badge counts only unread rows),
    -- while still anchoring the external deliveries.
    INSERT INTO public.notifications
      (user_id, workspace, kind, title_ar, title_en, body_ar, body_en, url, read_at)
    VALUES
      (v_uid, p_workspace, p_event, p_title_ar, p_title_en, p_body_ar, p_body_en, p_url,
       CASE WHEN v_fire_inapp THEN NULL ELSE now() END)
    RETURNING id INTO v_nid;
    v_count := v_count + 1;

    -- ── push → existing push_outbox queue ─────────────────────────────────
    IF v_fire_push THEN
      IF v_external THEN
        INSERT INTO public.push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
        VALUES (
          v_uid,
          'notify:' || p_event,
          COALESCE(p_title_ar, p_title_en),
          COALESCE(p_body_ar, p_body_en, ''),
          p_url,
          'ntf-' || p_event,
          'ntf:' || v_nid || ':' || v_uid
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
      ELSE
        RAISE NOTICE 'notify_emit: push skipped (external_effects off) event=% user=%', p_event, v_uid;
      END IF;
    END IF;

    -- ── whatsapp → notification_deliveries queue ──────────────────────────
    IF v_fire_wa THEN
      -- Absent prefs row = whatsapp on (the default).
      SELECT p.whatsapp_enabled INTO v_wa_pref
        FROM public.notification_prefs p WHERE p.user_id = v_uid;
      v_wa_pref := COALESCE(v_wa_pref, true);

      IF v_external AND v_wa_pref THEN
        INSERT INTO public.notification_deliveries (notification_id, channel)
        VALUES (v_nid, 'whatsapp');
      ELSIF NOT v_external AND v_wa_pref THEN
        -- Visible no-op: the delivery WOULD have fired. Logged so an operator
        -- can see exactly what the kill switch suppressed.
        INSERT INTO public.notification_deliveries (notification_id, channel, status, last_error)
        VALUES (v_nid, 'whatsapp', 'skipped', 'external-effects-off');
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_emit(text, text, text[], uuid[], text, text, text, text, text, text[])
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Validation — fail loudly inside the transaction if the new shape did not land
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'notify_emit'
      AND p.pronargs = 10
  ) THEN
    RAISE EXCEPTION 'NTF:EMIT_ARITY — notify_emit(10 args) was not created';
  END IF;
END $$;

COMMIT;
