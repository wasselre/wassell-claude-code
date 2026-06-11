import type { ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  /** Body — a string or richer content. */
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** Renders the confirm button red + a warning glyph. Default true — this
   *  component exists mostly for destructive actions. */
  danger?: boolean;
  /** Disables both buttons + spinner on confirm while the action runs. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * App-styled replacement for window.confirm — Wassel palette, RTL-aware,
 * Esc/overlay-click to cancel. Use for every destructive confirmation;
 * native browser popups ("app.wassel.re says…") are off-brand and can't
 * explain consequences properly.
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  busy = false,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        {danger && (
          <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center shrink-0">
            <AlertTriangle size={20} className="text-red-500" />
          </div>
        )}
        <div className="min-w-0">
          <h3 className="font-bold text-charcoal mb-1">{title}</h3>
          <div className="text-sm text-charcoal/60 leading-relaxed break-words">{message}</div>
        </div>
      </div>
    </Modal>
  );
}
