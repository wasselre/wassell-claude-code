-- Per-client portal registrations: a managed, durable record of "this client,
-- in this portal, is in state X" — instead of a log of one-off robot runs.
--
--   client_portal_registrations        ONE row per (client, portal). Two status
--                                      axes: our_status (what WE know) and
--                                      portal_status (what the PORTAL says,
--                                      verbatim label + raw code).
--   client_portal_registration_events  the history under each row: runs,
--                                      daily status checks, status changes,
--                                      manual edits.
--
-- Kept up to date three ways:
--   1. every registration run (portal_registration_jobs, kind='register') via
--      the AFTER trigger below — no worker change needed for that path;
--   2. the daily / on-demand STATUS CHECK: a portal_registration_jobs row with
--      kind='status_check' (no client). The worker signs in, reads the portal's
--      client list, and hands the rows to portal_status_sync_apply(), which
--      matches them to our clients by canonical phone;
--   3. manual edits from the client's «البوابات» tab (api/portal-registration.ts).
--
-- A portal-status CHANGE (not the first reading) notifies the client's owner:
-- Web Push (push_outbox) + a WhatsApp from the operations line to the rep.
--
-- Service-role only (RLS on, no policies): the SPA reads and writes through
-- api/portal-registration.ts, which gates on the client record's visibility.

BEGIN;

-- ── 1. Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_portal_registrations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_record_id         uuid NOT NULL,
  portal_record_id         uuid NOT NULL,
  our_status               text NOT NULL DEFAULT 'not_registered'
                           CHECK (our_status IN ('not_registered','registering','registered','already_registered','failed')),
  portal_status            text,          -- label exactly as the portal shows it (e.g. «جديد»)
  portal_status_code       text,          -- the portal's raw value (e.g. 'new')
  portal_status_changed_at timestamptz,
  portal_ref               text,          -- the portal's id for this client (e.g. '#14157')
  project_names            text[] NOT NULL DEFAULT '{}',   -- our project names registered for
  registered_as            text[] NOT NULL DEFAULT '{}',   -- what the portal was told (its project names)
  registered_at            timestamptz,
  registered_via           text CHECK (registered_via IN ('auto','manual_run','manual_entry','portal_sync')),
  registered_by_user_id    uuid,          -- auth uid of whoever ran / entered it
  last_checked_at          timestamptz,   -- last status check that FOUND this client in the portal
  last_job_id              uuid,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_record_id, portal_record_id)
);
CREATE INDEX IF NOT EXISTS client_portal_registrations_portal_idx
  ON public.client_portal_registrations (portal_record_id);

CREATE TABLE IF NOT EXISTS public.client_portal_registration_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id  uuid NOT NULL REFERENCES public.client_portal_registrations(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('run','status_check','status_change','found_in_portal','manual_edit','created')),
  our_status       text,
  portal_status    text,
  summary_ar       text NOT NULL,
  summary_en       text NOT NULL,
  job_id           uuid,
  actor_user_id    uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_portal_registration_events_reg_idx
  ON public.client_portal_registration_events (registration_id, created_at DESC);

ALTER TABLE public.client_portal_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_portal_registration_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_portal_registrations, public.client_portal_registration_events FROM anon, authenticated;

-- ── 2. Status-check jobs share the registration queue ───────────────────────
-- Same queue on purpose: claim_next's "one live run per portal" rule is what
-- keeps ONE code outstanding on the sign-in phone, and the WhatsApp relay
-- (park / restart on reply) works for them unchanged.

ALTER TABLE public.portal_registration_jobs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'register';
ALTER TABLE public.portal_registration_jobs DROP CONSTRAINT IF EXISTS portal_registration_jobs_kind_check;
ALTER TABLE public.portal_registration_jobs ADD CONSTRAINT portal_registration_jobs_kind_check
  CHECK (kind IN ('register','status_check'));
ALTER TABLE public.portal_registration_jobs ALTER COLUMN client_record_id DROP NOT NULL;
ALTER TABLE public.portal_registration_jobs DROP CONSTRAINT IF EXISTS portal_registration_jobs_client_required;
ALTER TABLE public.portal_registration_jobs ADD CONSTRAINT portal_registration_jobs_client_required
  CHECK (kind = 'status_check' OR client_record_id IS NOT NULL);
-- A status check has no rep to own it: nobody types its code in a modal, it
-- always goes through the WhatsApp relay.
ALTER TABLE public.portal_registration_jobs DROP CONSTRAINT IF EXISTS portal_registration_jobs_user_required;
ALTER TABLE public.portal_registration_jobs ADD CONSTRAINT portal_registration_jobs_user_required
  CHECK (user_id IS NOT NULL
         OR kind = 'status_check'
         OR (status = 'failed' AND result->>'skip_reason' = 'no_owner'));

CREATE UNIQUE INDEX IF NOT EXISTS portal_registration_jobs_one_active_check_idx
  ON public.portal_registration_jobs (portal_record_id)
  WHERE kind = 'status_check' AND status IN ('queued','running','awaiting_input');

CREATE OR REPLACE FUNCTION public.portal_status_check_enqueue(p_portal_record_id uuid, p_user_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.portal_registration_jobs
    (portal_record_id, client_record_id, user_id, lead_data, kind, origin)
  VALUES (p_portal_record_id, NULL, p_user_id, '{}'::jsonb, 'status_check', 'auto')
  ON CONFLICT (portal_record_id)
    WHERE kind = 'status_check' AND status IN ('queued','running','awaiting_input') DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.portal_registration_jobs
     WHERE portal_record_id = p_portal_record_id AND kind = 'status_check'
       AND status IN ('queued','running','awaiting_input')
     ORDER BY created_at DESC LIMIT 1;
    -- An explicit request wakes a parked check (the code will be asked for again).
    UPDATE public.portal_registration_jobs SET parked_at = NULL, updated_at = now()
     WHERE id = v_id AND parked_at IS NOT NULL;
  END IF;
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.portal_status_check_enqueue(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_status_check_enqueue(uuid, uuid) TO service_role;

-- ── 3. Runs → registration row (trigger) ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_portal_jobs_sync_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_reg      public.client_portal_registrations;
  v_new      text;
  v_proj     text := NULLIF(NEW.lead_data->>'project_name', '');
  v_as       text := NULLIF(NEW.lead_data->>'project', '');
  v_via      text := CASE WHEN NEW.origin = 'auto' THEN 'auto' ELSE 'manual_run' END;
  v_ar       text;
  v_en       text;
  v_err      text := split_part(COALESCE(NEW.error_message, ''), E'\n', 1);
BEGIN
  IF NEW.kind <> 'register' OR NEW.client_record_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  INSERT INTO public.client_portal_registrations (client_record_id, portal_record_id)
  VALUES (NEW.client_record_id, NEW.portal_record_id)
  ON CONFLICT (client_record_id, portal_record_id) DO NOTHING;
  SELECT * INTO v_reg FROM public.client_portal_registrations
   WHERE client_record_id = NEW.client_record_id AND portal_record_id = NEW.portal_record_id
   FOR UPDATE;

  v_new := v_reg.our_status;
  IF NEW.status IN ('queued','running','awaiting_input') THEN
    -- A fresh attempt never downgrades a client the portal already has.
    IF v_reg.our_status NOT IN ('registered','already_registered') THEN v_new := 'registering'; END IF;
  ELSIF NEW.status = 'done' THEN
    v_new := 'registered';
    v_ar := 'سُجّل العميل في البوابة' || COALESCE(' — ' || v_proj, '');
    v_en := 'Registered in the portal' || COALESCE(' — ' || v_proj, '');
  ELSIF NEW.status = 'already_registered' THEN
    IF v_reg.our_status <> 'registered' THEN v_new := 'already_registered'; END IF;
    v_ar := 'البوابة أفادت أن العميل مسجّل لدى وسيط آخر';
    v_en := 'The portal says the client is already another broker''s';
  ELSIF NEW.status = 'failed' THEN
    IF v_reg.our_status NOT IN ('registered','already_registered') THEN
      v_new := CASE WHEN NEW.result->>'skip_reason' = 'no_owner' THEN 'not_registered' ELSE 'failed' END;
    END IF;
    v_ar := 'فشلت محاولة التسجيل' || CASE WHEN v_err <> '' THEN ': ' || v_err ELSE '' END;
    v_en := 'Registration attempt failed' || CASE WHEN split_part(COALESCE(NEW.error_message,''), E'\n', 2) <> ''
                                                 THEN ': ' || split_part(NEW.error_message, E'\n', 2) ELSE '' END;
  ELSIF NEW.status = 'cancelled' THEN
    IF v_reg.our_status = 'registering' THEN
      v_new := CASE WHEN v_reg.registered_at IS NOT NULL THEN 'registered' ELSE 'not_registered' END;
    END IF;
    v_ar := 'أُلغيت محاولة التسجيل';
    v_en := 'Registration attempt cancelled';
  END IF;

  UPDATE public.client_portal_registrations r
     SET our_status            = v_new,
         project_names         = CASE WHEN v_proj IS NOT NULL AND NOT (v_proj = ANY(r.project_names))
                                      THEN r.project_names || v_proj ELSE r.project_names END,
         registered_as         = CASE WHEN NEW.status = 'done' AND v_as IS NOT NULL AND NOT (v_as = ANY(r.registered_as))
                                      THEN r.registered_as || v_as ELSE r.registered_as END,
         registered_at         = CASE WHEN NEW.status = 'done' THEN COALESCE(r.registered_at, NEW.finished_at, now()) ELSE r.registered_at END,
         registered_via        = CASE WHEN NEW.status = 'done' AND r.registered_via IS NULL THEN v_via ELSE r.registered_via END,
         registered_by_user_id = CASE WHEN NEW.status = 'done' AND r.registered_by_user_id IS NULL THEN NEW.user_id ELSE r.registered_by_user_id END,
         last_job_id           = NEW.id,
         updated_at            = now()
   WHERE r.id = v_reg.id;

  IF v_ar IS NOT NULL THEN
    INSERT INTO public.client_portal_registration_events
      (registration_id, kind, our_status, summary_ar, summary_en, job_id, actor_user_id)
    VALUES (v_reg.id, 'run', v_new, v_ar, v_en, NEW.id, NEW.user_id);
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS portal_jobs_sync_registration ON public.portal_registration_jobs;
CREATE TRIGGER portal_jobs_sync_registration
  AFTER INSERT OR UPDATE OF status ON public.portal_registration_jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_portal_jobs_sync_registration();

-- ── 4. Status check → registration rows ─────────────────────────────────────
-- p_rows: [{ref, name, phone, status_code, status_label}] as read from the
-- portal. Returns {rows, matched, created, changed:[{client, from, to}], unmatched}.

CREATE OR REPLACE FUNCTION public.portal_status_sync_apply(p_job_id uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_job        public.portal_registration_jobs;
  v_portal     text;
  v_clients_id uuid;
  v_ops        text;
  r            record;
  v_reg        public.client_portal_registrations;
  v_matched    int := 0;
  v_created    int := 0;
  v_unmatched  int := 0;
  v_changed    jsonb := '[]'::jsonb;
  v_owner      uuid;
  v_owner_ph   text;
  v_name       text;
  v_label      text;
  v_url        text;
BEGIN
  SELECT * INTO v_job FROM public.portal_registration_jobs WHERE id = p_job_id;
  IF NOT FOUND OR v_job.kind <> 'status_check' THEN
    RAISE EXCEPTION 'portal_status_sync_apply: % is not a status-check job', p_job_id;
  END IF;
  SELECT COALESCE(data->>'name', '—') INTO v_portal FROM public.records WHERE id = v_job.portal_record_id;
  SELECT id INTO v_clients_id FROM public.models WHERE name = 'clients';
  SELECT device_id INTO v_ops FROM public.whatsapp_numbers WHERE is_active AND is_operations LIMIT 1;

  FOR r IN
    WITH rows AS (
      SELECT NULLIF(x->>'ref','') AS ref,
             NULLIF(x->>'status_label','') AS label,
             NULLIF(x->>'status_code','') AS code,
             public.ksa_phone_canon(x->>'phone') AS canon
        FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) x
    ),
    clients AS (
      SELECT c.id, c.data, public.ksa_phone_canon(c.data->>'phone_number') AS canon
        FROM public.records c WHERE c.model_id = v_clients_id
    )
    SELECT rows.ref, rows.label, rows.code, rows.canon, cl.id AS client_id, cl.data AS client_data
      FROM rows LEFT JOIN clients cl ON cl.canon IS NOT NULL AND cl.canon = rows.canon
  LOOP
    IF r.client_id IS NULL THEN v_unmatched := v_unmatched + 1; CONTINUE; END IF;
    v_matched := v_matched + 1;
    v_label := COALESCE(r.label, r.code);

    SELECT * INTO v_reg FROM public.client_portal_registrations
     WHERE client_record_id = r.client_id AND portal_record_id = v_job.portal_record_id FOR UPDATE;
    IF NOT FOUND THEN
      -- On the portal's list under us but never recorded here (registered by
      -- hand before the app, or by a colleague directly in the portal).
      INSERT INTO public.client_portal_registrations
        (client_record_id, portal_record_id, our_status, portal_status, portal_status_code,
         portal_status_changed_at, portal_ref, registered_via, last_checked_at, last_job_id)
      VALUES (r.client_id, v_job.portal_record_id, 'registered', v_label, r.code,
              now(), r.ref, 'portal_sync', now(), p_job_id)
      RETURNING * INTO v_reg;
      v_created := v_created + 1;
      INSERT INTO public.client_portal_registration_events
        (registration_id, kind, our_status, portal_status, summary_ar, summary_en, job_id)
      VALUES (v_reg.id, 'found_in_portal', 'registered', v_label,
              'وُجد العميل ضمن عملائنا في البوابة' || COALESCE(' (' || r.ref || ')', '') || ' — الحالة «' || COALESCE(v_label,'—') || '»',
              'Found among our clients in the portal' || COALESCE(' (' || r.ref || ')', '') || ' — status "' || COALESCE(v_label,'—') || '"',
              p_job_id);
      CONTINUE;
    END IF;

    IF v_reg.portal_status IS DISTINCT FROM v_label THEN
      INSERT INTO public.client_portal_registration_events
        (registration_id, kind, our_status, portal_status, summary_ar, summary_en, job_id)
      VALUES (v_reg.id, 'status_change', 'registered', v_label,
              'تغيّرت حالة البوابة: «' || COALESCE(v_reg.portal_status,'—') || '» ← «' || COALESCE(v_label,'—') || '»',
              'Portal status changed: "' || COALESCE(v_reg.portal_status,'—') || '" → "' || COALESCE(v_label,'—') || '"',
              p_job_id);
      -- Notify the rep on a real CHANGE only — the first reading is not news.
      IF v_reg.portal_status IS NOT NULL THEN
        v_changed := v_changed || jsonb_build_object('client', r.client_data->>'client_name', 'from', v_reg.portal_status, 'to', v_label);
        v_owner := NULL; v_owner_ph := NULL;
        BEGIN
          v_owner := NULLIF(CASE jsonb_typeof(r.client_data->'client_owner')
                               WHEN 'array' THEN r.client_data->'client_owner'->>0
                               ELSE r.client_data->>'client_owner' END, '')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RAISE WARNING 'portal_status_sync_apply: client % has a non-uuid client_owner %', r.client_id, r.client_data->'client_owner';
          v_owner := NULL;
        END;
        v_name := COALESCE(NULLIF(r.client_data->>'client_name',''), 'العميل');
        v_url := '/model/clients/' || r.client_id || '?tab=portals';
        IF v_owner IS NOT NULL THEN
          INSERT INTO public.push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
          VALUES (v_owner, 'portal_status_change',
                  'تغيّرت حالة عميل في «' || v_portal || '»',
                  v_name || ': «' || COALESCE(v_reg.portal_status,'—') || '» ← «' || COALESCE(v_label,'—') || '»',
                  v_url, 'portal-status-' || v_reg.id,
                  'portal-status:' || v_reg.id || ':' || COALESCE(v_label,'') || ':' || p_job_id)
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
          SELECT regexp_replace(COALESCE(phone,''), '\D', '', 'g') INTO v_owner_ph FROM public.users WHERE id = v_owner AND is_active;
          IF v_ops IS NOT NULL AND COALESCE(v_owner_ph,'') <> '' THEN
            v_owner_ph := CASE WHEN v_owner_ph LIKE '05%' THEN '966' || substr(v_owner_ph, 2)
                               WHEN v_owner_ph LIKE '5%' AND length(v_owner_ph) = 9 THEN '966' || v_owner_ph
                               ELSE v_owner_ph END;
            INSERT INTO public.scheduled_whatsapp_jobs (device_id, chat_wid, phone, body, deliver_at)
            VALUES (v_ops, v_owner_ph || '@c.us', '+' || v_owner_ph,
                    '📋 تغيّرت حالة عميلك «' || v_name || '» في «' || v_portal || '»: «' ||
                    COALESCE(v_reg.portal_status,'—') || '» ← «' || COALESCE(v_label,'—') || '»' ||
                    E'\nhttps://app.wassel.re' || v_url,
                    now());
          END IF;
        END IF;
      END IF;
    END IF;

    UPDATE public.client_portal_registrations
       SET portal_status            = v_label,
           portal_status_code       = r.code,
           portal_status_changed_at = CASE WHEN portal_status IS DISTINCT FROM v_label THEN now() ELSE portal_status_changed_at END,
           portal_ref               = COALESCE(r.ref, portal_ref),
           -- Being on the portal's list under us IS proof of registration.
           our_status               = 'registered',
           registered_at            = COALESCE(registered_at, now()),
           registered_via           = COALESCE(registered_via, 'portal_sync'),
           last_checked_at          = now(),
           last_job_id              = p_job_id,
           updated_at               = now()
     WHERE id = v_reg.id;
    IF v_reg.our_status <> 'registered' THEN
      INSERT INTO public.client_portal_registration_events
        (registration_id, kind, our_status, portal_status, summary_ar, summary_en, job_id)
      VALUES (v_reg.id, 'found_in_portal', 'registered', v_label,
              'وُجد العميل ضمن عملائنا في البوابة — عُدّل إلى «مسجّل»',
              'Found among our clients in the portal — set to "registered"', p_job_id);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('rows', jsonb_array_length(COALESCE(p_rows,'[]'::jsonb)),
                            'matched', v_matched, 'created', v_created,
                            'unmatched', v_unmatched, 'changed', v_changed);
END $fn$;
REVOKE ALL ON FUNCTION public.portal_status_sync_apply(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_status_sync_apply(uuid, jsonb) TO service_role;

-- ── 5. Backfill from the runs already on file ───────────────────────────────

INSERT INTO public.client_portal_registrations
  (client_record_id, portal_record_id, our_status, project_names, registered_as,
   registered_at, registered_via, registered_by_user_id, last_job_id)
SELECT j.client_record_id, j.portal_record_id,
       CASE WHEN bool_or(j.status = 'done') THEN 'registered'
            WHEN bool_or(j.status = 'already_registered') THEN 'already_registered'
            WHEN bool_or(j.status = 'failed' AND COALESCE(j.result->>'skip_reason','') <> 'no_owner') THEN 'failed'
            ELSE 'not_registered' END,
       COALESCE(array_agg(DISTINCT j.lead_data->>'project_name') FILTER (WHERE COALESCE(j.lead_data->>'project_name','') <> ''), '{}'),
       COALESCE(array_agg(DISTINCT j.lead_data->>'project') FILTER (WHERE j.status = 'done' AND COALESCE(j.lead_data->>'project','') <> ''), '{}'),
       min(j.finished_at) FILTER (WHERE j.status = 'done'),
       (array_agg(CASE WHEN j.origin = 'auto' THEN 'auto' ELSE 'manual_run' END ORDER BY j.finished_at) FILTER (WHERE j.status = 'done'))[1],
       (array_agg(j.user_id ORDER BY j.finished_at) FILTER (WHERE j.status = 'done'))[1],
       (array_agg(j.id ORDER BY j.created_at DESC))[1]
  FROM public.portal_registration_jobs j
 WHERE j.kind = 'register' AND j.client_record_id IS NOT NULL
   AND j.status IN ('done','failed','already_registered','cancelled')
 GROUP BY j.client_record_id, j.portal_record_id
ON CONFLICT (client_record_id, portal_record_id) DO NOTHING;

INSERT INTO public.client_portal_registration_events
  (registration_id, kind, our_status, summary_ar, summary_en, job_id, actor_user_id, created_at)
SELECT r.id, 'run',
       CASE j.status WHEN 'done' THEN 'registered' WHEN 'already_registered' THEN 'already_registered'
                     WHEN 'cancelled' THEN NULL ELSE 'failed' END,
       CASE j.status WHEN 'done' THEN 'سُجّل العميل في البوابة' || COALESCE(' — ' || NULLIF(j.lead_data->>'project_name',''), '')
                     WHEN 'already_registered' THEN 'البوابة أفادت أن العميل مسجّل لدى وسيط آخر'
                     WHEN 'cancelled' THEN 'أُلغيت محاولة التسجيل'
                     ELSE 'فشلت محاولة التسجيل' || CASE WHEN split_part(COALESCE(j.error_message,''), E'\n', 1) <> ''
                                                        THEN ': ' || split_part(j.error_message, E'\n', 1) ELSE '' END END,
       CASE j.status WHEN 'done' THEN 'Registered in the portal' || COALESCE(' — ' || NULLIF(j.lead_data->>'project_name',''), '')
                     WHEN 'already_registered' THEN 'The portal says the client is already another broker''s'
                     WHEN 'cancelled' THEN 'Registration attempt cancelled'
                     ELSE 'Registration attempt failed' END,
       j.id, j.user_id, COALESCE(j.finished_at, j.created_at)
  FROM public.portal_registration_jobs j
  JOIN public.client_portal_registrations r
    ON r.client_record_id = j.client_record_id AND r.portal_record_id = j.portal_record_id
 WHERE j.kind = 'register' AND j.status IN ('done','failed','already_registered','cancelled')
   AND NOT EXISTS (SELECT 1 FROM public.client_portal_registration_events e WHERE e.job_id = j.id);

COMMIT;
