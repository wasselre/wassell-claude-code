import { useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Sparkles, Plus, ImageIcon } from 'lucide-react';
import type { AppRecord } from '@/types';
import ChatThread from './components/ChatThread';
import { seedDefaultLibrariesIfEmpty } from './lib/seedDefaults';

/**
 * Image Chats — "mini Higgsfield" inside Wassell. Two-pane layout
 * mirrors the AiAgentPage:
 *   - Left: list of past conversations (records in `image_chats`).
 *   - Right: active thread (ChatThread) or an empty-state welcome.
 *
 * Routes `/model/image_chats` and `/model/image_chats/:recordId`
 * both land here via the dispatcher in App.tsx.
 *
 * Messages for each conversation live inline in `record.data.messages`.
 * The bottom-pinned composer in ChatThread fires
 * `POST /api/image-chat/send` per turn; the backend appends the
 * user + assistant messages to the record and we re-read from the
 * store on completion.
 */
export default function ImageChatsPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const imageChatsModel = useMemo(
    () => models.find((m) => m.name === 'image_chats'),
    [models],
  );

  // One-shot seed of "Wassel default" preset + starter prompt snippets
  // when the libraries are completely empty AND the models exist. The
  // ref prevents double-fires from rapid re-renders / Strict Mode while
  // the records list is being optimistically updated.
  const seedAttemptedRef = useRef(false);
  useEffect(() => {
    if (seedAttemptedRef.current) return;
    const presetsModel = models.find((m) => m.name === 'image_presets');
    const snippetsModel = models.find((m) => m.name === 'prompt_snippets');
    if (!presetsModel || !snippetsModel) return;
    seedAttemptedRef.current = true;
    void seedDefaultLibrariesIfEmpty({
      presetsModelId: presetsModel.id,
      snippetsModelId: snippetsModel.id,
      presetsCount: (recordsByModel[presetsModel.id] ?? []).length,
      snippetsCount: (recordsByModel[snippetsModel.id] ?? []).length,
      saveRecord,
      isAr,
    });
  }, [models, recordsByModel, saveRecord, isAr]);

  const chats = useMemo<AppRecord[]>(() => {
    if (!imageChatsModel) return [];
    const all = recordsByModel[imageChatsModel.id] ?? [];
    return [...all].sort((a, b) => {
      const aT = (a.data.last_message_at as string | undefined) ?? a.updated_at;
      const bT = (b.data.last_message_at as string | undefined) ?? b.updated_at;
      return (bT ?? '').localeCompare(aT ?? '');
    });
  }, [imageChatsModel, recordsByModel]);

  function startNewChat() {
    if (!imageChatsModel) return;
    const now = new Date().toISOString();
    const newId = uuid();
    const record: AppRecord = {
      id: newId,
      model_id: imageChatsModel.id,
      data: {
        title: isAr ? 'محادثة جديدة' : 'New design',
        status: 'idle',
        message_count: 0,
        messages: [],
        last_aspect_ratio: '1:1',
        last_preset_id: null,
        created_by: currentUserId,
      },
      created_at: now,
      updated_at: now,
    };
    saveRecord(record);
    navigate(`/model/image_chats/${newId}`);
  }

  if (!imageChatsModel) {
    return (
      <div className="p-8 text-center text-charcoal/70">
        {isAr
          ? 'نموذج محادثات التصميم غير مهيأ بعد. أعد تحميل الصفحة.'
          : 'Image Chats model not initialized. Please reload.'}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex overflow-hidden rounded-2xl border border-sand/20 bg-white">
      {/* Left pane — conversation list */}
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
              {isAr ? 'لا توجد محادثات بعد.' : 'No conversations yet.'}
            </div>
          ) : (
            chats.map((chat) => {
              const title =
                (chat.data.title as string | undefined) ??
                (isAr ? 'محادثة' : 'Conversation');
              const messageCount = Number(chat.data.message_count ?? 0);
              const status = chat.data.status as string | undefined;
              const active = chat.id === recordId;
              return (
                <button
                  key={chat.id}
                  onClick={() => navigate(`/model/image_chats/${chat.id}`)}
                  className={`w-full text-start p-3 border-b border-sand/10 hover:bg-cream transition-colors ${
                    active ? 'bg-cream' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <ImageIcon size={14} className="text-copper shrink-0" />
                    <div className="font-medium text-sm truncate flex-1">{title}</div>
                    {status === 'generating' && (
                      <span className="text-[10px] text-blue-600 font-medium animate-pulse">
                        {isAr ? '...' : '...'}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-charcoal/60 truncate mt-1 ps-6">
                    {messageCount > 0
                      ? isAr
                        ? `${messageCount} رسالة`
                        : `${messageCount} message${messageCount === 1 ? '' : 's'}`
                      : isAr
                        ? 'جديدة'
                        : 'New'}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right pane — active chat or welcome */}
      <div className={`flex-1 min-w-0 flex-col ${!recordId ? 'hidden md:flex' : 'flex'}`}>
        {recordId ? (
          <ChatThread
            key={recordId}
            recordId={recordId}
            modelId={imageChatsModel.id}
            onNewChat={startNewChat}
          />
        ) : (
          <EmptyPane isAr={isAr} onStart={startNewChat} />
        )}
      </div>
    </div>
  );
}

function EmptyPane({ isAr, onStart }: { isAr: boolean; onStart: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-copper/10 flex items-center justify-center mb-4">
        <Sparkles size={32} className="text-copper" />
      </div>
      <h2 className="text-xl font-semibold text-charcoal mb-2">
        {isAr ? 'محادثات التصميم' : 'Image Chats'}
      </h2>
      <p className="text-sm text-charcoal/70 max-w-md mb-6">
        {isAr
          ? 'صمم منشورات ولافتات وصور ترويجية عبر محادثة مع نموذج Nano Banana. اختر الإعداد التجاري، حدد المقاس، أرفق صورة، ثم اكتب ما تريد.'
          : 'Design posts, banners, and promo images through a chat with Nano Banana. Pick a brand preset, set the aspect ratio, attach an image, then describe what you want.'}
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
