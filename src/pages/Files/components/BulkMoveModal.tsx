import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderRoot } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { listFolders, moveFile } from '@/lib/files/client';
import type { FileRow, FolderRow } from '@/types';
import { useAppStore } from '@/stores/appStore';

interface Props {
  files: FileRow[];
  open: boolean;
  onClose: () => void;
  onMoved: () => void;
}

/**
 * Bulk version of MoveToFolderModal — accepts an array of files and moves
 * them sequentially. Folders in the selection are NOT moved here (separate
 * feature) — the caller filters them out before opening.
 */
export default function BulkMoveModal({ files, open, onClose, onMoved }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [allFolders, setAllFolders] = useState<FolderRow[]>([]);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Default cursor: the folder the first file is in (matches MoveToFolderModal).
    setCursorId(files[0]?.folder_id ?? null);
    void (async () => {
      const roots = await listFolders(null);
      const seen = new Map<string, FolderRow>();
      roots.forEach((f) => seen.set(f.id, f));
      const queue: string[] = roots.map((f) => f.id);
      while (queue.length > 0) {
        const id = queue.shift()!;
        const kids = await listFolders(id);
        kids.forEach((k) => {
          if (!seen.has(k.id)) {
            seen.set(k.id, k);
            queue.push(k.id);
          }
        });
      }
      setAllFolders(Array.from(seen.values()));
    })();
  }, [open, files]);

  const visibleChildren = allFolders.filter((f) => f.parent_folder_id === cursorId);
  const cursor = allFolders.find((f) => f.id === cursorId) ?? null;

  const onPick = async () => {
    if (files.length === 0) return;
    setWorking(true);
    let ok = 0;
    let failed = 0;
    for (const f of files) {
      // Skip rows already in the target folder.
      if ((f.folder_id ?? null) === cursorId) {
        ok += 1;
        continue;
      }
      try {
        await moveFile(f.id, cursorId);
        ok += 1;
      } catch {
        // moveFile already toasts via surfaceError; just count.
        failed += 1;
      }
    }
    setWorking(false);
    addToast(
      t('files.bulk.move_summary', { ok, total: files.length }),
      failed === 0 ? 'success' : 'error',
    );
    onMoved();
    onClose();
  };

  if (files.length === 0) return null;

  const title = isAr
    ? `نقل ${files.length} ملف`
    : `Move ${files.length} file${files.length === 1 ? '' : 's'}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onPick} disabled={working}>
            {t('files.move.button')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cream/60 text-sm">
          <FolderRoot size={16} className="text-copper" />
          <button
            onClick={() => setCursorId(null)}
            className="font-bold text-charcoal hover:text-copper"
          >
            {t('files.move.root')}
          </button>
          {cursor && (
            <>
              <ChevronRight size={14} className="text-charcoal/30" />
              <span className="text-charcoal truncate">{cursor.name}</span>
            </>
          )}
        </div>
        <ul className="max-h-64 overflow-y-auto space-y-1">
          {visibleChildren.length === 0 && (
            <li className="text-sm text-charcoal/40 px-3 py-2">{t('files.empty.folder')}</li>
          )}
          {visibleChildren.map((f) => (
            <li key={f.id}>
              <button
                onClick={() => setCursorId(f.id)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-cream transition-colors text-start"
              >
                <Folder size={16} className="text-copper" />
                <span className="flex-1 truncate font-bold text-charcoal">{f.name}</span>
                <ChevronRight size={14} className="text-charcoal/30" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
