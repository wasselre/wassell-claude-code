/**
 * Phase 3 · B5 — "save this query as a view".
 *
 * The name is the identity: saving over a name you already used UPDATES that
 * view rather than creating a second one that differs invisibly. The RPC does
 * that atomically (ON CONFLICT on the owner+name unique index), so this modal
 * does not check first — a read-then-write here would be a race, and would
 * surface a unique-violation for a perfectly ordinary action.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import type { FileViewRow } from '@/types';

interface Props {
  open: boolean;
  /** Pre-filled when the user is re-saving a view they already opened. */
  initialName?: string;
  initialVisibility?: 'private' | 'shared';
  existing: FileViewRow[];
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, visibility: 'private' | 'shared') => void;
}

export default function SaveViewModal({
  open, initialName, initialVisibility, existing, busy, onCancel, onSave,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? '');
    setVisibility(initialVisibility ?? 'private');
  }, [open, initialName, initialVisibility]);

  if (!open) return null;

  const trimmed = name.trim();
  // Case- and whitespace-insensitive, exactly like the unique index, so the
  // warning appears in every case the database would actually overwrite.
  const collides = existing.some((v) => v.name.trim().toLowerCase() === trimmed.toLowerCase());

  return (
    <div
      className="modal-overlay fixed inset-0 z-50 bg-charcoal/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={t('files.library.save_view_title')}
    >
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between gap-3 p-5 pb-3">
          <h2 className="text-base font-bold text-charcoal">{t('files.library.save_view_title')}</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('common.close')}
            className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <form
          className="px-5 pb-5 space-y-4"
          onSubmit={(e) => { e.preventDefault(); if (trimmed && !busy) onSave(trimmed, visibility); }}
        >
          <div>
            <label htmlFor="view-name" className="block mb-1.5 text-xs font-bold text-charcoal/60">
              {t('files.library.view_name')}
            </label>
            <input
              id="view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              dir="auto"
              autoFocus
              maxLength={120}
              placeholder={t('files.library.view_name_placeholder')}
              className="w-full px-3 py-2.5 rounded-xl bg-white border border-sand/40 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30"
            />
            {collides && (
              <p className="mt-1.5 text-xs text-amber-700">{t('files.library.view_name_collides')}</p>
            )}
          </div>

          <fieldset>
            <legend className="mb-1.5 text-xs font-bold text-charcoal/60">
              {t('files.library.view_visibility')}
            </legend>
            <div className="flex items-center gap-2">
              {(['private', 'shared'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVisibility(v)}
                  aria-pressed={visibility === v}
                  className={`flex-1 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                    visibility === v
                      ? 'bg-copper/10 border-copper/30 text-copper'
                      : 'bg-white border-sand/40 text-charcoal/70 hover:bg-cream'
                  }`}
                >
                  {t(`files.library.visibility.${v}`)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-charcoal/45">
              {t(`files.library.visibility_hint.${visibility}`)}
            </p>
          </fieldset>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!trimmed || busy}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {t('common.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
