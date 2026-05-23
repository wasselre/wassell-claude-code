import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Sparkles, Download } from 'lucide-react';
import ImagePreview from '@/components/ui/ImagePreview';
import type { StoredMessage, ChatAspectRatio } from '@/lib/imageChat/client';

interface Props {
  message: StoredMessage;
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
 *   - Assistant messages: 1-4 generated images at the saved
 *     aspect_ratio (CSS `aspect-ratio`), each clickable for full-size
 *     preview and download.
 */
export default function MessageBubble({ message }: Props) {
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

  // Assistant: show the generated image(s) at the saved aspect ratio.
  // Grid sizing: 1 → single big image; 2 → side-by-side; 3+ → 2×N grid.
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
              <a
                href={img.url}
                download={img.name ?? 'wassel-image.png'}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="absolute top-2 end-2 p-2 rounded-full bg-charcoal/70 text-white opacity-0 group-hover:opacity-100 hover:bg-charcoal transition-opacity"
                aria-label={isAr ? 'تنزيل' : 'Download'}
                title={isAr ? 'تنزيل' : 'Download'}
              >
                <Download size={14} />
              </a>
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
        <span>Nano Banana 2 • {aspect}</span>
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
