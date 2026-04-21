import { useMemo, useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import type { AppModel, ModelSection } from '@/types';

interface SectionMirrorConfigProps {
  open: boolean;
  onClose: () => void;
  model: AppModel;
  section: ModelSection;
  onSave: (updates: Partial<ModelSection>) => void;
}

/**
 * Configure a section as "mirrored from another model". When enabled, the section
 * renders (and persists edits to) a linked record's matching section at runtime.
 *
 * Constraints:
 * - The section must be empty (no local fields) to enable mirroring — otherwise
 *   we'd silently hide fields.
 * - Sibling lookup must be single-select (multi-select can't identify one source
 *   record cleanly for whole-section mirroring).
 */
export default function SectionMirrorConfig({ open, onClose, model, section, onSave }: SectionMirrorConfigProps) {
  const { models, language } = useAppStore();
  const isAr = language === 'ar';

  const [enabled, setEnabled] = useState<boolean>(!!section.is_mirrored);
  const [siblingFieldId, setSiblingFieldId] = useState<string | null>(
    section.mirror_via_lookup_field_id ?? null,
  );
  const [sourceSectionId, setSourceSectionId] = useState<string | null>(
    section.mirror_source_section_id ?? null,
  );

  useEffect(() => {
    if (!open) return;
    setEnabled(!!section.is_mirrored);
    setSiblingFieldId(section.mirror_via_lookup_field_id ?? null);
    setSourceSectionId(section.mirror_source_section_id ?? null);
  }, [open, section.is_mirrored, section.mirror_via_lookup_field_id, section.mirror_source_section_id]);

  const hasLocalFields = section.fields.length > 0 && !section.is_mirrored;

  // Single-select lookup fields on this model are the only valid siblings.
  const siblingOptions = useMemo(() => {
    return model.schema.sections
      .flatMap((s) => s.fields)
      .filter((f) => f.type === 'lookup' && !f.is_multi && !!f.lookup_model_id);
  }, [model]);

  const selectedSibling = siblingOptions.find((f) => f.id === siblingFieldId) ?? null;
  const targetModel = selectedSibling?.lookup_model_id
    ? models.find((m) => m.id === selectedSibling.lookup_model_id)
    : null;

  // Target sections are all sections on the target model (user can pick any).
  const targetSections = targetModel?.schema.sections ?? [];

  const canSubmit = !enabled || (!!siblingFieldId && !!sourceSectionId);

  const handleSubmit = () => {
    if (!enabled) {
      onSave({
        is_mirrored: false,
        mirror_via_lookup_field_id: null,
        mirror_source_section_id: null,
      });
    } else {
      onSave({
        is_mirrored: true,
        mirror_via_lookup_field_id: siblingFieldId,
        mirror_source_section_id: sourceSectionId,
        fields: [],
      });
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isAr ? 'نسخ قسم من نموذج آخر' : 'Mirror a section from another model'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isAr ? 'حفظ' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label
          className={`flex items-start gap-2.5 py-1 ${hasLocalFields ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          title={
            hasLocalFields
              ? isAr
                ? 'احذف الحقول المحلية أولاً لتمكين النسخ.'
                : 'Remove local fields first to enable mirroring.'
              : undefined
          }
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={hasLocalFields}
            className="mt-0.5 w-4 h-4 rounded border-sand/50 text-copper focus:ring-copper/20"
          />
          <div>
            <span className="text-[13px] font-bold text-charcoal">
              {isAr ? 'هذا القسم منسوخ من نموذج آخر' : 'This section is mirrored from another model'}
            </span>
            <p className="text-[11px] text-charcoal/50 mt-1 leading-relaxed">
              {isAr
                ? 'تعرض الحقول من السجل المرتبط، وأي تعديل يُحفظ على ذلك السجل.'
                : 'Shows fields from the linked record. Edits save back to that record.'}
            </p>
          </div>
        </label>

        {enabled && (
          <>
            <div>
              <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                {isAr ? 'حقل الربط في هذا النموذج' : 'Sibling lookup field on this model'}
              </label>
              <select
                value={siblingFieldId ?? ''}
                onChange={(e) => {
                  setSiblingFieldId(e.target.value || null);
                  setSourceSectionId(null);
                }}
                className="form-input text-sm"
              >
                <option value="">—</option>
                {siblingOptions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {isAr ? f.label_ar : f.label_en}
                  </option>
                ))}
              </select>
              {siblingOptions.length === 0 && (
                <p className="text-[11px] text-amber-500 mt-1.5">
                  {isAr
                    ? 'لا يوجد حقل ربط مناسب. أضف حقل "بحث" أحادي الاختيار في هذا النموذج أولاً.'
                    : 'No suitable lookup. Add a single-select lookup field on this model first.'}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                {isAr ? 'القسم المصدر في النموذج المرتبط' : 'Source section on the linked model'}
              </label>
              <select
                value={sourceSectionId ?? ''}
                onChange={(e) => setSourceSectionId(e.target.value || null)}
                disabled={!targetModel}
                className="form-input text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">
                  {targetModel ? '—' : isAr ? 'اختر حقل الربط أولاً' : 'Pick a sibling lookup first'}
                </option>
                {targetSections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {isAr ? s.label_ar : s.label_en}
                  </option>
                ))}
              </select>
              {targetModel && targetSections.length === 0 && (
                <p className="text-[11px] text-amber-500 mt-1.5">
                  {isAr ? 'النموذج المرتبط لا يحتوي على أقسام.' : 'The linked model has no sections.'}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
