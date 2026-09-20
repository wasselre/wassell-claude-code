-- ============================================================================
-- 2026-09-20_repair_dangling_display_refs.sql
--
-- Repair every card_config / maps_config reference that points at a field id
-- no longer present in its model's schema.
--
-- WHY THESE BROKE
--   The 2026-08-20 client-side re-seed incident replaced several models'
--   `schema` JSONB wholesale. Restoring a schema mints NEW field ids, but
--   `card_config` / `maps_config` store ids, not slugs — so every display slot
--   kept pointing at the pre-restore id. The same mechanism (seedModels.ts
--   generates its field ids with a per-load `uuid()`) also left a few slots
--   dangling well before that incident: followups + targeted_projects have read
--   "(unknown field)" in the generated PRDs since at least 2026-06-11.
--
-- WHAT THE DAMAGE LOOKS LIKE
--   CardView (src/pages/Records/components/CardView.tsx:197-202) and MapsView
--   resolve each slot through a lookup that returns `undefined` for a missing
--   id, so the badge / subtitle / extra field simply does not render. Only the
--   card TITLE has a fallback (src/lib/recordTitle.ts) — which is why this went
--   unnoticed: cards still showed a title, just silently lost their badge and
--   subtitle.
--
-- HOW EACH TARGET WAS RECOVERED
--   * same slug   — the old id resolved to a slug in a pre-wipe snapshot
--                   (supabase/branch-bootstrap-13.sql, 2026-08-01, or a
--                   _backup_* table) and the live schema has that same slug.
--   * bootstrap-13 — all_projects.badge: the pre-wipe value fb66c9b3
--                   (project_status) is STILL a live id, so this is a straight
--                   restore of the pre-wipe configuration.
--   * seedModels.ts — followups + targeted_projects: the slot was already
--                   dangling before any snapshot we hold, so intent comes from
--                   the seed definition itself (fuClientFieldId -> client_id,
--                   tpNameFieldId -> project_name, tpPriorityFieldId ->
--                   priority).
--   * inferred    — ONE slot, clients.card.shown_field_ids[0]. The old id was
--                   `client_id [auto_id]`; the live model has no such slug
--                   because the field was REPLACED (new id and new slug) by
--                   `client_code [auto_id]` during the 2026-08-20 restore.
--                   Same concept, and still the model's only auto_id, so the
--                   user's deliberate card choice (the seed ships
--                   shown_field_ids: []) carries over. This is the one target
--                   here that is an inference rather than a recovered fact.
--   * dropped     — the field is genuinely gone with no same-slug successor:
--                   all_projects' preferred_city / preferred_country /
--                   preferred_neighborhoods and market_listings' city /
--                   district were folded into the `location` field by the geo
--                   migration. These references are REMOVED rather than
--                   re-pointed at `location`: swapping in a different field
--                   would be a display change, not a repair. Nothing visible
--                   changes — the app already filters them out.
--
-- `models.schema` IS NOT TOUCHED. The schemas were already restored; only the
-- display columns are repaired here.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Back up the display columns of every model this migration touches.
--
--    IF NOT EXISTS, deliberately: re-running this migration must never
--    overwrite the backup with the already-repaired state. (The rest of the
--    migration is a safe no-op on a second run — the old ids are gone from the
--    configs, so nothing matches and nothing changes.)
--
--    Rollback:
--      UPDATE public.models m
--      SET card_config = b.card_config, maps_config = b.maps_config
--      FROM public._backup_models_displaycols_20260920 b
--      WHERE b.id = m.id;
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public._backup_models_displaycols_20260920 AS
SELECT id, name, card_config, maps_config, now() AS backed_up_at
FROM public.models
WHERE name IN ('ai_chats', 'all_projects', 'chat_templates', 'chats', 'clients', 'copywriter_chats', 'data_migration', 'decks', 'followups', 'image_chats', 'market_listings', 'matching_chats', 'phone_calls', 'reel_scripts', 'targeted_projects');

-- ---------------------------------------------------------------------------
-- 2. The repair map: (model, dangling id) -> live id, or NULL to drop the ref.
--    `slots` and `note` are documentation only — the rewrite keys off old_id,
--    so a dangling id found in a slot not listed here is repaired too.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _display_ref_fix (
  model_name text NOT NULL,
  old_id     text NOT NULL,
  new_id     text,
  slots      text NOT NULL,
  note       text NOT NULL,
  PRIMARY KEY (model_name, old_id)
) ON COMMIT DROP;

INSERT INTO _display_ref_fix (model_name, old_id, new_id, slots, note) VALUES
  ('ai_chats',           'c534b9c4-4c6d-4ddc-90e3-aaa88b163c26', '5f7fc373-4c7f-4db7-9b37-6db5931bc1d3',  'card.badge_field_id', 'status (same slug)'),
  ('ai_chats',           'b912a23a-7db4-407e-a14b-5e4aaa402df2', 'df7c1c20-79a4-441c-b9f8-c42a3c204b25',  'card.subtitle_field_id', 'last_message_at (same slug)'),
  ('ai_chats',           '34a26cc5-1539-4d68-bd42-e9468b081e5d', '113791ae-ac91-47f4-875f-cfc0392bd790',  'card.title_field_id', 'title (same slug)'),
  ('all_projects',       '95d2ba80-86f4-4b49-ab67-ed1a028fb2eb', 'fb66c9b3-65a5-4715-97f7-420917f5b893',  'card.badge_field_id', 'id not in any snapshot -> project_status'),
  ('all_projects',       'b43684a1-f729-4167-bcf9-92d75bdd5470', NULL,                                    'maps.popup_shown_field_ids[2]', 'preferred_neighborhoods (dropped - field gone)'),
  ('all_projects',       'b6e14351-55ff-401b-947e-a3cebcef02b0', NULL,                                    'maps.popup_shown_field_ids[6]', 'preferred_country (dropped - field gone)'),
  ('all_projects',       '2e2992f7-0283-42e8-9031-5d7f557978e7', NULL,                                    'maps.popup_shown_field_ids[7]', 'preferred_city (dropped - field gone)'),
  ('chat_templates',     '11758e40-cf71-47a0-a186-f31686fe98e5', 'c12c0115-1749-4b46-a512-9e6c43c7a991',  'card.subtitle_field_id', 'language (same slug)'),
  ('chat_templates',     '513afce3-762f-4a75-ad67-f8e04571c972', '18933d8d-b94f-443d-919c-9029da7068e4',  'card.title_field_id', 'name (same slug)'),
  ('chats',              '5ea3e89a-2de9-4cfc-afc2-609e1aec90e3', '7ad14bb0-e910-4c41-b9b7-72a5464b836a',  'card.badge_field_id', 'status (same slug)'),
  ('chats',              '80a58552-6647-44c9-9c95-69fe0a771e4b', 'da448dbc-d864-4476-960b-21789c4563fc',  'card.subtitle_field_id', 'phone (same slug)'),
  ('chats',              'eae19fba-a52a-4b47-8bac-2e7d87c2c8be', '2d61da65-5d85-4704-8def-a9bbf4f9be8d',  'card.title_field_id', 'name (same slug)'),
  ('clients',            '965d318b-3f1f-4095-a984-565b957277a8', 'e155516f-fd9c-46b4-83ce-c91ce378e916',  'card.badge_field_id', 'preferred_unit_type (same slug)'),
  ('clients',            '8ea1877b-4d3b-4423-8b67-607158bc0b3f', '924e006f-cbab-4cca-9805-bcd1325b5cf0',  'card.shown_field_ids[0]', 'client_id -> client_code'),
  ('clients',            '224049d8-7f33-4bed-87bb-11ed17aed3f4', '5b6dfcbf-1c66-4651-87b0-d4873e30f42e',  'card.subtitle_field_id', 'phone_number (same slug)'),
  ('clients',            'db72d355-0dfc-43f4-a1d4-7f0df74a7645', '03557660-d52a-4b21-b886-48b6b39a894b',  'card.title_field_id', 'client_name (same slug)'),
  ('copywriter_chats',   '1ea6e9aa-dcb6-4f7f-b28f-6b024f6ae392', '8afc4287-9c78-4710-b8c7-410a2e7608cd',  'card.badge_field_id', 'status (same slug)'),
  ('copywriter_chats',   '12e205b4-5f46-41c0-9593-da0a251c60aa', 'c8311b69-283b-4710-befb-76005386b8a6',  'card.subtitle_field_id', 'last_message_at (same slug)'),
  ('copywriter_chats',   'df7b207c-45af-4540-a6af-1e1e118382f4', '53df6173-4fa7-4321-9ae0-7c2eba196eec',  'card.title_field_id', 'title (same slug)'),
  ('data_migration',     '1753e59d-83bc-4537-be66-8d98b7c1db2e', 'c4acda7c-4036-4b5c-b081-0aea54719396',  'card.badge_field_id', 'status (same slug)'),
  ('data_migration',     'c5341877-b961-487e-af33-65b3c3e4f785', '27d5b28f-5d3e-4ba9-b846-0acceeaf4e32',  'card.title_field_id', 'title (same slug)'),
  ('decks',              'cef83943-aede-4d03-a3b2-3c9b4b85dc75', 'b34f1a3f-17c9-40b0-8c85-eaebb936f273',  'card.badge_field_id', 'status (same slug)'),
  ('decks',              'e59f0f56-b368-4e5e-a1b1-c3a0406f9ce9', '762869c4-836c-45c7-8ea0-335ef818585b',  'card.subtitle_field_id', 'brief (same slug)'),
  ('decks',              '0afb728b-9f63-4e67-88b3-522dda0713c8', 'c8619d7d-87bc-495f-8af8-54045a6f586c',  'card.title_field_id', 'title (same slug)'),
  ('followups',          '6fc45f7b-41fa-453b-afdb-fa574cea74cf', 'bf18b3a8-77ca-418d-b5a7-f36305f83aab',  'card.title_field_id', 'id not in any snapshot -> client_id'),
  ('image_chats',        '30c7ea15-967b-4746-8301-d2cd0a02c26b', '5c1d9240-080c-452d-9aa3-a38073dbe594',  'card.badge_field_id', 'status (same slug)'),
  ('image_chats',        'bf971353-8019-4297-aeee-3964dcc0dccf', '23d01940-4952-457c-9929-ef5cf0c8ebca',  'card.title_field_id', 'title (same slug)'),
  ('market_listings',    '571f7e53-5196-4e6d-bb4c-38eefc355b4f', NULL,                                    'card.shown_field_ids[2] + maps.popup_subtitle_field_id', 'district (dropped - field gone)'),
  ('market_listings',    '0f8847f7-b1b4-40a5-8272-b5dc31513c4b', NULL,                                    'card.shown_field_ids[4]', 'city (dropped - field gone)'),
  ('matching_chats',     '82e90ea7-b36f-4793-ad92-3caa715327b1', '4eb7880b-4ddd-4e64-97ae-dc57c7d19a8d',  'card.badge_field_id', 'status (same slug)'),
  ('matching_chats',     '8217068b-61fc-4c98-b40d-fac8e07f4c45', 'fedbef2e-217c-4bc2-9c16-1851d77656f7',  'card.subtitle_field_id', 'last_message_at (same slug)'),
  ('matching_chats',     'f3d990c7-3149-4a94-a410-50b4e89bd1c3', '62c89475-2c6a-4062-a1e6-676afbf849ab',  'card.title_field_id', 'title (same slug)'),
  ('phone_calls',        'da2c1393-84bb-45f9-adff-d203fe1df330', '22cac962-d39f-40a7-8240-7e3f58ab186c',  'card.badge_field_id', 'direction (same slug)'),
  ('phone_calls',        'be95c210-2935-454a-bef2-8265be22cdd2', 'b48e751a-5ca6-43a2-9106-b2ce0f9bf527',  'card.subtitle_field_id', 'status (same slug)'),
  ('phone_calls',        '258dd89f-eb5a-4785-bab3-74c4a7576322', '2f3c355f-1fe3-46c0-b06c-c9cf56f78717',  'card.title_field_id', 'customer_phone (same slug)'),
  ('reel_scripts',       'dea4030b-8058-4e54-a747-8127f5b019ea', 'cff3bf55-f013-48df-8a08-0a2e0921e372',  'card.badge_field_id', 'status (same slug)'),
  ('reel_scripts',       '9c44b405-fb8a-4e42-889f-04cb7921ac27', '4e961c73-ea25-42c3-a504-084e99f50eae',  'card.title_field_id', 'title (same slug)'),
  ('targeted_projects',  'a88ebe04-76b7-4316-9560-93a82199f640', 'dd6f3667-1adc-4b66-a764-ae68e3414aa1',  'card.badge_field_id', 'id not in any snapshot -> priority'),
  ('targeted_projects',  '98b841c9-93d9-474d-b101-9b38268e8fa6', '98d69d09-e4d5-4de9-b74b-b1b63310eeab',  'card.title_field_id', 'id not in any snapshot -> project_name');

-- ---------------------------------------------------------------------------
-- 3. Guard rails. Fail loudly rather than write a bad config.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  bad text;
BEGIN
  -- (a) every replacement id must exist in the LIVE schema of its model
  SELECT string_agg(format('%s -> %s', f.model_name, f.new_id), ', ')
    INTO bad
  FROM _display_ref_fix f
  WHERE f.new_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.models m,
           jsonb_array_elements(m.schema->'sections') s,
           jsonb_array_elements(s->'fields') fld
      WHERE m.name = f.model_name AND fld->>'id' = f.new_id
    );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'replacement field id not present in the live schema: %', bad;
  END IF;

  -- (b) every id we are replacing must in fact be dangling — never silently
  --     re-point a slot that is currently working
  SELECT string_agg(format('%s -> %s', f.model_name, f.old_id), ', ')
    INTO bad
  FROM _display_ref_fix f
  WHERE EXISTS (
      SELECT 1
      FROM public.models m,
           jsonb_array_elements(m.schema->'sections') s,
           jsonb_array_elements(s->'fields') fld
      WHERE m.name = f.model_name AND fld->>'id' = f.old_id
    );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to rewrite a LIVE field id: %', bad;
  END IF;

  -- (c) a badge slot only accepts dropdown / multiselect (CardBuilder.tsx:25)
  SELECT string_agg(format('%s badge -> %s', f.model_name, fld->>'type'), ', ')
    INTO bad
  FROM _display_ref_fix f
  JOIN public.models m ON m.name = f.model_name
  JOIN LATERAL jsonb_array_elements(m.schema->'sections') s ON true
  JOIN LATERAL jsonb_array_elements(s->'fields') fld ON true
  WHERE f.new_id IS NOT NULL
    AND fld->>'id' = f.new_id
    AND f.slots LIKE '%badge_field_id%'
    AND fld->>'type' NOT IN ('dropdown', 'multiselect');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'badge slot needs a dropdown/multiselect: %', bad;
  END IF;

  -- (d) never re-point a slot at a section_mirror CONTAINER. collectViewFields
  --     (src/lib/sectionMirrorExpand.ts) REPLACES a container with its virtual
  --     children, so the container's own id is absent from the id space every
  --     view resolves against — the slot would look repaired and still render
  --     nothing. A mirrored child is addressed as `<containerId>::<childSlug>`.
  SELECT string_agg(format('%s -> %s', f.model_name, fld->>'name'), ', ')
    INTO bad
  FROM _display_ref_fix f
  JOIN public.models m ON m.name = f.model_name
  JOIN LATERAL jsonb_array_elements(m.schema->'sections') s ON true
  JOIN LATERAL jsonb_array_elements(s->'fields') fld ON true
  WHERE f.new_id IS NOT NULL
    AND fld->>'id' = f.new_id
    AND fld->>'type' = 'section_mirror';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'cannot point a display slot at a section_mirror container: %', bad;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 4. Rewrite one config object (card_config or maps_config) for one model.
--    Only keys naming a field id are considered; a value is changed only when
--    it exactly equals a mapped dangling id. Arrays keep their order and lose
--    dropped entries; scalars become NULL when the field is gone.
--    pg_temp, so nothing persists beyond this session.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.repair_display_cfg(p_model text, p_cfg jsonb)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT COALESCE(jsonb_object_agg(e.key, CASE
    WHEN e.key NOT LIKE '%field_id' AND e.key NOT LIKE '%field_ids' THEN e.value

    WHEN jsonb_typeof(e.value) = 'array' THEN COALESCE((
      SELECT jsonb_agg(COALESCE(f.new_id, a.v) ORDER BY a.ord)
      FROM jsonb_array_elements_text(e.value) WITH ORDINALITY AS a(v, ord)
      LEFT JOIN _display_ref_fix f ON f.model_name = p_model AND f.old_id = a.v
      WHERE f.old_id IS NULL OR f.new_id IS NOT NULL
    ), '[]'::jsonb)

    WHEN jsonb_typeof(e.value) = 'string' THEN (
      SELECT CASE
               WHEN f.old_id IS NULL THEN e.value          -- not a dangling id
               WHEN f.new_id IS NULL THEN 'null'::jsonb    -- field is gone
               ELSE to_jsonb(f.new_id)                     -- re-pointed
             END
      FROM (SELECT 1) AS one
      LEFT JOIN _display_ref_fix f
        ON f.model_name = p_model AND f.old_id = (e.value #>> '{}')
    )

    ELSE e.value
  END), '{}'::jsonb)
  FROM jsonb_each(COALESCE(p_cfg, '{}'::jsonb)) AS e(key, value);
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Apply.
-- ---------------------------------------------------------------------------
UPDATE public.models m
SET card_config = pg_temp.repair_display_cfg(m.name, m.card_config),
    maps_config = pg_temp.repair_display_cfg(m.name, m.maps_config),
    updated_at  = now()
WHERE EXISTS (SELECT 1 FROM _display_ref_fix f WHERE f.model_name = m.name);

-- ---------------------------------------------------------------------------
-- 6. Verify: no dangling reference may remain in any model's display columns.
--    Covers the plural *_field_ids arrays that a `k LIKE '%field_id'` sweep
--    misses. A ref may also be a section_mirror virtual id of the form
--    `<containerId>::<childSlug>` (src/lib/sectionMirrorExpand.ts); the child
--    half is a SLUG on another model, so this check validates the container
--    half only — enough to catch the id-drift this migration repairs.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  leftover text;
BEGIN
  WITH refs AS (
    SELECT m.name, 'card.' || k AS slot, v AS ref
    FROM public.models m, LATERAL jsonb_each_text(COALESCE(m.card_config,'{}'::jsonb)) AS e(k, v)
    WHERE k LIKE '%field_id' AND v IS NOT NULL AND v <> ''
    UNION ALL
    SELECT m.name, 'card.shown_field_ids', v
    FROM public.models m,
         LATERAL jsonb_array_elements_text(COALESCE(m.card_config->'shown_field_ids','[]'::jsonb)) AS a(v)
    UNION ALL
    SELECT m.name, 'maps.' || k, v
    FROM public.models m, LATERAL jsonb_each_text(COALESCE(m.maps_config,'{}'::jsonb)) AS e(k, v)
    WHERE k LIKE '%field_id' AND v IS NOT NULL AND v <> ''
    UNION ALL
    SELECT m.name, 'maps.popup_shown_field_ids', v
    FROM public.models m,
         LATERAL jsonb_array_elements_text(COALESCE(m.maps_config->'popup_shown_field_ids','[]'::jsonb)) AS a(v)
  ), live AS (
    SELECT m.name, fld->>'id' AS fid
    FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') fld
  )
  SELECT string_agg(format('%s %s=%s', r.name, r.slot, r.ref), ', ')
    INTO leftover
  FROM refs r
  WHERE r.ref IS NOT NULL AND r.ref <> ''
    AND NOT EXISTS (
      SELECT 1 FROM live l
      WHERE l.name = r.name
        AND (l.fid = r.ref OR l.fid = split_part(r.ref, '::', 1))
    );

  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'dangling display references remain: %', leftover;
  END IF;
END
$verify$;

COMMIT;
