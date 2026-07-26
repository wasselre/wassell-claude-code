// Ad-hoc prod query/RPC helper for this session (scratchpad — not committed).
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const supa = createClient(url, key, { auth: { persistSession: false } });

const [, , mode, ...rest] = process.argv;
if (mode === 'rpc') {
  const [fn, json] = rest;
  const { data, error } = await supa.rpc(fn, json ? JSON.parse(json) : {});
  console.log(error ? 'ERROR ' + error.message : JSON.stringify(data, null, 2));
} else if (mode === 'sel') {
  const [table, sel, filt] = rest;
  let q = supa.from(table).select(sel || '*');
  if (filt) for (const p of filt.split(',')) { const [c, v] = p.split('='); q = q.eq(c, v); }
  const { data, error } = await q.limit(50);
  console.log(error ? 'ERROR ' + error.message : JSON.stringify(data, null, 2));
} else if (mode === 'ins') {
  const [table, json] = rest;
  const { data, error } = await supa.from(table).insert(JSON.parse(json)).select();
  console.log(error ? 'ERROR ' + error.message : JSON.stringify(data, null, 2));
}
