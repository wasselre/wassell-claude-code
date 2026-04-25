import { useReactFlow } from '@xyflow/react';
import { Plus } from 'lucide-react';

export interface TailAddPillSpec {
  branchId: string;
  insertAfterId: string | null;
  isElse: boolean;
}

interface TailAddPillProps {
  spec: TailAddPillSpec;
  isAr: boolean;
}

// A small, attached "+" button rendered at the bottom of the LAST node in a
// branch. There's no edge connecting it to the node — it sits directly on
// the node's outline so visually it reads as part of that node, not as a
// separate "Add step" element. Clicking it opens the same Add menu the
// edge "+" buttons use.
export default function TailAddPill({ spec, isAr }: TailAddPillProps) {
  const rf = useReactFlow();

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const flow = rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    window.dispatchEvent(new CustomEvent('workflow-canvas:open-add-menu', {
      detail: {
        edgeId: `tail-${spec.branchId}`,
        branchId: spec.branchId,
        insertAfterId: spec.insertAfterId,
        isEntry: false,
        isElse: spec.isElse,
        // Tail of an action chain → the menu still lets the user pick
        // either Condition (which lands in the branch's condition group)
        // or any action.
        isAfterAction: !!spec.insertAfterId && spec.insertAfterId.startsWith('act-'),
        flowX: flow.x,
        flowY: flow.y,
      },
    }));
  };

  return (
    <button
      onClick={onClick}
      className="absolute -bottom-3.5 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-10 w-7 h-7 rounded-full bg-white border-2 border-copper text-copper hover:bg-copper hover:text-white transition-all shadow-md flex items-center justify-center"
      aria-label={isAr ? 'إضافة خطوة' : 'Add step'}
      title={isAr ? 'إضافة خطوة' : 'Add step'}
    >
      <Plus size={14} />
    </button>
  );
}
