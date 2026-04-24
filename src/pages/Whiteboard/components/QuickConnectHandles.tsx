import { useEffect, useRef, useState } from 'react';
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
 * Miro-style quick-connect handles.
 *
 * When the user hovers a geo shape (rectangle, ellipse, etc.), four small "+"
 * buttons appear just outside its top / right / bottom / left edges. Clicking
 * one creates a new shape of the same type offset in that direction and
 * connects it to the source with an arrow (both ends bound).
 *
 * Rendered via tldraw's `components.InFrontOfTheCanvas` slot so it sits above
 * the canvas but inherits its camera transform via `editor.pageToViewport`.
 * Only geo shapes trigger handles — arrows, text, images, etc. are skipped.
 *
 * Hover retention: tldraw's `getHoveredShapeId()` goes null the moment the
 * cursor leaves the shape, which would hide our buttons before the user
 * could click them. We pin the last-hovered geo shape in local state and
 * only unpin when the cursor is also off every handle button, tracked via
 * an enter/leave counter on each button.
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

  useEffect(() => {
    if (hoveredShapeId) {
      const shape = editor.getShape(hoveredShapeId);
      if (shape && shape.type === 'geo') {
        setPinnedId(hoveredShapeId);
        return;
      }
    }
    if (!isOverHandle) setPinnedId(null);
  }, [hoveredShapeId, isOverHandle, editor]);

  // Subscribe to camera changes so the handles reposition when the user
  // pans or zooms. pageToViewport() reads the current camera directly;
  // this subscription just triggers a re-render on camera updates.
  useValue('quick-connect camera', () => editor.getCamera(), [editor]);

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

  const connect = (dir: Dir) => {
    const src = editor.getShape(pinnedId) as TLGeoShape | undefined;
    if (!src) return;
    const srcBounds = editor.getShapePageBounds(pinnedId);
    if (!srcBounds) return;

    const { dx, dy } = DIR_VECTORS[dir];
    const newX = src.x + dx * (srcBounds.w + GAP_PX);
    const newY = src.y + dy * (srcBounds.h + GAP_PX);
    const newShapeId = createShapeId();
    const arrowId = createShapeId();

    editor.run(() => {
      editor.createShape<TLGeoShape>({
        id: newShapeId,
        type: 'geo',
        x: newX,
        y: newY,
        rotation: src.rotation,
        props: { ...src.props },
      });

      editor.createShape<TLArrowShape>({
        id: arrowId,
        type: 'arrow',
      });

      editor.createBindings<TLArrowBinding>([
        {
          type: 'arrow',
          fromId: arrowId,
          toId: pinnedId,
          props: {
            terminal: 'start',
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: false,
            snap: 'none',
          },
        },
        {
          type: 'arrow',
          fromId: arrowId,
          toId: newShapeId,
          props: {
            terminal: 'end',
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: false,
            snap: 'none',
          },
        },
      ]);
    });

    editor.select(newShapeId);
    // Intentionally keep pinnedId on the SOURCE shape so the user can
    // click another direction immediately to fan out. tldraw's own
    // hover logic will clear it when the cursor moves elsewhere.
  };

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {DIRS.map((dir) => (
        <button
          key={dir}
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          onClick={(e) => {
            e.stopPropagation();
            connect(dir);
          }}
          title={`Add connected shape (${dir})`}
          aria-label={`Add connected shape to the ${dir}`}
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
            cursor: 'pointer',
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
          }}
        >
          +
        </button>
      ))}
    </div>
  );
}
