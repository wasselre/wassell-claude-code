import { useRef, useState } from 'react';
import {
  useEditor,
  useValue,
  createShapeId,
  type TLArrowBinding,
  type TLArrowShape,
  type TLGeoShape,
  type TLShapeId,
} from 'tldraw';

/**
 * Canva-style quick-connect handles.
 *
 * When the user **selects** a single geo shape (rectangle, ellipse, etc.) by
 * clicking it, four small "+" buttons appear just outside its top / right /
 * bottom / left edges. Hover does NOT trigger them — too noisy when the user
 * is just moving the cursor across the canvas — and they're hidden while the
 * shape is being text-edited so they don't sit on top of the user's typing.
 *
 * Two affordances on each handle:
 *
 *   - **Click** (no drag): create a new same-type shape 80 px away in that
 *     direction and connect it to the source with an elbow arrow whose start
 *     is bound to the source's edge **on that side** and end is bound to the
 *     new shape's opposite edge.
 *   - **Drag onto another shape**: connect source → target with an elbow
 *     arrow. Source anchor is the side of the handle the user pulled from;
 *     target anchor is the edge of the target nearest to the cursor at drop
 *     time. Both endpoints are pinned with `isPrecise: true` and
 *     `snap: 'edge-point'`, so they don't drift to a different edge when
 *     either shape later moves — the user's chosen sides stay put.
 *
 * Rendered via tldraw's `components.InFrontOfTheCanvas` slot so it sits
 * above the canvas but inherits its camera transform via
 * `editor.pageToViewport` / `editor.screenToPage`. Only geo shapes trigger
 * handles — arrows, text, images, etc. are skipped.
 */

type Dir = 'top' | 'right' | 'bottom' | 'left';
const DIRS: Dir[] = ['top', 'right', 'bottom', 'left'];

const DIR_VECTORS: Record<Dir, { dx: number; dy: number }> = {
  top: { dx: 0, dy: -1 },
  right: { dx: 1, dy: 0 },
  bottom: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
};

// The exact edge-center anchor for each side, in shape-normalized coords.
// `isPrecise: true` + `snap: 'edge-point'` together tell tldraw to bind
// the arrow terminal to *this* point and not slide to a different edge
// when the other shape moves.
const DIR_ANCHOR: Record<Dir, { x: number; y: number }> = {
  top: { x: 0.5, y: 0 },
  right: { x: 1, y: 0.5 },
  bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 },
};

// When the user drags from a "+" on the source's bottom and drops on the
// target's top, we want the arrow to attach to the corresponding side of
// each shape. The opposite side is the natural target side for the
// click-to-create path (e.g. source-bottom → new-shape-top).
const OPPOSITE_DIR: Record<Dir, Dir> = {
  top: 'bottom',
  right: 'left',
  bottom: 'top',
  left: 'right',
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

/** Pick the closest cardinal edge of a shape to a given page point. */
function nearestEdgeDir(
  bounds: { x: number; y: number; w: number; h: number },
  pagePoint: { x: number; y: number },
): Dir {
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const dx = pagePoint.x - cx;
  const dy = pagePoint.y - cy;
  // Normalize by half-width / half-height so a point near the long edge
  // of a wide shape is correctly classified.
  const nx = dx / (bounds.w / 2);
  const ny = dy / (bounds.h / 2);
  if (Math.abs(nx) > Math.abs(ny)) return nx > 0 ? 'right' : 'left';
  return ny > 0 ? 'bottom' : 'top';
}

export function QuickConnectHandles(): JSX.Element | null {
  const editor = useEditor();

  // Reactive single-selection lookup. Returns the shape only if exactly
  // one is selected — multi-select / marquee don't surface handles.
  // Hidden while the shape is being text-edited so we don't sit on top
  // of the user's typing.
  const target = useValue(
    'quick-connect target',
    () => {
      const ids = editor.getSelectedShapeIds();
      if (ids.length !== 1) return null;
      const id = ids[0];
      if (!id) return null;
      const editingId = editor.getEditingShapeId();
      if (editingId === id) return null;
      const shape = editor.getShape(id);
      if (!shape || shape.type !== 'geo') return null;
      return shape;
    },
    [editor],
  );

  // Subscribe to camera changes so the handles reposition when the user
  // pans or zooms. pageToViewport() reads the current camera directly;
  // this subscription just triggers a re-render on camera updates.
  useValue('quick-connect camera', () => editor.getCamera(), [editor]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const screenToContainer = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  // ---------------------------------------------------------------------
  // Connection action — creates an elbow arrow with explicit anchor
  // points on both ends so neither end drifts when shapes move.
  // ---------------------------------------------------------------------

  const createElbowConnection = (
    sourceId: TLShapeId,
    sourceDir: Dir,
    spec:
      | { kind: 'new'; dir: Dir }
      | { kind: 'existing'; targetId: TLShapeId; targetDir: Dir },
  ) => {
    const src = editor.getShape(sourceId) as TLGeoShape | undefined;
    if (!src) return;
    const srcBounds = editor.getShapePageBounds(sourceId);
    if (!srcBounds) return;

    const arrowId = createShapeId();
    const targetId: TLShapeId =
      spec.kind === 'existing' ? spec.targetId : createShapeId();
    const targetDir: Dir =
      spec.kind === 'existing' ? spec.targetDir : OPPOSITE_DIR[sourceDir];

    editor.run(() => {
      if (spec.kind === 'new') {
        const { dx, dy } = DIR_VECTORS[spec.dir];
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
            normalizedAnchor: DIR_ANCHOR[sourceDir],
            isExact: false,
            // isPrecise: true tells tldraw to bind to *this exact* anchor
            // instead of the shape's center; combined with `edge-point`
            // snap mode it pins the terminal to the chosen edge so it
            // doesn't slide to a different edge when shapes move.
            isPrecise: true,
            snap: 'edge-point',
          },
        },
        {
          type: 'arrow',
          fromId: arrowId,
          toId: targetId,
          props: {
            terminal: 'end',
            normalizedAnchor: DIR_ANCHOR[targetDir],
            isExact: false,
            isPrecise: true,
            snap: 'edge-point',
          },
        },
      ]);
    });

    if (spec.kind === 'new') {
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
    if (!target) return;
    e.stopPropagation();
    e.preventDefault();

    const startVp = positions[dir];
    setDrag({
      dir,
      sourceId: target.id,
      startVp,
      currentVp: { x: startVp.x, y: startVp.y },
      hoverTargetId: null,
      passedThreshold: false,
    });

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
      const candidate = editor.getShapeAtPoint(pagePoint, { hitInside: true });
      if (
        candidate &&
        candidate.id !== drag.sourceId &&
        candidate.type === 'geo'
      ) {
        hoverTargetId = candidate.id;
      }
    }

    setDrag({ ...drag, currentVp: vp, hoverTargetId, passedThreshold: passed });
  };

  const onHandlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    e.stopPropagation();

    if (!drag.passedThreshold) {
      // Click: spawn a new shape on the chosen side.
      createElbowConnection(drag.sourceId, drag.dir, {
        kind: 'new',
        dir: drag.dir,
      });
    } else if (drag.hoverTargetId) {
      // Drag onto a shape: pick the target's closest edge to the drop
      // point so the arrow lands where the user actually let go.
      const targetBounds = editor.getShapePageBounds(drag.hoverTargetId);
      if (targetBounds) {
        const dropPagePoint = editor.screenToPage({
          x: e.clientX,
          y: e.clientY,
        });
        const targetDir = nearestEdgeDir(targetBounds, dropPagePoint);
        createElbowConnection(drag.sourceId, drag.dir, {
          kind: 'existing',
          targetId: drag.hoverTargetId,
          targetDir,
        });
      }
    } else {
      // Dropped on empty space — fall back to spawning a new shape on
      // the chosen side. (Could place at the drop point instead, but
      // keeping the handle direction makes the result predictable.)
      createElbowConnection(drag.sourceId, drag.dir, {
        kind: 'new',
        dir: drag.dir,
      });
    }

    setDrag(null);
  };

  // ---------------------------------------------------------------------
  // Geometry — runs after target/drag short-circuits below
  // ---------------------------------------------------------------------

  if (!target) return null;
  const bounds = editor.getShapePageBounds(target.id);
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

      {DIRS.map((dir) => (
        <button
          key={dir}
          type="button"
          onPointerDown={(e) => onHandlePointerDown(e, dir)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          title="Click to add a connected shape, drag to connect to an existing shape"
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
