import { useState } from 'react';
import { Bot, Loader2, Pause, Play } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';

/**
 * The per-chat STOP / RESUME switch for the AI sales agent.
 *
 * The agent answers every customer chat by default; this is the ONLY thing that
 * stops it in a chat (a rep typing a message does not). Stopped = the agent and
 * the basic bot stay silent here until someone resumes. State is
 * `data.ai_paused` on the chat record, so the list and the thread stay in sync.
 */
export default function AiAgentSwitch({
  chatRecordId, paused, reason, isAr, compact = false,
}: {
  chatRecordId: string;
  paused: boolean;
  /** Why it is stopped: 'rep' (someone pressed stop) or 'turn_cap' (the agent reached its reply limit). */
  reason?: string | null;
  isAr: boolean;
  compact?: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const toggle = async () => {
    const next = !paused;
    setBusy(true);
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const res = await fetch('/api/whatsapp/ai-pause', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ chat_record_id: chatRecordId, paused: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; answering?: boolean };
      if (!res.ok) {
        addToast(L(`تعذّر التغيير: ${body.error ?? res.status}`, `Failed: ${body.error ?? res.status}`), 'error');
        return;
      }
      addToast(
        next
          ? L('أوقفت المساعد في هذه المحادثة — لن يرد حتى تشغّله', 'AI stopped in this chat — it stays silent until you resume it')
          : body.answering
            ? L('شغّلت المساعد — يرد الآن على رسالة العميل', 'AI resumed — answering the customer now')
            : L('شغّلت المساعد — يرد على رسائل العميل القادمة', 'AI resumed — it answers the customer from now on'),
        'success',
      );
    } catch (err) {
      console.error('[AiAgentSwitch] toggle failed:', err);
      addToast(L(`خطأ: ${String(err)}`, `Error: ${String(err)}`), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pad = compact ? 'px-2 py-0.5' : 'px-2.5 py-1';
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      className={`inline-flex items-center gap-1 rounded-full border ${pad} text-xs font-medium transition-colors disabled:opacity-50 ${
        paused
          ? 'border-amber-400/60 bg-amber-50 text-amber-800 hover:bg-amber-100'
          : 'border-green-500/50 bg-green-500/10 text-green-700 hover:bg-green-500/20'
      }`}
      title={
        paused
          ? (reason === 'turn_cap'
              ? L('المساعد توقف بعد بلوغ حد الردود — اضغط لتشغيله', 'The AI stopped at its reply limit — press to resume')
              : L('المساعد موقوف في هذه المحادثة — اضغط لتشغيله', 'The AI is stopped in this chat — press to resume'))
          : L('المساعد يرد على هذا العميل — اضغط لإيقافه وتولّي المحادثة', 'The AI is answering this customer — press to stop it and take over')
      }
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : paused ? <Play size={12} /> : <Bot size={12} />}
      {paused ? L('المساعد موقوف — تشغيل', 'AI stopped — resume') : L('المساعد يرد', 'AI answering')}
      {!paused && !busy && <Pause size={11} className="opacity-70" />}
    </button>
  );
}
