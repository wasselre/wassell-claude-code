import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Save } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import DynamicField from './DynamicField';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord, ModelField } from '@/types';

interface BulkEditModalProps {
  open: boolean;
  onClose: () => void;
  model: AppModel;
  /** Records the user has selected in the list view. */
  selectedRecords: AppRecord[];
  /** Fires after records are saved. The caller decides toasts/selection reset. */
  onApplied: (updatedCount: number) => void;
}

// Field types that can't be bulk-edited because they're derived or auto-assigned.
// They can still appear in the model schema but we hide them from the bulk-edit form.
const NON_EDITABLE_FIELD_TYPES = new Set(['mirror', 'section_mirror', 'auto_id', 'formula']);

export default function BulkEditModal({
  open,
  onClose,
  model,
  selectedRecords,
  onApplied,
}: BulkEditModalProps) {
  const { t } = useTranslation();
  const { language, saveRecord, addToast } = useAppStore();
  const isAr = language === 'ar';

  // Which field slugs the user has enabled for bulk update.
  const [enabledFields, setEnabledFields] = useState<Set<string>>(new Set());
  // The new values to apply, keyed by field slug.
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [confirming, setConfirming] = useState(false);
  // Audit fix C2: blocks the Apply button while the loop is in flight,
  // so a frantic user can't fire two bulk writes that race against
  // each other in the retry queue.
  const [applying, setApplying] = useState(false);

  // Flat list of editable fields, grouped by their section, preserving order.
  // Hides non-editable types (mirror, auto_id, formula) and mirrored sections
  // (those edit linked records, not these ones — wrong mental model for bulk).
  const sections = useMemo(() => {
    const sorted = [...model.schema.sections].sort((a, b) => a.order - b.order);
    return sorted
      .filter((s) => !s.is_mirrored)
      .map((s) => ({
        section: s,
        fields: [...s.fields]
          .sort((a, b) => a.order - b.order)
          .filter((f) => !NON_EDITABLE_FIELD_TYPES.has(f.type)),
      }))
      .filter((g) => g.fields.length > 0);
  }, [model]);

  const reset = () => {
    setEnabledFields(new Set());
    setFormData({});
    setConfirming(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const toggleField = (field: ModelField) => {
    setEnabledFields((prev) => {
      const next = new Set(prev);
      if (next.has(field.name)) {
        next.delete(field.name);
        setFormData((d) => {
          const { [field.name]: _, ...rest } = d;
          return rest;
        });
      } else {
        next.add(field.name);
      }
      return next;
    });
  };

  const setFieldValue = (field: ModelField, value: unknown) => {
    // Auto-enable the field the moment the user touches it — otherwise the
    // checkbox + input combo feels fiddly. Clearing the checkbox still wipes it.
    setEnabledFields((prev) => {
      if (prev.has(field.name)) return prev;
      const next = new Set(prev);
      next.add(field.name);
      return next;
    });
    setFormData((d) => ({ ...d, [field.name]: value }));
  };

  const handleApply = async () => {
    if (enabledFields.size === 0 || applying) return;
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {};
    for (const name of enabledFields) patch[name] = formData[name];

    // Audit fix C2 — concurrency, atomicity, observability:
    // 1. Sequential awaits, not a parallel for-loop. Each save lands
    //    before the next starts, so ordering matches what the user
    //    would expect from a serial edit.
    // 2. Each save passes `expectedVersion: rec.version`. The version
    //    on `rec` is the version we LOADED with (RecordListPage's
    //    selection state); if a concurrent writer bumped it, the RPC
    //    raises version_mismatch and saveRecord resolves with
    //    { status: 'conflict' }. We collect those rather than silently
    //    overwriting.
    // 3. The end-of-run toast tells the user what actually happened
    //    (saved / queued / conflict). The previous code rolled all
    //    outcomes into a single "Edited N" with no per-row visibility.
    setApplying(true);
    let savedCount = 0;
    let queuedCount = 0;
    const conflicts: AppRecord[] = [];
    try {
      for (const rec of selectedRecords) {
        const result = await saveRecord(
          {
            ...rec,
            data: { ...rec.data, ...patch },
            updated_at: now,
          },
          { expectedVersion: rec.version ?? null },
        );
        if (result.status === 'conflict') {
          conflicts.push(rec);
        } else if (result.status === 'queued') {
          queuedCount += 1;
        } else {
          savedCount += 1;
        }
      }
    } finally {
      setApplying(false);
    }

    if (conflicts.length > 0) {
      addToast(
        isAr
          ? `تم تحديث ${savedCount + queuedCount} سجل، وتخطّي ${conflicts.length} لأنها عُدّلت من قبل مستخدم آخر. حدّث الصفحة لرؤية التغييرات.`
          : `Updated ${savedCount + queuedCount} records, skipped ${conflicts.length} that were just changed by another user. Reload to see their edits.`,
        'error',
      );
    } else if (queuedCount > 0) {
      addToast(
        isAr
          ? `تم تحديث ${savedCount} سجل، ${queuedCount} في انتظار المزامنة عند توفر الاتصال.`
          : `Updated ${savedCount} records, ${queuedCount} queued for sync.`,
        'info',
      );
    }

    onApplied(savedCount + queuedCount);
    reset();
    onClose();
  };

  const enabledCount = enabledFields.size;
  const recordCount = selectedRecords.length;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('records.bulk_edit_title')}
      maxWidth="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => setConfirming(true)}
            disabled={enabledCount === 0}
          >
            <Save size={14} />
            {t('records.bulk_edit_apply', { count: recordCount })}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-copper/8 border border-copper/30 px-4 py-3 text-sm text-charcoal">
          <p className="font-bold text-copper mb-1">
            {t('records.bulk_edit_description', { count: recordCount })}
          </p>
          <p className="text-charcoal/70 text-xs">
            {t('records.bulk_edit_hint')}
          </p>
        </div>

        {sections.map(({ section, fields }) => (
          <div
            key={section.id}
            className="rounded-xl border border-sand/50"
          >
            <div
              className="px-4 py-2 border-b border-sand/50 rounded-t-xl"
              style={{ backgroundColor: `${section.color ?? '#B8734F'}10` }}
            >
              <h3 className="text-sm font-bold text-charcoal">
                {isAr ? section.label_ar : section.label_en}
              </h3>
            </div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              {fields.map((field) => {
                const enabled = enabledFields.has(field.name);
                const fieldLabel = isAr ? field.label_ar : field.label_en;
                return (
                  <div
                    key={field.id}
                    className={`rounded-lg border p-3 transition-colors ${
                      enabled
                        ? 'border-copper/50 bg-copper/5'
                        : 'border-sand/40 bg-white'
                    } ${field.width === 'full' ? 'md:col-span-2' : ''}`}
                  >
                    <label className="flex items-start gap-2 cursor-pointer mb-2">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => toggleField(field)}
                        className="mt-0.5 w-4 h-4 accent-copper cursor-pointer"
                      />
                      <span className="text-sm font-bold text-charcoal">
                        {fieldLabel}
                      </span>
                    </label>
                    <div className={enabled ? '' : 'opacity-50 pointer-events-none'}>
                      <DynamicField
                        field={field}
                        value={formData[field.name]}
                        onChange={(v) => setFieldValue(field, v)}
                        recordData={formData}
                        compact
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {sections.length === 0 && (
          <div className="text-center text-sm text-charcoal/40 py-8">
            {t('records.bulk_edit_no_editable_fields')}
          </div>
        )}
      </div>

      {/* Confirmation: bulk writes are not undoable, so make the user confirm. */}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('records.bulk_edit_title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleApply} disabled={applying}>
              <Pencil size={14} />
              {t('records.bulk_edit_confirm_action')}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">
          {t('records.bulk_edit_confirm', {
            count: recordCount,
            fields: enabledCount,
          })}
        </p>
      </Modal>
    </Modal>
  );
}
