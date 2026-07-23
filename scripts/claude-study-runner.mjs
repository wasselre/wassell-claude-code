#!/usr/bin/env node
/**
 * claude-study-runner — drains the `claude_jobs` queue by running FULL headless
 * Claude Code sessions on this machine.
 *
 *   node scripts/claude-study-runner.mjs          (or: npm run study-runner)
 *
 * For each pending job (ONE at a time — sequential by design, so the runner
 * never competes with the owner's interactive Claude sessions for rate limit):
 *   kind='ping'          → trivial echo session; verifies the whole chain.
 *   kind='client_study'  → `claude -p "/client-study <chat-url>" ...` in the
 *                          repo root. The prompt instructs the session to
 *                          write a result-sentinel JSON file; the runner
 *                          uploads the produced PDF to the `wassel-files`
 *                          bucket, mints a 7-day signed URL, and completes the
 *                          job with { pdf_signed_url, whatsapp_draft, ... }.
 *
 * Credentials: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local/.env
 * (same auto-load posture as scripts/sync-model-workflow-prds.mjs). The Claude
 * CLI uses whatever account this machine is logged into.
 *
 * Sessions run with --dangerously-skip-permissions: this runner executes ONLY
 * on a trusted machine against our own repo. Do not point it at untrusted
 * repos or prompts.
 */
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLL_MS = 10_000;
const SESSION_TIMEOUT_MS = 35 * 60 * 1000;
const WORKER = `runner:${process.env.COMPUTERNAME || process.env.HOSTNAME || 'local'}:${process.pid}`;

// ── env (auto-load .env.local / .env, no dotenv dep) ────────────────────────
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[runner] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — check .env.local');
  process.exit(1);
}
const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ── claude CLI session ──────────────────────────────────────────────────────
function runClaude(prompt, cwd) {
  return new Promise((resolve) => {
    // Prompt goes via STDIN (not argv): multiline Arabic prompts survive
    // Windows shell quoting, and the CLI's "no stdin" warning goes away.
    const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'text'];
    // The child session must authenticate with THIS MACHINE'S Claude login
    // (the owner's account — explicit decision 2026-07-22). .env.local's
    // ANTHROPIC_API_KEY is the app's server-side key and is NOT valid for the
    // CLI — if it leaks into the child env the CLI prefers it and 401s.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    const child = spawn('claude', args, {
      cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already dead */ }
      resolve({ code: -1, out, err: err + '\n[runner] session timeout' });
    }, SESSION_TIMEOUT_MS);
    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -2, out, err: String(e) }); });
  });
}

// ── job handlers ────────────────────────────────────────────────────────────
async function handlePing(job) {
  const { code, out, err } = await runClaude(
    'Reply with exactly the single word PONG and nothing else.', ROOT);
  if (code !== 0 || !/PONG/i.test(out)) throw new Error(`ping session failed (code ${code}): ${(err || out).slice(-400)}`);
  return { pong_at: new Date().toISOString(), echo: out.trim().slice(0, 100) };
}

async function handleClientStudy(job) {
  const chatId = job.payload?.chat_record_id;
  if (!chatId) throw new Error('payload.chat_record_id is required');

  const workDir = mkdtempSync(path.join(tmpdir(), 'claude-study-'));
  const sentinel = path.join(workDir, 'result.json');
  const prompt = [
    `/client-study https://app.wassel.re/model/chats/${chatId}`,
    '',
    'You are running HEADLESS from the app queue — no one can answer questions,',
    'so make every decision autonomously per the skill. When the study is done',
    'and visually verified, write a JSON file to exactly this path:',
    `  ${sentinel}`,
    'with keys: "pdf_path" (absolute path of the final PDF), "title" (short',
    'Arabic study title), "whatsapp_draft" (the Arabic message for the client),',
    '"summary" (2-3 sentences for the rep, Arabic), "heads_ups" (array of',
    'private notes for the rep, may be empty). Writing this file is the LAST',
    'thing you do.',
  ].join('\n');

  try {
    const { code, out, err } = await runClaude(prompt, ROOT);
    if (!existsSync(sentinel)) {
      throw new Error(`session ended (code ${code}) without result sentinel: ${(err || out).slice(-600)}`);
    }
    const result = JSON.parse(readFileSync(sentinel, 'utf-8'));
    if (!result.pdf_path || !existsSync(result.pdf_path)) {
      throw new Error(`sentinel pdf_path missing or file not found: ${result.pdf_path}`);
    }

    const pdfBytes = readFileSync(result.pdf_path);
    const storagePath = `claude-studies/${job.id}.pdf`;
    const { error: upErr } = await supa.storage.from('wassel-files')
      .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);

    const { data: signed, error: signErr } = await supa.storage.from('wassel-files')
      .createSignedUrl(storagePath, 7 * 24 * 3600);
    if (signErr) throw new Error(`signed url failed: ${signErr.message}`);

    return {
      title: result.title ?? 'دراسة عقارية',
      pdf_storage_path: storagePath,
      pdf_signed_url: signed.signedUrl,
      pdf_bytes: pdfBytes.length,
      whatsapp_draft: result.whatsapp_draft ?? '',
      summary: result.summary ?? '',
      heads_ups: Array.isArray(result.heads_ups) ? result.heads_ups : [],
    };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) {
      console.error('[runner] workdir cleanup failed:', e.message);
    }
  }
}

// ── main loop ───────────────────────────────────────────────────────────────
let lastWatchdog = 0;
async function tick() {
  if (Date.now() - lastWatchdog > 5 * 60_000) {
    lastWatchdog = Date.now();
    const { error } = await supa.rpc('claude_jobs_watchdog');
    if (error) console.error('[runner] watchdog rpc failed:', error.message);
  }

  const { data: jobs, error } = await supa.rpc('claude_job_claim_next', { p_worker: WORKER });
  if (error) { console.error('[runner] claim failed:', error.message); return; }
  const job = jobs?.[0];
  if (!job) return;

  console.log(`[runner] claimed ${job.kind} job=${job.id}`);
  try {
    const result = job.kind === 'ping' ? await handlePing(job) : await handleClientStudy(job);
    const { error: doneErr } = await supa.rpc('claude_job_complete', { p_job_id: job.id, p_result: result });
    if (doneErr) console.error('[runner] complete rpc failed:', doneErr.message);
    else console.log(`[runner] job=${job.id} READY`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[runner] job=${job.id} FAILED: ${msg}`);
    const { error: failErr } = await supa.rpc('claude_job_fail', { p_job_id: job.id, p_error: msg });
    if (failErr) console.error('[runner] fail rpc failed:', failErr.message);
  }
}

console.log(`[runner] ${WORKER} polling every ${POLL_MS / 1000}s — repo: ${ROOT}`);
// Sequential forever-loop: one job fully finishes before the next claim.
// eslint-disable-next-line no-constant-condition
while (true) {
  try { await tick(); } catch (e) { console.error('[runner] tick crashed:', e); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
