import { type NodeProps, useReactFlow } from '@xyflow/react';
import { GitBranch, Copy, Trash2, Plus } from 'lucide-react';
import type { BranchGroupNodeData } from '../workflowToGraph';

interface BranchGroupProps extends NodeProps {
  data: BranchGroupNodeData;
}

// Swim-lane container for a single branch's conditions + actions. Renders
// behind child nodes (xyflow groups are z-ordered below their children).
export default function BranchGroupNode({ data }: BranchGroupProps) {
  const { branch, positionLabel, isElse, canDelete, canDuplicate, isAr } = data;
  const name = (isAr ? branch.label_ar : branch.label_en) || (isAr ? `فرع ${positionLabel}` : `${positionLabel} branch`);
  const rf = useReactFlow();

  const isEmpty = branch.conditions.length === 0 && branch.actions.length === 0;
  const lastCondition = branch.conditions[branch.conditions.length - 1];
  const lastAction = branch.actions[branch.actions.length - 1];
  const tailAfterId = lastAction?.id ?? lastCondition?.id ?? null;
  const tailIsAfterAction = !!lastAction;

  const tint = isElse
    ? 'bg-gradient-to-b from-chocolate/10 via-chocolate/5 to-transparent border-chocolate/30'
    : 'bg-gradient-to-b from-copper/10 via-copper/5 to-transparent border-copper/30';
  const pillTint = isElse
    ? 'bg-chocolate/15 text-chocolate'
    : 'bg-copper/15 text-copper';

  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDelete) return;
    window.dispatchEvent(new CustomEvent('workflow-canvas:delete-branch', { detail: { id: branch.id } }));
  };
  const onDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDuplicate) return;
    window.dispatchEvent(new CustomEvent('workflow-canvas:duplicate-branch', { detail: { id: branch.id } }));
  };
  const onAddAtTail = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Translate the button's screen rect to flow space so the canvas's menu
    // appears at the same visual position an edge-midpoint button would.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const flow = rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    window.dispatchEvent(new CustomEvent('workflow-canvas:open-add-menu', {
      detail: {
        edgeId: `lane-${branch.id}-tail`,
        branchId: branch.id,
        insertAfterId: tailAfterId,
        isEntry: isEmpty,
        isElse,
        isAfterAction: tailIsAfterAction,
        flowX: flow.x,
        flowY: flow.y,
      },
    }));
  };

  return (
    <div className={`h-full w-full rounded-2xl border-2 ${tint} relative`}>
      <div className="absolute inset-x-0 top-0 h-14 px-3 flex items-center gap-2 border-b border-sand/40 bg-white/60 backdrop-blur rounded-t-2xl">
        <div className={`w-8 h-8 rounded-lg ${pillTint} flex items-center justify-center shrink-0`}>
          <GitBranch size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-[10px] font-bold tracking-widest uppercase ${isElse ? 'text-chocolate/70' : 'text-copper'}`}>
            {positionLabel === 'IF'
              ? (isAr ? 'إذا' : 'IF')
              : positionLabel === 'ELSE IF'
                ? (isAr ? 'وإلا إذا' : 'ELSE IF')
                : (isAr ? 'خلاف ذلك' : 'OTHERWISE')}
          </div>
          <div className="text-sm font-bold text-charcoal truncate leading-tight" dir={isAr ? 'rtl' : 'ltr'}>
            {name}
          </div>
        </div>
        {canDuplicate && (
          <button
            onClick={onDuplicate}
            className="p-1.5 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-sand/30 transition-colors shrink-0"
            aria-label={isAr ? 'تكرار' : 'Duplicate'}
            title={isAr ? 'تكرار' : 'Duplicate'}
          >
            <Copy size={14} />
          </button>
        )}
        <button
          onClick={onDelete}
          disabled={!canDelete}
          className="p-1.5 rounded-md text-charcoal/40 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label={isAr ? 'حذف' : 'Delete'}
          title={canDelete ? (isAr ? 'حذف' : 'Delete') : (isAr ? 'لا يمكن حذف الفرع الوحيد' : 'Cannot delete the only branch')}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Empty-lane empty state: the only way to add the first node. Rendered
          centered in the lane body. */}
      {isEmpty && (
        <div className="absolute inset-x-0 top-14 bottom-0 flex flex-col items-center justify-center p-6 text-center">
          <div className="text-xs text-charcoal/45 mb-3">
            {isAr ? 'هذا الفرع فارغ' : 'This branch is empty'}
          </div>
          <button
            onClick={onAddAtTail}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border-2 border-dashed border-copper/40 text-copper hover:bg-copper hover:text-white hover:border-copper transition-all text-sm font-bold shadow-sm"
          >
            <Plus size={14} />
            {isAr ? 'أضف أول خطوة' : 'Add first step'}
          </button>
        </div>
      )}

      {/* Trailing "+ add" at the bottom of non-empty lanes so users can append
          to a long chain without hunting for the edge. */}
      {!isEmpty && (
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center">
          <button
            onClick={onAddAtTail}
            className="w-7 h-7 rounded-full bg-white border-2 border-copper/40 text-copper hover:bg-copper hover:text-white hover:border-copper transition-all shadow-sm flex items-center justify-center"
            aria-label={isAr ? 'أضف خطوة' : 'Add step'}
            title={isAr ? 'أضف خطوة' : 'Add step'}
          >
            <Plus size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
