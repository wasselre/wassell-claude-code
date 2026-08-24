#!/usr/bin/env node
/**
 * Build the DETERMINISTIC project WhatsApp sheet for ONE of our projects.
 *   node tools/project.mjs "<project name or all_projects id>"
 *
 * Posts to /api/templates/project-message, which reuses the app's canonical
 * composer (available-only prices, exact house labels) — no AI, no hand-
 * formatting. Prints the JSON result; the session sends `body_ar` via send.mjs.
 *
 * Output JSON: { ok, project_id, body_ar, body_en, facts, missing }
 *            | { not_found } | { ambiguous, matches } | { error }
 *
 * Exit codes: 0 built · 4 not found / ambiguous · 1 error.
 */
import { readFileSync } from 'node:fs';

const arg = process.argv.slice(2).join(' ').trim();
if (!arg) { console.error('usage: project.mjs "<project name or id>"'); process.exit(2); }

const envPath = process.env.WA_ENV_JSON;
if (!envPath) { console.error('WA_ENV_JSON not set'); process.exit(2); }
const cfg = JSON.parse(readFileSync(envPath, 'utf-8'));

// A UUID arg is an id; anything else is a name to resolve server-side.
const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
const payload = isUuid ? { project_id: arg } : { project_name: arg };

const res = await fetch(`${cfg.APP_URL}/api/templates/project-message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-wassel-ai-secret': cfg.AI_SECRET },
  body: JSON.stringify(payload),
});
const out = await res.json().catch(() => ({}));
console.log(JSON.stringify(out));

if (out.not_found) { console.error(`no project matched "${arg}"`); process.exit(4); }
if (out.ambiguous) { console.error(`"${arg}" matched several projects — pass a more specific name or the id`); process.exit(4); }
if (!res.ok || !out.ok) { console.error(`project-message failed: ${out.error ?? res.status}`); process.exit(1); }
process.exit(0);
