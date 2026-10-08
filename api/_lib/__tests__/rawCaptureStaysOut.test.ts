/**
 * Guard: the raw capture library stays out of the app (operator, 2026-10-08:
 * "make sure content extracted does not end up in files and the actual app").
 *
 * `mkt_media_raw_capture` is a back-room dataset for building agents later —
 * service-role only in the database (2026-10-08_02). This test keeps the code
 * side true: nothing the browser bundle or a Vercel endpoint ships may read it.
 * Only the Fly worker (worker/src) writes it. If an agent needs it later, that
 * is a deliberate decision — change this test in the same commit, don't route
 * around it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const SCAN = ['src', 'api', 'supabase/functions'];
const SELF = relative(ROOT, __filename);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
}

describe('raw capture stays out of the app', () => {
  it('no app or endpoint code references mkt_media_raw_capture', () => {
    const files: string[] = [];
    for (const d of SCAN) walk(join(ROOT, d), files);
    const hits = files
      .filter((f) => relative(ROOT, f) !== SELF)
      .filter((f) => readFileSync(f, 'utf8').includes('mkt_media_raw_capture'))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
