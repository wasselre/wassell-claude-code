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
import { getCustomPage } from './customPages';

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
  previewProfileId?: string | null,
): ResolvedProfile | null {
  if (currentUserId === null) return null;
  const user = users.find((u) => u.id === currentUserId);
  if (!user || !user.is_active) return null;
  const profile = resolveEffectiveProfile(user, profiles, previewProfileId);
  if (!profile) return null;
  return { user, profile };
}

/**
 * The profile the permission layer evaluates for a user, honoring the
 * "preview app as another profile" override. The override applies ONLY
 * when the user carries the explicit `can_preview_profiles` grant —
 * a stray previewProfileId for anyone else is ignored, so this helper
 * can never change permissions for users without the grant. A preview
 * id that doesn't resolve (deleted profile) falls back to the user's
 * own profile instead of failing closed, so a stale persisted preview
 * can't lock the user out.
 */
export function resolveEffectiveProfile(
  user: User | null | undefined,
  profiles: Profile[],
  previewProfileId?: string | null,
): Profile | null {
  if (!user) return null;
  if (previewProfileId && user.can_preview_profiles === true) {
    const preview = profiles.find((p) => p.id === previewProfileId);
    if (preview) return preview;
  }
  return profiles.find((p) => p.id === user.profile_id) ?? null;
}

function modelEntryFor(
  profile: Profile,
  modelId: string,
): ProfileModelPermissions | undefined {
  // Defensive: a malformed profile row (e.g. `model_permissions: {}` instead of
  // `[]`) must not `.find`-crash the whole app — one bad row would white-screen
  // every surface that runs a permission check. A non-array reads as "no
  // explicit per-model grants", which correctly falls back to default access.
  const entries = profile.model_permissions;
  if (!Array.isArray(entries)) return undefined;
  return entries.find((mp) => mp.model_id === modelId);
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
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  const entry = modelEntryFor(resolved.profile, modelId);
  if (!entry) return false;
  return entry.permissions.includes(permission);
}

/**
 * Whether a model should be SUPPRESSED from the current profile's sidebar even
 * though it may be viewable. This is the nav side of "reference (data-only)
 * access": a profile granted `view` on a module purely so another module's
 * mirrored/looked-up data resolves shouldn't get a sidebar button for it.
 *
 * Nav-only — never gates data. Callers still check `hasPermission(...,'view')`
 * to decide reachability; this only decides whether to draw the link.
 *
 *   1. No user system active (pre-init) → false (show, mirrors hasPermission's
 *      permissive bootstrap so nothing flickers).
 *   2. No resolved (active) profile → false (nothing to hide against).
 *   3. Admin profile → false (admins always see every model in the nav).
 *   4. Otherwise → the model entry's `hidden_from_sidebar` flag.
 */
export function isModelSidebarHidden(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  modelId: string,
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return false;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return false;
  return modelEntryFor(resolved.profile, modelId)?.hidden_from_sidebar === true;
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
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
  return resolved?.profile.is_admin === true;
}

/**
 * Whether the current user can access a custom (non-model) page — the Sales
 * Operations surfaces registered in `customPages.ts`. These pages aren't
 * models, so they bypass `model_permissions` and resolve against the
 * profile's `page_access` map instead.
 *
 * Resolution order:
 *   1. No user system active (pre-init) → true (backward compat, mirrors
 *      hasPermission so nothing flickers before bootstrap).
 *   2. No resolved (active) profile → false.
 *   3. Admin profile → true (admins see every page).
 *   4. Explicit `profile.page_access[pageId]` boolean → use it.
 *   5. Otherwise → the page's `default_access` ('all' → true, 'admin' → false).
 *
 * Unknown page ids fail closed (false) for non-admins.
 */
export function canAccessPage(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  pageId: string,
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  const explicit = resolved.profile.page_access?.[pageId];
  if (typeof explicit === 'boolean') return explicit;
  return getCustomPage(pageId)?.default_access === 'all';
}

/**
 * Whether the current user may READ the workflow subsystem (workflows /
 * workflow_groups / workflow_runs) — used by the Sales Process Studio to show
 * linked workflows and by the run-history route guard. Read-only: editing the
 * Workflow Builder stays admin-only regardless of this.
 *
 *   1. No user system active (pre-init) → true (backward compat).
 *   2. No resolved (active) profile → false.
 *   3. Admin profile → true (admins always see + manage workflows).
 *   4. Otherwise → the profile's `can_view_workflows` flag.
 *
 * Mirrors the DB-side `wassell_can_view_workflows` RLS helper — keep them in
 * sync.
 */
export function canViewWorkflows(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  return resolved.profile.can_view_workflows === true;
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
  previewProfileId?: string | null,
): Set<ModelPermission> {
  if (currentUserId === null) return new Set(ALL_PERMISSIONS);
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
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
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
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
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
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
  previewProfileId?: string | null,
): AppRecord[] {
  if (currentUserId === null) return records;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
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
  previewProfileId?: string | null,
): FieldPermission {
  if (isComputedField(field)) return 'readonly';
  if (currentUserId === null) return 'editable';
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
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
  previewProfileId?: string | null,
): FieldPermission {
  const field = modelFieldsFor(model).find((f) => f.id === fieldId);
  if (!field) return 'hidden';
  return getFieldPermission(currentUserId, users, profiles, model.id, field, previewProfileId);
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
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return true;
  // Author always sees their own views.
  if (view.user_id === currentUserId) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
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
  previewProfileId?: string | null,
): ModelView[] {
  if (currentUserId === null) return views;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
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
  previewProfileId?: string | null,
): boolean {
  if (currentUserId === null) return true;
  const resolved = resolveActiveProfile(currentUserId, users, profiles, previewProfileId);
  if (!resolved) return false;
  if (resolved.profile.is_admin) return true;
  const hidden = resolved.profile.hidden_button_ids ?? [];
  return !hidden.includes(buttonId);
}
