import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  applyViewScopeToRecords,
  applyVisibleViews,
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
 * Memoized on the inputs — primary entry point for RecordListPage,
 * lookup pickers, and any other surface that displays a list of
 * records. Admin / no-auth fast-paths inside `applyViewScopeToRecords`
 * keep the cost negligible when no filtering is needed.
 */
export function useApplyViewScope(
  model: AppModel | null | undefined,
  records: AppRecord[],
): AppRecord[] {
  const { currentUserId, users, profiles, roles } = useAppStore();
  return useMemo(() => {
    if (!model) return records;
    return applyViewScopeToRecords(currentUserId, users, profiles, roles, model, records);
  }, [currentUserId, users, profiles, roles, model, records]);
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
