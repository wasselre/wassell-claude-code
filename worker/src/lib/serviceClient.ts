/**
 * Service-role Supabase client factory for the Fly worker.
 *
 * COPY of the api/_lib/serviceClient.ts contract — the worker is a standalone
 * npm package (rootDir:src; the Dockerfile copies only src/) and CANNOT import
 * from api/_lib. Same posture as worker/src/imageGen.ts etc. Keep the header
 * contract in sync with api/_lib/serviceClient.ts.
 *
 * Stamps a mandatory identity onto every request so a worker that storms or
 * loops is attributable in Postgres logs (the 2026-06-23 storm could not tell
 * the worker apart from other service-role callers — T2 closes that):
 *
 *   x-wassel-service   'worker' (every loop in the process shares one client)
 *   x-wassel-build     the Fly image ref (FLY_IMAGE_REF), or 'unknown'
 *   x-wassel-instance  the Fly machine id (FLY_MACHINE_ID) — which of N machines
 *
 * SCOPE: identity headers only. No auth/RLS/retry/business-logic change.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../env.js';

export function makeServiceClient(env: WorkerEnv, serviceName = 'worker'): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: {
      headers: {
        'x-wassel-service': serviceName,
        'x-wassel-build': process.env.FLY_IMAGE_REF ?? 'unknown',
        'x-wassel-instance': process.env.FLY_MACHINE_ID ?? env.WORKER_ID,
      },
    },
  });
}
