/**
 * Project Finder — the ONLY two places an LLM is allowed to touch the flow.
 *
 *   1. parseRequirements(text)  — turn messy salesperson/customer text into a
 *      structured MatchRequirements object, BEFORE the deterministic engine runs.
 *   2. explainMatches(...)      — write a short sales-friendly explanation for each
 *      ALREADY-RANKED match, AFTER the deterministic engine ran.
 *
 * The LLM must NEVER choose projects, score projects, change ranking, invent
 * facts, or override deterministic results. Two safeguards enforce that:
 *   - explainMatches only ever returns {project_id -> string}; the apply step
 *     (applyLlmExplanations) reads ONLY the id + text and ignores anything else,
 *     so a model that tries to send a new score/band/order is silently overruled.
 *   - assertRankingUnchanged() is a hard invariant the endpoint runs after apply:
 *     if the score/band/source/match_type/order of any match changed, it throws.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MatchRequirements } from './matchAgent.js';
import type { FinderMatch, FinderResult, FinderGroupKey } from './projectFinder.js';
import { FINDER_GROUP_KEYS } from './projectFinder.js';

// Cheap, fast model for the two bounded tasks (parse + explain). These tasks are
// pure text transforms — no project selection — so a small model is appropriate.
export const FINDER_AI_MODEL = 'claude-haiku-4-5-20251001';

// ── 1. Parse messy text → structured requirements ───────────────────────────

const PARSE_SYSTEM =
  'You convert a real-estate salesperson\'s free-text note about what a customer wants into STRUCTURED search fields. ' +
  'Extract only what is explicitly stated or unambiguous. Do NOT guess. Do NOT recommend or pick projects — you only fill fields. ' +
  'Budgets and areas are numbers (SAR / m²). District/city are plain names (Arabic or English as written). ' +
  'unit_type is the kind of property (apartment/villa/townhouse/land/office…). ' +
  'If the customer gives a DIRECTION within a city instead of named districts ("north of Riyadh", "شمال الرياض", "east side"), ' +
  'set `city` to that city and `zone` to north|south|east|west|center|northeast|northwest|southeast|southwest. ' +
  'If they name actual districts, use `districts` and leave `zone` empty. Call set_requirements exactly once.';

const PARSE_TOOL: Anthropic.Tool = {
  name: 'set_requirements',
  description: 'Record the structured search requirements extracted from the text.',
  input_schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name, if stated.' },
      districts: { type: 'array', items: { type: 'string' }, description: 'One or more district/neighbourhood names, if stated.' },
      zone: { type: 'string', enum: ['north', 'south', 'east', 'west', 'center', 'northeast', 'northwest', 'southeast', 'southwest'], description: 'A DIRECTION within the city (e.g. "north of Riyadh"), instead of named districts. Requires city to be set.' },
      property_type: { type: 'string', description: 'apartment | villa | townhouse | land | office | duplex | …' },
      budget_min: { type: 'number' },
      budget_max: { type: 'number' },
      area_min: { type: 'number', description: 'm²' },
      area_max: { type: 'number', description: 'm²' },
      bedrooms: { type: 'number' },
      bathrooms: { type: 'number' },
      amenities: { type: 'array', items: { type: 'string' }, description: 'Required features/amenities, if stated.' },
      allow_stretch: { type: 'boolean', description: 'false if the customer is strict on budget.' },
    },
  },
};

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** Coerce the LLM tool output into a clean, trusted MatchRequirements. */
export function coerceParsedRequirements(raw: unknown): MatchRequirements {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: MatchRequirements = {};
  const city = str(r.city); if (city) out.city = city;
  const districts = strArr(r.districts); if (districts?.length) { out.districts = districts; out.district = districts[0]; }
  const ZONES = new Set(['north', 'south', 'east', 'west', 'center', 'northeast', 'northwest', 'southeast', 'southwest']);
  const zone = str(r.zone); if (zone && ZONES.has(zone.toLowerCase())) out.zone = zone.toLowerCase();
  const pt = str(r.property_type); if (pt) out.property_type = pt;
  const bmin = num(r.budget_min); if (bmin != null) out.budget_min = bmin;
  const bmax = num(r.budget_max); if (bmax != null) out.budget_max = bmax;
  const amin = num(r.area_min); if (amin != null) out.area_min = amin;
  const amax = num(r.area_max); if (amax != null) out.area_max = amax;
  const beds = num(r.bedrooms); if (beds != null) out.bedrooms = beds;
  const baths = num(r.bathrooms); if (baths != null) out.bathrooms = baths;
  const amen = strArr(r.amenities); if (amen?.length) out.amenities = amen;
  if (r.allow_stretch === false) out.allow_stretch = false;
  return out;
}

/**
 * Parse free text into requirements. Returns {} on ANY failure (no key, API
 * error, no tool call) — the deterministic engine still runs on whatever explicit
 * fields the caller passed. Never throws.
 */
export async function parseRequirements(text: string, apiKey: string | undefined): Promise<MatchRequirements> {
  if (!apiKey || !text.trim()) return {};
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: FINDER_AI_MODEL,
      max_tokens: 600,
      system: PARSE_SYSTEM,
      tools: [PARSE_TOOL],
      tool_choice: { type: 'tool', name: 'set_requirements' },
      messages: [{ role: 'user', content: text.slice(0, 4000) }],
    });
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'set_requirements');
    if (!block) return {};
    return coerceParsedRequirements(block.input);
  } catch (err) {
    console.error('[projectFinderAI] parseRequirements failed:', err instanceof Error ? err.message : String(err));
    return {};
  }
}

// ── 2. Explain ALREADY-RANKED matches ───────────────────────────────────────

const EXPLAIN_SYSTEM =
  'You write a SHORT (1–2 sentence) sales-friendly explanation for each property match that the system has ALREADY selected and ranked. ' +
  'You are given the ranked matches with their verified facts. Use ONLY those facts — never invent prices, availability, distances, or features. ' +
  'You may NOT add, remove, reorder, re-score, or re-band any match. Write one explanation per given project_id, keyed by project_id. ' +
  'If a match is from an external/broad source, remind the salesperson to verify it. Call write_explanations exactly once.';

const EXPLAIN_TOOL: Anthropic.Tool = {
  name: 'write_explanations',
  description: 'Provide one short explanation per match, keyed by project_id.',
  input_schema: {
    type: 'object',
    properties: {
      explanations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['project_id', 'explanation'],
        },
      },
    },
    required: ['explanations'],
  },
};

/** Compact, fact-only view handed to the explainer — never the score/band so the
 *  model can't "reason about" changing them. */
function matchForPrompt(m: FinderMatch) {
  return {
    project_id: m.project_id,
    project_name: m.project_name,
    match_type: m.match_type,
    distance_km: m.distance_km,
    geo_confidence: m.geo_confidence,
    source: m.source,
    facts: m.facts,
    data_gaps: m.data_gaps,
    mismatch_warnings: m.mismatch_warnings,
  };
}

/**
 * Ask the LLM for explanations. Returns a {project_id -> explanation} map (only
 * for ids that exist in the result). Returns {} on any failure. Never throws,
 * never affects ranking.
 */
export async function explainMatches(
  result: FinderResult,
  apiKey: string | undefined,
): Promise<Record<string, string>> {
  const all: FinderMatch[] = FINDER_GROUP_KEYS.flatMap((k) => result.groups[k]);
  if (!apiKey || all.length === 0) return {};
  const allowed = new Set(all.map((m) => m.project_id));
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: FINDER_AI_MODEL,
      max_tokens: 1500,
      system: EXPLAIN_SYSTEM,
      tools: [EXPLAIN_TOOL],
      tool_choice: { type: 'tool', name: 'write_explanations' },
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            requirements: result.requirements,
            matches: all.map(matchForPrompt),
          }),
        },
      ],
    });
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'write_explanations');
    const list = (block?.input as { explanations?: Array<{ project_id?: unknown; explanation?: unknown }> } | undefined)?.explanations ?? [];
    const out: Record<string, string> = {};
    for (const e of list) {
      const id = typeof e.project_id === 'string' ? e.project_id : null;
      const text = typeof e.explanation === 'string' ? e.explanation.trim() : null;
      if (id && text && allowed.has(id)) out[id] = text; // ignore ids the LLM invented
    }
    return out;
  } catch (err) {
    console.error('[projectFinderAI] explainMatches failed:', err instanceof Error ? err.message : String(err));
    return {};
  }
}

// ── Guards (pure, exported for tests) ────────────────────────────────────────

/** The ranking-defining fields of a match, in order. */
export interface RankingSnapshot {
  project_id: string;
  score: number;
  match_band: string;
  source: string;
  match_type: string;
}

export function snapshotRanking(result: FinderResult): Record<FinderGroupKey, RankingSnapshot[]> {
  const snap = {} as Record<FinderGroupKey, RankingSnapshot[]>;
  for (const k of FINDER_GROUP_KEYS) {
    snap[k] = result.groups[k].map((m) => ({
      project_id: m.project_id,
      score: m.score,
      match_band: m.match_band,
      source: m.source,
      match_type: m.match_type,
    }));
  }
  return snap;
}

/**
 * Hard invariant: the deterministic ranking (which projects, in which order, with
 * which score/band/source/match_type, in which group) MUST be identical before and
 * after the LLM explanation step. Throws if anything but the explanation text moved.
 */
export function assertRankingUnchanged(before: FinderResult, after: FinderResult): void {
  const b = snapshotRanking(before);
  const a = snapshotRanking(after);
  for (const k of FINDER_GROUP_KEYS) {
    if (b[k].length !== a[k].length) {
      throw new Error(`Project Finder ranking violation: group "${k}" length changed (${b[k].length} → ${a[k].length}).`);
    }
    for (let i = 0; i < b[k].length; i++) {
      const x = b[k][i]!;
      const y = a[k][i]!;
      if (
        x.project_id !== y.project_id ||
        x.score !== y.score ||
        x.match_band !== y.match_band ||
        x.source !== y.source ||
        x.match_type !== y.match_type
      ) {
        throw new Error(`Project Finder ranking violation in group "${k}" at position ${i} (project ${x.project_id}).`);
      }
    }
  }
}

/**
 * Apply LLM explanations to a finder result. Reads ONLY project_id + explanation
 * text; every ranking field is copied straight from the deterministic result, so a
 * malicious/buggy LLM payload (reordered, rescored, extra projects) cannot change
 * the outcome — at most it changes explanation strings for real matches. The
 * structure (order, membership, scores) is byte-identical to the input.
 */
export function applyLlmExplanations(
  result: FinderResult,
  explanations: Record<string, string>,
): FinderResult {
  const groups = {} as FinderResult['groups'];
  for (const k of FINDER_GROUP_KEYS) {
    groups[k] = result.groups[k].map((m) => {
      const replacement = explanations[m.project_id];
      return replacement && replacement.trim() ? { ...m, explanation: replacement.trim() } : m;
    });
  }
  const next: FinderResult = { ...result, groups };
  // Belt-and-suspenders: prove we only changed text.
  assertRankingUnchanged(result, next);
  return next;
}
