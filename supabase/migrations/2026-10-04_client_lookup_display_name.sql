-- Lookups to Clients show the client's NAME again (2026-10-04).
--
-- Eleven lookup fields that point at the `clients` model were set to display a
-- clients field that does not exist: `client_id` (followups, appointments,
-- visits, reservations, offer_prices, financing, ownership_transfer,
-- unanswered_requests) or `name` (chats, phone_calls, ai_chats). The clients
-- model's name field is `client_name`. With a missing display field the
-- resolver (`resolveLookupDisplayValue`) reads `data[<missing>]` → undefined,
-- so every generic surface that shows the linked client through the setting
-- showed a blank or the raw record id — found via the home page's
-- «آخر السجلات», where follow-ups were listed by their client's UUID.
--
-- This repoints ONLY lookups to clients whose display field names no existing
-- clients field. Nothing else in any schema changes; no record data changes.
-- None of these models is frozen, so no table / view-chain work is needed.

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_models_client_lookup_20261004 AS
  SELECT m.* FROM public.models m
   WHERE m.name IN ('ai_chats','appointments','chats','financing','followups','offer_prices',
                    'ownership_transfer','phone_calls','reservations','unanswered_requests','visits');
REVOKE ALL ON public._backup_models_client_lookup_20261004 FROM anon, authenticated;

DO $fix$
DECLARE
  v_clients_id text;
  v_client_fields text[];
BEGIN
  SELECT id::text INTO v_clients_id FROM public.models WHERE name = 'clients';
  IF v_clients_id IS NULL THEN RETURN; END IF;  -- fresh / branch database
  SELECT array_agg(f->>'name') INTO v_client_fields
    FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
   WHERE m.name = 'clients';
  IF NOT ('client_name' = ANY(v_client_fields)) THEN
    RAISE EXCEPTION 'CLIENT_LOOKUP_DISPLAY clients has no client_name field — fix aborted';
  END IF;

  UPDATE public.models m
     SET schema = jsonb_set(m.schema, '{sections}', (
           SELECT jsonb_agg(
                    s || jsonb_build_object('fields', (
                      SELECT COALESCE(jsonb_agg(
                               CASE WHEN f->>'type' = 'lookup'
                                     AND f->>'lookup_model_id' = v_clients_id
                                     AND COALESCE(f->>'lookup_display_field', '') <> ''
                                     AND position('::' in f->>'lookup_display_field') = 0
                                     AND NOT ((f->>'lookup_display_field') = ANY(v_client_fields))
                                    THEN f || jsonb_build_object('lookup_display_field', 'client_name')
                                    ELSE f END
                               ORDER BY fo), '[]'::jsonb)
                        FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS x(f, fo)))
                    ORDER BY so)
             FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS y(s, so))),
         updated_at = now()
   WHERE EXISTS (
     SELECT 1 FROM jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
      WHERE f->>'type' = 'lookup'
        AND f->>'lookup_model_id' = v_clients_id
        AND COALESCE(f->>'lookup_display_field', '') <> ''
        AND position('::' in f->>'lookup_display_field') = 0
        AND NOT ((f->>'lookup_display_field') = ANY(v_client_fields)));

  -- Assert: no lookup to clients is left pointing at a missing field.
  IF EXISTS (
    SELECT 1 FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
     WHERE f->>'type' = 'lookup'
       AND f->>'lookup_model_id' = v_clients_id
       AND COALESCE(f->>'lookup_display_field', '') <> ''
       AND position('::' in f->>'lookup_display_field') = 0
       AND NOT ((f->>'lookup_display_field') = ANY(v_client_fields))) THEN
    RAISE EXCEPTION 'CLIENT_LOOKUP_DISPLAY broken lookups remain';
  END IF;
END $fix$;

COMMIT;
