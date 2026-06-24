// Identity-tagged Supabase client factory for the manual operator SCRIPTS.
//
// Scripts are run by hand against prod with a service-role (or, for the
// read-only PRD/enum scripts, an anon-fallback) key. T2 routes them through
// this one factory so (a) their DB calls are attributable in Postgres logs and
// (b) scripts/check-service-clients.mjs has a single allowlisted chokepoint.
//
// Unlike the server factories this is a PASS-THROUGH on (url, key): several
// scripts resolve `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY` themselves
// (prefer-service, fall-back-to-anon) and we must not change that logic — the
// caller passes whatever it resolved. Identity headers are attached either way.
//
//   x-wassel-service   'script:<name>'
//   x-wassel-build     git SHA if exported as GIT_SHA, else 'unknown'
//   x-wassel-instance  the host running the script (os.hostname())
//
// SCOPE: identity headers only. No business-logic change.

import { createClient } from '@supabase/supabase-js';
import os from 'node:os';

export function makeIdentifiedClient(serviceName, url, key) {
  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      headers: {
        'x-wassel-service': serviceName,
        'x-wassel-build': process.env.GIT_SHA ?? 'unknown',
        'x-wassel-instance': os.hostname(),
      },
    },
  });
}
