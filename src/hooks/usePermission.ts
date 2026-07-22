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
  resolveEffectiveProfile,
} from '@/lib/permissions';
import type {
  AppModel,
  AppRecord,
  FieldPermission,
  ModelField,
  ModelPermission,
  ModelView,
} from '@/types';

// Every hook forwards `previewProfileId` — the "view app as another
// profile" override. The permission layer only honors it for users
// carrying the explicit `can_preview_profiles` grant.

export function usePermission(modelId: string, permission: ModelPermission): boolean {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return hasPermission(currentUserId, users, profiles, modelId, permission, previewProfileId);
}

export function useModelPermissions(modelId: string): Set<ModelPermission> {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return getModelPermissions(currentUserId, users, profiles, modelId, previewProfileId);
}

export function useIsAdmin(): boolean {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return isAdmin(currentUserId, users, profiles, previewProfileId);
}

/**
 * Whether the current user can access a custom (non-model) page — the Sales
 * Operations surfaces registered in `customPages.ts`. Used by the sidebar
 * links and the `RequirePageAccess` route guard.
 */
export function useCanAccessPage(pageId: string): boolean {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return canAccessPage(currentUserId, users, profiles, pageId, previewProfileId);
}

/**
 * Whether the current user may READ workflows (Studio links + run history).
 * Editing the Workflow Builder stays admin-only regardless.
 */
export function useCanViewWorkflows(): boolean {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return canViewWorkflows(currentUserId, users, profiles, previewProfileId);
}

/**
 * True if the current user can view this specific record (view perm + view_scope).
 * Cheaper than running `useApplyViewScope` when you have a single record in hand.
 */
export function useCanViewRecord(model: AppModel | null | undefined, record: AppRecord | null | undefined): boolean {
  const { currentUserId, users, profiles, roles, previewProfileId } = useAppStore();
  if (!model || !record) return false;
  return canViewRecord(currentUserId, users, profiles, roles, model, record, previewProfileId);
}

/**
 * True if the current user can edit this specific record (edit perm + view_scope + edit_scope).
 * The record form uses this to flip into read-only mode for in-scope-but-not-editable rows.
 */
export function useCanEditRecord(model: AppModel | null | undefined, record: AppRecord | null | undefined): boolean {
  const { currentUserId, users, profiles, roles, previewProfileId } = useAppStore();
  if (!model || !record) return false;
  return canEditRecord(currentUserId, users, profiles, roles, model, record, previewProfileId);
}

/**
 * Resolved permission for a single field on the current user's profile.
 * `hidden` → don't render. `readonly` → render disabled. `editable` →
 * render normally. Computed field types are forced to `readonly`.
 */
export function useFieldPermission(modelId: string, field: ModelField): FieldPermission {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return getFieldPermission(currentUserId, users, profiles, modelId, field, previewProfileId);
}

/**
 * Returns a callback that resolves the per-field permission for any field on
 * the given model. Useful when a parent component (e.g. RecordFormPage) needs
 * to hand the resolution down into a child (e.g. SectionBlock) that walks
 * fields itself — calling the per-field hook in a loop violates rules of hooks.
 * The callback closes over the current store state; it re-derives whenever
 * `currentUserId`, `users`, `profiles`, or `previewProfileId` change.
 */
export function useFieldPermissionResolver(modelId: string): (field: ModelField) => FieldPermission {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return useMemo(
    () => (field: ModelField) =>
      getFieldPermission(currentUserId, users, profiles, modelId, field, previewProfileId),
    [currentUserId, users, profiles, modelId, previewProfileId],
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
  const { currentUserId, users, profiles, roles, previewProfileId } = useAppStore();
  const me = users.find((u) => u.id === currentUserId) ?? null;
  // Preview-aware: the effective profile is what the scope walk evaluates.
  const myProfile = resolveEffectiveProfile(me, profiles, previewProfileId);
  // Cheap version marker for the roles collection. Identity changes only
  // when a role is added/removed; field-value resolution still re-walks
  // user.role_assignments which lives on `me`.
  const rolesVersion = `${roles.length}:${roles[roles.length - 1]?.updated_at ?? ''}`;
  return useMemo(() => {
    if (!model) return records;
    // Bail-out fast paths short-circuit before the scope walk.
    return applyViewScopeToRecords(currentUserId, users, profiles, roles, model, records, previewProfileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, me, myProfile, rolesVersion, model, records, previewProfileId]);
}

/**
 * Filter a list of saved views to those the current user can see. Used
 * by ViewSelector + RecordListPage. The author of a view always sees
 * their own; profile rules only affect shared views from other authors.
 */
export function useApplyVisibleViews(views: ModelView[]): ModelView[] {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return useMemo(
    () => applyVisibleViews(currentUserId, users, profiles, views, previewProfileId),
    [currentUserId, users, profiles, views, previewProfileId],
  );
}

/** Whether the current user can see / click a specific custom button. */
export function useIsButtonVisible(buttonId: string): boolean {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  return isButtonVisible(currentUserId, users, profiles, buttonId, previewProfileId);
}
