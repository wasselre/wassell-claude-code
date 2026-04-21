import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

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
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-box ${maxWidth} mx-4`}
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
    document.body,
  );
}
