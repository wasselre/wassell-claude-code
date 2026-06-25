// Applies geography model creation/extension via PostgREST (service role).
// Idempotent. Mirrors supabase/migrations/2026-06-25_geography_models.sql.
//   node scripts/geo-migration/03-apply-models.mjs
import fs from 'node:fs';

const ENV = fs.readFileSync('C:/Users/rayan/Claude/wassell-claude-code/.env.local','utf8');
const get = (k) => (ENV.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1]?.trim().replace(/\r$/,'').replace(/^["']|["']$/g,'');
const URL = get('VITE_SUPABASE_URL'); const KEY = get('SUPABASE_SERVICE_ROLE_KEY');
if (!URL || !KEY) throw new Error('missing env');
const H = { apikey:KEY, Authorization:'Bearer '+KEY, 'Content-Type':'application/json' };

const REGIONS='d15a0001-0000-4000-8000-000000000001', CITIES='d15a0001-0000-4000-8000-000000000002';
const DISTRICTS='d9a9db7e-b602-470c-b81b-5d6ff17048e9', GEO_GROUP='d15a0001-9700-4000-8000-000000000000';
const SEC_REGION='d15a0001-5ec0-4000-8000-000000000001', SEC_CITY='d15a0001-5ec0-4000-8000-000000000002';
const DIST_SEC='e3c29e6e-823b-4bda-870f-c169f3db6c97';

const f=(id,name,type,le,la,x={})=>({id,name,type,label_en:le,label_ar:la,required:!!x.required,order:x.order??0,width:x.width||'half',section_id:x.section_id,show_in_table:x.show_in_table??false,...(type==='lookup'?{lookup_model_id:x.lookup_model_id,lookup_display_field:x.lookup_display_field,is_multi:!!x.is_multi}:{}),...(x.options?{options:x.options}:{})});

const regionFields=[
 f('d15a0001-f1d0-4000-8001-000000000001','name_ar','text','Name (AR)','الاسم (عربي)',{required:true,order:0,show_in_table:true,section_id:SEC_REGION}),
 f('d15a0001-f1d0-4000-8001-000000000002','name_en','text','Name (EN)','الاسم (إنجليزي)',{required:true,order:1,show_in_table:true,section_id:SEC_REGION}),
 f('d15a0001-f1d0-4000-8001-000000000003','spl_region_id','text','SPL Region ID','معرف المنطقة (SPL)',{order:2,show_in_table:true,section_id:SEC_REGION}),
 f('d15a0001-f1d0-4000-8001-000000000004','country_code','text','Country Code','رمز الدولة',{order:3,section_id:SEC_REGION}),
 f('d15a0001-f1d0-4000-8001-000000000005','source','text','Source','المصدر',{order:4,section_id:SEC_REGION}),
 f('d15a0001-f1d0-4000-8001-000000000006','source_updated_at','datetime','Source Updated','تاريخ تحديث المصدر',{order:5,section_id:SEC_REGION}),
 f('d15a0001-f1d0-4000-8001-000000000007','is_active','checkbox','Active','نشط',{order:6,section_id:SEC_REGION}),
];
const cityFields=[
 f('d15a0001-f1d0-4000-8002-000000000001','name_ar','text','Name (AR)','الاسم (عربي)',{required:true,order:0,show_in_table:true,section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-000000000002','name_en','text','Name (EN)','الاسم (إنجليزي)',{required:true,order:1,show_in_table:true,section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-000000000003','display_name','text','Display Name','الاسم المعروض',{order:2,show_in_table:true,width:'full',section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-000000000004','spl_city_id','text','SPL City ID','معرف المدينة (SPL)',{order:3,show_in_table:true,section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-000000000005','region_lookup','lookup','Region','المنطقة',{order:4,show_in_table:true,section_id:SEC_CITY,lookup_model_id:REGIONS,lookup_display_field:'name_ar'}),
 f('d15a0001-f1d0-4000-8002-000000000006','region_name_ar','text','Region Name (AR)','اسم المنطقة (عربي)',{order:5,section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-000000000007','region_name_en','text','Region Name (EN)','اسم المنطقة (إنجليزي)',{order:6,section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-000000000008','source','text','Source','المصدر',{order:7,section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-000000000009','source_updated_at','datetime','Source Updated','تاريخ تحديث المصدر',{order:8,section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-00000000000a','has_districts','checkbox','Has Districts','يحتوي على أحياء',{order:9,section_id:SEC_CITY}),
 f('d15a0001-f1d0-4000-8002-00000000000b','is_active','checkbox','Active','نشط',{order:10,section_id:SEC_CITY}),
];
const distNew=[
 f('d15a0001-f1d0-4000-8003-000000000001','spl_district_id','text','SPL District ID','معرف الحي (SPL)',{order:20,show_in_table:true,section_id:DIST_SEC}),
 f('d15a0001-f1d0-4000-8003-000000000002','display_name','text','Display Name','الاسم المعروض',{order:21,show_in_table:true,width:'full',section_id:DIST_SEC}),
 f('d15a0001-f1d0-4000-8003-000000000003','city_lookup','lookup','City','المدينة',{order:22,show_in_table:true,section_id:DIST_SEC,lookup_model_id:CITIES,lookup_display_field:'display_name'}),
 f('d15a0001-f1d0-4000-8003-000000000004','city_id','text','City ID','معرف المدينة',{order:23,section_id:DIST_SEC}),
 f('d15a0001-f1d0-4000-8003-000000000005','city_name_ar','text','City Name (AR)','اسم المدينة (عربي)',{order:24,section_id:DIST_SEC}),
 f('d15a0001-f1d0-4000-8003-000000000006','city_name_en','text','City Name (EN)','اسم المدينة (إنجليزي)',{order:25,section_id:DIST_SEC}),
 f('d15a0001-f1d0-4000-8003-000000000007','region_lookup','lookup','Region','المنطقة',{order:26,section_id:DIST_SEC,lookup_model_id:REGIONS,lookup_display_field:'name_ar'}),
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
   {id:'d15a0001-0b7-0003',value:'needs_review',label_en:'Needs review',label_ar:'يحتاج مراجعة',color:'#ef4444'}]}),
 f('d15a0001-f1d0-4000-8003-000000000011','migration_notes','textarea','Migration Notes','ملاحظات الترحيل',{order:36,width:'full',section_id:DIST_SEC}),
];

const regionSchema={sections:[{id:SEC_REGION,color:'#8E4E3A',order:0,is_base:true,label_ar:'معلومات المنطقة',label_en:'Region Info',fields:regionFields}],duplicate_check_field_id:'d15a0001-f1d0-4000-8001-000000000003',section_selector_field_id:null};
const citySchema={sections:[{id:SEC_CITY,color:'#8E4E3A',order:0,is_base:true,label_ar:'معلومات المدينة',label_en:'City Info',fields:cityFields}],duplicate_check_field_id:'d15a0001-f1d0-4000-8002-000000000004',section_selector_field_id:null};

async function req(method, pathq, body, extraH={}) {
  const r = await fetch(URL+'/rest/v1/'+pathq, { method, headers:{...H,...extraH}, body: body?JSON.stringify(body):undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${pathq} -> ${r.status} ${t.slice(0,300)}`);
  return t ? JSON.parse(t) : null;
}

async function main(){
  // 1. Geography group (upsert on PK)
  await req('POST','model_groups',[{id:GEO_GROUP,label_ar:'الجغرافيا',label_en:'Geography',order:6}],{Prefer:'resolution=merge-duplicates,return=minimal'});
  console.log('group ok');

  // 2. Regions + Cities models (upsert on PK)
  await req('POST','models',[{
    id:REGIONS,name:'regions',label_ar:'المناطق',label_en:'Regions',icon:'map',color:'#8E4E3A',
    schema:regionSchema, card_config:{title_field_id:'d15a0001-f1d0-4000-8001-000000000001',shown_field_ids:['d15a0001-f1d0-4000-8001-000000000002']},
    group_id:GEO_GROUP,is_system:false,order:0
  }],{Prefer:'resolution=merge-duplicates,return=minimal'});
  await req('POST','models',[{
    id:CITIES,name:'cities',label_ar:'المدن',label_en:'Cities',icon:'building-2',color:'#8E4E3A',
    schema:citySchema, card_config:{title_field_id:'d15a0001-f1d0-4000-8002-000000000003',shown_field_ids:['d15a0001-f1d0-4000-8002-000000000006']},
    group_id:GEO_GROUP,is_system:false,order:1
  }],{Prefer:'resolution=merge-duplicates,return=minimal'});
  console.log('regions+cities ok');

  // 3. Districts: fetch, fix city label, append new fields (idempotent by id), set card/group/order
  const [dist] = await req('GET',`models?id=eq.${DISTRICTS}&select=schema,card_config`);
  const sch = dist.schema; const fields = sch.sections[0].fields;
  for (const fld of fields) if (fld.name==='city' && fld.label_en!=='City') fld.label_en='City';
  const have = new Set(fields.map(x=>x.id));
  for (const nf of distNew) if (!have.has(nf.id)) fields.push(nf);
  const card = dist.card_config || {shown_field_ids:[]}; card.title_field_id='d15a0001-f1d0-4000-8003-000000000002';
  await req('PATCH',`models?id=eq.${DISTRICTS}`,{schema:sch,card_config:card,group_id:GEO_GROUP,order:2},{Prefer:'return=minimal'});
  console.log('districts extended ok, field count now', fields.length);

  // 4. Grant view (scope all) on the 3 geo models to every profile lacking it
  const profs = await req('GET','profiles?select=id,model_permissions');
  for (const mid of [REGIONS,CITIES,DISTRICTS]) {
    for (const p of profs) {
      const mp = Array.isArray(p.model_permissions)?p.model_permissions:[];
      if (mp.some(e=>e.model_id===mid)) continue;
      mp.push({model_id:mid,permissions:['view'],view_scope:{mode:'all',conditions:[]},edit_scope:{mode:'all',conditions:[]}});
      await req('PATCH',`profiles?id=eq.${p.id}`,{model_permissions:mp},{Prefer:'return=minimal'});
    }
  }
  console.log('permissions granted to', profs.length, 'profiles');
  console.log('DONE');
}
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
