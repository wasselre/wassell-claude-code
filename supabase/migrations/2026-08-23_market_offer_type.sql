-- Add `offer_type` (sale/rent) to the FROZEN market_listings model.
--
-- Aqar's listing.categoryName conflates property type + transaction ("شقق للبيع").
-- Going forward the adapter parses it into a CLEAN property_type ("شقة") and this
-- new offer_type (sale/rent). New scrapes only — no backfill of existing rows.
--
-- market_listings is frozen, so this both ALTERs the table AND updates models.schema,
-- then unwinds the unified_records view chain to regenerate the JSONB-shape view +
-- RLS policies (dependency graph re-derived 2026-08-23; see CLAUDE.md "Frozen models").

BEGIN;

-- 1. DDL: offer_type is a dropdown → text column (freeze field-type mapping).
ALTER TABLE public.market_listings ADD COLUMN IF NOT EXISTS offer_type text;

-- 2. Append offer_type to the الإعلان section (index 0) so the Builder renders it
--    (read-only, frozen) and market_listings_v knows about it.
UPDATE public.models
SET schema = jsonb_set(
  schema,
  '{sections,0,fields}',
  (schema->'sections'->0->'fields') || jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', 'offer_type',
    'label_ar', 'نوع العرض',
    'label_en', 'Offer type',
    'type', 'dropdown',
    'required', false,
    'order', 99,
    'section_id', '5c329ccb-4f5f-4304-a6bb-c277866f8cab',
    'width', 'half',
    'show_in_table', true,
    'options', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'sale', 'label_ar', 'بيع',   'label_en', 'Sale', 'color', '#3B82F6'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'rent', 'label_ar', 'إيجار', 'label_en', 'Rent', 'color', '#8E4E3A')
    )
  )
)
WHERE name = 'market_listings';

-- 3. Unwind the view chain: drop unified_records' dependents, then unified_records,
--    then regenerate the frozen artifacts (rebuilds market_listings_v + the 4 RLS
--    policies to include offer_type) and the unified_records UNION, then recreate
--    the dependents VERBATIM with their captured reloptions + grants.
-- The file_links_select RLS policy ALSO references unified_records — drop it too,
-- and recreate it verbatim after the rebuild.
DROP POLICY IF EXISTS file_links_select ON public.file_links;
DROP VIEW IF EXISTS public.v_market_properties;
DROP VIEW IF EXISTS public.v_our_projects_scope;
DROP VIEW IF EXISTS public.v_website_public;
DROP VIEW IF EXISTS public.unified_records;

SELECT public.regenerate_frozen_model_artifacts('8f06bc39-4bee-42e9-9fab-77023fb89ede');
SELECT public.rebuild_unified_records();

CREATE POLICY file_links_select ON public.file_links
FOR SELECT TO authenticated
USING (
  (( SELECT wassell_app_user_id(( SELECT auth.uid() AS uid)) AS wassell_app_user_id) IS NOT NULL)
  AND (
    ( SELECT wassell_is_admin(( SELECT auth.uid() AS uid)) AS wassell_is_admin)
    OR (uploaded_by_user_id = ( SELECT wassell_app_user_id(( SELECT auth.uid() AS uid)) AS wassell_app_user_id))
    OR (file_id IN ( SELECT g.file_id FROM wassell_my_granted_file_ids('view'::text) g(file_id)))
    OR (( SELECT wassell_mos_can('read'::text) AS wassell_mos_can) AND (file_id IN ( SELECT m.file_id FROM wassell_my_marketing_file_ids() m(file_id))))
    OR ((folder_id IS NOT NULL) AND (folder_id IN ( SELECT c.folder_id FROM wassell_my_cascade_folder_ids('view'::text) c(folder_id))))
    OR (( SELECT wassell_file_derived_access_enabled() AS wassell_file_derived_access_enabled) AND (confidentiality IS DISTINCT FROM 'restricted'::text) AND (file_id IN ( SELECT d.file_id FROM wassell_my_record_derived_file_ids() d(file_id))))
  )
  AND (EXISTS ( SELECT 1 FROM unified_records ur WHERE ((ur.id = file_links.record_id) AND (ur.model_id = file_links.model_id))))
);

-- 3a. v_market_properties — security_invoker=true; grants were postgres+service_role
--     ONLY (NO anon/authenticated), so revoke the default-granted anon/authenticated.
CREATE VIEW public.v_market_properties
WITH (security_invoker=true) AS
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

-- 3b. v_our_projects_scope — reloptions NULL (NOT security_invoker); default grants match.
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

-- 3c. v_website_public — security_invoker=false by design (two-key anon exposure).
CREATE VIEW public.v_website_public
WITH (security_invoker=false) AS
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

-- 4. Release offer_type through the publish gate so the adapter's writes go LIVE
--    (property_type is already released).
SELECT public.market_listing_publish_set('aqar', 'offer_type', 'released',
  'Sale/rent parsed from listing.categoryName by the adapter; released so it writes live.');

COMMIT;
