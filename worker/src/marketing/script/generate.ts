/**
 * Writer call + output normalisation. One structured call to role
 * `script_writer`; the raw output is coerced into a strict GenerationOutput
 * (ordered scenes, cumulative timing from duration_sec, Arabic-Indic digits
 * on screen). Nothing here talks to the DB.
 */
import { buildRepairUserPrompt, buildSystemPrompt, buildWriterUserPrompt, GENERATION_SCHEMA, PURPOSES, type WriterPromptInput } from './prompts.js';
import type { Brief, CallRole, DraftScene, GenerationOutput, ReviewReport, RoleCallResult, ScenePurpose, VisualIntent } from './types.js';

const MIN_SCENE_SEC = 2;
const MAX_SCENE_SEC = 15;
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Western digits → Arabic-Indic; thousands separator ',' → '٬'. Leaves everything else. */
export function toArabicIndic(s: string): string {
  return s.replace(/\d/g, (d) => AR_DIGITS[Number(d)]!).replace(/(?<=[٠-٩]),(?=[٠-٩]{3})/g, '٬');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
}
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
const isPurpose = (v: unknown): v is ScenePurpose => typeof v === 'string' && (PURPOSES as readonly string[]).includes(v);

function visualIntent(v: unknown): VisualIntent {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const ie = str(o.interior_exterior);
  const gk = str(o.graphic_kind);
  return {
    shot_size: str(o.shot_size) || 'medium',
    subject: str(o.subject) || 'building',
    setting: str(o.setting) || 'exterior_facade',
    interior_exterior: ie === 'interior' || ie === 'exterior' || ie === 'graphic' || ie === 'mixed' ? ie : 'mixed',
    motion: str(o.motion) || 'static',
    graphic_kind: gk === 'text_overlay' || gk === 'animated_map' || gk === '3d_render' || gk === 'motion_graphic' || gk === 'split_screen' ? gk : 'none',
    mood: str(o.mood) || '',
  };
}

/**
 * Coerce the model output. Timing: scene durations are clamped to 2–15 s and
 * rescaled so the total ≈ brief.duration_sec; start/end are cumulative.
 */
export function normalizeGeneration(raw: unknown, brief: Pick<Brief, 'duration_sec'>): GenerationOutput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawScenes = Array.isArray(o.scenes) ? o.scenes.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object') : [];
  const kept = rawScenes.filter((s) => str(s.voiceover) || str(s.visual));
  if (kept.length === 0) throw new Error('provider:script_writer returned no scenes');

  // order: honour the model's order field when unique, else array order
  const withOrder = kept.map((s, i) => ({ s, ord: num(s.order) ?? i + 1, i }));
  withOrder.sort((a, b) => a.ord - b.ord || a.i - b.i);

  const n = withOrder.length;
  const evenly = brief.duration_sec / n;
  let durations = withOrder.map(({ s }) => {
    const d = num(s.duration_sec);
    return d !== null && d > 0 ? d : evenly;
  });
  const clamp = (d: number): number => Math.max(MIN_SCENE_SEC, Math.min(MAX_SCENE_SEC, Math.round(d * 2) / 2));
  durations = durations.map(clamp);
  const total = durations.reduce((a, b) => a + b, 0);
  if (total > 0 && Math.abs(total - brief.duration_sec) / brief.duration_sec > 0.2) {
    const k = brief.duration_sec / total;
    durations = durations.map((d) => clamp(d * k)); // may still miss the target when n×15 < duration — the validator WARNs
  }

  let cursor = 0;
  const scenes: DraftScene[] = withOrder.map(({ s }, i) => {
    const duration = durations[i]!;
    const start = Math.round(cursor * 10) / 10;
    cursor += duration;
    const end = Math.round(cursor * 10) / 10;
    const ar = str(s.asset_requirement);
    const scene: DraftScene = {
      order: i + 1,
      purpose: isPurpose(s.purpose) ? s.purpose : i === 0 ? 'hook' : i === n - 1 ? 'cta' : 'feature',
      duration_sec: duration,
      start_sec: start,
      end_sec: end,
      voiceover: str(s.voiceover),
      on_screen_text: toArabicIndic(str(s.on_screen_text)),
      visual: str(s.visual),
      visual_intent: visualIntent(s.visual_intent),
      angle: str(s.angle),
      fact_refs: strArr(s.fact_refs).map((f) => f.toUpperCase().replace(/\s/g, '')),
      learned_from: strArr(s.learned_from).map((e) => e.toUpperCase().replace(/\s/g, '')),
      asset_requirement: ar === 'footage' || ar === 'image' || ar === 'graphic' || ar === 'animation' || ar === 'template' || ar === 'none' ? ar : 'footage',
      production_note: str(s.production_note),
      warnings: [],
    };
    return scene;
  });

  const plan = Array.isArray(o.scene_plan) ? o.scene_plan.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object') : [];
  const patterns = Array.isArray(o.patterns_learned) ? o.patterns_learned.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object') : [];
  return {
    patterns_learned: patterns.map((p) => ({ pattern: str(p.pattern), from: strArr(p.from) })).filter((p) => p.pattern),
    scene_plan: plan.map((p, i) => ({ order: num(p.order) ?? i + 1, purpose: str(p.purpose), goal: str(p.goal), facts: strArr(p.facts) })),
    scenes,
    hooks: strArr(o.hooks).slice(0, 5),
  };
}

export interface GenerateResult { output: GenerationOutput; call: RoleCallResult<unknown>; system: string; user: string }

/** First draft. */
export async function generateScript(callRole: CallRole, input: WriterPromptInput): Promise<GenerateResult> {
  const system = buildSystemPrompt(input.rules);
  const user = buildWriterUserPrompt(input);
  const call = await callRole<unknown>('script_writer', { system, user, schema: GENERATION_SCHEMA, cache: true });
  return { output: normalizeGeneration(call.output, input.brief), call, system, user };
}

/** Repair turn — same writer role, the previous output + the combined report. */
export async function repairScript(callRole: CallRole, input: WriterPromptInput, previous: GenerationOutput, report: ReviewReport): Promise<GenerateResult> {
  const system = buildSystemPrompt(input.rules);
  const user = buildRepairUserPrompt(input, previous, report);
  const call = await callRole<unknown>('script_writer', { system, user, schema: GENERATION_SCHEMA, cache: true });
  return { output: normalizeGeneration(call.output, input.brief), call, system, user };
}
