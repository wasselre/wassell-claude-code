/**
 * Phase 3 · B7 (bulk half) — the floating bar shown while files are selected.
 *
 * `position: fixed`, bottom-centre, deliberately OUT of the document flow: the
 * folder page learned that a bar in the flow reflows the grid the moment a
 * selection starts, which moves the tiles out from under the cursor mid-drag
 * and makes the marquee hit-test disagree with what the user sees.
 */
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Pencil, X } from 'lucide-react';
import Button from '@/components/ui/Button';

interface Props {
  count: number;
  busy: boolean;
  onEdit: () => void;
  onDownload: () => void;
  onClear: () => void;
}

export default function LibraryBulkBar({ count, busy, onEdit, onDownload, onClear }: Props) {
  const { t } = useTranslation();
  if (count === 0) return null;

  return (
    <div
      // data-no-marquee: a mousedown on the bar must never start a rectangle,
      // and the bar sits over the grid.
      data-no-marquee
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-2 rounded-2xl bg-white border border-sand/40 shadow-xl shadow-charcoal/10"
      role="toolbar"
      aria-label={t('files.bulk.toolbar')}
    >
      <span className="ps-2 pe-1 text-sm font-bold text-charcoal tabular-nums">
        {t('files.bulk.selected', { count })}
      </span>
      <span className="w-px h-6 bg-sand/40" aria-hidden />

      <Button variant="secondary" className="!px-3 !py-1.5 text-xs" disabled={busy} onClick={onEdit}>
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Pencil size={13} aria-hidden />}
        {t('files.bulk.edit')}
      </Button>
      <Button variant="secondary" className="!px-3 !py-1.5 text-xs" disabled={busy} onClick={onDownload}>
        <Download size={13} aria-hidden />
        {t('files.bulk.download')}
      </Button>

      <button
        type="button"
        onClick={onClear}
        aria-label={t('files.bulk.clear')}
        className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream"
      >
        <X size={15} aria-hidden />
      </button>
    </div>
  );
}
