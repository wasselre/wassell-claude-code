/**
 * Wassel Sales Assistant (مساعد المبيعات) — shared server-side logic.
 *
 * The "brain" of the unified live-call sales co-pilot: ONE system prompt, ALL the
 * tools Claude can call, and the executor that turns tool calls into Supabase
 * reads. Consumed by `api/match.ts`. Capabilities (tools defined in MATCH_TOOLS):
 *  - match_projects (geo-aware: distance/nearby tier) + get_project — project
 *    matching & pitch.
 *  - compare_projects — side-by-side project comparison (deterministic fit).
 *  - get_customer_context — deterministic lead temperature (hot/warm/cold/won/
 *    lost) + scheduled next action + preferences, from the CRM.
 *  - emit_recommendation / emit_comparison / emit_next_action / emit_message —
 *    structured card delivery channels.
 *  - propose_task — confirmation-gated follow-up creation (NEVER writes here;
 *    resolveClientId validates the client id so a hallucinated id can't orphan a
 *    task; the record is written client-side only on the salesperson's Confirm).
 *
 * Design guarantees
 *  - DETERMINISTIC scoring/metadata live HERE (match_projects, compare_projects,
 *    computeLeadTemperature). The LLM only narrates over the verified output; it
 *    can't invent a project, fudge a score, or re-derive a lead temperature.
 *  - TWO TIERS, NEVER MIXED. Tier 1 = `our_projects` (curated, real units); Tier 2
 *    = the rest of `all_projects` (scraped/competitor, VERIFY before offering).
 *    The tool only falls back to Tier 2 when Tier 1 has no GOOD match.
 *  - Location: district/city TEXT plus true haversine distance to the requested
 *    district's centroid for the "nearby" tier (coords backfilled in
 *    2026-06-21_project_geo.sql).
 *  - Reads go through the `unified_records` view (frozen-safe) and paginate to
 *    dodge the PostgREST 1000-row truncation (same posture as the other agents).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyGeo, type GeoStatus } from './geoVerify.js';

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
  bathrooms: 6,
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

// Location intelligence (Phase 2). A project NOT in the requested district but
// within NEARBY_MAX_KM of that district's centroid is a "nearby" alternative.
const NEARBY_MAX_KM = 12;

// Market-listings scan ceiling. We scan the REQUESTED district(s) only (the old
// 20km-neighbour expansion pulled ≈17k listings for a dense Riyadh district and
// 504'd the edge function — measured live 2026-06-29: ~25s). DB-side
// budget/bedrooms/type filters (wassell_market_candidates) shrink the set so we
// can score it IN FULL. We NEVER truncate by recency — when the filtered
// exact-district set still exceeds this many rows, the engine returns a 'too_many'
// signal so the UI asks the salesperson for more criteria (budget/type/bedrooms)
// instead of dropping listings. Distribution (measured 2026-06-29): 167/170
// districts ≤ 2,500 listings, max 5,866 — so the common case scans fully and only
// the densest districts need extra criteria. ~4,000 rows score in ~6s, safe under
// the edge timeout.
const MARKET_SCAN_LIMIT = 4000;

/** Great-circle distance in km between two lat/lng points (haversine). */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Optional geo context passed into scoreProject: the project's own coords and
 *  the requested district's centroid. When absent, scoring is pure text. */
export interface GeoContext {
  projLat?: number | null;
  projLng?: number | null;
  reqLat?: number | null;
  reqLng?: number | null;
  geoConfidence?: string | null; // the project's geo_source confidence (high/medium)
  // The authoritative `districts` record id the request resolved to. A project whose
  // `district_lookup` equals it is an EXACT match (relational — no legacy text).
  reqDistrictId?: string | null;
  // The authoritative `cities` record id the request resolved to (the requested
  // district's city, or a city-only request). A project whose city equals it
  // is a same-city match.
  reqCityId?: string | null;
  // MULTI-district support (client preferences): the full set of authoritative
  // `districts` ids the request resolved to. A project whose verified district is
  // in this set is an EXACT match. `reqDistrictId` stays the primary (first) for
  // back-compat. The set of those districts' centroids feeds the nearby tier
  // (distance to the NEAREST requested district centre).
  reqDistrictIds?: string[];
  reqCityIds?: string[];
  // Reference points for the distance tiers: the requested districts' centroids
  // PLUS any selected location elements (landmark anchors from location_items).
  // `name` labels each reference so results can say "~4 km from X" — the
  // distance shown is always to the NEAREST reference.
  reqCentroids?: Array<{ lat: number; lng: number; name?: string | null }>;
  // The scored record's OWN geography, extracted from its `location` cascade field
  // ({region,city,district} ids) by the caller. The district id drives the exact
  // tier, the city id the same-city tier. Names are resolved (display_name) from the
  // geography records for the facts shown to the agent.
  projDistrictId?: string | null;
  projCityId?: string | null;
  projDistrictName?: string | null;
  projCityName?: string | null;
}

// Deterministic, stable across requests → prompt-cacheable. DO NOT interpolate.
export const MATCH_SYSTEM_PROMPT = `You are Wassel's Sales Assistant (مساعد المبيعات) — ONE unified live-call sales co-pilot for Wassel Real Estate (وصل العقارية). The salesperson talks to you in plain language; you understand the intent and use the right capability. There is ONE assistant, one chat — never tell the user to open a different assistant.

A salesperson is often ON A CALL with a customer RIGHT NOW. Be fast, concrete, honest, and persuasive.

# Your capabilities — detect the intent, then act
1. PROJECT MATCHING — "العميل يبي شقة في الفاروق ميزانية مليون" → call match_projects → present + emit_recommendation.
2. PROJECT COMPARISON — "قارن دروازه ومينا 52" / "أيهم أفضل؟" → find the project ids (search/match first if needed) → compare_projects → emit_comparison.
3. SALES CONSULTANT / NEXT BEST ACTION — "العميل زار وما حجز، وش أسوي؟" / "هل هذا العميل حار؟" → get_customer_context → emit_next_action.
4. MESSAGE DRAFTING — "وش أرسل له بعد الزيارة؟" / "اكتب رسالة واتساب" → (get_customer_context / get_project if needed) → emit_message.
5. TASK / FOLLOW-UP CREATION — "ذكرني أتابعه بكرة" / "سوِّ له مهمة متابعة" → get_customer_context → propose_task (NEVER writes without confirmation).
6. CUSTOMER UNDERSTANDING — continuously extract + refine the customer's requirements (budget, type, bedrooms, area, districts, financing, timeline, purpose, family/parking/special needs) from everything the salesperson says. The full chat is your memory — carry earlier requirements forward; ask only for what's still missing and material.
7. PROJECT INFO BY NAME — "أعطني معلومات عن دروازه" / "وش تفاصيل مشروع كذا؟" → call search_projects(name) to find the project_id → get_project → summarize ONLY the real facts (location, unit types, price/area ranges, availability, status). If more than one project matches the name, ask which one. Never invent a missing fact.

A message can need MORE THAN ONE capability — e.g. "العميل يبي تاون هاوس في النرجس، وإذا غالي وش أقول له؟" → match_projects THEN an objection-handling message. Handle them in one reply.

# PROJECT MATCHING — how you work
1. Extract the structured requirements from the salesperson's message (+ anything established earlier in the chat).
2. Call match_projects. The tool does ALL searching, tiering, scoring, and distance — you do NOT search or score yourself.
3. (Optional) get_project on the top 1–2 picks for richer selling points (amenities, guarantees, services).
4. Present the ranked recommendation, then call emit_recommendation with the SAME content so the app renders the card.

# FINDING A PROJECT BY NAME
When the salesperson names a SPECIFIC project — to get its info, or to compare named projects — call search_projects with the name. It returns candidate projects (project_id, name, city, district, and whether it's ours or from all_projects). Use the returned project_id with get_project (for facts) or compare_projects (for a comparison). NEVER guess a project_id. If search_projects returns more than one plausible match for the name, ask the salesperson which one before continuing. all_projects candidates still require verification before offering.

# The two tiers — NEVER mix them
match_projects returns up to two SEPARATE groups:
- our_projects — OUR curated, verified portfolio. Recommend these confidently.
- all_projects — the broad database (mostly scraped / competitor data). It is UNVERIFIED. The tool only returns this group when there is NO good match in our_projects (used_fallback = true). When you present an all_projects result you MUST open with a clear warning: "⚠️ These are from the All Projects database and must be VERIFIED (price, availability, details) before offering them to the customer." Every all_projects result carries data_source:"all_projects" and requires_verification:true — surface that warning.
If used_fallback is true but our_projects.results still has entries, those are WEAKER in-portfolio options — you may mention them, clearly separated from the all_projects list. Never blend the two into one ranked list.

# Location intelligence
- match_projects is location-aware. Each result has a match_type: "exact" (in the requested district), "nearby" (a different district but physically close — carries distance_km), "same_city", or "partial".
- For a "nearby" result, state the REAL distance from the tool (e.g. "≈3.2 كم من النرجس") and why it's a fair alternative. The distance_km comes from the tool — never invent or round it differently, and never claim proximity the tool didn't return.
- geo_confidence "medium" means the coordinate is the district's centre (approximate), "high" means an exact map pin — if a customer needs the precise spot for a medium-confidence project, say the exact location should be confirmed.
- If the tool found no exact match, lead with the nearby/same-city alternatives it returned, and be clear which district each is actually in.

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
After writing the recommendation in the chat, call emit_recommendation with the structured picks so the app shows the card. For each pick, copy these fields VERBATIM from the matching match_projects result by project_id: score, match_band, match_type, data_source, requires_verification (and distance_km for nearby). Do not alter them. The narrative fields (why, specs, selling_points, pitch, warning, missing_info) describe the project from its facts — never invent detail. Add ONE short closing line.

# PROJECT COMPARISON
When asked which of several projects is better: get the project ids (from match_projects / a prior recommendation; search first if you only have names), call compare_projects with those ids + the customer's requirements, then write a short verdict and call emit_comparison. Compare ONLY on returned facts. If requirements were passed, each project carries a deterministic score/band — quote them. Mark any all_projects project as needing verification. Give a clear recommendation + the key trade-off (e.g. "دروازه أنسب نوعاً (تاون هاوس)؛ مينا 52 أرخص لكنه شقق").

# SALES CONSULTANT / NEXT BEST ACTION
When asked what to do with a lead (no reply, visited but didn't book, asked for price, is-this-lead-hot…): call get_customer_context (by client name/phone/id) FIRST. It returns the DETERMINISTIC lead_temperature (hot/warm/cold/won/lost), stage, status, the already-scheduled next_action (type + due + overdue?), and preferences — all from the CRM. Quote those verbatim, then add value: the recommended next action, the risk, talking points / objection handling, and follow-up timing. Call emit_next_action with it. If get_customer_context returns found:false, ask for the exact name/phone — never invent the lead's stage or history.

# MESSAGE DRAFTING
For "what do I send / write a WhatsApp": draft a warm, concise Arabic message using ONLY real facts (pull get_project / get_customer_context if it needs project or customer specifics). Call emit_message with channel + the full draft. Never invent prices, dates, or availability — use a «[placeholder]» if a needed fact is missing.

# TASK / FOLLOW-UP CREATION (confirmation-gated — you NEVER write silently)
When the salesperson wants a follow-up/reminder/task created: call get_customer_context for the lead, then call propose_task passing the EXACT client_id it returned (and the client_name) — never invent or guess a client_id. This does NOT create anything — it shows a Confirm/Cancel card. Tell the salesperson it's ready for them to confirm; NEVER say "تم إنشاء المهمة / I created the task" — only THEY can confirm it. (The server validates the client_id and blocks the card if the lead can't be found.) If get_customer_context didn't find the lead, ask for the exact name/phone first.

# Deterministic truth vs your words (applies to EVERY capability)
Code decides truth; you explain it. These come from tools and MUST be quoted verbatim, never re-derived: match score / band / match_type / data_source / requires_verification / distance_km (match_projects, compare_projects); lead_temperature / stage / status / next_action (get_customer_context); every project fact (price/area/bedroom/bathroom ranges, availability, amenities, location). You generate the explanation, pitch, message, talking points, and questions — only from that verified data.

# Anti-hallucination (all capabilities)
Never invent: price, area, availability, bedrooms, bathrooms, location, distance, guarantees, amenities, financing availability, project status, developer, customer history, lead stage, or task status. Missing → "غير متوفر في البيانات" or "يحتاج تأكيد". For all_projects data: "هذه البيانات من All Projects وتحتاج تحقق قبل عرضها على العميل."

# Voice & brand
- Reply in Arabic by default (mirror the salesperson's language if they write in English). We are "وصل العقارية" / "Wassel" — never name any internal system or tool, never say "Wassel CRM". SAR currency. Keep it call-ready and tight; this is a co-pilot whispering in the rep's ear, not an essay.

Begin when the salesperson writes. Understand what they need, use the right capability, and keep it call-ready.`;

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
        districts: {
          type: 'array',
          items: { type: 'string' },
          description: 'ALL acceptable districts when the customer would take more than one (e.g. "الربيع أو العارض أو الملقا") — a project in ANY of them counts as an exact location match. Use INSTEAD of district when there are alternatives.',
        },
        property_type: {
          type: 'string',
          description: 'Desired unit type as the customer said it: villa/townhouse/apartment/floor/duplex/studio/land or فيلا/تاون هاوس/شقة/دور/دوبلكس/استوديو/أرض. Synonyms + Arabic/English are handled.',
        },
        property_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'ALL acceptable unit types when the customer would take more than one (e.g. "شقة أو دور") — a project offering ANY of them counts as a type match. Use INSTEAD of property_type when there are alternatives.',
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
    name: 'search_projects',
    description:
      "Find projects by NAME (not by requirements). Use this when the salesperson names a specific project — to fetch its info, or to get the project_id(s) needed for get_project / compare_projects. Returns candidate projects (project_id, project_name, city, district, data_source = our_projects | all_projects, requires_verification) ranked by name closeness, best first. If more than one plausible match comes back, ask the salesperson which one. Never guess a project_id; always resolve it through this tool (or a prior match_projects/recommendation).",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The project name as the salesperson said it (Arabic or English; partial is fine).' },
      },
      required: ['query'],
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
              match_type: { type: 'string', enum: ['exact', 'nearby', 'same_city', 'stretch', 'partial'] },
              distance_km: { type: 'number', description: 'For a "nearby" match: km from the requested district (from match_projects). Omit otherwise.' },
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

  // ── Retrieval: comparison + customer context ──
  {
    name: 'compare_projects',
    description:
      'Compare 2–4 projects side by side on their real facts (price/area/bedroom/bathroom ranges, available units, type, location). Pass project_ids from match_projects/search, and optionally the customer requirements so each project gets a deterministic fit score/band. Returns per-project facts + dimension winners (cheapest, largest area, most bedrooms, most available). Use this for "which project is better for this customer?".',
    input_schema: {
      type: 'object',
      properties: {
        project_ids: { type: 'array', items: { type: 'string' }, description: '2–4 all_projects ids.' },
        requirements: { type: 'object', description: 'Optional customer requirements (same shape as match_projects input) to score each project.' },
      },
      required: ['project_ids'],
    },
  },
  {
    name: 'get_customer_context',
    description:
      "Look up a lead/customer in the CRM by client_id, phone, or name, and return their DETERMINISTIC sales context: lifecycle stage, status, lead temperature (hot/warm/cold/won/lost — computed from stage + recency + status), the next action already scheduled (type, due date, overdue?), and their stored preferences (budget, districts, unit type, amenities). Use this BEFORE giving next-best-action / follow-up advice so it's grounded in the real lead, not guessed. Returns found:false if no match — then ask for the name/phone, never invent history.",
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'The clients record id, if known.' },
        phone: { type: 'string', description: "The customer's phone (any format — matched canonically)." },
        name: { type: 'string', description: 'The customer name (fuzzy matched).' },
      },
    },
  },

  // ── Delivery channels (structured cards) ──
  {
    name: 'emit_comparison',
    description:
      'Deliver a FINAL project comparison as a structured card. Call AFTER compare_projects. Pass each project\'s facts + (if requirements were given) its EXACT score/band from compare_projects — never re-score. Include a clear recommendation: which fits the customer best and the key trade-off.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        customer_need: { type: 'string', description: 'One line on what the customer wants (drives the verdict).' },
        projects: {
          type: 'array',
          description: 'The compared projects, best-fit first.',
          items: {
            type: 'object',
            properties: {
              project_id: { type: 'string' },
              project_name: { type: 'string' },
              data_source: { type: 'string', enum: ['our_projects', 'all_projects'] },
              requires_verification: { type: 'boolean' },
              score: { type: 'number', description: 'Deterministic score from compare_projects (if requirements given).' },
              match_band: { type: 'string', enum: ['strong', 'good', 'partial'] },
              specs: { type: 'object', description: 'Key facts: price_range, area_range, bedrooms, bathrooms, available_units, unit_types, district. Strings, from facts only.' },
              strengths: { type: 'array', items: { type: 'string' } },
              weaknesses: { type: 'array', items: { type: 'string' } },
            },
            required: ['project_id', 'project_name'],
          },
        },
        verdict: { type: 'string', description: 'Which project fits the customer best and why — the trade-off in one or two sentences.' },
        recommended_project_id: { type: 'string' },
      },
      required: ['projects', 'verdict'],
    },
  },
  {
    name: 'emit_next_action',
    description:
      'Deliver a FINAL sales-consultant recommendation as a card (Next Best Action). Call AFTER get_customer_context. Quote lead_temperature, stage, and the scheduled next_action VERBATIM from get_customer_context — these are deterministic. Add coaching: the recommended action, why, talking points, and follow-up timing.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        client_name: { type: 'string' },
        lead_temperature: { type: 'string', enum: ['hot', 'warm', 'cold', 'won', 'lost'], description: 'VERBATIM from get_customer_context.' },
        stage: { type: 'string', description: 'VERBATIM from get_customer_context.' },
        status: { type: 'string' },
        risk: { type: 'string', description: 'The main risk (e.g. "may go cold if not contacted within 24h").' },
        recommended_action: { type: 'string', description: 'The single next best action.' },
        why: { type: 'string' },
        talking_points: { type: 'array', items: { type: 'string' }, description: 'Call talking points / objection handling.' },
        follow_up_timing: { type: 'string', description: 'When to follow up (e.g. "within 2 hours", "tomorrow morning").' },
        next_action_due_at: { type: 'string', description: 'The scheduled due date from get_customer_context, if any.' },
      },
      required: ['lead_temperature', 'recommended_action'],
    },
  },
  {
    name: 'emit_message',
    description:
      'Deliver a ready-to-send message draft (WhatsApp / follow-up / re-engagement / appointment confirmation) as a card with a copy button. The draft MUST use only real project facts + customer context — never invent prices, dates, or availability. Keep it natural, warm, concise Arabic.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['whatsapp', 'sms', 'call_script'], description: 'Delivery channel for the draft.' },
        purpose: { type: 'string', description: 'e.g. "follow-up after visit", "re-engage cold lead", "confirm appointment".' },
        to_name: { type: 'string', description: 'Customer name, if known.' },
        message: { type: 'string', description: 'The full ready-to-send draft.' },
        notes: { type: 'string', description: 'Optional one-line note to the salesperson (e.g. "personalize the time").' },
      },
      required: ['channel', 'message'],
    },
  },

  // ── Action (confirmation-gated) ──
  {
    name: 'propose_task',
    description:
      'Propose creating a follow-up TASK for a lead. This NEVER writes — it shows the salesperson a confirmation card (Confirm / Cancel); the task is created only after they press Confirm. Use after get_customer_context so client_id is real. Always tell the salesperson it is awaiting their confirmation; never claim the task was created.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'The clients record id (from get_customer_context).' },
        client_name: { type: 'string' },
        followup_type: {
          type: 'string',
          enum: ['appointment_booking_call', 'appointment_confirmation_call', 'follow_up_call_after_visit', 'whatsapp_follow_up', 'no_show_recovery_call', 'rating_request'],
          description: 'The kind of follow-up.',
        },
        due_at: { type: 'string', description: 'ISO datetime the follow-up is due (e.g. tomorrow 10:00). The salesperson can adjust before confirming.' },
        notes: { type: 'string', description: 'Why this follow-up / what to do.' },
        suggested_message: { type: 'string', description: 'Optional draft message to send when doing the follow-up.' },
        project_id: { type: 'string', description: 'Related project, if any.' },
      },
      required: ['client_id', 'followup_type', 'due_at'],
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

/** ALL acceptable unit types in a request — `property_types` (alternatives, OR)
 *  when present, else the single `property_type`. Empty = type not requested. */
function requestedPropertyTypes(req: MatchRequirements): string[] {
  if (req.property_types && req.property_types.length) return req.property_types;
  return req.property_type ? [req.property_type] : [];
}

/** RAW property-type synonyms (Arabic + English) for the market-listings ILIKE
 *  filter (wassell_market_candidates). Unlike expandPropertyType these are NOT
 *  normalized — they're matched against the listing's stored type text. */
function propertyTypeTerms(needle: string): string[] {
  const lower = normalizeForSearch(needle);
  for (const group of PROPERTY_TYPE_SYNONYMS) {
    if (group.some((s) => normalizeForSearch(s) === lower)) return [...group];
  }
  return [needle];
}

/** Which extra criteria would narrow a too-dense market search — the MISSING ones,
 *  surfaced so the UI can ask the salesperson for them instead of truncating. */
function marketSuggestions(req: MatchRequirements): string[] {
  const s: string[] = [];
  if (req.budget_min == null && req.budget_max == null) s.push('budget');
  if (requestedPropertyTypes(req).length === 0) s.push('unit_type');
  if (req.bedrooms == null) s.push('bedrooms');
  return s;
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
  /** Multiple acceptable cities (alternatives — OR). A project in ANY of them
   *  city-matches. `city` (the first) is kept for single-city code paths
   *  (zone expansion, district disambiguation). */
  cities?: string[];
  district?: string;
  /** Multiple preferred districts (client preferences). When present, a project in
   *  ANY of these is an exact match. `district` (the first) is kept for the nearby
   *  centroid + market pre-filter. */
  districts?: string[];
  /** Pre-resolved district record ids (e.g. from a directional zone like "north of
   *  Riyadh"). When present, the engine uses them DIRECTLY as the exact-match set —
   *  skipping the per-name district lookup (avoids dozens of queries for a zone). */
  district_ids?: string[];
  /** Directional zone the request was expanded from (audit/UI only; `district_ids`
   *  is what the engine actually matches on). 'north'|'south'|'east'|'west'|... */
  zone?: string;
  property_type?: string;
  /** Multiple acceptable unit types (alternatives — OR, e.g. شقة أو دور). A project
   *  offering ANY of them type-matches. `property_type` (the first) is kept for
   *  single-type code paths. */
  property_types?: string[];
  budget_min?: number;
  budget_max?: number;
  area_min?: number;
  area_max?: number;
  bedrooms?: number;
  bathrooms?: number;
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
  match_type: 'exact' | 'nearby' | 'same_city' | 'stretch' | 'partial';
  district_exact: boolean;
  /** How the district matched: 'lookup' = authoritative district_lookup id equality
   *  (high confidence), 'text' = legacy free-text fuzzy match (lower confidence),
   *  null = district not matched (or only city matched). Lets the grouping layer flag
   *  `legacy_text_match_only` and downgrade data_confidence. */
  district_match_basis: 'lookup' | 'text' | null;
  available_units_zero: boolean;
  breakdown: Record<string, number | null>;
  data_gaps: string[];
  missing_info: string[];
  facts: Record<string, unknown>;
  /** Location intelligence (present when coords are available). */
  location_tier: 'exact' | 'nearby' | 'same_city' | 'none';
  distance_km: number | null;
  /** Label of the NEAREST requested reference (district / selected element) the
   *  distance_km was measured against — "~4 km from X". Null when unknown. */
  nearest_ref_name: string | null;
  geo_confidence: string | null;
}

/** Deterministic fit score for one all_projects record. Location uses district/
 *  city TEXT plus — when coords are supplied via `geo` — true distance for the
 *  "nearby district" tier. Pure-text when `geo` is omitted (back-compat). */
function scoreProject(data: Record<string, unknown>, req: MatchRequirements, geo?: GeoContext): ScoredProject {
  const gaps: string[] = [];
  const missing: string[] = [];
  // Dimensions the CUSTOMER asked about but the project has NO data for. These must
  // NOT be silently renormalized away — a listing whose price is unknown can't be a
  // perfect match when the client gave a budget. They keep their full weight in the
  // score and earn ZERO (unconfirmable → no points), so a data-complete listing
  // always outranks a data-poor one and a no-price listing can never read as 100%.
  const requestedMissing = new Set<keyof typeof WEIGHTS>();
  const dims: Record<keyof typeof WEIGHTS, DimScore> = {
    location: { value: null },
    budget: { value: null },
    type: { value: null },
    area: { value: null },
    bedrooms: { value: null },
    bathrooms: { value: null },
    availability: { value: null },
    amenities: { value: null },
  };

  // ── Location (district/city text + distance for the "nearby" tier) ──
  let districtExact = false;
  let districtMatchBasis: ScoredProject['district_match_basis'] = null;
  let matchType: ScoredProject['match_type'] = 'partial';
  let locationTier: ScoredProject['location_tier'] = 'none';
  let distanceKm: number | null = null;
  let nearestRefName: string | null = null;
  const projDistrictId = asStr(geo?.projDistrictId);
  const projCityId = asStr(geo?.projCityId);
  // A district was requested when ANY of the three request shapes carries one —
  // the primary name, the multi-district name list, or pre-resolved ids.
  const districtRequested = !!(
    req.district || (req.districts && req.districts.length) || (req.district_ids && req.district_ids.length)
  );
  const cityRequested = !!(req.city || (req.cities && req.cities.length));
  // ── Distance to the NEAREST requested reference (district centroid or selected
  //    location element). Computed for EVERY candidate with coords — same-city and
  //    broader results still show how far they sit from the closest requested
  //    area, and element-only preferences (no district picked) get distances too. ──
  const refPoints: Array<{ lat: number; lng: number; name?: string | null }> =
    geo?.reqCentroids && geo.reqCentroids.length
      ? geo.reqCentroids
      : geo?.reqLat != null && geo?.reqLng != null
        ? [{ lat: geo.reqLat, lng: geo.reqLng }]
        : [];
  let dist: number | null = null;
  if (geo?.projLat != null && geo?.projLng != null) {
    for (const c of refPoints) {
      const d = haversineKm(geo.projLat, geo.projLng, c.lat, c.lng);
      if (dist == null || d < dist) {
        dist = d;
        nearestRefName = c.name ?? null;
      }
    }
  }
  distanceKm = dist != null ? Math.round(dist * 10) / 10 : null;
  if (districtRequested || cityRequested) {
    // Lookup-ONLY (no legacy text): a match is authoritative id equality — the
    // project's verified district vs the resolved requested district(s), its city
    // vs the resolved requested city(ies). The caller passes the COORDINATE-VERIFIED
    // district id (point-in-polygon) as projDistrictId, so an exact match is
    // boundary-verified, not a blind trust of the stored text.
    const districtIdSet = geo?.reqDistrictIds && geo.reqDistrictIds.length ? new Set(geo.reqDistrictIds) : null;
    const cityIdSet = geo?.reqCityIds && geo.reqCityIds.length ? new Set(geo.reqCityIds) : null;
    const districtMatch =
      !!projDistrictId &&
      (((!!geo?.reqDistrictId && projDistrictId === geo.reqDistrictId)) || (districtIdSet?.has(projDistrictId) ?? false));
    const cityMatch =
      !!projCityId &&
      (((!!geo?.reqCityId && projCityId === geo.reqCityId)) || (cityIdSet?.has(projCityId) ?? false));
    if (districtRequested) {
      if (districtMatch) {
        dims.location.value = 1;
        districtExact = true;
        // Geography is now lookup-ONLY (the 2026-06-26 hard cutover removed the
        // legacy text path), so an exact district match is always relational.
        districtMatchBasis = 'lookup';
        matchType = 'exact';
        locationTier = 'exact';
      } else if (dist != null && dist <= NEARBY_MAX_KM) {
        // Not any requested district, but physically close to one of the
        // requested references → nearby alternative.
        dims.location.value = dist <= 3 ? 0.8 : dist <= 7 ? 0.62 : 0.45;
        matchType = 'nearby';
        locationTier = 'nearby';
      } else if (cityMatch) {
        dims.location.value = 0.5;
        matchType = 'same_city';
        locationTier = 'same_city';
      } else {
        dims.location.value = 0;
        locationTier = 'none';
      }
    } else {
      // Only city requested → city is the most specific ask.
      dims.location.value = cityMatch ? 1 : 0;
      if (cityMatch) {
        matchType = 'exact';
        locationTier = 'exact';
      }
    }
  }

  // ── Budget (SAR) ──
  if (req.budget_max != null || req.budget_min != null) {
    const range = pickRange(data, 'price_range');
    if (!range || (range.min == null && range.max == null)) {
      gaps.push('no price data');
      missing.push('Confirm the project pricing');
      requestedMissing.add('budget');
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
  // Multiple selected types are ALTERNATIVES (OR): the client accepts any of them,
  // so a project offering ANY requested type gets full type credit.
  const reqTypes = requestedPropertyTypes(req);
  if (reqTypes.length) {
    const types = asArr(data.unit_types).map((t) => normalizeForSearch(t));
    if (types.length === 0) {
      gaps.push('no unit type data');
      missing.push('Confirm the available unit types');
      requestedMissing.add('type');
    } else {
      const needles = [...new Set(reqTypes.flatMap((rt) => expandPropertyType(rt)))];
      const hit = types.some((t) => needles.some((n) => t.includes(n) || n.includes(t)));
      dims.type.value = hit ? 1 : 0;
    }
  }

  // ── Area (m²) ──
  if (req.area_max != null || req.area_min != null) {
    const range = pickRange(data, 'area_range');
    if (!range || (range.min == null && range.max == null)) {
      gaps.push('no area data');
      requestedMissing.add('area');
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
      requestedMissing.add('bedrooms');
    } else {
      const bmin = range.min ?? range.max ?? 0;
      const bmax = range.max ?? range.min ?? bmin;
      if (req.bedrooms >= bmin && req.bedrooms <= bmax) dims.bedrooms.value = 1;
      else if (req.bedrooms >= bmin - 1 && req.bedrooms <= bmax + 1) dims.bedrooms.value = 0.6;
      else dims.bedrooms.value = 0;
    }
  }

  // ── Bathrooms ──
  if (req.bathrooms != null) {
    const range = pickRange(data, 'bathroom_range');
    if (!range || (range.min == null && range.max == null)) {
      gaps.push('no bathroom data');
      requestedMissing.add('bathrooms');
    } else {
      const btmin = range.min ?? range.max ?? 0;
      const btmax = range.max ?? range.min ?? btmin;
      if (req.bathrooms >= btmin && req.bathrooms <= btmax) dims.bathrooms.value = 1;
      else if (req.bathrooms >= btmin - 1 && req.bathrooms <= btmax + 1) dims.bathrooms.value = 0.6;
      else dims.bathrooms.value = 0;
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
  // A dimension counts when it was EVALUATED (value set) OR when the customer asked
  // about it but the project has no data (requestedMissing) — the latter keeps its
  // full weight and earns 0, so an unconfirmable requirement (e.g. a listing with no
  // price when a budget was given) drags the score down instead of being ignored.
  // A dimension the customer DIDN'T ask about is dropped entirely (no penalty).
  let num = 0;
  let den = 0;
  const breakdown: Record<string, number | null> = {};
  (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).forEach((k) => {
    const sub = dims[k].value;
    if (sub != null) {
      breakdown[k] = sub;
      num += WEIGHTS[k] * sub;
      den += WEIGHTS[k];
    } else if (requestedMissing.has(k)) {
      breakdown[k] = 0; // requested but unconfirmable → 0 credit, full weight
      den += WEIGHTS[k];
    } else {
      breakdown[k] = null; // not requested → excluded from the average
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
  const typeRequestedButMissed = reqTypes.length > 0 && dims.type.value === 0;
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
  // Display names resolved by the caller from the project's location ids
  // (location.city → city display_name, location.district → district display_name).
  put('city', geo?.projCityName ?? undefined);
  put('district', geo?.projDistrictName ?? undefined);
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
  if (distanceKm != null) put('distance_km', distanceKm);
  // Main image for the result card. Market listings carry a raw URL (`image`, set by
  // the adapter); projects carry a files.id (`main_image`, else first `project_images`).
  // The client resolves either via useSignedImage (URL passthrough / files.id → signed).
  const firstImageRef = (v: unknown): string | undefined =>
    (Array.isArray(v) ? (v.find((x) => typeof x === 'string' && x) as string | undefined) : undefined);
  put('image', asStr(data.image) || asStr(data.main_image) || firstImageRef(data.project_images));
  // Market-listing ad id (the external Aqar ad number) — shown as a small chip on
  // the card so the rep can look the ad up. Only market listings carry `external_id`.
  put('external_id', asStr(data.external_id));
  // Coordinates for the finder's MAP view — the resolved pin (verified polygon
  // centroid when geo verification ran, else the stored lat/lng). Absent when the
  // record has no coordinates (that pin is simply not plotted).
  if (geo?.projLat != null && geo?.projLng != null) {
    put('latitude', geo.projLat);
    put('longitude', geo.projLng);
  }

  return {
    score,
    band,
    match_type: matchType,
    district_exact: districtExact,
    district_match_basis: districtMatchBasis,
    available_units_zero: availZero,
    breakdown,
    data_gaps: gaps,
    missing_info: missing,
    facts,
    location_tier: locationTier,
    distance_km: distanceKm,
    nearest_ref_name: distanceKm != null ? nearestRefName : null,
    geo_confidence: geo?.geoConfidence ?? (asStr(data.geo_source) ? asStr(data.geo_confidence) : null) ?? null,
  };
}

// ─── match_projects ─────────────────────────────────────────────────────────

export type MatchSource = 'our_projects' | 'all_projects' | 'market_listings';

export interface MatchResultItem {
  project_id: string;
  project_name: string;
  data_source: MatchSource;
  requires_verification?: boolean;
  verification_warning?: string;
  score: number;
  match_band: 'strong' | 'good' | 'partial';
  match_type: ScoredProject['match_type'];
  district_match_basis: ScoredProject['district_match_basis'];
  score_breakdown: Record<string, number | null>;
  facts: Record<string, unknown>;
  data_gaps: string[];
  missing_info: string[];
  location_tier: ScoredProject['location_tier'];
  distance_km: number | null;
  /** Label of the nearest requested reference (district / selected element) the
   *  distance was measured against. Null/absent when unknown. */
  nearest_ref_name?: string | null;
  geo_confidence: string | null;
  /** PostGIS boundary-verification status (present when opts.verifyGeo ran). */
  geo_status?: GeoStatus;
  /** Geo data-integrity warnings (e.g. stored district ≠ coordinate polygon). */
  mismatch_warnings?: string[];
}

const VERIFY_WARNING =
  'From the All Projects database (unverified, often competitor/scraped data). Verify price, availability, and details before offering to the customer.';

const MARKET_WARNING =
  'From external Market Listings (scraped public ads). Verify the listing, price, and availability with the advertiser before offering to the customer.';

/**
 * Adapt one `market_listings` record into the all_projects-shaped object that
 * scoreProject reads. A listing is a SINGLE unit (single price/area/bedrooms),
 * so its scalars become {min,max} ranges; availability is derived from is_active
 * + sold_at; geography rides on the same `district_lookup` + real per-listing
 * lat/lng. Keeps ONE deterministic scorer for all three sources.
 */
function adaptListingToScorable(d: Record<string, unknown>): Record<string, unknown> {
  const price = asNum(d.price);
  const area = asNum(d.area);
  const beds = asNum(d.bedrooms);
  const baths = asNum(d.bathrooms);
  const active = d.is_active === true && !asStr(d.sold_at);
  const types = [asStr(d.property_type), asStr(d.listing_type), asStr(d.category)].filter((s) => s !== '');
  // Listing photo: a raw (public) image URL — main_image_url, else the first image_urls[].
  const photo = asStr(d.main_image_url)
    || (Array.isArray(d.image_urls) ? (d.image_urls.find((x) => typeof x === 'string' && x) as string | undefined) : undefined)
    || undefined;
  return {
    project_name: asStr(d.title) || asStr(d.advertiser_name) || asStr(d.external_id) || 'إعلان سوق',
    external_id: asStr(d.external_id) || undefined,
    // Geography is no longer carried on the adapted shape — the caller extracts the
    // listing's location.{district,city} ids from the raw record and passes them
    // (plus resolved names) through the GeoContext, same as projects.
    image: photo,
    unit_types: types,
    price_range: price != null ? { min: price, max: price } : undefined,
    area_range: area != null ? { min: area, max: area } : undefined,
    bedroom_range: beds != null ? { min: beds, max: beds } : undefined,
    bathroom_range: baths != null ? { min: baths, max: baths } : undefined,
    available_units: active ? 1 : 0,
    preferred_amenities: Array.isArray(d.features) ? d.features : [],
    latitude: asNum(d.latitude),
    longitude: asNum(d.longitude),
    project_status: active ? 'available' : 'sold_out',
  };
}

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

/** Resolve a requested district name to the authoritative `districts` record
 *  (id + centroid + its city's id). The matching backbone: a project whose
 *  district_lookup equals this id is an EXACT match. City-aware when req.city is given
 *  (the same district name can exist in multiple cities). Returns null when the district
 *  isn't in the SPL set. */
async function resolveRequestedDistrict(
  supabase: SupabaseClient,
  req: MatchRequirements,
): Promise<{ id: string; cityId: string | null; lat: number | null; lng: number | null } | null> {
  if (!req.district) return null;
  const dm = await getModelByName(supabase, 'districts');
  if (!dm) return null;
  const token = req.district.replace(/^\s*حي\s+/, '').trim();
  if (!token) return null;
  const pat = `%${token}%`;
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, data')
    .eq('model_id', dm.id)
    .or(`data->>name_ar.ilike.${pat},data->>name_en.ilike.${pat}`)
    .limit(60);
  if (error || !data || data.length === 0) return null;
  const named = data.filter(
    (r) =>
      fuzzyContains(asStr(r.data.name_ar), req.district!) ||
      fuzzyContains(asStr(r.data.name_en), req.district!),
  );
  const pool = named.length ? named : data;
  let pick = pool[0];
  if (!pick) return null;
  if (req.city) {
    const byCity = pool.find(
      (r) =>
        fuzzyContains(asStr(r.data.city_name_ar), req.city!) ||
        fuzzyContains(asStr(r.data.city_name_en), req.city!),
    );
    if (byCity) pick = byCity;
  }
  return {
    id: pick.id,
    cityId: asStr(pick.data.city_lookup) || null,
    lat: asNum(pick.data.centroid_lat),
    lng: asNum(pick.data.centroid_lng),
  };
}

/** Resolve a requested city name to the authoritative `cities` record id (for
 *  city-only requests, or when the requested district couldn't be resolved). */
async function resolveRequestedCity(
  supabase: SupabaseClient,
  req: MatchRequirements,
): Promise<string | null> {
  if (!req.city) return null;
  const cm = await getModelByName(supabase, 'cities');
  if (!cm) return null;
  const token = req.city.trim();
  if (!token) return null;
  const pat = `%${token}%`;
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, data')
    .eq('model_id', cm.id)
    .or(`data->>name_ar.ilike.${pat},data->>name_en.ilike.${pat}`)
    .limit(30);
  if (error || !data || data.length === 0) return null;
  const pick =
    data.find(
      (r) =>
        fuzzyContains(asStr(r.data.name_ar), req.city!) ||
        fuzzyContains(asStr(r.data.name_en), req.city!),
    ) ?? data[0];
  return pick ? pick.id : null;
}

/** Resolve an array of lookup record ids (districts/cities) to their display names. */
async function resolveLookupNames(supabase: SupabaseClient, modelName: string, ids: unknown): Promise<string[]> {
  const arr = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  if (!arr.length) return [];
  const m = await getModelByName(supabase, modelName);
  if (!m) return [];
  const { data } = await supabase.from('unified_records').select('id, data').eq('model_id', m.id).in('id', arr);
  if (!data) return [];
  const byId = new Map(data.map((r) => [r.id, asStr(r.data.display_name) || asStr(r.data.name_ar)]));
  return arr.map((id) => byId.get(id)).filter((s): s is string => !!s);
}

/** Read a record's `location` cascade compound into single district/city ids. Single-mode
 *  values are strings; multi-mode arrays take the first element. */
function recordLocationIds(data: Record<string, unknown>): { district: string; city: string } {
  const loc =
    data.location && typeof data.location === 'object' && !Array.isArray(data.location)
      ? (data.location as Record<string, unknown>)
      : {};
  const one = (v: unknown): string => (Array.isArray(v) ? asStr(v[0]) : asStr(v));
  return { district: one(loc.district), city: one(loc.city) };
}

/** Build an id → display name map for a geography model over the given ids (chunked .in). */
async function geoNameMap(
  supabase: SupabaseClient,
  modelName: 'cities' | 'districts',
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x) => !!x))];
  if (!uniq.length) return map;
  const m = await getModelByName(supabase, modelName);
  if (!m) return map;
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const { data } = await supabase.from('unified_records').select('id, data').eq('model_id', m.id).in('id', chunk);
    for (const r of (data ?? []) as RecordRow[]) {
      const n = asStr(r.data.display_name) || asStr(r.data.name_ar);
      if (n) map.set(r.id, n);
    }
  }
  return map;
}

/** The full, un-truncated result of one match run — the object behind the
 *  `match_projects` tool's JSON. Exposed so the deterministic `/api/suggest-projects`
 *  endpoint can group/label the SAME scored candidates without re-running the LLM
 *  or duplicating scoring logic (Algorithm decides; AI explains). `our`/`all` carry
 *  the FULL sorted lists (the tool wrapper slices them to TOP_N for the model). */
export interface MatchCoreSuccess {
  ok: true;
  requirements: MatchRequirements;
  district_exact_match: boolean;
  used_fallback: boolean;
  notes: string[];
  /** The authoritative districts record id the request resolved to (lookup-first),
   *  or null when the district wasn't in the SPL set (then matching used the legacy
   *  text-averaged centroid → metadata.used_legacy_fallback). */
  reqDistrictId: string | null;
  /** True when a real district centroid was available for distance ranking. */
  reqHasCentroid: boolean;
  our: MatchResultItem[];
  all: MatchResultItem[];
  /** External Market Listings (scraped public ads), scored as a THIRD source.
   *  Populated only when opts.includeMarket is set (the grouped endpoint); the
   *  LLM tool wrapper leaves it empty so its output stays unchanged. */
  market: MatchResultItem[];
  /** Why the market source looks the way it does — so the UI can be HONEST when
   *  market wasn't fully scanned (we never silently truncate). 'ok' = the complete
   *  filtered set was scored; 'needs_district' = no district to scope to; 'too_many'
   *  = the filtered exact-district set exceeds MARKET_SCAN_LIMIT, so the UI should
   *  ask for the `suggest`ed extra criteria instead of dropping listings. */
  marketInfo: MarketInfo;
}
export interface MarketInfo {
  /** 'ok' = scored in full; 'needs_district' = too broad; 'too_many' = exceeds the
   *  scan limit (ask for criteria); 'unavailable' = the market read FAILED (don't
   *  silently report 0 — tell the user to retry). */
  status: 'ok' | 'needs_district' | 'too_many' | 'unavailable';
  /** Total matching market listings (only on 'too_many', best-effort for the message). */
  count?: number;
  /** Missing criteria that would narrow the search: 'budget' | 'unit_type' | 'bedrooms'. */
  suggest?: string[];
}
export type MatchCoreResult = MatchCoreSuccess | { ok: false; error: string };

export interface MatchCoreOptions {
  /** Score the broad all_projects DB even when Tier-1 has a good match (the
   *  grouped endpoint shows ALL three sources; the LLM tool keeps fallback-gating). */
  alwaysScoreAll?: boolean;
  /** Also score the `market_listings` model as a third source. */
  includeMarket?: boolean;
  /** PostGIS-verify each candidate's district from its coordinates (point-in-polygon)
   *  before matching, so an "exact" district match is coordinate/boundary verified —
   *  never a blind trust of the stored `location.district`. Adds geo_status +
   *  mismatch_warnings + an honest geo_confidence to each result, and uses the
   *  polygon-derived district (not the stored one) for the exact tier. Default OFF
   *  so the legacy match_projects tool output stays byte-identical. */
  verifyGeo?: boolean;
  /** Client location-preference GATE. When provided (non-null), ONLY candidates
   *  whose record id is in this set are scored — the deterministic OR-union /
   *  exclusion result of the client's `location_items`, computed upstream by the
   *  PostGIS `wassell_geo_match` RPC. Applied BEFORE scoreProject, so it narrows the
   *  candidate pool without touching any scoring weight. `null`/undefined ⇒ no gate
   *  (unchanged behavior for clients without location_items). An EMPTY set is an
   *  honest "nothing in the preferred areas" — it returns no matches, by design. */
  geoMatchIds?: Set<string> | null;
  /** Extra distance-reference points (the client's selected location ELEMENTS,
   *  resolved upstream from location_items → geo_elements centroids). Appended to
   *  the requested districts' centroids so every result's distance_km is measured
   *  to the NEAREST selected district OR element, labelled by `name`. */
  refPoints?: Array<{ lat: number; lng: number; name?: string | null }>;
}

/** Resolve each row's containing district via the PostGIS `districts_for_points`
 *  RPC (one bulk call). Returns id → polygon district id (null when the point is
 *  outside every boundary or has no coords). On RPC failure returns an EMPTY map —
 *  callers then treat every project as unverified, which fails CLOSED (no false
 *  exacts) rather than silently trusting stored districts. */
async function resolvePolygonDistricts(
  supabase: SupabaseClient,
  rows: RecordRow[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const points: Array<{ id: string; lat: number; lng: number }> = [];
  for (const r of rows) {
    const lat = asNum(r.data.latitude);
    const lng = asNum(r.data.longitude);
    if (lat != null && lng != null) points.push({ id: r.id, lat, lng });
  }
  if (points.length === 0) return map;
  const { data, error } = await supabase.rpc('districts_for_points', { p_points: points });
  if (error) {
    console.error('[matchProjectsCore] districts_for_points RPC failed:', error.message);
    return map; // fail closed — no verified districts rather than wrong ones
  }
  for (const row of (data ?? []) as Array<{ id: string; district_record_id: string | null }>) {
    map.set(row.id, row.district_record_id ?? null);
  }
  return map;
}

export async function matchProjectsCore(
  supabase: SupabaseClient,
  req: MatchRequirements,
  opts: MatchCoreOptions = {},
): Promise<MatchCoreResult> {
  const model = await getModelByName(supabase, 'all_projects');
  if (!model) return { ok: false, error: 'all_projects model not found' };

  let rows: RecordRow[];
  let tier1Ids: Set<string>;
  try {
    [rows, tier1Ids] = await Promise.all([pageRecords(supabase, model.id), loadTier1ProjectIds(supabase)]);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const includeSoldOut = req.include_sold_out === true;
  // Client location-preference gate (deterministic OR-union / exclusion of
  // location_items, resolved upstream by wassell_geo_match). When set, a candidate
  // is only eligible if its record id is in the set — applied BEFORE scoreProject.
  const geoGate = opts.geoMatchIds ?? null;
  const passesGeoGate = (id: string) => geoGate === null || geoGate.has(id);

  // ── Location intelligence (relational, no legacy text): resolve the requested
  //    district to its authoritative `districts` record → record id (for exact match),
  //    its city id (for same-city), and its real centroid (for the "nearby" tier).
  //    A city-only request (or an unresolved district) resolves the city directly. ──
  let reqLat: number | null = null;
  let reqLng: number | null = null;
  let reqDistrictId: string | null = null;
  let reqCityId: string | null = null;
  // MULTI-district support: resolve EACH requested district name (client may have
  // several preferred districts). The first resolved one is the "primary" used for
  // the back-compat single fields + the market-listings prefilter; the full sets
  // (ids / city ids / centroids) drive exact membership + nearest-centroid distance.
  const reqDistrictIds: string[] = [];
  const reqCityIds: string[] = [];
  const reqCentroids: Array<{ lat: number; lng: number; name?: string | null }> = [];

  // FAST PATH: pre-resolved district ids — the AUTHORITATIVE record ids the client
  // actually selected (SPA preference pickers) or a directional-zone expansion.
  // Batch-load their centroids/city in ONE query. This path is exact by id — it
  // can never mis-resolve to a same-named district in another city, which the
  // per-name fuzzy fallback below can.
  if (req.district_ids && req.district_ids.length) {
    const dm = await getModelByName(supabase, 'districts');
    if (dm) {
      const { data } = await supabase
        .from('unified_records').select('id, data').eq('model_id', dm.id).in('id', req.district_ids);
      for (const r of data ?? []) {
        if (!reqDistrictIds.includes(r.id)) reqDistrictIds.push(r.id);
        const cid = asStr(r.data.city_lookup) || null;
        if (cid && !reqCityIds.includes(cid)) reqCityIds.push(cid);
        const lat = asNum(r.data.centroid_lat);
        const lng = asNum(r.data.centroid_lng);
        const dname = asStr(r.data.display_name) || asStr(r.data.name_ar) || null;
        if (lat != null && lng != null) reqCentroids.push({ lat, lng, name: dname });
        if (reqDistrictId == null) { reqDistrictId = r.id; reqCityId = cid; reqLat = lat; reqLng = lng; }
      }
    }
  }

  // Per-name FUZZY resolution — only when no authoritative id resolved (free-text /
  // LLM-parsed requests). Never run on top of resolved ids: district names repeat
  // across Saudi cities and the fuzzy pick could add a wrong-city namesake to the
  // exact-match set.
  const districtNames = reqDistrictIds.length
    ? []
    : (req.districts && req.districts.length ? req.districts : req.district ? [req.district] : []);
  for (const dn of districtNames) {
    const token = (dn ?? '').trim();
    if (!token) continue;
    const resolved = await resolveRequestedDistrict(supabase, { ...req, district: token });
    if (!resolved) continue;
    if (!reqDistrictIds.includes(resolved.id)) reqDistrictIds.push(resolved.id);
    if (resolved.cityId && !reqCityIds.includes(resolved.cityId)) reqCityIds.push(resolved.cityId);
    if (resolved.lat != null && resolved.lng != null) reqCentroids.push({ lat: resolved.lat, lng: resolved.lng, name: token });
    if (reqDistrictId == null) {
      reqDistrictId = resolved.id;
      reqCityId = resolved.cityId;
      reqLat = resolved.lat;
      reqLng = resolved.lng;
    }
  }
  if (reqCityId == null && req.city) {
    reqCityId = await resolveRequestedCity(supabase, req);
  }
  if (reqCityId && !reqCityIds.includes(reqCityId)) reqCityIds.push(reqCityId);
  // Multiple acceptable cities (alternatives — OR): resolve EACH into the city-match
  // set so a project in ANY of them city-matches. `req.city` (the first) stays the
  // primary for the single-city paths above.
  if (req.cities && req.cities.length) {
    for (const cn of req.cities) {
      const token = (cn ?? '').trim();
      if (!token || (req.city && token === req.city.trim())) continue;
      const cid = await resolveRequestedCity(supabase, { ...req, city: token });
      if (cid && !reqCityIds.includes(cid)) reqCityIds.push(cid);
    }
  }

  // Selected location ELEMENTS (landmark anchors) as extra distance references —
  // every result's distance_km is to the NEAREST selected district OR element.
  if (opts.refPoints) {
    for (const p of opts.refPoints) {
      if (typeof p?.lat === 'number' && Number.isFinite(p.lat) && typeof p?.lng === 'number' && Number.isFinite(p.lng)) {
        reqCentroids.push({ lat: p.lat, lng: p.lng, name: p.name ?? null });
      }
    }
  }

  const verifyGeo = opts.verifyGeo === true;

  // PostGIS boundary verification: resolve every candidate project's REAL district
  // from its coordinates (point-in-polygon, one bulk RPC). The polygon-derived
  // district is the source of truth — matching uses it, not the stored text — so
  // an "exact" match is coordinate-verified. (Skipped when verifyGeo is off so the
  // legacy match_projects tool output is unchanged.)
  const polyMap: Map<string, string | null> = verifyGeo
    ? await resolvePolygonDistricts(supabase, rows)
    : new Map();

  // Resolve each candidate project's location ids to display names (shown in the
  // facts). Include BOTH the stored district id AND the polygon-derived district id
  // so the facts show the verified district name even when the stored one differs.
  const polyDistrictIds = [...polyMap.values()].filter((v): v is string => !!v);
  const districtNameById = await geoNameMap(supabase, 'districts', [
    ...rows.map((r) => recordLocationIds(r.data).district),
    ...polyDistrictIds,
  ]);
  const cityNameById = await geoNameMap(supabase, 'cities', rows.map((r) => recordLocationIds(r.data).city));

  // Rank by BAND first, then score — so a genuine good/strong match always
  // outranks a 'partial' one even if the partial has a higher raw score (e.g. a
  // wrong-type project whose location+budget inflate its number).
  const bandRank = (b: ScoredProject['band']) => (b === 'strong' ? 0 : b === 'good' ? 1 : 2);
  const byBandThenScore = (a: MatchResultItem, b: MatchResultItem) =>
    bandRank(a.match_band) - bandRank(b.match_band) || b.score - a.score;

  let anyDistrictExact = false;
  let anyNearby = false;

  // Build the GeoContext + per-result geo annotations for one record. When
  // verifyGeo is on, the project's district is the polygon that CONTAINS its pin
  // (source of truth) — not the stored text — and we attach geo_status,
  // mismatch_warnings, an honest geo_confidence, and any extra data_gaps.
  const geoFor = (r: RecordRow, loc: { district: string; city: string }, pmap: Map<string, string | null>, doVerify: boolean) => {
    const projLat = asNum(r.data.latitude);
    const projLng = asNum(r.data.longitude);
    if (!doVerify) {
      return {
        projLat,
        projLng,
        geoConfidence: asStr(r.data.geo_confidence) || null,
        projDistrictId: loc.district || null,
        projDistrictName: districtNameById.get(loc.district) ?? null,
        annotate: (_item: MatchResultItem) => {},
      };
    }
    const v = classifyGeo({
      lat: projLat,
      lng: projLng,
      storedDistrictId: loc.district || null,
      polygonDistrictId: pmap.get(r.id) ?? null,
    });
    const effDistrict = v.effectiveDistrictId;
    return {
      projLat,
      projLng,
      geoConfidence: v.geoConfidence,
      projDistrictId: effDistrict,
      // Show the VERIFIED district name when coords resolved one; else the stored.
      projDistrictName: districtNameById.get(effDistrict ?? loc.district) ?? null,
      annotate: (item: MatchResultItem) => {
        item.geo_status = v.status;
        item.geo_confidence = v.geoConfidence;
        if (v.mismatchWarnings.length) item.mismatch_warnings = v.mismatchWarnings;
        if (v.dataGaps.length) item.data_gaps = [...item.data_gaps, ...v.dataGaps];
      },
    };
  };

  const scoreInto = (sourceRows: RecordRow[], source: 'our_projects' | 'all_projects'): MatchResultItem[] => {
    const out: MatchResultItem[] = [];
    for (const r of sourceRows) {
      const name = asStr(r.data.project_name);
      if (!name) continue;
      if (!passesGeoGate(r.id)) continue; // location_items gate (before scoring)
      const loc = recordLocationIds(r.data);
      const g = geoFor(r, loc, polyMap, verifyGeo);
      const s = scoreProject(r.data, req, {
        projLat: g.projLat,
        projLng: g.projLng,
        reqLat,
        reqLng,
        reqDistrictId,
        reqCityId,
        reqDistrictIds,
        reqCityIds,
        reqCentroids,
        geoConfidence: g.geoConfidence,
        projDistrictId: g.projDistrictId,
        projCityId: loc.city || null,
        projDistrictName: g.projDistrictName,
        projCityName: cityNameById.get(loc.city) ?? null,
      });
      if (s.district_exact) anyDistrictExact = true;
      if (s.location_tier === 'nearby') anyNearby = true;
      if (s.score < MIN_RETURN) continue;
      if (s.available_units_zero && !includeSoldOut) continue; // sold-out excluded by default
      const item: MatchResultItem = {
        project_id: r.id,
        project_name: name,
        data_source: source,
        score: s.score,
        match_band: s.band,
        match_type: s.match_type,
        district_match_basis: s.district_match_basis,
        score_breakdown: s.breakdown,
        facts: s.facts,
        data_gaps: s.data_gaps,
        missing_info: s.missing_info,
        location_tier: s.location_tier,
        distance_km: s.distance_km,
        nearest_ref_name: s.nearest_ref_name,
        geo_confidence: s.geo_confidence,
      };
      g.annotate(item);
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

  // PASS 2 — all_projects. The LLM tool scores it ONLY on fallback (Tier-1 had no
  // good match). The grouped endpoint passes alwaysScoreAll so all three sources
  // are shown side by side, each labelled by source.
  const tier2 = (usedFallback || opts.alwaysScoreAll)
    ? scoreInto(rows.filter((r) => !tier1Ids.has(r.id)), 'all_projects')
    : [];

  // PASS 3 — market_listings (external scraped ads), scored as a third source via
  // the same deterministic scorer (each listing adapted to the project shape).
  // Only the grouped endpoint requests it (opts.includeMarket).
  //
  // Scope is the REQUESTED district(s) ONLY — the old 20km-neighbour expansion
  // pulled ≈17k listings for a dense Riyadh district and 504'd the edge function.
  // DB-side budget/bedrooms/type filters (wassell_market_candidates) shrink the set
  // so we score it IN FULL. We NEVER truncate by recency: if the filtered
  // exact-district set still exceeds MARKET_SCAN_LIMIT we return a 'too_many' signal
  // (with the missing criteria to ask for) instead of dropping listings.
  let market: MatchResultItem[] = [];
  let marketInfo: MarketInfo = { status: 'ok' };
  if (opts.includeMarket) {
    const mModel = await getModelByName(supabase, 'market_listings');
    if (mModel) {
      const districtIds = reqDistrictIds.length ? reqDistrictIds : reqDistrictId ? [reqDistrictId] : [];
      // ALL acceptable types feed the DB-side ILIKE filter (OR) — pre-filtering on
      // only the first type would drop the other acceptable types' listings before
      // scoring ever sees them.
      const reqTypeList = requestedPropertyTypes(req);
      const typeTerms = reqTypeList.length
        ? [...new Set(reqTypeList.flatMap((t) => propertyTypeTerms(t)))]
        : null;
      const baseArgs = {
        p_model_id: mModel.id,
        p_budget_min: req.budget_min ?? null,
        p_budget_max: req.budget_max ?? null,
        p_bedrooms: req.bedrooms ?? null,
        p_type_terms: typeTerms,
      };
      // Market SCOPE: the requested district(s) when set; ELSE the client's
      // location_items AREA (geoGate = geo-matched record ids, which include the
      // in-area listing ids), so an element/district preference alone scopes market
      // WITHOUT forcing the rep to also pick a district. Neither → a whole city is
      // too broad to scan in full (needs_district). DB-side budget/bed/type filters +
      // the count-then-paginate too_many guard apply identically to both scopes.
      let rpcArgs: Record<string, unknown> | null = null;
      if (districtIds.length > 0) {
        rpcArgs = { ...baseArgs, p_district_ids: districtIds };
      } else if (geoGate && geoGate.size > 0) {
        rpcArgs = { ...baseArgs, p_district_ids: null, p_record_ids: [...geoGate] };
      } else {
        marketInfo = { status: 'needs_district' };
      }
      if (rpcArgs) {
        try {
          // ONE call: returns { total, rows } as a single jsonb value (NOT subject to
          // PostgREST's ~1000-row response cap), and the expensive filter (id/district +
          // budget/bed/type + per-row RLS) runs EXACTLY ONCE. The old count + 3-page
          // fetch was 4 round-trips that each re-scanned + re-ran the per-row RLS — ~4×
          // the work, which made a dense in-area set (2595 villas) take ~16s. `total`
          // still drives the too_many guard (nothing dropped — we ask for more criteria).
          const { data: jsonResult, error: jErr } = await supabase.rpc('wassell_market_candidates_json', {
            ...rpcArgs, p_limit: MARKET_SCAN_LIMIT,
          });
          if (jErr) throw new Error(jErr.message);
          const total = Number((jsonResult as { total?: number } | null)?.total ?? 0);
          if (total > MARKET_SCAN_LIMIT) {
            marketInfo = { status: 'too_many', count: total, suggest: marketSuggestions(req) };
          } else {
            const listingRows = ((jsonResult as { rows?: RecordRow[] } | null)?.rows ?? []) as RecordRow[];
            const noMarketVerify = new Map<string, string | null>();
            for (const [k, v] of await geoNameMap(supabase, 'districts', listingRows.map((r) => recordLocationIds(r.data).district))) districtNameById.set(k, v);
            for (const [k, v] of await geoNameMap(supabase, 'cities', listingRows.map((r) => recordLocationIds(r.data).city))) cityNameById.set(k, v);
            for (const r of listingRows) {
              const adapted = adaptListingToScorable(r.data);
              const name = asStr(adapted.project_name);
              if (!name) continue;
              if (!passesGeoGate(r.id)) continue; // location_items gate (before scoring)
              const loc = recordLocationIds(r.data);
              // Market listings are EXTERNAL / unverified by design (flagged "verify
              // before offering") and keep their stored district + own coords
              // (doVerify=false — boundary verification is for OUR project catalog).
              const g = geoFor(r, loc, noMarketVerify, false);
              const s = scoreProject(adapted, req, {
                projLat: g.projLat,
                projLng: g.projLng,
                reqLat,
                reqLng,
                reqDistrictId,
                reqCityId,
                reqDistrictIds,
                reqCityIds,
                reqCentroids,
                geoConfidence: g.projLat != null && g.projLng != null ? 'high' : null,
                projDistrictId: g.projDistrictId,
                projCityId: loc.city || null,
                projDistrictName: g.projDistrictName,
                projCityName: cityNameById.get(loc.city) ?? null,
              });
              if (s.score < MIN_RETURN) continue;
              if (s.available_units_zero && !includeSoldOut) continue;
              const item: MatchResultItem = {
                project_id: r.id,
                project_name: name,
                data_source: 'market_listings',
                requires_verification: true,
                verification_warning: MARKET_WARNING,
                score: s.score,
                match_band: s.band,
                match_type: s.match_type,
                district_match_basis: s.district_match_basis,
                score_breakdown: s.breakdown,
                facts: s.facts,
                data_gaps: s.data_gaps,
                missing_info: s.missing_info,
                location_tier: s.location_tier,
                distance_km: s.distance_km,
                nearest_ref_name: s.nearest_ref_name,
                geo_confidence: s.geo_confidence,
              };
              g.annotate(item);
              market.push(item);
            }
            market = market.sort(byBandThenScore);
          }
        } catch (err) {
          // Non-fatal: a market read failure must not sink the recommendation
          // (our_projects + all_projects still return). Log loudly AND signal
          // 'unavailable' so the UI shows "couldn't load market — retry" instead of
          // a misleading "0 market matches" (only if we hadn't already classified it).
          console.error('[matchProjectsCore] market_listings RPC failed:', err instanceof Error ? err.message : String(err));
          if (marketInfo.status === 'ok') marketInfo = { status: 'unavailable' };
        }
      }
    }
  }

  const notes: string[] = [];
  if (req.district && !anyDistrictExact) {
    if (anyNearby) {
      notes.push(`No project in "${req.district}" exactly. Showing NEARBY-district alternatives ranked by real distance to ${req.district}'s centre (each result carries distance_km) plus same-city options.`);
    } else if (reqLat == null) {
      notes.push(`No project in "${req.district}", and no coordinates for that district — showing same-city text alternatives (distance could not be computed).`);
    } else {
      notes.push(`No project in or near "${req.district}" within ${NEARBY_MAX_KM} km — showing same-city alternatives.`);
    }
  }
  if (usedFallback) {
    notes.push('No good match in our_projects — falling back to all_projects. Those results MUST be verified before offering.');
  }

  return {
    ok: true,
    requirements: req,
    district_exact_match: anyDistrictExact,
    used_fallback: usedFallback,
    notes,
    reqDistrictId,
    reqHasCentroid: reqLat != null && reqLng != null,
    our: tier1,
    all: tier2,
    market,
    marketInfo,
  };
}

/**
 * The `match_projects` tool surface — a thin string wrapper over matchProjectsCore.
 * The shape is kept BYTE-IDENTICAL to the historical output (the LLM + match.ts +
 * the Follow-up panel all depend on it): two never-mixed tiers, all_projects ONLY
 * present when the Tier-1 fallback fired, each results array sliced to TOP_N.
 */
export async function matchProjects(supabase: SupabaseClient, req: MatchRequirements): Promise<string> {
  const core = await matchProjectsCore(supabase, req);
  if (!core.ok) {
    return JSON.stringify({ error: core.error, our_projects: { count: 0, results: [] }, all_projects: null });
  }
  return JSON.stringify({
    requirements_echo: core.requirements,
    district_exact_match: core.district_exact_match,
    used_fallback: core.used_fallback,
    our_projects: {
      source: 'our_projects',
      count: core.our.length,
      results: core.our.slice(0, TOP_N),
    },
    all_projects: core.used_fallback
      ? {
          source: 'all_projects',
          requires_verification: true,
          warning: VERIFY_WARNING,
          count: core.all.length,
          results: core.all.slice(0, TOP_N),
        }
      : null,
    notes: core.notes,
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

// ─── search_projects (find by name → ids) ────────────────────────────────────

interface SearchProjectsInput {
  query?: string;
}

/** Resolve projects by NAME so the agent can fetch info / get ids for
 *  get_project & compare_projects. Pure text match over project_name; ranks
 *  exact-normalized first, then prefix, then substring. Tags each hit with its
 *  tier (our_projects vs all_projects) + requires_verification. */
async function searchProjects(supabase: SupabaseClient, input: SearchProjectsInput): Promise<string> {
  const q = typeof input.query === 'string' ? input.query.trim() : '';
  if (!q) return JSON.stringify({ error: 'Provide a project name to search.', count: 0, results: [] });

  const model = await getModelByName(supabase, 'all_projects');
  if (!model) return JSON.stringify({ error: 'all_projects model not found', count: 0, results: [] });

  let rows: RecordRow[];
  let tier1Ids: Set<string>;
  try {
    [rows, tier1Ids] = await Promise.all([pageRecords(supabase, model.id), loadTier1ProjectIds(supabase)]);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err), count: 0, results: [] });
  }

  const qn = normalizeForSearch(q);
  const rank = (name: string): number => {
    const n = normalizeForSearch(name);
    if (n === qn) return 0;
    if (n.startsWith(qn)) return 1;
    return 2;
  };
  const hits = rows
    .map((r) => ({ r, name: asStr(r.data.project_name) }))
    .filter((x) => x.name && fuzzyContains(x.name, q))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length)
    .slice(0, 10);

  // Resolve the hits' location ids → city/district display names (relational only).
  const districtNameById = await geoNameMap(supabase, 'districts', hits.map(({ r }) => recordLocationIds(r.data).district));
  const cityNameById = await geoNameMap(supabase, 'cities', hits.map(({ r }) => recordLocationIds(r.data).city));
  const results = hits.map(({ r }) => {
    const isOurs = tier1Ids.has(r.id);
    const loc = recordLocationIds(r.data);
    return {
      project_id: r.id,
      project_name: asStr(r.data.project_name),
      city: cityNameById.get(loc.city) ?? '',
      district: districtNameById.get(loc.district) ?? '',
      data_source: (isOurs ? 'our_projects' : 'all_projects') as 'our_projects' | 'all_projects',
      requires_verification: !isOurs,
    };
  });

  return JSON.stringify({
    query: q,
    count: results.length,
    results,
    note:
      results.length === 0
        ? `No project matched "${q}". Ask the salesperson to re-check the name, or gather requirements and use match_projects instead.`
        : 'Pick the right project_id; for facts call get_project, for a comparison call compare_projects. all_projects results require verification before offering.',
  });
}

// ─── compare_projects (retrieval) ────────────────────────────────────────────

interface CompareInput {
  project_ids: string[];
  requirements?: MatchRequirements;
}

/** Pick the project_id that wins a numeric dimension (min for price, max for the rest). */
function dimWinner(
  rows: RecordRow[],
  key: string,
  pick: 'min' | 'max',
  side: 'min' | 'max',
): { project_id: string; value: number } | null {
  let best: { project_id: string; value: number } | null = null;
  for (const r of rows) {
    const range = pickRange(r.data, key);
    const v = range ? range[side] : asNum(r.data[key]);
    if (v == null) continue;
    if (!best || (pick === 'min' ? v < best.value : v > best.value)) best = { project_id: r.id, value: v };
  }
  return best;
}

async function compareProjects(supabase: SupabaseClient, input: CompareInput): Promise<string> {
  const ids = (input.project_ids ?? []).filter((x): x is string => typeof x === 'string' && !!x).slice(0, 4);
  if (ids.length < 2) return JSON.stringify({ error: 'Provide 2–4 project_ids to compare (get them from match_projects/search).' });

  const { data, error } = await supabase.from('unified_records').select('id, data').in('id', ids);
  if (error) return JSON.stringify({ error: error.message });
  const rows = (data ?? []) as RecordRow[];
  if (rows.length < 2) return JSON.stringify({ error: 'Could not load at least 2 of the requested projects.' });

  const req = input.requirements ?? {};
  const scored = Object.keys(req).length > 0;
  const tier1Ids = await loadTier1ProjectIds(supabase);
  const districtNameById = await geoNameMap(supabase, 'districts', rows.map((r) => recordLocationIds(r.data).district));
  const cityNameById = await geoNameMap(supabase, 'cities', rows.map((r) => recordLocationIds(r.data).city));

  const projects = rows.map((r) => {
    const loc = recordLocationIds(r.data);
    const s = scoreProject(r.data, req, {
      projDistrictId: loc.district || null,
      projCityId: loc.city || null,
      projDistrictName: districtNameById.get(loc.district) ?? null,
      projCityName: cityNameById.get(loc.city) ?? null,
    });
    const isOurs = tier1Ids.has(r.id);
    return {
      project_id: r.id,
      project_name: asStr(r.data.project_name),
      data_source: (isOurs ? 'our_projects' : 'all_projects') as 'our_projects' | 'all_projects',
      requires_verification: !isOurs,
      score: scored ? s.score : null,
      match_band: scored ? s.band : null,
      facts: s.facts,
    };
  });

  const dimension_winners = {
    cheapest: dimWinner(rows, 'price_range', 'min', 'min'),
    largest_area: dimWinner(rows, 'area_range', 'max', 'max'),
    most_bedrooms: dimWinner(rows, 'bedroom_range', 'max', 'max'),
    most_available: dimWinner(rows, 'available_units', 'max', 'max'),
  };

  return JSON.stringify({
    projects,
    dimension_winners,
    note: 'Compare ONLY on these facts. When `requirements` was provided, each project carries a deterministic score/band — quote them verbatim. Mark requires_verification (all_projects) projects as needing verification.',
  });
}

// ─── get_customer_context (retrieval + deterministic lead temperature) ───────

const STAGE_WON = new Set(['مغلق ناجح']);
const STAGE_DEAD = new Set(['خاسر', 'غير مؤهل']);
const STAGE_HIGH_INTENT = new Set(['زيارة', 'متابعة بعد الزيارة', 'عرض سعر', 'حجز', 'تمويل', 'الإفراغ']);
const STATUS_COLD = ['بارد', 'غير مهتم', 'غير مؤهل'];

/** KSA subscriber number (last 9 digits, mobile starts with 5) for matching
 *  across the mixed stored formats (+966…, 05…, bare 5…). */
function phoneKey(raw: string): string | null {
  let d = (raw || '').replace(/\D/g, '');
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length >= 9) d = d.slice(-9);
  return d.length === 9 ? d : null;
}

interface LeadTemp {
  temperature: 'hot' | 'warm' | 'cold' | 'won' | 'lost';
  reasons: string[];
  days_since_activity: number | null;
}

/** Deterministic lead temperature from CRM signals — no LLM judgement. */
function computeLeadTemperature(d: Record<string, unknown>): LeadTemp {
  const stage = asStr(d.client_stage);
  const status = asStr(d.client_status);
  const lastIso = asStr(d.last_activity_at);
  const reasons: string[] = [];
  const lastMs = lastIso ? Date.parse(lastIso) : NaN;
  const days = Number.isFinite(lastMs) ? Math.floor((Date.now() - lastMs) / 86_400_000) : null;

  if (STAGE_WON.has(stage)) return { temperature: 'won', reasons: ['Stage: Closed Won'], days_since_activity: days };
  if (STAGE_DEAD.has(stage)) return { temperature: 'lost', reasons: [`Stage: ${stage}`], days_since_activity: days };

  const highIntent = STAGE_HIGH_INTENT.has(stage);
  const coldStatus = STATUS_COLD.some((s) => status.includes(s));
  if (highIntent) reasons.push(`Active stage: ${stage}`);
  if (days != null) reasons.push(`${days} day(s) since last activity`);
  if (coldStatus) reasons.push(`Status: ${status}`);

  let temperature: LeadTemp['temperature'];
  if (coldStatus) temperature = 'cold';
  else if (days != null && days > 14) temperature = 'cold';
  else if (highIntent && days != null && days <= 3) temperature = 'hot';
  else if (highIntent) temperature = 'warm';
  else if (days != null && days <= 3) temperature = 'warm';
  else temperature = 'warm';
  return { temperature, reasons, days_since_activity: days };
}

function cleanClientPrefs(
  d: Record<string, unknown>,
  cityNames: string[],
  districtNames: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '' || v === '#REF') return;
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = v;
  };
  put('budget', d.budget);
  put('preferred_area', d.preferred_area);
  // Relational geography only — names resolved from preferred_cities / preferred_districts
  // lookups (no legacy preferred_city / preferred_neighborhoods text).
  put('preferred_cities', cityNames);
  put('preferred_districts', districtNames);
  put('preferred_unit_type', d.preferred_unit_type);
  put('preferred_amenities', d.preferred_amenities);
  put('preferred_direction', d.preferred_direction);
  return out;
}

interface CustomerLookup {
  client_id?: string;
  phone?: string;
  name?: string;
}

async function getCustomerContext(supabase: SupabaseClient, input: CustomerLookup): Promise<string> {
  const model = await getModelByName(supabase, 'clients');
  if (!model) return JSON.stringify({ found: false, error: 'clients model not found' });

  let rec: RecordRow | null = null;
  // Validate an echoed client_id is really a clients record before trusting it.
  if (input.client_id) {
    const { data } = await supabase.from('unified_records').select('id, data, model_id').eq('id', input.client_id).maybeSingle();
    if (data && (data as { model_id?: string }).model_id === model.id) rec = data as RecordRow;
  }
  if (!rec && (input.phone || input.name)) {
    const rows = await pageRecords(supabase, model.id, 5); // RLS-scoped to the rep's clients
    // Phone is effectively unique — match on it first.
    if (input.phone) {
      const wantPhone = phoneKey(input.phone);
      if (wantPhone) rec = rows.find((r) => phoneKey(asStr(r.data.phone_number)) === wantPhone) ?? null;
    }
    // Name — NEVER guess the first on duplicates; surface them so the agent asks.
    if (!rec && input.name) {
      const candidates: ResolvedClient[] = rows.map((r) => ({
        id: r.id,
        name: asStr(r.data.client_name),
        phone: asStr(r.data.phone_number),
      }));
      const resolution = resolveClientFromCandidates(candidates, normalizeForSearch(input.name));
      if (resolution.status === 'resolved') {
        rec = rows.find((r) => r.id === resolution.client.id) ?? null;
      } else if (resolution.status === 'ambiguous') {
        return JSON.stringify({
          found: false,
          ambiguous: true,
          candidates: resolution.candidates.map((c) => ({ name: c.name, phone: c.phone })),
          note: 'MORE THAN ONE client matches this name. Do NOT pick one — ask the salesperson which client (by phone or full name). For a task this would otherwise attach to the WRONG client.',
        });
      }
    }
  }

  if (!rec) {
    return JSON.stringify({
      found: false,
      note: 'No matching client in the CRM (or not in your scope). Ask the salesperson for the exact client name or phone, or proceed without lead context — never invent client history.',
    });
  }

  const d = rec.data;
  // Client geography is the multi-mode `location` cascade: { region:[], city:[], district:[] }.
  const clientLoc = d.location && typeof d.location === 'object' && !Array.isArray(d.location)
    ? (d.location as Record<string, unknown>) : {};
  const [cityNames, districtNames] = await Promise.all([
    resolveLookupNames(supabase, 'cities', clientLoc.city),
    resolveLookupNames(supabase, 'districts', clientLoc.district),
  ]);
  const temp = computeLeadTemperature(d);
  const dueIso = asStr(d.next_action_due_at);
  const overdue = dueIso ? Date.parse(dueIso) < Date.now() : false;
  const nextType = asStr(d.next_action_type);

  return JSON.stringify({
    found: true,
    client: {
      id: rec.id,
      name: asStr(d.client_name),
      phone: asStr(d.phone_number),
      stage: asStr(d.client_stage),
      status: asStr(d.client_status),
      lifecycle_health: asStr(d.lifecycle_health),
    },
    lead_temperature: temp.temperature,
    temperature_reasons: temp.reasons,
    next_action: dueIso || nextType ? { type: nextType || null, due_at: dueIso || null, overdue } : null,
    signals: { days_since_activity: temp.days_since_activity, last_activity_at: asStr(d.last_activity_at) },
    preferences: cleanClientPrefs(d, cityNames, districtNames),
    note: 'lead_temperature, stage, status, next_action are DETERMINISTIC from the CRM — quote them, do not re-judge. If a field is empty it is unknown; never invent client history.',
  });
}

// ─── propose_task client resolution (anti-hallucinated-id) ───────────────────

const CLIENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedClient {
  id: string;
  name: string;
  phone: string;
}

/**
 * The result of resolving a client for a proposed task:
 *  - resolved   → exactly one real client; the task may be confirmed.
 *  - not_found  → no real client; the card is shown disabled.
 *  - ambiguous  → multiple real clients match the name; the card is shown
 *                 disabled and lists the candidates — the salesperson must
 *                 disambiguate (re-ask with the full name / phone). NEVER guessed.
 */
export type ClientResolution =
  | { status: 'resolved'; client: ResolvedClient }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: ResolvedClient[] };

/**
 * PURE decision over a candidate list — exported for unit testing the
 * never-guess-on-ambiguity rule. Prefers an EXACT (normalized) name match; only
 * falls to a fuzzy substring match when there's no exact one, and in BOTH cases
 * requires a UNIQUE hit — two clients with the same name resolve to `ambiguous`,
 * never to "the first one".
 */
export function resolveClientFromCandidates(
  candidates: ResolvedClient[],
  wantNameNorm: string,
): ClientResolution {
  if (!wantNameNorm) return { status: 'not_found' };
  const exact = candidates.filter((c) => normalizeForSearch(c.name) === wantNameNorm);
  if (exact.length === 1) return { status: 'resolved', client: exact[0]! };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.slice(0, 6) };
  const contains = candidates.filter((c) => fuzzyContains(c.name, wantNameNorm));
  if (contains.length === 1) return { status: 'resolved', client: contains[0]! };
  if (contains.length > 1) return { status: 'ambiguous', candidates: contains.slice(0, 6) };
  return { status: 'not_found' };
}

/**
 * Resolve the authoritative client for a proposed task. The model sometimes
 * echoes a bogus/invented client_id, so never trust it blindly:
 *  1. Accept the echoed id ONLY if it is a REAL clients record (exact id match).
 *  2. Otherwise resolve by client_name — but NEVER guess: a unique match resolves,
 *     duplicates are reported as `ambiguous`, none as `not_found`.
 */
export async function resolveClient(
  supabase: SupabaseClient,
  rawId: unknown,
  name: unknown,
): Promise<ClientResolution> {
  const model = await getModelByName(supabase, 'clients');
  if (!model) return { status: 'not_found' };

  // 1. Echoed id — only if it is genuinely a clients record (unambiguous).
  if (typeof rawId === 'string' && CLIENT_UUID_RE.test(rawId)) {
    const { data } = await supabase
      .from('unified_records')
      .select('id, data, model_id')
      .eq('id', rawId)
      .maybeSingle();
    if (data && (data as { model_id?: string }).model_id === model.id) {
      const row = data as RecordRow;
      return { status: 'resolved', client: { id: row.id, name: asStr(row.data.client_name), phone: asStr(row.data.phone_number) } };
    }
  }

  // 2. By name — RLS-scoped to the rep's clients; never guess on duplicates.
  const wantName = typeof name === 'string' ? normalizeForSearch(name) : '';
  if (!wantName) return { status: 'not_found' };
  const rows = await pageRecords(supabase, model.id, 5);
  const candidates: ResolvedClient[] = rows.map((r) => ({
    id: r.id,
    name: asStr(r.data.client_name),
    phone: asStr(r.data.phone_number),
  }));
  return resolveClientFromCandidates(candidates, wantName);
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
      // ── Retrieval ──
      case 'match_projects':
        return await matchProjects(supabase, (input ?? {}) as MatchRequirements);
      case 'get_project':
        return await getProject(supabase, input as { project_id: string });
      case 'search_projects':
        return await searchProjects(supabase, (input ?? {}) as SearchProjectsInput);
      case 'compare_projects':
        return await compareProjects(supabase, (input ?? {}) as CompareInput);
      case 'get_customer_context':
        return await getCustomerContext(supabase, (input ?? {}) as CustomerLookup);

      // ── Delivery channels (the structured payload is surfaced to the browser
      //    by api/match.ts as a dedicated SSE event → a card; nothing persisted). ──
      case 'emit_recommendation':
        return JSON.stringify({ ok: true, note: 'Recommendation card delivered. Add one short closing line; do not repeat the full recommendation as text.' });
      case 'emit_comparison':
        return JSON.stringify({ ok: true, note: 'Comparison card delivered. Add one short closing line.' });
      case 'emit_next_action':
        return JSON.stringify({ ok: true, note: 'Next-action card delivered. Add one short closing line.' });
      case 'emit_message':
        return JSON.stringify({ ok: true, note: 'Message draft card delivered with a copy button. Add one short closing line.' });

      // ── Action (confirmation-gated) — propose_task NEVER writes; it surfaces a
      //    proposal the SALESPERSON must confirm in the UI before any record is
      //    created. The write happens client-side on confirm. ──
      case 'propose_task':
        return JSON.stringify({
          ok: true,
          status: 'awaiting_confirmation',
          note: 'A task proposal card was shown to the salesperson with Confirm / Cancel. NO task has been created yet. Tell them to review and press Confirm to create it — do NOT claim the task is done.',
        });

      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

// Exported for unit testing the deterministic scorer + metadata enforcement.
export const __test = { scoreProject, collectAuthoritativeMeta, reconcileRecommendationPayload, haversineKm, computeLeadTemperature, resolveClientFromCandidates, adaptListingToScorable };
