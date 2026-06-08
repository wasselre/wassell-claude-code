import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Plus, Sparkles, ImageIcon } from 'lucide-react';
import type { AppRecord } from '@/types';
import {
  enqueueImageChatTurn,
  cancelImageJob,
  type ChatAspectRatio,
  type ChatModelId,
  type MessageImage,
  type StoredMessage,
} from '@/lib/imageChat/client';
import MessageBubble from './MessageBubble';
import Composer, { type ComposerSeed } from './Composer';
import { chatModelDisplayName } from './ModelDropdown';

interface Props {
  recordId: string;
  modelId: string;
  onNewChat: () => void;
}

/** Max generations a single conversation can have in flight at once. Beyond
 *  this the Send button is gated (with a hint) — bounds fal.ai spend and the
 *  worker's per-record write serialization while still feeling concurrent. */
const MAX_INFLIGHT = 3;

/**
 * Active Image Chats thread. Shows the message transcript above and a
 * sticky Higgsfield-style composer below. Image Chats v2: generation is
 * fully concurrent and non-blocking — each send enqueues a per-message job
 * (which renders its own placeholder/spinner via MessageBubble) and the
 * composer stays live so the user can keep sending. Results stream back in
 * place via Supabase Realtime on the record.
 */
export default function ChatThread({ recordId, modelId, onNewChat }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const recordsByModel = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  const record = useMemo<AppRecord | undefined>(() => {
    return (recordsByModel[modelId] ?? []).find((r) => r.id === recordId);
  }, [recordsByModel, modelId, recordId]);

  const storedMessages = useMemo<StoredMessage[]>(() => {
    const raw = record?.data.messages;
    return Array.isArray(raw) ? (raw as StoredMessage[]) : [];
  }, [record]);

  const lastAspect: ChatAspectRatio =
    (record?.data.last_aspect_ratio as ChatAspectRatio | undefined) ?? '1:1';
  const lastPresetId = (record?.data.last_preset_id as string | undefined | null) ?? null;
  const lastModelId = record?.data.last_model as string | undefined | null;
  const headerModelName = chatModelDisplayName(lastModelId, isAr);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-chain target: the most recent COMPLETED assistant image. A queued /
  // generating / failed placeholder is never used as the reference.
  const prevImageUrl = useMemo<string | null>(() => {
    for (let i = storedMessages.length - 1; i >= 0; i--) {
      const m = storedMessages[i]!;
      if (
        m.role === 'assistant' &&
        (m.status === undefined || m.status === 'completed') &&
        m.images.length > 0 &&
        m.images[0]
      ) {
        return m.images[0].url;
      }
    }
    return null;
  }, [storedMessages]);

  // How many generations are currently in flight for this conversation.
  const inFlightCount = useMemo(
    () =>
      storedMessages.filter(
        (m) => m.role === 'assistant' && (m.status === 'queued' || m.status === 'generating'),
      ).length,
    [storedMessages],
  );
  const atCapacity = inFlightCount >= MAX_INFLIGHT;

  // One-shot composer seed for "Create Variation" / "Use as Next Reference".
  const [seed, setSeed] = useState<ComposerSeed | null>(null);

  function handleRequestVariation(image: MessageImage) {
    setSeed({
      attachmentUrl: image.url,
      attachmentName: image.name,
      prompt: isAr
        ? 'أنشئ نسخة مختلفة من هذه الصورة مع الحفاظ على نفس التكوين والأسلوب.'
        : 'Create a variation of this image, keeping the same composition and style.',
    });
  }

  function handleUseAsReference(image: MessageImage) {
    setSeed({ attachmentUrl: image.url, attachmentName: image.name });
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [storedMessages.length]);

  async function handleSend(params: {
    prompt: string;
    attachmentUrls: string[];
    attachmentSources: Array<'user' | 'preset' | 'snippet'>;
    aspectRatio: ChatAspectRatio;
    numVariations: number;
    presetId: string | null;
    modelId: ChatModelId;
  }) {
    try {
      // Fire-and-forget: returns as soon as the job is queued. The placeholder
      // + final image arrive via Realtime — we never await generation, so the
      // composer is free immediately for the next turn.
      await enqueueImageChatTurn({
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
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  function handleRetry(failed: StoredMessage) {
    const idx = storedMessages.findIndex((m) => m.id === failed.id);
    let userMsg: StoredMessage | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      if (storedMessages[i]?.role === 'user') {
        userMsg = storedMessages[i];
        break;
      }
    }
    if (!userMsg) {
      addToast(isAr ? 'تعذر إعادة المحاولة' : 'Cannot retry — original prompt not found', 'error');
      return;
    }
    void handleSend({
      prompt: userMsg.text ?? '',
      attachmentUrls: userMsg.images.map((im) => im.url),
      attachmentSources: userMsg.images.map((im) =>
        im.source === 'preset' || im.source === 'snippet' ? im.source : 'user',
      ),
      aspectRatio: userMsg.aspect_ratio ?? '1:1',
      numVariations: userMsg.num_variations ?? 1,
      presetId: userMsg.preset_id ?? null,
      modelId: lastModelId === 'gpt-image-2' ? 'gpt-image-2' : 'nano-banana',
    });
  }

  function handleCancel(jobId: string) {
    void cancelImageJob(jobId).catch((err) => {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    });
  }

  if (!record) {
    return (
      <div className="flex-1 flex items-center justify-center text-charcoal/60">
        {isAr ? 'المحادثة غير موجودة' : 'Conversation not found'}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-3 border-b border-sand/20 flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-copper/10 flex items-center justify-center shrink-0">
          <ImageIcon size={16} className="text-copper" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">
            {(record.data.title as string | undefined) ?? (isAr ? 'محادثة' : 'Conversation')}
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
        {storedMessages.length === 0 && <WelcomeHint isAr={isAr} />}
        {storedMessages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            chatRecordId={recordId}
            onRetry={handleRetry}
            onCancel={handleCancel}
            onRequestVariation={handleRequestVariation}
            onUseAsReference={handleUseAsReference}
          />
        ))}
      </div>

      {/* Composer — never blocked by generation; only the Send action is gated
          when the conversation is at its in-flight cap. */}
      <Composer
        atCapacity={atCapacity}
        initialAspectRatio={lastAspect}
        initialPresetId={lastPresetId}
        seed={seed}
        onSeedConsumed={() => setSeed(null)}
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
