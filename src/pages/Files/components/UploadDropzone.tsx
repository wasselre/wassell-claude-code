import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudUpload, Loader2 } from 'lucide-react';
import { uploadFile } from '@/lib/files/client';
import type { FileRow } from '@/types';
import { useAppStore } from '@/stores/appStore';

interface Props {
  folderId: string | null;
  enabled: boolean;
  onUploaded: (rows: FileRow[]) => void;
}

interface UploadingItem {
  id: string;
  name: string;
  size: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
}

/**
 * Inline, page-wide drop target. We render a hidden overlay that becomes
 * visible on dragenter at the document level so the user can drop anywhere
 * on the page. Also exposes a hidden <input type="file"> the FilesPage
 * triggers from its Upload button.
 */
export default function UploadDropzone({ folderId, enabled, onUploaded }: Props) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<UploadingItem[]>([]);
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Imperative API on window so FilesPage's Upload button can trigger picker.
  useEffect(() => {
    const opener = () => inputRef.current?.click();
    window.addEventListener('files:open-picker', opener);
    return () => window.removeEventListener('files:open-picker', opener);
  }, []);

  // Page-wide drag listeners. We track a counter so child dragenter/leaves
  // don't toggle the overlay unexpectedly.
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
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void uploadAll(files);
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

  const uploadAll = useCallback(
    async (files: File[]) => {
      if (!enabled) {
        addToast(t('files.no_permission'), 'error');
        return;
      }
      // Concurrency 3 — Promise.all-with-pool.
      const tickets: UploadingItem[] = files.map((f) => ({
        id: crypto.randomUUID(),
        name: f.name,
        size: f.size,
        status: 'queued',
      }));
      setItems((prev) => [...prev, ...tickets]);

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
            const row = await uploadFile(file, { folderId });
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
      if (successRows.length > 0) onUploaded(successRows);
      // Auto-clear successful tickets after a beat — keep errors visible.
      setTimeout(() => {
        setItems((prev) => prev.filter((it) => it.status === 'error'));
      }, 1500);
    },
    [enabled, folderId, onUploaded, addToast, t],
  );

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void uploadAll(files);
    // Reset so picking the same file again triggers a fresh upload.
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <>
      <input ref={inputRef} type="file" multiple onChange={onPicked} className="hidden" />

      {/* Full-page drag overlay */}
      {dragging && enabled && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center bg-charcoal/30 backdrop-blur-sm">
          <div className="bg-white border-4 border-dashed border-copper rounded-3xl px-12 py-10 text-center shadow-2xl shadow-copper/20">
            <CloudUpload size={56} className="text-copper mx-auto mb-3" />
            <div className="text-lg font-bold text-charcoal">{t('files.upload.dropzone_active')}</div>
          </div>
        </div>
      )}

      {/* Inline uploading-tickets list (bottom-right toast-style stack) */}
      {items.length > 0 && (
        <div className="fixed bottom-4 end-4 z-30 w-80 space-y-2">
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
              <div className="flex-1 min-w-0">
                <div className="font-bold text-charcoal truncate">{it.name}</div>
                {it.status === 'error' && <div className="text-xs text-red-600 truncate">{it.error}</div>}
                {it.status === 'uploading' && (
                  <div className="text-xs text-charcoal/50">{t('files.upload.uploading')}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
