import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

/**
 * Message composer: textarea + send button. Enter sends, Shift+Enter
 * newline, Ctrl/Cmd+Enter also sends. Auto-grows up to 6 rows; scrolls
 * past that. Disabled while the optimistic send is in flight.
 *
 * Step 9 adds an attach button for media; for now this is text-only.
 */
export default function Composer({
  chatWid,
  disabled = false,
}: {
  chatWid: string;
  disabled?: boolean;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const sendChatMessage = useAppStore((s) => s.sendChatMessage);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea up to a cap. Reset height first so shrinking
  // back down after a delete works.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 6 * 24; // ~6 lines at 24px line-height
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [text]);

  const canSend = text.trim().length > 0 && !sending && !disabled;

  const doSend = async () => {
    if (!canSend) return;
    const body = text.trim();
    setSending(true);
    // Clear optimistically so the user can keep typing. If the send fails,
    // the error toast + failed bubble tell them what happened — the text
    // doesn't come back (matches WhatsApp desktop).
    setText('');
    try {
      await sendChatMessage(chatWid, { body });
    } catch {
      // sendChatMessage already toasted the error and marked the bubble
      // as failed. No extra handling needed here.
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter newline. Ctrl/Cmd+Enter also sends (common
    // in other chat apps; some users default to that).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  };

  return (
    <div className="card p-3 mt-3 flex items-end gap-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={isAr ? 'اكتب رسالتك...' : 'Type a message…'}
        disabled={sending || disabled}
        rows={1}
        className="flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm text-charcoal placeholder:text-charcoal/40 focus:outline-none leading-relaxed"
        dir="auto"
      />
      <button
        onClick={doSend}
        disabled={!canSend}
        className="shrink-0 w-10 h-10 rounded-full bg-copper text-white hover:bg-terracotta disabled:bg-charcoal/20 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
        aria-label={isAr ? 'إرسال' : 'Send'}
        title={isAr ? 'إرسال (Enter)' : 'Send (Enter)'}
      >
        {sending ? (
          <Loader2 size={18} className="animate-spin" />
        ) : (
          <Send size={16} className={isAr ? 'rotate-180' : ''} />
        )}
      </button>
    </div>
  );
}
