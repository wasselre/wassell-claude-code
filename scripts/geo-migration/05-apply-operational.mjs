// Operational model changes (section 7): add district/city/region lookups to all_projects,
// preferred_* multi-lookups + location_priority to clients, project-district mirrors to units,
// and repoint marketing_operations.mirror_district. Legacy fields preserved. Idempotent by field id.
//   node scripts/geo-migration/05-apply-operational.mjs
import fs from 'node:fs';
const REPO='C:/Users/rayan/Claude/wassell-claude-code';
const ENV=fs.readFileSync(REPO+'/.env.local','utf8');
const env=(k)=>(ENV.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1]?.trim().replace(/\r$/,'').replace(/^["']|["']$/g,'');
const URL=env('VITE_SUPABASE_URL'), KEY=env('SUPABASE_SERVICE_ROLE_KEY');
const H={apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'};

const REGIONS='d15a0001-0000-4000-8000-000000000001', CITIES='d15a0001-0000-4000-8000-000000000002', DISTRICTS='d9a9db7e-b602-470c-b81b-5d6ff17048e9';
const AP='220c49b9-de57-492d-9eca-c0d9f54fd40f', CLIENTS='2e86f197-385f-4853-908f-b4cb7237f7d8', UNITS='7ca3014d-f658-418e-9c53-2d279c97f009', MKT='58e92e8d-b7c6-48ef-b9c4-41987e522075';
const AP_GEO_SEC='9e8fc144-d3ae-4b62-bf1c-831b152c58ac';
const CL_PREF_SEC='84e95d93-b3cb-40d3-9f69-0b30d51a2a3a';
const UN_BASIC_SEC='7d7c0e7e-15ef-40d1-a420-0452a058bf14';
const UN_PROJECT_LOOKUP='3aa1df8a-110b-46c2-b878-21fe93a70377'; // units.project_id

const MATCH_STATUS_OPTS=[
 ['matched_by_polygon','Matched by polygon','مطابقة بالحدود','#16a34a'],
 ['matched_by_exact_arabic_name','Exact Arabic name','تطابق الاسم العربي','#22c55e'],
 ['matched_by_exact_english_name','Exact English name','تطابق الاسم الإنجليزي','#22c55e'],
 ['matched_by_normalized_name','Normalized name','تطابق بعد التنظيف','#84cc16'],
 ['matched_by_alias','Alias match','تطابق اسم بديل','#84cc16'],
 ['matched_by_nearest_centroid','Nearest centroid','أقرب مركز','#eab308'],
 ['missing_coordinates','Missing coordinates','إحداثيات مفقودة','#f59e0b'],
 ['outside_known_boundary','Outside known boundary','خارج الحدود المعروفة','#f97316'],
 ['ambiguous_match','Ambiguous','غير محدد','#ef4444'],
 ['needs_manual_review','Needs manual review','يحتاج مراجعة يدوية','#dc2626'],
 ['manual_selected','Manually selected','اختيار يدوي','#3b82f6'],
 ['not_applicable','Not applicable','لا ينطبق','#9ca3af'],
].map(([value,le,la,color],i)=>({id:`d15a0002-ms-${String(i+1).padStart(2,'0')}`,value,label_en:le,label_ar:la,color}));
const PRIORITY_OPTS=[
 ['strict_district','Strict district','الحي بدقة','#dc2626'],
 ['nearby_district_ok','Nearby district OK','الأحياء القريبة مقبولة','#22c55e'],
 ['same_city_ok','Same city OK','نفس المدينة مقبول','#eab308'],
 ['flexible','Flexible','مرن','#3b82f6'],
].map(([value,le,la,color],i)=>({id:`d15a0002-pr-${String(i+1).padStart(2,'0')}`,value,label_en:le,label_ar:la,color}));

const fld=(id,name,type,le,la,sec,x={})=>({id,name,type,label_en:le,label_ar:la,required:false,order:x.order??50,width:x.width||'half',section_id:sec,show_in_table:x.show_in_table??false,
  ...(type==='lookup'?{lookup_model_id:x.lookup_model_id,lookup_display_field:x.lookup_display_field,is_multi:!!x.is_multi}:{}),
  ...(type==='mirror'?{mirror_target_field_name:x.mirror_target_field_name,mirror_via_lookup_field_id:x.mirror_via_lookup_field_id}:{}),
  ...(x.options?{options:x.options}:{})});

const AP_FIELDS=[
 fld('d15a0002-ap00-4000-8000-000000000001','district_lookup','lookup','District (linked)','الحي المرتبط',AP_GEO_SEC,{order:40,lookup_model_id:DISTRICTS,lookup_display_field:'display_name',show_in_table:true}),
 fld('d15a0002-ap00-4000-8000-000000000002','district_name','text','District Name','اسم الحي',AP_GEO_SEC,{order:41,show_in_table:true}),
 fld('d15a0002-ap00-4000-8000-000000000003','city_lookup','lookup','City (linked)','المدينة المرتبطة',AP_GEO_SEC,{order:42,lookup_model_id:CITIES,lookup_display_field:'display_name'}),
 fld('d15a0002-ap00-4000-8000-000000000004','region_lookup','lookup','Region (linked)','المنطقة المرتبطة',AP_GEO_SEC,{order:43,lookup_model_id:REGIONS,lookup_display_field:'name_ar'}),
 fld('d15a0002-ap00-4000-8000-000000000005','district_match_status','dropdown','District Match Status','حالة مطابقة الحي',AP_GEO_SEC,{order:44,options:MATCH_STATUS_OPTS}),
 fld('d15a0002-ap00-4000-8000-000000000006','district_migration_notes','textarea','District Migration Notes','ملاحظات ترحيل الحي',AP_GEO_SEC,{order:45,width:'full'}),
 fld('d15a0002-ap00-4000-8000-000000000007','location_verified_at','datetime','Location Verified At','تاريخ التحقق من الموقع',AP_GEO_SEC,{order:46}),
];
const CL_FIELDS=[
 fld('d15a0002-cl00-4000-8000-000000000001','preferred_regions','lookup','Preferred Regions','المناطق المفضلة',CL_PREF_SEC,{order:40,lookup_model_id:REGIONS,lookup_display_field:'name_ar',is_multi:true}),
 fld('d15a0002-cl00-4000-8000-000000000002','preferred_cities','lookup','Preferred Cities','المدن المفضلة',CL_PREF_SEC,{order:41,lookup_model_id:CITIES,lookup_display_field:'display_name',is_multi:true}),
 fld('d15a0002-cl00-4000-8000-000000000003','preferred_districts','lookup','Preferred Districts','الأحياء المفضلة (مرتبطة)',CL_PREF_SEC,{order:42,lookup_model_id:DISTRICTS,lookup_display_field:'display_name',is_multi:true,show_in_table:true}),
 fld('d15a0002-cl00-4000-8000-000000000004','location_priority','dropdown','Location Priority','أولوية الموقع',CL_PREF_SEC,{order:43,options:PRIORITY_OPTS}),
 fld('d15a0002-cl00-4000-8000-000000000005','max_distance_km','number','Max Distance (km)','أقصى مسافة (كم)',CL_PREF_SEC,{order:44}),
 fld('d15a0002-cl00-4000-8000-000000000006','preferred_location_notes','textarea','Preferred Location Notes','ملاحظات الموقع المفضل',CL_PREF_SEC,{order:45,width:'full'}),
 fld('d15a0002-cl00-4000-8000-000000000007','preferred_district_migration_status','dropdown','Pref District Migration Status','حالة ترحيل الأحياء المفضلة',CL_PREF_SEC,{order:46,options:MATCH_STATUS_OPTS}),
 fld('d15a0002-cl00-4000-8000-000000000008','preferred_district_migration_notes','textarea','Pref District Migration Notes','ملاحظات ترحيل الأحياء المفضلة',CL_PREF_SEC,{order:47,width:'full'}),
];
const UN_FIELDS=[
 fld('d15a0002-un00-4000-8000-000000000001','project_district_lookup','mirror','Project District (linked)','حي المشروع (مرتبط)',UN_BASIC_SEC,{order:40,mirror_target_field_name:'district_lookup',mirror_via_lookup_field_id:UN_PROJECT_LOOKUP}),
 fld('d15a0002-un00-4000-8000-000000000002','project_district_name','mirror','Project District Name','اسم حي المشروع',UN_BASIC_SEC,{order:41,mirror_target_field_name:'district_name',mirror_via_lookup_field_id:UN_PROJECT_LOOKUP,show_in_table:true}),
];

async function getModel(id){const r=await fetch(`${URL}/rest/v1/models?id=eq.${id}&select=schema`,{headers:H});const j=await r.json();return j[0].schema;}
async function patchModel(id,schema){const r=await fetch(`${URL}/rest/v1/models?id=eq.${id}`,{method:'PATCH',headers:{...H,Prefer:'return=minimal'},body:JSON.stringify({schema})});if(!r.ok)throw new Error(`patch ${id} ${r.status} ${(await r.text()).slice(0,300)}`);}
function appendToSection(schema, secId, newFields){
  const sec=schema.sections.find(s=>s.id===secId); if(!sec)throw new Error('section not found '+secId);
  const have=new Set(sec.fields.map(f=>f.id)); let added=0;
  for(const nf of newFields) if(!have.has(nf.id)){sec.fields.push(nf);added++;}
  return added;
}

async function main(){
  for(const [name,id,sec,fields] of [['all_projects',AP,AP_GEO_SEC,AP_FIELDS],['clients',CLIENTS,CL_PREF_SEC,CL_FIELDS],['units',UNITS,UN_BASIC_SEC,UN_FIELDS]]){
    const sch=await getModel(id); const added=appendToSection(sch,sec,fields); await patchModel(id,sch);
    console.log(`${name}: +${added} fields (total in section now ${sch.sections.find(s=>s.id===sec).fields.length})`);
  }
  // marketing_operations: repoint mirror_district to district_name
  const msch=await getModel(MKT); let repointed=false;
  for(const s of msch.sections) for(const f of s.fields) if(f.name==='mirror_district'){ f.mirror_target_field_name='district_name'; repointed=true; }
  await patchModel(MKT,msch); console.log('marketing_operations.mirror_district repointed:',repointed);
  console.log('DONE');
}
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
