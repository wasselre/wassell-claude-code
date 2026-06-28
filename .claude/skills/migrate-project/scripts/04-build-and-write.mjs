import fs from 'node:fs';
import crypto from 'node:crypto';
const SUPA='https://zhqqsxwealdwqzrbpwyv.supabase.co';
const ENV=fs.readFileSync('C:/Users/rayan/Claude/wassell-claude-code/.env.local','utf8');
const KEY=(ENV.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\r\n]+)"?/)||[])[1];
const ALL_PROJECTS='220c49b9-de57-492d-9eca-c0d9f54fd40f';
const UNITS='7ca3014d-f658-418e-9c53-2d279c97f009';
const DEVELOPER='7e5f034b-2bc0-4aaa-93b3-69bd67bed47a';
const PROJ=process.argv[2];
const H={apikey:KEY,'Authorization':'Bearer '+KEY,'Content-Type':'application/json'};
const rpc=(model,id,data)=>fetch(SUPA+'/rest/v1/rpc/record_save',{method:'POST',headers:H,body:JSON.stringify({p_model_id:model,p_id:id,p_data:data,p_created_by:null,p_expected_version:null})});
const num=v=>(v===null||v===undefined||v==='')?'':(isNaN(Number(v))?v:Number(v));
const STATUS={sold:'sold',available:'available',under_sale:'available',booked:'reserved',booked_paid:'reserved',pre_booking:'reserved',reserved:'reserved'};
const FLOOR_AR={'الأرضي':'ارضي','الأول':'اول','الثاني':'ثاني','الثالث':'ثالث'};

function parseUnit(u){
  const desc=(u.unit_description||'').trim();
  const toks = desc==='-'||desc==='' ? [] : desc.split(/\s*-\s*/).map(t=>t.trim()).filter(Boolean);
  const facade=new Set(), comps=new Set(), notes=[];
  for(const t of toks){
    const tn=t.replace(/بلكونه/g,'بلكونة');
    if(/امامية|أمامية|اماميه/.test(tn)) facade.add('امامية');
    else if(/جانبية|جانبيه/.test(tn)) facade.add('جانبية');
    else if(/خلفية/.test(tn)) facade.add('خلفية');
    else if(/غرفة خادمة/.test(tn)) comps.add('غرفة خادمة');
    else if(/غرفة خدمات/.test(tn)) comps.add('غرفة خدمات');
    else if(/بلكونة/.test(tn)) comps.add('بلكونة');
    else if(/سطح/.test(tn)) comps.add('سطح');
    else if(/مستودع/.test(tn)) comps.add('مستودع');
    else if(/تراس/.test(tn)) comps.add('تراس');
    else if(/سيب/.test(tn)) comps.add('سيب-خاص');
    else if(/مؤثثة/.test(tn)) notes.push('مؤثثة');
    else notes.push(t);
  }
  const g=u.garage_text||''; const parking=[];
  if(/قبو/.test(g)) parking.push('basement');
  if(/خارجي/.test(g)) parking.push('external');
  if(/داخلي/.test(g)) parking.push('internal');
  return {facade:[...facade], unit_components:[...comps], parking_space:parking, extraNotes:notes};
}

const src=JSON.parse(fs.readFileSync('proj_229.json','utf8'));
const units=src.units, p=src.project;

// 1) delete existing units for this project
const ids=await(await fetch(`${SUPA}/rest/v1/records?select=id&model_id=eq.${UNITS}&data->>project_id=eq.${PROJ}`,{headers:H})).json();
let del=0;
for(const row of ids){ const r=await fetch(SUPA+'/rest/v1/rpc/record_delete',{method:'POST',headers:H,body:JSON.stringify({p_model_id:UNITS,p_id:row.id})}); if(r.ok)del++; }
console.log('deleted old units:',del,'of',ids.length);

// 2) recreate enriched + collect component union
const compUnion=new Set(); const facadeUnion=new Set();
let ok=0,fail=0; const errs=[];
for(const u of units){
  const pu=parseUnit(u);
  pu.unit_components.forEach(c=>compUnion.add(c)); pu.facade.forEach(f=>facadeUnion.add(f));
  const data={
    project_id:PROJ, developer_id:DEVELOPER,
    unit_number:u.unit_number, unit_type:'شقة', unit_status:STATUS[u.status]||u.status,
    total_price:num(u.price_before_tax),
    unit_area:num(u.area), private_area:num(u.special_area), total_area:num(u.total_area),
    bedrooms:num(u.room_count), bathrooms:num(u.bathroom_count),
    floor:FLOOR_AR[u.floor_text]||'', block:u.building_name||'', building_number:u.building_name||'',
    country:'السعودية', city:'الرياض', district:'الندى',
    facade:pu.facade, unit_components:pu.unit_components, parking_space:pu.parking_space,
    notes:[u.unit_description&&('وصف: '+u.unit_description),
           pu.extraNotes.length&&('إضافي: '+pu.extraNotes.join('، ')),
           u.floor_text&&('الطابق: '+u.floor_text),
           u.price_after_tax&&('شامل الضريبة: '+u.price_after_tax+' ('+(u.tax_rate||'')+'%)'),
           (u.chart_file_urls||[]).length&&('مخطط: '+(u.chart_file_urls||[]).map(c=>c.url).join(' '))
          ].filter(Boolean).join(' | ')
  };
  const r=await rpc(UNITS,crypto.randomUUID(),data);
  if(r.ok)ok++; else{fail++; if(errs.length<3)errs.push(r.status+' '+(await r.text()).slice(0,140));}
}
console.log('units recreated:',JSON.stringify({ok,fail,errs}));

// 3) update project: amenities(5) + features = brochure + component union (exact unit components)
const COMP_LABEL={'غرفة خادمة':'غرفة خادمة','غرفة خدمات':'غرفة خدمات','بلكونة':'بلكونة','سطح':'سطح خاص','مستودع':'مستودع','تراس':'تراس','سيب-خاص':'سيب خاص'};
const FAC_LABEL={'امامية':'واجهة أمامية','جانبية':'واجهة جانبية','خلفية':'واجهة خلفية'};
const features=[
  {feature:'خصوصية عالية في الوحدات', keywords:'من البروشور'},
  {feature:'مداخل منفصلة', keywords:'من البروشور'},
  ...[...compUnion].map(c=>({feature:COMP_LABEL[c]||c, keywords:'من وحدات المشروع'})),
  ...[...facadeUnion].map(f=>({feature:FAC_LABEL[f]||f, keywords:'من وحدات المشروع'}))
];
const projData={
  project_name:'الماجدية 174', developer:DEVELOPER,
  preferred_country:'السعودية', preferred_city:'الرياض', preferred_neighborhoods:'حي الندى',
  project_location:p.location?.map_url||'', latitude:num(p.location?.latitude), longitude:num(p.location?.longitude),
  project_page_url:'https://almajdiah.com/projects/229', broucher_developer:p.web_site_project_brochure||'',
  unit_types:['apartment'], project_status:'available_on_map', construction_status:'ready',
  project_classification:'our_projects', project_type:'our_projects', is_public:true,
  data_sources:['project_page','brochure','units_table'],
  preferred_amenities:['lounge','sports_club','كونسرج','غرفة-بريد','مداخل-منفصلة'],
  features,
  services:[{service:'لاونج في كل منطقة',notes:'من البروشور'},{service:'كونسرج',notes:'من البروشور'},{service:'غرفة بريد',notes:'من البروشور'}],
  nearby_landmarks:[
    {landmark:'مطار الملك خالد الدولي',property_type:'مطار',distance:'',duration:''},
    {landmark:'مستشفى المملكة',property_type:'مستشفى',distance:'',duration:''},
    {landmark:'مركز الرياض الدولي للمؤتمرات والمعارض',property_type:'مركز مؤتمرات ومعارض',distance:'',duration:''},
    {landmark:'جامعة الملك سعود',property_type:'جامعة',distance:'',duration:''}],
  guarantees:[],
  project_analysis:'نسخة استخرجها Claude من موقع الماجدية (صفحة المشروع + API الوحدات + البروشور 15 صفحة) للمقارنة. 226 وحدة في حي الندى بالرياض. مكونات كل وحدة مستخرجة بدقة.',
  district_migration_notes:'CLAUDE-DUPLICATE-FOR-COMPARISON 2026-06-28 (project 229) v2'
};
const pr=await rpc(ALL_PROJECTS,PROJ,projData);
console.log('project update:',pr.status, 'features rows:',features.length, 'components found:',[...compUnion].join(','),'facades:',[...facadeUnion].join(','));
