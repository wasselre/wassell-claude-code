# PRD: Access Control (Users, Roles, Profiles)

**Status:** Live
**Last updated:** 2026-05-05
**Related PRDs:** model-builder.md, record-management.md, workflow-automation.md

> **2026-05-05 update:** Profile permissions now have THREE composable layers
> per model — actions (the existing 6-toggle matrix), **record scopes** (which
> records this profile can see/edit, expressed as filter rules), and **field
> rules** (per-field hidden / read-only / editable). The PermissionMatrix UI
> was rewritten as a per-model expandable card surfacing all three layers.
> Records gained a `created_by_user_id` column (set on first save) so admins
> can express "records I created" without forcing every model to expose a
> creator field. Filter rules can reference user-context value sources —
> `current_user` (the signed-in user's id) and `role_field` (a value on the
> user's role assignment) — so a single rule like "Region = my Region"
> applies per-user without per-user customization. Scope and field-rule
> enforcement is currently APP-LAYER only; RLS remains `USING (true)` and is
> the next milestone (see "Open questions / known limitations").

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
2. **Profiles** — the *permission bundle*. Per model, a profile expresses three things:
   - **Actions** — six toggles (View, Create, Edit, Delete, Import, Export) gating the model-wide capability.
   - **Scopes** — *which records* the profile can see (`view_scope`) and edit (`edit_scope`). Each is either `all` or a list of filter conditions AND'd together. Conditions can target either a model field or the synthetic `created_by_user_id` column, and compare against a literal, the current signed-in user, or a value from the user's role assignment. Edit-scope is always narrowed by view-scope at evaluation — a record the user can't see is never editable.
   - **Field rules** — per-field overrides (`hidden` / `readonly` / `editable`). Computed field types (formula, auto_id, mirror, section_mirror) are forced to `readonly` regardless of config.
   One profile also carries an `is_admin` flag that gates the admin-only areas of the app (Builder, Workflows, Dashboards, Settings) AND bypasses scopes + field rules entirely.
3. **Roles** — a *relationship with structured data*. A role is itself a mini-schema: it has its own custom fields (e.g. "Region" dropdown, "Task Count" number, "Manager" lookup). Users hold zero or more roles, and each role-assignment has its own field values. Workflows use these role fields to find the right assignee at run-time (e.g. "assign to the Sales Rep where Region = record.region"). Profile scopes use them in the inverse direction (e.g. "show records where record.region = my role's Region").

## Why it exists
Real-estate offices have clear hierarchies (researchers, salespeople, managers, owners) and territorial splits (by city or neighborhood). Rather than hard-coding roles, admins define custom roles with their own fields, and bind profile-based permissions per model. The admin flag keeps the power-user areas of the app out of the hands of daily sales staff.

## Key behaviors
- **Sign-in ↔ in-app user binding:** Supabase Auth owns credentials and sessions (`src/lib/auth.ts`). After sign-in, `initialize()` in `appStore` matches `session.user.email` (lowercased) against `users.email` and sets `currentUserId`. No match → `currentUserId = null` and the app renders a fail-closed state (permissions evaluate to false). The header shows a read-only name pill when auth is configured; the dev-only dropdown switcher only appears when Supabase is not configured.
- **First-admin bootstrap:** if a fresh install has exactly one user row AND it is the default seed admin (`admin@wassel.sa`), the first sign-in rewrites that row's email to the signed-in address and claims it. This removes the chicken-and-egg problem for the first admin.
- **Invite flow:** creating a user in `/settings/users` ships with a "Send invite email" checkbox (checked by default when Supabase is configured). On save, after the `users` row is created, the app calls `supabase.auth.signInWithOtp({ email, shouldCreateUser: true, emailRedirectTo: '<origin>/auth/reset-password' })` which emails the invitee a one-click sign-in link. Clicking it creates the Supabase Auth account (if absent), signs them in, and lands them on `/auth/reset-password` so they pick a password — this turns every subsequent login into a plain email + password flow on the Login page. The email→user binding in `initialize()` picks up the row the admin just created as soon as the invitee is signed in. Every existing user row has a **Resend invite** button (mail icon) that re-sends the same magic link; safe to click repeatedly (Supabase rate-limits it). Invite failures are surfaced in a toast but do NOT roll back the saved user row — the admin can retry via the row button.
- **Users** (`/settings/users`) — list, create, edit, delete users. Each user has email, bilingual name, an `is_active` flag, a single profile, and zero or more role assignments. Role checkboxes AND their field values are edited together in one modal.
- **Profiles** (`/settings/profiles`, `/settings/profiles/:profileId`) — manage the 6-action × N-models permission matrix. Two seeded profiles: `Administrator` (full access, `is_admin: true`, `is_system: true`) and `Sales` (client-facing models only). The `is_admin` and `is_system` flags are displayed as badges — they are read-only in the UI.
- **Roles** (`/settings/roles`, `/settings/roles/:roleId`) — define role schemas with **sections + all 21 field types** (text, textarea, number, email, phone, date, datetime, currency, url, checkbox, dropdown, multiselect, lookup, mirror, section_mirror, section_selector, assignee, notes, range, auto_id, formula). Same builder UX as models: drag-and-drop sections, per-field options (required, width, show-in-table, API name, color-coded dropdown options, lookup source + display field, formula expressions, etc.), plus the field template catalog. The Members tab is a read-only directory showing who holds the role and the current values of their role-fields. Field types that don't operate on records (auto_id, mirror, section_mirror, assignee, section_selector) render a disabled "not applicable in role context" placeholder in the user editor.
- **Permission checks:** `usePermission(modelId, action)` and `useIsAdmin()` for the action layer; `useCanViewRecord(model, record)` and `useCanEditRecord(model, record)` for record-level checks composing view_scope + edit_scope; `useFieldPermission(modelId, field)` (single-field) and `useFieldPermissionResolver(modelId)` (callback for parent components walking field lists) for field rules; `useApplyViewScope(model, records)` to filter a list down to visible records. Pure functions live in `src/lib/permissions.ts`; the scope condition evaluator lives in `src/lib/scopeFilters.ts`.
- **Scope evaluation:** A condition AND'd into a filter compares the record's value (`record.data[field.name]` or `record.created_by_user_id` for the synthetic `created_by` target) against the resolved source. Sources: `literal` (hardcoded value), `current_user` (signed-in user's id, used with `created_by` or `assignee` targets), `role_field` (`user.role_assignments[role_id].field_values[field_slug]`). When a user-context source can't resolve (user holds no such role, no value set), the condition fails closed — no record matches. Empty conditions arrays pass everything (so a half-built rule doesn't lock the user out mid-edit). Operators mirror dashboard filters: `equals` / `not_equals` / `contains` / `greater_than` / `less_than` / `is_empty` / `is_not_empty`.
- **Record stamping:** On first `saveRecord`, `created_by_user_id` is set to `currentUserId`. Preserved across edits — it's "who created" not "who last touched." Records saved without an active session (offline / pre-auth) stay null and are treated as "no known creator" by scope filters.
- **Form integration:** `RecordFormPage` uses `useCanViewRecord` to gate access entirely (failing → render the same 404 state as a missing record so the URL never confirms existence) and `useCanEditRecord` to flip into read-only mode (Save button hidden, fields rendered as `DynamicCell` inside a disabled-input shell). `SectionBlock` accepts `formReadOnly` + `getFieldPermission`; hidden fields are removed from layout, readonly fields render as DynamicCell inside the same disabled shell the mirror system already uses for non-editable mirror fields.
- **Lookup pickers respect view-scope.** `LookupCombobox` filters its candidate list through `useApplyViewScope`. Already-selected records resolve from the unfiltered list so a previously-saved selection still displays after view-scope tightens — only the dropdown's *candidate* list is gated.
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
| `src/pages/Settings/components/PermissionMatrix.tsx` | Per-model expandable card: 6 action toggles + view/edit scope editors + per-field hidden/readonly/editable rules |
| `src/pages/Settings/components/ScopeConditionEditor.tsx` | Filter-condition row builder used inside both the view-scope and edit-scope sections of `PermissionMatrix` — picks target (model field or `created_by`), operator, and value source (literal / current user / role field) |
| `src/lib/scopeFilters.ts` | Scope evaluator: resolves user-context value sources, walks conditions, returns boolean per record. Evaluator + `applyScope` filter helper |
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
- **Enforcement is APP-LAYER only.** `is_admin` bypass, action checks, view/edit scopes, field rules — all evaluated in React. Postgres RLS on every business table is still `USING (true) WITH CHECK (true)` for authenticated users. A user who bypasses the React layer (DevTools, direct Supabase query with the anon key) can read and write any record in the workspace. The next milestone is to migrate scope rules into RLS policies — the condition shape in `scopeFilters.ts` was designed to translate 1:1 to SQL. **Until that ships, treat scope/field rules as UX guardrails, not security controls.**
- **Invite requires Supabase "Allow new users to sign up" ON.** The magic-link invite uses `signInWithOtp({ shouldCreateUser: true })`, which Supabase blocks when sign-ups are disabled. If stricter control is required, the invite call should be moved to an Edge Function using `auth.admin.inviteUserByEmail` with the service-role key.
- **No audit log** of permission, scope, field-rule, or role-assignment changes.
- **No bulk reassignment** UI when deleting a profile. Admin must manually reassign each user first.
- **Role lookup fields are single-select only** (`is_multi` on role fields is not yet supported).
- **Workflows referencing a deleted role** show a warning but no auto-suggestion for a replacement.
- **No deactivation enforcement at sign-in.** A user flipped to `is_active: false` can still receive a magic link and sign in; access-denied only kicks in once the app evaluates permissions. True lockout needs either an Edge Function check or RLS gating by `is_active`.
- **Scope conditions on structured fields are limited.** `range`-type fields can be compared via `field_path: 'min' | 'max'` (mirroring dashboard filter behavior), but `multiselect` / `lookup is_multi` fields use scalar comparison — equality against an array always fails. Use `contains` for substring matches against the JSON serialization or split into multiple OR conditions (not yet supported — filters are AND-only).
- **Read-only fields are skipped during create.** When a profile marks a field `readonly`, that field doesn't appear in the create form — the value is populated by defaults / workflows / formulas, never by the creator. ("Create-only" semantics — set on insert, locked after — is not supported. Add a 4th state if real-world demand emerges.)
- **`current_user` against a free-text field doesn't work usefully.** It compares the raw user UUID against the field value, which is almost never what an admin wants. Use it with `created_by` or `assignee`-typed fields where the value is also a user id.
