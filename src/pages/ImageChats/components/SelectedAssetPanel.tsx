import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { X, Download, Link2, FolderPlus, Database, Sparkles, CornerUpRight, RefreshCw } from 'lucide-react';
import type { Generation } from '@/lib/imageChat/client';
import type { OutputItem } from '../lib/generations';
import AddImageToFilesModal from './AddImageToFilesModal';
import AddImageToRecordModal from './AddImageToRecordModal';

interface Props {
  output: OutputItem;
  generation: Generation;
  onClose: () => void;
  onCreateVariation: () => void;
  onUseAsReference: () => void;
  onRegenerate: () => void;
}

/**
 * Right-sidebar panel for the selected output asset (Image Chats v3). Shows a
 * full preview + provenance (prompt / model / settings / time, from the
 * media_asset when first-class, else from the parent generation) + the asset
 * actions. Add-to-Files / Add-to-Record reuse the v2 modals with a lightweight
 * image shape (no message-cache for v3 assets in v1).
 */
export default function SelectedAssetPanel({
  output,
  generation,
  onClose,
  onCreateVariation,
  onUseAsReference,
  onRegenerate,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [filesOpen, setFilesOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);

  const asset = output.asset;
  const prompt = asset?.prompt ?? generation.prompt;
  const model = asset?.model_id ?? generation.model_id;
  const aspect = generation.aspect_ratio;
  const created = asset?.created_at ?? generation.created_at;

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(output.url);
      addToast(isAr ? 'تم نسخ الرابط' : 'URL copied', 'success');
    } catch {
      addToast(isAr ? 'تعذّر النسخ' : 'Copy failed', 'error');
    }
  }

  // Lightweight image shape for the reused v2 modals (no file_id cache for v3).
  const pseudoImage = { url: output.url, name: 'wassel-image.png' };

  const ActionBtn = ({
    icon,
    label,
    onClick,
    primary,
  }: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    primary?: boolean;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
        primary
          ? 'bg-copper text-white hover:bg-terracotta'
          : 'border border-sand/40 bg-white text-charcoal/80 hover:bg-cream'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

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
        {/* Preview */}
        <div className="rounded-xl overflow-hidden border border-sand/30 bg-cream/40">
          <img src={output.url} alt="" className="w-full h-auto object-contain" />
        </div>

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
        <div className="space-y-1.5 pt-1">
          <a
            href={output.url}
            download={pseudoImage.name}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-sand/40 bg-white text-charcoal/80 hover:bg-cream transition-colors"
          >
            <Download size={15} className="text-charcoal/60" />
            <span>{isAr ? 'تنزيل' : 'Download'}</span>
          </a>
          <ActionBtn icon={<Link2 size={15} className="text-charcoal/60" />} label={isAr ? 'نسخ الرابط' : 'Copy URL'} onClick={() => void copyUrl()} />
          <ActionBtn icon={<FolderPlus size={15} className="text-copper" />} label={isAr ? 'إضافة إلى الملفات' : 'Add to Files'} onClick={() => setFilesOpen(true)} />
          <ActionBtn icon={<Database size={15} className="text-copper" />} label={isAr ? 'إضافة إلى سجل' : 'Add to Record'} onClick={() => setRecordOpen(true)} />
          <div className="h-px bg-sand/20 my-1" />
          <ActionBtn icon={<Sparkles size={15} />} label={isAr ? 'إنشاء نسخة مختلفة' : 'Create Variation'} onClick={onCreateVariation} primary />
          <ActionBtn icon={<CornerUpRight size={15} className={`text-charcoal/60 ${isAr ? 'rotate-180' : ''}`} />} label={isAr ? 'استخدام كمرجع' : 'Use as Reference'} onClick={onUseAsReference} />
          <ActionBtn icon={<RefreshCw size={15} className="text-charcoal/60" />} label={isAr ? 'إعادة الإنشاء' : 'Regenerate'} onClick={onRegenerate} />
        </div>
      </div>

      {filesOpen && (
        <AddImageToFilesModal image={pseudoImage} imageIndex={0} messageId="" chatRecordId="" onClose={() => setFilesOpen(false)} />
      )}
      {recordOpen && (
        <AddImageToRecordModal image={pseudoImage} imageIndex={0} messageId="" chatRecordId="" onClose={() => setRecordOpen(false)} />
      )}
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
