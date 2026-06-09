/**
 * Wassel copywriter agent — shared server-side logic.
 *
 * The "brain" of the real-estate copywriter agent: system prompt (the
 * methodology), the tools Claude can call, and the executor that turns tool
 * calls into Supabase reads. Consumed by `api/copywriter.ts`.
 *
 * Design notes
 *  - RETRIEVAL = the structured analysis fields ARE the index. `search_reels`
 *    filters the enriched `competitors` library (built by reelAnalyst) by
 *    angle / trigger / tone / hook_type / competitor + free text. No embeddings.
 *  - We REUSE the sales agent's project tools verbatim — `search_projects` /
 *    `get_project` are delegated to `executeAgentTool` and their schemas are
 *    pulled from `AGENT_TOOLS`, so there's a single source of truth and no
 *    drift. The copywriter needs the SAME project facts the sales agent reads.
 *  - The system prompt is one deterministic const so prompt caching works.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AGENT_TOOLS, executeAgentTool } from './aiAgent.js';
import {
  HOOK_TYPES,
  ANGLES,
  PSYCH_TRIGGERS,
  TONES,
  CTA_TYPES,
} from './reelAnalyst.mjs';

export const COPYWRITER_MODEL = 'claude-opus-4-7';
export const COPYWRITER_MAX_TOKENS = 16_000;

// Only reels that have been cleaned + analyzed are useful as patterns.
const USABLE_STATUSES = new Set(['analyzed', 'reviewed']);
// The library holds competitor reels, competitor posts, and (optionally) our
// own scripts. The copywriter retrieves over reel scripts + our scripts.
const REEL_TYPES = new Set(['reel_script', 'our_script']);

// Deterministic, stable across requests → prompt-cacheable. DO NOT interpolate.
export const COPYWRITER_SYSTEM_PROMPT = `You are an expert Saudi real-estate marketing copywriter and short-form video scriptwriter for Wassel Real Estate (وصل العقارية). You write Arabic reel / TikTok scripts and hooks in the proven style of the strongest Saudi real-estate content creators.

# What makes you different
You are NOT a generic AI writer. Every script you produce is grounded in a knowledge base of REAL competitor reels that performed in the Saudi market — their exact hooks, angles, psychological triggers, structures, tones, and CTAs have been analyzed and indexed. You write like the best Saudi real-estate marketers because you study what they actually did, then adapt it to OUR projects and brand.

# Your knowledge sources — USE THE TOOLS, never write from generic knowledge
1. search_reels / get_reel — the competitor reel library + our own past scripts. The PROVEN patterns. Filter by the angle / trigger / tone / hook_type that fits the project.
2. search_projects / get_project — OUR real projects (name, district, city, price, unit types, areas, amenities). Use the REAL facts; never invent.

# CRITICAL workflow — retrieve BEFORE you write
Before generating or improving ANY script:
1. If the task references one of our projects, call search_projects (by name / keywords) then get_project for the real facts.
2. Call search_reels filtered to the angles / triggers that fit (e.g. a villa in a prime district → angle:["location","luxury","exclusivity"]). Study the returned hooks + structures, then call get_reel on 2–4 of the strongest to read their full transcript.
3. THEN write a NEW script that adapts a proven structure + hook style to our project. Never copy a competitor's words — adapt the PATTERN (the hook mechanism, the beat order, the trigger) to our facts and brand.
Briefly tell the user which pattern / structure you're adapting (one line) so they trust the output is grounded.

If you write a script without calling search_reels first, you have failed — you are guessing instead of using the dataset, which is the whole point of this agent.

# Your capabilities — detect which from the user's message
1. GENERATE REEL SCRIPT — input: a project (or its details). Output a complete, ready-to-film Arabic reel script:
   • 🎬 الخطّاف (Hook) — the first 2–3 seconds that stop the scroll. Match a proven hook_type.
   • 🎯 الزاوية / المحفّز — one line: the angle + psychological trigger you are using.
   • 🎞️ المشاهد — the body as scene-by-scene voiceover beats (مشهد ١، مشهد ٢ …): each a short spoken line + a note of what's on screen.
   • 📢 الدعوة (CTA) — the exact closing call to action.
   Keep it tight (a reel is 20–45s ≈ 60–130 words of voiceover). End with 2–3 alternative hooks.

2. IMPROVE EXISTING SCRIPT — input: our draft. First diagnose it (hook strength, angle clarity, structure, CTA) against proven patterns from search_reels, then return: (a) a short diagnosis (what's weak + why), and (b) the improved full script. Preserve the user's intent and any real facts; sharpen the hook, tighten the structure, strengthen the CTA.

3. GENERATE HOOKS — input: a project / topic. Output 6–10 distinct hook options in Arabic, each labeled with its mechanism (سؤال / فضول / صدمة / نمط حياة / فرصة استثمارية / طرح مشكلة / تصريح جريء). Vary the mechanism. Ground them in hook patterns from search_reels.

4. ANALYZE SCRIPT — input: any script. Output a breakdown — الخطّاف ونوعه، الزاوية، المحفّز النفسي، بنية النص، الدعوة — plus concrete improvement suggestions, comparing against a proven pattern (pull a comparable reel via search_reels).

# Language & brand voice
- Write in Arabic. Match the energetic, warm, confident Saudi real-estate creator voice the dataset shows — colloquial where natural (اللي، وش، حياكم الله، ما شاء الله تبارك الرحمن) but never sloppy.
- Hooks must earn the first 3 seconds — a bold statement, real curiosity, or a sharp question (e.g. "قد شفت الفيلا اللي ما لها مثيل؟" or "بيت العمر اللي تدوّر عليه موجود في …").
- We are "وصل العقارية" / "Wassel". NEVER say "Wassel CRM" or name any internal system or tool.
- SAR currency; format with separators (1,990,000 ر.س).
- Keep it filmable: short spoken lines, one idea per scene.

# Honesty
- Use ONLY real project facts from get_project. If a needed fact (price, area, district, completion date) is missing, write a clear placeholder like «[السعر]» / «[المساحة]» for the team to fill — NEVER invent numbers.
- Don't promise discounts, availability, or timelines that aren't in the data.

# Interaction
- If the user names a project, fetch it. If they're vague about which project, ask ONE clarifying question (which project / what's the main selling point), then proceed.
- Your replies are work product (scripts), so they can be longer than a chat — but stay focused; no filler.

Begin when the user sends their first message.`;

type ToolUnion = Anthropic.Messages.Tool;

const projectTools = AGENT_TOOLS.filter(
  (t) => t.name === 'search_projects' || t.name === 'get_project',
);

export const COPYWRITER_TOOLS: ToolUnion[] = [
  {
    name: 'search_reels',
    description:
      'Search the competitor reel knowledge base (analyzed real-estate marketing reels from top Saudi creators, plus our own past scripts). Each result carries the PROVEN pattern: exact hook, hook_type, angle(s), psychological trigger(s), script structure, tone(s), and CTA. Call this BEFORE writing or improving any script and filter by the angle / trigger / tone / hook_type that fits the project. Returns compact summaries; call get_reel for the full cleaned transcript of a reel you want to study or emulate.',
    input_schema: {
      type: 'object',
      properties: {
        angle: {
          type: 'array',
          items: { type: 'string', enum: ANGLES },
          description: 'Match reels selling any of these angles. Pick the ones matching the project.',
        },
        psych_trigger: {
          type: 'array',
          items: { type: 'string', enum: PSYCH_TRIGGERS },
          description: 'Match reels activating any of these psychological triggers.',
        },
        tone: {
          type: 'array',
          items: { type: 'string', enum: TONES },
          description: 'Match reels with any of these tones.',
        },
        hook_type: {
          type: 'string',
          enum: HOOK_TYPES,
          description: 'Match reels whose hook uses this mechanism.',
        },
        cta_type: {
          type: 'string',
          enum: CTA_TYPES,
          description: 'Match reels with this kind of call to action.',
        },
        competitor: {
          type: 'string',
          description: 'Match a specific competitor handle — substring of the reel name, e.g. "radah.re" or "rakez".',
        },
        source: {
          type: 'string',
          enum: ['competitor', 'ours', 'all'],
          description: 'competitor = other creators\' reels; ours = our own past scripts; all = both (default).',
        },
        query: {
          type: 'string',
          description: 'Free-text over the cleaned transcript, hook, and structure (district, project type, theme keywords).',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 12, max 25).',
        },
      },
    },
  },
  {
    name: 'get_reel',
    description:
      'Fetch the full cleaned transcript + complete analysis of one reel by its id (returned by search_reels). Use to study a strong example in depth before adapting its structure / hook to our project.',
    input_schema: {
      type: 'object',
      properties: {
        reel_id: { type: 'string', description: 'The `id` returned by search_reels.' },
      },
      required: ['reel_id'],
    },
  },
  ...projectTools,
];

// ─── Tool execution ───────────────────────────────────────────────────────

interface ReelRow {
  id: string;
  data: Record<string, unknown>;
}

async function getModelIdByName(supabase: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await supabase.from('models').select('id').eq('name', name).maybeSingle();
  if (error || !data) return null;
  return data.id as string;
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

interface ReelSearchInput {
  angle?: string[];
  psych_trigger?: string[];
  tone?: string[];
  hook_type?: string;
  cta_type?: string;
  competitor?: string;
  source?: 'competitor' | 'ours' | 'all';
  query?: string;
  limit?: number;
}

async function searchReels(supabase: SupabaseClient, input: ReelSearchInput): Promise<string> {
  const modelId = await getModelIdByName(supabase, 'competitors');
  if (!modelId) return JSON.stringify({ error: 'competitors model not found', reels: [] });

  // Page the library (frozen-safe via unified_records). The analyzed set is a
  // few hundred rows — well within a couple of pages.
  const pageSize = 1000;
  const MAX_PAGES = 5;
  const rows: ReelRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * pageSize;
    const { data, error } = await supabase
      .from('unified_records')
      .select('id, data')
      .eq('model_id', modelId)
      .range(from, from + pageSize - 1);
    if (error) return JSON.stringify({ error: error.message, reels: [] });
    const batch = (data ?? []) as ReelRow[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  const wantAngles = (input.angle ?? []).map((s) => s.toLowerCase());
  const wantTriggers = (input.psych_trigger ?? []).map((s) => s.toLowerCase());
  const wantTones = (input.tone ?? []).map((s) => s.toLowerCase());
  const source = input.source ?? 'all';
  const competitorNeedle = (input.competitor ?? '').toLowerCase().trim();
  const queryTerms = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

  const overlap = (have: string[], want: string[]): number =>
    want.length === 0 ? 0 : have.filter((h) => want.includes(h.toLowerCase())).length;

  const scored = rows
    .map((r) => {
      const d = r.data;
      const type = asStr(d.type);
      const status = asStr(d.processing_status);
      // Hard filters: must be a usable, analyzed reel/our-script.
      if (!REEL_TYPES.has(type) || !USABLE_STATUSES.has(status)) return null;
      if (source === 'competitor' && type !== 'reel_script') return null;
      if (source === 'ours' && type !== 'our_script') return null;

      const name = asStr(d.name);
      if (competitorNeedle && !name.toLowerCase().includes(competitorNeedle)) return null;

      if (input.hook_type && asStr(d.hook_type) !== input.hook_type) return null;
      if (input.cta_type && asStr(d.cta_type) !== input.cta_type) return null;

      const angle = asArr(d.angle);
      const trigger = asArr(d.psych_trigger);
      const tone = asArr(d.tone);

      // If a facet filter is given, require at least one overlap.
      if (wantAngles.length && overlap(angle, wantAngles) === 0) return null;
      if (wantTriggers.length && overlap(trigger, wantTriggers) === 0) return null;
      if (wantTones.length && overlap(tone, wantTones) === 0) return null;

      let score = 0;
      score += overlap(angle, wantAngles) * 3;
      score += overlap(trigger, wantTriggers) * 2;
      score += overlap(tone, wantTones) * 1;
      if (input.hook_type) score += 2;
      if (queryTerms.length) {
        const hay = `${asStr(d.clean_content)} ${asStr(d.hook)} ${asStr(d.structure)} ${name}`.toLowerCase();
        for (const t of queryTerms) if (hay.includes(t)) score += 1;
      }

      return {
        score,
        summary: {
          id: r.id,
          competitor: name,
          type,
          hook: asStr(d.hook),
          hook_type: asStr(d.hook_type),
          angle,
          psych_trigger: trigger,
          structure: asStr(d.structure),
          tone,
          cta: asStr(d.cta),
          cta_type: asStr(d.cta_type),
        },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score);

  const limit = Math.max(1, Math.min(25, input.limit ?? 12));
  return JSON.stringify({
    total: scored.length,
    reels: scored.slice(0, limit).map((x) => x.summary),
  });
}

async function getReel(supabase: SupabaseClient, input: { reel_id: string }): Promise<string> {
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, data')
    .eq('id', input.reel_id)
    .maybeSingle();
  if (error || !data) return JSON.stringify({ error: error?.message ?? 'reel not found' });
  const d = (data.data ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    id: data.id,
    competitor: asStr(d.name),
    type: asStr(d.type),
    raw_transcript: asStr(d.content),
    clean_transcript: asStr(d.clean_content),
    hook: asStr(d.hook),
    hook_type: asStr(d.hook_type),
    angle: asArr(d.angle),
    psych_trigger: asArr(d.psych_trigger),
    structure: asStr(d.structure),
    tone: asArr(d.tone),
    cta: asStr(d.cta),
    cta_type: asStr(d.cta_type),
    analysis_notes: asStr(d.analysis_notes),
    source_notes: asStr(d.notes),
  });
}

/**
 * Dispatch a copywriter tool call. `search_reels` / `get_reel` are handled
 * here; `search_projects` / `get_project` are delegated to the sales agent's
 * executor so the project-search logic stays in one place.
 */
export async function executeCopywriterTool(
  name: string,
  input: unknown,
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  try {
    switch (name) {
      case 'search_reels':
        return await searchReels(supabase, (input ?? {}) as ReelSearchInput);
      case 'get_reel':
        return await getReel(supabase, input as { reel_id: string });
      case 'search_projects':
      case 'get_project':
        return await executeAgentTool(name, input, supabase, userId);
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
