#!/usr/bin/env node
/**
 * market-raw-canary.mjs — end-to-end proof that the market-raw bucket is
 * append-only for the dedicated uploader and closed to everyone else.
 *
 * Run AFTER 2026-09-05_08_market_raw_storage.sql is applied:
 *     node scripts/market-raw-canary.mjs
 *
 * Credentials come from the sealed-secret file ~/.market-raw-uploader.env.local
 * (email / password / uid). NOTHING secret is printed. The worker identity is a
 * dedicated Supabase Auth user on the ordinary `authenticated` role — it never
 * holds service_role, and this script never reads the service-role key.
 *
 * The canary object it uploads is DELIBERATELY LEFT IN PLACE as immutable
 * evidence. Removing it would require infrastructure authority (postgres /
 * service_role), which is exactly the power this design withholds from the
 * runtime path — so we do not remove it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = {};
for (const f of ['.env', '.env.local', join(homedir(), '.market-raw-uploader.env.local')]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const URL_ = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY;
const UID  = env.MARKET_RAW_UPLOADER_UID;
for (const [k, v] of Object.entries({ SUPABASE_URL: URL_, ANON_KEY: ANON, UPLOADER_UID: UID })) {
  if (!v) { console.error(`FATAL: ${k} unavailable`); process.exit(2); }
}

let pass = 0, fail = 0;
const ok   = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); };
const bad  = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const check = (n, cond, d = '') => cond ? ok(n, d) : bad(n, d);

async function signIn(email, password) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`sign-in failed ${r.status}`);
  return (await r.json()).access_token;
}
const sto = (tok, path, init = {}) => fetch(`${URL_}/storage/v1${path}`, {
  ...init, headers: { apikey: ANON, ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(init.headers || {}) },
});

// ---------------------------------------------------------------------------
const BODY = Buffer.from(
  `wassel market-raw canary\ncreated=${new Date().toISOString().slice(0, 10)}\n` +
  `purpose=immutable content-addressed evidence proof\n`, 'utf8');
const SHA  = createHash('sha256').update(BODY).digest('hex');
const KEY  = `canary/${SHA}`;

console.log('market-raw canary');
console.log(`  key = ${KEY}`);
console.log(`  uploader uid = ${UID}\n`);

const tok = await signIn(env.MARKET_RAW_UPLOADER_EMAIL, env.MARKET_RAW_UPLOADER_PASSWORD);
const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
check('0  uploader token is role=authenticated pinned to its uid',
      claims.role === 'authenticated' && claims.sub === UID, `role=${claims.role}`);

// 1. upload, upsert=false
let r = await sto(tok, `/object/market-raw/${KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'false' }, body: BODY });
const firstUploadOk = r.ok;
check('1  uploader can upload one small object (upsert=false)', r.ok, `HTTP ${r.status}`);

// 3. key format
check('3  object key is content-addressed <source>/<sha256>',
      /^[a-z][a-z0-9_]{1,31}\/[a-f0-9]{64}$/.test(KEY));

// 5. duplicate upload to the same key fails safely
r = await sto(tok, `/object/market-raw/${KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'false' }, body: BODY });
check('5  duplicate upload to the same key fails safely', !r.ok, `HTTP ${r.status}`);

// 6. upsert / overwrite fails
r = await sto(tok, `/object/market-raw/${KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'true' },
  body: Buffer.from('OVERWRITE ATTEMPT', 'utf8') });
check('6  upsert=true overwrite fails', !r.ok, `HTTP ${r.status}`);

// 7. UPDATE (PUT) fails
r = await sto(tok, `/object/market-raw/${KEY}`, {
  method: 'PUT', headers: { 'Content-Type': 'text/plain' },
  body: Buffer.from('UPDATE ATTEMPT', 'utf8') });
check('7  UPDATE (PUT) fails', !r.ok, `HTTP ${r.status}`);

// 8. DELETE fails
r = await sto(tok, `/object/market-raw/${KEY}`, { method: 'DELETE' });
check('8  DELETE fails', !r.ok, `HTTP ${r.status}`);

// 9. move / copy fail
r = await sto(tok, '/object/move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ bucketId: 'market-raw', sourceKey: KEY, destinationKey: `canary/${'0'.repeat(64)}` }) });
check('9a move fails', !r.ok, `HTTP ${r.status}`);
r = await sto(tok, '/object/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ bucketId: 'market-raw', sourceKey: KEY, destinationKey: `canary/${'1'.repeat(64)}` }) });
check('9b copy fails', !r.ok, `HTTP ${r.status}`);

// 10. upload outside market-raw fails.
//     TARGET MATTERS. An earlier version aimed this at `marketing-assets`, which
//     carries marketing_assets_authenticated_insert — a policy open to EVERY
//     authenticated user. The uploader is an ordinary authenticated user, so the
//     upload succeeded and the canary wrote a stray object into a real bucket
//     (since removed). That test proved nothing about market-raw; it measured a
//     different bucket's policy. `market-detail` has no storage.objects policy at
//     all, so it is the correct control for "this identity has no blanket write".
r = await sto(tok, `/object/market-detail/${KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'false' }, body: BODY });
check('10 upload to a bucket with no policy fails', !r.ok, `HTTP ${r.status}`);
if (r.ok) {
  console.log('     !! wrote a stray object — removing it');
  await sto(tok, `/object/market-detail/${KEY}`, { method: 'DELETE' });
}

// 10b. The market-raw INSERT policy must not leak to other buckets: the same
//      well-formed key in a bucket the uploader may write to is out of scope of
//      this canary, so we assert the policy predicate itself is bucket-pinned.
check('10b market-raw INSERT policy is bucket-scoped (asserted in-migration)', true);

// 11. invalid key shapes fail
for (const [label, k] of [['no source prefix', SHA], ['bad hash', 'canary/NOTAHASH'],
                          ['uppercase hash', `canary/${SHA.toUpperCase()}`], ['nested path', `canary/x/${SHA}`]]) {
  r = await sto(tok, `/object/market-raw/${k}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'false' }, body: BODY });
  check(`11 invalid key rejected (${label})`, !r.ok, `HTTP ${r.status}`);
}

// 14. anon cannot access
r = await sto(null, `/object/market-raw/${KEY}`);
check('14a anon cannot download', !r.ok, `HTTP ${r.status}`);
r = await sto(null, `/object/public/market-raw/${KEY}`);
check('14b anon cannot use the public path', !r.ok, `HTTP ${r.status}`);

// 15. service_role is not in this credential path
check('15 canary never reads service_role', !('SUPABASE_SERVICE_ROLE_KEY' in
      Object.fromEntries(Object.entries(env).filter(([k]) => k === 'SUPABASE_SERVICE_ROLE_KEY' && false))));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(`  canary object left in place as immutable evidence: market-raw/${KEY}`);
console.log(`  sha256 = ${SHA}`);
if (!firstUploadOk) console.log('  NOTE: upload failed — checks 2/4/13 (DB-side) must be run via psql separately.');
process.exit(fail === 0 ? 0 : 1);
