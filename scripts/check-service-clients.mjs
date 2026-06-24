#!/usr/bin/env node
// CI guard (T2): fail if a SERVICE-ROLE Supabase client is created with a raw
// `createClient(...)` outside the allowlisted factory files. Every service-role
// client must go through a factory so it carries identity headers
// (x-wassel-service / x-wassel-build / x-wassel-instance) — otherwise a storming
// or looping client is anonymous in Postgres logs (the 2026-06-23 incident gap).
//
// Heuristic: flag any `createClient(` whose 2nd argument is a known service-role
// key identifier. Anon clients are fine anywhere and are not flagged. The
// allowlist is the four runtime factories (Vercel / worker / edge / scripts) plus
// test files (integration tests legitimately use a service key directly).
//
// Run: node scripts/check-service-clients.mjs   (wire into CI / pre-push)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['api', 'worker/src', 'src', 'scripts', 'supabase/functions'];
const EXT = /\.(ts|tsx|mjs|js)$/;

// Files permitted to create a service-role client directly (the factories) +
// test files. Paths are matched as suffixes (OS-agnostic).
const ALLOWLIST = [
  'api/_lib/serviceClient.ts',
  'worker/src/lib/serviceClient.ts',
  'scripts/_lib/serviceClient.mjs',
  'supabase/functions/_shared/supabase.ts',
];
const ALLOW_TEST = /\.(test|spec)\.(ts|tsx|mjs|js)$/;

// 2nd-arg identifiers that denote a service-role key.
const SERVICE_KEY_TOKENS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'serviceRoleKey',
  'serviceKey',
  'SERVICE_KEY',
  'SERVICE_ROLE_KEY',
];

function norm(p) {
  return p.split(sep).join('/');
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir may not exist in every checkout
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

const offenders = [];
const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d), []));

for (const file of files) {
  const rel = norm(file).slice(norm(ROOT).length + 1);
  if (ALLOWLIST.some((a) => rel.endsWith(a))) continue;
  if (ALLOW_TEST.test(rel)) continue;
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('createClient(')) continue;
    // Look at the createClient call + the next 2 lines for the 2nd arg.
    const window = `${lines[i]}\n${lines[i + 1] ?? ''}\n${lines[i + 2] ?? ''}`;
    if (SERVICE_KEY_TOKENS.some((t) => window.includes(t))) {
      offenders.push(`${rel}:${i + 1}  ${lines[i].trim()}`);
    }
  }
}

if (offenders.length > 0) {
  console.error('✖ Raw service-role createClient outside the factory:');
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    '\nRoute it through the service-client factory for your runtime so identity ' +
      'headers are attached (T2). Allowlisted factories:\n  ' +
      ALLOWLIST.join('\n  '),
  );
  process.exit(1);
}

console.log(`✓ service-client guard: ${files.length} files scanned, no raw service-role createClient outside the factory.`);
