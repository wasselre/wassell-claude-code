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

  // Lane has no full background or border tint anymore — the user wanted
  // each node to read as its own thing instead of one big container card.
  // We keep just a small floating header chip that labels the branch (IF /
  // ELSE IF / OTHERWISE) and the lane-level controls (duplicate / delete).
  const headerTint = isElse
    ? 'bg-chocolate/10 text-chocolate border-chocolate/20'
    : 'bg-copper/10 text-copper border-copper/20';

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
    <div className="h-full w-full relative">
      {/* Floating header chip — labels this branch and hosts the
          lane-level actions. No background fill or border on the lane
          body, so each child node reads as a standalone card. */}
      <div className={`absolute inset-x-2 top-1 h-10 px-3 flex items-center gap-2 rounded-xl border ${headerTint} backdrop-blur-sm bg-white/70`}>
        <div className="shrink-0">
          <GitBranch size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 leading-none">
            <span className="text-[10px] font-bold tracking-widest uppercase">
              {positionLabel === 'IF'
                ? (isAr ? 'إذا' : 'IF')
                : positionLabel === 'ELSE IF'
                  ? (isAr ? 'وإلا إذا' : 'ELSE IF')
                  : (isAr ? 'خلاف ذلك' : 'OTHERWISE')}
            </span>
            {(branch.label_ar || branch.label_en) && (
              <>
                <span className="text-[10px] opacity-50">·</span>
                <span className="text-xs font-bold truncate text-charcoal/80" dir={isAr ? 'rtl' : 'ltr'}>
                  {name}
                </span>
              </>
            )}
          </div>
        </div>
        {canDuplicate && (
          <button
            onClick={onDuplicate}
            className="p-1 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-sand/30 transition-colors shrink-0"
            aria-label={isAr ? 'تكرار' : 'Duplicate'}
            title={isAr ? 'تكرار' : 'Duplicate'}
          >
            <Copy size={12} />
          </button>
        )}
        <button
          onClick={onDelete}
          disabled={!canDelete}
          className="p-1 rounded-md text-charcoal/40 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label={isAr ? 'حذف' : 'Delete'}
          title={canDelete ? (isAr ? 'حذف' : 'Delete') : (isAr ? 'لا يمكن حذف الفرع الوحيد' : 'Cannot delete the only branch')}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Empty-lane empty state. */}
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

      {/* Trailing "+ add" at the bottom of non-empty lanes. */}
      {!isEmpty && (
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center">
          <button
            onClick={onAddAtTail}
            className="w-8 h-8 rounded-full bg-white border-2 border-copper/40 text-copper hover:bg-copper hover:text-white hover:border-copper transition-all shadow-sm flex items-center justify-center"
            aria-label={isAr ? 'أضف خطوة' : 'Add step'}
            title={isAr ? 'أضف خطوة' : 'Add step'}
          >
            <Plus size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
