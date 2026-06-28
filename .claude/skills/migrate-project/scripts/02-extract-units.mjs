import fs from 'node:fs';
const H={headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0','Origin':'https://almajdiah.com','Referer':'https://almajdiah.com/'}};
const api=(id,pg)=>`https://etmaam.almajdiah.com/api/client/v1/projects/${id}?floor=&building=&bedroom_count=&unit_price_range=&unit_status=&specification=&page=${pg}`;
const ID=229;
const first=await(await fetch(api(ID,1),H)).json();
const p=first.project;
const last=first.units.meta.last_page;
let units=first.units.data.slice();
for(let pg=2;pg<=last;pg++){const j=await(await fetch(api(ID,pg),H)).json();units=units.concat(j.units.data);}
fs.writeFileSync('proj_229.json', JSON.stringify({project:p, units}, null, 1));
// print the project-level keys + the links the user cares about
console.log('PROJECT KEYS:', Object.keys(p).join(', '));
console.log(JSON.stringify({
  name:p.name, code:p.code, status_text:p.status_text,
  units_count:p.units_count, available_units:p.available_units, buildings:p.buildings_count,
  location:p.location, video_link:p.video_link, pdf_file:p.pdf_file,
  web_site_project_brochure:p.web_site_project_brochure,
  banner_img:p.banner_img, image:p.image, gallery_n:(p.gallery||[]).length,
  features:p.features, project_specifications:p.project_specifications,
  description:p.description
}, null, 1));
// status + type breakdown of units
const st={},ty={}; units.forEach(u=>{st[u.status]=(st[u.status]||0)+1; ty[u.floor_text]=(ty[u.floor_text]||0)+1;});
console.log('UNITS pulled:', units.length, '| status:', JSON.stringify(st));
console.log('floor_text/type:', JSON.stringify(ty));
console.log('SAMPLE UNIT keys:', Object.keys(units[0]).join(', '));
