#!/usr/bin/env node
/**
 * Send ONE of our projects to the customer using the FULL rep flow —
 * marketing MESSAGE + project BROCHURE + top PHOTOS — in one call.
 *   node tools/project-flow.mjs "<project name or all_projects id>"
 *
 * Posts to /api/whatsapp/ai-send-project, which resolves the message the same
 * way the reps do (saved message → fact-checked → fresh AI → deterministic
 * sheet), attaches one brochure + the top 3 photos, and ENQUEUES text → PDF →
 * pictures into the send queue (a worker delivers seconds-to-minutes later). It
 * re-checks the reply gate before sending, so if a human took over it sends
 * nothing.
 *
 * This is the RICH sibling of project.mjs (which sends only the plain text
 * sheet). Use it when a customer asks for a named project and you want to send
 * the whole package the way a rep would.
 *
 * Output JSON: { queued, message_source, project_id, media_queued, media_failed }
 *            | { queued:false, blocked:true, reason } | { queued:false, error }
 *
 * Exit codes: 0 queued · 3 blocked (human took over) · 4 not found · 1 error.
 */
import { readFileSync } from 'node:fs';

const arg = process.argv.slice(2).join(' ').trim();
if (!arg) { console.error('usage: project-flow.mjs "<project name or id>"'); process.exit(2); }

const envPath = process.env.WA_ENV_JSON;
if (!envPath) { console.error('WA_ENV_JSON not set'); process.exit(2); }
const cfg = JSON.parse(readFileSync(envPath, 'utf-8'));

// A UUID arg is an id; anything else is a name to resolve server-side.
const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
const payload = {
  chat_wid: cfg.chatWid,
  device_id: cfg.deviceId,
  job_id: cfg.jobId,
  // Manual handover: the rep invited the AI in, so the gate must not veto it.
  force: cfg.forced === true,
  ...(isUuid ? { project_id: arg } : { project_name: arg }),
};

const res = await fetch(`${cfg.APP_URL}/api/whatsapp/ai-send-project`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-wassel-ai-secret': cfg.AI_SECRET },
  body: JSON.stringify(payload),
});
const out = await res.json().catch(() => ({}));
console.log(JSON.stringify(out));

if (out.blocked) { console.error(`BLOCKED (${out.reason}) — a human is handling this chat. Send nothing more.`); process.exit(3); }
if (typeof out.error === 'string' && /not found|matched several/.test(out.error)) {
  console.error(`no single project matched "${arg}" — pass a more specific name or the id`); process.exit(4);
}
if (!res.ok || out.queued !== true) { console.error(`ai-send-project failed: ${out.error ?? res.status}`); process.exit(1); }
process.exit(0);
