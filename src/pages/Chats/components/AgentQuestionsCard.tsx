import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { AgentQuestion } from '@/types';
import AgentQuestionItem from '@/components/agentQuestions/AgentQuestionItem';

/**
 * Questions the AI sales agent could not answer and asked the rep
 * (wa_agent_questions), shown above the composer of that chat. The same
 * questions are listed across all chats in Sales → Work Queue → «أسئلة المساعد».
 * Sending from the composer closes them automatically too. Hidden when there
 * is nothing open.
 */
export default function AgentQuestionsCard({ chatWid, isAr, messageCount }: {
  chatWid: string;
  isAr: boolean;
  /** Re-checks when the thread changes (a rep reply may have closed a question). */
  messageCount: number;
}) {
  const loadAgentQuestions = useAppStore((s) => s.loadAgentQuestions);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);

  const refresh = useCallback(() => {
    if (!chatWid) return;
    loadAgentQuestions(chatWid)
      .then(setQuestions)
      // The card is an aid; a failed poll is logged and retried on the next tick.
      .catch((e: unknown) => console.error('[AgentQuestionsCard] load failed:', e));
  }, [chatWid, loadAgentQuestions]);

  useEffect(() => {
    setQuestions([]);
    refresh();
    const t = window.setInterval(refresh, 20_000);
    return () => window.clearInterval(t);
  }, [refresh]);
  useEffect(() => { refresh(); }, [messageCount, refresh]);

  if (questions.length === 0) return null;

  return (
    <div className="mx-0 mb-2 space-y-2 md:mx-0">
      {questions.map((q) => (
        <AgentQuestionItem
          key={q.id}
          question={q}
          isAr={isAr}
          onResolved={(id) => setQuestions((qs) => qs.filter((x) => x.id !== id))}
          onStale={refresh}
        />
      ))}
    </div>
  );
}
