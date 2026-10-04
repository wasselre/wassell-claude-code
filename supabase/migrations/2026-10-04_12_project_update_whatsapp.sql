-- Automated project updates from developers' WhatsApp groups (2026-10-04).
--
-- The operations line (wassel_ops) sits in the broker groups of Al-Ramz, Safa
-- and Riva. Developers post there: bookings («ريا النخيل مبنى 6 | شقة 2»),
-- available-unit price files (PDF), "only these are left" notes, commission
-- changes, and new projects. Until now someone read them and updated the CRM by
-- hand. This migration adds:
--
--   project_update_groups   which group belongs to which developer/marketer,
--                           and how far the reader has got (read_through).
--   not_before              on project_update_runs: a run waits until then.
--   chat_messages trigger   a new message in an enabled group queues ONE run
--                           per group, pushed back 3 minutes per new message
--                           (capped at 15 minutes after the first) so a text
--                           and the file posted right after it are read together.
--
-- The groups were already outside the sales funnel (api/webhook/waha.ts: no
-- bot, no lead, no follow-up task) — nothing here creates a task for anyone.
-- The trigger can never fail a message insert: it catches and RAISE WARNINGs
-- (same rule as the office-outreach reply trigger — losing an inbound message
-- to bookkeeping is far worse than missing one update).

BEGIN;

ALTER TABLE public.project_update_settings
  ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_debounce_seconds int NOT NULL DEFAULT 180,
  ADD COLUMN IF NOT EXISTS whatsapp_max_wait_seconds int NOT NULL DEFAULT 900;

ALTER TABLE public.project_update_runs
  ADD COLUMN IF NOT EXISTS not_before timestamptz;

CREATE TABLE IF NOT EXISTS public.project_update_groups (
  chat_wid      text PRIMARY KEY,
  label         text NOT NULL,
  -- developers/marketers (records of the companies model) whose projects this
  -- group talks about; the reader only ever matches projects of these.
  company_ids   uuid[] NOT NULL,
  is_enabled    boolean NOT NULL DEFAULT true,
  -- inbound messages with date <= read_through have been read.
  read_through  timestamptz,
  last_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.project_update_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_update_groups_admin_read ON public.project_update_groups;
CREATE POLICY project_update_groups_admin_read ON public.project_update_groups
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));
REVOKE ALL ON public.project_update_groups FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.project_update_groups FROM authenticated;
GRANT SELECT ON public.project_update_groups TO authenticated;

-- Seed the three groups the operations line is in today. read_through = now():
-- history is NOT replayed on go-live (old bookings / price files could undo
-- newer portal data); a backfill is an explicit dry run with params.since.
INSERT INTO public.project_update_groups (chat_wid, label, company_ids, read_through)
SELECT v.wid, v.label, v.ids, now()
FROM (VALUES
  ('120363407863381873@g.us', 'الرمز — شركاء النجاح (رمز الوساطة)', ARRAY['dfe055a2-de6a-49e6-8502-14d10d6d6b62']::uuid[]),
  ('120363429372820079@g.us', 'صفا للاستثمار — برنامج كسب', ARRAY['5ad445a4-4786-437a-87c0-361a3aeaf077']::uuid[]),
  ('120363411381105643@g.us', 'ريفا العقارية — الوسطاء', ARRAY['f8e1f1a2-fe39-4406-8b01-e91300fd1157']::uuid[])
) AS v(wid, label, ids)
ON CONFLICT (chat_wid) DO NOTHING;

-- Claim respects not_before (the WhatsApp debounce).
CREATE OR REPLACE FUNCTION public.project_update_claim_next(p_worker text)
RETURNS SETOF public.project_update_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.project_update_runs%ROWTYPE;
BEGIN
  IF NOT (SELECT is_enabled FROM public.project_update_settings WHERE id = 1) THEN RETURN; END IF;
  SELECT * INTO r FROM public.project_update_runs q
   WHERE q.status = 'queued' AND (q.not_before IS NULL OR q.not_before <= now())
   ORDER BY q.created_at
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.project_update_runs q
     SET status = 'running', attempts = r.attempts + 1, claimed_by = p_worker,
         started_at = now(), heartbeat_at = now()
   WHERE q.id = r.id
  RETURNING * INTO r;
  RETURN NEXT r;
END $$;

-- A run that must wait (e.g. a file in the batch is still being saved): back
-- to the queue until p_seconds from now, without spending an attempt.
CREATE OR REPLACE FUNCTION public.project_update_defer(p_id uuid, p_seconds int, p_note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.project_update_runs
     SET status = 'queued', claimed_by = NULL, attempts = GREATEST(attempts - 1, 0),
         not_before = now() + make_interval(secs => GREATEST(p_seconds, 30)),
         error = p_note
   WHERE id = p_id AND status = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

CREATE OR REPLACE FUNCTION public.tg_chat_messages_project_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.project_update_settings%ROWTYPE;
  v_key text;
BEGIN
  BEGIN
    IF NEW.flow IS DISTINCT FROM 'in' OR NEW.chat_wid NOT LIKE '%@g.us' THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.project_update_groups g WHERE g.chat_wid = NEW.chat_wid AND g.is_enabled) THEN
      RETURN NULL;
    END IF;
    SELECT * INTO s FROM public.project_update_settings WHERE id = 1;
    IF NOT FOUND OR NOT s.is_enabled OR NOT s.whatsapp_enabled THEN RETURN NULL; END IF;
    v_key := 'wa:' || NEW.chat_wid;
    -- Debounce: push the open run back, never past max_wait after it was queued.
    UPDATE public.project_update_runs r
       SET not_before = LEAST(now() + make_interval(secs => s.whatsapp_debounce_seconds),
                              r.created_at + make_interval(secs => s.whatsapp_max_wait_seconds))
     WHERE r.run_key = v_key AND r.status = 'queued';
    IF NOT FOUND THEN
      INSERT INTO public.project_update_runs (run_key, source_type, trigger, params, not_before)
      VALUES (v_key, 'whatsapp_group', 'whatsapp', jsonb_build_object('chat_wid', NEW.chat_wid),
              now() + make_interval(secs => s.whatsapp_debounce_seconds))
      ON CONFLICT (run_key) WHERE status IN ('queued','running') DO NOTHING;
      -- A run already RUNNING for this group: it reads up to its own snapshot;
      -- this message is picked up because read_through stays behind it, and
      -- the next message (or the scheduler sweep below) queues the next run.
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_chat_messages_project_update: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS chat_messages_project_update ON public.chat_messages;
CREATE TRIGGER chat_messages_project_update
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_chat_messages_project_update();

-- Sweep: a group with unread inbound messages and no open run (a message that
-- arrived while a run was RUNNING) gets one. Called from the worker tick.
CREATE OR REPLACE FUNCTION public.project_update_enqueue_groups() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.project_update_settings%ROWTYPE; g record; n int := 0;
BEGIN
  SELECT * INTO s FROM public.project_update_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.is_enabled OR NOT s.whatsapp_enabled THEN RETURN 0; END IF;
  FOR g IN
    SELECT pg.chat_wid FROM public.project_update_groups pg
     WHERE pg.is_enabled
       AND EXISTS (SELECT 1 FROM public.chat_messages m
                    WHERE m.chat_wid = pg.chat_wid AND m.flow = 'in'
                      AND m.date > COALESCE(pg.read_through, '-infinity'::timestamptz)
                      AND m.created_at < now() - make_interval(secs => s.whatsapp_debounce_seconds))
       AND NOT EXISTS (SELECT 1 FROM public.project_update_runs r
                        WHERE r.run_key = 'wa:' || pg.chat_wid AND r.status IN ('queued','running'))
       -- a group whose reads keep failing is retried at most 3 times a day
       AND (SELECT count(*) FROM public.project_update_runs r
             WHERE r.run_key = 'wa:' || pg.chat_wid AND r.status = 'failed'
               AND r.created_at > now() - interval '1 day') < 3
  LOOP
    PERFORM public.project_update_enqueue('whatsapp_group', 'wa:' || g.chat_wid, 'whatsapp', false,
                                          jsonb_build_object('chat_wid', g.chat_wid));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Advance a group's watermark (only forward).
CREATE OR REPLACE FUNCTION public.project_update_group_advance(p_chat_wid text, p_through timestamptz)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.project_update_groups
     SET read_through = GREATEST(COALESCE(read_through, p_through), p_through), last_run_at = now()
   WHERE chat_wid = p_chat_wid;
$$;

REVOKE ALL ON FUNCTION public.project_update_defer(uuid,int,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_enqueue_groups() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_update_group_advance(text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_chat_messages_project_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_update_defer(uuid,int,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_enqueue_groups() TO service_role;
GRANT EXECUTE ON FUNCTION public.project_update_group_advance(text,timestamptz) TO service_role;

COMMIT;
