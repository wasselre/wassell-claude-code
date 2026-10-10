import { useEffect, useState } from 'react';
import { fetchNextStepStats, type NextStepStats } from '@/lib/nextStep/client';

/**
 * Who decided the next steps in a period — the agent, or the 9 pm default.
 * Refreshed every minute while the overview is open.
 */
export function useNextStepStats(range: { from: number; to: number }) {
  const [stats, setStats] = useState<NextStepStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchNextStepStats(new Date(range.from).toISOString(), new Date(range.to).toISOString());
        if (alive) { setStats(s); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [range.from, range.to]);

  return { stats, error };
}
