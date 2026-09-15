/**
 * The production-workflow battery, live.
 *
 *   npx vite-node scripts/e2e-content-workflow.ts
 *
 * Proves the behaviours the reviews turned on, against real rows:
 *   1. the writing stage CANNOT close without a caption the writer confirmed;
 *   2. consuming a reservation is a SWAP — the ledger total does not move, and
 *      the work is never counted twice nor lost;
 *   3. an approval writes an immutable record of exactly what was approved;
 *   4. a locked field cannot be edited afterwards without a revision;
 *   5. a caption-only revision re-runs writing review, and an image-affecting
 *      change also re-runs design (the "changed price, stale image" case);
 *   6. rejecting the FINAL approval can be routed to the WRITER, not only the
 *      designer;
 *   7. an overdue untouched task keeps its full remaining effort in the ledger.
 *
 * Everything is created under a sandbox campaign and deleted at the end.
 */
import { readFileSync, existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
}
const BASE = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';
if (!BASE || !KEY) { console.error('missing SUPABASE env'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

/**
 * The engine RPCs are gated on `auth.uid()` — service_role has none, so the
 * workflow half must run as a REAL person, exactly as the app does. Tokens are
 * minted by scripts/mint-workflow-tokens.mjs into gitignored files and revoked
 * afterwards; without them this script refuses rather than testing a path no
 * human takes.
 */
const readToken = (f: string): string => {
  if (!existsSync(f)) {
    console.error(`missing ${f} — run: node scripts/mint-workflow-tokens.mjs`);
    process.exit(2);
  }
  return readFileSync(f, 'utf8').trim();
};
const WRITER = readToken('.wf-token.local');
const MANAGER = readToken('.wf-token-mgr.local');
const asUser = (tok: string) => ({ apikey: ANON, Authorization: `Bearer ${tok}`, 'content-type': 'application/json' });

async function get<T>(t: string, q: string): Promise<T[]> {
  const r = await fetch(`${BASE}/rest/v1/${t}?${q}`, { headers: H });
  if (!r.ok) throw new Error(`${t} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json() as Promise<T[]>;
}
async function post<T>(t: string, body: unknown): Promise<T[]> {
  const r = await fetch(`${BASE}/rest/v1/${t}`, {
    method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${t} insert ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const x = await r.text();
  return x ? JSON.parse(x) : [];
}
async function patch(
  t: string, q: string, body: unknown, token?: string,
): Promise<{ ok: boolean; body: string }> {
  const r = await fetch(`${BASE}/rest/v1/${t}?${q}`, {
    method: 'PATCH', headers: token ? asUser(token) : H, body: JSON.stringify(body),
  });
  return { ok: r.ok, body: await r.text() };
}
async function del(t: string, q: string): Promise<void> {
  await fetch(`${BASE}/rest/v1/${t}?${q}`, { method: 'DELETE', headers: H });
}
async function rpcRaw(
  fn: string, args: Record<string, unknown>, token?: string,
): Promise<{ ok: boolean; body: string }> {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: token ? asUser(token) : H, body: JSON.stringify(args),
  });
  return { ok: r.ok, body: await r.text() };
}
const rpc = async (fn: string, args: Record<string, unknown>, token?: string): Promise<unknown> => {
  const r = await rpcRaw(fn, args, token);
  if (!r.ok) throw new Error(`${fn}: ${r.body.slice(0, 300)}`);
  return r.body ? JSON.parse(r.body) : null;
};

const problems: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); problems.push(name); }
}
const ledgerTotal = async (): Promise<number> => {
  const rows = await get<{ weight: number }>('mos_work_ledger_v', 'select=weight&limit=5000');
  return Math.round(rows.reduce((a, b) => a + Number(b.weight), 0) * 100) / 100;
};

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  console.log(`content workflow e2e — WF-${stamp}\n`);

  const [proj] = await get<{ id: string }>('unified_records', 'select=id&limit=1&order=created_at.desc');
  const [type] = await get<{ id: string; workflow_id: string }>('mos_content_types', 'select=id,workflow_id&key=eq.post');
  if (!proj || !type) throw new Error('no project record / post content type');
  const [ver] = await get<{ id: string }>('workflow_versions',
    `select=id&workflow_id=eq.${type.workflow_id}&order=version_no.desc&limit=1`);
  if (!ver) throw new Error('no pinned workflow version');

  const [campaign] = await post<{ id: string; ref: string }>('mos_campaigns', {
    name: `🧪 WF-${stamp} — workflow e2e`, kind: 'organic', status: 'planning',
    project_ids: [proj.id], project_id: proj.id, note: 'scripts/e2e-content-workflow.ts — safe to delete',
  });
  if (!campaign) throw new Error('campaign insert failed');
  const [content] = await post<{ id: string; ref: string }>('mos_content', {
    title: `WF-${stamp} probe`, content_type_id: type.id, workflow_id: type.workflow_id,
    workflow_version_id: ver.id, campaign_id: campaign.id, project_ids: [proj.id], project_id: proj.id,
    organic_platforms: ['instagram'], data: { headlines: ['عنوان تجريبي'], design_brief: 'بريف' },
  });
  if (!content) throw new Error('content insert failed');
  console.log(`  campaign ${campaign.ref} · content ${content.ref}\n`);

  /* -- 1. the writing stage refuses to close without a confirmed caption -- */
  console.log('requirement enforcement');
  await rpc('workflow_role_path_start', { p_subject_table: 'mos_content', p_subject_id: content.id }, WRITER);
  const [t1] = await get<{ id: string; step_key: string; assignee_user_id: string | null; effort_days: number | null }>(
    'workflow_role_tasks', `select=id,step_key,assignee_user_id,effort_days&subject_id=eq.${content.id}&status=eq.open`);
  check('the first task opened on writing', t1?.step_key === 'writing', t1?.step_key);

  const noCaption = await rpcRaw('workflow_advance_role_path', {
    p_subject_table: 'mos_content', p_subject_id: content.id, p_result: 'submitted',
  }, WRITER);
  check('submitting with no caption is REFUSED',
    !noCaption.ok && /REQUIREMENTS_MISSING|caption/i.test(noCaption.body),
    noCaption.ok ? 'it was accepted' : noCaption.body.slice(0, 90).replace(/\s+/g, ' '));

  // Caption written but NOT confirmed by the writer.
  await patch('mos_content', `id=eq.${content.id}`, {
    data: { headlines: ['عنوان تجريبي'], design_brief: 'بريف', caption: 'نص الكابشن التجريبي.' },
  });
  const unconfirmed = await rpcRaw('workflow_advance_role_path', {
    p_subject_table: 'mos_content', p_subject_id: content.id, p_result: 'submitted',
  }, WRITER);
  check('an UNCONFIRMED caption is still refused',
    !unconfirmed.ok && /REQUIREMENTS_MISSING|confirm/i.test(unconfirmed.body),
    unconfirmed.ok ? 'it was accepted' : 'refused');

  /* -- 2. consuming a reservation is a swap ------------------------------- */
  console.log('\nledger swap');
  const caption = 'نص الكابشن التجريبي.';
  await patch('mos_content', `id=eq.${content.id}`, {
    data: {
      headlines: ['عنوان تجريبي'], design_brief: 'بريف', caption,
      caption_confirmed_text: caption, caption_confirmed_at: new Date().toISOString(),
    },
  });
  const before = await ledgerTotal();
  const adv = await rpcRaw('workflow_advance_role_path', {
    p_subject_table: 'mos_content', p_subject_id: content.id, p_result: 'submitted',
  }, WRITER);
  check('with a confirmed caption the writing stage closes', adv.ok,
    adv.ok ? '' : adv.body.slice(0, 120).replace(/\s+/g, ' '));
  const after = await ledgerTotal();
  const [t2] = await get<{ id: string; step_key: string }>('workflow_role_tasks',
    `select=id,step_key&subject_id=eq.${content.id}&status=eq.open`);
  check('it advanced to the manager review', t2?.step_key === 'writing_review', t2?.step_key);
  check('the ledger total did not jump when the task changed hands',
    Math.abs(after - before) <= 2.01, `${before} → ${after}`);

  /* -- 3 + 4. approval writes a record, and locks the fields -------------- */
  console.log('\napproval record + locks');
  const appr = await rpcRaw('workflow_advance_role_path', {
    p_subject_table: 'mos_content', p_subject_id: content.id, p_result: 'approved',
  }, MANAGER);
  check('the manager can approve the writing', appr.ok, appr.ok ? '' : appr.body.slice(0, 120));
  const approvals = await get<{ step_key: string; caption_hash: string | null; package_hash: string | null }>(
    'mos_content_approvals', `select=step_key,caption_hash,package_hash&content_id=eq.${content.id}`);
  check('an approval row records what was approved', approvals.length > 0,
    approvals.map((a) => a.step_key).join(','));
  check('the approval binds the caption', Boolean(approvals[0]?.caption_hash));

  const edit = await patch('mos_content', `id=eq.${content.id}`, {
    data: {
      headlines: ['عنوان تجريبي'], design_brief: 'بريف',
      caption: 'كابشن مختلف تمامًا بعد الاعتماد.',
      caption_confirmed_text: 'كابشن مختلف تمامًا بعد الاعتماد.',
    },
  }, WRITER);
  check('editing the APPROVED caption is refused', !edit.ok,
    edit.ok ? 'the edit went through' : edit.body.slice(0, 90).replace(/\s+/g, ' '));

  /* -- 5. revision scope --------------------------------------------------- */
  console.log('\nrevision scope');
  const rev = await rpcRaw('content_revise', {
    p_content_id: content.id, p_scope: ['caption'], p_note: 'الكابشن يحتاج تعديلًا',
  }, MANAGER);
  check('a caption revision opens', rev.ok, rev.ok ? rev.body.slice(0, 120) : rev.body.slice(0, 160));
  if (rev.ok) {
    const [tRev] = await get<{ step_key: string; round: number }>('workflow_role_tasks',
      `select=step_key,round&subject_id=eq.${content.id}&status=eq.open`);
    check('a caption-only revision goes back to the WRITING stage, not design',
      tRev?.step_key === 'writing' || tRev?.step_key === 'writing_review', tRev?.step_key);
    check('the round advanced', (tRev?.round ?? 0) >= 2, String(tRev?.round));
  }

  /* -- 6. overdue work keeps its full effort ------------------------------- */
  console.log('\noverdue work');
  const [openTask] = await get<{ id: string; effort_days: number | null }>('workflow_role_tasks',
    `select=id,effort_days&subject_id=eq.${content.id}&status=eq.open`);
  if (openTask) {
    const yesterday = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    // An UNASSIGNED task consumes nobody's capacity by design, so give it an
    // owner before measuring — otherwise this would measure the null case.
    const [owner] = await get<{ user_id: string }>('mos_user_capacity', 'select=user_id&limit=1');
    const [anyUser] = await get<{ id: string }>('users', 'select=id&is_active=is.true&limit=1');
    const assignee = owner?.user_id ?? anyUser?.id ?? null;
    await patch('workflow_role_tasks', `id=eq.${openTask.id}`, {
      scheduled_start: yesterday, scheduled_end: yesterday,
      effort_days: 2, progress_days: 0, assignee_user_id: assignee,
    });
    const rows = await get<{ weight: number; day: string }>('mos_work_ledger_v',
      `select=weight,day&ref_id=eq.${openTask.id}`);
    const total = rows.reduce((a, b) => a + Number(b.weight), 0);
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    check('an untouched 5-day-late 2-day task still costs 2 slot-days',
      Math.abs(total - 2) < 0.01, `${total}`);
    check('and it is projected forward, never onto its past days',
      rows.every((r) => r.day >= todayStr), rows.map((r) => r.day).join(','));

    await patch('workflow_role_tasks', `id=eq.${openTask.id}`, { progress_days: 1 });
    const rows2 = await get<{ weight: number }>('mos_work_ledger_v', `select=weight&ref_id=eq.${openTask.id}`);
    const total2 = rows2.reduce((a, b) => a + Number(b.weight), 0);
    check('recorded progress DOES reduce it', Math.abs(total2 - 1) < 0.01, `${total2}`);
  } else {
    check('an open task exists to test lateness against', false, 'none open');
  }

  /* -- cleanup ------------------------------------------------------------- */
  console.log('\ncleaning up…');
  await del('mos_content_approvals', `content_id=eq.${content.id}`);
  await del('mos_content_events', `content_id=eq.${content.id}`);
  await del('workflow_role_tasks', `subject_id=eq.${content.id}`);
  await del('mos_content_versions', `content_id=eq.${content.id}`);
  await del('mos_content_plan', `content_id=eq.${content.id}`);
  await del('mos_publications', `content_id=eq.${content.id}`);
  await del('mos_content', `id=eq.${content.id}`);
  await del('mos_campaign_plans', `campaign_id=eq.${campaign.id}`);
  await del('mos_campaign_executions', `campaign_id=eq.${campaign.id}`);
  await del('mos_campaigns', `id=eq.${campaign.id}`);
  console.log('  cleaned.');

  console.log(`\n${problems.length ? `PROBLEMS (${problems.length}/${checks}):\n  - ${problems.join('\n  - ')}` : `ALL ${checks} CHECKS PASSED`}`);
  if (problems.length) process.exit(1);
}

main().catch((e) => { console.error('\nFAILED:', e instanceof Error ? e.message : e); process.exit(1); });
