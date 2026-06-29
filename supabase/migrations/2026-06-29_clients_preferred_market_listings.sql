-- Clients: add a "Preferred Market Listings" field to the Client Preferences section
-- ============================================================================
-- Mirrors `preferred_projects` (lookup → all_projects, multi) but targets the
-- `market_listings` model — so when the Project Finder surfaces a market-listing
-- card, the salesperson's "Add to client" can store it in the client's
-- preferences WITHOUT polluting `preferred_projects` (which is an all_projects
-- lookup). `clients` is UNFROZEN (JSONB in `records`), so this is a pure
-- models.schema update — no column DDL. The `models_view_sync` trigger
-- regenerates `v_clients` automatically.
--
-- lookup_model_id is the LIVE market_listings model id (stable) — same literal is
-- used in seedModels.ts so a seed re-apply / heal can never write a stale id
-- (the "seed-backfill broken lookups" hazard).
--
-- Idempotent: the NOT EXISTS guard makes a re-run a no-op.
-- ============================================================================

update public.models
set schema = jsonb_set(
  schema,
  '{sections}',
  (
    select jsonb_agg(
      case
        when sec->>'id' = '84e95d93-b3cb-40d3-9f69-0b30d51a2a3a'  -- Client Preferences section
        then jsonb_set(
          sec,
          '{fields}',
          (sec->'fields') || jsonb_build_object(
            'id', gen_random_uuid()::text,
            'name', 'preferred_market_listings',
            'label_ar', 'إعلانات السوق المفضلة',
            'label_en', 'Preferred Market Listings',
            'type', 'lookup',
            'required', false,
            'order', 60,
            'section_id', '84e95d93-b3cb-40d3-9f69-0b30d51a2a3a',
            'width', 'half',
            'show_in_table', false,
            'lookup_model_id', '8f06bc39-4bee-42e9-9fab-77023fb89ede',  -- market_listings
            'lookup_display_field', 'title',
            'is_multi', true,
            'lookup_max_records', 1000
          )
        )
        else sec
      end
    )
    from jsonb_array_elements(schema->'sections') sec
  )
)
where name = 'clients'
  and not exists (
    select 1
    from jsonb_array_elements(schema->'sections') sec,
         jsonb_array_elements(sec->'fields') f
    where f->>'name' = 'preferred_market_listings'
  );
