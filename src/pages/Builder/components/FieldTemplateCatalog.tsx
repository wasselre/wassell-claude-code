import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Bookmark, X, ChevronDown } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import type { FieldTemplate } from '@/types';

interface FieldTemplateCatalogProps {
  /** Click a template to insert a copy into the active section. */
  onSelectTemplate: (template: FieldTemplate) => void;
}

/**
 * Collapsible accordion listing user-saved field templates. Defaults to collapsed
 * — user clicks the header to expand. Each entry is click-to-insert; the hover X
 * deletes the template. Dropped copies are independent (handled by SectionManager).
 */
export default function FieldTemplateCatalog({ onSelectTemplate }: FieldTemplateCatalogProps) {
  const { fieldTemplates, deleteFieldTemplate, language, addToast } = useAppStore();
  const isAr = language === 'ar';
  const [pendingDelete, setPendingDelete] = useState<FieldTemplate | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-4 py-3 flex items-center gap-2 hover:bg-cream/40 transition-colors text-start"
      >
        <Bookmark size={11} className="text-copper/60 shrink-0" />
        <h3 className="flex-1 text-xs font-bold text-charcoal/50 uppercase tracking-wider">
          {isAr ? 'القوالب' : 'Templates'}
        </h3>
        {fieldTemplates.length > 0 && (
          <span className="text-[10px] font-bold text-charcoal/40 bg-cream/60 px-1.5 py-0.5 rounded-full">
            {fieldTemplates.length}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="border-t border-sand/20 p-2">
          {fieldTemplates.length === 0 ? (
            <p className="text-[10px] text-charcoal/30 px-2 py-3 leading-relaxed text-center">
              {isAr
                ? 'لم تحفظ أي قوالب بعد. افتح أي حقل واضغط "حفظ كقالب".'
                : 'No templates yet. Open any field and click "Save as template".'}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {fieldTemplates.map((tpl) => {
                const label = isAr ? tpl.label_ar : tpl.label_en;
                return (
                  <div
                    key={tpl.id}
                    className="group relative flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-copper/[0.06] transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectTemplate(tpl)}
                      className="flex-1 flex items-center gap-2 text-start"
                      title={isAr ? 'إضافة إلى القسم النشط' : 'Add to active section'}
                    >
                      <div className="w-6 h-6 rounded-md bg-copper/10 flex items-center justify-center shrink-0">
                        <Bookmark size={12} className="text-copper" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-charcoal/80 truncate">{label}</div>
                        <div className="text-[9px] text-charcoal/40 truncate">{tpl.field.type}</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(tpl)}
                      title={isAr ? 'حذف' : 'Delete'}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-charcoal/30 hover:text-red-500 transition-all"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <Modal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title={isAr ? 'حذف القالب' : 'Delete template'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) {
                  deleteFieldTemplate(pendingDelete.id);
                  addToast(isAr ? 'تم حذف القالب' : 'Template deleted', 'success');
                }
                setPendingDelete(null);
              }}
            >
              {isAr ? 'حذف' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-charcoal text-sm">
          {isAr
            ? `سيتم حذف القالب "${pendingDelete ? pendingDelete.label_ar : ''}". لن تتأثر الحقول التي أُضيفت من هذا القالب.`
            : `The template "${pendingDelete?.label_en ?? ''}" will be deleted. Fields already added from this template are not affected.`}
        </p>
      </Modal>
    </div>
  );
}
