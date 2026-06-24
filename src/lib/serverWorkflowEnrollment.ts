// Server-authoritative workflow enrollment (client side).
//
// A model present in `workflow_capture_models` is executed by the Fly worker
// (server-authoritative). For such a model the BROWSER client engine must NOT
// also run workflows on save — otherwise the client AND the server both fire
// and every create/update double-executes (duplicate follow-ups, etc.). This
// module is the single source of truth the store + the workflow call sites use
// to decide "is this model server-enrolled?".

import { supabase } from './supabase';

/**
 * True when `modelId` is enrolled in server-authoritative workflow execution.
 * The client engine SKIPS firing for such models. Pure + testable.
 */
export function isModelServerEnrolled(modelId: string, enrolled: ReadonlySet<string>): boolean {
  return enrolled.has(modelId);
}

/**
 * Load the enabled allowlist into a Set.
 *
 * FAIL-SAFE: on error, log LOUDLY and return an EMPTY set so the client keeps
 * its existing behavior for non-enrolled models (the vast majority). The
 * realtime channel + a re-load converge a known-enrolled model quickly; that
 * brief window is the documented trade-off vs. the worse alternative
 * (suppressing ALL client workflows on a transient read failure, which would
 * silently stop every model's automations).
 */
export async function loadServerEnrolledModelIds(): Promise<Set<string>> {
  if (!supabase) return new Set();
  try {
    const { data, error } = await supabase
      .from('workflow_capture_models')
      .select('model_id')
      .eq('enabled', true);
    if (error) throw error;
    return new Set((data ?? []).map((r) => r.model_id as string));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[server-workflows] LOUD: failed to load workflow_capture_models — the client engine will keep firing for ALL models (fail-safe = existing behavior). A server-enrolled model could double-fire until this loads / realtime converges.',
      err,
    );
    return new Set();
  }
}
