-- 2026-06-18: Create the "Matching Assistant" model (slug `matching_chats`).
--
-- Backs the Phase 1 Project Matching Assistant — a live-call sales co-pilot that
-- matches customer requirements against the project portfolio. Custom split-pane
-- chat UI (src/pages/Matching) backed by api/match. Each record is one matching
-- session; messages live inline in records.data.messages.
--
-- Created by explicit SQL (not left to the frontend seed-backfill) for a
-- deterministic, stable model id shared with src/data/seedModels.ts
-- (MATCHING_CHATS_MODEL_ID). This model carries NO lookup field, so it is NOT
-- exposed to the seed-backfill stale-lookup-id problem — but we still create it
-- here so the id is deterministic and the row exists even before the SPA boots.
--
-- Slug is `matching_chats` (NOT in RETIRED_SYSTEM_MODEL_NAMES). The UI finds the
-- model by NAME, so the id only matters for deterministic creation.
--
-- Unfrozen model: rows live as JSONB in `records`; reads go through the
-- `unified_records` view automatically. The `models_view_sync` trigger creates
-- the `v_matching_chats` typed view on insert. No freeze artifacts needed.
--
-- Idempotent: the WHERE NOT EXISTS guard makes re-runs (and a prior frontend
-- backfill) a no-op.

WITH ids AS (
  SELECT
    '7c0ffee2-5cab-4b0a-9d3e-12ab34cd56ef'::uuid AS model_id,
    gen_random_uuid() AS sec_base,
    gen_random_uuid() AS f_title,
    gen_random_uuid() AS f_status,
    gen_random_uuid() AS f_msg_count,
    gen_random_uuid() AS f_last_msg
)
INSERT INTO public.models (id, name, label_ar, label_en, icon, color, schema, card_config, maps_config, group_id, "order", is_system, is_hardcoded)
SELECT
  model_id, 'matching_chats', 'مساعد المطابقة', 'Matching Assistant', 'compass', '#B8734F',
  jsonb_build_object(
    'sections', jsonb_build_array(
      jsonb_build_object('id', sec_base, 'label_ar','معلومات المحادثة','label_en','Conversation','order',0,'is_base',true,'color','#B8734F','fields', jsonb_build_array(
        jsonb_build_object('id',f_title,'name','title','label_ar','العنوان','label_en','Title','type','text','required',false,'order',0,'section_id',sec_base,'width','full','show_in_table',true),
        jsonb_build_object('id',f_status,'name','status','label_ar','الحالة','label_en','Status','type','dropdown','required',false,'order',1,'section_id',sec_base,'width','third','show_in_table',true,'options', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid(),'label_ar','نشط','label_en','Active','value','active','color','#22c55e'),
          jsonb_build_object('id',gen_random_uuid(),'label_ar','مؤرشف','label_en','Archived','value','archived','color','#9ca3af')
        )),
        jsonb_build_object('id',f_msg_count,'name','message_count','label_ar','عدد الرسائل','label_en','Messages','type','number','required',false,'order',2,'section_id',sec_base,'width','third','show_in_table',true),
        jsonb_build_object('id',f_last_msg,'name','last_message_at','label_ar','آخر رسالة','label_en','Last Message','type','datetime','required',false,'order',3,'section_id',sec_base,'width','third','show_in_table',true)
      ))
    ),
    'section_selector_field_id', null
  ),
  jsonb_build_object('title_field_id', f_title, 'subtitle_field_id', f_last_msg, 'badge_field_id', f_status, 'shown_field_ids', '[]'::jsonb),
  jsonb_build_object('click_action','popup','default_zoom',null,'map_style_json',null,'default_center_lat',null,'default_center_lng',null,'pin_color_field_id',null,'pin_label_field_id',null,'manual_lat_field_id',null,'manual_lng_field_id',null,'popup_badge_field_id',null,'popup_title_field_id',null,'location_url_field_id',null,'popup_shown_field_ids','[]'::jsonb,'popup_subtitle_field_id',null),
  NULL, 0, true, false
FROM ids
WHERE NOT EXISTS (SELECT 1 FROM public.models WHERE name = 'matching_chats');
