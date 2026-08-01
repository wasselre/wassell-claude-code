#!/usr/bin/env node
/**
 * apply-branch-bootstrap.mjs
 * ---------------------------------------------------------------------------
 * Applies supabase/branch-bootstrap-*.sql (in order) to a disposable Supabase
 * BRANCH database through the token-gated RPC `public.mos_bootstrap_exec`
 * (created on the branch by the bootstrap operator — see
 * docs/marketing-reference/branch-bootstrap-report.md for the exact setup SQL).
 *
 * Never point this at production. The exec RPC only exists on branches.
 *
 * Config (env vars or a git-ignored .mos-branch.local file in the repo root
 * with KEY=VALUE lines):
 *   MOS_BRANCH_URL        e.g. https://<branch_ref>.supabase.co
 *   MOS_BRANCH_ANON_KEY   the branch's anon/publishable key
 *   MOS_BOOTSTRAP_TOKEN   the token baked into mos_bootstrap_exec
 *
 * Usage:
 *   node scripts/apply-branch-bootstrap.mjs            # apply all files
 *   node scripts/apply-branch-bootstrap.mjs --from 5   # start at file 05
 *   node scripts/apply-branch-bootstrap.mjs --only 13  # apply a single file
 * ---------------------------------------------------------------------------
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(__dirname, '..');
const SQL_DIR = join(WORKTREE, 'supabase');

function loadLocal() {
  const out = {};
  for (const f of [join(WORKTREE, '.mos-branch.local')]) {
    let txt; try { txt = readFileSync(f, 'utf8'); } catch { continue; } // optional config file
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
const LOCAL = loadLocal();
const URL_ = process.env.MOS_BRANCH_URL || LOCAL.MOS_BRANCH_URL;
const KEY = process.env.MOS_BRANCH_ANON_KEY || LOCAL.MOS_BRANCH_ANON_KEY;
const TOKEN = process.env.MOS_BOOTSTRAP_TOKEN || LOCAL.MOS_BOOTSTRAP_TOKEN;
if (!URL_ || !KEY || !TOKEN) { console.error('FATAL: MOS_BRANCH_URL / MOS_BRANCH_ANON_KEY / MOS_BOOTSTRAP_TOKEN missing'); process.exit(1); }

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : null; };
const FROM = flag('--from'), ONLY = flag('--only');

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

const filesAll = readdirSync(SQL_DIR).filter(f => /^branch-bootstrap-\d+\.sql$/.test(f)).sort();
const files = filesAll.filter(f => {
  const n = Number(f.match(/(\d+)/)[1]);
  if (ONLY !== null) return n === ONLY;
  if (FROM !== null) return n >= FROM;
  return true;
});
console.log(`applying ${files.length} file(s) to ${URL_}`);

for (const f of files) {
  const sql = readFileSync(join(SQL_DIR, f), 'utf8');
  const t0 = Date.now();
  process.stdout.write(`  ${f} (${(sql.length / 1024).toFixed(0)} KB) ... `);
  try {
    await exec(sql);
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.log('FAILED');
    console.error(String(e.message).slice(0, 3000));
    process.exit(1);
  }
}
console.log('done');
