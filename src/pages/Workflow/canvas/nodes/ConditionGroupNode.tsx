import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CircleDot, Trash2, Plus, Copy, GitBranch } from 'lucide-react';
import { summarizeCondition } from '../../components/ConditionList';
import type { WorkflowCondition, ModelField, WorkflowEvent, WorkflowBranch } from '@/types';
import TailAddPill, { type TailAddPillSpec } from './TailAddPill';

export interface ConditionGroupNodeData extends Record<string, unknown> {
  kind: 'conditionGroup';
  branch: WorkflowBranch;
  conditions: WorkflowCondition[];
  fields: ModelField[];
  triggerEvent: WorkflowEvent;
  // Branch header info — rendered as the top section of this card so the
  // IF / ELSE IF label sits directly above the conditions, not floating
  // somewhere else on the canvas.
  positionLabel: 'IF' | 'ELSE IF' | 'OTHERWISE';
  branchName: string;
  isElse: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  isAr: boolean;
  // When this conditionGroup is the LAST node in its branch (no actions
  // yet) we render an attached "+" pill at its bottom edge for adding the
  // first action.
  tailAdd?: TailAddPillSpec;
}

interface ConditionGroupNodeProps extends NodeProps {
  data: ConditionGroupNodeData;
}

// One node per branch that contains ALL of the branch's conditions, AND-joined
// visually. Replaces the old "one node per condition" model — multiple
// conditions in the same step are conceptually one filter, so they should
// look like one card. The branch's header (IF / ELSE IF + name + duplicate /
// delete buttons) is the top of this card so the relationship is obvious.
export default function ConditionGroupNode({ data, selected, id }: ConditionGroupNodeProps) {
  const { branch, conditions, fields, isAr, positionLabel, branchName, isElse, canDelete, canDuplicate } = data;

  const onDeleteCondition = (conditionId: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('workflow-canvas:delete-condition', {
      detail: { branchId: branch.id, conditionId },
    }));
  };

  const onAddCondition = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('workflow-canvas:add-condition', {
      detail: { branchId: branch.id },
    }));
  };

  const onDeleteBranch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDelete) return;
    window.dispatchEvent(new CustomEvent('workflow-canvas:delete-branch', { detail: { id: branch.id } }));
  };
  const onDuplicateBranch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDuplicate) return;
    window.dispatchEvent(new CustomEvent('workflow-canvas:duplicate-branch', { detail: { id: branch.id } }));
  };

  // Mute the entire body when the branch is else (it can't have conditions).
  const headerLabel = positionLabel === 'IF'
    ? (isAr ? 'إذا' : 'IF')
    : positionLabel === 'ELSE IF'
      ? (isAr ? 'وإلا إذا' : 'ELSE IF')
      : (isAr ? 'خلاف ذلك' : 'OTHERWISE');

  const headerAccent = isElse ? 'bg-chocolate/10 text-chocolate' : 'bg-copper/10 text-copper';

  return (
    <div
      className={`group relative w-full rounded-2xl bg-white border-2 transition-all cursor-pointer ${
        selected ? 'border-copper shadow-lg shadow-copper/20' : 'border-sky-200 hover:border-sky-400 hover:shadow-md'
      }`}
      data-node-id={id}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ background: '#0ea5e9', border: '2px solid white', width: 8, height: 8 }}
      />

      {/* Branch header strip — labels which arm of the if/else-if/else
          tree this is. Hosts the lane-level duplicate / delete buttons. */}
      <div className={`flex items-center gap-2 px-3 py-2 border-b border-sky-100 ${headerAccent}`}>
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
        {canDuplicate && (
          <button
            onClick={onDuplicateBranch}
            className="p-1 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-white/60 transition-colors"
            aria-label={isAr ? 'تكرار الفرع' : 'Duplicate branch'}
            title={isAr ? 'تكرار الفرع' : 'Duplicate branch'}
          >
            <Copy size={12} />
          </button>
        )}
        <button
          onClick={onDeleteBranch}
          disabled={!canDelete}
          className="p-1 rounded-md text-charcoal/40 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label={isAr ? 'حذف الفرع' : 'Delete branch'}
          title={canDelete ? (isAr ? 'حذف الفرع' : 'Delete branch') : (isAr ? 'لا يمكن حذف الفرع الوحيد' : 'Cannot delete the only branch')}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Conditions list — every condition is rendered as a row inside the
          card, AND-joined. Click anywhere on the body opens the drawer for
          full editing; the per-row trash icon deletes that single
          condition without leaving the canvas. */}
      <div className="p-3 space-y-2">
        {conditions.length === 0 && (
          <div className="flex items-center gap-2 text-charcoal/45">
            <div className="w-7 h-7 rounded-md bg-sky-50 flex items-center justify-center shrink-0">
              <CircleDot size={14} className="text-sky-300" />
            </div>
            <span className="text-xs italic">
              {isAr ? 'لا توجد شروط — سيتم تنفيذ هذا الفرع دائمًا' : 'No conditions — this branch always runs'}
            </span>
          </div>
        )}
        {conditions.map((cond, idx) => {
          const summary = summarizeCondition(cond, fields, isAr);
          return (
            <div key={cond.id}>
              {idx > 0 && (
                <div className="flex items-center gap-2 my-1.5 ms-1">
                  <span className="text-[9px] font-bold tracking-wider uppercase text-sky-700/70 bg-sky-500/10 px-1.5 py-0.5 rounded">
                    {isAr ? 'و' : 'AND'}
                  </span>
                  <div className="flex-1 h-px bg-sky-100" />
                </div>
              )}
              <div className="group/row flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-sky-50/60">
                <div className="w-7 h-7 rounded-md bg-sky-100 text-sky-600 flex items-center justify-center shrink-0">
                  <CircleDot size={14} />
                </div>
                <div className="text-sm font-semibold text-charcoal min-w-0 flex-1 truncate" dir={isAr ? 'rtl' : 'ltr'}>
                  {summary}
                  {cond.only_on_change && (
                    <span className="ms-1.5 text-[10px] text-copper/80 font-bold">
                      {isAr ? '· عند التغيّر' : '· on change'}
                    </span>
                  )}
                </div>
                <button
                  onClick={onDeleteCondition(cond.id)}
                  className="p-1 rounded-md text-charcoal/25 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 opacity-0 group-hover/row:opacity-100"
                  aria-label={isAr ? 'حذف الشرط' : 'Delete condition'}
                  title={isAr ? 'حذف الشرط' : 'Delete condition'}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
        {!isElse && (
          <button
            onClick={onAddCondition}
            className="w-full mt-1 py-1.5 rounded-lg border border-dashed border-sky-300 text-sky-600 hover:bg-sky-50 transition-colors text-xs font-bold flex items-center justify-center gap-1.5"
          >
            <Plus size={12} />
            {isAr ? 'إضافة شرط' : 'Add condition'}
          </button>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ background: '#0ea5e9', border: '2px solid white', width: 8, height: 8 }}
      />
      {data.tailAdd && <TailAddPill spec={data.tailAdd} isAr={isAr} />}
    </div>
  );
}
