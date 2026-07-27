#!/usr/bin/env node
/**
 * Write what the conversation taught us back onto the CLIENT record.
 *
 *   node tools/save.mjs '{"client_name":"تركي","budget_max":2500000,
 *                         "unit_types":["فيلا"],"districts":["المهدية"],
 *                         "notes":"يحتاج تمويل بنكي — راتب 25 ألف"}'
 *
 * Reuses the Retell agent's tool server (api/retell/agent-tools) rather than a
 * second implementation: it already maps spoken Arabic to the schema's dropdown
 * option values at runtime, merges ranges instead of overwriting them, and
 * writes with optimistic concurrency. One mapping layer, one place to fix.
 *
 * Resolves the client from the chat's phone, so no id juggling in the session.
 *
 * Exit codes: 0 saved · 1 error.
 */
import { readFileSync } from 'node:fs';

const raw = process.argv.slice(2).join(' ').trim();
if (!raw) { console.error('usage: save.mjs \'{"budget_max":1500000,...}\''); process.exit(2); }

let args;
try { args = JSON.parse(raw); }
catch (e) { console.error('argument must be JSON:', e.message); process.exit(2); }

const envPath = process.env.WA_ENV_JSON;
if (!envPath) { console.error('WA_ENV_JSON not set'); process.exit(2); }
const cfg = JSON.parse(readFileSync(envPath, 'utf-8'));

// The tool server identifies the client from the call/chat context; give it the
// customer's phone in the shape it expects for an outbound leg.
const phone = '+' + String(cfg.chatWid).split('@')[0];

const res = await fetch(`${cfg.APP_URL}/api/retell/agent-tools`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'x-wassel-tool-secret': cfg.TOOL_SECRET ?? cfg.AI_SECRET,
  },
  body: JSON.stringify({
    name: 'save_client_info',
    args,
    call: { direction: 'outbound', to_number: phone, metadata: { source: 'whatsapp_agent' } },
  }),
});
const out = await res.json().catch(() => ({}));
console.log(JSON.stringify(out, null, 1));
if (!res.ok || out['خطأ'] || out.error) { console.error('save failed'); process.exit(1); }
process.exit(0);
