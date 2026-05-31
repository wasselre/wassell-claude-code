import type { ModelField, User } from '@/types';

/**
 * Returns the active users eligible to be picked in an `assignee` field,
 * applying the field's filter mode + role/profile constraints.
 *
 * Modes:
 *   'all'        → every active user
 *   'restricted' → active users whose `profile_id` is in
 *                  `assignee_profile_ids` OR who have any role in
 *                  `assignee_role_ids` (union)
 *
 * Backward compat: a field saved before the mode flag was introduced has
 * `assignee_user_filter_mode === undefined`. We infer the mode from the
 * existing data — empty constraints means "all users" (the historical
 * behavior of TableView / FieldFilterPopover / FieldValueInput; the form
 * input in DynamicField used to incorrectly show no users in that case,
 * which this helper fixes).
 */
export function filterEligibleAssignees(field: ModelField, users: User[]): User[] {
  const active = users.filter((u) => u.is_active);
  const roleIds = field.assignee_role_ids ?? [];
  const profileIds = field.assignee_profile_ids ?? [];

  const mode: 'all' | 'restricted' =
    field.assignee_user_filter_mode ??
    (roleIds.length === 0 && profileIds.length === 0 ? 'all' : 'restricted');

  if (mode === 'all') return active;

  return active.filter((u) => {
    if (profileIds.includes(u.profile_id)) return true;
    return u.role_assignments.some((ra) => roleIds.includes(ra.role_id));
  });
}

/** True iff the field places no constraints — i.e. any active user is eligible. */
export function isUnrestrictedAssignee(field: ModelField): boolean {
  const roleIds = field.assignee_role_ids ?? [];
  const profileIds = field.assignee_profile_ids ?? [];
  const mode =
    field.assignee_user_filter_mode ??
    (roleIds.length === 0 && profileIds.length === 0 ? 'all' : 'restricted');
  return mode === 'all';
}
