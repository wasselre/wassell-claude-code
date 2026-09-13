/**
 * The concurrency proof the second review asked for:
 * **two campaign approvals cannot both book the same remaining designer day.**
 *
 *   npx vite-node scripts/e2e-concurrent-commit.ts
 *
 * Method: plan TWO separate campaigns against the SAME live snapshot, each
 * needing the same scarce designer capacity, then fire both commits at once.
 * Exactly one must materialise; the other must be refused with WS409 (either
 * `plan_changed`, because the first commit moved the hash, or
 * `capacity_conflict`, because the independent SQL re-check caught it) — and
 * never with a retryable sqlstate, which PostgREST would re-run forever.
 *
 * Both campaigns are namespaced `CONC-<timestamp>` and deleted at the end.
 */
import { readFileSync, existsSync } from 'node:fs';
import { planCampaign, type PlanInput, type PlanResult, type WorkloadSnapshot, type LoadBucket, type PathRole, type PersonCapacity, type LedgerRow } from '../src/lib/marketingOS/scheduling/index.js';
import { DEFAULT_CALENDAR } from '../src/lib/marketingOS/scheduling/calendar.js';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
}
const BASE = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!BASE || !KEY) { console.error('missing SUPABASE env'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function get<T>(table: string, q: string): Promise<T[]> {
  const r = await fetch(`${BASE}/rest/v1/${table}?${q}`, { headers: H });
  if (!r.ok) throw new Error(`${table} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json() as Promise<T[]>;
}
async function post<T>(table: string, body: unknown): Promise<T[]> {
  const r = await fetch(`${BASE}/rest/v1/${table}`, {
    method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${table} insert ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}
async function del(table: string, q: string): Promise<void> {
  await fetch(`${BASE}/rest/v1/${table}?${q}`, { method: 'DELETE', headers: H });
}
async function rpcRaw(fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  return { ok: r.ok, status: r.status, body: await r.text() };
}

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function loadSnapshot(): Promise<WorkloadSnapshot> {
  const [roles, users, caps, roleLoad, leaves, ledgerRows, holidays] = await Promise.all([
    get<{ id: string; key: string }>('roles', 'select=id,key&domain=eq.marketing'),
    get<{ id: string; role_assignments: unknown }>('users', 'select=id,role_assignments&is_active=is.true'),
    get<{ user_id: string; bucket: string; daily_slots: number }>('mos_user_capacity', 'select=*'),
    get<{ role_id: string; bucket: string; daily_new_tasks: number }>('mos_role_load', 'select=*'),
    get<{ user_id: string; start_at: string; end_at: string }>('mos_leaves', 'select=user_id,start_at,end_at&status=eq.approved'),
    get<{ user_id: string; day: string; bucket: string; weight: number; source: string; ref_id: string | null }>('mos_work_ledger_v', 'select=*&limit=5000'),
    get<{ day: string }>('mos_holidays', 'select=day'),
  ]);
  const rr = await fetch(`${BASE}/rest/v1/rpc/mos_workload_snapshot_hash`, { method: 'POST', headers: H, body: '{}' });
  const hash = JSON.parse(await rr.text()) as string;

  const keyById = new Map(roles.map((r) => [r.id, r.key.replace(/^mos_/, '') as PathRole]));
  const idByKey = new Map(roles.map((r) => [r.key.replace(/^mos_/, '') as PathRole, r.id]));
  const load = new Map(roleLoad.map((r) => [`${r.role_id}|${r.bucket}`, r.daily_new_tasks]));
  const over = new Map(caps.map((c) => [`${c.user_id}|${c.bucket}`, c.daily_slots]));
  const leaveBy = new Map<string, Array<{ from: string; to: string }>>();
  for (const l of leaves) {
    const a = leaveBy.get(l.user_id) ?? [];
    a.push({ from: l.start_at.slice(0, 10), to: l.end_at.slice(0, 10) });
    leaveBy.set(l.user_id, a);
  }
  const people: PersonCapacity[] = [];
  for (const u of users) {
    const held: PathRole[] = [];
    for (const a of (Array.isArray(u.role_assignments) ? u.role_assignments : []) as Array<{ role_id?: string }>) {
      const k = a?.role_id ? keyById.get(a.role_id) : undefined;
      if (k && !held.includes(k)) held.push(k);
    }
    if (!held.length) continue;
    const c: Partial<Record<LoadBucket, number>> = { approvals: over.get(`${u.id}|approvals`) ?? 20 };
    for (const b of ['post', 'video'] as const) {
      c[b] = over.get(`${u.id}|${b}`) ?? Math.max(0, ...held.map((r) => load.get(`${idByKey.get(r)}|${b}`) ?? 0));
    }
    people.push({ userId: u.id, roles: held, caps: c, leaves: leaveBy.get(u.id) ?? [] });
  }
  people.sort((a, b) => (a.userId < b.userId ? -1 : 1));
  const ledger: LedgerRow[] = ledgerRows.filter((r) => r.day >= today).map((r) => ({
    userId: r.user_id, day: r.day,
    bucket: (['post', 'video', 'approvals'].includes(r.bucket) ? r.bucket : 'post') as LoadBucket,
    weight: Number(r.weight) || 0,
    source: (r.source === 'reservation' || r.source === 'manual' ? r.source : 'task') as LedgerRow['source'],
    refId: r.ref_id,
  }));
  return { today, calendar: { ...DEFAULT_CALENDAR, holidays: holidays.map((h) => h.day) }, people, ledger, hash };
}

function materialise(input: PlanInput, plan: PlanResult): Record<string, unknown> {
  return {
    campaign_id: input.campaignId, kind: input.kind,
    range_start: input.rangeStart, range_end: input.rangeEnd, cross_post: false,
    executions: input.platforms.map((p) => ({
      key: `exec:${p}`, platform: p, execution_id: null,
      publishing_rules: input.frequency.find((f) => f.platform === p) ?? null,
    })),
    items: plan.items.map((i) => ({
      key: i.key, title: i.title, content_type_key: i.contentTypeKey, project_id: i.projectId,
      workflow_key: i.workflowKey, need_at: i.needAt, required_ready_at: i.requiredReadyAt,
      production_start: i.productionStart, priority: i.priority,
      stage_deadlines: Object.fromEntries(i.stages.map((s) => [s.stepKey, s.deadline])),
      stage_assignees: Object.fromEntries(i.stages.map((s) => [s.stepKey, s.assigneeUserId])),
      placements: i.placements.map((p) => ({
        platform: p.platform, execution_key: p.executionKey, planned_at: p.plannedAt, day: p.day,
        batch_key: p.batchKey, slot_index: p.slotIndex, grid_row: p.gridRow, grid_col: p.gridCol,
      })),
      slot: null,
    })),
    batches: plan.batches.map((b) => ({
      key: b.key, execution_key: b.executionKey, platform: b.platform,
      day: b.day, sequence: b.sequence, item_keys: b.itemKeys,
    })),
    cycles: [],
  };
}
const reservationsOf = (plan: PlanResult): unknown[] => plan.reservations.map((r) => ({
  item_key: r.itemKey, step_key: r.stepKey, role_key: r.roleKey, bucket: r.bucket,
  assignee_user_id: r.assigneeUserId, planned_start: r.plannedStart,
  planned_end: r.plannedEnd, weight: r.weight,
}));

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  console.log(`concurrent commit — CONC-${stamp}\n`);

  const projects = await get<{ id: string }>('unified_records', 'select=id&limit=3&order=created_at.desc');
  const pids = projects.map((p) => p.id);
  if (pids.length < 3) throw new Error('need 3 records to stand in as projects');

  // Two campaigns, same tight publishing day → the same designer days.
  const day = addDays(today, 14);
  const made: Array<{ campaignId: string; planId: string; plan: PlanResult; input: PlanInput }> = [];

  const snapshot = await loadSnapshot();
  console.log(`  one shared snapshot: ${snapshot.ledger.length} ledger rows · hash ${snapshot.hash.slice(0, 12)}…`);

  for (const n of [1, 2]) {
    const [c] = await post<{ id: string; ref: string }>('mos_campaigns', {
      name: `🧪 CONC-${stamp}-${n} — concurrency probe`,
      kind: 'organic', status: 'planning', project_ids: pids, project_id: pids[0],
      note: 'created by scripts/e2e-concurrent-commit.ts — safe to delete',
    });
    if (!c) throw new Error('campaign insert failed');
    const input: PlanInput = {
      campaignId: c.id, kind: 'organic',
      projects: pids.map((id, i) => ({ projectId: id, projectName: `P${i + 1}`, posts: 1, videos: 0 })),
      platforms: ['instagram'], rangeStart: day, rangeEnd: day,
      frequency: [{ platform: 'instagram', perDay: 3, weekdays: null }],
      crossPost: false, publishBufferDays: 1,
    };
    // BOTH plan against the SAME snapshot — neither can see the other.
    const plan = planCampaign(input, snapshot);
    if (!plan.feasible) throw new Error(`campaign ${n} not feasible: ${plan.conflicts.map((x) => x.messageEn).join('; ')}`);
    const [row] = await post<{ id: string }>('mos_campaign_plans', {
      campaign_id: c.id, status: 'proposed', input, plan,
      feasibility: { feasible: true }, snapshot_hash: plan.snapshotHash, engine_version: plan.engineVersion,
    });
    if (!row) throw new Error('plan insert failed');
    made.push({ campaignId: c.id, planId: row.id, plan, input });
    console.log(`  campaign ${n}: ${c.ref} · plan ${row.id.slice(0, 8)} · ${plan.reservations.length} reservations, same hash`);
  }

  console.log('\n  firing both commits at the same instant…');
  const [a, b] = await Promise.all(made.map((m) => rpcRaw('mos_campaign_plan_commit', {
    p_plan_id: m.planId,
    p_reservations: reservationsOf(m.plan),
    p_expected_hash: m.plan.snapshotHash,
    p_materialise: materialise(m.input, m.plan),
    p_actor: null,
  })));
  const results = [a!, b!];
  results.forEach((r, i) => {
    console.log(`  commit ${i + 1}: HTTP ${r.status} ${r.ok ? 'OK' : r.body.slice(0, 120).replace(/\s+/g, ' ')}`);
  });

  const winners = results.filter((r) => r.ok).length;
  const problems: string[] = [];
  if (winners !== 1) problems.push(`expected exactly 1 winner, got ${winners}`);
  for (const r of results) {
    if (r.ok) continue;
    if (/40001|40P01/.test(r.body)) problems.push('a refusal used a RETRYABLE sqlstate — PostgREST would loop forever');
    if (!/WS409|plan_changed|capacity_conflict/i.test(r.body)) {
      problems.push(`refusal was not a WS409 conflict: ${r.body.slice(0, 160)}`);
    }
  }

  // The loser must have written NOTHING.
  for (let i = 0; i < made.length; i += 1) {
    const m = made[i]!;
    const won = results[i]!.ok;
    const [planRow] = await get<{ status: string }>('mos_campaign_plans', `select=status&id=eq.${m.planId}`);
    const res = await get<{ id: string }>('mos_task_reservations', `select=id&plan_id=eq.${m.planId}`);
    const content = await get<{ id: string }>('mos_content', `select=id&campaign_id=eq.${m.campaignId}`);
    console.log(`  campaign ${i + 1} after: plan=${planRow?.status} reservations=${res.length} content=${content.length}`);
    if (won && (res.length === 0 || content.length === 0)) problems.push(`winner ${i + 1} wrote nothing`);
    if (!won && (res.length > 0 || content.length > 0)) {
      problems.push(`loser ${i + 1} wrote rows anyway (${res.length} reservations, ${content.length} content)`);
    }
    if (!won && planRow?.status === 'approved') problems.push(`loser ${i + 1} was marked approved`);
  }

  console.log('\n  cleaning up…');
  for (const m of made) {
    const contentIds = (await get<{ id: string }>('mos_content', `select=id&campaign_id=eq.${m.campaignId}`)).map((c) => c.id);
    await del('mos_task_reservations', `plan_id=eq.${m.planId}`);
    await del('mos_publications', `campaign_id=eq.${m.campaignId}`);
    if (contentIds.length) await del('mos_content_plan', `content_id=in.(${contentIds.join(',')})`);
    await del('mos_publish_batches', `campaign_id=eq.${m.campaignId}`);
    if (contentIds.length) {
      await del('workflow_role_tasks', `subject_id=in.(${contentIds.join(',')})`);
      await del('mos_content', `id=in.(${contentIds.join(',')})`);
    }
    await del('mos_campaign_executions', `campaign_id=eq.${m.campaignId}`);
    await del('mos_campaign_plans', `id=eq.${m.planId}`);
    await del('mos_campaigns', `id=eq.${m.campaignId}`);
  }
  console.log('  cleaned.');

  if (problems.length) {
    console.error(`\nPROBLEMS:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nCONCURRENCY PASSED — exactly one commit booked the capacity, the other was refused cleanly.');
}

main().catch((e) => { console.error('\nFAILED:', e instanceof Error ? e.message : e); process.exit(1); });
