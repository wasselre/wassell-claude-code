import type {
  AppModel,
  AppRecord,
  FieldPermission,
  ModelField,
  ModelPermission,
  ModelView,
  Profile,
  ProfileModelPermissions,
  Role,
  User,
} from '@/types';
import { applyScope, buildScopeContext, recordPassesScope } from './scopeFilters';

const ALL_PERMISSIONS: ModelPermission[] = ['view', 'create', 'edit', 'delete', 'import', 'export'];

/**
 * Field types that are always read-only regardless of profile config:
 * the value is computed from other state (formulas), system-assigned
 * (auto_id), or sourced from a related record (mirror / section_mirror).
 * Allowing the matrix to override these would either silently no-op or
 * introduce data corruption.
 */
const COMPUTED_FIELD_TYPES: ReadonlySet<ModelField['type']> = new Set([
  'formula',
  'auto_id',
  'mirror',
  'section_mirror',
]);

function isComputedField(field: ModelField): boolean {
  // Any field with the type-level marker (formula / auto_id / mirror /
  // section_mirror) OR the stored cross-record rollup flag `is_rollup`
  // (units → project rollups; the DB trigger maintains the value).
  return (
    COMPUTED_FIELD_TYPES.has(field.type) ||
    !!field.is_rollup ||
    !!field.read_only
  );
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers — resolve the active profile and its model entry.
// Centralized so every check applies the same admin/inactive/no-auth
// rules without forking the logic per call site.
// ────────────────────────────────────────────────────────────────────

interface ResolvedProfile {
  user: User;
  profile: Profile;
}

function resolveActiveProfile(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
): ResolvedProfile | null {
  if (currentUserId === null) return null;
  const user = users.find((u) => u.id === currentUserId);
  if (!user || !user.is_active) return null;
  const profile = profiles.find((p) => p.id === user.profile_id);
  if (!profile) return null;
  return { user, profile };
}

function modelEntryFor(
  profile: Profile,
  modelId: string,
): ProfileModelPermissions | undefined {
  return profile.model_permissions.find((mp) => mp.model_id === modelId);
}

// ────────────────────────────────────────────────────────────────────
// Action permissions (model-level on/off). Same shape as before — the
// per-record and per-field layers compose on top.
// ────────────────────────────────────────────────────────────────────

/**
 * Check if a user has a specific permission on a model.
 * Returns true if:
 * - No user system active (currentUserId is null) → backward compatible full access
 * - User's profile is flagged `is_admin` → unrestricted access to every model,
 *   regardless of what's in `model_permissions`. The UI and RLS both rely on
 *   this invariant — it's what "admin" means.
 * - User's profile grants the permission on the model
 */
export function hasPermission(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  modelId: string,
  permission: ModelPermission,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  const entry = modelEntryFor(resolved.profile, modelId);
  if (!entry) return false;
  return entry.permissions.includes(permission);
}

/**
 * Check whether the current user is an admin. Admin-gated routes use this.
 * Returns true when no user system is active (pre-init fallback) to mirror
 * hasPermission's backward-compat behavior.
 */
export function isAdmin(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  return resolved?.profile.is_admin === true;
}

/**
 * Get all permissions a user has on a model. Admin profiles return the full
 * permission set regardless of what `model_permissions` actually contains —
 * this mirrors the bypass in `hasPermission`.
 */
export function getModelPermissions(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  modelId: string,
): Set<ModelPermission> {
  if (currentUserId === null) return new Set(ALL_PERMISSIONS);
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return new Set();
  if (resolved.profile.is_admin) return new Set(ALL_PERMISSIONS);
  const entry = modelEntryFor(resolved.profile, modelId);
  if (!entry) return new Set();
  return new Set(entry.permissions);
}

// ────────────────────────────────────────────────────────────────────
// Record-level scopes.
//
// Composition rules:
//   - canViewRecord = (model.view permission) AND (record passes view_scope)
//   - canEditRecord = (model.edit permission) AND (record passes view_scope)
//                                              AND (record passes edit_scope)
//
// The "view_scope ⊂ edit_scope" invariant is enforced here, not in the UI.
// Even if an admin saves an edit_scope wider than view_scope, this code
// narrows it: a record the user can't see is never a record they can edit.
// ────────────────────────────────────────────────────────────────────

function modelFieldsFor(model: AppModel): ModelField[] {
  return model.schema.sections.flatMap((s) => s.fields);
}

/**
 * Whether the current user can view a specific record. Combines the model
 * "view" action toggle with the profile's view_scope filter. No user
 * signed in → full access (backward compat). Admin → full access.
 */
export function canViewRecord(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  roles: Role[],
  model: AppModel,
  record: AppRecord,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  const entry = modelEntryFor(resolved.profile, model.id);
  if (!entry || !entry.permissions.includes('view')) return false;
  const ctx = buildScopeContext(resolved.user, roles);
  return recordPassesScope(entry.view_scope, record, modelFieldsFor(model), ctx);
}

/**
 * Whether the current user can edit a specific record. Walks the full
 * stack: model "edit" toggle → view_scope → edit_scope. Used by the
 * record form to decide whether to render in read-only mode.
 */
export function canEditRecord(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  roles: Role[],
  model: AppModel,
  record: AppRecord,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  const entry = modelEntryFor(resolved.profile, model.id);
  if (!entry || !entry.permissions.includes('edit')) return false;
  const ctx = buildScopeContext(resolved.user, roles);
  const fields = modelFieldsFor(model);
  if (!recordPassesScope(entry.view_scope, record, fields, ctx)) return false;
  return recordPassesScope(entry.edit_scope, record, fields, ctx);
}

/**
 * Filter a list of records to those the current user can view. This is
 * the primary entry point for record listings (RecordListPage, lookup
 * pickers, search results). Admin / no-auth fast-paths are inlined to
 * avoid walking every record when no filtering is needed.
 */
export function applyViewScopeToRecords(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  roles: Role[],
  model: AppModel,
  records: AppRecord[],
): AppRecord[] {
  if (currentUserId === null) return records;
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return [];
  if (resolved.profile.is_admin) return records;
  const entry = modelEntryFor(resolved.profile, model.id);
  if (!entry || !entry.permissions.includes('view')) return [];
  const ctx = buildScopeContext(resolved.user, roles);
  return applyScope(records, entry.view_scope, modelFieldsFor(model), ctx);
}

// ────────────────────────────────────────────────────────────────────
// Field-level permissions.
//
// `getFieldPermission` returns the effective rule for one field on one
// model for the current user. The form / table renderers consult this
// per-field and either skip rendering (`hidden`) or disable the input
// (`readonly`). Computed field types are forced to `readonly` so an
// admin can't accidentally make a formula writable.
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve the effective field permission. Falls back to `editable`
 * unless overridden by:
 *  1. The field is a computed type (always readonly).
 *  2. No user system / admin profile (always editable, except #1).
 *  3. The profile's `field_permissions[fieldId]` entry.
 *
 * Pass the field directly when you have it — it lets the function see
 * the type and short-circuit to readonly for computed fields without
 * looking up the model. The model-id overload is for hooks that only
 * have IDs in scope.
 */
export function getFieldPermission(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  modelId: string,
  field: ModelField,
): FieldPermission {
  if (isComputedField(field)) return 'readonly';
  if (currentUserId === null) return 'editable';
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return 'hidden';
  if (resolved.profile.is_admin) return 'editable';
  const entry = modelEntryFor(resolved.profile, modelId);
  if (!entry) return 'hidden';
  const explicit = entry.field_permissions?.[field.id];
  return explicit ?? 'editable';
}

/**
 * Convenience for callers that have only the model + field id, not the
 * full field object. Walks the model schema; returns `hidden` if the
 * field id is unknown (defensive — a stale id shouldn't render).
 */
export function getFieldPermissionByIds(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  model: AppModel,
  fieldId: string,
): FieldPermission {
  const field = modelFieldsFor(model).find((f) => f.id === fieldId);
  if (!field) return 'hidden';
  return getFieldPermission(currentUserId, users, profiles, model.id, field);
}

// ────────────────────────────────────────────────────────────────────
// Saved-view + custom-button visibility.
//
// Both use a deny-list shape on the profile (`hidden_view_ids` /
// `hidden_button_ids`). Default is visible; adding a new shared view
// or button is visible to everyone until an admin explicitly hides it
// for a profile. Admin profiles always see everything. For views, the
// author always sees their own views (we don't want a profile rule to
// hide a user's personal saved view from themselves).
// ────────────────────────────────────────────────────────────────────

/**
 * Whether the current user can see and select a specific saved view.
 * The author of a view always sees their own views regardless of profile
 * config — hiding personal views from their author would be confusing
 * and the user could just save a fresh copy anyway. Profile-level rules
 * only meaningfully affect SHARED views.
 */
export function isViewVisible(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  view: ModelView,
): boolean {
  if (currentUserId === null) return true;
  // Author always sees their own views.
  if (view.user_id === currentUserId) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  const hidden = resolved.profile.hidden_view_ids ?? [];
  return !hidden.includes(view.id);
}

/**
 * Filter a list of views to those the current user can see. Used by the
 * sidebar `ViewSelector` and any other surface that lists saved views.
 */
export function applyVisibleViews(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  views: ModelView[],
): ModelView[] {
  if (currentUserId === null) return views;
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return [];
  if (resolved.profile.is_admin) return views;
  const hidden = new Set(resolved.profile.hidden_view_ids ?? []);
  return views.filter((v) => v.user_id === currentUserId || !hidden.has(v.id));
}

/**
 * Whether the current user can see and click a specific custom button.
 * Buttons are always model-wide (no scope/field-style nuance) — either
 * the profile is allowed to invoke the button or it isn't.
 */
export function isButtonVisible(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  buttonId: string,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  const hidden = resolved.profile.hidden_button_ids ?? [];
  return !hidden.includes(buttonId);
}
