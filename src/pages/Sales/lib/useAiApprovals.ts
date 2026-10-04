import { useCallback, useEffect, useState } from 'react';
import type { AiAction } from '@/types';
import { fetchAiActions } from '@/lib/aiActions/client';
import { fetchAllReadyChatSuggestions, type ChatOutcomeSuggestion } from '@/lib/chatSuggestions/client';

/**
 * Everything the AI prepared that waits for the operator — messages to
 * clients, notices to officers (ai_actions) and follow-up results
 * (chat_outcome_suggestions). Feeds the Work Queue's AI tab and its badge.
 * Polled every 30 s and on window focus. `enabled=false` (not an admin) loads
 * nothing.
 */
export function useAiApprovals(enabled: boolean) {
  const [actions, setActions] = useState<AiAction[]>([]);
  const [results, setResults] = useState<ChatOutcomeSuggestion[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [a, r] = await Promise.all([fetchAiActions(), fetchAllReadyChatSuggestions()]);
      setActions(a);
      setResults(r);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[useAiApprovals] load failed:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [enabled, refresh]);

  const dropAction = useCallback((id: string) => setActions((xs) => xs.filter((x) => x.id !== id)), []);
  const dropResult = useCallback((id: string) => setResults((xs) => xs.filter((x) => x.id !== id)), []);

  return { actions, results, loading, error, refresh, dropAction, dropResult };
}
