-- market_listings: on-demand English translation (title_en / description_en)
--
-- CONTEXT: market_listings is FROZEN (physical table, model
--   8f06bc39-4bee-42e9-9fab-77023fb89ede, ~318k rows). Today the model carries
--   `title`/`description` (Arabic source, from the Aqar scrape) plus
--   `title_ar`/`description_ar` (REDUNDANT Arabic duplicates — `description_ar`-
--   only rows = 0; nothing unique lives there). There is NO English column.
--
-- OPERATOR DECISION (2026-09-08): collapse to ONE Arabic field in the form and
--   add English that is generated ON DEMAND, per-listing, only when the operator
--   explicitly asks — NOT the eager auto-translation pipeline (which is built on
--   the `records` table and cannot run on a frozen model anyway). So this
--   migration does NOT add market_listings to the durable capture/twin pipeline.
--   It adds two persisted English columns + a targeted write RPC; a server
--   endpoint + a form button drive the on-demand fill.
--
-- WHY COLUMNS (not custom_data overflow): `custom_data` is load-bearing here —
--   7,290 rows hold `image_mirror_map` (the photo mirror), `real_external_id`,
--   `claude_extract_test`. `freeze_apply_row`'s overflow block REBUILDS
--   custom_data from only the declared overflow fields on the next form save, so
--   an overflow field would silently wipe image_mirror_map. Physical columns
--   avoid that entirely (freeze_apply_row leaves custom_data untouched when no
--   overflow field exists).
--
-- Follows CLAUDE.md "Unwinding the view chain" for a frozen-model schema change.
--   Live dependency graph re-derived 2026-09-08:
--     market_listings   <- market_listings_summary, market_listings_v, v_market_listings
--     market_listings_v <- unified_records
--     unified_records   <- v_market_properties, v_our_projects_scope, v_website_public
--                          AND RLS policy file_links_select on file_links
--   Only the market_listings_v -> unified_records -> {3 views} + policy chain must
--   be unwound: adding a COLUMN to the base table does not disturb the direct
--   dependents (market_listings_summary / v_market_listings), and
--   regenerate_frozen_model_artifacts only drops/recreates <name>_v.

BEGIN;

-- 1. DDL: additive nullable columns (metadata-only; no table rewrite).
ALTER TABLE public.market_listings
  ADD COLUMN IF NOT EXISTS title_en       text,
  ADD COLUMN IF NOT EXISTS description_en text;

-- 2. JSONB schema: add title_en/description_en as READ-ONLY column-storage
--    fields (so market_listings_v exposes them and the form renders them,
--    non-editable), and HIDE the redundant title_ar/description_ar duplicates
--    from the form (new `hidden` flag, honored by SectionBlock). The columns
--    stay; only the form inputs disappear -> "one field, not two".
UPDATE public.models m
SET schema = jsonb_set(
  m.schema,
  '{sections}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN sec->>'id' = '5c329ccb-4f5f-4304-a6bb-c277866f8cab' THEN
          jsonb_set(
            sec,
            '{fields}',
            (
              SELECT jsonb_agg(
                CASE WHEN elem->>'name' IN ('title_ar','description_ar')
                     THEN elem || '{"hidden": true}'::jsonb
                     ELSE elem END
                ORDER BY ford
              )
              FROM jsonb_array_elements(sec->'fields') WITH ORDINALITY AS f(elem, ford)
            )
            || jsonb_build_array(
                 jsonb_build_object(
                   'id', gen_random_uuid()::text, 'name', 'title_en', 'type', 'text',
                   'order', 53, 'width', 'full',
                   'label_ar', 'العنوان (إنجليزي)', 'label_en', 'Title (EN)',
                   'required', false, 'read_only', true,
                   'section_id', '5c329ccb-4f5f-4304-a6bb-c277866f8cab', 'show_in_table', false
                 ),
                 jsonb_build_object(
                   'id', gen_random_uuid()::text, 'name', 'description_en', 'type', 'textarea',
                   'order', 54, 'width', 'full',
                   'label_ar', 'الوصف (إنجليزي)', 'label_en', 'Description (EN)',
                   'required', false, 'read_only', true,
                   'section_id', '5c329ccb-4f5f-4304-a6bb-c277866f8cab', 'show_in_table', false
                 )
               )
          )
        ELSE sec
      END
      ORDER BY sord
    )
    FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS s(sec, sord)
  )
)
WHERE m.name = 'market_listings';

-- 3. Unwind the view chain (plain drops; recreated in reverse below). Capture
--    the policy first is unnecessary — recreated verbatim in step 7.
DROP POLICY IF EXISTS file_links_select ON public.file_links;
DROP VIEW   IF EXISTS public.v_website_public;
DROP VIEW   IF EXISTS public.v_market_properties;
DROP VIEW   IF EXISTS public.v_our_projects_scope;
DROP VIEW   IF EXISTS public.unified_records;

-- 4. Regenerate market_listings_v (now with title_en/description_en) + the four
--    frozen_* RLS policies on market_listings.
SELECT public.regenerate_frozen_model_artifacts('8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid);

-- 5. Rebuild the unified_records UNION across all frozen models.
SELECT public.rebuild_unified_records();

-- 6. Recreate the three dependent views verbatim, restoring reloptions + grants
--    exactly (CLAUDE.md rule #2/#3):
--      v_market_properties  security_invoker=true, postgres/service_role only
--      v_our_projects_scope DEFINER (reloptions null), anon+authenticated
--      v_website_public     security_invoker=false, anon (two-key public surface)
CREATE VIEW public.v_market_properties WITH (security_invoker=true) AS
 WITH ml AS (
         SELECT ur.id,
            ur.data,
            COALESCE(NULLIF(ur.data ->> 'dupe_group_id'::text, ''::text), ur.id::text) AS group_id,
            ur.data ->> 'dupe_role'::text AS role
           FROM unified_records ur
          WHERE ur.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid AND COALESCE(try_boolean(ur.data ->> 'is_active'::text), true)
        ), grp AS (
         SELECT ml_1.group_id,
            count(*) AS ad_count,
            array_agg(DISTINCT ml_1.data ->> 'source'::text) AS sources,
            min(try_numeric(ml_1.data ->> 'price'::text)) AS min_price,
            max(try_numeric(ml_1.data ->> 'price'::text)) AS max_price
           FROM ml ml_1
          GROUP BY ml_1.group_id
        )
 SELECT DISTINCT ON (ml.group_id) ml.group_id AS dupe_group_id,
    ml.id AS canonical_record_id,
    grp.ad_count,
    grp.sources,
    array_length(grp.sources, 1) > 1 AS cross_platform,
    grp.min_price,
    grp.max_price,
    ml.data
   FROM ml
     JOIN grp USING (group_id)
  ORDER BY ml.group_id, (ml.role = 'canonical'::text) DESC, (try_boolean(ml.data ->> 'is_verified'::text)) DESC NULLS LAST, (COALESCE(try_numeric(ml.data ->> 'image_count'::text), 0::numeric)) DESC;
REVOKE ALL ON public.v_market_properties FROM anon, authenticated;
GRANT SELECT ON public.v_market_properties TO service_role;

CREATE VIEW public.v_our_projects_scope AS
 SELECT op.id AS our_project_id,
    ap.id AS project_id,
    ap.data ->> 'project_name'::text AS project_name_ar,
    ap.data ->> 'project_name_en'::text AS project_name_en,
    NULLIF(ap.data ->> 'developer'::text, ''::text)::uuid AS developer_record_id,
    dev.data ->> 'name'::text AS developer_name,
    ap.data ->> 'city_name'::text AS city,
    ap.data ->> 'project_location'::text AS location_text,
    ap.data ->> 'project_page_url'::text AS project_page_url,
    ap.data ->> 'brochure_link'::text AS brochure_url,
    ap.data ->> 'project_status'::text AS project_status,
    ap.data ->> 'project_id'::text AS external_project_id,
    op.data ->> 'portfolio_status'::text AS portfolio_status,
    op.data ->> 'sales_priority'::text AS sales_priority,
    (op.data ->> 'show_on_website'::text)::boolean AS show_on_website,
    op.created_at AS scoped_since,
    dev.data ->> 'website'::text AS developer_website,
    dev.data ->> 'phone'::text AS developer_phone
   FROM unified_records op
     JOIN unified_records ap ON ap.id = NULLIF(op.data ->> 'project'::text, ''::text)::uuid AND ap.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'::uuid
     LEFT JOIN unified_records dev ON dev.id = NULLIF(ap.data ->> 'developer'::text, ''::text)::uuid AND dev.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'::uuid
  WHERE op.model_id = '6609286a-f95a-45db-94e6-48cfa915ccbd'::uuid;
GRANT SELECT ON public.v_our_projects_scope TO anon, authenticated, service_role;

CREATE VIEW public.v_website_public WITH (security_invoker=false) AS
 SELECT ur.id AS record_id,
    ur.model_id,
    w.field_path,
    ur.data ->> w.field_path AS value_source,
        CASE
            WHEN 'ar'::text = ANY (w.langs) THEN COALESCE(( SELECT v.display_text
               FROM translation_variants v
                 JOIN translation_units u USING (resource_kind, entity_id, field_path)
              WHERE v.resource_kind = 'record'::text AND v.entity_id = ur.id AND v.field_path = w.field_path AND v.lang = 'ar'::text AND v.role = 'target'::text AND (v.state = ANY (ARRAY['translated'::text, 'approved'::text])) AND v.generation = u.generation),
            CASE
                WHEN (ur.data ->> w.field_path) ~ '[؀-ۿ]'::text THEN ur.data ->> w.field_path
                ELSE NULL::text
            END)
            ELSE NULL::text
        END AS value_ar,
        CASE
            WHEN 'en'::text = ANY (w.langs) THEN COALESCE(( SELECT v.display_text
               FROM translation_variants v
                 JOIN translation_units u USING (resource_kind, entity_id, field_path)
              WHERE v.resource_kind = 'record'::text AND v.entity_id = ur.id AND v.field_path = w.field_path AND v.lang = 'en'::text AND v.role = 'target'::text AND (v.state = ANY (ARRAY['translated'::text, 'approved'::text])) AND v.generation = u.generation),
            CASE
                WHEN (ur.data ->> w.field_path) !~ '[؀-ۿ]'::text THEN ur.data ->> w.field_path
                ELSE NULL::text
            END)
            ELSE NULL::text
        END AS value_en
   FROM unified_records ur
     JOIN website_publish_fields w ON w.resource_kind = 'record'::text AND w.scope_id = ur.model_id
  WHERE COALESCE((ur.data ->> 'is_public'::text)::boolean, false) = true;
GRANT SELECT ON public.v_website_public TO anon, authenticated, service_role;

-- 7. Recreate the file_links_select RLS policy verbatim.
CREATE POLICY file_links_select ON public.file_links FOR SELECT TO authenticated
USING (
  (( SELECT wassell_app_user_id(( SELECT auth.uid() AS uid)) AS wassell_app_user_id) IS NOT NULL)
  AND (( SELECT wassell_is_admin(( SELECT auth.uid() AS uid)) AS wassell_is_admin)
       OR (uploaded_by_user_id = ( SELECT wassell_app_user_id(( SELECT auth.uid() AS uid)) AS wassell_app_user_id))
       OR (file_id IN ( SELECT g.file_id FROM wassell_my_granted_file_ids('view'::text) g(file_id)))
       OR (( SELECT wassell_mos_can('read'::text) AS wassell_mos_can) AND (file_id IN ( SELECT m.file_id FROM wassell_my_marketing_file_ids() m(file_id))))
       OR ((folder_id IS NOT NULL) AND (folder_id IN ( SELECT c.folder_id FROM wassell_my_cascade_folder_ids('view'::text) c(folder_id))))
       OR (( SELECT wassell_file_derived_access_enabled() AS wassell_file_derived_access_enabled) AND (confidentiality IS DISTINCT FROM 'restricted'::text) AND (file_id IN ( SELECT d.file_id FROM wassell_my_record_derived_file_ids() d(file_id)))))
  AND (EXISTS ( SELECT 1 FROM unified_records ur WHERE ((ur.id = file_links.record_id) AND (ur.model_id = file_links.model_id))))
);

-- 8. Targeted on-demand write RPC. Single row-locked UPDATE of ONLY the two
--    English columns (never whole-data record_save) so it can never clobber a
--    concurrent scanner merge on the same row (same posture as
--    listing_mirror_map_patch / clean_text_entry_patch). Non-empty inputs only;
--    passing null/'' for a side keeps the existing value. Service-role only.
CREATE OR REPLACE FUNCTION public.market_listing_set_translation(
  p_id uuid, p_title_en text, p_description_en text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $fn$
BEGIN
  UPDATE public.market_listings
  SET title_en       = COALESCE(NULLIF(btrim(p_title_en), ''), title_en),
      description_en  = COALESCE(NULLIF(btrim(p_description_en), ''), description_en)
  WHERE id = p_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.market_listing_set_translation(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_listing_set_translation(uuid, text, text) TO service_role;

COMMIT;
