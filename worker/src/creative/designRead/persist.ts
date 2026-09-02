/**
 * Persist a design read via the scoped upsert RPC (worker path).
 *
 * The unique key is (subject_kind, subject_id, level, model_used,
 * rule_version): re-reading with the same model + rule version upserts in
 * place; a new rule version writes a new row, so prompts can evolve without
 * destroying history. The runner path (scripts/claude-study-runner.mjs) calls
 * the same RPC with model_used 'claude-runner:design-read'.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReadLevel, ReadSubjectKind } from '../contracts.js';

export const DESIGN_READ_RULE_VERSION = 'v1';

export interface DesignReadUpsertArgs {
  subject_kind: ReadSubjectKind;
  subject_id: string;
  level: ReadLevel;
  post_id: string | null;
  slide_index: number | null;
  organization_id: string | null;
  model_task: 'design_read_slide' | 'design_read_post';
  /** Resolved model id from the role result (e.g. 'claude-sonnet-5'). */
  model_used: string;
  rule_version: string;
  read: Record<string, unknown>;
  confidence?: number | null;
  cost_usd?: number | null;
  raw?: unknown;
  status?: 'done' | 'failed';
  failure?: string | null;
  /** 768-d SigLIP-2 vector; passed to the RPC in its '[…]' text form. */
  embedding?: number[] | null;
}

/** Upsert one read. Returns the visual_design_reads row id. Loud on failure. */
export async function upsertDesignRead(sb: SupabaseClient, args: DesignReadUpsertArgs): Promise<string> {
  const { data, error } = await sb.rpc('visual_design_read_upsert', {
    p_subject_kind: args.subject_kind,
    p_subject_id: args.subject_id,
    p_level: args.level,
    p_post_id: args.post_id,
    p_slide_index: args.slide_index,
    p_organization_id: args.organization_id,
    p_model_task: args.model_task,
    p_model_used: args.model_used,
    p_rule_version: args.rule_version,
    p_read: args.read,
    p_confidence: args.confidence ?? null,
    p_cost_usd: args.cost_usd ?? null,
    p_raw: args.raw ?? null,
    p_status: args.status ?? 'done',
    p_failure: args.failure ?? null,
    p_embedding: args.embedding && args.embedding.length > 0 ? `[${args.embedding.join(',')}]` : null,
  });
  if (error) throw new Error(`provider:supabase visual_design_read_upsert failed for ${args.subject_kind}/${args.subject_id}: ${error.message}`);
  return String(data);
}
