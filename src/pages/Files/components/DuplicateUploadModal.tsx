/**
 * Phase 3 · B7 — "you already have this file".
 *
 * Spec §10: "an exact byte match offers 'Link the existing file instead' with
 * the match shown, and creating the copy anyway requires a deliberate click."
 *
 * Both halves of that sentence are load-bearing:
 *
 *   "with the match shown" — a dedup prompt that will not tell you WHICH file
 *   it matched is unanswerable. You cannot judge whether the existing copy is
 *   the one you want without seeing its name, its type and where it came from.
 *
 *   "requires a deliberate click" — keeping the copy stays available, because
 *   sometimes a byte-identical file genuinely belongs twice (the same floor
 *   plan filed under two projects that later diverge). This refuses to decide
 *   for the user; it only refuses to decide SILENTLY.
 *
 * "Apply to the rest" exists because the realistic case is dropping twenty
 * files of which twelve are already there. Being asked twelve times is how
 * people learn to click the first button without reading it.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, FileWarning } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import type { FileRow } from '@/types';
import type { DuplicateDecision } from '@/lib/files/client';

interface Props {
  open: boolean;
  /** The file the user just uploaded. */
  incomingName: string;
  incomingSize: number;
  /** Files already in the library with identical bytes. */
  matches: FileRow[];
  /** How many files are still queued behind this one — drives whether the
   *  "apply to the rest" option is worth showing at all. */
  remaining: number;
  onDecide: (decision: DuplicateDecision, applyToRest: boolean) => void;
}

export default function DuplicateUploadModal({
  open, incomingName, incomingSize, matches, remaining, onDecide,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const [applyToRest, setApplyToRest] = useState(false);

  if (!open) return null;
  const primary = matches[0];

  return (
    // No onClose: dismissing by clicking away would leave the upload in limbo
    // with nothing resolving the promise. A decision is required, and both
    // decisions are one click.
    <Modal open={open} onClose={() => {}} maxWidth="max-w-lg">
      <div className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <span className="w-9 h-9 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
            <Copy size={17} className="text-amber-700" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-charcoal">{t('files.dupe.title')}</h2>
            <p className="mt-0.5 text-xs text-charcoal/55">
              {t('files.dupe.subtitle', { name: incomingName, size: formatBytes(incomingSize, isAr) })}
            </p>
          </div>
        </div>

        {/* The match itself. Without this the prompt is unanswerable. */}
        {primary && (
          <div className="p-3 rounded-xl bg-cream/70 border border-sand/40">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-charcoal/40">
              {t('files.dupe.already_have')}
            </p>
            {matches.slice(0, 3).map((m) => {
              const Icon = kindIcon[m.kind];
              const accent = kindAccent[m.kind];
              return (
                <div key={m.id} className="flex items-center gap-2.5 py-1">
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${accent.bg}`}>
                    <Icon size={15} className={accent.fg} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-charcoal truncate" dir="auto">
                      {m.original_name}
                    </span>
                    <span className="block text-[11px] text-charcoal/45">
                      {formatBytes(m.size_bytes, isAr)}
                    </span>
                  </span>
                </div>
              );
            })}
            {matches.length > 3 && (
              <p className="mt-1 text-[11px] text-charcoal/40">
                {t('files.dupe.and_more', { count: matches.length - 3 })}
              </p>
            )}
          </div>
        )}

        <p className="flex items-start gap-2 text-[11px] text-charcoal/50">
          <FileWarning size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>{t('files.dupe.explain')}</span>
        </p>

        {remaining > 0 && (
          <label className="flex items-center gap-2 text-xs text-charcoal/70 cursor-pointer">
            <input
              type="checkbox"
              checked={applyToRest}
              onChange={(e) => setApplyToRest(e.target.checked)}
              className="w-4 h-4 rounded border-sand/60 accent-copper"
            />
            {t('files.dupe.apply_to_rest', { count: remaining })}
          </label>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={() => onDecide('keep', applyToRest)}>
            {t('files.dupe.keep_copy')}
          </Button>
          <Button onClick={() => onDecide('link', applyToRest)}>
            {t('files.dupe.use_existing')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
