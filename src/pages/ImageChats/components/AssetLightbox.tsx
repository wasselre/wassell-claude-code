import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/stores/appStore';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Generation } from '@/lib/imageChat/client';
import type { OutputItem } from '../lib/generations';
import AssetActions from './AssetActions';

interface Props {
  /** All outputs of the generation (for prev/next + filmstrip navigation). */
  outputs: OutputItem[];
  /** Index of the output currently shown. */
  index: number;
  generation: Generation;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  onCreateVariation: () => void;
  onUseAsReference: () => void;
  onRegenerate: () => void;
}

/**
 * Full-screen viewer for a single output asset (Image Chats v3). Opened by
 * clicking an image in the canvas (or the right panel preview). Shows the image
 * at full size with prev/next navigation across the generation's outputs, a
 * thumbnail filmstrip, and a docked panel carrying the same provenance + actions
 * as SelectedAssetPanel (via the shared AssetActions). Esc / backdrop / × close;
 * ← → navigate. Sits at z-40 so the action modals (z-50/z-[60]) and toasts
 * (z-50) layer above it.
 */
export default function AssetLightbox({
  outputs,
  index,
  generation,
  onIndexChange,
  onClose,
  onCreateVariation,
  onUseAsReference,
  onRegenerate,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const count = outputs.length;
  const output = outputs[index];
  const hasPrev = index > 0;
  const hasNext = index < count - 1;

  // Physical-arrow navigation (dir-independent): ← = previous index, → = next.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1);
      else if (e.key === 'ArrowRight' && index < count - 1) onIndexChange(index + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, onClose, onIndexChange]);

  if (!output) return null;

  const asset = output.asset;
  const prompt = asset?.prompt ?? generation.prompt;
  const model = asset?.model_id ?? generation.model_id;
  const aspect = generation.aspect_ratio;
  const created = asset?.created_at ?? generation.created_at;

  return createPortal(
    <div className="fixed inset-0 z-40 flex bg-charcoal/90 backdrop-blur-sm" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Image stage — click the empty area to close. */}
      <div
        className="relative flex-1 min-w-0 flex items-center justify-center p-4 md:p-10"
        onClick={onClose}
      >
        {/* Counter (top-left, physical) */}
        {count > 1 && (
          <div className="absolute top-4 left-4 z-10 px-2.5 py-1 rounded-full bg-white/10 text-white text-xs font-medium" dir="ltr">
            {index + 1} / {count}
          </div>
        )}

        {/* Close (top-right, physical) */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          aria-label={isAr ? 'إغلاق' : 'Close'}
        >
          <X size={20} />
        </button>

        {/* The image — stop propagation so clicking it doesn't close. */}
        <img
          src={output.url}
          alt=""
          className="max-h-[84vh] max-w-full object-contain rounded-lg shadow-2xl select-none"
          onClick={(e) => e.stopPropagation()}
        />

        {/* Prev / next (physical left/right edges) */}
        {count > 1 && (
          <>
            <NavBtn
              side="left"
              disabled={!hasPrev}
              label={isAr ? 'السابق' : 'Previous'}
              onClick={(e) => {
                e.stopPropagation();
                if (hasPrev) onIndexChange(index - 1);
              }}
            />
            <NavBtn
              side="right"
              disabled={!hasNext}
              label={isAr ? 'التالي' : 'Next'}
              onClick={(e) => {
                e.stopPropagation();
                if (hasNext) onIndexChange(index + 1);
              }}
            />
          </>
        )}

        {/* Thumbnail filmstrip (forced LTR so #1…#N read in chevron order) */}
        {count > 1 && (
          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-2 py-2 rounded-xl bg-charcoal/50 max-w-[90%] overflow-x-auto"
            dir="ltr"
            onClick={(e) => e.stopPropagation()}
          >
            {outputs.map((o, i) => (
              <button
                key={o.url + i}
                type="button"
                onClick={() => onIndexChange(i)}
                className={`w-12 h-12 shrink-0 rounded-md overflow-hidden border-2 transition-all ${
                  i === index ? 'border-copper' : 'border-white/20 hover:border-white/60'
                }`}
                aria-label={`#${i + 1}`}
              >
                <img src={o.url} alt="" className="w-full h-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Docked details + actions (shared with the right rail). */}
      <div className="w-[300px] shrink-0 bg-white flex flex-col overflow-y-auto border-s border-sand/20">
        <div className="p-3 border-b border-sand/20 text-sm font-semibold text-charcoal">
          {isAr ? 'تفاصيل الأصل' : 'Asset details'}
        </div>
        <div className="p-3 space-y-4">
          {/* Provenance */}
          <div className="space-y-2 text-xs">
            <Meta label={isAr ? 'الوصف' : 'Prompt'} value={prompt || '—'} />
            <div className="flex gap-3">
              <Meta label={isAr ? 'النموذج' : 'Model'} value={model} />
              <Meta label={isAr ? 'المقاس' : 'Aspect'} value={aspect} ltr />
            </div>
            <Meta label={isAr ? 'وقت الإنشاء' : 'Created'} value={formatTime(created, isAr)} />
          </div>

          {/* Actions */}
          <AssetActions
            output={output}
            onCreateVariation={onCreateVariation}
            onUseAsReference={onUseAsReference}
            onRegenerate={onRegenerate}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NavBtn({
  side,
  disabled,
  label,
  onClick,
}: {
  side: 'left' | 'right';
  disabled: boolean;
  label: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`absolute top-1/2 -translate-y-1/2 ${
        side === 'left' ? 'left-2 md:left-4' : 'right-2 md:right-4'
      } z-10 p-2.5 rounded-full bg-white/10 text-white transition-colors ${
        disabled ? 'opacity-30 cursor-default' : 'hover:bg-white/25'
      }`}
    >
      {side === 'left' ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
  );
}

function Meta({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-charcoal/50">{label}</div>
      <div className="text-charcoal/90 break-words whitespace-pre-wrap" dir={ltr ? 'ltr' : undefined}>
        {value}
      </div>
    </div>
  );
}

function formatTime(iso: string, isAr: boolean): string {
  try {
    return new Date(iso).toLocaleString(isAr ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
