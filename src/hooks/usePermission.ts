import { useAppStore } from '@/stores/appStore';
import { hasPermission, getModelPermissions, isAdmin } from '@/lib/permissions';
import type { ModelPermission } from '@/types';

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
