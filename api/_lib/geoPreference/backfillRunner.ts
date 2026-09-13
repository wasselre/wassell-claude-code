/**
 * Review-first BACKFILL runner — the INVOCATION PATH for the Geography
 * Understanding Ability, expressed as pure, dependency-injected orchestration.
 *
 * For one claimed job (a client) it:
 *   1. gathers the client's history as SEPARATE {@link Conversation}s — one per
 *      phone call and one per WhatsApp thread (never merged: a call transcript has
 *      no speaker labels and needs its own extraction rules + its own review)
 *   2. for EACH conversation: runs Stage-A {@link extract}, persists the evidence
 *      under that conversation's real id, builds a {@link RunContext} and runs
 *      {@link runReviewFirst} — whose ONLY side effect is a `pending` row in
 *      geo_pref_proposals. So a client with a call and a chat gets TWO proposals,
 *      each reviewable against its own transcript (by design — a chat review is
 *      separate from a call review).
 *   3. marks the job done, or failed (attempts already ++ by claim) on error.
 *
 * SAFETY BOUNDARY (why this is safe to run over real clients):
 *   - It NEVER contacts a customer. It only READS history and writes a
 *     review-first proposal. There is no WhatsApp/send port in `BackfillDeps`.
 *   - It NEVER writes a client's active preferences. runReviewFirst's sole port
 *     is the proposal store; auto_write stays false in the run context (built by
 *     the injected `buildRunContext`).
 *
 * ISOLATION: {@link processBackfillJob} never throws — one client's failure is
 * captured onto its own job (failJob) and the batch moves on. DEDUP: the injected
 * proposal store skips creating a second proposal when an open one already exists
 * for the same (client, checkpoint), so a re-run produces no duplicates.
 *
 * IO is entirely behind {@link BackfillDeps}; `backfillPorts.ts` wires the real
 * Supabase-backed implementations, and the tests inject fakes. This mirrors the
 * resolver/orchestrator "pure logic + injected DB" split used across this module.
 */

import type { Conversation, ExtractResult } from './extractor.js';
import type {
  RunContext,
  ReviewFirstResult,
  OrchestratorPorts,
  ProposalStore,
} from './orchestrator.js';
import type { Evidence, EvidenceRelation } from './ontology.js';

/** A claimed geo_pref_backfill_jobs row. */
export interface BackfillJob {
  jobId: string;
  runId: string;
  clientId: string;
  /** attempts AFTER the claim increment (so >= 1). */
  attempts: number;
}

/** Outcome of processing one job — never an exception (isolation). */
export interface JobOutcome {
  jobId: string;
  clientId: string;
  status: 'done' | 'failed';
  /** true when a proposal was created OR reused (dedup), false when there was
   *  nothing to propose (empty history / no active preference). */
  hadProposal: boolean;
  error?: string;
}

export interface BatchResult {
  processed: number;
  done: number;
  failed: number;
  proposals: number;
  /** true when the queue was drained (claimNext returned null), false when the
   *  batch stopped on the `max`/`budgetMs` ceiling with work possibly remaining. */
  drained: boolean;
}

/**
 * Everything the runner needs, all injected. The heavy, ability-specific pieces
 * (extract / runReviewFirst / the Supabase resolver + proposal store) are ports
 * so the runner stays unit-testable with fakes and no DB.
 */
export interface BackfillDeps {
  /** Claim the next runnable job for the run (FOR UPDATE SKIP LOCKED). Returns
   *  null when the queue is drained. */
  claimNext(runId: string): Promise<BackfillJob | null>;
  /** Mark a job `done` (only touches a still-running row). */
  completeJob(jobId: string): Promise<void>;
  /** Mark a job `failed` with an error message. */
  failJob(jobId: string, error: string): Promise<void>;
  /** Gather a client's history as one conversation PER call and PER chat thread
   *  (each on its own channel, with its real id). Empty when there is none. */
  gatherConversations(clientId: string): Promise<Conversation[]>;
  /** Stage-A extraction (conversation ⇒ evidence + relations). */
  extract(conversation: Conversation): Promise<ExtractResult>;
  /** Build the per-client review-first run context. `evidenceCount` lets the
   *  builder pick `maximum_safe_action='ignore'` for empty extractions so the
   *  gate produces no proposal for a client with no active geo preference. */
  buildRunContext(clientId: string, evidenceCount: number): Promise<RunContext>;
  /** The review-first orchestrator (writes ONLY a pending proposal). */
  runReviewFirst(
    evidence: Evidence[],
    relations: EvidenceRelation[],
    ctx: RunContext,
    ports: OrchestratorPorts,
  ): Promise<ReviewFirstResult>;
  /** Dedup-aware proposal store handed to runReviewFirst. */
  proposals: ProposalStore;
  /** Persist ONE conversation's evidence + relations + a checkpoint (origin='model')
   *  under the conversation's real id, so the labeling workflow has real subjects
   *  and the proposal can link to a checkpoint. Optional — a fake without it simply
   *  skips persistence. Returns the checkpoint id. */
  persistExtraction?(
    clientId: string,
    conversation: Conversation,
    evidence: Evidence[],
    relations: EvidenceRelation[],
  ): Promise<{ checkpointId: string; evidenceIds: string[] }>;
  /** Optional structured logger. */
  log?(msg: string): void;
}

export interface BatchOptions {
  runId: string;
  /** Max jobs to process this batch (default: unbounded, drain the run). */
  max?: number;
  /** Wall-clock budget in ms — stop claiming new jobs past it (default: none).
   *  Lets an HTTP-hosted driver stay well under its request ceiling. */
  budgetMs?: number;
}

/**
 * Process ONE claimed job to a terminal state. NEVER throws — any failure is
 * captured onto this job via failJob so a sibling client is never blocked
 * (per-client isolation).
 */
export async function processBackfillJob(
  deps: BackfillDeps,
  job: BackfillJob,
): Promise<JobOutcome> {
  const log = deps.log ?? (() => {});
  try {
    const conversations = (await deps.gatherConversations(job.clientId)).filter((c) => c.turns.length > 0);
    if (conversations.length === 0) {
      // No history to interpret — a legitimate, non-error terminal state.
      await deps.completeJob(job.jobId);
      log(`[geo-backfill] client=${job.clientId} no history → done (no proposal)`);
      return { jobId: job.jobId, clientId: job.clientId, status: 'done', hadProposal: false };
    }

    // Each conversation is its own unit: extract → persist under ITS id → review.
    // A failure in any one fails the whole job (it retries; persistence is
    // idempotent per conversation and the proposal store dedups per checkpoint).
    let hadProposal = false;
    for (const conversation of conversations) {
      const { evidence, relations } = await deps.extract(conversation);
      let checkpointId: string | null = null;
      if (deps.persistExtraction) {
        const persisted = await deps.persistExtraction(job.clientId, conversation, evidence, relations);
        checkpointId = persisted.checkpointId;
      }
      const ctx = await deps.buildRunContext(job.clientId, evidence.length);
      if (checkpointId) ctx.checkpoint_id = checkpointId;
      const result = await deps.runReviewFirst(evidence, relations, ctx, {
        proposals: deps.proposals,
      });
      if (result.proposal !== null) hadProposal = true;
      log(
        `[geo-backfill] client=${job.clientId} ${conversation.channel}=${conversation.id ?? '?'} ` +
          `decision=${result.decision} evidence=${evidence.length} proposal=${result.proposal ? result.proposal.id : 'none'}`,
      );
    }

    await deps.completeJob(job.jobId);
    log(`[geo-backfill] client=${job.clientId} → done conversations=${conversations.length} proposal=${hadProposal}`);
    return { jobId: job.jobId, clientId: job.clientId, status: 'done', hadProposal };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Isolation: swallow, record on THIS job, let the batch continue.
    try {
      await deps.failJob(job.jobId, msg);
    } catch (failErr) {
      // failJob itself failing must not crash the batch either — log and move on.
      log(`[geo-backfill] client=${job.clientId} failJob errored: ${(failErr as Error).message}`);
    }
    log(`[geo-backfill] client=${job.clientId} FAILED: ${msg}`);
    return { jobId: job.jobId, clientId: job.clientId, status: 'failed', hadProposal: false, error: msg };
  }
}

/**
 * Claim-and-process jobs for a run until the queue drains or a ceiling is hit.
 *
 * Resumable by construction: it only ever processes what `claimNext` hands back,
 * and claimNext (backed by the SKIP-LOCKED RPC) returns only pending/retryable
 * jobs — done jobs are never re-processed.
 *
 * RETRY WITH A CAP: a job that fails is left `failed` with attempts++; claim
 * re-selects it (under the attempts cap) so it retries, and pending-first
 * ordering drains every fresh client before any retry, so a poison client can
 * never starve its siblings. Once a client hits the attempts cap it stays failed
 * and is skipped. Retries also survive across separate runs (re-running a run_id
 * resumes its pending + retryable-failed jobs).
 */
export async function runBackfillBatch(
  deps: BackfillDeps,
  opts: BatchOptions,
): Promise<BatchResult> {
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  let processed = 0;
  let done = 0;
  let failed = 0;
  let proposals = 0;

  while (processed < max && Date.now() < deadline) {
    const job = await deps.claimNext(opts.runId);
    if (!job) {
      return { processed, done, failed, proposals, drained: true };
    }
    const outcome = await processBackfillJob(deps, job);
    processed += 1;
    if (outcome.status === 'done') done += 1;
    else failed += 1;
    if (outcome.hadProposal) proposals += 1;
  }
  return { processed, done, failed, proposals, drained: false };
}
