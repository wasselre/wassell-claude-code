import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { ArrowRight, Sparkles, Send, Loader2, Database, FilePlus2, ExternalLink, Wand2, Trash2 } from 'lucide-react';
import { streamBuilderAgentTurn, type AgentApiMessage } from '@/lib/builderAgent/client';
import type { AppModel, ModelGroup } from '@/types';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Cards that summarize tool effects in the chat. We track create vs.
// update so we can distinguish "Created" / "Updated" / "Deleted" labels.
type ChangeKind = 'created' | 'updated' | 'deleted';
interface ModelChangeCard {
  kind: ChangeKind;
  model_id: string;
  name: string;
  section_count: number;
  field_count: number;
}

// Standalone chat UI for the model-builder agent. Conversation state is
// in-memory per page visit — the goal is the model that gets created or
// edited (which IS persisted), not the chat itself. Click "Open in
// Builder" on a created/updated model card to navigate into the editor
// for fine-tuning.
export default function BuilderAgentPage() {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const saveModel = useAppStore((s) => s.saveModel);
  const deleteModel = useAppStore((s) => s.deleteModel);
  const saveGroup = useAppStore((s) => s.saveGroup);
  const deleteGroup = useAppStore((s) => s.deleteGroup);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [changes, setChanges] = useState<ModelChangeCard[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText, activeTool, changes]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function summarizeModel(model: AppModel): { section_count: number; field_count: number } {
    const sections = model.schema?.sections ?? [];
    return {
      section_count: sections.length,
      field_count: sections.reduce((sum, s) => sum + (s.fields ?? []).length, 0),
    };
  }

  function pushOrMergeChange(card: ModelChangeCard) {
    setChanges((prev) => {
      // If we already have a card for this model from this turn, merge
      // (an "updated" follow-up to a "created" stays "created").
      const existing = prev.find((c) => c.model_id === card.model_id);
      if (existing) {
        const merged: ModelChangeCard = {
          ...existing,
          ...card,
          kind: existing.kind === 'created' ? 'created' : card.kind,
        };
        return prev.map((c) => (c.model_id === card.model_id ? merged : c));
      }
      return [...prev, card];
    });
  }

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

    try {
      await streamBuilderAgentTurn(
        apiMessages,
        (event) => {
          if (event.type === 'text') {
            assistantText += event.delta;
            setStreamingText(assistantText);
          } else if (event.type === 'tool_use') {
            setActiveTool(event.name);
          } else if (event.type === 'tool_result') {
            setActiveTool(null);
            // Sync any tool result that returns a model row into our local
            // Zustand store so the Builder page + sidebar pick up the change
            // without a round-trip reload.
            try {
              const parsed = JSON.parse(event.result);
              if (!parsed || !parsed.ok) return;

              if (event.name === 'create_model') {
                const m = parsed.model as AppModel;
                if (m) {
                  saveModel(m);
                  pushOrMergeChange({
                    kind: 'created',
                    model_id: m.id,
                    name: isAr ? m.label_ar : m.label_en,
                    ...summarizeModel(m),
                  });
                }
              } else if (
                event.name === 'update_model_metadata'
                || event.name === 'add_section'
                || event.name === 'update_section'
                || event.name === 'delete_section'
                || event.name === 'add_field'
                || event.name === 'update_field'
                || event.name === 'delete_field'
                || event.name === 'set_model_group'
              ) {
                const m = parsed.model as AppModel | undefined;
                if (m) {
                  saveModel(m);
                  pushOrMergeChange({
                    kind: 'updated',
                    model_id: m.id,
                    name: isAr ? m.label_ar : m.label_en,
                    ...summarizeModel(m),
                  });
                }
              } else if (event.name === 'delete_model') {
                if (parsed.deleted_model_id) {
                  deleteModel(parsed.deleted_model_id as string);
                  pushOrMergeChange({
                    kind: 'deleted',
                    model_id: parsed.deleted_model_id as string,
                    name: parsed.name as string,
                    section_count: 0,
                    field_count: 0,
                  });
                }
              } else if (event.name === 'create_model_group' || event.name === 'rename_model_group') {
                if (parsed.group) saveGroup(parsed.group as ModelGroup);
              } else if (event.name === 'delete_model_group') {
                if (parsed.group_id) deleteGroup(parsed.group_id as string);
              }
            } catch { /* ignore parse errors */ }
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        controller.signal,
      );

      if (assistantText.trim()) {
        setMessages((prev) => [...prev, { role: 'assistant', content: assistantText }]);
      }
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
        'أنشئ نموذجًا للعقارات بأقسام: معلومات عامة، الموقع، السعر، الصور، الحالة',
        'أضف حقل رقم جوال إلى نموذج العملاء، مطلوب وعرضه في الجدول',
        'أنشئ مجلدًا اسمه "المبيعات" وانقل نموذج الفرص إليه',
      ]
    : [
        'Create a Properties model with sections: General Info, Location, Price, Photos, Status',
        'Add a phone field to the Clients model, required and shown in the table',
        'Create a folder called "Sales" and move the Opportunities model into it',
      ];

  // Map tool names → bilingual progress labels. Keeps the UI scannable
  // while the agent runs multi-step builds.
  const toolLabel = (name: string): string => {
    const labels: Record<string, [string, string]> = {
      get_app_context: ['يقرأ بنية التطبيق...', 'Reading app context...'],
      create_model: ['ينشئ النموذج...', 'Creating model...'],
      update_model_metadata: ['يحدّث معلومات النموذج...', 'Updating model metadata...'],
      delete_model: ['يحذف النموذج...', 'Deleting model...'],
      add_section: ['يضيف قسمًا...', 'Adding section...'],
      update_section: ['يحدّث القسم...', 'Updating section...'],
      delete_section: ['يحذف القسم...', 'Deleting section...'],
      add_field: ['يضيف حقلًا...', 'Adding field...'],
      update_field: ['يحدّث الحقل...', 'Updating field...'],
      delete_field: ['يحذف الحقل...', 'Deleting field...'],
      create_model_group: ['ينشئ مجلدًا...', 'Creating folder...'],
      rename_model_group: ['يعيد تسمية المجلد...', 'Renaming folder...'],
      delete_model_group: ['يحذف المجلد...', 'Deleting folder...'],
      set_model_group: ['ينقل النموذج إلى المجلد...', 'Moving model to folder...'],
    };
    const pair = labels[name];
    if (!pair) return name;
    return isAr ? pair[0] : pair[1];
  };

  return (
    <div className="max-w-3xl mx-auto h-[calc(100vh-7rem)] flex flex-col">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => navigate('/builder')}
          className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors shrink-0"
          aria-label={isAr ? 'رجوع' : 'Back'}
        >
          <ArrowRight size={18} className="rtl:rotate-0 ltr:rotate-180" />
        </button>
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-copper text-white flex items-center justify-center shrink-0">
          <Wand2 size={20} />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-bold text-chocolate leading-tight">
            {isAr ? 'مساعد بناء النماذج' : 'Model Builder'}
          </h1>
          <p className="text-xs text-charcoal/50">
            {isAr
              ? 'صف النماذج والحقول التي تحتاجها وسأبنيها لك.'
              : 'Describe the models and fields you need and I\'ll build them for you.'}
          </p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto rounded-2xl border border-sand/40 bg-cream-light/40 p-4 space-y-3">
        {messages.length === 0 && !sending && (
          <div className="flex flex-col items-center justify-center text-center py-12 text-charcoal/50">
            <Sparkles size={36} className="text-copper mb-4" />
            <h2 className="text-base font-bold text-charcoal/80 mb-2">
              {isAr ? 'ابدأ بكتابة ما تريد بناءه' : 'Start by describing what you want to build'}
            </h2>
            <p className="text-xs max-w-md mb-4">
              {isAr
                ? 'يمكنني إنشاء نماذج جديدة، إضافة أو تعديل حقول، تنظيمها في مجلدات، وأكثر.'
                : 'I can create new models, add or edit fields, organize them into folders, and more.'}
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
            <span className="font-bold">{toolLabel(activeTool)}</span>
          </div>
        )}

        {changes.map((card) => (
          <ChangeChip
            key={card.model_id}
            card={card}
            isAr={isAr}
            onOpen={() => navigate(`/builder/${card.model_id}`)}
          />
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
          placeholder={isAr ? 'صف النموذج أو التعديل الذي تريده...' : 'Describe the model or change you want...'}
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
        <Wand2 size={14} />
      </div>
      <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-white border border-sand/40 text-charcoal px-4 py-2.5 text-sm whitespace-pre-wrap shadow-sm" dir={isAr ? 'rtl' : 'ltr'}>
        {content}
        {typing && <span className="ms-1 inline-block w-1.5 h-4 align-text-bottom bg-copper animate-pulse" />}
      </div>
    </div>
  );
}

interface ChangeChipProps { card: ModelChangeCard; isAr: boolean; onOpen: () => void }
function ChangeChip({ card, isAr, onOpen }: ChangeChipProps) {
  const isDeleted = card.kind === 'deleted';
  const labelTuple: Record<ChangeKind, [string, string]> = {
    created: ['تم الإنشاء', 'Created'],
    updated: ['تم التحديث', 'Updated'],
    deleted: ['تم الحذف', 'Deleted'],
  };
  const [labelAr, labelEn] = labelTuple[card.kind];
  const accent = isDeleted ? 'red' : card.kind === 'created' ? 'emerald' : 'sky';
  const accentClass = {
    emerald: 'from-emerald-50 border-emerald-200 text-emerald-700',
    sky: 'from-sky-50 border-sky-200 text-sky-700',
    red: 'from-red-50 border-red-200 text-red-700',
  }[accent];
  const iconBg = {
    emerald: 'bg-emerald-500',
    sky: 'bg-sky-500',
    red: 'bg-red-500',
  }[accent];
  const Icon = isDeleted ? Trash2 : FilePlus2;

  return (
    <div className={`rounded-2xl bg-gradient-to-br via-white to-cream-light border-2 ${accentClass} p-4 shadow-sm`}>
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl ${iconBg} text-white flex items-center justify-center shrink-0`}>
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold tracking-widest uppercase">
            {isAr ? labelAr : labelEn}
          </div>
          <div className="font-bold text-charcoal truncate" dir={isAr ? 'rtl' : 'ltr'}>{card.name}</div>
          {!isDeleted && (
            <div className="text-xs text-charcoal/50 mt-0.5 flex items-center gap-2">
              <Database size={10} />
              {isAr
                ? `${card.section_count} قسم · ${card.field_count} حقل`
                : `${card.section_count} section${card.section_count === 1 ? '' : 's'} · ${card.field_count} field${card.field_count === 1 ? '' : 's'}`}
            </div>
          )}
        </div>
        {!isDeleted && (
          <button
            onClick={onOpen}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-copper text-white hover:bg-copper-hover transition-colors text-sm font-bold shrink-0"
          >
            {isAr ? 'فتح في المنشئ' : 'Open in Builder'}
            <ExternalLink size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
