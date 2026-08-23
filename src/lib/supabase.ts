import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { processLock } from '@supabase/auth-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Per-tab + build identifiers attached to EVERY PostgREST request as headers.
// PostgREST forwards request headers into the `request.headers` GUC, so
// `record_save`'s conflict telemetry can log exactly which tab + which deployed
// build generated a save — closing the "which tab" attribution gap that is
// otherwise invisible server-side (a user_id only proves the account, not the
// tab/process). See supabase/migrations/2026-06-21_conflict_storm_hardening.sql.
//
// - x-wassel-tab:   unique per JS context, i.e. per browser tab / page load.
//                   A stale tab that never reloads keeps the SAME id for days,
//                   so a conflict storm's telemetry pins to one tab id.
// - x-wassel-build: the bundle's build version (git SHA). A storm from an
//                   OUTDATED build id is the signature of a tab that loaded
//                   before a fix shipped and never reloaded.
export const CLIENT_TAB_ID: string =
  (globalThis.crypto?.randomUUID?.() ??
    `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

export const CLIENT_BUILD_ID: string =
  typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'unknown';

export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          // Use the in-memory processLock instead of the default navigatorLock
          // (Web Locks API). On iOS/Safari PWAs the Web Lock gets held across
          // app suspend/resume and then "stolen by another request", which
          // STALLS `getSession()` / the token refresh — so a WhatsApp send goes
          // out slowly and sometimes without a fresh token, fails, and only
          // works on a retry (the "takes a couple of tries + key stolen error"
          // report, 2026-08-20). processLock serialises token refresh within the
          // tab without the Web Locks API. This is Supabase's recommended fix
          // for exactly this Safari/iOS symptom.
          lock: processLock,
        },
        global: {
          headers: {
            // T2 (2026-06-24): identify the SPA as a caller in Postgres logs /
            // conflict telemetry, alongside the per-tab + per-build ids. Mirrors
            // the x-wassel-service header the server/worker factories attach.
            'x-wassel-service': 'spa',
            'x-wassel-tab': CLIENT_TAB_ID,
            'x-wassel-build': CLIENT_BUILD_ID,
          },
        },
      })
    : null;

export const isSupabaseConfigured = (): boolean => supabase !== null;
