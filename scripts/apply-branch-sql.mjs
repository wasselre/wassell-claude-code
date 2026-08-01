#!/usr/bin/env node
/**
 * apply-branch-sql.mjs — apply arbitrary SQL files to the mos-fixtures BRANCH
 * through the same token-gated `mos_bootstrap_exec` RPC the bootstrap applier
 * uses. Used to run the 2026-08-01 migration series (and later fixes) on the
 * branch during the Marketing OS build. Never point at production: the exec
 * RPC only exists on branches.
 *
 * Usage: node scripts/apply-branch-sql.mjs supabase/migrations/a.sql [b.sql...]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(__dirname, '..');

function loadLocal() {
  const out = {};
  let txt;
  try { txt = readFileSync(join(WORKTREE, '.mos-branch.local'), 'utf8'); } catch { return out; } // optional config file
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const LOCAL = loadLocal();
const URL_ = process.env.MOS_BRANCH_URL || LOCAL.MOS_BRANCH_URL;
const KEY = process.env.MOS_BRANCH_ANON_KEY || LOCAL.MOS_BRANCH_ANON_KEY;
const TOKEN = process.env.MOS_BOOTSTRAP_TOKEN || LOCAL.MOS_BOOTSTRAP_TOKEN;
if (!URL_ || !KEY || !TOKEN) {
  console.error('FATAL: MOS_BRANCH_URL / MOS_BRANCH_ANON_KEY / MOS_BOOTSTRAP_TOKEN missing');
  process.exit(1);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/apply-branch-sql.mjs <sql file> [...]');
  process.exit(1);
}

async function exec(sql) {
  const res = await fetch(`${URL_}/rest/v1/rpc/mos_bootstrap_exec`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: TOKEN, p_sql: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return body;
}

console.log(`applying ${files.length} file(s) to ${URL_}`);
for (const f of files) {
  const path = resolve(WORKTREE, f);
  // The exec RPC already runs in its own transaction and cannot EXECUTE
  // transaction commands — strip the file's OUTER BEGIN;/COMMIT; lines only
  // (DO-block BEGIN/END bodies don't match the line-anchored pattern).
  const sql = readFileSync(path, 'utf8')
    .replace(/^\s*BEGIN;\s*$/m, '')
    .replace(/^\s*COMMIT;\s*$/m, '');
  const t0 = Date.now();
  process.stdout.write(`  ${basename(path)} (${Math.round(sql.length / 1024)} KB) ... `);
  try {
    await exec(sql);
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.log('FAILED');
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}
console.log('done');
