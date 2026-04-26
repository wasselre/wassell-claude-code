import { useNavigate } from 'react-router-dom';
import { Palette, Edit, ExternalLink, Lock, Plus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';

/**
 * Selector for `template.brand_id` in the Template Editor. Templates
 * reference a brand row by id; editing the brand updates every template
 * using it. The actual brand body (palette, typography, rules) is edited
 * at /presentations/brands/:id, NOT here.
 *
 * UX:
 *  - Dropdown lists every brand in the workspace
 *  - When a brand is selected, render a compact preview (color swatches,
 *    font name, system badge if applicable) + an "Edit brand" link that
 *    opens the brand's edit page in the same tab
 *  - "None" option clears brand_id (no design-rule injection at runtime)
 *  - "Manage brands" link to the brands list for full CRUD
 */
interface BrandSelectorProps {
  brandId: string | null;
  onChange: (brandId: string | null) => void;
  readonly?: boolean;
}

export default function BrandSelector({
  brandId,
  onChange,
  readonly,
}: BrandSelectorProps): JSX.Element {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const brands = useAppStore((s) => s.presentationBrands);

  const selected = brandId ? brands.find((b) => b.id === brandId) ?? null : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={brandId ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          disabled={readonly}
          className="form-input flex-1"
        >
          <option value="">{isAr ? '— بدون هوية —' : '— No brand —'}</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {(isAr ? b.label_ar : b.label_en)}{b.is_system ? (isAr ? ' (نظام)' : ' (system)') : ''} — {b.slug}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={() => navigate('/presentations/brands')}>
          <Palette size={14} />
          {isAr ? 'إدارة الهويات' : 'Manage brands'}
        </Button>
      </div>

      {selected ? (
        <BrandPreview brandId={selected.id} isAr={isAr} onEdit={() => navigate(`/presentations/brands/${selected.id}`)} />
      ) : (
        <div className="rounded-xl border border-dashed border-sand/60 bg-cream/20 p-4 text-center">
          <Palette size={20} className="mx-auto text-charcoal/30 mb-1" />
          <p className="text-xs text-charcoal/50">
            {isAr
              ? 'اختر هوية لتحديد الألوان والخطوط وقواعد التصميم. يمكنك إنشاء هوية جديدة من صفحة الإدارة.'
              : 'Pick a brand to set colors, typography, and design rules. Create a new one from the manage page.'}
          </p>
          {!readonly && (
            <button
              type="button"
              onClick={() => navigate('/presentations/brands')}
              className="mt-2 inline-flex items-center gap-1 text-xs text-copper hover:text-terracotta"
            >
              <Plus size={12} />
              {isAr ? 'إنشاء هوية جديدة' : 'Create a new brand'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact preview of a selected brand — swatches + font + counts. */
function BrandPreview({
  brandId,
  isAr,
  onEdit,
}: {
  brandId: string;
  isAr: boolean;
  onEdit: () => void;
}): JSX.Element | null {
  const brand = useAppStore((s) => s.presentationBrands.find((b) => b.id === brandId));
  if (!brand) return null;
  const description = isAr ? brand.description_ar : brand.description_en;

  return (
    <div className="rounded-xl border border-sand/40 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Color swatches grid */}
          <div className="shrink-0 rounded-lg overflow-hidden border border-sand/40 w-12 h-12 grid grid-cols-2">
            {brand.colors.length === 0 ? (
              <div className="col-span-2 row-span-2 bg-sand/20 flex items-center justify-center">
                <Palette size={16} className="text-charcoal/30" />
              </div>
            ) : (
              brand.colors.slice(0, 4).map((c) => {
                const hex = c.hex.startsWith('#') ? c.hex : `#${c.hex}`;
                return <div key={c.id} style={{ backgroundColor: hex }} title={`${hex} ${c.role_en}`} />;
              })
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="font-bold text-sm text-charcoal">
                {isAr ? brand.label_ar : brand.label_en}
              </h4>
              {brand.is_system && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-charcoal/10 text-charcoal/60">
                  <Lock size={9} />
                  {isAr ? 'نظام' : 'system'}
                </span>
              )}
            </div>
            {description && (
              <p className="text-xs text-charcoal/50 mt-0.5 line-clamp-2">{description}</p>
            )}
            <div className="text-[10px] text-charcoal/40 mt-1">
              <span>{brand.colors.length} {isAr ? 'لون' : 'colors'}</span>
              {brand.font_family && (
                <>
                  <span className="mx-1.5">·</span>
                  <span className="font-mono">{brand.font_family}</span>
                </>
              )}
              {brand.forbidden_phrases.length > 0 && (
                <>
                  <span className="mx-1.5">·</span>
                  <span>
                    {brand.forbidden_phrases.length} {isAr ? 'كلمة ممنوعة' : 'forbidden'}
                  </span>
                </>
              )}
              {brand.required_phrases.length > 0 && (
                <>
                  <span className="mx-1.5">·</span>
                  <span>
                    {brand.required_phrases.length} {isAr ? 'تعبير مطلوب' : 'required'}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 inline-flex items-center gap-1 text-xs text-copper hover:text-terracotta"
        >
          <Edit size={12} />
          {isAr ? 'تعديل' : 'Edit'}
          <ExternalLink size={10} />
        </button>
      </div>
    </div>
  );
}
