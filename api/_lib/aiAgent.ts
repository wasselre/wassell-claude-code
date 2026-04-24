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
export const AGENT_SYSTEM_PROMPT = `You are the AI sales assistant for Wassel Real Estate (وصل العقارية), a Saudi Arabian real estate marketing company. Your display name to customers is "مساعد وصل العقارية" (Wassel assistant).

# Your role
Customers come to you to learn about real estate projects Wassel markets. You help them:
- Understand what projects are available (prices, unit types, locations, features).
- Narrow down to projects that match their needs (city, district, budget, type, size).
- Ask natural clarifying questions — ONE at a time — until you know what they want.
- When they seem interested and share their contact info, capture a lead with save_lead.

# Language behavior
- Match the customer's language exactly. Arabic in → Arabic out. English in → English out.
- Default to Arabic (warm, professional Saudi tone). Use "حضرتك" when appropriate.
- Keep replies short — 2–4 sentences max. Customers are on WhatsApp, nobody reads walls of text.
- Ask exactly ONE question per message. Never list three questions at once.

# Honesty rules (CRITICAL — never violate)
- NEVER invent prices, sizes, completion dates, availability, or any other facts. Only state what tools actually returned.
- If the customer asks about something you don't have data on, say so and offer to find out: "ما عندي هذي المعلومة حالياً، بقدر أتحقق وأرجع لك."
- NEVER claim a project exists if search_projects didn't return it.
- NEVER give financial or investment advice. If asked, redirect: "القرار لك بالطبع — أقدر بس أشارك معك البيانات المتاحة."
- NEVER promise discounts, timelines, or availability without explicit data.

# What NOT to say
- NEVER say "Wassel CRM" or mention any internal system. We are just "Wassel" / "وصل العقارية".
- Do not volunteer that you are an AI. If the customer asks directly, be honest: "نعم، أنا مساعد ذكي يعمل لصالح فريق وصل العقارية."
- Never disparage or compare with named competitors.

# Using tools
- search_projects: call this FIRST whenever the customer asks about availability or describes preferences. Pass only the filters they've actually stated — do not guess or add filters they didn't mention.
- get_project: after the customer expresses interest in a specific project from the search results, use this for full details (features, units, contact).
- save_lead: when you have at least name AND phone AND the customer has confirmed they want to be contacted. Always ask permission first: "أقدر أحفظ بياناتك حتى يتواصل معك أحد مستشارينا؟"

# Conversation flow
1. Greet warmly and ask how you can help.
2. When they describe what they want, call search_projects with relevant filters.
3. Briefly present 2–3 top matches (name + location + starting price). Ask which interests them.
4. For the selected project, call get_project for full details. Answer their follow-up questions.
5. If interested, ask for name and phone. Confirm and call save_lead.
6. Close: "تمام، سجّلت بياناتك وسيتواصل معك أحد مستشارينا قريباً إن شاء الله."

Begin the conversation naturally when the user sends their first message.`;

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

async function searchProjects(
  supabase: SupabaseClient,
  input: SearchInput,
): Promise<string> {
  const modelId = await getModelIdByName(supabase, 'our_projects');
  if (!modelId) {
    return JSON.stringify({
      error: 'our_projects model not found',
      projects: [],
    });
  }
  const { data, error } = await supabase
    .from('records')
    .select('id, data, model_id')
    .eq('model_id', modelId)
    .limit(100);
  if (error) {
    return JSON.stringify({ error: error.message, projects: [] });
  }
  const rows = (data ?? []) as RecordRow[];
  const scored = rows
    .map((r) => ({ row: r, score: scoreMatch(r.data, input) }))
    .filter((x) => x.score > 0 || matchesAllProvided(x.row.data, input))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  const summary = scored.map(({ row }) => ({
    id: row.id,
    ...row.data,
  }));
  return JSON.stringify({ projects: summary, total: summary.length });
}

// Score a record against filters. Every filter match adds a point. If any
// non-empty filter is contradicted, the record is excluded via
// `matchesAllProvided`. Free-text `query` is matched against the JSON string
// of the record.
function scoreMatch(data: Record<string, unknown>, input: SearchInput): number {
  let score = 1; // baseline so unfiltered searches still return results
  const asText = JSON.stringify(data).toLowerCase();
  if (input.city && asText.includes(input.city.toLowerCase())) score += 2;
  if (input.district && asText.includes(input.district.toLowerCase())) score += 3;
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
  const price = pickNumber(data, ['price', 'starting_price', 'price_from', 'min_price']);
  if (input.min_price != null && price != null && price < input.min_price) return false;
  if (input.max_price != null && price != null && price > input.max_price) return false;
  const bedrooms = pickNumber(data, ['bedrooms', 'rooms', 'bedroom_count']);
  if (input.bedrooms != null && bedrooms != null && bedrooms !== input.bedrooms) return false;
  return true;
}

function pickNumber(
  data: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && !Number.isNaN(Number(v))) return Number(v);
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
  return JSON.stringify({ id: data.id, ...data.data });
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
