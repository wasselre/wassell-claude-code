-- «طلب غير مجاب» — TASK ENGINE (migration 2 of 3)
--
--   1. Suspend ordinary follow-ups for the new stage, in the four functions
--      that own that invariant. NOTE: this is a SUSPENSION, not a termination —
--      the relationship is alive and the client is still unmet demand. The four
--      lists happen to be the same mechanism a terminal stage uses; the meaning
--      is different and the code comments must keep saying so.
--   2. recalc_client_derived_data gets its own branch → lifecycle 'searching',
--      deliberately NOT 'closed': buildActiveClientDemand (src/lib/demand/)
--      EXCLUDES closed clients, and excluding the clients whose demand we failed
--      to meet is backwards — it destroys the signal this feature exists to
--      capture.
--   3. Two partial unique indexes — the real duplicate protection. An
--      only_on_change guard stops ordinary re-edits and nothing else (retries,
--      concurrency, or both entry points firing).
--   4. reconcile_open_searches() — the backstop. Completion-driven recurrence
--      does not "self-stop"; it can equally STALL if nobody completes the task.
--      This notices an open request with no open task and opens one.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1 + 2. In-place edits of the live function bodies
-- ---------------------------------------------------------------------------
-- Re-emit each body verbatim from pg_get_functiondef with ONE substitution, the
-- same technique the wants-rent migration used. Idempotent: guarded on the new
-- stage already being present.
DO $do$
DECLARE
  fn   record;
  body text;
BEGIN
  FOR fn IN
    SELECT p.oid, p.proname FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname IN ('reconcile_outbound_whatsapp', 'reconcile_inbound_whatsapp',
                        'reconcile_stranded_clients', 'recalc_client_derived_data',
                        'tg_records_supersede_followups')
  LOOP
    body := pg_get_functiondef(fn.oid);
    CONTINUE WHEN position('طلب غير مجاب' IN body) > 0;   -- already applied

    IF fn.proname = 'recalc_client_derived_data' THEN
      -- NOT added to v_terminal. A dedicated branch placed FIRST, so the
      -- searching client keeps counting as live demand.
      body := replace(body,
        E'  IF v_terminal THEN\n    v_lifecycle := ''closed'';',
        E'  IF v_stage = ''طلب غير مجاب'' THEN\n    v_lifecycle := ''searching'';\n  ELSIF v_terminal THEN\n    v_lifecycle := ''closed'';');
    ELSE
      -- The three reconcilers share one literal; the supersede trigger uses an
      -- ARRAY form. Both orderings are matched exactly as they appear live.
      body := replace(body,
        '''خاسر'', ''مغلق ناجح'', ''غير مؤهل'', ''يريد إيجار''',
        '''خاسر'', ''مغلق ناجح'', ''غير مؤهل'', ''يريد إيجار'', ''طلب غير مجاب''');
      body := replace(body,
        'ARRAY[''مغلق ناجح'',''خاسر'',''غير مؤهل'',''يريد إيجار'']',
        'ARRAY[''مغلق ناجح'',''خاسر'',''غير مؤهل'',''يريد إيجار'',''طلب غير مجاب'']');
    END IF;

    EXECUTE body;
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------
-- 3. Duplicate protection — enforced, not hoped for
-- ---------------------------------------------------------------------------
-- Partial unique indexes over the shared `records` JSONB table, scoped by
-- model_id. Precedent on this exact table: advertisers_phone_unique_idx.
-- Every predicate expression is IMMUTABLE, as a partial index requires.

-- One OPEN unanswered request per client. A request with no status yet counts
-- as open ('received'), so the very first insert is covered too.
CREATE UNIQUE INDEX IF NOT EXISTS unanswered_requests_one_open_per_client_idx
  ON public.records ((data->>'client_id'))
  WHERE model_id = 'da920a2c-43c2-4b82-9c39-ac36c4602e51'::uuid
    AND COALESCE(NULLIF(data->>'request_status', ''), 'received')
        NOT IN ('fulfilled', 'client_dropped')
    AND NULLIF(data->>'client_id', '') IS NOT NULL;

-- One OPEN search task per request. Scoped to task_kind='search_update' so a
-- future general sales task on the same request is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS sales_tasks_one_open_search_per_request_idx
  ON public.records ((data->>'request_id'))
  WHERE model_id = '5a1e7a50-0000-4000-8000-000000000001'::uuid
    AND data->>'task_kind' = 'search_update'
    AND COALESCE(NULLIF(data->>'task_status', ''), 'open') IN ('open', 'in_progress')
    AND NULLIF(data->>'request_id', '') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. The backstop
-- ---------------------------------------------------------------------------
-- Same posture as reconcile_stranded_clients: SECURITY DEFINER, service_role
-- only, dry-run supported, and it reports what it did rather than working
-- silently. Naturally idempotent — the unique index above IS the guard, so a
-- second concurrent run loses the race and skips instead of duplicating.
CREATE OR REPLACE FUNCTION public.reconcile_open_searches(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_requests uuid := (SELECT id FROM public.models WHERE name = 'unanswered_requests');
  v_tasks    uuid := (SELECT id FROM public.models WHERE name = 'sales_tasks');
  v_fallback text;
  r          record;
  v_owner    jsonb;
  v_created  int := 0;
  v_seen     jsonb := '[]'::jsonb;
BEGIN
  IF v_requests IS NULL OR v_tasks IS NULL THEN
    RETURN jsonb_build_object('error', 'models missing', 'created', 0);
  END IF;

  -- Last-resort owner, mirroring the Next-Action Backstop: an unowned task is
  -- an invisible task. Resolved by name, never hardcoded.
  SELECT u.id::text INTO v_fallback
  FROM public.users u
  WHERE u.is_active AND u.name_en = 'System Admin'
  LIMIT 1;

  FOR r IN
    SELECT q.id                        AS request_id,
           NULLIF(q.data->>'client_id', '') AS client_id,
           q.data->'assigned_to'       AS assigned_to
    FROM public.records q
    WHERE q.model_id = v_requests
      AND COALESCE(NULLIF(q.data->>'request_status', ''), 'received')
          NOT IN ('fulfilled', 'client_dropped')
      AND NOT EXISTS (
        SELECT 1 FROM public.records t
        WHERE t.model_id = v_tasks
          AND t.data->>'request_id' = q.id::text
          AND t.data->>'task_kind' = 'search_update'
          AND COALESCE(NULLIF(t.data->>'task_status', ''), 'open') IN ('open', 'in_progress'))
  LOOP
    v_seen := v_seen || to_jsonb(r.request_id::text);
    CONTINUE WHEN p_dry_run;

    -- assigned_to → the client's owner → System Admin.
    v_owner := NULLIF(r.assigned_to, 'null'::jsonb);
    IF v_owner IS NULL AND r.client_id IS NOT NULL THEN
      SELECT NULLIF(c.data->'client_owner', 'null'::jsonb) INTO v_owner
      FROM public.records c WHERE c.id = r.client_id::uuid;
    END IF;
    IF v_owner IS NULL AND v_fallback IS NOT NULL THEN
      v_owner := to_jsonb(v_fallback);
    END IF;

    BEGIN
      INSERT INTO public.records (id, model_id, data, created_at, updated_at)
      VALUES (gen_random_uuid(), v_tasks, jsonb_build_object(
        'title',           'تحديث حالة البحث',
        'task_kind',       'search_update',
        'task_status',     'open',
        'assignee',        v_owner,
        'due_date',        to_char(now() + interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
        'client_id',       r.client_id,
        'request_id',      r.request_id::text,
        'creation_source', 'search_reconcile'
      ), now(), now());
      v_created := v_created + 1;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent run (or a workflow) already opened one. Expected, not an error.
      NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object('stranded_requests', v_seen, 'created', v_created, 'dry_run', p_dry_run);
END
$function$;

REVOKE ALL ON FUNCTION public.reconcile_open_searches(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_open_searches(boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  n_fn int;
BEGIN
  SELECT count(*) INTO n_fn FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('reconcile_outbound_whatsapp', 'reconcile_inbound_whatsapp',
                      'reconcile_stranded_clients', 'recalc_client_derived_data',
                      'tg_records_supersede_followups')
    AND position('طلب غير مجاب' IN pg_get_functiondef(p.oid)) > 0;
  IF n_fn <> 6 THEN
    RAISE EXCEPTION 'expected all 6 task-engine functions (incl. both reconcile_outbound overloads) to carry the new stage, got %', n_fn;
  END IF;

  IF position('v_lifecycle := ''searching''' IN
      (SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.proname = 'recalc_client_derived_data')) = 0 THEN
    RAISE EXCEPTION 'recalc_client_derived_data is missing the searching branch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'unanswered_requests_one_open_per_client_idx')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'sales_tasks_one_open_search_per_request_idx') THEN
    RAISE EXCEPTION 'duplicate-protection indexes missing';
  END IF;
END
$do$;

COMMIT;
