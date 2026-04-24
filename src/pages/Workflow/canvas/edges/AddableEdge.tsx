import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { Plus } from 'lucide-react';

// Data carried on every edge — lets the "+" button know where to inject the
// new node (which branch, after which sibling) and whether conditions are
// allowed at this insertion point.
interface AddableEdgeData extends Record<string, unknown> {
  branchId: string;
  insertAfterId: string | null;
  isEntry: boolean;       // true when the edge's source is the trigger
  isElse: boolean;        // true when the target branch is the else branch
  isAfterAction: boolean; // true when insertion point is past all conditions
  isTail?: boolean;       // trailing "+ add at end" edge (points back to lane)
  isEmptyLane?: boolean;  // trigger → empty-lane stub
}

// Render a smooth curve between two handles with a "+" affordance in the
// middle that opens the add-node menu. Most of the visual polish comes from
// the CSS override in canvasStyles.css — the edge itself is minimal.
export default function AddableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style } = props;
  const d = data as AddableEdgeData | undefined;
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!d) return;
    // Notify the canvas to open the add-node menu at this edge's midpoint.
    // Using a DOM event keeps the edge component decoupled from canvas state.
    window.dispatchEvent(new CustomEvent('workflow-canvas:open-add-menu', {
      detail: {
        edgeId: id,
        branchId: d.branchId,
        insertAfterId: d.insertAfterId,
        isEntry: d.isEntry,
        isElse: d.isElse,
        isAfterAction: d.isAfterAction,
        // Coordinates are in flow (graph) space. The canvas hook translates
        // them to viewport (screen) space before positioning the dropdown.
        flowX: labelX,
        flowY: labelY,
      },
    }));
  };

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="workflow-addable-edge-label"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          <button
            onClick={onClick}
            className="group w-7 h-7 rounded-full bg-white border-2 border-copper/40 text-copper hover:bg-copper hover:text-white hover:border-copper transition-all shadow-sm flex items-center justify-center"
            aria-label="Add node"
            title="Add"
          >
            <Plus size={14} className="transition-transform group-hover:rotate-90" />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
