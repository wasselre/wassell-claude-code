#!/usr/bin/env node
/**
 * eval-project-message-ai.mjs — Kimi vs Anthropic bake-off for the project
 * WhatsApp AI-rewrite (see docs/prd/chats.md + the approved plan).
 *
 * OFFLINE, THROWAWAY harness — NOT shipped to prod. It reads a few real
 * all_projects records (service role), builds the SAME prompt the endpoint
 * `api/templates/project-message-ai.ts` uses, and calls BOTH providers 10× per
 * project so we can pick the production provider on evidence, not vibes.
 *
 *   node scripts/eval-project-message-ai.mjs [--projects=3] [--runs=10]
 *
 * ENV (auto-loaded from .env.local / .env at repo root, and ~/.kimi.env.local):
 *   SUPABASE_URL (or VITE_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY   — DB read
 *   ANTHROPIC_API_KEY                                                 — Claude
 *   KIMI_API_KEY (+ KIMI_MODEL, default kimi-k3)                      — Moonshot
 *
 * Output: a markdown report under scratchpad/ with every run's ar/en body,
 * latency, and guard flags, plus a per-provider summary.
 *
 * The SYSTEM_PROMPT + buildUserContent below are the source of truth the
 * endpoint copies — keep them identical (same posture as the worker copies).
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

// ── tiny zero-dep .env loader (mirrors sync-model-workflow-prds.mjs) ────────
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  let txt;
  try { txt = readFileSync(p, 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(join(ROOT, '.env.local'));
loadEnvFile(join(ROOT, '.env'));
loadEnvFile(join(os.homedir(), '.kimi.env.local')); // KIMI_API_KEY / KIMI_MODEL

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);
const N_PROJECTS = Number(ARGS.projects ?? 3);
const N_RUNS = Number(ARGS.runs ?? 10);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k3';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic';
const ANTHROPIC_MODEL = process.env.PROJECT_MESSAGE_AI_ANTHROPIC_MODEL || 'claude-opus-4-7';

function die(msg) { console.error(`\n[eval] ${msg}\n`); process.exit(1); }
if (!SUPABASE_URL || !SERVICE_KEY) die('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (run scripts/bootstrap-session.sh).');
if (!ANTHROPIC_API_KEY) die('ANTHROPIC_API_KEY required.');
if (!KIMI_API_KEY) die('KIMI_API_KEY required (lives in ~/.kimi.env.local).');

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ─────────────────────────────────────────────────────────────────────────
// SHARED PROMPT — the endpoint copies this verbatim. Keep in sync.
// ─────────────────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `You are a real-estate marketing copywriter for Wassel Real Estate (وصل العقارية), a Saudi company. You write a short, attractive WhatsApp message that markets ONE of the company's OWN projects to a potential buyer.

You are given the project's FULL RECORD as JSON (every stored field) plus an AUTHORITATIVE FACTS block that has already resolved the trustworthy values (place names, available-unit price/area ranges, bedrooms/bathrooms, unit types, the public link). Write the message by calling \`write_project_message\`.

ABSOLUTE RULES — never violate:
1. Write BOTH languages: body_ar (Arabic, primary) and body_en (a faithful English equivalent of the same message).
2. WRITE ATTRACTIVE MARKETING COPY — but INVENT NO SPECIFIC FACT. You have freedom: a warm promotional intro, lifestyle appeal, the desirability of the area, tasteful adjectives and emojis. You may NOT state any specific price, number, size, count, distance, developer, completion date, landmark, or any place name beyond the city/district you are given, unless it appears in the supplied data. General appeal is welcome; specific unverified claims are forbidden.
3. PRICES: quote ONLY the "available" price/area ranges from the AUTHORITATIVE FACTS block (they cover units a customer can actually buy). NEVER quote a price that is not in that block. If no available price is given, omit price entirely (a sold-out project shows no price rather than a stale one). Currency is the Saudi Riyal — «ر.س» in Arabic, "SAR" in English.
4. GEOGRAPHY IS AUTHORITATIVE — NEVER INVENT IT. The facts carry district_ar/district_en and city_ar/city_en. Copy the _ar values VERBATIM into body_ar and the _en values VERBATIM into body_en — do not transliterate, translate, abbreviate, or "correct" them. If a value is null, omit that place; never guess it and never substitute the other language's value.
5. SHAPE: open with the project name, then a short warm marketing intro (a line or two about the project's general appeal), then the concrete facts each on its own short line (city, district, unit types, bedrooms, area in m², bathrooms, "prices start from"), and end with the link. Keep the whole message WhatsApp-length — scannable — with a few tasteful emojis.
6. Give body_en a clean English form of the project name (e.g. «صفا 52» → "Safa 52"); never leave the Arabic project name sitting in the English body.
7. END after the link. NO closing call-to-action, NO "للتواصل والاستفسار", NO contact line, NO agency name/sign-off (never «وصل العقارية» / «Wassel»). Nothing after the link. NEVER write prose outside the tool; ALWAYS call write_project_message.`;

export const TOOL_SCHEMA = {
  name: 'write_project_message',
  description: 'Return the bilingual WhatsApp marketing message for the project.',
  input_schema: {
    type: 'object',
    properties: {
      body_ar: { type: 'string', description: 'The Arabic WhatsApp message (primary).' },
      body_en: { type: 'string', description: 'A faithful English equivalent of the same message.' },
    },
    required: ['body_ar', 'body_en'],
  },
};

/** Build the user turn: the full record + the authoritative facts block. */
export function buildUserContent(recordData, facts) {
  return `PROJECT RECORD (full JSON — every stored field; treat unfamiliar keys as context, do not quote raw slugs):
${JSON.stringify(recordData, null, 2)}

AUTHORITATIVE FACTS (already resolved — trust these over the raw record for names/prices):
${JSON.stringify(facts, null, 2)}`;
}

// ── helpers (mirrors projectMessageFacts.ts semantics, inlined for the .mjs) ──
const asString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) { const n = Number(v.trim()); return Number.isFinite(n) ? n : null; }
  return null;
};
const oneId = (v) => (Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : (typeof v === 'string' && v ? v : null));

function fieldsOf(model) {
  return (model?.schema?.sections ?? []).flatMap((s) => s.fields ?? []);
}
function slugByRollupKind(model, kind) {
  return fieldsOf(model).find((f) => f.is_rollup && f.rollup_kind === kind)?.name ?? null;
}
function slugByCandidates(model, cands) {
  const fs = fieldsOf(model);
  for (const c of cands) if (fs.some((f) => f.name === c)) return c;
  return null;
}
/** Simplified localized-geo resolver (the endpoint uses src resolveLocalizedName). */
function resolveGeo(rec) {
  if (!rec) return null;
  const d = rec.data ?? {};
  const ar = asString(d.display_name) ?? asString(d.name_ar);
  const en = asString(d.name_en) ?? asString(d.name_en_display);
  if (!ar && !en) return null;
  return { ar: ar ?? en, en: en ?? ar };
}
function formatPrice(n) {
  const g = Math.round(n).toLocaleString('en-US');
  return { ar: `${g} ر.س`, en: `SAR ${g}` };
}

async function main() {
  console.log(`[eval] loading models…`);
  const { data: models, error: mErr } = await db.from('models').select('id, name, schema');
  if (mErr) die(`models load failed: ${mErr.message}`);
  const byName = (n) => models.find((m) => m.name === n);
  const allProjects = byName('all_projects');
  if (!allProjects) die('all_projects model not found');
  const citiesM = byName('cities');
  const districtsM = byName('districts');

  // Pull all_projects records (frozen-safe via unified_records) with rich data.
  const { data: rows, error: rErr } = await db
    .from('unified_records')
    .select('id, data')
    .eq('model_id', allProjects.id)
    .limit(400);
  if (rErr) die(`records load failed: ${rErr.message}`);

  const availPriceSlug = slugByRollupKind(allProjects, 'available_price_range');
  const availAreaSlug = slugByRollupKind(allProjects, 'available_area_range');
  const bedSlug = slugByRollupKind(allProjects, 'bedroom_range');
  const bathSlug = slugByRollupKind(allProjects, 'bathroom_range');
  const utSlug = slugByCandidates(allProjects, ['unit_types', 'unit_type']);

  // Prefer projects that actually have an available price + a name + geography.
  const scored = (rows ?? [])
    .map((r) => {
      const d = r.data ?? {};
      const loc = d.location && typeof d.location === 'object' && !Array.isArray(d.location) ? d.location : {};
      const price = availPriceSlug ? d[availPriceSlug] : null;
      const hasPrice = price && typeof price === 'object' && asNum(price.min) != null;
      const score = (asString(d.project_name) ? 1 : 0) + (oneId(loc.city) ? 1 : 0) + (oneId(loc.district) ? 1 : 0) + (hasPrice ? 2 : 0);
      return { r, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score);

  const sample = scored.slice(0, N_PROJECTS).map((x) => x.r);
  if (sample.length === 0) die('no all_projects records with enough data found');

  // Pre-load the geo records we need.
  const geoIds = new Set();
  for (const r of sample) {
    const loc = r.data?.location ?? {};
    if (oneId(loc.city)) geoIds.add(oneId(loc.city));
    if (oneId(loc.district)) geoIds.add(oneId(loc.district));
  }
  const geoById = new Map();
  if (geoIds.size) {
    const { data: geo } = await db.from('unified_records').select('id, data').in('id', [...geoIds]);
    for (const g of geo ?? []) geoById.set(g.id, g);
  }

  function buildFacts(rec) {
    const d = rec.data ?? {};
    const loc = d.location && typeof d.location === 'object' && !Array.isArray(d.location) ? d.location : {};
    const cityGeo = resolveGeo(geoById.get(oneId(loc.city)));
    const distGeo = resolveGeo(geoById.get(oneId(loc.district)));
    const priceRange = availPriceSlug ? d[availPriceSlug] : null;
    const minPrice = priceRange && asNum(priceRange.min) != null ? formatPrice(asNum(priceRange.min)) : null;
    const areaRange = availAreaSlug ? d[availAreaSlug] : null;
    const bed = bedSlug ? d[bedSlug] : null;
    const bath = bathSlug ? d[bathSlug] : null;
    const utField = fieldsOf(allProjects).find((f) => f.name === utSlug);
    const utRaw = utSlug ? d[utSlug] : null;
    const utVals = Array.isArray(utRaw) ? utRaw : utRaw != null && utRaw !== '' ? [utRaw] : [];
    const unitTypes = utVals.map((v) => {
      const opt = (utField?.options ?? []).find((o) => o.value === v || o.id === v);
      return opt ? { ar: opt.label_ar || opt.label_en || v, en: opt.label_en || opt.label_ar || v } : { ar: String(v), en: String(v) };
    });
    return {
      name: asString(d.project_name),
      district_ar: distGeo?.ar ?? null,
      district_en: distGeo?.en ?? null,
      city_ar: cityGeo?.ar ?? null,
      city_en: cityGeo?.en ?? null,
      unit_types: unitTypes.length ? unitTypes : null,
      bedroom_range: bed && typeof bed === 'object' ? bed : null,
      bathroom_range: bath && typeof bath === 'object' ? bath : null,
      available_area_range_m2: areaRange && typeof areaRange === 'object' ? areaRange : null,
      available_price_range: priceRange && typeof priceRange === 'object' ? priceRange : null,
      prices_start_from: minPrice,
      website_link: `https://wassel.re/project?id=${encodeURIComponent(rec.id)}#units`,
    };
  }

  // ── LLM callers (both Anthropic-compatible; force-tool) ──
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const kimi = new Anthropic({ apiKey: KIMI_API_KEY, baseURL: KIMI_BASE_URL });

  async function callProvider(kind, userContent) {
    const client = kind === 'kimi' ? kimi : anthropic;
    const model = kind === 'kimi' ? KIMI_MODEL : ANTHROPIC_MODEL;
    const t0 = Date.now();
    const resp = await client.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'write_project_message' },
      // kimi-k3 defaults to extended thinking, which the Moonshot API rejects
      // alongside a forced tool_choice ("incompatible with thinking enabled").
      ...(kind === 'kimi' ? { thinking: { type: 'disabled' } } : {}),
      messages: [{ role: 'user', content: userContent }],
    });
    const ms = Date.now() - t0;
    const tool = resp.content.find((b) => b.type === 'tool_use');
    if (!tool) throw new Error('no tool_use block');
    return { body_ar: tool.input?.body_ar ?? '', body_en: tool.input?.body_en ?? '', ms, usage: resp.usage ?? null };
  }

  // Guard flags for display (not a hard gate here — the endpoint enforces).
  function guardFlags(out, facts, recordData) {
    const flags = [];
    if (facts.city_ar && out.body_ar && !out.body_ar.includes(facts.city_ar)) flags.push('AR missing city');
    if (facts.district_ar && out.body_ar && !out.body_ar.includes(facts.district_ar)) flags.push('AR missing district');
    if (facts.city_en && out.body_en && !out.body_en.includes(facts.city_en)) flags.push('EN missing city');
    if (facts.district_en && out.body_en && !out.body_en.includes(facts.district_en)) flags.push('EN missing district');
    if (facts.city_ar && out.body_en && out.body_en.includes(facts.city_ar)) flags.push('EN leaks AR city');
    // invented big number (>= 6 digits) not present anywhere in the record JSON
    const recNums = new Set((JSON.stringify(recordData).match(/\d{4,}/g) ?? []).map((s) => s));
    for (const body of [out.body_ar, out.body_en]) {
      for (const m of (body || '').replace(/[,٬]/g, '').match(/\d{6,}/g) ?? []) {
        if (!recNums.has(m)) { flags.push(`invented number ${m}`); break; }
      }
    }
    return flags;
  }

  const outDir = process.env.CLAUDE_SCRATCHPAD || join(ROOT, 'scratchpad');
  mkdirSync(outDir, { recursive: true });
  const lines = [];
  lines.push(`# Project-message AI bake-off — Kimi (${KIMI_MODEL}) vs Anthropic (${ANTHROPIC_MODEL})`);
  lines.push('');
  lines.push(`Projects: ${sample.length} · Runs each provider/project: ${N_RUNS}`);
  lines.push('');

  const stats = { kimi: { ok: 0, fail: 0, ms: [], flags: 0 }, anthropic: { ok: 0, fail: 0, ms: [], flags: 0 } };

  for (const rec of sample) {
    const facts = buildFacts(rec);
    const userContent = buildUserContent(rec.data, facts);
    lines.push(`\n---\n\n## ${facts.name ?? rec.id}  \nid: \`${rec.id}\` · ${facts.city_ar ?? '?'} / ${facts.district_ar ?? '?'} · price: ${facts.prices_start_from?.ar ?? '—'}`);
    for (const provider of ['anthropic', 'kimi']) {
      lines.push(`\n### ${provider}`);
      for (let i = 1; i <= N_RUNS; i++) {
        process.stdout.write(`\r[eval] ${facts.name ?? rec.id} · ${provider} · run ${i}/${N_RUNS}   `);
        try {
          const out = await callProvider(provider, userContent);
          const flags = guardFlags(out, facts, rec.data);
          stats[provider].ok++; stats[provider].ms.push(out.ms);
          if (flags.length) stats[provider].flags++;
          lines.push(`\n**run ${i}** · ${out.ms}ms${flags.length ? ` · ⚠️ ${flags.join(', ')}` : ' · ✅'}`);
          lines.push('```');
          lines.push(out.body_ar.trim());
          lines.push('— — —');
          lines.push(out.body_en.trim());
          lines.push('```');
        } catch (e) {
          stats[provider].fail++;
          lines.push(`\n**run ${i}** · ❌ ${e.message}`);
        }
      }
    }
  }

  const summarize = (s) => {
    const ms = s.ms.slice().sort((a, b) => a - b);
    const med = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
    return `ok ${s.ok} · fail ${s.fail} · flagged ${s.flags} · median ${med}ms`;
  };
  lines.splice(4, 0, `**Anthropic:** ${summarize(stats.anthropic)}  \n**Kimi:** ${summarize(stats.kimi)}`, '');

  const outPath = join(outDir, `project-message-bakeoff-${Date.now()}.md`);
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  process.stdout.write('\n');
  console.log(`[eval] Anthropic: ${summarize(stats.anthropic)}`);
  console.log(`[eval] Kimi:      ${summarize(stats.kimi)}`);
  console.log(`[eval] report → ${outPath}`);
}

main().catch((e) => die(e.stack || e.message));
