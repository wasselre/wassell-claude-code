/**
 * scripts/eval/_lib/env.mjs — shared plumbing for the eval harness.
 *
 * Zero-dependency `.env.local` / `.env` loader (same convention as
 * scripts/sync-model-workflow-prds.mjs: a real shell env always wins) plus a
 * service-role Supabase client tagged with the script identity, and a pager
 * that never truncates (the 1,000-row PostgREST cliff is a documented incident
 * in CLAUDE.md "Silent Failures" — every list read here pages to the end and
 * THROWS on the first error).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIdentifiedClient } from '../../_lib/serviceClient.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  const txt = readFileSync(p, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(join(ROOT, '.env.local'));
loadEnvFile(join(ROOT, '.env'));

export function requireEnv(name, alt) {
  const v = process.env[name] ?? (alt ? process.env[alt] : undefined);
  if (!v) throw new Error(`Missing env ${name}${alt ? ` (or ${alt})` : ''} — add it to .env.local or run scripts/bootstrap-session.sh`);
  return v;
}

/** Service-role client. Throws (does not silently degrade) when the key is absent. */
export function serviceClient(scriptName) {
  const url = requireEnv('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return makeIdentifiedClient(`script:eval/${scriptName}`, url, key);
}

/**
 * Page through a PostgREST query to the very end. `build(from, to)` must
 * return a fresh query with `.range(from, to)` applied. Throws on any error.
 */
export async function pageAll(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(`pageAll: ${error.message} (${error.code ?? 'no code'})`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
  }
  return out;
}

/** Tiny argv parser: `--k v`, `--k=v`, `--flag`. Repeated keys become arrays only when asked via `list()`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else args._.push(a);
  }
  return args;
}

export const todayStamp = () => new Date().toISOString().slice(0, 10);
