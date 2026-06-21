/**
 * Wassel Project Matching Assistant — shared server-side logic (Phase 1, MVP).
 *
 * The "brain" of the live-call sales co-pilot: a system prompt, the tools Claude
 * can call, and the executor that turns tool calls into Supabase reads. Consumed
 * by `api/match.ts`. Forked from `api/_lib/copywriterAgent.ts` — same SSE wire
 * format and tool-loop shape; only the prompt / tools / executor differ.
 *
 * Design notes (Phase 1 — TEXT MATCHING ONLY, no geo)
 *  - DETERMINISTIC scoring lives HERE, in `match_projects`. The LLM only narrates
 *    over the verified, scored, fact-checked output. It never sees a project it
 *    can invent and never computes a score it can fudge. This is the
 *    anti-hallucination guarantee.
 *  - TWO TIERS, NEVER MIXED. Tier 1 = projects in the `our_projects` model
 *    (the curated portfolio with real units). Tier 2 = the rest of `all_projects`
 *    (scraped/competitor data that must be VERIFIED before being offered). The
 *    tool returns them in SEPARATE arrays and only falls back to Tier 2 when
 *    Tier 1 has no GOOD match.
 *  - Coordinates / distance / nearby-district logic is PHASE 2. Phase 1 uses
 *    district + city TEXT only: exact district → full credit, same city → half.
 *  - Reads go through the `unified_records` view (frozen-safe) and paginate to
 *    dodge the PostgREST 1000-row truncation (same posture as the other agents).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

export const MATCH_MODEL = 'claude-opus-4-7';
export const MATCH_MAX_TOKENS = 8_000;

// Phase 1 scoring weights (sum = 100). The score is a weighted average over the
// dimensions the customer actually specified (availability always counts), so an
// unspecified dimension neither penalizes nor inflates — see scoreProject().
const WEIGHTS = {
  location: 30,
  budget: 25,
  type: 20,
  area: 10,
  bedrooms: 8,
  availability: 5,
  amenities: 2,
} as const;

// Band thresholds over the 0–100 score.
const STRONG = 75;
// A Tier-1 (our_projects) result at/above GOOD suppresses the Tier-2 fallback —
// i.e. we only reach into all_projects when our portfolio has nothing this good.
const GOOD = 60;
const MIN_RETURN = 40; // never surface a project below this
const STRETCH_TOLERANCE = 1.15; // a unit up to 15% over budget is a "stretch"
const TOP_N = 5; // max results returned per tier

// Deterministic, stable across requests → prompt-cacheable. DO NOT interpolate.
export const MATCH_SYSTEM_PROMPT = `You are Wassel's Sales Assistant (مساعد المبيعات) — a live-call sales co-pilot for Wassel Real Estate (وصل العقارية). You are ONE assistant with a growing set of capabilities; the salesperson talks to you in plain language and you do the right thing.

Your FIRST and currently-active capability is PROJECT MATCHING + SALES-PITCH GENERATION: when a salesperson describes what a customer wants, you find the best-fit project and give them the exact words to say on the call. (More capabilities — next-best-action with a lead, follow-up messages, project comparison — will live inside this SAME assistant later; they are NOT built yet.)

A salesperson is often ON A CALL with a customer RIGHT NOW and needs the best-matching project in seconds. Be fast, concrete, honest, and persuasive.

If the salesperson asks for something outside project matching (what to do next with a lead, a follow-up/WhatsApp message, comparing two projects, is-this-lead-hot-or-cold), briefly tell them that capability is coming soon to this same assistant. You MAY give a short, sensible pointer ONLY from real project facts you can retrieve — but never invent customer history, lead status, distances, or any data you don't have. Your primary job right now is the best project + the pitch.

# How you work
The customer describes what they want (district, city, property type, budget, area, bedrooms, lifestyle…). You:
1. Extract the structured requirements from the salesperson's message.
2. Call match_projects with those requirements. The tool does ALL the searching, tiering, and scoring — you do NOT search or score yourself.
3. (Optional) Call get_project on the top 1–2 picks to pull richer selling points (amenities, guarantees, services).
4. Present the ranked recommendation in the chat, then call emit_recommendation with the SAME content as structured data so the app renders a recommendation card.

# The two tiers — NEVER mix them
match_projects returns up to two SEPARATE groups:
- our_projects — OUR curated, verified portfolio. Recommend these confidently.
- all_projects — the broad database (mostly scraped / competitor data). It is UNVERIFIED. The tool only returns this group when there is NO good match in our_projects (used_fallback = true). When you present an all_projects result you MUST open with a clear warning: "⚠️ These are from the All Projects database and must be VERIFIED (price, availability, details) before offering them to the customer." Every all_projects result carries data_source:"all_projects" and requires_verification:true — surface that warning.
If used_fallback is true but our_projects.results still has entries, those are WEAKER in-portfolio options — you may mention them, clearly separated from the all_projects list. Never blend the two into one ranked list.

# Location (Phase 1 — text only)
- match_projects matches district + city as TEXT. There is NO distance/nearby-district logic yet (that's a later phase) — never claim a project is "X km away" or invent proximity.
- If no project matches the exact district, the tool sets district_exact_match:false and returns same-city alternatives (match_type:"same_city"). Tell the salesperson plainly: "No exact match in <district>, but here are options in the same city (<city>)." Do NOT imply they're in the requested district.

# Anti-hallucination — the most important rule
- State ONLY facts present in a tool result's "facts" (or get_project) — price_range, area_range, bedroom_range, bathroom_range, available_units, unit_types, city, district, project_status, amenities.
- NEVER invent or estimate a price, area, availability, location, amenity, guarantee, or any number. If a detail is missing, say "غير متوفر في البيانات / not available in the data" and add it to the questions to ask the customer.
- Each result carries data_gaps (what's missing) and missing_info (what to confirm). Use them.
- If match_projects returns no result at/above a usable score, say so directly and tell the salesperson which single requirement to relax (budget, district, type). Do NOT pad with weak options dressed up as good ones.

# Vague or thin requests
- If the salesperson gives too little to match well (e.g. only a city, or nothing concrete), ask ONE or TWO sharp questions FIRST (budget? district? villa or apartment? bedrooms?) before calling the tool. Don't guess.
- If the budget looks unrealistic for the requested area/type, say it plainly and show the closest real options + the gap.

# The match score & band are DETERMINISTIC — never change them
match_projects already computed each result's score, match_band, match_type, data_source, and requires_verification. These are the system's ranking metadata. You MUST use them EXACTLY as returned. You may NOT re-score, re-band, upgrade, downgrade, round, reinterpret, or rename a match's quality — not in your chat text, and not in emit_recommendation. If the tool says a project is "44 / partial", you say "44 / partial"; you never call it "good" because the location or price looks strong to you. Add narrative explanation freely, but the number and the band are fixed by the tool. The order you present picks in must follow the tool's order (best first).

# Output (in the chat, before emit_recommendation)
Lead with the single best match, then any runners-up. For each pick give:
- The project name + the EXACT match band (strong / good / partial) and score from match_projects — quoted verbatim, never your own assessment.
- Why it fits (tie it to the customer's stated requirements).
- Key specs — ONLY from facts (price range, area range, bedrooms/bathrooms, available units, city/district, type).
- 2–3 key selling points (factual).
- A نبذة / pitch — the exact sentence(s) the salesperson can say on the call (Arabic, warm, confident Saudi real-estate tone, SAR formatted like 1,990,000 ر.س).
- A verification warning if it's an all_projects result.
- The questions to ask the customer to refine the match (from missing_info / data_gaps).

# Then call emit_recommendation
After writing the recommendation in the chat, call emit_recommendation with the structured picks so the app shows the card. For each pick, copy these fields VERBATIM from the matching match_projects result by project_id: score, match_band, match_type, data_source, requires_verification. Do not alter them. The narrative fields (why, specs, selling_points, pitch, warning, missing_info) describe the project from its facts — never invent detail. Add ONE short closing line.

# Voice & brand
- Reply in Arabic by default (mirror the salesperson's language if they write in English). We are "وصل العقارية" / "Wassel" — never name any internal system or tool, never say "Wassel CRM". SAR currency. Keep it call-ready and tight; this is a co-pilot whispering in the rep's ear, not an essay.

Begin when the salesperson sends the customer's requirements.`;

type ToolUnion = Anthropic.Messages.Tool;

export const MATCH_TOOLS: ToolUnion[] = [
  {
    name: 'match_projects',
    description:
      "Search Wassel's projects for the best fit to a customer's requirements and return RANKED, SCORED, fact-checked candidates. Searches the curated our_projects portfolio FIRST; only if there is no good match there does it fall back to the broad all_projects database (returned separately, flagged requires_verification). Phase 1 matches location by district/city TEXT only (no distance). Returns two never-mixed groups (our_projects, all_projects), each result carrying its score, match band, the project's real facts, data gaps, and questions to ask. Call this once per customer requirement set; do not search or score yourself.",
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Requested city, e.g. "الرياض" / "Riyadh".' },
        district: { type: 'string', description: 'Requested district / neighborhood, e.g. "النرجس".' },
        property_type: {
          type: 'string',
          description: 'Desired unit type as the customer said it: villa/townhouse/apartment/floor/duplex/studio/land or فيلا/تاون هاوس/شقة/دور/دوبلكس/استوديو/أرض. Synonyms + Arabic/English are handled.',
        },
        budget_min: { type: 'number', description: 'Minimum budget in SAR (optional).' },
        budget_max: { type: 'number', description: 'Maximum budget in SAR.' },
        area_min: { type: 'number', description: 'Minimum area in m² (optional).' },
        area_max: { type: 'number', description: 'Maximum area in m² (optional).' },
        bedrooms: { type: 'number', description: 'Desired number of bedrooms.' },
        lifestyle: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lifestyle / preference keywords (family, privacy, luxury, investment, near_services) or specific amenities. Matched best-effort against project amenities (low weight in Phase 1).',
        },
        amenities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit required amenities, e.g. "غرفة خادمة", "مسبح".',
        },
        financing_needed: { type: 'boolean', description: 'Customer needs financing (noted for follow-up; not scored in Phase 1).' },
        special_requirements: { type: 'array', items: { type: 'string' }, description: 'Any other special requirements (noted; not scored in Phase 1).' },
        allow_stretch: { type: 'boolean', description: 'Allow options up to 15% over budget_max as "stretch" matches. Default true.' },
        include_sold_out: { type: 'boolean', description: 'Include projects with zero available units. Default false (sold-out is excluded).' },
      },
    },
  },
  {
    name: 'get_project',
    description:
      'Fetch the full fact sheet of one project (from match_projects results) by its id. Returns two groups: `details` (team-entered: developer, unit types, amenities, city, district, location, brochure, stage, guarantees, services) and `calculated` — the AUTO-CALCULATED rollups from the project\'s units (price/area/bedroom/bathroom ranges, unit counts, average price per m²). The calculated numbers are real — use them as the pricing/size facts. Only state values that are present; never invent.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The `project_id` returned by match_projects.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'emit_recommendation',
    description:
      'Deliver the FINAL ranked recommendation as STRUCTURED data so the app renders it as a recommendation card for the salesperson. Call this AFTER you have written the recommendation in the chat. The ranking metadata — score, match_band, match_type, data_source, requires_verification — MUST be copied VERBATIM from the matching match_projects result (by project_id); do not re-score, re-band, upgrade, downgrade, or rename. (The server also enforces this server-side, but pass the correct values.) The narrative fields come from the project facts — never invent or enrich.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line overall result, e.g. "Strong match in our projects" or "No good in-portfolio match — these need verification".' },
        data_source: { type: 'string', enum: ['our_projects', 'all_projects', 'mixed'], description: 'Where the recommendations came from. Use "all_projects" or "mixed" only when the fallback was used.' },
        requires_verification: { type: 'boolean', description: 'True if any recommendation is from all_projects and must be verified before offering.' },
        recommendations: {
          type: 'array',
          description: 'Ranked picks, best first.',
          items: {
            type: 'object',
            properties: {
              project_id: { type: 'string', description: 'The project_id from match_projects.' },
              project_name: { type: 'string' },
              data_source: { type: 'string', enum: ['our_projects', 'all_projects'] },
              requires_verification: { type: 'boolean' },
              score: { type: 'number', description: 'The 0–100 score from match_projects.' },
              match_band: { type: 'string', enum: ['strong', 'good', 'partial'] },
              match_type: { type: 'string', enum: ['exact', 'same_city', 'stretch', 'partial'] },
              why: { type: 'string', description: 'Why it fits the customer (tie to their requirements).' },
              specs: {
                type: 'object',
                description: 'Key specs — ONLY from facts. Omit anything missing.',
                properties: {
                  city: { type: 'string' },
                  district: { type: 'string' },
                  unit_types: { type: 'string', description: 'Comma-joined unit types.' },
                  price_range: { type: 'string', description: 'Formatted, e.g. "519,000 – 1,149,000 ر.س".' },
                  area_range: { type: 'string', description: 'e.g. "89 – 310 م²".' },
                  bedrooms: { type: 'string', description: 'e.g. "1 – 3".' },
                  bathrooms: { type: 'string' },
                  available_units: { type: 'string' },
                  project_status: { type: 'string' },
                },
              },
              selling_points: { type: 'array', items: { type: 'string' }, description: '2–3 factual selling points.' },
              pitch: { type: 'string', description: 'The exact sentence(s) the salesperson can say on the call.' },
              warning: { type: 'string', description: 'Verification warning for all_projects picks (optional).' },
              missing_info: { type: 'array', items: { type: 'string' }, description: 'Questions to ask the customer / data to confirm.' },
            },
            required: ['project_id', 'project_name', 'score', 'match_band', 'why', 'pitch'],
          },
        },
        questions_to_ask: { type: 'array', items: { type: 'string' }, description: 'Overall clarifying questions for the customer.' },
      },
      required: ['summary', 'recommendations'],
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

interface RecordRow {
  id: string;
  data: Record<string, unknown>;
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const asNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Normalize for text matching: Arabic-Indic digits → Western, lowercase,
 *  collapse whitespace, trim. Mirrors copywriterAgent.normalizeForSearch. */
function normalizeForSearch(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0660 && c <= 0x0669) out += String(c - 0x0660); // ٠-٩
    else if (c >= 0x06f0 && c <= 0x06f9) out += String(c - 0x06f0); // ۰-۹
    else out += ch;
  }
  return out.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Bidirectional substring match after normalization (so "النرجس" matches
 *  "حي النرجس" and vice-versa). Empty needle → false. */
function fuzzyContains(haystack: string, needle: string): boolean {
  const h = normalizeForSearch(haystack);
  const n = normalizeForSearch(needle);
  if (!n || !h) return false;
  return h.includes(n) || n.includes(h);
}

/** `{min,max}` range extractor — handles the stored range object shape and a
 *  flat number. Returns nulls when absent. */
function pickRange(data: Record<string, unknown>, key: string): { min: number | null; max: number | null } | null {
  const v = data[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const min = asNum(o.min);
    const max = asNum(o.max);
    if (min == null && max == null) return null;
    return { min, max };
  }
  const flat = asNum(v);
  if (flat != null) return { min: flat, max: flat };
  return null;
}

// Property-type synonyms — singular/plural + Arabic/English forms. Ported from
// api/_lib/aiAgent.ts. The live data even mixes "apartment"/"apartments" within
// unit_types, so matching one form must pull in the other.
const PROPERTY_TYPE_SYNONYMS: ReadonlyArray<readonly string[]> = [
  ['apartment', 'apartments', 'apt', 'flat', 'flats', 'penthouse', 'شقة', 'شقق', 'بنتهاوس'],
  ['villa', 'villas', 'فيلا', 'فلل'],
  ['townhouse', 'townhouses', 'تاون هاوس', 'تاون-هاوس', 'تاون'],
  ['studio', 'studios', 'استوديو', 'ستوديو'],
  ['duplex', 'duplexes', 'دبلكس', 'دوبلكس'],
  ['floor', 'floors', 'دور', 'أدوار', 'ادوار'],
  ['land', 'lands', 'plot', 'plots', 'أرض', 'ارض', 'اراضي', 'أراضي'],
];

function expandPropertyType(needle: string): string[] {
  const lower = normalizeForSearch(needle);
  for (const group of PROPERTY_TYPE_SYNONYMS) {
    if (group.some((s) => normalizeForSearch(s) === lower)) return group.map((s) => normalizeForSearch(s));
  }
  return [lower];
}

async function getModelByName(
  supabase: SupabaseClient,
  name: string,
): Promise<{ id: string; schema: unknown } | null> {
  const { data, error } = await supabase.from('models').select('id, schema').eq('name', name).maybeSingle();
  if (error || !data) return null;
  return { id: data.id as string, schema: data.schema };
}

/** Page every record of a model via unified_records (frozen-safe + truncation-safe). */
async function pageRecords(supabase: SupabaseClient, modelId: string, maxPages = 20): Promise<RecordRow[]> {
  const pageSize = 1000;
  const rows: RecordRow[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await supabase
      .from('unified_records')
      .select('id, data')
      .eq('model_id', modelId)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as RecordRow[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

/** The set of all_projects record ids that are in the curated our_projects
 *  model — these are Tier 1. our_projects.project is a single lookup holding the
 *  all_projects id (string); tolerate an array form defensively. */
async function loadTier1ProjectIds(supabase: SupabaseClient): Promise<Set<string>> {
  const model = await getModelByName(supabase, 'our_projects');
  const ids = new Set<string>();
  if (!model) return ids;
  const rows = await pageRecords(supabase, model.id, 5);
  for (const r of rows) {
    const link = r.data.project;
    if (typeof link === 'string' && link) ids.add(link);
    else if (Array.isArray(link)) for (const x of link) if (typeof x === 'string' && x) ids.add(x);
  }
  return ids;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export interface MatchRequirements {
  city?: string;
  district?: string;
  property_type?: string;
  budget_min?: number;
  budget_max?: number;
  area_min?: number;
  area_max?: number;
  bedrooms?: number;
  lifestyle?: string[];
  amenities?: string[];
  financing_needed?: boolean;
  special_requirements?: string[];
  allow_stretch?: boolean;
  include_sold_out?: boolean;
}

interface DimScore {
  /** 0..1, or null when the dimension doesn't apply (excluded from the average). */
  value: number | null;
}

interface ScoredProject {
  score: number;
  band: 'strong' | 'good' | 'partial';
  match_type: 'exact' | 'same_city' | 'stretch' | 'partial';
  district_exact: boolean;
  available_units_zero: boolean;
  breakdown: Record<string, number | null>;
  data_gaps: string[];
  missing_info: string[];
  facts: Record<string, unknown>;
}

/** Deterministic fit score for one all_projects record. Pure text matching
 *  (Phase 1) — no coordinates. */
function scoreProject(data: Record<string, unknown>, req: MatchRequirements): ScoredProject {
  const gaps: string[] = [];
  const missing: string[] = [];
  const dims: Record<keyof typeof WEIGHTS, DimScore> = {
    location: { value: null },
    budget: { value: null },
    type: { value: null },
    area: { value: null },
    bedrooms: { value: null },
    availability: { value: null },
    amenities: { value: null },
  };

  // ── Location (text only) ──
  let districtExact = false;
  let matchType: ScoredProject['match_type'] = 'partial';
  const projDistrict = asStr(data.preferred_neighborhoods);
  const projCity = asStr(data.preferred_city);
  if (req.district || req.city) {
    const districtMatch = !!req.district && fuzzyContains(projDistrict, req.district);
    const cityMatch = !!req.city && fuzzyContains(projCity, req.city);
    if (req.district) {
      if (districtMatch) {
        dims.location.value = 1;
        districtExact = true;
        matchType = 'exact';
      } else if (cityMatch) {
        dims.location.value = 0.5;
        matchType = 'same_city';
      } else {
        dims.location.value = 0;
      }
    } else {
      // Only city requested → city is the most specific ask.
      dims.location.value = cityMatch ? 1 : 0;
      if (cityMatch) matchType = 'exact';
    }
  }

  // ── Budget (SAR) ──
  if (req.budget_max != null || req.budget_min != null) {
    const range = pickRange(data, 'price_range');
    if (!range || (range.min == null && range.max == null)) {
      gaps.push('no price data');
      missing.push('Confirm the project pricing');
    } else {
      const pmin = range.min ?? range.max ?? 0;
      const pmax = range.max ?? range.min ?? pmin;
      const lo = req.budget_min ?? 0;
      const hi = req.budget_max ?? Number.POSITIVE_INFINITY;
      const overlaps = pmax >= lo && pmin <= hi;
      if (overlaps) {
        dims.budget.value = 1;
      } else if (pmin > hi) {
        const allowStretch = req.allow_stretch !== false;
        if (allowStretch && pmin <= hi * STRETCH_TOLERANCE) {
          dims.budget.value = 0.5;
          if (matchType === 'partial' || matchType === 'same_city') matchType = 'stretch';
        } else {
          dims.budget.value = 0;
        }
      } else {
        // Entirely below the customer's floor — wrong segment, mild credit.
        dims.budget.value = 0.2;
      }
    }
  }

  // ── Property type ──
  if (req.property_type) {
    const types = asArr(data.unit_types).map((t) => normalizeForSearch(t));
    if (types.length === 0) {
      gaps.push('no unit type data');
      missing.push('Confirm the available unit types');
    } else {
      const needles = expandPropertyType(req.property_type);
      const hit = types.some((t) => needles.some((n) => t.includes(n) || n.includes(t)));
      dims.type.value = hit ? 1 : 0;
    }
  }

  // ── Area (m²) ──
  if (req.area_max != null || req.area_min != null) {
    const range = pickRange(data, 'area_range');
    if (!range || (range.min == null && range.max == null)) {
      gaps.push('no area data');
    } else {
      const amin = range.min ?? range.max ?? 0;
      const amax = range.max ?? range.min ?? amin;
      const lo = req.area_min ?? 0;
      const hi = req.area_max ?? Number.POSITIVE_INFINITY;
      if (amax >= lo && amin <= hi) dims.area.value = 1;
      else {
        // Within 15% of the requested band → half credit.
        const near = amin > hi ? amin <= hi * 1.15 : amax >= lo * 0.85;
        dims.area.value = near ? 0.5 : 0;
      }
    }
  }

  // ── Bedrooms ──
  if (req.bedrooms != null) {
    const range = pickRange(data, 'bedroom_range');
    if (!range || (range.min == null && range.max == null)) {
      gaps.push('no bedroom data');
    } else {
      const bmin = range.min ?? range.max ?? 0;
      const bmax = range.max ?? range.min ?? bmin;
      if (req.bedrooms >= bmin && req.bedrooms <= bmax) dims.bedrooms.value = 1;
      else if (req.bedrooms >= bmin - 1 && req.bedrooms <= bmax + 1) dims.bedrooms.value = 0.6;
      else dims.bedrooms.value = 0;
    }
  }

  // ── Availability (always applies — intrinsic quality signal) ──
  const avail = asNum(data.available_units);
  let availZero = false;
  if (avail == null) {
    dims.availability.value = 0.5; // unknown
    gaps.push('no availability data');
  } else if (avail > 0) {
    dims.availability.value = 1;
  } else {
    dims.availability.value = 0;
    availZero = true;
  }

  // ── Amenities / lifestyle (best-effort, low weight) ──
  const wanted = [...(req.lifestyle ?? []), ...(req.amenities ?? [])].map((s) => s).filter(Boolean);
  if (wanted.length > 0) {
    const have = asArr(data.preferred_amenities);
    let matched = 0;
    for (const w of wanted) if (have.some((h) => fuzzyContains(h, w))) matched += 1;
    dims.amenities.value = matched / wanted.length;
  }

  // ── Weighted, renormalized average ──
  let num = 0;
  let den = 0;
  const breakdown: Record<string, number | null> = {};
  (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).forEach((k) => {
    const sub = dims[k].value;
    breakdown[k] = sub;
    if (sub != null) {
      num += WEIGHTS[k] * sub;
      den += WEIGHTS[k];
    }
  });
  const score = den > 0 ? Math.round((num / den) * 100) : 0;
  let band: ScoredProject['band'] = score >= STRONG ? 'strong' : score >= GOOD ? 'good' : 'partial';

  // Categorical guard: if the customer named a property type and this project
  // is NOT that type (type subscore 0), it must never read as a "strong"/"good"
  // recommendation — location + budget can otherwise carry a wrong-type project
  // to a high score (e.g. an apartment scoring 75 for a townhouse request,
  // because type is only 20/80 of the applicable weight). Cap the band at
  // 'partial' so the UI labels it honestly AND it stops suppressing the
  // all_projects fallback (so we still go look for the real type). The numeric
  // score is left intact for transparency.
  const typeRequestedButMissed = req.property_type != null && dims.type.value === 0;
  if (typeRequestedButMissed && band !== 'partial') {
    band = 'partial';
    missing.push('Project unit type does not match the requested property type');
  }

  // ── Facts (only present values — the LLM never sees a null to invent over) ──
  const facts: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '' || v === '#REF') return;
    if (Array.isArray(v) && v.length === 0) return;
    facts[k] = v;
  };
  put('city', projCity);
  put('district', projDistrict);
  put('unit_types', asArr(data.unit_types));
  put('project_status', data.project_status);
  put('project_type', data.project_type);
  put('price_range', data.price_range);
  put('area_range', data.area_range);
  put('bedroom_range', data.bedroom_range);
  put('bathroom_range', data.bathroom_range);
  put('unit_count', asNum(data.unit_count));
  put('available_units', avail);
  put('preferred_amenities', asArr(data.preferred_amenities));

  return {
    score,
    band,
    match_type: matchType,
    district_exact: districtExact,
    available_units_zero: availZero,
    breakdown,
    data_gaps: gaps,
    missing_info: missing,
    facts,
  };
}

// ─── match_projects ─────────────────────────────────────────────────────────

interface MatchResultItem {
  project_id: string;
  project_name: string;
  data_source: 'our_projects' | 'all_projects';
  requires_verification?: boolean;
  verification_warning?: string;
  score: number;
  match_band: 'strong' | 'good' | 'partial';
  match_type: ScoredProject['match_type'];
  score_breakdown: Record<string, number | null>;
  facts: Record<string, unknown>;
  data_gaps: string[];
  missing_info: string[];
}

const VERIFY_WARNING =
  'From the All Projects database (unverified, often competitor/scraped data). Verify price, availability, and details before offering to the customer.';

// ─── Deterministic-metadata enforcement (Phase 1.1) ──────────────────────────
// The match score / band / type / source / verification flag are computed by
// scoreProject and MUST NOT be re-derived by the LLM. The prompt forbids it, but
// the server ALSO enforces it: collect the authoritative metadata from each
// match_projects result, then overwrite whatever the model passes to
// emit_recommendation (matched by project_id) before it reaches the card.

export interface AuthoritativeMeta {
  score: number;
  match_band: 'strong' | 'good' | 'partial';
  match_type: ScoredProject['match_type'];
  data_source: 'our_projects' | 'all_projects';
  requires_verification: boolean;
}

/** Parse a match_projects tool-result JSON string and merge each result's
 *  authoritative ranking metadata into `into`, keyed by project_id. */
export function collectAuthoritativeMeta(
  matchResultJson: string,
  into?: Map<string, AuthoritativeMeta>,
): Map<string, AuthoritativeMeta> {
  const map = into ?? new Map<string, AuthoritativeMeta>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(matchResultJson);
  } catch {
    return map; // ack-only or non-JSON results (e.g. get_project) are ignored
  }
  const root = parsed as { our_projects?: unknown; all_projects?: unknown } | null;
  for (const group of [root?.our_projects, root?.all_projects]) {
    const results = (group as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results as Array<Record<string, unknown>>) {
      const pid = r?.project_id;
      if (typeof pid !== 'string' || !pid) continue;
      map.set(pid, {
        score: Number(r.score) || 0,
        match_band: (r.match_band as AuthoritativeMeta['match_band']) ?? 'partial',
        match_type: (r.match_type as AuthoritativeMeta['match_type']) ?? 'partial',
        data_source: (r.data_source as AuthoritativeMeta['data_source']) ?? 'our_projects',
        requires_verification: r.requires_verification === true,
      });
    }
  }
  return map;
}

/**
 * Overwrite the deterministic ranking metadata on an emit_recommendation payload
 * with the authoritative match_projects values (by project_id), so the model can
 * never upgrade/downgrade/rename a match. Mutates + returns the payload, plus the
 * list of corrections made (for logging). Recommendations whose project_id has no
 * authoritative entry are left as-is (no source to enforce against). Also
 * recomputes the top-level data_source / requires_verification from the corrected
 * picks so the banner can't disagree with the per-pick flags.
 */
export function reconcileRecommendationPayload(
  input: unknown,
  auth: Map<string, AuthoritativeMeta>,
): { payload: unknown; corrections: Array<{ project_id: string; field: string; from: unknown; to: unknown }> } {
  const corrections: Array<{ project_id: string; field: string; from: unknown; to: unknown }> = [];
  if (!input || typeof input !== 'object') return { payload: input, corrections };
  const p = input as Record<string, unknown>;
  const recs = Array.isArray(p.recommendations) ? (p.recommendations as Array<Record<string, unknown>>) : [];

  const FIELDS: (keyof AuthoritativeMeta)[] = ['score', 'match_band', 'match_type', 'data_source', 'requires_verification'];
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue;
    const pid = typeof rec.project_id === 'string' ? rec.project_id : '';
    const a = pid ? auth.get(pid) : undefined;
    if (!a) continue;
    for (const f of FIELDS) {
      if (rec[f] !== a[f]) {
        corrections.push({ project_id: pid, field: f, from: rec[f], to: a[f] });
        rec[f] = a[f];
      }
    }
  }

  // Recompute the top-level rollup flags from the corrected picks.
  if (recs.length > 0) {
    const anyVerify = recs.some((r) => r.requires_verification === true);
    const sources = new Set(recs.map((r) => r.data_source));
    p.requires_verification = anyVerify;
    p.data_source = sources.has('all_projects')
      ? sources.has('our_projects')
        ? 'mixed'
        : 'all_projects'
      : 'our_projects';
  }
  return { payload: p, corrections };
}

export async function matchProjects(supabase: SupabaseClient, req: MatchRequirements): Promise<string> {
  const model = await getModelByName(supabase, 'all_projects');
  if (!model) return JSON.stringify({ error: 'all_projects model not found', our_projects: { count: 0, results: [] }, all_projects: null });

  let rows: RecordRow[];
  let tier1Ids: Set<string>;
  try {
    [rows, tier1Ids] = await Promise.all([pageRecords(supabase, model.id), loadTier1ProjectIds(supabase)]);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err), our_projects: { count: 0, results: [] }, all_projects: null });
  }

  const includeSoldOut = req.include_sold_out === true;
  // Rank by BAND first, then score — so a genuine good/strong match always
  // outranks a 'partial' one even if the partial has a higher raw score (e.g. a
  // wrong-type project whose location+budget inflate its number).
  const bandRank = (b: ScoredProject['band']) => (b === 'strong' ? 0 : b === 'good' ? 1 : 2);
  const byBandThenScore = (a: MatchResultItem, b: MatchResultItem) =>
    bandRank(a.match_band) - bandRank(b.match_band) || b.score - a.score;

  let anyDistrictExact = false;
  const scoreInto = (sourceRows: RecordRow[], source: 'our_projects' | 'all_projects'): MatchResultItem[] => {
    const out: MatchResultItem[] = [];
    for (const r of sourceRows) {
      const name = asStr(r.data.project_name);
      if (!name) continue;
      const s = scoreProject(r.data, req);
      if (s.district_exact) anyDistrictExact = true;
      if (s.score < MIN_RETURN) continue;
      if (s.available_units_zero && !includeSoldOut) continue; // sold-out excluded by default
      const item: MatchResultItem = {
        project_id: r.id,
        project_name: name,
        data_source: source,
        score: s.score,
        match_band: s.band,
        match_type: s.match_type,
        score_breakdown: s.breakdown,
        facts: s.facts,
        data_gaps: s.data_gaps,
        missing_info: s.missing_info,
      };
      if (source === 'all_projects') {
        item.requires_verification = true;
        item.verification_warning = VERIFY_WARNING;
      }
      out.push(item);
    }
    return out.sort(byBandThenScore);
  };

  // PASS 1 — our_projects ONLY. Partition the loaded rows by tier membership so
  // we score just the curated portfolio first.
  const oursRows = rows.filter((r) => tier1Ids.has(r.id));
  const tier1 = scoreInto(oursRows, 'our_projects');

  // "Good enough to suppress fallback" = at least one Tier-1 result whose BAND
  // is good/strong. The band encodes score >= GOOD (60) AND the property-type
  // guard (a wrong-type project is capped to 'partial'), so a perfect-location
  // wrong-type match does NOT block the search for the real type.
  const tier1HasGood = tier1.some((r) => r.match_band !== 'partial');
  const usedFallback = !tier1HasGood;

  // PASS 2 — all_projects is scored ONLY when there is no good in-portfolio
  // match. When Tier 1 is good, the broad database is never scanned or shown.
  const tier2 = usedFallback
    ? scoreInto(rows.filter((r) => !tier1Ids.has(r.id)), 'all_projects')
    : [];

  const notes: string[] = [];
  if (req.district && !anyDistrictExact) {
    notes.push(`No exact district match for "${req.district}". Showing same-city alternatives (text match only — Phase 1 has no distance/nearby logic).`);
  }
  if (usedFallback) {
    notes.push('No good match in our_projects — falling back to all_projects. Those results MUST be verified before offering.');
  }

  // The two tiers are returned as SEPARATE objects and the all_projects group is
  // ONLY present when the fallback fired — so a good in-portfolio match returns
  // our_projects ONLY, and the model can never blend the lists.
  return JSON.stringify({
    requirements_echo: req,
    district_exact_match: anyDistrictExact,
    used_fallback: usedFallback,
    our_projects: {
      source: 'our_projects',
      count: tier1.length,
      results: tier1.slice(0, TOP_N),
    },
    all_projects: usedFallback
      ? {
          source: 'all_projects',
          requires_verification: true,
          warning: VERIFY_WARNING,
          count: tier2.length,
          results: tier2.slice(0, TOP_N),
        }
      : null,
    notes,
  });
}

// ─── get_project (drill-down fact sheet — ported from copywriterAgent) ───────

interface SchemaField {
  name: string;
  label_en: string;
  label_ar: string;
  type: string;
  is_computed: boolean;
  computed_kind: string;
}

function collectFields(schema: unknown): SchemaField[] {
  const out: SchemaField[] = [];
  const sections = (schema as { sections?: unknown[] } | null)?.sections ?? [];
  for (const sec of sections as Array<{ fields?: unknown[] }>) {
    for (const f of (sec.fields ?? []) as Array<Record<string, unknown>>) {
      const name = asStr(f.name);
      if (!name) continue;
      out.push({
        name,
        label_en: asStr(f.label_en) || name,
        label_ar: asStr(f.label_ar),
        type: asStr(f.type),
        is_computed: f.is_rollup === true,
        computed_kind: asStr(f.rollup_kind),
      });
    }
  }
  return out;
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '' || v === '#REF') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return o.min != null || o.max != null;
  }
  return true;
}

async function getProject(supabase: SupabaseClient, input: { project_id: string }): Promise<string> {
  const model = await getModelByName(supabase, 'all_projects');
  if (!model) return JSON.stringify({ error: 'all_projects model not found' });

  const { data: rec, error } = await supabase
    .from('unified_records')
    .select('id, data')
    .eq('id', input.project_id)
    .maybeSingle();
  if (error || !rec) return JSON.stringify({ error: error?.message ?? 'project not found' });

  const d = (rec.data ?? {}) as Record<string, unknown>;
  const fields = collectFields(model.schema);

  const details: Record<string, { label: string; label_ar: string; value: unknown }> = {};
  const calculated: Record<string, { label: string; label_ar: string; computed_kind: string; value: unknown }> = {};
  for (const f of fields) {
    const val = d[f.name];
    if (!hasValue(val)) continue;
    if (f.is_computed) {
      calculated[f.name] = { label: f.label_en, label_ar: f.label_ar, computed_kind: f.computed_kind, value: val };
    } else {
      details[f.name] = { label: f.label_en, label_ar: f.label_ar, value: val };
    }
  }

  return JSON.stringify({
    id: rec.id,
    project_name: asStr(d.project_name),
    details,
    calculated,
    note: 'The `calculated` group holds the project’s stored unit aggregates (maintained from real unit data). An absent metric means there is no unit data for it; say "not available", never invent a number.',
  });
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export async function executeMatchTool(
  name: string,
  input: unknown,
  supabase: SupabaseClient,
  _userId: string,
): Promise<string> {
  try {
    switch (name) {
      case 'match_projects':
        return await matchProjects(supabase, (input ?? {}) as MatchRequirements);
      case 'get_project':
        return await getProject(supabase, input as { project_id: string });
      case 'emit_recommendation':
        // Pure delivery channel: the structured payload is surfaced to the
        // browser by api/match.ts as a `recommendation` SSE event. Nothing is
        // persisted server-side; the salesperson reads the card.
        return JSON.stringify({
          ok: true,
          note: 'Recommendation delivered to the salesperson as a card. Add one short closing line; do not repeat the full recommendation as text.',
        });
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

// Exported for unit testing the deterministic scorer + metadata enforcement.
export const __test = { scoreProject, collectAuthoritativeMeta, reconcileRecommendationPayload };
