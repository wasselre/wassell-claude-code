import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Eye, FolderInput, MoreVertical, Share2, Shield, Trash2 } from 'lucide-react';
import type { FileRow } from '@/types';
import { kindAccent, kindIcon, formatBytes } from '@/lib/files/format';
import { useAppStore } from '@/stores/appStore';
import { signViewUrl } from '@/lib/files/client';

interface Props {
  file: FileRow;
  shared?: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onPreview: (f: FileRow) => void;
  onDownload: (f: FileRow) => void;
  onMove: (f: FileRow) => void;
  onShare: (f: FileRow) => void;
  onPermissions: (f: FileRow) => void;
  onDelete: (f: FileRow) => void;
}

export default function FileCard({
  file,
  shared,
  canEdit,
  canDelete,
  onPreview,
  onDownload,
  onMove,
  onShare,
  onPermissions,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  const accent = kindAccent[file.kind];
  const Icon = kindIcon[file.kind];

  return (
    <div
      onClick={() => onPreview(file)}
      className="group relative bg-white border border-sand/30 rounded-2xl overflow-hidden cursor-pointer hover:border-copper/30 hover:shadow-md hover:shadow-copper/5 transition-all flex flex-col"
    >
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
        <div ref={menuRef} className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream"
            aria-label={t('common.actions')}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className={`absolute bottom-full mb-1 z-20 ${isAr ? 'start-0' : 'end-0'} min-w-[12rem] bg-white border border-sand/30 rounded-xl shadow-lg shadow-charcoal/10 py-1`}
            >
              <MenuItem icon={Eye} label={t('files.actions.preview')} onClick={() => { setMenuOpen(false); onPreview(file); }} />
              <MenuItem icon={Download} label={t('files.actions.download')} onClick={() => { setMenuOpen(false); onDownload(file); }} />
              {canEdit && (
                <>
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
            </div>
          )}
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
