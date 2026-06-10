import { useEffect, useState } from 'react';
import { ChevronRight, Folder, Loader2, FileText, Check, FolderOpen } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { listFiles, listFolders } from '@/lib/files/client';
import { isDeckAttachableName } from '@/lib/decks/client';
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
  /** Called with the chosen file. The parent does the copy into the deck. */
  onPick: (file: FileRow) => void;
}

/**
 * Lightweight browser over the internal Files library, scoped to picking ONE
 * file to attach to a deck. Navigates folders like the Files page (root →
 * subfolders), lists files at each level, and lets the user select a single
 * deck-readable file. Files whose type the sandbox can't read are shown but
 * disabled, so a user isn't left wondering why their file "disappeared".
 *
 * Reads go through the same RLS-gated `listFolders` / `listFiles` helpers the
 * Files page uses, so the user only ever sees what they're allowed to.
 */
export default function PickFromFilesModal({ open, isAr, onClose, onPick }: Props) {
  const [stack, setStack] = useState<Crumb[]>([{ id: null, name: '' }]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cursor = stack[stack.length - 1] ?? { id: null, name: '' };

  // Reset to root every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStack([{ id: null, name: '' }]);
    setSelectedId(null);
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

  const selectedFile = files.find((f) => f.id === selectedId) ?? null;

  function enterFolder(f: FolderRow) {
    setSelectedId(null);
    setStack((s) => [...s, { id: f.id, name: f.name }]);
  }

  function jumpTo(idx: number) {
    setSelectedId(null);
    setStack((s) => s.slice(0, idx + 1));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidth="max-w-2xl"
      title={isAr ? 'اختر ملفًا من الملفات' : 'Choose a file from Files'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button onClick={() => selectedFile && onPick(selectedFile)} disabled={!selectedFile}>
            {isAr ? 'إرفاق' : 'Attach'}
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
              const supported = isDeckAttachableName(f.original_name);
              const selected = f.id === selectedId;
              const sizeMb = (f.size_bytes / 1024 / 1024).toFixed(f.size_bytes < 1024 * 1024 ? 2 : 1);
              return (
                <li key={`file-${f.id}`}>
                  <button
                    type="button"
                    disabled={!supported}
                    onClick={() => setSelectedId(f.id)}
                    title={
                      !supported
                        ? isAr
                          ? 'نوع غير مدعوم للإرفاق'
                          : 'Unsupported type for attachments'
                        : undefined
                    }
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-start border transition-colors ${
                      selected ? 'border-copper bg-copper/10' : 'border-transparent hover:bg-cream'
                    } ${!supported ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <FileText
                      size={16}
                      className={`shrink-0 ${selected ? 'text-copper' : 'text-charcoal/50'}`}
                    />
                    <span className="flex-1 truncate text-charcoal">{f.original_name}</span>
                    <span className="text-[11px] text-charcoal/40 shrink-0">{sizeMb} MB</span>
                    {selected && <Check size={14} className="text-copper shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-charcoal/50 mt-3">
        {isAr
          ? 'يمكن إرفاق ملفات Excel وPDF وPowerPoint وWord والصور والنصوص (حد أقصى ٣٢ ميجابايت).'
          : 'Excel, PDF, PowerPoint, Word, images, and text files can be attached (32 MB max).'}
      </p>
    </Modal>
  );
}
