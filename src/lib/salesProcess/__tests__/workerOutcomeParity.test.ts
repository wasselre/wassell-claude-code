// The Fly worker cannot import from src/, so worker/src/runCallAnalysisJob.ts
// carries a hand-maintained COPY of the call-channel outcome matrix. It uses
// that copy to constrain what DeepSeek may answer.
//
// If the copy drifts from config.ts the failure is quiet and ugly: the model
// proposes an outcome the Workspace has no button for, so the confirmation
// popup either shows nothing selected or refuses the job outright. This test is
// the tripwire — it reads the worker file as text (no import; different package,
// different tsconfig) and compares the map to the real config.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SALES_PROCESS } from '../config';

const WORKER_FILE = path.resolve(__dirname, '../../../../worker/src/runCallAnalysisJob.ts');

/** Pull `OUTCOMES_BY_TYPE` out of the worker source without importing it. */
function readWorkerMatrix(): Record<string, string[]> {
  const src = fs.readFileSync(WORKER_FILE, 'utf8');
  const start = src.indexOf('const OUTCOMES_BY_TYPE');
  expect(start, 'OUTCOMES_BY_TYPE not found in the worker runner').toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n};', open);
  const body = src.slice(open + 1, close);

  const out: Record<string, string[]> = {};
  for (const line of body.split('\n')) {
    const m = /^\s*([a-z_]+)\s*:\s*\[(.*)\],\s*$/.exec(line);
    if (!m) continue;
    out[m[1]!] = [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  }
  return out;
}

describe('worker call-analysis outcome matrix', () => {
  const worker = readWorkerMatrix();
  const callTypes = DEFAULT_SALES_PROCESS.followup_types.filter((t) => t.primary_channel === 'call');

  it('covers every call-channel follow-up type', () => {
    expect(Object.keys(worker).sort()).toEqual(callTypes.map((t) => t.type).sort());
  });

  it.each(callTypes.map((t) => [t.type, t] as const))(
    'matches config.ts for %s',
    (type, cfg) => {
      expect(worker[type]).toEqual(cfg.allowed_outcomes.map((o) => o.value));
    },
  );

  it('never offers the retired wrong_time outcome', () => {
    for (const [type, values] of Object.entries(worker)) {
      expect(values, `${type} still offers wrong_time`).not.toContain('wrong_time');
    }
  });

  it('falls back to a type that really exists', () => {
    // runCallAnalysisJob uses this when a call matches no follow-up, and the
    // popup mirrors it — the two MUST agree or the AI's answer is not a button.
    expect(worker.appointment_booking_call).toBeDefined();
    expect(worker.appointment_booking_call).toContain('no_answer');
  });
});
