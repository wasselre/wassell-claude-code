#!/usr/bin/env node
/**
 * Resolve a location a customer shared → the real district name.
 *
 *   node tools/where.mjs "https://maps.app.goo.gl/JL2qYMNE6f2bsm7Z6"
 *
 * Exists because the agent guessed. On 2026-07-27 a customer sent a Maps pin and
 * the agent asked "is this near حطين?" — inferred purely from the project it had
 * just recommended, with nothing behind it. The customer's reply («بناء على شي
 * قلت انه قريب من حطين؟») was the correct challenge.
 *
 * Two hops, both already in the app:
 *   1. /api/resolve-maps-url follows the short-link redirect → lat/lng
 *   2. districts_for_points (PostGIS) → the containing district polygon
 *
 * Prints JSON. `district: null` means the pin is outside every known boundary —
 * say so plainly rather than naming a district anyway.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const input = process.argv.slice(2).join(' ').trim();
if (!input) { console.error('usage: where.mjs "<maps url or \'lat,lng\'>"'); process.exit(2); }

const envPath = process.env.WA_ENV_JSON;
if (!envPath) { console.error('WA_ENV_JSON not set'); process.exit(2); }
const cfg = JSON.parse(readFileSync(envPath, 'utf-8'));

let lat = null, lng = null, finalUrl = null;

const pair = input.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
if (pair) {
  lat = Number(pair[1]); lng = Number(pair[2]);
} else {
  const res = await fetch(`${cfg.APP_URL}/api/resolve-maps-url?url=${encodeURIComponent(input)}`);
  const body = await res.json().catch(() => ({}));
  lat = body.lat; lng = body.lng; finalUrl = body.finalUrl ?? null;
  if (lat == null || lng == null) {
    console.log(JSON.stringify({
      resolved: false,
      reason: body.error ?? 'could not extract coordinates from that link',
      hint: 'لا تخمّن الحي — اسأل العميل عن اسم الحي مباشرة',
    }, null, 1));
    process.exit(0);
  }
}

const supa = createClient(cfg.SUPABASE_URL, cfg.SERVICE_KEY, { auth: { persistSession: false } });
const { data, error } = await supa.rpc('districts_for_points', {
  p_points: [{ id: 'pin', lat, lng }],
});
if (error) { console.error('districts_for_points failed:', error.message); process.exit(1); }

const hit = Array.isArray(data) ? data[0] : null;
let district = null, city = null;
if (hit?.district_record_id) {
  const { data: rec } = await supa
    .from('unified_records').select('data').eq('id', hit.district_record_id).maybeSingle();
  const d = rec?.data ?? {};
  district = d.display_name ?? d.name_ar ?? null;
  if (d.city_lookup) {
    const { data: c } = await supa
      .from('unified_records').select('data').eq('id', d.city_lookup).maybeSingle();
    city = c?.data?.display_name ?? c?.data?.name_ar ?? null;
  }
}

console.log(JSON.stringify({
  resolved: true,
  lat, lng, finalUrl,
  district,
  city,
  hint: district
    ? 'اذكر اسم الحي كما هو — هذه معلومة مؤكدة من الإحداثيات'
    : 'الإحداثيات خارج حدود الأحياء المعروفة — قل ذلك بصراحة ولا تسمِّ حياً',
}, null, 1));
