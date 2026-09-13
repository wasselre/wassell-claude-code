/**
 * Mint the two short-lived sessions the workflow e2e needs, and revoke them.
 *
 *   node scripts/mint-workflow-tokens.mjs          # mint
 *   node scripts/mint-workflow-tokens.mjs --revoke # revoke + delete the files
 *
 * The engine RPCs gate on `auth.uid()`, which service_role does not have, so
 * the workflow half has to run as real people or it tests a path nobody takes.
 * Tokens land in gitignored `.wf-token*.local` files.
 *
 * Revocation uses `scope=local` — NEVER `global`, which would sign the real
 * person out of their own sessions.
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
const BASE = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
if (!BASE || !SERVICE || !ANON) { console.error('missing SUPABASE env'); process.exit(2); }

/** Deliberately NOT an admin account for the writer: an admin bypasses
 *  `wassell_mos_can`, so testing as one would prove nothing about capabilities. */
const TARGETS = [
  { file: '.wf-token.local', email: 'm.ansary@wassel.re', role: 'writer' },
  { file: '.wf-token-mgr.local', email: 'r.abanumay@wassel.re', role: 'marketing manager' },
];

async function mint({ file, email, role }) {
  const g = await fetch(`${BASE}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const gj = await g.json();
  if (!gj.hashed_token) throw new Error(`generate_link for ${email}: ${JSON.stringify(gj).slice(0, 200)}`);
  const v = await fetch(`${BASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: gj.hashed_token }),
  });
  const vj = await v.json();
  if (!vj.access_token) throw new Error(`verify for ${email}: ${JSON.stringify(vj).slice(0, 200)}`);
  writeFileSync(file, vj.access_token, 'utf8');
  console.log(`minted ${role} (${email}) → ${file}`);
}

async function revoke({ file, email, role }) {
  if (!existsSync(file)) { console.log(`no ${file}`); return; }
  const token = readFileSync(file, 'utf8').trim();
  const r = await fetch(`${BASE}/auth/v1/logout?scope=local`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  unlinkSync(file);
  console.log(`revoked ${role} (${email}) — HTTP ${r.status}, ${file} deleted`);
}

const run = process.argv.includes('--revoke') ? revoke : mint;
for (const t of TARGETS) await run(t);
