import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Maximize2, Minimize2 } from 'lucide-react';
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
import PromptModal from './components/PromptModal';

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
  const [renameOpen, setRenameOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // While in fullscreen, the canvas wrapper becomes a `fixed inset-0`
  // overlay that paints over the sidebar/header. We keep the same DOM
  // tree (no portal, no route swap) so tldraw's editor instance survives
  // the toggle and we don't lose in-memory state. Esc exits fullscreen
  // — we only register the listener while fullscreen is on, and we use
  // capture phase so we beat tldraw's own keydown handlers (which would
  // otherwise eat the Esc for tool cancel).
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [isFullscreen]);

  const components = useMemo<TLComponents>(
    () => ({ InFrontOfTheCanvas: QuickConnectHandles }),
    [],
  );

  const handleRenameSubmit = (name: string) => {
    if (!board || name === board.name) {
      setRenameOpen(false);
      return;
    }
    renameBoard(board.id, name);
    setRenameOpen(false);
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
            onClick={() => setRenameOpen(true)}
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
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setIsFullscreen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold text-charcoal/70 hover:bg-cream hover:text-charcoal transition-colors"
          aria-label={isAr ? 'وضع ملء الشاشة' : 'Fullscreen mode'}
          title={isAr ? 'وضع ملء الشاشة' : 'Fullscreen mode'}
        >
          <Maximize2 size={14} />
          <span className="hidden sm:inline">{isAr ? 'ملء الشاشة' : 'Fullscreen'}</span>
        </button>
      </div>

      <div
        dir="ltr"
        className={
          isFullscreen
            ? 'fixed inset-0 z-[60] bg-white'
            : 'relative h-[calc(100vh-10rem)] w-full rounded-2xl overflow-hidden border border-sand/40 bg-white'
        }
      >
        <Tldraw
          key={board.id}
          licenseKey={licenseKey}
          components={components}
          onMount={onMount}
        />
        {isFullscreen && (
          <button
            type="button"
            onClick={() => setIsFullscreen(false)}
            className="absolute top-3 end-3 z-[61] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/95 hover:bg-cream border border-sand/40 shadow-md text-sm font-bold text-charcoal transition-colors"
            aria-label={isAr ? 'الخروج من ملء الشاشة' : 'Exit fullscreen'}
            title={isAr ? 'الخروج (Esc)' : 'Exit (Esc)'}
          >
            <Minimize2 size={14} />
            <span>{isAr ? 'خروج' : 'Exit'}</span>
          </button>
        )}
      </div>

      <PromptModal
        open={renameOpen}
        title={isAr ? 'إعادة تسمية اللوحة' : 'Rename board'}
        label={isAr ? 'اسم جديد' : 'New name'}
        initialValue={board.name}
        submitLabel={isAr ? 'حفظ' : 'Save'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
        onSubmit={handleRenameSubmit}
        onClose={() => setRenameOpen(false)}
      />
    </div>
  );
}
