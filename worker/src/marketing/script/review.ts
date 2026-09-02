/**
 * Independent judge (role script_reviewer) — sees the facts, the validator
 * report and the brief, NEVER the exemplars (so it cannot be swayed by the
 * competitor voice). Plus the single repair turn.
 */
import { repairScript } from './generate.js';
import { buildReviewerSystemPrompt, buildReviewerUserPrompt, REVIEW_SCHEMA, type WriterPromptInput } from './prompts.js';
import type { Brief, CallRole, DraftScene, FactsPackage, GenerationOutput, JudgeReport, RecipeRow, ReviewReport, RoleCallResult, ScriptWriterRules, ValidatorReport } from './types.js';

export interface JudgeInput {
  brief: Brief;
  facts: FactsPackage;
  recipe: RecipeRow;
  rules: ScriptWriterRules;
  scenes: DraftScene[];
  hooks: string[];
  validator: ValidatorReport;
}

function clamp(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3;
}

export function normalizeJudge(raw: unknown): JudgeReport {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const overall = o.overall === 'pass' || o.overall === 'revise' || o.overall === 'reject' ? o.overall : 'revise';
  const notes = Array.isArray(o.notes)
    ? o.notes.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
        .map((n) => ({ scene: Number.isFinite(Number(n.scene)) ? Number(n.scene) : 0, note: typeof n.note === 'string' ? n.note.trim() : '' }))
        .filter((n) => n.note)
    : [];
  return { overall, dialect: clamp(o.dialect), hook: clamp(o.hook), progression: clamp(o.progression), fit: clamp(o.fit), completeness: clamp(o.completeness), notes };
}

export async function judgeScript(callRole: CallRole, i: JudgeInput): Promise<{ judge: JudgeReport; call: RoleCallResult<unknown> }> {
  const system = buildReviewerSystemPrompt(i.rules);
  const user = buildReviewerUserPrompt({ brief: i.brief, facts: i.facts, recipe: i.recipe, scenes: i.scenes, hooks: i.hooks, validator: i.validator });
  const call = await callRole<unknown>('script_reviewer', { system, user, schema: REVIEW_SCHEMA, cache: true });
  return { judge: normalizeJudge(call.output), call };
}

/** Whether a repair turn is warranted: any validator FAIL, or the judge rejects outright. */
export function needsRepair(report: Pick<ReviewReport, 'validator' | 'judge'>): boolean {
  if (report.validator.checks.some((c) => c.level === 'fail')) return true;
  return report.judge?.overall === 'reject';
}

/** One repair turn — the writer gets the previous output + the combined report. */
export async function repair(callRole: CallRole, input: WriterPromptInput, previous: GenerationOutput, report: ReviewReport): Promise<{ output: GenerationOutput; call: RoleCallResult<unknown> }> {
  const r = await repairScript(callRole, input, previous, report);
  return { output: r.output, call: r.call };
}
