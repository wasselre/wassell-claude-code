// Imports SPL geography into Wassell via PostgREST (service role). Idempotent
// (deterministic md5-derived UUIDs; upsert on PK). Bytes stream from disk, not context.
//   node scripts/geo-migration/04-import-geography.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';

const REPO='C:/Users/rayan/Claude/wassell-claude-code';
const SRC='C:/Users/rayan/Claude/wassell-claude-code/.claude/worktrees/objective-turing-410d0c/saudi-districts/output';
const ENV=fs.readFileSync(REPO+'/.env.local','utf8');
const env=(k)=>(ENV.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1]?.trim().replace(/\r$/,'').replace(/^["']|["']$/g,'');
const URL=env('VITE_SUPABASE_URL'), KEY=env('SUPABASE_SERVICE_ROLE_KEY');
const H={apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'};

const REGIONS='d15a0001-0000-4000-8000-000000000001', CITIES='d15a0001-0000-4000-8000-000000000002', DISTRICTS='d9a9db7e-b602-470c-b81b-5d6ff17048e9';

const uuid=(s)=>{const h=crypto.createHash('md5').update(s).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
const rid=(spl)=>uuid('geo-region:'+spl), cid=(spl)=>uuid('geo-city:'+spl), did=(spl)=>uuid('geo-district:'+spl);

async function post(path, rows, prefer='resolution=merge-duplicates,return=minimal'){
  const r=await fetch(URL+'/rest/v1/'+path,{method:'POST',headers:{...H,Prefer:prefer},body:JSON.stringify(rows)});
  if(!r.ok){const t=await r.text();throw new Error(`POST ${path} (${rows.length}) -> ${r.status} ${t.slice(0,400)}`);}
}
async function del(path){const r=await fetch(URL+'/rest/v1/'+path,{method:'DELETE',headers:{...H,Prefer:'return=minimal'}});if(!r.ok&&r.status!==404){const t=await r.text();throw new Error(`DELETE ${path} -> ${r.status} ${t.slice(0,200)}`);}}
async function batched(path, rows, size){for(let i=0;i<rows.length;i+=size){await post(path,rows.slice(i,i+size));process.stdout.write(`\r  ${path}: ${Math.min(i+size,rows.length)}/${rows.length}`);}console.log('');}

const stripHayy=(s)=>String(s||'').replace(/^\s*حي\s+/,'').trim();
const stripDist=(s)=>String(s||'').replace(/\s*Dist\.?\s*$/i,'').trim();

const rows=JSON.parse(fs.readFileSync(SRC+'/saudi_city_districts.json','utf8'));
const summary=JSON.parse(fs.readFileSync(SRC+'/summary.json','utf8'));
const SOURCE=summary.source, EXTRACT=summary.extraction_date;

// --- Regions (distinct) ---
const regionMap=new Map();
for(const r of rows) if(!regionMap.has(String(r.region_id))) regionMap.set(String(r.region_id),r);
const regionRecs=[...regionMap.values()].map(r=>({
  id:rid(String(r.region_id)), model_id:REGIONS, created_by_user_id:null,
  data:{name_ar:r.region_name_ar,name_en:r.region_name_en,spl_region_id:String(r.region_id),country_code:'SA',source:SOURCE,source_updated_at:EXTRACT,is_active:true}
}));

// --- Cities (distinct) ---
const cityMap=new Map();
for(const r of rows) if(!cityMap.has(String(r.city_id))) cityMap.set(String(r.city_id),r);
const cityRecs=[...cityMap.values()].map(r=>({
  id:cid(String(r.city_id)), model_id:CITIES, created_by_user_id:null,
  data:{name_ar:r.city_name_ar,name_en:r.city_name_en,display_name:`${r.city_name_ar} - ${r.region_name_ar}`,
    spl_city_id:String(r.city_id),region_lookup:rid(String(r.region_id)),region_name_ar:r.region_name_ar,region_name_en:r.region_name_en,
    source:SOURCE,source_updated_at:EXTRACT,has_districts:true,is_active:true}
}));

// --- Districts ---
const distRecs=rows.map(r=>({
  id:did(String(r.district_id)), model_id:DISTRICTS, created_by_user_id:null,
  data:{name_ar:r.district_name_ar,name_en:r.district_name_en,spl_district_id:String(r.district_id),
    display_name:`${r.district_name_ar} - ${r.city_name_ar} - ${r.region_name_ar}`,
    city_lookup:cid(String(r.city_id)),city_id:String(r.city_id),city_name_ar:r.city_name_ar,city_name_en:r.city_name_en,
    region_lookup:rid(String(r.region_id)),region_id:String(r.region_id),region_name_ar:r.region_name_ar,region_name_en:r.region_name_en,
    centroid_lat:r.centroid_lat,centroid_lng:r.centroid_lng,center_lat:r.centroid_lat,center_lng:r.centroid_lng,
    source:SOURCE,source_updated_at:EXTRACT,is_active:true}
}));

// --- Aliases ---
const aliases=[];
for(const r of rows){
  const drec=did(String(r.district_id)), spl=String(r.district_id);
  aliases.push({district_record_id:drec,spl_district_id:spl,alias_ar:r.district_name_ar,alias_en:r.district_name_en,alias_type:'official',source:SOURCE,confidence_score:1.0,is_active:true});
  const ar2=stripHayy(r.district_name_ar); if(ar2 && ar2!==r.district_name_ar) aliases.push({district_record_id:drec,spl_district_id:spl,alias_ar:ar2,alias_en:null,alias_type:'arabic_variant',source:SOURCE,confidence_score:0.9,is_active:true});
  const en2=stripDist(r.district_name_en); if(en2 && en2!==r.district_name_en) aliases.push({district_record_id:drec,spl_district_id:spl,alias_ar:null,alias_en:en2,alias_type:'english_variant',source:SOURCE,confidence_score:0.9,is_active:true});
}

// --- Boundary staging (from geojson) ---
const gj=JSON.parse(fs.readFileSync(SRC+'/saudi_districts.geojson','utf8'));
const stageRows=gj.features.map(ft=>({
  spl_district_id:String(ft.properties.district_id), city_id:String(ft.properties.city_id??''), region_id:String(ft.properties.region_id??''),
  geojson:ft.geometry, geometry_type:ft.geometry?.type
}));

async function main(){
  console.log(`regions=${regionRecs.length} cities=${cityRecs.length} districts=${distRecs.length} aliases=${aliases.length} boundaries=${stageRows.length}`);
  console.log('importing regions...');   await batched('records',regionRecs,500);
  console.log('importing cities...');     await batched('records',cityRecs,500);
  console.log('importing districts...');  await batched('records',distRecs,500);
  console.log('clearing + importing aliases...'); await del(`district_aliases?source=eq.${encodeURIComponent(SOURCE)}`); await batched('district_aliases',aliases,1000);
  console.log('clearing + staging boundaries...'); await del('_geo_stage_boundaries?spl_district_id=neq.__none__'); await batched('_geo_stage_boundaries',stageRows,80);
  console.log('DONE — records+aliases+staging imported. Run the MCP conversion next.');
}
main().catch(e=>{console.error('\nFAILED:',e.message);process.exit(1);});
