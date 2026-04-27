import { useEffect, useRef, useState } from 'react';
import {
  useEditor,
  useValue,
  createShapeId,
  type TLArrowBinding,
  type TLArrowShape,
  type TLGeoShape,
  type TLShape,
  type TLShapeId,
} from 'tldraw';

/**
 * Canva-style quick-connect handles.
 *
 * When the user hovers a geo shape (rectangle, ellipse, etc.), four small "+"
 * buttons appear just outside its top / right / bottom / left edges. Two
 * affordances on each handle:
 *
 *   - **Click** (no drag): create a new same-type shape 80px away in that
 *     direction and connect it to the source with an elbow arrow.
 *   - **Drag onto another shape**: connect source → target with an elbow
 *     arrow (no new shape created). Drop on empty space → falls back to the
 *     click behavior (new shape at the drop point).
 *
 * Arrows use `kind: 'elbow'` with `snap: 'edge'` on both bindings, which
 * gives them right-angle, flowchart-style routing that auto-anchors to the
 * nearest edge of each shape — symmetrical and clean even when shapes move.
 *
 * Rendered via tldraw's `components.InFrontOfTheCanvas` slot so it sits
 * above the canvas but inherits its camera transform via
 * `editor.pageToViewport` / `editor.screenToPage`. Only geo shapes trigger
 * handles — arrows, text, images, etc. are skipped.
 *
 * Hover retention: tldraw's `getHoveredShapeId()` goes null the moment the
 * cursor leaves the shape, which would hide our buttons before the user
 * could click them. We pin the last-hovered geo shape in local state and
 * only unpin when the cursor is also off every handle button (tracked via
 * an enter/leave counter) and not actively dragging a connector.
 */

type Dir = 'top' | 'right' | 'bottom' | 'left';
const DIRS: Dir[] = ['top', 'right', 'bottom', 'left'];

const DIR_VECTORS: Record<Dir, { dx: number; dy: number }> = {
  top: { dx: 0, dy: -1 },
  right: { dx: 1, dy: 0 },
  bottom: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
};

const GAP_PX = 80;
const HANDLE_SIZE = 22;
const HANDLE_OFFSET = 18;
// Pixels the cursor must move before a pointerdown becomes a "drag".
// Below this, on pointerup we treat it as a click.
const DRAG_THRESHOLD = 6;

interface DragState {
  dir: Dir;
  sourceId: TLShapeId;
  // Viewport coords (relative to tldraw container) so we can render the
  // ghost line in the same coordinate space as the handles themselves.
  startVp: { x: number; y: number };
  currentVp: { x: number; y: number };
  hoverTargetId: TLShapeId | null;
  passedThreshold: boolean;
}

export function QuickConnectHandles(): JSX.Element | null {
  const editor = useEditor();

  const hoveredShapeId = useValue(
    'quick-connect hovered id',
    () => editor.getHoveredShapeId(),
    [editor],
  );

  const [pinnedId, setPinnedId] = useState<TLShapeId | null>(null);
  const hoverCountRef = useRef(0);
  const [isOverHandle, setIsOverHandle] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
    // Don't unpin while actively dragging — the source must stay alive
    // until the drop, even if hover wanders.
    if (drag) return;
    if (hoveredShapeId) {
      const shape = editor.getShape(hoveredShapeId);
      if (shape && shape.type === 'geo') {
        setPinnedId(hoveredShapeId);
        return;
      }
    }
    if (!isOverHandle) setPinnedId(null);
  }, [hoveredShapeId, isOverHandle, editor, drag]);

  // Subscribe to camera changes so the handles reposition when the user
  // pans or zooms. pageToViewport() reads the current camera directly;
  // this subscription just triggers a re-render on camera updates.
  useValue('quick-connect camera', () => editor.getCamera(), [editor]);

  // The container we live in is positioned at the same origin as the
  // tldraw canvas (we're inside InFrontOfTheCanvas). Container-relative
  // coords therefore equal viewport coords minus container.left/top.
  // We capture the container ref once so screen → viewport conversions
  // are stable across renders.
  const containerRef = useRef<HTMLDivElement | null>(null);

  const screenToContainer = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  // ---------------------------------------------------------------------
  // Connection action — creates an elbow arrow, optionally also creates
  // a target shape if no `targetId` is provided (the click case).
  // ---------------------------------------------------------------------

  const createElbowConnection = (
    sourceId: TLShapeId,
    target: { kind: 'existing'; shape: TLShape } | { kind: 'new'; dir: Dir },
  ) => {
    const src = editor.getShape(sourceId) as TLGeoShape | undefined;
    if (!src) return;
    const srcBounds = editor.getShapePageBounds(sourceId);
    if (!srcBounds) return;

    const arrowId = createShapeId();
    // Decide the target shape id BEFORE entering editor.run so it's
    // unambiguous to the type checker (and so subsequent calls can
    // reference it freely).
    const targetId: TLShapeId =
      target.kind === 'existing' ? target.shape.id : createShapeId();

    editor.run(() => {
      if (target.kind === 'new') {
        const { dx, dy } = DIR_VECTORS[target.dir];
        const newX = src.x + dx * (srcBounds.w + GAP_PX);
        const newY = src.y + dy * (srcBounds.h + GAP_PX);
        editor.createShape<TLGeoShape>({
          id: targetId,
          type: 'geo',
          x: newX,
          y: newY,
          rotation: src.rotation,
          props: { ...src.props },
        });
      }

      editor.createShape<TLArrowShape>({
        id: arrowId,
        type: 'arrow',
        // Elbow arrows give right-angle, flowchart-style routing — the
        // visual style the user is after when building diagrams.
        props: { kind: 'elbow' },
      });

      editor.createBindings<TLArrowBinding>([
        {
          type: 'arrow',
          fromId: arrowId,
          toId: sourceId,
          props: {
            terminal: 'start',
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: false,
            // 'edge' makes the arrow auto-attach to the nearest edge of
            // the source shape, keeping the connector clean as shapes
            // move around.
            snap: 'edge',
          },
        },
        {
          type: 'arrow',
          fromId: arrowId,
          toId: targetId,
          props: {
            terminal: 'end',
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: false,
            snap: 'edge',
          },
        },
      ]);
    });

    if (target.kind === 'new') {
      editor.select(targetId);
    }
  };

  // ---------------------------------------------------------------------
  // Drag plumbing
  // ---------------------------------------------------------------------

  const onHandlePointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    dir: Dir,
  ) => {
    if (!pinnedId) return;
    e.stopPropagation();
    e.preventDefault();

    const startVp = positions[dir];
    setDrag({
      dir,
      sourceId: pinnedId,
      startVp,
      currentVp: { x: startVp.x, y: startVp.y },
      hoverTargetId: null,
      passedThreshold: false,
    });

    // Capture so we keep getting move/up events even if the cursor leaves
    // the small button area.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const vp = screenToContainer(e.clientX, e.clientY);
    const dx = vp.x - drag.startVp.x;
    const dy = vp.y - drag.startVp.y;
    const passed = drag.passedThreshold || Math.hypot(dx, dy) >= DRAG_THRESHOLD;

    let hoverTargetId: TLShapeId | null = null;
    if (passed) {
      const pagePoint = editor.screenToPage({ x: e.clientX, y: e.clientY });
      const targetShape = editor.getShapeAtPoint(pagePoint, { hitInside: true });
      if (
        targetShape &&
        targetShape.id !== drag.sourceId &&
        targetShape.type === 'geo'
      ) {
        hoverTargetId = targetShape.id;
      }
    }

    setDrag({ ...drag, currentVp: vp, hoverTargetId, passedThreshold: passed });
  };

  const onHandlePointerUp = (
    e: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!drag) return;
    e.stopPropagation();

    if (!drag.passedThreshold) {
      // Treated as a click — current behavior: spawn new shape.
      createElbowConnection(drag.sourceId, { kind: 'new', dir: drag.dir });
    } else if (drag.hoverTargetId) {
      const targetShape = editor.getShape(drag.hoverTargetId);
      if (targetShape) {
        createElbowConnection(drag.sourceId, { kind: 'existing', shape: targetShape });
      }
    } else {
      // Dropped on empty space — fall back to creating a new shape at the
      // drop direction (same direction as the original handle for
      // simplicity). Could be smarter and place at the cursor, but this
      // matches the click-to-create behavior the user already knows.
      createElbowConnection(drag.sourceId, { kind: 'new', dir: drag.dir });
    }

    setDrag(null);
  };

  // ---------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------

  if (!pinnedId) return null;
  const source = editor.getShape(pinnedId) as TLGeoShape | undefined;
  if (!source || source.type !== 'geo') return null;
  const bounds = editor.getShapePageBounds(pinnedId);
  if (!bounds) return null;

  const centers = {
    top: editor.pageToViewport({ x: bounds.x + bounds.w / 2, y: bounds.y }),
    right: editor.pageToViewport({ x: bounds.x + bounds.w, y: bounds.y + bounds.h / 2 }),
    bottom: editor.pageToViewport({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h }),
    left: editor.pageToViewport({ x: bounds.x, y: bounds.y + bounds.h / 2 }),
  };

  const positions: Record<Dir, { x: number; y: number }> = {
    top: { x: centers.top.x, y: centers.top.y - HANDLE_OFFSET },
    right: { x: centers.right.x + HANDLE_OFFSET, y: centers.right.y },
    bottom: { x: centers.bottom.x, y: centers.bottom.y + HANDLE_OFFSET },
    left: { x: centers.left.x - HANDLE_OFFSET, y: centers.left.y },
  };

  const handlePointerEnter = () => {
    hoverCountRef.current += 1;
    setIsOverHandle(true);
  };
  const handlePointerLeave = () => {
    hoverCountRef.current = Math.max(0, hoverCountRef.current - 1);
    if (hoverCountRef.current === 0) setIsOverHandle(false);
  };

  // Highlight rectangle for the drag-target shape (if any).
  const targetHighlight = (() => {
    if (!drag?.hoverTargetId) return null;
    const targetBounds = editor.getShapePageBounds(drag.hoverTargetId);
    if (!targetBounds) return null;
    const tl = editor.pageToViewport({ x: targetBounds.x, y: targetBounds.y });
    const br = editor.pageToViewport({
      x: targetBounds.x + targetBounds.w,
      y: targetBounds.y + targetBounds.h,
    });
    return {
      left: tl.x,
      top: tl.y,
      width: br.x - tl.x,
      height: br.y - tl.y,
    };
  })();

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    >
      {/* Ghost line from handle to cursor while dragging */}
      {drag && drag.passedThreshold && (
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          <line
            x1={drag.startVp.x}
            y1={drag.startVp.y}
            x2={drag.currentVp.x}
            y2={drag.currentVp.y}
            stroke="#B8734F"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
        </svg>
      )}

      {/* Highlight ring on the shape being targeted */}
      {targetHighlight && (
        <div
          style={{
            position: 'absolute',
            left: targetHighlight.left - 3,
            top: targetHighlight.top - 3,
            width: targetHighlight.width + 6,
            height: targetHighlight.height + 6,
            border: '2px solid #B8734F',
            borderRadius: 8,
            pointerEvents: 'none',
            boxShadow: '0 0 0 4px rgba(184, 115, 79, 0.15)',
          }}
        />
      )}

      {/* The four "+" handles */}
      {DIRS.map((dir) => (
        <button
          key={dir}
          type="button"
          onPointerDown={(e) => onHandlePointerDown(e, dir)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          title={`Click to add a connected shape, drag to connect to an existing shape`}
          aria-label={`Connect from ${dir}`}
          style={{
            position: 'absolute',
            left: positions[dir].x,
            top: positions[dir].y,
            transform: 'translate(-50%, -50%)',
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            borderRadius: '50%',
            border: '1.5px solid #B8734F',
            background: 'white',
            color: '#B8734F',
            cursor: drag ? 'grabbing' : 'crosshair',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            lineHeight: 1,
            padding: 0,
            pointerEvents: 'auto',
            boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
            fontFamily: 'system-ui, sans-serif',
            // Prevent the OS from interpreting the drag as a text-selection
            // gesture, which can interrupt the pointer-capture flow.
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          +
        </button>
      ))}
    </div>
  );
}
