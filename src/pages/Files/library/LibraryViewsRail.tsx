/**
 * Phase 3 · B5 — the views rail.
 *
 * Two lists, and the visual difference between them is deliberate: the six
 * SYSTEM views are always there and cannot be edited; SAVED views belong to a
 * person and carry a delete affordance only for their author.
 *
 * A failed load of the saved views must NOT render as "you have no saved
 * views" — that is the empty-vs-broken trap this batch is under orders to
 * avoid. The rail therefore takes an explicit `error` and shows a retry.
 */
import { useTranslation } from 'react-i18next';
import {
  AlarmClock, AlertCircle, Bookmark, Clock, FolderOpen, Loader2, Megaphone,
  Trash2, Unlink, User as UserIcon, type LucideIcon,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { FileViewRow } from '@/types';
import { SYSTEM_VIEWS, type SystemView } from '@/lib/files/views';

const ICONS: Record<SystemView['icon'], LucideIcon> = {
  unlink: Unlink,
  clock: Clock,
  user: UserIcon,
  folder: FolderOpen,
  megaphone: Megaphone,
  alarm: AlarmClock,
};

interface Props {
  activeView: string | null;
  onOpenSystem: (key: string) => void;
  onOpenSaved: (row: FileViewRow) => void;
  savedViews: FileViewRow[];
  savedLoading: boolean;
  savedError: string | null;
  onRetrySaved: () => void;
  onDeleteSaved: (row: FileViewRow) => void;
  onSaveCurrent: () => void;
  /** True when the current query differs from every view — enables "Save". */
  canSaveCurrent: boolean;
}

export default function LibraryViewsRail({
  activeView, onOpenSystem, onOpenSaved, savedViews, savedLoading, savedError,
  onRetrySaved, onDeleteSaved, onSaveCurrent, canSaveCurrent,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const currentUserId = useAppStore((s) => s.currentUserId);

  const itemClass = (active: boolean) =>
    `w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-start transition-colors ${
      active ? 'bg-copper/10 text-copper font-bold' : 'text-charcoal/70 hover:bg-cream'
    }`;

  return (
    <nav className="space-y-5" aria-label={t('files.library.views')}>
      <div>
        <h2 className="px-3 mb-1.5 text-[10px] font-bold uppercase tracking-widest text-charcoal/35">
          {t('files.library.views')}
        </h2>
        <button
          type="button"
          onClick={() => onOpenSystem('')}
          className={itemClass(activeView === null || activeView === '')}
        >
          <Bookmark size={15} aria-hidden />
          <span className="flex-1 truncate">{t('files.library.all_files')}</span>
        </button>
        {SYSTEM_VIEWS.map((v) => {
          const Icon = ICONS[v.icon];
          // A view that needs to know who you are is offered only when the app
          // has bound a user row. Showing "My files" to an unbound session
          // would silently mean "everyone's files", which is a worse answer
          // than not offering it.
          if (v.requiresUser && !currentUserId) return null;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => onOpenSystem(v.key)}
              className={itemClass(activeView === v.key)}
              title={isAr ? v.hint_ar : v.hint_en}
            >
              <Icon size={15} aria-hidden />
              <span className="flex-1 truncate" dir="auto">{isAr ? v.label_ar : v.label_en}</span>
            </button>
          );
        })}
      </div>

      <div>
        <div className="px-3 mb-1.5 flex items-center justify-between gap-2">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-charcoal/35">
            {t('files.library.saved_views')}
          </h2>
          {savedLoading && <Loader2 size={11} className="animate-spin text-charcoal/30" aria-hidden />}
        </div>

        {savedError ? (
          <div className="mx-1 p-3 rounded-xl bg-red-500/5 border border-red-500/20" role="alert">
            <p className="flex items-start gap-2 text-xs text-red-700">
              <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden />
              <span>{t('files.library.saved_views_failed')}</span>
            </p>
            <button
              type="button"
              onClick={onRetrySaved}
              className="mt-2 px-2.5 py-1 rounded-lg bg-white border border-red-500/25 text-xs font-bold text-red-700 hover:bg-red-500/10"
            >
              {t('files.library.retry')}
            </button>
          </div>
        ) : savedViews.length === 0 ? (
          !savedLoading && (
            <p className="px-3 text-xs text-charcoal/40">{t('files.library.no_saved_views')}</p>
          )
        ) : (
          savedViews.map((row) => {
            const mine = row.owner_user_id === currentUserId;
            return (
              <div key={row.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onOpenSaved(row)}
                  className={itemClass(activeView === `saved:${row.id}`)}
                >
                  <Bookmark size={15} aria-hidden className={row.pinned ? 'fill-current' : undefined} />
                  <span className="flex-1 truncate" dir="auto">{row.name}</span>
                  {row.visibility === 'shared' && (
                    <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-charcoal/10 text-charcoal/50 uppercase">
                      {t('files.library.shared')}
                    </span>
                  )}
                </button>
                {/* Only the author may delete — RLS enforces it, this is the
                    affordance that stops a colleague trying and being refused. */}
                {mine && (
                  <button
                    type="button"
                    onClick={() => onDeleteSaved(row)}
                    aria-label={t('files.library.delete_view', { name: row.name })}
                    className="absolute top-1/2 -translate-y-1/2 end-2 p-1 rounded-md text-charcoal/0 group-hover:text-charcoal/40 hover:!text-red-600 hover:bg-red-500/10 transition-colors"
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                )}
              </div>
            );
          })
        )}

        <button
          type="button"
          onClick={onSaveCurrent}
          disabled={!canSaveCurrent}
          className="mt-2 w-full px-3 py-2 rounded-xl border border-dashed border-sand/60 text-xs font-bold text-charcoal/55 hover:bg-cream hover:text-copper disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {t('files.library.save_current_view')}
        </button>
      </div>
    </nav>
  );
}
