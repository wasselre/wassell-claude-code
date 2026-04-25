/**
 * Wassel AI sales agent — shared server-side logic.
 *
 * The "brain" of the in-app AI agent: system prompt (the teaching), tool
 * schemas Claude can call, and the executor that turns tool calls into
 * Supabase reads/writes. Consumed by `api/agent.ts`.
 *
 * Design notes
 *  - Project data is fetched live from Supabase via the agent's tools — we
 *    never stuff records into the system prompt. Keeps the prompt cacheable
 *    and the token bill small.
 *  - `search_projects` scans `our_projects` only (the projects Wassel is
 *    actively marketing — what customers ask about). Add the other two
 *    project models later if needed.
 *  - Tool names and arg shapes are stable. If you change them you must also
 *    bump the system prompt so the examples stay accurate.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

export const AGENT_MODEL = 'claude-opus-4-7';
export const AGENT_MAX_TOKENS = 16_000;

// Kept in a single const so prompt caching works — every byte of the system
// prompt is deterministic and stable across requests. DO NOT interpolate
// timestamps or session ids into it. See shared/prompt-caching.md.
export const AGENT_SYSTEM_PROMPT = `You are the AI sales assistant for Wassel Real Estate (وصل العقارية), a Saudi Arabian real estate marketing company. Your display name to customers is "مساعد وصل العقارية".

# Your role
Help customers find real estate projects that match their needs, answer their questions about those projects, and — when they're ready — capture a lead.

# Information gathering — qualify BEFORE recommending (CRITICAL)

The portfolio has hundreds of projects. To make a real recommendation (not a guess) you need to narrow the customer's request first.

The five qualifying fields are:
 1. unit_type — شقة / فيلا / تاون هاوس / أرض / دور
 2. city — الرياض / جدة / الدمام / مكة / المدينة, etc.
 3. bedrooms — number of rooms
 4. price_range — minimum or maximum SAR budget (either bound is fine)
 5. district — neighborhood within the city

Asking flow:
 - Ask ONE field per message. Never bundle two or three questions in the same reply.
 - After each customer answer, acknowledge briefly ("تمام، شقة في الرياض ✨") and ask the next missing field.
 - Priority order when picking which to ask next: unit_type → city → bedrooms → price_range → district.
 - Customers can volunteer multiple fields at once ("أبي فيلا 4 غرف في جدة بميزانية مليونين") — count them all and skip past the answered questions.
 - If a customer responds "مدري" / "ما يهمني" / "مالك علاقة" / "I don't know" to a specific field, drop that question and move to the next missing one. Don't ask the same field twice.

# What to surface (CRITICAL)

After every search_projects call, the tool returns BOTH (a) the full aggregate over all matches and (b) up to 15 top picks. Which one you present depends on how qualified the request is:

- **All 5 fields known** → present 2–3 specific top picks from `top_picks`, with name + district + bedrooms + price.
- **Fewer than 5 fields known** (3 or 4 confirmed, OR customer refuses to give more) → present the aggregate, NOT specific picks. Use the `aggregate` object: total match count, top districts (with counts), price range across the matches, bedroom range. Then ask the customer to pick a slice (a district, a price ceiling, etc.) so you can narrow further.

Example aggregate reply with only city known:
 "حسب اللي قلت لي — شقة في الرياض — حصلت 84 خيار. الأسعار من 650,000 إلى 4.2 مليون ر.س، أبرز الأحياء: الياسمين (12 مشروع)، الملقا (10)، النرجس (8)، حطين (7). تحب أركّز على حي معين، أو على ميزانية محددة؟"

Do NOT pick 2–3 specific projects out of a 50+ result set without the customer first telling you which slice to focus on. That looks like guessing and isn't useful.

ABSOLUTE RULE: Never say "ما عندي مشاريع" / "ما في مشاريع متاحة" / "no projects available" — or any equivalent — without calling search_projects FIRST in the same turn. If a search returns 0 results, retry once with a looser filter (drop the district or widen the price by 30%) before announcing no results. Apologizing without searching is a failure.

The search returns projects from three models, tagged via the "source" field:
 - "our_projects" — Wassel actively markets these. Prefer these when present.
 - "targeted_projects" — projects Wassel wants to land. Second choice.
 - "all_projects" — broader Saudi market universe. Wassel knows about them but doesn't market them directly.

A result from "all_projects" is still a real result. Share it. Frame it honestly: "هذا من السوق العام، ما هو ضمن المشاريع اللي نسوّقها حالياً مباشرة، لكن أقدر أربطك بأحد مستشارينا لو يهمك."

# Reading project data
- Field names vary. The common human-readable fields are: project_name, preferred_city, preferred_neighborhoods, price_range ({min,max}), area_range ({min,max}), bedroom_range ({min,max}).
- Some fields may be missing on a given record. State only what's present. Don't invent.
- Prices are in SAR. Format them with thousand separators when presenting: "1,298,000 ر.س".

# Language behavior
- Match the customer's language exactly. Arabic in → Arabic out. English in → English out.
- Default to Arabic (warm, professional Saudi tone). Use "حضرتك" when appropriate.
- Replies: 2–4 sentences. Customers are on WhatsApp — no walls of text.
- Ask at most ONE clarifying question per message, and only when necessary (budget if they said "cheap", city if they said "apartment" with no location). Never list multiple questions.

# Honesty rules
- NEVER invent prices, sizes, completion dates, availability. Only state what tools actually returned.
- If asked about something not in the data: "ما عندي هذي المعلومة حالياً، بقدر أتحقق وأرجع لك."
- No financial advice. If asked: "القرار لك بالطبع — أقدر بس أشارك معك البيانات المتاحة."
- No promises about discounts, timelines, or availability without data.

# What NOT to say
- NEVER say "Wassel CRM" or name any internal system. We are "Wassel" / "وصل العقارية".
- Don't volunteer you're an AI. If asked directly: "نعم، أنا مساعد ذكي يعمل لصالح فريق وصل العقارية."
- No competitor disparagement or comparison.

# Lead capture
- Ask for name + phone only after the customer shows real interest in a specific project or asks to be contacted.
- Always confirm before saving: "أقدر أحفظ بياناتك حتى يتواصل معك أحد مستشارينا؟"
- After save_lead succeeds: "تمام، سجّلت بياناتك وسيتواصل معك أحد مستشارينا قريباً إن شاء الله."

# Conversation shape (default)
1. Short greeting + ask how you can help (ONE message).
2. Customer describes a need. Count how many of the 5 qualifying fields they've given.
3. Ask ONE missing field per message in priority order (unit_type → city → bedrooms → price_range → district), acknowledging each answer. If the customer refuses a specific field, skip it and ask the next.
4. Whenever you call search_projects: if all 5 fields are known, present 2–3 specific top picks from `top_picks`. Otherwise present the `aggregate` (count, top districts, price range) and ask the customer which slice to focus on.
5. Once narrowed to a specific project, call get_project for full details and answer follow-ups from the real data.
6. Customer interested → ask name + phone → save_lead → close warmly.

Begin when the user sends their first message.`;

type ToolUnion = Anthropic.Messages.Tool;

export const AGENT_TOOLS: ToolUnion[] = [
  {
    name: 'search_projects',
    description:
      "Search Wassel's project portfolio (our_projects + targeted_projects + all_projects). Returns BOTH an `aggregate` over the full match set (total count, top districts with counts, price range, bedroom range) AND `top_picks` (up to 15 ranked specific projects). When the customer's request is fully qualified (all 5 of unit_type/city/bedrooms/price_range/district are known), show specific projects from top_picks. When the request is under-qualified, show the aggregate so the customer can pick a slice to drill into.",
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name in Arabic or English, e.g. "الرياض" or "Riyadh".',
        },
        district: {
          type: 'string',
          description: 'District / neighborhood, e.g. "حي الياسمين".',
        },
        property_type: {
          type: 'string',
          description: 'Property type, e.g. "شقة", "فيلا", "أرض", "apartment", "villa", "land".',
        },
        min_price: { type: 'number', description: 'Minimum price in SAR.' },
        max_price: { type: 'number', description: 'Maximum price in SAR.' },
        bedrooms: { type: 'number', description: 'Desired number of bedrooms.' },
        query: {
          type: 'string',
          description:
            'Free-text search across project name, description, and location. Use this when the customer mentions keywords not covered by the other fields.',
        },
      },
    },
  },
  {
    name: 'get_project',
    description:
      'Fetch the full record of a specific project by its id (returned by search_projects). Use this once the customer has shown interest in one project and needs more detail.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The `id` value returned by search_projects.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'save_lead',
    description:
      'Create a new client record in the CRM once the customer has shared their name and phone and explicitly agreed to be contacted by a Wassel advisor. Ask permission before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer full name.' },
        phone: {
          type: 'string',
          description: 'Customer phone number. Include country code if known (default +966 for Saudi).',
        },
        city: { type: 'string', description: 'City the customer is looking in.' },
        district: { type: 'string', description: 'District the customer is looking in.' },
        budget_max: { type: 'number', description: 'Customer max budget in SAR.' },
        interested_project_id: {
          type: 'string',
          description: 'Project id the customer showed strong interest in, if any.',
        },
        notes: {
          type: 'string',
          description:
            'Free-text summary of preferences, constraints, and anything notable from the conversation.',
        },
      },
      required: ['name', 'phone'],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────

// Keep the raw record shape loose — the agent consumes record.data as JSON,
// so we don't need typed access to every possible project field.
interface RecordRow {
  id: string;
  data: Record<string, unknown>;
  model_id: string;
}

async function getModelIdByName(
  supabase: SupabaseClient,
  name: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('models')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  if (error || !data) return null;
  return data.id as string;
}

interface SearchInput {
  city?: string;
  district?: string;
  property_type?: string;
  min_price?: number;
  max_price?: number;
  bedrooms?: number;
  query?: string;
}

// Project-search scope: all three project models unioned. In the current
// data, `our_projects` is often empty while `all_projects` holds the full
// market universe — searching just one misses inventory. We tag each result
// with `source` so the agent can prioritize Wassel-marketed projects when
// multiple models have matches.
const PROJECT_MODELS = ['our_projects', 'targeted_projects', 'all_projects'] as const;

async function searchProjects(
  supabase: SupabaseClient,
  input: SearchInput,
): Promise<string> {
  console.log('[search_projects] input', JSON.stringify(input));
  const modelMap = new Map<string, string>(); // model_id → model_name
  for (const name of PROJECT_MODELS) {
    const id = await getModelIdByName(supabase, name);
    if (id) modelMap.set(id, name);
  }
  console.log('[search_projects] models found', modelMap.size, [...modelMap.values()]);
  if (modelMap.size === 0) {
    return JSON.stringify({ error: 'no project models found', projects: [] });
  }

  const { data, error } = await supabase
    .from('records')
    .select('id, data, model_id')
    .in('model_id', [...modelMap.keys()])
    .limit(500);
  if (error) {
    console.log('[search_projects] supabase error', error.message);
    return JSON.stringify({ error: error.message, projects: [] });
  }
  const rows = (data ?? []) as RecordRow[];
  console.log('[search_projects] rows fetched', rows.length);
  const allMatches = rows
    .map((r) => ({ row: r, score: scoreMatch(r.data, input) }))
    .filter((x) => x.score > 0 && matchesAllProvided(x.row.data, input))
    // Prefer our_projects > targeted > all when scores tie, so Wassel-owned
    // inventory surfaces first.
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return sourceRank(modelMap.get(a.row.model_id)) - sourceRank(modelMap.get(b.row.model_id));
    });
  console.log('[search_projects] total matches', allMatches.length);

  const top = allMatches.slice(0, 15).map(({ row }) => ({
    id: row.id,
    source: modelMap.get(row.model_id) ?? 'unknown',
    ...cleanRecord(row.data),
  }));
  const aggregate = aggregateMatches(allMatches.map((m) => m.row));
  console.log('[search_projects] returning', top.length, 'top picks +', aggregate.total, 'aggregate');
  return JSON.stringify({
    total: aggregate.total,
    aggregate,
    top_picks: top,
  });
}

// Aggregate stats over the FULL match set (not just the top 15 picks). The
// prompt directs the agent to surface these when fewer than all 5
// qualifying fields are known — better than guessing 3 results out of
// hundreds. Customer self-narrows by picking a district / price band.
function aggregateMatches(rows: RecordRow[]): {
  total: number;
  by_city: Record<string, number>;
  top_districts: Array<{ district: string; count: number }>;
  top_unit_types: Array<{ type: string; count: number }>;
  price_range_overall: { min: number; max: number } | null;
  bedroom_range_overall: { min: number; max: number } | null;
} {
  const byCity: Record<string, number> = {};
  const byDistrict: Record<string, number> = {};
  const byUnit: Record<string, number> = {};
  let pmin = Infinity;
  let pmax = -Infinity;
  let bmin = Infinity;
  let bmax = -Infinity;

  for (const r of rows) {
    const d = r.data;
    const city = d.preferred_city;
    if (typeof city === 'string' && city.trim()) byCity[city] = (byCity[city] ?? 0) + 1;
    const district = d.preferred_neighborhoods;
    if (typeof district === 'string' && district.trim())
      byDistrict[district] = (byDistrict[district] ?? 0) + 1;
    // Unit type lives under various slugs depending on how the model was
    // built. We just collect anything plausibly-typed for honesty.
    for (const k of ['unit_type', 'property_type', 'type']) {
      const v = d[k];
      if (typeof v === 'string' && v.trim()) byUnit[v] = (byUnit[v] ?? 0) + 1;
    }
    const lp = pickRangeMin(d, ['price_range', 'price']);
    const hp = pickRangeMax(d, ['price_range', 'price']);
    if (lp != null) pmin = Math.min(pmin, lp);
    if (hp != null) pmax = Math.max(pmax, hp);
    const lb = pickRangeMin(d, ['bedroom_range', 'bedrooms', 'rooms']);
    const hb = pickRangeMax(d, ['bedroom_range', 'bedrooms', 'rooms']);
    if (lb != null) bmin = Math.min(bmin, lb);
    if (hb != null) bmax = Math.max(bmax, hb);
  }

  const topDistricts = Object.entries(byDistrict)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([district, count]) => ({ district, count }));
  const topUnits = Object.entries(byUnit)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  return {
    total: rows.length,
    by_city: byCity,
    top_districts: topDistricts,
    top_unit_types: topUnits,
    price_range_overall:
      pmin === Infinity || pmax === -Infinity ? null : { min: pmin, max: pmax },
    bedroom_range_overall:
      bmin === Infinity || bmax === -Infinity ? null : { min: bmin, max: bmax },
  };
}

function sourceRank(name: string | undefined): number {
  if (name === 'our_projects') return 0;
  if (name === 'targeted_projects') return 1;
  return 2;
}

// Strip opaque `item_*` foreign-key slugs so Claude doesn't waste tokens
// or hallucinate explanations for them. Keeps any field with a human-
// readable name (project_name, preferred_city, price_range, etc.).
function cleanRecord(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('item_')) continue;
    if (v === '#REF' || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// Score a record against filters. Every filter match adds a point. Free-
// text `query` is matched against the JSON string of the record.
function scoreMatch(data: Record<string, unknown>, input: SearchInput): number {
  let score = 1; // baseline so unfiltered searches still return results
  const asText = JSON.stringify(data).toLowerCase();
  if (input.city && asText.includes(input.city.toLowerCase())) score += 3;
  if (input.district && asText.includes(input.district.toLowerCase())) score += 4;
  if (input.property_type && asText.includes(input.property_type.toLowerCase())) score += 2;
  if (input.query) {
    for (const term of input.query.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (asText.includes(term)) score += 1;
    }
  }
  return score;
}

function matchesAllProvided(
  data: Record<string, unknown>,
  input: SearchInput,
): boolean {
  const priceMin = pickRangeMin(data, ['price_range', 'price']);
  const priceMax = pickRangeMax(data, ['price_range', 'price']);
  if (input.max_price != null && priceMin != null && priceMin > input.max_price) return false;
  if (input.min_price != null && priceMax != null && priceMax < input.min_price) return false;

  const bedroomMin = pickRangeMin(data, ['bedroom_range', 'bedrooms', 'rooms']);
  const bedroomMax = pickRangeMax(data, ['bedroom_range', 'bedrooms', 'rooms']);
  if (input.bedrooms != null) {
    if (bedroomMin != null && input.bedrooms < bedroomMin) return false;
    if (bedroomMax != null && input.bedrooms > bedroomMax) return false;
  }
  return true;
}

// Range-aware number extractor. Handles `{min, max}` objects (the shape used
// by `price_range` / `bedroom_range` / `area_range` in this project's data),
// falls back to a flat number when the field is plain.
function pickRangeMin(data: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && 'min' in v) {
      const m = (v as { min?: unknown }).min;
      if (typeof m === 'number') return m;
    }
  }
  return null;
}

function pickRangeMax(data: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && 'max' in v) {
      const m = (v as { max?: unknown }).max;
      if (typeof m === 'number') return m;
    }
  }
  return null;
}

async function getProject(
  supabase: SupabaseClient,
  input: { project_id: string },
): Promise<string> {
  const { data, error } = await supabase
    .from('records')
    .select('id, data, model_id')
    .eq('id', input.project_id)
    .maybeSingle();
  if (error || !data) {
    return JSON.stringify({ error: error?.message ?? 'project not found' });
  }
  return JSON.stringify({ id: data.id, ...cleanRecord(data.data) });
}

interface LeadInput {
  name: string;
  phone: string;
  city?: string;
  district?: string;
  budget_max?: number;
  interested_project_id?: string;
  notes?: string;
}

async function saveLead(
  supabase: SupabaseClient,
  input: LeadInput,
  userId: string,
): Promise<string> {
  const clientsModelId = await getModelIdByName(supabase, 'clients');
  if (!clientsModelId) {
    return JSON.stringify({ error: 'clients model not found' });
  }
  const leadData: Record<string, unknown> = {
    name: input.name,
    phone: input.phone,
    source: 'ai_agent',
  };
  if (input.city) leadData.city = input.city;
  if (input.district) leadData.district = input.district;
  if (input.budget_max != null) leadData.budget_max = input.budget_max;
  if (input.interested_project_id) leadData.interested_project_id = input.interested_project_id;
  if (input.notes) leadData.notes = input.notes;

  const { data, error } = await supabase
    .from('records')
    .insert({
      model_id: clientsModelId,
      data: leadData,
      created_by: userId,
    })
    .select('id')
    .single();
  if (error || !data) {
    return JSON.stringify({ error: error?.message ?? 'failed to create lead' });
  }
  return JSON.stringify({
    ok: true,
    lead_id: data.id,
    message: 'Lead saved. A Wassel advisor will follow up.',
  });
}

/**
 * Dispatch a tool call to its handler and return the JSON string Claude will
 * see as the tool result. Unknown tool names don't throw — they return an
 * error object so the agent can recover.
 */
export async function executeAgentTool(
  name: string,
  input: unknown,
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  try {
    switch (name) {
      case 'search_projects':
        return await searchProjects(supabase, (input ?? {}) as SearchInput);
      case 'get_project':
        return await getProject(supabase, input as { project_id: string });
      case 'save_lead':
        return await saveLead(supabase, input as LeadInput, userId);
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
