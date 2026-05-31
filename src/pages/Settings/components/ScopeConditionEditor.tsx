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
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';
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
  // Resolve the actual target field once — every branch below needs it.
  // `null` here means the target is the synthetic `created_by` column,
  // which is treated like an assignee for picker purposes (its value is a
  // user id).
  const targetField =
    fieldRef.kind === 'field'
      ? model.schema.sections
          .flatMap((s) => s.fields)
          .find((f) => f.id === fieldRef.field_id) ?? null
      : null;
  const targetIsUserShaped =
    fieldRef.kind === 'created_by' || targetField?.type === 'assignee';

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
        <LiteralValueInput
          fieldRef={fieldRef}
          targetField={targetField}
          value={source.kind === 'literal' ? source.value : ''}
          isAr={isAr}
          onChange={(value) => onChange({ kind: 'literal', value })}
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
          {targetIsUserShaped
            ? isAr
              ? 'يطابق هوية المستخدم المسجل دخوله'
              : "matches the signed-in user's id"
            : isAr
              ? 'تنبيه: هذا الحقل لا يخزن معرّف مستخدم — قد لا تطابق القاعدة أبداً.'
              : 'Note: this field does not hold a user id — the rule may never match.'}
        </span>
      )}
    </div>
  );
}

interface LiteralValueInputProps {
  fieldRef: ScopeFieldRef;
  targetField: ModelField | null;
  value: unknown;
  isAr: boolean;
  onChange: (next: unknown) => void;
}

/**
 * Type-aware input for the right-hand "literal" value of a condition.
 *
 * Why this exists: the previous version was a plain text input. Admins
 * typed the visible label (e.g. "متاح" for "Available") which never
 * matched the stored slug (`available`). The pickers here populate with
 * the SAME values the field stores on records, so equality just works.
 *
 * For multi-valued targets (multiselect, lookup is_multi, section_selector,
 * multi-assignee) the picker is still single-select — the evaluator's
 * `equals` operator on an array record value checks if the picked literal
 * is one of the elements (see scopeFilters.evaluateOperator).
 */
function LiteralValueInput({ fieldRef, targetField, value, isAr, onChange }: LiteralValueInputProps) {
  const { records, users, models } = useAppStore();

  // 1. created_by → user picker (record column holds a user id).
  if (fieldRef.kind === 'created_by') {
    return <UserPicker users={users} value={value} isAr={isAr} onChange={onChange} />;
  }

  if (!targetField) {
    return (
      <input
        type="text"
        className="form-input text-xs py-1 px-2 flex-1"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        placeholder={isAr ? 'قيمة' : 'value'}
      />
    );
  }

  switch (targetField.type) {
    // 2. dropdown / multiselect / section_selector → option picker (single-select;
    //    array fields use the "any-of-array" semantics in the evaluator).
    case 'dropdown':
    case 'multiselect':
    case 'section_selector': {
      const opts = targetField.options ?? [];
      return (
        <select
          className="form-input text-xs py-1 px-2 flex-1"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{isAr ? '— اختر —' : '— select —'}</option>
          {opts.map((o) => (
            <option key={o.id} value={o.value}>
              {isAr ? o.label_ar : o.label_en}
            </option>
          ))}
        </select>
      );
    }

    // 3. lookup → record picker. Native select with the linked records'
    //    display values; capped to 200 to keep the DOM small. For larger
    //    target sets, admins should use a more structured rule (role_field).
    case 'lookup': {
      const linkedModel = targetField.lookup_model_id
        ? models.find((m) => m.id === targetField.lookup_model_id)
        : null;
      const displaySlug = targetField.lookup_display_field ?? null;
      const linkedRecords = targetField.lookup_model_id
        ? (records[targetField.lookup_model_id] ?? []).slice(0, 200)
        : [];
      const labelFor = (rec: { id: string; data: Record<string, unknown> }) => {
        const primary = displaySlug
          ? resolveLookupDisplayValue(rec, displaySlug, { targetModel: linkedModel, allModels: models, allRecords: records })
          : null;
        if (typeof primary === 'string' && primary.trim() !== '') return primary;
        if (typeof primary === 'number' && Number.isFinite(primary)) return String(primary);
        return rec.id.slice(0, 8);
      };
      return (
        <select
          className="form-input text-xs py-1 px-2 flex-1"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={!linkedModel}
        >
          <option value="">
            {linkedModel ? (isAr ? '— اختر سجلاً —' : '— select record —') : (isAr ? 'لا يوجد نموذج مرتبط' : 'no linked model')}
          </option>
          {linkedRecords.map((r) => (
            <option key={r.id} value={r.id}>
              {labelFor(r)}
            </option>
          ))}
        </select>
      );
    }

    // 4. assignee → user picker (single-select; multi-assignee uses array-includes).
    case 'assignee':
      return <UserPicker users={users} value={value} isAr={isAr} onChange={onChange} />;

    // 5. checkbox → boolean toggle.
    case 'checkbox':
      return (
        <select
          className="form-input text-xs py-1 px-2 flex-1"
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === 'true' ? true : v === 'false' ? false : '');
          }}
        >
          <option value="">{isAr ? '— اختر —' : '— select —'}</option>
          <option value="true">{isAr ? 'نعم' : 'True'}</option>
          <option value="false">{isAr ? 'لا' : 'False'}</option>
        </select>
      );

    // 6. date / datetime → native date picker. Stored as ISO string (matching
    //    the rest of the app), so equality works as plain string comparison.
    case 'date':
      return (
        <input
          type="date"
          className="form-input text-xs py-1 px-2 flex-1"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'datetime':
      return (
        <input
          type="datetime-local"
          className="form-input text-xs py-1 px-2 flex-1"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    // 7. number / currency → numeric input. Coerced to Number on change so
    //    the evaluator's greater_than / less_than don't trip on string compare.
    case 'number':
    case 'currency':
      return (
        <input
          type="number"
          className="form-input text-xs py-1 px-2 flex-1"
          value={value === undefined || value === null || value === '' ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      );

    // 8. everything else (text, textarea, email, phone, url, …) → text input.
    default:
      return (
        <input
          type="text"
          className="form-input text-xs py-1 px-2 flex-1"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={isAr ? 'قيمة' : 'value'}
        />
      );
  }
}

interface UserPickerProps {
  users: { id: string; name_ar: string; name_en: string; is_active: boolean }[];
  value: unknown;
  isAr: boolean;
  onChange: (next: string) => void;
}

function UserPicker({ users, value, isAr, onChange }: UserPickerProps) {
  return (
    <select
      className="form-input text-xs py-1 px-2 flex-1"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{isAr ? '— اختر مستخدماً —' : '— select user —'}</option>
      {users.filter((u) => u.is_active).map((u) => (
        <option key={u.id} value={u.id}>
          {isAr ? u.name_ar : u.name_en}
        </option>
      ))}
    </select>
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
