import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { Zap } from 'lucide-react';
import type { WorkflowEvent } from '@/types';

interface TriggerPanelProps {
  triggerModelId: string;
  triggerEvent: WorkflowEvent;
  onModelChange: (id: string) => void;
  onEventChange: (event: WorkflowEvent) => void;
}

export default function TriggerPanel({ triggerModelId, triggerEvent, onModelChange, onEventChange }: TriggerPanelProps) {
  const { t } = useTranslation();
  const { models, language } = useAppStore();
  const isAr = language === 'ar';

  const events: { value: WorkflowEvent; label: string }[] = [
    { value: 'create', label: t('workflow.event_create') },
    { value: 'update', label: t('workflow.event_update') },
    { value: 'delete', label: t('workflow.event_delete') },
  ];

  const selectedModel = models.find((m) => m.id === triggerModelId);

  return (
    <div className="rounded-2xl bg-gradient-to-br from-amber-500/5 via-amber-500/[0.03] to-transparent border border-amber-400/30 p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-11 h-11 rounded-xl bg-amber-400 shadow-sm shadow-amber-500/20 flex items-center justify-center">
          <Zap size={20} className="text-white" fill="white" />
        </div>
        <div className="flex-1">
          <div className="text-[11px] font-bold tracking-widest uppercase text-amber-700/80">
            {isAr ? 'المشغّل' : 'Trigger'}
          </div>
          <h3 className="font-bold text-chocolate text-lg leading-tight">{t('workflow.when')}</h3>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-bold tracking-wider uppercase text-charcoal/50 mb-1.5">
            {t('workflow.trigger_event')}
          </label>
          <select
            value={triggerEvent}
            onChange={(e) => onEventChange(e.target.value as WorkflowEvent)}
            className="form-input text-sm font-bold"
          >
            {events.map((ev) => (
              <option key={ev.value} value={ev.value}>{ev.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-bold tracking-wider uppercase text-charcoal/50 mb-1.5">
            {t('workflow.trigger_model')}
          </label>
          <select
            value={triggerModelId}
            onChange={(e) => onModelChange(e.target.value)}
            className="form-input text-sm font-bold"
          >
            <option value="">— {isAr ? 'اختر نموذج' : 'Select model'} —</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>
            ))}
          </select>
        </div>
      </div>

      {selectedModel && (
        <div className="mt-3 text-sm text-charcoal/60 leading-relaxed">
          <span className="text-charcoal/40">{isAr ? 'سيتم التشغيل' : 'Will fire'} </span>
          <span className="font-bold text-amber-700">{events.find((e) => e.value === triggerEvent)?.label}</span>
          <span className="text-charcoal/40"> {isAr ? 'على' : 'on'} </span>
          <span className="font-bold text-amber-700">&ldquo;{isAr ? selectedModel.label_ar : selectedModel.label_en}&rdquo;</span>
        </div>
      )}
    </div>
  );
}
