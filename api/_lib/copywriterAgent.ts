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
 *  - PROJECT FACTS come from the `all_projects` model ONLY (the full portfolio).
 *    `get_project` returns a labeled fact sheet that SEPARATES the team-entered
 *    details from the AUTO-CALCULATED rollups (price / area / bedroom / bathroom
 *    ranges, unit counts, price per m²) — derived from each project's units and
 *    STORED on the record (`is_rollup:true`, maintained by a DB trigger). The
 *    tool reads the stored values + the LIVE model schema (labels + rollup_kind)
 *    so it stays correct even though the live all_projects was Builder-rebuilt.
 *  - The system prompt is one deterministic const so prompt caching works.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
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
2. search_projects / get_project — OUR real projects (the all_projects portfolio). get_project returns a fact sheet in two parts: "details" (team-entered: developer, unit types, amenities, district, city, location, brochure, stage) and "calculated" — the AUTO-CALCULATED rollups derived from the project's actual units: price range, area range, bedroom range, bathroom range, unit counts, and average price per m². THESE CALCULATED NUMBERS ARE REAL DATA — use them as the project's authoritative pricing / size facts. (Each calculated field carries a computed_kind, e.g. "price_range", "bedroom_range" — trust that over the label.) When the fact sheet includes "marketing_document" (الوثيقة التسويقية — a verified Arabic reference document covering the project's models, specs, guarantees, amenities, and selling points), treat it as the project's PRIMARY source of truth for qualitative facts and selling points — mine it before anything else.

# CRITICAL workflow — retrieve BEFORE you write
Before generating or improving ANY script:
1. If the task references one of our projects, call search_projects (by name / keywords / city / district) then get_project for the real facts — including the calculated price / area / bedroom ranges.
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

# Delivering a finished script — IMPORTANT
When you produce a COMPLETE reel script (capability 1 GENERATE or 2 IMPROVE), you MUST do BOTH:
1. Write the script in the chat as you do now (الخطّاف / الزاوية / المشاهد / الدعوة + alternative hooks).
2. THEN call the emit_reel_script tool with the SAME content as structured fields: title, hook, angle, the scene-by-scene body (each scene = its voiceover line + visual direction, plus optional on-screen text / note), cta, and alt_hooks. If the script is grounded in one of our projects, pass project_id = the exact id you used in get_project (and project_name). Fill reel_idea / objective / target_audience / key_message when you know them.
After the tool call, add ONE short closing line: the script is ready and they can press “Create Reel / إنشاء ريل” to save it as a record.
Do NOT call emit_reel_script for a hooks-only list (capability 3) or an analysis/diagnosis (capability 4) — those stay as plain chat text only.

# Language & brand voice
- Write in Arabic. Match the energetic, warm, confident Saudi real-estate creator voice the dataset shows — colloquial where natural (اللي، وش، حياكم الله، ما شاء الله تبارك الرحمن) but never sloppy.
- Hooks must earn the first 3 seconds — a bold statement, real curiosity, or a sharp question (e.g. "قد شفت الفيلا اللي ما لها مثيل؟" or "بيت العمر اللي تدوّر عليه موجود في …").
- We are "وصل العقارية" / "Wassel". NEVER say "Wassel CRM" or name any internal system or tool.
- SAR currency; format with separators (1,990,000 ر.س).
- Keep it filmable: short spoken lines, one idea per scene.

# Honesty
- Use ONLY real project facts from get_project. If a needed fact (price, area, district, completion date) is missing from the fact sheet, write a clear placeholder like «[السعر]» / «[المساحة]» for the team to fill — NEVER invent numbers.
- Don't promise discounts, availability, or timelines that aren't in the data.

# Interaction
- If the user names a project, fetch it. If they're vague about which project, ask ONE clarifying question (which project / what's the main selling point), then proceed.
- Your replies are work product (scripts), so they can be longer than a chat — but stay focused; no filler.

Begin when the user sends their first message.`;

type ToolUnion = Anthropic.Messages.Tool;

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
  {
    name: 'search_projects',
    description:
      "Search OUR project portfolio (the all_projects model) by name, city, district, or keywords. Returns matching projects with their headline facts (name, city, district, type, unit types, price range, unit count) so you can pick the right one — then call get_project for the full fact sheet including the auto-calculated price / area / bedroom ranges. Use this to ground a script in a real Wassel project.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text over the project name + record (keywords, developer, theme).' },
        city: { type: 'string', description: 'City, e.g. "الرياض" / "Riyadh".' },
        district: { type: 'string', description: 'District / neighborhood, e.g. "حي النرجس".' },
        limit: { type: 'number', description: 'Max results (default 12, max 25).' },
      },
    },
  },
  {
    name: 'get_project',
    description:
      "Fetch the full fact sheet of one project from all_projects by its id (from search_projects). Returns two groups: `details` (team-entered: developer, unit types, amenities, city, district, location, brochure, stage) and `calculated` — the AUTO-CALCULATED rollups derived from the project's units (price range, area range, bedroom / bathroom range, unit counts, average price per m²). The calculated numbers are real — use them as the project's pricing / size facts. Only state values that are present.",
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The `id` returned by search_projects.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'emit_reel_script',
    description:
      'Deliver a COMPLETE, final, ready-to-film reel script as STRUCTURED data so the team can turn it into a Reel record with one click. Call this ONLY for a finished reel script (capability 1 GENERATE REEL SCRIPT or 2 IMPROVE EXISTING SCRIPT) — NEVER for a hooks-only list (capability 3) or an analysis/diagnosis (capability 4); those stay as plain chat text. Call it AFTER you have written the script in the chat, passing the same content as structured fields. Include `project_id` (the exact id you got from get_project) whenever the script is grounded in one of our projects, so the Reel record links to it automatically. After the call, add ONE short closing line telling the user the script is ready and they can press “Create Reel / إنشاء ريل” to save it as a record.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short Arabic title for the reel.' },
        project_id: { type: 'string', description: 'The all_projects record id from get_project, when the script is for one of our projects.' },
        project_name: { type: 'string', description: 'The project name, for display/confirmation.' },
        hook: { type: 'string', description: '🎬 The opening hook (the first 2–3 seconds).' },
        angle: { type: 'string', description: '🎯 The angle + psychological trigger, in one line.' },
        cta: { type: 'string', description: '📢 The closing call to action.' },
        alt_hooks: { type: 'array', items: { type: 'string' }, description: '2–3 alternative hooks.' },
        reel_idea: { type: 'string', description: 'One-line core idea of the reel.' },
        objective: { type: 'string', description: 'Goal of the reel (e.g. awareness, leads, launch).' },
        target_audience: { type: 'string', description: 'Who the reel targets.' },
        key_message: { type: 'string', description: 'The single key message.' },
        scenes: {
          type: 'array',
          description: 'The scene-by-scene body — one entry per scene/beat, in order.',
          items: {
            type: 'object',
            properties: {
              scene: { type: 'string', description: 'Scene label, e.g. "مشهد ١".' },
              voiceover: { type: 'string', description: 'The spoken voiceover line for this scene.' },
              visual: { type: 'string', description: 'Visual direction — what is on screen / how it is shot.' },
              on_screen_text: { type: 'string', description: 'On-screen text overlay (optional).' },
              notes: { type: 'string', description: 'Production note for this scene (optional).' },
            },
            required: ['voiceover', 'visual'],
          },
        },
      },
      required: ['title', 'hook', 'scenes'],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────

interface RecordRow {
  id: string;
  data: Record<string, unknown>;
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Normalize for project-name search: Arabic-Indic / Eastern-Arabic digits →
 *  Western, lowercase, collapse whitespace, trim — so "مينا ٥٢", "مينا 52" and
 *  the stored "مينا 52 " (trailing space) all reduce to the same "مينا 52". */
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

async function getModelByName(
  supabase: SupabaseClient,
  name: string,
): Promise<{ id: string; schema: unknown } | null> {
  const { data, error } = await supabase.from('models').select('id, schema').eq('name', name).maybeSingle();
  if (error || !data) return null;
  return { id: data.id as string, schema: data.schema };
}

/** Page every record of a model via unified_records (frozen-safe). */
async function pageRecords(supabase: SupabaseClient, modelId: string, maxPages = 5): Promise<RecordRow[]> {
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

// ─── Reels ─────────────────────────────────────────────────────────────────

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
  const model = await getModelByName(supabase, 'competitors');
  if (!model) return JSON.stringify({ error: 'competitors model not found', reels: [] });

  let rows: RecordRow[];
  try {
    rows = await pageRecords(supabase, model.id);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err), reels: [] });
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
  return JSON.stringify({ total: scored.length, reels: scored.slice(0, limit).map((x) => x.summary) });
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

// ─── Projects (all_projects only, with computed rollups) ────────────────────

interface SchemaField {
  name: string;
  label_en: string;
  label_ar: string;
  type: string;
  is_computed: boolean;
  computed_kind: string;
}

/** Flatten an all_projects schema into a field list (label + computed flags). */
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

/** True if a value is worth surfacing (not empty / null / a broken #REF formula). */
function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '' || v === '#REF') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') {
    // range {min,max} — keep only if at least one bound is present
    const o = v as Record<string, unknown>;
    return o.min != null || o.max != null;
  }
  return true;
}

// Unit rollups are now STORED on the all_projects record by a DB trigger (see
// supabase/migrations/2026-06-15_persist_project_rollups.sql). get_project
// reads the stored values directly, so the previously-ported recompute logic
// (unitsForProject + computeRollupKind + the status/number helpers) was removed.

interface ProjectSearchInput {
  query?: string;
  city?: string;
  district?: string;
  limit?: number;
}

/** Read a project's location.{city,district} as single ids (first element if multi). */
function projLoc(d: Record<string, unknown>): { city?: string; district?: string } {
  const loc = d.location && typeof d.location === 'object' && !Array.isArray(d.location)
    ? (d.location as Record<string, unknown>) : {};
  const one = (v: unknown): string | undefined =>
    Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : undefined) : (typeof v === 'string' && v ? v : undefined);
  return { city: one(loc.city), district: one(loc.district) };
}

/** Resolve geography record ids → display names via unified_records (ids are globally unique). */
async function resolveLocNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  for (let i = 0; i < uniq.length; i += 400) {
    const { data } = await supabase.from('unified_records').select('id, data').in('id', uniq.slice(i, i + 400));
    for (const r of (data ?? []) as RecordRow[]) {
      const n = r.data.display_name ?? r.data.name_ar;
      if (typeof n === 'string' && n) map.set(r.id, n);
    }
  }
  return map;
}

async function searchProjects(supabase: SupabaseClient, input: ProjectSearchInput): Promise<string> {
  const model = await getModelByName(supabase, 'all_projects');
  if (!model) return JSON.stringify({ error: 'all_projects model not found', projects: [] });

  let rows: RecordRow[];
  try {
    rows = await pageRecords(supabase, model.id, 20); // up to 20k projects
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err), projects: [] });
  }

  // Resolve each project's location.{city,district} ids → display names (relational geography).
  const locNames = await resolveLocNames(
    supabase,
    rows.flatMap((r) => { const { city, district } = projLoc(r.data); return [city, district].filter((x): x is string => !!x); }),
  );

  const queryNorm = normalizeForSearch(input.query ?? '');
  const queryTerms = queryNorm.split(' ').filter(Boolean);
  const cityNorm = normalizeForSearch(input.city ?? '');
  const districtNorm = normalizeForSearch(input.district ?? '');
  const hasFilters = !!(queryNorm || cityNorm || districtNorm);

  const scored = rows
    .map((r) => {
      const d = r.data;
      const name = asStr(d.project_name);
      if (!name) return null;
      const nameNorm = normalizeForSearch(name);

      let score = 0;
      // The project NAME is by far the strongest signal. An exact / phrase
      // match on the name MUST dominate incidental matches elsewhere in the
      // record (a price or area that happens to contain the query digits) —
      // otherwise the real "مينا 52" ties with 28 other مينا projects that
      // merely have "52" somewhere in their data, and the result cap buries it.
      if (queryNorm) {
        if (nameNorm === queryNorm) score += 2000;
        else if (nameNorm.includes(queryNorm)) score += 1000; // name contains the whole query
        else if (nameNorm.length >= 3 && queryNorm.includes(nameNorm)) score += 500;
        const bodyNorm = normalizeForSearch(JSON.stringify(d));
        for (const t of queryTerms) {
          if (nameNorm.includes(t)) score += 20; // term in the name
          else if (bodyNorm.includes(t)) score += 1; // term elsewhere (weak tiebreak)
        }
      }
      const { city: cityId, district: districtId } = projLoc(d);
      const cityName = cityId ? locNames.get(cityId) ?? '' : '';
      const districtName = districtId ? locNames.get(districtId) ?? '' : '';
      if (cityNorm && normalizeForSearch(cityName).includes(cityNorm)) score += 6;
      if (districtNorm && normalizeForSearch(districtName).includes(districtNorm)) score += 8;

      if (hasFilters && score === 0) return null; // filters given but nothing matched
      if (!hasFilters) score = 1; // no filters → list everything
      return {
        score,
        summary: {
          id: r.id,
          project_name: name,
          city: cityName,
          district: districtName,
          project_type: asStr(d.project_type),
          unit_types: asArr(d.unit_types),
          // NOTE: pricing/size are NOT in the search summary — they're computed
          // live from units; call get_project for the real numbers.
        },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score);

  const limit = Math.max(1, Math.min(30, input.limit ?? 15));
  return JSON.stringify({ total: scored.length, projects: scored.slice(0, limit).map((x) => x.summary) });
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

  // Compute the rollups LIVE from this project's units — the is_computed values
  // are NOT reliably persisted in records.data (the app recomputes them at
  // render). Reading the stored slot would report empty for projects whose
  // form clearly shows numbers. This makes the agent's figures equal the form.
  const details: Record<string, { label: string; label_ar: string; value: unknown }> = {};
  const calculated: Record<string, { label: string; label_ar: string; computed_kind: string; value: unknown }> = {};

  for (const f of fields) {
    if (f.is_computed) {
      // Rollups are STORED on the record now (DB trigger) — read the slot.
      const val = d[f.name];
      if (hasValue(val)) {
        calculated[f.name] = { label: f.label_en, label_ar: f.label_ar, computed_kind: f.computed_kind, value: val };
      }
      continue;
    }
    const raw = d[f.name];
    if (!hasValue(raw)) continue;
    details[f.name] = { label: f.label_en, label_ar: f.label_ar, value: raw };
  }

  // units_total comes from the stored unit_count rollup (kind 'units_count').
  const unitCountField = fields.find((f) => f.is_computed && f.computed_kind === 'units_count');
  const unitsTotalRaw = unitCountField ? Number(d[unitCountField.name]) : NaN;
  const unitsTotal = Number.isFinite(unitsTotalRaw) ? unitsTotalRaw : 0;

  return JSON.stringify({
    id: rec.id,
    project_name: asStr(d.project_name),
    units_total: unitsTotal,
    details,
    calculated,
    note: 'The `calculated` group holds the project’s stored unit aggregates (maintained from real unit data). An empty/absent metric means there is no unit data for it; use a [placeholder], never invent a number.',
  });
}

const REEL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the authoritative all_projects record id to link an emitted reel
 * script to. The model OFTEN echoes a wrong/short project_id (observed: "26")
 * in emit_reel_script — especially on later-turn rewrites where it composes
 * from memory instead of re-calling get_project — which leaves the new Reel
 * record's Project lookup unresolved. So never trust the echoed id blindly:
 *   1. the id the agent actually fetched via get_project THIS request (exact), else
 *   2. resolve from project_name via the name-first search (finds the real
 *      project despite the stored trailing-space / Arabic-digit quirks), else
 *   3. the echoed id, only if it's a well-formed UUID, else null (no link).
 */
export async function resolveReelScriptProjectId(
  supabase: SupabaseClient,
  rawProjectId: unknown,
  projectName: unknown,
  fetchedProjectId: string | null,
): Promise<string | null> {
  if (typeof fetchedProjectId === 'string' && REEL_UUID_RE.test(fetchedProjectId)) return fetchedProjectId;

  const name = typeof projectName === 'string' ? projectName.trim() : '';
  if (name) {
    try {
      const res = JSON.parse(await searchProjects(supabase, { query: name, limit: 1 })) as {
        projects?: Array<{ id?: string }>;
      };
      const id = res.projects?.[0]?.id;
      if (typeof id === 'string' && REEL_UUID_RE.test(id)) return id;
    } catch {
      // fall through to the echoed id
    }
  }

  const raw = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
  return REEL_UUID_RE.test(raw) ? raw : null;
}

/**
 * Dispatch a copywriter tool call. All four tools are implemented here — the
 * copywriter reads project facts from all_projects (with computed rollups),
 * NOT the sales agent's 3-model qualification search.
 */
export async function executeCopywriterTool(
  name: string,
  input: unknown,
  supabase: SupabaseClient,
  _userId: string,
): Promise<string> {
  try {
    switch (name) {
      case 'search_reels':
        return await searchReels(supabase, (input ?? {}) as ReelSearchInput);
      case 'get_reel':
        return await getReel(supabase, input as { reel_id: string });
      case 'search_projects':
        return await searchProjects(supabase, (input ?? {}) as ProjectSearchInput);
      case 'get_project':
        return await getProject(supabase, input as { project_id: string });
      case 'emit_reel_script':
        // Pure delivery channel: the structured payload is surfaced to the
        // browser by api/copywriter.ts as a `reel_script` SSE event (it owns
        // the `send`). Nothing is persisted server-side and no record is
        // auto-created — the user reviews + saves the Reel record themselves.
        return JSON.stringify({
          ok: true,
          note: 'Reel script delivered to the user as a structured table with a “Create Reel” button. Add one short closing line; do not repeat the full script as text.',
        });
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
