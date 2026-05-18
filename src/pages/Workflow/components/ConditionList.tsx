import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Plus, Trash2, CircleDot } from 'lucide-react';
import FieldValueInput from './FieldValueInput';
import type { WorkflowCondition, ConditionOperator, ModelField, WorkflowEvent } from '@/types';

interface ConditionListProps {
  conditions: WorkflowCondition[];
  fields: ModelField[];
  triggerEvent: WorkflowEvent;
  onChange: (conditions: WorkflowCondition[]) => void;
  // 'all' = AND (default), 'any' = OR. When `onModeChange` is provided the
  // toggle is rendered above the list. Both must be provided together for the
  // toggle to appear; otherwise the list silently honours the mode for
  // labelling without offering the switch.
  mode?: 'all' | 'any';
  onModeChange?: (mode: 'all' | 'any') => void;
  // When true, render without the outer card / icon chrome so the component
  // nests cleanly inside a branch card. The branch card provides its own
  // container styling.
  embedded?: boolean;
}

const OPERATORS: ConditionOperator[] = [
  'equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty', 'is_not_empty',
];

// Short operator symbols for the canvas node card. Mirrors the i18n keys but
// stays terse and language-agnostic so it fits the ~40-char summary budget.
const OPERATOR_SYMBOL: Record<ConditionOperator, string> = {
  equals: '=',
  not_equals: '≠',
  contains: '⊇',
  intersects: '∩',
  greater_than: '>',
  less_than: '<',
  is_empty: 'Ø',
  is_not_empty: '≠ Ø',
  exists_related_record: '∃',
  not_exists_related_record: '∄',
};

// One-line textual summary for a condition, used by ConditionNode on the
// canvas. Truncates long values so a full-width node stays one line tall.
export function summarizeCondition(cond: WorkflowCondition, fields: ModelField[], isAr: boolean): string {
  if (!cond.field_id) return isAr ? 'اختر حقلًا' : 'Pick a field';
  const field = fields.find((f) => f.name === cond.field_id);
  const name = field ? (isAr ? field.label_ar : field.label_en) : cond.field_id;
  const sym = OPERATOR_SYMBOL[cond.operator];
  if (cond.operator === 'is_empty' || cond.operator === 'is_not_empty') {
    return `${name} ${sym}`;
  }
  const v = cond.value;
  const shown = v == null || v === ''
    ? (isAr ? '(فارغ)' : '(empty)')
    : typeof v === 'string'
      ? v
      : Array.isArray(v)
        ? v.join(', ')
        : String(v);
  const trimmed = shown.length > 22 ? shown.slice(0, 19) + '…' : shown;
  return `${name} ${sym} ${trimmed}`;
}

export default function ConditionList({ conditions, fields, triggerEvent, onChange, mode = 'all', onModeChange, embedded = false }: ConditionListProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const showTransitionToggle = triggerEvent === 'update';
  const isOr = mode === 'any';
  const connectorLabel = isOr ? (isAr ? 'أو' : 'OR') : (isAr ? 'و' : 'AND');
  const connectorChipClasses = isOr
    ? 'text-amber-700/80 bg-amber-500/10'
    : 'text-blue-600/70 bg-blue-500/10';

  const addCondition = () => {
    onChange([...conditions, { id: uuid(), field_id: '', operator: 'equals', value: '' }]);
  };

  const updateCondition = (id: string, updates: Partial<WorkflowCondition>) => {
    onChange(conditions.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  };

  const deleteCondition = (id: string) => {
    onChange(conditions.filter((c) => c.id !== id));
  };

  const needsValue = (op: ConditionOperator) => op !== 'is_empty' && op !== 'is_not_empty';

  // Get relevant operators for a field type
  const getOperatorsForField = (fieldName: string): ConditionOperator[] => {
    const field = fields.find((f) => f.name === fieldName);
    if (!field) return OPERATORS;
    switch (field.type) {
      case 'dropdown':
      case 'multiselect':
      case 'lookup':
      case 'section_selector':
      case 'checkbox':
        // Only equality/empty operators make sense for selection fields
        return ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
      case 'number':
      case 'currency':
        return OPERATORS; // all operators
      case 'date':
      case 'datetime':
        return ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'];
      default:
        return OPERATORS;
    }
  };

  // Match-mode toggle — only shown when the host wired `onModeChange` AND
  // there are at least two conditions (toggle has no semantic effect with 0
  // or 1 conditions, so hiding it keeps the empty/just-added state quiet).
  const showModeToggle = !!onModeChange && conditions.length >= 2;
  const matchAllLabel = isAr ? 'مطابقة كل الشروط' : 'Match ALL conditions';
  const matchAnyLabel = isAr ? 'مطابقة أي شرط' : 'Match ANY condition';
  const matchAllShort = isAr ? 'الكل (و)' : 'ALL (AND)';
  const matchAnyShort = isAr ? 'أي (أو)' : 'ANY (OR)';

  const body = (
    <>
      {showModeToggle && (
        <div className="mb-3 flex items-center gap-2 p-2 rounded-xl bg-cream-light/80 border border-sand/40">
          <span className="text-[11px] font-bold uppercase tracking-wider text-charcoal/50 ps-1 shrink-0">
            {isAr ? 'الربط' : 'Match'}
          </span>
          <div className="flex-1" />
          <div className="inline-flex rounded-lg border border-sand/50 bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => onModeChange?.('all')}
              className={`px-3 py-1.5 text-xs font-bold transition-colors ${
                !isOr ? 'bg-blue-500 text-white' : 'text-charcoal/60 hover:bg-sand/20'
              }`}
              title={matchAllLabel}
            >
              {matchAllShort}
            </button>
            <button
              type="button"
              onClick={() => onModeChange?.('any')}
              className={`px-3 py-1.5 text-xs font-bold transition-colors border-s border-sand/50 ${
                isOr ? 'bg-amber-500 text-white' : 'text-charcoal/60 hover:bg-sand/20'
              }`}
              title={matchAnyLabel}
            >
              {matchAnyShort}
            </button>
          </div>
        </div>
      )}
      <div className="space-y-2.5">
        {conditions.length === 0 && (
          <div className="text-center py-6 text-charcoal/35 text-sm bg-cream-light/60 rounded-xl border border-dashed border-sand/40">
            {isAr ? 'لا توجد شروط — سيتم تنفيذ هذا الفرع دائمًا.' : 'No conditions — this branch will always run.'}
          </div>
        )}
        {conditions.map((cond, idx) => {
          const selectedField = fields.find((f) => f.name === cond.field_id);
          const availableOps = getOperatorsForField(cond.field_id);

          return (
            <div key={cond.id}>
              {idx > 0 && (
                <div className="flex items-center gap-2 my-1.5 ms-2">
                  <span className={`text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded ${connectorChipClasses}`}>
                    {connectorLabel}
                  </span>
                  <div className="flex-1 h-px bg-sand/30" />
                </div>
              )}
              <div className="group p-3 bg-white rounded-xl border border-sand/30 hover:border-blue-400/40 transition-colors space-y-2">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 w-6 h-6 rounded-md bg-blue-500/10 text-blue-600 text-xs font-bold flex items-center justify-center">{idx + 1}</span>
                  <select
                    value={cond.field_id}
                    onChange={(e) => updateCondition(cond.id, { field_id: e.target.value, value: '' })}
                    className="form-input text-sm flex-1 py-2"
                  >
                    <option value="">— {isAr ? 'اختر حقل' : 'Select field'} —</option>
                    {fields.map((f) => (
                      <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                    ))}
                  </select>
                  <select
                    value={cond.operator}
                    onChange={(e) => updateCondition(cond.id, { operator: e.target.value as ConditionOperator })}
                    className="form-input text-sm w-32 py-2"
                  >
                    {availableOps.map((op) => (
                      <option key={op} value={op}>{t(`condition.${op}`)}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => deleteCondition(cond.id)}
                    className="p-1.5 rounded-md text-charcoal/25 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                    aria-label={isAr ? 'حذف' : 'Delete'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {needsValue(cond.operator) && (
                  <div className="ps-8">
                    <FieldValueInput
                      field={selectedField}
                      value={cond.value}
                      onChange={(val) => updateCondition(cond.id, { value: val })}
                      className="flex-1"
                    />
                  </div>
                )}

                {showTransitionToggle && (
                  <label className="flex items-start gap-2 text-xs text-charcoal/60 cursor-pointer select-none ps-8">
                    <input
                      type="checkbox"
                      checked={!!cond.only_on_change}
                      onChange={(e) => updateCondition(cond.id, { only_on_change: e.target.checked })}
                      className="mt-0.5 accent-copper"
                    />
                    <span className="leading-tight">
                      <span className="font-medium text-charcoal/70">{t('condition.only_on_change')}</span>
                      <span className="block text-charcoal/40">{t('condition.only_on_change_hint')}</span>
                    </span>
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button
        onClick={addCondition}
        className="mt-3 w-full py-2 rounded-xl border border-dashed border-blue-400/40 text-blue-600 hover:bg-blue-500/5 transition-colors text-sm font-bold flex items-center justify-center gap-1.5"
      >
        <Plus size={14} />
        {t('workflow.add_condition')}
      </button>
    </>
  );

  if (embedded) return body;

  return (
    <div className="card p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
          <CircleDot size={20} className="text-blue-500" />
        </div>
        <div>
          <h3 className="font-bold text-chocolate text-lg">{t('workflow.only_if')}</h3>
          <p className="text-xs text-charcoal/30">
            {conditions.length === 0
              ? (isAr ? 'تُنفذ القاعدة دائمًا بدون شروط إضافية.' : 'Rule always executes with no additional conditions.')
              : (isAr ? `${conditions.length} شرط` : `${conditions.length} condition(s)`)
            }
          </p>
        </div>
      </div>
      {body}
    </div>
  );
}
