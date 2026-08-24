import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// When something is in the browser Fullscreen API (e.g. the finder's full-view
// map), only descendants of the fullscreen element paint on the top layer — a
// modal portaled to <body> renders on the hidden normal document, "outside" the
// map. Portal into the active fullscreen element instead so popups (units, send
// flows, …) open ON TOP of the full-view surface. Falls back to <body> normally.
const pickPortalTarget = (): Element =>
  (typeof document !== 'undefined' && document.fullscreenElement) || document.body;

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
}

export default function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 'max-w-lg',
}: ModalProps) {
  // Track the portal target across the modal's lifetime so entering/leaving
  // full-view while it's open moves it onto/off the fullscreen surface.
  const [portalTarget, setPortalTarget] = useState<Element>(pickPortalTarget);

  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const sync = () => setPortalTarget(pickPortalTarget());
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay px-4" onClick={onClose}>
      <div
        className={`modal-box ${maxWidth}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between p-5 border-b border-sand/50">
            <h2 className="text-lg font-bold text-charcoal">{title}</h2>
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-cream transition-colors text-charcoal/50 hover:text-charcoal"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="p-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 p-5 border-t border-sand/50">
            {footer}
          </div>
        )}
      </div>
    </div>,
    portalTarget,
  );
}
