/**
 * POST /api/templates/posts-content
 *
 * The Posts Content writer's server side. Two modes:
 *   { mode: 'facts', our_project_ids[] }  → per-project facts + RANKED angles
 *   { mode: 'write', our_project_id, tone, language, items[] } → the posts
 *
 * Why it's shaped this way
 * ------------------------
 * The 15 angles in src/lib/postsContent/templates.ts are marketing THEMES, not
 * property types — a project sells whatever `unit_types` says it sells. Angles
 * the project's data cannot back are EXCLUDED before generation (rankAngles),
 * never generated-with-a-warning.
 *
 * Two independent anti-fabrication gates, both enforced here:
 *   1. Structural — the model writes a headline + prose only; every numeric
 *      specification is rendered by composeSpecBlock() from database values.
 *      assertNoNumbers() rejects prose that smuggles one in anyway.
 *   2. Referential — the model must cite `used_fact_ids[]` from the catalog
 *      built by buildFactCatalog(). Any unknown id is a rejection. This is the
 *      gate that catches number-free fabrications ("مع مسبح خاص وحديقة").
 * A rejected post is retried ONCE with the violation fed back, then reported as
 * a failure for that post alone — never published, never silently downgraded.
 *
 * The caller fans out one request per project chunk so no request approaches
 * the 60 s ceiling. No queue: text generation is ~5-15 s per post, unlike the
 * deck / image / document pipelines that genuinely need one.
 *
 * Loud failures only (CLAUDE.md): 401 auth, 400 validation, 404 project,
 * 500 env, 502 model provider.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getServiceClient } from '../_lib/files.js';
import { llmRoutingEnabled, llmJson, logLlmFallback } from '../_lib/textLlm.js';
import { resolveLocalizedName } from '../../src/lib/geo/localizedName.js';
import { angleById, type PostTone } from '../../src/lib/postsContent/templates.js';
import { rankAngles, type PostLanguage } from '../../src/lib/postsContent/planning.js';
import {
  buildFactCatalog, composePostBody, composeSpecBlock, evidenceHaystack, maxGuaranteeYears,
  needsAr, needsEn, parseGuaranteeYears, unknownFactIds,
  type Bilingual, type FactEntry, type GeneratedPost, type GuaranteeItem, type NumericRange,
  type PostsProjectFacts,
} from '../../src/lib/postsContent/facts.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const OUR_PROJECTS = 'our_projects';
const ALL_PROJECTS = 'all_projects';

/** Hard cap per request so one call can't sit near the 60 s ceiling. */
const MAX_ITEMS_PER_REQUEST = 4;
/** One corrective retry per post before it is reported as failed. */
const MAX_ATTEMPTS = 2;

export interface WriteItem {
  key: string;
  angle: string;
  variation_index?: number;
  post_number?: number;
  /** Headlines already produced for this angle — the model must not echo them. */
  avoid_headlines?: string[];
  /** Set when the user asked for a rewrite after rejecting the previous take. */
  feedback?: {
    reason?: string;
    note?: string;
    previous_headline?: string;
    previous_prose?: string;
  };
}

interface RequestBody {
  mode?: 'facts' | 'write';
  our_project_id?: string;
  our_project_ids?: string[];
  tone?: PostTone;
  language?: PostLanguage;
  items?: WriteItem[];
}

// ── node/web request plumbing (same shim as the sibling endpoints) ──────────
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

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function oneId(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' && v ? v : null;
}
function asRange(v: unknown): NumericRange | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const min = asFiniteNumber(o.min);
  const max = asFiniteNumber(o.max);
  return min != null && max != null ? { min, max } : null;
}
function rowsOf(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v.filter((r) => r && typeof r === 'object') as Array<Record<string, unknown>>) : [];
}

// ── model-schema helpers (dropdown/multiselect label resolution) ────────────
interface SchemaField {
  name: string;
  type: string;
  options?: Array<{ id?: string; value?: string; label_ar?: string; label_en?: string }>;
}
function fieldsOf(schema: unknown): SchemaField[] {
  const sections = (schema as { sections?: Array<{ fields?: SchemaField[] }> } | null)?.sections ?? [];
  return sections.flatMap((s) => s.fields ?? []);
}
function labelsFor(fields: SchemaField[], slug: string, value: unknown): Bilingual | null {
  const v = asString(value);
  if (!v) return null;
  const opt = fields.find((f) => f.name === slug)?.options?.find((o) => o.value === v || o.id === v);
  if (!opt) return { ar: v, en: v };
  return { ar: opt.label_ar || opt.label_en || v, en: opt.label_en || opt.label_ar || v };
}
function multiLabelsFor(fields: SchemaField[], slug: string, raw: unknown): { labels: Bilingual[]; values: string[] } {
  const values = Array.isArray(raw) ? raw : raw != null && raw !== '' ? [raw] : [];
  const labels: Bilingual[] = [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const key = asString(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const l = labelsFor(fields, slug, v);
    if (l) { labels.push(l); kept.push(key); }
  }
  return { labels, values: kept };
}

const WEBSITE_BASE = 'https://wassel.re';

/**
 * Resolve every fact a post needs, from our_projects → its all_projects master.
 * Reads under the caller's JWT (RLS applies to the project) and uses the
 * service client only for reference geography + developer names, which are
 * non-sensitive and live in frozen tables the browser can't always reach.
 */
export async function resolveFacts(
  jwtClient: SupabaseClient,
  svc: SupabaseClient,
  ourProjectId: string,
  cache: { models?: { ourId: string; allId: string; allFields: SchemaField[] } },
): Promise<{ facts: PostsProjectFacts } | { error: string; status: number }> {
  if (!cache.models) {
    const { data: modelRows, error: modelErr } = await jwtClient
      .from('models').select('id, name, schema').in('name', [OUR_PROJECTS, ALL_PROJECTS]);
    if (modelErr || !modelRows) return { error: `models read failed: ${modelErr?.message ?? ''}`, status: 500 };
    const ourModel = modelRows.find((m) => (m as { name: string }).name === OUR_PROJECTS) as { id: string } | undefined;
    const allModel = modelRows.find((m) => (m as { name: string }).name === ALL_PROJECTS) as
      | { id: string; schema: unknown } | undefined;
    if (!ourModel || !allModel) return { error: 'our_projects / all_projects model not found', status: 500 };
    cache.models = { ourId: ourModel.id, allId: allModel.id, allFields: fieldsOf(allModel.schema) };
  }
  const { ourId, allId, allFields } = cache.models;

  const { data: opRow, error: opErr } = await jwtClient
    .from('unified_records').select('data').eq('id', ourProjectId).eq('model_id', ourId).maybeSingle();
  if (opErr) return { error: `our_projects read failed: ${opErr.message}`, status: 500 };
  if (!opRow) return { error: `project not found or not visible: ${ourProjectId}`, status: 404 };
  const op = ((opRow as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;

  const allProjectId = oneId(op.project);
  let ap: Record<string, unknown> = {};
  if (allProjectId) {
    const { data: apRow } = await jwtClient
      .from('unified_records').select('data').eq('id', allProjectId).eq('model_id', allId).maybeSingle();
    ap = ((apRow as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  }

  // Geography — authoritative bilingual names from the frozen geo models. A
  // record that isn't fully localized is OMITTED rather than letting the Arabic
  // name leak into the English body (ISSUE #8 in listing-message.ts).
  const loc = ap.location && typeof ap.location === 'object' && !Array.isArray(ap.location)
    ? (ap.location as Record<string, unknown>) : {};
  const resolveGeo = async (id: string | null): Promise<Bilingual | null> => {
    if (!id) return null;
    const { data } = await svc.from('unified_records').select('data').eq('id', id).maybeSingle();
    const gd = (data as { data?: Record<string, unknown> } | null)?.data ?? null;
    const localized = resolveLocalizedName(id, gd);
    if (!localized) {
      if (gd) console.error(`[posts-content] geography ${id} is not fully localized (missing name_en) — omitted`);
      return null;
    }
    return { ar: localized.ar, en: localized.enDisplay };
  };
  const city = await resolveGeo(oneId(loc.city));
  const district = await resolveGeo(oneId(loc.district));

  let developer: string | null = null;
  const developerId = oneId(ap.developer);
  if (developerId) {
    const { data } = await svc.from('unified_records').select('data').eq('id', developerId).maybeSingle();
    const dd = (data as { data?: Record<string, unknown> } | null)?.data ?? {};
    developer = asString(dd.developer_name) ?? asString(dd.name) ?? null;
  }

  const guarantees: GuaranteeItem[] = rowsOf(ap.guarantees)
    .map((r) => {
      const item = asString(r.col_1) ?? '';
      const duration = asString(r.col_3) ?? '';
      return { item, duration, years: parseGuaranteeYears(duration) };
    })
    .filter((g) => !!g.item);

  const features = rowsOf(ap.features).map((r) => asString(r.feature)).filter((f): f is string => !!f);
  const services = rowsOf(ap.services)
    .map((r) => {
      const s = asString(r.service);
      const n = asString(r.notes);
      return s ? (n ? `${s} (${n})` : s) : null;
    })
    .filter((s): s is string => !!s);
  const landmarks = rowsOf(ap.nearby_landmarks)
    .map((r) => {
      const l = asString(r.landmark);
      const d = asString(r.distance) ?? asString(r.duration);
      return l ? (d ? `${l} - ${d}` : l) : null;
    })
    .filter((s): s is string => !!s);

  const unitTypes = multiLabelsFor(allFields, 'unit_types', ap.unit_types);
  const amenities = multiLabelsFor(allFields, 'preferred_amenities', ap.preferred_amenities);

  const facts: PostsProjectFacts = {
    ourProjectId,
    allProjectId,
    name: asString(ap.project_name) ?? asString(op.project_name),
    developer,
    city,
    district,
    unitTypes: unitTypes.labels,
    unitTypeValues: unitTypes.values,
    // AVAILABLE-only rollups (QA-003): quoting the all-unit range would tell a
    // customer a project "starts from" a price nobody can actually buy at.
    areaRange: asRange(ap.available_area_range),
    priceRange: asRange(ap.available_price_range),
    bedrooms: asRange(ap.bedroom_range),
    bathrooms: asRange(ap.bathroom_range),
    availableUnits: asFiniteNumber(ap.available_units),
    projectStatus: labelsFor(allFields, 'project_status', ap.project_status),
    constructionStatus: labelsFor(allFields, 'construction_status', ap.construction_status),
    features,
    guarantees,
    services,
    landmarks,
    amenities: amenities.labels,
    websiteUnitsLink: allProjectId ? `${WEBSITE_BASE}/project?id=${encodeURIComponent(allProjectId)}#units` : null,
    brochureLink: asString(ap.brochure_link) ?? asString(ap.broucher_developer),
    missing: [],
  };

  const missing: string[] = [];
  if (!facts.name) missing.push('name');
  if (!facts.city) missing.push('city');
  if (!facts.district) missing.push('district');
  if (facts.unitTypes.length === 0) missing.push('unit_types');
  if (!facts.areaRange) missing.push('area');
  if (!facts.priceRange) missing.push('price');
  if (facts.features.length === 0) missing.push('features');
  if (facts.guarantees.length === 0) missing.push('guarantees');
  // `websiteUnitsLink` is resolved but NOT part of a post (see composeSpecBlock),
  // so its absence is not a gap worth warning about.
  facts.missing = missing;

  return { facts };
}

function systemPrompt(language: PostLanguage): string {
  const langRule = language === 'ar'
    ? 'Write ARABIC ONLY. Return empty strings for headline_en and prose_en — do not translate.'
    : language === 'en'
      ? 'Write ENGLISH ONLY. Return empty strings for headline_ar and prose_ar — do not write Arabic. Use the *_en values from the fact catalog for every place, feature and landmark name; never copy an Arabic name into the English text unless the catalog offers no English form.'
      : 'Write BOTH languages. Arabic is primary; the English is an independently-written equivalent carrying the same verified facts — NOT a literal word-for-word translation.';

  return `You are the senior Arabic real-estate copywriter for Wassel Real Estate (وصل العقارية), a Saudi marketing company. You write ONE social-media post about ONE real project, from ONE assigned marketing angle.

You are given the project's FACT CATALOG (an explicit, id'd list of everything true about this project), the ANGLE, the TONE, and a STYLE REFERENCE written by the client.

Absolute rules:
1. WRITE ONLY the headline and the prose paragraph. A separate system renders the specification lines (نوع العقار / الموقع / المساحة / المزايا / الضمانات / القيمة / الرابط) from the database and appends them under your prose. Do NOT write those lines and do NOT repeat their content.
2. NEVER write a price, an area figure, a warranty duration, a room count, a unit count, or any number with three or more digits. No «ر.س», «SAR», «م²», «ريال». Those are rendered for you.
3. EVERY FACTUAL CLAIM MUST COME FROM THE FACT CATALOG, and you must list the id of every fact you used in \`used_fact_ids\`. An id is the FULL string on the left of the "=" in the catalog, copied character for character — e.g. ["feature:3", "guarantee:0", "location:district"]. NEVER a bare number like "3", never the fact's text, never an id you did not see in the catalog. You may not mention a pool, gym, garden, private entrance, view, smart system, security, financing, payment plan, completion date, landmark, distance, or developer claim unless it is IN THE CATALOG. Writing something the catalog does not contain — even with no numbers in it — is a fabrication and the post will be rejected. When in doubt, write about the mood and the lifestyle rather than asserting a feature.
4. NEVER change the property type. The project sells the unit types in the catalog. If the angle's reference copy talks about a villa but the catalog says apartments, write about apartments. The angle is a THEME, not a property type.
5. NAMES ARE AUTHORITATIVE — copy the catalog's place names verbatim into the matching language. Never transliterate, translate or invent one. The PROJECT NAME has no official English form: write it exactly as the catalog gives it, in both languages, even inside English text. Do not romanize it — an invented spelling differs between posts and is not the project's name.
6. The STYLE REFERENCE shows the client's desired voice and rhythm. Match the voice; do NOT copy its sentences and do NOT keep its property type or its invented details.
7. TONE — "short": one punchy headline plus 1-2 sentences, social-caption length, a couple of tasteful emojis allowed. "long": a formal, dignified headline plus 3-4 sentences of elevated Modern Standard Arabic, no emojis.
8. ${langRule}
9. No call to action, no phone number, no sign-off, no hashtags, no agency name. End after the prose.`;
}

const TOOL_SCHEMA = {
  name: 'write_post',
  description: 'Return the marketing post (headline + prose only) plus the ids of every fact used.',
  input_schema: {
    type: 'object' as const,
    properties: {
      headline_ar: { type: 'string', description: 'Arabic headline. Empty string when Arabic was not requested.' },
      prose_ar: { type: 'string', description: 'Arabic body paragraph. Empty string when Arabic was not requested.' },
      headline_en: { type: 'string', description: 'English headline. Empty string when English was not requested.' },
      prose_en: { type: 'string', description: 'English body paragraph. Empty string when English was not requested.' },
      used_fact_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ids from the FACT CATALOG for every factual claim made. Must be non-empty.',
      },
    },
    required: ['headline_ar', 'prose_ar', 'headline_en', 'prose_en', 'used_fact_ids'],
  },
};

interface ModelOut {
  headline_ar: string;
  prose_ar: string;
  headline_en: string;
  prose_en: string;
  used_fact_ids: string[];
}

/**
 * Gate 1 — structural. Reject text that smuggled a specification past rule 2.
 * Prices and areas are the exact class of fact a customer acts on.
 */
function checkNoNumbers(parts: Array<{ label: string; text: string }>): string[] {
  const violations: string[] = [];
  for (const { label, text } of parts) {
    if (!text) continue;
    if (/ر\.?\s?س|SAR|ريال|﷼/i.test(text)) violations.push(`${label} contains a currency token`);
    if (/م²|m²|متر مربع/i.test(text)) violations.push(`${label} contains an area unit`);
    if (/\d{3,}/.test(text)) violations.push(`${label} contains a 3+ digit number`);
  }
  return violations;
}

/** Gate 2 — referential. Every cited fact id must exist in the catalog. */
function checkFactIds(used: string[], catalog: FactEntry[]): string[] {
  if (used.length === 0) {
    return ['used_fact_ids is empty — every post must cite at least one fact from the catalog'];
  }
  const unknown = unknownFactIds(used, catalog);
  if (unknown.length === 0) return [];
  // Name the valid ids in the violation so the corrective retry can fix the
  // citation instead of guessing again (the common miss is a bare index).
  return [
    `used_fact_ids contains ids that are not in this project's catalog: ${unknown.join(', ')}. `
    + `Valid ids are exactly: ${catalog.map((f) => f.id).join(', ')}`,
  ];
}

function buildUserContent(args: {
  facts: PostsProjectFacts;
  catalog: FactEntry[];
  item: WriteItem;
  tone: PostTone;
  language: PostLanguage;
  evidence: string[];
  correction?: string;
}): string {
  const { facts, catalog, item, tone, language, evidence, correction } = args;
  const angle = angleById(item.angle);
  if (!angle) throw new Error(`unknown angle ${item.angle}`);
  const ref = angle.reference[tone];
  const variation = item.variation_index ?? 0;

  const catalogText = catalog.map((f) => `  ${f.id} = ${f.text_ar}${f.text_en !== f.text_ar ? ` | EN: ${f.text_en}` : ''}`).join('\n');

  const parts: string[] = [
    `FACT CATALOG — the ONLY claims you may make. Cite the ids you use in used_fact_ids, copying each id EXACTLY as written before the "=" (e.g. "${catalog[0]?.id ?? 'feature:0'}"), never as a bare number:\n${catalogText}`,
    `\nUNIT TYPES SOLD (never contradict this): ${facts.unitTypes.map((u) => u.ar).join('، ') || '(unknown)'}`,
    `LONGEST WARRANTY ON RECORD: ${maxGuaranteeYears(facts) ?? '(none)'} (do NOT write the number — it is rendered for you)`,
    `\nASSIGNED ANGLE: ${angle.label_ar} / ${angle.label_en} — ${angle.theme_ar}`,
    `FACTS THAT MADE THIS ANGLE ELIGIBLE: ${evidence.join('، ')}`,
    `TONE: ${tone}`,
    `LANGUAGE: ${language}`,
    `\nSTYLE REFERENCE (the client's voice — match the rhythm, never copy the words, never keep its property type):\nالعنوان: ${ref.headline}\nالنص: ${ref.body}`,
  ];

  if (variation > 0 || (item.avoid_headlines?.length ?? 0) > 0) {
    parts.push(
      `\nREPEAT ANGLE — this is take #${variation + 1} of this angle for this project. It MUST read as a different post, not a rewrite. Change the hook, the headline structure, the lead benefit, which supporting facts you cite, and the sentence rhythm.`,
    );
    if (item.avoid_headlines?.length) {
      parts.push(`Headlines already used for this project (do not echo their wording or structure):\n${item.avoid_headlines.map((h) => `  - ${h}`).join('\n')}`);
    }
  }

  if (item.feedback) {
    const f = item.feedback;
    parts.push(
      `\nREWRITE REQUESTED. The reviewer rejected the previous version.\nReason: ${f.reason ?? '(unspecified)'}${f.note ? `\nReviewer note: ${f.note}` : ''}${f.previous_headline ? `\nPrevious headline: ${f.previous_headline}` : ''}${f.previous_prose ? `\nPrevious prose: ${f.previous_prose}` : ''}\nFix exactly that problem. Do NOT change any verified project fact, and do NOT drift off the assigned angle.`,
    );
  }

  if (correction) {
    parts.push(`\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${correction}\nProduce a corrected version that obeys every rule.`);
  }

  return parts.join('\n');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Normalize a provider reply: unrequested-language keys are legitimately absent. */
function normalizeOut(raw: Partial<ModelOut>): ModelOut {
  return {
    headline_ar: str(raw.headline_ar),
    prose_ar: str(raw.prose_ar),
    headline_en: str(raw.headline_en),
    prose_en: str(raw.prose_en),
    used_fact_ids: Array.isArray(raw.used_fact_ids) ? raw.used_fact_ids.filter((x) => typeof x === 'string') : [],
  };
}

async function callModel(args: {
  system: string;
  user: string;
  language: PostLanguage;
}): Promise<{ out: ModelOut; generatedBy: string }> {
  const { system, user, language } = args;

  if (llmRoutingEnabled()) {
    try {
      // Only require the keys this language actually needs. Demanding all four
      // sent every Arabic-only / English-only request to the Anthropic fallback,
      // because a model told to "leave headline_ar empty" omits the key rather
      // than emitting "". The emptiness of the OTHER language is asserted by the
      // caller's validation, not by the transport contract.
      const requiredKeys = [
        ...(needsAr(language) ? ['headline_ar', 'prose_ar'] : []),
        ...(needsEn(language) ? ['headline_en', 'prose_en'] : []),
        'used_fact_ids',
      ];
      const q = await llmJson<Partial<ModelOut>>({
        system,
        user,
        shape: '{"headline_ar": string, "prose_ar": string, "headline_en": string, "prose_en": string, "used_fact_ids": string[]}',
        requiredKeys,
        maxTokens: 2_000,
        timeoutMs: 40_000,
      });
      return {
        out: normalizeOut(q),
        generatedBy: 'deepseek:deepseek-chat',
      };
    } catch (err) {
      logLlmFallback('/api/templates/posts-content', err);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2_000,
    system,
    tools: [TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: 'write_post' },
    messages: [{ role: 'user', content: user }],
  });
  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') throw new Error('Claude did not call write_post');
  return {
    out: normalizeOut(toolBlock.input as Partial<ModelOut>),
    generatedBy: 'anthropic:claude-opus-4-7',
  };
}

export async function writeOnePost(args: {
  facts: PostsProjectFacts;
  catalog: FactEntry[];
  item: WriteItem;
  tone: PostTone;
  language: PostLanguage;
  evidence: string[];
}): Promise<GeneratedPost> {
  const { facts, catalog, item, tone, language, evidence } = args;
  const system = systemPrompt(language);

  let correction: string | undefined;
  let lastViolations: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const user = buildUserContent({ facts, catalog, item, tone, language, evidence, correction });
    const { out, generatedBy } = await callModel({ system, user, language });

    const headlineAr = (out.headline_ar ?? '').trim();
    const proseAr = (out.prose_ar ?? '').trim();
    const headlineEn = (out.headline_en ?? '').trim();
    const proseEn = (out.prose_en ?? '').trim();

    const checked: Array<{ label: string; text: string }> = [];
    if (needsAr(language)) checked.push({ label: 'headline_ar', text: headlineAr }, { label: 'prose_ar', text: proseAr });
    if (needsEn(language)) checked.push({ label: 'headline_en', text: headlineEn }, { label: 'prose_en', text: proseEn });

    const violations = [...checkNoNumbers(checked), ...checkFactIds(out.used_fact_ids, catalog)];
    if (needsAr(language) && !proseAr) violations.push('prose_ar is empty but Arabic was requested');
    if (needsEn(language) && !proseEn) violations.push('prose_en is empty but English was requested');

    if (violations.length > 0) {
      console.error(
        `[posts-content] attempt ${attempt}/${MAX_ATTEMPTS} REJECTED for angle "${item.angle}" (${generatedBy}): ${violations.join('; ')}`,
      );
      lastViolations = violations;
      correction = violations.join('; ');
      continue;
    }

    const specAr = needsAr(language) ? composeSpecBlock(facts, tone, 'ar') : '';
    const specEn = needsEn(language) ? composeSpecBlock(facts, tone, 'en') : '';
    return {
      key: item.key,
      ourProjectId: facts.ourProjectId,
      angle: item.angle,
      variationIndex: item.variation_index ?? 0,
      postNumber: item.post_number ?? 0,
      headline_ar: headlineAr,
      headline_en: headlineEn,
      prose_ar: proseAr,
      prose_en: proseEn,
      spec_ar: specAr,
      spec_en: specEn,
      body_ar: needsAr(language) ? composePostBody(headlineAr, proseAr, specAr) : '',
      body_en: needsEn(language) ? composePostBody(headlineEn, proseEn, specEn) : '',
      tone,
      language,
      used_fact_ids: out.used_fact_ids,
      evidence,
      // An angle only reaches generation when rankAngles kept it, so a post that
      // passes both gates IS grounded. The flag stays on the record so a future
      // reader can filter without re-deriving.
      grounded: true,
      generated_by: generatedBy,
    };
  }

  throw new Error(`rejected after ${MAX_ATTEMPTS} attempts: ${lastViolations.join('; ')}`);
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
    const mode = body.mode ?? 'write';
    const tone: PostTone = body.tone === 'long' ? 'long' : 'short';
    const language: PostLanguage =
      body.language === 'en' ? 'en' : body.language === 'both' ? 'both' : 'ar';

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
    const cache = {};

    // ── facts mode — no tokens spent; powers the setup-stage preview ──────
    if (mode === 'facts') {
      const ids = (body.our_project_ids ?? (body.our_project_id ? [body.our_project_id] : []))
        .map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return jsonError(400, 'our_project_ids[] is required');

      const out: Array<{
        our_project_id: string;
        facts?: PostsProjectFacts;
        catalog_size?: number;
        ranked?: Array<{ angleId: string; evidence: string[]; score: number }>;
        error?: string;
      }> = [];
      for (const id of ids) {
        // Sequential on purpose: this is 3-4 cheap reads per project and keeps
        // the shared model-schema cache effective.
        // eslint-disable-next-line no-await-in-loop
        const r = await resolveFacts(jwtClient, svc, id, cache);
        if ('error' in r) {
          out.push({ our_project_id: id, error: r.error });
          continue;
        }
        const ranked = rankAngles(evidenceHaystack(r.facts), r.facts.unitTypeValues);
        out.push({
          our_project_id: id,
          facts: r.facts,
          catalog_size: buildFactCatalog(r.facts).length,
          ranked,
        });
      }
      return jsonOk({ ok: true, projects: out });
    }

    // ── write mode ────────────────────────────────────────────────────────
    const ourProjectId = body.our_project_id?.trim();
    if (!ourProjectId) return jsonError(400, 'our_project_id is required');
    const items = (body.items ?? []).filter((i) => i && i.key && angleById(i.angle));
    if (items.length === 0) return jsonError(400, 'items[] must contain at least one known angle');
    if (items.length > MAX_ITEMS_PER_REQUEST) {
      return jsonError(400, `at most ${MAX_ITEMS_PER_REQUEST} posts per request (got ${items.length})`);
    }

    const resolved = await resolveFacts(jwtClient, svc, ourProjectId, cache);
    if ('error' in resolved) return jsonError(resolved.status, resolved.error);
    const { facts } = resolved;
    const catalog = buildFactCatalog(facts);
    if (catalog.length === 0) {
      return jsonError(400, `project ${ourProjectId} has no usable data — nothing can be written about it`);
    }
    const ranked = rankAngles(evidenceHaystack(facts), facts.unitTypeValues);
    const evidenceByAngle = new Map(ranked.map((r) => [r.angleId, r.evidence]));

    // Items inside one request run concurrently; failures are reported PER POST
    // so one bad generation never sinks the rest of the batch.
    const settled = await Promise.allSettled(
      items.map((item) =>
        writeOnePost({
          facts, catalog, item, tone, language,
          evidence: evidenceByAngle.get(item.angle) ?? [],
        }),
      ),
    );
    const posts: GeneratedPost[] = [];
    const errors: Array<{ key: string; angle: string; error: string }> = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') { posts.push(r.value); return; }
      const item = items[i];
      if (!item) return;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[posts-content] post "${item.key}" (angle ${item.angle}) failed: ${msg}`);
      errors.push({ key: item.key, angle: item.angle, error: msg });
    });

    return jsonOk({ ok: true, facts, posts, errors });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
