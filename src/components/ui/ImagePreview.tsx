import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, Download } from 'lucide-react';

interface ImagePreviewProps {
  /** Public URL of the image to preview. Component renders nothing when null/empty. */
  url: string | null;
  onClose: () => void;
  /** Optional caption shown under the image. */
  alt?: string;
}

/**
 * Full-screen image lightbox. Click backdrop or Escape to close.
 * Used by every image-typed field (record form + table cell). Renders
 * via portal so it overlays the entire app, not just the parent stack.
 *
 * Top-right toolbar: open-in-new-tab + download + close. Image itself
 * is `object-contain` capped at 95vw × 95vh — preserves aspect ratio
 * regardless of source dimensions.
 */
export default function ImagePreview({ url, onClose, alt = '' }: ImagePreviewProps) {
  useEffect(() => {
    if (!url) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    // Lock body scroll while the lightbox is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = prevOverflow;
    };
  }, [url, onClose]);

  if (!url) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
      onClick={onClose}
    >
      <div className="absolute top-4 end-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          title="Open in new tab"
        >
          <ExternalLink size={18} />
        </a>
        <a
          href={url}
          download
          className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          title="Download"
        >
          <Download size={18} />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          title="Close (Esc)"
        >
          <X size={18} />
        </button>
      </div>
      <img
        src={url}
        alt={alt}
        className="max-w-[95vw] max-h-[95vh] object-contain rounded-lg shadow-2xl cursor-default"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
