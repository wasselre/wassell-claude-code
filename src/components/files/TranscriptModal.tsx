import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, FileText, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { formatVideoDuration } from '@/lib/files/transcripts';

/**
 * Read a video's spoken-word transcript. Shared by the chat's project library
 * and the global Files pages, so the transcript reads the same everywhere.
 */
interface Props {
  title: string;
  text: string;
  durationSeconds?: number | null;
  /** The AI-written one-liner about the video, shown above the transcript. */
  description?: string | null;
  onClose: () => void;
}

export default function TranscriptModal({ title, text, durationSeconds, description, onClose }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [copied, setCopied] = useState(false);
  const duration = formatVideoDuration(durationSeconds);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[TranscriptModal] copy failed', err);
      addToast(t('files.transcript.copy_failed'), 'error');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-charcoal/50 p-4"
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl" dir={isAr ? 'rtl' : 'ltr'}>
        <div className="flex shrink-0 items-center gap-3 border-b border-sand/20 px-5 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-copper/10 text-copper">
            <FileText size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-chocolate">{t('files.transcript.title')}</h2>
            <p className="truncate text-xs text-charcoal/50" dir="auto">
              {title}{duration ? ` · ${duration}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sand px-2.5 py-1.5 text-xs font-medium text-charcoal/70 transition-colors hover:bg-cream"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t('files.transcript.copied') : t('files.transcript.copy')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-charcoal/50 transition-colors hover:bg-cream hover:text-charcoal"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {description && (
            <p className="rounded-lg bg-cream/60 p-3 text-xs leading-relaxed text-charcoal/70" dir="auto">{description}</p>
          )}
          <p className="whitespace-pre-wrap text-sm leading-loose text-charcoal" dir="auto">{text}</p>
        </div>
      </div>
    </div>
  );
}
