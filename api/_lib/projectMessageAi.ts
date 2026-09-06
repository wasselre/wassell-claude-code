/**
 * Shared: AI-generate (or FACT-CHECK) the bilingual WhatsApp marketing message
 * for ONE of our own projects (an `all_projects` record), from the project's
 * CURRENT data.
 *
 * Extracted from api/templates/project-message-ai.ts so BOTH that JWT endpoint
 * (RLS-gated read) AND the in-process WhatsApp bot flow (api/_lib/aiSendProject.ts,
 * service-role read) can generate a message without an internal HTTP hop — the
 * same posture as api/_lib/projectSheet.ts (deterministic) and api/_lib/aiSend.ts.
 *
 * The ENTIRE project record `data` is sent to the model, PLUS an authoritative
 * facts block resolving the values the model must not invent — geography (from
 * the frozen geo models) and the AVAILABLE-only price/area ranges (QA-003). The
 * output is gated: a rewrite that dropped/altered an authoritative place name, or
 * introduced a large number not present in the record, is REJECTED loudly rather
 * than sent.
 *
 * Providers share ONE code path — Kimi (Moonshot) is Anthropic-SDK-compatible.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveLocalizedName, type LocalizedName } from '../../src/lib/geo/localizedName.js';

export interface GenerateInput {
  projectId: string;
  provider?: 'anthropic' | 'kimi';
  /**
   * FACT-CHECK mode. When an existing saved message is supplied, the model does
   * NOT rewrite it — it only corrects the NUMBERS (price / area / bed-bath /
   * unit types) to the project's current values and leaves all wording intact.
   * Either language being present switches into this mode.
   */
  existingAr?: string;
  existingEn?: string;
}

export interface GenerateOk {
  ok: true;
  mode: 'generate' | 'factcheck';
  body_ar: string;
  body_en: string;
  facts: Record<string, unknown>;
  generated_by: string;
}
export interface GenerateErr {
  ok: false;
  /** HTTP-shaped status the JWT endpoint maps straight through. */
  status: number;
  error: string;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asFiniteNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) { const n = Number(v.trim()); return Number.isFinite(n) ? n : null; }
  return null;
};
const oneId = (v: unknown): string | null =>
  Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : (typeof v === 'string' && v ? v : null);

// ─────────────────────────────────────────────────────────────────────────
// SHARED PROMPT — copied VERBATIM from scripts/eval-project-message-ai.mjs,
// where it was validated in the Kimi/Anthropic bake-off. Keep the two in sync
// (same posture as the worker copies).
// ─────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a real-estate marketing copywriter for Wassel Real Estate (وصل العقارية), a Saudi company. You write a short, attractive WhatsApp message that markets ONE of the company's OWN projects to a potential buyer.

You are given the project's FULL RECORD as JSON (every stored field) plus an AUTHORITATIVE FACTS block that has already resolved the trustworthy values (place names, available-unit price/area ranges, bedrooms/bathrooms, unit types, the public link). Write the message by calling \`write_project_message\`.

ABSOLUTE RULES — never violate:
1. Write BOTH languages: body_ar (Arabic, primary) and body_en (a faithful English equivalent of the same message).
2. WRITE ATTRACTIVE MARKETING COPY — but INVENT NO SPECIFIC FACT. You have freedom: a warm promotional intro, lifestyle appeal, the desirability of the area, tasteful adjectives and emojis. You may NOT state any specific price, number, size, count, distance, developer, completion date, landmark, or any place name beyond the city/district you are given, unless it appears in the supplied data. General appeal is welcome; specific unverified claims are forbidden.
3. PRICES: quote ONLY the "available" price/area ranges from the AUTHORITATIVE FACTS block (they cover units a customer can actually buy). NEVER quote a price that is not in that block. If no available price is given, omit price entirely (a sold-out project shows no price rather than a stale one). Currency is the Saudi Riyal — «ر.س» in Arabic, "SAR" in English.
4. GEOGRAPHY IS AUTHORITATIVE — NEVER INVENT IT. The facts carry district_ar/district_en and city_ar/city_en. Copy the _ar values VERBATIM into body_ar and the _en values VERBATIM into body_en — do not transliterate, translate, abbreviate, or "correct" them. If a value is null, omit that place; never guess it and never substitute the other language's value.
5. SHAPE: open with the project name, then a short warm marketing intro (a line or two about the project's general appeal), then the concrete facts each on its own short line (city, district, unit types, bedrooms, area in m², bathrooms, "prices start from"), and end with the link. Keep the whole message WhatsApp-length — scannable — with a few tasteful emojis.
6. Give body_en a clean English form of the project name (e.g. «صفا 52» → "Safa 52"); never leave the Arabic project name sitting in the English body.
7. END after the link. NO closing call-to-action, NO "للتواصل والاستفسار", NO contact line, NO agency name/sign-off (never «وصل العقارية» / «Wassel»). Nothing after the link. NEVER write prose outside the tool; ALWAYS call write_project_message.`;

const TOOL_SCHEMA = {
  name: 'write_project_message',
  description: 'Return the bilingual WhatsApp marketing message for the project.',
  input_schema: {
    type: 'object' as const,
    properties: {
      body_ar: { type: 'string', description: 'The Arabic WhatsApp message (primary).' },
      body_en: { type: 'string', description: 'A faithful English equivalent of the same message.' },
    },
    required: ['body_ar', 'body_en'],
  },
};

/** Build the user turn: the full record + the authoritative facts block. */
function buildUserContent(recordData: Record<string, unknown>, facts: Record<string, unknown>): string {
  return `PROJECT RECORD (full JSON — every stored field; treat unfamiliar keys as context, do not quote raw slugs):
${JSON.stringify(recordData, null, 2)}

AUTHORITATIVE FACTS (already resolved — trust these over the raw record for names/prices):
${JSON.stringify(facts, null, 2)}`;
}

// ── FACT-CHECK mode ────────────────────────────────────────────────────────
const FACTCHECK_SYSTEM_PROMPT = `You are updating an EXISTING WhatsApp marketing message for one of Wassel Real Estate's own projects so its NUMBERS match the project's CURRENT data. You are given the existing message (body_ar and body_en) plus an AUTHORITATIVE FACTS block. Return the message by calling \`write_project_message\`.

ABSOLUTE RULES — never violate:
1. Return BOTH languages. Keep each body OTHERWISE IDENTICAL to the input — same wording, sentences, order, emojis, line breaks, tone, and the project name. Change NOTHING except numeric values that are wrong.
2. Update every numeric value to match the AUTHORITATIVE FACTS: the starting price (use the available price only), the area range in m², the bedroom and bathroom counts/ranges, and the unit-types list. Use ONLY values present in the facts — never invent or estimate.
3. If a number in the message already matches the facts, leave it EXACTLY as written (same formatting). Only touch a figure that actually disagrees.
4. PRICE: quote only the available price from the facts. If the facts carry no available price but the message states one, remove just that figure while keeping the sentence readable — do not invent a replacement.
5. GEOGRAPHY: the facts carry district_ar/district_en and city_ar/city_en. If a place name in the message disagrees with the facts, correct it to the facts value (Arabic form in body_ar, English form in body_en); otherwise leave it. Never invent a place name or swap languages.
6. Do NOT add, remove, or reorder any non-numeric text. Do NOT add a closing line, CTA, or sign-off. NEVER write prose outside the tool; ALWAYS call write_project_message.`;

function buildFactCheckContent(existingAr: string, existingEn: string, facts: Record<string, unknown>): string {
  return `EXISTING MESSAGE — update ONLY its numbers to match the facts; keep every other character identical:

body_ar:
${existingAr || '(none)'}

body_en:
${existingEn || '(none)'}

AUTHORITATIVE FACTS (the current, correct values):
${JSON.stringify(facts, null, 2)}`;
}

interface SchemaField { name: string; is_rollup?: boolean; rollup_kind?: string; options?: Array<{ id?: string; value?: string; label_ar?: string; label_en?: string }> }
interface ModelSchema { sections?: Array<{ fields?: SchemaField[] }> }
function fieldsOf(schema: ModelSchema | null): SchemaField[] {
  return (schema?.sections ?? []).flatMap((s) => s.fields ?? []);
}
function slugByRollupKind(schema: ModelSchema | null, kind: string): string | null {
  return fieldsOf(schema).find((f) => f.is_rollup && f.rollup_kind === kind)?.name ?? null;
}
function slugByCandidates(schema: ModelSchema | null, cands: string[]): string | null {
  const fs = fieldsOf(schema);
  for (const c of cands) if (fs.some((f) => f.name === c)) return c;
  return null;
}
function formatPrice(n: number): { ar: string; en: string } {
  const g = Math.round(n).toLocaleString('en-US');
  return { ar: `${g} ر.س`, en: `SAR ${g}` };
}

/**
 * Protected-fact gate. Rejects a rewrite that dropped/altered an authoritative
 * place name (same posture as listing-message's assertGeographyIntact) OR that
 * introduced a large number (≥6 digits) not present in the record — a proxy for
 * an invented price. Rejection throws → the caller keeps the saved template.
 */
function assertFactsIntact(args: {
  bodyAr: string;
  bodyEn: string;
  districtGeo: LocalizedName | null;
  cityGeo: LocalizedName | null;
  recordData: Record<string, unknown>;
  facts: Record<string, unknown>;
  provider: string;
}): void {
  const { bodyAr, bodyEn, districtGeo, cityGeo, recordData, facts, provider } = args;
  const violations: string[] = [];

  const checkAr = (geo: LocalizedName | null, level: string) => {
    if (!geo || !bodyAr) return;
    if (!bodyAr.includes(geo.ar)) violations.push(`body_ar is missing the authoritative ${level} «${geo.ar}»`);
  };
  const checkEn = (geo: LocalizedName | null, level: string) => {
    if (!geo || !bodyEn) return;
    const ok = bodyEn.includes(geo.enDisplay) || bodyEn.includes(geo.enCanonical);
    if (!ok) violations.push(`body_en is missing the authoritative ${level} "${geo.enDisplay}"`);
    if (bodyEn.includes(geo.ar)) violations.push(`body_en contains the ARABIC ${level} «${geo.ar}» instead of "${geo.enDisplay}"`);
  };
  checkAr(districtGeo, 'district');
  checkAr(cityGeo, 'city');
  checkEn(districtGeo, 'district');
  checkEn(cityGeo, 'city');

  // Invented-price guard: every ≥6-digit run in the bodies must correspond to a
  // number present in the record OR the facts block — in RAW **or ROUNDED** form.
  const toWestern = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const allowedNums = new Set<string>();
  for (const tok of toWestern(`${JSON.stringify(recordData)}${JSON.stringify(facts)}`).match(/\d[\d,٬.]*/g) ?? []) {
    const digits = tok.replace(/[,٬.]/g, '');
    if (digits.length >= 4) allowedNums.add(digits);
    const n = Number(tok.replace(/[,٬]/g, ''));
    if (Number.isFinite(n)) { allowedNums.add(String(Math.round(n))); allowedNums.add(String(Math.trunc(n))); }
  }
  for (const [lang, body] of [['ar', bodyAr], ['en', bodyEn]] as const) {
    const stripped = toWestern(body).replace(/[,٬]/g, '');
    for (const m of stripped.match(/\d{6,}/g) ?? []) {
      if (!allowedNums.has(m)) { violations.push(`body_${lang} contains a number not in the record data: ${m}`); break; }
    }
  }

  if (violations.length > 0) {
    console.error(`[project-message-ai] REJECTED ${provider} output — ${violations.join('; ')}`);
    throw new Error(`generated message failed validation (${provider}): ${violations.join('; ')}`);
  }
}

/**
 * Generate (or fact-check) the bilingual project message.
 *
 * `readClient` reads the model + project (RLS for a JWT caller, service role for
 * the in-process bot). `svc` is always service role (geography is reference
 * data). Returns a discriminated result — the JWT endpoint maps `status`/`error`
 * straight to jsonError, and the bot flow falls back to the deterministic sheet
 * on any `ok:false`.
 */
export async function generateProjectMessage(
  readClient: SupabaseClient,
  svc: SupabaseClient,
  input: GenerateInput,
): Promise<GenerateOk | GenerateErr> {
  const projectId = input.projectId?.trim();
  if (!projectId) return { ok: false, status: 400, error: 'project_id is required' };

  // Resolve the all_projects model (schema → rollup slugs + unit_types options).
  const { data: apModel, error: apModelErr } = await readClient
    .from('models').select('id, schema').eq('name', 'all_projects').single();
  if (apModelErr || !apModel) return { ok: false, status: 500, error: `all_projects model not found: ${apModelErr?.message ?? ''}` };
  const schema = (apModel.schema ?? null) as ModelSchema | null;

  // RLS-gate the project under the read client; read its full data (frozen-safe
  // via unified_records, same as listing-message).
  const { data: projRow, error: projErr } = await readClient
    .from('unified_records')
    .select('data')
    .eq('id', projectId)
    .eq('model_id', apModel.id as string)
    .single();
  if (projErr || !projRow) return { ok: false, status: 404, error: `project not found: ${projErr?.message ?? projectId}` };
  const pd = (projRow.data ?? {}) as Record<string, unknown>;

  // Authoritative geography — resolve the location cascade ids to localized names.
  const resolveGeoLocalized = async (id: string | null): Promise<LocalizedName | null> => {
    if (!id) return null;
    const { data } = await svc.from('unified_records').select('data').eq('id', id).maybeSingle();
    const gd = (data as { data?: Record<string, unknown> } | null)?.data ?? null;
    const localized = resolveLocalizedName(id, gd);
    if (!localized && gd) {
      console.error(`[project-message-ai] geography ${id} is not fully localized (missing name_en) — omitting rather than letting the model invent a name`);
    }
    return localized;
  };
  const loc = pd.location && typeof pd.location === 'object' && !Array.isArray(pd.location)
    ? (pd.location as Record<string, unknown>) : {};
  const cityGeo = await resolveGeoLocalized(oneId(loc.city));
  const districtGeo = await resolveGeoLocalized(oneId(loc.district));

  // Available-only rollups (QA-003) + ranges + unit types, read from the record.
  const availPriceSlug = slugByRollupKind(schema, 'available_price_range');
  const availAreaSlug = slugByRollupKind(schema, 'available_area_range');
  const bedSlug = slugByRollupKind(schema, 'bedroom_range');
  const bathSlug = slugByRollupKind(schema, 'bathroom_range');
  const utSlug = slugByCandidates(schema, ['unit_types', 'unit_type']);
  const asRange = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const priceRange = availPriceSlug ? asRange(pd[availPriceSlug]) : null;
  const minPriceNum = priceRange ? asFiniteNumber(priceRange.min) : null;

  const utField = utSlug ? fieldsOf(schema).find((f) => f.name === utSlug) : undefined;
  const utRaw = utSlug ? pd[utSlug] : null;
  const utVals = Array.isArray(utRaw) ? utRaw : utRaw != null && utRaw !== '' ? [utRaw] : [];
  const unitTypes = utVals.map((v) => {
    const opt = (utField?.options ?? []).find((o) => o.value === v || o.id === v);
    return opt
      ? { ar: opt.label_ar || opt.label_en || String(v), en: opt.label_en || opt.label_ar || String(v) }
      : { ar: String(v), en: String(v) };
  });

  const facts = {
    name: asString(pd.project_name),
    city_ar: cityGeo?.ar ?? null,
    city_en: cityGeo?.enDisplay ?? null,
    district_ar: districtGeo?.ar ?? null,
    district_en: districtGeo?.enDisplay ?? null,
    unit_types: unitTypes.length ? unitTypes : null,
    bedroom_range: bedSlug ? asRange(pd[bedSlug]) : null,
    bathroom_range: bathSlug ? asRange(pd[bathSlug]) : null,
    available_area_range_m2: availAreaSlug ? asRange(pd[availAreaSlug]) : null,
    available_price_range: priceRange,
    prices_start_from: minPriceNum != null ? formatPrice(minPriceNum) : null,
    website_link: `https://wassel.re/project?id=${encodeURIComponent(projectId)}#units`,
  };

  // FACT-CHECK vs full GENERATE.
  const existingAr = typeof input.existingAr === 'string' ? input.existingAr : '';
  const existingEn = typeof input.existingEn === 'string' ? input.existingEn : '';
  const isFactCheck = existingAr.trim().length > 0 || existingEn.trim().length > 0;
  const systemPrompt = isFactCheck ? FACTCHECK_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userContent = isFactCheck
    ? buildFactCheckContent(existingAr, existingEn, facts)
    : buildUserContent(pd, facts);

  // Provider selection. Default is KIMI (2026-08-23 — ~7× cheaper, quality
  // confirmed). An explicit input override or PROJECT_MESSAGE_AI_PROVIDER=anthropic
  // switches back to Claude.
  const provider: 'anthropic' | 'kimi' =
    input.provider === 'kimi' || input.provider === 'anthropic'
      ? input.provider
      : (process.env.PROJECT_MESSAGE_AI_PROVIDER === 'anthropic' ? 'anthropic' : 'kimi');

  let client: Anthropic;
  let model: string;
  if (provider === 'kimi') {
    const kimiKey = process.env.KIMI_API_KEY;
    if (!kimiKey) return { ok: false, status: 500, error: 'KIMI_API_KEY is not configured' };
    client = new Anthropic({ apiKey: kimiKey, baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic' });
    model = process.env.KIMI_MODEL || 'kimi-k3';
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, status: 500, error: 'ANTHROPIC_API_KEY is not configured' };
    client = new Anthropic({ apiKey });
    model = process.env.PROJECT_MESSAGE_AI_ANTHROPIC_MODEL || 'claude-opus-4-7';
  }

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 2_000,
      system: systemPrompt,
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'write_project_message' },
      // kimi-k3 defaults to extended thinking, which Moonshot rejects together
      // with a forced tool_choice; Anthropic ignores an explicit "disabled".
      ...(provider === 'kimi' ? { thinking: { type: 'disabled' as const } } : {}),
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `${provider} call failed: ${msg}` };
  }

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    return { ok: false, status: 502, error: `${provider} did not call the write_project_message tool` };
  }
  const out = toolBlock.input as { body_ar?: string; body_en?: string };
  const bodyAr = asString(out.body_ar);
  const bodyEn = asString(out.body_en);
  if (!bodyAr && !bodyEn) return { ok: false, status: 502, error: `${provider} returned an empty message` };

  try {
    assertFactsIntact({ bodyAr: bodyAr ?? '', bodyEn: bodyEn ?? '', districtGeo, cityGeo, recordData: pd, facts, provider });
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }

  return {
    ok: true,
    mode: isFactCheck ? 'factcheck' : 'generate',
    body_ar: bodyAr ?? '',
    body_en: bodyEn ?? '',
    facts,
    generated_by: `${provider}:${model}`,
  };
}
