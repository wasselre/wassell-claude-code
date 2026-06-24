/**
 * Server-side Supabase client using the service-role key. Bypasses RLS.
 *
 * USED ONLY BY `api/webhook/haberchat.ts` (audit rule — see CLAUDE.md and
 * the plan file). The webhook writes on behalf of every user, so it needs
 * to bypass per-user row-level security. All other api/* endpoints use
 * the user's JWT via `verifySupabaseJWT`.
 */

import { type SupabaseClient } from '@supabase/supabase-js';
import { makeServiceClient } from './serviceClient.js';

let cached: SupabaseClient | null = null;

export function getServiceSupabase(): SupabaseClient {
  if (cached) return cached;
  // T2: identity-tagged service-role client (x-wassel-service='api:server').
  const client = makeServiceClient('api:server');
  if (!client) {
    throw new Error(
      'SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required for the service-role client',
    );
  }
  cached = client;
  return cached;
}
