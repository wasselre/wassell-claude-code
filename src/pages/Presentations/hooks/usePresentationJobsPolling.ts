import { useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import type { PresentationJob, DaemonStatus } from '@/types';

/**
 * Polls Supabase for live updates on presentation jobs + the singleton
 * daemon heartbeat. Stops automatically when all visible jobs are terminal.
 *
 * In Phase 1 no daemon writes back, so this hook mostly refreshes the
 * daemon_status row to drive the "offline" banner. In Phase 2 it will also
 * pick up status transitions (queued → running → completed) written by the
 * daemon so the list and detail pages stay live.
 */
export function usePresentationJobsPolling(options: {
  /** Filter to a subset of jobs (e.g. one detail page). Empty/undefined = watch all. */
  jobIds?: string[];
  /** Poll interval in ms. Defaults to 3000; pass 1500 for detail pages. */
  intervalMs?: number;
  /** Set false to pause polling (e.g. when tab is hidden). Defaults true. */
  enabled?: boolean;
}): void {
  const { jobIds, intervalMs = 3000, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;
    if (!supabase) return;

    let disposed = false;
    const tick = async (): Promise<void> => {
      if (disposed) return;
      const state = useAppStore.getState();
      const watched = jobIds && jobIds.length > 0
        ? state.presentationJobs.filter((j) => jobIds.includes(j.id))
        : state.presentationJobs;
      // Nothing to watch — still refresh daemon status (offline banner).
      const hasLiveJobs = watched.some((j) => j.status === 'queued' || j.status === 'running');

      try {
        // Daemon status: always refresh, regardless of live jobs.
        const { data: daemonRow } = await supabase!
          .from('daemon_status')
          .select('*')
          .eq('id', 'presentations')
          .maybeSingle();
        if (!disposed) {
          useAppStore.setState({ daemonStatus: (daemonRow as DaemonStatus | null) ?? null });
        }
      } catch {
        // fail-open: leave existing daemonStatus as-is
      }

      if (hasLiveJobs) {
        try {
          const query = supabase!.from('presentation_jobs').select('*');
          const { data } = jobIds && jobIds.length > 0
            ? await query.in('id', jobIds)
            : await query.in('status', ['queued', 'running']);
          if (disposed || !data) return;
          const fresh = data as PresentationJob[];
          const byId = new Map(fresh.map((j) => [j.id, j]));
          const currentJobs = useAppStore.getState().presentationJobs;
          const next = currentJobs.map((j) => byId.get(j.id) ?? j);
          // Append any jobs returned by the query that aren't in local state yet.
          for (const j of fresh) {
            if (!next.find((x) => x.id === j.id)) next.unshift(j);
          }
          useAppStore.setState({ presentationJobs: next });
        } catch {
          // fail-open: next tick retries
        }
      }
    };

    // Kick once immediately so the banner / status update without waiting
    // a full interval on first mount.
    void tick();
    const handle = window.setInterval(() => { void tick(); }, intervalMs);
    return () => {
      disposed = true;
      window.clearInterval(handle);
    };
  }, [jobIds, intervalMs, enabled]);
}
