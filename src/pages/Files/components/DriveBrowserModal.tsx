import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  FolderPlus,
  FolderIcon,
  Loader2,
  MoreVertical,
  Pencil,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  createFolder,
  deleteFile,
  deleteFolder,
  getFolder,
  listFiles,
  listFolders,
  renameFile,
  renameFolder,
  signViewUrl,
  uploadFile,
} from '@/lib/files/client';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import { useAppStore } from '@/stores/appStore';
import type { AttachmentRef, FileRow, FolderRow } from '@/types';
import FilePreviewModal from './FilePreviewModal';
import TileMenu from './TileMenu';

export type DrivePickerMode = 'pick-folder' | 'pick-files' | 'pick-files-and-folders';

export type DrivePickerResult =
  | { kind: 'folder'; folderId: string | null }
  | { kind: 'files'; files: FileRow[] }
  | { kind: 'mixed'; refs: AttachmentRef[]; files: FileRow[]; folders: FolderRow[] };

interface Props {
  open: boolean;
  mode: DrivePickerMode;
  /** Folder to open initially. `null` (or undefined) = Drive root. */
  initialFolderId?: string | null;
  /** MIME filter applied to new uploads only (the listing is unfiltered). */
  acceptMime?: string;
  /** Per-file size cap applied to new uploads. */
  maxSizeMb?: number;
  /** When a new file is uploaded inside this modal, tag it with this record. */
  attachToModelId?: string | null;
  attachToRecordId?: string | null;
  /** Optional pre-selected items (carry the existing field value in so the user
   *  sees what's already attached and can deselect). Files-and-folders mode. */
  initialSelectedFileIds?: string[];
  initialSelectedFolderIds?: string[];
  onClose: () => void;
  onSelect: (result: DrivePickerResult) => void;
}

/**
 * Reusable Drive picker. Three modes:
 *
 *  - `pick-folder` — choose ONE folder (or root). Used to ask "where should
 *    this upload land?". Files render but aren't selectable; folders are
 *    selected by clicking the chevron OR confirming on "Save here".
 *
 *  - `pick-files` — multi-select files only. Folders are navigation only.
 *    Used by the `image` / `file` / `multi_image` / `multi_file` field
 *    inputs when adding existing items.
 *
 *  - `pick-files-and-folders` — multi-select both. Used by the
 *    `attachment` field which references files OR folders.
 *
 * Inline Upload and New Folder buttons act on the currently-open folder.
 */
export default function DriveBrowserModal({
  open,
  mode,
  initialFolderId = null,
  acceptMime,
  maxSizeMb = 500,
  attachToModelId = null,
  attachToRecordId = null,
  initialSelectedFileIds = [],
  initialSelectedFolderIds = [],
  onClose,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  // Navigation state — current folder id, plus a breadcrumb chain of names so
  // we don't have to re-query for ancestor labels on each render.
  const [folderId, setFolderId] = useState<string | null>(initialFolderId);
  const [breadcrumb, setBreadcrumb] = useState<Array<{ id: string | null; name: string }>>([]);

  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set(initialSelectedFileIds));
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set(initialSelectedFolderIds));
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // Inline-rename state: which tile is being renamed (kind+id) and the draft.
  const [renamingId, setRenamingId] = useState<{ kind: 'file' | 'folder'; id: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** Full-screen file preview opened from the picker. Stacked above the
   *  picker via the same body-portal; later-rendered → higher in stack. */
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  /** App user id — used to gate per-tile edit/delete to the uploader. */
  const currentUserId = useAppStore((s) => s.currentUserId);
  const canEditFile = useCallback(
    (f: FileRow) => f.uploaded_by_user_id === currentUserId,
    [currentUserId],
  );
  const canManageFolder = useCallback(
    (f: FolderRow) => f.created_by_user_id === currentUserId,
    [currentUserId],
  );

  // Reset the picker when it opens. Carry initial selection in.
  useEffect(() => {
    if (!open) return;
    setFolderId(initialFolderId ?? null);
    setSelectedFileIds(new Set(initialSelectedFileIds));
    setSelectedFolderIds(new Set(initialSelectedFolderIds));
    setCreatingFolder(false);
    setNewFolderName('');
    // We intentionally don't add initial* arrays to the dep list — they're
    // input-time defaults, not reactive props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reload folder contents on navigation. Also rebuild the breadcrumb by
  // walking ancestors. The walk is O(depth) — typically < 5 hops.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [subFolders, contents] = await Promise.all([
        listFolders(folderId),
        listFiles(folderId),
      ]);
      setFolders(subFolders);
      setFiles(contents);

      // Walk up from current folder to root for the breadcrumb. Each hop is
      // one round-trip; for typical libraries this is fine. If we ever need
      // deeper trees we can collapse the walk into a recursive RPC.
      const chain: Array<{ id: string | null; name: string }> = [];
      let cursor: string | null = folderId;
      while (cursor) {
        const row: FolderRow | null = await getFolder(cursor);
        if (!row) break;
        chain.unshift({ id: row.id, name: row.name });
        cursor = row.parent_folder_id;
      }
      setBreadcrumb(chain);
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // Escape handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const showFileSelectors = mode !== 'pick-folder';
  const showFolderSelectors = mode === 'pick-files-and-folders';

  const totalSelected = selectedFileIds.size + selectedFolderIds.size;

  const handleToggleFile = (id: string) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleFolder = (id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    if (mode === 'pick-folder') {
      onSelect({ kind: 'folder', folderId });
      onClose();
      return;
    }
    if (mode === 'pick-files') {
      const chosen = files.filter((f) => selectedFileIds.has(f.id));
      // Also include any pre-selected files from prior folders (we keep their
      // ids in the set even after navigating away). For files we need the
      // FileRow though, so the parent component will have to load missing
      // ones by id. Pass back what we currently have plus the id list.
      onSelect({ kind: 'files', files: chosen });
      onClose();
      return;
    }
    // pick-files-and-folders
    const fileRefs: AttachmentRef[] = Array.from(selectedFileIds).map((id) => ({ type: 'file', id }));
    const folderRefs: AttachmentRef[] = Array.from(selectedFolderIds).map((id) => ({
      type: 'folder',
      id,
    }));
    const chosenFiles = files.filter((f) => selectedFileIds.has(f.id));
    const chosenFolders = folders.filter((f) => selectedFolderIds.has(f.id));
    onSelect({
      kind: 'mixed',
      refs: [...fileRefs, ...folderRefs],
      files: chosenFiles,
      folders: chosenFolders,
    });
    onClose();
  };

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleUploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    const newlyUploaded: FileRow[] = [];
    let errors = 0;
    for (const f of Array.from(fileList)) {
      if (maxSizeMb && f.size > maxSizeMb * 1024 * 1024) {
        addToast(
          `${f.name}: ${isAr ? 'حجم الملف يتجاوز الحد المسموح.' : 'File exceeds size limit.'}`,
          'error',
        );
        errors += 1;
        continue;
      }
      if (acceptMime && !mimeMatches(f.type, acceptMime)) {
        addToast(
          `${f.name}: ${isAr ? 'نوع الملف غير مسموح به.' : 'File type not allowed.'}`,
          'error',
        );
        errors += 1;
        continue;
      }
      try {
        const row = await uploadFile(f, {
          folderId,
          modelId: attachToModelId,
          recordId: attachToRecordId,
        });
        newlyUploaded.push(row);
      } catch {
        // uploadFile already surfaces a toast via the files client.
        errors += 1;
      }
    }
    setUploading(false);
    if (uploadInputRef.current) uploadInputRef.current.value = '';
    if (newlyUploaded.length === 0 && errors > 0) return;
    // Refresh listing so new uploads appear, then auto-select them so the
    // user can hit "Add selected" immediately without re-clicking.
    await refresh();
    if (showFileSelectors) {
      setSelectedFileIds((prev) => {
        const next = new Set(prev);
        for (const row of newlyUploaded) next.add(row.id);
        return next;
      });
    }
  };

  const handleCreateFolderSubmit = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const row = await createFolder(name, folderId);
      setCreatingFolder(false);
      setNewFolderName('');
      await refresh();
      if (showFolderSelectors) {
        setSelectedFolderIds((prev) => new Set(prev).add(row.id));
      }
    } catch {
      // surfaced by client
    }
  };

  // ─── Per-tile edit ops (rename + delete) ─────────────────────────────
  const handleStartRename = (kind: 'file' | 'folder', id: string, currentName: string) => {
    setRenamingId({ kind, id });
    setRenameDraft(currentName);
  };
  const handleCancelRename = () => {
    setRenamingId(null);
    setRenameDraft('');
  };
  const handleCommitRename = async () => {
    if (!renamingId) return;
    const next = renameDraft.trim();
    if (!next) {
      handleCancelRename();
      return;
    }
    try {
      if (renamingId.kind === 'file') {
        const updated = await renameFile(renamingId.id, next);
        setFiles((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
      } else {
        const updated = await renameFolder(renamingId.id, next);
        setFolders((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
      }
      handleCancelRename();
    } catch {
      /* surfaced by client */
    }
  };

  const handleDeleteFile = async (f: FileRow) => {
    const msg = isAr
      ? `حذف "${f.original_name}"؟ لا يمكن التراجع.`
      : `Delete "${f.original_name}"? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    try {
      await deleteFile(f.id);
      setFiles((prev) => prev.filter((x) => x.id !== f.id));
      setSelectedFileIds((prev) => {
        if (!prev.has(f.id)) return prev;
        const next = new Set(prev);
        next.delete(f.id);
        return next;
      });
      // If we were previewing it, close the preview.
      setPreviewFile((cur) => (cur?.id === f.id ? null : cur));
    } catch {
      /* surfaced by client */
    }
  };

  const handleDeleteFolder = async (folder: FolderRow) => {
    const msg = isAr
      ? `حذف "${folder.name}"؟ لا يمكن التراجع.`
      : `Delete "${folder.name}"? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    try {
      await deleteFolder(folder.id);
      setFolders((prev) => prev.filter((x) => x.id !== folder.id));
      setSelectedFolderIds((prev) => {
        if (!prev.has(folder.id)) return prev;
        const next = new Set(prev);
        next.delete(folder.id);
        return next;
      });
    } catch {
      /* surfaced by client (typically "Folder is not empty") */
    }
  };

  const confirmLabel = useMemo(() => {
    if (mode === 'pick-folder') {
      return isAr ? 'احفظ هنا' : 'Save here';
    }
    return `${isAr ? 'إضافة المحددة' : 'Add selected'} (${totalSelected})`;
  }, [mode, isAr, totalSelected]);

  const confirmDisabled = mode !== 'pick-folder' && totalSelected === 0;

  const ArrowBack = isAr ? ChevronRight : ChevronLeft;

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-charcoal/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-sand/40">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-charcoal mb-1.5">
              {mode === 'pick-folder' && t('fields.attachment.choose_destination')}
              {mode === 'pick-files' && t('fields.attachment.pick_files')}
              {mode === 'pick-files-and-folders' && t('fields.attachment.pick_files_and_folders')}
            </h2>
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 text-xs text-charcoal/60 flex-wrap">
              <button
                type="button"
                onClick={() => setFolderId(null)}
                className={`px-1.5 py-0.5 rounded hover:bg-cream/60 transition-colors ${folderId === null ? 'font-bold text-charcoal' : ''}`}
              >
                {t('fields.attachment.root')}
              </button>
              {breadcrumb.map((b, i) => (
                <span key={b.id ?? `crumb-${i}`} className="flex items-center gap-1">
                  <span className="text-charcoal/30">/</span>
                  <button
                    type="button"
                    onClick={() => setFolderId(b.id)}
                    className={`px-1.5 py-0.5 rounded hover:bg-cream/60 transition-colors truncate max-w-[140px] ${i === breadcrumb.length - 1 ? 'font-bold text-charcoal' : ''}`}
                  >
                    {b.name}
                  </button>
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors shrink-0"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={18} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-sand/30 bg-cream/30">
          {folderId !== null && (
            <button
              type="button"
              onClick={() => {
                const parent = breadcrumb.length >= 2 ? breadcrumb[breadcrumb.length - 2] : null;
                setFolderId(parent ? parent.id : null);
              }}
              className="inline-flex items-center gap-1 text-xs font-bold text-charcoal/70 hover:text-copper transition-colors"
            >
              <ArrowBack size={14} />
              {isAr ? 'رجوع' : 'Back'}
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setCreatingFolder((v) => !v)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-sand/50 text-xs font-bold text-charcoal/70 hover:bg-cream hover:text-charcoal transition-colors"
          >
            <FolderPlus size={14} />
            {t('fields.attachment.create_folder')}
          </button>
          <button
            type="button"
            onClick={handleUploadClick}
            disabled={uploading}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-copper text-white text-xs font-bold hover:bg-terracotta transition-colors disabled:opacity-50"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {t('fields.attachment.upload_new')}
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            accept={acceptMime}
            className="hidden"
            onChange={(e) => void handleUploadFiles(e.target.files)}
          />
        </div>

        {/* Inline new-folder row */}
        {creatingFolder && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-sand/30 bg-copper/5">
            <FolderPlus size={14} className="text-copper/70" />
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateFolderSubmit();
                if (e.key === 'Escape') {
                  setCreatingFolder(false);
                  setNewFolderName('');
                }
              }}
              autoFocus
              placeholder={isAr ? 'اسم المجلد' : 'Folder name'}
              className="flex-1 form-input py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void handleCreateFolderSubmit()}
              disabled={!newFolderName.trim()}
              className="px-3 py-1 rounded-lg bg-copper text-white text-xs font-bold disabled:opacity-50"
            >
              {isAr ? 'إنشاء' : 'Create'}
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 min-h-[280px]">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 size={24} className="animate-spin text-copper" />
            </div>
          ) : folders.length === 0 && files.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-charcoal/40 text-sm">
              {t('fields.attachment.empty_folder')}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
              {folders.map((f) => (
                <PickerFolderTile
                  key={f.id}
                  folder={f}
                  checked={selectedFolderIds.has(f.id)}
                  showSelector={showFolderSelectors}
                  canManage={canManageFolder(f)}
                  isRenaming={renamingId?.kind === 'folder' && renamingId.id === f.id}
                  renameDraft={renamingId?.kind === 'folder' && renamingId.id === f.id ? renameDraft : ''}
                  onToggle={() => handleToggleFolder(f.id)}
                  onOpen={() => setFolderId(f.id)}
                  onStartRename={() => handleStartRename('folder', f.id, f.name)}
                  onDraftChange={setRenameDraft}
                  onCommitRename={() => void handleCommitRename()}
                  onCancelRename={handleCancelRename}
                  onDelete={() => void handleDeleteFolder(f)}
                />
              ))}
              {files.map((file) => (
                <PickerFileTile
                  key={file.id}
                  file={file}
                  checked={selectedFileIds.has(file.id)}
                  showSelector={showFileSelectors}
                  canEdit={canEditFile(file)}
                  isRenaming={renamingId?.kind === 'file' && renamingId.id === file.id}
                  renameDraft={renamingId?.kind === 'file' && renamingId.id === file.id ? renameDraft : ''}
                  isAr={isAr}
                  onToggle={() => handleToggleFile(file.id)}
                  onPreview={() => setPreviewFile(file)}
                  onStartRename={() =>
                    handleStartRename('file', file.id, file.original_name)
                  }
                  onDraftChange={setRenameDraft}
                  onCommitRename={() => void handleCommitRename()}
                  onCancelRename={handleCancelRename}
                  onDelete={() => void handleDeleteFile(file)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-sand/40 bg-cream/20">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-charcoal/70 hover:bg-cream text-sm font-bold transition-colors"
          >
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirmDisabled}
            className="px-4 py-2 rounded-lg bg-copper text-white text-sm font-bold hover:bg-terracotta transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {confirmLabel}
          </button>
        </div>
      </div>

      {/* Stacked preview modal — opens above the picker when a tile's
          Preview action is invoked. Reuses the main FilePreviewModal so
          the user gets the same rename/share/delete affordances. */}
      <FilePreviewModal
        file={previewFile}
        open={!!previewFile}
        canEdit={previewFile ? canEditFile(previewFile) : false}
        canDelete={previewFile ? canEditFile(previewFile) : false}
        onClose={() => setPreviewFile(null)}
        onShare={() => {
          // Share-from-picker is intentionally a no-op for now — the picker
          // is for selection, not external sharing. The Share/Permissions
          // surfaces live in the main /files page.
        }}
        onPermissions={() => {
          /* same rationale as onShare above */
        }}
        onDelete={(f) => void handleDeleteFile(f)}
        onRenamed={(updated) => {
          setFiles((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
          setPreviewFile(updated);
        }}
      />
    </div>,
    document.body,
  );
}

/** True when `mime` matches the comma-separated `accept` pattern. Supports
 *  exact MIMEs ('image/png') and wildcards ('image/*'). Empty accept = any. */
function mimeMatches(mime: string, accept: string): boolean {
  if (!accept) return true;
  const patterns = accept.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (patterns.length === 0) return true;
  const m = mime.toLowerCase();
  return patterns.some((p) => {
    if (p === m) return true;
    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -1); // 'image/'
      return m.startsWith(prefix);
    }
    return false;
  });
}

// ─── Tile components ────────────────────────────────────────────────────

interface FolderTileProps {
  folder: FolderRow;
  checked: boolean;
  showSelector: boolean;
  canManage: boolean;
  isRenaming: boolean;
  renameDraft: string;
  onToggle: () => void;
  onOpen: () => void;
  onStartRename: () => void;
  onDraftChange: (s: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}

function PickerFolderTile({
  folder,
  checked,
  showSelector,
  canManage,
  isRenaming,
  renameDraft,
  onToggle,
  onOpen,
  onStartRename,
  onDraftChange,
  onCommitRename,
  onCancelRename,
  onDelete,
}: FolderTileProps) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className={`relative group rounded-xl border bg-white overflow-hidden transition-all ${checked ? 'border-copper ring-2 ring-copper/20' : 'border-sand/40 hover:border-sand/70'}`}
    >
      {showSelector && !isRenaming && (
        <label className="absolute top-1.5 start-1.5 z-10 p-1 bg-white/90 rounded-md cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="cursor-pointer"
          />
        </label>
      )}
      {canManage && !isRenaming && (
        <div className="absolute top-1 end-1 z-10">
          <button
            ref={kebabRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="p-1 rounded-md bg-white/90 text-charcoal/50 hover:text-charcoal hover:bg-white opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label={t('common.actions')}
          >
            <MoreVertical size={14} />
          </button>
          <TileMenu open={menuOpen} anchorRef={kebabRef} onClose={() => setMenuOpen(false)} isAr={isAr} width={160}>
            <PickerMenuItem
              icon={Pencil}
              label={t('files.actions.rename')}
              onClick={() => {
                setMenuOpen(false);
                onStartRename();
              }}
            />
            <div className="my-1 border-t border-sand/30" />
            <PickerMenuItem
              icon={Trash2}
              label={t('files.actions.delete')}
              danger
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            />
          </TileMenu>
        </div>
      )}

      <button
        type="button"
        onClick={onOpen}
        className="w-full flex flex-col items-center gap-1.5 p-3 text-center hover:bg-cream/50 transition-colors"
        title={folder.name}
        disabled={isRenaming}
      >
        <FolderIcon size={32} className="text-copper/70" />
        {isRenaming ? (
          <div
            className="w-full flex items-center gap-1"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitRename();
                if (e.key === 'Escape') onCancelRename();
              }}
              dir="auto"
              className="flex-1 min-w-0 text-xs px-1.5 py-1 border border-copper/40 rounded focus:outline-none focus:border-copper"
            />
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCommitRename();
              }}
              className="p-1 rounded text-copper hover:bg-copper/10"
              aria-label={t('common.save')}
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCancelRename();
              }}
              className="p-1 rounded text-charcoal/50 hover:bg-cream"
              aria-label={t('common.cancel')}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <span className="text-xs font-bold text-charcoal truncate w-full">{folder.name}</span>
        )}
      </button>
    </div>
  );
}

interface FileTileProps {
  file: FileRow;
  checked: boolean;
  showSelector: boolean;
  canEdit: boolean;
  isRenaming: boolean;
  renameDraft: string;
  isAr: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onStartRename: () => void;
  onDraftChange: (s: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}

function PickerFileTile({
  file,
  checked,
  showSelector,
  canEdit,
  isRenaming,
  renameDraft,
  isAr,
  onToggle,
  onPreview,
  onStartRename,
  onDraftChange,
  onCommitRename,
  onCancelRename,
  onDelete,
}: FileTileProps) {
  const { t } = useTranslation();
  const Icon = kindIcon[file.kind];
  const accent = kindAccent[file.kind];
  const isDisabled = !showSelector;
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  // Lazy-fetch a signed view URL for image kinds so the tile shows the actual
  // picture. Same approach as FileCard on the main /files page.
  useEffect(() => {
    if (file.kind !== 'image') return;
    let cancelled = false;
    void signViewUrl(file.id)
      .then((res) => {
        if (!cancelled) setThumbUrl(res.url);
      })
      .catch(() => {
        // Fine — falls back to the icon tile.
      });
    return () => {
      cancelled = true;
    };
  }, [file.id, file.kind]);

  return (
    <div
      className={`relative group rounded-xl border bg-white overflow-hidden transition-all ${checked ? 'border-copper ring-2 ring-copper/20' : 'border-sand/40 hover:border-sand/70'} ${isDisabled ? 'opacity-50' : ''}`}
    >
      {showSelector && !isRenaming && (
        <label className="absolute top-1.5 start-1.5 z-10 p-1 bg-white/90 rounded-md cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="cursor-pointer"
          />
        </label>
      )}
      {!isRenaming && (
        <div className="absolute top-1 end-1 z-10">
          <button
            ref={kebabRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="p-1 rounded-md bg-white/90 text-charcoal/50 hover:text-charcoal hover:bg-white opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label={t('common.actions')}
          >
            <MoreVertical size={14} />
          </button>
          <TileMenu open={menuOpen} anchorRef={kebabRef} onClose={() => setMenuOpen(false)} isAr={isAr} width={160}>
            <PickerMenuItem
              icon={Eye}
              label={t('files.actions.preview')}
              onClick={() => {
                setMenuOpen(false);
                onPreview();
              }}
            />
            {canEdit && (
              <>
                <PickerMenuItem
                  icon={Pencil}
                  label={t('files.actions.rename')}
                  onClick={() => {
                    setMenuOpen(false);
                    onStartRename();
                  }}
                />
                <div className="my-1 border-t border-sand/30" />
                <PickerMenuItem
                  icon={Trash2}
                  label={t('files.actions.delete')}
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                />
              </>
            )}
          </TileMenu>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (isRenaming) return;
          if (showSelector) onToggle();
        }}
        disabled={isDisabled || isRenaming}
        className="w-full flex flex-col items-center gap-1.5 text-center"
        title={file.original_name}
      >
        {/* For image kinds, fill the top of the tile with the actual picture
            (aspect-square cover) so users can scan visually. For other kinds
            keep the compact accent-colored icon block. */}
        {file.kind === 'image' && thumbUrl ? (
          <div className="w-full aspect-square overflow-hidden bg-cream">
            <img
              src={thumbUrl}
              alt={file.original_name}
              loading="lazy"
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          <div
            className={`w-16 h-16 mt-3 rounded-lg flex items-center justify-center ${accent.bg}`}
          >
            <Icon size={28} className={accent.fg} />
          </div>
        )}
        <div className="w-full px-3 pb-3 flex flex-col items-center gap-0.5">
        {isRenaming ? (
          <div
            className="w-full flex items-center gap-1"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitRename();
                if (e.key === 'Escape') onCancelRename();
              }}
              dir="auto"
              className="flex-1 min-w-0 text-xs px-1.5 py-1 border border-copper/40 rounded focus:outline-none focus:border-copper"
            />
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCommitRename();
              }}
              className="p-1 rounded text-copper hover:bg-copper/10"
              aria-label={t('common.save')}
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCancelRename();
              }}
              className="p-1 rounded text-charcoal/50 hover:bg-cream"
              aria-label={t('common.cancel')}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <>
            <span className="text-xs font-bold text-charcoal truncate w-full">
              {file.original_name}
            </span>
            <span className="text-[10px] text-charcoal/50" dir="ltr">
              {formatBytes(file.size_bytes, isAr)}
            </span>
          </>
        )}
        </div>
      </button>
    </div>
  );
}

interface PMIProps {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function PickerMenuItem({ icon: Icon, label, onClick, danger }: PMIProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
        danger
          ? 'text-red-600 hover:bg-red-50'
          : 'text-charcoal/80 hover:bg-cream hover:text-charcoal'
      }`}
    >
      <Icon size={12} />
      <span>{label}</span>
    </button>
  );
}
