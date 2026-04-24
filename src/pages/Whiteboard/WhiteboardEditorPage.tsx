import { useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil } from 'lucide-react';
import {
  Tldraw,
  type Editor,
  type TLComponents,
  type TLEditorSnapshot,
  type TLStoreSnapshot,
} from 'tldraw';
import 'tldraw/tldraw.css';
import { useAppStore } from '@/stores/appStore';
import { QuickConnectHandles } from './components/QuickConnectHandles';

/**
 * Whiteboard editor — one tldraw canvas per board.
 *
 * Data flow:
 *   - on mount: load `board.snapshot` into the editor (empty canvas if null)
 *   - on user edits: debounce 1500ms, then call `saveWhiteboardSnapshot`
 *     (which writes localStorage first + upserts Supabase)
 *   - on unmount: flush any pending debounce so the last few strokes aren't lost
 *
 * We don't use tldraw's `persistenceKey` — the snapshot in Supabase is the
 * single source of truth. `listen({ source: 'user', scope: 'document' })`
 * filters out remote/programmatic changes so we don't save echoes of our
 * own `loadSnapshot()` call.
 */

const SAVE_DEBOUNCE_MS = 1500;

export default function WhiteboardEditorPage(): JSX.Element {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';
  const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined;

  const board = useAppStore((s) => s.whiteboards.find((b) => b.id === boardId));
  const saveSnapshot = useAppStore((s) => s.saveWhiteboardSnapshot);
  const renameBoard = useAppStore((s) => s.renameWhiteboard);

  const saveTimerRef = useRef<number | null>(null);
  const editorRef = useRef<Editor | null>(null);

  const components = useMemo<TLComponents>(
    () => ({ InFrontOfTheCanvas: QuickConnectHandles }),
    [],
  );

  const handleRename = () => {
    if (!board) return;
    const name = window.prompt(isAr ? 'اسم جديد' : 'New name', board.name);
    if (!name || !name.trim() || name === board.name) return;
    renameBoard(board.id, name);
  };

  const onMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;

      // Load existing snapshot (if any) into the fresh store.
      if (board?.snapshot) {
        try {
          editor.loadSnapshot(board.snapshot as Partial<TLEditorSnapshot> | TLStoreSnapshot);
        } catch (err) {
          console.warn('[whiteboard] loadSnapshot failed — starting blank', err);
        }
      }

      const unsubscribe = editor.store.listen(
        () => {
          if (!board) return;
          if (saveTimerRef.current !== null) {
            window.clearTimeout(saveTimerRef.current);
          }
          saveTimerRef.current = window.setTimeout(() => {
            saveTimerRef.current = null;
            saveSnapshot(board.id, editor.getSnapshot());
          }, SAVE_DEBOUNCE_MS);
        },
        { source: 'user', scope: 'document' },
      );

      return () => {
        unsubscribe();
        // Flush any pending save so the last stroke before navigation survives.
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
          if (board) saveSnapshot(board.id, editor.getSnapshot());
        }
      };
    },
    // `board` is intentionally a dep — if the user opens a different board
    // React remounts via `key={boardId}` anyway so onMount fires fresh.
    [board, saveSnapshot],
  );

  if (!board) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-lg font-bold text-charcoal mb-2">
          {isAr ? 'اللوحة غير موجودة' : 'Board not found'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/whiteboard')}
          className="text-sm text-copper hover:text-terracotta font-bold"
        >
          {isAr ? '← العودة إلى القائمة' : '← Back to list'}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button
          type="button"
          onClick={() => navigate('/whiteboard')}
          className="p-2 rounded-lg hover:bg-cream text-charcoal/50 hover:text-charcoal transition-colors"
          aria-label={isAr ? 'العودة' : 'Back'}
          title={isAr ? 'العودة إلى القائمة' : 'Back to list'}
        >
          <ArrowLeft size={18} className="rtl:rotate-180" />
        </button>
        <h1 className="text-xl font-bold text-charcoal flex items-center gap-2">
          {board.name}
          <button
            type="button"
            onClick={handleRename}
            className="p-1.5 rounded-md hover:bg-cream text-charcoal/30 hover:text-charcoal transition-colors"
            aria-label={isAr ? 'إعادة تسمية' : 'Rename'}
            title={isAr ? 'إعادة تسمية' : 'Rename'}
          >
            <Pencil size={14} />
          </button>
        </h1>
        <span className="text-xs text-charcoal/40">
          {isAr ? 'التغييرات تحفظ تلقائياً' : 'Changes save automatically'}
        </span>
      </div>

      <div
        dir="ltr"
        className="relative h-[calc(100vh-10rem)] w-full rounded-2xl overflow-hidden border border-sand/40 bg-white"
      >
        <Tldraw
          key={board.id}
          licenseKey={licenseKey}
          components={components}
          onMount={onMount}
        />
      </div>
    </div>
  );
}
