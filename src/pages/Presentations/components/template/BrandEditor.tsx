import { Plus, Trash2, Sparkles, Palette } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type {
  PresentationBrand,
  PresentationBrandColor,
  PresentationBrandPhrase,
  PresentationBrandRequiredPhrase,
} from '@/types';

/**
 * Editor for `template.brand`. The cloud worker injects whatever's set here
 * into every step's prompt at runtime — so the agent always has the brand
 * spec without the author repeating it in each step's instructions.
 *
 * Sections:
 *   - **Palette** — structured (visual swatches matter for color identity)
 *   - **Typography** — font + free-form notes
 *   - **Design rules** — layout / structure / sequence (free-form textarea)
 *   - **Text rules** — RTL / digits / punctuation (free-form textarea)
 *   - **Vocabulary** — banned + required phrase lists
 *
 * Brand is OPTIONAL on a template. When the user clicks "Add brand", we
 * initialize an empty brand. When they click "Remove brand" (in the header),
 * we clear it back to null. Worker doesn't inject anything for null brands.
 */
interface BrandEditorProps {
  brand: PresentationBrand | null;
  onChange: (brand: PresentationBrand | null) => void;
  readonly?: boolean;
}

const EMPTY_BRAND: PresentationBrand = {
  colors: [],
  font_family: '',
  font_notes: '',
  design_rules: '',
  text_rules: '',
  forbidden_phrases: [],
  required_phrases: [],
};

export default function BrandEditor({
  brand,
  onChange,
  readonly,
}: BrandEditorProps): JSX.Element {
  const isAr = useAppStore((s) => s.language === 'ar');

  if (brand === null) {
    return (
      <div className="rounded-xl border border-dashed border-sand/60 bg-cream/20 p-6 text-center">
        <Palette size={28} className="mx-auto text-charcoal/30 mb-2" />
        <p className="text-sm text-charcoal/70 mb-1">
          {isAr ? 'لا توجد إعدادات هوية بعد' : 'No brand spec yet'}
        </p>
        <p className="text-xs text-charcoal/50 mb-4 max-w-md mx-auto">
          {isAr
            ? 'أضِف ألوان العلامة، الخطوط، وقواعد التصميم. سيقوم وكيل السحابة بحقن هذه الإرشادات في كل خطوة، فلا تحتاج لتكرارها في تعليمات الخطوات.'
            : 'Add brand colors, fonts, and design rules. The cloud agent will inject these into every step\'s prompt automatically, so you don\'t have to repeat them in each step\'s instructions.'}
        </p>
        {!readonly && (
          <Button variant="ghost" onClick={() => onChange(EMPTY_BRAND)}>
            <Plus size={14} />
            {isAr ? 'إضافة هوية' : 'Add brand'}
          </Button>
        )}
      </div>
    );
  }

  const patch = (changes: Partial<PresentationBrand>): void => {
    onChange({ ...brand, ...changes });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-charcoal/50">
          <Sparkles size={12} className="text-copper" />
          {isAr
            ? 'يحقن وكيل السحابة هذه الإرشادات في كل خطوة'
            : 'The cloud agent injects this into every step'}
        </div>
        {!readonly && (
          <button
            type="button"
            onClick={() => {
              if (confirm(isAr
                ? 'إزالة جميع إعدادات الهوية من هذا القالب؟'
                : 'Remove all brand settings from this template?')) {
                onChange(null);
              }
            }}
            className="text-xs text-red-600 hover:text-red-700"
          >
            {isAr ? 'إزالة الهوية' : 'Remove brand'}
          </button>
        )}
      </div>

      {/* Palette */}
      <Subsection title={isAr ? 'لوحة الألوان' : 'Color palette'}>
        <ColorPalette
          colors={brand.colors}
          isAr={isAr}
          readonly={readonly}
          onChange={(colors) => patch({ colors })}
        />
      </Subsection>

      {/* Typography */}
      <Subsection title={isAr ? 'الخطوط' : 'Typography'}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SubField label={isAr ? 'اسم الخط' : 'Font family'}>
            <input
              type="text"
              value={brand.font_family}
              onChange={(e) => patch({ font_family: e.target.value })}
              disabled={readonly}
              dir="ltr"
              placeholder="Amiri"
              className="form-input text-sm"
            />
          </SubField>
          <SubField
            label={isAr ? 'ملاحظات الخط' : 'Font notes'}
            hint={isAr
              ? 'مثال: مستخدم في كل العناصر، على جميع شِرَات OOXML (latin/ea/cs)'
              : 'e.g. Used on every text run; set on all OOXML slots (latin/ea/cs)'}
          >
            <textarea
              value={brand.font_notes}
              onChange={(e) => patch({ font_notes: e.target.value })}
              disabled={readonly}
              dir={isAr ? 'rtl' : 'ltr'}
              rows={2}
              className="form-input text-sm w-full"
            />
          </SubField>
        </div>
      </Subsection>

      {/* Design rules */}
      <Subsection
        title={isAr ? 'قواعد التصميم والتخطيط' : 'Design & layout rules'}
        hint={isAr
          ? 'نسبة الشريحة، عدد الشرائح، تسلسل الشرائح، الفواصل، التذييلات. Markdown مدعوم.'
          : 'Slide aspect, count, sequence, dividers, footers. Markdown supported.'}
      >
        <textarea
          value={brand.design_rules}
          onChange={(e) => patch({ design_rules: e.target.value })}
          disabled={readonly}
          dir={isAr ? 'rtl' : 'ltr'}
          rows={6}
          placeholder={isAr
            ? 'مثال:\nالنسبة: 16:9\nعدد الشرائح: 15 شريحة\nالشرائح ١، ٣، ٧، ١١ بخلفية بنية كاملة، بدون تذييل\nالشرائح الأخرى: تذييل بـ wassel.re على اليسار'
            : 'e.g.\nAspect: 16:9\nSlide count: 15\nSlides 1, 3, 7, 11 = full-brown divider, no footer\nOther slides: footer with wassel.re on the left'}
          className="form-input text-sm w-full font-mono"
        />
      </Subsection>

      {/* Text rules */}
      <Subsection
        title={isAr ? 'قواعد النصوص والمحتوى' : 'Text & content rules'}
        hint={isAr
          ? 'RTL، الأرقام، علامات الترقيم، الروابط، قواعد المحتوى (لا تختلق أرقاماً). Markdown مدعوم.'
          : 'RTL, digits, punctuation, hyperlinks, content rules ("don\'t invent numbers"). Markdown.'}
      >
        <textarea
          value={brand.text_rules}
          onChange={(e) => patch({ text_rules: e.target.value })}
          disabled={readonly}
          dir={isAr ? 'rtl' : 'ltr'}
          rows={6}
          placeholder={isAr
            ? 'مثال:\nأرقام عربية-هندية (٠-٩) بدلاً من اللاتينية\nفواصل عشرية ٫ بدلاً من النقطة بين الأرقام\nالروابط بلون النحاس بدون تسطير\nلا تختلق أرقاماً — إذا لم يكن المعطى متوفراً، استخدم ـ'
            : 'e.g.\nUse Arabic-Indic digits (٠-٩) instead of Latin\nUse ٫ as decimal separator between Arabic digits\nHyperlinks must be copper, no underline\nNever invent numbers — if data is missing, use — placeholder'}
          className="form-input text-sm w-full font-mono"
        />
      </Subsection>

      {/* Forbidden phrases */}
      <Subsection title={isAr ? 'كلمات وتعابير ممنوعة' : 'Forbidden phrases'}>
        <ForbiddenList
          phrases={brand.forbidden_phrases}
          isAr={isAr}
          readonly={readonly}
          onChange={(forbidden_phrases) => patch({ forbidden_phrases })}
        />
      </Subsection>

      {/* Required phrases */}
      <Subsection title={isAr ? 'تعابير مطلوبة بالضبط' : 'Required exact phrases'}>
        <RequiredList
          phrases={brand.required_phrases}
          isAr={isAr}
          readonly={readonly}
          onChange={(required_phrases) => patch({ required_phrases })}
        />
      </Subsection>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Subcomponents
// ────────────────────────────────────────────────────────────────────

function Subsection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <h3 className="text-xs font-bold text-charcoal/70 uppercase tracking-wide mb-1">
        {title}
      </h3>
      {hint && <p className="text-[11px] text-charcoal/45 mb-2">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function SubField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <label className="block text-[10px] font-bold text-charcoal/60 uppercase tracking-wide mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="text-[10px] text-charcoal/40 mt-0.5">{hint}</p>}
    </div>
  );
}

function ColorPalette({
  colors,
  isAr,
  readonly,
  onChange,
}: {
  colors: PresentationBrandColor[];
  isAr: boolean;
  readonly?: boolean;
  onChange: (colors: PresentationBrandColor[]) => void;
}): JSX.Element {
  const patch = (idx: number, p: Partial<PresentationBrandColor>): void => {
    onChange(colors.map((c, i) => (i === idx ? { ...c, ...p } : c)));
  };
  const remove = (idx: number): void => {
    onChange(colors.filter((_, i) => i !== idx));
  };
  const add = (): void => {
    onChange([
      ...colors,
      {
        id: uuid(),
        role_en: '',
        role_ar: '',
        hex: '#B8734F',
      },
    ]);
  };

  return (
    <div className="space-y-2">
      {colors.length === 0 && (
        <p className="text-xs text-charcoal/40 italic">
          {isAr
            ? 'لا توجد ألوان بعد. أضف لون العلامة الأساسي أولاً.'
            : 'No colors yet. Add your primary brand color first.'}
        </p>
      )}
      {colors.map((color, idx) => {
        const normalizedHex = color.hex.startsWith('#') ? color.hex : `#${color.hex}`;
        return (
          <div key={color.id} className="flex items-center gap-2">
            <div
              className="w-10 h-10 rounded-lg border border-sand/40 shrink-0"
              style={{ backgroundColor: normalizedHex }}
              title={normalizedHex}
            />
            <input
              type="text"
              value={color.hex}
              onChange={(e) => patch(idx, { hex: e.target.value })}
              disabled={readonly}
              dir="ltr"
              placeholder="#B8734F"
              className="form-input text-xs font-mono w-24 shrink-0"
            />
            <input
              type="text"
              value={color.role_ar}
              onChange={(e) => patch(idx, { role_ar: e.target.value })}
              disabled={readonly}
              dir="rtl"
              placeholder={isAr ? 'الدور (عربي)' : 'Role (Arabic)'}
              className="form-input text-xs flex-1 min-w-0"
            />
            <input
              type="text"
              value={color.role_en}
              onChange={(e) => patch(idx, { role_en: e.target.value })}
              disabled={readonly}
              dir="ltr"
              placeholder={isAr ? 'الدور (إنجليزي)' : 'Role (English)'}
              className="form-input text-xs flex-1 min-w-0"
            />
            <input
              type="text"
              value={color.notes ?? ''}
              onChange={(e) => patch(idx, { notes: e.target.value === '' ? undefined : e.target.value })}
              disabled={readonly}
              dir={isAr ? 'rtl' : 'ltr'}
              placeholder={isAr ? 'ملاحظات' : 'Notes'}
              className="form-input text-xs flex-1 min-w-0"
            />
            {!readonly && (
              <button
                type="button"
                onClick={() => remove(idx)}
                className="p-1.5 rounded hover:bg-red-50 text-charcoal/50 hover:text-red-600 shrink-0"
                title={isAr ? 'حذف' : 'Remove'}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        );
      })}
      {!readonly && (
        <Button variant="ghost" onClick={add}>
          <Plus size={14} />
          {isAr ? 'إضافة لون' : 'Add color'}
        </Button>
      )}
    </div>
  );
}

function ForbiddenList({
  phrases,
  isAr,
  readonly,
  onChange,
}: {
  phrases: PresentationBrandPhrase[];
  isAr: boolean;
  readonly?: boolean;
  onChange: (phrases: PresentationBrandPhrase[]) => void;
}): JSX.Element {
  const patch = (idx: number, p: Partial<PresentationBrandPhrase>): void => {
    onChange(phrases.map((ph, i) => (i === idx ? { ...ph, ...p } : ph)));
  };
  const remove = (idx: number): void => onChange(phrases.filter((_, i) => i !== idx));
  const add = (): void => onChange([...phrases, { id: uuid(), wrong: '', right: '', note: '' }]);

  return (
    <div className="space-y-2">
      {phrases.map((p, idx) => (
        <div key={p.id} className="grid grid-cols-12 gap-2 items-center">
          <input
            type="text"
            value={p.wrong}
            onChange={(e) => patch(idx, { wrong: e.target.value })}
            disabled={readonly}
            placeholder={isAr ? 'الكلمة الممنوعة' : 'Forbidden phrase'}
            className="form-input text-xs col-span-4"
          />
          <span className="text-charcoal/40 text-center col-span-1">→</span>
          <input
            type="text"
            value={p.right ?? ''}
            onChange={(e) => patch(idx, { right: e.target.value === '' ? undefined : e.target.value })}
            disabled={readonly}
            placeholder={isAr ? 'البديل (اختياري)' : 'Replace with (optional)'}
            className="form-input text-xs col-span-4"
          />
          <input
            type="text"
            value={p.note ?? ''}
            onChange={(e) => patch(idx, { note: e.target.value === '' ? undefined : e.target.value })}
            disabled={readonly}
            placeholder={isAr ? 'ملاحظة' : 'Note'}
            className="form-input text-xs col-span-2"
          />
          {!readonly && (
            <button
              type="button"
              onClick={() => remove(idx)}
              className="p-1.5 rounded hover:bg-red-50 text-charcoal/50 hover:text-red-600 col-span-1"
              title={isAr ? 'حذف' : 'Remove'}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
      {!readonly && (
        <Button variant="ghost" onClick={add}>
          <Plus size={14} />
          {isAr ? 'إضافة كلمة ممنوعة' : 'Add forbidden phrase'}
        </Button>
      )}
    </div>
  );
}

function RequiredList({
  phrases,
  isAr,
  readonly,
  onChange,
}: {
  phrases: PresentationBrandRequiredPhrase[];
  isAr: boolean;
  readonly?: boolean;
  onChange: (phrases: PresentationBrandRequiredPhrase[]) => void;
}): JSX.Element {
  const patch = (idx: number, p: Partial<PresentationBrandRequiredPhrase>): void => {
    onChange(phrases.map((ph, i) => (i === idx ? { ...ph, ...p } : ph)));
  };
  const remove = (idx: number): void => onChange(phrases.filter((_, i) => i !== idx));
  const add = (): void => onChange([...phrases, { id: uuid(), context: '', phrase: '', note: '' }]);

  return (
    <div className="space-y-2">
      {phrases.map((p, idx) => (
        <div key={p.id} className="grid grid-cols-12 gap-2 items-center">
          <input
            type="text"
            value={p.context}
            onChange={(e) => patch(idx, { context: e.target.value })}
            disabled={readonly}
            placeholder={isAr ? 'السياق (مثل: عنوان شريحة 4)' : 'Context (e.g. Slide 4 subtitle)'}
            className="form-input text-xs col-span-4"
          />
          <input
            type="text"
            value={p.phrase}
            onChange={(e) => patch(idx, { phrase: e.target.value })}
            disabled={readonly}
            placeholder={isAr ? 'النص الحرفي' : 'Exact text'}
            className="form-input text-xs col-span-5"
          />
          <input
            type="text"
            value={p.note ?? ''}
            onChange={(e) => patch(idx, { note: e.target.value === '' ? undefined : e.target.value })}
            disabled={readonly}
            placeholder={isAr ? 'ملاحظة' : 'Note'}
            className="form-input text-xs col-span-2"
          />
          {!readonly && (
            <button
              type="button"
              onClick={() => remove(idx)}
              className="p-1.5 rounded hover:bg-red-50 text-charcoal/50 hover:text-red-600 col-span-1"
              title={isAr ? 'حذف' : 'Remove'}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
      {!readonly && (
        <Button variant="ghost" onClick={add}>
          <Plus size={14} />
          {isAr ? 'إضافة تعبير مطلوب' : 'Add required phrase'}
        </Button>
      )}
    </div>
  );
}
