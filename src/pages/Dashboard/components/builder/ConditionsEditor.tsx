import { v4 as uuid } from 'uuid';
import { Plus, Trash2, Filter } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { ModelField, WidgetFilterCondition, WidgetFilterOperator } from '@/types';

/**
 * Multi-condition filter editor (AND). Works on `WidgetFilterCondition[]` — the
 * shape Saved Views + the engine's `viewConditionsToFilterGroup` already speak.
 * Extracted from the legacy WidgetConfigModal so the new builder reuses it
 * verbatim. `label` lets callers retitle it (e.g. "Part" / "Whole" for a
 * percentage numerator/denominator).
 */
export default function ConditionsEditor({
  conditions,
  onChange,
  allFields,
  label,
  compact,
}: {
  conditions: WidgetFilterCondition[];
  onChange: (conditions: WidgetFilterCondition[]) => void;
  allFields: ModelField[];
  label?: string;
  compact?: boolean;
}) {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const operators: { value: WidgetFilterOperator; ar: string; en: string }[] = [
    { value: 'equals', ar: 'يساوي', en: 'equals' },
    { value: 'not_equals', ar: 'لا يساوي', en: 'not equals' },
    { value: 'contains', ar: 'يحتوي على', en: 'contains' },
    { value: 'greater_than', ar: 'أكبر من', en: 'greater than' },
    { value: 'less_than', ar: 'أصغر من', en: 'less than' },
    { value: 'is_empty', ar: 'فارغ', en: 'is empty' },
    { value: 'is_not_empty', ar: 'غير فارغ', en: 'is not empty' },
  ];
  const needsValue = (op: WidgetFilterOperator) => op !== 'is_empty' && op !== 'is_not_empty';

  const addCondition = () => onChange([...conditions, { id: uuid(), field_id: '', operator: 'equals', value: '' }]);
  const updateCondition = (id: string, updates: Partial<WidgetFilterCondition>) =>
    onChange(conditions.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  const pickField = (id: string, nextFieldId: string) => {
    const nextField = allFields.find((f) => f.id === nextFieldId);
    const field_path = nextField?.type === 'range' ? 'min' : undefined;
    updateCondition(id, { field_id: nextFieldId, field_path, value: '' });
  };
  const deleteCondition = (id: string) => onChange(conditions.filter((c) => c.id !== id));

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Filter size={14} className="text-charcoal/40" />
        <label className="text-sm font-bold text-charcoal">{label ?? (isAr ? 'شروط التصفية' : 'Filter conditions')}</label>
        {conditions.length > 0 && (
          <span className="rounded-full bg-copper/10 px-1.5 py-0.5 text-xs font-bold text-copper">{conditions.length}</span>
        )}
      </div>

      {conditions.length > 0 && (
        <div className="mb-3 space-y-2">
          {conditions.map((cond) => {
            const selectedField = allFields.find((f) => f.id === cond.field_id);
            return (
              <div key={cond.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-cream-light p-2">
                <select value={cond.field_id} onChange={(e) => pickField(cond.id, e.target.value)} className="form-input min-w-[120px] flex-1 bg-white py-1 text-xs">
                  <option value="">— {isAr ? 'حقل' : 'Field'} —</option>
                  {allFields.map((f) => (
                    <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>
                  ))}
                </select>

                {selectedField?.type === 'range' && cond.operator !== 'is_empty' && cond.operator !== 'is_not_empty' && (
                  <select value={cond.field_path ?? 'min'} onChange={(e) => updateCondition(cond.id, { field_path: e.target.value })} className="form-input w-20 bg-white py-1 text-xs">
                    <option value="min">{isAr ? 'الحد الأدنى' : 'Min'}</option>
                    <option value="max">{isAr ? 'الحد الأعلى' : 'Max'}</option>
                  </select>
                )}

                <select value={cond.operator} onChange={(e) => updateCondition(cond.id, { operator: e.target.value as WidgetFilterOperator })} className="form-input w-28 bg-white py-1 text-xs">
                  {operators.map((op) => (
                    <option key={op.value} value={op.value}>{isAr ? op.ar : op.en}</option>
                  ))}
                </select>

                {needsValue(cond.operator) && selectedField ? (
                  selectedField.type === 'dropdown' || selectedField.type === 'multiselect' ? (
                    <select value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: e.target.value })} className="form-input flex-1 bg-white py-1 text-xs">
                      <option value="">—</option>
                      {(selectedField.options ?? []).map((opt) => (
                        <option key={opt.id} value={opt.value}>{isAr ? opt.label_ar : opt.label_en}</option>
                      ))}
                    </select>
                  ) : selectedField.type === 'checkbox' ? (
                    <select value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: e.target.value === 'true' })} className="form-input w-20 bg-white py-1 text-xs">
                      <option value="true">{isAr ? 'نعم' : 'Yes'}</option>
                      <option value="false">{isAr ? 'لا' : 'No'}</option>
                    </select>
                  ) : selectedField.type === 'number' || selectedField.type === 'currency' || selectedField.type === 'range' ? (
                    <input type="number" value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: e.target.value ? Number(e.target.value) : '' })} className="form-input flex-1 bg-white py-1 text-xs" />
                  ) : selectedField.type === 'date' || selectedField.type === 'datetime' ? (
                    <input type="date" value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: e.target.value })} className="form-input flex-1 bg-white py-1 text-xs" />
                  ) : (
                    <input type="text" value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: e.target.value })} className="form-input flex-1 bg-white py-1 text-xs" placeholder="..." />
                  )
                ) : needsValue(cond.operator) && !selectedField ? (
                  <input type="text" value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: e.target.value })} className="form-input flex-1 bg-white py-1 text-xs" placeholder="..." />
                ) : null}

                <button onClick={() => deleteCondition(cond.id)} className="shrink-0 rounded p-1 text-charcoal/20 hover:bg-red-50 hover:text-red-500">
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button onClick={addCondition} className="pill border-copper/30 text-xs text-copper hover:bg-copper/5">
        <Plus size={12} />
        {compact ? (isAr ? 'شرط' : 'Condition') : isAr ? 'إضافة شرط' : 'Add condition'}
      </button>
    </div>
  );
}
