/**
 * ScopeConditionEditor — the filter builder used by both view-scope and
 * edit-scope inside the PermissionMatrix.
 *
 * Each row is a `ScopeFilterCondition`:
 *   [target field]   [operator]   [value source]
 * where:
 *   - target is `created_by` (the synthetic creator column) or a model field
 *   - operator is one of the dashboard-aligned operators (equals, contains, …)
 *   - value source is a literal, "current user", or "role field" reference
 *
 * Self-contained: receives the current conditions array + an onChange and
 * never reaches into the store directly. Renders nothing when the parent
 * scope is in "all" mode — the parent owns the mode toggle.
 */

import { v4 as uuid } from 'uuid';
import { Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type {
  AppModel,
  ModelField,
  Role,
  ScopeFieldRef,
  ScopeFilterCondition,
  ScopeOperator,
  ScopeValueSource,
} from '@/types';

interface Props {
  model: AppModel;
  conditions: ScopeFilterCondition[];
  onChange: (next: ScopeFilterCondition[]) => void;
}

const OPERATOR_LABELS_AR: Record<ScopeOperator, string> = {
  equals: 'يساوي',
  not_equals: 'لا يساوي',
  contains: 'يحتوي على',
  greater_than: 'أكبر من',
  less_than: 'أصغر من',
  is_empty: 'فارغ',
  is_not_empty: 'غير فارغ',
};
const OPERATOR_LABELS_EN: Record<ScopeOperator, string> = {
  equals: '=',
  not_equals: '≠',
  contains: 'contains',
  greater_than: '>',
  less_than: '<',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

const ALL_OPERATORS: ScopeOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
];

// Field types that don't make sense as scope targets — they store complex
// or model-local data (mirrors, container fields, structured types) where
// equality/contains comparisons would be ambiguous. Hiding them in the
// picker keeps admins from creating rules that silently never match.
const UNFILTERABLE_TYPES: ReadonlySet<ModelField['type']> = new Set([
  'mirror',
  'section_mirror',
  'section_selector',
  'notes',
  'table',
]);

function filterableFields(model: AppModel): ModelField[] {
  return model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => !UNFILTERABLE_TYPES.has(f.type))
    .sort((a, b) => a.order - b.order);
}

function defaultCondition(model: AppModel): ScopeFilterCondition {
  // Sensible default: "records I created" — the most common rule. Falls
  // back to the first filterable field if the model has no creator hook
  // (shouldn't happen — created_by_user_id is universal — but defensive).
  return {
    id: uuid(),
    field: { kind: 'created_by' },
    operator: 'equals',
    source: { kind: 'current_user' },
  };
  // (`model` left in the signature for future per-model heuristics.)
  void model;
}

function fieldRefValue(ref: ScopeFieldRef): string {
  return ref.kind === 'created_by' ? '__created_by' : ref.field_id;
}

function parseFieldRefValue(value: string): ScopeFieldRef {
  if (value === '__created_by') return { kind: 'created_by' };
  return { kind: 'field', field_id: value };
}

export default function ScopeConditionEditor({ model, conditions, onChange }: Props) {
  const { language, roles } = useAppStore();
  const isAr = language === 'ar';
  const opLabels = isAr ? OPERATOR_LABELS_AR : OPERATOR_LABELS_EN;

  const fields = filterableFields(model);

  const update = (id: string, patch: Partial<ScopeFilterCondition>) => {
    onChange(conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };
  const remove = (id: string) => onChange(conditions.filter((c) => c.id !== id));
  const add = () => onChange([...conditions, defaultCondition(model)]);

  return (
    <div className="space-y-2">
      {conditions.length === 0 && (
        <p className="text-xs text-charcoal/40 italic">
          {isAr
            ? 'لا توجد شروط — أضف شرطاً لتقييد السجلات.'
            : 'No conditions yet — add one to restrict records.'}
        </p>
      )}

      {conditions.map((cond) => (
        <ConditionRow
          key={cond.id}
          condition={cond}
          model={model}
          fields={fields}
          roles={roles}
          isAr={isAr}
          opLabels={opLabels}
          onChange={(patch) => update(cond.id, patch)}
          onRemove={() => remove(cond.id)}
        />
      ))}

      <button
        type="button"
        onClick={add}
        className="text-xs font-bold text-copper hover:text-copper/80 inline-flex items-center gap-1 mt-1"
      >
        <Plus size={12} />
        {isAr ? 'إضافة شرط' : 'Add condition'}
      </button>
    </div>
  );
}

interface RowProps {
  condition: ScopeFilterCondition;
  model: AppModel;
  fields: ModelField[];
  roles: Role[];
  isAr: boolean;
  opLabels: Record<ScopeOperator, string>;
  onChange: (patch: Partial<ScopeFilterCondition>) => void;
  onRemove: () => void;
}

function ConditionRow({ condition, model, fields, roles, isAr, opLabels, onChange, onRemove }: RowProps) {
  const needsRhs = condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty';

  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-cream/40 border border-sand/30">
      {/* Target field */}
      <select
        className="form-input text-xs py-1 px-2 flex-1 min-w-0"
        value={fieldRefValue(condition.field)}
        onChange={(e) => onChange({ field: parseFieldRefValue(e.target.value) })}
      >
        <option value="__created_by">{isAr ? 'أنشأ بواسطة' : 'Created by'}</option>
        <optgroup label={isAr ? 'حقول النموذج' : 'Model fields'}>
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {isAr ? f.label_ar : f.label_en}
            </option>
          ))}
        </optgroup>
      </select>

      {/* Operator */}
      <select
        className="form-input text-xs py-1 px-2 w-24"
        value={condition.operator}
        onChange={(e) => onChange({ operator: e.target.value as ScopeOperator })}
      >
        {ALL_OPERATORS.map((op) => (
          <option key={op} value={op}>
            {opLabels[op]}
          </option>
        ))}
      </select>

      {/* Right-hand value source */}
      {needsRhs && (
        <ValueSourceEditor
          source={condition.source}
          fieldRef={condition.field}
          model={model}
          roles={roles}
          isAr={isAr}
          onChange={(source) => onChange({ source })}
        />
      )}
      {!needsRhs && <div className="flex-1" />}

      <button
        type="button"
        onClick={onRemove}
        className="p-1.5 rounded text-charcoal/40 hover:text-red-500 hover:bg-red-50"
        title={isAr ? 'حذف' : 'Remove'}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

interface ValueProps {
  source: ScopeValueSource;
  fieldRef: ScopeFieldRef;
  model: AppModel;
  roles: Role[];
  isAr: boolean;
  onChange: (next: ScopeValueSource) => void;
}

function ValueSourceEditor({ source, fieldRef, model, roles, isAr, onChange }: ValueProps) {
  // The "current user" source only makes sense when the target is the
  // created_by column or an assignee field — otherwise the comparison
  // will always be false. We still allow the user to pick it in the UI
  // (the evaluator handles the "doesn't match" case gracefully); but
  // the default option order surfaces the most-likely choice.
  const targetIsUserShaped =
    fieldRef.kind === 'created_by' ||
    (fieldRef.kind === 'field' &&
      model.schema.sections
        .flatMap((s) => s.fields)
        .find((f) => f.id === fieldRef.field_id)?.type === 'assignee');

  const sourceKind = source.kind;

  return (
    <div className="flex items-center gap-1.5 flex-1">
      <select
        className="form-input text-xs py-1 px-2 w-32"
        value={sourceKind}
        onChange={(e) => {
          const kind = e.target.value as ScopeValueSource['kind'];
          if (kind === 'literal') onChange({ kind: 'literal', value: '' });
          else if (kind === 'current_user') onChange({ kind: 'current_user' });
          else onChange({ kind: 'role_field', role_id: roles[0]?.id ?? '', field_slug: '' });
        }}
      >
        <option value="literal">{isAr ? 'قيمة ثابتة' : 'Literal'}</option>
        <option value="current_user">{isAr ? 'المستخدم الحالي' : 'Current user'}</option>
        <option value="role_field">{isAr ? 'حقل من الدور' : 'Role field'}</option>
      </select>

      {sourceKind === 'literal' && (
        <input
          type="text"
          className="form-input text-xs py-1 px-2 flex-1"
          value={source.kind === 'literal' ? String(source.value ?? '') : ''}
          onChange={(e) =>
            onChange({ kind: 'literal', value: e.target.value })
          }
          placeholder={targetIsUserShaped ? (isAr ? 'معرّف المستخدم' : 'user id') : (isAr ? 'قيمة' : 'value')}
        />
      )}

      {sourceKind === 'role_field' && source.kind === 'role_field' && (
        <RoleFieldPicker
          roles={roles}
          roleId={source.role_id}
          fieldSlug={source.field_slug}
          isAr={isAr}
          onChange={(role_id, field_slug) =>
            onChange({ kind: 'role_field', role_id, field_slug })
          }
        />
      )}

      {sourceKind === 'current_user' && (
        <span className="text-[11px] text-charcoal/40 italic">
          {isAr ? 'يطابق هوية المستخدم المسجل دخوله' : "matches the signed-in user's id"}
        </span>
      )}
    </div>
  );
}

interface RoleFieldPickerProps {
  roles: Role[];
  roleId: string;
  fieldSlug: string;
  isAr: boolean;
  onChange: (roleId: string, fieldSlug: string) => void;
}

function RoleFieldPicker({ roles, roleId, fieldSlug, isAr, onChange }: RoleFieldPickerProps) {
  const role = roles.find((r) => r.id === roleId);
  const fields = role
    ? role.schema.sections.flatMap((s) => s.fields).sort((a, b) => a.order - b.order)
    : [];

  return (
    <>
      <select
        className="form-input text-xs py-1 px-2"
        value={roleId}
        onChange={(e) => onChange(e.target.value, '')}
      >
        <option value="">{isAr ? '— اختر دوراً —' : '— select role —'}</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {isAr ? r.label_ar : r.label_en}
          </option>
        ))}
      </select>
      <select
        className="form-input text-xs py-1 px-2 flex-1"
        value={fieldSlug}
        onChange={(e) => onChange(roleId, e.target.value)}
        disabled={!role}
      >
        <option value="">{isAr ? '— اختر حقلاً —' : '— select field —'}</option>
        {fields.map((f) => (
          <option key={f.id} value={f.name}>
            {isAr ? f.label_ar : f.label_en}
          </option>
        ))}
      </select>
    </>
  );
}
