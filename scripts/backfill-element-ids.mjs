#!/usr/bin/env node
/**
 * Assign stable `_row_id`s to existing table-field rows (bilingual W1,
 * migration 2026-09-01_06). Operator-run post-apply; idempotent and batched.
 * ~1,767 in-scope rows as of the 2026-08-02 audit (all_projects,
 * project_details, targeted_projects, reel_scripts). Excluded models
 * (market_listings, design_templates) are deliberately not listed.
 *
 * Usage: node scripts/backfill-element-ids.mjs
 * Env (auto-loads .env.local/.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['.env.local', '.env']) {
  const p = resolve(ROOT, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const URL_ = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

const MODELS = ['all_projects', 'project_details', 'targeted_projects', 'reel_scripts'];

const rest = async (path, body) => {
  const res = await fetch(`${URL_}${path}`, {
    method: 'POST',
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'x-wassel-service': 'script:backfill-element-ids',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text.trim() === '' ? null : JSON.parse(text);
};

for (const name of MODELS) {
  // model id via REST filter (models table readable with service role)
  const res = await fetch(`${URL_}/rest/v1/models?select=id&name=eq.${name}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  const models = await res.json();
  const id = models?.[0]?.id;
  if (!id) { console.log(`${name}: model not found, skipping`); continue; }
  let total = 0;
  for (;;) {
    const n = await rest('/rest/v1/rpc/translation_assign_row_ids', { p_model_id: id, p_limit: 100 });
    total += n ?? 0;
    if (!n) break;
  }
  console.log(`${name}: ${total} records updated`);
}
console.log('done.');
