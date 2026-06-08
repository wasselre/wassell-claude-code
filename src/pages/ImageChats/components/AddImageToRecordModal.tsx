import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/stores/appStore';
import { ArrowLeft, X, Search, ChevronRight, Loader2, Image as ImageIcon } from 'lucide-react';
import type { AppModel, AppRecord, AttachmentRef, FieldType, ModelField } from '@/types';
import {
  buildRecordSearchText,
  normalizeForSearch,
  type RecordSearchContext,
} from '@/lib/recordSearch';
import { resolveRecordTitle } from '@/lib/recordTitle';
import { modelsWithImageTargets, compatibleTargetFields } from '@/lib/assets/recordTargets';
import { promoteChatImage } from '@/lib/assets/promote';
import type { MessageImage } from '@/lib/imageChat/client';

interface Props {
  image: MessageImage;
  imageIndex: number;
  messageId: string;
  /** The image_chats conversation record id (for the dedup cache). */
  chatRecordId: string;
  onClose: () => void;
}

type Step = 'model' | 'record' | 'field' | 'collide';
type CollisionAction = 'set' | 'replace' | 'add' | 'replace_all';

const SINGLE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['image', 'file']);
const MULTI_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['multi_image', 'multi_file']);

function fieldTypeLabel(type: FieldType, isAr: boolean): string {
  switch (type) {
    case 'image':
      return isAr ? 'صورة' : 'Image';
    case 'multi_image':
      return isAr ? 'صور متعددة' : 'Gallery';
    case 'file':
      return isAr ? 'ملف' : 'File';
    case 'multi_file':
      return isAr ? 'ملفات متعددة' : 'Files';
    case 'attachment':
      return isAr ? 'مرفقات' : 'Attachments';
    default:
      return type;
  }
}

/** Compute the new stored value for the field after applying the image. */
function computeNewValue(
  type: FieldType,
  cur: unknown,
  fid: string,
  action: CollisionAction,
): unknown {
  if (SINGLE_TYPES.has(type)) {
    return fid; // 'set' or 'replace' both write the single id
  }
  if (MULTI_TYPES.has(type)) {
    const arr = Array.isArray(cur) ? cur.filter((x): x is string => typeof x === 'string') : [];
    if (action === 'replace_all') return [fid];
    return arr.includes(fid) ? arr : [...arr, fid]; // add, deduped
  }
  // attachment
  const arr = Array.isArray(cur)
    ? (cur as AttachmentRef[]).filter(
        (r) => !!r && typeof r === 'object' && 'type' in r && 'id' in r,
      )
    : [];
  const exists = arr.some((r) => r.type === 'file' && r.id === fid);
  return exists ? arr : [...arr, { type: 'file', id: fid } as AttachmentRef];
}

/**
 * "Add to Record" — a 4-step picker that attaches a generated chat image to any
 * record's image/file/attachment field:
 *   1. Model (only models that have an image/file/attachment field)
 *   2. Record (search reuses the Table-View record search utilities)
 *   3. Target field (local image/file/attachment fields)
 *   4. Collision handling, then promote → set field → saveRecord.
 */
export default function AddImageToRecordModal({
  image,
  imageIndex,
  messageId,
  chatRecordId,
  onClose,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);

  const [step, setStep] = useState<Step>('model');
  const [model, setModel] = useState<AppModel | null>(null);
  const [record, setRecord] = useState<AppRecord | null>(null);
  const [field, setField] = useState<ModelField | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [recordQuery, setRecordQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const ctx: RecordSearchContext = useMemo(() => ({ models, records }), [models, records]);

  const eligibleModels = useMemo(() => {
    const list = modelsWithImageTargets(models);
    const q = normalizeForSearch(modelQuery.trim());
    if (!q) return list;
    return list.filter((m) =>
      normalizeForSearch(`${m.label_ar} ${m.label_en} ${m.name}`).includes(q),
    );
  }, [models, modelQuery]);

  const modelRecords = model ? records[model.id] ?? [] : [];

  // Build a searchable index once per model/records change (not per keystroke).
  const searchIndex = useMemo(() => {
    const idx = new Map<string, string>();
    if (!model) return idx;
    for (const r of modelRecords) {
      idx.set(r.id, normalizeForSearch(buildRecordSearchText(r, model, ctx)));
    }
    return idx;
  }, [model, modelRecords, ctx]);

  const filteredRecords = useMemo(() => {
    if (!model) return [];
    const q = normalizeForSearch(recordQuery.trim());
    const base = q ? modelRecords.filter((r) => (searchIndex.get(r.id) ?? '').includes(q)) : modelRecords;
    return base.slice(0, 60);
  }, [model, modelRecords, searchIndex, recordQuery]);

  const targetFields = useMemo(() => {
    if (!model) return [];
    return compatibleTargetFields(model, models).map((ef) => ef.field);
  }, [model, models]);

  const currentValue = record && field ? record.data[field.name] : undefined;

  async function applyToField(action: CollisionAction) {
    if (!model || !record || !field) return;
    setBusy(true);
    try {
      let fid = image.file_id ?? null;
      if (!fid) {
        const fileRow = await promoteChatImage({
          sourceUrl: image.url,
          modelId: model.id,
          recordId: record.id,
          chatRecordId,
          messageId,
          imageIndex,
        });
        fid = fileRow.id;
      }
      const newValue = computeNewValue(field.type, record.data[field.name], fid, action);
      const updated: AppRecord = {
        ...record,
        data: { ...record.data, [field.name]: newValue },
        updated_at: new Date().toISOString(),
      };
      const res = await saveRecord(updated, { expectedVersion: record.version });
      if (res.status === 'saved') {
        addToast(isAr ? 'تمت الإضافة إلى السجل' : 'Added to record', 'success');
        onClose();
      } else if (res.status === 'queued') {
        addToast(isAr ? 'تم الحفظ محلياً وسيُزامن لاحقاً' : 'Saved offline — will sync', 'info');
        onClose();
      } else {
        addToast(
          isAr
            ? 'تم تعديل السجل في مكان آخر — أعد التحميل ثم حاول مجدداً'
            : 'Record was changed elsewhere — reload and try again',
          'error',
        );
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const stepTitle =
    step === 'model'
      ? isAr ? 'اختر النموذج' : 'Choose a model'
      : step === 'record'
        ? isAr ? 'اختر السجل' : 'Choose a record'
        : step === 'field'
          ? isAr ? 'اختر الحقل' : 'Choose a field'
          : isAr ? 'تأكيد الإضافة' : 'Confirm';

  function goBack() {
    if (step === 'record') setStep('model');
    else if (step === 'field') setStep('record');
    else if (step === 'collide') setStep('field');
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
      dir={isAr ? 'rtl' : 'ltr'}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 p-3 border-b border-sand/20">
          {step !== 'model' && (
            <button
              onClick={goBack}
              className="p-1.5 rounded-lg hover:bg-cream text-charcoal/70"
              aria-label={isAr ? 'رجوع' : 'Back'}
            >
              <ArrowLeft size={16} className={isAr ? 'rotate-180' : ''} />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-charcoal">{stepTitle}</div>
            {(model || record || field) && (
              <div className="text-[11px] text-charcoal/50 truncate">
                {[
                  model ? (isAr ? model.label_ar : model.label_en) : null,
                  record ? resolveRecordTitle(model!, record, records, models) ?? '—' : null,
                  field ? (isAr ? field.label_ar : field.label_en) : null,
                ]
                  .filter(Boolean)
                  .join(' › ')}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-cream text-charcoal/70"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3">
          {step === 'model' && (
            <>
              <SearchBox value={modelQuery} onChange={setModelQuery} isAr={isAr} />
              {eligibleModels.length === 0 ? (
                <Empty text={isAr ? 'لا توجد نماذج تقبل الصور.' : 'No models accept images.'} />
              ) : (
                <ul className="mt-2 space-y-1">
                  {eligibleModels.map((m) => (
                    <li key={m.id}>
                      <button
                        onClick={() => {
                          setModel(m);
                          setRecord(null);
                          setField(null);
                          setRecordQuery('');
                          setStep('record');
                        }}
                        className="w-full flex items-center gap-2 text-start px-3 py-2 rounded-lg hover:bg-cream transition-colors"
                      >
                        <span className="flex-1 text-sm">{isAr ? m.label_ar : m.label_en}</span>
                        <ChevronRight size={14} className={`text-charcoal/40 ${isAr ? 'rotate-180' : ''}`} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {step === 'record' && model && (
            <>
              <SearchBox
                value={recordQuery}
                onChange={setRecordQuery}
                isAr={isAr}
                placeholder={isAr ? 'ابحث في كل الحقول…' : 'Search all fields…'}
              />
              {filteredRecords.length === 0 ? (
                <Empty text={isAr ? 'لا توجد سجلات مطابقة.' : 'No matching records.'} />
              ) : (
                <ul className="mt-2 space-y-1">
                  {filteredRecords.map((r) => {
                    const title = resolveRecordTitle(model, r, records, models);
                    return (
                      <li key={r.id}>
                        <button
                          onClick={() => {
                            setRecord(r);
                            setField(null);
                            setStep('field');
                          }}
                          className="w-full flex items-center gap-2 text-start px-3 py-2 rounded-lg hover:bg-cream transition-colors"
                        >
                          <span className="flex-1 text-sm truncate">
                            {title ?? (isAr ? '(بدون عنوان)' : '(untitled)')}
                          </span>
                          <ChevronRight size={14} className={`text-charcoal/40 ${isAr ? 'rotate-180' : ''}`} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {step === 'field' && model && (
            <>
              {targetFields.length === 0 ? (
                <Empty
                  text={isAr ? 'لا توجد حقول صور في هذا النموذج.' : 'No image fields on this model.'}
                />
              ) : (
                <ul className="space-y-1">
                  {targetFields.map((f) => (
                    <li key={f.id}>
                      <button
                        onClick={() => {
                          setField(f);
                          setStep('collide');
                        }}
                        className="w-full flex items-center gap-2 text-start px-3 py-2 rounded-lg hover:bg-cream transition-colors"
                      >
                        <ImageIcon size={14} className="text-copper shrink-0" />
                        <span className="flex-1 text-sm">{isAr ? f.label_ar : f.label_en}</span>
                        <span className="text-[10px] text-charcoal/50 bg-cream rounded px-1.5 py-0.5">
                          {fieldTypeLabel(f.type, isAr)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {step === 'collide' && field && (
            <CollisionStep
              isAr={isAr}
              type={field.type}
              currentValue={currentValue}
              busy={busy}
              onApply={applyToField}
              onCancel={onClose}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SearchBox({
  value,
  onChange,
  isAr,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  isAr: boolean;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-2.5 text-charcoal/40" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? (isAr ? 'بحث…' : 'Search…')}
        className="w-full ps-8 pe-3 py-2 rounded-lg border border-sand/40 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none text-sm bg-white"
        autoFocus
      />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-center text-sm text-charcoal/50 py-8">{text}</div>;
}

function CollisionStep({
  isAr,
  type,
  currentValue,
  busy,
  onApply,
  onCancel,
}: {
  isAr: boolean;
  type: FieldType;
  currentValue: unknown;
  busy: boolean;
  onApply: (action: CollisionAction) => void;
  onCancel: () => void;
}) {
  const isSingle = SINGLE_TYPES.has(type);
  const isMulti = MULTI_TYPES.has(type);
  const singleHasValue = isSingle && typeof currentValue === 'string' && currentValue.length > 0;
  const existingCount = Array.isArray(currentValue) ? currentValue.length : 0;

  const Btn = ({
    action,
    label,
    primary,
  }: {
    action: CollisionAction;
    label: string;
    primary?: boolean;
  }) => (
    <button
      onClick={() => onApply(action)}
      disabled={busy}
      className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
        primary
          ? 'bg-copper text-white hover:bg-terracotta'
          : 'border border-sand/40 bg-white text-charcoal/80 hover:bg-cream'
      }`}
    >
      {busy && primary && <Loader2 size={14} className="animate-spin" />}
      {label}
    </button>
  );

  let message: string;
  if (isSingle && singleHasValue) {
    message = isAr
      ? 'هذا الحقل يحتوي على صورة بالفعل. استبدالها؟'
      : 'This field already has an image. Replace it?';
  } else if (isMulti && existingCount > 0) {
    message = isAr
      ? `يحتوي هذا المعرض على ${existingCount} صورة. أضف إليه أم استبدل الكل؟`
      : `This gallery has ${existingCount} image(s). Add to it, or replace all?`;
  } else if (type === 'attachment' && existingCount > 0) {
    message = isAr
      ? `أضف الصورة إلى ${existingCount} مرفق موجود.`
      : `Add the image to ${existingCount} existing attachment(s).`;
  } else {
    message = isAr ? 'إضافة الصورة إلى هذا الحقل.' : 'Add the image to this field.';
  }

  return (
    <div className="py-4">
      <p className="text-sm text-charcoal/80 mb-4">{message}</p>
      <div className="flex flex-wrap gap-2">
        {isSingle && singleHasValue && (
          <Btn action="replace" label={isAr ? 'استبدال' : 'Replace'} primary />
        )}
        {isSingle && !singleHasValue && <Btn action="set" label={isAr ? 'إضافة' : 'Add'} primary />}
        {isMulti && (
          <>
            <Btn action="add" label={isAr ? 'إضافة' : 'Add'} primary />
            {existingCount > 0 && (
              <Btn action="replace_all" label={isAr ? 'استبدال الكل' : 'Replace existing'} />
            )}
          </>
        )}
        {type === 'attachment' && <Btn action="add" label={isAr ? 'إضافة' : 'Add'} primary />}
        <button
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center px-4 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream disabled:opacity-50"
        >
          {isAr ? 'إغلاق' : 'Close'}
        </button>
      </div>
    </div>
  );
}
