import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { ArrowRight, Save, GitBranch, Plus, Maximize2, Minimize2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { translateLabel } from '@/lib/translateLabel';
import WorkflowCanvas from './canvas/WorkflowCanvas';
import type { Workflow, WorkflowEvent, WorkflowBranch, ModelField } from '@/types';

// Build the branch list for the editor. New workflows get a single empty "IF"
// branch. Older saves that only have flat `conditions` / `actions` are wrapped
// into a single branch so the editor doesn't lose their data.
function initialBranches(workflow: Workflow): WorkflowBranch[] {
  if (workflow.branches && workflow.branches.length > 0) return workflow.branches;
  return [{
    id: uuid(),
    conditions: workflow.conditions ?? [],
    actions: workflow.actions ?? [],
  }];
}

export default function WorkflowEditorPage() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { workflows, models, saveWorkflow, addToast, language } = useAppStore();
  const isAr = language === 'ar';

  const isNew = workflowId === 'new';
  const existing = !isNew ? workflows.find((w) => w.id === workflowId) : null;

  const [workflow, setWorkflow] = useState<Workflow>(() => {
    if (existing) {
      return { ...existing, branches: initialBranches(existing) };
    }
    const firstBranch: WorkflowBranch = {
      id: uuid(),
      conditions: [],
      actions: [],
    };
    return {
      id: uuid(),
      label_ar: '',
      label_en: '',
      trigger_model_id: '',
      trigger_event: 'create' as WorkflowEvent,
      branches: [firstBranch],
      conditions: [],
      actions: [],
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });

  useEffect(() => {
    if (existing) setWorkflow({ ...existing, branches: initialBranches(existing) });
  }, [existing]);

  const triggerModel = models.find((m) => m.id === workflow.trigger_model_id);
  const webhookSlugs = useAppStore((s) => s.webhookSlugs);
  const triggerSlug = webhookSlugs.find((s) => s.id === workflow.trigger_webhook_slug_id);
  const isWebhookTrigger = workflow.trigger_event === 'webhook';

  // For webhook workflows, synthesize the "trigger fields" from the slug's
  // declared payload_schema so the existing condition/mapping pickers still
  // work. Each declared field becomes a ModelField of type 'text'.
  const triggerFields = useMemo<ModelField[]>(() => {
    if (isWebhookTrigger && triggerSlug) {
      const declared = (triggerSlug.payload_schema as { fields?: Array<{ name: string; label_ar?: string; label_en?: string }> } | undefined)?.fields ?? [];
      return declared
        .filter((f) => f.name && f.name.trim())
        .map((f, idx): ModelField => ({
          id: `__webhook_${triggerSlug.id}_${f.name}`,
          name: f.name,
          label_ar: f.label_ar || f.name,
          label_en: f.label_en || f.name,
          type: 'text',
          required: false,
          order: idx,
          section_id: '__webhook__',
          width: 'full',
          show_in_table: false,
        }));
    }
    return triggerModel?.schema.sections.flatMap((s) => s.fields) ?? [];
  }, [isWebhookTrigger, triggerSlug, triggerModel]);

  // Whether the trigger is fully configured — gates the canvas. Record
  // triggers need a model; webhook triggers need a slug.
  const isTriggerConfigured = isWebhookTrigger ? !!workflow.trigger_webhook_slug_id : !!workflow.trigger_model_id;

  // The canvas exposes its Add Branch / Add Else actions through this ref so
  // the editor's top bar can fire them — keeps those buttons reliably
  // clickable instead of floating over the canvas where they might collide
  // with nodes.
  const toolbarRef = useRef<{ addBranch: () => void; addElseBranch: () => void } | null>(null);
  const hasElse = (workflow.branches ?? []).some((b) => b.is_else);

  // Fullscreen mode hides the app's sidebar + global header by mounting the
  // editor as a fixed-position overlay covering the entire viewport. The
  // user toggles it with the maximize / minimize button in the top bar.
  // ESC also exits fullscreen so a stuck modal can never trap the user.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false); };
    document.addEventListener('keydown', onKey);
    // Lock body scroll while fullscreen so background scrolling doesn't
    // leak through.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isFullscreen]);

  const handleSave = () => {
    if (!workflow.label_ar.trim() || !workflow.label_en.trim()) {
      addToast(t('common.required'), 'error');
      return;
    }
    // Mirror the first (non-else) branch into the legacy flat fields so any
    // consumer that still reads `workflow.conditions` / `workflow.actions`
    // (list page counter, field-rename propagation) stays sensible. Engine
    // prefers `branches` — this is pure back-compat.
    const branches = workflow.branches ?? [];
    const primary = branches.find((b) => !b.is_else) ?? branches[0];
    saveWorkflow({
      ...workflow,
      conditions: primary?.conditions ?? [],
      actions: primary?.actions ?? [],
      updated_at: new Date().toISOString(),
    });
    addToast(t('toast.saved'), 'success');
    navigate('/workflow');
  };

  // The editor intentionally escapes the app layout's default padding via
  // negative margins and then sets its own compact top bar + full-height
  // canvas below it. Gives the node graph the whole viewport to breathe in,
  // which matches the n8n / Zapier feel: the canvas IS the page.
  return (
    <div className={
      isFullscreen
        ? 'workflow-editor-shell fixed inset-0 z-[60] flex flex-col bg-cream-light'
        : 'workflow-editor-shell -mx-4 md:-mx-8 -my-6 flex flex-col h-[calc(100vh-4rem)]'
    }>
      <div className="shrink-0 px-4 md:px-8 py-3 flex items-center gap-3 border-b border-sand/40 bg-white/70 backdrop-blur-sm">
        <button
          onClick={() => navigate('/workflow')}
          className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors shrink-0"
          aria-label={t('common.back') ?? 'Back'}
        >
          <ArrowRight size={18} className="rtl:rotate-0 ltr:rotate-180" />
        </button>
        <h1 className="text-base font-bold text-chocolate shrink-0 hidden sm:block">
          {isNew ? t('workflow.new') : (workflow.label_ar || workflow.label_en) || t('workflow.new')}
        </h1>
        <div className="flex-1 max-w-md">
          <Input
            value={isAr ? workflow.label_ar : workflow.label_en}
            onChange={(e) => {
              // Update only the side the user is typing in. The opposite
              // side gets filled by the translate-on-blur handler below.
              setWorkflow({
                ...workflow,
                label_ar: isAr ? e.target.value : workflow.label_ar,
                label_en: isAr ? workflow.label_en : e.target.value,
              });
            }}
            onBlur={async (e) => {
              const typed = e.target.value.trim();
              if (!typed) return;
              const otherSide = isAr ? workflow.label_en : workflow.label_ar;
              if (otherSide && otherSide.trim()) return; // user filled both manually
              try {
                const labels = await translateLabel(typed, 'workflow');
                setWorkflow((prev) => ({
                  ...prev,
                  label_ar: isAr ? prev.label_ar : labels.label_ar,
                  label_en: isAr ? labels.label_en : prev.label_en,
                }));
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                addToast(
                  isAr ? `تعذرت ترجمة اسم القاعدة: ${msg}` : `Workflow name translation failed: ${msg}`,
                  'error',
                );
              }
            }}
            required
            dir={isAr ? 'rtl' : 'ltr'}
            placeholder={isAr ? 'اسم القاعدة...' : 'Rule name...'}
          />
        </div>
        <div className="flex-1" />
        {isTriggerConfigured && (
          <>
            <button
              onClick={() => toolbarRef.current?.addBranch()}
              className="hidden md:flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-copper/40 text-copper hover:bg-copper/5 transition-colors text-sm font-bold"
              title={isAr ? 'أضف فرعًا مشروطًا جديدًا' : 'Add another conditional branch'}
            >
              <Plus size={14} />
              <GitBranch size={12} />
              {isAr ? 'فرع' : 'Branch'}
            </button>
            {!hasElse && (
              <button
                onClick={() => toolbarRef.current?.addElseBranch()}
                className="hidden md:flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-chocolate/30 text-chocolate/70 hover:bg-chocolate/5 transition-colors text-sm font-bold"
                title={isAr ? 'أضف حالة افتراضية' : 'Add default case'}
              >
                <Plus size={14} />
                {isAr ? 'وإلا' : 'Else'}
              </button>
            )}
          </>
        )}
        <button
          onClick={() => setIsFullscreen((v) => !v)}
          className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/60 hover:text-charcoal transition-colors"
          aria-label={isFullscreen
            ? (isAr ? 'الخروج من ملء الشاشة' : 'Exit fullscreen')
            : (isAr ? 'ملء الشاشة' : 'Fullscreen')}
          title={isFullscreen
            ? (isAr ? 'الخروج من ملء الشاشة (Esc)' : 'Exit fullscreen (Esc)')
            : (isAr ? 'ملء الشاشة' : 'Fullscreen')}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <Button onClick={handleSave}>
          <Save size={16} />
          {t('common.save')}
        </Button>
      </div>

      {isTriggerConfigured ? (
        <div className="flex-1 min-h-0">
          <WorkflowCanvas
            workflow={workflow}
            setWorkflow={(updater) => setWorkflow(updater)}
            triggerFields={triggerFields}
            toolbarRef={toolbarRef}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-4 md:px-8 py-8 flex items-center justify-center">
          <div className="w-full max-w-xl text-center text-charcoal/40 bg-cream-light/60 rounded-2xl border border-dashed border-sand/40 p-10">
            <GitBranch size={36} className="mx-auto mb-3 opacity-50" />
            <p className="font-bold text-charcoal/70">{isAr ? 'اختر مشغّلًا للبدء' : 'Pick a trigger to get started'}</p>
            <p className="text-xs mt-1 mb-6">{isAr ? 'اختر النموذج والحدث لبدء بناء القاعدة.' : 'Choose a model and event to begin building this rule.'}</p>
            <InlineTriggerPicker
              workflow={workflow}
              onChange={(patch) => setWorkflow((w) => ({
                ...w,
                ...patch,
                branches: (w.branches ?? []).map((b) => ({ ...b, conditions: [] })),
              }))}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// A lightweight picker shown on the empty state, before the canvas appears.
// Once the trigger is configured the full-fat trigger editor lives inside the
// canvas node (click the trigger → drawer opens with TriggerPanel).
interface InlineTriggerPickerProps {
  workflow: Workflow;
  onChange: (patch: { trigger_model_id?: string; trigger_event?: WorkflowEvent; trigger_webhook_slug_id?: string | null }) => void;
}
function InlineTriggerPicker({ workflow, onChange }: InlineTriggerPickerProps) {
  const { models, webhookSlugs, language } = useAppStore();
  const { t } = useTranslation();
  const isAr = language === 'ar';
  const isWebhook = workflow.trigger_event === 'webhook';

  // `on_due` is followups-only in v1: the cron sweeper sweeps that one
  // model's `scheduled_datetime`. Hide the option for other models so it's
  // not pickable on a workflow that would never fire.
  const selectedModel = models.find((m) => m.id === workflow.trigger_model_id);
  const supportsOnDue = selectedModel?.name === 'followups';

  const events: { value: WorkflowEvent; label: string }[] = [
    { value: 'create', label: t('workflow.event_create') },
    { value: 'update', label: t('workflow.event_update') },
    { value: 'delete', label: t('workflow.event_delete') },
    { value: 'webhook', label: isAr ? 'خطاف وارد' : 'Webhook' },
    { value: 'button_click', label: isAr ? 'ضغطة زر مخصص' : 'Custom button click' },
    ...(supportsOnDue
      ? [{ value: 'on_due' as WorkflowEvent, label: isAr ? 'حان موعد المتابعة (تلقائي)' : 'Followup due (auto-fired)' }]
      : []),
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-start">
      <div>
        <label className="block text-[11px] font-bold tracking-wider uppercase text-charcoal/50 mb-1.5">
          {t('workflow.trigger_event')}
        </label>
        <select
          value={workflow.trigger_event}
          onChange={(e) => {
            const event = e.target.value as WorkflowEvent;
            onChange({
              trigger_event: event,
              trigger_model_id: event === 'webhook' ? '' : workflow.trigger_model_id,
              trigger_webhook_slug_id: event === 'webhook' ? workflow.trigger_webhook_slug_id : null,
            });
          }}
          className="form-input text-sm font-bold"
        >
          {events.map((ev) => (
            <option key={ev.value} value={ev.value}>{ev.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[11px] font-bold tracking-wider uppercase text-charcoal/50 mb-1.5">
          {isWebhook ? (isAr ? 'نقطة الاستقبال' : 'Webhook endpoint') : t('workflow.trigger_model')}
        </label>
        {isWebhook ? (
          <select
            value={workflow.trigger_webhook_slug_id ?? ''}
            onChange={(e) => onChange({ trigger_webhook_slug_id: e.target.value || null })}
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
            value={workflow.trigger_model_id}
            onChange={(e) => onChange({ trigger_model_id: e.target.value })}
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
  );
}
