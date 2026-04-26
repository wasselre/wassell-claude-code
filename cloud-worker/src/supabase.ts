import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.ts';

/**
 * Service-role Supabase client for the cloud worker.
 *
 * Bypasses RLS — the worker needs to call the `claim_next_presentation_job`
 * RPC (which runs `FOR UPDATE SKIP LOCKED`) and write to `presentation_jobs`
 * / `daemon_status` regardless of any user session. Never ship this key to
 * the browser; it lives only in the worker's deploy-platform secrets.
 */
export function createWorkerSupabase(env: WorkerEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      // No session persistence / auto-refresh on the server.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
