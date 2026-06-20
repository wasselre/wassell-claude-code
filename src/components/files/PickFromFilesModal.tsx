import { useEffect, useState } from 'react';
import { ChevronRight, Folder, Loader2, FileText, Check, FolderOpen } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { listFiles, listFolders } from '@/lib/files/client';
import type { FileRow, FolderRow } from '@/types';

interface Crumb {
  /** null = the Files root (folder_id IS NULL). */
  id: string | null;
  name: string;
}

interface Props {
  open: boolean;
  isAr: boolean;
  onClose: () => void;
  /** Called with the chosen file(s) when the user confirms. Always an array
   * (one entry in single-select mode). The parent does whatever copy/attach. */
  onConfirm: (files: FileRow[]) => void;
  /** Allow selecting more than one file (selection persists across folders).
   * Default: single-select. */
  multiple?: boolean;
  /** Which files are selectable. Others are shown but disabled (so a user isn't
   * left wondering why their file "disappeared"). Default: everything. */
  isSelectable?: (file: FileRow) => boolean;
  /** Modal title. */
  title?: string;
  /** Footer confirm-button label. */
  confirmLabel?: string;
  /** Small hint line under the list (e.g. supported types). */
  hint?: string;
}

/**
 * Lightweight browser over the internal Files library for picking one or more
 * existing files. Navigates folders like the Files page (root → subfolders),
 * lists files at each level, and lets the caller restrict which files are
 * selectable via `isSelectable`. Reads go through the same RLS-gated
 * `listFolders` / `listFiles` helpers the Files page uses, so the user only
 * ever sees what they're allowed to.
 *
 * Generalized from the original Decks-only picker so Decks, Data Migration, and
 * any future caller share one browser instead of duplicating it.
 */
export default function PickFromFilesModal({
  open,
  isAr,
  onClose,
  onConfirm,
  multiple = false,
  isSelectable,
  title,
  confirmLabel,
  hint,
}: Props) {
  const [stack, setStack] = useState<Crumb[]>([{ id: null, name: '' }]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Selected files kept as full rows (not ids) so a multi-select survives folder
  // navigation — the chosen rows may live in folders we've since left.
  const [selected, setSelected] = useState<FileRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cursor = stack[stack.length - 1] ?? { id: null, name: '' };
  const canSelect = (f: FileRow) => (isSelectable ? isSelectable(f) : true);
  const isPicked = (id: string) => selected.some((f) => f.id === id);

  // Reset to root every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStack([{ id: null, name: '' }]);
    setSelected([]);
    setError(null);
  }, [open]);

  // Load the current folder's contents whenever the cursor changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [fol, fil] = await Promise.all([listFolders(cursor.id), listFiles(cursor.id)]);
        if (cancelled) return;
        setFolders(fol);
        setFiles(fil);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setFolders([]);
        setFiles([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, cursor.id]);

  function enterFolder(f: FolderRow) {
    // Single-select clears on navigation (a pick in the new folder replaces it);
    // multi-select keeps the running selection so files from several folders can
    // be picked together.
    if (!multiple) setSelected([]);
    setStack((s) => [...s, { id: f.id, name: f.name }]);
  }

  function jumpTo(idx: number) {
    if (!multiple) setSelected([]);
    setStack((s) => s.slice(0, idx + 1));
  }

  function toggleFile(file: FileRow) {
    if (!multiple) {
      setSelected([file]);
      return;
    }
    setSelected((sel) =>
      sel.some((f) => f.id === file.id) ? sel.filter((f) => f.id !== file.id) : [...sel, file],
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidth="max-w-2xl"
      title={title ?? (isAr ? 'اختر ملفًا من الملفات' : 'Choose a file from Files')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button onClick={() => selected.length > 0 && onConfirm(selected)} disabled={selected.length === 0}>
            {(confirmLabel ?? (isAr ? 'إرفاق' : 'Attach')) +
              (multiple && selected.length > 0 ? ` (${selected.length})` : '')}
          </Button>
        </>
      }
    >
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 flex-wrap px-3 py-2 rounded-lg bg-cream/60 text-sm mb-3">
        {stack.map((c, i) => (
          <span key={`${c.id ?? 'root'}-${i}`} className="flex items-center gap-1 min-w-0">
            {i > 0 && <ChevronRight size={14} className="text-charcoal/30 shrink-0" />}
            <button
              type="button"
              onClick={() => jumpTo(i)}
              className={`hover:text-copper truncate max-w-[12rem] ${
                i === stack.length - 1 ? 'font-bold text-charcoal' : 'text-charcoal/70'
              }`}
            >
              {i === 0 ? (isAr ? 'الملفات' : 'Files') : c.name}
            </button>
          </span>
        ))}
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-2 mb-3">
          {error}
        </div>
      )}

      <div className="max-h-[22rem] overflow-y-auto -mx-1 px-1">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-charcoal/40">
            <Loader2 size={22} className="animate-spin" />
          </div>
        ) : (
          <ul className="space-y-1">
            {folders.length === 0 && files.length === 0 && (
              <li className="flex flex-col items-center gap-2 text-sm text-charcoal/40 px-3 py-12 text-center">
                <FolderOpen size={28} className="opacity-50" />
                {isAr ? 'هذا المجلد فارغ.' : 'This folder is empty.'}
              </li>
            )}

            {folders.map((f) => (
              <li key={`fol-${f.id}`}>
                <button
                  type="button"
                  onClick={() => enterFolder(f)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-cream transition-colors text-start"
                >
                  <Folder size={16} className="text-copper shrink-0" />
                  <span className="flex-1 truncate font-medium text-charcoal">{f.name}</span>
                  <ChevronRight size={14} className="text-charcoal/30 shrink-0" />
                </button>
              </li>
            ))}

            {files.map((f) => {
              const supported = canSelect(f);
              const selectedNow = isPicked(f.id);
              const sizeMb = (f.size_bytes / 1024 / 1024).toFixed(f.size_bytes < 1024 * 1024 ? 2 : 1);
              return (
                <li key={`file-${f.id}`}>
                  <button
                    type="button"
                    disabled={!supported}
                    onClick={() => toggleFile(f)}
                    title={
                      !supported
                        ? isAr
                          ? 'نوع غير مدعوم'
                          : 'Unsupported type'
                        : undefined
                    }
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-start border transition-colors ${
                      selectedNow ? 'border-copper bg-copper/10' : 'border-transparent hover:bg-cream'
                    } ${!supported ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <FileText
                      size={16}
                      className={`shrink-0 ${selectedNow ? 'text-copper' : 'text-charcoal/50'}`}
                    />
                    <span className="flex-1 truncate text-charcoal">{f.original_name}</span>
                    <span className="text-[11px] text-charcoal/40 shrink-0">{sizeMb} MB</span>
                    {selectedNow && <Check size={14} className="text-copper shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {hint && <p className="text-[11px] text-charcoal/50 mt-3">{hint}</p>}
    </Modal>
  );
}
