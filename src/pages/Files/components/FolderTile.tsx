import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Folder, MoreVertical, Pencil, Share2, Shield, Trash2 } from 'lucide-react';
import { useState, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import type { FolderRow } from '@/types';
import { useAppStore } from '@/stores/appStore';
import TileMenu from './TileMenu';

interface Props {
  folder: FolderRow;
  shared?: boolean;
  onRename: (folder: FolderRow) => void;
  onPermissions: (folder: FolderRow) => void;
  onDelete: (folder: FolderRow) => void;
  /** True when the caller is editor+ on the folder — shows the kebab and
   *  rename/share/permissions actions. */
  canManage: boolean;
  /** True when the caller is owner on the folder — gates the Delete action.
   *  Defaults to canManage when omitted (back-compat). */
  canDelete?: boolean;
  /** Selection-related props — same contract as FileCard. */
  selected: boolean;
  selectionActive: boolean;
  onSelectClick: (e: ReactMouseEvent) => boolean;
  onToggleCheckbox: (e: ReactMouseEvent) => void;
}

export default function FolderTile({
  folder,
  shared,
  onRename,
  onPermissions,
  onDelete,
  canManage,
  canDelete,
  selected,
  selectionActive,
  onSelectClick,
  onToggleCheckbox,
}: Props) {
  const showDelete = canDelete ?? canManage;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      data-selectable-kind="folder"
      data-selectable-id={folder.id}
      onClick={(e) => {
        const consumed = onSelectClick(e);
        if (!consumed) navigate(`/files/${folder.id}`);
      }}
      className={`group relative bg-white border rounded-2xl p-4 cursor-pointer transition-all ${
        selected
          ? 'border-copper ring-2 ring-copper/40 shadow-md shadow-copper/10'
          : 'border-sand/30 hover:border-copper/30 hover:shadow-md hover:shadow-copper/5'
      }`}
    >
      {/* Hover-revealed selection checkbox. Sits over the folder icon so the
          tile doesn't shift when it appears. */}
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
            ? 'bg-white text-charcoal/40 border border-sand/50 opacity-100 hover:text-copper'
            : 'bg-white text-charcoal/40 border border-sand/50 opacity-0 group-hover:opacity-100 hover:text-copper'
        }`}
      >
        <Check size={14} strokeWidth={3} className={selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'} />
      </button>

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
        {canManage && !selectionActive && (
          <div className="relative">
            <button
              ref={kebabRef}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={t('common.actions')}
            >
              <MoreVertical size={16} />
            </button>
            <TileMenu open={menuOpen} anchorRef={kebabRef} onClose={() => setMenuOpen(false)} isAr={isAr} width={160}>
              <MenuItem icon={Pencil} label={t('files.actions.rename')} onClick={() => { setMenuOpen(false); onRename(folder); }} />
              <MenuItem icon={Share2} label={t('files.actions.share')} onClick={() => { setMenuOpen(false); onPermissions(folder); }} />
              <MenuItem icon={Shield} label={t('files.actions.permissions')} onClick={() => { setMenuOpen(false); onPermissions(folder); }} />
              {showDelete && (
                <>
                  <div className="my-1 border-t border-sand/30" />
                  <MenuItem icon={Trash2} label={t('files.actions.delete')} danger onClick={() => { setMenuOpen(false); onDelete(folder); }} />
                </>
              )}
            </TileMenu>
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
