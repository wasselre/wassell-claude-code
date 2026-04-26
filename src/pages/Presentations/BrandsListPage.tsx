import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Edit,
  Copy,
  Trash2,
  ArrowRight,
  Palette,
  Lock,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { PresentationBrandRecord } from '@/types';

/**
 * `/presentations/brands` — list every brand the workspace knows about.
 * The seeded `wassel` row is system-managed (read-only with a lock badge);
 * user-authored ones are editable + deletable. Cloning works on either.
 */
export default function BrandsListPage(): JSX.Element {
  const navigate = useNavigate();
  const {
    presentationBrands,
    presentationTemplates,
    createPresentationBrand,
    deletePresentationBrand,
    duplicatePresentationBrand,
    addToast,
    language,
  } = useAppStore();
  const isAr = language === 'ar';

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...presentationBrands].sort((a, b) => {
        // System brands first (Wassel anchors the list as the recommended
        // starting point), then alphabetical.
        if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
        return (isAr ? a.label_ar : a.label_en).localeCompare(
          isAr ? b.label_ar : b.label_en,
        );
      }),
    [presentationBrands, isAr],
  );

  // For each brand, count templates that reference it. Surfaced as a
  // chip so the user knows which brands are actively in use.
  const usageCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of presentationTemplates) {
      if (t.brand_id) counts[t.brand_id] = (counts[t.brand_id] ?? 0) + 1;
    }
    return counts;
  }, [presentationTemplates]);

  const handleNew = (): void => {
    const brand = createPresentationBrand({
      slug: `brand-${Date.now()}`,
      label_ar: 'هوية جديدة',
      label_en: 'New brand',
      description_ar: '',
      description_en: '',
      colors: [],
      font_family: '',
      font_notes: '',
      design_rules: '',
      text_rules: '',
      forbidden_phrases: [],
      required_phrases: [],
    });
    navigate(`/presentations/brands/${brand.id}`);
  };

  const handleClone = (brand: PresentationBrandRecord): void => {
    const clone = duplicatePresentationBrand(brand.id);
    if (!clone) {
      addToast(isAr ? 'تعذّر النسخ' : 'Could not clone', 'error');
      return;
    }
    addToast(
      isAr ? `تم إنشاء "${clone.label_ar}"` : `Created "${clone.label_en}"`,
      'success',
    );
    navigate(`/presentations/brands/${clone.id}`);
  };

  const handleDelete = (brand: PresentationBrandRecord): void => {
    deletePresentationBrand(brand.id);
    addToast(
      isAr ? `تم حذف "${brand.label_ar}"` : `Deleted "${brand.label_en}"`,
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
            {isAr ? 'الهويات والتصاميم' : 'Brands'}
          </h1>
          <p className="text-sm text-charcoal/50 mt-1">
            {isAr
              ? 'مكتبة الهويات: كل هوية تحتوي على ألوان، خطوط، وقواعد تصميم. القوالب تشير إلى الهوية بدلاً من تكرارها.'
              : 'Brand library — colors, typography, and design rules. Templates reference a brand instead of repeating it.'}
          </p>
        </div>
        <Button onClick={handleNew}>
          <Plus size={16} />
          {isAr ? 'هوية جديدة' : 'New brand'}
        </Button>
      </div>

      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
          <Palette size={48} className="mb-4" />
          <p className="text-lg font-bold">
            {isAr ? 'لا توجد هويات بعد' : 'No brands yet'}
          </p>
          <p className="text-sm">
            {isAr ? 'انقر "هوية جديدة" لإنشاء واحدة.' : 'Click "New brand" to create one.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {sorted.map((brand) => {
            const usage = usageCount[brand.id] ?? 0;
            return (
              <div key={brand.id} className="card p-5 flex items-center gap-4">
                {/* Color swatches strip */}
                <div className="flex shrink-0 rounded-lg overflow-hidden border border-sand/40 w-16 h-16 grid grid-cols-2">
                  {brand.colors.length === 0 ? (
                    <div className="col-span-2 row-span-2 bg-sand/20 flex items-center justify-center">
                      <Palette size={20} className="text-charcoal/30" />
                    </div>
                  ) : (
                    brand.colors.slice(0, 4).map((c) => {
                      const hex = c.hex.startsWith('#') ? c.hex : `#${c.hex}`;
                      return (
                        <div
                          key={c.id}
                          style={{ backgroundColor: hex }}
                          title={`${hex} ${c.role_en}`}
                        />
                      );
                    })
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-charcoal">
                      {isAr ? brand.label_ar : brand.label_en}
                    </h3>
                    {brand.is_system && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-charcoal/10 text-charcoal/60">
                        <Lock size={10} />
                        {isAr ? 'هوية النظام' : 'System'}
                      </span>
                    )}
                    {usage > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-copper/15 text-copper">
                        {usage} {isAr ? (usage === 1 ? 'قالب' : 'قوالب') : usage === 1 ? 'template' : 'templates'}
                      </span>
                    )}
                  </div>
                  {(isAr ? brand.description_ar : brand.description_en) && (
                    <p className="text-sm text-charcoal/50 mt-1 line-clamp-2">
                      {isAr ? brand.description_ar : brand.description_en}
                    </p>
                  )}
                  <div className="text-xs text-charcoal/40 mt-1">
                    <span className="font-mono">{brand.slug}</span>
                    <span className="mx-2">·</span>
                    <span>
                      {brand.colors.length} {isAr ? 'لون' : 'colors'}
                    </span>
                    {brand.font_family && (
                      <>
                        <span className="mx-2">·</span>
                        <span className="font-mono">{brand.font_family}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => navigate(`/presentations/brands/${brand.id}`)}
                    className="p-2 rounded-lg hover:bg-cream/40 text-charcoal/60 hover:text-charcoal"
                    title={isAr ? 'تعديل' : 'Edit'}
                  >
                    <Edit size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleClone(brand)}
                    className="p-2 rounded-lg hover:bg-cream/40 text-charcoal/60 hover:text-charcoal"
                    title={isAr ? 'نسخ' : 'Clone'}
                  >
                    <Copy size={16} />
                  </button>
                  {!brand.is_system && (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(brand.id)}
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

      {confirmDeleteId && (() => {
        const brand = presentationBrands.find((b) => b.id === confirmDeleteId);
        if (!brand) return null;
        const usage = usageCount[brand.id] ?? 0;
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
                {isAr ? 'حذف الهوية؟' : 'Delete brand?'}
              </h2>
              <p className="text-sm text-charcoal/60 mb-4">
                {isAr
                  ? `سيتم حذف "${brand.label_ar}" نهائياً.${usage > 0 ? ` ${usage} قالب يستخدم هذه الهوية حالياً، وسيُلغى ربطها بهم تلقائياً.` : ''}`
                  : `"${brand.label_en}" will be deleted permanently.${usage > 0 ? ` ${usage} template${usage === 1 ? '' : 's'} currently reference${usage === 1 ? 's' : ''} this brand and will have their brand link cleared.` : ''}`}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                  {isAr ? 'إلغاء' : 'Cancel'}
                </Button>
                <Button variant="danger" onClick={() => handleDelete(brand)}>
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
