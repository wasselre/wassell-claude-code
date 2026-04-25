import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Plus } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';

export interface TailAddNodeData extends Record<string, unknown> {
  kind: 'tailAdd';
  branchId: string;
  insertAfterId: string | null;
  isElse: boolean;
  isAr: boolean;
}

interface TailAddNodeProps extends NodeProps {
  data: TailAddNodeData;
}

// Visible affordance pinned at the end of every non-empty branch chain so
// users can append a new action without hunting for a hidden edge button.
// Clicking the node opens the same Add menu the edge "+" would. The edge
// between the last real node and this tail also has an "addable" type, so
// inserting between the last action and the tail still works (treated as
// an append by `insertAfterId`).
export default function TailAddNode({ data }: TailAddNodeProps) {
  const { branchId, insertAfterId, isAr } = data;
  const rf = useReactFlow();

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const flow = rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    window.dispatchEvent(new CustomEvent('workflow-canvas:open-add-menu', {
      detail: {
        edgeId: `tail-${branchId}`,
        branchId,
        insertAfterId,
        isEntry: false,
        isElse: data.isElse,
        // Tail of an action chain → conditions can still be added (they
        // land in the branch's condition group regardless of position).
        isAfterAction: !!insertAfterId && insertAfterId.startsWith('act-'),
        flowX: flow.x,
        flowY: flow.y,
      },
    }));
  };

  return (
    <button
      onClick={onClick}
      className="group flex items-center justify-center gap-2 w-full px-4 py-3 rounded-2xl bg-white/70 backdrop-blur-sm border-2 border-dashed border-copper/40 text-copper hover:bg-copper hover:text-white hover:border-copper transition-all text-sm font-bold shadow-sm"
      aria-label={isAr ? 'إضافة خطوة' : 'Add step'}
      title={isAr ? 'إضافة خطوة' : 'Add step'}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ background: '#B8734F', border: '2px solid white', width: 8, height: 8 }}
      />
      <Plus size={14} />
      <span>{isAr ? 'إضافة خطوة' : 'Add step'}</span>
    </button>
  );
}
