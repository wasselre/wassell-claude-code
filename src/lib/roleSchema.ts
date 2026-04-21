import { v4 as uuid } from 'uuid';
import type { Role, ModelField, ModelSchema, ModelSection } from '@/types';

/**
 * Return all fields in a role's schema, sorted by (section.order, field.order).
 * Used by consumers that need a flat list (workflow conditions, members table,
 * inline user role editor, etc.) — roles use sections for the builder UX but
 * most runtime consumers treat fields as a flat set.
 */
export function roleFields(role: Role): ModelField[] {
  const sortedSections = [...role.schema.sections].sort((a, b) => a.order - b.order);
  return sortedSections.flatMap((s) => [...s.fields].sort((a, b) => a.order - b.order));
}

/**
 * Build a default single-section schema for a new role. Label is bilingual
 * "General" so the user sees a consistent empty state regardless of language.
 */
export function emptyRoleSchema(): ModelSchema {
  const section: ModelSection = {
    id: uuid(),
    label_ar: 'عام',
    label_en: 'General',
    order: 0,
    is_base: true,
    color: '#B8734F',
    fields: [],
  };
  return { sections: [section], section_selector_field_id: null };
}
