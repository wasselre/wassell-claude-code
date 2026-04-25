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

# Search behavior (CRITICAL — this is where the agent usually gets it wrong)
- Call search_projects EARLY. The moment the customer mentions ANY signal (city, budget, property type, even "I'm looking for something"), search. Do not clarify 3 times before searching.
- Pass only filters the customer has stated. Empty filters are fine — search_projects with no filters returns a broad list.
- If search returns projects, present 2–3 top matches in ONE message. Don't ask another clarifying question first.
- If search returns NOTHING with a filter the customer mentioned (e.g. "الرياض"), try again with a looser filter (e.g. drop the district, or drop the price cap) before apologizing. Only apologize after you've actually widened the search.
- The search returns projects from three models: "our_projects" (Wassel-marketed — prioritize these), "targeted_projects", and "all_projects" (market universe). Each result has a "source" field. If you only find results in "all_projects", say so: "هذا مشروع من السوق العام، ما هو ضمن المشاريع اللي نسوّقها حالياً، لكن أقدر أربطك بأحد مستشارينا لو يهمك."

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
2. Customer describes what they want → search_projects → present top 2–3 matches with price + location.
3. Customer picks one → get_project for full details → answer follow-ups from the real data.
4. Customer interested → ask name + phone → save_lead → close warmly.

Begin when the user sends their first message.`;

type ToolUnion = Anthropic.Messages.Tool;

export const AGENT_TOOLS: ToolUnion[] = [
  {
    name: 'search_projects',
    description:
      "Search Wassel's active project portfolio. Returns up to 15 matching projects with summary info (id, title, city, district, starting price, unit types). Call this FIRST when the customer asks about availability or describes preferences. Pass only filters the customer has actually stated.",
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
  const scored = rows
    .map((r) => ({ row: r, score: scoreMatch(r.data, input) }))
    .filter((x) => x.score > 0 && matchesAllProvided(x.row.data, input))
    // Prefer our_projects > targeted > all when scores tie, so Wassel-owned
    // inventory surfaces first.
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return sourceRank(modelMap.get(a.row.model_id)) - sourceRank(modelMap.get(b.row.model_id));
    })
    .slice(0, 15);
  console.log('[search_projects] post-filter count', scored.length);
  const summary = scored.map(({ row }) => ({
    id: row.id,
    source: modelMap.get(row.model_id) ?? 'unknown',
    ...cleanRecord(row.data),
  }));
  console.log('[search_projects] returning', summary.length, 'projects');
  return JSON.stringify({ projects: summary, total: summary.length });
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
