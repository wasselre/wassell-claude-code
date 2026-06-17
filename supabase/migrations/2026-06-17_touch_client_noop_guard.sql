-- ============================================================================
-- Fix: _touch_client must be a NO-OP when the client's derived fields wouldn't
-- change. Stops the Follow-up Workspace "keeps reloading" re-render burst.
--
-- ROOT CAUSE (diagnosed 2026-06-17): the client derived-fields system "touches"
-- the client (`UPDATE records SET data = data`) on every followups/calls/chats
-- change via records_touch_client_on_activity → _touch_client. records_bump_version
-- bumps `version` on ANY UPDATE (data unchanged or not) and set_updated_at_records
-- restamps `updated_at`, so each touch emits a Realtime `records` event. Booking an
-- appointment fires the "Appointment booked via call" workflow (create client
-- update + 2 confirmation follow-ups); the follow-up INSERTs each touch the client,
-- producing ~3 client UPDATEs/events. The SPA echo-dedup registers a NULL
-- updated_at (record_save doesn't return the row), so wasEchoOf suppresses only the
-- FIRST echo; the rest are applied by mergeRecord as external edits, replacing the
-- `records` store identity and re-rendering the whole Workspace tree (the visible
-- "reloading"). Bounded/transient (no infinite loop, no version storm — verified),
-- but the spurious churn is real and also inflates client `version` app-wide.
--
-- FIX: only perform the touch UPDATE when applying the recomputed derived patch
-- would actually change the row. A touch that changes nothing now produces no
-- UPDATE → no version bump → no updated_at restamp → no Realtime event → no
-- re-render. The BEFORE-fill (tg_records_fill_client_next_action) still runs on
-- every touch that DOES land, so derived-field semantics are unchanged.
--
-- DDL-only on an unfrozen model; idempotent (CREATE OR REPLACE). Does NOT touch
-- models.schema. recalc_client_derived_data(uuid, text) is the live recompute.
-- ============================================================================

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
  -- Only write when the recomputed derived patch actually changes the client.
  -- A no-op UPDATE would still bump version + restamp updated_at + emit a
  -- Realtime event, pointlessly re-rendering any open client view.
  UPDATE public.records r
  SET data = data
  WHERE r.id = v_uuid
    AND r.model_id = public._sales_clients_model_id()
    AND (r.data || public.recalc_client_derived_data(r.id, r.data->>'client_stage')) IS DISTINCT FROM r.data;
END;
$fn$;
