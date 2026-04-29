import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Zap } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { TriggerNodeData } from '../workflowToGraph';

// The single trigger node at the top of the canvas. Its body is clickable and
// opens the trigger editor in the drawer. Handle is decorative — edges are
// built from the tree, not user-drawn.
export default function TriggerNode({ data, selected }: NodeProps & { data: TriggerNodeData }) {
  const { models, webhookSlugs } = useAppStore();
  const { trigger_event, trigger_model_id, trigger_webhook_slug_id, isAr } = data;

  const eventLabel = (() => {
    if (trigger_event === 'create') return isAr ? 'إنشاء' : 'Create';
    if (trigger_event === 'update') return isAr ? 'تحديث' : 'Update';
    if (trigger_event === 'delete') return isAr ? 'حذف' : 'Delete';
    if (trigger_event === 'button_click') return isAr ? 'ضغطة زر' : 'Button';
    return isAr ? 'خطاف' : 'Webhook';
  })();

  const model = models.find((m) => m.id === trigger_model_id);
  const slug = webhookSlugs.find((s) => s.id === trigger_webhook_slug_id);

  const target = trigger_event === 'webhook'
    ? (slug ? slug.name : (isAr ? 'اختر نقطة استقبال' : 'Pick an endpoint'))
    : (model ? (isAr ? model.label_ar : model.label_en) : (isAr ? 'اختر نموذجًا' : 'Pick a model'));

  return (
    <div
      className={`h-full w-full rounded-2xl bg-gradient-to-br from-amber-400 via-amber-500 to-amber-600 shadow-lg shadow-amber-500/20 text-white transition-all cursor-pointer ${
        selected ? 'ring-4 ring-copper/60' : 'hover:shadow-xl hover:-translate-y-0.5'
      }`}
    >
      <div className="h-full w-full p-4 flex items-center gap-3">
        <div className="w-12 h-12 rounded-xl bg-white/25 backdrop-blur flex items-center justify-center shrink-0">
          <Zap size={24} className="text-white" fill="white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold tracking-widest uppercase text-white/80">
            {isAr ? 'عند' : 'When'}
          </div>
          <div className="font-bold text-lg leading-tight truncate">{eventLabel}</div>
          <div className="text-xs text-white/90 truncate mt-0.5" dir={isAr ? 'rtl' : 'ltr'}>
            {target}
          </div>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ background: '#F5EDE0', border: '2px solid #B8734F', width: 10, height: 10 }}
      />
    </div>
  );
}
