import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { AgentQuestion } from '@/types';

/**
 * Open questions the WhatsApp sales agent asked reps, across every chat the
 * caller can see — the Work Queue's «أسئلة المساعد» tab and its badge.
 * Polled every 30 s and on window focus; a resolved question is dropped
 * locally at once.
 */
export function useAgentQuestions() {
  const loadOpenAgentQuestions = useAppStore((s) => s.loadOpenAgentQuestions);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setQuestions(await loadOpenAgentQuestions());
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[useAgentQuestions] load failed:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [loadOpenAgentQuestions]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const drop = useCallback((id: string) => setQuestions((qs) => qs.filter((q) => q.id !== id)), []);

  return { questions, loading, error, refresh, drop };
}
