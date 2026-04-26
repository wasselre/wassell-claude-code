import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Save, Lock } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import BrandEditor from './components/template/BrandEditor';
import type { PresentationBrandRecord } from '@/types';

/**
 * `/presentations/brands/:brandId` — edit a brand row. Re-uses
 * `BrandEditor` for the palette / typography / rules body. Top-level
 * fields (slug, labels, description) live here on the page.
 *
 * System brands (Wassel) render with a read-only banner.
 */
export default function BrandEditPage(): JSX.Element {
  const { brandId } = useParams<{ brandId: string }>();
  const navigate = useNavigate();
  const {
    presentationBrands,
    updatePresentationBrand,
    addToast,
    language,
  } = useAppStore();
  const isAr = language === 'ar';

  const brand = useMemo(
    () => presentationBrands.find((b) => b.id === brandId) ?? null,
    [presentationBrands, brandId],
  );

  const [draft, setDraft] = useState<PresentationBrandRecord | null>(brand);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(brand);
    setDirty(false);
  }, [brand]);

  const validationError = useMemo<{ field: 'slug' | 'labels'; en: string; ar: string } | null>(() => {
    if (!draft) return null;
    if (draft.slug.trim() === '') {
      return { field: 'slug', en: 'Slug is required', ar: 'الرمز مطلوب' };
    }
    if (!/^[a-z0-9_-]+$/.test(draft.slug)) {
      return { field: 'slug', en: 'Lowercase letters, digits, "-" and "_" only', ar: 'يقبل أحرفاً صغيرة وأرقاماً و - و _ فقط' };
    }
    if (presentationBrands.some((b) => b.id !== draft.id && b.slug === draft.slug)) {
      return { field: 'slug', en: 'Slug already used', ar: 'الرمز مستخدم بالفعل' };
    }
    if (draft.label_en.trim() === '' || draft.label_ar.trim() === '') {
      return { field: 'labels', en: 'Both Arabic and English names are required', ar: 'الاسم بالعربية والإنجليزية مطلوبان' };
    }
    return null;
  }, [draft, presentationBrands]);

  if (!brand || !draft) {
    return (
      <div>
        <button
          onClick={() => navigate('/presentations/brands')}
          className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-charcoal mb-6"
        >
          <ArrowRight size={16} className="rtl:rotate-0 ltr:rotate-180" />
          {isAr ? 'الهويات' : 'Brands'}
        </button>
        <div className="card p-8 text-center text-charcoal/40">
          {isAr ? 'لم يتم العثور على الهوية.' : 'Brand not found.'}
        </div>
      </div>
    );
  }

  const readonly = brand.is_system;

  const patch = (changes: Partial<PresentationBrandRecord>): void => {
    setDraft((d) => (d ? { ...d, ...changes } : d));
    setDirty(true);
  };

  const handleSave = (): void => {
    if (readonly) return;
    if (validationError) {
      addToast(isAr ? validationError.ar : validationError.en, 'error');
      return;
    }
    updatePresentationBrand(draft.id, draft);
    addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
    setDirty(false);
  };

  return (
    <div className="max-w-3xl">
      <button
        onClick={() => navigate('/presentations/brands')}
        className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-charcoal mb-4"
      >
        <ArrowRight size={16} className="rtl:rotate-0 ltr:rotate-180" />
        {isAr ? 'الهويات' : 'Brands'}
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
              {isAr ? 'هذه هوية نظام' : 'This is a system brand'}
            </p>
            <p className="mt-1 text-charcoal/60">
              {isAr
                ? 'هويات النظام للقراءة فقط. انسخها أولاً ثم عدّل النسخة لإنشاء هويتك الخاصة.'
                : 'System brands are read-only. Clone it first to make your own editable copy.'}
            </p>
          </div>
        </div>
      )}

      {/* Top-level fields */}
      <section className="card p-5 mb-4">
        <h2 className="text-base font-bold text-charcoal mb-4">
          {isAr ? 'المعلومات الأساسية' : 'Basics'}
        </h2>
        <div className="space-y-3">
          <Field label={isAr ? 'الاسم (عربي)' : 'Name (Arabic)'} required>
            <input
              type="text"
              value={draft.label_ar}
              onChange={(e) => patch({ label_ar: e.target.value })}
              disabled={readonly}
              dir="rtl"
              className="form-input"
            />
          </Field>
          <Field label={isAr ? 'الاسم (إنجليزي)' : 'Name (English)'} required>
            <input
              type="text"
              value={draft.label_en}
              onChange={(e) => patch({ label_en: e.target.value })}
              disabled={readonly}
              dir="ltr"
              className="form-input"
            />
          </Field>
          <Field label={isAr ? 'الرمز (slug)' : 'Slug'} required
            error={validationError?.field === 'slug' ? (isAr ? validationError.ar : validationError.en) : undefined}
          >
            <input
              type="text"
              value={draft.slug}
              onChange={(e) => patch({ slug: e.target.value })}
              disabled={readonly}
              dir="ltr"
              className={`form-input font-mono ${validationError?.field === 'slug' ? 'border-red-300' : ''}`}
            />
          </Field>
          <Field label={isAr ? 'الوصف (عربي)' : 'Description (Arabic)'}>
            <textarea
              value={draft.description_ar ?? ''}
              onChange={(e) => patch({ description_ar: e.target.value })}
              disabled={readonly}
              dir="rtl"
              rows={2}
              className="form-input w-full"
            />
          </Field>
          <Field label={isAr ? 'الوصف (إنجليزي)' : 'Description (English)'}>
            <textarea
              value={draft.description_en ?? ''}
              onChange={(e) => patch({ description_en: e.target.value })}
              disabled={readonly}
              dir="ltr"
              rows={2}
              className="form-input w-full"
            />
          </Field>
        </div>
      </section>

      {/* Brand body — re-use the palette / typography / rules editor.
          Pass a synthetic id so the BrandEditor's "copy from another"
          picker excludes self correctly. */}
      <section className="card p-5">
        <h2 className="text-base font-bold text-charcoal mb-4">
          {isAr ? 'لوحة الألوان وقواعد التصميم' : 'Palette & design rules'}
        </h2>
        <BrandEditor
          brand={{
            colors: draft.colors,
            font_family: draft.font_family,
            font_notes: draft.font_notes,
            design_rules: draft.design_rules,
            text_rules: draft.text_rules,
            forbidden_phrases: draft.forbidden_phrases,
            required_phrases: draft.required_phrases,
          }}
          readonly={readonly}
          // Brands shouldn't reference themselves in the "copy from"
          // picker; passing the id excludes self.
          currentTemplateId={`brand:${draft.id}`}
          onChange={(brandBody) => {
            if (brandBody === null) {
              // Cleared — reset fields to empty defaults.
              patch({
                colors: [],
                font_family: '',
                font_notes: '',
                design_rules: '',
                text_rules: '',
                forbidden_phrases: [],
                required_phrases: [],
              });
            } else {
              patch({
                colors: brandBody.colors,
                font_family: brandBody.font_family,
                font_notes: brandBody.font_notes,
                design_rules: brandBody.design_rules,
                text_rules: brandBody.text_rules,
                forbidden_phrases: brandBody.forbidden_phrases,
                required_phrases: brandBody.required_phrases,
              });
            }
          }}
        />
      </section>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
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
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
