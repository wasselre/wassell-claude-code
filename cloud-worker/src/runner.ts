import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.ts';
import type {
  PresentationJobRow,
  PresentationStep,
  PresentationStepOutput,
  PresentationToolName,
} from './types.ts';
import { createAnthropicClient } from './anthropic.ts';
import { runAgentLoop, type AgentLoopResult, type AgentToolCall } from './agentLoop.ts';

/**
 * Phase 3 runner. Walks `template.steps` from the FROZEN snapshot on the job
 * row (not the live template — editing the template after queue time mustn't
 * mutate an in-flight job).
 *
 * Per step we:
 *   1. Mark the step `running` in `step_outputs` and persist immediately so
 *      the detail page reflects progress.
 *   2. Build the user prompt: step.prompt + the user's typed inputs +
 *      summarized output from prior steps.
 *   3. Run an agent loop with the step's tool subset (intersection with
 *      template.tools, or template.tools when step.tools is empty).
 *   4. Persist the step's `completed` row with output_text, tool_calls,
 *      duration, optional drive_url scraped from drive_upload tool calls.
 *   5. On thrown errors: mark this step `failed`, mark all later steps
 *      `skipped`, mark the job `failed`. Stop the run.
 *
 * Templates with empty `steps` (legacy daemon-synced rows) fall through to
 * the Phase 1B hardcoded smoke prompt — preserves the existing user-visible
 * behavior until those templates are migrated.
 */

// Phase 1B fallback — used when the queued job's template has no steps
// declared (i.e. came from the legacy daemon-synced catalog).
const PHASE1B_FALLBACK_SYSTEM = `You are an analyst for Wassel (وصل العقارية), a Saudi Arabian real-estate marketing firm. Be concise and factual. Available tools: web_search, web_fetch, code_execution, record_lookup, drive_upload.`;
const PHASE1B_FALLBACK_USER = `This template has no steps declared. Run a smoke test: web_search for one Riyadh real-estate fact, build a 3-slide deck with code_execution + python-pptx (saving to the working directory), then call drive_upload with the file_id from the bash_code_execution_output block. Return a 2-bullet summary.`;

// Per-step system prompt is mostly fixed; the user prompt carries everything
// step-specific. Keeping the system stable maximizes prompt-cache hits across
// steps in the same job.
const STEP_SYSTEM_PROMPT = `You are an analyst for Wassel (وصل العقارية), a Saudi Arabian real-estate marketing firm. You're executing one step in a multi-step pipeline. Follow the instructions for THIS step only — earlier step outputs are provided as context, but you don't need to redo their work. Be concise. When you call drive_upload, pass the exact file_id you saw in the most recent bash_code_execution_output block (NOT a filename or request_id).`;

export async function runJob(
  supabase: SupabaseClient,
  env: WorkerEnv,
  job: PresentationJobRow,
): Promise<void> {
  const startedAt = Date.now();
  const tpl = job.template_snapshot;
  const steps = tpl?.steps ?? [];
  console.log(
    `[runner] running job ${job.id} (template=${job.template_slug}, steps=${steps.length})`,
  );

  const anthropic = createAnthropicClient(env);

  // Legacy fallback — templates with no steps run the Phase 1B hardcoded
  // smoke prompt. Once Phase 5 retires the local daemon and all templates
  // are user-authored with steps, this branch can go.
  if (steps.length === 0) {
    try {
      const result = await runAgentLoop({
        anthropic,
        supabase,
        googleDriveOAuth: env.googleDriveOAuth,
        googleDriveParentFolderId: env.googleDriveParentFolderId,
        systemPrompt: PHASE1B_FALLBACK_SYSTEM,
        userMessage: PHASE1B_FALLBACK_USER,
        maxIterations: 25,
        maxTokens: 8000,
        onStep: (step) => writeProgress(supabase, job.id, formatLegacyProgress(step)),
      });
      await markJobCompleted(supabase, job, startedAt, result, /* stepOutputs */ []);
    } catch (err) {
      await markJobFailed(supabase, job, startedAt, err, /* stepOutputs */ []);
    }
    return;
  }

  // Phase 3 path — walk the declared steps.
  // Phase 3.1: when the job is being re-run (Retry from a specific step in
  // the UI), `job.step_outputs` carries the prior run's state with the
  // target step + everything downstream reset to 'pending'. We seed our
  // working array from it so already-completed steps stay intact and feed
  // their output_text into later steps' context. First-run jobs have no
  // `step_outputs` (or all entries pending) — same code path either way.
  const stepOutputs: PresentationStepOutput[] = steps.map((s, i) => {
    const prior = job.step_outputs?.[i];
    if (prior && prior.step_id === s.id) return prior;
    return { step_id: s.id, kind: s.kind, status: 'pending' };
  });

  // Build the standing inputs block once. Every step sees the user's typed
  // inputs (project_brief, etc.) at the top of its prompt — this is the
  // simplest way to make all template inputs available to all steps without
  // a placeholder-substitution language.
  const inputsBlock = formatInputs(job.inputs);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;

    // Phase 3.1 resume: skip steps already marked completed in a prior run.
    // Their output_text remains in stepOutputs for later steps to consume.
    if (stepOutputs[i]?.status === 'completed') {
      console.log(`[runner] step ${i + 1}/${steps.length} (${step.kind}) — skipping (already completed)`);
      continue;
    }

    const stepStartedAt = Date.now();
    const stepStartedIso = new Date().toISOString();

    // Mark this step running before kicking off the agent.
    stepOutputs[i] = {
      ...stepOutputs[i]!,
      status: 'running',
      started_at: stepStartedIso,
      // Clear any leftover state from a prior failed/interrupted run so
      // the UI doesn't show stale errors / drive_urls.
      finished_at: undefined,
      duration_ms: undefined,
      output_text: undefined,
      tool_calls: undefined,
      drive_url: undefined,
      usage: undefined,
      error: undefined,
    };
    await writeStepOutputs(supabase, job.id, stepOutputs);
    await writeProgress(supabase, job.id, {
      stage: step.kind,
      messageEn: `Step ${i + 1}/${steps.length}: ${step.kind} running…`,
      messageAr: `الخطوة ${i + 1}/${steps.length}: تشغيل ${step.kind}…`,
    });

    // Per-step tool subset. Empty `step.tools` = inherit template tools.
    const enabledTools: PresentationToolName[] = step.tools.length > 0
      ? step.tools.filter((t) => tpl.tools.includes(t))
      : [...tpl.tools];

    const userMessage = buildStepUserMessage(step, job.inputs, inputsBlock, stepOutputs.slice(0, i));

    let stepResult: AgentLoopResult;
    try {
      stepResult = await runAgentLoop({
        anthropic,
        supabase,
        googleDriveOAuth: env.googleDriveOAuth,
        googleDriveParentFolderId: env.googleDriveParentFolderId,
        enabledTools,
        systemPrompt: STEP_SYSTEM_PROMPT,
        userMessage,
        maxIterations: 25,
        maxTokens: 8000,
        // Mid-step progress hook (Phase 3.1) — surfaces tool-by-tool
        // activity to the detail page while the agent is still working.
        onStep: (loopStep) => writeProgress(
          supabase,
          job.id,
          formatStepProgress(step.kind, i + 1, steps.length, loopStep),
        ),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runner] step ${i + 1} (${step.kind}) failed: ${message}`);
      stepOutputs[i] = {
        ...stepOutputs[i]!,
        status: 'failed',
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - stepStartedAt,
        error: message,
      };
      // Skip everything downstream — they were going to consume this output.
      for (let j = i + 1; j < stepOutputs.length; j++) {
        stepOutputs[j] = { ...stepOutputs[j]!, status: 'skipped' };
      }
      await markJobFailed(supabase, job, startedAt, err, stepOutputs);
      return;
    }

    stepOutputs[i] = {
      ...stepOutputs[i]!,
      status: 'completed',
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - stepStartedAt,
      output_text: stepResult.finalText,
      tool_calls: stepResult.toolCalls.map((tc) => ({ name: tc.name, ok: !tc.is_error })),
      drive_url: extractDriveUrl(stepResult.toolCalls),
      usage: {
        input_tokens: stepResult.usage.input_tokens,
        output_tokens: stepResult.usage.output_tokens,
      },
    };
    await writeStepOutputs(supabase, job.id, stepOutputs);
    console.log(
      `[runner] step ${i + 1}/${steps.length} (${step.kind}) completed in ${stepOutputs[i]!.duration_ms}ms`,
    );
  }

  // All steps completed — finalize the job.
  await markJobCompleted(
    supabase,
    job,
    startedAt,
    /* finalLoopResult */ null,
    stepOutputs,
  );
}

// ────────────────────────────────────────────────────────────────────
// Prompt assembly helpers
// ────────────────────────────────────────────────────────────────────

function formatInputs(inputs: Record<string, unknown>): string {
  const entries = Object.entries(inputs);
  if (entries.length === 0) return '(no user inputs)';
  return entries
    .map(([k, v]) => {
      const display = typeof v === 'string' ? v : JSON.stringify(v);
      return `- ${k}: ${display}`;
    })
    .join('\n');
}

function buildStepUserMessage(
  step: PresentationStep,
  inputs: Record<string, unknown>,
  inputsBlock: string,
  priorOutputs: PresentationStepOutput[],
): string {
  const parts: string[] = [];
  parts.push(`# ${step.kind.toUpperCase()} STEP`);
  parts.push('');
  parts.push('## User inputs');
  parts.push(inputsBlock);
  parts.push('');
  if (priorOutputs.length > 0) {
    parts.push('## Earlier step outputs');
    for (const o of priorOutputs) {
      parts.push(`### ${o.kind}`);
      parts.push(o.output_text ?? '(no output)');
      if (o.drive_url) parts.push(`Drive URL: ${o.drive_url}`);
      parts.push('');
    }
  }
  parts.push('## Instructions for this step');
  parts.push(
    interpolateInputs(
      step.prompt || `(no instructions — do the obvious thing for a ${step.kind} step)`,
      inputs,
    ),
  );
  return parts.join('\n');
}

/** `{{ input_name }}` → the value of that input. Whitespace inside the
 *  braces is tolerated (the user might type `{{project_brief}}` or
 *  `{{ project_brief }}`). Unknown names render as `[unknown input: x]`
 *  so the agent can flag the issue back to the user instead of silently
 *  ignoring a typo. */
function interpolateInputs(prompt: string, inputs: Record<string, unknown>): string {
  return prompt.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, name: string) => {
    if (!(name in inputs)) return `[unknown input: ${name}]`;
    const v = inputs[name];
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Builds a bilingual progress message for a single agent-loop iteration
 *  inside a step. Shown in the detail page's "currently doing" line. */
function formatStepProgress(
  stepKind: string,
  stepNumber: number,
  totalSteps: number,
  loopStep: { iteration: number; toolUses: Array<{ name: string }>; paused: boolean; finalText?: string },
): ProgressUpdate {
  const stage = `${stepKind}.${loopStep.iteration}`;
  if (loopStep.finalText !== undefined) {
    return {
      stage,
      messageEn: `Step ${stepNumber}/${totalSteps}: ${stepKind} finishing (iter ${loopStep.iteration})`,
      messageAr: `الخطوة ${stepNumber}/${totalSteps}: ${stepKind} ينهي (دورة ${loopStep.iteration})`,
    };
  }
  if (loopStep.paused) {
    return {
      stage,
      messageEn: `Step ${stepNumber}/${totalSteps}: ${stepKind} server-tool paused (iter ${loopStep.iteration})`,
      messageAr: `الخطوة ${stepNumber}/${totalSteps}: ${stepKind} توقف مؤقت (دورة ${loopStep.iteration})`,
    };
  }
  if (loopStep.toolUses.length > 0) {
    const names = loopStep.toolUses.map((t) => t.name).join(', ');
    return {
      stage,
      messageEn: `Step ${stepNumber}/${totalSteps}: ${stepKind} → ${names} (iter ${loopStep.iteration})`,
      messageAr: `الخطوة ${stepNumber}/${totalSteps}: ${stepKind} → ${names} (دورة ${loopStep.iteration})`,
    };
  }
  return {
    stage,
    messageEn: `Step ${stepNumber}/${totalSteps}: ${stepKind} thinking (iter ${loopStep.iteration})`,
    messageAr: `الخطوة ${stepNumber}/${totalSteps}: ${stepKind} يفكر (دورة ${loopStep.iteration})`,
  };
}

function extractDriveUrl(toolCalls: AgentToolCall[]): string | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (tc.name !== 'drive_upload' || tc.is_error) continue;
    try {
      const parsed = JSON.parse(tc.result) as { ok?: boolean; drive_url?: string };
      if (parsed.ok && typeof parsed.drive_url === 'string' && parsed.drive_url !== '') {
        return parsed.drive_url;
      }
    } catch {
      // not JSON
    }
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────
// Persistence helpers
// ────────────────────────────────────────────────────────────────────

interface ProgressUpdate {
  stage: string;
  messageEn: string;
  messageAr: string;
}

async function writeProgress(
  supabase: SupabaseClient,
  jobId: string,
  p: ProgressUpdate,
): Promise<void> {
  await supabase
    .from('presentation_jobs')
    .update({
      progress_stage: p.stage,
      progress_message_en: p.messageEn,
      progress_message_ar: p.messageAr,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

async function writeStepOutputs(
  supabase: SupabaseClient,
  jobId: string,
  stepOutputs: PresentationStepOutput[],
): Promise<void> {
  await supabase
    .from('presentation_jobs')
    .update({
      step_outputs: stepOutputs,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

function formatLegacyProgress(step: {
  iteration: number;
  toolUses: Array<{ name: string }>;
  paused: boolean;
  finalText?: string;
}): ProgressUpdate {
  if (step.finalText !== undefined) {
    return {
      stage: 'done',
      messageEn: `Done in ${step.iteration} iteration${step.iteration === 1 ? '' : 's'}`,
      messageAr: `تم في ${step.iteration} دورة`,
    };
  }
  if (step.paused) {
    return {
      stage: 'paused',
      messageEn: `Server-side tool loop paused (iteration ${step.iteration}); resuming`,
      messageAr: `تم إيقاف الأداة مؤقتاً (الدورة ${step.iteration}) — جاري الاستئناف`,
    };
  }
  if (step.toolUses.length > 0) {
    const names = step.toolUses.map((t) => t.name).join(', ');
    return {
      stage: step.toolUses[0]!.name,
      messageEn: `Iteration ${step.iteration}: calling ${names}`,
      messageAr: `الدورة ${step.iteration}: تشغيل ${names}`,
    };
  }
  return {
    stage: 'thinking',
    messageEn: `Iteration ${step.iteration}: thinking`,
    messageAr: `الدورة ${step.iteration}: جاري التحليل`,
  };
}

async function markJobCompleted(
  supabase: SupabaseClient,
  job: PresentationJobRow,
  startedAt: number,
  legacyResult: AgentLoopResult | null,
  stepOutputs: PresentationStepOutput[],
): Promise<void> {
  const finishedAtIso = new Date().toISOString();

  // Pick the most recent step's drive_url (that's the deck the user wants
  // surfaced). When no step uploaded, fall back to scraping the legacy
  // tool-call list (Phase 1B path).
  let driveUrl: string | null = null;
  for (let i = stepOutputs.length - 1; i >= 0; i--) {
    if (stepOutputs[i]!.drive_url) {
      driveUrl = stepOutputs[i]!.drive_url ?? null;
      break;
    }
  }
  if (!driveUrl && legacyResult) {
    const candidate = extractDriveUrl(legacyResult.toolCalls);
    if (candidate) driveUrl = candidate;
  }

  const totalIters = stepOutputs.reduce((acc, o) => acc + (o.usage ? 1 : 0), 0)
    || legacyResult?.iterations
    || 0;
  const totalIn = stepOutputs.reduce((acc, o) => acc + (o.usage?.input_tokens ?? 0), 0)
    + (legacyResult?.usage.input_tokens ?? 0);
  const totalOut = stepOutputs.reduce((acc, o) => acc + (o.usage?.output_tokens ?? 0), 0)
    + (legacyResult?.usage.output_tokens ?? 0);

  const finalText = legacyResult?.finalText
    ?? stepOutputs[stepOutputs.length - 1]?.output_text
    ?? '';

  const { error } = await supabase
    .from('presentation_jobs')
    .update({
      status: 'completed',
      drive_deck_url: driveUrl,
      step_outputs: stepOutputs,
      result: {
        ok: true,
        drive_deck_url: driveUrl,
        local_paths: {},
        warnings: [
          stepOutputs.length > 0
            ? `Phase 3 run finished — ${stepOutputs.length} step${stepOutputs.length === 1 ? '' : 's'} completed.`
            : `Phase 1B fallback run finished in ${totalIters} iteration(s).`,
          `Token usage: in=${totalIn} out=${totalOut}.`,
          finalText ? `Final answer:\n${finalText}` : '(no final answer)',
        ],
      },
      progress_stage: 'done',
      progress_message_ar: stepOutputs.length > 0
        ? `تم — ${stepOutputs.length} خطوة`
        : 'تم',
      progress_message_en: stepOutputs.length > 0
        ? `Done — ${stepOutputs.length} step${stepOutputs.length === 1 ? '' : 's'}`
        : 'Done',
      finished_at: finishedAtIso,
      duration_ms: Date.now() - startedAt,
      updated_at: finishedAtIso,
    })
    .eq('id', job.id);
  if (error) {
    console.error(`[runner] failed to mark job ${job.id} completed: ${error.message}`);
    return;
  }
  console.log(`[runner] job ${job.id} completed in ${Date.now() - startedAt}ms`);
}

async function markJobFailed(
  supabase: SupabaseClient,
  job: PresentationJobRow,
  startedAt: number,
  err: unknown,
  stepOutputs: PresentationStepOutput[],
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[runner] job ${job.id} failed: ${message}`);
  const finishedAtIso = new Date().toISOString();
  const { error } = await supabase
    .from('presentation_jobs')
    .update({
      status: 'failed',
      step_outputs: stepOutputs,
      error_code: 'claude_error',
      error_message: message,
      error_detail: err instanceof Error && err.stack ? err.stack : null,
      finished_at: finishedAtIso,
      duration_ms: Date.now() - startedAt,
      updated_at: finishedAtIso,
    })
    .eq('id', job.id);
  if (error) {
    console.error(`[runner] also failed to write failure row for ${job.id}: ${error.message}`);
  }
}
