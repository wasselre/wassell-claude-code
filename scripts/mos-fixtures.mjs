#!/usr/bin/env node
/**
 * mos-fixtures.mjs — build (and tear down) the approved Marketing OS design
 * dataset on the isolated Supabase BRANCH.
 *
 * The dataset transcribes the reference mockups in
 * docs/marketing-reference/source/screens/ (s02, s03, s06, s07, s09, s10, s11,
 * s12, s14, s16, s20, s21, s24, s34, s35, s37, s40, s41, s42, s50) so the
 * rebuilt screens capture against the exact names/numbers they were
 * designed around.
 *
 * CHANNELS
 *   Phase 0 (platform seed)  — raw SQL through the token-gated, branch-only
 *     `mos_bootstrap_exec` / `mos_bootstrap_query` RPCs (copied from
 *     scripts/apply-branch-sql.mjs / scripts/verify-branch-bootstrap.mjs).
 *     Used ONLY for: profile, auth users, public.users, CRM record rows,
 *     ref-counter offsets, settings, and teardown. NEVER for marketing-domain
 *     objects.
 *   Phase 1 (domain data)    — the REAL /api/marketing-os endpoint on the
 *     MOS_APP_URL dev stack, signed in as the role that would own each write.
 *     RLS, the role-path engine, the ref triggers and notify_emit all run for
 *     real — that is the point of the fixture.
 *
 * KEY DECISIONS (read before editing)
 *   1. REF OFFSETS. The branch's ref allocator (mos_tg_assign_ref →
 *      mos_next_ref, branch-bootstrap-04) mints from the SHARED
 *      mos_ref_counters table, which starts empty. Phase 0 upserts offsets
 *      (GREATEST — never rewinds) so creation order produces the mockup refs
 *      exactly: V- at 1, P- at 11, C- at 2, SH- at 3. mos_content_types.
 *      next_number is seeded too, defensively, for the older per-type
 *      allocator generation. After every create the allocated ref is checked
 *      against the expectation and a mismatch THROWS — we do not mislabel.
 *   2. SHOOT PREFIX DIVERGENCE. The branch trigger (mos_tg_shoot_ref) mints
 *      'SH-', while the mockups label shoot requests 'SR-005'. Exact 'SR-'
 *      refs are impossible through the real API without editing the trigger,
 *      so shoots are created as SH-003..SH-005 and the divergence is warned
 *      loudly at build time and reported by --verify. (Everything else —
 *      V/P/C/A — matches exactly.)
 *   3. s24 IS SR-005. The task brief said "items linked to V-004's missing
 *      scenes for SR-003 per s24" — but s24's breadcrumb is SR-005 and s42
 *      shows SR-003 as the delivered «مقام ١٧ — خارجيات». The mockups win:
 *      the scene items hang on the scheduled request (SH-005).
 *   4. CONFLICTING MOCKUPS. V-002's TikTok: s11 says scheduled, s12 says
 *      published with numbers «ناقص», s50 shows numbers entered. s12 (the
 *      performance screen) wins: published 31 July with NO snapshot, which
 *      also supplies the required «ناقص» case. P-016 is published 30 July
 *      with no metrics (s50's «أدخل» row) — the second ناقص.
 *   5. CAROUSELS. P-012/P-018/P-019 are created with content_type 'carousel'
 *      (s03/s21 show كاروسيل). The shared 'P-' counter keeps the series
 *      gap-free; under the older per-type allocator this would collide and
 *      the ref check would throw — by design.
 *   6. IDEMPOTENCY. Re-runs converge: existing refs/titles are skipped,
 *      counter seeds never rewind, links/upserts are replay-safe, and
 *      driveTo() is a no-op for items already at their target step.
 *
 * CONFIG: .mos-branch.local (KEY=VALUE) or env —
 *   MOS_BRANCH_URL, MOS_BRANCH_ANON_KEY, MOS_BOOTSTRAP_TOKEN   (branch SQL)
 *   MOS_APP_URL           default http://localhost:3000 (mos-dev-server stack)
 *   MOS_FIXTURE_PASSWORD  default 'MosFixture!2026'
 *
 * USAGE:
 *   node scripts/mos-fixtures.mjs                 # phase 0 + phase 1
 *   node scripts/mos-fixtures.mjs --phase 0       # platform seed only
 *   node scripts/mos-fixtures.mjs --phase 1       # domain build only
 *   node scripts/mos-fixtures.mjs --teardown      # remove all fixture data
 *   node scripts/mos-fixtures.mjs --verify        # print the dataset table
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(__dirname, '..');

/* ------------------------------------------------------------------ */
/* config (loader copied from scripts/apply-branch-sql.mjs)            */
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

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const PHASE = opt('--phase') ?? 'all';
const DO_TEARDOWN = argv.includes('--teardown');
const DO_VERIFY = argv.includes('--verify');
if (!['0', '1', 'all'].includes(PHASE)) {
  console.error(`FATAL: --phase must be 0, 1 or all (got '${PHASE}')`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* raw SQL channels (branch only)                                      */
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
/** DDL/DML on the branch. Returns the (opaque) ack body. */
const exec = (sql) => rpc('mos_bootstrap_exec', { p_token: TOKEN, p_sql: sql });
/** SELECT on the branch. Returns an array of row objects. */
const query = async (sql) => JSON.parse(await rpc('mos_bootstrap_query', { p_token: TOKEN, p_sql: sql }));

/** SQL text literal. */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** SQL jsonb literal from a JS value. */
const qj = (v) => `${q(JSON.stringify(v))}::jsonb`;

/* ------------------------------------------------------------------ */
/* the five fixture people (s37 «الأدوار ومن يشغلها»)                  */
/* ------------------------------------------------------------------ */

const PROFILE_ID = 'f1de0001-0000-4000-8000-000000000001';
const ROLE_IDS = {
  ceo: 'c0febe01-0000-4000-8000-000000000001',
  marketing_manager: 'c0febe01-0000-4000-8000-000000000002',
  ops_supervisor: 'c0febe01-0000-4000-8000-000000000003',
  writer: 'c0febe01-0000-4000-8000-000000000004',
  montage: 'c0febe01-0000-4000-8000-000000000005',
};
// Names transcribed from s37: ريان العبدالله (CEO) · ريان (مدير التسويق) ·
// نور (مشرف العمليات) · مريم (الكاتب) · سارة (المونتير).
const PEOPLE = [
  { role: 'ceo', uid: 'f1de0002-0000-4000-8000-000000000001', email: 'mos-ceo@fixtures.wassel.local', name_ar: 'ريان العبدالله', name_en: 'Rayan Alabdullah', phone: '+96655501001' },
  { role: 'marketing_manager', uid: 'f1de0002-0000-4000-8000-000000000002', email: 'mos-marketing_manager@fixtures.wassel.local', name_ar: 'ريان', name_en: 'Rayan', phone: '+96655501002' },
  { role: 'ops_supervisor', uid: 'f1de0002-0000-4000-8000-000000000003', email: 'mos-ops_supervisor@fixtures.wassel.local', name_ar: 'نور', name_en: 'Nour', phone: '+96655501003' },
  { role: 'writer', uid: 'f1de0002-0000-4000-8000-000000000004', email: 'mos-writer@fixtures.wassel.local', name_ar: 'مريم', name_en: 'Maryam', phone: '+96655501004' },
  { role: 'montage', uid: 'f1de0002-0000-4000-8000-000000000005', email: 'mos-montage@fixtures.wassel.local', name_ar: 'سارة', name_en: 'Sarah', phone: '+96655501005' },
];

/* ------------------------------------------------------------------ */
/* CRM fixture rows (phase 0, SQL)                                     */
/* ------------------------------------------------------------------ */

const MODEL_IDS = {
  appointments: 'b032a675-6237-4436-9783-a1a253855f74',
  visits: '372ed642-3753-40b4-9dd7-e8390f91b1f8',
  reservations: '5a1e0ffe-0000-4000-8000-000000000002',
};
const PROJECTS = [
  { id: 'f1de0010-0000-4000-8000-000000000001', key: 'mina', data: { project_name: 'مينا ٥٢' } },
  { id: 'f1de0010-0000-4000-8000-000000000002', key: 'maqam', data: { project_name: 'مقام ١٧' } },
];
const PROJECT = Object.fromEntries(PROJECTS.map((p) => [p.key, p.id]));
const clientId = (n) => `f1de0011-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLIENTS = Array.from({ length: 12 }, (_, i) => ({
  id: clientId(i + 1),
  data: { client_name: `عميل تجربة ${i + 1}`, phone_number: `+96655501${String(i + 1).padStart(2, '0')}` },
}));
const APPOINTMENTS = Array.from({ length: 6 }, (_, i) => ({
  id: `f1de0012-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  data: {
    client_id: clientId(i + 1),
    appointment_date: `2026-07-${21 + i}T12:00:00+03`,
    appointment_status: i === 5 ? 'cancelled' : 'completed',
  },
}));
const VISITS = Array.from({ length: 4 }, (_, i) => ({
  id: `f1de0013-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  data: { client_id: clientId(i + 1), scheduled_datetime: `2026-07-${22 + i}T15:00:00+03` },
}));
const RESERVATIONS = [
  { id: 'f1de0014-0000-4000-8000-000000000001', data: { client_id: clientId(1), reservation_date: '2026-07-28T10:00:00+03', reservation_amount: '850000', payment_status: 'paid' } },
  { id: 'f1de0014-0000-4000-8000-000000000002', data: { client_id: clientId(2), reservation_date: '2026-07-30T10:00:00+03', reservation_amount: '1200000', payment_status: 'pending' } },
];

/* ================================================================== */
/* PHASE 0 — platform seed                                             */
/* ================================================================== */

async function phase0() {
  console.log('\n=== PHASE 0 — platform seed (SQL channel) ===');

  // 1. Profile -------------------------------------------------------
  await exec(`
INSERT INTO public.profiles (id, label_ar, label_en, is_admin, model_permissions, page_access, is_system)
VALUES (${q(PROFILE_ID)}, 'فريق التسويق', 'Marketing Staff', false, '{}'::jsonb, '{"marketing_management": true}'::jsonb, false)
ON CONFLICT (id) DO NOTHING;`);
  console.log('[ok] profile فريق التسويق');

  // 2. auth users + identities + public.users ------------------------
  // The eight token columns must be EMPTY STRINGS, not NULL — GoTrue 500s
  // "Database error querying schema" on NULLs there (verified live on this
  // branch 2026-08-01). Idempotent against the existing f1de0002 users.
  for (const p of PEOPLE) {
    await exec(`
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change,
  email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token,
  created_at, updated_at
) VALUES (
  ${q(p.uid)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  ${q(p.email)}, extensions.crypt(${q(PASSWORD)}, extensions.gen_salt('bf')),
  now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  '', '', '', '', '', '', '', '',
  now(), now()
)
ON CONFLICT (id) DO NOTHING;
INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
VALUES (
  gen_random_uuid(), ${q(p.uid)}, ${q(p.uid)}, 'email',
  jsonb_build_object('sub', ${q(p.uid)}, 'email', ${q(p.email)}),
  now(), now(), now()
)
ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, auth_uid, name_ar, name_en, email, profile_id, is_active, role_assignments, phone)
VALUES (
  ${q(p.uid)}, ${q(p.uid)}, ${q(p.name_ar)}, ${q(p.name_en)}, ${q(p.email)},
  ${q(PROFILE_ID)}, true,
  ${qj([{ role_id: ROLE_IDS[p.role] }])},
  ${q(p.phone)}
)
ON CONFLICT (id) DO UPDATE SET
  role_assignments = EXCLUDED.role_assignments,
  profile_id = EXCLUDED.profile_id;`);
    console.log(`[ok] user ${p.email} (${p.name_ar} · ${p.role})`);
  }

  // 3. CRM records -----------------------------------------------------
  const models = await query(
    `SELECT name, id FROM public.models WHERE name IN ('all_projects','clients')`);
  const modelId = Object.fromEntries(models.map((m) => [m.name, m.id]));
  for (const name of ['all_projects', 'clients']) {
    if (!modelId[name]) throw new Error(`FATAL: model '${name}' not found on the branch — run the bootstrap first`);
  }
  const insertRecords = (model, rows) => `
INSERT INTO public.records (id, model_id, data, created_at)
VALUES ${rows.map((r) => `(${q(r.id)}, ${q(model)}, ${qj(r.data)}, ${q(r.created_at ?? '2026-07-01T09:00:00+03')})`).join(',\n       ')}
ON CONFLICT (id) DO NOTHING;`;
  await exec(insertRecords(modelId.all_projects, PROJECTS));
  console.log('[ok] 2 projects (مينا ٥٢ · مقام ١٧)');
  await exec(insertRecords(modelId.clients, CLIENTS));
  console.log('[ok] 12 clients');
  await exec(insertRecords(MODEL_IDS.appointments, APPOINTMENTS));
  await exec(insertRecords(MODEL_IDS.visits, VISITS));
  await exec(insertRecords(MODEL_IDS.reservations, RESERVATIONS));
  console.log('[ok] CRM funnel: 6 appointments · 4 visits · 2 reservations (2026-07)');

  // 4. ref-counter offsets --------------------------------------------
  // GREATEST never rewinds a counter on re-run. See header decision 1.
  await exec(`
INSERT INTO public.mos_ref_counters (prefix, next_number) VALUES
  ('V-', 1), ('P-', 11), ('C-', 2), ('SH-', 3), ('A-', 1)
ON CONFLICT (prefix) DO UPDATE
  SET next_number = GREATEST(public.mos_ref_counters.next_number, EXCLUDED.next_number);
UPDATE public.mos_content_types
   SET next_number = GREATEST(next_number, CASE key WHEN 'video' THEN 1 WHEN 'post' THEN 11 WHEN 'carousel' THEN 11 ELSE next_number END)
 WHERE key IN ('video','post','carousel');`);
  console.log('[ok] ref counters seeded (V-→1 · P-→11 · C-→2 · SH-→3 · A-→1)');

  // 5. settings ---------------------------------------------------------
  await exec(`
UPDATE public.mos_settings SET value = '{"enabled": false}'::jsonb WHERE key = 'external_effects';
INSERT INTO public.mos_settings (key, value) VALUES
  ('fixture_stamp', jsonb_build_object('created_at', now()::text, 'version', 1))
ON CONFLICT (key) DO NOTHING;`);
  console.log('[ok] external_effects=false · fixture_stamp written');
  console.log('=== PHASE 0 complete ===');
}

/* ================================================================== */
/* PHASE 1 — the marketing dataset through the real API                */
/* ================================================================== */

const tokens = {};
async function signIn(email) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-in failed for ${email}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body.access_token;
}
async function signInAll() {
  for (const p of PEOPLE) {
    tokens[p.role] = await signIn(p.email);
  }
  console.log('[ok] signed in as all 5 roles');
}

/** POST /api/marketing-os as a role. Throws loudly on any failure. */
async function api(role, action, payload = {}) {
  const res = await fetch(`${APP}/api/marketing-os`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens[role]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  const hint = payload.id ?? payload.content_id ?? payload.campaign_id
    ?? payload.title ?? payload.campaign?.name ?? payload.asset?.title ?? payload.request?.title ?? '';
  if (!res.ok || body.error) {
    throw new Error(
      `api '${action}' FAILED as ${role} [${hint}]: HTTP ${res.status} ${JSON.stringify(body).slice(0, 700)}`);
  }
  return body;
}

/* ---- the dataset (transcribed from the mockups) ------------------- */

// Campaigns, created in this exact order → C-002..C-008 (s14 + s34).
const CAMPAIGNS = [
  { ref: 'C-002', name: 'إطلاق مينا ٥٢', kind: 'paid', project: 'mina', status: 'done',
    starts_on: '2026-06-01', ends_on: '2026-06-30', budget_total: 50000, objective: 'leads',
    goal: 'إطلاق مينا ٥٢', sign: true },
  { ref: 'C-003', name: 'يوليو العضوي', kind: 'organic', project: null, status: 'done',
    starts_on: '2026-07-01', ends_on: '2026-07-31', objective: 'awareness', goal: 'يوليو العضوي' },
  { ref: 'C-004', name: 'عملاء — مينا ٥٢', kind: 'paid', project: 'mina', status: 'active',
    starts_on: '2026-08-01', ends_on: '2026-08-31', budget_total: 45000, objective: 'leads',
    goal: 'عملاء مؤهلون لمينا ٥٢', success_metric: 'qualified', success_threshold: 150 },
  { ref: 'C-005', name: 'مقام ١٧ — وعي بالعلامة', kind: 'paid', project: 'maqam', status: 'active',
    starts_on: '2026-08-10', ends_on: '2026-08-31', budget_total: 15000, objective: 'awareness',
    goal: 'مقام ١٧ — وعي بالعلامة' },
  { ref: 'C-006', name: 'أغسطس العضوي', kind: 'organic', project: null, status: 'active',
    starts_on: '2026-08-01', ends_on: '2026-08-31', objective: 'awareness', goal: 'أغسطس العضوي' },
  { ref: 'C-007', name: 'تشويق رمضان', kind: 'paid', project: 'mina', status: 'planning',
    starts_on: '2027-02-01', ends_on: '2027-02-28', objective: 'leads', goal: 'تشويق رمضان' },
  // s34 «بانتظار توقيعك» — over the 50k signature threshold, left UNSIGNED.
  { ref: 'C-008', name: 'حملة إطلاق مقام ١٧ — سبتمبر', kind: 'paid', project: 'maqam', status: 'planning',
    starts_on: '2026-09-01', ends_on: '2026-09-30', budget_total: 75000, objective: 'leads',
    goal: '٢٠٠ عميل مؤهل بتكلفة مستهدفة ٣٧٥ ريال', success_metric: 'qualified', success_threshold: 200 },
];

// Content, created in this exact order → V-001..V-011 then P-011..P-024.
// drive: target step_key ('done' = finish the path). Steps from the seeded
// role-paths: video idea→idea_review→script→script_review→assets→editing→
// first_version→review→scheduling→publish_check; post writing→writing_review
// →design→design_review→scheduling→publish_check.
const CONTENT = [
  { ref: 'V-001', type: 'video', title: 'مينا ٥٢ — فيديو الإطلاق', project: 'mina', campaign: 'C-002', purpose: 'paid', drive: 'done', target_publish_at: '2026-06-05T19:00:00+03' },
  { ref: 'V-002', type: 'video', title: 'جولة الوحدة — ١٤٢ م² زاوية', project: 'mina', campaign: 'C-004', purpose: 'both', drive: 'done', target_publish_at: '2026-07-28T19:00:00+03' },
  { ref: 'V-003', type: 'video', title: 'تعريف المطور — العجلان', project: 'mina', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-31T20:00:00+03' },
  { ref: 'V-004', type: 'video', title: 'مينا ٥٢ — جولة الموقع', project: 'mina', campaign: 'C-006', purpose: 'organic', drive: 'special', due_at: '2026-07-26T12:00:00+03', target_publish_at: '2026-08-10T19:00:00+03' },
  { ref: 'V-005', type: 'video', title: 'مقام ١٧ — جولة النموذج', project: 'maqam', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-19T19:00:00+03' },
  { ref: 'V-006', type: 'video', title: 'مينا ٥٢ — شهادات الملاك', project: 'mina', campaign: 'C-004', purpose: 'both', drive: 'done', target_publish_at: '2026-07-25T19:00:00+03' },
  { ref: 'V-007', type: 'video', title: 'جولة المرافق — المسبح والنادي', project: 'mina', campaign: 'C-006', purpose: 'organic', drive: 'editing', due_at: '2026-07-31T12:00:00+03' },
  { ref: 'V-008', type: 'video', title: 'مينا ٥٢ — لقطة الدرون', project: 'mina', campaign: 'C-006', purpose: 'organic', drive: 'editing', due_at: '2026-07-31T12:00:00+03' },
  { ref: 'V-009', type: 'video', title: 'لماذا شمال الرياض — زاوية المستثمر', project: 'mina', campaign: 'C-004', purpose: 'both', drive: 'assets', due_at: '2026-08-01T12:00:00+03', target_publish_at: '2026-08-12T19:00:00+03' },
  { ref: 'V-010', type: 'video', title: 'مقام ١٧ — الواجهة ليلًا', project: 'maqam', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-12T19:00:00+03' },
  { ref: 'V-011', type: 'video', title: 'مقام ١٧ — جدول التسليم', project: 'maqam', campaign: null, purpose: 'organic', drive: null, due_at: '2026-07-30T12:00:00+03' },
  { ref: 'P-011', type: 'post', title: 'مقام ١٧ — الواجهة', project: 'maqam', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-26T18:00:00+03' },
  { ref: 'P-012', type: 'carousel', title: 'خطة السداد — دفعة ١٠٪', project: 'mina', campaign: 'C-004', purpose: 'paid', drive: 'done', target_publish_at: '2026-07-20T18:00:00+03' },
  { ref: 'P-013', type: 'post', title: 'مينا ٥٢ — عرض الأسبوع', project: 'mina', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-15T18:00:00+03' },
  { ref: 'P-014', type: 'post', title: 'المرافق — سطح الاستراحة', project: 'mina', campaign: 'C-006', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-28T18:00:00+03' },
  { ref: 'P-015', type: 'post', title: 'مقام ١٧ — موقع المشروع', project: 'maqam', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-22T18:00:00+03' },
  { ref: 'P-016', type: 'post', title: 'الموقع — خريطة المسافات', project: 'mina', campaign: 'C-006', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-30T18:00:00+03' },
  { ref: 'P-017', type: 'post', title: 'مينا ٥٢ — الأسعار من ٩٨٠ ألف', project: 'mina', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-24T18:00:00+03' },
  { ref: 'P-018', type: 'carousel', title: 'كاروسيل خطة سداد مقام ١٧', project: 'maqam', campaign: 'C-004', purpose: 'paid', drive: 'design', due_at: '2026-07-27T12:00:00+03' },
  { ref: 'P-019', type: 'carousel', title: 'خمسة أسباب للشراء في شمال الرياض', project: 'mina', campaign: 'C-006', purpose: 'organic', drive: 'design', due_at: '2026-07-29T12:00:00+03' },
  { ref: 'P-020', type: 'post', title: 'مينا ٥٢ — جولة البهو بالصور', project: 'mina', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-26T18:00:00+03' },
  { ref: 'P-021', type: 'post', title: 'صور الجولة — ١٤٢ م²', project: 'mina', campaign: 'C-006', purpose: 'organic', drive: 'writing_review', due_at: '2026-07-26T12:00:00+03', target_publish_at: '2026-08-05T18:00:00+03' },
  { ref: 'P-022', type: 'post', title: 'خطة سداد الثلاث غرف', project: 'mina', campaign: 'C-004', purpose: 'paid', drive: null, due_at: '2026-07-28T12:00:00+03', target_publish_at: '2026-08-04T18:00:00+03' },
  { ref: 'P-023', type: 'post', title: 'مقام ١٧ — مرافق الحي', project: 'maqam', campaign: 'C-003', purpose: 'organic', drive: 'done', target_publish_at: '2026-07-29T18:00:00+03' },
  { ref: 'P-024', type: 'post', title: 'الحي — واجهة الجامع', project: 'mina', campaign: 'C-006', purpose: 'organic', drive: null, due_at: '2026-08-02T12:00:00+03' },
];

// V-004 writing fields (s06 brief + s07 exact prose).
const V004_BRIEF = {
  goal: 'استفسارات مؤهلة من مشتري شمال الرياض',
  audience: 'عائلات سعودية، ٣٠–٤٥، أول شراء ترقية',
  angle: 'الموقع — المدارس، الدائري، البوليفارد في ١٢ دقيقة',
  cta: 'واتساب لطلب خطة السداد',
};
const V004_DATA_V1 = {
  idea: 'ابدأ بالمبنى — واجهة مينا ٥٢ عند الغروب، ثم جولة داخل الوحدة.',
  hook: 'مينا ٥٢. واجهة تليق بك.',
  voiceover: 'مينا ٥٢ مشروع يجمع الفخامة والموقع.\nواجهة عصرية عند الغروب، وبهو يستقبلك كل يوم.\nتعال شاهد الوحدة بنفسك.\nللاستفسار راسلنا على واتساب.',
  duration: '38', aspect_ratio: '9:16',
};
const V004_DATA_V2 = {
  idea: 'أغلب المشترين لا يعرفون أن مينا ٥٢ على بعد اثنتي عشرة دقيقة من البوليفارد. ابدأ بالطريق، لا بالمبنى — أثبت الموقع قبل أن تبيع الوحدة.',
  hook: 'اثنتا عشرة دقيقة. هذا كل شيء.',
  voiceover: 'ابحث عن شقة في شمال الرياض، وسيقول لك الجميع: إما الموقع أو السعر.\nمشروع مينا ٥٢ يقع على بعد اثنتي عشرة دقيقة من البوليفارد، وسبع دقائق من الطريق الدائري.\nثلاث مدارس، ومركز تجاري، على مسافة قصيرة سيرًا على الأقدام.\nللاستفسار عن خطة السداد، راسلنا على واتساب.',
  duration: '38', aspect_ratio: '9:16',
};
// s10 — the exact round-1 rejection note (transcribed verbatim).
const V004_REJECT_NOTE = 'الافتتاحية تأخذ وقتًا طويلًا. اذهبي إلى ادعاء الموقع في أول ٣ ثوانٍ.';

// V-004 scenes (s07). footage_status: have | to_make | missing.
const V004_SCENES = [
  { position: 1, start_sec: 0, end_sec: 3, visual: 'ليل خارجي، اقتراب بطيء', voiceover: 'اثنتا عشرة دقيقة. هذا كل شيء.', on_screen_text: '١٢ دقيقة للبوليفارد', footage_status: 'have' },
  { position: 2, start_sec: 3, end_sec: 9, visual: 'كاميرا سيارة — مخرج الدائري', voiceover: 'ابحث عن شقة في شمال الرياض…', on_screen_text: null, footage_status: 'missing', note: 'ساعة ذهبية، بلا ازدحام' },
  { position: 3, start_sec: 9, end_sec: 17, visual: 'خريطة متحركة، تنزل العلامات', voiceover: 'سبع دقائق من الطريق الدائري', on_screen_text: '٧ دقائق للدائري', footage_status: 'to_make' },
  { position: 4, start_sec: 17, end_sec: 24, visual: 'مشي نحو بوابة المدرسة', voiceover: 'ثلاث مدارس على مسافة قصيرة', on_screen_text: '٣ مدارس', footage_status: 'missing', note: 'صباحًا، بوجود أطفال' },
  { position: 5, start_sec: 24, end_sec: 32, visual: 'داخلي — الصالة، ساعة ذهبية', voiceover: null, on_screen_text: 'من ٩٨٠ ألف ريال', footage_status: 'have' },
  { position: 6, start_sec: 32, end_sec: 38, visual: 'الشعار + واتساب', voiceover: 'راسلنا على واتساب', on_screen_text: 'واتساب', footage_status: 'to_make' },
];
// V-009 scenes — the two missing ones s24 rolls into the shoot request.
const V009_SCENES = [
  { position: 1, start_sec: 0, end_sec: 6, visual: 'الطريق من البوليفارد — تايم لابس', voiceover: null, on_screen_text: null, footage_status: 'missing', note: 'إثبات ادعاء الـ١٢ دقيقة' },
  { position: 2, start_sec: 6, end_sec: 12, visual: 'لقطة جوية — موقع مينا ٥٢', voiceover: null, on_screen_text: null, footage_status: 'have' },
  { position: 3, start_sec: 12, end_sec: 18, visual: 'التجزئة المجاورة — دانوب والصيدلية', voiceover: null, on_screen_text: null, footage_status: 'missing', note: 'واسعة، تأسيسية' },
];

// Executions per campaign (s14 subtitles + s20). ads/daily where shown.
const AUG_DAYS = ['2026-08-01', '2026-08-04', '2026-08-07', '2026-08-10', '2026-08-13',
  '2026-08-16', '2026-08-19', '2026-08-21', '2026-08-23', '2026-08-24'];
const EXECUTIONS = {
  'C-002': [
    { platform: 'meta', label: 'إطلاق ميتا', status: 'ended', starts_on: '2026-06-01', ends_on: '2026-06-30',
      budget: 50000, spend: 49300, leads: 274, qualified: 91,
      ads: [{ content: 'V-001', label: 'فيديو الإطلاق', status: 'paused', spend: 49300, leads: 274, qualified: 91 }] },
  ],
  'C-004': [
    { platform: 'meta', label: 'إعلانات ميتا', status: 'running', starts_on: '2026-08-01', ends_on: '2026-08-31',
      budget: 20000, spend: 15400, leads: 96, qualified: 34, purpose: 'conversion',
      targeting: { location: 'الرياض + ٢٥ كم', age: '٣٠ – ٤٥', interests: 'عقار، تحسين المنزل، عائلة' },
      ads: [
        { content: 'V-002', label: 'جولة الوحدة — ١٤٢ م² زاوية', status: 'running', spend: 6200, clicks: 1840, leads: 51, qualified: 21, note: 'الأفضل' },
        { content: 'P-012', label: 'خطة السداد — دفعة ١٠٪', status: 'running', spend: 5100, clicks: 1210, leads: 31, qualified: 10 },
        { content: 'P-014', label: 'المرافق — سطح الاستراحة', status: 'watch', spend: 2900, clicks: 640, leads: 10, qualified: 3, note: 'مراقبة' },
        { content: 'P-018', label: 'مقام ١٧ — كاروسيل خطة السداد', status: 'paused', spend: 1200, clicks: 290, leads: 4, qualified: 0, note: 'المشروع الخطأ — محتوى مقام ١٧ في حملة مينا ٥٢' },
        { content: 'V-004', label: 'مينا ٥٢ — جولة الموقع', status: 'waiting', note: 'في الانتظار — لا يعمل قبل اعتماد المحتوى' },
      ],
      daily: { spend: 1540, leads: [8, 9, 10, 10, 10, 10, 10, 10, 10, 9], qualified: [3, 3, 4, 3, 4, 3, 4, 3, 4, 3] } },
    { platform: 'tiktok', label: 'تيك توك', status: 'running', starts_on: '2026-08-01', ends_on: '2026-08-31',
      budget: 12000, spend: 8900, leads: 44, qualified: 9, purpose: 'conversion',
      daily: { spend: 890, leads: [4, 4, 5, 4, 5, 4, 5, 4, 5, 4], qualified: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0] } },
    { platform: 'google', label: 'بحث جوجل — العلامة والنية', status: 'running', starts_on: '2026-08-01', ends_on: '2026-08-31',
      budget: 9000, spend: 5100, leads: 21, qualified: 14, purpose: 'traffic',
      daily: { spend: 510, leads: [2, 2, 2, 2, 2, 2, 2, 2, 3, 2], qualified: [1, 2, 1, 2, 1, 2, 1, 1, 2, 1] } },
    { platform: 'snapchat', label: 'سناب شات — وعي', status: 'running', starts_on: '2026-08-01', ends_on: '2026-08-31',
      budget: 4000, spend: 1800, leads: 5, qualified: 0, purpose: 'awareness',
      daily: { spend: 180, leads: [0, 1, 0, 1, 1, 0, 1, 0, 1, 0], qualified: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
  ],
  'C-005': [
    { platform: 'snapchat', label: 'سناب شات — وعي', status: 'running', starts_on: '2026-08-10', ends_on: '2026-08-31',
      budget: 9000, spend: 4300, leads: 20, qualified: 0, purpose: 'awareness' },
    { platform: 'meta', label: 'ميتا — وعي', status: 'running', starts_on: '2026-08-10', ends_on: '2026-08-31',
      budget: 6000, spend: 2900, leads: 25, qualified: 6, purpose: 'awareness' },
  ],
};

// Publications (s06/s11/s50). snapshots recorded as ops (نور — s12 «أدخلتها نور»).
const PUBLICATIONS = [
  { content: 'V-001', platform: 'instagram', status: 'published', published_at: '2026-06-05T19:04:00+03' },
  { content: 'V-002', platform: 'instagram', status: 'published', published_at: '2026-07-28T19:04:00+03',
    caption: '١٤٢ مترًا، ثلاث غرف، وإطلالة على الحدائق 🌿\nمن ٩٨٠ ألف ريال — راسلنا على واتساب.',
    external_url: 'https://instagram.com/reel/C9xR2mK',
    snapshots: [
      { views: 21700, engagement: 490, enquiries: 11 },
      { views: 27410, engagement: 792, enquiries: 14, extra: { saves: 302 } },
    ] },
  // The «ناقص» case: published, deliberately NO snapshot (s12).
  { content: 'V-002', platform: 'tiktok', status: 'published', published_at: '2026-07-31T20:00:00+03',
    caption: 'جولة في شقة ١٤٢ مترًا بشمال الرياض 👀\nالأسعار في الوصف.' },
  // «بحاجة لموعد» — a draft with no schedule (s11).
  { content: 'V-002', platform: 'snapchat', status: 'draft' },
  { content: 'V-003', platform: 'tiktok', status: 'published', published_at: '2026-07-31T20:00:00+03' },
  { content: 'V-005', platform: 'instagram', status: 'published', published_at: '2026-07-19T19:00:00+03' },
  { content: 'V-010', platform: 'instagram', status: 'published', published_at: '2026-07-12T19:00:00+03' },
  // V-004's publishing plan (s06): three drafts, two carrying target dates.
  { content: 'V-004', platform: 'instagram', status: 'draft', scheduled_at: '2026-08-10T19:00:00+03' },
  { content: 'V-004', platform: 'tiktok', status: 'draft', scheduled_at: '2026-08-11T20:00:00+03' },
  { content: 'V-004', platform: 'snapchat', status: 'draft' },
  { content: 'P-011', platform: 'instagram', status: 'published', published_at: '2026-07-26T18:00:00+03' },
  { content: 'P-013', platform: 'instagram', status: 'published', published_at: '2026-07-15T18:00:00+03' },
  { content: 'P-014', platform: 'instagram', status: 'published', published_at: '2026-07-28T18:00:00+03',
    snapshots: [{ views: 8400, engagement: 203, enquiries: 4 }] },
  { content: 'P-015', platform: 'instagram', status: 'published', published_at: '2026-07-22T18:00:00+03' },
  // The s50 «أدخل» row: published, no numbers yet.
  { content: 'P-016', platform: 'instagram', status: 'published', published_at: '2026-07-30T18:00:00+03' },
  { content: 'P-017', platform: 'instagram', status: 'published', published_at: '2026-07-24T18:00:00+03' },
  { content: 'P-020', platform: 'instagram', status: 'published', published_at: '2026-07-26T18:00:00+03' },
  { content: 'P-023', platform: 'instagram', status: 'published', published_at: '2026-07-29T18:00:00+03' },
];

// Assets (s16 sections + s41 unused). links: [content ref, role].
const ASSETS = [
  { title: 'اقتراب ليلي خارجي', kind: 'video', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'فيديو'], note: '4K · ٠٠:٢٢',
    links: [['V-004', 'source'], ['V-001', 'source'], ['V-002', 'source'], ['V-006', 'source']] },
  { title: 'لقطة درون — الغروب', kind: 'video', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'درون'], note: '4K · ٠١:٠٤',
    links: [['V-001', 'source'], ['V-002', 'source'], ['V-005', 'source'], ['V-006', 'source'], ['V-008', 'source'], ['V-010', 'source']] },
  { title: 'جولة البهو', kind: 'video', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'داخلي'], note: '4K · ٠٠:٤٨',
    links: [['V-001', 'source'], ['P-020', 'source']] },
  { title: 'المواقف والبوابة', kind: 'video', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'خارجي'], note: '1080p · ٠٠:٣١', links: [] },
  { title: 'V-002 النهائي — ٩:١٦', kind: 'video', source: 'design', project: 'mina', tags: ['مينا ٥٢', 'نسخة معتمدة'], note: 'نُشر ٢٨ يوليو',
    links: [['V-002', 'final']] },
  { title: 'الصالة — الساعة الذهبية', kind: 'photo', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'داخلي', 'مجموعة ٦'],
    links: [['V-004', 'source'], ['P-014', 'source'], ['P-016', 'source'], ['P-020', 'source'], ['P-021', 'source']] },
  { title: 'المطبخ — وحدة ١٤٢ م²', kind: 'photo', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'داخلي', 'مجموعة ٤'],
    links: [['P-012', 'source'], ['P-021', 'source'], ['V-002', 'source']] },
  { title: 'سطح الاستراحة والمسبح', kind: 'photo', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'مرافق', 'مجموعة ٩'],
    links: [['P-014', 'source'], ['V-007', 'source'], ['P-016', 'source'], ['P-017', 'source'], ['P-019', 'source'], ['P-020', 'source'], ['P-023', 'source']] },
  { title: 'واجهة المشروع — من المطور', kind: 'design', source: 'developer', project: 'mina', tags: ['مينا ٥٢', 'تصميم ثلاثي'],
    links: [['P-011', 'source'], ['P-015', 'source']] },
  { title: 'تفاصيل دورة المياه — ٥ صور', kind: 'photo', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'داخلي'], links: [] },
  { title: 'المصعد والردهة', kind: 'video', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'داخلي'], note: '٠٠:١٨', links: [] },
  { title: 'غرفة الغسيل — ٣ صور', kind: 'photo', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'داخلي'], links: [] },
  { title: 'الشرفة — إطلالة شمالية', kind: 'photo', source: 'shoot', project: 'mina', tags: ['مينا ٥٢', 'داخلي'], links: [] },
  { title: 'مقام ١٧ — الواجهة نهارًا', kind: 'photo', source: 'developer', project: 'maqam', tags: ['مقام ١٧', 'خارجي'],
    links: [['P-011', 'source']] },
  { title: 'مقام ١٧ — مخطط الموقع', kind: 'design', source: 'developer', project: 'maqam', tags: ['مقام ١٧'],
    links: [['P-015', 'source']] },
  { title: 'مقام ١٧ — النادي الرياضي', kind: 'photo', source: 'shoot', project: 'maqam', tags: ['مقام ١٧', 'مرافق'], links: [] },
];

// Shoot requests (s42). The scheduled one carries the scene items (s24).
const SHOOTS = [
  { ref: 'SH-003', title: 'مقام ١٧ — خارجيات', project: 'maqam', status: 'scheduled',
    scheduled_at: '2026-07-08T06:00:00+03', assigned_role: 'ops_supervisor', deliver: true },
  { ref: 'SH-004', title: 'مينا ٥٢ — مرافق وداخليات', project: 'mina', status: 'scheduled',
    scheduled_at: '2026-07-29T06:00:00+03', assigned_role: 'montage', deliver: true },
  { ref: 'SH-005', title: 'مينا ٥٢ — الدائري والمدارس', project: 'mina', status: 'scheduled',
    scheduled_at: '2026-07-30T06:00:00+03', assigned_role: 'ops_supervisor',
    location: 'موقع مينا ٥٢ + مخرج الدائري ٨', note: '٣ ساعات تقديرية · كاميرا وجيمبال',
    scenes: [{ content: 'V-004', positions: [2, 4] }, { content: 'V-009', positions: [1, 3] }],
    extra_items: [
      { description: 'واجهة الجامع', content: 'P-024', note: 'طلبها الكاتب' },
      { description: 'أي شيء آخر ما دمتِ هناك' },
    ] },
];

/* ---- build helpers -------------------------------------------------- */

const contentByRef = {}; // ref → content row from mos_content_v
const campaignByRef = {}; // ref → campaign row
const executionIds = {}; // 'C-004:meta' → execution id
const adIds = {}; // 'C-002:V-001' → ad id

function expectRef(kind, expected, actual) {
  if (actual !== expected) {
    throw new Error(
      `FATAL ref mismatch: expected ${kind} ${expected}, allocator minted '${actual}'.\n` +
      'The branch ref counters are out of sync with a fresh build. Either run with ' +
      '--teardown first, or re-run phase 0 on a fresh branch. We do not mislabel refs.');
  }
}

/** Advance a content item along its pinned role-path until `target` (step key
 *  or 'done'). No-op when already there; throws if already past it. */
async function driveTo(ref, target) {
  const id = contentByRef[ref]?.id;
  if (!id) throw new Error(`driveTo: ${ref} not in content map`);
  for (let i = 0; i < 30; i++) {
    const d = await api('marketing_manager', 'content_detail', { id });
    const open = (d.tasks ?? []).find((t) => t.status === 'open');
    if (!open) {
      if (target === 'done') return;
      throw new Error(`driveTo(${ref}): path finished before reaching '${target}'`);
    }
    if (open.step_id === target) return;
    const order = (d.steps ?? []).map((s) => s.id);
    if (target !== 'done' && order.indexOf(open.step_id) > order.indexOf(target)) {
      throw new Error(`driveTo(${ref}): already at '${open.step_id}', past target '${target}'`);
    }
    const step = (d.steps ?? []).find((s) => s.id === open.step_id);
    const result = step?.is_approval ? 'approved' : 'submitted';
    const role = tokens[open.role] ? open.role : 'marketing_manager';
    await api(role, 'task_complete', { content_id: id, result });
  }
  throw new Error(`driveTo(${ref}): exceeded 30 transitions`);
}

async function saveScenes(ref, scenes) {
  const id = contentByRef[ref]?.id;
  const d = await api('marketing_manager', 'content_detail', { id });
  if ((d.scenes ?? []).length > 0) {
    console.log(`[skip] ${ref} scenes exist (${d.scenes.length})`);
    return d.scenes;
  }
  let saved = [];
  for (const s of scenes) {
    const r = await api('writer', 'scene_save', { content_id: id, scene: s });
    saved = r.scenes ?? [];
  }
  console.log(`[ok] ${ref}: ${scenes.length} scenes`);
  return saved;
}

async function phase1() {
  console.log('\n=== PHASE 1 — marketing dataset (real API) ===');
  await signInAll();

  // Bootstrap sanity: the types the dataset relies on must exist.
  const boot = await api('marketing_manager', 'bootstrap');
  const typeKeys = new Set((boot.content_types ?? []).map((t) => t.key));
  for (const k of ['video', 'post', 'carousel']) {
    if (!typeKeys.has(k)) throw new Error(`FATAL: content type '${k}' missing on the branch`);
  }

  // Idempotency map: existing refs are skipped, not duplicated.
  const existing = await api('marketing_manager', 'content_list', { limit: 500 });
  for (const row of existing.content ?? []) contentByRef[row.ref] = row;
  const existingCampaigns = await api('marketing_manager', 'campaign_list', { limit: 100 });
  for (const row of existingCampaigns.campaigns ?? []) campaignByRef[row.ref] = row;

  /* -- 1. campaigns (created before content: content links to them) -- */
  console.log('\n-- campaigns --');
  for (const c of CAMPAIGNS) {
    if (campaignByRef[c.ref]) {
      console.log(`[skip] ${c.ref} exists`);
      continue;
    }
    const r = await api('marketing_manager', 'campaign_save', {
      campaign: {
        name: c.name, kind: c.kind, status: c.status,
        project_id: c.project ? PROJECT[c.project] : null,
        starts_on: c.starts_on, ends_on: c.ends_on,
        budget_total: c.budget_total ?? null, objective: c.objective,
        goal: c.goal, success_metric: c.success_metric ?? null,
        success_threshold: c.success_threshold ?? null,
        owner_role: 'marketing_manager',
      },
    });
    const row = r.item ?? {};
    expectRef('campaign', c.ref, row.ref);
    campaignByRef[row.ref] = row;
    console.log(`[ok] ${row.ref} ${c.name}`);
  }
  // C-002 ran in June — its budget was signed. C-008 stays unsigned (s34).
  // signed_at lives on the base row; campaign_list reads the view, which
  // predates the signature columns — so check through the merged detail read.
  if (CAMPAIGNS.find((c) => c.ref === 'C-002')?.sign && campaignByRef['C-002']) {
    const d = await api('marketing_manager', 'campaign_detail', { id: campaignByRef['C-002'].id });
    if (!d.item?.signed_at) {
      await api('ceo', 'campaign_sign', { campaign_id: campaignByRef['C-002'].id });
      console.log('[ok] C-002 budget signed (ceo)');
    } else {
      console.log('[skip] C-002 already signed');
    }
  }

  /* -- 2. content, in ref order -------------------------------------- */
  console.log('\n-- content --');
  const createdRefs = new Set();
  for (const item of CONTENT) {
    if (contentByRef[item.ref]) {
      console.log(`[skip] ${item.ref} exists (${contentByRef[item.ref].status_key})`);
      continue;
    }
    const r = await api('writer', 'content_create', {
      title: item.title,
      content_type_key: item.type,
      project_id: PROJECT[item.project],
      campaign_id: item.campaign ? campaignByRef[item.campaign]?.id ?? null : null,
      purpose: item.purpose,
      ...(item.due_at ? { due_at: item.due_at } : {}),
      ...(item.target_publish_at ? { target_publish_at: item.target_publish_at } : {}),
    });
    const row = r.item ?? {};
    expectRef('content', item.ref, row.ref);
    contentByRef[row.ref] = row;
    createdRefs.add(row.ref);
    console.log(`[ok] ${row.ref} ${item.title}`);
  }

  /* -- 3. V-004 — the showcase item (s06/s07/s10) --------------------- */
  console.log('\n-- V-004 writing + review loop --');
  {
    // STATE-DRIVEN, not created-this-run-driven: a partial earlier run (or a
    // manual advance) may have left V-004 anywhere in the loop — probe the
    // open task and run only the remaining transitions so re-runs converge.
    const id = contentByRef['V-004'].id;
    const probe = async () => {
      const d = await api('marketing_manager', 'content_detail', { id });
      const open = (d.tasks ?? []).find((t) => t.status === 'open');
      return { step: open?.step_id ?? null, round: open?.round ?? 0 };
    };
    let st = await probe();
    if (st.step === 'script_review' && st.round === 2) {
      console.log('[skip] V-004 review loop (already at script_review r2)');
    } else {
      // Brief + scenes are idempotent upserts — always safe to (re)apply.
      await api('writer', 'content_update', { id, patch: { ...V004_BRIEF, data: V004_DATA_V1 } });
      await saveScenes('V-004', V004_SCENES);
      if (st.step === 'idea' && st.round === 1) {
        await api('writer', 'task_complete', { content_id: id, result: 'submitted' });
        st = await probe();
      }
      if (st.step === 'idea_review' && st.round === 1) {
        await api('marketing_manager', 'task_complete', { content_id: id, result: 'approved' });
        st = await probe();
      }
      if (st.step === 'script' && st.round === 1) {
        await api('writer', 'task_complete', { content_id: id, result: 'submitted' }); // snapshot v1
        st = await probe();
      }
      if (st.step === 'script_review' && st.round === 1) {
        await api('marketing_manager', 'task_complete', { content_id: id, result: 'changes_requested', note: V004_REJECT_NOTE });
        console.log('[ok] V-004 round 1 rejected with the s10 note');
        st = await probe();
      }
      if (st.step === 'script' && st.round === 2) {
        await api('writer', 'content_update', { id, patch: { data: V004_DATA_V2 } });
        await api('writer', 'task_complete', { content_id: id, result: 'submitted' }); // snapshot v2
        console.log('[ok] V-004 round 2 submitted — sitting at مراجعة النص');
        st = await probe();
      }
      if (!(st.step === 'script_review' && st.round === 2)) {
        throw new Error(`FATAL: V-004 loop could not converge — at '${st.step}' round ${st.round}`);
      }
    }
  }
  // V-004 must now sit at script_review round 2 — verify via the drive no-op.
  const v004 = await api('marketing_manager', 'content_detail', { id: contentByRef['V-004'].id });
  const v004Open = (v004.tasks ?? []).find((t) => t.status === 'open');
  if (!v004Open || v004Open.step_id !== 'script_review' || v004Open.round !== 2) {
    throw new Error(`FATAL: V-004 is at '${v004Open?.step_id}' round ${v004Open?.round}, expected script_review round 2`);
  }

  /* -- 4. scenes for V-009 (the shoot backlog s24 draws from) --------- */
  await saveScenes('V-009', V009_SCENES);

  /* -- 5. drive every other item to its mockup step ------------------- */
  console.log('\n-- workflow states --');
  for (const item of CONTENT) {
    if (!item.drive || item.drive === 'special') continue;
    await driveTo(item.ref, item.drive);
    console.log(`[ok] ${item.ref} → ${item.drive}`);
  }

  /* -- 6. executions + ads + daily entries ---------------------------- */
  console.log('\n-- executions / ads / daily --');
  for (const [campaignRef, execs] of Object.entries(EXECUTIONS)) {
    const campaign = campaignByRef[campaignRef];
    if (!campaign) throw new Error(`executions: ${campaignRef} missing`);
    const detail = await api('marketing_manager', 'campaign_detail', { id: campaign.id });
    if ((detail.executions ?? []).length > 0) {
      console.log(`[skip] ${campaignRef} executions exist (${detail.executions.length})`);
      for (const e of detail.executions) executionIds[`${campaignRef}:${e.platform}`] = e.id;
      continue;
    }
    for (const e of execs) {
      const r = await api('marketing_manager', 'execution_save', {
        campaign_id: campaign.id,
        execution: {
          platform: e.platform, label: e.label, status: e.status,
          starts_on: e.starts_on, ends_on: e.ends_on, budget: e.budget,
          spend: e.spend, leads: e.leads, qualified: e.qualified,
          ...(e.purpose ? { purpose: e.purpose } : {}),
          ...(e.targeting ? { targeting: e.targeting } : {}),
        },
      });
      const created = (r.executions ?? []).find((x) => x.platform === e.platform);
      executionIds[`${campaignRef}:${e.platform}`] = created?.id;
      console.log(`[ok] ${campaignRef} exec ${e.label}`);
      for (const ad of e.ads ?? []) {
        const ar = await api('marketing_manager', 'ad_save', {
          execution_id: created.id,
          ad: {
            content_id: contentByRef[ad.content]?.id ?? null,
            label: ad.label, status: ad.status,
            spend: ad.spend ?? null, clicks: ad.clicks ?? null,
            leads: ad.leads ?? null, qualified: ad.qualified ?? null,
            note: ad.note ?? null,
          },
        });
        const adRow = (ar.ads ?? []).find((x) => x.label === ad.label);
        adIds[`${campaignRef}:${ad.content}`] = adRow?.id;
        console.log(`[ok]   ad ${ad.content} (${ad.status})`);
      }
      for (const [i, day] of (e.daily ? AUG_DAYS : []).entries()) {
        await api('ops_supervisor', 'daily_save', {
          execution_id: created.id, day,
          spend: e.daily.spend, leads: e.daily.leads[i], qualified: e.daily.qualified[i],
        });
      }
      if (e.daily) console.log(`[ok]   ${AUG_DAYS.length} daily entries (${e.platform})`);
    }
  }
  // C-002's ad id for attribution (executions may have been skipped on rerun).
  if (!adIds['C-002:V-001'] || !executionIds['C-002:meta']) {
    const detail = await api('marketing_manager', 'campaign_detail', { id: campaignByRef['C-002'].id });
    const metaExec = (detail.executions ?? []).find((e) => e.platform === 'meta');
    if (metaExec) {
      executionIds['C-002:meta'] = metaExec.id;
      const ed = await api('marketing_manager', 'execution_detail', { id: metaExec.id });
      const ad = (ed.ads ?? [])[0];
      if (ad) adIds['C-002:V-001'] = ad.id;
    }
  }

  /* -- 7. shoot requests ---------------------------------------------- */
  console.log('\n-- shoot requests --');
  const shootList = await api('ops_supervisor', 'shoot_list', {});
  const shootsByTitle = Object.fromEntries((shootList.requests ?? []).map((r) => [r.title, r]));
  let warnedShootPrefix = false;
  for (const s of SHOOTS) {
    if (shootsByTitle[s.title]) {
      console.log(`[skip] ${s.title} exists (${shootsByTitle[s.title].ref})`);
      continue;
    }
    // Resolve scene ids for the request payload.
    const sceneIds = [];
    for (const sc of s.scenes ?? []) {
      const d = await api('marketing_manager', 'content_detail', { id: contentByRef[sc.content].id });
      for (const pos of sc.positions) {
        const scene = (d.scenes ?? []).find((x) => x.position === pos);
        if (scene) sceneIds.push(scene.id);
      }
    }
    const r = await api('ops_supervisor', 'shoot_save', {
      request: {
        title: s.title, project_id: PROJECT[s.project], status: s.status,
        scheduled_at: s.scheduled_at, assigned_role: s.assigned_role,
        location: s.location ?? null, note: s.note ?? null,
      },
      scene_ids: sceneIds,
    });
    const requestId = r.request_id;
    const created = (r.requests ?? []).find((x) => x.id === requestId);
    if (created?.ref && !created.ref.startsWith('SR-') && !warnedShootPrefix) {
      warnedShootPrefix = true;
      console.warn(`[warn] SHOOT REF DIVERGENCE: the branch allocator mints '${created.ref}' — the mockups ` +
        "label these 'SR-00N'. Exact SR- refs are impossible through the real API (mos_tg_shoot_ref " +
        "hardcodes 'SH-'). Keeping the allocated refs; --verify reports the actual values.");
    }
    console.log(`[ok] ${created?.ref ?? '?'} ${s.title} (${sceneIds.length} scenes)`);
    for (const item of s.extra_items ?? []) {
      await api('ops_supervisor', 'shoot_item_add', {
        request_id: requestId, description: item.description,
        ...(item.content ? { content_id: contentByRef[item.content]?.id } : {}),
      });
    }
    if (s.deliver) {
      await api('ops_supervisor', 'shoot_deliver', { id: requestId });
      console.log(`[ok]   delivered`);
    }
  }

  /* -- 8. assets + usage links ----------------------------------------- */
  console.log('\n-- assets --');
  const assetList = await api('ops_supervisor', 'asset_list', { limit: 500 });
  const assetsByTitle = Object.fromEntries((assetList.assets ?? []).map((a) => [a.title, a]));
  for (const a of ASSETS) {
    let assetId = assetsByTitle[a.title]?.id;
    if (assetId) {
      console.log(`[skip] asset «${a.title}» exists`);
    } else {
      const r = await api('ops_supervisor', 'asset_save', {
        asset: {
          title: a.title, kind: a.kind, source: a.source,
          project_id: PROJECT[a.project], tags: a.tags ?? [], note: a.note ?? null,
        },
      });
      assetId = r.asset?.id;
      console.log(`[ok] asset «${a.title}» (${r.asset?.ref ?? '?'})`);
    }
    // Links are upserts — always replay them so a partial first run converges.
    for (const [contentRef, role] of a.links) {
      if (!contentByRef[contentRef]) throw new Error(`asset link: ${contentRef} missing for «${a.title}»`);
      await api('ops_supervisor', 'asset_link', {
        asset_id: assetId, content_id: contentByRef[contentRef].id, role,
      });
    }
  }
  console.log(`[ok] usage links replayed (${ASSETS.filter((a) => a.links.length === 0).length} assets left unused for s41)`);

  /* -- 9. publications + metric snapshots ------------------------------ */
  console.log('\n-- publications / metrics --');
  const pubList = await api('writer', 'publication_list', { limit: 500 });
  const pubExists = new Set((pubList.publications ?? []).map((p) => `${p.content_id}:${p.platform}`));
  for (const p of PUBLICATIONS) {
    const contentId = contentByRef[p.content]?.id;
    if (!contentId) throw new Error(`publication: ${p.content} missing`);
    if (pubExists.has(`${contentId}:${p.platform}`)) {
      console.log(`[skip] ${p.content} ${p.platform}`);
      continue;
    }
    const r = await api('writer', 'publication_save', {
      content_id: contentId,
      publication: {
        platform: p.platform, status: p.status,
        scheduled_at: p.scheduled_at ?? null, published_at: p.published_at ?? null,
        caption: p.caption ?? null, external_url: p.external_url ?? null,
      },
    });
    const pub = (r.publications ?? []).find((x) => x.platform === p.platform);
    console.log(`[ok] ${p.content} ${p.platform} (${p.status})`);
    for (const snap of p.snapshots ?? []) {
      await api('ops_supervisor', 'metrics_record', {
        publication_id: pub.id,
        views: snap.views ?? null, engagement: snap.engagement ?? null,
        enquiries: snap.enquiries ?? null, extra: snap.extra ?? {},
      });
      console.log(`[ok]   snapshot ${snap.views} views`);
    }
  }

  /* -- 10. attribution ledger (C-002 → CRM clients) -------------------- */
  console.log('\n-- attribution --');
  const existingAttr = await api('marketing_manager', 'attribution_list', { campaign_id: campaignByRef['C-002'].id });
  if ((existingAttr.rows ?? []).length >= 8) {
    console.log(`[skip] C-002 attributions exist (${existingAttr.rows.length})`);
  } else {
    const stamps = [
      ...[1, 2, 3, 4].map((n, i) => ({
        client_record_id: clientId(n), execution_id: executionIds['C-002:meta'],
        occurred_at: `2026-06-${10 + i}T11:00:00+03`,
      })),
      ...[5, 6, 7, 8].map((n, i) => ({
        client_record_id: clientId(n), ad_id: adIds['C-002:V-001'],
        occurred_at: `2026-06-${14 + i}T11:00:00+03`,
      })),
    ];
    for (const s of stamps) {
      try {
        await api('marketing_manager', 'attribution_stamp', {
          client_record_id: s.client_record_id,
          execution_id: s.execution_id ?? null, ad_id: s.ad_id ?? null,
          touch_type: 'first', occurred_at: s.occurred_at, source: 'lead_form',
        });
      } catch (err) {
        if (/unknown action/i.test(String(err.message))) {
          console.warn('[warn] attribution via SQL fallback — switch to API when part2 lands');
          await exec(`
INSERT INTO public.client_attributions (client_record_id, execution_id, ad_id, touch_type, occurred_at, source)
VALUES (${q(s.client_record_id)}, ${s.execution_id ? q(s.execution_id) : 'NULL'}, ${s.ad_id ? q(s.ad_id) : 'NULL'}, 'first', ${q(s.occurred_at)}, 'lead_form');`);
        } else {
          throw err;
        }
      }
    }
    console.log(`[ok] ${stamps.length} attribution stamps → C-002 (mid-June, CRM rows in window)`);
  }

  /* -- 11. one manual reminder (V-004 is the stalled item, s35) -------- */
  if (createdRefs.has('V-004')) {
    try {
      await api('marketing_manager', 'remind', { content_id: contentByRef['V-004'].id });
      console.log('[ok] reminder fired on V-004');
    } catch (err) {
      console.warn(`[warn] remind not available: ${String(err.message).slice(0, 200)}`);
    }
  } else {
    console.log('[skip] reminder (V-004 not rebuilt this run)');
  }

  console.log('\n=== PHASE 1 complete ===');
}

/* ================================================================== */
/* teardown                                                            */
/* ================================================================== */

async function teardown() {
  console.log('\n=== TEARDOWN (SQL channel) ===');
  const userIds = PEOPLE.map((p) => p.uid);
  // [label, count SQL, delete SQL] — counts are honest per-table numbers.
  const tables = [
    ['client_attributions', 'SELECT count(*)::int AS n FROM public.client_attributions', 'DELETE FROM public.client_attributions'],
    ['mos_metric_snapshots', 'SELECT count(*)::int AS n FROM public.mos_metric_snapshots', 'DELETE FROM public.mos_metric_snapshots'],
    ['mos_publications', 'SELECT count(*)::int AS n FROM public.mos_publications', 'DELETE FROM public.mos_publications'],
    ['mos_asset_links', 'SELECT count(*)::int AS n FROM public.mos_asset_links', 'DELETE FROM public.mos_asset_links'],
    ['mos_assets', 'SELECT count(*)::int AS n FROM public.mos_assets', 'DELETE FROM public.mos_assets'],
    ['mos_shoot_items', 'SELECT count(*)::int AS n FROM public.mos_shoot_items', 'DELETE FROM public.mos_shoot_items'],
    ['mos_shoot_requests', 'SELECT count(*)::int AS n FROM public.mos_shoot_requests', 'DELETE FROM public.mos_shoot_requests'],
    ['mos_execution_daily', 'SELECT count(*)::int AS n FROM public.mos_execution_daily', 'DELETE FROM public.mos_execution_daily'],
    ['mos_execution_ads', 'SELECT count(*)::int AS n FROM public.mos_execution_ads', 'DELETE FROM public.mos_execution_ads'],
    ['mos_campaign_executions', 'SELECT count(*)::int AS n FROM public.mos_campaign_executions', 'DELETE FROM public.mos_campaign_executions'],
    ['mos_campaign_events', 'SELECT count(*)::int AS n FROM public.mos_campaign_events', 'DELETE FROM public.mos_campaign_events'],
    ['mos_comments', 'SELECT count(*)::int AS n FROM public.mos_comments', 'DELETE FROM public.mos_comments'],
    ['mos_content_versions', 'SELECT count(*)::int AS n FROM public.mos_content_versions', 'DELETE FROM public.mos_content_versions'],
    ['workflow_role_tasks', "SELECT count(*)::int AS n FROM public.workflow_role_tasks WHERE subject_table = 'mos_content'", "DELETE FROM public.workflow_role_tasks WHERE subject_table = 'mos_content'"],
    ['mos_content', 'SELECT count(*)::int AS n FROM public.mos_content', 'DELETE FROM public.mos_content'],
    ['mos_campaigns', 'SELECT count(*)::int AS n FROM public.mos_campaigns', 'DELETE FROM public.mos_campaigns'],
    ['notifications', `SELECT count(*)::int AS n FROM public.notifications WHERE user_id IN (${userIds.map(q).join(',')})`, `DELETE FROM public.notifications WHERE user_id IN (${userIds.map(q).join(',')})`],
    ['notification_prefs', `SELECT count(*)::int AS n FROM public.notification_prefs WHERE user_id IN (${userIds.map(q).join(',')})`, `DELETE FROM public.notification_prefs WHERE user_id IN (${userIds.map(q).join(',')})`],
    ['mos_ref_counters', "SELECT count(*)::int AS n FROM public.mos_ref_counters WHERE prefix IN ('V-','P-','C-','SH-','A-')", "DELETE FROM public.mos_ref_counters WHERE prefix IN ('V-','P-','C-','SH-','A-')"],
    ['records (fixtures)', "SELECT count(*)::int AS n FROM public.records WHERE id::text LIKE 'f1de00%'", "DELETE FROM public.records WHERE id::text LIKE 'f1de00%'"],
    ['mos_settings.fixture_stamp', "SELECT count(*)::int AS n FROM public.mos_settings WHERE key = 'fixture_stamp'", "DELETE FROM public.mos_settings WHERE key = 'fixture_stamp'"],
  ];

  // The attribution ledger is append-only — its immutability trigger binds
  // even the definer channel, so it must be disabled for the delete.
  await exec('ALTER TABLE public.client_attributions DISABLE TRIGGER client_attributions_immutable_tg;');
  try {
    for (const [name, countSql, del] of tables) {
      const before = (await query(countSql))[0]?.n ?? '?';
      await exec(`${del};`);
      console.log(`[ok] ${name}: ${before} deleted`);
    }
  } finally {
    await exec('ALTER TABLE public.client_attributions ENABLE TRIGGER client_attributions_immutable_tg;');
  }
  // notification_deliveries cascades with notifications (FK ON DELETE CASCADE).
  // KEPT on purpose: users/profile/auth users, settings, workflows, roles,
  // surface_access, notification_rules (seed).
  console.log('=== TEARDOWN complete (users/profile/settings/workflows kept) ===');
}

/* ================================================================== */
/* verify                                                              */
/* ================================================================== */

async function verify() {
  console.log('\n=== VERIFY ===');
  const stamp = await query("SELECT count(*)::int AS n FROM public.mos_settings WHERE key = 'fixture_stamp'");
  if ((stamp[0]?.n ?? 0) === 0) {
    console.error('FAIL: fixture_stamp missing — fixtures were never built (or were torn down).');
    process.exit(1);
  }

  await signInAll();
  const content = (await api('marketing_manager', 'content_list', { limit: 500 })).content ?? [];
  const campaigns = (await api('marketing_manager', 'campaign_list', { limit: 100 })).campaigns ?? [];
  const assets = (await api('ops_supervisor', 'asset_list', { limit: 500 })).assets ?? [];
  const shoots = (await api('ops_supervisor', 'shoot_list', {})).requests ?? [];
  const pubs = (await api('writer', 'publication_list', { limit: 500 })).publications ?? [];
  const work = await api('marketing_manager', 'work_list', { scope: 'team', limit: 500 });

  let execCount = 0;
  let adCount = 0;
  for (const c of campaigns) {
    const d = await api('marketing_manager', 'campaign_detail', { id: c.id });
    execCount += (d.executions ?? []).length;
    for (const e of d.executions ?? []) {
      const ed = await api('marketing_manager', 'execution_detail', { id: e.id });
      adCount += (ed.ads ?? []).length;
    }
  }
  const snaps = (await query('SELECT count(*)::int AS n FROM public.mos_metric_snapshots'))[0]?.n ?? 0;
  const attrs = (await query('SELECT count(*)::int AS n FROM public.client_attributions'))[0]?.n ?? 0;

  const byType = {};
  for (const c of content) byType[c.content_type_key] = (byType[c.content_type_key] ?? 0) + 1;
  const tasksByRole = {};
  for (const t of work.tasks ?? []) tasksByRole[t.role] = (tasksByRole[t.role] ?? 0) + 1;
  const shootRefs = shoots.map((s) => `${s.ref} «${s.title}» (${s.status})`).join(' · ');
  if (shoots.some((s) => String(s.ref).startsWith('SH-'))) {
    console.warn('[warn] shoot refs are SH-* (branch allocator), not the mockups’ SR-* — known divergence, see header.');
  }

  console.table([
    { object: 'content: video', count: byType.video ?? 0, expected: 11 },
    { object: 'content: post', count: byType.post ?? 0, expected: 11 },
    { object: 'content: carousel', count: byType.carousel ?? 0, expected: 3 },
    { object: 'campaigns', count: campaigns.length, expected: 8 },
    { object: 'executions', count: execCount, expected: 7 },
    { object: 'ads', count: adCount, expected: 6 },
    { object: 'assets', count: assets.length, expected: 16 },
    { object: 'shoot requests', count: shoots.length, expected: 3 },
    { object: 'publications', count: pubs.length, expected: PUBLICATIONS.length },
    { object: 'metric snapshots', count: snaps, expected: 3 },
    { object: 'attributions', count: attrs, expected: 8 },
  ]);
  console.log('open tasks by role:', JSON.stringify(tasksByRole));
  console.log('shoots:', shootRefs || '(none)');

  const v004 = content.find((c) => c.ref === 'V-004');
  const ok = v004 && v004.status_key === 'script_review' && v004.current_round === 2;
  if (!ok) {
    console.error(`FAIL: V-004 is at '${v004?.status_key}' round ${v004?.current_round} — expected script_review round 2.`);
    process.exit(1);
  }
  console.log('[ok] V-004 sits at مراجعة النص (script_review) · round 2');
  console.log('=== VERIFY passed ===');
}

/* ================================================================== */
/* main                                                                */
/* ================================================================== */

try {
  if (DO_TEARDOWN) {
    await teardown();
  } else if (DO_VERIFY) {
    await verify();
  } else {
    if (PHASE === '0' || PHASE === 'all') await phase0();
    if (PHASE === '1' || PHASE === 'all') await phase1();
    await verify();
  }
} catch (err) {
  console.error(`\nFATAL: ${err?.message ?? err}`);
  process.exit(1);
}
