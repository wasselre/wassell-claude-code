-- ============================================================================
-- 2026-07-01: advertisers module — normalize REGA-scraped advertiser contacts
-- ----------------------------------------------------------------------------
-- A dedicated `advertisers` CRM model (one record per unique agent MOBILE — a
-- contact-level broker directory) that market_listings link to via a new
-- `advertiser` lookup. The REGA lookup worker upserts the advertiser (dedup by
-- phone) and links the listing, so the same broker isn't duplicated across their
-- many listings and you get a working call-list of brokers.
--
-- Fixed model id so the dedup index + upsert RPC can reference it as a literal.
-- ============================================================================

BEGIN;

-- ── 1. Create the advertisers model (guarded) + add the market_listings lookup ──
DO $$
DECLARE
  v_model uuid := 'a1b2c3d4-e5f6-4a7b-8c9d-000000000001';
  v_sec   uuid := gen_random_uuid();
  f_name uuid := gen_random_uuid(); f_phone uuid := gen_random_uuid();
  f_agent uuid := gen_random_uuid(); f_type uuid := gen_random_uuid();
  f_fal uuid := gen_random_uuid(); f_unified uuid := gen_random_uuid();
  f_source uuid := gen_random_uuid(); f_first uuid := gen_random_uuid();
  f_last uuid := gen_random_uuid(); f_notes uuid := gen_random_uuid();
  v_schema jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.models WHERE name = 'advertisers') THEN
    RETURN;
  END IF;

  v_schema := jsonb_build_object(
    'section_selector_field_id', NULL,
    'sections', jsonb_build_array(jsonb_build_object(
      'id', v_sec::text, 'label_ar','معلومات المعلن','label_en','Advertiser',
      'order',0,'is_base',true,'color','#B8734F',
      'fields', jsonb_build_array(
        jsonb_build_object('id',f_name::text,'name','name','type','text','label_ar','اسم المعلن','label_en','Advertiser','required',true,'order',0,'section_id',v_sec::text,'width','full','show_in_table',true),
        jsonb_build_object('id',f_phone::text,'name','phone','type','phone','label_ar','رقم الجوال','label_en','Mobile','required',false,'order',1,'section_id',v_sec::text,'width','half','show_in_table',true),
        jsonb_build_object('id',f_agent::text,'name','agent_name','type','text','label_ar','مسؤول الإعلان','label_en','Responsible agent','required',false,'order',2,'section_id',v_sec::text,'width','half','show_in_table',true),
        jsonb_build_object('id',f_type::text,'name','broker_type','type','dropdown','label_ar','نوع الوسيط','label_en','Broker type','required',false,'order',3,'section_id',v_sec::text,'width','half','show_in_table',false,
          'options', jsonb_build_array(
            jsonb_build_object('id',gen_random_uuid()::text,'label_ar','مكتب','label_en','Office','value','office','color','#8E4E3A'),
            jsonb_build_object('id',gen_random_uuid()::text,'label_ar','فرد','label_en','Individual','value','individual','color','#C09B5F'))),
        jsonb_build_object('id',f_fal::text,'name','fal_license','type','text','label_ar','رخصة فال','label_en','FAL license','required',false,'order',4,'section_id',v_sec::text,'width','half','show_in_table',false),
        jsonb_build_object('id',f_unified::text,'name','unified_number','type','text','label_ar','الرقم الموحد للمنشأة','label_en','Unified number','required',false,'order',5,'section_id',v_sec::text,'width','half','show_in_table',false),
        jsonb_build_object('id',f_source::text,'name','source','type','dropdown','label_ar','المصدر','label_en','Source','required',false,'order',6,'section_id',v_sec::text,'width','half','show_in_table',false,
          'options', jsonb_build_array(
            jsonb_build_object('id',gen_random_uuid()::text,'label_ar','الهيئة العامة للعقار','label_en','REGA','value','rega','color','#B8734F'),
            jsonb_build_object('id',gen_random_uuid()::text,'label_ar','يدوي','label_en','Manual','value','manual','color','#4A4E54'))),
        jsonb_build_object('id',f_first::text,'name','first_seen','type','datetime','label_ar','أول ظهور','label_en','First seen','required',false,'order',7,'section_id',v_sec::text,'width','half','show_in_table',false),
        jsonb_build_object('id',f_last::text,'name','last_seen','type','datetime','label_ar','آخر ظهور','label_en','Last seen','required',false,'order',8,'section_id',v_sec::text,'width','half','show_in_table',false),
        jsonb_build_object('id',f_notes::text,'name','notes','type','notes','label_ar','ملاحظات','label_en','Notes','required',false,'order',9,'section_id',v_sec::text,'width','full','show_in_table',false)
      )
    ))
  );

  INSERT INTO public.models (id,name,label_ar,label_en,icon,color,"order",group_id,is_system,is_hardcoded,table_name,card_config,schema)
  VALUES (v_model,'advertisers','المعلنون','Advertisers','contact','#B8734F',51,NULL,false,false,NULL,
    jsonb_build_object('title_field_id',f_name::text,'subtitle_field_id',f_phone::text,'badge_field_id',f_type::text,
      'shown_field_ids',jsonb_build_array(f_name::text,f_phone::text,f_agent::text,f_fal::text)),
    v_schema);

  -- Append the `advertiser` lookup to the market_listings Advertiser section.
  UPDATE public.models SET schema = jsonb_set(schema, '{sections}', (
    SELECT jsonb_agg(CASE WHEN s->>'id'='a487cb9e-6c81-48be-9efb-6fd6f4bc4147'
      THEN jsonb_set(s, '{fields}', (s->'fields') || jsonb_build_object(
        'id',gen_random_uuid()::text,'name','advertiser','type','lookup',
        'label_ar','بطاقة المعلن','label_en','Advertiser record','required',false,'order',2,
        'section_id','a487cb9e-6c81-48be-9efb-6fd6f4bc4147','width','full','is_multi',false,
        'show_in_table',false,'lookup_model_id',v_model::text,'lookup_display_field','name'))
      ELSE s END)
    FROM jsonb_array_elements(schema->'sections') s))
  WHERE name='market_listings'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(schema->'sections') s,
                    jsonb_array_elements(s->'fields') f WHERE f->>'name'='advertiser');
END $$;

-- ── 2. Dedup: one advertiser record per phone. ──────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS advertisers_phone_unique_idx
  ON public.records ((data->>'phone'))
  WHERE model_id = 'a1b2c3d4-e5f6-4a7b-8c9d-000000000001';

-- ── 3. Upsert RPC (dedup by phone, race-safe). ──────────────────────────────
CREATE OR REPLACE FUNCTION public.rega_upsert_advertiser(
  p_name text, p_phone text, p_agent text, p_fal text,
  p_unified text, p_broker_type text, p_created_by uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_model uuid := 'a1b2c3d4-e5f6-4a7b-8c9d-000000000001';
  v_id uuid;
  v_patch jsonb;
BEGIN
  IF p_phone IS NULL OR p_phone = '' THEN RETURN NULL; END IF;
  v_patch := jsonb_strip_nulls(jsonb_build_object(
    'name', p_name, 'agent_name', p_agent, 'fal_license', p_fal,
    'unified_number', p_unified, 'broker_type', p_broker_type,
    'source', 'rega', 'last_seen', now()));

  SELECT id INTO v_id FROM public.records
   WHERE model_id = v_model AND data->>'phone' = p_phone LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE public.records SET data = data || v_patch, updated_at = now() WHERE id = v_id;
    RETURN v_id;
  END IF;

  BEGIN
    v_id := gen_random_uuid();
    INSERT INTO public.records (id, model_id, data, created_by_user_id)
    VALUES (v_id, v_model,
      v_patch || jsonb_build_object('phone', p_phone, 'first_seen', now()), p_created_by);
    RETURN v_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race — an advertiser with this phone was just created; merge into it.
    SELECT id INTO v_id FROM public.records
     WHERE model_id = v_model AND data->>'phone' = p_phone LIMIT 1;
    UPDATE public.records SET data = data || v_patch, updated_at = now() WHERE id = v_id;
    RETURN v_id;
  END;
END $$;
REVOKE ALL ON FUNCTION public.rega_upsert_advertiser(text,text,text,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rega_upsert_advertiser(text,text,text,text,text,text,uuid) TO service_role;

-- ── 4. Backfill existing 'done' listings into advertiser records + link. ────
DO $$
DECLARE r record; v_adv uuid;
BEGIN
  FOR r IN
    SELECT id, created_by_user_id, data FROM public.records
     WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'
       AND COALESCE(data->>'rega_lookup_status','') = 'done'
       AND NULLIF(data->>'advertiser_phone','') IS NOT NULL
  LOOP
    v_adv := public.rega_upsert_advertiser(
      r.data->>'advertiser_name', r.data->>'advertiser_phone', r.data->>'rega_agent_name',
      r.data->>'rega_fal_license', NULL, NULL, r.created_by_user_id);
    IF v_adv IS NOT NULL THEN
      UPDATE public.records SET data = data || jsonb_build_object('advertiser', v_adv::text), updated_at = now()
       WHERE id = r.id AND COALESCE(data->>'advertiser','') <> v_adv::text;
    END IF;
  END LOOP;
END $$;

-- ── 5. Surface the lookup in the market_listings slim store (list view). ────
CREATE OR REPLACE VIEW public.market_listings_summary
WITH (security_invoker = true) AS
SELECT
  id, model_id, created_by_user_id, created_at, updated_at,
  jsonb_build_object(
    'external_id', data->'external_id', 'source', data->'source', 'title', data->'title',
    'listing_type', data->'listing_type', 'category', data->'category', 'property_type', data->'property_type',
    'price', data->'price', 'price_per_m2', data->'price_per_m2', 'area', data->'area',
    'bedrooms', data->'bedrooms', 'bathrooms', data->'bathrooms',
    'location', data->'location',
    'latitude', data->'latitude', 'longitude', data->'longitude',
    'is_active', data->'is_active', 'main_image_url', data->'main_image_url',
    'advertiser_name', data->'advertiser_name', 'image_count', data->'image_count', 'video_count', data->'video_count',
    'advertiser_phone', data->'advertiser_phone',
    'rega_lookup_status', data->'rega_lookup_status',
    'rega_lookup_error', data->'rega_lookup_error',
    'rega_lookup_at', data->'rega_lookup_at',
    'advertiser', data->'advertiser'
  ) AS data
FROM public.records
WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';
GRANT SELECT ON public.market_listings_summary TO authenticated;

COMMIT;
