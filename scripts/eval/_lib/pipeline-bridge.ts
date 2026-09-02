/**
 * scripts/eval/_lib/pipeline-bridge.ts — one-shot child process that runs a
 * single pipeline call for the eval harness and prints the result as JSON.
 *
 * Executed with the worker's own tsx (`worker/node_modules/tsx/dist/cli.mjs`)
 * so it can import the worker's TypeScript directly, with the worker's
 * node_modules resolution (the worker is a standalone package).
 *
 * Protocol: JSON request on stdin →
 *   { kind: 'script', input: {content_id, project_id, recipe, duration_sec}, roleOverrides }
 *   { kind: 'cv',     input: {role, frame_id? | shot_id?, video_id?},        roleOverrides }
 * one line on stdout prefixed with `__EVAL_RESULT__` followed by
 *   { ok:true,  result, wall_ms }
 *   { ok:false, unavailable:true, reason }         ← entry file / export missing
 *   { ok:false, error, kind, stack, wall_ms }      ← the pipeline threw
 * Anything else the pipeline prints (console.log) is left on stdout/stderr and
 * ignored by the harness, which only parses the sentinel line.
 *
 * ASSUMED ENTRY SIGNATURES (owned by W-SCRIPT / W-CV, wired by the coordinator;
 * this file must NOT create them):
 *   worker/src/marketing/script/evalEntry.ts
 *     export runScriptEval(input, roleOverrides) → { draft, review, cost_usd, latency_ms, roles }
 *   worker/src/marketing/cv/evalEntry.ts
 *     export runCvEval(input, roleOverrides)     → { output, cost_usd, latency_ms, roles }
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SENTINEL = '__EVAL_RESULT__';

type EntryKind = 'script' | 'cv';
const ENTRIES: Record<EntryKind, { file: string; fn: string }> = {
  script: { file: join(ROOT, 'worker', 'src', 'marketing', 'script', 'evalEntry.ts'), fn: 'runScriptEval' },
  cv: { file: join(ROOT, 'worker', 'src', 'marketing', 'cv', 'evalEntry.ts'), fn: 'runCvEval' },
};

interface BridgeRequest {
  kind: EntryKind;
  input: Record<string, unknown>;
  roleOverrides?: Record<string, unknown>;
}

type EntryFn = (input: Record<string, unknown>, roleOverrides: Record<string, unknown>) => Promise<unknown>;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function emitAndExit(obj: Record<string, unknown>, code = 0): void {
  process.stdout.write(`${SENTINEL}${JSON.stringify(obj)}\n`, () => process.exit(code));
}

function errorKind(msg: string): string | null {
  const m = /^(provider|facts_insufficient|budget_exceeded|validation_unrepaired):/.exec(msg);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let req: BridgeRequest;
  try {
    req = JSON.parse(raw) as BridgeRequest;
  } catch (e) {
    return emitAndExit({ ok: false, error: `bridge: invalid JSON on stdin: ${(e as Error).message}` }, 2);
  }
  const entry = ENTRIES[req.kind];
  if (!entry) return emitAndExit({ ok: false, error: `bridge: unknown kind ${String(req.kind)}` }, 2);
  if (!existsSync(entry.file)) {
    return emitAndExit({ ok: false, unavailable: true, reason: `${entry.file} does not exist yet (pipeline not available)` });
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(entry.file).href)) as Record<string, unknown>;
  } catch (e) {
    const err = e as Error;
    return emitAndExit({ ok: false, unavailable: true, reason: `import of ${entry.file} failed: ${err.message}`, stack: err.stack });
  }
  const fn = mod[entry.fn];
  if (typeof fn !== 'function') {
    return emitAndExit({ ok: false, unavailable: true, reason: `${entry.file} does not export ${entry.fn}()` });
  }
  const t0 = Date.now();
  try {
    const result = await (fn as EntryFn)(req.input, req.roleOverrides ?? {});
    return emitAndExit({ ok: true, result, wall_ms: Date.now() - t0 });
  } catch (e) {
    const err = e as Error;
    return emitAndExit({ ok: false, error: err.message, kind: errorKind(err.message), stack: err.stack, wall_ms: Date.now() - t0 });
  }
}

main().catch((e: Error) => emitAndExit({ ok: false, error: `bridge crashed: ${e.message}`, stack: e.stack }, 1));
