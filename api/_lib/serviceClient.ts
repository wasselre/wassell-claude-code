/**
 * THE single factory for SERVICE-ROLE Supabase clients in the Vercel API runtime.
 *
 * Why this exists (T2, 2026-06-24 backend audit): a service-role client bypasses
 * RLS, so when one storms or loops, Postgres logs show only an anonymous
 * `service_role` call — you cannot tell the migrate endpoint from the webhook
 * from the worker. That blind spot is exactly what made the Fly worker a red
 * herring during the 2026-06-23 CPU storm. This factory stamps a MANDATORY
 * identity onto every request the client makes; PostgREST forwards request
 * headers into the `request.headers` GUC, so `record_save` / conflict telemetry
 * can name the caller:
 *
 *   x-wassel-service   logical caller, e.g. 'api:migrate', 'api:generate-deck'
 *   x-wassel-build     deployed git SHA (VERCEL_GIT_COMMIT_SHA), or 'unknown'
 *   x-wassel-instance  serving region (VERCEL_REGION), or 'unknown'
 *
 * HARD RULE: never call `createClient(url, SUPABASE_SERVICE_ROLE_KEY, ...)`
 * directly anywhere else. Go through `makeServiceClient` so identity is
 * guaranteed. `scripts/check-service-clients.mjs` fails the build if a raw
 * service-role `createClient` appears outside the factory files.
 *
 * SCOPE: identity headers only. This does NOT change auth, RLS, retry, or any
 * business logic — it is purely observability instrumentation.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** The mandatory identity header set for a Vercel-runtime service-role client. */
export function serviceIdentityHeaders(serviceName: string): Record<string, string> {
  return {
    'x-wassel-service': serviceName,
    'x-wassel-build': process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
    'x-wassel-instance': process.env.VERCEL_REGION ?? 'unknown',
  };
}

/**
 * Build a service-role client tagged with caller identity.
 *
 * Returns `null` when the required env is missing so each caller keeps its own
 * existing "env not configured" handling (some throw, some return a 500) — this
 * factory deliberately does not impose an error policy.
 */
export function makeServiceClient(serviceName: string): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: serviceIdentityHeaders(serviceName) },
  });
}
