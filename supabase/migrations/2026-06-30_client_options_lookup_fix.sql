-- Repair the client_property_options.client_id lookup_model_id.
--
-- client_property_options is a seeded (is_system) model added 2026-06-30. Its
-- client_id field is a lookup → clients, but seed model ids are generated with
-- uuid() per app load (src/data/seedModels.ts), so the frontend backfill that
-- INSERTs the model into Supabase writes the SEED's clients id as
-- lookup_model_id — which does NOT match the live clients model row id. This is
-- the documented "seed-backfill writes broken lookups" trap.
--
-- The feature itself is unaffected (the Project Finder + Client Options tab write
-- client_id as a plain string, never via the lookup picker), but the generic
-- Builder form's client_id picker would resolve to a non-existent model. This
-- repoints it at the LIVE clients model, resolved BY NAME so it is portable +
-- idempotent + restore-safe (re-run after any DB restore that rolls the row back).
--
-- Already applied live to wassell-prod on 2026-06-30 via the Supabase MCP.

UPDATE public.models m
SET schema = jsonb_set(
      m.schema,
      '{sections,0,fields}',
      (
        SELECT jsonb_agg(
          CASE WHEN f.value->>'name' = 'client_id'
            THEN f.value || jsonb_build_object(
                   'lookup_model_id',
                   (SELECT id::text FROM public.models WHERE name = 'clients' LIMIT 1)
                 )
            ELSE f.value
          END
          ORDER BY f.ord
        )
        FROM jsonb_array_elements(m.schema->'sections'->0->'fields') WITH ORDINALITY AS f(value, ord)
      )
    ),
    updated_at = now()
WHERE m.name = 'client_property_options'
  AND EXISTS (SELECT 1 FROM public.models WHERE name = 'clients');
