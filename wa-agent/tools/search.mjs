#!/usr/bin/env node
/**
 * Search OUR PROJECTS for this client, using the real matching engine.
 *
 *   node tools/search.mjs
 *
 * Takes no criteria: it runs against the client's SAVED preferences, so the
 * agent must have written them with save.mjs first. That is deliberate — the
 * record is what a human rep would see, and searching off something other than
 * the record makes the two disagree.
 *
 * Scope is our_projects ONLY. Market listings are out of scope for the agent by
 * explicit decision (2026-07-27): if our portfolio has nothing, a HUMAN searches
 * the market — the agent must not quote a listing it can't vouch for. So when
 * the result is empty this escalates instead of widening.
 *
 * Prints JSON: { found:[…] } or { found: [], escalated: true }.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const envPath = process.env.WA_ENV_JSON;
if (!envPath) { console.error('WA_ENV_JSON not set'); process.exit(2); }
const cfg = JSON.parse(readFileSync(envPath, 'utf-8'));
const supa = createClient(cfg.SUPABASE_URL, cfg.SERVICE_KEY, { auth: { persistSession: false } });

// Client behind this chat.
const { data: chat } = await supa.from('records').select('data').eq('id', cfg.chatRecordId).maybeSingle();
const clientId = chat?.data?.client_link;
if (!clientId) { console.log(JSON.stringify({ found: [], reason: 'chat has no linked client — create one first' })); process.exit(0); }

const { data: client } = await supa.from('records').select('data').eq('id', clientId).maybeSingle();
const d = client?.data ?? {};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v != null && Number.isFinite(Number(v)) ? Number(v) : undefined));
const rng = (v) => (v && typeof v === 'object' ? { min: num(v.min), max: num(v.max) } : {});

const budget = rng(d.budget), beds = rng(d.preferred_bedrooms), area = rng(d.preferred_area);
const districts = (Array.isArray(d.location_items) ? d.location_items : [])
  .filter((i) => i?.kind === 'district' && i?.polarity !== 'exclude')
  .map((i) => i.district_label).filter(Boolean);
const unitTypes = Array.isArray(d.preferred_unit_type) ? d.preferred_unit_type : [];

// What is still missing? The agent should ask rather than search half-blind.
const missing = [];
if (!unitTypes.length) missing.push('نوع الوحدة');
if (districts.length === 0) missing.push('الحي');
if (budget.max == null) missing.push('السعر');
if (missing.length) {
  console.log(JSON.stringify({ found: [], incomplete: true, missing,
    hint: 'اسأل العميل عن الناقص قبل البحث — لا تبحث بمعلومات ناقصة' }, null, 1));
  process.exit(0);
}

// The engine, restricted to our portfolio.
const res = await fetch(`${cfg.APP_URL}/api/retell/agent-tools`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-wassel-tool-secret': cfg.TOOL_SECRET ?? cfg.AI_SECRET },
  body: JSON.stringify({
    name: 'find_matching_projects',
    args: {
      city: 'الرياض',
      districts,
      property_type: unitTypes[0],
      budget_min: budget.min, budget_max: budget.max,
      bedrooms: beds.min, area_min: area.min, area_max: area.max,
      sources: ['our_projects'],
    },
    call: { direction: 'outbound', to_number: '+' + String(cfg.chatWid).split('@')[0],
            metadata: { client_record_id: clientId, source: 'whatsapp_agent' } },
  }),
});
const out = await res.json().catch(() => ({}));
const found = Array.isArray(out['نتائج']) ? out['نتائج'] : [];

if (found.length > 0) {
  console.log(JSON.stringify({ found, note: out['تنبيه'] ?? null }, null, 1));
  process.exit(0);
}

// ── nothing in our portfolio → hand to a human, do NOT widen ────────────────
const stamp = new Date().toISOString().slice(0, 10);
const summary =
  `لا يوجد مشروع مطابق من مشاريعنا للعميل — ${unitTypes.join('، ')} في ${districts.join('، ')} ` +
  `بحدود ${budget.max?.toLocaleString('en-US')} ريال. يحتاج بحث في السوق من الفريق.`;

const { data: fu } = await supa.from('models').select('id').eq('name', 'followups').maybeSingle();
if (fu?.id) {
  const due = new Date(); due.setUTCHours(due.getUTCHours() + 2);
  await supa.rpc('record_save', {
    p_model_id: fu.id,
    p_id: crypto.randomUUID(),
    p_data: {
      client_id: clientId,
      followup_type: ['appointment_booking_call'],
      followup_status: 'open',
      scheduled_datetime: due.toISOString(),
      notes: `[المساعد الذكي ${stamp}] ${summary}`,
    },
  });
}

console.log(JSON.stringify({
  found: [], escalated: true, summary,
  hint: 'قل للعميل إنك ما لقيت شي مناسب حالياً ضمن مشاريعنا وإن الفريق بيبحث له ويرد عليه — ' +
        'لا تعرض أي عقار من خارج مشاريعنا ولا تخترع خيارات.',
}, null, 1));
