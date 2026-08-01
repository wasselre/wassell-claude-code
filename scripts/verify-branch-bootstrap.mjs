#!/usr/bin/env node
/**
 * verify-branch-bootstrap.mjs
 * ---------------------------------------------------------------------------
 * Compares the mos-fixtures BRANCH database against PRODUCTION catalogs:
 * object counts per type, seed-table row counts, and functional spot checks.
 * Reads prod via public.claude_runner_sql (read-only RPC) and the branch via
 * public.mos_bootstrap_query (token-gated, branch-only).
 *
 * Usage: node scripts/verify-branch-bootstrap.mjs
 * Config: same .mos-branch.local + .env.local as the generate/apply scripts.
 * ---------------------------------------------------------------------------
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(__dirname, '..');
function loadKV(paths) {
  const out = {};
  for (const f of paths) {
    let txt; try { txt = readFileSync(f, 'utf8'); } catch { continue; } // optional
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
const ENV = loadKV([join(WORKTREE, '.mos-branch.local'), join(WORKTREE, '.env.local'), 'C:/Users/rayan/Claude/wassell-claude-code/.env.local']);
const PROD_URL = ENV.SUPABASE_URL, PROD_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
const BR_URL = ENV.MOS_BRANCH_URL, BR_KEY = ENV.MOS_BRANCH_ANON_KEY, TOKEN = ENV.MOS_BOOTSTRAP_TOKEN;

async function rpc(url, key, fn, body) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${fn} HTTP ${res.status}: ${txt.slice(0, 500)}`);
  return JSON.parse(txt);
}
const prod = sql => rpc(PROD_URL, PROD_KEY, 'claude_runner_sql', { p_sql: sql });
const branch = sql => rpc(BR_URL, BR_KEY, 'mos_bootstrap_query', { p_token: TOKEN, p_sql: sql });

const EXT_REL = `NOT EXISTS (SELECT 1 FROM pg_depend ed WHERE ed.classid='pg_class'::regclass AND ed.objid=c.oid AND ed.refclassid='pg_extension'::regclass AND ed.deptype='e')`;
const EXT_PROC = `NOT EXISTS (SELECT 1 FROM pg_depend ed WHERE ed.classid='pg_proc'::regclass AND ed.objid=p.oid AND ed.refclassid='pg_extension'::regclass AND ed.deptype='e')`;

const CHECKS = {
  user_tables: `SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND ${EXT_REL}`,
  user_views: `SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='v' AND ${EXT_REL}`,
  user_functions: `SELECT count(*) AS n FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname NOT LIKE 'mos_bootstrap_%' AND ${EXT_PROC}`,
  triggers: `SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND ${EXT_REL}`,
  event_triggers: `SELECT count(*) AS n FROM pg_event_trigger WHERE evtname='ensure_rls'`,
  policies_public: `SELECT count(*) AS n FROM pg_policies WHERE schemaname='public'`,
  policies_storage: `SELECT count(*) AS n FROM pg_policies WHERE schemaname='storage'`,
  rls_enabled_tables: `SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relrowsecurity AND ${EXT_REL}`,
  non_constraint_indexes: `SELECT count(*) AS n FROM pg_index ix JOIN pg_class c ON c.oid=ix.indrelid AND c.relnamespace='public'::regnamespace AND c.relkind='r' WHERE ${EXT_REL} AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid=ix.indexrelid)`,
  pk_unique_check_constraints: `SELECT count(*) AS n FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid WHERE con.connamespace='public'::regnamespace AND con.contype IN ('p','u','c') AND c.relkind='r' AND ${EXT_REL}`,
  foreign_keys: `SELECT count(*) AS n FROM pg_constraint con WHERE con.contype='f' AND con.connamespace='public'::regnamespace`,
  sequences: `SELECT count(*) AS n FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid WHERE c.relnamespace='public'::regnamespace AND ${EXT_REL}`,
  buckets: `SELECT count(*) AS n FROM storage.buckets`,
  realtime_members: `SELECT count(*) AS n FROM pg_publication_tables WHERE pubname='supabase_realtime'`,
  replident_nondefault: `SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relreplident <> 'd' AND ${EXT_REL}`,
  security_invoker_views: `SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='v' AND c.reloptions::text LIKE '%security_invoker=true%'`,
  secdef_functions: `SELECT count(*) AS n FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prosecdef AND p.proname NOT LIKE 'mos_bootstrap_%' AND ${EXT_PROC}`,
  models_rows: `SELECT count(*) AS n FROM public.models`,
  model_groups_rows: `SELECT count(*) AS n FROM public.model_groups`,
  roles_rows: `SELECT count(*) AS n FROM public.roles`,
  profiles_rows: `SELECT count(*) AS n FROM public.profiles`,
  workflow_groups_rows: `SELECT count(*) AS n FROM public.workflow_groups`,
  mos_workflows_rows: `SELECT count(*) AS n FROM public.mos_workflows`,
  mos_workflow_steps_rows: `SELECT count(*) AS n FROM public.mos_workflow_steps`,
  mos_content_types_rows: `SELECT count(*) AS n FROM public.mos_content_types`,
  mos_platform_accounts_rows: `SELECT count(*) AS n FROM public.mos_platform_accounts`,
  listing_mirror_settings_rows: `SELECT count(*) AS n FROM public.listing_mirror_settings`,
  webhook_slugs_rows: `SELECT count(*) AS n FROM public.webhook_slugs`,
};

const rows = [];
let mismatches = 0;
for (const [name, sql] of Object.entries(CHECKS)) {
  const [p, b] = await Promise.all([prod(sql), branch(sql)]);
  const pv = p[0]?.n, bv = b[0]?.n;
  const ok = String(pv) === String(bv);
  if (!ok) mismatches++;
  rows.push({ check: name, prod: pv, branch: bv, ok: ok ? 'OK' : 'MISMATCH' });
}
console.table(rows);

// difference lists for the headline object types (names only, to explain deltas)
const DIFFS = {
  tables: `SELECT c.relname AS x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND ${EXT_REL}`,
  views: `SELECT c.relname AS x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='v' AND ${EXT_REL}`,
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND ${EXT_PROC}`,
  policies: `SELECT tablename || ':' || policyname AS x FROM pg_policies WHERE schemaname='public'`,
};
for (const [name, sql] of Object.entries(DIFFS)) {
  const [p, b] = await Promise.all([prod(sql), branch(sql)]);
  const ps = new Set(p.map(r => r.x)), bs = new Set(b.map(r => r.x));
  const onlyProd = [...ps].filter(x => !bs.has(x));
  const onlyBranch = [...bs].filter(x => !ps.has(x)).filter(x => !x.startsWith('mos_bootstrap_'));
  if (onlyProd.length || onlyBranch.length) {
    console.log(`DIFF ${name}: only-in-prod=[${onlyProd.join(', ')}] only-in-branch=[${onlyBranch.join(', ')}]`);
  }
}

// functional spot checks on the branch
const SPOT = [
  ['unified_records selectable', `SELECT count(*) AS ok FROM (SELECT * FROM public.unified_records LIMIT 0) z`],
  ['record_save exists', `SELECT count(*) AS ok FROM pg_proc WHERE proname='record_save' AND pronamespace='public'::regnamespace`],
  ['wassell_mos_can executes', `SELECT (public.wassell_mos_can('read'))::text AS ok`],
  ['models schema jsonb intact', `SELECT count(*) AS ok FROM public.models WHERE jsonb_typeof(schema->'sections')='array'`],
  ['v_clients selectable', `SELECT count(*) AS ok FROM (SELECT * FROM public.v_clients LIMIT 0) z`],
  ['postgis works', `SELECT ST_AsText(ST_MakePoint(46.7, 24.7))::text AS ok`],
  ['physical clients table count (0 = matches prod; clients model is unfrozen)', `SELECT count(*) AS ok FROM pg_class WHERE relname='clients' AND relnamespace='public'::regnamespace AND relkind='r'`],
  ['records empty (no data copied)', `SELECT count(*) AS ok FROM public.records`],
];
for (const [label, sql] of SPOT) {
  try {
    const r = await branch(sql);
    console.log(`SPOT ${label}: ${JSON.stringify(r[0])}`);
  } catch (e) {
    console.log(`SPOT ${label}: ERROR ${String(e.message).slice(0, 300)}`);
    mismatches++;
  }
}
console.log(mismatches ? `RESULT: ${mismatches} mismatch(es)` : 'RESULT: all checks passed');
