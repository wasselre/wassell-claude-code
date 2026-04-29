import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { Zap } from 'lucide-react';
import type { WorkflowEvent } from '@/types';

interface TriggerPanelProps {
  triggerModelId: string;
  triggerEvent: WorkflowEvent;
  triggerWebhookSlugId: string | null | undefined;
  onModelChange: (id: string) => void;
  onEventChange: (event: WorkflowEvent) => void;
  onWebhookSlugChange: (slugId: string | null) => void;
}

export default function TriggerPanel({
  triggerModelId,
  triggerEvent,
  triggerWebhookSlugId,
  onModelChange,
  onEventChange,
  onWebhookSlugChange,
}: TriggerPanelProps) {
  const { t } = useTranslation();
  const { models, webhookSlugs, language } = useAppStore();
  const isAr = language === 'ar';

  const events: { value: WorkflowEvent; label: string }[] = [
    { value: 'create', label: t('workflow.event_create') },
    { value: 'update', label: t('workflow.event_update') },
    { value: 'delete', label: t('workflow.event_delete') },
    { value: 'webhook', label: isAr ? 'خطاف وارد' : 'Webhook' },
    { value: 'button_click', label: isAr ? 'ضغطة زر مخصص' : 'Custom button click' },
  ];

  const selectedModel = models.find((m) => m.id === triggerModelId);
  const selectedSlug = webhookSlugs.find((s) => s.id === triggerWebhookSlugId);
  const isWebhook = triggerEvent === 'webhook';
  const isButtonClick = triggerEvent === 'button_click';
  // Buttons configured on the selected model (any button can target any
  // workflow on the model — the linkage is stored on the button via its
  // action.workflow_id; this list is informational so the user knows which
  // buttons exist and are candidates).
  const modelButtons = (selectedModel?.schema.custom_buttons ?? []).filter(
    (b) => b.enabled !== false,
  );

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
            {isWebhook
              ? (isAr ? 'نقطة الاستقبال' : 'Webhook endpoint')
              : t('workflow.trigger_model')}
          </label>
          {isWebhook ? (
            <select
              value={triggerWebhookSlugId ?? ''}
              onChange={(e) => onWebhookSlugChange(e.target.value || null)}
              className="form-input text-sm font-bold"
            >
              <option value="">— {isAr ? 'اختر نقطة' : 'Select endpoint'} —</option>
              {webhookSlugs.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.is_active}>
                  {s.name}{!s.is_active ? ` (${isAr ? 'معطّل' : 'disabled'})` : ''}
                </option>
              ))}
            </select>
          ) : (
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
          )}
        </div>
      </div>

      {isWebhook && webhookSlugs.length === 0 && (
        <div className="mt-3 text-xs text-amber-800/80 bg-amber-100/40 border border-amber-300/40 rounded-lg px-3 py-2 leading-relaxed">
          {isAr
            ? 'لا توجد نقاط استقبال. أنشئ واحدة من الإعدادات → نقاط الخطافات.'
            : 'No webhook endpoints defined. Create one at Settings → Webhooks.'}
        </div>
      )}

      {isWebhook && selectedSlug && (
        <div className="mt-3 text-sm text-charcoal/60 leading-relaxed">
          <span className="text-charcoal/40">{isAr ? 'سيتم التشغيل عند استقبال طلب على ' : 'Will fire on POST to '}</span>
          <code className="text-[11px] font-mono text-copper bg-copper/5 border border-copper/20 rounded px-1.5 py-0.5" dir="ltr">
            /functions/v1/inbox/{selectedSlug.slug}
          </code>
        </div>
      )}

      {isButtonClick && selectedModel && (
        <div className="mt-3 text-xs text-amber-800/80 bg-amber-100/40 border border-amber-300/40 rounded-lg px-3 py-2 leading-relaxed">
          {isAr
            ? 'يربط هذا السير بأزرار النموذج عبر تبويب "الأزرار المخصصة" في مُنشئ النموذج. أي زر يُختار هذا السير سيشغّله عند الضغط.'
            : 'This workflow becomes triggerable from a button. Connect it to a button via the model\'s "Buttons" tab — any button that selects this workflow will fire it on click.'}
          {modelButtons.length > 0 && (
            <div className="mt-1.5 text-charcoal/70">
              {isAr ? 'الأزرار الحالية على هذا النموذج: ' : 'Existing buttons on this model: '}
              <span className="font-bold">
                {modelButtons.map((b) => (isAr ? b.label_ar : b.label_en) || b.id).join(' · ')}
              </span>
            </div>
          )}
          {modelButtons.length === 0 && (
            <div className="mt-1.5 text-charcoal/60">
              {isAr
                ? 'لا توجد أزرار على هذا النموذج بعد. أضف زرًا من مُنشئ النموذج → الأزرار المخصصة.'
                : 'No buttons on this model yet. Add one from the Builder → Buttons tab.'}
            </div>
          )}
        </div>
      )}

      {!isWebhook && !isButtonClick && selectedModel && (
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
