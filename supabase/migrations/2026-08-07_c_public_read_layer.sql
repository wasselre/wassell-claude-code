-- ============================================================================
-- Public project pages redesign — W1: safe allowlisted public read layer.
--
-- SECURITY DEFINER RPCs granted to anon that return fully-resolved, structured,
-- ALLOWLISTED public DTOs. Internal fields (internal_sales_notes, source_*,
-- ai_audit_notes, data_sources, project_analysis, geo_confidence, developer
-- notes/email, unit source_*/developer_id, …) are simply never SELECTed — the
-- allowlist is the set of keys these functions emit, in ONE auditable place.
--
-- Signed media stays in service-role edge functions; these RPCs return file-id
-- refs (resolved to durable URLs by the website's authorized image route).
--
-- Additive. Does NOT revoke the older raw anon grant (that is W9, after every
-- consumer is migrated + verified).
-- ============================================================================

-- ── model-id helpers (tiny, cached) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public._pub_model_id(p_name text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.models WHERE name = p_name LIMIT 1;
$fn$;

-- ── country code → localized name ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._pub_country(p_code text, p_lang text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE upper(coalesce(p_code,''))
    WHEN 'SA' THEN CASE WHEN p_lang='en' THEN 'Saudi Arabia'          ELSE 'المملكة العربية السعودية' END
    WHEN 'AE' THEN CASE WHEN p_lang='en' THEN 'United Arab Emirates'  ELSE 'الإمارات العربية المتحدة' END
    WHEN 'KW' THEN CASE WHEN p_lang='en' THEN 'Kuwait'                ELSE 'الكويت' END
    WHEN 'QA' THEN CASE WHEN p_lang='en' THEN 'Qatar'                 ELSE 'قطر' END
    WHEN 'BH' THEN CASE WHEN p_lang='en' THEN 'Bahrain'               ELSE 'البحرين' END
    WHEN 'OM' THEN CASE WHEN p_lang='en' THEN 'Oman'                  ELSE 'عُمان' END
    WHEN 'EG' THEN CASE WHEN p_lang='en' THEN 'Egypt'                 ELSE 'مصر' END
    ELSE NULL   -- unknown code → no fabricated country (never defaults to Saudi)
  END;
$fn$;

-- ── translation-variant resolver (mirrors v_website_public semantics) ─────
-- Returns the requested language's value for a record field: a generation-valid
-- target-language translation variant if present, else the source value when it
-- is already in that language, else the raw source (never null for a name).
CREATE OR REPLACE FUNCTION public._pub_localized_text(
  p_entity uuid, p_field text, p_lang text, p_src text
) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_variant text;
  v_is_ar boolean := p_src ~ '[؀-ۿ]';
BEGIN
  IF to_regclass('public.translation_variants') IS NOT NULL THEN
    SELECT v.display_text INTO v_variant
    FROM public.translation_variants v
    JOIN public.translation_units u USING (resource_kind, entity_id, field_path)
    WHERE v.resource_kind='record' AND v.entity_id=p_entity AND v.field_path=p_field
      AND v.lang=p_lang AND v.role='target' AND v.state IN ('translated','approved')
      AND v.generation = u.generation
    LIMIT 1;
  END IF;
  IF v_variant IS NOT NULL AND btrim(v_variant) <> '' THEN
    RETURN v_variant;
  END IF;
  -- No valid translation → use source if it matches the requested language.
  IF (p_lang='ar' AND v_is_ar) OR (p_lang='en' AND NOT v_is_ar) THEN
    RETURN p_src;
  END IF;
  RETURN p_src;  -- last-resort fallback: never null a name/label
END;
$fn$;

-- ── dropdown/multiselect option → {value,label,color} in requested lang ───
CREATE OR REPLACE FUNCTION public._pub_opt(
  p_model text, p_field text, p_value text, p_lang text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_opt jsonb;
BEGIN
  IF p_value IS NULL OR btrim(p_value)='' THEN RETURN NULL; END IF;
  SELECT o INTO v_opt
  FROM public.models m,
       jsonb_array_elements(m.schema->'sections') s,
       jsonb_array_elements(s->'fields') f,
       jsonb_array_elements(COALESCE(f->'options','[]'::jsonb)) o
  WHERE m.name = p_model AND f->>'name' = p_field AND o->>'value' = p_value
  LIMIT 1;
  IF v_opt IS NULL THEN
    RETURN jsonb_build_object('value', p_value, 'label', p_value, 'color', NULL);
  END IF;
  RETURN jsonb_build_object(
    'value', p_value,
    'label', COALESCE(NULLIF(v_opt->>(CASE WHEN p_lang='en' THEN 'label_en' ELSE 'label_ar' END),''),
                      v_opt->>'label_en', v_opt->>'label_ar', p_value),
    'color', v_opt->>'color'
  );
END;
$fn$;

-- Map an array (or scalar) of option values → array of localized labels (deduped, order-preserving).
CREATE OR REPLACE FUNCTION public._pub_opt_labels(
  p_model text, p_field text, p_values jsonb, p_lang text
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH vals AS (
    SELECT DISTINCT ON (val) val, ord FROM (
      SELECT value AS val, ordinality AS ord
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p_values)='array' THEN p_values
             WHEN p_values IS NULL OR p_values='null'::jsonb THEN '[]'::jsonb
             ELSE jsonb_build_array(p_values) END
      ) WITH ORDINALITY
      WHERE btrim(value) <> ''
    ) q ORDER BY val, ord
  )
  SELECT COALESCE(jsonb_agg((public._pub_opt(p_model,p_field,val,p_lang))->>'label' ORDER BY ord), '[]'::jsonb)
  FROM vals;
$fn$;

-- ── geography resolution (one-hop from the district record) ──────────────
CREATE OR REPLACE FUNCTION public._pub_geo(p_location jsonb, p_lang text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_did text := NULLIF(p_location->>'district','');
  v_cid text := NULLIF(p_location->>'city','');
  v_rid text := NULLIF(p_location->>'region','');
  v_district text; v_city text; v_region text; v_code text;
  r record;
BEGIN
  IF v_did IS NOT NULL AND to_regclass('public.districts') IS NOT NULL THEN
    SELECT name_ar,name_en,city_name_ar,city_name_en,region_name_ar,region_name_en,country_code
      INTO r FROM public.districts WHERE id::text = v_did LIMIT 1;
    IF FOUND THEN
      v_district := CASE WHEN p_lang='en' THEN COALESCE(NULLIF(r.name_en,''),r.name_ar) ELSE COALESCE(NULLIF(r.name_ar,''),r.name_en) END;
      v_city     := CASE WHEN p_lang='en' THEN COALESCE(NULLIF(r.city_name_en,''),r.city_name_ar) ELSE COALESCE(NULLIF(r.city_name_ar,''),r.city_name_en) END;
      v_region   := CASE WHEN p_lang='en' THEN COALESCE(NULLIF(r.region_name_en,''),r.region_name_ar) ELSE COALESCE(NULLIF(r.region_name_ar,''),r.region_name_en) END;
      v_code     := r.country_code;
    END IF;
  END IF;

  IF v_city IS NULL AND v_cid IS NOT NULL AND to_regclass('public.cities') IS NOT NULL THEN
    SELECT name_ar,name_en,region_name_ar,region_name_en,country_code INTO r
      FROM public.cities WHERE id::text = v_cid LIMIT 1;
    IF FOUND THEN
      v_city := CASE WHEN p_lang='en' THEN COALESCE(NULLIF(r.name_en,''),r.name_ar) ELSE COALESCE(NULLIF(r.name_ar,''),r.name_en) END;
      v_region := COALESCE(v_region, CASE WHEN p_lang='en' THEN NULLIF(r.region_name_en,'') ELSE NULLIF(r.region_name_ar,'') END);
      v_code := COALESCE(v_code, r.country_code);
    END IF;
  END IF;

  IF v_region IS NULL AND v_rid IS NOT NULL AND to_regclass('public.regions') IS NOT NULL THEN
    SELECT name_ar,name_en,country_code INTO r
      FROM public.regions WHERE id::text = v_rid LIMIT 1;
    IF FOUND THEN
      v_region := CASE WHEN p_lang='en' THEN COALESCE(NULLIF(r.name_en,''),r.name_ar) ELSE COALESCE(NULLIF(r.name_ar,''),r.name_en) END;
      v_code := COALESCE(v_code, r.country_code);
    END IF;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'district', v_district,
    'city', v_city,
    'region', v_region,
    'country_code', v_code,
    'country', public._pub_country(v_code, p_lang)
  ));
END;
$fn$;

-- ── {min,max} range normalizer ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._pub_range(p jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN p IS NULL OR p='null'::jsonb THEN NULL
    WHEN (p->>'min') IS NULL AND (p->>'max') IS NULL THEN NULL
    ELSE jsonb_build_object('min', p->'min', 'max', p->'max')
  END;
$fn$;

-- ==========================================================================
-- get_public_project(p_id, p_lang) — one project's full allowlisted DTO.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_public_project(p_id uuid, p_lang text DEFAULT 'ar')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_ap   uuid := public._pub_model_id('all_projects');
  v_pd   uuid := public._pub_model_id('project_details');
  v_dev  uuid := public._pub_model_id('developers');
  v_ss   uuid := public._pub_model_id('site_settings');
  d      jsonb;   -- all_projects data
  sc     jsonb;   -- project_details sidecar data (or null)
  dv     jsonb;   -- developer data (or null)
  ss     jsonb;   -- site_settings data (or null)
  ai_ar  record;  -- ai content requested lang
  v_lang text := CASE WHEN lower(coalesce(p_lang,'ar'))='en' THEN 'en' ELSE 'ar' END;
  v_name text;
  v_geo  jsonb;
  v_lat  numeric; v_lng numeric;
  v_hero text; v_overview text; v_seo text; v_highlights jsonb; v_ed_src text;
  v_features jsonb; v_landmarks jsonb;
  v_hero_img text; v_gallery jsonb;
  v_contact jsonb;
  v_brochure jsonb;
  v_show jsonb;
  v_native jsonb;
BEGIN
  SELECT data INTO d FROM public.records
   WHERE id = p_id AND model_id = v_ap
     AND COALESCE((data->>'is_public')::boolean,false) = true;
  IF d IS NULL THEN RETURN NULL; END IF;   -- not public / not found

  SELECT data INTO sc FROM public.records
   WHERE model_id = v_pd AND data->>'project_id' = p_id::text LIMIT 1;

  IF NULLIF(d->>'developer','') IS NOT NULL THEN
    SELECT data INTO dv FROM public.records WHERE id = (d->>'developer')::uuid AND model_id = v_dev LIMIT 1;
  END IF;

  SELECT data INTO ss FROM public.records WHERE model_id = v_ss LIMIT 1;

  SELECT hero_description, overview, highlights, seo_description
    INTO ai_ar
    FROM public.project_public_content
   WHERE project_id = p_id AND lang = v_lang AND validation_status = 'valid';

  -- localized name
  v_name := public._pub_localized_text(p_id, 'project_name', v_lang, d->>'project_name');

  -- geography + coords (project coords only; NO Riyadh / centroid fallback)
  v_geo := public._pub_geo(d->'location', v_lang);
  v_lat := public.try_numeric(d->>'latitude');
  v_lng := public.try_numeric(d->>'longitude');

  -- editorial precedence: manual (sidecar) → AI (valid) → deterministic
  v_hero := COALESCE(
    NULLIF(btrim(sc->>'hero_short_description'),''),
    NULLIF(btrim(ai_ar.hero_description),''),
    NULL);   -- deterministic hero built client-side from facts when null
  v_overview := COALESCE(
    NULLIF(btrim(sc->>'description'),''),
    NULLIF(btrim(ai_ar.overview),''),
    NULLIF(btrim(d->>'marketing_document'),''));
  v_highlights := COALESCE(
    CASE WHEN jsonb_typeof(ai_ar.highlights)='array' AND jsonb_array_length(ai_ar.highlights)>0 THEN ai_ar.highlights END,
    '[]'::jsonb);
  v_seo := COALESCE(NULLIF(btrim(ai_ar.seo_description),''), NULL);
  v_ed_src := CASE
    WHEN NULLIF(btrim(sc->>'hero_short_description'),'') IS NOT NULL OR NULLIF(btrim(sc->>'description'),'') IS NOT NULL THEN 'manual'
    WHEN ai_ar.hero_description IS NOT NULL OR ai_ar.overview IS NOT NULL THEN 'ai'
    ELSE 'deterministic' END;

  -- features (factual table on all_projects) → [{feature, keywords}]; sidecar features override if present
  v_features := COALESCE(
    CASE WHEN jsonb_typeof(sc->'features')='array' AND jsonb_array_length(sc->'features')>0 THEN
      (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
         'title', x->>'title', 'description', x->>'description')))
       FROM jsonb_array_elements(sc->'features') x
       WHERE btrim(COALESCE(x->>'title',''))<>'') END,
    CASE WHEN jsonb_typeof(d->'features')='array' THEN
      (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
         'title', x->>'feature', 'description', NULLIF(x->>'keywords',''))))
       FROM jsonb_array_elements(d->'features') x
       WHERE btrim(COALESCE(x->>'feature',''))<>'') END,
    '[]'::jsonb);

  -- landmarks FAIL-CLOSED: only when provenance is curated/verified.
  -- Source: sidecar landmarks (landmarks_source curated/verified) OR all_projects
  -- nearby_landmarks when all_projects landmarks_source is curated/verified.
  -- Distance/duration only when non-empty; never fabricated.
  v_landmarks := '[]'::jsonb;
  IF (sc->>'landmarks_source') IN ('curated','verified') AND jsonb_typeof(sc->'landmarks')='array' THEN
    SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'name', x->>'name', 'distance', NULLIF(btrim(x->>'distance'),''))))
      ,'[]'::jsonb) INTO v_landmarks
    FROM jsonb_array_elements(sc->'landmarks') x WHERE btrim(COALESCE(x->>'name',''))<>'';
  ELSIF (d->>'landmarks_source') IN ('curated','verified') AND jsonb_typeof(d->'nearby_landmarks')='array' THEN
    SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'name', x->>'landmark',
        'type', NULLIF(btrim(x->>'property_type'),''),
        'distance', NULLIF(btrim(x->>'distance'),''),
        'duration', NULLIF(btrim(x->>'duration'),''))))
      ,'[]'::jsonb) INTO v_landmarks
    FROM jsonb_array_elements(d->'nearby_landmarks') x WHERE btrim(COALESCE(x->>'landmark',''))<>'';
  END IF;

  -- media: hero = sidecar override → main_image → first gallery image;
  -- gallery = all_projects.project_images (full set) else sidecar gallery_image_1..8
  v_gallery := CASE
    WHEN jsonb_typeof(d->'project_images')='array' AND jsonb_array_length(d->'project_images')>0 THEN d->'project_images'
    ELSE (
      SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM (
        SELECT NULLIF(btrim(sc->>('gallery_image_'||n)),'') AS v
        FROM generate_series(1,8) n
      ) g WHERE v IS NOT NULL)
  END;
  v_hero_img := COALESCE(
    NULLIF(btrim(sc->>'hero_image_url'),''),
    NULLIF(btrim(d->>'main_image'),''),
    (v_gallery->>0));

  -- brochure: Wassel brochure_link preferred → developer brochure (labelled)
  v_brochure := CASE
    WHEN NULLIF(btrim(d->>'brochure_link'),'') IS NOT NULL THEN jsonb_build_object('url', d->>'brochure_link', 'source','wassel')
    WHEN NULLIF(btrim(sc->>'brochure_pdf_url'),'') IS NOT NULL THEN jsonb_build_object('url', sc->>'brochure_pdf_url', 'source','wassel')
    WHEN NULLIF(btrim(d->>'broucher_developer'),'') IS NOT NULL THEN jsonb_build_object('url', d->>'broucher_developer', 'source','developer')
    ELSE NULL END;

  -- contact: genuinely-configured sidecar agent → else company contact (site_settings)
  IF NULLIF(btrim(sc->>'agent_name'),'') IS NOT NULL
     AND (NULLIF(btrim(sc->>'agent_phone'),'') IS NOT NULL OR NULLIF(btrim(sc->>'agent_whatsapp'),'') IS NOT NULL) THEN
    v_contact := jsonb_strip_nulls(jsonb_build_object(
      'mode','agent',
      'name', sc->>'agent_name', 'title', NULLIF(sc->>'agent_title',''),
      'phone', NULLIF(sc->>'agent_phone',''), 'whatsapp', NULLIF(sc->>'agent_whatsapp',''),
      'image', NULLIF(sc->>'agent_image_url','')));
  ELSE
    v_contact := jsonb_strip_nulls(jsonb_build_object(
      'mode','company',
      'phone', NULLIF(ss->>'contact_phone',''),
      'whatsapp', COALESCE(NULLIF(ss->>'whatsapp_phone',''), NULLIF(ss->>'contact_phone','')),
      'email', NULLIF(ss->>'contact_email','')));
  END IF;

  -- visibility toggles (respect explicit hide controls; default show)
  v_show := jsonb_build_object(
    'gallery',  COALESCE((sc->>'show_gallery')::boolean, true),
    'features', COALESCE((sc->>'show_features')::boolean, true),
    'map',      COALESCE((sc->>'show_map')::boolean, true),
    'brochure', COALESCE((sc->>'show_brochure')::boolean, true),
    'units',    COALESCE((sc->>'show_units')::boolean, true),
    'form',     COALESCE((sc->>'show_form')::boolean, true),
    'agent',    COALESCE((sc->>'show_agent')::boolean, true));

  v_native := public._pub_range(d->'available_native_price_range');

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'id', p_id,
    'lang', v_lang,
    'name', v_name,
    'developer', CASE WHEN dv IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
        'name', public._pub_localized_text((d->>'developer')::uuid,'name',v_lang,dv->>'name'),
        'website', NULLIF(btrim(dv->>'website'),''))) ELSE NULL END,
    'project_status', public._pub_opt('all_projects','project_status', d->>'project_status', v_lang),
    'construction_status', public._pub_opt('all_projects','construction_status', d->>'construction_status', v_lang),
    'handover_date', NULLIF(btrim(d->>'handover_date'),''),
    'last_verified_at', NULLIF(btrim(d->>'last_verified_at'),''),
    'location', (v_geo || jsonb_strip_nulls(jsonb_build_object(
        'lat', v_lat, 'lng', v_lng,
        'maps_url', NULLIF(btrim(d->>'project_location'),''),
        'has_map', (v_lat IS NOT NULL AND v_lng IS NOT NULL)))),
    'accent_color', NULLIF(sc->>'accent_color',''),
    'facts', jsonb_strip_nulls(jsonb_build_object(
        'available_units', public.try_numeric(d->>'available_units'),
        'unit_count', public.try_numeric(d->>'unit_count'),
        'sold_units', public.try_numeric(d->>'sold_units'),
        'reserved_units', public.try_numeric(d->>'reserved_units'),
        'unit_types', public._pub_opt_labels('all_projects','unit_types', d->'unit_types', v_lang),
        'available_price_range', public._pub_range(d->'available_price_range'),
        'available_area_range', public._pub_range(d->'available_area_range'),
        'available_native_price_range', v_native,
        'native_currency', CASE WHEN v_native IS NOT NULL THEN NULLIF(d->>'developer_currency','') END,
        'bedroom_range', public._pub_range(d->'bedroom_range'),
        'bathroom_range', public._pub_range(d->'bathroom_range'))),
    'payment', jsonb_strip_nulls(jsonb_build_object(
        'summary', NULLIF(btrim(d->>'payment_plan_summary'),''),
        'down_payment_percent', public.try_numeric(d->>'down_payment_percent'),
        'during_construction_percent', public.try_numeric(d->>'during_construction_percent'),
        'on_handover_percent', public.try_numeric(d->>'on_handover_percent'),
        'post_handover_months', public.try_numeric(d->>'post_handover_months'),
        'schedule', CASE WHEN jsonb_typeof(d->'payment_plan_schedule')='array'
                          AND jsonb_array_length(d->'payment_plan_schedule')>0
                     THEN d->'payment_plan_schedule' ELSE NULL END)),
    'amenities', public._pub_opt_labels('all_projects','preferred_amenities', d->'preferred_amenities', v_lang),
    'features', v_features,
    'services', CASE WHEN jsonb_typeof(d->'services')='array' THEN
        (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('service', x->>'service', 'notes', NULLIF(x->>'notes',''))))
         FROM jsonb_array_elements(d->'services') x WHERE btrim(COALESCE(x->>'service',''))<>'') ELSE '[]'::jsonb END,
    'guarantees', CASE WHEN jsonb_typeof(d->'guarantees')='array' THEN d->'guarantees' ELSE '[]'::jsonb END,
    'landmarks', v_landmarks,
    'media', jsonb_build_object('hero', v_hero_img, 'gallery', COALESCE(v_gallery,'[]'::jsonb)),
    'brochure', v_brochure,
    'editorial', jsonb_strip_nulls(jsonb_build_object(
        'hero', v_hero, 'overview', v_overview, 'highlights', v_highlights,
        'seo', v_seo, 'source', v_ed_src)),
    'contact', v_contact,
    'show', v_show
  ));
END;
$fn$;

-- ==========================================================================
-- list_public_projects(p_lang) — listing-card DTO for every public project.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.list_public_projects(p_lang text DEFAULT 'ar')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_ap uuid := public._pub_model_id('all_projects');
  v_dev uuid := public._pub_model_id('developers');
  v_lang text := CASE WHEN lower(coalesce(p_lang,'ar'))='en' THEN 'en' ELSE 'ar' END;
  v_out jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(card ORDER BY card->>'name'), '[]'::jsonb) INTO v_out FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'id', r.id,
      'name', public._pub_localized_text(r.id,'project_name',v_lang, r.data->>'project_name'),
      'developer', (SELECT public._pub_localized_text((r.data->>'developer')::uuid,'name',v_lang, dv.data->>'name')
                    FROM public.records dv WHERE dv.id = NULLIF(r.data->>'developer','')::uuid AND dv.model_id=v_dev),
      'location', public._pub_geo(r.data->'location', v_lang),
      'project_status', public._pub_opt('all_projects','project_status', r.data->>'project_status', v_lang),
      'hero', COALESCE(NULLIF(btrim(r.data->>'main_image'),''), (r.data->'project_images'->>0)),
      'available_price_range', public._pub_range(r.data->'available_price_range'),
      'available_units', public.try_numeric(r.data->>'available_units'),
      'unit_count', public.try_numeric(r.data->>'unit_count'),
      'lat', public.try_numeric(r.data->>'latitude'),
      'lng', public.try_numeric(r.data->>'longitude')
    )) AS card
    FROM public.records r
    WHERE r.model_id = v_ap AND COALESCE((r.data->>'is_public')::boolean,false) = true
  ) q;
  RETURN v_out;
END;
$fn$;

-- ==========================================================================
-- list_public_project_points(p_lang) — lightweight map markers only.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.list_public_project_points(p_lang text DEFAULT 'ar')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_ap uuid := public._pub_model_id('all_projects');
  v_lang text := CASE WHEN lower(coalesce(p_lang,'ar'))='en' THEN 'en' ELSE 'ar' END;
  v_out jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(pt), '[]'::jsonb) INTO v_out FROM (
    SELECT jsonb_build_object(
      'id', r.id,
      'name', public._pub_localized_text(r.id,'project_name',v_lang, r.data->>'project_name'),
      'lat', public.try_numeric(r.data->>'latitude'),
      'lng', public.try_numeric(r.data->>'longitude'),
      'status', (public._pub_opt('all_projects','project_status', r.data->>'project_status', v_lang))->>'label'
    ) AS pt
    FROM public.records r
    WHERE r.model_id = v_ap AND COALESCE((r.data->>'is_public')::boolean,false) = true
      AND public.try_numeric(r.data->>'latitude') IS NOT NULL
      AND public.try_numeric(r.data->>'longitude') IS NOT NULL
  ) q;
  RETURN v_out;
END;
$fn$;

-- ==========================================================================
-- get_public_site_settings() — allowlisted public site settings.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_public_site_settings()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_ss uuid := public._pub_model_id('site_settings');
  d jsonb;
  v_out jsonb := '{}'::jsonb;
  k text;
BEGIN
  SELECT data INTO d FROM public.records WHERE model_id = v_ss LIMIT 1;
  IF d IS NULL THEN RETURN '{}'::jsonb; END IF;
  -- all pd_* page-template text keys
  FOR k IN SELECT jsonb_object_keys(d) LOOP
    IF k LIKE 'pd_%' THEN
      v_out := v_out || jsonb_build_object(k, d->k);
    END IF;
  END LOOP;
  -- explicit company-contact allowlist
  v_out := v_out || jsonb_strip_nulls(jsonb_build_object(
    'contact_phone', NULLIF(d->>'contact_phone',''),
    'whatsapp_phone', NULLIF(d->>'whatsapp_phone',''),
    'contact_email', NULLIF(d->>'contact_email',''),
    'address_ar', NULLIF(d->>'address_ar',''),
    'address_en', NULLIF(d->>'address_en',''),
    'hours_ar', NULLIF(d->>'hours_ar',''),
    'hours_weekend', NULLIF(d->>'hours_weekend',''),
    'linkedin_url', NULLIF(d->>'linkedin_url',''),
    'tiktok_url', NULLIF(d->>'tiktok_url',''),
    'instagram_url', NULLIF(d->>'instagram_url','')));
  RETURN v_out;
END;
$fn$;

-- ── grants ────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.get_public_project(uuid, text)          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_public_projects(text)              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_public_project_points(text)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_site_settings()              TO anon, authenticated;
-- helper functions are SECURITY DEFINER and only reachable via the RPCs above,
-- but grant execute so the RPCs can call them under the anon role context.
GRANT EXECUTE ON FUNCTION public._pub_model_id(text)                     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pub_country(text, text)                TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pub_localized_text(uuid, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pub_opt(text, text, text, text)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pub_opt_labels(text, text, jsonb, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pub_geo(jsonb, text)                   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pub_range(jsonb)                       TO anon, authenticated;
