import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderRoot } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { listFolders, moveFile } from '@/lib/files/client';
import type { FileRow, FolderRow } from '@/types';
import { useAppStore } from '@/stores/appStore';

interface Props {
  file: FileRow | null;
  open: boolean;
  onClose: () => void;
  onMoved: () => void;
}

export default function MoveToFolderModal({ file, open, onClose, onMoved }: Props) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const [allFolders, setAllFolders] = useState<FolderRow[]>([]);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCursorId(file?.folder_id ?? null);
    // Load all visible folders so we can render the picker without round-trips.
    void (async () => {
      const roots = await listFolders(null);
      // Then load children iteratively. For simplicity, load by following
      // already-discovered parents; do a single pass that's good enough for
      // typical libraries (<a few hundred folders).
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
  }, [open, file]);

  const visibleChildren = allFolders.filter((f) => f.parent_folder_id === cursorId);
  const cursor = allFolders.find((f) => f.id === cursorId) ?? null;

  const onPick = async () => {
    if (!file) return;
    // Same folder = no-op
    if ((file.folder_id ?? null) === cursorId) {
      onClose();
      return;
    }
    setWorking(true);
    try {
      await moveFile(file.id, cursorId);
      onMoved();
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setWorking(false);
    }
  };

  if (!file) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('files.move.title', { name: file.original_name })}
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
          {visibleChildren.map((f) => {
            // Disallow stepping into a folder that's the file's *current* parent
            // we don't actively disable; the user can pick it as "move to current" -> no-op.
            return (
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
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
