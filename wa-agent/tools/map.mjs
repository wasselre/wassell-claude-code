#!/usr/bin/env node
/**
 * Draw the district(s) the customer named on a map and SEND it for confirmation.
 *
 *   node tools/map.mjs "النرجس"            # by name
 *   node tools/map.mjs "النرجس" "الياسمين" # several
 *   node tools/map.mjs --from-client        # whatever is saved in location_items
 *
 * Why: "شمال الرياض" means different things to different people, and a wrong
 * area wastes the whole search. A picture settles it in one message before any
 * project is quoted.
 *
 * Renders via Google Static Maps (outline + fill in Wassel copper), re-hosts the
 * PNG in the public marketing-assets bucket, and sends it as a WhatsApp image
 * with a caption asking the customer to confirm. The Maps key never leaves the
 * server: WhatsApp receives our storage URL, not the Google one.
 *
 * Prints JSON: { sent, districts:[…], unresolved:[…] }.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
if (args.length === 0) { console.error('usage: map.mjs "<district>" [more…] | --from-client'); process.exit(2); }

const envPath = process.env.WA_ENV_JSON;
if (!envPath) { console.error('WA_ENV_JSON not set'); process.exit(2); }
const cfg = JSON.parse(readFileSync(envPath, 'utf-8'));
const supa = createClient(cfg.SUPABASE_URL, cfg.SERVICE_KEY, { auth: { persistSession: false } });

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || cfg.MAPS_KEY || '';
if (!MAPS_KEY) {
  console.log(JSON.stringify({ sent: false, reason: 'GOOGLE_MAPS_API_KEY not set on the worker' }));
  process.exit(0);
}

// ── which districts? ────────────────────────────────────────────────────────
const norm = (s) => String(s || '').trim().toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ');

let wanted = [];
if (args[0] === '--from-client') {
  const { data: chat } = await supa.from('records').select('data').eq('id', cfg.chatRecordId).maybeSingle();
  const clientId = chat?.data?.client_link;
  if (!clientId) { console.log(JSON.stringify({ sent: false, reason: 'chat has no linked client' })); process.exit(0); }
  const { data: client } = await supa.from('records').select('data').eq('id', clientId).maybeSingle();
  const items = Array.isArray(client?.data?.location_items) ? client.data.location_items : [];
  wanted = items
    .filter((i) => i?.kind === 'district' && i?.polarity !== 'exclude' && i.district_id)
    .map((i) => ({ id: i.district_id, label: i.district_label }));
  if (wanted.length === 0) {
    console.log(JSON.stringify({ sent: false, reason: 'no districts saved on the client yet — ask first' }));
    process.exit(0);
  }
} else {
  // Resolve names → district records (Riyadh only; the agent works Riyadh).
  const { data: rows } = await supa.rpc('claude_runner_sql', {
    p_sql: `SELECT r.id, COALESCE(r.data->>'display_name', r.data->>'name_ar') AS nm
              FROM unified_records r
             WHERE r.model_id = (SELECT id FROM models WHERE name='districts')`,
  });
  const all = Array.isArray(rows) ? rows : [];
  for (const a of args) {
    const t = norm(a);
    const hit = all.find((r) => norm(r.nm) === t) || all.find((r) => norm(r.nm).includes(t) && t.length > 2);
    if (hit) wanted.push({ id: hit.id, label: hit.nm });
    else wanted.push({ id: null, label: a });
  }
}

const unresolved = wanted.filter((w) => !w.id).map((w) => w.label);
const resolved = wanted.filter((w) => w.id);
if (resolved.length === 0) {
  console.log(JSON.stringify({ sent: false, unresolved, reason: 'could not match any district by name' }));
  process.exit(0);
}

// ── outlines → static map URL ───────────────────────────────────────────────
const paths = [];
const names = [];
let cLat = 0, cLng = 0, n = 0;
for (const d of resolved) {
  const { data, error } = await supa.rpc('district_outline', { p_district_id: d.id, p_max_points: 40 });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.points) continue;
  names.push(row.name_ar ?? d.label);
  cLat += row.center_lat; cLng += row.center_lng; n += 1;
  const pts = row.points.map(([lat, lng]) => `${lat},${lng}`).join('|');
  // Copper outline + translucent fill = the app's own map styling.
  paths.push(`path=color:0xB8734Fff|weight:3|fillcolor:0xB8734F55|${pts}`);
}
if (paths.length === 0) {
  console.log(JSON.stringify({ sent: false, unresolved, reason: 'no boundary polygons available for those districts' }));
  process.exit(0);
}

const url =
  `https://maps.googleapis.com/maps/api/staticmap?size=640x640&scale=2&maptype=roadmap&language=ar` +
  `&center=${(cLat / n).toFixed(5)},${(cLng / n).toFixed(5)}` +
  `&${paths.join('&')}&key=${MAPS_KEY}`;

const img = await fetch(url);
if (!img.ok) {
  console.log(JSON.stringify({ sent: false, reason: `static map failed: ${img.status} ${await img.text().catch(() => '')}`.slice(0, 200) }));
  process.exit(0);
}
const bytes = Buffer.from(await img.arrayBuffer());

// Re-host: WhatsApp fetches OUR url, so the Maps key stays server-side.
const objectPath = `wa-agent-maps/${cfg.jobId ?? Date.now()}.png`;
const { error: upErr } = await supa.storage.from('marketing-assets')
  .upload(objectPath, bytes, { contentType: 'image/png', upsert: true });
if (upErr) { console.error('upload failed:', upErr.message); process.exit(1); }
const { data: pub } = supa.storage.from('marketing-assets').getPublicUrl(objectPath);

// ── send as an image with a confirmation caption ────────────────────────────
const caption = names.length === 1
  ? `هذي المنطقة اللي تقصدها؟ (${names[0]})`
  : `هذي المناطق اللي تقصدها؟ (${names.join('، ')})`;

const { data: jobId, error: qErr } = await supa.rpc('scheduled_whatsapp_enqueue', {
  p_device_id: cfg.deviceId ?? 'sales',
  p_chat_wid: cfg.chatWid,
  p_phone: '+' + String(cfg.chatWid).split('@')[0],
  p_body: caption,
  p_media: [{ url: pub.publicUrl }],
  p_reference: `ai-map:${cfg.jobId ?? 'manual'}:${Date.now()}`,
  p_deliver_at: new Date().toISOString(),
  p_user_id: null,
});
if (qErr) { console.error('enqueue failed:', qErr.message); process.exit(1); }

// Audit as an AI message so the gate doesn't read it as a human takeover.
await supa.from('whatsapp_ai_replies').insert({
  message_wid: `sched:${String(jobId)}`, chat_wid: cfg.chatWid,
  job_id: cfg.jobId ?? null, body: caption,
});

console.log(JSON.stringify({ sent: true, districts: names, unresolved, caption }, null, 1));
