import { useEffect, useRef, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';

interface PromptModalProps {
  open: boolean;
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel: string;
  cancelLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/**
 * Branded replacement for `window.prompt()` — takes a single text value
 * inside the app's Modal shell so creating a folder or renaming a board
 * matches the rest of the CRM's design (Amiri font, copper bronze accent,
 * sand-colored borders) instead of the browser's native chrome dialog.
 *
 * Behavior contract:
 *   - Enter submits if the trimmed value is non-empty.
 *   - Escape (handled by Modal) cancels.
 *   - Initial focus on the input + select-all so the user can immediately
 *     type a replacement when renaming.
 */
export default function PromptModal({
  open,
  title,
  label,
  initialValue = '',
  placeholder,
  submitLabel,
  cancelLabel,
  onSubmit,
  onClose,
}: PromptModalProps): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset and select-all whenever the modal (re)opens.
  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    // requestAnimationFrame so the input has mounted before we focus it
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open, initialValue]);

  const trimmed = value.trim();
  const handleSubmit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
  };

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
          <Button onClick={handleSubmit} disabled={!trimmed}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        {label && (
          <label className="block text-sm font-bold text-charcoal">{label}</label>
        )}
        <input
          ref={inputRef}
          type="text"
          className="form-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
      </div>
    </Modal>
  );
}
