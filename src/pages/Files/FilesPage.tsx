import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FilePlus, FolderPlus, FolderUp, Loader2, Search, Upload, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { FileRow, FilePermissionRole, FolderRow, PdfCompressResponse } from '@/types';
import {
  deleteFile,
  deleteFolder,
  effectiveFileRoles,
  effectiveFolderRoles,
  getFolder,
  listFiles,
  listFolders,
  listSharedWithMe,
  renameFile,
  renameFolder,
  requestPdfCompress,
  roleSatisfies,
  searchDrive,
  signDownloadUrl,
  signViewUrls,
  type DriveSearchResult,
} from '@/lib/files/client';
import { formatBytes } from '@/lib/files/format';
import ConfirmModal from '@/components/ui/ConfirmModal';
import FilesTabs from './components/FilesTabs';
import NewDocumentModal from './components/NewDocumentModal';
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
import { useMarqueeSelection } from './useMarqueeSelection';

type View = 'mine' | 'shared' | 'folder';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Compression keeps running server-side past this — we just stop *watching*
 *  and tell the user the copies will appear on a later refresh. */
const COMPRESS_POLL_TIMEOUT_MS = 15 * 60_000;

/**
 * Poll /api/files/compress-pdf for many files with ONE sequential round-robin
 * sweep (bounded request rate no matter how many files were bulk-selected —
 * N parallel pollers would hammer the API). Ids still pending at the timeout
 * are simply absent from the result map.
 */
async function pollCompressMany(fileIds: string[]): Promise<Map<string, PdfCompressResponse>> {
  const out = new Map<string, PdfCompressResponse>();
  const pending = new Set(fileIds);
  const t0 = Date.now();
  while (pending.size > 0 && Date.now() - t0 < COMPRESS_POLL_TIMEOUT_MS) {
    await sleep(2500);
    for (const id of [...pending]) {
      const res = await requestPdfCompress(id);
      if (res.status === 'done' || res.status === 'failed') {
        out.set(id, res);
        pending.delete(id);
      }
    }
  }
  return out;
}

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
  /** fileId → signed thumbnail URL, batch-signed for all image files in one
   *  request whenever the file list changes (replaces per-tile signing). */
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  /** id → caller's effective role, batch-resolved per view so the UI shows the
   *  right edit/delete/share affordances for cascade/direct grantees (not just
   *  uploaders). RLS remains the authoritative gate. */
  const [fileRoles, setFileRoles] = useState<Record<string, FilePermissionRole>>({});
  const [folderRoles, setFolderRoles] = useState<Record<string, FilePermissionRole>>({});

  // ─── Search state ─────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState(''); // debounced
  const [searchResult, setSearchResult] = useState<DriveSearchResult>({
    folders: [],
    files: [],
    contentMatchIds: new Set(),
  });
  const [searchLoading, setSearchLoading] = useState(false);

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
  /** Files with a compression start+poll cycle in flight — disables the
   *  per-card menu item and excludes them from a second bulk run. */
  const [compressingIds, setCompressingIds] = useState<Set<string>>(new Set());

  const currentFolderId = view === 'folder' ? folderIdParam ?? null : null;

  // When a search is active, the grids render the (global) search results
  // instead of the current folder's contents. All the per-view machinery
  // (selection, thumbnails, roles) keys off these displayed lists so search
  // reuses the exact same tiles + affordances.
  const searchActive = searchQuery.trim().length >= 2;
  const displayFolders = searchActive ? searchResult.folders : folders;
  const displayFiles = searchActive ? searchResult.files : files;

  // ─── Selection state ─────────────────────────────────────────────────
  const selection = useFilesSelection({ folders: displayFolders, files: displayFiles });

  // Clear selection AND any active search whenever the view or folder changes —
  // navigating away from a search (e.g. clicking a folder result) should land
  // in that folder normally, not keep showing global results.
  useEffect(() => {
    selection.clear();
    setSearchInput('');
    setSearchQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentFolderId]);

  // ─── Marquee (rubber-band) selection — Google Drive style ───────────
  //
  // The implementation moved to useMarqueeSelection so the Library shares the
  // EXACT behaviour rather than a second copy of it. Everything subtle about it
  // — the drag-vs-click threshold, grid-relative coordinates, the edge
  // auto-scroll rAF loop, the post-drag click suppressor — now lives in one
  // place and is fixed in one place.
  //
  // This page keeps folders and files in two separate sets so bulk actions can
  // address them independently, and the hook does not care: it captures an
  // opaque `base` at mousedown and hands it straight back, so the pair survives
  // a drag without the hook ever knowing what a folder is.
  const gridRef = useRef<HTMLDivElement | null>(null);

  /** Latest selection helpers, in a ref so the hook's callbacks always read
   *  fresh ones without the hook re-subscribing on every render. */
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const { marquee, onGridMouseDown, swallowClickAfterDrag } = useMarqueeSelection<{
    folders: Set<string>;
    files: Set<string>;
  }>({
    gridRef,
    captureBase: () => ({
      folders: new Set(selectionRef.current.selectedFolderIds),
      files: new Set(selectionRef.current.selectedFileIds),
    }),
    applyHits: (hits, mode, base) => {
      const sel = selectionRef.current;
      // The hook is generic over `kind: string`; this page only has two.
      const items = hits.filter(
        (h): h is SelectableItem => h.kind === 'folder' || h.kind === 'file',
      );
      if (mode === 'replace') {
        sel.replace(items);
        return;
      }
      const fo = new Set(base.folders);
      const fi = new Set(base.files);
      if (mode === 'add') {
        items.forEach((h) => (h.kind === 'folder' ? fo : fi).add(h.id));
      } else {
        // toggle — symmetric difference of base and hits
        items.forEach((h) => {
          const set = h.kind === 'folder' ? fo : fi;
          if (set.has(h.id)) set.delete(h.id);
          else set.add(h.id);
        });
      }
      sel.replace([
        ...Array.from(fo).map((id) => ({ kind: 'folder' as const, id })),
        ...Array.from(fi).map((id) => ({ kind: 'file' as const, id })),
      ]);
    },
    // Mousedown on blank grid area with no drag = "click on background".
    // (A mousedown ON a card does NOT clear here — the card's own onClick
    // fires next and owns that decision.)
    onBackgroundClick: () => {
      const sel = selectionRef.current;
      if (sel.totalSelected > 0) sel.clear();
    },
    clearSelection: () => selectionRef.current.clear(),
  });

  /** Wrap selection.onItemClick so a card's click that came from the END of
   *  a drag (not a real click) gets suppressed before opening preview. */
  const onCardClick = useCallback(
    (item: SelectableItem, e: ReactMouseEvent): boolean => {
      if (swallowClickAfterDrag()) return true; // click came from the end of a drag
      return selection.onItemClick(item, clickMode(e));
    },
    [selection, swallowClickAfterDrag],
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

  // Batch-sign thumbnails for every image file in the displayed list in ONE
  // request whenever it changes (was one /sign-view-url per tile). `displayFiles`
  // is the search results when a search is active, else the current view.
  useEffect(() => {
    const imageIds = displayFiles.filter((f) => f.kind === 'image').map((f) => f.id);
    if (imageIds.length === 0) {
      setThumbUrls({});
      return;
    }
    let cancelled = false;
    void signViewUrls(imageIds)
      .then((map) => {
        if (!cancelled) setThumbUrls(map);
      })
      .catch(() => {
        // surfaceError already toasted; cards fall back to the icon tile.
      });
    return () => {
      cancelled = true;
    };
  }, [displayFiles]);

  // Batch-resolve effective roles for the displayed files + folders so the
  // kebab/preview affordances match real grants (cascade + direct), not just
  // ownership. One RPC per kind per list change.
  useEffect(() => {
    const ids = displayFiles.map((f) => f.id);
    if (ids.length === 0) {
      setFileRoles({});
      return;
    }
    let cancelled = false;
    void effectiveFileRoles(ids)
      .then((map) => {
        if (!cancelled) setFileRoles(map);
      })
      .catch(() => {
        // surfaced; falls back to the uploader heuristic below.
      });
    return () => {
      cancelled = true;
    };
  }, [displayFiles]);

  useEffect(() => {
    const ids = displayFolders.map((f) => f.id);
    if (ids.length === 0) {
      setFolderRoles({});
      return;
    }
    let cancelled = false;
    void effectiveFolderRoles(ids)
      .then((map) => {
        if (!cancelled) setFolderRoles(map);
      })
      .catch(() => {
        // surfaced; falls back to the creator heuristic below.
      });
    return () => {
      cancelled = true;
    };
  }, [displayFolders]);

  // Debounce the raw search box into the active (committed) query.
  useEffect(() => {
    const id = window.setTimeout(() => setSearchQuery(searchInput), 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // Run the global Drive search whenever the debounced query changes.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResult({ folders: [], files: [], contentMatchIds: new Set() });
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    void searchDrive(q)
      .then((res) => {
        if (!cancelled) setSearchResult(res);
      })
      .catch(() => {
        /* surfaceError already toasted */
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [searchQuery]);

  // ─── Permission helpers ───────────────────────────────────────────────

  // Effective-role-aware affordances. The batch RPC (above) resolves the
  // caller's real role per item including folder cascade + direct grants; while
  // that's loading (or if it failed) we fall back to uploader/creator ownership
  // so owners never lose their own buttons. RLS is the authoritative write gate.
  const canEditFile = useCallback(
    (f: FileRow) => {
      const role = fileRoles[f.id];
      if (role) return roleSatisfies(role, 'edit');
      return f.uploaded_by_user_id === currentUserId;
    },
    [fileRoles, currentUserId],
  );
  const canDeleteFile = useCallback(
    (f: FileRow) => {
      const role = fileRoles[f.id];
      if (role) return roleSatisfies(role, 'delete');
      return f.uploaded_by_user_id === currentUserId;
    },
    [fileRoles, currentUserId],
  );
  const canManageFolder = useCallback(
    (f: FolderRow) => {
      const role = folderRoles[f.id];
      if (role) return roleSatisfies(role, 'edit');
      return f.created_by_user_id === currentUserId;
    },
    [folderRoles, currentUserId],
  );
  const canDeleteFolder = useCallback(
    (f: FolderRow) => {
      const role = folderRoles[f.id];
      if (role) return roleSatisfies(role, 'delete');
      return f.created_by_user_id === currentUserId;
    },
    [folderRoles, currentUserId],
  );

  // ─── Handlers ────────────────────────────────────────────────────────

  /** Wassel documents bypass the preview modal — they have a full-page
   *  editor at /files/doc/:id. Other kinds open in the lightbox/iframe modal. */
  const onPreview = (f: FileRow) => {
    if (f.kind === 'wassel_doc') {
      navigate(`/files/doc/${f.id}`);
      return;
    }
    setPreviewFile(f);
  };

  /** New Document opens the template picker (Blank + business templates);
   *  the modal owns creation and hands back the row to navigate. */
  const [newDocOpen, setNewDocOpen] = useState(false);
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
  /** Pending destructive action — drives the app-styled ConfirmModal (the
   *  native window.confirm popups are gone; they were off-brand and couldn't
   *  explain that folder deletion takes the contents too). */
  const [confirmAction, setConfirmAction] = useState<
    | { kind: 'file'; file: FileRow }
    | { kind: 'folder'; folder: FolderRow }
    | { kind: 'bulk' }
    | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const onDeleteFile = (f: FileRow) => setConfirmAction({ kind: 'file', file: f });
  const onDeleteFolder = (folder: FolderRow) => setConfirmAction({ kind: 'folder', folder });

  const doDeleteFile = async (f: FileRow) => {
    try {
      await deleteFile(f.id);
      addToast(t('toast.deleted'), 'success');
      setPreviewFile(null);
      await reload();
    } catch {
      // surfaceError already toasted
    }
  };
  const doDeleteFolder = async (folder: FolderRow) => {
    try {
      const { files: removedFiles } = await deleteFolder(folder.id);
      addToast(t('files.delete.folder_done', { count: removedFiles }), 'success');
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
    () => displayFiles.filter((f) => selection.selectedFileIds.has(f.id)),
    [displayFiles, selection.selectedFileIds],
  );
  const selectedFolders = useMemo(
    () => displayFolders.filter((f) => selection.selectedFolderIds.has(f.id)),
    [displayFolders, selection.selectedFolderIds],
  );
  const deletableSelected = useMemo(() => {
    const f = selectedFiles.filter((x) => canDeleteFile(x));
    const fo = selectedFolders.filter((x) => canDeleteFolder(x));
    return { files: f, folders: fo, total: f.length + fo.length };
  }, [selectedFiles, selectedFolders, canDeleteFile, canDeleteFolder]);
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

  const onBulkDelete = useCallback(() => {
    if (deletableSelected.total === 0) {
      addToast(t('files.bulk.no_deletable'), 'error');
      return;
    }
    setConfirmAction({ kind: 'bulk' });
  }, [deletableSelected, addToast, t]);

  const doBulkDelete = useCallback(async () => {
    setBulkBusy(true);
    let ok = 0;
    const total = deletableSelected.total;
    for (const f of deletableSelected.files) {
      try {
        await deleteFile(f.id);
        ok += 1;
      } catch {
        /* toasted */
      }
    }
    // Folders delete recursively (contents included) — the confirm modal
    // already warned about it.
    for (const folder of deletableSelected.folders) {
      try {
        await deleteFolder(folder.id);
        ok += 1;
      } catch {
        /* toasted */
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

  // ─── PDF compression (Ghostscript on the Fly worker) ──────────────────
  // Start is fire-and-forget on the server (queue + worker); the handlers
  // here only watch for the outcome to toast + refresh. Closing the tab
  // mid-compress loses nothing — the copies appear on the next reload.

  const compressibleSelected = useMemo(
    () => selectedFiles.filter((f) => f.kind === 'pdf' && canEditFile(f)),
    [selectedFiles, canEditFile],
  );

  const markCompressing = useCallback((ids: string[], on: boolean) => {
    setCompressingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const onCompressFile = useCallback(
    async (f: FileRow) => {
      if (compressingIds.has(f.id)) return;
      markCompressing([f.id], true);
      try {
        const startRes = await requestPdfCompress(f.id, true);
        if (startRes.status === 'failed') {
          addToast(t('files.compress.failed', { name: f.original_name, error: startRes.error ?? '' }), 'error');
          return;
        }
        addToast(t('files.compress.started', { name: f.original_name }), 'info');
        const res = (await pollCompressMany([f.id])).get(f.id);
        if (!res) {
          addToast(t('files.compress.still_running', { count: 1 }), 'info');
          return;
        }
        if (res.status === 'failed') {
          addToast(t('files.compress.failed', { name: f.original_name, error: res.error ?? '' }), 'error');
          return;
        }
        if (res.no_gain) {
          addToast(t('files.compress.no_gain', { name: f.original_name }), 'info');
          return;
        }
        addToast(
          t('files.compress.done', {
            name: f.original_name,
            from: formatBytes(res.original_bytes ?? 0, isAr),
            to: formatBytes(res.compressed_bytes ?? 0, isAr),
          }),
          'success',
        );
        await reload();
      } finally {
        markCompressing([f.id], false);
      }
    },
    [compressingIds, markCompressing, addToast, t, isAr, reload],
  );

  const onBulkCompress = useCallback(async () => {
    const targets = compressibleSelected.filter((f) => !compressingIds.has(f.id));
    if (targets.length === 0) {
      addToast(t('files.bulk.no_compressible'), 'error');
      return;
    }
    markCompressing(targets.map((f) => f.id), true);
    selection.clear();
    addToast(t('files.compress.started_many', { count: targets.length }), 'info');
    try {
      // Enqueue EVERYTHING up front — jobs finish server-side across the 5
      // worker machines even if this tab closes mid-poll.
      const started: FileRow[] = [];
      let failed = 0;
      for (const f of targets) {
        const res = await requestPdfCompress(f.id, true);
        if (res.status === 'failed') failed += 1;
        else started.push(f);
      }
      const outcomes = await pollCompressMany(started.map((f) => f.id));
      // Ids absent from `outcomes` were still running when we stopped watching.
      const stillRunning = started.length - outcomes.size;
      let done = 0;
      let saved = 0;
      for (const res of outcomes.values()) {
        if (res.status === 'failed') {
          failed += 1;
        } else {
          done += 1;
          if (!res.no_gain) {
            saved += Math.max(0, (res.original_bytes ?? 0) - (res.compressed_bytes ?? 0));
          }
        }
      }
      addToast(
        t('files.compress.bulk_summary', {
          ok: done,
          total: targets.length,
          saved: formatBytes(saved, isAr),
        }),
        failed > 0 ? 'error' : 'success',
      );
      if (stillRunning > 0) {
        addToast(t('files.compress.still_running', { count: stillRunning }), 'info');
      }
      await reload();
    } finally {
      markCompressing(targets.map((f) => f.id), false);
    }
  }, [compressibleSelected, compressingIds, markCompressing, selection, addToast, t, isAr, reload]);

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
                onClick={() => setNewDocOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-sand/40 text-charcoal hover:bg-cream font-bold text-sm transition-colors"
              >
                <FilePlus size={16} />
                {t('files.new_doc.button')}
              </button>
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

      {/* Global search */}
      <div className="mb-4">
        <div className="relative max-w-lg">
          <Search
            size={16}
            className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none"
          />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('files.search.placeholder')}
            dir="auto"
            className="w-full ps-9 pe-9 py-2.5 rounded-xl bg-white border border-sand/40 text-sm text-charcoal placeholder-charcoal/40 focus:outline-none focus:ring-2 focus:ring-copper/30"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              aria-label={t('files.search.clear_aria')}
              className="absolute top-1/2 -translate-y-1/2 end-2 p-1 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-cream"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb (folder view only, hidden while searching) */}
      {view === 'folder' && !searchActive && (
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
        compressibleCount={compressibleSelected.filter((f) => !compressingIds.has(f.id)).length}
        onClear={selection.clear}
        onDelete={onBulkDelete}
        onMove={onBulkMove}
        onDownload={onBulkDownload}
        onCompress={() => void onBulkCompress()}
      />

      {/* Content */}
      {(searchActive ? searchLoading : loading) ? (
        <div className="py-20 flex justify-center">
          <Loader2 size={28} className="animate-spin text-copper" />
        </div>
      ) : displayFolders.length === 0 && displayFiles.length === 0 ? (
        searchActive ? (
          <SearchEmpty query={searchQuery} />
        ) : (
          <EmptyState view={view} onUpload={() => window.dispatchEvent(new Event('files:open-picker'))} uploadEnabled={uploadEnabled} />
        )
      ) : (
        <div
          ref={gridRef}
          onMouseDown={onGridMouseDown}
          // Extra bottom padding while a selection is active so the floating
          // BulkActionBar (fixed, bottom-center) never sits on top of the last
          // row. Padding only grows the scroll area below the tiles — it does
          // NOT move existing tiles, so the marquee hit-test stays aligned.
          className={`space-y-6 relative select-none ${selection.totalSelected > 0 ? 'pb-24' : ''}`}
          style={bulkBusy ? { pointerEvents: 'none', opacity: 0.7 } : undefined}
        >
          {searchActive && (
            <p className="text-sm text-charcoal/50 -mb-2">
              {t('files.search.results', { count: displayFolders.length + displayFiles.length })}
            </p>
          )}
          {displayFolders.length > 0 && (
            <section>
              <h2 className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-3">
                {isAr ? 'المجلدات' : 'Folders'}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {displayFolders.map((f) => (
                  <FolderTile
                    key={f.id}
                    folder={f}
                    shared={view === 'shared' || f.created_by_user_id !== currentUserId}
                    canManage={canManageFolder(f)}
                    canDelete={canDeleteFolder(f)}
                    selected={selection.isSelected('folder', f.id)}
                    selectionActive={selection.totalSelected > 0}
                    onSelectClick={(e) => onCardClick({ kind: 'folder', id: f.id }, e)}
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

          {displayFiles.length > 0 && (
            <section>
              <h2 className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-3">
                {isAr ? 'الملفات' : 'Files'}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {displayFiles.map((f) => (
                  <FileCard
                    key={f.id}
                    file={f}
                    shared={view === 'shared' || f.uploaded_by_user_id !== currentUserId}
                    canEdit={canEditFile(f)}
                    canDelete={canDeleteFile(f)}
                    thumbUrl={f.kind === 'image' ? thumbUrls[f.id] ?? null : undefined}
                    selected={selection.isSelected('file', f.id)}
                    selectionActive={selection.totalSelected > 0}
                    onSelectClick={(e) => onCardClick({ kind: 'file', id: f.id }, e)}
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
                    onCompress={(file) => void onCompressFile(file)}
                    compressing={compressingIds.has(f.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Marquee overlay — absolutely positioned INSIDE the grid (which is
              position:relative and scrolls with the page), in grid-relative
              coords. Living in the scrolling content means the box stays pinned
              to the tiles it covers while the page auto-scrolls down. */}
          {marquee && (marquee.w > 2 || marquee.h > 2) && (
            <div
              aria-hidden
              // !mt-0 is load-bearing: the grid uses `space-y-6`, which injects
              // margin-top onto every non-first child. As a later child the
              // overlay would inherit a 24px top margin that shifts the visible
              // box down from where `top: marquee.y` places it. Reset it.
              className="absolute pointer-events-none z-30 border border-copper/70 bg-copper/10 rounded-sm !mt-0"
              style={{
                left: marquee.x,
                top: marquee.y,
                width: marquee.w,
                height: marquee.h,
              }}
            />
          )}
        </div>
      )}

      {/* Dropzone (renders nothing visible until a drag enters) */}
      <UploadDropzone folderId={currentFolderId} enabled={uploadEnabled} onUploaded={onUploaded} />

      {/* Modals */}
      <ConfirmModal
        open={!!confirmAction}
        busy={confirmBusy}
        title={
          confirmAction?.kind === 'folder'
            ? t('files.delete.folder_title')
            : confirmAction?.kind === 'bulk'
            ? t('files.bulk.delete_title')
            : t('files.delete.file_title')
        }
        message={
          confirmAction?.kind === 'folder'
            ? t('files.delete.folder_message', { name: confirmAction.folder.name })
            : confirmAction?.kind === 'bulk'
            ? t('files.bulk.delete_message', { count: deletableSelected.total })
            : t('files.delete.file_message', { name: confirmAction?.kind === 'file' ? confirmAction.file.original_name : '' })
        }
        confirmLabel={t('files.actions.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          if (!confirmAction) return;
          setConfirmBusy(true);
          const run =
            confirmAction.kind === 'file'
              ? doDeleteFile(confirmAction.file)
              : confirmAction.kind === 'folder'
              ? doDeleteFolder(confirmAction.folder)
              : doBulkDelete();
          void run.finally(() => {
            setConfirmBusy(false);
            setConfirmAction(null);
          });
        }}
      />
      <NewDocumentModal
        open={newDocOpen}
        folderId={currentFolderId}
        onClose={() => setNewDocOpen(false)}
        onCreated={(row) => {
          setNewDocOpen(false);
          navigate(`/files/doc/${row.id}`);
        }}
      />
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

/** Shown when a search returns nothing. */
function SearchEmpty({ query }: { query: string }) {
  const { t } = useTranslation();
  return (
    <div className="py-20 flex flex-col items-center justify-center text-center">
      <div className="w-20 h-20 rounded-3xl bg-cream flex items-center justify-center mb-4">
        <Search size={32} className="text-copper" />
      </div>
      <p className="text-charcoal/60 max-w-md">{t('files.search.empty', { query })}</p>
    </div>
  );
}

function mergeUniqueById<T extends { id: string }>(a: T[], b: T[]): T[] {
  const map = new Map<string, T>();
  [...a, ...b].forEach((item) => map.set(item.id, item));
  return Array.from(map.values());
}
