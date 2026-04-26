import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { ArrowRight, Sparkles, Send, Loader2, Database, FilePlus2, ExternalLink } from 'lucide-react';
import { streamWorkflowAgentTurn, type AgentApiMessage } from '@/lib/workflowAgent/client';
import type { Workflow, WorkflowGroup } from '@/types';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface CreatedWorkflowCard {
  workflow_id: string;
  name: string;
  is_active: boolean;
  branch_count: number;
  action_count: number;
}

// Standalone chat UI for the workflow-builder agent. Conversation state is
// in-memory per page visit — the goal is the workflow that gets created
// (which IS persisted), not the chat itself. Click "Open in editor" on a
// created workflow card to navigate into the canvas editor for fine-tuning.
export default function WorkflowAgentPage() {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const saveWorkflow = useAppStore((s) => s.saveWorkflow);
  const saveWorkflowGroup = useAppStore((s) => s.saveWorkflowGroup);
  const deleteWorkflowGroup = useAppStore((s) => s.deleteWorkflowGroup);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedWorkflowCard[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText, activeTool, created]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setInput('');
    setError(null);
    setStreamingText('');
    setActiveTool(null);
    setSending(true);

    const next: ChatMessage[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(next);

    const apiMessages: AgentApiMessage[] = next.map((m) => ({ role: m.role, content: m.content }));
    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = '';
    const newCards: CreatedWorkflowCard[] = [];

    try {
      await streamWorkflowAgentTurn(
        apiMessages,
        (event) => {
          if (event.type === 'text') {
            assistantText += event.delta;
            setStreamingText(assistantText);
          } else if (event.type === 'tool_use') {
            setActiveTool(event.name);
          } else if (event.type === 'tool_result') {
            setActiveTool(null);
            // Sync any tool result that returns a workflow row into our
            // local Zustand store so the editor page + workflow list pick
            // up the change without a round-trip reload.
            if (event.name === 'create_workflow') {
              try {
                const parsed = JSON.parse(event.result);
                if (parsed && parsed.ok && parsed.workflow_id) {
                  if (parsed.workflow) saveWorkflow(parsed.workflow as Workflow);
                  const card: CreatedWorkflowCard = {
                    workflow_id: parsed.workflow_id,
                    name: parsed.name,
                    is_active: !!parsed.is_active,
                    branch_count: parsed.branch_count ?? 1,
                    action_count: parsed.action_count ?? 0,
                  };
                  newCards.push(card);
                  setCreated((prev) => [...prev, card]);
                }
              } catch { /* ignore parse errors */ }
            } else if (event.name === 'set_workflow_active') {
              try {
                const parsed = JSON.parse(event.result);
                if (parsed && parsed.ok && parsed.workflow_id) {
                  if (parsed.workflow) saveWorkflow(parsed.workflow as Workflow);
                  // Update any matching create-card already in this thread
                  // so its inline indicator reflects the new state.
                  setCreated((prev) => prev.map((c) => c.workflow_id === parsed.workflow_id
                    ? { ...c, is_active: !!parsed.is_active }
                    : c,
                  ));
                }
              } catch { /* ignore parse errors */ }
            } else if (event.name === 'set_workflow_folder') {
              try {
                const parsed = JSON.parse(event.result);
                if (parsed && parsed.ok && parsed.workflow) {
                  saveWorkflow(parsed.workflow as Workflow);
                }
              } catch { /* ignore parse errors */ }
            } else if (event.name === 'create_workflow_folder' || event.name === 'rename_workflow_folder') {
              try {
                const parsed = JSON.parse(event.result);
                if (parsed && parsed.ok && parsed.folder) {
                  saveWorkflowGroup(parsed.folder as WorkflowGroup);
                }
              } catch { /* ignore parse errors */ }
            } else if (event.name === 'delete_workflow_folder') {
              try {
                const parsed = JSON.parse(event.result);
                if (parsed && parsed.ok && parsed.folder_id) {
                  deleteWorkflowGroup(parsed.folder_id as string);
                }
              } catch { /* ignore parse errors */ }
            }
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        controller.signal,
      );

      if (assistantText.trim()) {
        setMessages((prev) => [...prev, { role: 'assistant', content: assistantText }]);
      }
      // Suppress unused-warning when we didn't create any cards this turn.
      void newCards;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'The user aborted a request.') setError(msg);
    } finally {
      setStreamingText('');
      setActiveTool(null);
      setSending(false);
      abortRef.current = null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const examples = isAr
    ? [
        'لما يتم إنشاء عميل بحالة "ساخن" أرسل إشعار للفريق',
        'بعد ٣ أيام من إنشاء متابعة، أنشئ متابعة جديدة من نوع مكالمة',
        'إذا تم تحديث حالة المتابعة إلى "مغلق فاز"، حدّث حالة العميل إلى "تم الإغلاق"',
      ]
    : [
        'When a Client is created with status "hot", send a notification to the team',
        'Three days after a follow-up is created, create a new follow-up of type "call"',
        'When a follow-up status is updated to "closed-won", update the client status to "closed"',
      ];

  return (
    <div className="max-w-3xl mx-auto h-[calc(100vh-7rem)] flex flex-col">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => navigate('/workflow')}
          className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors shrink-0"
          aria-label={isAr ? 'رجوع' : 'Back'}
        >
          <ArrowRight size={18} className="rtl:rotate-0 ltr:rotate-180" />
        </button>
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-copper text-white flex items-center justify-center shrink-0">
          <Sparkles size={20} />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-bold text-chocolate leading-tight">
            {isAr ? 'مساعد بناء الأتمتة' : 'Workflow Builder'}
          </h1>
          <p className="text-xs text-charcoal/50">
            {isAr
              ? 'صف الأتمتة بلغة طبيعية وسأبنيها لك.'
              : 'Describe an automation in plain language and I\'ll build it for you.'}
          </p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto rounded-2xl border border-sand/40 bg-cream-light/40 p-4 space-y-3">
        {messages.length === 0 && !sending && (
          <div className="flex flex-col items-center justify-center text-center py-12 text-charcoal/50">
            <Sparkles size={36} className="text-copper mb-4" />
            <h2 className="text-base font-bold text-charcoal/80 mb-2">
              {isAr ? 'ابدأ بكتابة ما تحتاجه' : 'Start by describing what you need'}
            </h2>
            <p className="text-xs max-w-md mb-4">
              {isAr
                ? 'سأسأل أي توضيحات لازمة، ثم أنشئ القاعدة وأعطيك رابط لتعديلها.'
                : 'I\'ll ask any clarifying questions I need, then create the workflow and link you to it.'}
            </p>
            <div className="grid gap-2 w-full max-w-md">
              {examples.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => { setInput(ex); taRef.current?.focus(); }}
                  className="text-start text-xs px-4 py-2.5 rounded-xl bg-white border border-sand/40 hover:border-copper hover:bg-cream-light transition-colors text-charcoal/70"
                  dir={isAr ? 'rtl' : 'ltr'}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} isAr={isAr} />
        ))}

        {streamingText && <Bubble role="assistant" content={streamingText} isAr={isAr} typing />}

        {activeTool && (
          <div className="flex items-center gap-2 text-xs text-charcoal/60 ps-3" dir={isAr ? 'rtl' : 'ltr'}>
            <Loader2 size={12} className="animate-spin text-copper" />
            <span className="font-bold">
              {activeTool === 'get_app_context'
                ? (isAr ? 'يقرأ بنية التطبيق...' : 'Reading app context...')
                : activeTool === 'create_workflow'
                  ? (isAr ? 'ينشئ القاعدة...' : 'Creating workflow...')
                  : activeTool === 'set_workflow_active'
                    ? (isAr ? 'يحدّث حالة التفعيل...' : 'Updating activation...')
                    : activeTool === 'create_workflow_folder'
                      ? (isAr ? 'ينشئ مجلدًا...' : 'Creating folder...')
                      : activeTool === 'rename_workflow_folder'
                        ? (isAr ? 'يعيد تسمية المجلد...' : 'Renaming folder...')
                        : activeTool === 'delete_workflow_folder'
                          ? (isAr ? 'يحذف المجلد...' : 'Deleting folder...')
                          : activeTool === 'set_workflow_folder'
                            ? (isAr ? 'ينقل القاعدة إلى المجلد...' : 'Moving workflow to folder...')
                            : activeTool}
            </span>
          </div>
        )}

        {created.map((card) => (
          <CreatedWorkflowChip key={card.workflow_id} card={card} isAr={isAr} onOpen={() => navigate(`/workflow/${card.workflow_id}`)} />
        ))}

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">
            {error}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-end gap-2 rounded-2xl bg-white border border-sand/40 p-2 shadow-sm">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={isAr ? 'اكتب ما تحتاج أتمتته...' : 'Describe what you want to automate...'}
          className="flex-1 resize-none bg-transparent border-0 outline-none px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 max-h-32"
          dir={isAr ? 'rtl' : 'ltr'}
          disabled={sending}
        />
        <button
          onClick={() => void handleSend()}
          disabled={sending || !input.trim()}
          className="w-10 h-10 rounded-xl bg-copper text-white flex items-center justify-center hover:bg-copper-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          aria-label={isAr ? 'إرسال' : 'Send'}
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}

interface BubbleProps { role: 'user' | 'assistant'; content: string; isAr: boolean; typing?: boolean }
function Bubble({ role, content, isAr, typing }: BubbleProps) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-copper text-white px-4 py-2.5 text-sm whitespace-pre-wrap shadow-sm" dir={isAr ? 'rtl' : 'ltr'}>
          {content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start gap-2">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-400 to-copper text-white flex items-center justify-center shrink-0">
        <Sparkles size={14} />
      </div>
      <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-white border border-sand/40 text-charcoal px-4 py-2.5 text-sm whitespace-pre-wrap shadow-sm" dir={isAr ? 'rtl' : 'ltr'}>
        {content}
        {typing && <span className="ms-1 inline-block w-1.5 h-4 align-text-bottom bg-copper animate-pulse" />}
      </div>
    </div>
  );
}

interface CreatedChipProps { card: CreatedWorkflowCard; isAr: boolean; onOpen: () => void }
function CreatedWorkflowChip({ card, isAr, onOpen }: CreatedChipProps) {
  return (
    <div className="rounded-2xl bg-gradient-to-br from-emerald-50 via-white to-cream-light border-2 border-emerald-200 p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center shrink-0">
          <FilePlus2 size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold tracking-widest uppercase text-emerald-700">
            {isAr ? 'تم الإنشاء' : 'Created'}
          </div>
          <div className="font-bold text-charcoal truncate" dir={isAr ? 'rtl' : 'ltr'}>{card.name}</div>
          <div className="text-xs text-charcoal/50 mt-0.5 flex items-center gap-2">
            <Database size={10} />
            {isAr ? `${card.branch_count} فرع · ${card.action_count} إجراء` : `${card.branch_count} branch${card.branch_count === 1 ? '' : 'es'} · ${card.action_count} action${card.action_count === 1 ? '' : 's'}`}
            {!card.is_active && (
              <span className="ms-2 text-[10px] font-bold tracking-wider uppercase bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                {isAr ? 'غير مفعّل' : 'inactive'}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onOpen}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-copper text-white hover:bg-copper-hover transition-colors text-sm font-bold shrink-0"
        >
          {isAr ? 'فتح' : 'Open'}
          <ExternalLink size={14} />
        </button>
      </div>
    </div>
  );
}
