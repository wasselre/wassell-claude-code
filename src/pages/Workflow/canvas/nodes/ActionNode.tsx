import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Play, Plus, Pencil, UserCheck, MessageSquare, Send, Phone, Globe, Sparkles, Trash2 } from 'lucide-react';
import { ACTION_STYLE, summarizeAction } from '../../components/ActionList';
import type { ActionNodeData } from '../workflowToGraph';
import type { WorkflowAction } from '@/types';
import type { LucideIcon } from 'lucide-react';
import TailAddPill from './TailAddPill';

const ICON_BY_TYPE: Record<WorkflowAction['type'], LucideIcon> = {
  create_record: Plus,
  update_record: Pencil,
  send_notification: MessageSquare,
  assign_user: UserCheck,
  http_request: Globe,
  outbound_ivr: Phone,
  send_whatsapp_message: Send,
  paseet_query: Sparkles,
};

interface ActionNodeProps extends NodeProps {
  data: ActionNodeData;
}

// Single-action node for the canvas. Full editing happens in the drawer.
export default function ActionNode({ data, selected, id }: ActionNodeProps) {
  const { action, models, isAr, readOnly } = data;
  const style = ACTION_STYLE[action.type];
  const Icon = ICON_BY_TYPE[action.type] ?? Play;
  const summary = summarizeAction(action, models, isAr);
  const label = isAr ? style.label_ar : style.label_en;

  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('workflow-canvas:delete-node', { detail: { id } }));
  };

  return (
    <div
      className={`group relative h-full w-full rounded-xl bg-white border-2 transition-all cursor-pointer ${
        selected ? 'border-copper shadow-lg shadow-copper/20 -translate-y-0.5' : `${style.nodeBorder} hover:shadow-md`
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ background: '#B8734F', border: '2px solid white', width: 8, height: 8 }}
      />
      <div className="h-full w-full p-3 flex items-center gap-2.5">
        <div className={`w-9 h-9 rounded-lg ${style.nodeBg} text-white flex items-center justify-center shrink-0 shadow-sm`}>
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-[10px] font-bold tracking-wider uppercase ${style.badgeText}`}>
            {label}
          </div>
          <div className="text-sm font-bold text-charcoal leading-tight truncate mt-0.5" dir={isAr ? 'rtl' : 'ltr'}>
            {summary}
          </div>
        </div>
        {!readOnly && (
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md text-charcoal/25 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
            aria-label={isAr ? 'حذف' : 'Delete'}
            title={isAr ? 'حذف' : 'Delete'}
          >
            <Trash2 size={14} />
          </button>
        )}
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
