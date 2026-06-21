import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Compass, Plus, MessageSquare } from 'lucide-react';
import type { AppRecord } from '@/types';
import MatchingThread from './components/MatchingThread';

/**
 * Two-pane "Project Matching Assistant" layout. Left = list of past sessions
 * (records in the `matching_chats` model). Right = active thread or an
 * empty-state welcome card. Routes `/model/matching_chats` and
 * `/model/matching_chats/:recordId` both land here via the dispatcher in App.tsx.
 *
 * Same shape as the copywriter / AI sales agent pages — each session's messages
 * live inline in `record.data.messages`; the backend (api/match.ts) is stateless
 * and gets the full text history each turn.
 */
export default function MatchingPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const model = useMemo(() => models.find((m) => m.name === 'matching_chats'), [models]);
  const chats = useMemo<AppRecord[]>(() => {
    if (!model) return [];
    const all = recordsByModel[model.id] ?? [];
    return [...all].sort((a, b) => {
      const aT = (a.data.last_message_at as string | undefined) ?? a.updated_at;
      const bT = (b.data.last_message_at as string | undefined) ?? b.updated_at;
      return (bT ?? '').localeCompare(aT ?? '');
    });
  }, [model, recordsByModel]);

  function startNewChat() {
    if (!model) return;
    const now = new Date().toISOString();
    const newId = uuid();
    const record: AppRecord = {
      id: newId,
      model_id: model.id,
      data: {
        title: isAr ? 'محادثة جديدة' : 'New chat',
        status: 'active',
        message_count: 0,
        messages: [],
        created_by: currentUserId,
      },
      created_at: now,
      updated_at: now,
    };
    saveRecord(record);
    navigate(`/model/matching_chats/${newId}`);
  }

  if (!model) {
    return (
      <div className="p-8 text-center text-charcoal/70">
        {isAr
          ? 'مساعد المبيعات غير مهيأ بعد. أعد تحميل الصفحة.'
          : 'Sales Assistant model not initialized. Please reload.'}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex overflow-hidden rounded-2xl border border-sand/20 bg-white">
      {/* Left pane — list + new-chat button */}
      <div
        className={`w-full md:w-[320px] shrink-0 border-e border-sand/20 flex-col ${
          recordId ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="p-3 border-b border-sand/20 flex items-center gap-2">
          <button
            onClick={startNewChat}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            {isAr ? 'محادثة جديدة' : 'New chat'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {chats.length === 0 ? (
            <div className="p-6 text-center text-sm text-charcoal/60">
              {isAr ? 'لا توجد محادثات بعد.' : 'No sessions yet.'}
            </div>
          ) : (
            chats.map((chat) => {
              const title = (chat.data.title as string | undefined) ?? (isAr ? 'محادثة' : 'Session');
              const preview = lastMessagePreview(chat);
              const active = chat.id === recordId;
              return (
                <button
                  key={chat.id}
                  onClick={() => navigate(`/model/matching_chats/${chat.id}`)}
                  className={`w-full text-start p-3 border-b border-sand/10 hover:bg-cream transition-colors ${
                    active ? 'bg-cream' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <MessageSquare size={14} className="text-copper shrink-0" />
                    <div className="font-medium text-sm truncate">{title}</div>
                  </div>
                  {preview && (
                    <div className="text-xs text-charcoal/60 truncate mt-1 ps-6">{preview}</div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right pane — active session or welcome */}
      <div className={`flex-1 min-w-0 flex-col ${!recordId ? 'hidden md:flex' : 'flex'}`}>
        {recordId ? (
          <MatchingThread key={recordId} recordId={recordId} modelId={model.id} onNewChat={startNewChat} />
        ) : (
          <EmptyPane isAr={isAr} onStart={startNewChat} />
        )}
      </div>
    </div>
  );
}

function lastMessagePreview(chat: AppRecord): string | null {
  const messages = chat.data.messages as { content: string }[] | undefined;
  if (!messages || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last) return null;
  return last.content.slice(0, 80);
}

function EmptyPane({ isAr, onStart }: { isAr: boolean; onStart: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-copper/10 flex items-center justify-center mb-4">
        <Compass size={32} className="text-copper" />
      </div>
      <h2 className="text-xl font-semibold text-charcoal mb-2">
        {isAr ? 'مساعد المبيعات' : 'Sales Assistant'}
      </h2>
      <p className="text-sm text-charcoal/70 max-w-md mb-6">
        {isAr
          ? 'مساعد المبيعات يساعدك أثناء المكالمة: يرشّح لك أفضل المشاريع للعميل ويجهّز لك كلاماً بيعياً جاهزاً تقوله مباشرة. اكتب طلب العميل بلغة طبيعية (المدينة، الحي، نوع العقار، الميزانية، الغرف). يبحث في مشاريعنا أولاً ثم في «كل المشاريع» مع التنبيه للتحقق. (قريباً داخل نفس المساعد: اقتراح الخطوة التالية والمتابعة وصياغة الرسائل.)'
          : "Your live-call sales co-pilot: it finds the best-fit projects for the customer and gives you ready-to-say sales language. Type the customer's request in plain words (city, district, property type, budget, bedrooms). It searches our projects first, then All Projects (flagged for verification). Coming soon inside this same assistant: next-best-action, follow-ups, and message drafting."}
      </p>
      <button
        onClick={onStart}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors"
      >
        <Plus size={16} />
        {isAr ? 'محادثة جديدة' : 'New chat'}
      </button>
    </div>
  );
}
