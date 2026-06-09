import { useState, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Download, Link2, FolderPlus, Database, Sparkles, CornerUpRight, RefreshCw } from 'lucide-react';
import type { OutputItem } from '../lib/generations';
import AddImageToFilesModal from './AddImageToFilesModal';
import AddImageToRecordModal from './AddImageToRecordModal';

interface Props {
  output: OutputItem;
  /** Creative actions — omit to hide (e.g. the Media Library, which has no
   *  active session/composer to seed). */
  onCreateVariation?: () => void;
  onUseAsReference?: () => void;
  onRegenerate?: () => void;
  /** Extra buttons appended after a divider (e.g. "Open source session"). */
  extra?: ReactNode;
}

/**
 * Shared action list for a selected output asset (Image Chats v3). Rendered by
 * the right-rail SelectedAssetPanel and the full-screen AssetLightbox (workspace
 * + Media Library) so the surfaces never drift. Hosts the v2 Add-to-Files /
 * Add-to-Record modals internally (a lightweight image shape — no message-cache
 * for v3 assets). Download / Copy URL act on the output's public URL directly.
 * The creative actions (Variation / Reference / Regenerate) are optional so the
 * Media Library can reuse this with just the universal actions + an `extra`.
 */
export default function AssetActions({
  output,
  onCreateVariation,
  onUseAsReference,
  onRegenerate,
  extra,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [filesOpen, setFilesOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);

  // Lightweight image shape for the reused v2 modals (no file_id cache for v3).
  const pseudoImage = { url: output.url, name: 'wassel-image.png' };
  const hasCreative = !!(onCreateVariation || onUseAsReference || onRegenerate);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(output.url);
      addToast(isAr ? 'تم نسخ الرابط' : 'URL copied', 'success');
    } catch {
      addToast(isAr ? 'تعذّر النسخ' : 'Copy failed', 'error');
    }
  }

  return (
    <div className="space-y-1.5">
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

      {hasCreative && <div className="h-px bg-sand/20 my-1" />}
      {onCreateVariation && (
        <ActionBtn icon={<Sparkles size={15} />} label={isAr ? 'إنشاء نسخة مختلفة' : 'Create Variation'} onClick={onCreateVariation} primary />
      )}
      {onUseAsReference && (
        <ActionBtn icon={<CornerUpRight size={15} className={`text-charcoal/60 ${isAr ? 'rotate-180' : ''}`} />} label={isAr ? 'استخدام كمرجع' : 'Use as Reference'} onClick={onUseAsReference} />
      )}
      {onRegenerate && (
        <ActionBtn icon={<RefreshCw size={15} className="text-charcoal/60" />} label={isAr ? 'إعادة الإنشاء' : 'Regenerate'} onClick={onRegenerate} />
      )}

      {extra && (
        <>
          <div className="h-px bg-sand/20 my-1" />
          {extra}
        </>
      )}

      {filesOpen && (
        <AddImageToFilesModal image={pseudoImage} imageIndex={0} messageId="" chatRecordId="" onClose={() => setFilesOpen(false)} />
      )}
      {recordOpen && (
        <AddImageToRecordModal image={pseudoImage} imageIndex={0} messageId="" chatRecordId="" onClose={() => setRecordOpen(false)} />
      )}
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
  primary,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
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
}
