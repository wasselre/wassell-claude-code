/**
 * Coverage guard: every AI call site in the repo must record its usage.
 *
 * This is the test that keeps "everything is tracked" TRUE over time. The
 * 2026-09-14 audit found 35 of ~44 call sites spending with no telemetry; they
 * were all wired, but nothing stopped the 36th from shipping unwired — a new
 * endpoint is three lines of `new Anthropic(...)` away from being invisible to
 * cost reporting again.
 *
 * The rules are deliberately crude (source scanning, not type analysis) because
 * a crude rule that runs on every commit beats a precise one nobody runs. When
 * this test fails the fix is almost always "wrap the client in
 * trackedAnthropic" or "pass `track:` to the helper" — not "add an allowlist
 * entry".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
// `scripts` was outside this scan until 2026-09-15, and `__tests__` was skipped
// outright. Both were real holes: an operator-run eval or backfill in scripts/
// spends the same money as production, and an e2e test that builds its own
// client spends it from a laptop. Measured that day, hand-run work was the
// LARGER share of the Anthropic bill.
//
// Know the limit of this guard, though: it catches a file that CONSTRUCTS a
// client or calls a provider URL. It cannot catch a test that drives an
// already-metered function in a loop — which is exactly what
// runCalibration.e2e.test.ts does. That class of spend is caught by comparing
// our balance against the vendor's (v_ai_balance_reconciliation), not here.
const SCAN_DIRS = ['api', join('worker', 'src'), join('supabase', 'functions'), 'scripts'];
const CODE_EXT = /\.(ts|mts|mjs)$/;
const NL = '\n';

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXT.test(name) && !name.endsWith('.d.ts') && !name.endsWith('.d.mts')) out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => ({
  path: relative(ROOT, f).split(sep).join('/'),
  src: readFileSync(f, 'utf8'),
}));

/** The recorder itself and its copies — they contain the patterns by definition. */
const RECORDER_FILES = new Set([
  'api/_lib/aiUsage.ts',
  'worker/src/lib/aiUsage.ts',
  'supabase/functions/_shared/aiUsage.ts',
  // Fourth copy: plain ESM, because .mjs tooling cannot import the TS one.
  'scripts/lib/aiUsage.mjs',
  // This guard quotes the patterns it hunts for, so it matches itself.
  'api/_lib/__tests__/aiUsageCoverage.test.ts',
]);

/**
 * Anthropic (and Anthropic-compatible, i.e. Kimi) clients that are NOT built
 * inside trackedAnthropic(...).
 *
 * An entry needs BOTH a reason and a `proof` string that must appear in the
 * file. The proof is what stops an exemption from quietly decaying into a hole:
 * delete the explicit recording the reason describes and the proof stops
 * matching, so this test fails instead of the spend going dark.
 */
const UNWRAPPED_CLIENT_ALLOWLIST: Record<string, { reason: string; proof: string }> = {
  'api/builder-agent.ts': {
    reason: 'streams the turn, so usage only exists at finalMessage(); records once per loop iteration',
    proof: 'recordAiUsage',
  },
  'api/workflow-agent.ts': {
    reason: 'streams the turn; records once per loop iteration',
    proof: 'recordAiUsage',
  },
  'api/match.ts': {
    reason: 'streams the turn; records once per loop iteration',
    proof: 'recordAiUsage',
  },
  'api/_lib/reelAnalyst.mjs': {
    reason: 'plain .mjs, cannot import the TypeScript recorder; the caller injects the wrapper',
    proof: 'wrapClient',
  },
  'worker/src/ai/providers/anthropic.ts': {
    reason: 'the role provider — its caller callRole() records every result centrally',
    proof: 'LlmProvider',
  },
  // ── scripts/ ────────────────────────────────────────────────────────────
  // These construct a client for the FILES / SKILLS APIs, which are storage
  // and cost no tokens. Metering them would add rows that are always zero and
  // teach the reader to ignore the ledger. Each proof is the storage call
  // itself: swap it for a model call and the exemption stops matching.
  'scripts/list-anthropic-files.mjs': {
    reason: 'lists uploaded files via the Files API; makes no model call',
    proof: 'beta.files.list',
  },
  'scripts/upload-wassel-skill.mjs': {
    reason: 'uploads a Skill via the Skills API; makes no model call',
    proof: 'beta.skills.create',
  },
  'scripts/upload-wassel-review-skill.mjs': {
    reason: 'uploads a Skill version via the Skills API; makes no model call',
    proof: 'beta.skills.create',
  },

  'supabase/functions/_shared/anthropic.ts': {
    reason: 'client factory only; the edge function that uses it records explicitly',
    proof: 'export',
  },
  'supabase/functions/project-details-ai-v2/index.ts': {
    reason: 'Deno runtime; records explicitly via ../_shared/aiUsage.ts',
    proof: 'recordAiUsage',
  },
};

describe('AI usage coverage', () => {
  it('finds the files it is supposed to be scanning', () => {
    // Guards against the walk silently matching nothing — a green test that
    // checked zero files would be worse than no test.
    expect(FILES.length).toBeGreaterThan(400);
    expect(FILES.some((f) => f.path === 'scripts/lib/aiUsage.mjs')).toBe(true);
    expect(FILES.some((f) => f.path === 'api/_lib/aiUsage.ts')).toBe(true);
  });

  it('every Anthropic client is wrapped for tracking', () => {
    const offenders: string[] = [];
    for (const { path, src } of FILES) {
      if (RECORDER_FILES.has(path)) continue;
      if (!src.includes('new Anthropic(')) continue;

      const allow = UNWRAPPED_CLIENT_ALLOWLIST[path];
      if (allow) {
        if (!src.includes(allow.proof)) {
          offenders.push(
            `${path} is allowlisted ("${allow.reason}") but no longer contains "${allow.proof}" — the exemption has become a hole`,
          );
        }
        continue;
      }

      const lines = src.split(NL);
      lines.forEach((line, i) => {
        if (!line.includes('new Anthropic(')) return;
        // The construction may sit on the line after `trackedAnthropic(`.
        const window = [lines[i - 1] ?? '', line].join(NL);
        if (!window.includes('trackedAnthropic(')) {
          offenders.push(`${path}:${i + 1} constructs an Anthropic client outside trackedAnthropic()`);
        }
      });
    }
    expect(offenders, `Untracked AI spend:${NL}  ${offenders.join(NL + '  ')}`).toEqual([]);
  });

  it('every direct DeepSeek call records usage', () => {
    const offenders: string[] = [];
    for (const { path, src } of FILES) {
      if (RECORDER_FILES.has(path)) continue;
      // Must be a real call, not a config file that merely names the host
      // (worker/src/env.ts declares DEEPSEEK_BASE_URL and calls nothing).
      const callsDeepseek =
        (src.includes('api.deepseek.com') || src.includes('DEEPSEEK_BASE_URL')) &&
        src.includes('chat/completions');
      if (!callsDeepseek) continue;
      if (!src.includes('recordAiUsage')) {
        offenders.push(`${path} calls DeepSeek directly but never calls recordAiUsage`);
      }
    }
    expect(offenders, `Untracked DeepSeek spend:${NL}  ${offenders.join(NL + '  ')}`).toEqual([]);
  });

  /**
   * Files that speak to Modal but do not record, because their CALLER does.
   * Same proof discipline as the Anthropic allowlist: delete the mechanism the
   * reason names and the proof stops matching.
   */
  const MODAL_TRANSPORT_ALLOWLIST: Record<string, { reason: string; proof: string }> = {
    'worker/src/marketing/cv/modalClient.ts': {
      reason: 'transport only; the cv lane records the /process call through cv/ledger.ts addCost()',
      proof: 'ModalCvClient',
    },
    'worker/src/ai/providers/modalEmbed.ts': {
      reason: 'embedding provider; its caller embed() in ai/roles.ts records every result',
      proof: 'EmbeddingProvider',
    },
    'worker/src/env.ts': {
      reason: 'names the auth header in a comment while declaring the env var; makes no call',
      proof: 'MODAL_CV_TOKEN',
    },
    'worker/src/ai/__tests__/modalEmbed.test.ts': {
      reason: 'asserts the NOT-CONFIGURED path: it deletes MODAL_CV_URL and expects the throw, so it never reaches Modal',
      proof: 'delete process.env.MODAL_CV_URL',
    },
  };

  it('every direct Modal call records usage', () => {
    // This rule exists because its absence cost us: api/_lib/marketing/modalCv.ts
    // called Modal's /embed_query on every visual search and was missed by the
    // original sweep, because the guard only knew about Anthropic and DeepSeek.
    // Modal is the largest single line in the bill, so it gets its own rule.
    //
    // The detector is Modal's auth header rather than the env var name: the
    // worker's index.ts mentions MODAL_CV_URL purely to gate the lanes and
    // makes no call, and a rule that flags it teaches people to ignore the rule.
    const offenders: string[] = [];
    for (const { path, src } of FILES) {
      if (RECORDER_FILES.has(path)) continue;
      if (!src.includes('x-wassel-token')) continue;

      const allow = MODAL_TRANSPORT_ALLOWLIST[path];
      if (allow) {
        if (!src.includes(allow.proof)) {
          offenders.push(
            `${path} is allowlisted ("${allow.reason}") but no longer contains "${allow.proof}" — the exemption has become a hole`,
          );
        }
        continue;
      }
      if (!src.includes('recordAiUsage')) {
        offenders.push(`${path} calls Modal directly but never calls recordAiUsage`);
      }
    }
    expect(offenders, `Untracked Modal spend:${NL}  ${offenders.join(NL + '  ')}`).toEqual([]);
  });

  it('the shared DeepSeek client forces every caller to declare a call site', () => {
    const src = FILES.find((f) => f.path === 'api/_lib/deepseek.ts')?.src ?? '';
    expect(src).toContain('recordAiUsage');
    // `track: AiCallRef` with no `?` is what makes an unwired caller a compile
    // error rather than a silent metering gap.
    expect(src).toMatch(/\n\s*track: AiCallRef;/);
  });

  it('the fal image queue bills every poll', () => {
    for (const path of ['api/_lib/imageGen.ts', 'worker/src/imageGen.ts']) {
      const src = FILES.find((f) => f.path === path)?.src ?? '';
      expect(src, `${path} must record fal usage`).toContain('recordAiUsage');
      expect(src, `${path} must require a call-site ref`).toMatch(/\n\s*track: AiCallRef;/);
    }
  });

  it('the worker copy of the recorder is in sync with the api original', () => {
    // Line endings are normalised out: git's core.autocrlf rewrites checked-out
    // files on Windows, so the same two files are LF in CI and CRLF on a laptop.
    // Comparing raw bytes failed after a rebase over a difference that does not
    // exist in the repository.
    const lf = (t: string) => t.replace(/\r\n/g, '\n');
    const api = lf(FILES.find((f) => f.path === 'api/_lib/aiUsage.ts')?.src ?? '');
    const worker = lf(FILES.find((f) => f.path === 'worker/src/lib/aiUsage.ts')?.src ?? '');
    expect(api.length).toBeGreaterThan(0);
    // The copy is the api file plus a generated banner; strip the banner and the
    // two must be byte-identical. Regenerate with:
    //   node scripts/sync-ai-usage-copy.mjs
    const stripped = worker.replace(/ \* ⚠ THIS FILE IS GENERATED FROM[\s\S]*?\n \*\n/, '');
    expect(stripped, 'run `node scripts/sync-ai-usage-copy.mjs`').toBe(api);
  });
});
