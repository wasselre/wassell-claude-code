import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../env.js';

type BrowserbaseEnv = Pick<WorkerEnv, 'BROWSERBASE_API_KEY' | 'BROWSERBASE_PROJECT_ID'>;

export function browserbaseSessionOptions(projectId: string, contextId?: string | null): Record<string, unknown> {
  return {
    projectId,
    timeout: 20 * 60,
    proxies: [{ type: 'browserbase', geolocation: { country: 'SA', city: 'RIYADH' } }],
    browserSettings: {
      viewport: { width: 1280, height: 900 },
      solveCaptchas: true,
      ...(contextId ? { context: { id: contextId, persist: true } } : {}),
    },
  };
}

/** The queue serializes a portal's jobs. The RPC is still compare-and-set so
 * a concurrent record edit cannot replace a previously assigned context. */
export async function ensurePortalContext(
  supabase: SupabaseClient,
  env: BrowserbaseEnv,
  portalRecordId: string,
  portal: Record<string, unknown>,
): Promise<string | null> {
  if (portal.browserbase_persist_context !== true) return null;
  if (typeof portal.browserbase_context_id === 'string' && portal.browserbase_context_id.trim()) {
    return portal.browserbase_context_id.trim();
  }
  const headers = { 'X-BB-API-Key': env.BROWSERBASE_API_KEY!, 'Content-Type': 'application/json' };
  const response = await fetch('https://api.browserbase.com/v1/contexts', {
    method: 'POST', headers,
    body: JSON.stringify({ projectId: env.BROWSERBASE_PROJECT_ID }),
    signal: AbortSignal.timeout(30_000),
  });
  const context = await response.json() as { id?: string; message?: string };
  if (!response.ok || !context.id) throw new Error(`Browserbase context create failed (${response.status}): ${context.message ?? 'no context id'}`);
  const { data, error } = await supabase.rpc('portal_browserbase_context_set', {
    p_portal_record_id: portalRecordId, p_context_id: context.id,
  });
  const chosen = typeof data === 'string' && data.trim() ? data.trim() : null;
  if (error || !chosen) {
    // A created but unrecorded context is never used; avoid leaving a cookie
    // container behind when the database write failed.
    await deleteUnusedContext(env, context.id);
    throw new Error(`portal_browserbase_context_set failed: ${error?.message ?? 'no context id returned'}`);
  }
  if (chosen !== context.id) await deleteUnusedContext(env, context.id);
  return chosen;
}

async function deleteUnusedContext(env: BrowserbaseEnv, id: string): Promise<void> {
  try {
    const response = await fetch(`https://api.browserbase.com/v1/contexts/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'X-BB-API-Key': env.BROWSERBASE_API_KEY! }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) console.error(`[portal] unused Browserbase context cleanup failed (${response.status})`);
  } catch (error) {
    // Only cleanup of a never-used context is best-effort. Main RPC failures
    // still propagate; API cleanup failures remain visible in worker logs.
    console.error(`[portal] unused Browserbase context cleanup failed: ${(error as Error).message}`);
  }
}
