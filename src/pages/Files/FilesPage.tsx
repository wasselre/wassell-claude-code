import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderPlus, Loader2, Upload } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { FileRow, FolderRow } from '@/types';
import {
  deleteFile,
  deleteFolder,
  getFolder,
  listFiles,
  listFolders,
  listSharedWithMe,
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

  const currentFolderId = view === 'folder' ? folderIdParam ?? null : null;

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

  // ─── Existing folder names for create dedupe ────────────────────────
  const existingNames = useMemo(() => folders.map((f) => f.name), [folders]);

  // ─── Upload enabled? ────────────────────────────────────────────────
  // In "Shared with me" root we have no destination folder, so picker is off.
  const uploadEnabled = view !== 'shared';

  const onUploaded = (rows: FileRow[]) => {
    setFiles((prev) => [...rows, ...prev]);
    addToast(`${rows.length} ${isAr ? 'ملف' : 'file(s)'}`, 'success');
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

      {/* Content */}
      {loading ? (
        <div className="py-20 flex justify-center">
          <Loader2 size={28} className="animate-spin text-copper" />
        </div>
      ) : folders.length === 0 && files.length === 0 ? (
        <EmptyState view={view} onUpload={() => window.dispatchEvent(new Event('files:open-picker'))} uploadEnabled={uploadEnabled} />
      ) : (
        <div className="space-y-6">
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
                    onPreview={onPreview}
                    onDownload={onDownload}
                    onMove={onMove}
                    onShare={onShare}
                    onPermissions={onPermissionsFile}
                    onDelete={onDeleteFile}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
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
      />
      <ShareLinkModal file={shareFile} open={!!shareFile} onClose={() => setShareFile(null)} />
      <PermissionsPanel target={permsTarget} open={!!permsTarget} onClose={() => setPermsTarget(null)} />
      <MoveToFolderModal
        file={moveFile}
        open={!!moveFile}
        onClose={() => setMoveFile(null)}
        onMoved={reload}
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
