-- 2026-06-21: Location intelligence foundation for the Sales Assistant.
--
-- Adds coordinate fields to all_projects and backfills them WITHOUT any network
-- calls (pure SQL): (1) extract inline lat/lng from project_location map links
-- (~300 projects), then (2) cascade district centroids — computed from those
-- coordinate-bearing projects — to same-district projects that still lack coords
-- (covers ~71 districts). The remaining projects keep district/city TEXT matching
-- only (geo_source absent).
--
-- all_projects is UNFROZEN (JSONB in `records`), so this only edits models.schema
-- (so the Builder + v_all_projects see the fields) and writes values into
-- records.data — no DDL on a physical table. The models_view_sync trigger
-- regenerates v_all_projects on the schema change; the records_fill_project_rollups
-- BEFORE trigger appends rollups on each row write (different keys — no conflict).
--
-- Idempotent: the field-append is guarded by "latitude not already present"; the
-- coord backfills only fill rows whose latitude is still empty.

-- 1. Add latitude / longitude / geo_source / geo_confidence to the Geographic
--    Information section.
DO $$
DECLARE
  v_model_id uuid;
  v_geo_section_id text := '9e8fc144-d3ae-4b62-bf1c-831b152c58ac';
  v_sec_idx int;
BEGIN
  SELECT id INTO v_model_id FROM public.models WHERE name = 'all_projects';
  IF v_model_id IS NULL THEN RETURN; END IF;

  -- already added?
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(
             (SELECT schema->'sections' FROM public.models WHERE id = v_model_id)) sec,
           jsonb_array_elements(sec->'fields') f
    WHERE f->>'name' = 'latitude'
  ) THEN
    RETURN;
  END IF;

  -- locate the Geographic Information section's 0-based index (robust to reorder)
  SELECT (ord - 1) INTO v_sec_idx
  FROM public.models m,
       jsonb_array_elements(m.schema->'sections') WITH ORDINALITY t(s, ord)
  WHERE m.id = v_model_id AND s->>'id' = v_geo_section_id;
  IF v_sec_idx IS NULL THEN v_sec_idx := 1; END IF; -- fallback: Geographic was idx 1

  UPDATE public.models
  SET schema = jsonb_set(
    schema,
    ARRAY['sections', v_sec_idx::text, 'fields'],
    (schema->'sections'->v_sec_idx->'fields') || jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'name','latitude','label_ar','خط العرض','label_en','Latitude','type','number','required',false,'order',20,'section_id',v_geo_section_id,'width','half','show_in_table',false),
      jsonb_build_object('id',gen_random_uuid()::text,'name','longitude','label_ar','خط الطول','label_en','Longitude','type','number','required',false,'order',21,'section_id',v_geo_section_id,'width','half','show_in_table',false),
      jsonb_build_object('id',gen_random_uuid()::text,'name','geo_source','label_ar','مصدر الإحداثيات','label_en','Geo Source','type','dropdown','required',false,'order',22,'section_id',v_geo_section_id,'width','half','show_in_table',false,'options',jsonb_build_array(
        jsonb_build_object('id',gen_random_uuid()::text,'label_ar','من رابط الخريطة','label_en','From map link','value','inline_link','color','#22c55e'),
        jsonb_build_object('id',gen_random_uuid()::text,'label_ar','مركز الحي','label_en','District centroid','value','district_centroid','color','#eab308'),
        jsonb_build_object('id',gen_random_uuid()::text,'label_ar','يدوي','label_en','Manual','value','manual','color','#3b82f6')
      )),
      jsonb_build_object('id',gen_random_uuid()::text,'name','geo_confidence','label_ar','دقة الموقع','label_en','Geo Confidence','type','dropdown','required',false,'order',23,'section_id',v_geo_section_id,'width','half','show_in_table',false,'options',jsonb_build_array(
        jsonb_build_object('id',gen_random_uuid()::text,'label_ar','عالية','label_en','High','value','high','color','#22c55e'),
        jsonb_build_object('id',gen_random_uuid()::text,'label_ar','متوسطة','label_en','Medium','value','medium','color','#eab308'),
        jsonb_build_object('id',gen_random_uuid()::text,'label_ar','منخفضة','label_en','Low','value','low','color','#ef4444')
      ))
    )
  )
  WHERE id = v_model_id;
END $$;

-- 2. Backfill inline coordinates parsed from project_location (KSA-bounded).
WITH ap AS (
  SELECT r.id, r.data->>'project_location' AS loc
  FROM public.records r
  WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'all_projects')
    AND coalesce(r.data->>'project_location','') <> ''
), parsed AS (
  SELECT id,
    coalesce(
      regexp_match(loc, '!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)'),
      regexp_match(loc, '@(-?\d+\.\d+),(-?\d+\.\d+)'),
      regexp_match(loc, '[?&](?:q|ll|query)=(-?\d+\.\d+),(-?\d+\.\d+)'),
      regexp_match(loc, '^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$')
    ) AS m
  FROM ap
), good AS (
  SELECT id, (m[1])::numeric AS lat, (m[2])::numeric AS lng
  FROM parsed
  WHERE m IS NOT NULL
    AND (m[1])::numeric BETWEEN 16 AND 33   -- KSA latitude
    AND (m[2])::numeric BETWEEN 34 AND 56   -- KSA longitude
)
UPDATE public.records r
SET data = r.data || jsonb_build_object(
  'latitude', g.lat, 'longitude', g.lng,
  'geo_source', 'inline_link', 'geo_confidence', 'high')
FROM good g
WHERE r.id = g.id;

-- 3. District centroids → cascade to same-district projects lacking coords.
WITH ap AS (
  SELECT r.id,
         nullif(trim(r.data->>'preferred_neighborhoods'),'') AS district,
         (r.data->>'latitude')::numeric  AS lat,
         (r.data->>'longitude')::numeric AS lng
  FROM public.records r
  WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'all_projects')
), centroids AS (
  SELECT district, round(avg(lat),6) AS clat, round(avg(lng),6) AS clng
  FROM ap
  WHERE lat IS NOT NULL AND district IS NOT NULL
  GROUP BY district
)
UPDATE public.records r
SET data = r.data || jsonb_build_object(
  'latitude', c.clat, 'longitude', c.clng,
  'geo_source', 'district_centroid', 'geo_confidence', 'medium')
FROM centroids c
WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'all_projects')
  AND nullif(trim(r.data->>'preferred_neighborhoods'),'') = c.district
  AND coalesce(r.data->>'latitude','') = '';
