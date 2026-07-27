#!/usr/bin/env node
/**
 * wassel-wa-agent — the WhatsApp AI reply runner.
 *
 * Drains `claude_jobs` rows of kind='whatsapp_reply' by spawning a FULL headless
 * Claude Code session per conversation. The session — not an API bot — reads the
 * chat, looks things up in the CRM, decides what to say, and sends it.
 *
 * Deliberately the same shape as scripts/claude-study-runner.mjs (which does the
 * same for client studies), with three differences:
 *   - runs on Fly, not a laptop, so it works 24/7 (that's the whole point);
 *   - authenticates via CLAUDE_CODE_OAUTH_TOKEN (no interactive login in a container);
 *   - one job at a time + a DB singleton lease, so two machines can never both
 *     answer the same customer.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAUDE_CODE_OAUTH_TOKEN,
 *      WHATSAPP_AI_SECRET, APP_URL (default https://app.wassel.re).
 */
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL      = process.env.APP_URL || 'https://app.wassel.re';
const AI_SECRET    = process.env.WHATSAPP_AI_SECRET || '';
const POLL_MS      = Number(process.env.POLL_INTERVAL_MS || 5000);
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS || 8 * 60_000);
const WORKER = `wa-agent-${process.env.FLY_MACHINE_ID || process.pid}`;
const LEASE = 'whatsapp_reply';

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('[wa-agent] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) console.error('[wa-agent] WARNING: CLAUDE_CODE_OAUTH_TOKEN is not set — sessions will fail to authenticate');

const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

let stopping = false;
let currentChild = null;
let haveLease = false;

// ── HTTP: health + WAHA proxy ───────────────────────────────────────────────
//
// WAHA refuses Vercel's egress with 403 while accepting this worker (verified
// live 2026-07-26: identical API key, 200 from here, 403 from a Vercel
// function). Rather than punch a firewall hole for Vercel's whole dynamic IP
// range, the app calls WAHA *through* this machine: `/waha/<path>` is forwarded
// verbatim with the real API key attached.
//
// Auth is the shared WHATSAPP_AI_SECRET — without it this would be an open
// relay to the WhatsApp gateway.
const WAHA_URL = (process.env.WAHA_URL || '').replace(/\/+$/, '');
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (!url.pathname.startsWith('/waha/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, worker: WORKER, lease: haveLease, proxy: Boolean(WAHA_URL) }));
    return;
  }

  const secret = process.env.WHATSAPP_AI_SECRET || '';
  if (!secret || req.headers['x-wassel-proxy-secret'] !== secret) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (!WAHA_URL || !WAHA_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'WAHA_URL / WAHA_API_KEY not set on the worker' }));
    return;
  }

  const target = `${WAHA_URL}${url.pathname.slice('/waha'.length)}${url.search}`;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'X-Api-Key': WAHA_API_KEY,
        ...(req.headers['content-type'] ? { 'Content-Type': String(req.headers['content-type']) } : {}),
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    });
    res.end(buf);
  } catch (err) {
    console.error('[wa-agent] proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `proxy failed: ${err instanceof Error ? err.message : String(err)}` }));
  }
}).listen(Number(process.env.PORT || 8080));

// ── singleton lease ─────────────────────────────────────────────────────────
async function renewLease() {
  const { data, error } = await supa.rpc('claude_runner_lease_acquire', {
    p_lease: LEASE, p_owner: WORKER, p_host: process.env.FLY_REGION || 'fly',
    p_pid: process.pid, p_ttl_seconds: 120,
  });
  if (error) { console.error('[wa-agent] lease rpc failed:', error.message); return false; }
  return data === true || data?.acquired === true || (Array.isArray(data) && data[0]?.acquired === true);
}

// ── claude session ──────────────────────────────────────────────────────────
/**
 * Run a Claude session. `resumeId` continues an existing one — that is what
 * makes a follow-up message cheap: the chat, client and call history are
 * already in context, so the turn is short instead of a cold start.
 *
 * JSON output (rather than text) so we get back the session_id to resume next
 * time and the token usage that drives rotation.
 */
function runClaude(prompt, cwd, resumeId = null) {
  return new Promise((resolve) => {
    // Prompt via STDIN so multiline Arabic survives shell quoting.
    const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'json'];
    if (resumeId) args.push('--resume', resumeId);
    const env = { ...process.env };
    // The app's server-side API key is NOT valid for the CLI; if present the CLI
    // prefers it and 401s. Same scrub as the study runner.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    const child = spawn('claude', args, {
      cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env, detached: true,
    });
    currentChild = child;
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      resolve({ code: -1, out, err: err + '\n[wa-agent] session timeout', sessionId: null, tokens: 0 });
    }, SESSION_TIMEOUT_MS);
    child.stdin.write(prompt); child.stdin.end();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer); currentChild = null;
      // --output-format json prints one envelope: { session_id, result, usage, ... }
      let sessionId = null, tokens = 0, text = out;
      try {
        const j = JSON.parse(out.trim());
        sessionId = j.session_id ?? null;
        text = typeof j.result === 'string' ? j.result : out;
        const u = j.usage ?? {};
        // Context GROWTH only. cache_read_input_tokens is the cached prefix
        // re-read on every internal tool call — counting it measured 232k after
        // a SINGLE turn (live 2026-07-27), which would have rotated the session
        // on the very next message and made resume dead code.
        tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      } catch { /* non-JSON (crash / auth error) - keep raw text for diagnosis */ }
      resolve({ code, out: text, err, sessionId, tokens });
    });
    child.on('error', (e) => { clearTimeout(timer); currentChild = null; resolve({ code: -2, out, err: String(e), sessionId: null, tokens: 0 }); });
  });
}

// ── the job ─────────────────────────────────────────────────────────────────
async function handleWhatsappReply(job) {
  const p = job.payload ?? {};
  const chatWid = p.chat_wid;
  if (!chatWid) throw new Error('payload.chat_wid is required');

  // A rep pressing "hand this chat to the AI" is an explicit invitation, so a
  // forced job skips the schedule/human-active gates. Auto-triggered jobs
  // re-check right before spending a session (a human may have replied in the
  // seconds since the webhook enqueued).
  // `forced` covers the takeover-enable click. Ongoing messages in an
  // AI-managed chat come through the normal path, and the gate itself returns
  // 'chat_ai_managed' for those, so the re-check below passes for them too.
  const forced = p.forced === true;
  if (!forced) {
    const { data: gate } = await supa.rpc('whatsapp_ai_should_reply', { p_chat_wid: chatWid });
    const g = Array.isArray(gate) ? gate[0] : gate;
    if (g?.should_reply !== true) return { skipped: true, reason: g?.reason ?? 'blocked' };
  }

  // PRE-FETCH the context the session always needs.
  //
  // Latency is the thing that makes or breaks this on WhatsApp: a customer
  // waiting 3+ minutes reads as broken. Measured live 2026-07-27 — 165s and
  // 324s per reply — and a large slice was the session making three sequential
  // db.mjs round-trips (chat, client, calls), each booting its own node process,
  // before it could start reasoning. Handing it the context up front removes
  // those entirely; the session still has db.mjs for anything extra.
  const ctx = { conversation: [], client: null, calls: [], error: null };
  try {
    const { data: msgs } = await supa
      .from('chat_messages')
      .select('flow, kind, body, media_caption, date')
      .eq('chat_wid', chatWid)
      .order('date', { ascending: false })
      .limit(40);
    ctx.conversation = (msgs ?? []).reverse();

    const { data: chatRec } = await supa
      .from('records').select('data').eq('id', p.chat_record_id ?? '').maybeSingle();
    const clientId = chatRec?.data?.client_link ?? null;
    if (clientId) {
      const { data: cl } = await supa.from('records').select('id, data').eq('id', clientId).maybeSingle();
      if (cl) ctx.client = { id: cl.id, ...cl.data };
    }

    const phone = p.phone ?? ('+' + String(chatWid).split('@')[0]);
    const { data: calls } = await supa
      .from('call_logs')
      .select('direction, status, duration_seconds, agent_name, creation_time, summary')
      .eq('contact_phone', phone)
      .order('creation_time', { ascending: false })
      .limit(5);
    ctx.calls = calls ?? [];
  } catch (err) {
    // Never block the reply on pre-fetch — the session can still query itself.
    ctx.error = err instanceof Error ? err.message : String(err);
    console.error('[wa-agent] context pre-fetch failed:', ctx.error);
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'wa-agent-'));
  const sentinel = path.join(workDir, 'result.json');
  const envJson = path.join(workDir, 'env.json');
  writeFileSync(path.join(workDir, 'context.json'), JSON.stringify(ctx, null, 1));
  // Per-job context for the session's tools (send.mjs reads it via WA_ENV_JSON).
  writeFileSync(envJson, JSON.stringify({
    SUPABASE_URL, SERVICE_KEY, APP_URL, AI_SECRET,
    // save.mjs writes the client record through the Retell agent-tools server
    // (one Arabic→schema mapping layer for both channels), which authenticates
    // with its own secret.
    TOOL_SECRET: process.env.RETELL_WEBHOOK_SECRET ?? '',
    contextFile: path.join(workDir, 'context.json'),
    forced,
    chatWid,
    chatRecordId: p.chat_record_id ?? null, deviceId: p.device_id ?? 'sales', jobId: job.id,
  }));
  process.env.WA_ENV_JSON = envJson;   // inherited by the spawned session

  const prompt = [
    `/whatsapp-reply ${chatWid}`,
    '',
    'You are running HEADLESS on the WhatsApp queue. Nobody can answer questions —',
    'decide everything yourself per the skill. Job context is in:',
    `  ${path.join(workDir, 'env.json')}`,
    '',
    'The conversation, the client record and the recent CALL SUMMARIES are ALREADY',
    'fetched for you here — read this file FIRST and do not re-query them:',
    `  ${path.join(workDir, 'context.json')}`,
    'Speed matters: a customer is waiting. Only query the DB for something this',
    'file does not contain.',
    'When you have sent the reply (or decided not to), write JSON to exactly:',
    `  ${sentinel}`,
    'with keys: "sent" (boolean), "reply" (the Arabic text you sent, or null),',
    '"handoff" (boolean — true if a human should take over), "summary" (one line,',
    'Arabic, for the rep). Writing this file is the LAST thing you do.',
  ].join('\n');

  // Resumed turn: the session already holds the history, the skill and the
  // tools. Repeating them would waste the very tokens we are conserving.
  const resumePrompt = [
    'New message(s) arrived in the same WhatsApp conversation you are already handling.',
    '',
    `Latest: ${String(p.trigger_message || '(see the thread)').slice(0, 500)}`,
    '',
    'Read any new messages from the DB, reply per the same rules, and write the',
    'sentinel JSON to exactly this path when done:',
    `  ${sentinel}`,
    'Same keys as before: sent, reply, handoff, summary.',
  ].join('\n');

  // ---- one living session per conversation --------------------------------
  const { data: sess } = await supa.rpc('whatsapp_ai_session_get', {
    p_chat_wid: chatWid,
    p_max_tokens: Number(process.env.SESSION_MAX_TOKENS || 250000),
  });
  const sRow = Array.isArray(sess) ? sess[0] : sess;
  const resumeId = sRow?.session_id ?? null;
  if (resumeId) console.log(`[wa-agent] resuming ${resumeId} (turn ${(sRow.turns ?? 0) + 1}, ~${sRow.context_tokens} tok)`);
  else console.log(`[wa-agent] new session (${sRow?.reason ?? 'no_session'})`);

  // What changed in the CRM since this session last replied? A resumed session
  // holds a SNAPSHOT — a call logged yesterday, or a rep editing the client, is
  // invisible to it unless we say so. Answering as though a call never happened
  // is precisely the failure this agent already made once.
  let deltaPrompt = resumePrompt;
  if (resumeId && sRow?.last_used_at) {
    const since = sRow.last_used_at;
    const bits = [];
    try {
      const phone = p.phone ?? ('+' + String(chatWid).split('@')[0]);
      const { data: newCalls } = await supa
        .from('call_logs')
        .select('direction, status, duration_seconds, agent_name, creation_time, summary')
        .eq('contact_phone', phone)
        .gt('creation_time', since)
        .order('creation_time', { ascending: false })
        .limit(3);
      if (newCalls?.length) {
        bits.push(
          'NEW CALLS logged since your last reply — read these, they',
          'override anything older, especially any promise in «الخطوات التالية»:',
          JSON.stringify(newCalls, null, 1),
        );
      }

      // Client record edited by a rep (budget corrected, preferences added…).
      const { data: chatRec2 } = await supa
        .from('records').select('data').eq('id', p.chat_record_id ?? '').maybeSingle();
      const cid = chatRec2?.data?.client_link ?? null;
      if (cid) {
        const { data: cl } = await supa
          .from('records').select('data, updated_at').eq('id', cid).gt('updated_at', since).maybeSingle();
        if (cl) bits.push('CLIENT RECORD updated since your last reply:', JSON.stringify(cl.data, null, 1));
      }

      // Messages a HUMAN rep sent by hand while the agent was idle.
      const { data: humanMsgs } = await supa
        .from('chat_messages')
        .select('flow, body, date')
        .eq('chat_wid', chatWid)
        .gt('date', since)
        .order('date', { ascending: true })
        .limit(20);
      if (humanMsgs?.length) {
        bits.push('MESSAGES since your last reply (both directions):', JSON.stringify(humanMsgs, null, 1));
      }
    } catch (e) {
      console.error('[wa-agent] delta build failed:', e);
      bits.push('WARNING: could not load CRM changes — re-check calls and the client record yourself.');
    }
    if (bits.length) deltaPrompt = [resumePrompt, '', '--- WHAT CHANGED SINCE YOUR LAST REPLY ---', ...bits].join('\n');
  }

  let { code, out, err, sessionId, tokens } = await runClaude(
    resumeId ? deltaPrompt : prompt, '/app/repo', resumeId);

  // A resume fails if the CLI dropped that session's state. Cold-start once
  // rather than losing the customer's turn.
  if (resumeId && (code !== 0 || /No conversation found|session.*not found/i.test(err || ''))) {
    console.warn('[wa-agent] resume failed, starting fresh:', (err || '').slice(-200));
    ({ code, out, err, sessionId, tokens } = await runClaude(prompt, '/app/repo', null));
    if (sessionId) await supa.rpc('whatsapp_ai_session_put', {
      p_chat_wid: chatWid, p_session_id: sessionId, p_tokens: tokens, p_is_new: true,
      p_error: 'previous session could not be resumed' });
  } else if (sessionId) {
    await supa.rpc('whatsapp_ai_session_put', {
      p_chat_wid: chatWid, p_session_id: sessionId, p_tokens: tokens, p_is_new: !resumeId });
  }
  if (!existsSync(sentinel)) {
    throw new Error(`session ended (code ${code}) without sentinel: ${(err || out).slice(-500)}`);
  }
  const raw = readFileSync(sentinel, 'utf-8');
  let result;
  try { result = JSON.parse(raw); }
  catch { result = JSON.parse(raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')); }
  return result;
}

// ── loop ────────────────────────────────────────────────────────────────────
async function tick() {
  if (stopping) return;
  haveLease = await renewLease();
  if (!haveLease) return;                       // another machine owns the queue

  const { data: jobs, error } = await supa.rpc('claude_job_claim_next', { p_worker: WORKER });
  if (error) { console.error('[wa-agent] claim failed:', error.message); return; }
  const job = Array.isArray(jobs) ? jobs[0] : jobs;
  if (!job) return;
  if (job.kind !== 'whatsapp_reply') {
    // Not ours (the study runner owns the other kinds) — hand it straight back.
    await supa.rpc('claude_job_interrupt', { p_job_id: job.id, p_owner: WORKER }).catch(() => {});
    return;
  }

  console.log(`[wa-agent] claimed job=${job.id} chat=${job.payload?.chat_wid}`);
  try {
    const result = await handleWhatsappReply(job);
    await supa.rpc('claude_job_complete', { p_job_id: job.id, p_result: result });
    console.log(`[wa-agent] job=${job.id} done:`, JSON.stringify(result).slice(0, 200));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[wa-agent] job=${job.id} FAILED:`, msg);
    await supa.rpc('claude_job_fail', { p_job_id: job.id, p_error: msg.slice(0, 1000) });
  }
}

/**
 * Requeue jobs this machine was running when it died.
 *
 * `claude_jobs_recover_orphaned` deliberately skips jobs whose `claimed_by`
 * matches the caller — another lane's live work is not an orphan. But WORKER is
 * derived from FLY_MACHINE_ID, which SURVIVES a restart, so a job killed by a
 * deploy was claimed by the same id the new process reports: the sweep never
 * touched it and it sat in 'running' forever. That also wedged the chat, since
 * `whatsapp_ai_enqueue` debounces on any pending/running job for it — one
 * deploy at the wrong moment and that customer could never get an AI reply
 * again (live 2026-07-27).
 *
 * At boot we hold nothing by definition, so anything still 'running' under our
 * own id is abandoned and safe to reclaim.
 */
const MAX_JOB_ATTEMPTS = 3;
async function recoverOwnStaleJobs() {
  const { data, error } = await supa
    .from('claude_jobs')
    .select('id, attempts, payload')
    .eq('status', 'running')
    .eq('claimed_by', WORKER);
  if (error) { console.error('[wa-agent] stale-job scan failed:', error.message); return; }
  for (const job of data ?? []) {
    const retry = (job.attempts ?? 0) < MAX_JOB_ATTEMPTS;
    const patch = retry
      ? { status: 'pending', claimed_by: null, started_at: null,
          error: `recovered: ${WORKER} restarted mid-job (attempt ${job.attempts ?? 0})` }
      : { status: 'failed', finished_at: new Date().toISOString(),
          error: `recovered: ${WORKER} restarted mid-job ${job.attempts ?? 0} times — not retried` };
    const { error: upErr } = await supa.from('claude_jobs').update(patch).eq('id', job.id).eq('status', 'running');
    if (upErr) console.error(`[wa-agent] could not recover job=${job.id}:`, upErr.message);
    else console.warn(`[wa-agent] ${retry ? 'requeued' : 'failed'} stale job=${job.id} chat=${job.payload?.chat_wid ?? '?'}`);
  }
}

async function main() {
  console.log(`[wa-agent] started worker=${WORKER} poll=${POLL_MS}ms`);
  await recoverOwnStaleJobs().catch((e) => console.error('[wa-agent] recovery threw:', e));
  for (;;) {
    if (stopping) break;
    try { await tick(); } catch (e) { console.error('[wa-agent] tick error:', e); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log('[wa-agent] stopped');
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[wa-agent] ${sig} — finishing in-flight job then exiting`);
    stopping = true;
    if (currentChild) { try { process.kill(-currentChild.pid, 'SIGTERM'); } catch {} }
  });
}

main();
