import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { ArrowRight, Save, Lock, Sparkles } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type {
  PresentationInput,
  PresentationInputSource,
  PresentationInputType,
  PresentationStep,
  PresentationStepKind,
  PresentationTemplate,
  PresentationToolName,
} from '@/types';
import type { TemplateProposalChanges } from '@/lib/templateAssistant/client';
import InputsEditor from './components/template/InputsEditor';
import ToolsEditor from './components/template/ToolsEditor';
import StepsEditor from './components/template/StepsEditor';
import BrandSelector from './components/template/BrandSelector';
import TemplateAssistantPanel from './components/template/TemplateAssistantPanel';

const VALID_TOOLS: ReadonlySet<PresentationToolName> = new Set([
  'web_search',
  'web_fetch',
  'code_execution',
  'record_lookup',
  'drive_upload',
]);
const VALID_STEP_KINDS: ReadonlySet<PresentationStepKind> = new Set([
  'research',
  'outline',
  'build',
  'review',
  'custom',
]);
const VALID_INPUT_TYPES: ReadonlySet<PresentationInputType> = new Set([
  'text',
  'textarea',
  'number',
  'date',
  'dropdown',
]);
const VALID_INPUT_SOURCES: ReadonlySet<PresentationInputSource> = new Set(['user', 'record_field']);

/**
 * `/presentations/templates/:id` — edit a user-authored template.
 *
 * This is the Phase 2.0 SHELL: metadata only (slug, labels, description,
 * icon, record binding). The Inputs / Tools / Steps sections are stubbed
 * with "Next-turn" notes — they land in Phase 2.1.
 *
 * Daemon-synced templates land here read-only with a banner.
 */
export default function TemplateEditorPage(): JSX.Element {
  const { templateId } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const {
    presentationTemplates,
    models,
    updatePresentationTemplate,
    addToast,
    language,
  } = useAppStore();
  const isAr = language === 'ar';

  const template = useMemo(
    () => presentationTemplates.find((t) => t.id === templateId) ?? null,
    [presentationTemplates, templateId],
  );

  // Local working copy. We don't dispatch on every keystroke — Save commits
  // the patch back to the store + Supabase. This matches the existing
  // builder/editor pattern (e.g. WorkflowEditorPage).
  const [draft, setDraft] = useState<PresentationTemplate | null>(template);
  const [dirty, setDirty] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);

  useEffect(() => {
    setDraft(template);
    setDirty(false);
  }, [template]);

  // Live validation. Computed on every render so the inline error and the
  // Save button's disabled state both react immediately as the user types.
  // Order matches handleSave: empty slug → format → clash → empty labels.
  // Hooks must run regardless of whether `draft` is loaded, so this lives
  // ABOVE the early-return below.
  const validationError = useMemo<{ field: 'slug' | 'labels'; en: string; ar: string } | null>(() => {
    if (!draft) return null;
    if (draft.slug.trim() === '') {
      return { field: 'slug', en: 'Slug is required', ar: 'الرمز (slug) مطلوب' };
    }
    if (!/^[a-z0-9_-]+$/.test(draft.slug)) {
      return {
        field: 'slug',
        en: 'Lowercase letters, digits, "-" and "_" only',
        ar: 'يقبل أحرفاً صغيرة وأرقاماً و - و _ فقط',
      };
    }
    if (presentationTemplates.some((t) => t.id !== draft.id && t.slug === draft.slug)) {
      return {
        field: 'slug',
        en: 'Slug already used by another template',
        ar: 'الرمز مستخدم في قالب آخر',
      };
    }
    if (draft.label_en.trim() === '' || draft.label_ar.trim() === '') {
      return {
        field: 'labels',
        en: 'Both Arabic and English names are required',
        ar: 'الاسم بالعربية والإنجليزية مطلوبان',
      };
    }
    return null;
  }, [draft, presentationTemplates]);

  if (!template || !draft) {
    return (
      <div>
        <button
          onClick={() => navigate('/presentations/templates')}
          className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-charcoal mb-6"
        >
          <ArrowRight size={16} className="rtl:rotate-0 ltr:rotate-180" />
          {isAr ? 'القوالب' : 'Templates'}
        </button>
        <div className="card p-8 text-center text-charcoal/40">
          {isAr ? 'لم يتم العثور على القالب.' : 'Template not found.'}
        </div>
      </div>
    );
  }

  const readonly = !template.is_user_authored;

  const patch = (changes: Partial<PresentationTemplate>): void => {
    setDraft((d) => (d ? { ...d, ...changes } : d));
    setDirty(true);
  };

  const handleSave = (): void => {
    if (readonly) return;
    if (validationError) {
      addToast(isAr ? validationError.ar : validationError.en, 'error');
      return;
    }
    updatePresentationTemplate(draft.id, draft);
    addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
    setDirty(false);
  };

  /**
   * Apply a proposal from the AI assistant to the draft. Returns true if
   * applied (and the assistant card flips to "Applied"), false if rejected.
   *
   * Validation rules:
   *  - Unknown tool names → drop them, don't fail the whole patch
   *  - Step / input objects missing required fields → reject the proposal
   *    entirely (the assistant should re-emit a valid one)
   *  - Generate stable ids for new steps / inputs / dropdown options so
   *    the editors' react-key + reorder logic keep working
   *  - When `tools` is patched, scope each step's `tools` to the new set
   */
  const applyAssistantPatch = (changes: TemplateProposalChanges): boolean => {
    if (readonly) {
      addToast(
        isAr ? 'هذا القالب للقراءة فقط' : 'This template is read-only',
        'error',
      );
      return false;
    }

    const next: Partial<PresentationTemplate> = {};

    // Scalars — pass through if present.
    if (typeof changes.label_en === 'string') next.label_en = changes.label_en;
    if (typeof changes.label_ar === 'string') next.label_ar = changes.label_ar;
    if (typeof changes.slug === 'string') next.slug = changes.slug;
    if (typeof changes.description_en === 'string') next.description_en = changes.description_en;
    if (typeof changes.description_ar === 'string') next.description_ar = changes.description_ar;
    if (typeof changes.icon === 'string') next.icon = changes.icon;
    if (typeof changes.output_structure === 'string') next.output_structure = changes.output_structure;

    // Tools — filter to known names; preserve order.
    let nextTools: PresentationToolName[] | null = null;
    if (Array.isArray(changes.tools)) {
      nextTools = (changes.tools as string[])
        .filter((t): t is PresentationToolName => VALID_TOOLS.has(t as PresentationToolName));
      next.tools = nextTools;
    }
    const effectiveTools = new Set<PresentationToolName>(nextTools ?? draft.tools);

    // Steps — validate each, generate ids, scope tools to effective set.
    if (Array.isArray(changes.steps)) {
      const validated: PresentationStep[] = [];
      for (const raw of changes.steps) {
        if (typeof raw !== 'object' || raw === null) continue;
        const r = raw as Record<string, unknown>;
        const kind = r.kind;
        const prompt = r.prompt;
        const toolsList = r.tools;
        if (typeof kind !== 'string' || !VALID_STEP_KINDS.has(kind as PresentationStepKind)) {
          addToast(
            isAr ? `خطوة بنوع غير صالح: ${String(kind)}` : `Invalid step kind: ${String(kind)}`,
            'error',
          );
          return false;
        }
        if (typeof prompt !== 'string') {
          addToast(isAr ? 'تعليمات الخطوة مطلوبة' : 'Step prompt is required', 'error');
          return false;
        }
        if (!Array.isArray(toolsList)) {
          addToast(isAr ? 'أدوات الخطوة مطلوبة (قائمة)' : 'Step tools must be an array', 'error');
          return false;
        }
        const stepTools = (toolsList as string[])
          .filter((t): t is PresentationToolName => VALID_TOOLS.has(t as PresentationToolName))
          .filter((t) => effectiveTools.has(t));
        const id = typeof r.id === 'string' && r.id.length > 0 ? (r.id as string) : uuid();
        const step: PresentationStep = {
          id,
          kind: kind as PresentationStepKind,
          prompt,
          tools: stepTools,
        };
        if (typeof r.label_en === 'string') step.label_en = r.label_en;
        if (typeof r.label_ar === 'string') step.label_ar = r.label_ar;
        validated.push(step);
      }
      next.steps = validated;
    } else if (nextTools) {
      // Tools changed but no steps patch — clean each existing step's
      // tool subset against the new template tools.
      next.steps = draft.steps.map((s) => ({
        ...s,
        tools: s.tools.filter((t) => effectiveTools.has(t)),
      }));
    }

    // Input schema — validate, generate ids, dropdown option ids if any.
    if (Array.isArray(changes.input_schema)) {
      const validated: PresentationInput[] = [];
      for (const raw of changes.input_schema) {
        if (typeof raw !== 'object' || raw === null) continue;
        const r = raw as Record<string, unknown>;
        const name = r.name;
        const labelEn = r.label_en;
        const labelAr = r.label_ar;
        const type = r.type;
        const required = r.required;
        const source = r.source;
        if (
          typeof name !== 'string' ||
          name.length === 0 ||
          typeof labelEn !== 'string' ||
          typeof labelAr !== 'string' ||
          typeof type !== 'string' ||
          !VALID_INPUT_TYPES.has(type as PresentationInputType) ||
          typeof required !== 'boolean' ||
          typeof source !== 'string' ||
          !VALID_INPUT_SOURCES.has(source as PresentationInputSource)
        ) {
          addToast(
            isAr ? `مدخل غير صالح: ${String(name ?? '?')}` : `Invalid input: ${String(name ?? '?')}`,
            'error',
          );
          return false;
        }
        const input: PresentationInput = {
          name,
          label_en: labelEn,
          label_ar: labelAr,
          type: type as PresentationInputType,
          required,
          source: source as PresentationInputSource,
        };
        if (typeof r.record_field === 'string') input.record_field = r.record_field;
        if (typeof r.placeholder_en === 'string') input.placeholder_en = r.placeholder_en;
        if (typeof r.placeholder_ar === 'string') input.placeholder_ar = r.placeholder_ar;
        if (typeof r.default_value === 'string' || typeof r.default_value === 'number') {
          input.default_value = r.default_value as string | number;
        }
        // Dropdown options — generate ids if missing so the editor's
        // option list stays stable across reorders.
        if (input.type === 'dropdown' && Array.isArray(r.options)) {
          input.options = (r.options as Array<Record<string, unknown>>).map((opt) => ({
            id: typeof opt.id === 'string' && opt.id.length > 0 ? (opt.id as string) : uuid(),
            value: typeof opt.value === 'string' ? opt.value : '',
            label_en: typeof opt.label_en === 'string' ? opt.label_en : '',
            label_ar: typeof opt.label_ar === 'string' ? opt.label_ar : '',
          }));
        }
        validated.push(input);
      }
      next.input_schema = validated;
    }

    if (Object.keys(next).length === 0) {
      addToast(
        isAr ? 'لا يوجد تغيير قابل للتطبيق' : 'No applicable changes in this proposal',
        'error',
      );
      return false;
    }

    patch(next);
    addToast(isAr ? 'تم تطبيق المقترح' : 'Proposal applied', 'success');
    return true;
  };

  return (
    <div className="max-w-3xl">
      <button
        onClick={() => navigate('/presentations/templates')}
        className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-charcoal mb-4"
      >
        <ArrowRight size={16} className="rtl:rotate-0 ltr:rotate-180" />
        {isAr ? 'القوالب' : 'Templates'}
      </button>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-charcoal">
            {isAr ? draft.label_ar : draft.label_en}
          </h1>
          <p className="text-sm text-charcoal/50 mt-1 font-mono">{draft.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          {!readonly && (
            <Button variant="ghost" onClick={() => setAssistantOpen((v) => !v)}>
              <Sparkles size={14} />
              {isAr ? 'مساعد ذكي' : 'AI helper'}
            </Button>
          )}
          {!readonly && (
            <Button onClick={handleSave} disabled={!dirty || validationError !== null}>
              <Save size={14} />
              {isAr ? 'حفظ' : 'Save'}
            </Button>
          )}
        </div>
      </div>

      {readonly && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-charcoal/15 bg-charcoal/5 mb-6">
          <Lock size={18} className="text-charcoal/50 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm text-charcoal/70">
            <p className="font-bold">
              {isAr ? 'هذا القالب للقراءة فقط' : 'This template is read-only'}
            </p>
            <p className="mt-1 text-charcoal/60">
              {isAr
                ? 'القوالب المُزامَنة من Daemon لا يمكن تعديلها هنا. انسخ القالب أولاً ثم عدّل النسخة.'
                : 'Daemon-synced templates can\'t be edited here. Clone it first, then edit the copy.'}
            </p>
          </div>
        </div>
      )}

      {/* Metadata section — Phase 2.0 */}
      <Section title={isAr ? 'المعلومات الأساسية' : 'Basics'}>
        <Field label={isAr ? 'الاسم (عربي)' : 'Name (Arabic)'} required>
          <input
            type="text"
            value={draft.label_ar}
            onChange={(e) => patch({ label_ar: e.target.value })}
            disabled={readonly}
            className="form-input"
            dir="rtl"
          />
        </Field>
        <Field label={isAr ? 'الاسم (إنجليزي)' : 'Name (English)'} required>
          <input
            type="text"
            value={draft.label_en}
            onChange={(e) => patch({ label_en: e.target.value })}
            disabled={readonly}
            className="form-input"
            dir="ltr"
          />
        </Field>
        <Field label={isAr ? 'الوصف (عربي)' : 'Description (Arabic)'}>
          <textarea
            value={draft.description_ar ?? ''}
            onChange={(e) => patch({ description_ar: e.target.value })}
            disabled={readonly}
            className="form-input min-h-[60px]"
            dir="rtl"
            rows={2}
          />
        </Field>
        <Field label={isAr ? 'الوصف (إنجليزي)' : 'Description (English)'}>
          <textarea
            value={draft.description_en ?? ''}
            onChange={(e) => patch({ description_en: e.target.value })}
            disabled={readonly}
            className="form-input min-h-[60px]"
            dir="ltr"
            rows={2}
          />
        </Field>
        <Field
          label={isAr ? 'الرمز (slug)' : 'Slug'}
          hint={isAr
            ? 'معرف فريد للنظام. أحرف صغيرة وأرقام و - فقط.'
            : 'Unique system identifier. Lowercase letters, digits, "-" only.'}
          required
          error={
            validationError?.field === 'slug'
              ? (isAr ? validationError.ar : validationError.en)
              : undefined
          }
        >
          <input
            type="text"
            value={draft.slug}
            onChange={(e) => patch({ slug: e.target.value })}
            disabled={readonly}
            className={`form-input font-mono ${
              validationError?.field === 'slug' ? 'border-red-300 focus:border-red-400' : ''
            }`}
            dir="ltr"
          />
        </Field>
        <Field
          label={isAr ? 'الأيقونة (Lucide)' : 'Icon (Lucide name)'}
          hint={isAr ? 'مثل: building-2, file-text, presentation' : 'e.g. building-2, file-text, presentation'}
        >
          <input
            type="text"
            value={draft.icon}
            onChange={(e) => patch({ icon: e.target.value })}
            disabled={readonly}
            className="form-input font-mono"
            dir="ltr"
          />
        </Field>
        <Field label={isAr ? 'متاح في القائمة' : 'Available in picker'}>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.is_available}
              onChange={(e) => patch({ is_available: e.target.checked })}
              disabled={readonly}
              className="w-4 h-4"
            />
            <span className="text-sm text-charcoal/70">
              {isAr
                ? 'إظهار هذا القالب في نافذة اختيار القوالب'
                : 'Show this template in the picker modal'}
            </span>
          </label>
        </Field>
      </Section>

      {/* Record binding — Phase 2.0 */}
      <Section title={isAr ? 'ربط بنموذج' : 'Record binding'}>
        <Field
          label={isAr ? 'النموذج المرتبط' : 'Bound model'}
          hint={isAr
            ? 'عند التحديد، تظهر القوالب أيضاً في زر "إنشاء عرض" على صفحات سجلات هذا النموذج.'
            : 'When set, this template also appears under the "Generate deck" button on records of that model.'}
        >
          <select
            value={draft.record_binding?.model_slug ?? ''}
            onChange={(e) => {
              const slug = e.target.value;
              if (slug === '') {
                patch({ record_binding: null });
              } else {
                patch({
                  record_binding: {
                    model_slug: slug,
                    optional: draft.record_binding?.optional ?? true,
                  },
                });
              }
            }}
            disabled={readonly}
            className="form-input"
          >
            <option value="">{isAr ? '— لا ربط —' : '— no binding —'}</option>
            {models.map((m) => (
              <option key={m.id} value={m.name}>
                {isAr ? m.label_ar : m.label_en} ({m.name})
              </option>
            ))}
          </select>
        </Field>
        {draft.record_binding && (
          <Field label={isAr ? 'سجل اختياري' : 'Record optional'}>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.record_binding.optional}
                onChange={(e) =>
                  patch({
                    record_binding: {
                      ...draft.record_binding!,
                      optional: e.target.checked,
                    },
                  })
                }
                disabled={readonly}
                className="w-4 h-4"
              />
              <span className="text-sm text-charcoal/70">
                {isAr
                  ? 'يمكن إنشاء العرض بدون اختيار سجل'
                  : 'User can generate without picking a record'}
              </span>
            </label>
          </Field>
        )}
      </Section>

      {/* Inputs section — what the user fills in when generating a deck */}
      <Section
        title={isAr ? 'المدخلات' : 'Inputs'}
        subtitle={
          isAr
            ? `${draft.input_schema.length} مدخل — يطلبها النموذج من المستخدم عند إنشاء عرض`
            : `${draft.input_schema.length} input(s) — what the form asks the user when generating`
        }
      >
        <InputsEditor
          inputs={draft.input_schema}
          recordBinding={draft.record_binding}
          readonly={readonly}
          onChange={(input_schema) => patch({ input_schema })}
        />
      </Section>

      {/* Tools section — what the agent can do at runtime */}
      <Section
        title={isAr ? 'الأدوات' : 'Tools'}
        subtitle={
          isAr
            ? `${draft.tools.length} أداة مفعّلة — ما يستطيع وكيل السحابة استخدامه`
            : `${draft.tools.length} tool(s) enabled — what the cloud agent can call`
        }
      >
        <ToolsEditor
          selected={draft.tools}
          readonly={readonly}
          onChange={(tools) => {
            // When tools are removed at the template level, also drop them
            // from each step's tool subset — otherwise the step's `tools`
            // list would point at tools that no longer exist on the template.
            const enabled = new Set<PresentationToolName>(tools);
            const cleanedSteps = draft.steps.map((step) => ({
              ...step,
              tools: step.tools.filter((t) => enabled.has(t)),
            }));
            patch({ tools, steps: cleanedSteps });
          }}
        />
      </Section>

      {/* Brand section — references a brand record from the brand library.
          Editing the brand updates every template that references it. */}
      <Section
        title={isAr ? 'الهوية والتصميم' : 'Brand & design'}
        subtitle={
          isAr
            ? 'اختر هوية من المكتبة. يحقنها الوكيل في كل خطوة.'
            : 'Pick a brand from the library. The worker injects it into every step.'
        }
      >
        <BrandSelector
          brandId={draft.brand_id}
          readonly={readonly}
          onChange={(brand_id) => patch({ brand_id })}
        />
      </Section>

      {/* Output structure section — what THIS deck's slides are. Distinct
          from brand (which is across-templates visual identity). */}
      <Section
        title={isAr ? 'هيكل الإخراج' : 'Output structure'}
        subtitle={
          isAr
            ? 'عدد الشرائح، تسلسلها، وقواعد كل شريحة. مختلف عن الهوية: الهوية تنطبق على كل العروض، الهيكل يصف هذا العرض تحديداً.'
            : 'Slide count, sequence, per-slide rules. Distinct from brand: brand is across-decks visual identity; this is what THIS deck contains.'
        }
      >
        <textarea
          value={draft.output_structure}
          onChange={(e) => patch({ output_structure: e.target.value })}
          disabled={readonly}
          rows={10}
          placeholder={isAr
            ? 'مثال:\n- عدد الشرائح: ١٥\n- التسلسل:\n  ١. شريحة الغلاف\n  ٢. عن وصل\n  ٣. فاصل تحليل السوق\n  ٤. تحليل السوق\n  ...'
            : 'e.g.\n- Slide count: 15\n- Sequence:\n  1. Cover\n  2. About Us\n  3. DIVIDER — Market\n  4. Market analysis\n  ...'}
          dir={isAr ? 'rtl' : 'ltr'}
          className="form-input text-sm w-full font-mono"
        />
      </Section>

      {/* Steps section — ordered pipeline */}
      <Section
        title={isAr ? 'الخطوات' : 'Steps'}
        subtitle={
          isAr
            ? `${draft.steps.length} خطوة — يمشي وكيل السحابة فيها بالترتيب`
            : `${draft.steps.length} step(s) — the cloud agent walks these in order`
        }
      >
        <StepsEditor
          steps={draft.steps}
          templateTools={draft.tools}
          readonly={readonly}
          onChange={(steps) => patch({ steps })}
        />
      </Section>

      {/* AI helper panel — fixed-position drawer; controlled by the
          "AI helper" toggle in the page header. The panel can call back
          via `onApply` to merge a proposed patch into the draft. */}
      <TemplateAssistantPanel
        open={assistantOpen && !readonly}
        onClose={() => setAssistantOpen(false)}
        template={draft}
        onApply={applyAssistantPatch}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Local presentation helpers — keep this page self-contained for now.
// If they get reused elsewhere, move into src/components/ui.
// ────────────────────────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="card p-5 mb-4">
      <div className="mb-4">
        <h2 className="text-base font-bold text-charcoal">{title}</h2>
        {subtitle && (
          <p className="text-xs text-charcoal/50 mt-0.5">{subtitle}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  /** Inline validation error. When set, overrides `hint` and renders red. */
  error?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <label className="block text-xs font-bold text-charcoal/70 uppercase tracking-wide mb-1">
        {label}
        {required && <span className="text-red-500 ms-1">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600 mt-1">{error}</p>
      ) : hint ? (
        <p className="text-xs text-charcoal/40 mt-1">{hint}</p>
      ) : null}
    </div>
  );
}

