import { useTranslation } from 'react-i18next';
import { Download, FolderInput, Trash2, X } from 'lucide-react';

interface Props {
  count: number;
  /** How many of the selected items the current user can actually delete. */
  deletableCount: number;
  /** How many of the selected items the current user can move (files only — folder bulk move isn't implemented yet). */
  movableFileCount: number;
  /** How many file rows are in the selection (for the Download button). */
  fileCount: number;
  onClear: () => void;
  onDelete: () => void;
  onMove: () => void;
  onDownload: () => void;
}

/**
 * Floating action bar shown whenever the user has at least one item selected.
 *
 * CRITICAL — this is pinned to the bottom-center of the viewport (position:
 * fixed) ON PURPOSE. It used to be an in-flow `sticky` bar rendered directly
 * above the grid, which meant the instant the first item got selected the bar
 * mounted and pushed every tile down ~60px. That shift desynced the marquee
 * hit-test (the rubber-band grabbed different tiles than the box covered) and
 * made checkbox / tile clicks land on the wrong row. Keeping the bar OUT of
 * the document flow is what makes selection stable — do not move it back into
 * flow. Mirrors the Gmail/Drive multi-select pill.
 */
export default function BulkActionBar({
  count,
  deletableCount,
  movableFileCount,
  fileCount,
  onClear,
  onDelete,
  onMove,
  onDownload,
}: Props) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label={t('files.bulk.selected_count', { count })}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-charcoal text-white rounded-2xl px-3 py-2 shadow-lg shadow-charcoal/30 max-w-[calc(100vw-2rem)]"
    >
      <button
        type="button"
        onClick={onClear}
        className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
        aria-label={t('files.bulk.clear')}
      >
        <X size={16} />
      </button>
      <span className="font-bold text-sm pe-2 border-e border-white/15">
        {t('files.bulk.selected_count', { count })}
      </span>

      <div className="flex items-center gap-1 ms-auto">
        <BarButton
          icon={Download}
          label={t('files.bulk.download')}
          disabled={fileCount === 0}
          onClick={onDownload}
        />
        <BarButton
          icon={FolderInput}
          label={t('files.bulk.move')}
          disabled={movableFileCount === 0}
          onClick={onMove}
        />
        <BarButton
          icon={Trash2}
          label={t('files.bulk.delete')}
          danger
          disabled={deletableCount === 0}
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

interface BBProps {
  icon: typeof Trash2;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

function BarButton({ icon: Icon, label, onClick, disabled, danger }: BBProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold transition-colors ${
        disabled
          ? 'text-white/30 cursor-not-allowed'
          : danger
          ? 'text-red-300 hover:bg-red-500/15'
          : 'text-white hover:bg-white/10'
      }`}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}
