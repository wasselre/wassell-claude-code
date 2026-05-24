import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Plus, Sparkles, ImageIcon } from 'lucide-react';
import type { AppRecord } from '@/types';
import {
  sendImageChatTurn,
  type ChatAspectRatio,
  type ChatModelId,
  type StoredMessage,
} from '@/lib/imageChat/client';
import MessageBubble from './MessageBubble';
import Composer from './Composer';
import { chatModelDisplayName } from './ModelDropdown';

interface Props {
  recordId: string;
  modelId: string;
  onNewChat: () => void;
}

/**
 * Active Image Chats thread. Shows the message transcript above and a
 * sticky Higgsfield-style composer below. The composer is the source
 * of truth for the per-turn controls (aspect ratio, variations, brand
 * preset, attachments); on send it calls the API and re-reads the
 * persisted record state via the store.
 */
export default function ChatThread({ recordId, modelId, onNewChat }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const recordsByModel = useAppStore((s) => s.records);

  const record = useMemo<AppRecord | undefined>(() => {
    return (recordsByModel[modelId] ?? []).find((r) => r.id === recordId);
  }, [recordsByModel, modelId, recordId]);

  const storedMessages = useMemo<StoredMessage[]>(() => {
    const raw = record?.data.messages;
    return Array.isArray(raw) ? (raw as StoredMessage[]) : [];
  }, [record]);

  const lastAspect: ChatAspectRatio =
    (record?.data.last_aspect_ratio as ChatAspectRatio | undefined) ?? '1:1';
  const lastPresetId =
    (record?.data.last_preset_id as string | undefined | null) ?? null;
  const lastModelId = record?.data.last_model as string | undefined | null;
  const recordStatus = (record?.data.status as string | undefined) ?? 'idle';
  const recordError = (record?.data.error_message as string | undefined) ?? null;
  const headerModelName = chatModelDisplayName(lastModelId, isAr);

  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-chain target: the last assistant message's primary image. Null
  // when the conversation is empty or the previous turn failed.
  const prevImageUrl = useMemo<string | null>(() => {
    for (let i = storedMessages.length - 1; i >= 0; i--) {
      const m = storedMessages[i]!;
      if (m.role === 'assistant' && m.images.length > 0 && m.images[0]) {
        return m.images[0].url;
      }
    }
    return null;
  }, [storedMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [storedMessages.length, sending]);

  async function handleSend(params: {
    prompt: string;
    attachmentUrls: string[];
    attachmentSources: Array<'user' | 'preset' | 'snippet'>;
    aspectRatio: ChatAspectRatio;
    numVariations: number;
    presetId: string | null;
    modelId: ChatModelId;
  }) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await sendImageChatTurn({
        recordId,
        prompt: params.prompt,
        attachmentUrls: params.attachmentUrls,
        attachmentSources: params.attachmentSources,
        aspectRatio: params.aspectRatio,
        numVariations: params.numVariations,
        presetId: params.presetId,
        modelId: params.modelId,
        prevImageUrl,
      });
      // Realtime fan-out (records publication, see schema.sql) pushes
      // the appended messages + status updates from the server back
      // into the store automatically — no explicit refresh needed.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSending(false);
    }
  }

  if (!record) {
    return (
      <div className="flex-1 flex items-center justify-center text-charcoal/60">
        {isAr ? 'المحادثة غير موجودة' : 'Conversation not found'}
      </div>
    );
  }

  const isGenerating = sending || recordStatus === 'generating';
  const surfaceError = error ?? (recordStatus === 'failed' ? recordError : null);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-3 border-b border-sand/20 flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-copper/10 flex items-center justify-center shrink-0">
          <ImageIcon size={16} className="text-copper" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">
            {(record.data.title as string | undefined) ??
              (isAr ? 'محادثة' : 'Conversation')}
          </div>
          <div className="text-xs text-charcoal/60">
            {isAr ? `${headerModelName} • وصل العقارية` : `${headerModelName} • Wassel`}
          </div>
        </div>
        <button
          onClick={onNewChat}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-xs font-medium shrink-0"
          title={isAr ? 'محادثة جديدة' : 'New chat'}
        >
          <Plus size={14} />
          <span className="hidden sm:inline">{isAr ? 'جديدة' : 'New'}</span>
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {storedMessages.length === 0 && !isGenerating && (
          <WelcomeHint isAr={isAr} />
        )}
        {storedMessages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {isGenerating && (
          <div className="flex items-center gap-2 text-sm text-charcoal/60 italic ps-2">
            <Sparkles size={14} className="text-copper animate-pulse" />
            <span>
              {isAr
                ? lastModelId === 'gpt-image-2'
                  ? `${headerModelName} يفكر... قد تستغرق العملية حتى خمس دقائق.`
                  : `${headerModelName} يفكر... قد تستغرق العملية حتى دقيقتين.`
                : lastModelId === 'gpt-image-2'
                  ? `${headerModelName} is thinking… this can take up to five minutes.`
                  : `${headerModelName} is thinking… this can take up to two minutes.`}
            </span>
          </div>
        )}
        {surfaceError && (
          <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm p-3 whitespace-pre-wrap">
            {surfaceError}
          </div>
        )}
      </div>

      {/* Composer */}
      <Composer
        disabled={isGenerating}
        initialAspectRatio={lastAspect}
        initialPresetId={lastPresetId}
        onSend={handleSend}
      />
    </div>
  );
}

function WelcomeHint({ isAr }: { isAr: boolean }) {
  return (
    <div className="text-center p-6 text-sm text-charcoal/60">
      <Sparkles size={24} className="mx-auto mb-2 text-copper" />
      <div>
        {isAr
          ? 'مثال: "اصنع منشور إنستغرام لمشروع مقام ١٧ بخلفية رملية ولوغو في الأسفل."'
          : 'Try: "Create an Instagram post for Maqam 17 with a sandy background and the logo at the bottom."'}
      </div>
    </div>
  );
}
