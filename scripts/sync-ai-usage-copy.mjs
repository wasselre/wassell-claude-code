#!/usr/bin/env node
/**
 * Regenerate `worker/src/lib/aiUsage.ts` from `api/_lib/aiUsage.ts`.
 *
 * The worker is a standalone npm package (rootDir:"src"; the Dockerfile copies
 * only worker/src/) so it cannot import from api/_lib — the repo's answer to
 * that has always been a verbatim copy with a banner (worker/src/imageGen.ts,
 * worker/src/migrateAgent.ts). This script makes the copy mechanical instead of
 * manual, because the one time it was done by hand the copy went stale within
 * the hour.
 *
 *   node scripts/sync-ai-usage-copy.mjs          # write the copy
 *   node scripts/sync-ai-usage-copy.mjs --check  # fail if it is out of date (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'api', '_lib', 'aiUsage.ts');
const DST = join(root, 'worker', 'src', 'lib', 'aiUsage.ts');

const BANNER = ` * ⚠ THIS FILE IS GENERATED FROM \`api/_lib/aiUsage.ts\` by
 * scripts/sync-ai-usage-copy.mjs. DO NOT EDIT IT DIRECTLY — edit the api copy
 * and re-run the script. The worker is a standalone npm package and cannot
 * import from api/_lib; same posture as worker/src/imageGen.ts.
 *
`;

const src = readFileSync(SRC, 'utf8');
const anchor = ' * aiUsage — the single recorder for every AI call the app makes.\n *\n';
if (!src.includes(anchor)) {
  console.error('sync-ai-usage-copy: header anchor not found in api/_lib/aiUsage.ts');
  process.exit(1);
}
const out = src.replace(anchor, anchor + BANNER, 1);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(DST, 'utf8');
  } catch {
    console.error('sync-ai-usage-copy: worker copy is missing — run `node scripts/sync-ai-usage-copy.mjs`');
    process.exit(1);
  }
  if (current !== out) {
    console.error('sync-ai-usage-copy: worker/src/lib/aiUsage.ts is OUT OF DATE — run `node scripts/sync-ai-usage-copy.mjs`');
    process.exit(1);
  }
  console.log('sync-ai-usage-copy: worker copy is up to date');
  process.exit(0);
}

writeFileSync(DST, out);
console.log(`sync-ai-usage-copy: wrote ${DST}`);
