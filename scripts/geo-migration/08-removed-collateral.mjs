// Measures what's linked to the 85 removed projects (so a delete decision is informed).
import fs from 'node:fs';
const REPO='C:/Users/rayan/Claude/wassell-claude-code';
const ENV=fs.readFileSync(REPO+'/.env.local','utf8');
const env=(k)=>(ENV.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1]?.trim().replace(/\r$/,'').replace(/^["']|["']$/g,'');
const URL=env('VITE_SUPABASE_URL'), KEY=env('SUPABASE_SERVICE_ROLE_KEY');
const H={apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'};
const ids=JSON.parse(fs.readFileSync(REPO+'/.claude/worktrees/determined-pike-4a2043/scripts/geo-migration/_removed_ids.json','utf8'));

// RPC-free: count via the data->>'project_id' / lookup arrays using a SQL function would be cleaner,
// but here just fetch units + our_projects that reference any removed all_projects id.
async function q(sql){ const r=await fetch(`${URL}/rest/v1/rpc/exec_sql`,{method:'POST',headers:H,body:JSON.stringify({q:sql})}); return r.ok?r.json():null; }

// units: data->>'project_id' in ids  | our_projects: data->>'project' in ids
async function countRefs(model_id, key){
  let withRef=0; const linked=new Set();
  // page through model records, check key membership
  const idset=new Set(ids);
  for(let from=0;;from+=1000){
    const r=await fetch(`${URL}/rest/v1/records?model_id=eq.${model_id}&select=id,data&limit=1000&offset=${from}`,{headers:H});
    const rows=await r.json(); if(!rows.length) break;
    for(const row of rows){ const v=row.data?.[key]; if(v && idset.has(v)){ withRef++; linked.add(v);} }
    if(rows.length<1000) break;
  }
  return {refs:withRef, distinctProjects:linked.size};
}

const units = await countRefs('7ca3014d-f658-418e-9c53-2d279c97f009','project_id');
const ourp  = await countRefs('6609286a-f95a-45db-94e6-48cfa915ccbd','project');
console.log(JSON.stringify({ removed_projects: ids.length,
  units_linked_to_removed: units, our_projects_linked_to_removed: ourp }, null, 2));
