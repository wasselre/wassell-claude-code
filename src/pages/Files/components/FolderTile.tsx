import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Folder, MoreVertical, Pencil, Share2, Shield, Trash2 } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import type { FolderRow } from '@/types';
import { useAppStore } from '@/stores/appStore';

interface Props {
  folder: FolderRow;
  shared?: boolean;
  onRename: (folder: FolderRow) => void;
  onPermissions: (folder: FolderRow) => void;
  onDelete: (folder: FolderRow) => void;
  /** True when the current user is the folder's owner (can manage). */
  canManage: boolean;
}

export default function FolderTile({ folder, shared, onRename, onPermissions, onDelete, canManage }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  return (
    <div
      onClick={() => navigate(`/files/${folder.id}`)}
      className="group relative bg-white border border-sand/30 rounded-2xl p-4 cursor-pointer hover:border-copper/30 hover:shadow-md hover:shadow-copper/5 transition-all"
    >
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-copper/10 flex items-center justify-center shrink-0">
          <Folder size={22} className="text-copper" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-charcoal truncate" title={folder.name}>
            {folder.name}
          </div>
          {shared && (
            <div className="mt-1 inline-flex items-center gap-1 text-[0.6875rem] font-bold text-copper bg-copper/10 px-2 py-0.5 rounded-md">
              {t('files.shared_badge')}
            </div>
          )}
        </div>
        {canManage && (
          <div ref={menuRef} className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={t('common.actions')}
            >
              <MoreVertical size={16} />
            </button>
            {menuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className={`absolute top-full mt-1 z-20 ${isAr ? 'start-0' : 'end-0'} min-w-[10rem] bg-white border border-sand/30 rounded-xl shadow-lg shadow-charcoal/10 py-1`}
              >
                <MenuItem icon={Pencil} label={t('files.actions.rename')} onClick={() => { setMenuOpen(false); onRename(folder); }} />
                <MenuItem icon={Share2} label={t('files.actions.share')} onClick={() => { setMenuOpen(false); onPermissions(folder); }} />
                <MenuItem icon={Shield} label={t('files.actions.permissions')} onClick={() => { setMenuOpen(false); onPermissions(folder); }} />
                <div className="my-1 border-t border-sand/30" />
                <MenuItem icon={Trash2} label={t('files.actions.delete')} danger onClick={() => { setMenuOpen(false); onDelete(folder); }} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface MIProps {
  icon: typeof Folder;
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
