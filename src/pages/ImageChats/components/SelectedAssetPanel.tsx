import { useAppStore } from '@/stores/appStore';
import { X, Maximize2 } from 'lucide-react';
import type { Generation } from '@/lib/imageChat/client';
import type { OutputItem } from '../lib/generations';
import AssetActions from './AssetActions';

interface Props {
  output: OutputItem;
  generation: Generation;
  onClose: () => void;
  /** Open the full-screen lightbox for this output. */
  onExpand: () => void;
  onCreateVariation: () => void;
  onUseAsReference: () => void;
  onRegenerate: () => void;
}

/**
 * Right-sidebar panel for the selected output asset (Image Chats v3). Shows a
 * preview (click → full-screen lightbox) + provenance (prompt / model / settings
 * / time, from the media_asset when first-class, else from the parent
 * generation) + the asset actions (shared with the lightbox via AssetActions).
 */
export default function SelectedAssetPanel({
  output,
  generation,
  onClose,
  onExpand,
  onCreateVariation,
  onUseAsReference,
  onRegenerate,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');

  const asset = output.asset;
  const prompt = asset?.prompt ?? generation.prompt;
  const model = asset?.model_id ?? generation.model_id;
  const aspect = generation.aspect_ratio;
  const created = asset?.created_at ?? generation.created_at;

  return (
    <div className="w-[300px] shrink-0 border-s border-sand/20 flex flex-col bg-white" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="p-3 border-b border-sand/20 flex items-center gap-2">
        <div className="flex-1 text-sm font-semibold text-charcoal">
          {isAr ? 'الأصل المحدد' : 'Selected asset'}
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-cream text-charcoal/70" aria-label={isAr ? 'إغلاق' : 'Close'}>
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Preview — click to open the full-screen view. */}
        <button
          type="button"
          onClick={onExpand}
          className="group relative w-full rounded-xl overflow-hidden border border-sand/30 bg-cream/40 block"
          title={isAr ? 'عرض كامل' : 'Full view'}
        >
          <img src={output.url} alt="" className="w-full h-auto object-contain" />
          <div className="absolute inset-0 flex items-center justify-center bg-charcoal/0 group-hover:bg-charcoal/30 transition-colors">
            <span className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/90 text-charcoal text-xs font-medium shadow">
              <Maximize2 size={13} />
              {isAr ? 'عرض كامل' : 'Full view'}
            </span>
          </div>
        </button>

        {/* Provenance */}
        <div className="space-y-2 text-xs">
          <Meta label={isAr ? 'الوصف' : 'Prompt'} value={prompt || '—'} />
          <div className="flex gap-3">
            <Meta label={isAr ? 'النموذج' : 'Model'} value={model} />
            <Meta label={isAr ? 'المقاس' : 'Aspect'} value={aspect} ltr />
          </div>
          <Meta label={isAr ? 'وقت الإنشاء' : 'Created'} value={formatTime(created, isAr)} />
        </div>

        {/* Actions (shared with the lightbox) */}
        <AssetActions
          output={output}
          onCreateVariation={onCreateVariation}
          onUseAsReference={onUseAsReference}
          onRegenerate={onRegenerate}
        />
      </div>
    </div>
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
    return new Date(iso).toLocaleString(isAr ? 'ar' : 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}
