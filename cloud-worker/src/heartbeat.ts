import { hostname } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { WORKER_VERSION } from './version.ts';

export interface HeartbeatOptions {
  supabase: SupabaseClient;
  intervalMs: number;
  getLastError?: () => { message: string; at: string } | null;
}

export interface HeartbeatHandle {
  stop: () => Promise<void>;
  /** Fire a heartbeat immediately; used on boot to flip the app out of the
   *  "offline" state without waiting for the first interval. */
  beatNow: () => Promise<void>;
}

/**
 * Upserts the singleton `daemon_status` row used by the app's offline banner.
 * The id is `presentations` — same row the legacy local daemon writes to —
 * so during the transition only ONE worker should be running at a time.
 * Phase 5 deletes the local daemon and the cloud worker becomes the sole
 * writer.
 */
export function startHeartbeat({ supabase, intervalMs, getLastError }: HeartbeatOptions): HeartbeatHandle {
  const host = hostname();
  const pid = process.pid;

  const beat = async (): Promise<void> => {
    const lastErr = getLastError?.() ?? null;
    const payload = {
      id: 'presentations',
      last_heartbeat_at: new Date().toISOString(),
      hostname: `cloud:${host}`,
      pid,
      version: WORKER_VERSION,
      last_error: lastErr?.message ?? null,
      last_error_at: lastErr?.at ?? null,
    };
    const { error } = await supabase.from('daemon_status').upsert(payload);
    if (error) {
      console.error(`[heartbeat] upsert failed: ${error.message}`);
    }
  };

  const handle = setInterval(() => {
    void beat();
  }, intervalMs);

  return {
    stop: async () => {
      clearInterval(handle);
    },
    beatNow: beat,
  };
}
