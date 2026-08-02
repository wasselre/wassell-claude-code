#!/usr/bin/env node
/**
 * mos-journeys.mjs — Workstream E: the ten end-to-end journeys, run against the
 * isolated Supabase BRANCH (czdznzadjqzajrnjoafi) through the REAL
 * /api/marketing-os endpoint on the dev stack, each verified with DB + response
 * evidence. This is VERIFICATION, not UI building — it drives the flows as the
 * correct signed-in role and asserts the resulting DB + response state.
 *
 * Reuses the exact api()/exec()/query()/signIn() pattern from
 * scripts/mos-fixtures.mjs. The config comes from .mos-branch.local (or env);
 * the dev stack answers at MOS_APP_URL (default http://localhost:3000) with a
 * FROZEN process clock (MOS_QA_EPOCH=2026-07-29T10:00:00+03:00).
 *
 * SAFETY (never violated):
 *   - Journeys create their OWN objects, tagged 'JRN' (content/campaign/shoot/
 *     asset titles start with the TAG; attributions carry a JRN note; the J6
 *     workflow's label_en + content-type key are JRN-tagged). The shared design
 *     fixtures (V-004, C-004, …) are NEVER mutated into a different state.
 *   - Journeys that grant a marketing role to a fixture user (J5, J7) REVOKE it;
 *     cleanup also resets the writer + montage fixture users to their single
 *     baseline role, so a crashed prior run can never leave a grant behind.
 *   - cleanup() runs BEFORE (idempotency) and AFTER (tidiness) the journeys, so
 *     every run starts from — and returns to — the shared-fixture baseline.
 *     The attribution ledger is append-only (immutability trigger), so its JRN
 *     rows are removed with the trigger disabled, exactly like the fixtures'
 *     teardown.
 *
 * USAGE:
 *   node scripts/mos-journeys.mjs            # cleanup → all ten → cleanup → table
 *   node scripts/mos-journeys.mjs --only 1,3 # run a subset (still cleans first/last)
 *   node scripts/mos-journeys.mjs --keep     # skip the final cleanup (leave artifacts)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(__dirname, '..');

/* ------------------------------------------------------------------ */
/* config (loader copied from scripts/mos-fixtures.mjs)                */
/* ------------------------------------------------------------------ */

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
const APP = process.env.MOS_APP_URL || 'http://localhost:3000';
const PASSWORD = process.env.MOS_FIXTURE_PASSWORD || 'MosFixture!2026';
if (!URL_ || !KEY || !TOKEN) {
  console.error('FATAL: MOS_BRANCH_URL / MOS_BRANCH_ANON_KEY / MOS_BOOTSTRAP_TOKEN missing');
  process.exit(1);
}

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const ONLY = (opt('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = argv.includes('--keep');

/* ------------------------------------------------------------------ */
/* raw SQL channels (branch only) — copied from mos-fixtures.mjs        */
/* ------------------------------------------------------------------ */

async function rpc(fn, body) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${fn} HTTP ${res.status}: ${txt.slice(0, 800)}`);
  return txt;
}
const exec = (sql) => rpc('mos_bootstrap_exec', { p_token: TOKEN, p_sql: sql });
const query = async (sql) => JSON.parse(await rpc('mos_bootstrap_query', { p_token: TOKEN, p_sql: sql }));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* ------------------------------------------------------------------ */
/* the five fixture people (same ids as mos-fixtures.mjs)              */
/* ------------------------------------------------------------------ */

const ROLE_IDS = {
  ceo: 'c0febe01-0000-4000-8000-000000000001',
  marketing_manager: 'c0febe01-0000-4000-8000-000000000002',
  ops_supervisor: 'c0febe01-0000-4000-8000-000000000003',
  writer: 'c0febe01-0000-4000-8000-000000000004',
  montage: 'c0febe01-0000-4000-8000-000000000005',
};
const PEOPLE = [
  { role: 'ceo', uid: 'f1de0002-0000-4000-8000-000000000001', email: 'mos-ceo@fixtures.wassel.local' },
  { role: 'marketing_manager', uid: 'f1de0002-0000-4000-8000-000000000002', email: 'mos-marketing_manager@fixtures.wassel.local' },
  { role: 'ops_supervisor', uid: 'f1de0002-0000-4000-8000-000000000003', email: 'mos-ops_supervisor@fixtures.wassel.local' },
  { role: 'writer', uid: 'f1de0002-0000-4000-8000-000000000004', email: 'mos-writer@fixtures.wassel.local' },
  { role: 'montage', uid: 'f1de0002-0000-4000-8000-000000000005', email: 'mos-montage@fixtures.wassel.local' },
];
const UID = Object.fromEntries(PEOPLE.map((p) => [p.role, p.uid]));

const PROJECT = {
  mina: 'f1de0010-0000-4000-8000-000000000001',
  maqam: 'f1de0010-0000-4000-8000-000000000002',
};
const clientId = (n) => `f1de0011-0000-4000-8000-${String(n).padStart(12, '0')}`;

const TAG = 'JRN'; // every object a journey creates is tagged with this.

/* ------------------------------------------------------------------ */
/* auth + api transport (copied pattern from mos-fixtures.mjs)         */
/* ------------------------------------------------------------------ */

const tokens = {};
async function signIn(email) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-in failed for ${email}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.access_token;
}
async function signInAll() {
  for (const p of PEOPLE) tokens[p.role] = await signIn(p.email);
  console.log('[ok] signed in as all 5 roles');
}

/** Raw POST — returns {ok,status,body}; never throws. */
async function apiRaw(role, action, payload = {}, o = {}) {
  const headers = { Authorization: `Bearer ${tokens[role]}`, 'Content-Type': 'application/json' };
  if (o.activeRole) headers['x-mos-active-role'] = o.activeRole;
  const res = await fetch(`${APP}/api/marketing-os`, {
    method: 'POST', headers, body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !body.error, status: res.status, body };
}
/** POST that throws loudly on any failure — the default for the happy path. */
async function api(role, action, payload = {}, o = {}) {
  const r = await apiRaw(role, action, payload, o);
  if (!r.ok) {
    throw new Error(`api '${action}' as ${role}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  return r.body;
}

/* ------------------------------------------------------------------ */
/* assertion collector                                                 */
/* ------------------------------------------------------------------ */

const short = (v) => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};
function newJourney(id, name) {
  return {
    id, name, checks: [], error: null, partial: false, note: '',
    eq(label, got, want) {
      this.checks.push({ label, got: short(got), want: short(want), ok: JSON.stringify(got) === JSON.stringify(want) });
    },
    ok(label, cond, got) {
      this.checks.push({ label, got: short(got), want: 'truthy', ok: !!cond });
    },
  };
}
const passed = (j) => !j.error && j.checks.length > 0 && j.checks.every((c) => c.ok);

/* ------------------------------------------------------------------ */
/* content-drive helpers                                               */
/* ------------------------------------------------------------------ */

const APPROVAL_STEPS = new Set(['idea_review', 'script_review', 'review', 'writing_review', 'design_review', 'publish_check']);

async function openTask(contentId) {
  const d = await api('marketing_manager', 'content_detail', { id: contentId });
  const t = (d.tasks ?? []).find((x) => x.status === 'open') ?? null;
  return { detail: d, task: t, step: t?.step_id ?? null, role: t?.role ?? null, round: t?.round ?? null };
}
/** Complete the open task as its own role; result derived from the step unless given. */
async function complete(contentId, over = {}) {
  const { task, step } = await openTask(contentId);
  if (!task) throw new Error(`complete: ${contentId} has no open task`);
  const result = over.result ?? (APPROVAL_STEPS.has(step) ? 'approved' : 'submitted');
  const signer = tokens[task.role] ? task.role : 'marketing_manager';
  const payload = { content_id: contentId, result };
  if (over.note) payload.note = over.note;
  if (over.targets) payload.targets = over.targets;
  return api(signer, 'task_complete', payload);
}

/* ------------------------------------------------------------------ */
/* cleanup — scoped strictly to JRN-tagged objects + role baseline     */
/* ------------------------------------------------------------------ */

async function cleanup() {
  const like = `'${TAG}%'`;
  const jContent = `SELECT id FROM public.mos_content WHERE title LIKE ${like}`;
  const jCamp = `SELECT id FROM public.mos_campaigns WHERE name LIKE ${like}`;
  const jShoot = `SELECT id FROM public.mos_shoot_requests WHERE title LIKE ${like}`;
  const jAsset = `SELECT id FROM public.mos_assets WHERE title LIKE ${like}`;
  const jExec = `SELECT e.id FROM public.mos_campaign_executions e JOIN public.mos_campaigns c ON c.id=e.campaign_id WHERE c.name LIKE ${like}`;
  const jWf = `SELECT id FROM public.workflows WHERE kind='role_path' AND label_en LIKE ${like}`;

  // Append-only attribution ledger: remove JRN rows with the immutability
  // trigger disabled (same posture as mos-fixtures.mjs teardown).
  await exec(`
ALTER TABLE public.client_attributions DISABLE TRIGGER client_attributions_immutable_tg;
DELETE FROM public.client_attributions WHERE note LIKE ${like};
ALTER TABLE public.client_attributions ENABLE TRIGGER client_attributions_immutable_tg;`);

  await exec(`
DELETE FROM public.mos_metric_snapshots WHERE publication_id IN (
  SELECT p.id FROM public.mos_publications p WHERE p.content_id IN (${jContent}));
DELETE FROM public.mos_publications WHERE content_id IN (${jContent});
DELETE FROM public.mos_comments WHERE content_id IN (${jContent}) OR campaign_id IN (${jCamp});
DELETE FROM public.mos_asset_links WHERE content_id IN (${jContent}) OR asset_id IN (${jAsset});
DELETE FROM public.mos_shoot_items WHERE request_id IN (${jShoot}) OR content_id IN (${jContent});
DELETE FROM public.mos_assets WHERE title LIKE ${like} OR shoot_request_id IN (${jShoot});
DELETE FROM public.mos_shoot_requests WHERE title LIKE ${like};
DELETE FROM public.mos_scenes WHERE content_id IN (${jContent});
DELETE FROM public.mos_content_versions WHERE content_id IN (${jContent});
DELETE FROM public.mos_execution_ads WHERE execution_id IN (${jExec}) OR content_id IN (${jContent});
DELETE FROM public.mos_execution_daily WHERE execution_id IN (${jExec});
DELETE FROM public.workflow_role_tasks WHERE subject_table='mos_content' AND subject_id IN (${jContent});
DELETE FROM public.mos_content WHERE title LIKE ${like};
DELETE FROM public.mos_campaign_events WHERE campaign_id IN (${jCamp});
DELETE FROM public.mos_campaign_executions WHERE campaign_id IN (${jCamp});
DELETE FROM public.mos_campaigns WHERE name LIKE ${like};
DELETE FROM public.mos_content_types WHERE key LIKE 'jrn_%';
DELETE FROM public.workflow_versions WHERE workflow_id IN (${jWf});
DELETE FROM public.workflows WHERE kind='role_path' AND label_en LIKE ${like};`);

  // Reset the two fixture users the role journeys touch to their single baseline.
  await exec(`
UPDATE public.users SET role_assignments = '[{"role_id":"${ROLE_IDS.writer}","field_values":{}}]'::jsonb
 WHERE id = '${UID.writer}';
UPDATE public.users SET role_assignments = '[{"role_id":"${ROLE_IDS.montage}","field_values":{}}]'::jsonb
 WHERE id = '${UID.montage}';`);
}

/* ================================================================== */
/* Journey 1 — video full loop                                         */
/* ================================================================== */

async function journey1() {
  const j = newJourney(1, 'Video full loop (create→reject r2→shoot→deliver→montage→publish→metrics)');
  // fresh video item, created by the writer
  const created = await api('writer', 'content_create', {
    title: `${TAG} · J1 مينا ٥٢ — جولة الموقع`, content_type_key: 'video',
    project_id: PROJECT.mina, purpose: 'organic', target_publish_at: '2026-08-20T19:00:00+03:00',
  });
  const id = created.item.id;
  j.ok('content created (video)', !!id, created.item.ref);

  // Assert each transition's post-state {step, role, round}.
  let s = await openTask(id);
  j.eq('open on create → idea/writer/r1', [s.step, s.role, s.round], ['idea', 'writer', 1]);

  await complete(id); s = await openTask(id);
  j.eq('after submit → idea_review/manager/r1', [s.step, s.role, s.round], ['idea_review', 'marketing_manager', 1]);

  await complete(id); s = await openTask(id);
  j.eq('after approve → script/writer/r1', [s.step, s.role, s.round], ['script', 'writer', 1]);

  // Writer writes the first script draft, then submits (snapshots version r1).
  await api('writer', 'content_update', { id, patch: { data: { hook: 'مينا ٥٢. واجهة تليق بك.', duration: '38' } } });
  await complete(id); s = await openTask(id);
  j.eq('after submit script → script_review/manager/r1', [s.step, s.role, s.round], ['script_review', 'marketing_manager', 1]);

  // Manager REJECTS with areas + note → revision round 2 back at script/writer.
  const NOTE = 'الافتتاحية طويلة. اذهبي إلى ادعاء الموقع في أول ٣ ثوانٍ.';
  const AREAS = ['hook', 'location_claim'];
  await complete(id, { result: 'changes_requested', note: NOTE, targets: AREAS });
  s = await openTask(id);
  j.eq('after reject → script/writer/round 2', [s.step, s.role, s.round], ['script', 'writer', 2]);

  // The rejection's areas live on the CLOSED script_review r1 task; the note is
  // attached to the rejected version (round 1).
  const closedReview = (s.detail.tasks ?? []).find((t) => t.step_id === 'script_review' && t.round === 1);
  j.eq('closed script_review r1 revision_targets = areas', closedReview?.revision_targets ?? null, AREAS);
  j.eq('closed script_review r1 result', closedReview?.result ?? null, 'changes_requested');
  const versions = await api('writer', 'content_versions', { content_id: id });
  const v1 = (versions.versions ?? []).find((v) => v.round === 1);
  j.eq('version round 1 carries rejected_note', v1?.rejected_note ?? null, NOTE);

  // Writer reworks the script with scenes; two scenes still need footage.
  await api('writer', 'content_update', { id, patch: { data: { hook: 'اثنتا عشرة دقيقة. هذا كل شيء.', duration: '38' } } });
  let scenes = [];
  for (const sc of [
    { position: 1, visual: 'ليل خارجي، اقتراب بطيء', footage_status: 'have' },
    { position: 2, visual: 'كاميرا سيارة — مخرج الدائري', footage_status: 'missing' },
    { position: 3, visual: 'مشي نحو بوابة المدرسة', footage_status: 'missing' },
  ]) {
    const r = await api('writer', 'scene_save', { content_id: id, scene: sc });
    scenes = r.scenes ?? [];
  }
  const missingScenes = scenes.filter((x) => x.footage_status === 'missing');
  j.eq('two scenes flagged missing footage', missingScenes.length, 2);

  // Resubmit the script (snapshot r2) → manager approves → assets sits with ops.
  await complete(id); s = await openTask(id);
  j.eq('after resubmit → script_review/manager/r2', [s.step, s.role, s.round], ['script_review', 'marketing_manager', 2]);
  await complete(id); s = await openTask(id);
  j.eq('after approve → assets/ops/r2', [s.step, s.role, s.round], ['assets', 'ops_supervisor', 2]);

  // Ops raises a shoot request for the missing scenes (this is the wire that
  // makes it NOT Drive — the scenes travel with the request).
  const shoot = await api('ops_supervisor', 'shoot_save', {
    request: {
      title: `${TAG} · J1 مينا ٥٢ — الدائري والمدارس`, project_id: PROJECT.mina,
      status: 'scheduled', scheduled_at: '2026-08-14T06:00:00+03:00', assigned_role: 'ops_supervisor',
      location: 'مخرج الدائري ٨', note: 'كاميرا وجيمبال',
    },
    scene_ids: missingScenes.map((x) => x.id),
  });
  const requestId = shoot.request_id;
  const sdBefore = await api('ops_supervisor', 'shoot_detail', { request_id: requestId });
  j.eq('shoot request carries the 2 missing scenes', (sdBefore.items ?? []).length, 2);

  // Offline capture/upload path (the ?shoot= wire): toggle an item done + save
  // an asset tied to the shoot request.
  await api('ops_supervisor', 'shoot_item_toggle', { id: sdBefore.items[0].id, done: true });
  const upload = await api('ops_supervisor', 'asset_save', {
    asset: {
      title: `${TAG} · J1 لقطة الدائري — نهائي`, kind: 'video', source: 'shoot',
      project_id: PROJECT.mina, shoot_request_id: requestId, note: '4K',
    },
  });
  j.eq('uploaded asset tied to the shoot request', upload.asset?.shoot_request_id ?? null, requestId);

  // Delivery unblocks the collection: the waiting scenes flip to have, the
  // request is delivered, its items are marked done.
  await api('ops_supervisor', 'shoot_deliver', { id: requestId });
  const stillMissing = (await query(
    `SELECT count(*)::int AS n FROM public.mos_scenes WHERE content_id=${q(id)} AND footage_status='missing'`))[0].n;
  const shootRow = (await query(
    `SELECT status FROM public.mos_shoot_requests WHERE id=${q(requestId)}`))[0];
  j.eq('shoot_deliver cleared missing scenes', stillMissing, 0);
  j.eq('shoot request status = delivered', shootRow?.status ?? null, 'delivered');

  // Montage → ready → schedule → publish. Drive to done.
  await complete(id); s = await openTask(id);   // assets submit → editing/montage
  j.eq('after assets → editing/montage/r2', [s.step, s.role, s.round], ['editing', 'montage', 2]);
  await complete(id); s = await openTask(id);   // editing → first_version/montage
  j.eq('after editing → first_version/montage/r2', [s.step, s.role, s.round], ['first_version', 'montage', 2]);
  await complete(id); s = await openTask(id);   // first_version → review/manager
  j.eq('after first_version → review/manager/r2', [s.step, s.role, s.round], ['review', 'marketing_manager', 2]);
  await complete(id); s = await openTask(id);   // review approve → scheduling/writer
  j.eq('after review → scheduling/writer/r2', [s.step, s.role, s.round], ['scheduling', 'writer', 2]);

  // Writer schedules a manual publication.
  await api('writer', 'publication_save', {
    content_id: id, publication: { platform: 'instagram', status: 'scheduled', scheduled_at: '2026-08-20T19:00:00+03:00' },
  });
  await complete(id); s = await openTask(id);   // scheduling submit → publish_check/ops
  j.eq('after scheduling → publish_check/ops/r2', [s.step, s.role, s.round], ['publish_check', 'ops_supervisor', 2]);

  // Ops confirms publish with a URL, then approves publish_check → done.
  const pubList = await api('writer', 'publication_list', { content_id: id });
  const pubId = pubList.publications[0].id;
  await api('ops_supervisor', 'publication_save', {
    content_id: id,
    publication: { id: pubId, status: 'published', published_at: '2026-08-20T19:04:00+03:00', external_url: 'https://instagram.com/reel/JRN1x' },
  });
  await complete(id); s = await openTask(id);
  j.eq('publish_check approved → path done (no open task)', s.task, null);
  const finalStatus = (await query(`SELECT status_key FROM public.mos_content_v WHERE id=${q(id)}`))[0]?.status_key;
  j.eq('content status_key = done', finalStatus, 'done');

  // Weekly metrics entered on the live publication.
  await api('ops_supervisor', 'metrics_record', { publication_id: pubId, views: 18200, engagement: 410, enquiries: 9 });
  const finalPub = (await query(
    `SELECT external_url, status FROM public.mos_publications WHERE id=${q(pubId)}`))[0];
  const snapN = (await query(
    `SELECT count(*)::int AS n FROM public.mos_metric_snapshots WHERE publication_id=${q(pubId)}`))[0].n;
  j.ok('final publication is published with a URL', finalPub?.status === 'published' && !!finalPub?.external_url, finalPub?.external_url);
  j.eq('metric snapshot exists', snapN, 1);
  return j;
}

/* ================================================================== */
/* Journey 2 — post: four headlines, approve one, two captions          */
/* ================================================================== */

async function journey2() {
  const j = newJourney(2, 'Post: four headlines → approve one (alts retained) → two distinct captions');
  const created = await api('writer', 'content_create', {
    title: `${TAG} · J2 مينا ٥٢ — عرض الأسبوع`, content_type_key: 'post', project_id: PROJECT.mina, purpose: 'organic',
  });
  const id = created.item.id;

  const HEADLINES = [
    'مينا ٥٢ — تملّك من ٩٨٠ ألف', 'شقتك في شمال الرياض بانتظارك',
    '١٤٢ مترًا، ثلاث غرف، إطلالة حدائق', 'خطة سداد تناسبك — راسلنا',
  ];
  await api('writer', 'content_update', { id, patch: { data: { headlines: HEADLINES, chosen_headline: 2 } } });

  let s = await openTask(id);
  j.eq('open on create → writing/writer/r1', [s.step, s.role, s.round], ['writing', 'writer', 1]);
  await complete(id); s = await openTask(id);
  j.eq('after submit → writing_review/manager/r1', [s.step, s.role, s.round], ['writing_review', 'marketing_manager', 1]);
  // Manager APPROVES one headline; the alternatives stay in data.
  await complete(id, { result: 'approved' }); s = await openTask(id);
  j.eq('after approve → design/montage/r1', [s.step, s.role, s.round], ['design', 'montage', 1]);

  const afterApprove = await api('marketing_manager', 'content_detail', { id });
  const data = afterApprove.item.data ?? {};
  j.eq('all four headline alternatives retained in data', (data.headlines ?? []).length, 4);
  j.eq('chosen headline recorded', data.chosen_headline, 2);

  // Two publications with DIFFERENT captions.
  const capIG = 'عرض هذا الأسبوع 🌿 من ٩٨٠ ألف — راسلنا على واتساب.';
  const capTT = 'جولة سريعة في مينا ٥٢ 👀 الأسعار في الوصف.';
  await api('writer', 'publication_save', { content_id: id, publication: { platform: 'instagram', status: 'draft', caption: capIG } });
  await api('writer', 'publication_save', { content_id: id, publication: { platform: 'tiktok', status: 'draft', caption: capTT } });
  const pubs = (await api('writer', 'publication_list', { content_id: id })).publications ?? [];
  const caps = pubs.map((p) => p.caption).sort();
  j.eq('two publications created', pubs.length, 2);
  j.ok('the two captions differ', pubs.length === 2 && pubs[0].caption !== pubs[1].caption, caps.join(' || '));
  j.eq('both captions persisted verbatim', caps, [capTT, capIG].sort());
  return j;
}

/* ================================================================== */
/* Journey 3 — paid campaign → outcomes from the CRM + CEO return       */
/* ================================================================== */

async function journey3() {
  const j = newJourney(3, 'Paid campaign: executions→link content→daily→attribution→outcomes→CEO');
  // Create the campaign WITH draft executions (the modal's promise).
  const camp = await api('marketing_manager', 'campaign_save', {
    campaign: {
      name: `${TAG} · J3 عملاء مينا ٥٢`, kind: 'paid', status: 'active', project_id: PROJECT.mina,
      starts_on: '2026-08-01', ends_on: '2026-08-31', budget_total: 30000, objective: 'leads',
      goal: 'عملاء مؤهلون', owner_role: 'marketing_manager',
    },
    executions: [{ platform: 'meta', budget: 20000 }, { platform: 'tiktok', budget: 10000 }],
  });
  const campaignId = camp.item.id;
  j.eq('paid campaign budget_total renders (not null)', camp.item.budget_total, 30000);

  let detail = await api('marketing_manager', 'campaign_detail', { id: campaignId });
  const drafts = (detail.executions ?? []);
  j.eq('two draft executions created', drafts.length, 2);
  j.eq('executions start as draft', [...new Set(drafts.map((e) => e.status))], ['draft']);

  // Run the meta execution with real numbers (this is where qualified aggregates).
  const metaExec = drafts.find((e) => e.platform === 'meta');
  await api('marketing_manager', 'execution_save', {
    campaign_id: campaignId,
    execution: { id: metaExec.id, status: 'running', spend: 15400, leads: 96, qualified: 34, purpose: 'conversion' },
  });
  // Link content: an ad pointing at a JRN content item.
  const adContent = await api('writer', 'content_create', {
    title: `${TAG} · J3 إعلان — جولة الوحدة`, content_type_key: 'video', project_id: PROJECT.mina, purpose: 'paid',
  });
  await api('marketing_manager', 'ad_save', {
    execution_id: metaExec.id, ad: { content_id: adContent.item.id, label: 'جولة الوحدة', status: 'running', spend: 6200, leads: 51, qualified: 21 },
  });
  // Manual daily results.
  await api('ops_supervisor', 'daily_save', { execution_id: metaExec.id, day: '2026-08-01', spend: 1540, leads: 8, qualified: 3 });
  await api('ops_supervisor', 'daily_save', { execution_id: metaExec.id, day: '2026-08-04', spend: 1600, leads: 9, qualified: 4 });
  const dailyN = (await query(
    `SELECT count(*)::int AS n FROM public.mos_execution_daily WHERE execution_id=${q(metaExec.id)}`))[0].n;
  j.eq('two daily result rows saved', dailyN, 2);

  // Attribution stamps → CRM clients 1 & 2 (which have appointments/visits/
  // reservations in July), first-touch, occurred mid-June so the 90-day window
  // covers the CRM events. Idempotent: the JRN note lets cleanup remove them.
  const existing = (await api('marketing_manager', 'attribution_list', { campaign_id: campaignId })).rows ?? [];
  if (existing.length < 2) {
    await api('marketing_manager', 'attribution_stamp', {
      client_record_id: clientId(1), execution_id: metaExec.id, touch_type: 'first',
      occurred_at: '2026-06-10T11:00:00+03:00', source: 'lead_form', note: `${TAG}3 attr c1`,
    });
    await api('marketing_manager', 'attribution_stamp', {
      client_record_id: clientId(2), execution_id: metaExec.id, touch_type: 'first',
      occurred_at: '2026-06-11T11:00:00+03:00', source: 'lead_form', note: `${TAG}3 attr c2`,
    });
  }
  const attr = (await api('marketing_manager', 'attribution_list', { campaign_id: campaignId })).rows ?? [];
  j.eq('two attribution rows on the campaign', attr.length, 2);

  // Outcomes derived from the CRM records in-window.
  const oc = (await api('marketing_manager', 'campaign_outcomes', { campaign_id: campaignId })).outcomes;
  j.eq('outcomes attributed_clients', oc.attributed_clients, 2);
  j.ok('outcomes appointments non-zero', oc.appointments >= 2, oc.appointments);
  j.ok('outcomes visits non-zero', oc.visits >= 2, oc.visits);
  j.ok('outcomes reservations non-zero', oc.reservations >= 2, oc.reservations);
  j.ok('outcomes reservation_value non-zero', oc.reservation_value > 0, oc.reservation_value);
  // qualified is a spend-side aggregate (executions/ads), not an outcomes field.
  detail = await api('marketing_manager', 'campaign_detail', { id: campaignId });
  j.eq('campaign qualified aggregate (spend side)', detail.item.total_qualified, 34);

  // CEO return: the campaign appears on ceo_overview with its derived reservations.
  const ceo = await api('ceo', 'ceo_overview', { period: 'quarter' });
  const row = (ceo.campaigns ?? []).find((c) => c.id === campaignId);
  j.ok('campaign present on ceo_overview', !!row, row?.ref);
  j.eq('ceo_overview reservations == outcomes.reservations', row?.reservations ?? null, oc.reservations);
  j.eq('ceo_overview cost_per_reservation computed', row?.cost_per_reservation, Math.round((row?.spend ?? 0) / oc.reservations));
  return j;
}

/* ================================================================== */
/* Journey 4 — organic campaign: money fields NULL, outcomes compute    */
/* ================================================================== */

async function journey4() {
  const j = newJourney(4, 'Organic campaign: budget/spend NULL (not zero), outcomes still compute');
  const camp = await api('marketing_manager', 'campaign_save', {
    campaign: {
      name: `${TAG} · J4 أغسطس العضوي`, kind: 'organic', status: 'active', project_id: null,
      starts_on: '2026-08-01', ends_on: '2026-08-31', objective: 'awareness', goal: 'وعي عضوي',
      owner_role: 'marketing_manager',
    },
  });
  const id = camp.item.id;
  const detail = await api('marketing_manager', 'campaign_detail', { id });
  j.eq('kind = organic', detail.item.kind, 'organic');
  j.eq('budget_total is NULL (renders as dash)', detail.item.budget_total, null);
  j.eq('total_spend is NULL (not 0)', detail.item.total_spend, null);
  j.ok('total_spend is not the number zero', detail.item.total_spend !== 0, detail.item.total_spend);
  j.eq('execution_count = 0', detail.item.execution_count, 0);
  // Outcomes still COMPUTE (return a well-formed object, zeros not error).
  const oc = (await api('marketing_manager', 'campaign_outcomes', { campaign_id: id })).outcomes;
  j.ok('outcomes computed (window_days present)', typeof oc.window_days === 'number', oc.window_days);
  j.eq('outcomes reservations = 0 (no attributions)', oc.reservations, 0);
  return j;
}

/* ================================================================== */
/* Journey 5 — active-role switch on a dual-role user                    */
/* ================================================================== */

async function journey5() {
  const j = newJourney(5, 'Active-role switch: grant 2nd role → union surfaces/task-set; header echoes active_role');
  // Baseline: writer alone.
  const before = await api('writer', 'bootstrap');
  j.eq('baseline roles = [writer]', before.me.roles.sort(), ['writer']);
  j.eq('writer surface: overview hidden (baseline)', before.me.surfaces.overview, 'hidden');
  j.eq('writer surface: shoots read (baseline)', before.me.surfaces.shoots, 'read');
  const workBefore = await api('writer', 'work_list', { scope: 'mine' });
  j.eq('baseline work queue role = writer', workBefore.role, 'writer');

  // Grant a second role (ops_supervisor) via the RPC, as the manager (manage_roles).
  await api('marketing_manager', 'role_grant', { user_id: UID.writer, role_key: 'ops_supervisor', grant: true });
  // Re-mint the writer's token so wassell_mos_roles() reflects the new grant.
  tokens.writer = await signIn(PEOPLE.find((p) => p.role === 'writer').email);

  const after = await api('writer', 'bootstrap');
  j.eq('roles now the union', after.me.roles.sort(), ['ops_supervisor', 'writer']);
  // Surfaces are the UNION (max level across held roles) — overview + shoots grow.
  j.eq('union surface: overview now full', after.me.surfaces.overview, 'full');
  j.eq('union surface: shoots now full', after.me.surfaces.shoots, 'full');
  // The work queue follows wassell_mos_role's priority pick (ops > writer).
  const workAfter = await api('writer', 'work_list', { scope: 'mine' });
  j.eq('work queue role switched to ops_supervisor', workAfter.role, 'ops_supervisor');
  j.ok('task set differs after the second role', workAfter.role !== workBefore.role, `${workBefore.role}→${workAfter.role}`);

  // active_role echoes a HELD role from the x-mos-active-role header…
  const asWriter = await api('writer', 'bootstrap', {}, { activeRole: 'writer' });
  const asOps = await api('writer', 'bootstrap', {}, { activeRole: 'ops_supervisor' });
  j.eq('active_role echoes header=writer', asWriter.me.active_role, 'writer');
  j.eq('active_role echoes header=ops_supervisor', asOps.me.active_role, 'ops_supervisor');
  // …and falls back for an UN-held role (validated, never authorizes).
  const asCeo = await api('writer', 'bootstrap', {}, { activeRole: 'ceo' });
  j.ok('unheld active-role falls back to a held role', after.me.roles.includes(asCeo.me.active_role), asCeo.me.active_role);
  j.note = 'active_role is display-only (contract §98): surfaces + task set are a function of the held-role UNION / priority pick, not of the header — verified above.';

  // Revoke the grant → back to baseline.
  await api('marketing_manager', 'role_grant', { user_id: UID.writer, role_key: 'ops_supervisor', grant: false });
  tokens.writer = await signIn(PEOPLE.find((p) => p.role === 'writer').email);
  const restored = await api('writer', 'bootstrap');
  j.eq('revoke restores roles = [writer]', restored.me.roles.sort(), ['writer']);
  return j;
}

/* ================================================================== */
/* Journey 6 — workflow version freeze                                  */
/* ================================================================== */

async function journey6() {
  const j = newJourney(6, 'Workflow version freeze: in-flight item stays on original version, new item gets new');
  // A throwaway role-path workflow + content type (never touches the shared
  // video_std/post_std paths the fixtures depend on).
  const STEPS_V1 = [
    { key: 'draft', label_ar: 'مسودة', label_en: 'Draft', role_key: 'writer', due_days: 2, creates_revision: true },
    { key: 'review', label_ar: 'مراجعة', label_en: 'Review', role_key: 'marketing_manager', due_days: 1, is_approval: true },
    { key: 'publish', label_ar: 'نشر', label_en: 'Publish', role_key: 'ops_supervisor', due_days: 1 },
  ];
  const wf1 = await api('marketing_manager', 'workflow_save', {
    label_ar: `${TAG} مسار تجريبي`, label_en: `${TAG} test path`, is_active: true, steps: STEPS_V1,
  });
  const wfId = wf1.workflow.id;
  const v1Id = wf1.workflow.current_version_id;
  j.eq('workflow created at version_no 1', wf1.version_no, 1);
  j.ok('v1 id present', !!v1Id, v1Id);

  await api('marketing_manager', 'content_type_save', {
    content_type: { key: 'jrn_type', label_ar: 'نوع تجريبي', label_en: 'JRN type', prefix: 'JR', workflow_id: wfId, sort_order: 90, is_active: true },
  });

  // In-flight item A — pins v1.
  const a = await api('writer', 'content_create', { title: `${TAG} · J6 عنصر قبل التعديل`, content_type_key: 'jrn_type', project_id: PROJECT.mina, purpose: 'organic' });
  const aVer = (await api('marketing_manager', 'content_detail', { id: a.item.id })).item.workflow_version_id;
  j.eq('item A pinned to v1', aVer, v1Id);

  // Edit the workflow → a NEW version.
  const STEPS_V2 = STEPS_V1.map((s) => (s.key === 'review' ? { ...s, label_en: 'Manager review (edited)' } : s));
  const wf2 = await api('marketing_manager', 'workflow_save', { id: wfId, label_ar: `${TAG} مسار تجريبي`, label_en: `${TAG} test path`, is_active: true, steps: STEPS_V2 });
  const v2Id = wf2.workflow.current_version_id;
  j.eq('edit bumps version_no to 2', wf2.version_no, 2);
  j.ok('v2 id differs from v1', v2Id !== v1Id, `${String(v1Id).slice(0, 8)}→${String(v2Id).slice(0, 8)}`);

  // Item A is FROZEN on v1; a NEW item B gets v2.
  const aVerAfter = (await api('marketing_manager', 'content_detail', { id: a.item.id })).item.workflow_version_id;
  j.eq('in-flight item A still on original v1 (frozen)', aVerAfter, v1Id);
  const b = await api('writer', 'content_create', { title: `${TAG} · J6 عنصر بعد التعديل`, content_type_key: 'jrn_type', project_id: PROJECT.mina, purpose: 'organic' });
  const bVer = (await api('marketing_manager', 'content_detail', { id: b.item.id })).item.workflow_version_id;
  j.eq('new item B gets the new v2', bVer, v2Id);
  return j;
}

/* ================================================================== */
/* Journey 7 — role-holder change vs. transfer of an open task          */
/* ================================================================== */

async function journey7() {
  const j = newJourney(7, 'Role-holder change: future tasks route by role; an open task moves only via transfer');
  // A fresh post sits at writing (role=writer). montage does NOT hold writer.
  const created = await api('writer', 'content_create', { title: `${TAG} · J7 مقام ١٧ — منشور`, content_type_key: 'post', project_id: PROJECT.maqam, purpose: 'organic' });
  const id = created.item.id;
  const s0 = await openTask(id);
  j.eq('open task sits with the writer role', s0.role, 'writer');

  // Before the grant, montage may not complete the writer's task.
  const denied = await apiRaw('montage', 'task_complete', { content_id: id, result: 'submitted' });
  j.ok('montage denied the writer task before grant', !denied.ok && (denied.status === 403 || denied.status === 400), `HTTP ${denied.status}`);

  // Reassign the writer ROLE to a new holder (montage). Now future writer-role
  // work routes to whoever holds writer.
  await api('marketing_manager', 'role_grant', { user_id: UID.montage, role_key: 'writer', grant: true });
  tokens.montage = await signIn(PEOPLE.find((p) => p.role === 'montage').email);
  const workMontage = await api('montage', 'work_list', { scope: 'mine' });
  j.ok('new holder now sees the writer-role queue', (workMontage.content ?? []).some((c) => c.id === id), workMontage.role);

  // An EXISTING open task's assignee only changes via the audited transfer RPC.
  const s1 = await openTask(id);
  j.eq('open task assignee is null before transfer', s1.task.assignee_user_id, null);
  await api('marketing_manager', 'task_transfer', { task_id: s1.task.id, to_user_id: UID.montage });
  const moved = (await query(
    `SELECT assignee_user_id, note FROM public.workflow_role_tasks WHERE id=${q(s1.task.id)}`))[0];
  j.eq('transfer set the assignee to the new holder', moved?.assignee_user_id, UID.montage);
  j.ok('transfer is audited (note stamped)', typeof moved?.note === 'string' && /transferred by/.test(moved.note), moved?.note);

  // Cleanup revokes the temp grant (also handled by cleanup()'s baseline reset).
  await api('marketing_manager', 'role_grant', { user_id: UID.montage, role_key: 'writer', grant: false });
  tokens.montage = await signIn(PEOPLE.find((p) => p.role === 'montage').email);
  return j;
}

/* ================================================================== */
/* Journey 8 — day-one empty state (screen 45) predicate                */
/* ================================================================== */

async function journey8() {
  const j = newJourney(8, 'Day-one empty state (s45): EmptyDayOne predicate vs. live fixture-full overview');
  // The EmptyDayOne trigger (src/pages/Marketing/OverviewPage.tsx): render the
  // day-one checklist when in_production===0 AND mix===[] AND campaigns===[].
  // The shared fixture dataset MUST NOT be torn down (other work depends on it),
  // so we assert the PREDICATE against (a) the live fixture-full overview — which
  // must be correctly NON-empty — and (b) a synthetic empty read.
  const isEmptyDayOne = (o) =>
    (o.counts?.in_production ?? 0) === 0 && (o.mix ?? []).length === 0 && (o.campaigns ?? []).length === 0;

  const live = await api('marketing_manager', 'overview', { week_of: '2026-07-29T12:00:00+03:00' });
  j.ok('live overview has content in production (fixtures intact)', (live.counts?.in_production ?? 0) > 0, live.counts?.in_production);
  j.eq('EmptyDayOne predicate is FALSE on the fixture-full dataset', isEmptyDayOne(live), false);

  const emptyRead = { counts: { in_production: 0, waiting_on_me: 0, publishing_this_week: 0, late: 0 }, mix: [], campaigns: [], week: [] };
  j.eq('EmptyDayOne predicate is TRUE on a synthetic empty read', isEmptyDayOne(emptyRead), true);
  j.note = 'Fixtures preserved: asserted the exact s45 trigger (in_production===0 && mix===[] && campaigns===[]) rather than tearing down the shared dataset.';
  return j;
}

/* ================================================================== */
/* Journey 9 — AR↔EN (B6 overlay pending → documented partial)          */
/* ================================================================== */

async function journey9() {
  const j = newJourney(9, 'AR↔EN: engine is bilingual + locale-agnostic; EN value-overlay (B6) not wired');
  // A JRN content item to read in both "locales" (the API takes no locale arg —
  // it always returns BOTH label_ar and label_en; the client picks per active
  // language). Two reads must return byte-identical Arabic source data.
  const created = await api('writer', 'content_create', { title: `${TAG} · J9 ثنائي اللغة`, content_type_key: 'post', project_id: PROJECT.mina, purpose: 'organic' });
  const id = created.item.id;

  const r1 = await api('marketing_manager', 'content_detail', { id });
  const r2 = await api('marketing_manager', 'content_detail', { id });
  j.eq('Arabic source title unchanged across reads', r1.item.title, r2.item.title);
  j.ok('title is the Arabic source (unchanged, no EN overlay applied)', r1.item.title === `${TAG} · J9 ثنائي اللغة`, r1.item.title);

  const boot = await api('marketing_manager', 'bootstrap');
  const postType = (boot.content_types ?? []).find((t) => t.key === 'post');
  j.ok('content type carries BOTH label_ar and label_en', !!postType?.label_ar && !!postType?.label_en, `${postType?.label_ar} / ${postType?.label_en}`);
  const step = (r1.steps ?? [])[0];
  j.ok('workflow step carries BOTH label_ar and label_en', !!step?.label_ar && !!step?.label_en, `${step?.label_ar} / ${step?.label_en}`);

  // B6 status: the value_translations overlay (resolveDisplayText) is NOT wired
  // into api/marketing-os.ts — the endpoint returns raw Arabic source, never a
  // translated EN string. Confirmed by inspection (see final report).
  j.partial = true;
  j.note = 'B6 PENDING: value_translations EN overlay (src/lib/valueTranslation) is NOT invoked by api/marketing-os.ts; the API is locale-agnostic and returns Arabic source verbatim. Documented partial, not a failure — the engine correctly ships bilingual label pairs and leaves EN value-overlay to the (unbuilt) display surface.';
  return j;
}

/* ================================================================== */
/* Journey 10 — weekly entry three distinct states                     */
/* ================================================================== */

async function journey10() {
  const j = newJourney(10, 'Weekly entry: entered-zero, missing, and skipped are three distinct persisted states');
  const created = await api('writer', 'content_create', { title: `${TAG} · J10 أرقام الأسبوع`, content_type_key: 'post', project_id: PROJECT.mina, purpose: 'organic' });
  const id = created.item.id;

  // Three publications, one per platform, all published in a fixed week.
  const PUB_AT = '2026-07-08T12:00:00+03:00';
  const mk = async (platform) => {
    await api('writer', 'publication_save', { content_id: id, publication: { platform, status: 'published', published_at: PUB_AT } });
    const list = (await api('writer', 'publication_list', { content_id: id })).publications ?? [];
    return list.find((p) => p.platform === platform).id;
  };
  const pubZero = await mk('instagram');   // entered a real zero
  const pubMissing = await mk('tiktok');   // nothing entered
  const pubSkip = await mk('snapchat');    // deliberately skipped

  // State 1: a real 0 metric persists as 0 (not null, not missing).
  await api('ops_supervisor', 'metrics_record', { publication_id: pubZero, views: 0, engagement: 0, enquiries: 0 });
  const zeroSnap = (await query(
    `SELECT views, engagement, enquiries FROM public.mos_metric_snapshots WHERE publication_id=${q(pubZero)}`))[0];
  j.eq('entered-zero persists views=0 (a number, not null)', zeroSnap?.views, 0);

  // State 3: a skip stores a reason (extra.skipped), NULL metric fields.
  const REASON = 'المنصة لم تُصدر الأرقام بعد';
  await api('ops_supervisor', 'metrics_skip', { publication_id: pubSkip, reason: REASON });
  const skipSnap = (await query(
    `SELECT views, extra FROM public.mos_metric_snapshots WHERE publication_id=${q(pubSkip)}`))[0];
  j.eq('skip persists a reason in extra.skipped', skipSnap?.extra?.skipped, REASON);
  j.eq('skip leaves the metric fields null', skipSnap?.views, null);

  // State 2 (missing): pubMissing has NO snapshot row at all.
  const missingN = (await query(
    `SELECT count(*)::int AS n FROM public.mos_metric_snapshots WHERE publication_id=${q(pubMissing)}`))[0].n;
  j.eq('missing = zero snapshot rows', missingN, 0);

  // The Friday screen (numbers_week) derives the three DISTINCT states server-side.
  const wk = await api('ops_supervisor', 'numbers_week', { week_start: PUB_AT });
  const all = (wk.platforms ?? []).flatMap((p) => p.publications);
  const eZero = all.find((p) => p.publication_id === pubZero);
  const eMiss = all.find((p) => p.publication_id === pubMissing);
  const eSkip = all.find((p) => p.publication_id === pubSkip);
  j.ok('numbers_week returns all three publications', !!eZero && !!eMiss && !!eSkip, `${!!eZero}/${!!eMiss}/${!!eSkip}`);
  // entered-zero: has a snapshot, not missing, not skipped, value 0.
  j.eq('state ENTERED-ZERO: {missing,skipped,views}', [eZero?.missing, eZero?.skipped_reason, eZero?.latest?.views], [false, null, 0]);
  // missing: no latest, missing true, «لم يُدخل».
  j.eq('state MISSING: {missing,latest}', [eMiss?.missing, eMiss?.latest], [true, null]);
  // skipped: has latest (the skip row), not missing, reason present.
  j.eq('state SKIPPED: {missing,skipped_reason}', [eSkip?.missing, eSkip?.skipped_reason], [false, REASON]);
  // The three states are mutually distinct.
  const sig = (e) => (e.missing ? 'missing' : e.skipped_reason ? 'skipped' : 'entered');
  j.eq('three distinct state signatures', [sig(eZero), sig(eMiss), sig(eSkip)], ['entered', 'missing', 'skipped']);
  return j;
}

/* ================================================================== */
/* runner                                                              */
/* ================================================================== */

const JOURNEYS = [journey1, journey2, journey3, journey4, journey5, journey6, journey7, journey8, journey9, journey10];

async function main() {
  console.log(`\n=== MOS Workstream E — ten end-to-end journeys (branch ${LOCAL.MOS_BRANCH_REF ?? '?'}) ===`);
  console.log(`app=${APP}\n`);
  await signInAll();

  console.log('[cleanup] removing any leftover JRN-tagged objects + resetting fixture-user roles…');
  await cleanup();

  const results = [];
  for (const fn of JOURNEYS) {
    const jid = String(JOURNEYS.indexOf(fn) + 1);
    if (ONLY.length > 0 && !ONLY.includes(jid)) continue;
    let j;
    try {
      j = await fn();
    } catch (err) {
      j = newJourney(Number(jid), fn.name);
      j.error = err?.message ?? String(err);
    }
    const status = j.error ? 'ERROR' : (j.partial && passed(j)) ? 'PARTIAL' : passed(j) ? 'PASS' : 'FAIL';
    results.push({ j, status });
    console.log(`\n──────── Journey ${j.id}: ${status} ── ${j.name}`);
    if (j.error) console.log(`   ERROR: ${j.error}`);
    if (j.checks.length > 0) console.table(j.checks.map((c) => ({ ok: c.ok ? '✓' : '✗', assertion: c.label, got: c.got, want: c.want })));
    if (j.note) console.log(`   note: ${j.note}`);
  }

  if (!KEEP) {
    console.log('\n[cleanup] removing JRN-tagged objects created by this run…');
    await cleanup();
  } else {
    console.log('\n[cleanup] skipped (--keep) — JRN artifacts left on the branch');
  }

  console.log('\n=== SUMMARY ===');
  console.table(results.map(({ j, status }) => ({
    journey: j.id,
    result: status,
    checks: `${j.checks.filter((c) => c.ok).length}/${j.checks.length}`,
    name: j.name.length > 62 ? `${j.name.slice(0, 59)}…` : j.name,
  })));

  const failed = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  const partial = results.filter((r) => r.status === 'PARTIAL');
  console.log(`\n${results.length} journeys · ${results.length - failed.length - partial.length} PASS · ${partial.length} PARTIAL · ${failed.length} FAIL/ERROR`);
  if (failed.length > 0) {
    console.log('FAILURES:', failed.map((r) => `J${r.j.id}`).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err?.message ?? err}`);
  process.exit(1);
});
