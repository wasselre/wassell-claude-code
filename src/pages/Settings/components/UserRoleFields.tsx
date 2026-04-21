import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import DynamicField from '@/pages/Records/components/DynamicField';
import { roleFields } from '@/lib/roleSchema';
import type { Role, UserRoleAssignment } from '@/types';

// Field types that don't make sense in a role-assignment context (they need a
// record to operate on, which a role-field doesn't have). Render a disabled
// placeholder instead of DynamicField for these.
const NOT_APPLICABLE_IN_ROLE = new Set([
  'auto_id',       // no record to number
  'mirror',        // needs a lookup on the same record
  'section_mirror',// needs a lookup on the same record
  'assignee',      // circular — assigning users inside a role's fields
  'section_selector', // only useful at a model level with non-base sections
]);

interface UserRoleFieldsProps {
  role: Role;
  assignment: UserRoleAssignment;
  onChange: (values: Record<string, unknown>) => void;
}

export default function UserRoleFields({ role, assignment, onChange }: UserRoleFieldsProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const values = assignment.field_values;
  const fields = roleFields(role);

  const update = (fieldName: string, value: unknown) => {
    onChange({ ...values, [fieldName]: value });
  };

  if (fields.length === 0) {
    return (
      <p className="text-xs text-charcoal/30 italic">
        {isAr ? 'لا توجد حقول في هذا الدور' : 'This role has no fields'}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {fields.map((field) => {
        const val = values[field.name];
        const colSpan = field.width === 'full' ? 'col-span-2' : 'col-span-1';

        if (NOT_APPLICABLE_IN_ROLE.has(field.type)) {
          return (
            <div key={field.id} className={colSpan}>
              <label className="block text-xs font-bold text-charcoal/50 mb-1">
                {isAr ? field.label_ar : field.label_en}
              </label>
              <p className="text-xs text-charcoal/25 italic py-2 px-3 bg-sand/10 rounded-lg">
                {t('roles.field_not_applicable', { type: field.type })}
              </p>
            </div>
          );
        }

        return (
          <div key={field.id} className={colSpan}>
            <label className="block text-xs font-bold text-charcoal/50 mb-1">
              {isAr ? field.label_ar : field.label_en}
              {field.required && <span className="text-red-500 ms-1">*</span>}
            </label>
            <DynamicField
              field={field}
              value={val}
              onChange={(v) => update(field.name, v)}
              compact
            />
          </div>
        );
      })}
    </div>
  );
}
