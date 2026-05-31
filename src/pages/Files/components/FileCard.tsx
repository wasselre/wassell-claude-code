import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Download, Eye, FolderInput, MoreVertical, Pencil, Share2, Shield, Trash2 } from 'lucide-react';
import type { FileRow } from '@/types';
import { kindAccent, kindIcon, formatBytes } from '@/lib/files/format';
import { useAppStore } from '@/stores/appStore';
import { signViewUrl } from '@/lib/files/client';
import TileMenu from './TileMenu';

interface Props {
  file: FileRow;
  shared?: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Currently selected in the bulk-select UI. */
  selected: boolean;
  /** True if anything is selected — switches plain click from "preview" to
   *  "replace selection with this item". */
  selectionActive: boolean;
  /** Click forwarder; returns true if selection logic consumed the click and
   *  the card should suppress its default preview action. */
  onSelectClick: (e: ReactMouseEvent) => boolean;
  /** Explicit click on the hover-revealed circular checkbox. */
  onToggleCheckbox: (e: ReactMouseEvent) => void;
  onPreview: (f: FileRow) => void;
  onDownload: (f: FileRow) => void;
  onMove: (f: FileRow) => void;
  onShare: (f: FileRow) => void;
  onPermissions: (f: FileRow) => void;
  onDelete: (f: FileRow) => void;
  onRename: (f: FileRow) => void;
}

export default function FileCard({
  file,
  shared,
  canEdit,
  canDelete,
  selected,
  selectionActive,
  onSelectClick,
  onToggleCheckbox,
  onPreview,
  onDownload,
  onMove,
  onShare,
  onPermissions,
  onDelete,
  onRename,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLButtonElement>(null);

  // Lazy-load a thumbnail for image kinds.
  useEffect(() => {
    if (file.kind !== 'image') return;
    let cancelled = false;
    void signViewUrl(file.id)
      .then((res) => {
        if (!cancelled) setThumbUrl(res.url);
      })
      .catch(() => {
        // Failure is fine — falls back to the icon tile.
      });
    return () => {
      cancelled = true;
    };
  }, [file.id, file.kind]);

  const accent = kindAccent[file.kind];
  const Icon = kindIcon[file.kind];

  return (
    <div
      data-selectable-kind="file"
      data-selectable-id={file.id}
      onClick={(e) => {
        const consumed = onSelectClick(e);
        if (!consumed) onPreview(file);
      }}
      className={`group relative bg-white border rounded-2xl overflow-hidden cursor-pointer transition-all flex flex-col ${
        selected
          ? 'border-copper ring-2 ring-copper/40 shadow-md shadow-copper/10'
          : 'border-sand/30 hover:border-copper/30 hover:shadow-md hover:shadow-copper/5'
      }`}
    >
      {/* Hover-revealed selection checkbox (Google Drive style). Always visible
          when selected so users see what's picked even after mouseout. */}
      <button
        type="button"
        onClick={onToggleCheckbox}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={t('files.bulk.toggle_select_aria')}
        aria-pressed={selected}
        className={`absolute z-10 top-2 end-2 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
          selected
            ? 'bg-copper text-white opacity-100 shadow-sm'
            : selectionActive
            ? 'bg-white/90 text-charcoal/40 border border-sand/50 opacity-100 hover:text-copper'
            : 'bg-white/90 text-charcoal/40 border border-sand/50 opacity-0 group-hover:opacity-100 hover:text-copper'
        }`}
      >
        <Check size={14} strokeWidth={3} className={selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'} />
      </button>

      {/* Thumb area */}
      <div className={`aspect-[4/3] flex items-center justify-center relative ${accent.bg}`}>
        {file.kind === 'image' && thumbUrl ? (
          <img
            src={thumbUrl}
            alt={file.original_name}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <Icon size={40} className={accent.fg} />
        )}
        {shared && (
          <div className="absolute top-2 start-2 inline-flex items-center gap-1 text-[0.6875rem] font-bold text-white bg-charcoal/70 backdrop-blur-sm px-2 py-0.5 rounded-md">
            {t('files.shared_badge')}
          </div>
        )}
      </div>

      {/* Metadata strip */}
      <div className="flex items-start gap-2 p-3 border-t border-sand/20">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-charcoal truncate text-sm" title={file.original_name}>
            {file.original_name}
          </div>
          <div className="text-xs text-charcoal/40 mt-0.5">{formatBytes(file.size_bytes, isAr)}</div>
        </div>
        <div className="relative">
          <button
            ref={kebabRef}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream"
            aria-label={t('common.actions')}
          >
            <MoreVertical size={16} />
          </button>
          <TileMenu open={menuOpen} anchorRef={kebabRef} onClose={() => setMenuOpen(false)} isAr={isAr} width={192}>
            <MenuItem icon={Eye} label={t('files.actions.preview')} onClick={() => { setMenuOpen(false); onPreview(file); }} />
            <MenuItem icon={Download} label={t('files.actions.download')} onClick={() => { setMenuOpen(false); onDownload(file); }} />
            {canEdit && (
              <>
                <MenuItem icon={Pencil} label={t('files.actions.rename')} onClick={() => { setMenuOpen(false); onRename(file); }} />
                <MenuItem icon={FolderInput} label={t('files.actions.move')} onClick={() => { setMenuOpen(false); onMove(file); }} />
                <MenuItem icon={Share2} label={t('files.actions.share')} onClick={() => { setMenuOpen(false); onShare(file); }} />
                <MenuItem icon={Shield} label={t('files.actions.permissions')} onClick={() => { setMenuOpen(false); onPermissions(file); }} />
              </>
            )}
            {canDelete && (
              <>
                <div className="my-1 border-t border-sand/30" />
                <MenuItem icon={Trash2} label={t('files.actions.delete')} danger onClick={() => { setMenuOpen(false); onDelete(file); }} />
              </>
            )}
          </TileMenu>
        </div>
      </div>
    </div>
  );
}

interface MIProps {
  icon: typeof Eye;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function MenuItem({ icon: Icon, label, onClick, danger }: MIProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
        danger
          ? 'text-red-600 hover:bg-red-50'
          : 'text-charcoal/80 hover:bg-cream hover:text-charcoal'
      }`}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}
