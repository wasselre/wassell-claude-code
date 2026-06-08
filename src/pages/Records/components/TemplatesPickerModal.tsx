import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, Search, ImageOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';

interface TemplatesPickerModalProps {
  /** Currently selected template IDs (controlled). */
  selectedIds: string[];
  /** Fires with the new selection on Save. Cancel discards. */
  onSave: (ids: string[]) => void;
  onClose: () => void;
}

interface TemplateCard {
  id: string;
  name: string;
  referenceImage: string;
  variableCount: number;
}

/**
 * Card-grid modal for picking design templates. Multi-select:
 * tapping a card toggles its checkmark. The "Save" button commits
 * the selection to the field; "Cancel" discards.
 *
 * Triggered by the `templates_picker` field type in DynamicField.
 * Reads the design_templates records straight from the appStore
 * (same source the form uses for everything else).
 */
export default function TemplatesPickerModal({
  selectedIds,
  onSave,
  onClose,
}: TemplatesPickerModalProps) {
  const { t: _t } = useTranslation();
  const { language, models, records } = useAppStore();
  const isAr = language === 'ar';

  // Local working copy — the user's edits don't propagate until they hit Save.
  const [working, setWorking] = useState<Set<string>>(() => new Set(selectedIds));
  const [query, setQuery] = useState('');

  useEffect(() => {
    setWorking(new Set(selectedIds));
  }, [selectedIds]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const cards: TemplateCard[] = useMemo(() => {
    const dt = models.find((m) => m.name === 'design_templates');
    if (!dt) return [];
    const list = records[dt.id] ?? [];
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
        };
      })
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [models, records, query, isAr]);

  const toggle = (id: string) => {
    setWorking((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] bg-charcoal/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-cream rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-sand/40 gap-3">
          <h2 className="text-lg font-bold text-charcoal whitespace-nowrap">
            {isAr ? 'اختر القوالب' : 'Pick templates'}
          </h2>
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/40" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isAr ? 'بحث...' : 'Search...'}
              className="form-input ps-9 w-full"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-sand/30 text-charcoal/50 hover:text-charcoal transition-colors"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {cards.length === 0 ? (
            <div className="text-center text-charcoal/50 italic py-12">
              {query
                ? (isAr ? 'لا توجد قوالب تطابق البحث' : 'No templates match your search')
                : (isAr ? 'لا توجد قوالب — أنشئ قالباً أولاً في "مكتبة القوالب"' : 'No templates yet — create one in Templates Library first')}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {cards.map((c) => {
                const isSelected = working.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggle(c.id)}
                    className={`group relative text-start rounded-xl overflow-hidden border-2 transition-all ${
                      isSelected
                        ? 'border-copper shadow-lg shadow-copper/20'
                        : 'border-sand/40 hover:border-copper/40 hover:shadow-md'
                    }`}
                  >
                    {/* Checkmark */}
                    <div
                      className={`absolute top-2 end-2 z-10 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                        isSelected
                          ? 'bg-copper text-cream'
                          : 'bg-cream/80 border border-sand/60 text-transparent group-hover:text-charcoal/40'
                      }`}
                    >
                      <Check size={14} strokeWidth={3} />
                    </div>
                    {/* Reference image */}
                    <div className="aspect-square bg-sand/20 flex items-center justify-center overflow-hidden">
                      {c.referenceImage ? (
                        <img
                          src={c.referenceImage}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <ImageOff size={32} className="text-charcoal/20" />
                      )}
                    </div>
                    {/* Title + variable count */}
                    <div className="p-3 bg-white">
                      <div className="font-bold text-sm text-charcoal truncate">{c.name}</div>
                      <div className="text-xs text-charcoal/50 mt-0.5">
                        {c.variableCount === 0
                          ? (isAr ? 'بدون متغيرات' : 'No variables')
                          : isAr
                            ? `${c.variableCount} متغير`
                            : `${c.variableCount} variable${c.variableCount === 1 ? '' : 's'}`}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 border-t border-sand/40 bg-cream/40">
          <div className="text-sm text-charcoal/60">
            {working.size === 0
              ? (isAr ? 'لم تختر أي قالب' : 'No templates selected')
              : isAr
                ? `${working.size} قالب مختار`
                : `${working.size} selected`}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" type="button" onClick={onClose}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button
              type="button"
              onClick={() => {
                onSave(Array.from(working));
                onClose();
              }}
            >
              {isAr ? 'حفظ' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
