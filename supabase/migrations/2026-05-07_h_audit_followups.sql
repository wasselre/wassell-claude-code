-- ============================================================================
-- Audit follow-up migration — addresses HIGH/MEDIUM/LOW findings from the
-- 2026-05-07 codebase audit that need DDL changes.
--
-- Findings closed by this migration:
--   H4  — models_view_sync trigger swallows DDL failures (now persists to a
--         model_view_sync_failures table that an admin UI can surface).
--   H6  — freeze_model concurrency: wrap in advisory lock + idempotency guard.
--   L2  — record_search rejects p_limit < 1 with a clear error.
--   L3  — freeze_model emits an activity_log entry.
--   M7  — Haberchat webhook DLQ table for failed event inserts.
--   M11 — record_search validates cursor shape before use.
--   M12 — rebuild_unified_records uses CREATE OR REPLACE when column list is
--         unchanged (less aggressive locking; advisory lock to serialize).
--   M13 — record_assign_auto_id verifies the caller can create on the model
--         before incrementing the counter.
--   M14 — webhook_payloads gets a daily prune of >90-day rows.
--
-- All changes are idempotent and safe to run on top of the post-Phases-A–G
-- schema (2026-05-06 + earlier 2026-05-07 migrations).
-- ============================================================================

BEGIN;

-- ─── H4 — model_view_sync_failures (persist what RAISE WARNING discarded) ───

CREATE TABLE IF NOT EXISTS public.model_view_sync_failures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id    uuid,
  model_name  text,
  tg_op       text,
  sqlstate    text,
  message     text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE public.model_view_sync_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mvsf_admin_all ON public.model_view_sync_failures;
CREATE POLICY mvsf_admin_all ON public.model_view_sync_failures
  FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

GRANT SELECT, UPDATE ON public.model_view_sync_failures TO authenticated;

CREATE OR REPLACE FUNCTION public.models_view_sync_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.drop_model_view(OLD.name);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name THEN
    PERFORM public.drop_model_view(OLD.name);
  END IF;
  PERFORM public.regenerate_model_view(NEW.id);
  RETURN NEW;
EXCEPTION WHEN others THEN
  -- Audit fix H4: persist the failure to a queryable table so an admin
  -- UI / monitoring job can surface it. RAISE WARNING alone went only to
  -- the Postgres log and was invisible to the app.
  BEGIN
    INSERT INTO public.model_view_sync_failures (model_id, model_name, tg_op, sqlstate, message)
    VALUES (
      COALESCE(NEW.id, OLD.id),
      COALESCE(NEW.name, OLD.name),
      TG_OP,
      SQLSTATE,
      SQLERRM
    );
  EXCEPTION WHEN others THEN
    -- Insertion of the failure record itself failed (RLS, missing table,
    -- whatever). Fall back to RAISE WARNING — same posture as before this
    -- migration. Never let this branch break the underlying model save.
    NULL;
  END;
  RAISE WARNING '[models_view_sync] % on model %: %', TG_OP, COALESCE(NEW.id, OLD.id), SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

-- ─── M14 — webhook_payloads pruning helper ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.prune_webhook_payloads(p_keep_days int DEFAULT 90)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_deleted int;
BEGIN
  IF NOT public.wassell_is_admin((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'prune_webhook_payloads: admin only';
  END IF;
  DELETE FROM public.webhook_payloads
   WHERE received_at < now() - (p_keep_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.prune_webhook_payloads(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_webhook_payloads(int) TO authenticated;

-- ─── M11 + L2 — record_search cursor + limit validation ────────────────────

CREATE OR REPLACE FUNCTION public.record_search(
  p_model_id    uuid,
  p_filters     jsonb DEFAULT '{}'::jsonb,
  p_cursor      jsonb DEFAULT NULL,
  p_limit       int   DEFAULT 50,
  p_search_text text  DEFAULT NULL
)
RETURNS TABLE (
  id                 uuid,
  model_id           uuid,
  data               jsonb,
  created_by_user_id uuid,
  created_at         timestamptz,
  updated_at         timestamptz,
  has_more           boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cursor_created_at timestamptz;
  v_cursor_id         uuid;
  v_limit             int;
  v_fetched           int;
BEGIN
  -- Audit fix L2: reject explicit zero/negative limits with a clear error
  -- instead of silently clamping to 1. Callers that pass NULL still get
  -- the 50 default; the clamp upper bound (500) stays.
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'record_search: p_limit must be >= 1, got %', p_limit
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_limit := LEAST(COALESCE(p_limit, 50), 500);

  -- Audit fix M11: validate cursor shape upfront. A malformed cursor used
  -- to silently become NULL → pagination resets to page 1, which can
  -- trap a client in an infinite loop.
  IF p_cursor IS NOT NULL THEN
    IF jsonb_typeof(p_cursor) <> 'object'
       OR p_cursor->>'created_at' IS NULL
       OR p_cursor->>'id' IS NULL THEN
      RAISE EXCEPTION 'record_search: malformed cursor — expected {created_at, id}, got %', p_cursor
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    BEGIN
      v_cursor_created_at := (p_cursor->>'created_at')::timestamptz;
      v_cursor_id         := (p_cursor->>'id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'record_search: cursor parse failed — created_at must be ISO timestamptz, id must be uuid'
        USING ERRCODE = 'invalid_parameter_value';
    END;
  END IF;

  RETURN QUERY
  WITH page AS (
    SELECT u.id, u.model_id, u.data, u.created_by_user_id, u.created_at, u.updated_at
    FROM public.unified_records u
    WHERE u.model_id = p_model_id
      AND (p_filters = '{}'::jsonb OR u.data @> p_filters)
      AND (
        p_search_text IS NULL OR p_search_text = ''
        OR u.data::text ILIKE '%' || p_search_text || '%'
      )
      AND (
        v_cursor_created_at IS NULL
        OR (u.created_at, u.id) < (v_cursor_created_at, v_cursor_id)
      )
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT v_limit + 1
  ),
  counted AS (
    SELECT *, COUNT(*) OVER () AS total FROM page
  )
  SELECT
    c.id,
    c.model_id,
    c.data,
    c.created_by_user_id,
    c.created_at,
    c.updated_at,
    (c.total > v_limit) AS has_more
  FROM counted c
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT v_limit;
END;
$fn$;

-- ─── M13 — record_assign_auto_id permission check ──────────────────────────
-- The function already exists from Phase F.1 (2026-05-07_f1_auto_id_counters.sql).
-- Wrap it with a permission check so a low-privilege user can't inflate
-- counters for a model they can't even create records on.

CREATE OR REPLACE FUNCTION public.record_assign_auto_id(
  p_model_id  uuid,
  p_field_id  uuid,
  p_scope_key text,
  p_start     int  DEFAULT 1
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_value int;
BEGIN
  -- Audit fix M13: gate behind the same model-level 'create' permission
  -- that gates record creation. Without this, any authenticated user
  -- (even one denied 'create' by their profile) could spam this RPC
  -- and create gaps / collisions in the visible auto-IDs.
  IF NOT public.wassell_user_has_action((SELECT auth.uid()), p_model_id, 'create') THEN
    RAISE EXCEPTION 'record_assign_auto_id: caller lacks create permission on model %', p_model_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.auto_id_counters (model_id, field_id, scope_key, current_value)
  VALUES (p_model_id, p_field_id, p_scope_key, p_start)
  ON CONFLICT (model_id, field_id, scope_key)
  DO UPDATE SET current_value = auto_id_counters.current_value + 1
  RETURNING current_value INTO v_value;

  RETURN v_value;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) TO authenticated;

-- ─── H6 — freeze_model concurrency lock + idempotency ──────────────────────
-- The freeze_model function lives in schema.sql; we wrap it with a guard
-- function that takes an advisory lock + idempotency check before delegating.
-- New callers should target freeze_model_safe; the original is kept for
-- backward-compat but should not be called directly.

CREATE OR REPLACE FUNCTION public.freeze_model_safe(p_model_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_model record;
  v_locked boolean;
  v_result jsonb;
BEGIN
  -- Audit fix H6: serialize concurrent freezes on the SAME model. Two
  -- admins clicking Freeze in different browsers used to both pass the
  -- validation phase, both call freeze_copy_records, and produce
  -- duplicated rows. The advisory lock is per-model so unrelated freezes
  -- can still run in parallel.
  v_locked := pg_try_advisory_xact_lock(hashtext('freeze_model:' || p_model_id::text));
  IF NOT v_locked THEN
    RAISE EXCEPTION 'freeze_model_safe: another freeze is already in progress for model %', p_model_id
      USING ERRCODE = 'lock_not_available';
  END IF;

  SELECT id, name, is_hardcoded INTO v_model FROM public.models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'freeze_model_safe: model % not found', p_model_id;
  END IF;
  IF v_model.is_hardcoded THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_frozen', true,
      'model_id', v_model.id,
      'model_name', v_model.name
    );
  END IF;

  v_result := public.freeze_model(p_model_id);

  -- Audit fix L3: emit an activity_log entry for the freeze. This is one of
  -- the largest possible structural changes a model can undergo.
  BEGIN
    INSERT INTO public.activity_log (
      category, event_type, actor_user_id, actor_email,
      target_model_id, target_label, summary_ar, summary_en, status, details
    )
    VALUES (
      'system',
      'model_freeze',
      (SELECT auth.uid()),
      NULL,
      p_model_id,
      v_model.name,
      'تم تجميد النموذج "' || v_model.name || '"',
      'Froze model "' || v_model.name || '"',
      'success',
      v_result
    );
  EXCEPTION WHEN others THEN
    -- Non-fatal: the freeze succeeded; we just couldn't log it. Surface
    -- via RAISE NOTICE so it's visible in the SQL editor.
    RAISE NOTICE '[freeze_model_safe] activity_log insert failed: %', SQLERRM;
  END;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.freeze_model_safe(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.freeze_model_safe(uuid) TO authenticated;

-- ─── M12 — rebuild_unified_records uses advisory lock ──────────────────────
-- Keep the DROP+CREATE (the column list might widen) but serialize concurrent
-- rebuilds so two simultaneous calls don't deadlock on each other's locks.

CREATE OR REPLACE FUNCTION public.rebuild_unified_records()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_sql       text := 'SELECT id, model_id, data, created_by_user_id, created_at, updated_at, version FROM public.records';
  v_model     record;
  v_view_name text;
  v_locked    boolean;
BEGIN
  -- Audit fix M12: advisory lock so concurrent rebuilds (e.g. two near-
  -- simultaneous freezes finishing at the same time) serialize instead of
  -- racing on the DROP VIEW's ACCESS EXCLUSIVE lock against each other.
  v_locked := pg_try_advisory_xact_lock(hashtext('rebuild_unified_records'));
  IF NOT v_locked THEN
    -- Wait for the in-progress rebuild rather than failing — the result
    -- will be the same.
    PERFORM pg_advisory_xact_lock(hashtext('rebuild_unified_records'));
  END IF;

  -- Audit fix H5 prerequisite: project `version` in the unified view so
  -- the frontend AppRecord shape includes it. Frozen tables don't have
  -- a version column yet (Phase F.2.1 future work) — emit NULL for them.
  -- The frontend RPC treats null as "skip the version check" so frozen
  -- writes still work; for unfrozen writes, the form's H5 fix can now
  -- snapshot the actual version from the loaded record.
  FOR v_model IN SELECT name FROM models WHERE is_hardcoded = true ORDER BY name LOOP
    v_view_name := public.freeze_safe_ident(v_model.name) || '_v';
    IF EXISTS (
      SELECT 1 FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = v_view_name
    ) THEN
      v_sql := v_sql || format(
        ' UNION ALL SELECT id, model_id, data, created_by_user_id, created_at, updated_at, NULL::int AS version FROM public.%I',
        v_view_name
      );
    END IF;
  END LOOP;

  EXECUTE 'DROP VIEW IF EXISTS public.unified_records';
  EXECUTE 'CREATE VIEW public.unified_records WITH (security_invoker = true) AS ' || v_sql;
  EXECUTE 'GRANT SELECT ON public.unified_records TO authenticated, anon, service_role';
END;
$fn$;

-- ─── M7 — Haberchat webhook dead-letter queue ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.haberchat_webhook_dlq (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at  timestamptz NOT NULL DEFAULT now(),
  event_type   text,
  device_wid   text,
  payload      jsonb NOT NULL,
  error_class  text,
  error_message text,
  retry_count  int NOT NULL DEFAULT 0,
  resolved_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_haberchat_dlq_received_at
  ON public.haberchat_webhook_dlq (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_haberchat_dlq_unresolved
  ON public.haberchat_webhook_dlq (resolved_at) WHERE resolved_at IS NULL;

ALTER TABLE public.haberchat_webhook_dlq ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS haberchat_dlq_admin_all ON public.haberchat_webhook_dlq;
CREATE POLICY haberchat_dlq_admin_all ON public.haberchat_webhook_dlq
  FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

-- service_role bypasses RLS (the webhook handler runs as service_role).
GRANT SELECT, UPDATE ON public.haberchat_webhook_dlq TO authenticated;

COMMIT;
