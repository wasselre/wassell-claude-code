#!/usr/bin/env node
/**
 * Headless DB access for client-study sessions.
 *
 *   node .claude/skills/client-study/assets/db_query.mjs "SELECT ... "
 *
 * Runs ONE read-only SQL statement through the `claude_runner_sql` RPC
 * (service-role; migration 2026-07-23) and prints the rows as JSON. Use this
 * when the interactive Supabase MCP is unavailable (headless runner sessions —
 * the MCP needs a claude.ai OAuth flow that can't happen without a human).
 *
 * Credentials come from the repo's .env.local / .env (SUPABASE_URL or
 * VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Read-only is enforced
 * server-side; writes will error.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// assets/ → client-study/ → skills/ → .claude/ → repo root
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sql = process.argv[2];

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found (repo .env.local)');
  process.exit(1);
}
if (!sql || !sql.trim()) {
  console.error('ERROR: pass the SQL as the first argument');
  process.exit(1);
}

const supa = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await supa.rpc('claude_runner_sql', { p_sql: sql });
if (error) {
  console.error('SQL ERROR: ' + error.message);
  process.exit(2);
}
console.log(JSON.stringify(data, null, 1));
