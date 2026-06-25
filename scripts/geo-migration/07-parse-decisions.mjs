// Parse the reviewer-edited CSV and reconcile against the original 97-row queue.
// Read-only: reports kept rows (+ notes) and the removed set. Applies nothing.
import fs from 'node:fs';
const REPO='C:/Users/rayan/Claude/wassell-claude-code';
const ENV=fs.readFileSync(REPO+'/.env.local','utf8');
const env=(k)=>(ENV.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1]?.trim().replace(/\r$/,'').replace(/^["']|["']$/g,'');
const URL=env('VITE_SUPABASE_URL'), KEY=env('SUPABASE_SERVICE_ROLE_KEY');
const H={apikey:KEY,Authorization:'Bearer '+KEY};
const CSV=REPO+'/.claude/worktrees/determined-pike-4a2043/migration-backups/geography-migration-20260625/district-review-queue.csv';

// minimal RFC-4180 CSV parser
function parseCSV(text){
  text=text.replace(/^﻿/,'');
  const rows=[]; let row=[], cur='', q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=c; }
    else { if(c==='"')q=true; else if(c===','){row.push(cur);cur='';} else if(c==='\n'){row.push(cur);rows.push(row);row=[];cur='';} else if(c==='\r'){} else cur+=c; }
  }
  if(cur.length||row.length){row.push(cur);rows.push(row);}
  return rows.filter(r=>r.length>1||r[0]!=='');
}

const rows=parseCSV(fs.readFileSync(CSV,'utf8'));
const header=rows[0]; const idx=(n)=>header.indexOf(n);
const kept=rows.slice(1).map(r=>({
  project_id:r[idx('project_id')], project_name:r[idx('project_name')],
  note:r[idx('match_status')], legacy_district:r[idx('legacy_district')], legacy_city:r[idx('legacy_city')],
  name_suggestion:r[idx('name_suggestion')], name_cand_id:r[idx('name_cand_id')],
  coord_suggestion:r[idx('coord_suggestion')], coord_cand_id:r[idx('coord_cand_id')],
  chosen_district_id:r[idx('chosen_district_id')],
}));
const keptIds=new Set(kept.map(k=>k.project_id));

// original 97
const r=await fetch(`${URL}/rest/v1/_geo_review_queue?select=project_id,project_name,legacy_district,legacy_city,match_status`,{headers:H});
const orig=await r.json();
const removed=orig.filter(o=>!keptIds.has(o.project_id));

console.log(`KEPT ${kept.length} rows; REMOVED ${removed.length} of ${orig.length}\n`);
console.log('=== KEPT (your notes in "note") ===');
for(const k of kept) console.log(`• ${k.project_name} | note="${k.note}" | legacy="${k.legacy_district}"/${k.legacy_city||'-'} | name→${k.name_suggestion||'-'} | chosen=${k.chosen_district_id||'(blank)'} | id=${k.project_id}`);
console.log('\n=== REMOVED (you said: delete these projects) ===');
for(const o of removed) console.log(`• ${o.project_name} | legacy="${o.legacy_district}"/${o.legacy_city||'-'} | ${o.match_status} | id=${o.project_id}`);
// emit id lists for the next step
fs.writeFileSync(REPO+'/.claude/worktrees/determined-pike-4a2043/scripts/geo-migration/_removed_ids.json', JSON.stringify(removed.map(o=>o.project_id)));
fs.writeFileSync(REPO+'/.claude/worktrees/determined-pike-4a2043/scripts/geo-migration/_kept.json', JSON.stringify(kept));
console.log(`\n(wrote _removed_ids.json [${removed.length}] and _kept.json [${kept.length}])`);
