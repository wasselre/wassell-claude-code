import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Branded replacement for `window.confirm()`. Uses the app's Modal shell
 * and Button so the destructive prompt matches the rest of the CRM
 * instead of the browser's native chrome dialog. Set `destructive` to
 * style the confirm button red — for delete confirmations.
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onClose,
}: ConfirmModalProps): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-charcoal/80 leading-relaxed">{message}</p>
    </Modal>
  );
}
