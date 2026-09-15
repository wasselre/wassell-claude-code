/**
 * End-to-end: plan a real campaign against the LIVE workload, commit it, prove
 * what was created, then delete every row it made.
 *
 *   npx vite-node scripts/e2e-campaign-plan.ts            # organic
 *   npx vite-node scripts/e2e-campaign-plan.ts --paid     # paid + refresh cycles
 *   npx vite-node scripts/e2e-campaign-plan.ts --keep     # leave the rows behind
 *
 * This runs the SAME engine the API runs (imported, not re-implemented) and the
 * SAME commit RPC, so it exercises the one path that unit tests cannot: SQL
 * materialisation. Everything it creates is namespaced `E2E-<timestamp>` and
 * removed at the end unless --keep.
 */
import { readFileSync, existsSync } from 'node:fs';
import { planCampaign, DEFAULT_RULES, type RuleSet, type PlanInput, type PlanResult, type WorkloadSnapshot, type LoadBucket, type PathRole, type PersonCapacity, type LedgerRow } from '../src/lib/marketingOS/scheduling/index.js';
import { DEFAULT_PUBLISHING } from '../src/lib/marketingOS/scheduling/releases.js';
import { DEFAULT_CALENDAR } from '../src/lib/marketingOS/scheduling/calendar.js';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
}
const BASE = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!BASE || !KEY) { console.error('missing SUPABASE env'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const PAID = process.argv.includes('--paid');
const KEEP = process.argv.includes('--keep');

async function get<T>(table: string, q: string): Promise<T[]> {
  const r = await fetch(`${BASE}/rest/v1/${table}?${q}`, { headers: H });
  if (!r.ok) throw new Error(`${table} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json() as Promise<T[]>;
}
async function post<T>(table: string, body: unknown, prefer = 'return=representation'): Promise<T[]> {
  const r = await fetch(`${BASE}/rest/v1/${table}`, {
    method: 'POST', headers: { ...H, Prefer: prefer }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${table} insert ${r.status}: ${(await r.text()).slice(0, 500)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}
async function del(table: string, q: string): Promise<void> {
  const r = await fetch(`${BASE}/rest/v1/${table}?${q}`, { method: 'DELETE', headers: H });
  if (!r.ok) console.error(`  cleanup ${table} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${t.slice(0, 600)}`);
  return (t ? JSON.parse(t) : null) as T;
}

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* snapshot — the same query shape api/_lib/marketing/planning uses     */
/* ------------------------------------------------------------------ */
async function loadSnapshot(): Promise<WorkloadSnapshot> {
  const [roles, users, caps, roleLoad, leaves, ledgerRows, holidays] = await Promise.all([
    get<{ id: string; key: string }>('roles', 'select=id,key&domain=eq.marketing'),
    get<{ id: string; role_assignments: unknown }>('users', 'select=id,role_assignments&is_active=is.true'),
    get<{ user_id: string; bucket: string; daily_slots: number }>('mos_user_capacity', 'select=*'),
    get<{ role_id: string; bucket: string; daily_new_tasks: number }>('mos_role_load', 'select=*'),
    get<{ user_id: string; start_at: string; end_at: string }>('mos_leaves', 'select=user_id,start_at,end_at&status=eq.approved'),
    get<{ user_id: string; day: string; bucket: string; weight: number; source: string; ref_id: string | null }>(
      'mos_work_ledger_v', 'select=*&limit=5000'),
    get<{ day: string }>('mos_holidays', 'select=day'),
  ]);
  const hash = await rpc<string>('mos_workload_snapshot_hash', {});

  const keyById = new Map(roles.map((r) => [r.id, r.key.replace(/^mos_/, '') as PathRole]));
  const idByKey = new Map(roles.map((r) => [r.key.replace(/^mos_/, '') as PathRole, r.id]));
  const load = new Map(roleLoad.map((r) => [`${r.role_id}|${r.bucket}`, r.daily_new_tasks]));
  const over = new Map(caps.map((c) => [`${c.user_id}|${c.bucket}`, c.daily_slots]));
  const leaveBy = new Map<string, Array<{ from: string; to: string }>>();
  for (const l of leaves) {
    const arr = leaveBy.get(l.user_id) ?? [];
    arr.push({ from: l.start_at.slice(0, 10), to: l.end_at.slice(0, 10) });
    leaveBy.set(l.user_id, arr);
  }
  const people: PersonCapacity[] = [];
  for (const u of users) {
    const held: PathRole[] = [];
    for (const a of (Array.isArray(u.role_assignments) ? u.role_assignments : []) as Array<{ role_id?: string }>) {
      const k = a?.role_id ? keyById.get(a.role_id) : undefined;
      if (k && !held.includes(k)) held.push(k);
    }
    if (!held.length) continue;
    const c: Partial<Record<LoadBucket, number>> = { approvals: 20 };
    for (const b of ['post', 'video'] as const) {
      const o = over.get(`${u.id}|${b}`);
      c[b] = o ?? Math.max(0, ...held.map((r) => load.get(`${idByKey.get(r)}|${b}`) ?? 0));
    }
    const ov = over.get(`${u.id}|approvals`);
    if (ov != null) c.approvals = ov;
    people.push({ userId: u.id, roles: held, caps: c, leaves: leaveBy.get(u.id) ?? [] });
  }
  people.sort((a, b) => (a.userId < b.userId ? -1 : 1));

  const ledger: LedgerRow[] = ledgerRows
    .filter((r) => r.day >= today)
    .map((r) => ({
      userId: r.user_id, day: r.day,
      bucket: (['post', 'video', 'approvals'].includes(r.bucket) ? r.bucket : 'post') as LoadBucket,
      weight: Number(r.weight) || 0,
      source: (r.source === 'reservation' || r.source === 'manual' ? r.source : 'task') as LedgerRow['source'],
      refId: r.ref_id,
    }));

  return {
    today,
    calendar: { ...DEFAULT_CALENDAR, holidays: holidays.map((h) => h.day) },
    people, ledger, hash,
  };
}

/* ------------------------------------------------------------------ */
function materialise(input: PlanInput, plan: PlanResult): Record<string, unknown> {
  return {
    campaign_id: input.campaignId, kind: input.kind,
    range_start: input.rangeStart, range_end: input.rangeEnd, cross_post: input.crossPost,
    executions: input.kind === 'paid'
      ? (input.paid ?? []).map((c) => ({
        key: c.executionKey, platform: c.platform, execution_id: c.executionId,
        refresh_policy: {
          slate_size: c.policy.slateSize, keep_min: c.policy.keepMin, cycle_days: c.policy.cycleDays,
          min_remaining_days: c.policy.minRemainingDays,
          lead_time_working_days: c.policy.leadTimeWorkingDays, fifth_policy: c.policy.fifthPolicy,
        },
      }))
      : input.platforms.map((p) => ({
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
      slot: i.slot ? {
        execution_key: i.slot.executionKey, cycle_round: i.slot.cycleRound,
        slot_index: i.slot.slotIndex, kind: i.slot.kind,
      } : null,
    })),
    batches: plan.batches.map((b) => ({
      key: b.key, execution_key: b.executionKey, platform: b.platform,
      day: b.day, sequence: b.sequence, item_keys: b.itemKeys,
    })),
    cycles: plan.cycles.map((c) => ({
      execution_key: c.executionKey, round: c.round, refresh_on: c.refreshOn, ready_by: c.readyBy,
      production_start_on: c.productionStartOn, decision_due_on: c.decisionDueOn,
      produced: c.produced, banked_spare_slot_id: c.bankedSpareSlotId,
    })),
  };
}

/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const ref = `E2E-${stamp}`;
  console.log(`e2e campaign plan — ${PAID ? 'paid' : 'organic'} — ${ref}\n`);

  const projects = await get<{ id: string; data: Record<string, unknown> }>(
    'unified_records', 'select=id,data&limit=3&order=created_at.desc');
  const projectIds = projects.slice(0, PAID ? 1 : 3).map((p) => p.id);
  if (!projectIds.length) throw new Error('no records to use as projects');

  const [campaign] = await post<{ id: string; ref: string }>('mos_campaigns', {
    name: `🧪 ${ref} — planning e2e`,
    kind: PAID ? 'paid' : 'organic',
    status: 'planning',
    project_ids: projectIds,
    project_id: projectIds[0],
    note: 'created by scripts/e2e-campaign-plan.ts — safe to delete',
  });
  if (!campaign) throw new Error('campaign insert returned nothing');
  console.log(`  campaign ${campaign.ref} (${campaign.id.slice(0, 8)})`);

  const rangeStart = addDays(today, 21);
  const rangeEnd = addDays(rangeStart, PAID ? 29 : 2);

  const input: PlanInput = PAID
    ? {
      campaignId: campaign.id, kind: 'paid',
      projects: [{ projectId: projectIds[0]!, projectName: 'E2E', posts: 0, videos: 0 }],
      platforms: ['meta'], rangeStart, rangeEnd,
      frequency: [], crossPost: false, publishBufferDays: 1,
      paid: [{
        executionKey: 'exec:meta', executionId: null, platform: 'meta',
        policy: {
          slateSize: 5, keepMin: 1, cycleDays: 7, minRemainingDays: 3,
          leadTimeWorkingDays: 7, fifthPolicy: 'A', bankedSpares: [],
        },
      }],
    }
    : {
      campaignId: campaign.id, kind: 'organic',
      projects: projectIds.map((id, i) => ({ projectId: id, projectName: `P${i + 1}`, posts: 2, videos: 0 })),
      platforms: ['instagram'], rangeStart, rangeEnd,
      frequency: [{ platform: 'instagram', perDay: 3, weekdays: null }],
      crossPost: false, publishBufferDays: 1,
    };

  console.log('  loading the live workload…');
  const snapshot = await loadSnapshot();
  console.log(`  ledger ${snapshot.ledger.length} rows · ${snapshot.people.length} people · hash ${snapshot.hash.slice(0, 12)}…`);

  // The LIVE automatable map, exactly as api/_lib/.../snapshot.ts feeds it.
  // Calling planCampaign without it would make every destination look manual
  // (an unknown platform is deliberately never assumed automatable), which is
  // what this script did until 2026-09-14 and why it reported six releases
  // needing an owner on a platform that publishes itself.
  const automatable = await rpc<Record<string, boolean>>('mos_platform_automatable_map', {});
  const rules: RuleSet = {
    ...DEFAULT_RULES,
    publishing: { ...DEFAULT_PUBLISHING, automatable: automatable ?? {} },
  };
  console.log(`  automatable: ${JSON.stringify(automatable)}`);

  const plan = planCampaign(input, snapshot, rules);
  console.log(`  planned: feasible=${plan.feasible} proof=${plan.infeasibleProof} items=${plan.items.length} batches=${plan.batches.length} reservations=${plan.reservations.length}`);
  if (plan.totals.creatives) {
    const c = plan.totals.creatives;
    console.log(`  creatives: ${c.total} (${c.initial} launch + ${c.replacements} replacements + ${c.fifths} fifths) over ${c.cycles} refreshes`);
  }
  const rel = plan.totals.releases;
  console.log(`  releases: ${rel.total} (${rel.automatic} automatic · ${rel.manual} need a person)`);
  for (const c of plan.conflicts) console.log(`  conflict [${c.kind}] ${c.messageEn}`);
  if (!plan.feasible) {
    console.log(`  alternatives: earliest=${plan.alternatives.earliestFeasibleStart} maxItems=${plan.alternatives.maxItemsInRange}`);
    throw new Error('the plan is not feasible — cannot exercise commit');
  }

  const [planRow] = await post<{ id: string }>('mos_campaign_plans', {
    campaign_id: campaign.id, status: 'proposed',
    input, plan,
    feasibility: { feasible: plan.feasible, conflicts: plan.conflicts },
    snapshot_hash: plan.snapshotHash, engine_version: plan.engineVersion,
  });
  if (!planRow) throw new Error('plan insert returned nothing');
  console.log(`  plan row ${planRow.id.slice(0, 8)}`);

  /* -- the guard: a wrong hash must be refused ---------------------- */
  let refused = false;
  try {
    await rpc('mos_campaign_plan_commit', {
      p_plan_id: planRow.id, p_reservations: [], p_expected_hash: 'wrong', p_materialise: {}, p_actor: null,
    });
  } catch (e) {
    refused = true;
    const msg = String(e instanceof Error ? e.message : e);
    if (/40001|40P01/.test(msg)) throw new Error('commit raised a RETRYABLE sqlstate');
    console.log(`  wrong-hash commit refused: ${msg.slice(0, 90).replace(/\s+/g, ' ')}`);
  }
  if (!refused) throw new Error('commit ACCEPTED a wrong snapshot hash');

  /* -- the real commit ---------------------------------------------- */
  const reservations = plan.reservations.map((r) => ({
    item_key: r.itemKey, step_key: r.stepKey, role_key: r.roleKey, bucket: r.bucket,
    assignee_user_id: r.assigneeUserId, planned_start: r.plannedStart,
    planned_end: r.plannedEnd, weight: r.weight,
    // `execution_key#round`, resolved into mos_task_reservations.cycle_id by
    // the commit. A deferred paid reservation (a later refresh round, whose
    // content shell the sweep creates at production_start_on) has NO subject,
    // and cycle_id is the only thing mos_plan_start_due can find it by. Sending
    // it is not optional: the commit refuses a subject-less, cycle-less
    // reservation with MOS:UNBINDABLE_RESERVATION rather than let it book
    // capacity nothing will ever consume.
    cycle_key: r.cycleKey,
  }));
  const created = await rpc<Record<string, unknown>>('mos_campaign_plan_commit', {
    p_plan_id: planRow.id, p_reservations: reservations,
    p_expected_hash: plan.snapshotHash, p_materialise: materialise(input, plan), p_actor: null,
  });
  console.log(`  COMMITTED → ${JSON.stringify(created)}`);

  /* -- idempotence --------------------------------------------------- */
  const again = await rpc<Record<string, unknown>>('mos_campaign_plan_commit', {
    p_plan_id: planRow.id, p_reservations: reservations,
    p_expected_hash: plan.snapshotHash, p_materialise: materialise(input, plan), p_actor: null,
  });
  console.log(`  re-commit (idempotence) → ${JSON.stringify(again)}`);

  /* -- prove what exists --------------------------------------------- */
  const [content, plans, batches, res, cycles, slots, pubs, tasks] = await Promise.all([
    get('mos_content', `select=id,ref,title,target_publish_at&campaign_id=eq.${campaign.id}`),
    get('mos_content_plan', `select=content_id,required_ready_at,production_start,priority,status&campaign_id=eq.${campaign.id}`),
    get('mos_publish_batches', `select=day,sequence,status&campaign_id=eq.${campaign.id}&order=sequence`),
    get('mos_task_reservations', `select=step_key,assignee_user_id,planned_start,planned_end,status,content_id,row_id,cycle_id,content_key&plan_id=eq.${planRow.id}`),
    get('mos_refresh_cycles', `select=round,refresh_on,ready_by,production_start_on,produced:round&execution_id=in.(${
      (await get<{ id: string }>('mos_campaign_executions', `select=id&campaign_id=eq.${campaign.id}`)).map((e) => e.id).join(',') || '00000000-0000-0000-0000-000000000000'})`),
    get('mos_creative_slots', 'select=id&limit=1'),
    get('mos_publications', `select=platform,status,planned_at,grid_row,grid_col&campaign_id=eq.${campaign.id}`),
    get('workflow_role_tasks', `select=id&subject_id=in.(${
      (await get<{ id: string }>('mos_content', `select=id&campaign_id=eq.${campaign.id}`)).map((c) => c.id).join(',') || '00000000-0000-0000-0000-000000000000'})`),
  ]);
  console.log('\n  created rows:');
  console.log(`    mos_content            ${content.length}`);
  console.log(`    mos_content_plan       ${plans.length}`);
  console.log(`    mos_publish_batches    ${batches.length}  ${batches.map((b: Record<string, unknown>) => `${b.day}#${b.sequence}`).join(' ')}`);
  console.log(`    mos_task_reservations  ${res.length}`);
  console.log(`    mos_publications       ${pubs.length}`);
  console.log(`    mos_refresh_cycles     ${cycles.length}`);
  console.log(`    workflow_role_tasks    ${tasks.length}  (must be 0 — the sweep opens them at production_start)`);
  void slots;

  const problems: string[] = [];
  if (content.length !== plan.items.length && !PAID) problems.push(`content ${content.length} != items ${plan.items.length}`);
  if (res.length !== plan.reservations.length) problems.push(`reservations ${res.length} != planned ${plan.reservations.length}`);
  if (!PAID && batches.length !== plan.batches.length) problems.push(`batches ${batches.length} != planned ${plan.batches.length}`);
  if (tasks.length !== 0) problems.push(`${tasks.length} task(s) opened at commit — the sweep should do that`);

  /* -- every reservation must be reachable by SOMETHING ---------------- */
  //
  // A paid plan deliberately books work for refresh rounds whose content does
  // not exist yet, so those reservations land with no content_id and no
  // row_id. The ONLY thing that can find them again is
  // `mos_plan_start_due`'s bind:
  //
  //     content_id IS NULL AND row_id IS NULL
  //       AND cycle_id = <the cycle> AND content_key = <slot.content_key>
  //
  // Until 2026-09-15_23 nothing ever wrote cycle_id, so that bind matched zero
  // rows and every deferred reservation booked a designer's capacity forever
  // while `mos_plan_repair` re-dated it onto today, every day — silently. This
  // check is here so that can never come back unnoticed.
  {
    const resRows = res as unknown as Array<{ content_id: string | null; row_id: string | null;
      cycle_id: string | null; content_key: string | null }>;
    const orphans = resRows.filter((r) => !r.content_id && !r.row_id);
    const bindable = orphans.filter((r) => r.cycle_id && r.content_key);
    console.log(`    subject-less reservations: ${orphans.length}  (bindable by cycle+key: ${bindable.length})`);
    if (orphans.length !== bindable.length) {
      problems.push(`${orphans.length - bindable.length} reservation(s) have no subject AND no cycle — nothing can ever consume them`);
    }
    if (PAID && orphans.length > 0) {
      // The bind's other half: the slot the sweep will create the shell from
      // must carry the SAME content_key, on the SAME cycle.
      const slotRows = await get<{ cycle_id: string | null; content_key: string | null }>(
        'mos_creative_slots', `select=cycle_id,content_key&plan_id=eq.${planRow.id}`);
      const slotSet = new Set(slotRows.filter((s) => s.cycle_id && s.content_key)
        .map((s) => `${s.cycle_id}|${s.content_key}`));
      const matched = bindable.filter((r) => slotSet.has(`${r.cycle_id}|${r.content_key}`)).length;
      console.log(`    sweep bind would match: ${matched}/${orphans.length}`);
      if (matched !== orphans.length) {
        problems.push(`mos_plan_start_due would bind only ${matched} of ${orphans.length} deferred reservations`);
      }
    }
  }

  /* -- the reservations must now be IN the ledger --------------------- */
  const after = await get<{ ref_id: string; weight: number }>('mos_work_ledger_v', 'select=ref_id,weight&source=eq.reservation&limit=5000');
  const mine = new Set((await get<{ id: string }>('mos_task_reservations', `select=id&plan_id=eq.${planRow.id}`)).map((r) => r.id));
  const inLedger = after.filter((r) => mine.has(r.ref_id)).length;
  console.log(`    ledger rows for these reservations: ${inLedger}`);
  if (mine.size > 0 && inLedger === 0) problems.push('committed reservations do NOT appear in the ledger');

  const hashAfter = await rpc<string>('mos_workload_snapshot_hash', {});
  console.log(`    snapshot hash moved: ${plan.snapshotHash.slice(0, 10)} → ${hashAfter.slice(0, 10)} ${hashAfter !== plan.snapshotHash ? '(yes)' : '(NO — should have)'}`);
  if (mine.size > 0 && hashAfter === plan.snapshotHash) problems.push('the hash did not move after booking capacity');

  /* -- cleanup -------------------------------------------------------- */
  if (!KEEP) {
    console.log('\n  cleaning up…');
    const contentIds = (await get<{ id: string }>('mos_content', `select=id&campaign_id=eq.${campaign.id}`)).map((c) => c.id);
    await del('mos_task_reservations', `plan_id=eq.${planRow.id}`);
    await del('mos_publications', `campaign_id=eq.${campaign.id}`);
    if (contentIds.length) await del('mos_content_plan', `content_id=in.(${contentIds.join(',')})`);
    await del('mos_publish_batches', `campaign_id=eq.${campaign.id}`);
    const execIds = (await get<{ id: string }>('mos_campaign_executions', `select=id&campaign_id=eq.${campaign.id}`)).map((e) => e.id);
    if (execIds.length) {
      await del('mos_creative_slots', `execution_id=in.(${execIds.join(',')})`);
      await del('mos_refresh_cycles', `execution_id=in.(${execIds.join(',')})`);
    }
    if (contentIds.length) {
      await del('workflow_role_tasks', `subject_id=in.(${contentIds.join(',')})`);
      await del('mos_content', `id=in.(${contentIds.join(',')})`);
    }
    await del('mos_campaign_executions', `campaign_id=eq.${campaign.id}`);
    await del('mos_campaign_plans', `id=eq.${planRow.id}`);
    await del('mos_campaigns', `id=eq.${campaign.id}`);
    console.log('  cleaned.');
  } else {
    console.log(`\n  --keep: campaign ${campaign.ref} left in place.`);
  }

  if (problems.length) {
    console.error(`\nPROBLEMS:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nE2E PASSED');
}

main().catch((e) => { console.error('\nE2E FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
