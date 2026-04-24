import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CircleDot, Trash2 } from 'lucide-react';
import { summarizeCondition } from '../../components/ConditionList';
import type { ConditionNodeData } from '../workflowToGraph';

interface ConditionNodeProps extends NodeProps {
  data: ConditionNodeData;
}

// Compact node rendering of a single condition. The full editor lives in the
// drawer; this card just shows a color-coded summary plus delete affordance.
export default function ConditionNode({ data, selected, id }: ConditionNodeProps) {
  const { condition, fields, isAr } = data;
  const summary = summarizeCondition(condition, fields, isAr);

  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Delegate deletion to the canvas keyboard handler by dispatching a
    // custom event carrying the node id. The canvas installs a listener.
    window.dispatchEvent(new CustomEvent('workflow-canvas:delete-node', { detail: { id } }));
  };

  return (
    <div
      className={`group relative h-full w-full rounded-xl bg-white border-2 transition-all cursor-pointer ${
        selected ? 'border-copper shadow-lg shadow-copper/20 -translate-y-0.5' : 'border-sky-200 hover:border-sky-400 hover:shadow-md'
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ background: '#0ea5e9', border: '2px solid white', width: 8, height: 8 }}
      />
      <div className="h-full w-full p-3 flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center shrink-0">
          <CircleDot size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold tracking-wider uppercase text-sky-700/70">
            {isAr ? 'شرط' : 'Condition'}
            {condition.only_on_change && (
              <span className="ms-1.5 text-[9px] text-copper/80">
                {isAr ? '· عند التغيّر' : '· on change'}
              </span>
            )}
          </div>
          <div className="text-sm font-bold text-charcoal leading-tight truncate mt-0.5" dir={isAr ? 'rtl' : 'ltr'}>
            {summary}
          </div>
        </div>
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md text-charcoal/25 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
          aria-label={isAr ? 'حذف' : 'Delete'}
          title={isAr ? 'حذف' : 'Delete'}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ background: '#0ea5e9', border: '2px solid white', width: 8, height: 8 }}
      />
    </div>
  );
}
