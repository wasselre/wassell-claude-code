import { v4 as uuid } from 'uuid';
import { SEED_MODELS } from './seedModels';
import type { Profile, ProfileModelPermissions, Role, User, ModelPermission, ModelSection } from '@/types';

function now(): string {
  return new Date().toISOString();
}

const ALL_PERMISSIONS: ModelPermission[] = ['view', 'create', 'edit', 'delete', 'import', 'export'];
const BASIC_PERMISSIONS: ModelPermission[] = ['view', 'create', 'edit'];
const READONLY_PERMISSIONS: ModelPermission[] = ['view'];

// Sales capability matrix — client-facing work only. Tighter than "everything"
// so the seed is a useful default. Research is admin-only; catalogs are read-only.
const SALES_BASIC_MODELS = new Set(['clients', 'followups', 'appointments', 'targeted_projects']);
const SALES_READONLY_MODELS = new Set(['developers', 'all_projects', 'our_projects', 'units']);

function salesPermissionsFor(modelName: string): ModelPermission[] {
  if (SALES_BASIC_MODELS.has(modelName)) return BASIC_PERMISSIONS;
  if (SALES_READONLY_MODELS.has(modelName)) return READONLY_PERMISSIONS;
  return [];
}

// --- Profiles ---
// IMPORTANT: these IDs are HARDCODED — do NOT replace with `uuid()`.
// The backfill in `appStore.initialize()` checks "is a profile with this ID
// already in Supabase?" If the seed ID changes every page load (which is
// what `uuid()` would do — JS modules re-execute on every load), the answer
// is always no and the backfill keeps inserting fresh copies. Hardcoded IDs
// make the seed idempotent: the first install inserts these rows; every
// subsequent load sees them already exist and skips. See bug postmortem in
// the 2026-05-17 cleanup commit.
const adminProfileId = 'ed8349bc-e083-46cb-9bcb-34727fb7fb78';
const salesProfileId = 'b303acd7-eaea-47f2-a9b7-404d3dc79ea8';

export const SEED_PROFILES: Profile[] = [
  {
    id: adminProfileId,
    label_ar: 'مدير النظام',
    label_en: 'Administrator',
    is_system: true,
    is_admin: true,
    model_permissions: SEED_MODELS.map((m) => ({
      model_id: m.id,
      permissions: ALL_PERMISSIONS,
    })),
    created_at: now(),
    updated_at: now(),
  },
  {
    id: salesProfileId,
    label_ar: 'مبيعات',
    label_en: 'Sales',
    is_system: false,
    is_admin: false,
    model_permissions: SEED_MODELS
      .map<ProfileModelPermissions>((m) => ({
        model_id: m.id,
        permissions: salesPermissionsFor(m.name),
      }))
      .filter((mp) => mp.permissions.length > 0),
    created_at: now(),
    updated_at: now(),
  },
];

// --- Roles ---
// Roles use the same schema shape as models (sections → fields). The seed
// roles each have a single "General" section; admins can split into more
// sections later just like in the model builder.
// Hardcoded for the same reason as adminProfileId / salesProfileId above —
// the backfill is keyed by id, so stable ids make seeding idempotent.
const salesRepRoleId = 'bc217747-73cf-4405-b176-1da43d8f972a';
const salesManagerRoleId = 'c54976bb-d0ae-4c5c-a7a7-05ef5fd07551';

function generalSection(fields: ModelSection['fields']): ModelSection {
  return {
    id: uuid(),
    label_ar: 'عام',
    label_en: 'General',
    order: 0,
    is_base: true,
    color: '#B8734F',
    fields,
  };
}

const salesRepSectionId = uuid();
const salesManagerSectionId = uuid();

export const SEED_ROLES: Role[] = [
  {
    id: salesRepRoleId,
    label_ar: 'مندوب مبيعات',
    label_en: 'Sales Rep',
    is_system: true,
    schema: {
      sections: [
        {
          id: salesRepSectionId,
          label_ar: 'عام',
          label_en: 'General',
          order: 0,
          is_base: true,
          color: '#B8734F',
          fields: [
            {
              id: uuid(),
              name: 'is_active',
              label_ar: 'نشط',
              label_en: 'Active',
              type: 'checkbox',
              required: false,
              order: 0,
              section_id: salesRepSectionId,
              width: 'half',
              show_in_table: true,
            },
            {
              id: uuid(),
              name: 'responsible_region',
              label_ar: 'المنطقة المسؤولة',
              label_en: 'Responsible Region',
              type: 'dropdown',
              required: false,
              order: 1,
              section_id: salesRepSectionId,
              width: 'half',
              show_in_table: true,
              options: [
                { id: uuid(), label_ar: 'الرياض', label_en: 'Riyadh', value: 'riyadh', color: '#B8734F' },
                { id: uuid(), label_ar: 'جدة', label_en: 'Jeddah', value: 'jeddah', color: '#8E4E3A' },
                { id: uuid(), label_ar: 'الدمام', label_en: 'Dammam', value: 'dammam', color: '#C09B5F' },
              ],
            },
            {
              id: uuid(),
              name: 'task_count',
              label_ar: 'عدد المهام',
              label_en: 'Task Count',
              type: 'number',
              required: false,
              order: 2,
              section_id: salesRepSectionId,
              width: 'half',
              show_in_table: true,
            },
          ],
        },
      ],
      section_selector_field_id: null,
    },
    created_at: now(),
    updated_at: now(),
  },
  {
    id: salesManagerRoleId,
    label_ar: 'مدير مبيعات',
    label_en: 'Sales Manager',
    is_system: true,
    schema: {
      sections: [
        {
          id: salesManagerSectionId,
          label_ar: 'عام',
          label_en: 'General',
          order: 0,
          is_base: true,
          color: '#B8734F',
          fields: [
            {
              id: uuid(),
              name: 'is_active',
              label_ar: 'نشط',
              label_en: 'Active',
              type: 'checkbox',
              required: false,
              order: 0,
              section_id: salesManagerSectionId,
              width: 'half',
              show_in_table: true,
            },
            {
              id: uuid(),
              name: 'team_size',
              label_ar: 'حجم الفريق',
              label_en: 'Team Size',
              type: 'number',
              required: false,
              order: 1,
              section_id: salesManagerSectionId,
              width: 'half',
              show_in_table: true,
            },
          ],
        },
      ],
      section_selector_field_id: null,
    },
    created_at: now(),
    updated_at: now(),
  },
];

// Suppress TS unused-variable warning for the helper (kept for clarity — may
// be useful when seeding additional roles). Intentional.
void generalSection;

// --- Users ---
export const SEED_USERS: User[] = [
  {
    // Hardcoded for the same reason as the profile/role ids above —
    // the backfill is keyed by id, so stable ids make seeding idempotent.
    // (The email also has a UNIQUE constraint in the DB, which is what
    // partially limited duplication for users to begin with.)
    id: 'a3374d65-9cee-4daa-8880-5e8ff23e7db0',
    name_ar: 'مدير النظام',
    name_en: 'System Admin',
    email: 'admin@wassel.sa',
    profile_id: adminProfileId,
    role_assignments: [],
    is_active: true,
    created_at: now(),
    updated_at: now(),
  },
];
