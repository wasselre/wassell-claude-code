-- Conflict-storm hardening — LAYER 3: per-session rate-limit (2026-06-21)
-- =====================================================================
-- Closest enforceable rate-limit for the record_save version-conflict storm.
--
-- WHY NOT A TRUE EDGE LIMIT: the browser calls PostgREST DIRECTLY
-- (https://<project>.supabase.co/rest/v1/rpc/record_save) — there is NO edge we
-- own between the client and Supabase to put a per-request rate-limit on, and
-- managed Supabase exposes no per-RPC PostgREST rate-limit knob. Routing saves
-- through a Vercel proxy wouldn't help against the actual threat (an OUTDATED
-- bundle that calls PostgREST directly and never learns about the proxy). That
-- threat is instead eliminated by LAYER 2 (forced stale-build reload), which
-- removes outdated bundles so every live client is current + cooperating.
--
-- The closest ENFORCEABLE layer is therefore the DB itself. record_save already
-- has a per-RECORD block (auto-set by the client-cooperative record_conflict_
-- report after 8 conflicts/15s on one record). This layer adds a per-SESSION
-- block: a session that storms ACROSS records (or keeps re-tripping) crosses
-- 25 conflicts/30s and is terminally rejected for ALL saves for 10 minutes.
-- session_id comes from the JWT (request.jwt.claims), so it is unspoofable by
-- page JS. (Per-IP was rejected as the key: office NAT shares one IP across
-- many legit users → false positives. IP is still captured in the telemetry.)
--
-- Honest residual: like the per-record throttle, the per-session counter is fed
-- by the client calling record_conflict_report — a NON-cooperating old bundle
-- doesn't feed it. Layer 2 closes that gap by forcing old bundles to reload;
-- the rate-based conflict_storm_sweep remains the autonomous detector/alert.

BEGIN;

CREATE TABLE IF NOT EXISTS public.session_save_blocks (
  session_id    text PRIMARY KEY,
  blocked_until timestamptz NOT NULL,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.session_save_blocks ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.session_conflict_counters (
  session_id   text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        int NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.session_conflict_counters ENABLE ROW LEVEL SECURITY;

-- record_save: enforce BOTH the per-session and per-record block at the top,
-- reading session_id from the JWT once and reusing it in the conflict telemetry.
CREATE OR REPLACE FUNCTION public.record_save(
  p_model_id uuid, p_id uuid, p_data jsonb,
  p_created_by uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_model record;
  v_table text;
  v_existing_version int;
  v_user uuid;
  v_headers jsonb;
  v_claims jsonb;
  v_session text;
BEGIN
  BEGIN v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN v_claims := NULL; END;
  v_session := v_claims->>'session_id';

  -- Per-session rate-limit block (layer 3).
  IF v_session IS NOT NULL THEN
    PERFORM 1 FROM public.session_save_blocks s
     WHERE s.session_id = v_session AND s.blocked_until > now();
    IF FOUND THEN
      RAISE EXCEPTION
        'conflict_storm_blocked: this session is rate-limited after repeated version conflicts'
        USING ERRCODE = 'serialization_failure',
              HINT = 'reload the page to continue';
    END IF;
  END IF;

  -- Per-record terminal block (storm mitigation / auto-throttle).
  PERFORM 1 FROM public.record_save_blocks b
   WHERE b.record_id = p_id AND b.blocked_until > now();
  IF FOUND THEN
    RAISE EXCEPTION
      'conflict_storm_blocked: saves to record % are temporarily blocked after a retry storm', p_id
      USING ERRCODE = 'serialization_failure',
            HINT = 'reload the record; the block clears automatically';
  END IF;

  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'model % not found', p_model_id; END IF;

  IF v_model.is_hardcoded THEN
    v_table := public.freeze_safe_ident(v_model.name);
    EXECUTE format('INSERT INTO public.%I (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', v_table) USING p_id;
    PERFORM public.freeze_apply_row(p_model_id, p_id, p_data, p_created_by, p_expected_version);
  ELSE
    IF p_expected_version IS NOT NULL THEN
      SELECT version INTO v_existing_version FROM records WHERE id = p_id;
      IF FOUND AND v_existing_version <> p_expected_version THEN
        v_user := auth.uid();
        BEGIN v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
        EXCEPTION WHEN others THEN v_headers := NULL; END;
        RAISE LOG 'record_save_conflict v2 record=% model=% user=% session=% role=% tab=% build=% expected=% current=% ip=% client=% referer=% path=% ua=%',
          p_id, p_model_id, v_user,
          v_session, v_claims->>'role',
          v_headers->>'x-wassel-tab', v_headers->>'x-wassel-build',
          p_expected_version, v_existing_version,
          coalesce(v_headers->>'x-forwarded-for', v_headers->>'x-real-ip', v_headers->>'cf-connecting-ip'),
          v_headers->>'x-client-info', v_headers->>'referer',
          current_setting('request.path', true),
          v_headers->>'user-agent';
        RAISE EXCEPTION
          'version_mismatch: record was edited by another user (loaded v%, current v%) [record=% model=% user=% session=% role=%]',
          p_expected_version, v_existing_version, p_id, p_model_id, v_user,
          v_session, v_claims->>'role'
          USING ERRCODE = 'serialization_failure',
                HINT = 'reload the record to see latest changes';
      END IF;
    END IF;

    INSERT INTO records (id, model_id, data, created_by_user_id)
    VALUES (p_id, p_model_id, p_data, p_created_by)
    ON CONFLICT (id) DO UPDATE SET
      data = EXCLUDED.data,
      created_by_user_id = COALESCE(records.created_by_user_id, EXCLUDED.created_by_user_id),
      updated_at = now();
  END IF;
  RETURN p_id;
END;
$function$;

-- record_conflict_report: feed BOTH the per-(record,session) counter (per-record
-- auto-block) AND the per-session counter (per-session rate-limit block).
CREATE OR REPLACE FUNCTION public.record_conflict_report(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_session   text;
  v_count     int;
  v_scount    int;
  v_model     uuid;
  c_window    interval := interval '15 seconds';
  c_trip      int := 8;
  c_block     interval := interval '5 minutes';
  c_swindow   interval := interval '30 seconds';
  c_strip     int := 25;
  c_sblock    interval := interval '10 minutes';
  v_blocked   boolean := false;
  v_sblocked  boolean := false;
BEGIN
  BEGIN
    v_session := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', '?');
  EXCEPTION WHEN others THEN v_session := '?'; END;

  INSERT INTO public.record_conflict_counters (record_id, session_id, window_start, count, updated_at)
  VALUES (p_record_id, v_session, now(), 1, now())
  ON CONFLICT (record_id, session_id) DO UPDATE SET
    count = CASE WHEN public.record_conflict_counters.window_start < now() - c_window
                 THEN 1 ELSE public.record_conflict_counters.count + 1 END,
    window_start = CASE WHEN public.record_conflict_counters.window_start < now() - c_window
                       THEN now() ELSE public.record_conflict_counters.window_start END,
    updated_at = now()
  RETURNING count INTO v_count;

  IF v_count >= c_trip THEN
    SELECT model_id INTO v_model FROM public.records WHERE id = p_record_id;
    INSERT INTO public.record_save_blocks (record_id, model_id, blocked_until, reason, created_by)
    VALUES (p_record_id, v_model, now() + c_block,
            format('auto-throttle: %s conflicts/%s from session %s', v_count, c_window, v_session),
            'auto_throttle')
    ON CONFLICT (record_id) DO UPDATE
      SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason,
          model_id = COALESCE(public.record_save_blocks.model_id, EXCLUDED.model_id),
          created_at = now(), created_by = 'auto_throttle';
    INSERT INTO public.system_alerts (kind, severity, detail)
    VALUES ('conflict_auto_block', 'warning', jsonb_build_object(
      'record_id', p_record_id, 'model_id', v_model, 'session_id', v_session,
      'count', v_count, 'blocked_for', c_block::text));
    v_blocked := true;
  END IF;

  IF v_session <> '?' THEN
    INSERT INTO public.session_conflict_counters (session_id, window_start, count, updated_at)
    VALUES (v_session, now(), 1, now())
    ON CONFLICT (session_id) DO UPDATE SET
      count = CASE WHEN public.session_conflict_counters.window_start < now() - c_swindow
                   THEN 1 ELSE public.session_conflict_counters.count + 1 END,
      window_start = CASE WHEN public.session_conflict_counters.window_start < now() - c_swindow
                         THEN now() ELSE public.session_conflict_counters.window_start END,
      updated_at = now()
    RETURNING count INTO v_scount;

    IF v_scount >= c_strip THEN
      INSERT INTO public.session_save_blocks (session_id, blocked_until, reason)
      VALUES (v_session, now() + c_sblock,
              format('auto-throttle: %s conflicts/%s across records', v_scount, c_swindow))
      ON CONFLICT (session_id) DO UPDATE
        SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason, created_at = now();
      INSERT INTO public.system_alerts (kind, severity, detail)
      VALUES ('conflict_session_block', 'critical', jsonb_build_object(
        'session_id', v_session, 'count', v_scount, 'blocked_for', c_sblock::text));
      v_sblocked := true;
    END IF;
  END IF;

  RETURN jsonb_build_object('count', v_count, 'blocked', v_blocked,
                            'session_count', v_scount, 'session_blocked', v_sblocked);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_conflict_report(uuid) TO authenticated, service_role;

COMMIT;
