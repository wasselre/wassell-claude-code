import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Search, ImageOff, Pencil, Trash2, MoreVertical, Layers, Sparkles } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import TemplatesAiAgentModal from './TemplatesAiAgentModal';

/**
 * Custom page for `/model/design_templates`. Renders the templates as a
 * card library (reference image + name + variable count) instead of the
 * generic record-list table. Clicking a card opens the standard record
 * form to edit the template's name / prompts / variables / reference
 * image — all of which stay in the regular Builder + RecordFormPage flow.
 *
 * Wired in App.tsx's RecordListDispatcher: `if (modelName ===
 * 'design_templates') return <TemplatesLibraryPage />`.
 */
export default function TemplatesLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language, models, records, deleteRecord, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [query, setQuery] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);

  const designTemplatesModel = useMemo(
    () => models.find((m) => m.name === 'design_templates'),
    [models],
  );

  const cards = useMemo(() => {
    if (!designTemplatesModel) return [];
    const list = records[designTemplatesModel.id] ?? [];
    const q = query.trim().toLowerCase();
    return list
      .map((r) => {
        const data = r.data as Record<string, unknown>;
        const name = typeof data.name === 'string' ? data.name : '';
        const referenceImage = typeof data.reference_image === 'string' ? data.reference_image : '';
        const vars = Array.isArray(data.variables) ? (data.variables as unknown[]) : [];
        return {
          id: r.id,
          name: name || (isAr ? '(بدون اسم)' : '(unnamed)'),
          referenceImage,
          variableCount: vars.length,
          updatedAt: r.updated_at,
        };
      })
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [designTemplatesModel, records, query, isAr]);

  if (!designTemplatesModel) {
    return (
      <div className="p-6 text-charcoal/50">
        {isAr ? 'نموذج القوالب غير موجود — أعد تحميل الصفحة.' : 'design_templates model not found — try reloading.'}
      </div>
    );
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(isAr ? `حذف القالب "${name}"؟` : `Delete template "${name}"?`)) return;
    try {
      await deleteRecord(designTemplatesModel.id, id);
      setMenuOpenId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(isAr ? `فشل الحذف: ${msg}` : `Delete failed: ${msg}`, 'error');
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto" onClick={() => setMenuOpenId(null)}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-copper/10 text-copper flex items-center justify-center">
            <Layers size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-charcoal">
              {isAr ? designTemplatesModel.label_ar : designTemplatesModel.label_en}
            </h1>
            <p className="text-sm text-charcoal/60">
              {cards.length === 0
                ? (isAr ? 'لا توجد قوالب بعد' : 'No templates yet')
                : isAr
                  ? `${cards.length} قالب`
                  : `${cards.length} template${cards.length === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/40" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isAr ? 'بحث...' : 'Search...'}
              className="form-input ps-9 w-64"
            />
          </div>
          <Button
            variant="secondary"
            type="button"
            onClick={() => setAiOpen(true)}
            title={isAr ? 'الصق وصف القالب وسيقوم الذكاء الاصطناعي بإنشائه' : 'Paste a template description and the AI will build it'}
          >
            <Sparkles size={16} className="text-copper" />
            {isAr ? 'إنشاء بالذكاء الاصطناعي' : 'AI Agent'}
          </Button>
          <Button
            type="button"
            onClick={() => navigate(`/model/${designTemplatesModel.name}/new`)}
          >
            <Plus size={16} />
            {isAr ? 'قالب جديد' : 'New Template'}
          </Button>
        </div>
      </div>

      {aiOpen && (
        <TemplatesAiAgentModal
          modelId={designTemplatesModel.id}
          onClose={() => setAiOpen(false)}
        />
      )}

      {/* Empty state */}
      {cards.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed border-sand/40 rounded-2xl">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-copper/10 text-copper flex items-center justify-center mb-4">
            <Layers size={32} />
          </div>
          <h3 className="text-lg font-bold text-charcoal mb-1">
            {query
              ? (isAr ? 'لا توجد قوالب تطابق البحث' : 'No templates match your search')
              : (isAr ? 'مكتبة القوالب فارغة' : 'Your templates library is empty')}
          </h3>
          <p className="text-sm text-charcoal/50 mb-6 max-w-md mx-auto">
            {query
              ? (isAr ? 'جرّب بحثاً آخر أو أنشئ قالباً جديداً.' : 'Try a different search or add a new template.')
              : (isAr
                ? 'أنشئ أول قالب — صورة مرجعية + ٣ تعليمات (تنظيف، تعديل، تصميم) + قائمة المتغيرات.'
                : 'Create your first template — reference image + 3 prompts (cleanup, editing, design) + variables list.')}
          </p>
          {!query && (
            <Button
              type="button"
              onClick={() => navigate(`/model/${designTemplatesModel.name}/new`)}
            >
              <Plus size={16} />
              {isAr ? 'قالب جديد' : 'New Template'}
            </Button>
          )}
        </div>
      ) : (
        /* Card grid */
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {cards.map((c) => (
            <div
              key={c.id}
              className="group relative rounded-2xl overflow-hidden border border-sand/40 bg-white hover:border-copper/40 hover:shadow-lg transition-all cursor-pointer"
              onClick={() => navigate(`/model/${designTemplatesModel.name}/${c.id}`)}
            >
              {/* Reference image */}
              <div className="aspect-square bg-sand/20 flex items-center justify-center overflow-hidden">
                {c.referenceImage ? (
                  <img
                    src={c.referenceImage}
                    alt=""
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    loading="lazy"
                  />
                ) : (
                  <ImageOff size={36} className="text-charcoal/15" />
                )}
              </div>
              {/* Body */}
              <div className="p-3">
                <div className="font-bold text-sm text-charcoal truncate">{c.name}</div>
                <div className="text-xs text-charcoal/50 mt-0.5">
                  {c.variableCount === 0
                    ? (isAr ? 'بدون متغيرات' : 'No variables')
                    : isAr
                      ? `${c.variableCount} متغير`
                      : `${c.variableCount} variable${c.variableCount === 1 ? '' : 's'}`}
                </div>
              </div>
              {/* Actions menu */}
              <div className="absolute top-2 end-2" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => setMenuOpenId(menuOpenId === c.id ? null : c.id)}
                  className="p-1.5 rounded-full bg-white/90 hover:bg-white text-charcoal shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={t('common.actions')}
                >
                  <MoreVertical size={14} />
                </button>
                {menuOpenId === c.id && (
                  <div className="absolute end-0 mt-1 w-44 rounded-xl border border-sand/40 bg-white shadow-lg overflow-hidden z-10">
                    <button
                      type="button"
                      onClick={() => navigate(`/model/${designTemplatesModel.name}/${c.id}`)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-charcoal hover:bg-cream/40 text-start"
                    >
                      <Pencil size={14} className="text-charcoal/50" />
                      {isAr ? 'تعديل' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(c.id, c.name)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 text-start"
                    >
                      <Trash2 size={14} />
                      {isAr ? 'حذف' : 'Delete'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
