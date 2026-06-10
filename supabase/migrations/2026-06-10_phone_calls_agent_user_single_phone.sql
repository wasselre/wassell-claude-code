-- 2026-06-10 — Phone Calls (Hatif) module cleanup
-- ---------------------------------------------------------------------------
-- The `phone_calls` model is UNFROZEN (JSONB schema in `models`, rows in
-- `records`), so this migration edits the model's JSONB schema and backfills
-- the JSONB record data — there is no DDL / dedicated table.
--
-- Changes:
--   1. `agent_name`  text  → `assignee`  (links the call to a CRM user;
--      the webhook resolves the Hatif agent by email/name → users.id).
--   2. Remove the redundant raw phone legs `caller_number` + `callee_number`
--      from the model and from existing record data. `customer_phone` is the
--      single normalized customer-side number. (The raw legs remain on
--      `call_logs` for forensics.)
--   3. Backfill `agent_name`: resolve each existing raw-name string to a
--      users.id where the agent is a CRM user (normalized name match), else
--      JSON null — so the assignee field only ever holds a user id or null.
--   4. Backfill `client_link`: match `customer_phone` (digits-equal, both
--      sides normalized) to a client and link it.
--
-- `recording_url` keeps its `url` type — the inline audio player is a pure
-- frontend change in DynamicField, no schema change needed.
--
-- The `models_view_sync` trigger regenerates `v_phone_calls` automatically on
-- the schema UPDATE. Idempotent: safe to re-run (filters/merges are stable;
-- backfills only touch rows that differ). Take the _backup_* snapshots BELOW
-- before first run.

BEGIN;

-- ── 0. Backups (one-time safety net; comment out on idempotent re-runs) ─────
-- Run these once before the first application. They are NOT inside the
-- idempotent set — re-running would overwrite the pristine snapshot.
--   CREATE TABLE IF NOT EXISTS _backup_phone_calls_model_20260610   AS
--     SELECT * FROM public.models  WHERE name = 'phone_calls';
--   CREATE TABLE IF NOT EXISTS _backup_phone_calls_records_20260610 AS
--     SELECT * FROM public.records
--     WHERE model_id = (SELECT id FROM public.models WHERE name = 'phone_calls');

-- ── 1. Schema: drop the two raw legs, convert agent_name → assignee ─────────
UPDATE public.models m
SET schema = jsonb_set(
      m.schema,
      '{sections,0,fields}',
      COALESCE((
        SELECT jsonb_agg(
                 CASE
                   WHEN f->>'name' = 'agent_name'
                     THEN f || jsonb_build_object(
                            'type', 'assignee',
                            'assignee_user_filter_mode', 'all')
                   ELSE f
                 END
                 ORDER BY (f->>'order')::int
               )
        FROM jsonb_array_elements(m.schema->'sections'->0->'fields') f
        WHERE f->>'name' NOT IN ('caller_number', 'callee_number')
      ), '[]'::jsonb)
    ),
    updated_at = now()
WHERE m.name = 'phone_calls';

-- ── 2. Records: strip the orphaned raw-leg keys ────────────────────────────
UPDATE public.records
SET data = data - 'caller_number' - 'callee_number'
WHERE model_id = (SELECT id FROM public.models WHERE name = 'phone_calls')
  AND (data ? 'caller_number' OR data ? 'callee_number');

-- ── 3. Records: resolve agent_name raw-name → users.id (or JSON null) ───────
WITH resolved AS (
  SELECT r.id,
         (SELECT u.id::text
            FROM public.users u
           WHERE u.is_active
             AND (
               lower(regexp_replace(btrim(u.name_en), '\s+', ' ', 'g'))
                 = lower(regexp_replace(btrim(r.data->>'agent_name'), '\s+', ' ', 'g'))
               OR
               lower(regexp_replace(btrim(u.name_ar), '\s+', ' ', 'g'))
                 = lower(regexp_replace(btrim(r.data->>'agent_name'), '\s+', ' ', 'g'))
             )
           LIMIT 1) AS user_id
    FROM public.records r
   WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'phone_calls')
     AND r.data->>'agent_name' IS NOT NULL
)
UPDATE public.records r
SET data = jsonb_set(r.data, '{agent_name}',
                     COALESCE(to_jsonb(resolved.user_id), 'null'::jsonb))
FROM resolved
WHERE r.id = resolved.id
  -- only write when the stored value isn't already the resolved user id
  AND r.data->>'agent_name' IS DISTINCT FROM resolved.user_id;

-- ── 4. Records: backfill client_link from customer_phone (digits-equal) ─────
WITH matched AS (
  SELECT r.id AS call_id,
         (SELECT cl.id::text
            FROM public.records cl
           WHERE cl.model_id = (SELECT id FROM public.models WHERE name = 'clients')
             AND regexp_replace(cl.data->>'phone_number', '\D', '', 'g')
                 = regexp_replace(r.data->>'customer_phone', '\D', '', 'g')
           ORDER BY cl.created_at
           LIMIT 1) AS client_id
    FROM public.records r
   WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'phone_calls')
     AND COALESCE(r.data->>'customer_phone', '') <> ''
)
UPDATE public.records r
SET data = jsonb_set(r.data, '{client_link}', to_jsonb(matched.client_id))
FROM matched
WHERE r.id = matched.call_id
  AND matched.client_id IS NOT NULL
  AND r.data->>'client_link' IS DISTINCT FROM matched.client_id;

COMMIT;
