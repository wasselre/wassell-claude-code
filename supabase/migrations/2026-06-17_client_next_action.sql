-- ============================================================================
-- Client next-action trio — DB-maintained from open follow-ups.
--
-- The clients model carries three "next action" fields added in Phase 1 but
-- never wired to any writer, so they were permanently empty on all 154 clients:
--   • next_followup_id   (lookup → followups)
--   • next_action_type   (dropdown: call/whatsapp/appointment/offer/financing/ownership)
--   • next_action_due_at (datetime)
--
-- This makes them STORED-and-maintained aggregates, mirroring the proven
-- all_projects rollup pattern (2026-06-15_persist_project_rollups.sql):
--   • A SECURITY DEFINER function recomputes the trio from a client's OPEN
--     follow-ups (followup_status in open/in_progress) — the earliest
--     scheduled_datetime wins.
--   • A BEFORE INSERT/UPDATE trigger on the clients rows fills the trio inline
--     on every write, so a user edit can't wipe it; the DB is authoritative.
--   • An AFTER INSERT/UPDATE/DELETE trigger on the followups rows "touches" the
--     linked client(s) so creating / completing / rescheduling / deleting /
--     moving a follow-up recomputes the trio — self-healing, and it covers
--     EVERY create path (UI save, client-side workflows, the on_due sweeper,
--     direct DB writes) because it keys off the records table, not the engine.
--
-- Both clients and followups are UNFROZEN (JSONB in records) — no DDL. If either
-- is ever frozen, these triggers must move to the frozen write path (same caveat
-- as the all_projects rollups). SECURITY DEFINER so the recompute counts ALL of
-- a client's follow-ups and the touch bypasses the writer's RLS on the client.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ── Model-id helpers (tiny models table → effectively free; SECURITY DEFINER
--    so trigger contexts read models regardless of the invoker's RLS). ───────
CREATE OR REPLACE FUNCTION public._sales_clients_model_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.models WHERE name = 'clients' LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public._sales_followups_model_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.models WHERE name = 'followups' LIMIT 1;
$fn$;

-- A follow-up's linked client id (scalar lookup, or first element of an array).
CREATE OR REPLACE FUNCTION public._followup_client_id_of(d jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN d IS NULL THEN NULL
    WHEN jsonb_typeof(d->'client_id') = 'array' THEN nullif(d->'client_id'->>0, '')
    ELSE nullif(d->>'client_id', '')
  END;
$fn$;

-- Map a follow-up type (section_selector array, or scalar) to the client's
-- next_action_type vocabulary. Later-stage types map to their stage value;
-- every call/confirmation/recovery/visit type maps to the channel 'call'.
CREATE OR REPLACE FUNCTION public._followup_next_action_type(d jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE COALESCE(d->'followup_type'->>0, d->>'followup_type')
    WHEN 'whatsapp_follow_up'             THEN 'whatsapp'
    WHEN 'offer_follow_up'                THEN 'offer'
    WHEN 'financing_follow_up'            THEN 'financing'
    WHEN 'reservation_payment_follow_up'  THEN 'financing'
    WHEN 'ownership_transfer_follow_up'   THEN 'ownership'
    ELSE 'call'
  END;
$fn$;

-- Recompute the trio for one client from its OPEN follow-ups. Earliest
-- scheduled_datetime wins (created_at breaks ties); empty patch when none.
CREATE OR REPLACE FUNCTION public.recalc_client_next_action_data(p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_followups uuid := public._sales_followups_model_id();
  v_cid       text := p_client_id::text;
  r           record;
BEGIN
  IF v_followups IS NULL THEN RETURN '{}'::jsonb; END IF;

  SELECT f.id,
         f.data->>'scheduled_datetime'        AS due,
         public._followup_next_action_type(f.data) AS nat
  INTO r
  FROM public.records f
  WHERE f.model_id = v_followups
    AND public._followup_client_id_of(f.data) = v_cid
    AND COALESCE(f.data->>'followup_status', '') IN ('open', 'in_progress')
  ORDER BY public.try_timestamptz(f.data->>'scheduled_datetime') ASC NULLS LAST,
           f.created_at ASC
  LIMIT 1;

  IF r.id IS NULL THEN
    -- No open follow-up → clear the trio (self-healing on complete/delete).
    RETURN jsonb_build_object(
      'next_followup_id',   NULL,
      'next_action_type',   NULL,
      'next_action_due_at', NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'next_followup_id',   r.id::text,
    'next_action_type',   r.nat,
    'next_action_due_at', r.due
  );
END;
$fn$;

-- BEFORE INSERT/UPDATE on clients rows → fill the trio inline.
CREATE OR REPLACE FUNCTION public.tg_records_fill_client_next_action()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.model_id = public._sales_clients_model_id() THEN
    NEW.data := COALESCE(NEW.data, '{}'::jsonb) || public.recalc_client_next_action_data(NEW.id);
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_fill_client_next_action ON public.records;
CREATE TRIGGER records_fill_client_next_action
BEFORE INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_fill_client_next_action();

-- Touch one client so the BEFORE-fill recomputes it. SECURITY DEFINER so the
-- UPDATE applies even when the follow-up writer lacks edit rights on the client.
CREATE OR REPLACE FUNCTION public._touch_client(p_cid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_uuid uuid;
BEGIN
  IF p_cid IS NULL THEN RETURN; END IF;
  BEGIN
    v_uuid := p_cid::uuid;
  EXCEPTION WHEN others THEN
    RETURN;  -- not a uuid → nothing to touch
  END;
  UPDATE public.records SET data = data
  WHERE id = v_uuid AND model_id = public._sales_clients_model_id();
END;
$fn$;

-- AFTER INSERT/UPDATE/DELETE on followups rows → recompute affected client(s),
-- including the follow-up-moved-between-clients case (touch BOTH old + new).
CREATE OR REPLACE FUNCTION public.tg_records_touch_client_on_followup_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_followups uuid := public._sales_followups_model_id();
  v_old text;
  v_new text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.model_id <> v_followups THEN RETURN OLD; END IF;
    v_old := public._followup_client_id_of(OLD.data);
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.model_id <> v_followups THEN RETURN NEW; END IF;
    v_new := public._followup_client_id_of(NEW.data);
  ELSE  -- UPDATE
    IF NEW.model_id <> v_followups THEN RETURN NEW; END IF;
    v_old := public._followup_client_id_of(OLD.data);
    v_new := public._followup_client_id_of(NEW.data);
  END IF;

  IF v_new IS NOT NULL THEN
    PERFORM public._touch_client(v_new);
  END IF;
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN
    PERFORM public._touch_client(v_old);
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

DROP TRIGGER IF EXISTS records_touch_client_on_followup_change ON public.records;
CREATE TRIGGER records_touch_client_on_followup_change
AFTER INSERT OR UPDATE OR DELETE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_touch_client_on_followup_change();

-- Mark the trio read_only in the clients schema so the record form shows them
-- as DB-derived (not editable). Behavior-only; the trigger is authoritative.
DO $ro$
DECLARE
  v_id uuid;
  v_schema jsonb;
  s int;
  f int;
  v_name text;
BEGIN
  SELECT id, schema INTO v_id, v_schema FROM public.models WHERE name = 'clients';
  IF v_id IS NULL THEN RAISE NOTICE 'clients not found — skip read_only'; RETURN; END IF;

  FOR s IN 0 .. jsonb_array_length(v_schema->'sections') - 1 LOOP
    FOR f IN 0 .. jsonb_array_length(v_schema->'sections'->s->'fields') - 1 LOOP
      v_name := v_schema #>> ARRAY['sections', s::text, 'fields', f::text, 'name'];
      IF v_name IN ('next_followup_id', 'next_action_type', 'next_action_due_at') THEN
        v_schema := jsonb_set(
          v_schema,
          ARRAY['sections', s::text, 'fields', f::text, 'read_only'],
          'true'::jsonb, true
        );
      END IF;
    END LOOP;
  END LOOP;

  UPDATE public.models SET schema = v_schema, updated_at = now() WHERE id = v_id;
END $ro$;

-- Backfill: touch every client → BEFORE-fill computes + stores the trio for all.
UPDATE public.records
SET data = data
WHERE model_id = public._sales_clients_model_id();
