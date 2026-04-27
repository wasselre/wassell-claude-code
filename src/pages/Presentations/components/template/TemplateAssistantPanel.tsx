import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, X, Copy, Loader2, Check, Wand2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  streamTemplateAssistant,
  type TemplateAssistantMessage,
  type TemplateProposal,
  type TemplateProposalChanges,
} from '@/lib/templateAssistant/client';
import type { PresentationTemplate } from '@/types';

/**
 * Right-side drawer with a streaming chat thread. The assistant has full
 * context (Wassel architecture, the 5 tools, brand vs output_structure
 * split, recent platform updates, and the user's current draft).
 *
 * The assistant communicates two ways:
 *   - **Plain text** — explanations, questions, follow-ups, suggested
 *     prompts inside ```` code fences (still supported for free-form text).
 *   - **Structured proposals** — when the assistant wants to FILL a
 *     template field, it calls the `propose_template_patch` tool. Each
 *     call streams as a `proposal` event and shows up inline as an
 *     "Apply" card. The user clicks Apply and the patch merges into the
 *     template draft (the parent's `onApply` callback handles validation
 *     + id generation + the actual mutation).
 */
interface TemplateAssistantPanelProps {
  open: boolean;
  onClose: () => void;
  /** The current draft, sent to the server on every turn so the assistant
   *  always sees the latest tools/steps/inputs the user has set. */
  template: PresentationTemplate;
  /** Apply a proposed patch to the parent's draft. Parent is responsible
   *  for id generation, tool-subset validation, and dispatching the
   *  store-level setDraft. Returns true if applied, false if rejected. */
  onApply: (changes: TemplateProposalChanges) => boolean;
}

/** Local chat-message shape — extends the wire shape with an array of
 *  proposals attached to whichever message the assistant emitted them in. */
interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  proposals?: TemplateProposal[];
  /** Set of proposal ids the user has acted on (Apply or Discard). The
   *  card renders as disabled with the chosen state. */
  proposalState?: Record<string, 'applied' | 'discarded'>;
}

export default function TemplateAssistantPanel({
  open,
  onClose,
  template,
  onApply,
}: TemplateAssistantPanelProps): JSX.Element | null {
  const isAr = useAppStore((s) => s.language === 'ar');

  const [messages, setMessages] = useState<UiMessage[]>([]);
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

    const nextMessages: UiMessage[] = [
      ...messages,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '', proposals: [], proposalState: {} },
    ];
    setMessages(nextMessages);
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // The history we send to the server excludes the empty assistant
      // placeholder we just pushed (that's our local "in-flight" marker).
      // Strip proposals from the wire history — they aren't text the
      // server needs to replay as conversation context.
      const apiMessages: TemplateAssistantMessage[] = nextMessages
        .slice(0, -1)
        .map(({ role, content }) => ({ role, content }));

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
          } else if (event.type === 'proposal') {
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1]!;
              const existing = last.proposals ?? [];
              updated[updated.length - 1] = {
                ...last,
                proposals: [
                  ...existing,
                  { id: event.id, summary: event.summary, changes: event.changes },
                ],
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

  const handleApply = (msgIdx: number, proposal: TemplateProposal): void => {
    const ok = onApply(proposal.changes);
    setMessages((prev) => {
      const updated = [...prev];
      const m = updated[msgIdx];
      if (!m) return prev;
      updated[msgIdx] = {
        ...m,
        proposalState: {
          ...(m.proposalState ?? {}),
          [proposal.id]: ok ? 'applied' : 'discarded',
        },
      };
      return updated;
    });
  };

  const handleDiscard = (msgIdx: number, proposal: TemplateProposal): void => {
    setMessages((prev) => {
      const updated = [...prev];
      const m = updated[msgIdx];
      if (!m) return prev;
      updated[msgIdx] = {
        ...m,
        proposalState: {
          ...(m.proposalState ?? {}),
          [proposal.id]: 'discarded',
        },
      };
      return updated;
    });
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
              proposals={m.proposals ?? []}
              proposalState={m.proposalState ?? {}}
              isStreaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
              isAr={isAr}
              onApply={(p) => handleApply(i, p)}
              onDiscard={(p) => handleDiscard(i, p)}
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
                ? 'مثال: اكتب لي خطوة بحث ثم خطوة بناء — املأ القالب بالكامل  (Ctrl+Enter للإرسال)'
                : 'e.g. Draft a research step, then a build step — fill the template  (Ctrl+Enter to send)'
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
            ? 'Claude Opus 4.7 — يعرف بنية وصل، الأدوات، وآخر التحديثات. يستطيع ملء حقول القالب مباشرة.'
            : 'Claude Opus 4.7 — knows Wassel architecture, tools, recent updates. Can fill template fields directly.'}
        </p>
      </div>
    </aside>
  );
}

function EmptyState({ isAr }: { isAr: boolean }): JSX.Element {
  const examplesEn = [
    'Fill the basics for a Riyadh apartment market deck.',
    'Draft a research step + a build step that uses code_execution.',
    'Add an input for project_brief (textarea, required).',
    'Generate the output structure for a 10-slide monthly report.',
  ];
  const examplesAr = [
    'املأ المعلومات الأساسية لعرض شقق الرياض.',
    'اكتب خطوة بحث ثم خطوة بناء تستخدم code_execution.',
    'أضف مدخلاً اسمه project_brief — نصي طويل، إلزامي.',
    'اكتب هيكل إخراج لتقرير شهري من ١٠ شرائح.',
  ];
  const examples = isAr ? examplesAr : examplesEn;
  return (
    <div className="text-sm text-charcoal/60 space-y-3">
      <p>
        {isAr
          ? 'اشرح ما تريد. أنا أعرف بنية وصل، الأدوات الخمس، تفاصيل قالبك الحالي، وآخر تحديثات المنصة. أستطيع كتابة التعليمات وملء الحقول مباشرة عبر بطاقات "تطبيق".'
          : 'Tell me what you want. I know the Wassel architecture, the 5 worker tools, your current draft, and the recent platform updates. I can write prompts AND fill template fields directly via Apply cards.'}
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
  proposals,
  proposalState,
  isStreaming,
  isAr,
  onApply,
  onDiscard,
}: {
  role: 'user' | 'assistant';
  content: string;
  proposals: TemplateProposal[];
  proposalState: Record<string, 'applied' | 'discarded'>;
  isStreaming: boolean;
  isAr: boolean;
  onApply: (p: TemplateProposal) => void;
  onDiscard: (p: TemplateProposal) => void;
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
          <>
            <AssistantContent content={content} isStreaming={isStreaming} isAr={isAr} />
            {proposals.length > 0 && (
              <div className="mt-2 space-y-2">
                {proposals.map((p) => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    state={proposalState[p.id]}
                    isAr={isAr}
                    onApply={() => onApply(p)}
                    onDiscard={() => onDiscard(p)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** A bordered card showing the assistant's proposed patch with Apply /
 *  Discard buttons. Once acted on, the buttons collapse into a status
 *  chip ("Applied" / "Discarded"). */
function ProposalCard({
  proposal,
  state,
  isAr,
  onApply,
  onDiscard,
}: {
  proposal: TemplateProposal;
  state: 'applied' | 'discarded' | undefined;
  isAr: boolean;
  onApply: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const fieldChips = describeChanges(proposal.changes, isAr);
  return (
    <div
      className={`rounded-lg border overflow-hidden ${
        state === 'applied'
          ? 'border-green-300 bg-green-50'
          : state === 'discarded'
            ? 'border-charcoal/15 bg-cream/60 opacity-70'
            : 'border-copper/40 bg-cream/40'
      }`}
    >
      <div className="px-3 py-2 border-b border-sand/30 flex items-start gap-2">
        <Wand2 size={14} className="text-copper shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-charcoal/60">
            {isAr ? 'تعديل مقتَرَح' : 'Proposed change'}
          </p>
          <p className="text-sm text-charcoal mt-0.5 whitespace-normal break-words">
            {proposal.summary}
          </p>
        </div>
      </div>
      {fieldChips.length > 0 && (
        <div className="px-3 py-2 border-b border-sand/30 flex flex-wrap gap-1">
          {fieldChips.map((c, i) => (
            <span
              key={i}
              className="inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded bg-white border border-sand/50 text-charcoal/70"
            >
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="px-3 py-2 flex items-center justify-end gap-2">
        {state === 'applied' ? (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-green-700">
            <Check size={12} />
            {isAr ? 'تم التطبيق' : 'Applied'}
          </span>
        ) : state === 'discarded' ? (
          <span className="text-xs text-charcoal/50">{isAr ? 'تم التجاهل' : 'Discarded'}</span>
        ) : (
          <>
            <button
              type="button"
              onClick={onDiscard}
              className="text-xs text-charcoal/60 hover:text-charcoal px-2 py-1"
            >
              {isAr ? 'تجاهل' : 'Discard'}
            </button>
            <button
              type="button"
              onClick={onApply}
              className="inline-flex items-center gap-1 text-xs font-bold text-white bg-copper hover:bg-terracotta rounded px-3 py-1"
            >
              <Check size={12} />
              {isAr ? 'تطبيق' : 'Apply'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Build a list of compact field chips (e.g. ["steps (3)", "tools (2)",
 *  "output_structure"]) summarizing what the patch touches. Used on the
 *  proposal card so the user can see at a glance which fields would
 *  change. */
function describeChanges(changes: TemplateProposalChanges, isAr: boolean): string[] {
  const chips: string[] = [];
  const t = (en: string, ar: string): string => (isAr ? ar : en);
  if (changes.label_en !== undefined) chips.push(t('label_en', 'الاسم EN'));
  if (changes.label_ar !== undefined) chips.push(t('label_ar', 'الاسم AR'));
  if (changes.slug !== undefined) chips.push(t('slug', 'الرمز'));
  if (changes.description_en !== undefined) chips.push(t('description_en', 'الوصف EN'));
  if (changes.description_ar !== undefined) chips.push(t('description_ar', 'الوصف AR'));
  if (changes.icon !== undefined) chips.push(t('icon', 'الأيقونة'));
  if (Array.isArray(changes.tools)) {
    chips.push(t(`tools (${changes.tools.length})`, `أدوات (${changes.tools.length})`));
  }
  if (Array.isArray(changes.input_schema)) {
    chips.push(t(`inputs (${changes.input_schema.length})`, `مدخلات (${changes.input_schema.length})`));
  }
  if (Array.isArray(changes.steps)) {
    chips.push(t(`steps (${changes.steps.length})`, `خطوات (${changes.steps.length})`));
  }
  if (changes.output_structure !== undefined) chips.push(t('output_structure', 'هيكل الإخراج'));
  return chips;
}

/**
 * Renders assistant text with code-fence detection. Anything inside
 * triple-backtick fences becomes a copyable code block — kept around for
 * free-form text the assistant emits without using the patch tool.
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

  const segments = content.split(/```/g);
  return (
    <>
      {segments.map((seg, i) => {
        if (i % 2 === 0) {
          return seg ? <span key={i}>{seg}</span> : null;
        }
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
