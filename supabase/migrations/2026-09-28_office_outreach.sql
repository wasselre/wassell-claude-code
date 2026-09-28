-- Office outreach for unanswered requests (D38 + D46, 2026-09-28).
--
-- A request («طلب غير مجاب») can be sent, as ONE short WhatsApp message per
-- office, to the real-estate offices in the client's requested districts. Offices
-- that have something reply; the rep turns the reply into a unit / project /
-- standalone office unit (fields added below) and a client option.
--
-- SENDING RIDES THE EXISTING scheduled_whatsapp_jobs QUEUE. Nothing new runs on
-- the worker: each office message is one scheduled job with a paced deliver_at,
-- and the worker already fails a WhatsApp 463 once without retrying it (WA-07).
--
-- WHY IT IS PACED THIS WAY (research 2026-09-28):
--   * Every message here is COLD outreach — the office never wrote to us. WAHA's
--     own guide: "you should never initiate a conversation"; 463 = shadow
--     restriction for too much new-contact outreach, 475 = message capping,
--     5–10 spam reports start a ban.
--   * Since Oct 2025 WhatsApp caps the messages a number may send per month to
--     people who have not replied (figure unpublished).
--   * A NEW number must warm up: GREEN API's schedule is receive-only for the
--     first days, then ~1 outgoing / 2 h, growing to 12–100/day by day 7, with
--     full trust after 25–30 days; gaps must be random, not a fixed rhythm.
--   * Our own 2026-07-23 incident: a 36-message cold burst locked the sales
--     line with 463 and every retry re-armed it.
-- So: a dedicated line, a ramp keyed on the line's AGE, random gaps, business
-- hours only, a per-office 14-day gap, halving on a poor reply rate, and a
-- CIRCUIT BREAKER — the first 463 / 475 cancels every queued office message on
-- that line and rests it 24 h. Every number is a setting row, not code.
--
-- Error codes: refusals raise SQLSTATE WS422 with a stable message key (never
-- 40001 — see CLAUDE.md "Never raise SQLSTATE 40001").

SET check_function_bodies = off;

-- ─── 1. Settings (singleton) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.office_outreach_settings (
  id                 int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- whatsapp_numbers.device_id of the DEDICATED outreach line. NULL = sending off.
  device_id          text,
  -- The day the line was paired; its age drives the ramp below.
  line_started_on    date,
  send_start_hour    int         NOT NULL DEFAULT 9  CHECK (send_start_hour BETWEEN 0 AND 23),
  send_end_hour      int         NOT NULL DEFAULT 21 CHECK (send_end_hour BETWEEN 1 AND 24),
  recontact_days     int         NOT NULL DEFAULT 14 CHECK (recontact_days >= 0),
  -- Ordered steps: from_day (line age) → per_day cap + random gap range (seconds).
  ramp               jsonb       NOT NULL DEFAULT '[
    {"from_day":0,  "per_day":0,  "min_gap_s":0,   "max_gap_s":0},
    {"from_day":4,  "per_day":10, "min_gap_s":600, "max_gap_s":1200},
    {"from_day":7,  "per_day":25, "min_gap_s":360, "max_gap_s":720},
    {"from_day":14, "per_day":40, "min_gap_s":240, "max_gap_s":480}
  ]'::jsonb,
  -- Halve the day's cap when fewer than this share of the last 7 days' messages
  -- got a reply (only once at least low_reply_min_sent were sent).
  low_reply_rate     numeric     NOT NULL DEFAULT 0.20,
  low_reply_min_sent int         NOT NULL DEFAULT 20,
  -- Circuit breaker state.
  paused_until       timestamptz,
  pause_reason       text,
  half_cap_until     date,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.office_outreach_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.office_outreach_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_outreach_settings_read ON public.office_outreach_settings;
CREATE POLICY office_outreach_settings_read ON public.office_outreach_settings
  FOR SELECT TO authenticated USING (true);

-- ─── 2. One row per (request, office) message ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.office_outreach (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid        NOT NULL,
  client_id       uuid,
  office_id       uuid        NOT NULL,
  office_phone    text        NOT NULL,          -- ksa_phone_canon digits, e.g. 9665…
  office_name     text,
  device_id       text        NOT NULL,
  body            text        NOT NULL,
  status          text        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued','sent','failed','cancelled')),
  job_id          uuid,
  deliver_at      timestamptz NOT NULL,
  sent_at         timestamptz,
  replied_at      timestamptz,
  reply_preview   text,
  error           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, office_id)
);
CREATE INDEX IF NOT EXISTS office_outreach_phone_idx   ON public.office_outreach (office_phone);
CREATE INDEX IF NOT EXISTS office_outreach_device_idx  ON public.office_outreach (device_id, deliver_at);
CREATE INDEX IF NOT EXISTS office_outreach_request_idx ON public.office_outreach (request_id);
CREATE INDEX IF NOT EXISTS office_outreach_job_idx     ON public.office_outreach (job_id);

-- ─── 3. Offices that asked us to stop ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.office_do_not_contact (
  phone       text        PRIMARY KEY,           -- ksa_phone_canon digits
  reason      text,
  source      text        NOT NULL DEFAULT 'reply',
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.office_do_not_contact ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_dnc_read ON public.office_do_not_contact;
CREATE POLICY office_dnc_read ON public.office_do_not_contact FOR SELECT TO authenticated USING (true);

-- ─── helpers ────────────────────────────────────────────────────────────────
-- The records_view RLS rule, callable from a definer function.
CREATE OR REPLACE FUNCTION public.office_outreach_can_view_record(p_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE r records;
BEGIN
  SELECT * INTO r FROM records WHERE id = p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN r.model_id IN (SELECT s.model_id FROM wassell_my_view_scope_all_models() s(model_id))
      OR wassell_can_view_record(auth.uid(), r);
END $$;

ALTER TABLE public.office_outreach ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_outreach_read ON public.office_outreach;
CREATE POLICY office_outreach_read ON public.office_outreach
  FOR SELECT TO authenticated USING (public.office_outreach_can_view_record(request_id));

CREATE OR REPLACE FUNCTION public.office_outreach_riyadh_today()
RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Riyadh')::date $$;

-- First non-empty id out of a lookup value that may be a string or an array.
CREATE OR REPLACE FUNCTION public.office_outreach_first_id(v jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(v)
           WHEN 'string' THEN NULLIF(v #>> '{}', '')
           WHEN 'array'  THEN NULLIF(v ->> 0, '')
           ELSE NULL END
$$;

-- ─── 4. Line status (for the settings panel + the send button) ─────────────
CREATE OR REPLACE FUNCTION public.office_outreach_line_status()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  s office_outreach_settings;
  v_today date := office_outreach_riyadh_today();
  v_age int;
  v_step jsonb;
  v_sent7 int; v_replied7 int;
  v_today_count int;
  v_per_day int;
  v_line_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'WS422'; END IF;
  SELECT * INTO s FROM office_outreach_settings WHERE id = 1;
  v_line_active := s.device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM whatsapp_numbers w WHERE w.device_id = s.device_id AND w.is_active);
  v_age := CASE WHEN s.line_started_on IS NULL THEN NULL ELSE v_today - s.line_started_on END;
  IF v_age IS NOT NULL THEN
    SELECT st INTO v_step FROM jsonb_array_elements(s.ramp) st
     WHERE (st->>'from_day')::int <= v_age ORDER BY (st->>'from_day')::int DESC LIMIT 1;
  END IF;
  SELECT count(*) FILTER (WHERE status = 'sent'), count(*) FILTER (WHERE status = 'sent' AND replied_at IS NOT NULL)
    INTO v_sent7, v_replied7
    FROM office_outreach WHERE device_id = s.device_id AND sent_at > now() - interval '7 days';
  SELECT count(*) INTO v_today_count FROM office_outreach
   WHERE device_id = s.device_id AND status <> 'cancelled'
     AND (deliver_at AT TIME ZONE 'Asia/Riyadh')::date = v_today;
  v_per_day := COALESCE((v_step->>'per_day')::int, 0);
  IF v_per_day > 0 AND ((s.half_cap_until IS NOT NULL AND s.half_cap_until >= v_today)
       OR (v_sent7 >= s.low_reply_min_sent AND v_replied7::numeric / NULLIF(v_sent7, 0) < s.low_reply_rate)) THEN
    v_per_day := GREATEST(1, ceil(v_per_day / 2.0)::int);
  END IF;
  RETURN jsonb_build_object(
    'device_id', s.device_id,
    'line_active', v_line_active,
    'line_started_on', s.line_started_on,
    'line_age_days', v_age,
    'per_day', v_per_day,
    'min_gap_s', COALESCE((v_step->>'min_gap_s')::int, 0),
    'max_gap_s', COALESCE((v_step->>'max_gap_s')::int, 0),
    'warming_up', v_age IS NOT NULL AND v_per_day = 0,
    'next_step_day', (SELECT min((st->>'from_day')::int) FROM jsonb_array_elements(s.ramp) st
                       WHERE (st->>'from_day')::int > COALESCE(v_age, -1) AND (st->>'per_day')::int > 0),
    'today_scheduled', v_today_count,
    'sent_7d', v_sent7, 'replied_7d', v_replied7,
    'paused_until', s.paused_until, 'pause_reason', s.pause_reason,
    'half_cap_until', s.half_cap_until,
    'send_start_hour', s.send_start_hour, 'send_end_hour', s.send_end_hour,
    'recontact_days', s.recontact_days,
    'ramp', s.ramp,
    'low_reply_rate', s.low_reply_rate, 'low_reply_min_sent', s.low_reply_min_sent,
    'queued', (SELECT count(*) FROM office_outreach WHERE device_id = s.device_id AND status = 'queued'),
    'can_send', v_line_active AND v_age IS NOT NULL AND v_per_day > 0
                AND (s.paused_until IS NULL OR s.paused_until <= now())
  );
END $$;

-- ─── 5. Settings save (admin only) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.office_outreach_settings_save(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT wassell_is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'outreach_admin_only' USING ERRCODE = 'WS422';
  END IF;
  IF p ? 'device_id' AND NULLIF(p->>'device_id', '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM whatsapp_numbers WHERE device_id = p->>'device_id') THEN
    RAISE EXCEPTION 'outreach_unknown_line' USING ERRCODE = 'WS422';
  END IF;
  IF p ? 'ramp' AND jsonb_typeof(p->'ramp') <> 'array' THEN
    RAISE EXCEPTION 'outreach_bad_ramp' USING ERRCODE = 'WS422';
  END IF;
  UPDATE office_outreach_settings SET
    device_id          = CASE WHEN p ? 'device_id' THEN NULLIF(p->>'device_id', '') ELSE device_id END,
    line_started_on    = CASE WHEN p ? 'line_started_on' THEN NULLIF(p->>'line_started_on', '')::date ELSE line_started_on END,
    send_start_hour    = COALESCE((p->>'send_start_hour')::int, send_start_hour),
    send_end_hour      = COALESCE((p->>'send_end_hour')::int, send_end_hour),
    recontact_days     = COALESCE((p->>'recontact_days')::int, recontact_days),
    ramp               = COALESCE(p->'ramp', ramp),
    low_reply_rate     = COALESCE((p->>'low_reply_rate')::numeric, low_reply_rate),
    low_reply_min_sent = COALESCE((p->>'low_reply_min_sent')::int, low_reply_min_sent),
    -- Clearing the pause is an explicit admin act ("resume now").
    paused_until       = CASE WHEN (p->>'resume')::boolean IS TRUE THEN NULL ELSE paused_until END,
    pause_reason       = CASE WHEN (p->>'resume')::boolean IS TRUE THEN NULL ELSE pause_reason END,
    updated_at         = now()
  WHERE id = 1;
  RETURN office_outreach_line_status();
END $$;

-- ─── 6. Offices qualified for a request ────────────────────────────────────
-- District match on the client's INCLUDED districts (location_items), minus any
-- EXCLUDED district; with p_include_city, also offices in the same cities.
CREATE OR REPLACE FUNCTION public.office_outreach_candidates(p_request_id uuid, p_include_city boolean DEFAULT false)
RETURNS TABLE (
  office_id uuid, office_name text, phone text, district_id text, district_name text,
  match_kind text, last_contacted_at timestamptz, replied_before boolean,
  do_not_contact boolean, recently_contacted boolean, in_this_request boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_req records; v_client records;
  v_offices_model uuid := (SELECT id FROM models WHERE name = 'real_estate_offices');
  v_include text[]; v_exclude text[]; v_cities text[];
  v_recontact int := (SELECT recontact_days FROM office_outreach_settings WHERE id = 1);
BEGIN
  IF auth.uid() IS NULL OR NOT office_outreach_can_view_record(p_request_id) THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'WS422';
  END IF;
  SELECT * INTO v_req FROM records WHERE id = p_request_id;
  SELECT * INTO v_client FROM records
   WHERE id::text = office_outreach_first_id(v_req.data->'client_id');
  IF NOT FOUND THEN RETURN; END IF;

  SELECT array_agg(DISTINCT it->>'district_id') FILTER (WHERE COALESCE(it->>'polarity','include') <> 'exclude'),
         array_agg(DISTINCT it->>'district_id') FILTER (WHERE it->>'polarity' = 'exclude')
    INTO v_include, v_exclude
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_client.data->'location_items') = 'array'
                                   THEN v_client.data->'location_items' ELSE '[]'::jsonb END) it
   WHERE it->>'kind' = 'district' AND COALESCE(it->>'district_id','') <> '';

  -- Cities: the client's own + the cities of the requested districts.
  SELECT array_agg(DISTINCT c) INTO v_cities FROM (
    SELECT jsonb_array_elements_text(CASE jsonb_typeof(v_client.data->'location'->'city')
             WHEN 'array' THEN v_client.data->'location'->'city'
             WHEN 'string' THEN jsonb_build_array(v_client.data->'location'->'city')
             ELSE '[]'::jsonb END) c
    UNION
    SELECT pc.record_id::text FROM geo_boundaries d
      JOIN geo_boundaries pc ON pc.tier = 'city' AND pc.external_id = d.parent_external_id
     WHERE d.tier = 'district' AND d.record_id::text = ANY (COALESCE(v_include, '{}'))
  ) x WHERE c IS NOT NULL AND c <> '';

  RETURN QUERY
  WITH o AS (
    SELECT r.id, NULLIF(btrim(r.data->>'office_name'), '') nm,
           ksa_phone_canon(r.data->>'mobile_number') ph,
           r.data->'location'->>'district' dist,
           r.data->'location'->>'city' city
      FROM records r
     WHERE r.model_id = v_offices_model
       AND COALESCE(r.data->>'mobile_number', '') <> ''
  ), matched AS (
    SELECT o.*, CASE WHEN o.dist = ANY (COALESCE(v_include, '{}')) THEN 'district' ELSE 'city' END mk
      FROM o
     WHERE (o.dist = ANY (COALESCE(v_include, '{}'))
            OR (p_include_city AND o.city = ANY (COALESCE(v_cities, '{}'))))
       AND NOT (COALESCE(o.dist, '') = ANY (COALESCE(v_exclude, '{}')))
       AND o.ph IS NOT NULL AND o.ph <> ''
  ), dedup AS (
    SELECT DISTINCT ON (ph) * FROM matched
     ORDER BY ph, (mk = 'district') DESC, (nm IS NOT NULL) DESC, id
  )
  SELECT d.id, d.nm, d.ph, d.dist,
         (SELECT g.name_ar FROM geo_boundaries g WHERE g.tier = 'district' AND g.record_id::text = d.dist LIMIT 1),
         d.mk,
         (SELECT max(oo.created_at) FROM office_outreach oo WHERE oo.office_phone = d.ph AND oo.status <> 'cancelled'),
         EXISTS (SELECT 1 FROM office_outreach oo WHERE oo.office_phone = d.ph AND oo.replied_at IS NOT NULL),
         EXISTS (SELECT 1 FROM office_do_not_contact n WHERE n.phone = d.ph),
         EXISTS (SELECT 1 FROM office_outreach oo WHERE oo.office_phone = d.ph AND oo.status IN ('queued','sent')
                  AND oo.created_at > now() - make_interval(days => v_recontact)),
         EXISTS (SELECT 1 FROM office_outreach oo WHERE oo.request_id = p_request_id AND oo.office_phone = d.ph
                  AND oo.status <> 'cancelled')
    FROM dedup d
   ORDER BY 8 DESC, (d.mk = 'district') DESC, (d.nm IS NOT NULL) DESC, d.nm NULLS LAST;
END $$;

-- ─── 7. Enqueue — paced, capped, business hours, breaker-aware ─────────────
-- p_messages: [{ "office_id": uuid, "body": text }, …] in the order to send.
CREATE OR REPLACE FUNCTION public.office_outreach_enqueue(p_request_id uuid, p_messages jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  s office_outreach_settings;
  v_today date := office_outreach_riyadh_today();
  v_status jsonb;
  v_per_day int; v_min_gap int; v_max_gap int;
  v_req records;
  v_offices_model uuid := (SELECT id FROM models WHERE name = 'real_estate_offices');
  v_client_id uuid;
  v_cursor timestamptz;
  v_local timestamp; v_day date; v_count int;
  m jsonb; v_office records; v_ph text; v_name text; v_body text;
  v_job uuid; v_oo uuid;
  v_queued int := 0; v_first timestamptz; v_last timestamptz;
  v_skipped jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  v_author uuid;
  v_guard int;
BEGIN
  IF auth.uid() IS NULL OR NOT office_outreach_can_view_record(p_request_id) THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'WS422';
  END IF;
  IF jsonb_typeof(p_messages) <> 'array' OR jsonb_array_length(p_messages) = 0 THEN
    RAISE EXCEPTION 'outreach_nothing_to_send' USING ERRCODE = 'WS422';
  END IF;

  -- Serialise schedulers so two reps cannot both claim the same free slots.
  PERFORM 1 FROM office_outreach_settings WHERE id = 1 FOR UPDATE;
  SELECT * INTO s FROM office_outreach_settings WHERE id = 1;
  v_status := office_outreach_line_status();
  IF s.device_id IS NULL OR NOT (v_status->>'line_active')::boolean THEN
    RAISE EXCEPTION 'outreach_no_line' USING ERRCODE = 'WS422';
  END IF;
  IF s.line_started_on IS NULL THEN
    RAISE EXCEPTION 'outreach_no_line' USING ERRCODE = 'WS422';
  END IF;
  IF s.paused_until IS NOT NULL AND s.paused_until > now() THEN
    RAISE EXCEPTION 'outreach_paused' USING ERRCODE = 'WS422';
  END IF;
  v_per_day := (v_status->>'per_day')::int;
  IF v_per_day <= 0 THEN
    RAISE EXCEPTION 'outreach_warming_up' USING ERRCODE = 'WS422';
  END IF;
  v_min_gap := GREATEST((v_status->>'min_gap_s')::int, 60);
  v_max_gap := GREATEST((v_status->>'max_gap_s')::int, v_min_gap);

  SELECT * INTO v_req FROM records WHERE id = p_request_id;
  v_client_id := NULLIF(office_outreach_first_id(v_req.data->'client_id'), '')::uuid;
  SELECT id INTO v_author FROM users WHERE auth_uid = auth.uid() LIMIT 1;

  -- Continue after the last queued message on this line (never overlap).
  v_cursor := GREATEST(now() + interval '2 minutes',
                       COALESCE((SELECT max(deliver_at) FROM office_outreach
                                  WHERE device_id = s.device_id AND status = 'queued'), now())
                       + make_interval(secs => v_min_gap + floor(random() * (v_max_gap - v_min_gap + 1))));

  FOR m IN SELECT * FROM jsonb_array_elements(p_messages) LOOP
    SELECT * INTO v_office FROM records
     WHERE id::text = m->>'office_id' AND model_id = v_offices_model;
    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_object('office_id', m->>'office_id', 'reason', 'unknown_office'); CONTINUE;
    END IF;
    v_ph := ksa_phone_canon(v_office.data->>'mobile_number');
    v_name := NULLIF(btrim(v_office.data->>'office_name'), '');
    v_body := btrim(COALESCE(m->>'body', ''));
    IF v_ph IS NULL OR v_ph = '' THEN
      v_skipped := v_skipped || jsonb_build_object('office_id', v_office.id, 'reason', 'no_phone'); CONTINUE;
    END IF;
    IF v_body = '' OR length(v_body) > 1500 THEN
      v_skipped := v_skipped || jsonb_build_object('office_id', v_office.id, 'reason', 'bad_body'); CONTINUE;
    END IF;
    IF v_ph = ANY (v_seen) THEN
      v_skipped := v_skipped || jsonb_build_object('office_id', v_office.id, 'reason', 'duplicate_phone'); CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM office_do_not_contact WHERE phone = v_ph) THEN
      v_skipped := v_skipped || jsonb_build_object('office_id', v_office.id, 'reason', 'do_not_contact'); CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM office_outreach WHERE request_id = p_request_id AND office_phone = v_ph AND status <> 'cancelled') THEN
      v_skipped := v_skipped || jsonb_build_object('office_id', v_office.id, 'reason', 'already_in_request'); CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM office_outreach WHERE office_phone = v_ph AND status IN ('queued','sent')
                AND created_at > now() - make_interval(days => s.recontact_days))
       AND NOT EXISTS (SELECT 1 FROM office_outreach WHERE office_phone = v_ph AND replied_at IS NOT NULL) THEN
      v_skipped := v_skipped || jsonb_build_object('office_id', v_office.id, 'reason', 'recently_contacted'); CONTINUE;
    END IF;
    v_seen := v_seen || v_ph;

    -- Find the next free slot: inside business hours, under the day's cap.
    v_guard := 0;
    LOOP
      v_guard := v_guard + 1;
      IF v_guard > 400 THEN RAISE EXCEPTION 'outreach_schedule_overflow' USING ERRCODE = 'WS422'; END IF;
      v_local := v_cursor AT TIME ZONE 'Asia/Riyadh';
      v_day := v_local::date;
      IF extract(hour FROM v_local) < s.send_start_hour THEN
        v_cursor := ((v_day + make_interval(hours => s.send_start_hour, mins => floor(random() * 20)::int))
                     AT TIME ZONE 'Asia/Riyadh');
        CONTINUE;
      END IF;
      IF extract(hour FROM v_local) >= s.send_end_hour THEN
        v_cursor := (((v_day + 1) + make_interval(hours => s.send_start_hour, mins => floor(random() * 20)::int))
                     AT TIME ZONE 'Asia/Riyadh');
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_count FROM office_outreach
       WHERE device_id = s.device_id AND status <> 'cancelled'
         AND (deliver_at AT TIME ZONE 'Asia/Riyadh')::date = v_day;
      IF v_count >= v_per_day THEN
        v_cursor := (((v_day + 1) + make_interval(hours => s.send_start_hour, mins => floor(random() * 20)::int))
                     AT TIME ZONE 'Asia/Riyadh');
        CONTINUE;
      END IF;
      EXIT;
    END LOOP;

    v_oo := gen_random_uuid();
    INSERT INTO scheduled_whatsapp_jobs (device_id, chat_wid, phone, body, media, reference, deliver_at, created_by_user_id)
    VALUES (s.device_id, v_ph || '@c.us', '+' || v_ph, v_body, '[]'::jsonb, 'office_outreach:' || v_oo, v_cursor, auth.uid())
    RETURNING id INTO v_job;
    INSERT INTO office_outreach (id, request_id, client_id, office_id, office_phone, office_name, device_id, body,
                                 status, job_id, deliver_at, created_by)
    VALUES (v_oo, p_request_id, v_client_id, v_office.id, v_ph, v_name, s.device_id, v_body,
            'queued', v_job, v_cursor, auth.uid());

    v_queued := v_queued + 1;
    v_first := COALESCE(v_first, v_cursor);
    v_last := v_cursor;
    v_cursor := v_cursor + make_interval(secs => v_min_gap + floor(random() * (v_max_gap - v_min_gap + 1)));
  END LOOP;

  IF v_queued > 0 THEN
    -- The request now shows it is being worked, and keeps a readable history line.
    UPDATE records SET data = data
      || CASE WHEN COALESCE(data->>'request_status', 'received') IN ('received', 'offices_selected')
              THEN jsonb_build_object('request_status', 'offices_contacted') ELSE '{}'::jsonb END
      || jsonb_build_object('request_updates',
           COALESCE(CASE WHEN jsonb_typeof(data->'request_updates') = 'array' THEN data->'request_updates' END, '[]'::jsonb)
           || jsonb_build_array(jsonb_build_object(
                'id', gen_random_uuid()::text,
                'text', format('جُدول إرسال الطلب إلى %s مكتب عقاري (من %s إلى %s بتوقيت الرياض)',
                               v_queued,
                               to_char(v_first AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI'),
                               to_char(v_last  AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI')),
                'author_id', v_author,
                'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
     WHERE id = p_request_id;
  END IF;

  RETURN jsonb_build_object('queued', v_queued, 'skipped', v_skipped,
                            'first_at', v_first, 'last_at', v_last, 'per_day', v_per_day);
END $$;

-- ─── 8. Cancel what has not gone yet (rep action) ──────────────────────────
CREATE OR REPLACE FUNCTION public.office_outreach_cancel(p_request_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  IF auth.uid() IS NULL OR NOT office_outreach_can_view_record(p_request_id) THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'WS422';
  END IF;
  UPDATE scheduled_whatsapp_jobs j SET status = 'cancelled', error_message = 'cancelled by rep', finished_at = now()
    FROM office_outreach o
   WHERE o.request_id = p_request_id AND o.status = 'queued' AND j.id = o.job_id AND j.status = 'queued';
  UPDATE office_outreach SET status = 'cancelled', error = COALESCE(error, 'cancelled by rep')
   WHERE request_id = p_request_id AND status = 'queued';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ─── 9. Job → outreach status sync + CIRCUIT BREAKER ───────────────────────
CREATE OR REPLACE FUNCTION public.tg_office_outreach_job_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_oo uuid;
BEGIN
  IF NEW.reference IS NULL OR NEW.reference NOT LIKE 'office_outreach:%' THEN RETURN NEW; END IF;
  v_oo := substring(NEW.reference FROM 17)::uuid;

  IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
    UPDATE office_outreach SET status = 'sent', sent_at = COALESCE(NEW.finished_at, now()), error = NULL WHERE id = v_oo;
  ELSIF NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed' THEN
    UPDATE office_outreach SET status = 'failed', error = left(NEW.error_message, 500) WHERE id = v_oo;
  ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE office_outreach SET status = 'cancelled', error = COALESCE(error, left(NEW.error_message, 500))
     WHERE id = v_oo AND status = 'queued';
  END IF;

  -- WhatsApp said "too much new-contact outreach" (463) or "capped" (475) —
  -- also when the worker only REQUEUED it, since a requeue is a retry and
  -- retries re-arm the lock. Stop the whole line, rest it 24 h, halve tomorrow.
  IF NEW.error_message IS NOT NULL
     AND NEW.error_message IS DISTINCT FROM OLD.error_message
     AND NEW.error_message ~ '(error 46[3]|error 475|cold_outreach_locked)' THEN
    UPDATE office_outreach_settings
       SET paused_until = now() + interval '24 hours',
           pause_reason = CASE WHEN NEW.error_message ~ 'error 475' THEN 'whatsapp_475_cap' ELSE 'whatsapp_463_lock' END,
           half_cap_until = office_outreach_riyadh_today() + 1,
           updated_at = now()
     WHERE id = 1;
    UPDATE scheduled_whatsapp_jobs
       SET status = 'cancelled', error_message = 'paused: WhatsApp restricted the outreach line', finished_at = now()
     WHERE device_id = NEW.device_id AND status = 'queued'
       AND reference LIKE 'office_outreach:%';
    UPDATE office_outreach SET status = 'cancelled', error = 'paused: WhatsApp restricted the outreach line'
     WHERE device_id = NEW.device_id AND status = 'queued';
    RAISE WARNING 'office outreach PAUSED on % for 24h: %', NEW.device_id, left(NEW.error_message, 200);
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF to_regclass('public.scheduled_whatsapp_jobs') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS scheduled_whatsapp_office_outreach_sync ON public.scheduled_whatsapp_jobs;
    CREATE TRIGGER scheduled_whatsapp_office_outreach_sync
      AFTER UPDATE OF status, error_message ON public.scheduled_whatsapp_jobs
      FOR EACH ROW WHEN (NEW.reference LIKE 'office_outreach:%')
      EXECUTE FUNCTION public.tg_office_outreach_job_sync();
  END IF;
END $$;

-- ─── 10. Office replies → the request; "stop" → do-not-contact ─────────────
CREATE OR REPLACE FUNCTION public.tg_office_outreach_reply()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_ph text; v_body text;
BEGIN
  v_ph := ksa_phone_canon(NEW.from_phone);
  IF v_ph IS NULL OR v_ph = '' THEN RETURN NEW; END IF;
  -- Cheap exit for the 99% of inbound messages that are customers.
  IF NOT EXISTS (SELECT 1 FROM office_outreach WHERE office_phone = v_ph AND status = 'sent') THEN RETURN NEW; END IF;
  v_body := COALESCE(NULLIF(btrim(NEW.body), ''), NULLIF(btrim(NEW.transcript), ''), '[' || COALESCE(NEW.kind, 'media') || ']');
  UPDATE office_outreach SET replied_at = COALESCE(NEW.date, now()), reply_preview = left(v_body, 300)
   WHERE office_phone = v_ph AND status = 'sent' AND replied_at IS NULL;
  IF v_body ~* '(^|\s)(إيقاف|ايقاف|stop|لا ترسل|لا تراسل|لا تتواصل|الغاء الاشتراك|إلغاء الاشتراك)(\s|$|[.!،])' THEN
    INSERT INTO office_do_not_contact (phone, reason, source) VALUES (v_ph, left(v_body, 200), 'reply')
    ON CONFLICT (phone) DO NOTHING;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A reply-matching failure must never lose an inbound WhatsApp message.
  RAISE WARNING 'office outreach reply match failed for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS chat_messages_office_outreach_reply ON public.chat_messages;
    CREATE TRIGGER chat_messages_office_outreach_reply
      AFTER INSERT ON public.chat_messages
      FOR EACH ROW WHEN (NEW.flow = 'in')
      EXECUTE FUNCTION public.tg_office_outreach_reply();
  END IF;
END $$;

-- ─── 11. Grants ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.office_outreach_line_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_outreach_settings_save(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_outreach_candidates(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_outreach_enqueue(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_outreach_cancel(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_outreach_can_view_record(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_outreach_line_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.office_outreach_settings_save(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.office_outreach_candidates(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.office_outreach_enqueue(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.office_outreach_cancel(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.office_outreach_can_view_record(uuid) TO authenticated, service_role;
REVOKE ALL ON public.office_outreach, public.office_outreach_settings, public.office_do_not_contact FROM anon;
GRANT SELECT ON public.office_outreach, public.office_outreach_settings, public.office_do_not_contact TO authenticated;

-- ─── 12. Office offerings: fields on units + all_projects ──────────────────
-- An office's offer is saved as ordinary records so it flows into client
-- options, the unit table and the finder like any other stock:
--   units.unit_source       'project' (default) | 'office' (standalone, no project)
--   units.source_office_id  / all_projects.source_office_id  → real_estate_offices
--   units.source_request_id / all_projects.source_request_id → unanswered_requests
--   units.office_unit_location — where a standalone office unit is (no project to inherit it from)
CREATE OR REPLACE FUNCTION pg_temp.oo_add_field(p_model uuid, p_section text, p_field jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_idx int; v_order int;
BEGIN
  IF p_model IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
              WHERE m.id = p_model AND f->>'name' = p_field->>'name') THEN RETURN; END IF;
  SELECT i - 1 INTO v_idx FROM models m, jsonb_array_elements(m.schema->'sections') WITH ORDINALITY t(s, i)
   WHERE m.id = p_model AND s->>'id' = p_section;
  IF v_idx IS NULL THEN RAISE EXCEPTION 'section % not found on model %', p_section, p_model; END IF;
  SELECT COALESCE(max((f->>'order')::int), -1) + 1 INTO v_order
    FROM models m, jsonb_array_elements(m.schema->'sections'->v_idx->'fields') f WHERE m.id = p_model;
  UPDATE models
     SET schema = jsonb_set(schema, ARRAY['sections', v_idx::text, 'fields'],
                            (schema->'sections'->v_idx->'fields')
                            || (p_field || jsonb_build_object('id', gen_random_uuid()::text, 'section_id', p_section, 'order', v_order))),
         updated_at = now()
   WHERE id = p_model;
END $$;

DO $$
DECLARE
  v_units uuid := (SELECT id FROM models WHERE name = 'units');
  v_projects uuid := (SELECT id FROM models WHERE name = 'all_projects');
  v_offices uuid := (SELECT id FROM models WHERE name = 'real_estate_offices');
  v_requests uuid := (SELECT id FROM models WHERE name = 'unanswered_requests');
BEGIN
  IF v_units IS NULL OR v_projects IS NULL OR v_offices IS NULL OR v_requests IS NULL THEN RETURN; END IF;

  PERFORM pg_temp.oo_add_field(v_units, '11111111-0000-4000-8000-000000000001', jsonb_build_object(
    'name', 'unit_source', 'label_ar', 'مصدر الوحدة', 'label_en', 'Unit Source', 'type', 'dropdown',
    'required', false, 'width', 'half', 'show_in_table', false,
    'options', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'project', 'label_ar', 'ضمن مشروع', 'label_en', 'In a project', 'color', '#B8734F'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'office', 'label_ar', 'وحدة من مكتب', 'label_en', 'Office unit', 'color', '#8E4E3A'))));
  PERFORM pg_temp.oo_add_field(v_units, '11111111-0000-4000-8000-000000000001', jsonb_build_object(
    'name', 'source_office_id', 'label_ar', 'المكتب المصدر', 'label_en', 'Source Office', 'type', 'lookup',
    'required', false, 'width', 'half', 'show_in_table', false, 'is_multi', false,
    'lookup_model_id', v_offices::text, 'lookup_display_field', 'office_name'));
  PERFORM pg_temp.oo_add_field(v_units, '11111111-0000-4000-8000-000000000001', jsonb_build_object(
    'name', 'source_request_id', 'label_ar', 'طلب العميل المصدر', 'label_en', 'Source Request', 'type', 'lookup',
    'required', false, 'width', 'half', 'show_in_table', false, 'is_multi', false,
    'lookup_model_id', v_requests::text, 'lookup_display_field', 'request_notes'));
  PERFORM pg_temp.oo_add_field(v_units, '11111111-0000-4000-8000-000000000005', jsonb_build_object(
    'name', 'office_unit_location', 'label_ar', 'موقع وحدة المكتب', 'label_en', 'Office Unit Location', 'type', 'location',
    'required', false, 'width', 'full', 'show_in_table', false));

  PERFORM pg_temp.oo_add_field(v_projects, 'fad0a581-049d-4a1a-b975-b3d87df8c901', jsonb_build_object(
    'name', 'source_office_id', 'label_ar', 'المكتب المصدر', 'label_en', 'Source Office', 'type', 'lookup',
    'required', false, 'width', 'half', 'show_in_table', false, 'is_multi', false,
    'lookup_model_id', v_offices::text, 'lookup_display_field', 'office_name'));
  PERFORM pg_temp.oo_add_field(v_projects, 'fad0a581-049d-4a1a-b975-b3d87df8c901', jsonb_build_object(
    'name', 'source_request_id', 'label_ar', 'طلب العميل المصدر', 'label_en', 'Source Request', 'type', 'lookup',
    'required', false, 'width', 'half', 'show_in_table', false, 'is_multi', false,
    'lookup_model_id', v_requests::text, 'lookup_display_field', 'request_notes'));
END $$;
