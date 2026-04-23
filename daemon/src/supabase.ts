import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DaemonEnv } from './env.ts';

/**
 * Service-role Supabase client for the daemon.
 * Bypasses RLS — the daemon needs to SELECT ... FOR UPDATE SKIP LOCKED (via
 * the `claim_next_presentation_job` RPC) and write to `presentation_jobs` /
 * `daemon_status` / `presentation_templates` regardless of any user session.
 * Never ship this key to the browser.
 */
export function createDaemonSupabase(env: DaemonEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      // No session persistence / auto-refresh on the server.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
