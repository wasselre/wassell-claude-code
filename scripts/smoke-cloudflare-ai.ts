/**
 * Standalone smoke test for the Cloudflare Workers AI provider
 * (api/_lib/cloudflareAi.ts — Qwen3 30B, OpenAI-compatible endpoint).
 *
 * Verifies the provider WITHOUT touching any app flow:
 *   1. English prompt  → non-empty completion.
 *   2. Arabic prompt   → completion containing Arabic script (Unicode path).
 *   3. Auth-failure mapping → a deliberately invalid token must surface as
 *      CloudflareAiError kind='auth' (never a silent pass-through).
 *
 * USAGE (from the repo root; reads CLOUDFLARE_* from .env.local / .env):
 *   node scripts/smoke-cloudflare-ai.ts        # Node >= 23 (type stripping)
 *   npx tsx scripts/smoke-cloudflare-ai.ts     # any Node
 *
 * Requires: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (see
 * docs/cloudflare-workers-ai.md). Exits 1 on any failure — loud, per CLAUDE.md.
 * Prints usage tokens per call (the free plan has a daily Neuron allowance);
 * never prints the token.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareChatCompletion, CloudflareAiError } from '../api/_lib/cloudflareAi.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── tiny zero-dep .env loader (same convention as sync-model-workflow-prds.mjs) ──
function loadEnvFile(p: string): void {
  if (!existsSync(p)) return;
  let txt: string;
  try {
    txt = readFileSync(p, 'utf8');
  } catch {
    return; // unreadable env file — the env-presence check in the provider reports it
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnvFile(join(ROOT, '.env.local'));
loadEnvFile(join(ROOT, '.env'));

/** Qwen3 emits <think>…</think> reasoning blocks — strip for display only. */
function visible(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function fmtUsage(u: { promptTokens: number; completionTokens: number } | null): string {
  return u ? `${u.promptTokens} in + ${u.completionTokens} out tokens` : 'usage n/a';
}

let failures = 0;
function report(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failures += 1;
}

// 1. English
try {
  const r = await cloudflareChatCompletion({
    messages: [{ role: 'user', content: 'Reply with one short English sentence: what is the capital of France?' }],
    maxTokens: 600,
    temperature: 0.2,
  });
  const text = visible(r.content);
  report('english', text.length > 0 && /paris/i.test(text), `${r.durationMs}ms, ${fmtUsage(r.usage)}, reply: ${text.slice(0, 120)}`);
} catch (err) {
  report('english', false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

// 2. Arabic (Unicode round-trip)
try {
  const r = await cloudflareChatCompletion({
    messages: [{ role: 'user', content: 'أجب بجملة عربية قصيرة واحدة فقط: ما هي عاصمة المملكة العربية السعودية؟' }],
    maxTokens: 600,
    temperature: 0.2,
  });
  const text = visible(r.content);
  const hasArabic = /[؀-ۿ]/.test(text);
  report('arabic', text.length > 0 && hasArabic && text.includes('الرياض'), `${r.durationMs}ms, ${fmtUsage(r.usage)}, reply: ${text.slice(0, 120)}`);
} catch (err) {
  report('arabic', false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

// 3. Auth-failure mapping (invalid token must classify as kind='auth')
{
  const real = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'invalid-token-for-smoke-test';
  try {
    await cloudflareChatCompletion({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
      timeoutMs: 30_000,
    });
    report('auth-mapping', false, 'invalid token unexpectedly succeeded');
  } catch (err) {
    const ok = err instanceof CloudflareAiError && err.kind === 'auth';
    report(
      'auth-mapping',
      ok,
      err instanceof CloudflareAiError ? `kind=${err.kind} status=${err.status}` : String(err),
    );
  } finally {
    process.env.CLOUDFLARE_API_TOKEN = real;
  }
}

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
