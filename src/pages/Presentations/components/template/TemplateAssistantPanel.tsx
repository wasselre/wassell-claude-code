import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, X, Copy, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  streamTemplateAssistant,
  type TemplateAssistantMessage,
} from '@/lib/templateAssistant/client';
import type { PresentationTemplate } from '@/types';

/**
 * Right-side drawer with a streaming chat thread. The assistant has full
 * context (Wassel architecture, the 5 tools, and the user's current
 * template draft) and helps the user draft step prompts.
 *
 * Pattern:
 *   - User describes what they want a step to do (e.g. "research recent
 *     Riyadh apartment prices")
 *   - Assistant returns a complete prompt inside a code fence
 *   - User clicks the copy button on the code block, pastes into the
 *     step's prompt textarea
 *
 * Open/close is controlled by the parent. Closed = `open: false` and the
 * panel is hidden but its chat state persists for the session.
 */
interface TemplateAssistantPanelProps {
  open: boolean;
  onClose: () => void;
  /** The current draft, sent to the server on every turn so the assistant
   *  always sees the latest tools/steps/inputs the user has set. */
  template: PresentationTemplate;
}

export default function TemplateAssistantPanel({
  open,
  onClose,
  template,
}: TemplateAssistantPanelProps): JSX.Element | null {
  const isAr = useAppStore((s) => s.language === 'ar');

  const [messages, setMessages] = useState<TemplateAssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the chat area to the bottom when new content streams in.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // Cancel an in-flight request when the panel closes — otherwise tokens
  // keep streaming server-side after the UI is gone.
  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setStreaming(false);
    }
  }, [open]);

  const send = async (): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    setError(null);

    const nextMessages: TemplateAssistantMessage[] = [
      ...messages,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '' },
    ];
    setMessages(nextMessages);
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // The history we send to the server excludes the empty assistant
      // placeholder we just pushed (that's our local "in-flight" marker).
      const apiMessages = nextMessages.slice(0, -1);
      await streamTemplateAssistant(
        apiMessages,
        template,
        (event) => {
          if (event.type === 'text') {
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1]!;
              updated[updated.length - 1] = {
                ...last,
                content: last.content + event.delta,
              };
              return updated;
            });
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd/Ctrl+Enter sends; plain Enter keeps a newline so users can write
    // multi-line questions naturally.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  };

  const reset = (): void => {
    if (streaming && abortRef.current) abortRef.current.abort();
    setMessages([]);
    setInput('');
    setError(null);
  };

  if (!open) return null;

  return (
    <aside
      className="fixed top-0 bottom-0 z-40 w-[420px] max-w-[90vw] bg-cream border-s border-sand/60 shadow-xl flex flex-col"
      style={isAr ? { left: 0 } : { right: 0 }}
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-sand/40 bg-white">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-copper" />
          <h2 className="text-sm font-bold text-charcoal">
            {isAr ? 'مساعد القوالب' : 'Template assistant'}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={reset}
              className="text-xs text-charcoal/50 hover:text-charcoal px-2 py-1"
            >
              {isAr ? 'بدء جديد' : 'New chat'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-cream/40 text-charcoal/60"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 ? (
          <EmptyState isAr={isAr} />
        ) : (
          messages.map((m, i) => (
            <ChatBubble
              key={i}
              role={m.role}
              content={m.content}
              isStreaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
              isAr={isAr}
            />
          ))
        )}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs p-3">
            {error}
          </div>
        )}
      </div>

      <div className="border-t border-sand/40 p-3 bg-white">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            disabled={streaming}
            placeholder={
              isAr
                ? 'مثال: اكتب لي خطوة بحث عن أسعار الشقق في الرياض ٢٠٢٦…  (Ctrl+Enter للإرسال)'
                : 'e.g. Draft a research step for Riyadh apartment prices in 2026…  (Ctrl+Enter to send)'
            }
            rows={3}
            dir={isAr ? 'rtl' : 'ltr'}
            className="form-input text-sm w-full pe-10 resize-none"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={streaming || !input.trim()}
            className="absolute end-2 bottom-2 p-2 rounded-lg bg-copper text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-terracotta"
            aria-label={isAr ? 'إرسال' : 'Send'}
          >
            {streaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
        <p className="text-[10px] text-charcoal/40 mt-1.5 text-center">
          {isAr
            ? 'يستخدم Claude Opus 4.7 ويعرف القوالب وأدواتها'
            : 'Powered by Claude Opus 4.7 — knows your template + the 5 worker tools'}
        </p>
      </div>
    </aside>
  );
}

function EmptyState({ isAr }: { isAr: boolean }): JSX.Element {
  const examplesEn = [
    'Draft a research step prompt for Riyadh apartment prices.',
    'My build step needs to make a 3-slide deck — write the prompt.',
    'Write a step that pulls 5 clients from CRM and lists their preferences.',
    'I want to add an outline step — what should it say?',
  ];
  const examplesAr = [
    'اكتب لي خطوة بحث عن أسعار الشقق في الرياض.',
    'خطوة البناء تحتاج عمل عرض من 3 شرائح — اكتب التعليمات.',
    'اكتب خطوة تجلب 5 عملاء من النظام وتعرض تفضيلاتهم.',
    'أريد إضافة خطوة هيكلة — ماذا أكتب فيها؟',
  ];
  const examples = isAr ? examplesAr : examplesEn;
  return (
    <div className="text-sm text-charcoal/60 space-y-3">
      <p>
        {isAr
          ? 'اشرح ما تريد أن تفعله الخطوة. أنا أعرف بنية وصل العقارية، الأدوات الخمس، وتفاصيل قالبك الحالي. سأكتب لك التعليمات الصحيحة.'
          : 'Describe what you want the step to do. I know the Wassel architecture, the 5 worker tools, and your current template state. I\'ll draft the right prompt.'}
      </p>
      <div className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-wide text-charcoal/40">
          {isAr ? 'أمثلة' : 'Try'}
        </p>
        {examples.map((ex, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              const ta = document.querySelector('textarea[placeholder]') as HTMLTextAreaElement | null;
              if (ta) {
                ta.value = ex;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.focus();
              }
            }}
            className="w-full text-start text-xs text-charcoal/70 hover:text-copper bg-white border border-sand/40 rounded-lg px-3 py-2 hover:border-copper/40"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  content,
  isStreaming,
  isAr,
}: {
  role: 'user' | 'assistant';
  content: string;
  isStreaming: boolean;
  isAr: boolean;
}): JSX.Element {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
          isUser
            ? 'bg-copper text-white'
            : 'bg-white border border-sand/40 text-charcoal'
        }`}
      >
        {isUser ? (
          content
        ) : (
          <AssistantContent content={content} isStreaming={isStreaming} isAr={isAr} />
        )}
      </div>
    </div>
  );
}

/**
 * Renders assistant text with code-fence detection. Anything inside
 * triple-backtick fences becomes a copyable code block — the user clicks
 * Copy and pastes into the step's prompt textarea.
 */
function AssistantContent({
  content,
  isStreaming,
  isAr,
}: {
  content: string;
  isStreaming: boolean;
  isAr: boolean;
}): JSX.Element {
  if (content.length === 0 && isStreaming) {
    return (
      <span className="inline-flex items-center gap-2 text-charcoal/40">
        <Loader2 size={12} className="animate-spin" />
        {isAr ? 'جاري التفكير…' : 'Thinking…'}
      </span>
    );
  }

  // Split on ``` fences. Even-indexed segments are prose; odd-indexed are
  // code (the inside of a fence). Strip an optional language tag from the
  // first line of code segments.
  const segments = content.split(/```/g);
  return (
    <>
      {segments.map((seg, i) => {
        if (i % 2 === 0) {
          return seg ? <span key={i}>{seg}</span> : null;
        }
        // Code block. Strip leading "lang" line if present.
        const lines = seg.split('\n');
        const firstLine = lines[0]?.trim() ?? '';
        const isLangTag = /^[a-zA-Z0-9_+-]{1,20}$/.test(firstLine);
        const codeText = (isLangTag ? lines.slice(1) : lines).join('\n');
        return (
          <CodeBlock key={i} code={codeText.replace(/\n$/, '')} isAr={isAr} />
        );
      })}
      {isStreaming && (
        <span className="inline-block w-2 h-3 bg-charcoal/30 ms-1 animate-pulse" />
      )}
    </>
  );
}

function CodeBlock({ code, isAr }: { code: string; isAr: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="my-2 rounded-lg bg-cream/60 border border-sand/40 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b border-sand/30 text-[10px] text-charcoal/50">
        <span className="font-bold uppercase tracking-wide">
          {isAr ? 'مقتَرَح' : 'Suggested prompt'}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white text-charcoal/70 hover:text-copper"
        >
          <Copy size={10} />
          {copied ? (isAr ? 'تم النسخ' : 'Copied!') : (isAr ? 'نسخ' : 'Copy')}
        </button>
      </div>
      <pre
        className="p-2 text-xs font-mono text-charcoal/80 whitespace-pre-wrap break-words overflow-x-auto"
        dir="ltr"
      >
        {code}
      </pre>
    </div>
  );
}
