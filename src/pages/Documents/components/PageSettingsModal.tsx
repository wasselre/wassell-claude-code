import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, Settings2, X } from 'lucide-react';
import type { PageSettings, PageSize, PageOrientationSetting, PageMargin } from '@/lib/documents/pageSettings';

interface Props {
  open: boolean;
  value: PageSettings;
  onClose: () => void;
  /** Persist + apply. Resolves when saved (modal shows busy meanwhile). */
  onSave: (next: PageSettings) => Promise<void>;
}

/** Page setup — size, orientation, margins, header/footer, page numbers. */
export default function PageSettingsModal({ open, value, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PageSettings>(value);
  const [busy, setBusy] = useState(false);

  // Re-seed the draft each open so a cancelled edit never sticks around.
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  if (!open) return null;

  const set = <K extends keyof PageSettings>(key: K, v: PageSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: v }));

  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-charcoal/40 backdrop-blur-sm flex items-center justify-center p-4 modal-overlay"
      onClick={() => !busy && onClose()}
    >
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-sand/30 sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-2">
            <Settings2 size={18} className="text-copper" />
            <h3 className="font-bold text-charcoal">{t('doc.page.title')}</h3>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="p-2 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream disabled:opacity-40"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <Segmented<PageSize>
            label={t('doc.page.size')}
            value={draft.page_size}
            options={[
              { id: 'a4', label: 'A4' },
              { id: 'letter', label: 'Letter' },
              { id: 'legal', label: 'Legal' },
            ]}
            onChange={(v) => set('page_size', v)}
          />
          <Segmented<PageOrientationSetting>
            label={t('doc.page.orientation')}
            value={draft.orientation}
            options={[
              { id: 'portrait', label: t('doc.page.portrait') },
              { id: 'landscape', label: t('doc.page.landscape') },
            ]}
            onChange={(v) => set('orientation', v)}
          />
          <Segmented<PageMargin>
            label={t('doc.page.margins')}
            value={draft.margin}
            options={[
              { id: 'narrow', label: t('doc.page.margin_narrow') },
              { id: 'normal', label: t('doc.page.margin_normal') },
              { id: 'wide', label: t('doc.page.margin_wide') },
            ]}
            onChange={(v) => set('margin', v)}
          />

          <div>
            <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-1.5">
              {t('doc.page.header')}
            </div>
            <input
              value={draft.header_text}
              onChange={(e) => set('header_text', e.target.value)}
              placeholder={t('doc.page.header_placeholder')}
              dir="auto"
              className="w-full px-3 py-2 rounded-lg border border-sand/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
            />
          </div>
          <div>
            <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-1.5">
              {t('doc.page.footer')}
            </div>
            <input
              value={draft.footer_text}
              onChange={(e) => set('footer_text', e.target.value)}
              placeholder={t('doc.page.footer_placeholder')}
              dir="auto"
              className="w-full px-3 py-2 rounded-lg border border-sand/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
            />
          </div>

          <Toggle
            label={t('doc.page.page_numbers')}
            hint={t('doc.page.page_numbers_hint')}
            checked={draft.show_page_numbers}
            onChange={(v) => set('show_page_numbers', v)}
          />
          <Toggle
            label={t('doc.page.different_first')}
            hint={t('doc.page.different_first_hint')}
            checked={draft.different_first_page}
            onChange={(v) => set('different_first_page', v)}
          />
        </div>

        <div className="flex justify-end gap-2 px-5 pb-5">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream font-bold text-sm disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-copper text-white hover:bg-terracotta font-bold text-sm disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-1.5">{label}</div>
      <div className="flex rounded-xl border border-sand/40 overflow-hidden">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`flex-1 px-3 py-2 text-sm font-bold transition-colors ${
              value === o.id ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button onClick={() => onChange(!checked)} className="w-full flex items-center gap-3 text-start">
      <span
        className={`w-10 h-5.5 h-6 rounded-full p-0.5 transition-colors shrink-0 ${checked ? 'bg-copper' : 'bg-sand/60'}`}
      >
        <span
          className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4 rtl:-translate-x-4' : ''
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-charcoal">{label}</span>
        <span className="block text-xs text-charcoal/45">{hint}</span>
      </span>
    </button>
  );
}
