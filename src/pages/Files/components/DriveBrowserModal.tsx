import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  FolderIcon,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import {
  createFolder,
  getFolder,
  listFiles,
  listFolders,
  uploadFile,
} from '@/lib/files/client';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import { useAppStore } from '@/stores/appStore';
import type { AttachmentRef, FileRow, FolderRow } from '@/types';

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
              {folders.map((f) => {
                const checked = selectedFolderIds.has(f.id);
                return (
                  <div
                    key={f.id}
                    className={`relative group rounded-xl border bg-white overflow-hidden transition-all ${checked ? 'border-copper ring-2 ring-copper/20' : 'border-sand/40 hover:border-sand/70'}`}
                  >
                    {showFolderSelectors && (
                      <label className="absolute top-1.5 start-1.5 z-10 p-1 bg-white/90 rounded-md cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggleFolder(f.id)}
                          className="cursor-pointer"
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => setFolderId(f.id)}
                      className="w-full flex flex-col items-center gap-1.5 p-3 text-center hover:bg-cream/50 transition-colors"
                      title={f.name}
                    >
                      <FolderIcon size={32} className="text-copper/70" />
                      <span className="text-xs font-bold text-charcoal truncate w-full">{f.name}</span>
                    </button>
                  </div>
                );
              })}
              {files.map((file) => {
                const Icon = kindIcon[file.kind];
                const accent = kindAccent[file.kind];
                const checked = selectedFileIds.has(file.id);
                const isDisabled = !showFileSelectors;
                return (
                  <div
                    key={file.id}
                    className={`relative rounded-xl border bg-white overflow-hidden transition-all ${checked ? 'border-copper ring-2 ring-copper/20' : 'border-sand/40 hover:border-sand/70'} ${isDisabled ? 'opacity-50' : ''}`}
                  >
                    {showFileSelectors && (
                      <label className="absolute top-1.5 start-1.5 z-10 p-1 bg-white/90 rounded-md cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggleFile(file.id)}
                          className="cursor-pointer"
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (showFileSelectors) handleToggleFile(file.id);
                      }}
                      disabled={isDisabled}
                      className="w-full flex flex-col items-center gap-1.5 p-3 text-center"
                      title={file.original_name}
                    >
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${accent.bg}`}>
                        <Icon size={20} className={accent.fg} />
                      </div>
                      <span className="text-xs font-bold text-charcoal truncate w-full">
                        {file.original_name}
                      </span>
                      <span className="text-[10px] text-charcoal/50" dir="ltr">
                        {formatBytes(file.size_bytes, isAr)}
                      </span>
                    </button>
                  </div>
                );
              })}
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
