import { useEffect, useState } from 'react';
import { fetchAiFollowupSends, type AiFollowupSends } from '@/lib/aiActions/client';

/**
 * The AI's WhatsApp follow-ups for a period — sent, of which campaign, still
 * queued, failed. Refreshed every minute while the overview is open.
 */
export function useAiFollowupSends(range: { from: number; to: number }) {
  const [counts, setCounts] = useState<AiFollowupSends | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = await fetchAiFollowupSends(new Date(range.from).toISOString(), new Date(range.to).toISOString());
        if (alive) { setCounts(c); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [range.from, range.to]);

  return { counts, error };
}
