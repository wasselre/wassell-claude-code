import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MoreVertical,
  Maximize2,
  Download,
  Link2,
  FolderPlus,
  Database,
  Sparkles,
  CornerUpRight,
} from 'lucide-react';
import type { MessageImage } from '@/lib/imageChat/client';
import AddImageToFilesModal from './AddImageToFilesModal';
import AddImageToRecordModal from './AddImageToRecordModal';

interface Props {
  image: MessageImage;
  /** Index within the message's images[] (for the dedup cache). */
  imageIndex: number;
  messageId: string;
  /** The image_chats conversation record id (for the dedup cache). */
  chatRecordId: string;
  /** Open the full-size preview (the menu's "Open"). */
  onPreview: (url: string) => void;
  /** Pin this image as a reference + seed a variation prompt in the composer. */
  onRequestVariation: (image: MessageImage) => void;
  /** Pin this image as the reference for the next composed turn. */
  onUseAsReference: (image: MessageImage) => void;
}

const MENU_WIDTH = 208;

/**
 * Per-image actions menu on a completed assistant image (Image Chats v2,
 * Part 2). Open / Download / Copy URL are local; Add to Files / Add to Record
 * open their modals; Create Variation / Use as Next Reference feed the
 * composer. The dropdown is portaled to <body> because the image tile is
 * overflow-hidden (rounded) and would clip an in-flow menu.
 */
export default function AssetActionsMenu({
  image,
  imageIndex,
  messageId,
  chatRecordId,
  onPreview,
  onRequestVariation,
  onUseAsReference,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    e.preventDefault();
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(8, Math.min(window.innerWidth - MENU_WIDTH - 8, rect.right - MENU_WIDTH));
      setPos({ top: rect.bottom + 4, left });
    }
    setOpen(true);
  }

  async function copyUrl() {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(image.url);
      addToast(isAr ? 'تم نسخ الرابط' : 'URL copied', 'success');
    } catch {
      addToast(isAr ? 'تعذّر النسخ' : 'Copy failed', 'error');
    }
  }

  const itemCls =
    'w-full flex items-center gap-2.5 px-3 py-2 text-start text-sm text-charcoal/80 hover:bg-cream transition-colors';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="absolute top-2 end-2 z-10 p-2 rounded-full bg-charcoal/70 text-white opacity-0 group-hover:opacity-100 hover:bg-charcoal transition-opacity"
        aria-label={isAr ? 'إجراءات' : 'Actions'}
        title={isAr ? 'إجراءات' : 'Actions'}
      >
        <MoreVertical size={14} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            className="fixed z-[70] rounded-lg border border-sand/40 bg-white shadow-xl py-1"
            style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
            dir={isAr ? 'rtl' : 'ltr'}
            onClick={(e) => e.stopPropagation()}
          >
            <button className={itemCls} onClick={() => { setOpen(false); onPreview(image.url); }}>
              <Maximize2 size={15} className="text-charcoal/60" />
              {isAr ? 'فتح' : 'Open'}
            </button>
            <a
              className={itemCls}
              href={image.url}
              download={image.name ?? 'wassel-image.png'}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
            >
              <Download size={15} className="text-charcoal/60" />
              {isAr ? 'تنزيل' : 'Download'}
            </a>
            <button className={itemCls} onClick={() => void copyUrl()}>
              <Link2 size={15} className="text-charcoal/60" />
              {isAr ? 'نسخ الرابط' : 'Copy URL'}
            </button>
            <div className="my-1 border-t border-sand/20" />
            <button className={itemCls} onClick={() => { setOpen(false); setFilesOpen(true); }}>
              <FolderPlus size={15} className="text-copper" />
              {isAr ? 'إضافة إلى الملفات' : 'Add to Files'}
            </button>
            <button className={itemCls} onClick={() => { setOpen(false); setRecordOpen(true); }}>
              <Database size={15} className="text-copper" />
              {isAr ? 'إضافة إلى سجل' : 'Add to Record'}
            </button>
            <div className="my-1 border-t border-sand/20" />
            <button className={itemCls} onClick={() => { setOpen(false); onRequestVariation(image); }}>
              <Sparkles size={15} className="text-charcoal/60" />
              {isAr ? 'إنشاء نسخة مختلفة' : 'Create Variation'}
            </button>
            <button className={itemCls} onClick={() => { setOpen(false); onUseAsReference(image); }}>
              <CornerUpRight size={15} className={`text-charcoal/60 ${isAr ? 'rotate-180' : ''}`} />
              {isAr ? 'استخدام كمرجع' : 'Use as Next Reference'}
            </button>
          </div>,
          document.body,
        )}

      {filesOpen && (
        <AddImageToFilesModal
          image={image}
          imageIndex={imageIndex}
          messageId={messageId}
          chatRecordId={chatRecordId}
          onClose={() => setFilesOpen(false)}
        />
      )}
      {recordOpen && (
        <AddImageToRecordModal
          image={image}
          imageIndex={imageIndex}
          messageId={messageId}
          chatRecordId={chatRecordId}
          onClose={() => setRecordOpen(false)}
        />
      )}
    </>
  );
}
