#!/usr/bin/env node
/**
 * generate-branch-bootstrap.mjs
 * ---------------------------------------------------------------------------
 * Generates supabase/branch-bootstrap-NN.sql from the LIVE production
 * database catalogs (project zhqqsxwealdwqzrbpwyv). The recorded migration
 * history does NOT create the core tables (they were applied outside
 * migration tracking), so `supabase branches` replay produces a broken DB.
 * These files are a complete, idempotent, catalog-derived schema bootstrap:
 * applied in order to a fresh EMPTY branch database they recreate the
 * public schema faithfully (structure + a small set of platform seed rows,
 * no user/business data).
 *
 * How it reads prod: via the read-only SECURITY DEFINER RPC
 * `public.claude_runner_sql(p_sql text)` (forces transaction_read_only=on),
 * using SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * This script performs NO writes against production.
 *
 * Usage:  node scripts/generate-branch-bootstrap.mjs
 * Output: supabase/branch-bootstrap-01.sql ... -NN.sql  (apply in order)
 * Apply:  node scripts/apply-branch-bootstrap.mjs   (see that script)
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(__dirname, '..');
const OUT_DIR = join(WORKTREE, 'supabase');

// ---------------------------------------------------------------- env ------
function loadEnv() {
  const candidates = [
    join(WORKTREE, '.env.local'),
    join(WORKTREE, '.env'),
    'C:/Users/rayan/Claude/wassell-claude-code/.env.local',
    'C:/Users/rayan/Claude/wassell-claude-code/.env',
  ];
  const env = {};
  for (const f of candidates) {
    let txt;
    try { txt = readFileSync(f, 'utf8'); } catch { continue; } // file absent: fine, next candidate
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
const ENV = loadEnv();
const SUPABASE_URL = process.env.SUPABASE_URL || ENV.SUPABASE_URL || ENV.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ENV.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found'); process.exit(1); }

// ------------------------------------------------------------- helpers -----
async function q(sql) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claude_runner_sql`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_sql: sql }),
    });
    if (res.ok) return res.json();
    const body = await res.text();
    if (attempt >= 3) throw new Error(`claude_runner_sql failed (${res.status}): ${body}\n--- SQL ---\n${sql.slice(0, 400)}`);
    console.error(`  retry ${attempt} after ${res.status}...`);
    await new Promise(r => setTimeout(r, 1500 * attempt));
  }
}

const qi = s => '"' + String(s).replace(/"/g, '""') + '"';           // identifier
const ql = s => "'" + String(s).replace(/'/g, "''") + "'";           // literal
const EXT_REL = `NOT EXISTS (SELECT 1 FROM pg_depend ed WHERE ed.classid='pg_class'::regclass AND ed.objid=c.oid AND ed.refclassid='pg_extension'::regclass AND ed.deptype='e')`;
const EXT_PROC = `NOT EXISTS (SELECT 1 FROM pg_depend ed WHERE ed.classid='pg_proc'::regclass AND ed.objid=p.oid AND ed.refclassid='pg_extension'::regclass AND ed.deptype='e')`;

// ACL parsing: "{postgres=arwdDxtm/postgres,anon=X/postgres}" -> [{grantee, privs}]
const PRIV_MAP_TABLE = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', D: 'TRUNCATE', x: 'REFERENCES', t: 'TRIGGER', m: 'MAINTAIN' };
const PRIV_MAP_SEQ = { r: 'SELECT', w: 'UPDATE', U: 'USAGE' };
const PRIV_MAP_FN = { X: 'EXECUTE' };
function parseAcl(aclText) {
  if (!aclText) return null;
  const inner = aclText.replace(/^\{|\}$/g, '');
  if (!inner) return [];
  // entries may be quoted ("role name"=priv/grantor); our roles are simple names
  return inner.split(',').map(e => {
    const eq = e.indexOf('=');
    const slash = e.lastIndexOf('/');
    const grantee = e.slice(0, eq).replace(/^"|"$/g, '') || 'PUBLIC';
    const privs = e.slice(eq + 1, slash);
    return { grantee, privs };
  });
}
function aclGrants(objSql, aclText, privMap, revokeList) {
  const entries = parseAcl(aclText);
  if (entries === null) return []; // NULL acl = built-in default; leave to branch defaults
  const out = [`REVOKE ALL ON ${objSql} FROM ${revokeList.join(', ')};`];
  for (const { grantee, privs } of entries) {
    const names = [];
    for (const ch of privs) {
      if (ch === '*') continue; // grant option — not replayed
      const p = privMap[ch];
      if (p && !names.includes(p)) names.push(p);
    }
    if (!names.length) continue;
    const to = grantee === 'PUBLIC' ? 'PUBLIC' : qi(grantee);
    out.push(`GRANT ${names.join(', ')} ON ${objSql} TO ${to};`);
  }
  return out;
}

// dollar-quote a body with a tag not present in the body
function dollarQuote(body, base) {
  let tag = `$${base}$`; let i = 0;
  while (body.includes(tag)) { i++; tag = `$${base}${i}$`; }
  return tag + body + tag;
}

// ----------------------------------------------------------- file writer ---
const MAX_FILE = 600 * 1024; // bytes per file, keeps each PostgREST apply fast
const files = []; // {name, parts: [..]}
let current = null;
function newFile(title) {
  const n = String(files.length + 1).padStart(2, '0');
  current = { name: `branch-bootstrap-${n}.sql`, title, parts: [], size: 0 };
  files.push(current);
  const hdr = `-- ============================================================================
-- ${current.name} — ${title}
-- AUTO-GENERATED by scripts/generate-branch-bootstrap.mjs from the LIVE
-- production catalogs (project zhqqsxwealdwqzrbpwyv). Do not hand-edit.
-- Apply all branch-bootstrap-*.sql files IN ORDER to a fresh empty branch DB
-- (node scripts/apply-branch-bootstrap.mjs). Idempotent: safe to re-run.
-- ============================================================================
SET check_function_bodies = off;
SET client_min_messages = warning;
`;
  current.parts.push(hdr); current.size += hdr.length;
}
function emit(sql, title) {
  if (!current || (title && title !== current.title) || current.size > MAX_FILE) newFile(title || current.title);
  current.parts.push(sql.endsWith('\n') ? sql : sql + '\n');
  current.size += sql.length + 1;
}

// ================================================================ main =====
const report = {};
async function main() {
  console.log('reading prod catalogs via claude_runner_sql ...');

  // ---- 1. extensions ------------------------------------------------------
  const exts = await q(`SELECT e.extname, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname NOT IN ('plpgsql','supabase_vault','pg_stat_statements','pg_graphql','pgsodium','pgjwt','pg_net') ORDER BY e.extname`);
  newFile('extensions + sequences');
  emit('-- ---- extensions ----');
  for (const e of exts) emit(`CREATE EXTENSION IF NOT EXISTS ${qi(e.extname)} WITH SCHEMA ${qi(e.schema)} CASCADE;`);
  report.extensions = exts.map(e => e.extname);

  // ---- 2. sequences (identity-backed excluded; they come with tables) -----
  const seqs = await q(`
    SELECT c.relname AS name, s.seqstart::text AS seqstart, s.seqincrement::text AS seqincrement, s.seqmax::text AS seqmax, s.seqmin::text AS seqmin, s.seqcache::text AS seqcache, s.seqcycle,
           format_type(s.seqtypid, null) AS typ,
           (SELECT d.deptype FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') LIMIT 1) AS deptype,
           (SELECT quote_ident(tc.relname)||'.'||quote_ident(ta.attname) FROM pg_depend d JOIN pg_class tc ON tc.oid=d.refobjid JOIN pg_attribute ta ON ta.attrelid=d.refobjid AND ta.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') LIMIT 1) AS owned_by,
           c.relacl::text AS acl
    FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
    WHERE c.relnamespace='public'::regnamespace AND ${EXT_REL} ORDER BY c.relname`);
  emit('\n-- ---- sequences (standalone + serial-backed; identity seqs excluded) ----');
  const serialOwnedBy = [];
  const seqAclStmts = [];
  for (const s of seqs) {
    if (s.deptype === 'i') continue; // identity: created with its table
    emit(`CREATE SEQUENCE IF NOT EXISTS public.${qi(s.name)} AS ${s.typ} START WITH ${s.seqstart} INCREMENT BY ${s.seqincrement} MINVALUE ${s.seqmin} MAXVALUE ${s.seqmax} CACHE ${s.seqcache}${s.seqcycle ? ' CYCLE' : ''};`);
    if (s.deptype === 'a' && s.owned_by) serialOwnedBy.push(`ALTER SEQUENCE public.${qi(s.name)} OWNED BY public.${s.owned_by};`);
    seqAclStmts.push(...aclGrants(`SEQUENCE public.${qi(s.name)}`, s.acl, PRIV_MAP_SEQ, ['PUBLIC', 'anon', 'authenticated', 'service_role']));
  }
  report.sequences = seqs.filter(s => s.deptype !== 'i').length;

  // ---- deferred defaults: column defaults that call user functions --------
  const deferredDefaults = await q(`
    SELECT tc.relname AS tbl, ta.attname AS col, pg_get_expr(ad.adbin, ad.adrelid) AS expr
    FROM pg_attrdef ad
    JOIN pg_class tc ON tc.oid=ad.adrelid AND tc.relnamespace='public'::regnamespace
    JOIN pg_attribute ta ON ta.attrelid=ad.adrelid AND ta.attnum=ad.adnum AND ta.attgenerated=''
    JOIN pg_depend d ON d.classid='pg_attrdef'::regclass AND d.objid=ad.oid AND d.refclassid='pg_proc'::regclass
    JOIN pg_proc p ON p.oid=d.refobjid AND p.pronamespace='public'::regnamespace
    WHERE ${EXT_PROC}
    ORDER BY tc.relname, ta.attname`);
  const deferredSet = new Set(deferredDefaults.map(r => `${r.tbl}.${r.col}`));

  // ---- 3. tables ----------------------------------------------------------
  console.log('tables ...');
  const tableAclStmts = [];
  const replidentStmts = [];
  const invalidCons = []; // NOT VALID p/u/c constraints -> guarded ALTER later
  let allTables = [];
  for (let off = 0; ; off += 80) {
    const batch = await q(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relreplident, c.reloptions::text[] AS reloptions, c.relacl::text AS acl,
        (SELECT ic.relname FROM pg_index ix JOIN pg_class ic ON ic.oid=ix.indexrelid WHERE ix.indrelid=c.oid AND ix.indisreplident LIMIT 1) AS replident_index,
        (SELECT jsonb_agg(jsonb_build_object(
            'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull,
            'default', pg_get_expr(ad.adbin, ad.adrelid), 'identity', a.attidentity, 'generated', a.attgenerated,
            'collation', (SELECT co.collname FROM pg_collation co WHERE co.oid=a.attcollation AND a.attcollation IS DISTINCT FROM ty.typcollation)
          ) ORDER BY a.attnum)
         FROM pg_attribute a JOIN pg_type ty ON ty.oid=a.atttypid
         LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
         WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS cols,
        (SELECT jsonb_agg(jsonb_build_object('name', con.conname, 'def', pg_get_constraintdef(con.oid), 'valid', con.convalidated) ORDER BY con.contype, con.conname)
         FROM pg_constraint con WHERE con.conrelid=c.oid AND con.contype IN ('p','u','c','x')) AS cons
      FROM pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND ${EXT_REL}
      ORDER BY c.relname LIMIT 80 OFFSET ${off}`);
    allTables = allTables.concat(batch);
    console.log(`  tables ${off + batch.length}`);
    if (batch.length < 80) break;
  }
  for (const t of allTables) {
    const lines = [];
    for (const col of t.cols || []) {
      let l = `  ${qi(col.name)} ${col.type}`;
      if (col.collation) l += ` COLLATE ${qi(col.collation)}`;
      if (col.generated === 's') l += ` GENERATED ALWAYS AS (${col.default}) STORED`;
      else if (col.identity === 'a') l += ' GENERATED ALWAYS AS IDENTITY';
      else if (col.identity === 'd') l += ' GENERATED BY DEFAULT AS IDENTITY';
      if (col.notnull) l += ' NOT NULL';
      if (col.default && col.generated !== 's' && !col.identity && !deferredSet.has(`${t.relname}.${col.name}`)) l += ` DEFAULT ${col.default}`;
      lines.push(l);
    }
    for (const con of t.cons || []) {
      if (con.valid === false) { invalidCons.push({ tbl: t.relname, name: con.name, def: con.def }); continue; }
      lines.push(`  CONSTRAINT ${qi(con.name)} ${con.def}`);
    }
    const withOpts = t.reloptions && t.reloptions.length ? ` WITH (${t.reloptions.join(', ')})` : '';
    emit(`CREATE TABLE IF NOT EXISTS public.${qi(t.relname)} (\n${lines.join(',\n')}\n)${withOpts};\n`, 'tables');
    if (t.relreplident === 'f') replidentStmts.push(`ALTER TABLE public.${qi(t.relname)} REPLICA IDENTITY FULL;`);
    else if (t.relreplident === 'n') replidentStmts.push(`ALTER TABLE public.${qi(t.relname)} REPLICA IDENTITY NOTHING;`);
    else if (t.relreplident === 'i' && t.replident_index) replidentStmts.push(`ALTER TABLE public.${qi(t.relname)} REPLICA IDENTITY USING INDEX ${qi(t.replident_index)};`);
    tableAclStmts.push(...aclGrants(`TABLE public.${qi(t.relname)}`, t.acl, PRIV_MAP_TABLE, ['PUBLIC', 'anon', 'authenticated', 'service_role']));
  }
  report.tables = allTables.length;
  emit('\n-- ---- replica identity ----', 'tables');
  for (const s of replidentStmts) emit(s, 'tables');
  emit('\n-- ---- serial sequence ownership ----', 'tables');
  for (const s of serialOwnedBy) emit(s, 'tables');

  // ---- 4. foreign keys + NOT VALID constraints (guarded) ------------------
  console.log('foreign keys ...');
  const fks = await q(`SELECT c.relname AS tbl, con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    WHERE con.contype='f' AND con.connamespace='public'::regnamespace AND c.relnamespace='public'::regnamespace
    ORDER BY c.relname, con.conname`);
  newFile('foreign keys');
  for (const fk of fks.concat(invalidCons.map(x => ({ tbl: x.tbl, conname: x.name, def: x.def })))) {
    const body = `\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=${ql(fk.conname)} AND conrelid='public.${fk.tbl.replace(/'/g, "''")}'::regclass) THEN\n    ALTER TABLE public.${qi(fk.tbl)} ADD CONSTRAINT ${qi(fk.conname)} ${fk.def};\n  END IF;\nEND\n`;
    emit(`DO ${dollarQuote(body, 'fk')};`);
  }
  report.foreign_keys = fks.length;
  report.not_valid_constraints = invalidCons.length;

  // ---- 5. functions -------------------------------------------------------
  console.log('functions ...');
  const fnAclStmts = [];
  let fnCount = 0;
  for (let off = 0; ; off += 50) {
    const batch = await q(`
      SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS ident_args, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl
      FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND ${EXT_PROC}
      ORDER BY p.proname, p.oid LIMIT 50 OFFSET ${off}`);
    for (const f of batch) {
      emit(f.def.trimEnd() + ';\n', 'functions');
      fnAclStmts.push(...aclGrants(`FUNCTION public.${qi(f.proname)}(${f.ident_args})`, f.acl, PRIV_MAP_FN, ['PUBLIC', 'anon', 'authenticated', 'service_role']));
      fnCount++;
    }
    console.log(`  functions ${fnCount}`);
    if (batch.length < 50) break;
  }
  report.functions = fnCount;

  // deferred column defaults (need functions to exist first)
  emit('\n-- ---- deferred column defaults (reference user functions) ----', 'functions');
  for (const d of deferredDefaults) emit(`ALTER TABLE public.${qi(d.tbl)} ALTER COLUMN ${qi(d.col)} SET DEFAULT ${d.expr};`, 'functions');
  report.deferred_defaults = deferredDefaults.length;

  // ---- 6. views (topo-sorted, security_invoker preserved) -----------------
  console.log('views ...');
  const views = await q(`
    SELECT c.relname, c.reloptions::text[] AS reloptions, pg_get_viewdef(c.oid) AS def, c.relacl::text AS acl,
      (SELECT COALESCE(jsonb_agg(DISTINCT dv.relname), '[]'::jsonb)
       FROM pg_depend d
       JOIN pg_rewrite rw ON rw.oid=d.objid AND rw.ev_class=c.oid
       JOIN pg_class dv ON dv.oid=d.refobjid AND dv.relkind='v' AND dv.relnamespace='public'::regnamespace AND dv.oid<>c.oid
       WHERE d.classid='pg_rewrite'::regclass AND d.refclassid='pg_class'::regclass) AS view_deps
    FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relkind='v' AND ${EXT_REL}
    ORDER BY c.relname`);
  // topo sort
  const byName = new Map(views.map(v => [v.relname, v]));
  const emitted = new Set(); const order = [];
  function visit(name, chain) {
    if (emitted.has(name) || !byName.has(name)) return;
    if (chain.has(name)) throw new Error('view dependency cycle: ' + [...chain, name].join(' -> '));
    chain.add(name);
    for (const dep of byName.get(name).view_deps || []) visit(dep, chain);
    chain.delete(name);
    emitted.add(name); order.push(byName.get(name));
  }
  for (const v of views) visit(v.relname, new Set());
  const viewAclStmts = [];
  for (const v of order) {
    const withOpts = v.reloptions && v.reloptions.length ? ` WITH (${v.reloptions.join(', ')})` : '';
    const def = v.def.trimEnd().replace(/;$/, '');
    emit(`CREATE OR REPLACE VIEW public.${qi(v.relname)}${withOpts} AS\n${def};\n`, 'views');
    viewAclStmts.push(...aclGrants(`TABLE public.${qi(v.relname)}`, v.acl, PRIV_MAP_TABLE, ['PUBLIC', 'anon', 'authenticated', 'service_role']));
  }
  report.views = order.length;

  // ---- 7. triggers + event trigger ---------------------------------------
  console.log('triggers ...');
  const trgs = await q(`
    SELECT c.relname AS tbl, t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND ${EXT_REL}
    ORDER BY c.relname, t.tgname`);
  newFile('triggers + event trigger');
  for (const t of trgs) {
    emit(t.def.replace(/^CREATE TRIGGER/, 'CREATE OR REPLACE TRIGGER') + ';');
    if (t.tgenabled === 'D') emit(`ALTER TABLE public.${qi(t.tbl)} DISABLE TRIGGER ${qi(t.tgname)};`);
    else if (t.tgenabled === 'A') emit(`ALTER TABLE public.${qi(t.tbl)} ENABLE ALWAYS TRIGGER ${qi(t.tgname)};`);
    else if (t.tgenabled === 'R') emit(`ALTER TABLE public.${qi(t.tbl)} ENABLE REPLICA TRIGGER ${qi(t.tgname)};`);
  }
  report.triggers = trgs.length;
  const evtrgs = await q(`
    SELECT evtname, evtevent, evttags::text[] AS tags, p.proname AS fn
    FROM pg_event_trigger et JOIN pg_proc p ON p.oid=et.evtfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE pn.nspname='public'
    ORDER BY evtname`);
  emit('\n-- ---- event triggers ----');
  for (const et of evtrgs) {
    const when = et.tags && et.tags.length ? ` WHEN TAG IN (${et.tags.map(ql).join(', ')})` : '';
    emit(`DROP EVENT TRIGGER IF EXISTS ${qi(et.evtname)};\nCREATE EVENT TRIGGER ${qi(et.evtname)} ON ${et.evtevent}${when} EXECUTE FUNCTION public.${qi(et.fn)}();`);
  }
  report.event_triggers = evtrgs.length;

  // ---- 8. indexes (non-constraint) ----------------------------------------
  console.log('indexes ...');
  let idxCount = 0;
  newFile('indexes');
  for (let off = 0; ; off += 300) {
    const batch = await q(`
      SELECT pg_get_indexdef(ix.indexrelid) AS def
      FROM pg_index ix
      JOIN pg_class c ON c.oid=ix.indrelid AND c.relnamespace='public'::regnamespace AND c.relkind='r'
      JOIN pg_class ic ON ic.oid=ix.indexrelid
      WHERE ${EXT_REL}
        AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid=ix.indexrelid)
      ORDER BY c.relname, ic.relname LIMIT 300 OFFSET ${off}`);
    for (const i of batch) {
      emit(i.def.replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ').replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ') + ';');
      idxCount++;
    }
    console.log(`  indexes ${idxCount}`);
    if (batch.length < 300) break;
  }
  report.indexes = idxCount;

  // ---- 9. RLS enable + policies -------------------------------------------
  console.log('rls + policies ...');
  const rlsTables = await q(`SELECT c.relname, c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relrowsecurity AND ${EXT_REL} ORDER BY c.relname`);
  newFile('row level security + policies');
  for (const t of rlsTables) {
    emit(`ALTER TABLE public.${qi(t.relname)} ENABLE ROW LEVEL SECURITY;`);
    if (t.relforcerowsecurity) emit(`ALTER TABLE public.${qi(t.relname)} FORCE ROW LEVEL SECURITY;`);
  }
  report.rls_tables = rlsTables.length;
  let polCount = 0;
  for (let off = 0; ; off += 120) {
    const batch = await q(`SELECT tablename, policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname LIMIT 120 OFFSET ${off}`);
    for (const p of batch) {
      const toRoles = (p.roles || []).map(r => r === 'public' ? 'public' : qi(r)).join(', ') || 'public';
      let stmt = `DROP POLICY IF EXISTS ${qi(p.policyname)} ON public.${qi(p.tablename)};\n`;
      stmt += `CREATE POLICY ${qi(p.policyname)} ON public.${qi(p.tablename)} AS ${p.permissive} FOR ${p.cmd} TO ${toRoles}`;
      if (p.qual) stmt += `\n  USING (${p.qual})`;
      if (p.with_check) stmt += `\n  WITH CHECK (${p.with_check})`;
      emit(stmt + ';');
      polCount++;
    }
    console.log(`  policies ${polCount}`);
    if (batch.length < 120) break;
  }
  report.policies = polCount;

  // ---- 10. grants (faithful per-object ACL replay) ------------------------
  console.log('grants ...');
  newFile('grants (per-object ACL replay from prod)');
  emit('-- Tables');
  for (const s of tableAclStmts) emit(s);
  emit('\n-- Views');
  for (const s of viewAclStmts) emit(s);
  emit('\n-- Sequences');
  for (const s of seqAclStmts) emit(s);
  emit('\n-- Functions', 'grants (functions)');
  for (const s of fnAclStmts) emit(s, 'grants (functions)');
  report.grant_statements = tableAclStmts.length + viewAclStmts.length + seqAclStmts.length + fnAclStmts.length;

  // ---- 11. storage buckets + storage policies -----------------------------
  console.log('storage ...');
  const buckets = await q(`SELECT id, name, public, file_size_limit, allowed_mime_types::text[] AS mimes FROM storage.buckets ORDER BY id`);
  newFile('storage buckets + storage.objects policies + realtime publication');
  for (const b of buckets) {
    const mimes = b.mimes && b.mimes.length ? `ARRAY[${b.mimes.map(ql).join(',')}]::text[]` : 'NULL';
    emit(`INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (${ql(b.id)}, ${ql(b.name)}, ${b.public}, ${b.file_size_limit === null ? 'NULL' : b.file_size_limit}, ${mimes}) ON CONFLICT (id) DO NOTHING;`);
  }
  report.buckets = buckets.length;
  const spol = await q(`SELECT tablename, policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname='storage' ORDER BY tablename, policyname`);
  emit('\n-- storage policies (NOTE: requires ownership of storage.objects — may need dashboard/storage-admin if this errors)');
  for (const p of spol) {
    const toRoles = (p.roles || []).map(r => r === 'public' ? 'public' : qi(r)).join(', ') || 'public';
    let stmt = `DROP POLICY IF EXISTS ${qi(p.policyname)} ON storage.${qi(p.tablename)};\n`;
    stmt += `CREATE POLICY ${qi(p.policyname)} ON storage.${qi(p.tablename)} AS ${p.permissive} FOR ${p.cmd} TO ${toRoles}`;
    if (p.qual) stmt += `\n  USING (${p.qual})`;
    if (p.with_check) stmt += `\n  WITH CHECK (${p.with_check})`;
    emit(stmt + ';');
  }
  report.storage_policies = spol.length;

  // ---- 12. realtime publication -------------------------------------------
  const pubs = await q(`SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY schemaname, tablename`);
  emit('\n-- realtime publication membership');
  for (const p of pubs) {
    const body = `\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname=${ql(p.schemaname)} AND tablename=${ql(p.tablename)}) THEN\n    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE ${p.schemaname}.${qi(p.tablename).replace(/'/g, "''")}';\n  END IF;\nEND\n`;
    emit(`DO ${dollarQuote(body, 'pub')};`);
  }
  report.realtime_tables = pubs.length;

  // ---- 13. platform seed rows ---------------------------------------------
  console.log('seed rows ...');
  const SEED_TABLES = ['model_groups', 'models', 'roles', 'profiles', 'workflow_groups', 'mos_workflows', 'mos_content_types', 'mos_workflow_steps', 'mos_platform_accounts', 'listing_mirror_settings', 'webhook_slugs'];
  const NULL_COLUMNS = { webhook_slugs: ['created_by'] }; // FK -> auth.users (not copied)
  newFile('platform seed rows (config tables only — no user/business data)');
  emit(`-- Seeded tables: ${SEED_TABLES.join(', ')}`);
  emit('-- webhook_slugs.created_by is NULLed (references auth.users, which is not copied).');
  report.seeds = {};
  for (const tbl of SEED_TABLES) {
    const cols = await q(`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS ftype, ty.typname AS udt, ty.typcategory AS cat, a.attgenerated <> '' AS generated,
             (SELECT et.typname FROM pg_type et WHERE et.oid = ty.typelem) AS elem_udt
      FROM pg_attribute a JOIN pg_type ty ON ty.oid=a.atttypid
      WHERE a.attrelid='public.${tbl}'::regclass AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY a.attnum`);
    const insertCols = cols.filter(c => !c.generated);
    // int8/numeric returned via to_jsonb keep exactness server-side; cast to text in transit to avoid JS precision loss
    const selectList = insertCols.map(c => {
      if (['int8', 'numeric'].includes(c.udt)) return `(t.${qi(c.name)})::text AS ${qi(c.name)}`;
      return `t.${qi(c.name)} AS ${qi(c.name)}`;
    }).join(', ');
    const rows = await q(`SELECT ${selectList} FROM public.${qi(tbl)} t ORDER BY 1`);
    emit(`\n-- ${tbl} (${rows.length} rows)`);
    emit(`ALTER TABLE public.${qi(tbl)} DISABLE TRIGGER USER;`);
    for (const row of rows) {
      const names = [], vals = [];
      for (const c of insertCols) {
        names.push(qi(c.name));
        let v = row[c.name];
        if ((NULL_COLUMNS[tbl] || []).includes(c.name)) v = null;
        vals.push(sqlLiteral(v, c));
      }
      emit(`INSERT INTO public.${qi(tbl)} (${names.join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT DO NOTHING;`);
    }
    emit(`ALTER TABLE public.${qi(tbl)} ENABLE TRIGGER USER;`);
    report.seeds[tbl] = rows.length;
  }

  // ---- write files --------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) if (/^branch-bootstrap-\d+\.sql$/.test(f)) unlinkSync(join(OUT_DIR, f));
  let total = 0;
  for (const f of files) {
    const txt = f.parts.join('');
    writeFileSync(join(OUT_DIR, f.name), txt);
    total += txt.length;
    console.log(`wrote ${f.name}  (${(txt.length / 1024).toFixed(0)} KB) — ${f.title}`);
  }
  console.log(`total ${(total / 1024).toFixed(0)} KB in ${files.length} files`);
  console.log('REPORT ' + JSON.stringify(report));
}

function sqlLiteral(v, col) {
  if (v === null || v === undefined) return 'NULL';
  const t = col.udt;
  if (t === 'jsonb' || t === 'json') return ql(JSON.stringify(v)) + '::' + t;
  if (t === 'bool') return v ? 'true' : 'false';
  if (['int2', 'int4', 'float4', 'float8'].includes(t)) return String(v);
  if (['int8', 'numeric'].includes(t)) return ql(v) + '::' + (t === 'int8' ? 'bigint' : 'numeric');
  if (col.cat === 'A') { // array
    const elem = col.elem_udt || 'text';
    if (!Array.isArray(v)) throw new Error(`expected array for ${col.name}`);
    if (!v.length) return `'{}'::${elem}[]`;
    return `ARRAY[${v.map(x => ql(x)).join(', ')}]::${elem}[]`;
  }
  if (typeof v === 'object') throw new Error(`unsupported object value for ${col.name} (${t})`);
  return ql(v) + '::' + col.ftype;
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
