/**
 * POST /api/templates/project-message-ai
 *
 * AI-REWRITES the WhatsApp marketing message for ONE of our own projects
 * (an `all_projects` record) from the project's CURRENT data — so a rep sending
 * a project message never has to trust a template written weeks ago against a
 * price/unit-mix that has since changed.
 *
 * Input:  { project_id, provider? }   (provider is for the bake-off / testing;
 *          production omits it and uses PROJECT_MESSAGE_AI_PROVIDER)
 * Output: { ok, body_ar, body_en, facts, generated_by }
 *
 * The ENTIRE project record `data` (every stored field) is sent to the model,
 * PLUS an authoritative facts block resolving the values the model must not
 * invent — geography (from the frozen geo models) and the AVAILABLE-only
 * price/area ranges (QA-003: a customer must never be quoted a sold/reserved
 * unit's price). The model is force-tooled to bilingual body_ar + body_en and
 * the output is gated: a rewrite that dropped/altered an authoritative place
 * name, or introduced a large number not present in the record, is REJECTED
 * loudly (the UI then keeps the saved template) rather than sent.
 *
 * Providers share ONE code path — Kimi (Moonshot) is Anthropic-SDK-compatible,
 * so both use force-tool `messages.create`, differing only in
 * baseURL/apiKey/model. Pattern mirrors api/templates/listing-message.ts.
 *
 * Loud failures only (CLAUDE.md): 401 (auth), 400 (validation), 404 (project),
 * 500 (env), 502 (provider / guard rejection).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getServiceClient } from '../_lib/files.js';
import { resolveLocalizedName, type LocalizedName } from '../../src/lib/geo/localizedName.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

interface RequestBody {
  project_id?: string;
  provider?: 'anthropic' | 'kimi';
}

// ── Node↔Web bridge (the nodejs runtime ignores a returned Web Response) ────
async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(nodeReq);
  return new Request(url.toString(), { method, headers, body });
}
async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  nodeRes.end(Buffer.from(await webResp.arrayBuffer()));
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
  /** The authoritative facts block (website link + resolved prices) — its
   *  numbers are legitimate even when they are not literally in the record. */
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

  // Invented-number guard: every ≥6-digit run in the bodies (separators
  // stripped) must appear verbatim in the record OR the facts block. Small
  // numbers (rooms, areas) are ignored; this targets fabricated prices. The
  // facts JSON is included so the website-link UUID and the resolved
  // available-price never read as "invented".
  const recNums = new Set((`${JSON.stringify(recordData)}${JSON.stringify(facts)}`.match(/\d{4,}/g) ?? []));
  for (const [lang, body] of [['ar', bodyAr], ['en', bodyEn]] as const) {
    const stripped = body.replace(/[,٬٬]/g, '');
    for (const m of stripped.match(/\d{6,}/g) ?? []) {
      if (!recNums.has(m)) { violations.push(`body_${lang} contains a number not in the record data: ${m}`); break; }
    }
  }

  if (violations.length > 0) {
    console.error(`[project-message-ai] REJECTED ${provider} output — ${violations.join('; ')}`);
    throw new Error(`generated message failed validation (${provider}): ${violations.join('; ')}`);
  }
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  const resp = await withAuth(req, async (_user) => {
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const projectId = body.project_id?.trim();
    if (!projectId) return jsonError(400, 'project_id is required');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!supabaseUrl || !anonKey || !jwt) return jsonError(500, 'Supabase env vars missing or JWT absent');
    const jwtClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const svc = getServiceClient();

    // Resolve the all_projects model (schema → rollup slugs + unit_types options).
    const { data: apModel, error: apModelErr } = await jwtClient
      .from('models').select('id, schema').eq('name', 'all_projects').single();
    if (apModelErr || !apModel) return jsonError(500, `all_projects model not found: ${apModelErr?.message ?? ''}`);
    const schema = (apModel.schema ?? null) as ModelSchema | null;

    // RLS-gate the project under the caller's JWT; read its full data (frozen-safe
    // via unified_records, same as listing-message).
    const { data: projRow, error: projErr } = await jwtClient
      .from('unified_records')
      .select('data')
      .eq('id', projectId)
      .eq('model_id', apModel.id as string)
      .single();
    if (projErr || !projRow) return jsonError(404, `project not found: ${projErr?.message ?? projectId}`);
    const pd = (projRow.data ?? {}) as Record<string, unknown>;

    // Authoritative geography — resolve the location cascade ids to localized
    // names via the frozen geo models (service role read, reference data).
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

    const userContent = buildUserContent(pd, facts);

    // ── Provider selection. Default is KIMI (the chosen production provider,
    //    2026-08-23 — ~7× cheaper, quality confirmed in the bake-off). A body
    //    override (bake-off/testing) or PROJECT_MESSAGE_AI_PROVIDER=anthropic
    //    switches back to Claude. ──
    const provider: 'anthropic' | 'kimi' =
      body.provider === 'kimi' || body.provider === 'anthropic'
        ? body.provider
        : (process.env.PROJECT_MESSAGE_AI_PROVIDER === 'anthropic' ? 'anthropic' : 'kimi');

    let client: Anthropic;
    let model: string;
    if (provider === 'kimi') {
      const kimiKey = process.env.KIMI_API_KEY;
      if (!kimiKey) return jsonError(500, 'KIMI_API_KEY is not configured');
      client = new Anthropic({ apiKey: kimiKey, baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic' });
      model = process.env.KIMI_MODEL || 'kimi-k3';
    } else {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
      client = new Anthropic({ apiKey });
      model = process.env.PROJECT_MESSAGE_AI_ANTHROPIC_MODEL || 'claude-opus-4-7';
    }

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 2_000,
        system: SYSTEM_PROMPT,
        tools: [TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'write_project_message' },
        // kimi-k3 defaults to extended thinking, which Moonshot rejects together
        // with a forced tool_choice; Anthropic ignores an explicit "disabled".
        ...(provider === 'kimi' ? { thinking: { type: 'disabled' as const } } : {}),
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `${provider} call failed: ${msg}`);
    }

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      return jsonError(502, `${provider} did not call the write_project_message tool`);
    }
    const out = toolBlock.input as { body_ar?: string; body_en?: string };
    const bodyAr = asString(out.body_ar);
    const bodyEn = asString(out.body_en);
    if (!bodyAr && !bodyEn) return jsonError(502, `${provider} returned an empty message`);

    try {
      assertFactsIntact({ bodyAr: bodyAr ?? '', bodyEn: bodyEn ?? '', districtGeo, cityGeo, recordData: pd, facts, provider });
    } catch (err) {
      return jsonError(502, err instanceof Error ? err.message : String(err));
    }

    return jsonOk({
      ok: true,
      body_ar: bodyAr ?? '',
      body_en: bodyEn ?? '',
      facts,
      generated_by: `${provider}:${model}`,
    });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
