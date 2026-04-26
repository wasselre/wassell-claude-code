import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Save, Lock } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { PresentationTemplate, PresentationToolName } from '@/types';
import InputsEditor from './components/template/InputsEditor';
import ToolsEditor from './components/template/ToolsEditor';
import StepsEditor from './components/template/StepsEditor';

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
        {!readonly && (
          <Button onClick={handleSave} disabled={!dirty || validationError !== null}>
            <Save size={14} />
            {isAr ? 'حفظ' : 'Save'}
          </Button>
        )}
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

