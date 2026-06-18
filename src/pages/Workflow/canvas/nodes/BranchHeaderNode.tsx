import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GitBranch, Copy, Trash2 } from 'lucide-react';
import type { WorkflowBranch } from '@/types';
import TailAddPill, { type TailAddPillSpec } from './TailAddPill';

export interface BranchHeaderNodeData extends Record<string, unknown> {
  kind: 'branchHeader';
  branch: WorkflowBranch;
  positionLabel: 'IF' | 'ELSE IF' | 'OTHERWISE';
  branchName: string;
  isElse: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  isAr: boolean;
  readOnly?: boolean;
  // When this branch header is the LAST node in its branch (else branch
  // with no actions yet) we render an attached "+" pill at its bottom
  // edge for adding the first action.
  tailAdd?: TailAddPillSpec;
}

interface BranchHeaderNodeProps extends NodeProps {
  data: BranchHeaderNodeData;
}

// Small header-only node used for ELSE branches, which don't carry
// conditions. For non-else branches the header is folded into the top of
// the ConditionGroupNode so the relationship between IF and the conditions
// is unambiguous; here it's a standalone card so the OTHERWISE arm of the
// tree still has an entry node connected to the trigger.
export default function BranchHeaderNode({ data, selected }: BranchHeaderNodeProps) {
  const { branch, positionLabel, branchName, isElse, canDelete, canDuplicate, isAr, readOnly } = data;

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

  const headerLabel = positionLabel === 'IF'
    ? (isAr ? 'إذا' : 'IF')
    : positionLabel === 'ELSE IF'
      ? (isAr ? 'وإلا إذا' : 'ELSE IF')
      : (isAr ? 'خلاف ذلك' : 'OTHERWISE');

  const accent = isElse
    ? 'bg-chocolate/10 text-chocolate border-chocolate/30'
    : 'bg-copper/10 text-copper border-copper/30';

  return (
    <div className={`group relative w-full rounded-2xl bg-white border-2 transition-all cursor-pointer ${
      selected ? 'border-copper shadow-lg shadow-copper/20' : `${accent} hover:shadow-md`
    }`}>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ background: '#B8734F', border: '2px solid white', width: 8, height: 8 }}
      />
      <div className={`flex items-center gap-2 px-3 py-2.5 ${accent} border-b border-current/10`}>
        <GitBranch size={14} />
        <span className="text-[10px] font-bold tracking-widest uppercase">{headerLabel}</span>
        {(branch.label_ar || branch.label_en) && (
          <>
            <span className="text-[10px] opacity-50">·</span>
            <span className="text-xs font-bold truncate flex-1 text-charcoal/80" dir={isAr ? 'rtl' : 'ltr'}>
              {branchName}
            </span>
          </>
        )}
        <div className="flex-1" />
        {canDuplicate && !readOnly && (
          <button
            onClick={onDuplicate}
            className="p-1 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-white/60 transition-colors"
            aria-label={isAr ? 'تكرار الفرع' : 'Duplicate branch'}
            title={isAr ? 'تكرار الفرع' : 'Duplicate branch'}
          >
            <Copy size={12} />
          </button>
        )}
        {!readOnly && (
          <button
            onClick={onDelete}
            disabled={!canDelete}
            className="p-1 rounded-md text-charcoal/40 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={isAr ? 'حذف الفرع' : 'Delete branch'}
            title={canDelete ? (isAr ? 'حذف الفرع' : 'Delete branch') : (isAr ? 'لا يمكن حذف الفرع الوحيد' : 'Cannot delete the only branch')}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="px-3 py-2 text-xs text-charcoal/45 italic" dir={isAr ? 'rtl' : 'ltr'}>
        {isAr
          ? 'يعمل هذا الفرع فقط عندما لا يتطابق أي فرع سابق.'
          : 'Runs only when no earlier branch matched.'}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ background: '#B8734F', border: '2px solid white', width: 8, height: 8 }}
      />
      {data.tailAdd && <TailAddPill spec={data.tailAdd} isAr={isAr} />}
    </div>
  );
}
