// Dumps the district review queue (_geo_review_queue) to a UTF-8 (BOM) CSV for offline review.
//   node scripts/geo-migration/06-export-review-queue.mjs
import fs from 'node:fs';
const REPO='C:/Users/rayan/Claude/wassell-claude-code';
const ENV=fs.readFileSync(REPO+'/.env.local','utf8');
const env=(k)=>(ENV.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1]?.trim().replace(/\r$/,'').replace(/^["']|["']$/g,'');
const URL=env('VITE_SUPABASE_URL'), KEY=env('SUPABASE_SERVICE_ROLE_KEY');
const H={apikey:KEY,Authorization:'Bearer '+KEY};

const cols=['project_name','legacy_district','legacy_city','match_status','lat','lng',
  'name_suggestion','name_suggestion_city','name_similarity','coord_suggestion','coord_suggestion_city','coord_km',
  'chosen_district_id','reviewer_note','project_id','name_cand_id','coord_cand_id'];

const r=await fetch(`${URL}/rest/v1/_geo_review_queue?select=${cols.join(',')}&order=name_similarity.desc.nullslast,coord_km.asc.nullslast`,{headers:H});
if(!r.ok){console.error('fetch failed',r.status,await r.text());process.exit(1);}
const rows=await r.json();
const esc=(v)=>{ if(v==null) return ''; const s=String(v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
const csv='﻿'+[cols.join(',')].concat(rows.map(row=>cols.map(c=>esc(row[c])).join(','))).join('\r\n');
const out=REPO+'/.claude/worktrees/determined-pike-4a2043/migration-backups/geography-migration-20260625/district-review-queue.csv';
fs.writeFileSync(out,csv);
console.log(`wrote ${rows.length} rows -> ${out}`);
console.log('top 8 by name similarity:');
for(const row of rows.slice(0,8)) console.log(`  ${row.project_name} | legacy="${row.legacy_district}"/${row.legacy_city||'-'} | status=${row.match_status} | name→ ${row.name_suggestion||'-'} (${row.name_suggestion_city||'-'}, sim ${row.name_similarity??'-'}) | coord→ ${row.coord_suggestion||'-'} (${row.coord_km??'-'}km)`);
