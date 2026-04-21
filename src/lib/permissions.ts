import type { User, Profile, ModelPermission } from '@/types';

const ALL_PERMISSIONS: ModelPermission[] = ['view', 'create', 'edit', 'delete', 'import', 'export'];

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
  // No user system active = full access
  if (currentUserId === null) return true;

  const user = users.find((u) => u.id === currentUserId);
  if (!user || !user.is_active) return false;

  const profile = profiles.find((p) => p.id === user.profile_id);
  if (!profile) return false;

  // Admin bypass — an admin profile can do anything to any model. This
  // prevents the "stale model_permissions array" class of bug: if new models
  // were created after the profile was last saved, the admin still has
  // access to them without the array being manually re-saved.
  if (profile.is_admin) return true;

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
  if (currentUserId === null) {
    return new Set(ALL_PERMISSIONS);
  }

  const user = users.find((u) => u.id === currentUserId);
  if (!user || !user.is_active) return new Set();

  const profile = profiles.find((p) => p.id === user.profile_id);
  if (!profile) return new Set();

  // Admin bypass — same rule as hasPermission.
  if (profile.is_admin) return new Set(ALL_PERMISSIONS);

  const modelPerms = profile.model_permissions.find((mp) => mp.model_id === modelId);
  if (!modelPerms) return new Set();

  return new Set(modelPerms.permissions);
}
