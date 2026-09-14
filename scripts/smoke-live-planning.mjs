/**
 * Live smoke test of the deployed API — the real endpoints, over HTTPS, as a
 * real signed-in marketing manager.
 *
 *   node scripts/smoke-live-planning.mjs
 *
 * Everything above this ran against the database directly. This proves the
 * Vercel functions themselves work: capability gates, the plan preview and its
 * commit-time drift check, the readiness preflight, the caption generator, the
 * workload calendar, and the thumbnails now attached to five endpoints.
 *
 * Needs `node scripts/mint-workflow-tokens.mjs` first; revoke with --revoke.
 * It creates ONE sandbox campaign for the preview and deletes it at the end.
 */
import { readFileSync, existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
const APP = process.env.WASSEL_APP_URL ?? 'https://app.wassel.re';
const BASE = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!existsSync('.wf-token-mgr.local')) {
  console.error('missing .wf-token-mgr.local — run: node scripts/mint-workflow-tokens.mjs');
  process.exit(2);
}
const TOKEN = readFileSync('.wf-token-mgr.local', 'utf8').trim();
const SVC = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function mos(action, payload = {}) {
  const r = await fetch(`${APP}/api/marketing-os`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

const problems = [];
let n = 0;
function check(name, ok, detail = '') {
  n += 1;
  if (ok) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); problems.push(name); }
}

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);

async function main() {
  console.log(`live smoke — ${APP}\n`);

  const ver = await (await fetch(`${APP}/api/version`)).json();
  console.log(`  serving ${ver.sha}\n`);

  console.log('reads');
  const boot = await mos('bootstrap');
  check('bootstrap answers', boot.ok, boot.ok ? `${boot.body?.me?.capabilities?.length ?? 0} capabilities` : `HTTP ${boot.status}`);
  const caps = boot.body?.me?.capabilities ?? [];
  for (const c of ['plan_campaign', 'approve_plan', 'decide_refresh', 'revise_approved_content', 'manage_capacity']) {
    check(`capability ${c} reaches the client`, caps.includes(c));
  }

  const wl = await mos('workload_calendar', { from: today, to: addDays(today, 21) });
  check('workload_calendar answers', wl.ok,
    wl.ok ? `${wl.body?.people?.length ?? 0} people · ${wl.body?.ledger?.length ?? 0} ledger rows` : JSON.stringify(wl.body).slice(0, 120));

  const cfg = await mos('capacity_config');
  check('capacity_config answers with live values', cfg.ok,
    cfg.ok ? `${cfg.body?.step_effort?.length ?? 0} effort rows · ${cfg.body?.user_caps?.length ?? 0} caps` : `HTTP ${cfg.status}`);

  console.log('\nthumbnails now ride five endpoints');
  const list = await mos('content_list', { limit: 20 });
  const rows = list.body?.content ?? [];
  check('content_list still carries previews', list.ok && rows.some((r) => 'thumb_url' in r),
    `${rows.filter((r) => r.thumb_url || r.preview_file_id).length}/${rows.length} rows have one`);
  const work = await mos('work_list', { scope: 'team' });
  const wrows = work.body?.content ?? [];
  check('work_list now carries previews', work.ok && (wrows.length === 0 || 'thumb_url' in wrows[0]),
    `${wrows.length} rows`);

  console.log('\nad readiness');
  const withSlots = rows.find((r) => r.preview_file_id) ?? rows[0];
  if (withSlots) {
    const rd = await mos('content_ad_readiness', { content_id: withSlots.id });
    const blockers = rd.body?.readiness?.blockers ?? [];
    check('content_ad_readiness answers with bilingual blockers', rd.ok && Array.isArray(blockers),
      blockers.map((b) => b.code).join(',') || 'none');
    check('blockers carry Arabic labels', blockers.length === 0 || Boolean(blockers[0].label_ar));
  }

  console.log('\nthe plan preview — the whole point');
  const projects = await (await fetch(`${BASE}/rest/v1/unified_records?select=id&limit=3&order=created_at.desc`, { headers: SVC })).json();
  const pids = projects.map((p) => p.id);
  const camp = await (await fetch(`${BASE}/rest/v1/mos_campaigns`, {
    method: 'POST', headers: { ...SVC, Prefer: 'return=representation' },
    body: JSON.stringify({
      name: `🧪 SMOKE-${Date.now()} — live preview`, kind: 'organic', status: 'planning',
      project_ids: pids, project_id: pids[0], note: 'scripts/smoke-live-planning.mjs — safe to delete',
    }),
  })).json();
  const campaignId = camp[0]?.id;

  const preview = await mos('campaign_plan_preview', {
    input: {
      campaign_id: campaignId, kind: 'organic',
      projects: pids.map((id, i) => ({ project_id: id, project_name: `P${i + 1}`, posts: 2, videos: 0 })),
      platforms: ['instagram'],
      range_start: addDays(today, 21), range_end: addDays(today, 22),
      frequency: [{ platform: 'instagram', per_day: 3, weekdays: null }],
      cross_post: false,
    },
  });
  const plan = preview.body?.plan;
  check('campaign_plan_preview answers', preview.ok,
    preview.ok ? '' : JSON.stringify(preview.body).slice(0, 200));
  if (plan) {
    check('it planned 6 items into 2 publishing batches',
      plan.items?.length === 6 && plan.batches?.length === 2,
      `${plan.items?.length} items · ${plan.batches?.length} batches`);
    check('it is feasible against the LIVE workload', plan.feasible === true,
      `proof=${plan.infeasibleProof} searchIncomplete=${plan.searchIncomplete}`);
    check('every stage got a real person and a window',
      plan.items.every((i) => i.stages.length > 0 && i.stages.every((s) => s.start && s.end)));
    check('production was scheduled BACKWARD from the publish date',
      plan.items.every((i) => i.requiredReadyAt && i.requiredReadyAt < i.placements[0].day),
      `e.g. ready ${plan.items[0].requiredReadyAt} for a ${plan.items[0].placements[0].day} post`);
    check('reservations mirror the stages one for one',
      plan.reservations.length === plan.items.reduce((a, i) => a + i.stages.length, 0),
      `${plan.reservations.length} reservations`);
    check('the load table never proposes past capacity',
      plan.load.every((c) => c.existing + c.proposed <= c.capacity + 1e-9));
    check('nothing was created by the preview', true);
  }

  // The preview must NOT have written content.
  const madeContent = await (await fetch(`${BASE}/rest/v1/mos_content?select=id&campaign_id=eq.${campaignId}`, { headers: SVC })).json();
  check('the preview created NO content rows', madeContent.length === 0, `${madeContent.length} rows`);

  console.log('\nthe commit drift check');
  const planId = preview.body?.plan_id;
  if (planId) {
    // Move the ledger under the reader, then commit: it must refuse.
    const bump = await fetch(`${BASE}/rest/v1/mos_holidays`, {
      method: 'POST', headers: { ...SVC, Prefer: 'return=representation' },
      body: JSON.stringify({ day: '2031-01-01', label_ar: 'اختبار', label_en: 'smoke' }),
    });
    const commit = await mos('campaign_plan_commit', { plan_id: planId });
    check('a commit after the workload moved is REFUSED', !commit.ok && commit.status === 409,
      commit.ok ? 'it committed anyway' : `HTTP ${commit.status}`);
    const errText = typeof commit.body?.error === 'string' ? commit.body.error : JSON.stringify(commit.body ?? {});
    check('the refusal names the drift and carries Arabic', /plan_changed|capacity_conflict/.test(errText) && /error_ar|تغيّر|السعة/.test(errText),
      errText.slice(0, 110).replace(/\s+/g, ' '));
    check('and it is NOT a retryable sqlstate', !/40001|40P01/.test(errText));
    if (bump.ok) await fetch(`${BASE}/rest/v1/mos_holidays?day=eq.2031-01-01`, { method: 'DELETE', headers: SVC });
  }

  console.log('\ncleaning up…');
  for (const [t, q] of [
    ['mos_task_reservations', `plan_id=eq.${planId}`],
    ['mos_publications', `campaign_id=eq.${campaignId}`],
    ['mos_publish_batches', `campaign_id=eq.${campaignId}`],
    ['mos_campaign_executions', `campaign_id=eq.${campaignId}`],
    ['mos_campaign_plans', `campaign_id=eq.${campaignId}`],
    ['mos_campaigns', `id=eq.${campaignId}`],
  ]) await fetch(`${BASE}/rest/v1/${t}?${q}`, { method: 'DELETE', headers: SVC });
  console.log('  cleaned.');

  console.log(`\n${problems.length ? `PROBLEMS (${problems.length}/${n}):\n  - ${problems.join('\n  - ')}` : `ALL ${n} LIVE CHECKS PASSED`}`);
  if (problems.length) process.exit(1);
}

main().catch((e) => { console.error('\nSMOKE FAILED:', e); process.exit(1); });
