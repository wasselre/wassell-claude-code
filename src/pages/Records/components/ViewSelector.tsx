import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  Check,
  Plus,
  Pencil,
  Trash2,
  Star,
  Users,
  Lock,
  Eye,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { ModelView } from '@/types';

interface ViewSelectorProps {
  modelId: string;
  views: ModelView[];
  activeViewId: string | null;
  onSelect: (viewId: string | null) => void;
  onCreateNew: () => void;
  onEdit: (view: ModelView) => void;
}

/**
 * Dropdown that lets the user switch between saved views,
 * create a new view, edit the current one, or pick a default.
 *
 * "Default view" (null viewId) means: fall back to fields where show_in_table=true.
 */
export default function ViewSelector({
  modelId,
  views,
  activeViewId,
  onSelect,
  onCreateNew,
  onEdit,
}: ViewSelectorProps) {
  const { t } = useTranslation();
  const { language, currentUserId, users, deleteView, setDefaultView, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ModelView | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const myViews = views.filter((v) => v.user_id === currentUserId);
  const sharedViews = views.filter((v) => v.is_shared && v.user_id !== currentUserId);
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  const activeLabel = activeView
    ? (isAr ? activeView.label_ar : activeView.label_en)
    : t('views.default_view');

  const authorName = (view: ModelView) => {
    const u = users.find((x) => x.id === view.user_id);
    if (!u) return '';
    return isAr ? u.name_ar : u.name_en;
  };

  const handleDelete = () => {
    if (!confirmDelete) return;
    deleteView(confirmDelete.id);
    if (activeViewId === confirmDelete.id) onSelect(null);
    addToast(t('toast.deleted'), 'success');
    setConfirmDelete(null);
  };

  const toggleDefault = (view: ModelView) => {
    if (!currentUserId) return;
    const newId = view.is_default ? null : view.id;
    setDefaultView(modelId, currentUserId, newId);
    addToast(t('toast.saved'), 'success');
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 bg-white px-3 py-2 rounded-lg border border-sand/40 text-sm text-charcoal hover:border-copper/40 hover:bg-copper/[0.03] transition-colors"
        title={t('views.current_view')}
      >
        <Eye size={14} className="text-charcoal/50" />
        <span className="font-bold max-w-[12rem] truncate">{activeLabel}</span>
        {activeView?.is_default && <Star size={12} className="text-copper fill-copper" />}
        <ChevronDown size={14} className="text-charcoal/40" />
      </button>

      {open && (
        <div
          className={`absolute top-full mt-1 ${isAr ? 'right-0' : 'left-0'} z-20 w-80 bg-white rounded-xl shadow-lg border border-sand/40 py-2 max-h-[28rem] overflow-y-auto`}
        >
          {/* Default option — show_in_table fallback */}
          <button
            onClick={() => { onSelect(null); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-cream ${activeViewId === null ? 'bg-copper/[0.05] text-copper font-bold' : 'text-charcoal'}`}
          >
            {activeViewId === null ? <Check size={14} /> : <span className="w-3.5" />}
            <span className="flex-1 text-start">{t('views.default_view')}</span>
          </button>

          {/* My views */}
          {myViews.length > 0 && (
            <>
              <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-charcoal/40 font-bold flex items-center gap-1">
                <Lock size={10} />
                {t('views.my_views')}
              </div>
              {myViews.map((v) => (
                <ViewRow
                  key={v.id}
                  view={v}
                  isAr={isAr}
                  active={activeViewId === v.id}
                  canEdit
                  onSelect={() => { onSelect(v.id); setOpen(false); }}
                  onEdit={() => { setOpen(false); onEdit(v); }}
                  onDelete={() => setConfirmDelete(v)}
                  onToggleDefault={() => toggleDefault(v)}
                />
              ))}
            </>
          )}

          {/* Shared views */}
          {sharedViews.length > 0 && (
            <>
              <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-charcoal/40 font-bold flex items-center gap-1">
                <Users size={10} />
                {t('views.shared_views')}
              </div>
              {sharedViews.map((v) => (
                <ViewRow
                  key={v.id}
                  view={v}
                  isAr={isAr}
                  active={activeViewId === v.id}
                  canEdit={false}
                  authorName={authorName(v)}
                  onSelect={() => { onSelect(v.id); setOpen(false); }}
                />
              ))}
            </>
          )}

          <div className="border-t border-sand/40 mt-2 pt-1">
            <button
              onClick={() => { setOpen(false); onCreateNew(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-copper hover:bg-copper/[0.05] font-bold"
            >
              <Plus size={14} />
              {t('views.save_as_new')}
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-4" onClick={() => setConfirmDelete(null)}>
          <div
            className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-charcoal mb-2">{t('views.delete_view')}</h3>
            <p className="text-sm text-charcoal/70 mb-4">{t('views.delete_view_confirm')}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-lg text-sm font-bold text-charcoal hover:bg-cream"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-red-500 text-white hover:bg-red-600"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ViewRow({
  view,
  isAr,
  active,
  canEdit,
  authorName,
  onSelect,
  onEdit,
  onDelete,
  onToggleDefault,
}: {
  view: ModelView;
  isAr: boolean;
  active: boolean;
  canEdit: boolean;
  authorName?: string;
  onSelect: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onToggleDefault?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`group flex items-center gap-1.5 px-3 py-1.5 hover:bg-cream cursor-pointer text-sm ${active ? 'bg-copper/[0.05]' : ''}`}
      onClick={onSelect}
    >
      {active ? <Check size={14} className="text-copper" /> : <span className="w-3.5" />}
      <div className="flex-1 min-w-0">
        <div className={`truncate ${active ? 'font-bold text-copper' : 'text-charcoal'}`}>
          {isAr ? view.label_ar : view.label_en}
        </div>
        {authorName && (
          <div className="text-[10px] text-charcoal/40 truncate">
            {t('views.shared_by')} {authorName}
          </div>
        )}
      </div>
      {view.is_default && <Star size={11} className="text-copper fill-copper shrink-0" />}
      {view.is_shared && canEdit && <Users size={11} className="text-charcoal/40 shrink-0" />}

      {canEdit && (
        // Always visible (not hover-gated) so edit / delete / set-default are
        // discoverable — in a dropdown (especially RTL) hover-only controls
        // read as "missing". Muted at rest, full-strength on row hover.
        <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
          {onToggleDefault && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleDefault(); }}
              className="p-1 rounded hover:bg-white text-charcoal/40 hover:text-copper"
              title={view.is_default ? t('views.clear_default') : t('views.set_as_default')}
            >
              <Star size={12} className={view.is_default ? 'fill-copper text-copper' : ''} />
            </button>
          )}
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="p-1 rounded hover:bg-white text-charcoal/40 hover:text-copper"
              title={t('common.edit')}
            >
              <Pencil size={12} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-1 rounded hover:bg-white text-charcoal/40 hover:text-red-500"
              title={t('common.delete')}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
