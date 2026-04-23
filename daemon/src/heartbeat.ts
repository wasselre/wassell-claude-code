import { hostname } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DAEMON_VERSION } from './version.ts';

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

export function startHeartbeat({ supabase, intervalMs, getLastError }: HeartbeatOptions): HeartbeatHandle {
  const host = hostname();
  const pid = process.pid;

  const beat = async (): Promise<void> => {
    const lastErr = getLastError?.() ?? null;
    const payload = {
      id: 'presentations',
      last_heartbeat_at: new Date().toISOString(),
      hostname: host,
      pid,
      version: DAEMON_VERSION,
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
