import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Sparkles, Loader2, Clock, RefreshCw, X } from 'lucide-react';
import ImagePreview from '@/components/ui/ImagePreview';
import AssetActionsMenu from './AssetActionsMenu';
import type { StoredMessage, MessageImage, ChatAspectRatio } from '@/lib/imageChat/client';

interface Props {
  message: StoredMessage;
  /** The image_chats conversation record id — enables the per-image actions menu. */
  chatRecordId?: string;
  /** Re-enqueue the turn that produced a failed/cancelled message. */
  onRetry?: (message: StoredMessage) => void;
  /** Cancel a queued/generating job by its generation_jobs id. */
  onCancel?: (jobId: string) => void;
  /** Pin an image as a reference + seed a variation prompt in the composer. */
  onRequestVariation?: (image: MessageImage) => void;
  /** Pin an image as the reference for the next composed turn. */
  onUseAsReference?: (image: MessageImage) => void;
}

const ASPECT_RATIO_CSS: Record<ChatAspectRatio, string> = {
  '1:1': '1 / 1',
  '9:16': '9 / 16',
  '16:9': '16 / 9',
  '4:3': '4 / 3',
  '3:4': '3 / 4',
};

/**
 * Single message in an Image Chats thread.
 *
 *   - User messages: text bubble (if any) + an attachment row of
 *     thumbnails. Auto-attached preset/snippet images get a ✦ badge.
 *   - Assistant messages: driven by the message's OWN `status`
 *     (Image Chats v2 — per-message generation jobs):
 *       queued/generating → a placeholder card (spinner + Cancel) at the
 *         saved aspect ratio, so the thread doesn't pop when it fills.
 *       completed (or legacy, status undefined) → the 1-4 image grid,
 *         each clickable for full-size preview + download.
 *       failed → a red error box + Retry.
 *       cancelled → a muted card + Retry.
 */
export default function MessageBubble({
  message,
  chatRecordId,
  onRetry,
  onCancel,
  onRequestVariation,
  onUseAsReference,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const isUser = message.role === 'user';
  const aspect: ChatAspectRatio = message.aspect_ratio ?? '1:1';
  const aspectCss = ASPECT_RATIO_CSS[aspect];

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-2">
        {message.text && (
          <div className="max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap shadow-sm bg-copper text-white border border-primary">
            {message.text}
          </div>
        )}
        {message.images.length > 0 && (
          <div className="flex flex-wrap gap-2 max-w-[80%] justify-end">
            {message.images.map((img, idx) => (
              <div
                key={`${img.url}-${idx}`}
                className="relative rounded-lg overflow-hidden border border-sand/40 w-20 h-20 bg-cream/40"
              >
                <button
                  type="button"
                  onClick={() => setPreviewUrl(img.url)}
                  className="absolute inset-0 cursor-zoom-in"
                  aria-label={isAr ? 'فتح' : 'Open'}
                >
                  <img src={img.url} alt="" className="w-full h-full object-cover" />
                </button>
                {(img.source === 'preset' || img.source === 'snippet') && (
                  <span className="absolute top-0.5 start-0.5 text-[9px] font-bold bg-copper text-white rounded px-1 py-px shadow-sm">
                    ✦ {img.source === 'preset' ? (isAr ? 'إعداد' : 'preset') : (isAr ? 'تعليمة' : 'snippet')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {message.preset_name && (
          <div className="text-[10px] text-charcoal/50 italic">
            {isAr ? `بالإعداد: ${message.preset_name}` : `with preset: ${message.preset_name}`}
          </div>
        )}
        {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
      </div>
    );
  }

  // ── Assistant — drive the view from the per-message status ──────────
  const status = message.status;
  const isPending = status === 'queued' || status === 'generating';
  const isFailed = status === 'failed';
  const isCancelled = status === 'cancelled';

  if (isPending) {
    const queued = status === 'queued';
    return (
      <div className="flex flex-col items-start gap-2">
        <div className="relative max-w-[280px] w-full">
          <div
            className="rounded-2xl overflow-hidden border border-sand/30 bg-cream/40 animate-pulse"
            style={{ aspectRatio: aspectCss }}
          >
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-charcoal/60">
              {queued ? (
                <Clock size={20} className="text-copper" />
              ) : (
                <Loader2 size={20} className="text-copper animate-spin" />
              )}
              <span className="text-xs">
                {queued
                  ? isAr
                    ? 'في الانتظار…'
                    : 'Queued…'
                  : isAr
                    ? 'يتم الإنشاء…'
                    : 'Generating…'}
              </span>
            </div>
          </div>
          {message.job_id && onCancel && (
            <button
              type="button"
              onClick={() => onCancel(message.job_id!)}
              className="absolute top-2 end-2 p-1.5 rounded-full bg-charcoal/70 text-white hover:bg-charcoal transition-colors"
              aria-label={isAr ? 'إلغاء' : 'Cancel'}
              title={isAr ? 'إلغاء' : 'Cancel'}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-charcoal/50 italic">
          <Sparkles size={10} className="text-copper" />
          <span dir="ltr">{aspect}</span>
          {(message.num_variations ?? 1) > 1 && <span>• ×{message.num_variations}</span>}
        </div>
      </div>
    );
  }

  if (isFailed) {
    return (
      <div className="flex flex-col items-start gap-2 max-w-[80%]">
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm p-3 whitespace-pre-wrap w-full">
          {message.error || (isAr ? 'فشل إنشاء الصورة' : 'Image generation failed')}
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={() => onRetry(message)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand/40 bg-white hover:bg-cream text-charcoal/80 transition-colors text-xs font-medium"
          >
            <RefreshCw size={12} />
            <span>{isAr ? 'إعادة المحاولة' : 'Retry'}</span>
          </button>
        )}
      </div>
    );
  }

  if (isCancelled) {
    return (
      <div className="flex flex-col items-start gap-2 max-w-[80%]">
        <div className="rounded-2xl border border-sand/30 bg-cream text-charcoal/50 text-sm px-4 py-2 italic">
          {isAr ? 'تم الإلغاء' : 'Cancelled'}
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={() => onRetry(message)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand/40 bg-white hover:bg-cream text-charcoal/80 transition-colors text-xs font-medium"
          >
            <RefreshCw size={12} />
            <span>{isAr ? 'إعادة المحاولة' : 'Retry'}</span>
          </button>
        )}
      </div>
    );
  }

  // ── completed (or legacy: status undefined) — the image grid ────────
  const count = message.images.length;
  const gridCols = count <= 1 ? 'grid-cols-1' : 'grid-cols-2';

  return (
    <div className="flex flex-col items-start gap-2">
      {count === 0 ? (
        <div className="max-w-[80%] rounded-2xl px-4 py-2 text-sm bg-cream text-charcoal border border-sand/30 italic">
          {isAr ? '(لا توجد نتيجة)' : '(no result)'}
        </div>
      ) : (
        <div className={`grid ${gridCols} gap-2 max-w-[80%] w-full`}>
          {message.images.map((img, idx) => (
            <div
              key={`${img.url}-${idx}`}
              className="relative rounded-2xl overflow-hidden border border-sand/30 bg-cream/40 group"
              style={{ aspectRatio: aspectCss }}
            >
              <button
                type="button"
                onClick={() => setPreviewUrl(img.url)}
                className="absolute inset-0 cursor-zoom-in"
                aria-label={isAr ? 'فتح بحجم كامل' : 'Open full-size'}
              >
                <img src={img.url} alt="" className="w-full h-full object-cover" loading="lazy" />
              </button>
              {chatRecordId && onRequestVariation && onUseAsReference && (
                <AssetActionsMenu
                  image={img}
                  imageIndex={idx}
                  messageId={message.id}
                  chatRecordId={chatRecordId}
                  onPreview={(url) => setPreviewUrl(url)}
                  onRequestVariation={onRequestVariation}
                  onUseAsReference={onUseAsReference}
                />
              )}
              {count > 1 && (
                <span className="absolute bottom-2 start-2 text-[10px] font-bold bg-charcoal/70 text-white rounded px-1.5 py-0.5">
                  #{idx + 1}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-[10px] text-charcoal/50 italic">
        <Sparkles size={10} className="text-copper" />
        <span dir="ltr">{aspect}</span>
        {message.preset_name && (
          <>
            <span>•</span>
            <span>{isAr ? `إعداد: ${message.preset_name}` : `preset: ${message.preset_name}`}</span>
          </>
        )}
      </div>
      {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </div>
  );
}
