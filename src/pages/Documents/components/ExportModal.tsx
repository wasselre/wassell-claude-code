import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FileCode, FileDown, FileText, FileType, Loader2, Printer, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { JSONContent } from '@tiptap/core';
import { useAppStore } from '@/stores/appStore';
import {
  buildDocxBlob,
  buildHtmlShell,
  downloadBlob,
  downloadText,
  openPrintPdf,
  safeFilename,
  tiptapToMarkdown,
} from '@/lib/documents/export';

interface Props {
  open: boolean;
  title: string;
  /** Live editor content getters — fresh even before the next autosave. */
  getJson: () => JSONContent;
  getHtml: () => string;
  onClose: () => void;
}

type Format = 'pdf' | 'docx' | 'html' | 'md';

const FORMATS: Array<{ id: Format; icon: LucideIcon }> = [
  { id: 'pdf', icon: Printer },
  { id: 'docx', icon: FileType },
  { id: 'html', icon: FileCode },
  { id: 'md', icon: FileText },
];

/** Export menu — PDF (print engine), DOCX, HTML, Markdown. */
export default function ExportModal({ open, title, getJson, getHtml, onClose }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState<Format | null>(null);

  if (!open) return null;

  const run = async (format: Format) => {
    setBusy(format);
    try {
      const dir: 'rtl' | 'ltr' = isAr ? 'rtl' : 'ltr';
      const base = safeFilename(title);
      if (format === 'pdf') {
        const ok = openPrintPdf(title, getHtml(), dir);
        if (!ok) {
          addToast(t('doc.export.popup_blocked'), 'error');
          return;
        }
      } else if (format === 'html') {
        downloadText(`${base}.html`, buildHtmlShell(title, getHtml(), dir), 'text/html');
      } else if (format === 'md') {
        downloadText(`${base}.md`, tiptapToMarkdown(getJson()), 'text/markdown');
      } else {
        const blob = await buildDocxBlob(getJson(), isAr);
        downloadBlob(`${base}.docx`, blob);
      }
      addToast(t('doc.export.done'), 'success');
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-charcoal/40 backdrop-blur-sm flex items-center justify-center p-4 modal-overlay"
      onClick={() => !busy && onClose()}
    >
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-sand/30">
          <div className="flex items-center gap-2">
            <FileDown size={18} className="text-copper" />
            <h3 className="font-bold text-charcoal">{t('doc.export.title')}</h3>
          </div>
          <button
            onClick={onClose}
            disabled={!!busy}
            className="p-2 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream disabled:opacity-40"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-1.5">
          {FORMATS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              onClick={() => void run(id)}
              disabled={!!busy}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-sand/40 hover:bg-cream hover:border-copper/30 text-start transition-colors disabled:opacity-50"
            >
              {busy === id ? (
                <Loader2 size={18} className="animate-spin text-copper shrink-0" />
              ) : (
                <Icon size={18} className="text-copper shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-sm font-bold text-charcoal">{t(`doc.export.${id}`)}</div>
                <div className="text-xs text-charcoal/45">{t(`doc.export.${id}_hint`)}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
