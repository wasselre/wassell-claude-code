#!/usr/bin/env node
/**
 * Send ONE WhatsApp message as the AI agent.
 *   node tools/send.mjs "<arabic text>"
 *
 * Posts to /api/whatsapp/ai-send, which re-checks the gate immediately before
 * sending (a human may have replied while the session was thinking), sends via
 * the WhatsApp gateway, and records the message in whatsapp_ai_replies.
 *
 * Exit codes: 0 sent · 3 blocked (human took over / disabled) · 1 error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const text = process.argv.slice(2).join(' ').trim();
if (!text) { console.error('usage: send.mjs "<message>"'); process.exit(2); }

// env.json is written per-job by the runner next to the session's work dir; its
// path comes in via WA_ENV_JSON so the session never has to guess.
const envPath = process.env.WA_ENV_JSON;
if (!envPath) { console.error('WA_ENV_JSON not set'); process.exit(2); }
const cfg = JSON.parse(readFileSync(envPath, 'utf-8'));

const res = await fetch(`${cfg.APP_URL}/api/whatsapp/ai-send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-wassel-ai-secret': cfg.AI_SECRET },
  body: JSON.stringify({
    chat_wid: cfg.chatWid, body: text, device_id: cfg.deviceId, job_id: cfg.jobId,
    // Manual handover: the rep invited the AI in, so the schedule/human-active
    // gates must not veto the send they asked for.
    force: cfg.forced === true,
  }),
});
const out = await res.json().catch(() => ({}));
console.log(JSON.stringify(out));
if (out.blocked) { console.error(`BLOCKED (${out.reason}) — a human is handling this chat. Send nothing more.`); process.exit(3); }
if (!res.ok || !out.sent) { console.error(`send failed: ${out.error ?? res.status}`); process.exit(1); }
process.exit(0);
