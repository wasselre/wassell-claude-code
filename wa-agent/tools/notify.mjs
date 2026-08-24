#!/usr/bin/env node
/**
 * Post an operator-facing notification to the Tasks → "AI notifications" tab.
 *   node tools/notify.mjs "<body>" [severity]
 *   severity: info (default) | action | warning
 *
 * Use it when you hand a chat off to a human or want someone's attention —
 * a one-line summary of what happened and what the human should do. It is the
 * in-app twin of setting handoff:true in the sentinel.
 *
 * Posts to /api/whatsapp/ai-notify (shared-secret auth); links the notification
 * to the current chat automatically.
 *
 * Exit codes: 0 posted · 1 error.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const body = (args[0] ?? '').trim();
const severity = ['info', 'action', 'warning'].includes(args[1]) ? args[1] : 'info';
if (!body) { console.error('usage: notify.mjs "<body>" [info|action|warning]'); process.exit(2); }

const envPath = process.env.WA_ENV_JSON;
if (!envPath) { console.error('WA_ENV_JSON not set'); process.exit(2); }
const cfg = JSON.parse(readFileSync(envPath, 'utf-8'));

const res = await fetch(`${cfg.APP_URL}/api/whatsapp/ai-notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-wassel-ai-secret': cfg.AI_SECRET },
  body: JSON.stringify({
    body,
    severity,
    source: 'whatsapp',
    chat_wid: cfg.chatWid,
    chat_record_id: cfg.chatRecordId ?? null,
  }),
});
const out = await res.json().catch(() => ({}));
console.log(JSON.stringify(out));
if (!res.ok || !out.ok) { console.error(`notify failed: ${out.error ?? res.status}`); process.exit(1); }
process.exit(0);
