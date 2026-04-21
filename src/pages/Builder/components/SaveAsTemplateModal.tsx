import { useEffect, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import type { ModelField, FieldTemplate } from '@/types';

interface SaveAsTemplateModalProps {
  open: boolean;
  onClose: () => void;
  field: ModelField;
  /** Default template name (e.g. the field's label in the current language). */
  defaultLabelAr: string;
  defaultLabelEn: string;
}

export default function SaveAsTemplateModal({
  open,
  onClose,
  field,
  defaultLabelAr,
  defaultLabelEn,
}: SaveAsTemplateModalProps) {
  const { language, saveFieldTemplate, addToast } = useAppStore();
  const isAr = language === 'ar';
  const [labelAr, setLabelAr] = useState(defaultLabelAr);
  const [labelEn, setLabelEn] = useState(defaultLabelEn);

  useEffect(() => {
    if (!open) return;
    setLabelAr(defaultLabelAr);
    setLabelEn(defaultLabelEn);
  }, [open, defaultLabelAr, defaultLabelEn]);

  const canSubmit = labelAr.trim().length > 0 || labelEn.trim().length > 0;

  const handleSave = () => {
    // Strip id / section_id / order — these are regenerated when the template is
    // instantiated into a section.
    const { id: _id, section_id: _sid, order: _order, ...snapshot } = field;
    const now = new Date().toISOString();
    const template: FieldTemplate = {
      id: uuid(),
      label_ar: labelAr.trim() || labelEn.trim(),
      label_en: labelEn.trim() || labelAr.trim(),
      field: snapshot,
      created_at: now,
      updated_at: now,
    };
    saveFieldTemplate(template);
    addToast(isAr ? 'تم حفظ القالب' : 'Template saved', 'success');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isAr ? 'حفظ الحقل كقالب' : 'Save field as template'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button onClick={handleSave} disabled={!canSubmit}>
            {isAr ? 'حفظ القالب' : 'Save template'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[12px] text-charcoal/60 leading-relaxed">
          {isAr
            ? 'يُحفظ نوع الحقل وإعداداته وخياراته كقالب قابل لإعادة الاستخدام. نسخ القالب مستقلة — تعديل القالب أو الحقل الأصلي لا يؤثر على النسخ الموجودة.'
            : 'The field type, settings, and options are saved as a reusable template. Inserted copies are independent — editing the template or the original field does not affect existing copies.'}
        </p>
        <div>
          <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
            {isAr ? 'اسم القالب (عربي)' : 'Template name (Arabic)'}
          </label>
          <input
            type="text"
            value={labelAr}
            onChange={(e) => setLabelAr(e.target.value)}
            className="form-input text-sm"
            dir="rtl"
            placeholder="مثال: الأحياء"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
            {isAr ? 'اسم القالب (إنجليزي)' : 'Template name (English)'}
          </label>
          <input
            type="text"
            value={labelEn}
            onChange={(e) => setLabelEn(e.target.value)}
            className="form-input text-sm"
            dir="ltr"
            placeholder="e.g. Districts"
          />
        </div>
      </div>
    </Modal>
  );
}
