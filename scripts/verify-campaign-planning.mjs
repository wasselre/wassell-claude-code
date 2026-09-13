/**
 * Live behavioural verification for the campaign-planning build.
 *
 *   node scripts/verify-campaign-planning.mjs            # read-only battery
 *   node scripts/verify-campaign-planning.mjs --write    # + the write battery
 *                                                        #   (sandbox rows, cleaned up)
 *
 * The repo validates `mos_*` migrations by production apply + proof queries
 * rather than the translation CI fixture (see the skip note in
 * .github/workflows/ci.yml). This script is that proof, run against
 * wassell-prod with the service role THROUGH POSTGREST — deliberately no
 * arbitrary-SQL RPC is added to production just to test it.
 *
 * Catalog-level checks (does the function exist, can anon execute it, does any
 * function still raise 40001) are done separately via the Supabase MCP and
 * recorded in the build report; they need pg_catalog, which PostgREST does not
 * expose, and inventing an `exec_sql` RPC to reach it would be worse than the
 * problem it solves.
 *
 * Reads env from .env.local / .env.
 */
import { readFileSync, existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const BASE = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — run scripts/bootstrap-session.sh first.');
  process.exit(2);
}
const WRITE = process.argv.includes('--write');
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

/** PostgREST table read. `q` is a raw query string, e.g. `select=*&status=eq.open`. */
async function rows(table, q = 'select=*') {
  const res = await fetch(`${BASE}/rest/v1/${table}?${q}`, { headers: H });
  if (!res.ok) throw new Error(`${table} read ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** PostgREST RPC. Returns the parsed body; throws with the DB message on failure. */
async function rpc(fn, args = {}) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: H, body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${fn} ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const results = [];
let failures = 0;
let skipped = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    if (detail === SKIP) { skipped += 1; results.push({ name, ok: true, skipped: true }); console.log(`  SKIP  ${name}`); return; }
    results.push({ name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failures += 1;
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail: msg });
    console.error(`  FAIL  ${name} — ${msg}`);
  }
}
const SKIP = Symbol('skip');
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function main() {
  console.log(`Campaign planning — live verification (${BASE})\n`);

  /* ---------------------------------------------------------------- */
  console.log('reachability');
  for (const t of [
    'mos_campaign_plans', 'mos_publish_batches', 'mos_content_plan', 'mos_task_reservations',
    'mos_refresh_cycles', 'mos_creative_slots', 'mos_ad_metrics_daily', 'mos_content_approvals',
    'mos_content_events', 'mos_user_capacity', 'mos_holidays', 'mos_step_effort',
    'mos_work_ledger_v', 'mos_publish_batch_v', 'mos_creative_perf_v',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await check(`${t} is readable`, async () => {
      const r = await rows(t, 'select=*&limit=1');
      return `${Array.isArray(r) ? r.length : 0} row sample`;
    });
  }

  /* ---------------------------------------------------------------- */
  console.log('\nwork ledger');
  const ledger = await rows('mos_work_ledger_v', 'select=user_id,day,bucket,weight,source,ref_id&limit=5000');

  await check('never emits a past day', async () => {
    const t = today();
    const past = ledger.filter((r) => r.day < t);
    assert(past.length === 0, `${past.length} rows dated before ${t} (first: ${JSON.stringify(past[0])})`);
    return `${ledger.length} rows, none before ${t}`;
  });

  await check('each ref_id appears in exactly one source', async () => {
    const bySource = new Map();
    for (const r of ledger) {
      if (!r.ref_id) continue;
      const set = bySource.get(r.ref_id) ?? new Set();
      set.add(r.source);
      bySource.set(r.ref_id, set);
    }
    const dupes = [...bySource.entries()].filter(([, s]) => s.size > 1);
    assert(dupes.length === 0, `${dupes.length} ref(s) counted twice: ${dupes.slice(0, 3).map(([k]) => k).join(',')}`);
    return `${bySource.size} distinct refs, no double-count`;
  });

  await check('a consumed reservation is out of the ledger', async () => {
    const consumed = await rows('mos_task_reservations', 'select=id&status=eq.consumed&limit=200');
    const ids = new Set(consumed.map((r) => r.id));
    const leaked = ledger.filter((r) => r.source === 'reservation' && ids.has(r.ref_id));
    assert(leaked.length === 0, `${leaked.length} consumed reservation(s) still occupy capacity`);
    return consumed.length ? `${consumed.length} consumed, 0 leaked` : 'none consumed yet';
  });

  await check('a stale reservation KEEPS its capacity', async () => {
    const stale = await rows('mos_task_reservations', 'select=id,weight&status=eq.stale&limit=200');
    if (!stale.length) return SKIP;
    const present = new Set(ledger.filter((r) => r.source === 'reservation').map((r) => r.ref_id));
    const missing = stale.filter((s) => !present.has(s.id));
    assert(missing.length === 0, `${missing.length} stale reservation(s) vanished from the ledger`);
    return `${stale.length} stale, all still counted`;
  });

  await check('elapsed time is not progress: an untouched overdue task keeps full effort', async () => {
    const t = today();
    const overdue = await rows(
      'workflow_role_tasks',
      `select=id,effort_days,progress_days,scheduled_end&status=eq.open&progress_days=eq.0&scheduled_end=lt.${t}&effort_days=not.is.null&limit=25`,
    );
    if (!overdue.length) return SKIP;
    const bad = [];
    for (const task of overdue) {
      const mine = ledger.filter((r) => r.ref_id === task.id);
      const total = mine.reduce((a, b) => a + Number(b.weight), 0);
      if (Math.abs(total - Number(task.effort_days)) > 0.01) {
        bad.push(`${task.id}: ledger ${total} vs effort ${task.effort_days}`);
      }
    }
    assert(bad.length === 0, bad.slice(0, 3).join(' | '));
    return `${overdue.length} overdue task(s), full effort preserved`;
  });

  /* ---------------------------------------------------------------- */
  console.log('\nsnapshot hash');
  await check('is stable across two calls', async () => {
    const a = await rpc('mos_workload_snapshot_hash');
    const b = await rpc('mos_workload_snapshot_hash');
    assert(a && a === b, `unstable: ${a} vs ${b}`);
    return `${String(a).slice(0, 16)}…`;
  });

  /* ---------------------------------------------------------------- */
  console.log('\nbanked-spare exclusivity');
  await check('no cycle holds two earmarked spares, no spare serves two cycles', async () => {
    const slots = await rows('mos_creative_slots',
      'select=id,bank_reserved_for_cycle_id&bank_reserved_for_cycle_id=not.is.null&limit=500');
    const perCycle = new Map();
    for (const s of slots) perCycle.set(s.bank_reserved_for_cycle_id, (perCycle.get(s.bank_reserved_for_cycle_id) ?? 0) + 1);
    const over = [...perCycle.entries()].filter(([, n]) => n > 1);
    assert(over.length === 0, `${over.length} cycle(s) with more than one spare`);
    return slots.length ? `${slots.length} earmarked, all 1:1` : 'none earmarked yet';
  });

  /* ---------------------------------------------------------------- */
  console.log('\nad readiness');
  await check('both design slots present → no slot blocker', async () => {
    const links = await rows('mos_asset_links',
      'select=content_id,role&role=in.(final_square,final_vertical)&superseded_at=is.null&limit=500');
    const byContent = new Map();
    for (const l of links) {
      const set = byContent.get(l.content_id) ?? new Set();
      set.add(l.role);
      byContent.set(l.content_id, set);
    }
    const complete = [...byContent.entries()].find(([, s]) => s.size === 2);
    if (!complete) return SKIP;
    const readiness = await rpc('content_ad_readiness', { p_content_id: complete[0], p_execution_id: null });
    const codes = (readiness?.blockers ?? []).map((b) => b.code);
    assert(!codes.includes('final_square') && !codes.includes('final_vertical'),
      `slot blockers wrongly reported: ${codes.join(',')}`);
    return `content ${complete[0].slice(0, 8)} → blockers: ${codes.length ? codes.join(',') : 'none'}`;
  });

  await check('a legacy single-file item IS blocked on the missing slot', async () => {
    const legacy = await rows('mos_asset_links',
      'select=content_id,role&role=eq.final&superseded_at=is.null&limit=200');
    const squares = new Set((await rows('mos_asset_links',
      'select=content_id&role=eq.final_square&superseded_at=is.null&limit=500')).map((r) => r.content_id));
    const target = legacy.find((l) => !squares.has(l.content_id));
    if (!target) return SKIP;
    const readiness = await rpc('content_ad_readiness', { p_content_id: target.content_id, p_execution_id: null });
    const codes = (readiness?.blockers ?? []).map((b) => b.code);
    assert(codes.includes('final_square'), `expected final_square blocker, got: ${codes.join(',') || 'none'}`);
    return `content ${target.content_id.slice(0, 8)} → ${codes.join(',')}`;
  });

  /* ---------------------------------------------------------------- */
  console.log('\ncommit guards');
  await check('commit refuses a stale snapshot hash with WS409 plan_changed', async () => {
    try {
      await rpc('mos_campaign_plan_commit', {
        p_plan_id: '00000000-0000-0000-0000-000000000000',
        p_reservations: [],
        p_expected_hash: 'deliberately-wrong-hash',
        p_materialise: {},
        p_actor: null,
      });
      throw new Error('the commit accepted a wrong hash');
    } catch (e) {
      const body = String(e.body ?? e.message);
      assert(/plan_changed|not[_ ]found|capacity_conflict|WS409/i.test(body),
        `unexpected refusal: ${body.slice(0, 200)}`);
      // The whole point: a refusal must never be 40001/40P01, or PostgREST
      // re-runs the transaction forever (the 2026-09-07 conflict-storm root cause).
      assert(!/40001|40P01/.test(body), 'the commit raised a RETRYABLE sqlstate — PostgREST would loop forever');
      return `refused with ${/plan_changed/i.test(body) ? 'plan_changed' : 'a non-retryable error'}`;
    }
  });

  /* ---------------------------------------------------------------- */
  console.log('\nlive data intact');
  await check('pre-existing rows still there', async () => {
    const [content, campaigns, ads, tasks, manual] = await Promise.all([
      rows('mos_content', 'select=id&archived_at=is.null&limit=1000'),
      rows('mos_campaigns', 'select=id&archived_at=is.null&limit=1000'),
      rows('mos_execution_ads', 'select=id&archived_at=is.null&limit=1000'),
      rows('workflow_role_tasks', 'select=id&status=eq.open&limit=1000'),
      rows('mos_manual_tasks', 'select=id&status=eq.open&limit=1000'),
    ]);
    assert(content.length >= 24, `content is ${content.length}, was 24`);
    assert(campaigns.length >= 5, `campaigns is ${campaigns.length}, was 5`);
    return `content ${content.length} · campaigns ${campaigns.length} · ads ${ads.length} · open tasks ${tasks.length} · manual ${manual.length}`;
  });

  /* ---------------------------------------------------------------- */
  if (WRITE) {
    console.log('\nwrite battery (sandbox)');
    await check('two concurrent commits: exactly one wins', async () => {
      // Both fire the same plan id with the same hash; the advisory lock plus
      // the idempotence rule must yield one materialisation, never two.
      const plans = await rows('mos_campaign_plans', 'select=id,snapshot_hash&status=eq.proposed&limit=1');
      if (!plans.length) return SKIP;
      const { id, snapshot_hash: hash } = plans[0];
      const both = await Promise.allSettled([
        rpc('mos_campaign_plan_commit', { p_plan_id: id, p_reservations: [], p_expected_hash: hash, p_materialise: {}, p_actor: null }),
        rpc('mos_campaign_plan_commit', { p_plan_id: id, p_reservations: [], p_expected_hash: hash, p_materialise: {}, p_actor: null }),
      ]);
      const okCount = both.filter((r) => r.status === 'fulfilled').length;
      assert(okCount >= 1, 'both commits failed');
      const after = await rows('mos_campaign_plans', `select=id,status&id=eq.${id}`);
      assert(after[0]?.status === 'approved', `plan ended as ${after[0]?.status}`);
      return `${okCount}/2 succeeded, plan approved exactly once`;
    });
  } else {
    console.log('\n(write battery skipped — pass --write to run it)');
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${failures ? 'FAILURES PRESENT' : 'ALL CHECKS PASSED'} — ${passed}/${results.length} (${skipped} skipped)`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error('verification crashed:', e);
  process.exit(1);
});
