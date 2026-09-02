/**
 * Runner provider — the 'runner' creative provider (contracts §5).
 *
 * A design-read role configured `{provider:'runner'}` does not call an LLM API
 * from this worker. Instead it enqueues ONE `claude_jobs` row
 * (kind 'mkt_visual_design_slide' | 'mkt_visual_design_post') and polls the row
 * until the Claude-Code runner daemon (scripts/claude-study-runner.mjs — A-VIS
 * owns the two new handlers) completes it. The runner spends the paid Claude
 * SUBSCRIPTION, so there is no per-call API meter — cost_usd is 0 by the same
 * convention the existing runner handlers persist (`p_cost: 0`), NOT null
 * (null means "unknown"; this one is known-zero).
 *
 * Manifest contract (payload of the claude_jobs row):
 *   { manifest_items: <items>, ...params }
 * A-VIS's handlers read `job.payload.manifest_items`
 * ({media_id, post_id, stored_url, carousel_index, org} per item) and
 * self-select via `creative_design_read_targets` when it is empty. The column
 * on claude_jobs is `payload` — the A-VIS brief's "job.params.manifest_items"
 * refers to this same object (there is no `params` column; the mos_creative_jobs
 * table is the one with `params`).
 *
 * `callViaRunner` packages a sibling CallRequest (`req.images` + `req.user`) as
 * manifest items so a lane that thinks in callRole terms can be re-pointed at
 * the runner purely via mos_settings.ai_roles — no code change.
 *
 * Nothing here touches the network beyond PostgREST. Errors are prefixed
 * `provider:runner` (contracts §0.15) so lanes map them to error_kind
 * 'provider'.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CallRequest, CallUsage } from '../ai/index.js';
import { creativeProviderError, type CreativeCallResult } from './roles.js';

export type RunnerJobKind = 'mkt_visual_design_slide' | 'mkt_visual_design_post';

export const RUNNER_JOB_KINDS: readonly RunnerJobKind[] = ['mkt_visual_design_slide', 'mkt_visual_design_post'];

/** The only slice of a Supabase client this module needs (tests inject a fake). */
export type RunnerClient = Pick<SupabaseClient, 'from'>;

/** One opaque manifest item — the shape is A-VIS's contract, we never inspect it. */
export type RunnerManifestItem = unknown;

export interface RunnerOptions {
  sb?: RunnerClient;
  /** Default 30 min — a runner session can legitimately take many minutes. */
  timeoutMs?: number;
  /** Default 5 s. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface ClaudeJobRow {
  id: string;
  status: string;
  result?: unknown;
  error?: string | null;
}

function requireSb(sb: RunnerClient | undefined, where: string): RunnerClient {
  if (!sb) throw creativeProviderError('runner', `${where}: no Supabase client (opts.sb) — cannot reach claude_jobs`);
  return sb;
}

/**
 * Insert ONE queued claude_jobs row for a design-read batch. Returns the job id.
 * `items` are manifest items for A-VIS's handlers; `params` are extra payload
 * keys (e.g. {prompt, schema} from callViaRunner, or {tier} from a backfill).
 */
export async function enqueueRunnerRead(
  sb: RunnerClient,
  kind: RunnerJobKind,
  items: RunnerManifestItem[],
  params: Record<string, unknown> = {},
): Promise<string> {
  if (!RUNNER_JOB_KINDS.includes(kind)) {
    throw creativeProviderError('runner', `enqueueRunnerRead: kind '${String(kind)}' is not one of ${RUNNER_JOB_KINDS.join('|')}`);
  }
  if (!Array.isArray(items)) {
    throw creativeProviderError('runner', `enqueueRunnerRead(${kind}): items must be an array`);
  }
  const payload = { ...params, manifest_items: items };
  const { data, error } = (await sb
    .from('claude_jobs')
    .insert({ kind, payload, status: 'pending' } as never)
    .select('id')
    .single()) as { data: { id: string } | null; error: { message: string } | null };
  if (error) throw creativeProviderError('runner', `claude_jobs insert (${kind}, ${items.length} items) failed: ${error.message}`, error);
  if (!data?.id) throw creativeProviderError('runner', `claude_jobs insert (${kind}) returned no id`);
  return data.id;
}

export interface RunnerJobOutcome {
  status: 'ready';
  result: unknown;
  attempts: number;
}

const RUNNER_TERMINAL_OK = 'ready';
// 'blocked' is not a live claude_jobs status today (pending/running/ready/failed/
// cancelled) — the contract asks us to treat it as terminal-failed if it ever
// appears, so it is mapped here defensively.
const RUNNER_TERMINAL_FAIL = new Set(['failed', 'cancelled', 'blocked']);

/**
 * Poll a claude_jobs row until terminal. ready → {status:'ready', result};
 * failed / cancelled / blocked → throw `provider:runner …`; timeout → throw
 * `provider:runner … timeout`.
 */
export async function awaitRunnerJob(
  sb: RunnerClient,
  jobId: string,
  opts: Omit<RunnerOptions, 'sb'> = {},
): Promise<RunnerJobOutcome> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const { data, error } = (await sb
      .from('claude_jobs')
      .select('id, status, result, error')
      .eq('id', jobId)
      .maybeSingle()) as { data: ClaudeJobRow | null; error: { message: string } | null };
    if (error) throw creativeProviderError('runner', `claude_jobs poll (${jobId}) failed: ${error.message}`, error);
    if (!data) throw creativeProviderError('runner', `claude_jobs row ${jobId} not found`);
    if (data.status === RUNNER_TERMINAL_OK) return { status: 'ready', result: data.result, attempts };
    if (RUNNER_TERMINAL_FAIL.has(data.status)) {
      throw creativeProviderError('runner', `job ${jobId} ${data.status}: ${data.error ?? 'no error recorded'}`);
    }
    if (now() >= deadline) {
      throw creativeProviderError('runner', `job ${jobId} did not finish within ${timeoutMs}ms (last status '${data.status}', polls=${attempts})`);
    }
    await sleep(pollMs);
  }
}

/**
 * callRole-shaped runner invocation (contracts §5: provider 'runner' for design
 * reads = write a claude_jobs row and resolve on completion).
 *
 * Packaging: every `req.images` entry becomes a manifest item ({stored_url,
 * carousel_index} for URL images — the runner daemon downloads them; {base64,
 * mime, carousel_index} for inline images); `req.user` / `req.system` /
 * `req.schema` ride along as payload params so A-VIS's handler can run the same
 * prompt the API path would have.
 */
export async function callViaRunner<T>(
  kind: RunnerJobKind,
  req: CallRequest,
  opts: RunnerOptions = {},
): Promise<CreativeCallResult<T>> {
  const sb = requireSb(opts.sb, `callViaRunner(${kind})`);
  const now = opts.now ?? (() => Date.now());
  const items: RunnerManifestItem[] = (req.images ?? []).map((im, i) =>
    im.url !== undefined
      ? { stored_url: im.url, carousel_index: i }
      : { base64: im.base64, mime: im.mime, carousel_index: i },
  );
  const started = now();
  const jobId = await enqueueRunnerRead(sb, kind, items, {
    prompt: req.user,
    system: req.system,
    schema: req.schema,
  });
  const outcome = await awaitRunnerJob(sb, jobId, opts);
  const usage: CallUsage = { in: 0, out: 0 };
  return {
    output: outcome.result as T,
    usage,
    cost_usd: 0, // Claude-Code runner = paid subscription, zero incremental API charge (runner handlers persist p_cost: 0)
    provider: 'runner',
    model: `claude-runner:${kind}`,
    version: null,
    latency_ms: Math.max(0, Math.round(now() - started)),
  };
}
