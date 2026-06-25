// Generates the SQL that creates the Regions + Cities records-models, extends the
// existing Districts model with relational lookups, organizes them under a Geography
// group, and grants view on all three to every profile. Deterministic fixed IDs.
import fs from 'node:fs';

const REGIONS = 'd15a0001-0000-4000-8000-000000000001';
const CITIES  = 'd15a0001-0000-4000-8000-000000000002';
const DISTRICTS = 'd9a9db7e-b602-470c-b81b-5d6ff17048e9';
const GEO_GROUP = 'd15a0001-9700-4000-8000-000000000000';
const SEC_REGION = 'd15a0001-5ec0-4000-8000-000000000001';
const SEC_CITY   = 'd15a0001-5ec0-4000-8000-000000000002';
const DIST_SEC   = 'e3c29e6e-823b-4bda-870f-c169f3db6c97'; // existing districts section id

const f = (id, name, type, label_en, label_ar, extra = {}) => ({
  id, name, type, label_en, label_ar,
  required: !!extra.required, order: extra.order ?? 0,
  width: extra.width || 'half', section_id: extra.section_id,
  show_in_table: extra.show_in_table ?? false,
  ...(type === 'lookup' ? { lookup_model_id: extra.lookup_model_id, lookup_display_field: extra.lookup_display_field, is_multi: !!extra.is_multi } : {}),
  ...(type === 'dropdown' && extra.options ? { options: extra.options } : {}),
});

// --- Regions fields ---
const regionFields = [
  f('d15a0001-f1d0-4000-8001-000000000001','name_ar','text','Name (AR)','الاسم (عربي)',{required:true,order:0,show_in_table:true,section_id:SEC_REGION}),
  f('d15a0001-f1d0-4000-8001-000000000002','name_en','text','Name (EN)','الاسم (إنجليزي)',{required:true,order:1,show_in_table:true,section_id:SEC_REGION}),
  f('d15a0001-f1d0-4000-8001-000000000003','spl_region_id','text','SPL Region ID','معرف المنطقة (SPL)',{order:2,show_in_table:true,section_id:SEC_REGION}),
  f('d15a0001-f1d0-4000-8001-000000000004','country_code','text','Country Code','رمز الدولة',{order:3,section_id:SEC_REGION}),
  f('d15a0001-f1d0-4000-8001-000000000005','source','text','Source','المصدر',{order:4,section_id:SEC_REGION}),
  f('d15a0001-f1d0-4000-8001-000000000006','source_updated_at','datetime','Source Updated','تاريخ تحديث المصدر',{order:5,section_id:SEC_REGION}),
  f('d15a0001-f1d0-4000-8001-000000000007','is_active','checkbox','Active','نشط',{order:6,section_id:SEC_REGION}),
];
// --- Cities fields ---
const cityFields = [
  f('d15a0001-f1d0-4000-8002-000000000001','name_ar','text','Name (AR)','الاسم (عربي)',{required:true,order:0,show_in_table:true,section_id:SEC_CITY}),
  f('d15a0001-f1d0-4000-8002-000000000002','name_en','text','Name (EN)','الاسم (إنجليزي)',{required:true,order:1,show_in_table:true,section_id:SEC_CITY}),
  f('d15a0001-f1d0-4000-8002-000000000003','display_name','text','Display Name','الاسم المعروض',{order:2,show_in_table:true,section_id:SEC_CITY,width:'full'}),
  f('d15a0001-f1d0-4000-8002-000000000004','spl_city_id','text','SPL City ID','معرف المدينة (SPL)',{order:3,show_in_table:true,section_id:SEC_CITY}),
  f('d15a0001-f1d0-4000-8002-000000000005','region_lookup','lookup','Region','المنطقة',{order:4,section_id:SEC_CITY,lookup_model_id:REGIONS,lookup_display_field:'name_ar',is_multi:false,show_in_table:true}),
  f('d15a0001-f1d0-4000-8002-000000000006','region_name_ar','text','Region Name (AR)','اسم المنطقة (عربي)',{order:5,section_id:SEC_CITY}),
  f('d15a0001-f1d0-4000-8002-000000000007','region_name_en','text','Region Name (EN)','اسم المنطقة (إنجليزي)',{order:6,section_id:SEC_CITY}),
  f('d15a0001-f1d0-4000-8002-000000000008','source','text','Source','المصدر',{order:7,section_id:SEC_CITY}),
  f('d15a0001-f1d0-4000-8002-000000000009','source_updated_at','datetime','Source Updated','تاريخ تحديث المصدر',{order:8,section_id:SEC_CITY}),
  f('d15a0001-f1d0-4000-8002-00000000000a','has_districts','checkbox','Has Districts','يحتوي على أحياء',{order:9,section_id:SEC_CITY}),
  f('d15a0001-f1d0-4000-8002-00000000000b','is_active','checkbox','Active','نشط',{order:10,section_id:SEC_CITY}),
];
// --- New Districts fields (appended; existing fields preserved) ---
const distNewFields = [
  f('d15a0001-f1d0-4000-8003-000000000001','spl_district_id','text','SPL District ID','معرف الحي (SPL)',{order:20,show_in_table:true,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-000000000002','display_name','text','Display Name','الاسم المعروض',{order:21,show_in_table:true,section_id:DIST_SEC,width:'full'}),
  f('d15a0001-f1d0-4000-8003-000000000003','city_lookup','lookup','City','المدينة',{order:22,section_id:DIST_SEC,lookup_model_id:CITIES,lookup_display_field:'display_name',is_multi:false,show_in_table:true}),
  f('d15a0001-f1d0-4000-8003-000000000004','city_id','text','City ID','معرف المدينة',{order:23,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-000000000005','city_name_ar','text','City Name (AR)','اسم المدينة (عربي)',{order:24,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-000000000006','city_name_en','text','City Name (EN)','اسم المدينة (إنجليزي)',{order:25,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-000000000007','region_lookup','lookup','Region','المنطقة',{order:26,section_id:DIST_SEC,lookup_model_id:REGIONS,lookup_display_field:'name_ar',is_multi:false}),
  f('d15a0001-f1d0-4000-8003-000000000008','region_id','text','Region ID','معرف المنطقة',{order:27,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-000000000009','region_name_ar','text','Region Name (AR)','اسم المنطقة (عربي)',{order:28,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-00000000000a','region_name_en','text','Region Name (EN)','اسم المنطقة (إنجليزي)',{order:29,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-00000000000b','centroid_lat','number','Centroid Latitude','خط العرض (المركز)',{order:30,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-00000000000c','centroid_lng','number','Centroid Longitude','خط الطول (المركز)',{order:31,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-00000000000d','source','text','Source','المصدر',{order:32,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-00000000000e','source_updated_at','datetime','Source Updated','تاريخ تحديث المصدر',{order:33,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-00000000000f','is_active','checkbox','Active','نشط',{order:34,section_id:DIST_SEC}),
  f('d15a0001-f1d0-4000-8003-000000000010','legacy_status','dropdown','Legacy Status','حالة الترحيل',{order:35,section_id:DIST_SEC,options:[
    {id:'d15a0001-0b7-0001',value:'matched',label_en:'Matched',label_ar:'مطابق',color:'#22c55e'},
    {id:'d15a0001-0b7-0002',value:'legacy_only',label_en:'Legacy only',label_ar:'قديم فقط',color:'#eab308'},
    {id:'d15a0001-0b7-0003',value:'needs_review',label_en:'Needs review',label_ar:'يحتاج مراجعة',color:'#ef4444'},
  ]}),
  f('d15a0001-f1d0-4000-8003-000000000011','migration_notes','textarea','Migration Notes','ملاحظات الترحيل',{order:36,section_id:DIST_SEC,width:'full'}),
];

const regionSchema = { sections:[{ id:SEC_REGION, color:'#8E4E3A', order:0, is_base:true, label_ar:'معلومات المنطقة', label_en:'Region Info', fields:regionFields }], duplicate_check_field_id:'d15a0001-f1d0-4000-8001-000000000003', section_selector_field_id:null };
const citySchema   = { sections:[{ id:SEC_CITY,   color:'#8E4E3A', order:0, is_base:true, label_ar:'معلومات المدينة', label_en:'City Info', fields:cityFields }], duplicate_check_field_id:'d15a0001-f1d0-4000-8002-000000000004', section_selector_field_id:null };

const q = (s) => `'${String(s).replace(/'/g,"''")}'`;
const jb = (o) => `'${JSON.stringify(o).replace(/'/g,"''")}'::jsonb`;

let sql = `-- AUTO-GENERATED by scripts/geo-migration/02-gen-models-sql.mjs\nBEGIN;\n\n`;
sql += `-- Geography model group\nINSERT INTO public.model_groups (id, label_ar, label_en, "order") VALUES (${q(GEO_GROUP)}, 'الجغرافيا', 'Geography', 6)\nON CONFLICT (id) DO UPDATE SET label_ar=EXCLUDED.label_ar, label_en=EXCLUDED.label_en;\n\n`;

sql += `-- Regions model\nINSERT INTO public.models (id, name, label_ar, label_en, icon, color, schema, card_config, group_id, is_system, "order")\nVALUES (${q(REGIONS)}, 'regions', 'المناطق', 'Regions', 'map', '#8E4E3A', ${jb(regionSchema)}, ${jb({title_field_id:'d15a0001-f1d0-4000-8001-000000000001',shown_field_ids:['d15a0001-f1d0-4000-8001-000000000002']})}, ${q(GEO_GROUP)}, false, 0)\nON CONFLICT (id) DO UPDATE SET schema=EXCLUDED.schema, card_config=EXCLUDED.card_config, group_id=EXCLUDED.group_id;\n\n`;

sql += `-- Cities model\nINSERT INTO public.models (id, name, label_ar, label_en, icon, color, schema, card_config, group_id, is_system, "order")\nVALUES (${q(CITIES)}, 'cities', 'المدن', 'Cities', 'building-2', '#8E4E3A', ${jb(citySchema)}, ${jb({title_field_id:'d15a0001-f1d0-4000-8002-000000000003',shown_field_ids:['d15a0001-f1d0-4000-8002-000000000006']})}, ${q(GEO_GROUP)}, false, 1)\nON CONFLICT (id) DO UPDATE SET schema=EXCLUDED.schema, card_config=EXCLUDED.card_config, group_id=EXCLUDED.group_id;\n\n`;

// Districts: (1) fix mislabeled 'city' field label_en, (2) append new relational fields,
// move into group, set card title to display_name. Two clean statements.
sql += `-- Districts step 1: fix the mislabeled 'city' field (label_en was "Region")\nUPDATE public.models\nSET schema = jsonb_set(schema, '{sections,0,fields}', (\n      SELECT jsonb_agg(CASE WHEN fld->>'name'='city' THEN jsonb_set(fld,'{label_en}','\"City\"'::jsonb) ELSE fld END)\n      FROM jsonb_array_elements(schema->'sections'->0->'fields') fld\n    ))\nWHERE id = ${q(DISTRICTS)};\n\n`;
sql += `-- Districts step 2: append relational fields, move to Geography group, card title = display_name\nUPDATE public.models\nSET schema = jsonb_set(schema, '{sections,0,fields}', (schema->'sections'->0->'fields') || ${jb(distNewFields)}),\n    card_config = jsonb_set(card_config, '{title_field_id}', '\"d15a0001-f1d0-4000-8003-000000000002\"'::jsonb),\n    group_id = ${q(GEO_GROUP)}, "order" = 2\nWHERE id = ${q(DISTRICTS)};\n\n`;

// Permissions: grant 'view' (scope all) on the three geography models to every profile that lacks it.
const grant = (mid) => `-- grant view on ${mid}\nUPDATE public.profiles p SET model_permissions =\n  COALESCE(p.model_permissions,'[]'::jsonb) || ${jb([{model_id:mid,permissions:['view'],view_scope:{mode:'all',conditions:[]},edit_scope:{mode:'all',conditions:[]}}])}\nWHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.model_permissions,'[]'::jsonb)) mp WHERE mp->>'model_id' = ${q(mid)});\n\n`;
sql += grant(REGIONS) + grant(CITIES) + grant(DISTRICTS);

sql += `COMMIT;\n`;
fs.writeFileSync(process.argv[2] || 'scripts/geo-migration/_out_models.sql', sql);
console.log(sql);
