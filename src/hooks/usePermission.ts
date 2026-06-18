import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  applyViewScopeToRecords,
  applyVisibleViews,
  canAccessPage,
  canViewWorkflows,
  canEditRecord,
  canViewRecord,
  getFieldPermission,
  getModelPermissions,
  hasPermission,
  isAdmin,
  isButtonVisible,
} from '@/lib/permissions';
import type {
  AppModel,
  AppRecord,
  FieldPermission,
  ModelField,
  ModelPermission,
  ModelView,
} from '@/types';

export function usePermission(modelId: string, permission: ModelPermission): boolean {
  const { currentUserId, users, profiles } = useAppStore();
  return hasPermission(currentUserId, users, profiles, modelId, permission);
}

export function useModelPermissions(modelId: string): Set<ModelPermission> {
  const { currentUserId, users, profiles } = useAppStore();
  return getModelPermissions(currentUserId, users, profiles, modelId);
}

export function useIsAdmin(): boolean {
  const { currentUserId, users, profiles } = useAppStore();
  return isAdmin(currentUserId, users, profiles);
}

/**
 * Whether the current user can access a custom (non-model) page — the Sales
 * Operations surfaces registered in `customPages.ts`. Used by the sidebar
 * links and the `RequirePageAccess` route guard.
 */
export function useCanAccessPage(pageId: string): boolean {
  const { currentUserId, users, profiles } = useAppStore();
  return canAccessPage(currentUserId, users, profiles, pageId);
}

/**
 * Whether the current user may READ workflows (Studio links + run history).
 * Editing the Workflow Builder stays admin-only regardless.
 */
export function useCanViewWorkflows(): boolean {
  const { currentUserId, users, profiles } = useAppStore();
  return canViewWorkflows(currentUserId, users, profiles);
}

/**
 * True if the current user can view this specific record (view perm + view_scope).
 * Cheaper than running `useApplyViewScope` when you have a single record in hand.
 */
export function useCanViewRecord(model: AppModel | null | undefined, record: AppRecord | null | undefined): boolean {
  const { currentUserId, users, profiles, roles } = useAppStore();
  if (!model || !record) return false;
  return canViewRecord(currentUserId, users, profiles, roles, model, record);
}

/**
 * True if the current user can edit this specific record (edit perm + view_scope + edit_scope).
 * The record form uses this to flip into read-only mode for in-scope-but-not-editable rows.
 */
export function useCanEditRecord(model: AppModel | null | undefined, record: AppRecord | null | undefined): boolean {
  const { currentUserId, users, profiles, roles } = useAppStore();
  if (!model || !record) return false;
  return canEditRecord(currentUserId, users, profiles, roles, model, record);
}

/**
 * Resolved permission for a single field on the current user's profile.
 * `hidden` → don't render. `readonly` → render disabled. `editable` →
 * render normally. Computed field types are forced to `readonly`.
 */
export function useFieldPermission(modelId: string, field: ModelField): FieldPermission {
  const { currentUserId, users, profiles } = useAppStore();
  return getFieldPermission(currentUserId, users, profiles, modelId, field);
}

/**
 * Returns a callback that resolves the per-field permission for any field on
 * the given model. Useful when a parent component (e.g. RecordFormPage) needs
 * to hand the resolution down into a child (e.g. SectionBlock) that walks
 * fields itself — calling the per-field hook in a loop violates rules of hooks.
 * The callback closes over the current store state; it re-derives whenever
 * `currentUserId`, `users`, or `profiles` change.
 */
export function useFieldPermissionResolver(modelId: string): (field: ModelField) => FieldPermission {
  const { currentUserId, users, profiles } = useAppStore();
  return useMemo(
    () => (field: ModelField) =>
      getFieldPermission(currentUserId, users, profiles, modelId, field),
    [currentUserId, users, profiles, modelId],
  );
}

/**
 * Filter a list of records down to those the current user can view.
 * Primary entry point for RecordListPage, lookup pickers, and any
 * other surface that displays a list of records.
 *
 * Memo strategy: the dependencies are deliberately the *resolved* user
 * + profile + role-collection-version-marker rather than the full
 * `users` / `profiles` / `roles` arrays. Without this, any save on any
 * unrelated user (e.g. an admin renaming themselves) invalidates every
 * record list in the app and re-runs the per-row scope walk —
 * expensive at the 2,605-record scale. Computing the active user/
 * profile once outside the memo keeps the dependency surface small;
 * `roles.updated_at` (rough version marker via length + last id) is
 * fine because role schemas only matter when role_field sources are
 * referenced in scope conditions.
 */
export function useApplyViewScope(
  model: AppModel | null | undefined,
  records: AppRecord[],
): AppRecord[] {
  const { currentUserId, users, profiles, roles } = useAppStore();
  const me = users.find((u) => u.id === currentUserId) ?? null;
  const myProfile = me ? profiles.find((p) => p.id === me.profile_id) ?? null : null;
  // Cheap version marker for the roles collection. Identity changes only
  // when a role is added/removed; field-value resolution still re-walks
  // user.role_assignments which lives on `me`.
  const rolesVersion = `${roles.length}:${roles[roles.length - 1]?.updated_at ?? ''}`;
  return useMemo(() => {
    if (!model) return records;
    // Bail-out fast paths short-circuit before the scope walk.
    return applyViewScopeToRecords(currentUserId, users, profiles, roles, model, records);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, me, myProfile, rolesVersion, model, records]);
}

/**
 * Filter a list of saved views to those the current user can see. Used
 * by ViewSelector + RecordListPage. The author of a view always sees
 * their own; profile rules only affect shared views from other authors.
 */
export function useApplyVisibleViews(views: ModelView[]): ModelView[] {
  const { currentUserId, users, profiles } = useAppStore();
  return useMemo(
    () => applyVisibleViews(currentUserId, users, profiles, views),
    [currentUserId, users, profiles, views],
  );
}

/** Whether the current user can see / click a specific custom button. */
export function useIsButtonVisible(buttonId: string): boolean {
  const { currentUserId, users, profiles } = useAppStore();
  return isButtonVisible(currentUserId, users, profiles, buttonId);
}
