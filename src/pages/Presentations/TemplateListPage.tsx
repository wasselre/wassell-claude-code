import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Edit,
  Copy,
  Trash2,
  ArrowRight,
  FileText,
  CheckCircle2,
  XCircle,
  Lock,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import type { PresentationTemplate } from '@/types';

/**
 * `/presentations/templates` — list every presentation template, separating
 * user-authored ones (editable, deletable) from daemon-synced ones
 * (read-only, can only be cloned). Phase 2 entry point: a "+ New Template"
 * button drops the user into the editor with a blank stub.
 *
 * Daemon-synced rows are still shown so the user can see the bundled
 * `wassel` template and clone it as a starting point. Once the daemon is
 * retired in Phase 5, all rows here will be `is_user_authored: true`.
 */
export default function TemplateListPage(): JSX.Element {
  const navigate = useNavigate();
  const {
    presentationTemplates,
    createPresentationTemplate,
    deletePresentationTemplate,
    duplicatePresentationTemplate,
    addToast,
    language,
  } = useAppStore();
  const isAr = language === 'ar';

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...presentationTemplates].sort((a, b) => {
        // User-authored first (most likely to be edited), then alphabetical.
        if (a.is_user_authored !== b.is_user_authored) {
          return a.is_user_authored ? -1 : 1;
        }
        return (isAr ? a.label_ar : a.label_en).localeCompare(
          isAr ? b.label_ar : b.label_en,
        );
      }),
    [presentationTemplates, isAr],
  );

  const handleNew = (): void => {
    // Stub template with sensible defaults. Editor receives the new id and
    // lets the user fill in the rest.
    const tpl = createPresentationTemplate({
      slug: `template-${Date.now()}`,
      label_ar: 'قالب جديد',
      label_en: 'New template',
      description_ar: '',
      description_en: '',
      icon: 'file-text',
      input_schema: [],
      record_binding: null,
      estimated_duration_seconds: null,
      is_available: true,
      tools: [],
      steps: [],
      brand: null,
      brand_id: null,
    });
    navigate(`/presentations/templates/${tpl.id}`);
  };

  const handleClone = (tpl: PresentationTemplate): void => {
    const clone = duplicatePresentationTemplate(tpl.id);
    if (!clone) {
      addToast(isAr ? 'تعذّر النسخ' : 'Could not clone', 'error');
      return;
    }
    addToast(
      isAr ? `تم إنشاء "${clone.label_ar}"` : `Created "${clone.label_en}"`,
      'success',
    );
    navigate(`/presentations/templates/${clone.id}`);
  };

  const handleDelete = (tpl: PresentationTemplate): void => {
    deletePresentationTemplate(tpl.id);
    addToast(
      isAr ? `تم حذف "${tpl.label_ar}"` : `Deleted "${tpl.label_en}"`,
      'success',
    );
    setConfirmDeleteId(null);
  };

  return (
    <div>
      <button
        onClick={() => navigate('/presentations')}
        className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-charcoal mb-4"
      >
        <ArrowRight size={16} className="rtl:rotate-0 ltr:rotate-180" />
        {isAr ? 'العروض' : 'Presentations'}
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-charcoal">
            {isAr ? 'قوالب العروض' : 'Presentation templates'}
          </h1>
          <p className="text-sm text-charcoal/50 mt-1">
            {isAr
              ? 'القوالب التي يستخدمها وكيل السحابة لإنتاج العروض. المُنشأة بواسطتك قابلة للتعديل والحذف.'
              : 'Templates the cloud agent uses to produce decks. Ones you authored are editable and deletable.'}
          </p>
        </div>
        <Button onClick={handleNew}>
          <Plus size={16} />
          {isAr ? 'قالب جديد' : 'New template'}
        </Button>
      </div>

      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
          <FileText size={48} className="mb-4" />
          <p className="text-lg font-bold">
            {isAr ? 'لا توجد قوالب بعد' : 'No templates yet'}
          </p>
          <p className="text-sm">
            {isAr ? 'انقر "قالب جديد" لإنشاء واحد.' : 'Click "New template" to create one.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {sorted.map((tpl) => {
            const Icon = getIconComponent(tpl.icon);
            const label = isAr ? tpl.label_ar : tpl.label_en;
            const description = isAr ? tpl.description_ar : tpl.description_en;
            return (
              <div
                key={tpl.id}
                className="card p-5 flex items-center gap-4"
              >
                <div className="w-10 h-10 rounded-lg bg-copper/10 flex items-center justify-center shrink-0">
                  <Icon size={18} className="text-copper" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-charcoal">{label}</h3>
                    {tpl.is_user_authored ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-copper/15 text-copper">
                        {isAr ? 'مُنشأ بواسطتك' : 'User-authored'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-charcoal/10 text-charcoal/60">
                        <Lock size={10} />
                        {isAr ? 'مزامنة من Daemon' : 'Daemon-synced'}
                      </span>
                    )}
                    {tpl.is_available ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-700">
                        <CheckCircle2 size={12} />
                        {isAr ? 'متاح' : 'Available'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-charcoal/40">
                        <XCircle size={12} />
                        {isAr ? 'مخفي' : 'Hidden'}
                      </span>
                    )}
                  </div>
                  {description && (
                    <p className="text-sm text-charcoal/50 mt-1 line-clamp-2">{description}</p>
                  )}
                  <div className="text-xs text-charcoal/40 mt-1">
                    <span className="font-mono">{tpl.slug}</span>
                    <span className="mx-2">·</span>
                    <span>
                      {tpl.tools.length} {isAr ? 'أداة' : 'tools'}
                    </span>
                    <span className="mx-2">·</span>
                    <span>
                      {tpl.steps.length} {isAr ? 'خطوة' : 'steps'}
                    </span>
                    <span className="mx-2">·</span>
                    <span>
                      {tpl.input_schema.length} {isAr ? 'مدخل' : 'inputs'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {tpl.is_user_authored && (
                    <button
                      type="button"
                      onClick={() => navigate(`/presentations/templates/${tpl.id}`)}
                      className="p-2 rounded-lg hover:bg-cream/40 text-charcoal/60 hover:text-charcoal"
                      title={isAr ? 'تعديل' : 'Edit'}
                    >
                      <Edit size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleClone(tpl)}
                    className="p-2 rounded-lg hover:bg-cream/40 text-charcoal/60 hover:text-charcoal"
                    title={isAr ? 'نسخ' : 'Clone'}
                  >
                    <Copy size={16} />
                  </button>
                  {tpl.is_user_authored && (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(tpl.id)}
                      className="p-2 rounded-lg hover:bg-red-50 text-charcoal/60 hover:text-red-600"
                      title={isAr ? 'حذف' : 'Delete'}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation — inline modal-ish, no portal needed for this */}
      {confirmDeleteId && (() => {
        const tpl = presentationTemplates.find((t) => t.id === confirmDeleteId);
        if (!tpl) return null;
        return (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
            onClick={() => setConfirmDeleteId(null)}
          >
            <div
              className="bg-cream rounded-2xl p-6 max-w-md w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-bold text-charcoal mb-2">
                {isAr ? 'حذف القالب؟' : 'Delete template?'}
              </h2>
              <p className="text-sm text-charcoal/60 mb-4">
                {isAr
                  ? `سيتم حذف "${tpl.label_ar}" نهائياً. الوظائف السابقة التي استخدمت هذا القالب لن تتأثر.`
                  : `"${tpl.label_en}" will be deleted permanently. Past jobs that used this template are unaffected.`}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                  {isAr ? 'إلغاء' : 'Cancel'}
                </Button>
                <Button variant="danger" onClick={() => handleDelete(tpl)}>
                  <Trash2 size={14} />
                  {isAr ? 'حذف' : 'Delete'}
                </Button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
