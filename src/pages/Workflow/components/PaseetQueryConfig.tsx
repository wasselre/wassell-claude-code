import { useEffect, useMemo, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { v4 as uuid } from 'uuid';
import { Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type {
  WorkflowActionPaseetQuery,
  PaseetResponseMapping,
  PaseetResponseMappingKind,
  PaseetResponseShape,
  PaseetTableColumnMapping,
  ModelField,
} from '@/types';

interface Props {
  action: WorkflowActionPaseetQuery;
  triggerFields: ModelField[];
  onUpdate: (next: WorkflowActionPaseetQuery) => void;
}

/**
 * Editor for the `paseet_query` workflow action. Users configure:
 *   1. the Arabic prompt sent to Paseet (with `{field_slug}` substitution),
 *   2. what shape of answer to expect (free text / single value / table),
 *   3. one or more response_mappings that describe how to fold the answer
 *      back onto the trigger record (set a field, or append/replace rows
 *      inside a `table` field).
 *
 * Inputs use local state + commit-on-blur so typing the prompt template
 * doesn't lag the workflow editor with a save-per-keystroke (same trick
 * used in CustomButtonsTab).
 */

type LocalInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'> & {
  value: string;
  onCommit: (next: string) => void;
};
function LocalInput({ value, onCommit, ...rest }: LocalInputProps) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <input
      {...rest}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
    />
  );
}

type LocalTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onBlur'> & {
  value: string;
  onCommit: (next: string) => void;
};
function LocalTextarea({ value, onCommit, ...rest }: LocalTextareaProps) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <textarea
      {...rest}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
    />
  );
}

const RESPONSE_SHAPES: PaseetResponseShape[] = ['text', 'single_value', 'table_rows'];
const MAPPING_KINDS: PaseetResponseMappingKind[] = ['set_field', 'append_table_rows', 'replace_table_rows'];

export default function PaseetQueryConfig({ action, triggerFields, onUpdate }: Props) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [expandedMappingId, setExpandedMappingId] = useState<string | null>(null);

  const updateField = <K extends keyof WorkflowActionPaseetQuery>(key: K, value: WorkflowActionPaseetQuery[K]) => {
    onUpdate({ ...action, [key]: value });
  };

  const addMapping = () => {
    const m: PaseetResponseMapping = {
      id: uuid(),
      kind: action.response_shape === 'table_rows' ? 'append_table_rows' : 'set_field',
      target_field_id: '',
    };
    updateField('response_mappings', [...action.response_mappings, m]);
    setExpandedMappingId(m.id);
  };

  const patchMapping = (id: string, patch: Partial<PaseetResponseMapping>) => {
    updateField(
      'response_mappings',
      action.response_mappings.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );
  };

  const removeMapping = (id: string) => {
    updateField(
      'response_mappings',
      action.response_mappings.filter((m) => m.id !== id),
    );
  };

  // Trigger fields by slug, plus the table fields (for table_rows mappings).
  const tableFields = useMemo(
    () => triggerFields.filter((f) => f.type === 'table'),
    [triggerFields],
  );
  const nonDerivedFields = useMemo(
    () => triggerFields.filter((f) => f.type !== 'mirror' && f.type !== 'auto_id' && f.type !== 'formula'),
    [triggerFields],
  );

  return (
    <div className="space-y-4 mt-3">
      {/* Prompt template */}
      <div>
        <label className="block text-xs font-bold text-charcoal/60 mb-1">
          {isAr ? 'النص المُرسل إلى بسيط' : 'Prompt sent to Paseet'}
        </label>
        <LocalTextarea
          className="form-input w-full font-mono text-sm"
          rows={6}
          value={action.prompt_template}
          onCommit={(v) => updateField('prompt_template', v)}
          dir="auto"
          placeholder={
            isAr
              ? 'عطني العناصر التالية لمشروع {project_name} في الموقع {location}…'
              : 'Give me the following for project {project_name} at location {location}…'
          }
        />
        <p className="text-xs text-charcoal/40 mt-1">
          {isAr
            ? 'استخدم {اسم_الحقل} لإدراج قيمة من السجل. مثال: {project_name}'
            : 'Use {field_slug} to substitute a value from the trigger record. e.g. {project_name}'}
        </p>
      </div>

      {/* Response shape */}
      <div>
        <label className="block text-xs font-bold text-charcoal/60 mb-1">
          {isAr ? 'شكل الرد المتوقَّع' : 'Expected response shape'}
        </label>
        <select
          className="form-input w-full"
          value={action.response_shape}
          onChange={(e) => updateField('response_shape', e.target.value as PaseetResponseShape)}
        >
          {RESPONSE_SHAPES.map((s) => (
            <option key={s} value={s}>
              {s === 'text'
                ? isAr ? 'نص حر' : 'Free text'
                : s === 'single_value'
                ? isAr ? 'قيمة واحدة' : 'Single value'
                : isAr ? 'صفوف جدول' : 'Table rows'}
            </option>
          ))}
        </select>
      </div>

      {/* Timeout */}
      <div>
        <label className="block text-xs font-bold text-charcoal/60 mb-1">
          {isAr ? 'مهلة الانتظار (ثوانٍ)' : 'Timeout (seconds)'}
        </label>
        <LocalInput
          type="number"
          min={10}
          max={180}
          className="form-input w-32"
          value={String(Math.round((action.timeout_ms ?? 90_000) / 1000))}
          onCommit={(v) => {
            const n = parseInt(v, 10);
            if (Number.isFinite(n)) updateField('timeout_ms', Math.min(Math.max(n * 1000, 10_000), 180_000));
          }}
        />
      </div>

      {/* Response mappings */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-bold text-charcoal/60">
            {isAr ? 'وجهات الرد' : 'Response mappings'}
          </label>
          <button
            type="button"
            onClick={addMapping}
            className="flex items-center gap-1 text-xs text-copper hover:text-copper/80 px-2 py-1 rounded hover:bg-copper/5"
          >
            <Plus size={12} />
            {isAr ? 'إضافة وجهة' : 'Add mapping'}
          </button>
        </div>

        {action.response_mappings.length === 0 && (
          <p className="text-xs text-charcoal/40 italic py-2">
            {isAr
              ? 'لا توجد وجهات. أضف وجهة لحفظ رد بسيط في حقل من السجل.'
              : 'No mappings. Add one to save Paseet’s answer into a record field.'}
          </p>
        )}

        <div className="space-y-2">
          {action.response_mappings.map((m, idx) => {
            const expanded = expandedMappingId === m.id;
            const isTableKind = m.kind === 'append_table_rows' || m.kind === 'replace_table_rows';
            const targetField = triggerFields.find((f) => f.name === m.target_field_id);
            const targetTableField = isTableKind ? tableFields.find((f) => f.name === m.target_field_id) : null;
            const targetCols = (targetTableField?.table_columns ?? []) as Array<{ id: string; name: string; label_ar: string; label_en: string }>;

            return (
              <div key={m.id} className="border border-sand/40 rounded-lg bg-white">
                <button
                  type="button"
                  onClick={() => setExpandedMappingId(expanded ? null : m.id)}
                  className="w-full flex items-center justify-between p-3 text-start"
                >
                  <div className="text-sm">
                    <span className="font-bold text-charcoal">
                      {isAr ? `وجهة ${idx + 1}` : `Mapping ${idx + 1}`}
                    </span>
                    <span className="text-charcoal/50 ms-2">
                      ·{' '}
                      {m.kind === 'set_field'
                        ? isAr ? 'حقل' : 'field'
                        : m.kind === 'append_table_rows'
                        ? isAr ? 'إضافة صفوف' : 'append rows'
                        : isAr ? 'استبدال صفوف' : 'replace rows'}
                      {targetField && ` → ${isAr ? targetField.label_ar : targetField.label_en}`}
                    </span>
                  </div>
                  {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {expanded && (
                  <div className="px-3 pb-3 pt-1 space-y-3 border-t border-sand/20">
                    {/* Mapping kind */}
                    <div>
                      <label className="block text-xs font-bold text-charcoal/60 mb-1">
                        {isAr ? 'نوع الوجهة' : 'Mapping kind'}
                      </label>
                      <select
                        className="form-input w-full"
                        value={m.kind}
                        onChange={(e) => patchMapping(m.id, { kind: e.target.value as PaseetResponseMappingKind })}
                      >
                        {MAPPING_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k === 'set_field'
                              ? isAr ? 'تعيين قيمة في حقل' : 'Set field value'
                              : k === 'append_table_rows'
                              ? isAr ? 'إضافة صفوف لجدول' : 'Append rows to table'
                              : isAr ? 'استبدال صفوف جدول' : 'Replace table rows'}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Target field */}
                    <div>
                      <label className="block text-xs font-bold text-charcoal/60 mb-1">
                        {isAr ? 'الحقل المستهدف' : 'Target field'}
                      </label>
                      <select
                        className="form-input w-full"
                        value={m.target_field_id}
                        onChange={(e) => patchMapping(m.id, { target_field_id: e.target.value })}
                      >
                        <option value="">{isAr ? '— اختر حقلًا —' : '— Select field —'}</option>
                        {(isTableKind ? tableFields : nonDerivedFields).map((f) => (
                          <option key={f.id} value={f.name}>
                            {isAr ? f.label_ar : f.label_en} ({f.type})
                          </option>
                        ))}
                      </select>
                      {triggerFields.length === 0 && (
                        <p className="text-xs text-amber-700 mt-1">
                          {isAr
                            ? 'حدّد نموذج المشغّل في إعدادات سير العمل أولًا حتى تظهر الحقول.'
                            : 'Pick a trigger model on the workflow first so fields show up here.'}
                        </p>
                      )}
                    </div>

                    {/* set_field: parse_as + optional regex */}
                    {m.kind === 'set_field' && (
                      <>
                        <div>
                          <label className="block text-xs font-bold text-charcoal/60 mb-1">
                            {isAr ? 'تحويل القيمة' : 'Parse as'}
                          </label>
                          <select
                            className="form-input w-full"
                            value={m.parse_as ?? 'text'}
                            onChange={(e) => patchMapping(m.id, { parse_as: e.target.value as 'text' | 'number' | 'currency' })}
                          >
                            <option value="text">{isAr ? 'نص' : 'Text'}</option>
                            <option value="number">{isAr ? 'رقم' : 'Number'}</option>
                            <option value="currency">{isAr ? 'عملة' : 'Currency'}</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-charcoal/60 mb-1">
                            {isAr ? 'استخراج بـ Regex (اختياري)' : 'Extract with regex (optional)'}
                          </label>
                          <LocalInput
                            className="form-input w-full font-mono text-sm"
                            placeholder="e.g. (\\d{1,3}(?:,\\d{3})*)"
                            value={m.extract_regex ?? ''}
                            onCommit={(v) => patchMapping(m.id, { extract_regex: v || undefined })}
                          />
                          <p className="text-xs text-charcoal/40 mt-1">
                            {isAr
                              ? 'لاستخراج قيمة محددة من نص الرد. تُستخدم المجموعة الأولى من الـ regex.'
                              : 'Pluck a specific value out of the answer text. The first capture group is used if any.'}
                          </p>
                        </div>
                      </>
                    )}

                    {/* table_rows: column-by-column mapping */}
                    {isTableKind && targetTableField && (
                      <TableColumnMappingsEditor
                        mapping={m}
                        targetColumns={targetCols}
                        isAr={isAr}
                        onUpdate={(tcm) => patchMapping(m.id, { table_column_mappings: tcm })}
                      />
                    )}

                    {/* Delete */}
                    <div className="flex justify-end pt-2 border-t border-sand/20">
                      <button
                        type="button"
                        onClick={() => removeMapping(m.id)}
                        className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50"
                      >
                        <Trash2 size={12} />
                        {isAr ? 'حذف الوجهة' : 'Delete mapping'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── Table column mappings sub-editor ─────────────────────────────── */

interface TableColumnMappingsEditorProps {
  mapping: PaseetResponseMapping;
  targetColumns: Array<{ id: string; name: string; label_ar: string; label_en: string }>;
  isAr: boolean;
  onUpdate: (next: PaseetTableColumnMapping[]) => void;
}

function TableColumnMappingsEditor({ mapping, targetColumns, isAr, onUpdate }: TableColumnMappingsEditorProps) {
  const colMappings = mapping.table_column_mappings ?? [];

  const addColMapping = () => {
    const taken = new Set(colMappings.map((cm) => cm.target_column_id));
    const nextCol = targetColumns.find((c) => !taken.has(c.id));
    onUpdate([
      ...colMappings,
      {
        id: uuid(),
        target_column_id: nextCol?.id ?? '',
        source_header_keywords: [],
        parse_as: 'text',
      },
    ]);
  };

  const patch = (id: string, p: Partial<PaseetTableColumnMapping>) => {
    onUpdate(colMappings.map((cm) => (cm.id === id ? { ...cm, ...p } : cm)));
  };

  const remove = (id: string) => {
    onUpdate(colMappings.filter((cm) => cm.id !== id));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-bold text-charcoal/60">
          {isAr ? 'تعيين الأعمدة' : 'Column mapping'}
        </label>
        <button
          type="button"
          onClick={addColMapping}
          disabled={targetColumns.length === 0}
          className="flex items-center gap-1 text-xs text-copper hover:text-copper/80 px-2 py-1 rounded hover:bg-copper/5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={12} />
          {isAr ? 'إضافة عمود' : 'Add column'}
        </button>
      </div>

      {targetColumns.length === 0 && (
        <p className="text-xs text-amber-700 italic">
          {isAr
            ? 'الحقل المستهدف ليس به أعمدة. حدد أعمدته من مُنشئ النموذج أولًا.'
            : 'Target field has no columns yet. Configure them in the model builder first.'}
        </p>
      )}

      {colMappings.length === 0 && targetColumns.length > 0 && (
        <p className="text-xs text-charcoal/40 italic">
          {isAr
            ? 'لا توجد أعمدة معيَّنة. أضف عمودًا لمطابقة عمود في رد بسيط بعمود في الجدول.'
            : 'No columns mapped yet. Add one to match a Paseet response column to a CRM table column.'}
        </p>
      )}

      <div className="space-y-2 mt-2">
        {colMappings.map((cm) => {
          const targetCol = targetColumns.find((c) => c.id === cm.target_column_id);
          return (
            <div key={cm.id} className="grid grid-cols-12 gap-2 items-start p-2 rounded border border-sand/30 bg-cream/30">
              <div className="col-span-4">
                <label className="block text-[10px] font-bold text-charcoal/50 mb-0.5">
                  {isAr ? 'عمود الجدول' : 'CRM column'}
                </label>
                <select
                  className="form-input w-full text-sm"
                  value={cm.target_column_id}
                  onChange={(e) => patch(cm.id, { target_column_id: e.target.value })}
                >
                  <option value="">—</option>
                  {targetColumns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {isAr ? c.label_ar : c.label_en}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-5">
                <label className="block text-[10px] font-bold text-charcoal/50 mb-0.5">
                  {isAr ? 'كلمات في رد بسيط' : 'Paseet header keywords'}
                </label>
                <LocalInput
                  className="form-input w-full text-sm"
                  placeholder={isAr ? 'مثال: أقل, أدنى' : 'e.g. أقل, أدنى'}
                  value={(cm.source_header_keywords ?? []).join(', ')}
                  onCommit={(v) => {
                    const kws = v.split(/[,،]+/).map((s) => s.trim()).filter(Boolean);
                    patch(cm.id, { source_header_keywords: kws });
                  }}
                />
              </div>
              <div className="col-span-2">
                <label className="block text-[10px] font-bold text-charcoal/50 mb-0.5">
                  {isAr ? 'النوع' : 'Parse'}
                </label>
                <select
                  className="form-input w-full text-sm"
                  value={cm.parse_as ?? (targetCol?.name && targetCol.name.toLowerCase().includes('price') ? 'currency' : 'text')}
                  onChange={(e) => patch(cm.id, { parse_as: e.target.value as 'text' | 'number' | 'currency' })}
                >
                  <option value="text">{isAr ? 'نص' : 'Text'}</option>
                  <option value="number">{isAr ? 'رقم' : 'Number'}</option>
                  <option value="currency">{isAr ? 'عملة' : 'Currency'}</option>
                </select>
              </div>
              <div className="col-span-1 flex items-end justify-end pb-1">
                <button
                  type="button"
                  onClick={() => remove(cm.id)}
                  className="p-1.5 rounded text-red-500 hover:bg-red-50"
                  title={isAr ? 'حذف' : 'Remove'}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
