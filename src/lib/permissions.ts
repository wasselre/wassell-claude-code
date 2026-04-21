import type { User, Profile, ModelPermission } from '@/types';

/**
 * Check if a user has a specific permission on a model.
 * Returns true if:
 * - No user system active (currentUserId is null) → backward compatible full access
 * - User's profile grants the permission on the model
 */
export function hasPermission(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  modelId: string,
  permission: ModelPermission,
): boolean {
  // No user system active = full access
  if (currentUserId === null) return true;

  const user = users.find((u) => u.id === currentUserId);
  if (!user || !user.is_active) return false;

  const profile = profiles.find((p) => p.id === user.profile_id);
  if (!profile) return false;

  const modelPerms = profile.model_permissions.find((mp) => mp.model_id === modelId);
  if (!modelPerms) return false;

  return modelPerms.permissions.includes(permission);
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
  const user = users.find((u) => u.id === currentUserId);
  if (!user || !user.is_active) return false;
  const profile = profiles.find((p) => p.id === user.profile_id);
  return profile?.is_admin === true;
}

/**
 * Get all permissions a user has on a model.
 */
export function getModelPermissions(
  currentUserId: string | null,
  users: User[],
  profiles: Profile[],
  modelId: string,
): Set<ModelPermission> {
  if (currentUserId === null) {
    return new Set(['view', 'create', 'edit', 'delete', 'import', 'export']);
  }

  const user = users.find((u) => u.id === currentUserId);
  if (!user || !user.is_active) return new Set();

  const profile = profiles.find((p) => p.id === user.profile_id);
  if (!profile) return new Set();

  const modelPerms = profile.model_permissions.find((mp) => mp.model_id === modelId);
  if (!modelPerms) return new Set();

  return new Set(modelPerms.permissions);
}
