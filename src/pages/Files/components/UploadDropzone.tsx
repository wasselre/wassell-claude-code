import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudUpload, FolderUp, Loader2 } from 'lucide-react';
import {
  readDataTransferTree,
  readWebkitDirectoryFiles,
  uploadFile,
  uploadTree,
} from '@/lib/files/client';
import type { FileRow, FolderRow } from '@/types';
import type { DuplicateDecision } from '@/lib/files/client';
import DuplicateUploadModal from './DuplicateUploadModal';
import { useAppStore } from '@/stores/appStore';

interface Props {
  folderId: string | null;
  enabled: boolean;
  onUploaded: (rows: FileRow[], folders: FolderRow[]) => void;
}

/**
 * B7. One duplicate decision awaiting the user.
 *
 * Uploads run three at a time, so three workers can hit a duplicate at once.
 * They are serialised through a single pending prompt and a promise chain:
 * asking three questions on top of each other is how people learn to click the
 * first button without reading it.
 */
interface PendingDuplicate {
  name: string;
  size: number;
  matches: FileRow[];
  remaining: number;
  resolve: (d: DuplicateDecision) => void;
}

interface UploadingItem {
  id: string;
  name: string;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
  /** When set, this card is a folder-tree summary card; `total`/`done`/`failed` drive the counts. */
  tree?: { total: number; done: number; failed: number };
}

/**
 * Page-wide upload surface. Three input paths:
 *   1. Drag-drop anywhere on the page (files OR folders, via webkitGetAsEntry).
 *   2. "Upload" button → hidden <input type="file" multiple>.
 *   3. "Upload folder" button → hidden <input type="file" webkitdirectory>.
 *
 * FilesPage triggers (2) and (3) by dispatching window events.
 */
export default function UploadDropzone({ folderId, enabled, onUploaded }: Props) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<UploadingItem[]>([]);

  // ── B7: duplicate prompts ───────────────────────────────────────────────
  const [pendingDupe, setPendingDupe] = useState<PendingDuplicate | null>(null);
  /** Set once the user ticks "apply to the rest"; cleared at the start of each
   *  new batch so a decision never leaks from one drop into the next. */
  const batchDecisionRef = useRef<DuplicateDecision | null>(null);
  /** Serialises prompts: each request waits for the previous one to resolve,
   *  so three concurrent workers ask one question at a time. */
  const promptChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const askDuplicate = useCallback(
    (matches: FileRow[], file: File, remaining: number): Promise<DuplicateDecision> => {
      const run = promptChainRef.current.then(() => {
        // Re-checked INSIDE the chain, not before it: an earlier prompt may
        // have set it while this one was queued, which is the whole point of
        // "apply to the rest".
        if (batchDecisionRef.current) return batchDecisionRef.current;
        return new Promise<DuplicateDecision>((resolve) => {
          setPendingDupe({
            name: file.name, size: file.size, matches, remaining,
            resolve: (d) => { setPendingDupe(null); resolve(d); },
          });
        });
      });
      promptChainRef.current = run.catch(() => undefined);
      return run;
    },
    [],
  );
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const openFile = () => fileInputRef.current?.click();
    const openFolder = () => folderInputRef.current?.click();
    window.addEventListener('files:open-picker', openFile);
    window.addEventListener('files:open-folder-picker', openFolder);
    return () => {
      window.removeEventListener('files:open-picker', openFile);
      window.removeEventListener('files:open-folder-picker', openFolder);
    };
  }, []);

  // Helpers — flat-files upload (legacy path), shared by drop and picker.
  const uploadFlatFiles = useCallback(
    async (files: File[]) => {
      if (!enabled) {
        addToast(t('files.no_permission'), 'error');
        return;
      }
      const tickets: UploadingItem[] = files.map((f) => ({
        id: crypto.randomUUID(),
        name: f.name,
        status: 'queued',
      }));
      setItems((prev) => [...prev, ...tickets]);

      // A new drop is a new decision. Carrying "apply to the rest" across
      // batches would silently discard files the user never saw a prompt for.
      batchDecisionRef.current = null;
      const successRows: FileRow[] = [];
      const concurrency = 3;
      let cursor = 0;
      async function worker() {
        while (true) {
          const ix = cursor++;
          if (ix >= files.length) return;
          const ticket = tickets[ix];
          const file = files[ix];
          if (!ticket || !file) return;
          setItems((prev) => prev.map((it) => (it.id === ticket.id ? { ...it, status: 'uploading' } : it)));
          try {
            const row = await uploadFile(file, {
              folderId,
              onDuplicate: (matches, f) => askDuplicate(matches, f, files.length - ix - 1),
            });
            successRows.push(row);
            setItems((prev) => prev.map((it) => (it.id === ticket.id ? { ...it, status: 'done' } : it)));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setItems((prev) =>
              prev.map((it) => (it.id === ticket.id ? { ...it, status: 'error', error: msg } : it)),
            );
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (successRows.length > 0) onUploaded(successRows, []);
      // Auto-clear successful tickets after a beat — keep errors visible.
      setTimeout(() => {
        setItems((prev) => prev.filter((it) => it.status === 'error'));
      }, 1500);
    },
    [enabled, folderId, onUploaded, addToast, t, askDuplicate],
  );

  // Tree upload — used by directory drop AND directory picker. We render a
  // single rolled-up "tree" ticket showing N/M progress instead of one card
  // per file (which would overwhelm for big trees).
  const runTreeUpload = useCallback(
    async (tree: { items: { file: File; pathSegments: string[] }[]; folderPaths: Set<string> }, label: string) => {
      if (!enabled) {
        addToast(t('files.no_permission'), 'error');
        return;
      }
      const ticketId = crypto.randomUUID();
      setItems((prev) => [
        ...prev,
        {
          id: ticketId,
          name: label,
          status: 'uploading',
          tree: { total: tree.items.length, done: 0, failed: 0 },
        },
      ]);

      const res = await uploadTree(tree, folderId, (p) => {
        setItems((prev) =>
          prev.map((it) =>
            it.id === ticketId
              ? {
                  ...it,
                  tree: { total: p.total, done: p.done, failed: p.failed },
                  name: p.currentFile ? `${label} — ${p.currentFile}` : label,
                }
              : it,
          ),
        );
      });

      setItems((prev) =>
        prev.map((it) =>
          it.id === ticketId
            ? {
                ...it,
                status: res.failures.length > 0 ? 'error' : 'done',
                error:
                  res.failures.length > 0
                    ? `${res.failures.length} ${t('files.upload.failed')}`
                    : undefined,
                tree: {
                  total: res.uploadedFiles.length + res.failures.length,
                  done: res.uploadedFiles.length,
                  failed: res.failures.length,
                },
                name: label,
              }
            : it,
        ),
      );

      if (res.uploadedFiles.length > 0 || res.createdFolders.length > 0) {
        onUploaded(res.uploadedFiles, res.createdFolders);
      }
      // Keep error tickets so the user can read what failed; auto-dismiss success.
      if (res.failures.length === 0) {
        setTimeout(() => {
          setItems((prev) => prev.filter((it) => it.id !== ticketId));
        }, 1800);
      }
    },
    [enabled, folderId, onUploaded, addToast, t, askDuplicate],
  );

  // Page-wide drag listeners. We accept BOTH files and directories.
  useEffect(() => {
    if (!enabled) return;
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dragCounter.current += 1;
      setDragging(true);
    };
    const onLeave = () => {
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);

      const dt = e.dataTransfer;
      // Try to read the entry tree (handles directories). Falls back to
      // dt.files if webkitGetAsEntry is missing or returns no entries.
      let tree: { items: { file: File; pathSegments: string[] }[]; folderPaths: Set<string> } | null = null;
      try {
        if (dt.items && dt.items.length > 0 && typeof (dt.items[0] as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry === 'function') {
          tree = await readDataTransferTree(dt.items);
        }
      } catch {
        tree = null;
      }

      const hasDirectories = tree && tree.folderPaths.size > 0;
      if (hasDirectories && tree) {
        const rootLabel =
          // Pick the shortest folder path as the "name" of the dropped tree.
          Array.from(tree.folderPaths).sort((a, b) => a.length - b.length)[0] ?? 'folder';
        void runTreeUpload(tree, rootLabel);
      } else if (tree && tree.items.length > 0) {
        // All-file drop via the entry API.
        void uploadFlatFiles(tree.items.map((it) => it.file));
      } else {
        // Fallback to dt.files (no directories detected).
        const files = Array.from(dt.files);
        if (files.length > 0) void uploadFlatFiles(files);
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, folderId]);

  const onFlatPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void uploadFlatFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onFolderPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const tree = readWebkitDirectoryFiles(files);
    // Folder picker always gives a folder name in webkitRelativePath segment 0.
    const firstFile = files[0] as File & { webkitRelativePath?: string };
    const rel = firstFile?.webkitRelativePath ?? '';
    const rootName = rel.split('/')[0] || 'folder';
    void runTreeUpload(tree, rootName);
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  return (
    <>
      <DuplicateUploadModal
        open={pendingDupe !== null}
        incomingName={pendingDupe?.name ?? ''}
        incomingSize={pendingDupe?.size ?? 0}
        matches={pendingDupe?.matches ?? []}
        remaining={pendingDupe?.remaining ?? 0}
        onDecide={(decision, applyToRest) => {
          if (applyToRest) batchDecisionRef.current = decision;
          pendingDupe?.resolve(decision);
        }}
      />
    <>
      <input ref={fileInputRef} type="file" multiple onChange={onFlatPicked} className="hidden" />
      <input
        ref={folderInputRef}
        type="file"
        onChange={onFolderPicked}
        className="hidden"
        // These three attributes together give Chrome/Edge/Safari the folder picker.
        // @ts-expect-error — webkitdirectory/directory aren't on the React types.
        webkitdirectory=""
        directory=""
        mozdirectory=""
        multiple
      />

      {/* Full-page drag overlay */}
      {dragging && enabled && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center bg-charcoal/30 backdrop-blur-sm">
          <div className="bg-white border-4 border-dashed border-copper rounded-3xl px-12 py-10 text-center shadow-2xl shadow-copper/20">
            <CloudUpload size={56} className="text-copper mx-auto mb-3" />
            <div className="text-lg font-bold text-charcoal">{t('files.upload.dropzone_active')}</div>
          </div>
        </div>
      )}

      {/* Inline upload tickets */}
      {items.length > 0 && (
        <div className="fixed bottom-4 end-4 z-30 w-80 space-y-2 max-h-[60vh] overflow-y-auto">
          {items.map((it) => (
            <div
              key={it.id}
              className={`bg-white border rounded-xl px-3 py-2 shadow-md text-sm flex items-center gap-2 ${
                it.status === 'error' ? 'border-red-300' : 'border-sand/40'
              }`}
            >
              {it.status === 'uploading' || it.status === 'queued' ? (
                <Loader2 size={16} className="animate-spin text-copper shrink-0" />
              ) : it.status === 'done' ? (
                <div className="w-4 h-4 rounded-full bg-emerald-500 shrink-0" />
              ) : (
                <div className="w-4 h-4 rounded-full bg-red-500 shrink-0" />
              )}
              {it.tree && (
                <FolderUp size={14} className="text-copper shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-bold text-charcoal truncate">{it.name}</div>
                {it.tree ? (
                  <div className="text-xs text-charcoal/50">
                    {it.tree.done}/{it.tree.total}
                    {it.tree.failed > 0 && <span className="text-red-600"> · {it.tree.failed} failed</span>}
                  </div>
                ) : it.status === 'uploading' ? (
                  <div className="text-xs text-charcoal/50">{t('files.upload.uploading')}</div>
                ) : it.status === 'error' && it.error ? (
                  <div className="text-xs text-red-600 truncate">{it.error}</div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
    </>
  );
}
