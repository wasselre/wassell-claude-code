import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderPlus, FolderUp, Loader2, Upload } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { FileRow, FolderRow } from '@/types';
import {
  deleteFile,
  deleteFolder,
  getFolder,
  listFiles,
  listFolders,
  listSharedWithMe,
  renameFile,
  renameFolder,
  signDownloadUrl,
} from '@/lib/files/client';
import FilesTabs from './components/FilesTabs';
import FilesBreadcrumb from './components/FilesBreadcrumb';
import FolderTile from './components/FolderTile';
import FileCard from './components/FileCard';
import UploadDropzone from './components/UploadDropzone';
import FilePreviewModal from './components/FilePreviewModal';
import ShareLinkModal from './components/ShareLinkModal';
import PermissionsPanel, { type PermissionTarget } from './components/PermissionsPanel';
import MoveToFolderModal from './components/MoveToFolderModal';
import CreateFolderModal from './components/CreateFolderModal';
import BulkActionBar from './components/BulkActionBar';
import BulkMoveModal from './components/BulkMoveModal';
import { clickMode, useFilesSelection, type SelectableItem } from './useFilesSelection';

type View = 'mine' | 'shared' | 'folder';

interface Props {
  /** 'shared' tab when forced by the route /files/shared. Otherwise the URL
   *  param :folderId may be present for inside-folder view. */
  forceShared?: boolean;
}

export default function FilesPage({ forceShared = false }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const navigate = useNavigate();
  const { folderId: folderIdParam } = useParams();

  const view: View = forceShared ? 'shared' : folderIdParam ? 'folder' : 'mine';

  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  /** Cache of all folders we've ever seen — used by breadcrumb to walk parents. */
  const [folderCache, setFolderCache] = useState<FolderRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Modal state
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const [shareFile, setShareFile] = useState<FileRow | null>(null);
  const [permsTarget, setPermsTarget] = useState<PermissionTarget | null>(null);
  const [moveFile, setMoveFile] = useState<FileRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<FolderRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** Inline file-rename modal — mirrors the folder rename flow above so a
   *  user can rename via the FileCard kebab without entering the preview. */
  const [renamingFileRow, setRenamingFileRow] = useState<FileRow | null>(null);
  const [renameFileValue, setRenameFileValue] = useState('');
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const currentFolderId = view === 'folder' ? folderIdParam ?? null : null;

  // ─── Selection state ─────────────────────────────────────────────────
  const selection = useFilesSelection({ folders, files });

  // Clear selection whenever the view or folder changes — selected ids from a
  // previous folder are meaningless here.
  useEffect(() => {
    selection.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentFolderId]);

  // ─── Marquee (rubber-band) selection ────────────────────────────────
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Marquee rectangle in viewport coords (null = not active).
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Selection snapshot at mousedown, so additive/toggle modes can compute
   *  the union or symmetric difference live as the rectangle changes. */
  const baseSelectionRef = useRef<{ folders: Set<string>; files: Set<string> }>({
    folders: new Set(),
    files: new Set(),
  });
  const marqueeOriginRef = useRef<{ x: number; y: number } | null>(null);
  const marqueeModeRef = useRef<'replace' | 'add' | 'toggle'>('replace');

  /** Hit-test every [data-selectable-id] under the grid container against the
   *  current rectangle. Returns the items whose bbox intersects. */
  const hitTest = useCallback((rect: { x: number; y: number; w: number; h: number }): SelectableItem[] => {
    const root = gridRef.current;
    if (!root) return [];
    const nodes = root.querySelectorAll<HTMLElement>('[data-selectable-id]');
    const hits: SelectableItem[] = [];
    const rL = rect.x;
    const rT = rect.y;
    const rR = rect.x + rect.w;
    const rB = rect.y + rect.h;
    nodes.forEach((el) => {
      const b = el.getBoundingClientRect();
      const intersects = !(b.right < rL || b.left > rR || b.bottom < rT || b.top > rB);
      if (intersects) {
        const id = el.getAttribute('data-selectable-id');
        const kind = el.getAttribute('data-selectable-kind') as 'folder' | 'file' | null;
        if (id && (kind === 'folder' || kind === 'file')) {
          hits.push({ kind, id });
        }
      }
    });
    return hits;
  }, []);

  const onGridMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // left button only
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Don't start a marquee on a card, button, link, or any interactive elt.
      if (target.closest('[data-selectable-id], button, a, input, textarea, [role="button"], [data-no-marquee]')) {
        return;
      }
      // Mode based on modifier keys at mousedown.
      const mode: 'replace' | 'add' | 'toggle' = e.shiftKey
        ? 'add'
        : e.ctrlKey || e.metaKey
        ? 'toggle'
        : 'replace';
      marqueeModeRef.current = mode;
      baseSelectionRef.current = {
        folders: new Set(selection.selectedFolderIds),
        files: new Set(selection.selectedFileIds),
      };
      if (mode === 'replace') {
        // Pre-clear so blank-drag visually starts from zero.
        selection.clear();
      }
      marqueeOriginRef.current = { x: e.clientX, y: e.clientY };
      setMarquee({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    },
    [selection],
  );

  // Window-level mousemove / mouseup so the drag survives the cursor leaving
  // the grid. We attach only when an origin exists.
  useEffect(() => {
    if (!marquee) return;
    const onMove = (e: MouseEvent) => {
      const origin = marqueeOriginRef.current;
      if (!origin) return;
      const x = Math.min(origin.x, e.clientX);
      const y = Math.min(origin.y, e.clientY);
      const w = Math.abs(e.clientX - origin.x);
      const h = Math.abs(e.clientY - origin.y);
      const rect = { x, y, w, h };
      setMarquee(rect);
      // Live update selection inside the rectangle.
      const hits = hitTest(rect);
      const mode = marqueeModeRef.current;
      if (mode === 'replace') {
        selection.replace(hits);
      } else if (mode === 'add') {
        // Union of base + hits.
        const base = baseSelectionRef.current;
        const fo = new Set(base.folders);
        const fi = new Set(base.files);
        hits.forEach((h) => (h.kind === 'folder' ? fo.add(h.id) : fi.add(h.id)));
        selection.replace([
          ...Array.from(fo).map((id) => ({ kind: 'folder' as const, id })),
          ...Array.from(fi).map((id) => ({ kind: 'file' as const, id })),
        ]);
      } else {
        // toggle — symmetric difference of base and hits.
        const base = baseSelectionRef.current;
        const fo = new Set(base.folders);
        const fi = new Set(base.files);
        hits.forEach((h) => {
          const set = h.kind === 'folder' ? fo : fi;
          if (set.has(h.id)) set.delete(h.id);
          else set.add(h.id);
        });
        selection.replace([
          ...Array.from(fo).map((id) => ({ kind: 'folder' as const, id })),
          ...Array.from(fi).map((id) => ({ kind: 'file' as const, id })),
        ]);
      }
    };
    const onUp = () => {
      marqueeOriginRef.current = null;
      setMarquee(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [marquee, hitTest, selection]);

  // Click on empty grid background (mouseup with no drag) → clear selection.
  // We treat a marquee with zero size as a "click on background."
  const onGridClickBackground = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-selectable-id], button, a, input, textarea, [role="button"], [data-no-marquee]')) {
        return;
      }
      if (selection.totalSelected > 0) selection.clear();
    },
    [selection],
  );

  // Load contents whenever the view or folder id changes.
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      if (view === 'shared') {
        const { folders: sf, files: ff } = await listSharedWithMe();
        setFolders(sf);
        setFiles(ff);
        setFolderCache((cache) => mergeUniqueById(cache, sf));
      } else {
        const [fs, ff] = await Promise.all([listFolders(currentFolderId), listFiles(currentFolderId)]);
        setFolders(fs);
        setFiles(ff);
        setFolderCache((cache) => mergeUniqueById(cache, fs));
        // Make sure the current folder itself is in the cache for the breadcrumb.
        if (currentFolderId) {
          const cur = await getFolder(currentFolderId);
          if (cur) setFolderCache((cache) => mergeUniqueById(cache, [cur]));
        }
      }
    } finally {
      setLoading(false);
    }
  }, [view, currentFolderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ─── Permission helpers ───────────────────────────────────────────────

  const canEditFile = useCallback(
    (f: FileRow) => {
      // Direct ownership wins. Folder cascade is enforced by RLS so any file
      // we can see at all is at least viewer-level; we approximate "editor+"
      // here using uploader-ownership. A future round-trip could surface the
      // exact role, but it's a UX cleanup, not a security issue (RLS gates writes).
      return f.uploaded_by_user_id === currentUserId;
    },
    [currentUserId],
  );
  const canDeleteFile = canEditFile;
  const canManageFolder = useCallback(
    (f: FolderRow) => f.created_by_user_id === currentUserId,
    [currentUserId],
  );

  // ─── Handlers ────────────────────────────────────────────────────────

  const onPreview = (f: FileRow) => setPreviewFile(f);
  const onShare = (f: FileRow) => setShareFile(f);
  const onPermissionsFile = (f: FileRow) => setPermsTarget({ kind: 'file', row: f });
  const onPermissionsFolder = (f: FolderRow) => setPermsTarget({ kind: 'folder', row: f });
  const onMove = (f: FileRow) => setMoveFile(f);
  const onDownload = async (f: FileRow) => {
    try {
      const { url } = await signDownloadUrl(f.id);
      window.location.href = url;
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };
  const onDeleteFile = async (f: FileRow) => {
    if (!window.confirm(t('files.delete.confirm', { name: f.original_name }))) return;
    try {
      await deleteFile(f.id);
      addToast(t('toast.deleted'), 'success');
      setPreviewFile(null);
      await reload();
    } catch {
      // surfaceError already toasted
    }
  };
  const onDeleteFolder = async (folder: FolderRow) => {
    if (!window.confirm(t('files.delete.confirm', { name: folder.name }))) return;
    try {
      await deleteFolder(folder.id);
      addToast(t('toast.deleted'), 'success');
      await reload();
    } catch {
      /* surfaced */
    }
  };
  const onRenameStart = (folder: FolderRow) => {
    setRenamingFolder(folder);
    setRenameValue(folder.name);
  };
  const onRenameCommit = async () => {
    if (!renamingFolder) return;
    const next = renameValue.trim();
    if (!next || next === renamingFolder.name) {
      setRenamingFolder(null);
      return;
    }
    try {
      await renameFolder(renamingFolder.id, next);
      setRenamingFolder(null);
      await reload();
    } catch {
      /* surfaced */
    }
  };
  const onRenameFileStart = (f: FileRow) => {
    setRenamingFileRow(f);
    setRenameFileValue(f.original_name);
  };
  const onRenameFileCommit = async () => {
    if (!renamingFileRow) return;
    const next = renameFileValue.trim();
    if (!next || next === renamingFileRow.original_name) {
      setRenamingFileRow(null);
      return;
    }
    try {
      const updated = await renameFile(renamingFileRow.id, next);
      setFiles((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
      // If this file is also open in the preview, keep them in sync.
      setPreviewFile((cur) => (cur?.id === updated.id ? updated : cur));
      setRenamingFileRow(null);
    } catch {
      /* surfaced */
    }
  };

  // ─── Bulk action handlers ───────────────────────────────────────────
  const selectedFiles = useMemo(
    () => files.filter((f) => selection.selectedFileIds.has(f.id)),
    [files, selection.selectedFileIds],
  );
  const selectedFolders = useMemo(
    () => folders.filter((f) => selection.selectedFolderIds.has(f.id)),
    [folders, selection.selectedFolderIds],
  );
  const deletableSelected = useMemo(() => {
    const f = selectedFiles.filter((x) => canDeleteFile(x));
    const fo = selectedFolders.filter((x) => canManageFolder(x));
    return { files: f, folders: fo, total: f.length + fo.length };
  }, [selectedFiles, selectedFolders, canDeleteFile, canManageFolder]);
  const movableFiles = useMemo(
    () => selectedFiles.filter((x) => canEditFile(x)),
    [selectedFiles, canEditFile],
  );

  const onBulkDownload = useCallback(async () => {
    if (selectedFiles.length === 0) return;
    addToast(t('files.bulk.download_started', { count: selectedFiles.length }), 'success');
    // Sequential to keep server signed-URL rate limits sane and to make sure
    // each download attaches its own filename header before we navigate to
    // the next. Open each in a new tab so the browser handles the download.
    for (const f of selectedFiles) {
      try {
        const { url } = await signDownloadUrl(f.id);
        // Open new tab — the response has Content-Disposition: attachment so
        // the browser kicks off a download without navigating away.
        window.open(url, '_blank', 'noopener');
      } catch {
        // surfaceError already toasted; continue with the rest.
      }
    }
  }, [selectedFiles, addToast, t]);

  const onBulkDelete = useCallback(async () => {
    if (deletableSelected.total === 0) {
      addToast(t('files.bulk.no_deletable'), 'error');
      return;
    }
    if (!window.confirm(t('files.bulk.delete_confirm', { count: deletableSelected.total }))) return;
    setBulkBusy(true);
    let ok = 0;
    const total = deletableSelected.total;
    // Files first, then folders (folders may become empty after files inside
    // them get removed by a future folder-bulk-delete extension; harmless now).
    for (const f of deletableSelected.files) {
      try {
        await deleteFile(f.id);
        ok += 1;
      } catch {
        /* toasted */
      }
    }
    for (const folder of deletableSelected.folders) {
      try {
        await deleteFolder(folder.id);
        ok += 1;
      } catch {
        /* toasted (typically "Folder is not empty") */
      }
    }
    setBulkBusy(false);
    addToast(t('files.bulk.delete_summary', { ok, total }), ok === total ? 'success' : 'error');
    selection.clear();
    await reload();
  }, [deletableSelected, addToast, t, selection, reload]);

  const onBulkMove = useCallback(() => {
    if (movableFiles.length === 0) {
      addToast(t('files.bulk.no_movable'), 'error');
      return;
    }
    setBulkMoveOpen(true);
  }, [movableFiles, addToast, t]);

  // ─── Existing folder names for create dedupe ────────────────────────
  const existingNames = useMemo(() => folders.map((f) => f.name), [folders]);

  // ─── Upload enabled? ────────────────────────────────────────────────
  // In "Shared with me" root we have no destination folder, so picker is off.
  const uploadEnabled = view !== 'shared';

  const onUploaded = (rows: FileRow[], folders: FolderRow[]) => {
    // Refresh from server so child-folder content + ancestor caches stay
    // consistent (a folder-tree upload can create folders we don't yet
    // show in this view's grid).
    if (folders.length > 0) {
      setFolderCache((cache) => mergeUniqueById(cache, folders));
    }
    if (rows.length > 0 || folders.length > 0) {
      void reload();
    }
    const fileCount = rows.length;
    const folderCount = folders.length;
    if (folderCount > 0) {
      addToast(
        isAr
          ? `${fileCount} ملف · ${folderCount} مجلد`
          : `${fileCount} file(s) · ${folderCount} folder(s)`,
        'success',
      );
    } else if (fileCount > 0) {
      addToast(`${fileCount} ${isAr ? 'ملف' : 'file(s)'}`, 'success');
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-3">{t('files.title')}</h1>
          <FilesTabs />
        </div>
        <div className="flex items-center gap-2">
          {uploadEnabled && (
            <>
              <button
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream font-bold text-sm transition-colors"
              >
                <FolderPlus size={16} />
                {t('files.new_folder.button')}
              </button>
              <button
                onClick={() => window.dispatchEvent(new Event('files:open-folder-picker'))}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream font-bold text-sm transition-colors"
                title={t('files.upload.folder_tooltip')}
              >
                <FolderUp size={16} />
                {t('files.upload.folder_button')}
              </button>
              <button
                onClick={() => window.dispatchEvent(new Event('files:open-picker'))}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta font-bold text-sm transition-colors shadow-sm shadow-copper/20"
              >
                <Upload size={16} />
                {t('files.upload.button')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Breadcrumb (folder view only) */}
      {view === 'folder' && (
        <div className="mb-4">
          <FilesBreadcrumb folders={folderCache} currentFolderId={currentFolderId} />
        </div>
      )}

      {/* Bulk action bar (only when selection is non-empty) */}
      <BulkActionBar
        count={selection.totalSelected}
        deletableCount={deletableSelected.total}
        movableFileCount={movableFiles.length}
        fileCount={selectedFiles.length}
        onClear={selection.clear}
        onDelete={onBulkDelete}
        onMove={onBulkMove}
        onDownload={onBulkDownload}
      />

      {/* Content */}
      {loading ? (
        <div className="py-20 flex justify-center">
          <Loader2 size={28} className="animate-spin text-copper" />
        </div>
      ) : folders.length === 0 && files.length === 0 ? (
        <EmptyState view={view} onUpload={() => window.dispatchEvent(new Event('files:open-picker'))} uploadEnabled={uploadEnabled} />
      ) : (
        <div
          ref={gridRef}
          onMouseDown={onGridMouseDown}
          onClick={onGridClickBackground}
          className="space-y-6 relative select-none"
          style={bulkBusy ? { pointerEvents: 'none', opacity: 0.7 } : undefined}
        >
          {folders.length > 0 && (
            <section>
              <h2 className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-3">
                {isAr ? 'المجلدات' : 'Folders'}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {folders.map((f) => (
                  <FolderTile
                    key={f.id}
                    folder={f}
                    shared={view === 'shared' || f.created_by_user_id !== currentUserId}
                    canManage={canManageFolder(f)}
                    selected={selection.isSelected('folder', f.id)}
                    selectionActive={selection.totalSelected > 0}
                    onSelectClick={(e) => selection.onItemClick({ kind: 'folder', id: f.id }, clickMode(e))}
                    onToggleCheckbox={(e) => {
                      e.stopPropagation();
                      selection.toggleMany([{ kind: 'folder', id: f.id }]);
                    }}
                    onRename={onRenameStart}
                    onPermissions={onPermissionsFolder}
                    onDelete={onDeleteFolder}
                  />
                ))}
              </div>
            </section>
          )}

          {files.length > 0 && (
            <section>
              <h2 className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-3">
                {isAr ? 'الملفات' : 'Files'}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {files.map((f) => (
                  <FileCard
                    key={f.id}
                    file={f}
                    shared={view === 'shared' || f.uploaded_by_user_id !== currentUserId}
                    canEdit={canEditFile(f)}
                    canDelete={canDeleteFile(f)}
                    selected={selection.isSelected('file', f.id)}
                    selectionActive={selection.totalSelected > 0}
                    onSelectClick={(e) => selection.onItemClick({ kind: 'file', id: f.id }, clickMode(e))}
                    onToggleCheckbox={(e) => {
                      e.stopPropagation();
                      selection.toggleMany([{ kind: 'file', id: f.id }]);
                    }}
                    onPreview={onPreview}
                    onDownload={onDownload}
                    onMove={onMove}
                    onShare={onShare}
                    onPermissions={onPermissionsFile}
                    onDelete={onDeleteFile}
                    onRename={onRenameFileStart}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Marquee overlay (drawn at viewport coords so it survives scroll) */}
      {marquee && (marquee.w > 2 || marquee.h > 2) && (
        <div
          aria-hidden
          className="fixed pointer-events-none z-30 border border-copper/70 bg-copper/10 rounded-sm"
          style={{
            left: marquee.x,
            top: marquee.y,
            width: marquee.w,
            height: marquee.h,
          }}
        />
      )}

      {/* Dropzone (renders nothing visible until a drag enters) */}
      <UploadDropzone folderId={currentFolderId} enabled={uploadEnabled} onUploaded={onUploaded} />

      {/* Modals */}
      <CreateFolderModal
        open={createOpen}
        parentFolderId={currentFolderId}
        existingNames={existingNames}
        onClose={() => setCreateOpen(false)}
        onCreated={(folder) => {
          setFolders((prev) => [folder, ...prev]);
          setFolderCache((cache) => mergeUniqueById(cache, [folder]));
        }}
      />
      <FilePreviewModal
        file={previewFile}
        open={!!previewFile}
        canEdit={previewFile ? canEditFile(previewFile) : false}
        canDelete={previewFile ? canDeleteFile(previewFile) : false}
        onClose={() => setPreviewFile(null)}
        onShare={onShare}
        onPermissions={onPermissionsFile}
        onDelete={onDeleteFile}
        onRenamed={(updated) => {
          setPreviewFile(updated);
          setFiles((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
        }}
      />
      <ShareLinkModal file={shareFile} open={!!shareFile} onClose={() => setShareFile(null)} />
      <PermissionsPanel target={permsTarget} open={!!permsTarget} onClose={() => setPermsTarget(null)} />
      <MoveToFolderModal
        file={moveFile}
        open={!!moveFile}
        onClose={() => setMoveFile(null)}
        onMoved={reload}
      />
      <BulkMoveModal
        files={movableFiles}
        open={bulkMoveOpen}
        onClose={() => setBulkMoveOpen(false)}
        onMoved={async () => {
          selection.clear();
          await reload();
        }}
      />

      {/* Inline folder rename modal (cheap one-off) */}
      {renamingFolder && (
        <div
          className="fixed inset-0 z-50 bg-charcoal/40 flex items-center justify-center p-4"
          onClick={() => setRenamingFolder(null)}
        >
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-xl p-5 w-full max-w-sm">
            <h3 className="font-bold text-charcoal mb-3">{t('files.actions.rename')}</h3>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onRenameCommit();
                if (e.key === 'Escape') setRenamingFolder(null);
              }}
              className="w-full px-3 py-2 rounded-lg border border-sand/40 mb-4 focus:outline-none focus:ring-2 focus:ring-copper/30"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRenamingFolder(null)}
                className="px-4 py-2 rounded-xl bg-transparent text-charcoal/70 hover:bg-cream text-sm font-bold"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={onRenameCommit}
                className="px-4 py-2 rounded-xl bg-copper text-white hover:bg-terracotta text-sm font-bold"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inline file rename modal (same pattern as folder rename above) */}
      {renamingFileRow && (
        <div
          className="fixed inset-0 z-50 bg-charcoal/40 flex items-center justify-center p-4"
          onClick={() => setRenamingFileRow(null)}
        >
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-xl p-5 w-full max-w-sm">
            <h3 className="font-bold text-charcoal mb-3">{t('files.actions.rename')}</h3>
            <input
              autoFocus
              value={renameFileValue}
              onChange={(e) => setRenameFileValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onRenameFileCommit();
                if (e.key === 'Escape') setRenamingFileRow(null);
              }}
              dir="auto"
              className="w-full px-3 py-2 rounded-lg border border-sand/40 mb-4 focus:outline-none focus:ring-2 focus:ring-copper/30"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRenamingFileRow(null)}
                className="px-4 py-2 rounded-xl bg-transparent text-charcoal/70 hover:bg-cream text-sm font-bold"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={onRenameFileCommit}
                className="px-4 py-2 rounded-xl bg-copper text-white hover:bg-terracotta text-sm font-bold"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navigate (a no-op placeholder so the import is used when needed in future) */}
      <span hidden onClick={() => navigate('/files')} />
    </div>
  );
}

interface EmptyProps {
  view: View;
  uploadEnabled: boolean;
  onUpload: () => void;
}

function EmptyState({ view, uploadEnabled, onUpload }: EmptyProps) {
  const { t } = useTranslation();
  const message =
    view === 'shared'
      ? t('files.empty.shared_with_me')
      : view === 'folder'
      ? t('files.empty.folder')
      : t('files.empty.my_files');
  return (
    <div className="py-20 flex flex-col items-center justify-center text-center">
      <div className="w-20 h-20 rounded-3xl bg-cream flex items-center justify-center mb-4">
        <Upload size={32} className="text-copper" />
      </div>
      <p className="text-charcoal/60 max-w-md mb-5">{message}</p>
      {uploadEnabled && (
        <button
          onClick={onUpload}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta font-bold text-sm transition-colors"
        >
          <Upload size={16} />
          {t('files.upload.button')}
        </button>
      )}
    </div>
  );
}

function mergeUniqueById<T extends { id: string }>(a: T[], b: T[]): T[] {
  const map = new Map<string, T>();
  [...a, ...b].forEach((item) => map.set(item.id, item));
  return Array.from(map.values());
}
