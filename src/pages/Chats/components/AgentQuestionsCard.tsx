import { useCallback, useEffect, useState } from 'react';
import { HelpCircle, Loader2, Send } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import type { AgentQuestion } from '@/types';

/**
 * Questions the AI sales agent could not answer and asked the rep
 * (wa_agent_questions), shown above the composer of that chat.
 *
 * The rep has three ways out, all explicit:
 *   • type the answer → the agent passes it on to the customer in its own voice
 *     (optionally kept as a fact of the project for next time);
 *   • «أجبته مباشرة» → the rep answered the customer themselves (sending from
 *     the composer closes the question automatically too);
 *   • «ليس سؤالاً» → dismiss, nothing is sent.
 * Hidden when there is nothing open.
 */
export default function AgentQuestionsCard({ chatWid, isAr, messageCount }: {
  chatWid: string;
  isAr: boolean;
  /** Re-checks when the thread changes (a rep reply may have closed a question). */
  messageCount: number;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const loadAgentQuestions = useAppStore((s) => s.loadAgentQuestions);
  const addToast = useAppStore((s) => s.addToast);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [asFact, setAsFact] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

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

  const act = async (q: AgentQuestion, action: 'answer' | 'direct' | 'dismiss') => {
    const answer = (drafts[q.id] ?? '').trim();
    if (action === 'answer' && !answer) return;
    setBusy(q.id);
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const res = await fetch('/api/whatsapp/agent-answer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ question_id: q.id, action, answer, save_as_fact: asFact[q.id] === true }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const msg = body.error === 'ai_paused'
          ? L('المساعد موقوف في هذه المحادثة — ردّ على العميل مباشرة أو شغّل المساعد أولاً', 'The AI is stopped in this chat — answer the customer directly or resume the AI first')
          : body.error === 'already_resolved'
            ? L('هذا السؤال أُجيب عليه بالفعل', 'This question was already resolved')
            : body.error === 'ai_disabled'
              ? L('المساعد الآلي مطفأ — ردّ على العميل مباشرة', 'The AI is switched off — answer the customer directly')
              : L(`تعذّر الحفظ: ${body.error ?? res.status}`, `Could not save: ${body.error ?? res.status}`);
        addToast(msg, 'error');
        if (body.error === 'already_resolved') refresh();
        return;
      }
      addToast(
        action === 'answer'
          ? L('وصل جوابك للمساعد — يبلّغ العميل الآن', 'Answer saved — the AI is telling the customer now')
          : action === 'direct' ? L('أُغلق السؤال', 'Question closed') : L('تم تجاهل السؤال', 'Question dismissed'),
        'success',
      );
      setQuestions((qs) => qs.filter((x) => x.id !== q.id));
    } catch (err) {
      console.error('[AgentQuestionsCard] action failed:', err);
      addToast(L(`خطأ: ${String(err)}`, `Error: ${String(err)}`), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (questions.length === 0) return null;

  return (
    <div className="mx-0 mb-2 space-y-2 md:mx-0">
      {questions.map((q) => (
        <div key={q.id} className="rounded-2xl border border-amber-300 bg-amber-50 p-3">
          <div className="flex items-start gap-2">
            <HelpCircle size={16} className="mt-0.5 shrink-0 text-amber-700" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold text-amber-800">{L('المساعد يسألك — العميل ينتظر الجواب', 'The AI is asking you — the customer is waiting')}</div>
              <div className="mt-0.5 text-sm font-semibold text-charcoal" dir="auto">{q.question}</div>
              {q.note && <div className="mt-0.5 text-xs text-charcoal/60" dir="auto">{q.note}</div>}
            </div>
          </div>
          <textarea
            value={drafts[q.id] ?? ''}
            onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
            rows={2}
            dir="auto"
            placeholder={L('اكتب الجواب هنا والمساعد يبلّغه للعميل بأسلوبه…', 'Type the answer; the AI passes it on in its own voice…')}
            className="form-input mt-2 w-full resize-none text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy === q.id || !(drafts[q.id] ?? '').trim()}
              onClick={() => void act(q, 'answer')}
              className="inline-flex items-center gap-1 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
            >
              {busy === q.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              {L('أرسل الجواب عبر المساعد', 'Send via the AI')}
            </button>
            <button
              type="button"
              disabled={busy === q.id}
              onClick={() => void act(q, 'direct')}
              className="rounded-lg border border-charcoal/20 bg-white px-3 py-1.5 text-xs font-semibold text-charcoal/80 transition hover:bg-cream disabled:opacity-50"
              title={L('رددت على العميل بنفسك — يُغلق السؤال ولا يرسل المساعد شيئاً', 'You answered the customer yourself — closes the question, the AI sends nothing')}
            >
              {L('أجبته مباشرة', 'I answered directly')}
            </button>
            <button
              type="button"
              disabled={busy === q.id}
              onClick={() => void act(q, 'dismiss')}
              className="rounded-lg px-2 py-1.5 text-xs font-semibold text-charcoal/50 transition hover:bg-charcoal/5 disabled:opacity-50"
            >
              {L('ليس سؤالاً', 'Not a question')}
            </button>
            {q.project_id && (
              <label className="ms-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-charcoal/70">
                <input
                  type="checkbox"
                  checked={asFact[q.id] === true}
                  onChange={(e) => setAsFact((f) => ({ ...f, [q.id]: e.target.checked }))}
                />
                {L('احفظ الجواب كمعلومة عن المشروع', 'Keep as a fact of this project')}
              </label>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
