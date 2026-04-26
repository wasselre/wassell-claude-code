import { useMemo } from 'react';
import {
  Trash2, ArrowUp, ArrowDown, Search, List, Hammer, CheckCheck, Sparkles, GripVertical,
} from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { STEP_KIND_LABELS, TEMPLATE_TOOL_REGISTRY } from '@/data/templateToolRegistry';
import type { PresentationStep, PresentationStepKind, PresentationToolName } from '@/types';

/**
 * Editor for `template.steps` — the ordered pipeline the cloud worker
 * walks at runtime. Each step is one card; reorder via up/down buttons.
 *
 * The "Tools" multi-select on each step is constrained to the template's
 * own tool set: the agent can't call a tool that's not enabled at the
 * template level. When `templateTools` is empty, the multi-select renders
 * a hint pointing the author to the Tools section above.
 *
 * "When empty, the step inherits the full template tool set" is enforced
 * at runtime by the cloud worker (Phase 3) — here we just store an empty
 * array, no special UI for "inherit" beyond the empty checklist.
 */
interface StepsEditorProps {
  steps: PresentationStep[];
  templateTools: PresentationToolName[];
  onChange: (steps: PresentationStep[]) => void;
  readonly?: boolean;
}

const STEP_KIND_ORDER: PresentationStepKind[] = [
  'research',
  'outline',
  'build',
  'review',
  'custom',
];

const KIND_ICONS: Record<PresentationStepKind, typeof Search> = {
  research: Search,
  outline: List,
  build: Hammer,
  review: CheckCheck,
  custom: Sparkles,
};

const KIND_DEFAULT_PROMPT: Record<PresentationStepKind, { en: string; ar: string }> = {
  research: {
    en: 'Use web_search and any other research tools to gather verified facts about the project. Cite every claim with a URL or source name. Do not invent numbers.',
    ar: 'استخدم web_search والأدوات الأخرى لجمع حقائق موثوقة عن المشروع. اذكر مصدر كل معلومة. لا تختلق أرقاماً.',
  },
  outline: {
    en: 'Draft a slide-by-slide outline (titles + 3-5 bullet talking points each). Use the evidence from the research step.',
    ar: 'اقترح هيكل العرض شريحة بشريحة (عنوان لكل شريحة + 3-5 نقاط للحديث). استخدم نتائج خطوة البحث.',
  },
  build: {
    en: 'Use code_execution with python-pptx to build the .pptx from the outline. Save to the working directory and call drive_upload with the file_id.',
    ar: 'استخدم code_execution مع python-pptx لبناء ملف العرض من الهيكل. احفظه ثم استدعِ drive_upload بمعرف الملف.',
  },
  review: {
    en: 'Audit the deck against brand and accuracy rules. Report any issues; fix the simple ones inline.',
    ar: 'راجع العرض للتأكد من مطابقته للهوية البصرية ودقة الأرقام. أبلغ عن أي مشاكل وأصلح البسيطة منها.',
  },
  custom: {
    en: '',
    ar: '',
  },
};

export default function StepsEditor({
  steps,
  templateTools,
  onChange,
  readonly,
}: StepsEditorProps): JSX.Element {
  const isAr = useAppStore((s) => s.language === 'ar');

  const patchStep = (idx: number, patch: Partial<PresentationStep>): void => {
    onChange(steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const removeStep = (idx: number): void => {
    onChange(steps.filter((_, i) => i !== idx));
  };
  const moveStep = (idx: number, delta: -1 | 1): void => {
    const target = idx + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    onChange(next);
  };
  const addStep = (kind: PresentationStepKind): void => {
    const defaults = KIND_DEFAULT_PROMPT[kind];
    onChange([
      ...steps,
      {
        id: uuid(),
        kind,
        prompt: isAr ? defaults.ar : defaults.en,
        tools: [],
      },
    ]);
  };

  // step.id is already a uuid; use it directly as the dnd id.
  const sortableIds = useMemo(() => steps.map((s) => s.id), [steps]);

  const handleDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const fromIdx = sortableIds.indexOf(String(active.id));
    const toIdx = sortableIds.indexOf(String(over.id));
    if (fromIdx === -1 || toIdx === -1) return;
    onChange(arrayMove(steps, fromIdx, toIdx));
  };

  return (
    <div className="space-y-3">
      {steps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-sand/60 bg-cream/20 p-6 text-center text-sm text-charcoal/50">
          {isAr
            ? 'لا توجد خطوات. أضف خطوة بحث أو هيكلة أو بناء لبدء بناء سير العمل.'
            : 'No steps yet. Add a research / outline / build step to start the pipeline.'}
        </div>
      ) : (
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {steps.map((step, idx) => (
                <StepCard
                  key={step.id}
                  step={step}
                  idx={idx}
                  total={steps.length}
                  isAr={isAr}
                  templateTools={templateTools}
                  readonly={readonly}
                  onPatch={(patch) => patchStep(idx, patch)}
                  onRemove={() => removeStep(idx)}
                  onMove={(d) => moveStep(idx, d)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {!readonly && (
        <div className="pt-2 border-t border-sand/30">
          <p className="text-[10px] font-bold text-charcoal/60 uppercase tracking-wide mb-2">
            {isAr ? 'إضافة خطوة' : 'Add step'}
          </p>
          <div className="flex flex-wrap gap-2">
            {STEP_KIND_ORDER.map((kind) => {
              const Icon = KIND_ICONS[kind];
              return (
                <Button
                  key={kind}
                  variant="ghost"
                  onClick={() => addStep(kind)}
                >
                  <Icon size={14} />
                  {isAr ? STEP_KIND_LABELS[kind].label_ar : STEP_KIND_LABELS[kind].label_en}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface StepCardProps {
  step: PresentationStep;
  idx: number;
  total: number;
  isAr: boolean;
  templateTools: PresentationToolName[];
  readonly?: boolean;
  onPatch: (patch: Partial<PresentationStep>) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}

function StepCard({
  step,
  idx,
  total,
  isAr,
  templateTools,
  readonly,
  onPatch,
  onRemove,
  onMove,
}: StepCardProps): JSX.Element {
  const Icon = KIND_ICONS[step.kind];
  const defaultLabel = isAr ? STEP_KIND_LABELS[step.kind].label_ar : STEP_KIND_LABELS[step.kind].label_en;
  const stepLabel = (isAr ? step.label_ar : step.label_en) || defaultLabel;
  const stepToolsSet = new Set(step.tools);

  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: step.id, disabled: readonly });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const toggleTool = (name: PresentationToolName): void => {
    const next = new Set(stepToolsSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onPatch({ tools: templateTools.filter((t) => next.has(t)) });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border border-sand/40 bg-white p-4 ${isDragging ? 'shadow-lg' : ''}`}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          {!readonly && (
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="p-1 rounded hover:bg-cream/40 text-charcoal/40 cursor-grab active:cursor-grabbing touch-none"
              title={isAr ? 'سحب لإعادة الترتيب' : 'Drag to reorder'}
              aria-label={isAr ? 'سحب لإعادة الترتيب' : 'Drag to reorder'}
            >
              <GripVertical size={14} />
            </button>
          )}
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-copper/10 text-copper text-xs font-bold shrink-0">
            {idx + 1}
          </span>
          <Icon size={14} className="text-charcoal/60" />
          <span className="text-sm font-bold text-charcoal">{stepLabel}</span>
          <span className="text-[10px] font-mono text-charcoal/40">{step.kind}</span>
        </div>
        {!readonly && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={idx === 0}
              className="p-1 rounded hover:bg-cream/40 text-charcoal/50 disabled:opacity-30 disabled:cursor-not-allowed"
              title={isAr ? 'تحريك للأعلى' : 'Move up'}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={idx === total - 1}
              className="p-1 rounded hover:bg-cream/40 text-charcoal/50 disabled:opacity-30 disabled:cursor-not-allowed"
              title={isAr ? 'تحريك للأسفل' : 'Move down'}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="p-1 rounded hover:bg-red-50 text-charcoal/50 hover:text-red-600"
              title={isAr ? 'حذف' : 'Delete'}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-[10px] font-bold text-charcoal/60 uppercase tracking-wide mb-1">
            {isAr ? 'النوع' : 'Kind'}
          </label>
          <select
            value={step.kind}
            onChange={(e) => onPatch({ kind: e.target.value as PresentationStepKind })}
            disabled={readonly}
            className="form-input text-sm"
          >
            {STEP_KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {isAr ? STEP_KIND_LABELS[k].label_ar : STEP_KIND_LABELS[k].label_en} — {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-charcoal/60 uppercase tracking-wide mb-1">
            {isAr ? 'تسمية مخصّصة (اختياري)' : 'Custom label (optional)'}
          </label>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={step.label_ar ?? ''}
              onChange={(e) => onPatch({ label_ar: e.target.value === '' ? undefined : e.target.value })}
              disabled={readonly}
              dir="rtl"
              placeholder={STEP_KIND_LABELS[step.kind].label_ar}
              className="form-input text-xs"
            />
            <input
              type="text"
              value={step.label_en ?? ''}
              onChange={(e) => onPatch({ label_en: e.target.value === '' ? undefined : e.target.value })}
              disabled={readonly}
              dir="ltr"
              placeholder={STEP_KIND_LABELS[step.kind].label_en}
              className="form-input text-xs"
            />
          </div>
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-[10px] font-bold text-charcoal/60 uppercase tracking-wide mb-1">
          {isAr ? 'تعليمات الخطوة' : 'Step prompt'}
        </label>
        <textarea
          value={step.prompt}
          onChange={(e) => onPatch({ prompt: e.target.value })}
          disabled={readonly}
          rows={4}
          dir={isAr ? 'rtl' : 'ltr'}
          placeholder={isAr
            ? 'اكتب التعليمات التي يحصل عليها الوكيل في هذه الخطوة...'
            : 'What should the agent do at this step?'}
          className="form-input text-sm w-full"
        />
      </div>

      <div>
        <label className="block text-[10px] font-bold text-charcoal/60 uppercase tracking-wide mb-1">
          {isAr ? 'الأدوات لهذه الخطوة' : 'Tools for this step'}
        </label>
        {templateTools.length === 0 ? (
          <p className="text-xs text-charcoal/40 italic">
            {isAr
              ? 'لم يتم تفعيل أي أدوات في القالب بعد. عُد إلى قسم "الأدوات" وفعّل ما تحتاجه.'
              : 'No tools enabled at template level yet. Enable some in the Tools section above.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {templateTools.map((tool) => {
                const meta = TEMPLATE_TOOL_REGISTRY.find((t) => t.name === tool);
                const checked = stepToolsSet.has(tool);
                return (
                  <label
                    key={tool}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs cursor-pointer ${
                      checked ? 'bg-copper/15 text-copper' : 'bg-charcoal/5 text-charcoal/60 hover:bg-charcoal/10'
                    } ${readonly ? 'cursor-default' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => !readonly && toggleTool(tool)}
                      disabled={readonly}
                      className="w-3 h-3"
                    />
                    <span className="font-mono">{meta ? (isAr ? meta.label_ar : meta.label_en) : tool}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-[10px] text-charcoal/40 mt-1">
              {step.tools.length === 0
                ? (isAr
                    ? 'لم يتم اختيار شيء — ستحصل الخطوة على جميع أدوات القالب.'
                    : 'Nothing selected — step inherits all template tools.')
                : (isAr
                    ? `الأدوات المحددة: ${step.tools.length}/${templateTools.length}`
                    : `${step.tools.length}/${templateTools.length} selected`)}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
