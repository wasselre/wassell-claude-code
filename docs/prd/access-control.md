# PRD: Access Control (Users, Roles, Profiles)

**Status:** Live
**Last updated:** 2026-04-22
**Related PRDs:** model-builder.md, record-management.md, workflow-automation.md

> **2026-04-22 update:** Sign-in identity is now bound to the in-app `users`
> row automatically. When a user signs in through Supabase Auth, the store's
> `initialize()` looks them up by email (case-insensitive) and sets
> `currentUserId`. A first-ever sign-in into a fresh install adopts the seeded
> admin row so the first admin has no provisioning step. The `/settings/users`
> page now ships a magic-link **invite flow**: creating a new user can send
> them a one-click sign-in email, and every row has a **Resend invite**
> button. The header's user-switcher dropdown is hidden whenever Supabase
> Auth is configured — it's a dev-only fallback.

> **2026-04-19 update:** Role schemas now use the **same builder as models** —
> sections, all 21 field types, all per-field options. A role is no longer a
> flat list of fields; it has a `schema` with the same shape as `AppModel.schema`.
> The Model Builder's `SectionManager` and `FieldEditor` are reused directly
> for roles via an `ownerKind='role'` prop that skips model-specific rename
> propagation. Legacy `field_definitions` are auto-migrated into a single
> "General" section on first boot.

## What it is (in plain English)
Three layers decide who can see and do what:
1. **Users** — the actual people logging into the app.
2. **Profiles** — the *permission bundle*. Each profile defines, per model, which of six actions (View, Create, Edit, Delete, Import, Export) the profile's users can perform. One profile also carries an `is_admin` flag that gates the admin-only areas of the app (Builder, Workflows, Dashboards, Settings).
3. **Roles** — a *relationship with structured data*. A role is itself a mini-schema: it has its own custom fields (e.g. "Region" dropdown, "Task Count" number, "Manager" lookup). Users hold zero or more roles, and each role-assignment has its own field values. Workflows use these role fields to find the right assignee at run-time (e.g. "assign to the Sales Rep where Region = record.region").

## Why it exists
Real-estate offices have clear hierarchies (researchers, salespeople, managers, owners) and territorial splits (by city or neighborhood). Rather than hard-coding roles, admins define custom roles with their own fields, and bind profile-based permissions per model. The admin flag keeps the power-user areas of the app out of the hands of daily sales staff.

## Key behaviors
- **Sign-in ↔ in-app user binding:** Supabase Auth owns credentials and sessions (`src/lib/auth.ts`). After sign-in, `initialize()` in `appStore` matches `session.user.email` (lowercased) against `users.email` and sets `currentUserId`. No match → `currentUserId = null` and the app renders a fail-closed state (permissions evaluate to false). The header shows a read-only name pill when auth is configured; the dev-only dropdown switcher only appears when Supabase is not configured.
- **First-admin bootstrap:** if a fresh install has exactly one user row AND it is the default seed admin (`admin@wassel.sa`), the first sign-in rewrites that row's email to the signed-in address and claims it. This removes the chicken-and-egg problem for the first admin.
- **Invite flow:** creating a user in `/settings/users` ships with a "Send invite email" checkbox (checked by default when Supabase is configured). On save, after the `users` row is created, the app calls `supabase.auth.signInWithOtp({ email, shouldCreateUser: true })` which emails the invitee a one-click sign-in link. Clicking it creates the Supabase Auth account (if absent), signs them in, and the email→user binding above picks up the row the admin just created. Every existing user row has a **Resend invite** button (mail icon) that re-sends the same magic link; safe to click repeatedly (Supabase rate-limits it). Invite failures are surfaced in a toast but do NOT roll back the saved user row — the admin can retry via the row button.
- **Users** (`/settings/users`) — list, create, edit, delete users. Each user has email, bilingual name, an `is_active` flag, a single profile, and zero or more role assignments. Role checkboxes AND their field values are edited together in one modal.
- **Profiles** (`/settings/profiles`, `/settings/profiles/:profileId`) — manage the 6-action × N-models permission matrix. Two seeded profiles: `Administrator` (full access, `is_admin: true`, `is_system: true`) and `Sales` (client-facing models only). The `is_admin` and `is_system` flags are displayed as badges — they are read-only in the UI.
- **Roles** (`/settings/roles`, `/settings/roles/:roleId`) — define role schemas with **sections + all 21 field types** (text, textarea, number, email, phone, date, datetime, currency, url, checkbox, dropdown, multiselect, lookup, mirror, section_mirror, section_selector, assignee, notes, range, auto_id, formula). Same builder UX as models: drag-and-drop sections, per-field options (required, width, show-in-table, API name, color-coded dropdown options, lookup source + display field, formula expressions, etc.), plus the field template catalog. The Members tab is a read-only directory showing who holds the role and the current values of their role-fields. Field types that don't operate on records (auto_id, mirror, section_mirror, assignee, section_selector) render a disabled "not applicable in role context" placeholder in the user editor.
- **Permission checks:** `usePermission(modelId, action)` and `useIsAdmin()` hooks. Pure functions live in `src/lib/permissions.ts`.
- **Route guards:** `<RequireAdmin>` wraps admin-only routes (Builder, Workflows, Dashboards, Translations, Profiles, Roles, Users settings). Non-admins are redirected to `/` with an access-denied toast.
- **Sidebar filter:** models a user lacks `view` on are hidden from the nav; groups with zero visible models are hidden too.
- **Workflow assignment via role field:** a workflow action can say "assign this record to the user who holds role *Regional Manager* where *Region = record.region*". If the referenced role is later deleted, the Workflow editor surfaces a red warning next to the role picker.

## Invariants (enforced in the store)
Every destructive mutation returns `{ ok: true } | { ok: false, reason }`. UI guards (disabled buttons, hidden options) are ergonomic; the store is the single source of truth.

- **System profiles/roles cannot be deleted.** `is_system: true` short-circuits delete with `reason: 'is_system'`.
- **Profile delete is blocked while any user references it** (`reason: 'has_users'`). Admin must reassign users first — no silent re-assignment.
- **Role delete cascades:** the role is removed AND all `role_assignments` pointing at it are pruned from every user. No dangling references on users. Referring workflows keep their dangling `role_id` so the Workflow editor can warn (no auto-fix).
- **Self-delete is blocked** (`reason: 'self_delete'`).
- **Last active admin cannot be deleted or deactivated** (`reason: 'last_admin'`). Applies to `deleteUser` and to `saveUser` when deactivating the last admin or flipping them to a non-admin profile.
- **User save requires a valid profile** (`reason: 'missing_profile'`). The Save button is disabled in the UI; the store validates regardless.
- **Destructive actions always confirm** — user/profile/role delete, user deactivate all use the standard `Modal` confirmation pattern.

## Admin gate
Admin-only routes:
- `/builder`, `/builder/:modelId`
- `/workflow`, `/workflow/:workflowId`
- `/dashboards`, `/dashboards/:dashboardId`
- `/settings/translations`
- `/settings/profiles`, `/settings/profiles/:profileId`
- `/settings/roles`, `/settings/roles/:roleId`
- `/settings/users`

Non-admin-accessible routes: `/`, `/model/:modelName`, `/model/:modelName/new`, `/model/:modelName/:recordId`, `/settings` (landing — but the cards grid filters to admin-only cards and shows an empty state for non-admins), `/public/dashboard/:token`.

## User flows
1. **Create a profile:** `/settings/profiles` → "+ New Profile" → give name → PermissionMatrix shows every model with 6 toggles + "All" → save. New profiles are never `is_admin` or `is_system`.
2. **Create a role definition:** `/settings/roles` → "+ New Role" → give name → add custom fields (like a mini-model) → save.
3. **Create a user:** `/settings/users` → "+ New User" → fill name + email → pick profile (defaults to first; empty option removed) → check any roles and fill their field values inline → leave "Send invite email" checked → save. The invitee gets a one-click sign-in email; clicking it logs them in bound to the row you just created. If they didn't get it (spam, typo), click the mail icon on their row to resend.
4. **Restrict access:** Change a profile's matrix → users with that profile immediately lose access in the UI (sidebar hides models, buttons disappear, record pages gate by permission).
5. **Dynamic assignment:** In a workflow `assign_user` action or a `role_variable` field mapping, pick a role and add conditions that match role fields to trigger-record fields. At run time the engine finds the matching user.

## Data touched
- Reads/writes: `users`, `profiles`, `roles` (mirrored in localStorage + Supabase when configured).
- Reads: `models` (to render the PermissionMatrix and filter the sidebar).
- Consumed by: `usePermission`, `useModelPermissions`, `useIsAdmin` hooks, `RequireAdmin` guard, `workflowEngine` (`assign_user` actions and `role_variable` field mappings).

## Key files
| File | What it does |
|---|---|
| `src/pages/Settings/UsersPage.tsx` | User list, create/edit modal with inline role-field editor, delete + deactivate confirmations, Send-invite checkbox on create, Resend-invite button per row |
| `src/lib/auth.ts` | Supabase Auth wrapper — `signIn`, `signOut`, `getSession`, `onAuthChange`, `sendPasswordResetEmail`, `updatePassword`, `inviteUser` (magic-link invite via `signInWithOtp`) |
| `src/pages/Login.tsx`, `src/pages/auth/ResetPassword.tsx` | Sign-in page and password-recovery landing page |
| `src/pages/Settings/ProfilesPage.tsx` | Profile list and editor; system badge; delete guard UI |
| `src/pages/Settings/components/PermissionMatrix.tsx` | Model × 6-action toggle grid |
| `src/pages/Settings/RolesPage.tsx` | Role list + editor. Wraps each role as an `AppModel`-shaped object and delegates to `SectionManager` with `ownerKind='role'` for the full builder UX. Read-only Members table supports all field-type displays. |
| `src/pages/Builder/components/SectionManager.tsx` | Shared builder (used by both models and roles). `ownerKind` prop gates rename propagation. |
| `src/pages/Builder/components/FieldEditor.tsx` | Shared field editor. `ownerKind='role'` skips `renameField` propagation (role-field slugs aren't referenced in records/workflows/views). |
| `src/pages/Settings/components/UserRoleFields.tsx` | Inline role-field editor on the User modal. Uses `DynamicField` from the record form for all supported types. |
| `src/lib/roleSchema.ts` | Helpers: `roleFields(role)` flattens sections into ordered list; `emptyRoleSchema()` builds the default single-section schema for new roles. |
| `src/hooks/usePermission.ts` | `usePermission`, `useModelPermissions`, `useIsAdmin` |
| `src/lib/permissions.ts` | Permission evaluation + `isAdmin` |
| `src/components/guards/RequireAdmin.tsx` | Route guard that redirects non-admins |
| `src/components/layout/Sidebar.tsx` | Filters models by `view` permission |
| `src/components/layout/Header.tsx` | Read-only signed-in pill when auth is on; dev-only user-switcher dropdown when auth is off; sign-out button |
| `src/stores/appStore.ts` | `bindAuth` / `signOutAndClear`, email→user lookup + seed-admin bootstrap inside `initialize()` |
| `src/pages/Workflow/components/ActionList.tsx` | `assign_user` action + role-variable mapping; dangling-role warning |
| `src/types/index.ts` | `User`, `Profile`, `Role`, `UserRoleAssignment`, `StoreMutationResult` |
| `src/data/seedUsers.ts` | Seeded admin + Sales profiles, seeded roles, seeded admin user |
| `src/stores/appStore.ts` | `users`, `profiles`, `roles` state; invariant enforcement; migration/heal |

## Open questions / known limitations
- **Invite requires Supabase "Allow new users to sign up" ON.** The magic-link invite uses `signInWithOtp({ shouldCreateUser: true })`, which Supabase blocks when sign-ups are disabled. If stricter control is required, the invite call should be moved to an Edge Function using `auth.admin.inviteUserByEmail` with the service-role key.
- **No row-level permissions** — can't say "user X can only see records they own". RLS is currently "any authenticated user sees everything"; `schema.sql` has a v2 plan for `owner_user_id` columns but it is not implemented.
- **No field-level permissions** — access is per-model only.
- **No audit log** of permission or role-assignment changes.
- **No bulk reassignment** UI when deleting a profile. Admin must manually reassign each user first.
- **Role lookup fields are single-select only** (`is_multi` on role fields is not yet supported).
- **Workflows referencing a deleted role** show a warning but no auto-suggestion for a replacement.
- **No deactivation enforcement at sign-in.** A user flipped to `is_active: false` can still receive a magic link and sign in; access-denied only kicks in once the app evaluates permissions. True lockout needs either an Edge Function check or RLS gating by `is_active`.
