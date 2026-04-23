/**
 * Server-side Supabase client using the service-role key. Bypasses RLS.
 *
 * USED ONLY BY `api/webhook/haberchat.ts` (audit rule — see CLAUDE.md and
 * the plan file). The webhook writes on behalf of every user, so it needs
 * to bypass per-user row-level security. All other api/* endpoints use
 * the user's JWT via `verifySupabaseJWT`.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getServiceSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required for the service-role client',
    );
  }
  cached = createClient(url, serviceKey, { auth: { persistSession: false } });
  return cached;
}
