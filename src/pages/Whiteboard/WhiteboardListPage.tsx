import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SquarePen, FolderPlus, Plus, Folder, MoreVertical, Trash2, Pencil, FolderInput } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { Whiteboard, WhiteboardFolder } from '@/types';
import PromptModal from './components/PromptModal';
import ConfirmModal from './components/ConfirmModal';

/**
 * Dialog state machine — kept in a single piece of state instead of N
 * booleans so it's impossible to have, say, both rename and delete open
 * at once. Each variant carries the data its modal needs.
 */
type Dialog =
  | null
  | { kind: 'new-folder' }
  | { kind: 'new-board'; folderId: string | null }
  | { kind: 'rename-board'; board: Whiteboard }
  | { kind: 'rename-folder'; folder: WhiteboardFolder }
  | { kind: 'delete-board'; board: Whiteboard }
  | { kind: 'delete-folder'; folder: WhiteboardFolder };

/**
 * Whiteboard hub — flat folder list + boards inside.
 *
 * The user creates folders and boards here and jumps into a board to draw.
 * Nothing fancy: a vertical stack of folder sections (plus an "Unfiled"
 * bucket for boards without a folder) with a card per board. Each card
 * has a 3-dot menu for rename / move / delete. Create is via native
 * `prompt()` dialogs to keep this page slim — upgrade to a proper modal
 * later if the team wants richer metadata (description, icon, etc.).
 */

function formatRelative(iso: string, isAr: boolean): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return isAr ? 'قبل لحظات' : 'moments ago';
  if (mins < 60) return isAr ? `قبل ${mins} دقيقة` : `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return isAr ? `قبل ${hrs} ساعة` : `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  return isAr ? `قبل ${days} يوم` : `${days} d ago`;
}

function BoardCard({
  board,
  folders,
  isAr,
  onOpen,
  onRename,
  onDelete,
  onMove,
}: {
  board: Whiteboard;
  folders: WhiteboardFolder[];
  isAr: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMove: (folderId: string | null) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onOpen}
        className="card p-5 w-full flex items-start gap-3 hover:border-copper/40 transition-all text-start"
      >
        <div className="w-10 h-10 rounded-lg bg-copper/10 flex items-center justify-center shrink-0">
          <SquarePen size={18} className="text-copper" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-charcoal truncate">{board.name}</h3>
          <p className="text-xs text-charcoal/50 mt-1">{formatRelative(board.updated_at, isAr)}</p>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
          setMoveOpen(false);
        }}
        className="absolute top-3 end-3 p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-cream text-charcoal/40 hover:text-charcoal transition-all"
        aria-label={isAr ? 'خيارات' : 'Options'}
      >
        <MoreVertical size={16} />
      </button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setMenuOpen(false); setMoveOpen(false); }} />
          <div className="absolute top-12 end-3 z-20 bg-white border border-sand/40 rounded-xl shadow-lg py-1 min-w-[180px]">
            {!moveOpen ? (
              <>
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); onRename(); }}
                  className="w-full text-start px-3 py-2 text-sm hover:bg-cream flex items-center gap-2"
                >
                  <Pencil size={14} />
                  {isAr ? 'إعادة تسمية' : 'Rename'}
                </button>
                <button
                  type="button"
                  onClick={() => setMoveOpen(true)}
                  className="w-full text-start px-3 py-2 text-sm hover:bg-cream flex items-center gap-2"
                >
                  <FolderInput size={14} />
                  {isAr ? 'نقل إلى مجلد' : 'Move to folder'}
                </button>
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); onDelete(); }}
                  className="w-full text-start px-3 py-2 text-sm hover:bg-red-50 text-red-600 flex items-center gap-2"
                >
                  <Trash2 size={14} />
                  {isAr ? 'حذف' : 'Delete'}
                </button>
              </>
            ) : (
              <>
                <div className="px-3 py-2 text-xs font-bold text-charcoal/40 uppercase tracking-wider">
                  {isAr ? 'نقل إلى' : 'Move to'}
                </div>
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); onMove(null); }}
                  className="w-full text-start px-3 py-2 text-sm hover:bg-cream"
                >
                  {isAr ? '— بدون مجلد —' : '— No folder —'}
                </button>
                {folders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => { setMenuOpen(false); onMove(f.id); }}
                    className="w-full text-start px-3 py-2 text-sm hover:bg-cream flex items-center gap-2"
                  >
                    <Folder size={14} className="text-charcoal/40" />
                    {f.name}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function WhiteboardListPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    whiteboards,
    whiteboardFolders,
    language,
    createWhiteboard,
    createWhiteboardFolder,
    renameWhiteboard,
    renameWhiteboardFolder,
    deleteWhiteboard,
    deleteWhiteboardFolder,
    moveWhiteboard,
  } = useAppStore();
  const isAr = language === 'ar';

  const grouped = useMemo(() => {
    const byFolder: Record<string, Whiteboard[]> = {};
    const unfiled: Whiteboard[] = [];
    for (const b of whiteboards) {
      if (b.folder_id) {
        (byFolder[b.folder_id] ??= []).push(b);
      } else {
        unfiled.push(b);
      }
    }
    const sortFn = (a: Whiteboard, b: Whiteboard) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    Object.values(byFolder).forEach((arr) => arr.sort(sortFn));
    unfiled.sort(sortFn);
    return { byFolder, unfiled };
  }, [whiteboards]);

  const sortedFolders = useMemo(
    () => [...whiteboardFolders].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [whiteboardFolders],
  );

  const [dialog, setDialog] = useState<Dialog>(null);
  const closeDialog = () => setDialog(null);

  const handleNewFolder = () => setDialog({ kind: 'new-folder' });
  const handleNewBoard = (folderId: string | null) =>
    setDialog({ kind: 'new-board', folderId });
  const handleRenameBoard = (board: Whiteboard) =>
    setDialog({ kind: 'rename-board', board });
  const handleDeleteBoard = (board: Whiteboard) =>
    setDialog({ kind: 'delete-board', board });
  const handleRenameFolder = (folder: WhiteboardFolder) =>
    setDialog({ kind: 'rename-folder', folder });
  const handleDeleteFolder = (folder: WhiteboardFolder) =>
    setDialog({ kind: 'delete-folder', folder });

  const submitDialog = (value: string) => {
    if (!dialog) return;
    if (dialog.kind === 'new-folder') {
      createWhiteboardFolder(value);
    } else if (dialog.kind === 'new-board') {
      const board = createWhiteboard(value, dialog.folderId);
      closeDialog();
      navigate(`/whiteboard/${board.id}`);
      return;
    } else if (dialog.kind === 'rename-board') {
      if (value !== dialog.board.name) renameWhiteboard(dialog.board.id, value);
    } else if (dialog.kind === 'rename-folder') {
      if (value !== dialog.folder.name) renameWhiteboardFolder(dialog.folder.id, value);
    }
    closeDialog();
  };

  const confirmDialog = () => {
    if (!dialog) return;
    if (dialog.kind === 'delete-board') {
      deleteWhiteboard(dialog.board.id);
    } else if (dialog.kind === 'delete-folder') {
      deleteWhiteboardFolder(dialog.folder.id);
    }
    closeDialog();
  };

  const folderInsideCount = (folderId: string) => grouped.byFolder[folderId]?.length ?? 0;

  const totalCount = whiteboards.length;
  const isEmpty = totalCount === 0 && sortedFolders.length === 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-charcoal">{t('whiteboard.title')}</h1>
          <p className="text-sm text-charcoal/50 mt-1">
            {isAr
              ? 'لوحات رسم تفاعلية منظمة في مجلدات، يشاركها الفريق.'
              : 'Interactive drawing boards organized into folders, shared with the team.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={handleNewFolder}>
            <FolderPlus size={16} />
            {isAr ? 'مجلد جديد' : 'New folder'}
          </Button>
          <Button onClick={() => handleNewBoard(null)}>
            <Plus size={16} />
            {isAr ? 'لوحة جديدة' : 'New board'}
          </Button>
        </div>
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
          <SquarePen size={48} className="mb-4" />
          <p className="text-lg font-bold">
            {isAr ? 'لا توجد لوحات بعد' : 'No boards yet'}
          </p>
          <p className="text-sm mb-5">
            {isAr ? 'ابدأ بإنشاء لوحة أو مجلد.' : 'Start by creating a board or folder.'}
          </p>
          <Button onClick={() => handleNewBoard(null)}>
            <Plus size={16} />
            {isAr ? 'لوحة جديدة' : 'New board'}
          </Button>
        </div>
      ) : (
        <div className="space-y-8">
          {sortedFolders.map((folder) => {
            const boards = grouped.byFolder[folder.id] ?? [];
            return (
              <section key={folder.id}>
                <div className="flex items-center gap-2 mb-3">
                  <Folder size={18} className="text-charcoal/40" />
                  <h2 className="font-bold text-charcoal">{folder.name}</h2>
                  <span className="text-xs text-charcoal/40">
                    {boards.length} {isAr ? 'لوحة' : boards.length === 1 ? 'board' : 'boards'}
                  </span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => handleNewBoard(folder.id)}
                    className="text-xs text-copper hover:text-terracotta font-bold flex items-center gap-1"
                  >
                    <Plus size={12} />
                    {isAr ? 'لوحة هنا' : 'Board here'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRenameFolder(folder)}
                    className="p-1.5 rounded-md hover:bg-cream text-charcoal/40 hover:text-charcoal"
                    aria-label={isAr ? 'إعادة تسمية المجلد' : 'Rename folder'}
                    title={isAr ? 'إعادة تسمية' : 'Rename'}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteFolder(folder)}
                    className="p-1.5 rounded-md hover:bg-red-50 text-charcoal/40 hover:text-red-600"
                    aria-label={isAr ? 'حذف المجلد' : 'Delete folder'}
                    title={isAr ? 'حذف' : 'Delete'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {boards.length === 0 ? (
                  <p className="text-sm text-charcoal/30 italic ps-7">
                    {isAr ? 'لا توجد لوحات في هذا المجلد.' : 'No boards in this folder.'}
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {boards.map((board) => (
                      <BoardCard
                        key={board.id}
                        board={board}
                        folders={sortedFolders}
                        isAr={isAr}
                        onOpen={() => navigate(`/whiteboard/${board.id}`)}
                        onRename={() => handleRenameBoard(board)}
                        onDelete={() => handleDeleteBoard(board)}
                        onMove={(fid) => moveWhiteboard(board.id, fid)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          {grouped.unfiled.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="font-bold text-charcoal/60">
                  {isAr ? 'بدون مجلد' : 'Unfiled'}
                </h2>
                <span className="text-xs text-charcoal/40">
                  {grouped.unfiled.length}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {grouped.unfiled.map((board) => (
                  <BoardCard
                    key={board.id}
                    board={board}
                    folders={sortedFolders}
                    isAr={isAr}
                    onOpen={() => navigate(`/whiteboard/${board.id}`)}
                    onRename={() => handleRenameBoard(board)}
                    onDelete={() => handleDeleteBoard(board)}
                    onMove={(fid) => moveWhiteboard(board.id, fid)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* New folder */}
      <PromptModal
        open={dialog?.kind === 'new-folder'}
        title={isAr ? 'مجلد جديد' : 'New folder'}
        label={isAr ? 'اسم المجلد' : 'Folder name'}
        placeholder={isAr ? 'مثال: المشاريع' : 'e.g. Marketing plans'}
        submitLabel={isAr ? 'إنشاء' : 'Create'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
        onSubmit={submitDialog}
        onClose={closeDialog}
      />

      {/* New board */}
      <PromptModal
        open={dialog?.kind === 'new-board'}
        title={isAr ? 'لوحة جديدة' : 'New board'}
        label={isAr ? 'اسم اللوحة' : 'Board name'}
        placeholder={isAr ? 'مثال: مخطط الموقع' : 'e.g. Site plan'}
        submitLabel={isAr ? 'إنشاء وفتح' : 'Create & open'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
        onSubmit={submitDialog}
        onClose={closeDialog}
      />

      {/* Rename board */}
      <PromptModal
        open={dialog?.kind === 'rename-board'}
        title={isAr ? 'إعادة تسمية اللوحة' : 'Rename board'}
        label={isAr ? 'اسم جديد' : 'New name'}
        initialValue={dialog?.kind === 'rename-board' ? dialog.board.name : ''}
        submitLabel={isAr ? 'حفظ' : 'Save'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
        onSubmit={submitDialog}
        onClose={closeDialog}
      />

      {/* Rename folder */}
      <PromptModal
        open={dialog?.kind === 'rename-folder'}
        title={isAr ? 'إعادة تسمية المجلد' : 'Rename folder'}
        label={isAr ? 'اسم جديد' : 'New name'}
        initialValue={dialog?.kind === 'rename-folder' ? dialog.folder.name : ''}
        submitLabel={isAr ? 'حفظ' : 'Save'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
        onSubmit={submitDialog}
        onClose={closeDialog}
      />

      {/* Delete board */}
      <ConfirmModal
        open={dialog?.kind === 'delete-board'}
        title={isAr ? 'حذف اللوحة؟' : 'Delete board?'}
        message={
          dialog?.kind === 'delete-board'
            ? isAr
              ? `سيتم حذف "${dialog.board.name}" نهائياً.`
              : `"${dialog.board.name}" will be permanently deleted.`
            : ''
        }
        confirmLabel={isAr ? 'حذف' : 'Delete'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
        destructive
        onConfirm={confirmDialog}
        onClose={closeDialog}
      />

      {/* Delete folder */}
      <ConfirmModal
        open={dialog?.kind === 'delete-folder'}
        title={isAr ? 'حذف المجلد؟' : 'Delete folder?'}
        message={(() => {
          if (dialog?.kind !== 'delete-folder') return '';
          const inside = folderInsideCount(dialog.folder.id);
          if (inside === 0) {
            return isAr
              ? `سيتم حذف المجلد "${dialog.folder.name}".`
              : `Folder "${dialog.folder.name}" will be deleted.`;
          }
          return isAr
            ? `سيتم حذف المجلد "${dialog.folder.name}" ونقل ${inside} ${inside === 1 ? 'لوحة' : 'لوحات'} إلى "بدون مجلد".`
            : `Folder "${dialog.folder.name}" will be deleted and ${inside} board${inside === 1 ? '' : 's'} will move to "Unfiled".`;
        })()}
        confirmLabel={isAr ? 'حذف المجلد' : 'Delete folder'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
        destructive
        onConfirm={confirmDialog}
        onClose={closeDialog}
      />
    </div>
  );
}
