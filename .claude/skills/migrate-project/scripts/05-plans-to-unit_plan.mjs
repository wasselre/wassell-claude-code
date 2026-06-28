import fs from 'node:fs';
import crypto from 'node:crypto';
const SUPA='https://zhqqsxwealdwqzrbpwyv.supabase.co';
const ENV=fs.readFileSync('C:/Users/rayan/Claude/wassell-claude-code/.env.local','utf8');
const KEY=(ENV.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\r\n]+)"?/)||[])[1];
const UNITS='7ca3014d-f658-418e-9c53-2d279c97f009';
const PROJ='a5435814-f1a6-4efe-be5a-fb6bc329c790';
const AUTH_UID='31621e58-c723-45ad-9e4f-6f8ba1689fe7';   // storage path prefix
const PUB_USER='a3374d65-9cee-4daa-8880-5e8ff23e7db0';   // files.uploaded_by_user_id
const H={apikey:KEY,'Authorization':'Bearer '+KEY,'Content-Type':'application/json'};
const LIMIT=process.argv[2]?Number(process.argv[2]):99;

// plan-derived components per charted unit (read from the floor-plan drawings)
const PLANS={
 'A/6':  {beds:3,baths:3,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة خادمة','فناء خارجي','غرفة-نوم-رييسية']},
 'B/8':  {beds:3,baths:3,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة خادمة','غرفة غسيل','غرفة-نوم-رييسية']},
 'B/16': {beds:1,baths:1,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة غسيل','سطح','غرفة-نوم-رييسية']},
 'D/5':  {beds:2,baths:2,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة-نوم-رييسية']},
 'D/18': {beds:2,baths:3,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة غسيل','غرفة-نوم-رييسية']},
 'E/15': {beds:2,baths:3,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة-نوم-رييسية']},
 'E/19': {beds:2,baths:2,comps:['صالة جلوس','صالة طعام','مطبخ','سطح','غرفة-نوم-رييسية']},
 'F/16': {beds:1,baths:1,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة غسيل','سطح','غرفة-نوم-رييسية']},
 'H/9':  {beds:2,baths:3,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة غسيل','غرفة-نوم-رييسية']},
 'H/24': {beds:2,baths:2,comps:['صالة جلوس','صالة طعام','مطبخ','سطح','غرفة-نوم-رييسية']},
 'H/27': {beds:2,baths:2,comps:['صالة جلوس','صالة طعام','مطبخ','غرفة خادمة','غرفة غسيل','ملابس','سطح','غرفة-نوم-رييسية']},
};
const map=JSON.parse(fs.readFileSync('plan_map.json','utf8'));

let done=0;
for(const m of map.slice(0,LIMIT)){
  const key=m.bld+'/'+m.unit;
  // 1) fetch my unit (id + current data) to merge
  const rows=await(await fetch(`${SUPA}/rest/v1/records?select=id,data&model_id=eq.${UNITS}&data->>project_id=eq.${PROJ}&data->>building_number=eq.${m.bld}&data->>unit_number=eq.${m.unit}`,{headers:H})).json();
  if(!rows.length){ console.log(key,'NO UNIT FOUND'); continue; }
  const unit=rows[0]; const data=unit.data;
  if(data.unit_plan){ console.log(key,'already has plan, skip'); continue; }
  // 2) upload plan to storage
  const bytes=fs.readFileSync(m.file);
  const fileId=crypto.randomUUID();
  const path=`${AUTH_UID}/${fileId}.jpg`;
  const up=await fetch(`${SUPA}/storage/v1/object/wassel-files/${path}`,{method:'POST',
    headers:{apikey:KEY,'Authorization':'Bearer '+KEY,'Content-Type':'image/jpeg'},body:bytes});
  if(!up.ok){ console.log(key,'UPLOAD FAIL',up.status,(await up.text()).slice(0,120)); continue; }
  // 3) insert files row
  const frow={id:fileId,model_id:UNITS,record_id:unit.id,uploaded_by_user_id:PUB_USER,
    original_name:`${m.bld}${m.unit}-plan.jpg`,mime_type:'image/jpeg',size_bytes:bytes.length,
    storage_bucket:'wassel-files',storage_path:path,kind:'image'};
  const fi=await fetch(`${SUPA}/rest/v1/files`,{method:'POST',headers:{...H,Prefer:'return=minimal'},body:JSON.stringify(frow)});
  if(!fi.ok){ console.log(key,'FILES INSERT FAIL',fi.status,(await fi.text()).slice(0,160)); continue; }
  // 4) merge components (desc-derived + plan-derived) and set unit_plan + plan-confirmed beds/baths
  const pl=PLANS[key]||{comps:[]};
  const comps=Array.from(new Set([...(Array.isArray(data.unit_components)?data.unit_components:[]), ...pl.comps]));
  const newData={...data, unit_plan:fileId, unit_components:comps,
    bedrooms: pl.beds??data.bedrooms, bathrooms: pl.baths??data.bathrooms,
    notes:[data.notes, 'مخطط الوحدة مقروء: '+pl.comps.join('، ')].filter(Boolean).join(' | ')};
  const sv=await fetch(SUPA+'/rest/v1/rpc/record_save',{method:'POST',headers:H,
    body:JSON.stringify({p_model_id:UNITS,p_id:unit.id,p_data:newData,p_created_by:null,p_expected_version:null})});
  console.log(key,'->', sv.status, 'plan',fileId.slice(0,8), 'comps:',comps.join(','));
  done++;
}
console.log('DONE units with plans:',done);
