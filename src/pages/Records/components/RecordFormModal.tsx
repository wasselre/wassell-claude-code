import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { Save, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import SectionBlock from './SectionBlock';
import { useAutoLink } from '../hooks/useAutoLink';
import { useAutoFill } from '../hooks/useAutoFill';
import { applyFollowupAutoStamp } from '../utils/followupAutoStamp';
import type { AppRecord } from '@/types';

interface RecordFormModalProps {
  /** Model to render. The modal looks it up from the store; passing the id keeps the API stable across model edits. */
  modelId: string;
  /** When non-null, the modal opens in edit mode against this record. Null means a brand-new record. */
  recordId: string | null;
  /** Initial values applied on top of an empty new record. Ignored when `recordId` is set (edit mode reads from the store). */
  prefill?: Record<string, unknown>;
  onClose: () => void;
  /** Called after a successful save with the saved record's id. The parent typically refreshes its data. */
  onSaved?: (recordId: string) => void;
}

/**
 * Reusable record-form rendered inside a dialog overlay. Wraps the same
 * `SectionBlock` + `DynamicField` rendering used by the full
 * `RecordFormPage`, but with a stripped-down save flow (no URL navigation,
 * no prev/next, no mirrored-section sync-back). Powers the
 * `create_record` / `find_or_create_record` custom-button actions.
 *
 * Auto-link and auto-fill primitives are mounted here too — typing a phone
 * in the visits modal finds the client and fills the name without the
 * user having to click Save first.
 */
export default function RecordFormModal({
  modelId,
  recordId,
  prefill,
  onClose,
  onSaved,
}: RecordFormModalProps) {
  const { t } = useTranslation();
  const { models, records, language, saveRecord, addToast } = useAppStore();
  const isAr = language === 'ar';

  const model = models.find((m) => m.id === modelId);
  const isNew = !recordId;
  const existingRecord = model && recordId
    ? (records[model.id] ?? []).find((r) => r.id === recordId) ?? null
    : null;

  // Initial form state: existing record's data merged with prefill (prefill
  // wins for new records, ignored for edits). Lazy initializer so we only
  // compute it once even though `models` / `records` may change.
  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    if (existingRecord) return existingRecord.data;
    return { ...(prefill ?? {}) };
  });
  const [saving, setSaving] = useState(false);

  // Run the auto-link + auto-fill effects against the same form state.
  // Both hooks no-op gracefully when the model is missing — must be called
  // unconditionally (rules of hooks) even though the modal renders null
  // when the model can't be found.
  useAutoLink({ model, formData, setFormData });
  useAutoFill({ model, formData, setFormData });

  const visibleSections = useMemo(() => {
    if (!model) return [];
    const sorted = [...model.schema.sections].sort((a, b) => a.order - b.order);
    const selectorFieldId = model.schema.section_selector_field_id;
    if (!selectorFieldId) return sorted;
    const selectorField = model.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.id === selectorFieldId);
    const selectorValue = selectorField
      ? (formData[selectorField.name] as string[] | undefined) ?? []
      : [];
    return sorted.filter((s) => s.is_base || s.is_mirrored || selectorValue.includes(s.id));
  }, [model, formData]);

  if (!model) return null;

  const title = isNew
    ? `${t('records.new_record')} — ${isAr ? model.label_ar : model.label_en}`
    : `${t('records.edit_record')} — ${isAr ? model.label_ar : model.label_en}`;

  const handleFieldChange = (fieldName: string, value: unknown) => {
    setFormData((prev) => {
      const next = { ...prev, [fieldName]: value };
      applyFollowupAutoStamp(model.name, fieldName, value, next);
      return next;
    });
  };

  const handleSave = async () => {
    // Validate required fields, same posture as RecordFormPage. Mirrored
    // sections (which the modal doesn't support yet) are skipped — visits
    // / followups don't use them.
    const allFields = model.schema.sections
      .filter((s) => !s.is_mirrored)
      .flatMap((s) => s.fields);
    const missing = allFields.filter((f) => {
      if (!f.required) return false;
      if (f.type === 'mirror') return false;
      const val = formData[f.name];
      if (f.type === 'lookup' && f.is_multi) {
        return !Array.isArray(val) || val.length === 0;
      }
      return val === undefined || val === null || val === '';
    });
    if (missing.length > 0) {
      const label = isAr ? missing[0]!.label_ar : missing[0]!.label_en;
      addToast(`${isAr ? 'الحقل مطلوب: ' : 'Required field: '}${label}`, 'error');
      return;
    }

    setSaving(true);
    try {
      const id = existingRecord?.id ?? uuid();
      const now = new Date().toISOString();
      const record: AppRecord = existingRecord
        ? { ...existingRecord, data: formData, updated_at: now }
        : {
            id,
            model_id: model.id,
            data: formData,
            created_at: now,
            updated_at: now,
          };
      const result = await saveRecord(record, {
        // Pass the loaded version so a concurrent edit on the same record
        // surfaces as a 'conflict' instead of silently overwriting.
        expectedVersion: existingRecord?.version ?? null,
      });
      if (result.status === 'conflict') {
        addToast(
          isAr
            ? 'تم تعديل هذا السجل في مكان آخر — أعد التحميل قبل الحفظ'
            : 'This record was edited elsewhere — reload before saving',
          'error',
        );
        return;
      }
      // 'queued' is also a non-fatal "saved locally, syncing later" path.
      // The store already toasted the underlying error if any; we close
      // the modal because the local cache reflects the change.
      onSaved?.(id);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(isAr ? `فشل الحفظ: ${msg}` : `Save failed: ${msg}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      maxWidth="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-6 max-h-[calc(100vh-12rem)] overflow-y-auto pe-2">
        {visibleSections.map((section) => (
          <SectionBlock
            key={section.id}
            section={section}
            formData={formData}
            onChange={handleFieldChange}
            currentModel={model}
            mirrorEdits={{}}
            onMirrorFieldChange={() => {
              /* noop — modal doesn't support mirrored-section sync-back in v1 */
            }}
          />
        ))}
      </div>
    </Modal>
  );
}
