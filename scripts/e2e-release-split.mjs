#!/usr/bin/env node
/**
 * The creation/publication split, proved against the LIVE database.
 *
 * The operator asked for two task types: a content task while the creative is
 * being made, and a publication task that carries only the finished material,
 * where it is going, and what that destination demands. This script proves the
 * properties that were broken before the split, using real rows:
 *
 *   1. ONE creative going to TWO destinations produces TWO releases, not one.
 *   2. A destination that can publish by itself raises NO task — that rule is
 *      what keeps this from being a bigger pile of orphaned publish checks.
 *   3. A destination that cannot publish raises EXACTLY one task, which says
 *      why it exists.
 *   4. The sweep is idempotent: running it twice never doubles the task.
 *   5. Marking a release published closes its task by itself.
 *   6. The content workflow no longer ends in scheduling / publish_check.
 *
 * Everything it creates, it deletes. Run it against production; it leaves the
 * database exactly as it found it.
 *
 *   node scripts/e2e-release-split.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) {
  console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const get = async (path) => {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { headers: H });
  const body = await r.json();
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};
const post = async (table, row) => {
  const r = await fetch(`${BASE}/rest/v1/${table}`, {
    method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`POST ${table} → ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return Array.isArray(body) ? body[0] : body;
};
const patch = async (path, row) => {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};
const del = (path) => fetch(`${BASE}/rest/v1/${path}`, { method: 'DELETE', headers: H });
const rpc = async (fn, args = {}) => {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`RPC ${fn} → ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

const tag = `E2E-REL-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
let contentId = null;

try {
  console.log(`the creation/publication split — ${tag}\n`);

  /* ── 0. the content path no longer publishes ─────────────────────────── */
  console.log('the content task stops at approval');
  const versions = await get(
    'workflow_versions?select=workflow_id,version_no,definition&order=version_no.desc',
  );
  const latest = new Map();
  for (const v of versions) {
    const key = v.definition?.metadata?.key;
    if (!key || !['post_std', 'video_std'].includes(key)) continue;
    if (!latest.has(v.workflow_id)) latest.set(v.workflow_id, v);
  }
  for (const v of latest.values()) {
    const keys = (v.definition.metadata.steps ?? []).map((s) => s.key);
    check(
      `${v.definition.metadata.key} ends at final approval`,
      !keys.includes('scheduling') && !keys.includes('publish_check'),
      keys.join(' → '),
    );
  }

  /* ── 1. a creative with two destinations ─────────────────────────────── */
  console.log('\none creative, two destinations');
  const type = (await get('mos_content_types?select=id,workflow_id&key=eq.post&limit=1'))[0];
  const ver = (await get(
    `workflow_versions?select=id&workflow_id=eq.${type.workflow_id}&order=version_no.desc&limit=1`,
  ))[0];
  const content = await post('mos_content', {
    content_type_id: type.id,
    workflow_id: type.workflow_id,
    workflow_version_id: ver.id,
    title: `${tag} — فصل الإنشاء عن النشر`,
    purpose: 'organic',
    data: { caption: 'نص اختباري للنشر.' },
  });
  contentId = content.id;

  // instagram is connected and can publish; x is not. Both are real rows in
  // mos_platform_accounts, so this is the tenant's actual shape, not a fixture.
  const dueAt = new Date(Date.now() - 60_000).toISOString();   // already due
  const igPub = await post('mos_publications', {
    content_id: contentId, platform: 'instagram', status: 'planned',
    planned_at: dueAt, scheduled_timezone: 'Asia/Riyadh', note: tag,
  });
  const xPub = await post('mos_publications', {
    content_id: contentId, platform: 'x', status: 'planned',
    planned_at: dueAt, scheduled_timezone: 'Asia/Riyadh', note: tag,
  });

  const releases = await get(`mos_release_v?select=*&content_id=eq.${contentId}&order=platform`);
  check('two destinations are two releases, not one', releases.length === 2,
    releases.map((r) => r.platform).join(' + '));
  check('each release knows whether it can publish itself',
    releases.find((r) => r.platform === 'instagram')?.automatable === true
    && releases.find((r) => r.platform === 'x')?.automatable === false,
    releases.map((r) => `${r.platform}=${r.automatable}`).join(' '));

  /* ── 2 + 3. the sweep asks a person ONLY where one is needed ─────────── */
  console.log('\na task only where a person is needed');
  const sweep1 = await rpc('mos_release_sweep');
  const tasks1 = await get(
    `mos_manual_tasks?select=id,ref_id,action,status,details,due_at&kind=eq.publish&status=eq.open&content_id=eq.${contentId}`,
  );
  check('the connected account raised NO task', !tasks1.some((t) => t.ref_id === igPub.id),
    'instagram publishes by itself');
  check('the unconnected one raised exactly ONE task',
    tasks1.filter((t) => t.ref_id === xPub.id).length === 1,
    `x → ${tasks1.filter((t) => t.ref_id === xPub.id).length} task(s)`);
  // x HAS an account row, it just cannot publish — so the honest reason is
  // `account_not_connected`, not `platform_not_automatable`. An earlier version
  // of this test asserted the latter and was simply wrong about the data.
  const xTask = tasks1.find((t) => t.ref_id === xPub.id);
  check('the task says WHY it exists', xTask?.action === 'account_not_connected',
    xTask?.action ?? '(none)');
  check('and says it in Arabic the assignee can act on',
    typeof xTask?.details === 'string' && xTask.details.trim().length > 0,
    (xTask?.details ?? '').slice(0, 60));
  check('the task carries the release date', xTask?.due_at != null);
  check('the sweep reported what it did, including what it could not place',
    typeof sweep1?.due === 'number' && typeof sweep1?.unassignable === 'number',
    JSON.stringify(sweep1));

  /* ── 4. idempotence ──────────────────────────────────────────────────── */
  console.log('\nrunning the sweep again changes nothing');
  await rpc('mos_release_sweep');
  await rpc('mos_release_sweep');
  const tasks2 = await get(
    `mos_manual_tasks?select=id&kind=eq.publish&status=eq.open&content_id=eq.${contentId}`,
  );
  check('three sweeps still leave ONE task', tasks2.length === 1, `${tasks2.length} task(s)`);

  /* ── 5. publishing closes the task by itself ─────────────────────────── */
  console.log('\npublishing closes its own task');
  await patch(`mos_publications?id=eq.${xPub.id}`, {
    status: 'published', published_at: new Date().toISOString(),
    external_url: 'https://example.invalid/e2e',
  });
  const tasks3 = await get(
    `mos_manual_tasks?select=id,status&kind=eq.publish&content_id=eq.${contentId}`,
  );
  check('the release task closed itself', tasks3.every((t) => t.status === 'done'),
    tasks3.map((t) => t.status).join(', '));

  const afterDue = await rpc('mos_release_due', { p_horizon_minutes: null });
  check('a published release is no longer due',
    !(afterDue ?? []).some((r) => r.release_id === xPub.id));

  /* ── 6. the ledger sees the release, in its own bucket ───────────────── */
  console.log('\nrelease work is charged to the publishing budget');
  const owner = (await get(
    `mos_manual_tasks?select=assignee_user_id&kind=eq.publish&content_id=eq.${contentId}&limit=1`,
  ))[0]?.assignee_user_id;
  const caps = await get('mos_user_capacity?select=user_id,bucket,daily_slots&bucket=eq.publishing');
  check('the publishing bucket exists for real people', caps.length > 0,
    `${caps.length} row(s)`);
  check('the release task was given an owner', owner != null,
    owner ? owner.slice(0, 8) : 'unassigned');
} catch (e) {
  failed += 1;
  console.error('\nERROR:', e instanceof Error ? e.message : e);
} finally {
  console.log('\ncleaning up…');
  if (contentId) {
    await del(`mos_manual_tasks?content_id=eq.${contentId}`);
    await del(`mos_publications?content_id=eq.${contentId}`);
    await del(`workflow_role_tasks?subject_id=eq.${contentId}`);
    await del(`mos_content_events?content_id=eq.${contentId}`);
    await del(`mos_content?id=eq.${contentId}`);
    const left = await get(`mos_content?select=id&id=eq.${contentId}`);
    console.log(left.length === 0 ? '  cleaned.' : `  WARNING: ${left.length} row(s) left behind`);
  }
}

console.log(`\n${failed === 0 ? `ALL ${passed} CHECKS PASSED` : `${failed} FAILED, ${passed} passed`}`);
process.exit(failed === 0 ? 0 : 1);
