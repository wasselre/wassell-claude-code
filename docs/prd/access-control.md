# PRD: Access Control (Users, Roles, Profiles)

**Status:** Live (user-management feature complete; locked for ~6 months)
**Last updated:** 2026-08-16 (new **Reference (data-only) module access + auto-dependency grants**. A profile's per-model grant (`ProfileModelPermissions`) gained two frontend-only fields: `hidden_from_sidebar` (nav-only hide — the profile can read this model's data but gets no sidebar button for it, decoupling "can read" from "is a place I navigate to") and `auto_reference` (marks a grant the editor auto-added). In the profile editor's PermissionMatrix, toggling `view` ON for a module now computes its display-dependency closure — every OTHER module it shows data from through `lookup` / `mirror` / `section_mirror` fields, walked transitively by `resolveModelDataDependencies` (`src/lib/moduleDependencies.ts`) — and auto-adds a read-only, `hidden_from_sidebar` + `auto_reference` `view` grant (scope: all) for each. So granting a marketing profile "Our Projects" no longer requires hand-enumerating geography / units / developers / all_projects for its mirrored fields to resolve, and none of those clutter the profile's sidebar. The auto-added grants surface as removable "reference modules" chips at the top of the matrix (each with a show-in-sidebar eye toggle + an ✕ remove); they fire ONLY on an explicit view toggle (never continuously), are pruned when the module that pulled them in loses `view`, and are promoted to intentional grants — cleared `auto_reference`, never auto-pruned — the moment an admin customizes the entry (adds an action, sets a scope). **Frontend-only, no migration, no RLS change:** a reference grant is an ordinary `view` grant to the DB (`saveProfile` spreads the extra keys into the JSONB `model_permissions` untouched); `hidden_from_sidebar` is read only by the Sidebar via the new `isModelSidebarHidden` permissions helper (admins ignore it — they always see every model). Prior: 2026-07-22 (new **Profile preview — "view app as another profile"**. A per-user grant `users.can_preview_profiles` (BOOLEAN, **OFF by default** — migration `2026-07-22_user_can_preview_profiles.sql`) is toggled by an admin from Settings → Users ("السماح بمعاينة الملفات الشخصية" checkbox in the user modal; an Eye badge on the user card shows who has it). Granted users get an Eye switcher pill in the Header listing every other profile (non-admin grantees can't pick admin profiles); choosing one sets `previewProfileId` in the store (persisted to `wassell_preview_profile_id`, survives reload, cleared on sign-out / user switch / Exit). The whole client permission layer — every function in `src/lib/permissions.ts` takes an optional trailing `previewProfileId`, honored inside `resolveActiveProfile` ONLY when the user carries the grant — then evaluates the previewed profile: sidebar model/page links, admin gates (`RequireAdmin`, activity-log link, Builder button — now hidden for non-admins), page access, field rules, saved-view/button visibility, and the client-side view-scope re-filter. A gold banner under the header ("وضع المعاينة … إنهاء المعاينة") is gated on the REAL user's grant, so the exit is always reachable even while previewing a profile with no access. **UI perspective only:** RLS still evaluates the real `auth.uid()`, so records shown are the real user's server-filtered set narrowed by the previewed profile's client rules — the preview can narrow, never widen. Scope conditions using `current_user` / `role_field` still resolve against the real user (same person, different profile). New helper `resolveEffectiveProfile` is used by Sidebar + MarketIntelligencePage instead of raw `profile_id` lookups. Prior: 2026-06-30 — new profile-assignable **Sales Rep workspace** — two custom pages `my_clients` (`/sales/my-clients`) + `my_tasks` (`/sales/my-tasks`) added to `src/lib/customPages.ts` with `default_access: 'admin'` (opt-in). They auto-wire into the Sidebar, the `PageAccessMatrix` profile toggles, and `RequirePageAccess` route guards with zero extra plumbing — adding a `CUSTOM_PAGES` entry is the only change needed. Reps see only their own clients/tasks (scoped by `client_owner` / `sales_rep` === current user); admins see all + a rep filter / "All reps" toggle. Pure frontend — no migration; the page-access keys live in the existing `profiles.page_access` JSONB. New area PRD: `sales-rep-workspace.md`. Prior: 2026-06-21 — invite/delete Edge Functions: gateway `verify_jwt` turned OFF for `invite-user` + `delete-user`. The reported `"فشل إرسال الدعوة: Failed to send a request to the Edge Function"` was the gateway rejecting the POST's JWT *before* the function ran and returning a CORS-less 401 — which the browser surfaced as an opaque supabase-js `FunctionsFetchError`. Both functions already do full internal auth (Bearer → `auth.getUser()` → `wassell_is_admin`), so the gateway check was redundant; turning it off makes every auth outcome return a readable, CORS-bearing JSON error. Pinned in new `supabase/config.toml`. Deployed to prod via MCP — `invite-user` v3, `delete-user` v2. Prior: 2026-06-18 — per-profile READ access to the workflow subsystem — the Sales Process Studio reads the `workflows` table to show each phase's linked workflow, but that table was admin-only at the DB, so a non-admin granted the Studio page loaded ZERO workflows and saw every activity as "Missing workflow." Added a `profiles.can_view_workflows` flag + `wassell_can_view_workflows` RLS helper; the `workflows` + `workflow_groups` FOR-ALL admin policy was split into SELECT (can-view) / INSERT-UPDATE-DELETE (admin), and `workflow_runs_read` now allows can-view too. New `RequireWorkflowView` guard opens the read-only run-history routes (`/workflow/logs*`) to granted profiles; the Studio shows "Open in Workflow Builder" admin-only and "View Runs" to viewers; the logs Clear-all / run Delete buttons are admin-only. EDITING workflows + the Builder editor stay admin-only. A "Can see workflows" toggle sits in the profile editor's Sales Operations card. Migration `2026-06-18_workflow_view_access.sql`. Prior same-day: per-profile access to the custom Sales Operations pages — Sales Tasks / Sales Process / Sales Manager are React pages, not models, so they can't ride the `model_permissions` matrix. Added a `page_access` JSONB map on `profiles` + a small registry `src/lib/customPages.ts` with each page's `default_access` ('all' or 'admin'); an admin grants/revokes per page per profile in Settings → Profiles. Defaults preserve prior behavior exactly: Sales Tasks open to all, Sales Process + Sales Manager admin-only. New `RequirePageAccess` guard replaces the blanket `RequireAdmin` on the three `/sales/*` routes; sidebar links render from the registry gated by `canAccessPage`. Migration `2026-06-18_profile_page_access.sql`. Prior: 2026-06-17 — added the `sales_process_overrides` table to the per-table policy posture — admin write, authenticated read; written from the Sales Manager page, read by every rep's Follow-up Workspace. Prior: 2026-06-16 — duplicate seeded profiles/roles fixed: a DB restore/branch can reintroduce a system seed under a drifted id alongside the canonical one, so id-only seed matching produced label duplicates (prod had 2× Administrator, 2× Sales Manager, 2× Sales Rep). Cleaned up + added DB-level `profiles_system_label_uniq` / `roles_system_label_uniq` partial unique indexes and made the SPA seed backfill dedupe by id AND system-seed label — see migration `2026-06-16_dedup_seed_roles_profiles.sql`. Prior: 2026-06-08 — deleting a user now also removes the Supabase Auth identity via the `delete-user` Edge Function, and invite/delete toasts surface the real GoTrue reason)
**Related PRDs:** model-builder.md, record-management.md, workflow-automation.md, data-storage.md, logs.md

> **2026-05-24 — `auth_uid` binding deadlock fixed.**
>
> The Phase 1 (2026-05-06) RLS pass shipped with a chicken-and-egg in the
> `users_write` policy: `USING (wassell_is_admin(...) OR users.auth_uid =
> auth.uid())`. A newly-invited user's row has `auth_uid = NULL` and they
> aren't admin yet, so both legs evaluate false and PostgREST silently
> filtered their first-sign-in `bindAuthUidToUser` UPDATE to zero rows.
> From RLS's perspective the user then didn't exist, and every records
> query returned `[]` — invited users saw empty workspaces for 18 days
> before this was caught.
>
> The fix lands two complementary paths so the same bug can't return
> through a different door:
>
> - **`bind_my_auth_uid()`** — SECURITY DEFINER RPC (`public`) that
>   atomically binds the caller's `auth.uid()` to the matching
>   `public.users` row (case-insensitive email match, `auth_uid IS NULL`
>   guard so existing bindings can't be hijacked, `is_active = true`).
>   Called from `initialize()` instead of the broken upsert. Heals every
>   existing broken user on their next page load — no manual SQL needed.
> - **`invite-user` Edge Function** also binds `auth_uid` atomically via
>   service role right after `auth.admin.inviteUserByEmail` succeeds.
>   New invites land pre-bound; the RPC is the heal/backstop path.
> - **`supabaseUpsert` now detects zero-rows-returned** on an upsert
>   that targeted a known id and surfaces it as a loud error toast
>   (CLAUDE.md → "Silent Failures"). The same class of bug now fails
>   loudly instead of hiding for weeks.

> **2026-05-07 — Production RLS + privilege hardening (Phases A.1, A.4, B.1–B.4, B-followup).**
>
> The full database access surface was tightened in one pass. Highlights:
>
> - **A.1 — RLS init-plan wraps.** Every `auth.uid()` reference inside an RLS policy was rewritten as `(SELECT auth.uid())` so Postgres evaluates it once per query as an InitPlan node, not once per row. Logically identical RLS; ~10–100× planner improvement at scale. Also patched the `regenerate_frozen_model_artifacts` policy generator so future freezes emit the wrapped form, then re-regenerated artifacts for every existing frozen model. Resolves Supabase advisor `auth_rls_initplan` (24 → 0).
> - **A.4 — `SET search_path = public, pg_temp`** on every SECURITY DEFINER function in `public`. Closes the search-path attack surface where an unprivileged user could shadow `public.records` (or any other catalog object) by creating a same-named object in a schema earlier on the search path. Resolves `function_search_path_mutable` (12 → 0).
> - **B.1 + B.2 — `REVOKE EXECUTE FROM PUBLIC` on every public-schema function**, then explicit `GRANT EXECUTE` only to the roles that should have access. The frontend bundle ships the public anon key — without this, anyone could `curl POST /rest/v1/rpc/freeze_model` or `/rpc/drop_model_view`. After the migration: `anon` keeps **only** `get_public_dashboard`. `authenticated` keeps `record_save` / `record_delete` / `wassell_*` RLS helpers / `try_*` view casts / `get_public_dashboard` / `search_all_projects`. `service_role` is unaffected (Vercel API routes / webhooks / triggers). Resolves `anon_security_definer_function_executable` (24 → 1) and `authenticated_security_definer_function_executable` (24 → ~10 legitimate).
> - **B.3 — `activity_log` RLS split into per-command policies.** The previous `Authenticated full access` USING(true) WITH CHECK(true) FOR ALL policy let any user read every other user's actions and rewrite history via UPDATE. Now: `activity_log_select` (admin sees all; non-admin sees only their own events), `activity_log_insert` (admin or self-stamped; rejects NULL `actor_user_id` to prevent anonymous logging), `activity_log_delete` (admin only — for retention pruning), and **NO UPDATE policy** — audit logs are now formally **immutable**. Service-role inserts (Vercel API routes, webhooks) bypass RLS entirely.
> - **B.4 — Multiple-permissive policy split.** 9 tables had a `*_read PERMISSIVE SELECT` policy AND a `*_write PERMISSIVE ALL` policy. Postgres evaluates BOTH on every SELECT (OR-combined). Splitting `*_write FOR ALL` into separate `*_insert` / `*_update` / `*_delete` policies means SELECT now has exactly one PERMISSIVE policy. Same RLS logic, different decomposition. Tables: `field_templates`, `model_groups`, `models`, `profiles`, `roles`, `users`, `model_views`, `marketing_operations__facts`, `marketing_operations__sources`. Also patched `freeze_model` so future frozen-model junction tables get the same split. Resolves `multiple_permissive_policies` (9 → 0).
> - **B-followup — 11 always-true policies tightened by category.**
>   - **Webhook-driven** (read for users, write only via service_role): `chat_messages`, `call_logs`, `webhook_payloads` → SELECT for authenticated; INSERT/UPDATE/DELETE only via service_role from `/api/webhook/*`. (`webhook_payloads_consume_update` is intentionally kept open so the marketing UI can mark payloads consumed.)
>   - **Marketing data** (admin write, authenticated read): `competitors`, `posts`, `reels`, `research_questions`.
>   - **Settings** (admin write, authenticated read): `webhook_slugs`, `whatsapp_numbers`.
>   - **Per-user notifications**: `marketing_notifications` → SELECT/UPDATE for owner-or-admin; INSERT/DELETE for admin only.
>   - **Deprecated wa_***: `wa_conversations`, `wa_errors`, `wa_leads` → admin-only for ALL operations.
>   - **Intentionally kept at USING(true)**: `whiteboards`, `whiteboard_folders` (multi-user collaboration design); `workflow_runs_insert` (any save can log).
> - **B.5 — Auth leaked-password protection** is a project-level Supabase dashboard toggle, not a code change. Out of scope for the refactor; flag for the user to enable in Auth → Password requirements.
>
> The result: non-admin sessions get exactly the rows their profile allows even when querying Supabase directly. The client is no longer the trust boundary.

> **2026-05-06 — User-management plan complete (Phases 1–4).**
>
> The four-phase plan from the user-management roadmap shipped end-to-end
> across commits 4515af3, e8ab691, 805bdcd, and the wrap-up commit. The
> system now meets the "perfect simple" target:
>
> - **Phase 1 — Real Enforcement (RLS).** All record reads/writes go
>   through Postgres helper functions (`wassell_can_*_record`,
>   `wassell_user_has_action`, `wassell_record_passes_scope`) that
>   evaluate the same scope/field rules the JS evaluator uses. Admin
>   profiles bypass; non-admin sessions get exactly the rows their
>   profile allows even when querying Supabase directly. `users.auth_uid`
>   binds the in-app user to `auth.users.id` on first sign-in.
> - **Phase 2 — Auth Lockdown.** Inviting a new user goes through the
>   `invite-user` Edge Function (service-role + admin verification);
>   project-level signups can/should be OFF. Deactivated users get
>   force-signed-out at sign-in. Admins must complete TOTP MFA
>   (`/auth/mfa-setup`) before reaching admin routes — `RequireAdmin`
>   probes AAL and bounces aal1 admins through the setup page. Password
>   floor raised to 12 chars (`MIN_PASSWORD_LENGTH`).
> - **Phase 3 — Audit + Self-Service + Public-Token Gate.** Every
>   mutation on users/profiles/roles writes an `audit_log` row with
>   actor + entity + before/after JSONB. New `/settings/audit-log` page
>   surfaces the trail (admin-only). New `/profile` self-service page
>   lets users update their bilingual name, change their password, and
>   manage their MFA factor. The header avatar pill links there. Public
>   dashboards now route through `get_public_dashboard(p_token)`
>   (SECURITY DEFINER) instead of a broad `is_public = true` anon
>   policy — the URL token actually gates access at the DB layer.
> - **Phase 4 — Sign-Off.** Scope filtering is memoized on the resolved
>   active user/profile rather than the full users/profiles arrays so
>   unrelated saves don't invalidate every record list. The profile
>   delete confirmation modal now offers bulk reassignment to a target
>   profile when users still hold the deleted one (each save still
>   respects the last_admin invariant).
>
> **Three project-level Supabase dashboard changes are still required**
> to flip the lockdown switches into the ON position. They can't be set
> via API — they live in the dashboard:
>
> 1. **Auth → Settings → "Allow new users to sign up": OFF**
>    (after this, the only path to a new account is the admin invite
>    flow via `/settings/users`).
> 2. **Auth → Providers → MFA TOTP: ON.** Without this, the MFA
>    enrollment call returns "MFA not enabled" and admins can't pass
>    the aal2 gate.
> 3. **Auth → Password requirements → Minimum length: 12.**
>    The client validates inline; this is the server enforcement.
>
> Until those three flip, the lockdown is half-armed: the code paths
> exist but the project still allows weak passwords and self-signups.
>
> User management is now considered **feature-complete** for ~6 months.
> See "Open questions / known limitations" for the small handful of
> deliberate non-goals (SSO, SCIM, record-level audit, IP allowlisting).

> **2026-05-05 (2nd update):** PermissionMatrix gained two more sections per
> model — **Saved views** and **Custom buttons** — both as deny-list toggles
> on the profile (`hidden_view_ids` / `hidden_button_ids`). Default is
> visible; admins explicitly hide. View visibility additionally exempts the
> author of a view (you can't hide a user's personal view from themselves).
> Wired into `ViewSelector` (via `RecordListPage`'s filter) and the custom-
> button render path in `RecordFormPage`. When an active view becomes hidden
> after a permission change, the list page resets to the Default view.

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
- **Invite flow:** creating a user in `/settings/users` ships with a "Send invite email" checkbox (checked by default when Supabase is configured). On save, after the `users` row is created, the app calls the `invite-user` Edge Function (`src/lib/auth.ts` → `inviteUser`) which, using the service-role key, calls `auth.admin.inviteUserByEmail(email, { redirectTo: '<origin>/auth/reset-password' })` AND atomically `UPDATE public.users SET auth_uid = <new auth.users.id> WHERE email = ? AND auth_uid IS NULL` in the same call. Because both writes happen with service-role access, the chicken-and-egg in the `users_write` RLS policy is avoided — the row is bound *before* the invitee clicks anything. Clicking the link creates the Supabase Auth session and lands them on `/auth/reset-password` to pick a password. The email→user binding in `initialize()` picks up the row immediately. Every existing user row has a **Resend invite** button (mail icon) that re-runs the same Edge Function call; idempotent — re-invites are no-ops on the binding and just refresh the magic link. Invite failures are surfaced in a toast but do NOT roll back the saved user row — the admin can retry via the row button. Project-level "Allow new users to sign up" should be OFF so this Edge-Function path is the only door in. **Gateway JWT verification is OFF (`verify_jwt = false`) for both `invite-user` and `delete-user`** (pinned in `supabase/config.toml`). The functions do their own auth (require a Bearer token → `auth.getUser()` → `wassell_is_admin`), so the gateway check was redundant — and when the gateway rejected a bad/expired JWT it returned a 401 *without* CORS headers, which the browser masked as the opaque `"Failed to send a request to the Edge Function"` (a supabase-js `FunctionsFetchError`). With the gateway out of the way, every auth outcome now returns a readable, CORS-bearing JSON error the client can surface. Do NOT flip `verify_jwt` back on without restoring a CORS-bearing gateway error.
- **First-sign-in `auth_uid` heal:** for users invited BEFORE the 2026-05-24 fix (whose rows are still NULL because the Edge Function didn't yet bind), `initialize()` calls the `bind_my_auth_uid()` SECURITY DEFINER RPC after the email match succeeds. The RPC reads `auth.uid()` + the JWT's email claim server-side, atomically fills any NULL `auth_uid` whose email matches (case-insensitive) and whose `is_active = true`, and returns the bound id (or NULL if no app user matches the JWT email — the caller treats that as access-denied). Idempotent: a re-bind of an already-bound caller returns the existing id without writing. This is the heal-on-reload path; every stuck user unsticks themselves by loading the app once. Never overwrites an existing binding (defense against hijack via a recycled email).
- **Users** (`/settings/users`) — list, create, edit, delete users. Each user has email, bilingual name, an `is_active` flag, a single profile, and zero or more role assignments. Role checkboxes AND their field values are edited together in one modal.
- **Profiles** (`/settings/profiles`, `/settings/profiles/:profileId`) — manage the 6-action × N-models permission matrix, PLUS a **Sales Operations** card (above the model matrix) of per-page toggles for the custom non-model pages (Sales Tasks / Sales Process / Sales Manager) backed by `page_access`. For an admin profile the toggles render checked + disabled (admins always see every page). Two seeded profiles: `Administrator` (full access, `is_admin: true`, `is_system: true`) and `Sales` (client-facing models only). The `is_admin` and `is_system` flags are displayed as badges — they are read-only in the UI.
- **Roles** (`/settings/roles`, `/settings/roles/:roleId`) — define role schemas with **sections + all 21 field types** (text, textarea, number, email, phone, date, datetime, currency, url, checkbox, dropdown, multiselect, lookup, mirror, section_mirror, section_selector, assignee, notes, range, auto_id, formula). Same builder UX as models: drag-and-drop sections, per-field options (required, width, show-in-table, API name, color-coded dropdown options, lookup source + display field, formula expressions, etc.), plus the field template catalog. The Members tab is a read-only directory showing who holds the role and the current values of their role-fields. Field types that don't operate on records (auto_id, mirror, section_mirror, assignee, section_selector) render a disabled "not applicable in role context" placeholder in the user editor.
- **Permission checks:** `usePermission(modelId, action)` and `useIsAdmin()` for the action layer; `useCanViewRecord(model, record)` and `useCanEditRecord(model, record)` for record-level checks composing view_scope + edit_scope; `useFieldPermission(modelId, field)` (single-field) and `useFieldPermissionResolver(modelId)` (callback for parent components walking field lists) for field rules; `useApplyViewScope(model, records)` to filter a list down to visible records. Pure functions live in `src/lib/permissions.ts`; the scope condition evaluator lives in `src/lib/scopeFilters.ts`.
- **Scope evaluation:** A condition AND'd into a filter compares the record's value (`record.data[field.name]` or `record.created_by_user_id` for the synthetic `created_by` target) against the resolved source. Sources: `literal` (hardcoded value), `current_user` (signed-in user's id, used with `created_by` or `assignee` targets), `role_field` (`user.role_assignments[role_id].field_values[field_slug]`). When a user-context source can't resolve (user holds no such role, no value set), the condition fails closed — no record matches. Empty conditions arrays pass everything (so a half-built rule doesn't lock the user out mid-edit). Operators mirror dashboard filters: `equals` / `not_equals` / `contains` / `greater_than` / `less_than` / `is_empty` / `is_not_empty`.
- **Record stamping:** On first `saveRecord`, `created_by_user_id` is set to `currentUserId`. Preserved across edits — it's "who created" not "who last touched." Records saved without an active session (offline / pre-auth) stay null and are treated as "no known creator" by scope filters.
- **Form integration:** `RecordFormPage` uses `useCanViewRecord` to gate access entirely (failing → render the same 404 state as a missing record so the URL never confirms existence) and `useCanEditRecord` to flip into read-only mode (Save button hidden, fields rendered as `DynamicCell` inside a disabled-input shell). `SectionBlock` accepts `formReadOnly` + `getFieldPermission`; hidden fields are removed from layout, readonly fields render as DynamicCell inside the same disabled shell the mirror system already uses for non-editable mirror fields.
- **Lookup pickers respect view-scope.** `LookupCombobox` filters its candidate list through `useApplyViewScope`. Already-selected records resolve from the unfiltered list so a previously-saved selection still displays after view-scope tightens — only the dropdown's *candidate* list is gated.
- **Saved views + custom buttons** are filtered per profile via the deny-lists `hidden_view_ids` and `hidden_button_ids`. Defaults are visible; admins explicitly hide. The view filter exempts the author of each view (`isViewVisible` returns true when `view.user_id === currentUserId`) so a personal saved view is never hidden from its owner. When the active view in `RecordListPage` becomes hidden after a permission change, the page resets to the Default view automatically. Custom buttons on the record form check `isButtonVisible` before rendering.
- **Custom (non-model) page access:** the Sales Operations surfaces — the **Sales Rep workspace** (**My Clients** `/sales/my-clients`, **My Tasks** `/sales/my-tasks`), **Sales Tasks** (`/sales/tasks`), **Sales Process** / Studio (`/sales/process`), **Sales Manager** (`/sales/manager`) — are React pages, not models, so they're gated by a separate per-profile mechanism. A registry (`src/lib/customPages.ts`) lists each page with a `default_access` of `'all'` or `'admin'`. A profile carries a `page_access` map (`{ "<page_id>": true|false }`); an explicit value overrides the default, an absent id falls back to it. `canAccessPage(currentUserId, users, profiles, pageId)` resolves it: no-user → true (pre-init), admin profile → true (always), explicit boolean → use it, else the page's `default_access`. Admins always see every page. Defaults preserve the original behavior — Sales Tasks open to everyone, Sales Process + Sales Manager admin-only — and the two Sales Rep workspace pages (`my_clients` / `my_tasks`) ship `default_access: 'admin'` (opt-in: hidden until an admin grants them to a sales profile). Every page is grantable/revocable per profile in the profile editor. Hook: `useCanAccessPage`. See `sales-rep-workspace.md` for what those two pages contain.
- **Workflow read access (per profile):** the `workflows` / `workflow_groups` / `workflow_runs` tables are admin-only for WRITES, but a profile flagged `can_view_workflows` (or any admin) can READ them. This exists so the Sales Process Studio — grantable to non-admins via page access — can show each phase's linked workflow ("Linked") instead of "Missing workflow"; without read access the non-admin's store loads zero workflows. `canViewWorkflows(currentUserId, users, profiles)` resolves it (no-user → true; admin → true; else `profile.can_view_workflows`), mirrored at the DB by the `wassell_can_view_workflows` RLS helper. A viewer can: see the "Linked" status in the Studio, open the **Workflow Builder READ-ONLY** (the whole canvas + node drawer render with edit affordances suppressed and inputs disabled, so they can inspect the actual trigger / conditions / actions but not change them), and view run history (`/workflow/logs*`). **Editing workflows stays admin-only** — Save / Add-branch / Add-action / delete / the logs "Clear all" + run "Delete" are all hidden for non-admins, and RLS rejects any write regardless. Read-only is threaded via a `readOnly` flag: `WorkflowEditorPage` (`!isAdmin`) → `WorkflowCanvas` → `workflowToGraph` (no "+" pills, plain edges, `readOnly` in node data) + each node component (hide delete/duplicate/add-condition) + `NodeDrawer` (disabled `<fieldset>`). Toggle: the "Can see workflows" checkbox in the profile editor's Sales Operations card. Hook: `useCanViewWorkflows`.
- **Route guards:** `<RequireAdmin>` wraps admin-only routes (Builder, Workflows **list** + **agent**, Dashboards, Translations, Profiles, Roles, Users settings) — it also enforces TOTP MFA (aal2). `<RequirePageAccess pageId>` wraps the three `/sales/*` routes, and `<RequireWorkflowView>` wraps the read-only workflow surfaces — the **editor** (`/workflow/:workflowId`, which renders read-only for non-admins) and the run-history routes (`/workflow/logs`, `/workflow/logs/:runId`) — both use the same redirect-home-with-toast posture as RequireAdmin but WITHOUT the MFA step (these are operational/read-only surfaces meant to be grantable to non-admin sales staff who may legitimately be at aal1). All are UX gates; server-side RLS remains the trust boundary.
- **Reference (data-only) module access:** because cross-module display values (lookup / mirror / section_mirror fields) resolve client-side against the RLS-filtered record set, a profile that can `view` module X but not the modules X mirrors data from sees those fields render blank. To close that without manual enumeration, the profile editor auto-grants read-only access to a module's display-dependency closure when you grant it `view`: `resolveModelDataDependencies(modelId, models)` (`src/lib/moduleDependencies.ts`) DERIVES the closure from the schema rather than a hand-maintained per-field-type list — the earlier cut hard-coded `lookup`, then had to be patched for `location`, then would have needed patching for each new type. It now uses two mechanical passes: **(1) type-agnostic forward extraction** — `collectModelRefs` walks each field definition and harvests every value under a `model_id` / `*_model_id` key, so `lookup_model_id`, `location_levels[].model_id`, and any future field type that stores a model id are covered with no new code (mirror / section_mirror need no special case — they route through a sibling lookup already harvested, and their target is reached by recursion); **(2) declared child modules** — `schema.displayed_child_models` (slugs) lists CHILD modules a model's pages embed as an inline list, e.g. `all_projects` → `units` (the units→project link lives on the child, so a forward scan can't find it). Collecting both per model and recursing yields the exact transitive closure (e.g. our_projects → all_projects → developers + regions/cities/districts + units). The `displayed_child_models` declaration lives on the model as DATA — seeded in `seedModels.ts` and propagated onto existing system models by the always-run `healDisplayedChildModels` heal (since `refreshSystemModels` only inserts, never updates). Geography names (region/city/district) resolve client-side against the RLS-gated `cities`/`districts` records, so without those grants a project's location renders «غير متوفر». Each dependency gets a `{ permissions: ['view'], hidden_from_sidebar: true, auto_reference: true }` grant. These are ordinary `view` grants to RLS — they only differ in that the editor tracks them (`auto_reference`) so it can render them as removable chips and prune them when the granting module loses view. `hidden_from_sidebar` keeps them out of that profile's nav (see next bullet). Toggling view OFF prunes reference deps no longer needed by any intentional (non-`auto_reference`) viewable module; a manually removed reference stays removed (the resolver only adds on an explicit view-ON, never re-adds).
- **Sidebar visibility is decoupled from view:** a per-model `hidden_from_sidebar` flag on the profile grant suppresses the model's sidebar button for that profile even though `view` is granted (data still loads everywhere it's mirrored). The matrix exposes a "Show in this profile's sidebar" toggle per model and a quick eye toggle on each reference chip. Resolved by `isModelSidebarHidden` in `permissions.ts` (admin profiles ignore it — admins always see every model in the nav); the Sidebar composes it with the existing `canView` + static `navHidden` filters.
- **Sidebar filter:** models a user lacks `view` on are hidden from the nav; groups with zero visible models are hidden too. The Sales Operations links render from `CUSTOM_PAGES` filtered through `canAccessPage`, so each link appears only for profiles that can open it. A page may additionally carry `hidden_from_sidebar: true` (since 2026-07-27: Sales Tasks, Sales Studio, Workflow Map, Sales Manager) — that flag is a NAV-ONLY hide, not a permission: the route guard and the per-profile toggle keep working, so a direct URL still opens the page for a permitted user.
- **Workflow assignment via role field:** a workflow action can say "assign this record to the user who holds role *Regional Manager* where *Region = record.region*". If the referenced role is later deleted, the Workflow editor surfaces a red warning next to the role picker.

## Database-side enforcement (post-2026-05-07)
The 2026-05-07 hardening pass moved enforcement out of the client. Treat the client as a UX-helper layer; the database is now the trust boundary.

- **Every public-schema function has its EXECUTE privilege explicitly granted.** `REVOKE EXECUTE ... FROM PUBLIC` was applied to all of `public`. After that, only the explicitly-granted functions are callable via the REST RPC surface:
  - `anon` → `get_public_dashboard(text)` only.
  - `authenticated` → `record_save` (5-arg `(p_model_id, p_id, p_data, p_created_by, p_expected_version)` — the prior 4-arg signature was DROPPED in Phase F.2 to avoid overload ambiguity; `p_expected_version` defaults to NULL so callers that don't track versions are unaffected), `record_delete`, `wassell_app_user_id`, `wassell_is_admin`, `wassell_user_has_action`, `wassell_record_passes_scope`, `wassell_can_view_record` / `_edit` / `_create` / `_delete`, `wassell_can_view_jsonb` / `_edit_jsonb`, `try_boolean` / `try_numeric` / `try_timestamptz` (used by the auto-generated `v_<model>` views via `security_invoker`), `record_assign_auto_id`, `record_search`, `get_public_dashboard`, `search_all_projects`.
  - `service_role` → unaffected (Vercel API routes / webhooks / triggers continue to work).
  - **An anon `curl POST /rest/v1/rpc/freeze_model` now returns `42501` instead of running.**
- **All SECURITY DEFINER functions in `public` have `SET search_path = public, pg_temp`.** Closes the search-path attack surface where an unprivileged user could shadow `public.records` (or any other catalog object) by creating a same-named object earlier on the search path.
- **Every RLS policy uses `(SELECT auth.uid())`** instead of bare `auth.uid()`. Postgres evaluates `auth.uid()` once per query as an InitPlan node, not once per row — the same correctness, ~10–100× planner improvement at scale. The `regenerate_frozen_model_artifacts` policy generator emits the wrapped form, so future freezes inherit it automatically.
- **Per-table policy posture (post-B-followup):**
  - `records` — per-row gating via `wassell_can_*_record` helpers (Phase 1 — pre-existing). Init-plan wrapped.
  - `activity_log` — split: SELECT (admin sees all, users see their own), INSERT (admin OR self-stamped, NULL `actor_user_id` rejected), DELETE (admin only). **No UPDATE policy — audit log is immutable** (any UPDATE returns 42501).
  - `field_templates`, `model_groups`, `models`, `profiles`, `roles`, `users`, `model_views`, `marketing_operations__facts`, `marketing_operations__sources` — split into separate INSERT/UPDATE/DELETE policies (instead of the prior `*_write FOR ALL`). Same effective rules (admin-only writes), now with exactly one PERMISSIVE policy on SELECT.
  - **Webhook tables** (`chat_messages`, `call_logs`, `webhook_payloads`) — SELECT-only for `authenticated`. INSERT/UPDATE/DELETE go through `service_role` from `/api/webhook/*` handlers (bypassing RLS). `webhook_payloads_consume_update` intentionally remains permissive so the marketing UI can mark payloads consumed. `chat_messages` SELECT additionally composes with the **chats view-scope** via `wassell_chat_scope_class()` (added 2026-07-28): `all`→every message, `none`→none, `filtered`→messages whose parent conversation record passes the caller's records RLS. So scoping the chats *conversation list* automatically scopes message bodies + the Realtime feed.
  - **Per-rep chat visibility (2026-08-14).** The scope engine can't traverse the `chats.client_link` lookup, so each chat carries a read-only `client_owner` assignee mirrored from the linked client's `clients.client_owner` (a `public.users.id`), kept in sync by DB triggers (`records_fill_chat_client_owner` + `records_sync_chats_on_client_owner`). This makes "a rep sees only chats linked to a client they own" a plain, admin-configurable view-scope on the chats model — condition `client_owner equals current user` (and/or `client_link is not empty` to hide advertiser/contact/other chats). **Off by default** — no profile ships the scope; an admin opts a profile in via Settings → Profiles → chats, and message visibility follows automatically (previous bullet). Migration: `supabase/migrations/2026-08-14_chat_client_owner_mirror.sql`.
  - **Marketing data + settings** (`competitors`, `posts`, `reels`, `research_questions`, `webhook_slugs`, `whatsapp_numbers`) — admin write, authenticated read.
  - `sales_process_overrides` — admin write (`wassell_is_admin`), authenticated read. Holds the manager-edited follow-up objectives **and call-guidance scripts** the Sales Manager page writes and every rep's Follow-up Workspace reads. The `script_ar` / `script_en` columns (added 2026-06-21) inherit the same policies — no policy change. Migrations: `supabase/migrations/2026-06-17_sales_process_overrides.sql` + `supabase/migrations/2026-06-21_sales_process_override_script.sql`. See [sales-process.md](sales-process.md).
  - `workflows`, `workflow_groups` — the prior `*_admin FOR ALL` policy was split: **SELECT** allows `wassell_can_view_workflows` (admin OR `profiles.can_view_workflows`); **INSERT/UPDATE/DELETE** stay `wassell_is_admin`. So a granted profile can READ workflows (Sales Process Studio shows links) but only admins write. `workflow_runs` — `read` now allows `wassell_can_view_workflows` too (read-only run history); `insert` stays open (client-side run logging); `modify`/`delete` stay admin. Migration: `supabase/migrations/2026-06-18_workflow_view_access.sql`.
  - `marketing_notifications` — owner-or-admin SELECT/UPDATE (UPDATE for `read_at`); admin-only INSERT/DELETE.
  - **Deprecated `wa_*` tables** (`wa_conversations`, `wa_errors`, `wa_leads`) — admin-only for ALL operations (per CLAUDE.md these are unused, scheduled for drop).
  - **Intentionally permissive (USING(true))**: `whiteboards`, `whiteboard_folders` (multi-user collaboration design); `workflow_runs_insert` (any user save can produce a run that needs to log).
- **Frozen tables.** Each frozen table runs `frozen_view` / `frozen_insert` / `frozen_update` / `frozen_delete` policies + `frozen_junction_view` / `frozen_junction_write` for junctions, all wrapped with `(SELECT auth.uid())`. `wassell_can_view_jsonb` / `wassell_can_edit_jsonb` build a synthetic `records` row from the frozen-table columns and delegate to `wassell_record_passes_scope`. See data-storage.md "Frozen models" for details.
- **Seed uniqueness (2026-06-16).** Partial unique indexes `profiles_system_label_uniq` and `roles_system_label_uniq` — `UNIQUE (lower(btrim(label_en))) WHERE is_system` — guarantee at most one `is_system` profile/role per label, so a future restore/branch/backup-copy can no longer reintroduce a duplicate seed silently (it fails loudly with a 23505 unique violation). User-created non-system rows (e.g. several "New Profile") are unconstrained (partial predicate). The SPA seed backfill in `appStore.initialize()` mirrors this — it skips inserting a system seed whose label already exists under a different id, adopting the existing row instead of duplicating it. Migration: `supabase/migrations/2026-06-16_dedup_seed_roles_profiles.sql`.

## Invariants (enforced in the store)
Every destructive mutation returns `{ ok: true } | { ok: false, reason }`. UI guards (disabled buttons, hidden options) are ergonomic; the store is the single source of truth.

- **System profiles/roles cannot be deleted.** `is_system: true` short-circuits delete with `reason: 'is_system'`.
- **Profile delete is blocked while any user references it** (`reason: 'has_users'`). Admin must reassign users first — no silent re-assignment.
- **Role delete cascades:** the role is removed AND all `role_assignments` pointing at it are pruned from every user. No dangling references on users. Referring workflows keep their dangling `role_id` so the Workflow editor can warn (no auto-fix).
- **Self-delete is blocked** (`reason: 'self_delete'`).
- **Last active admin cannot be deleted or deactivated** (`reason: 'last_admin'`). Applies to `deleteUser` and to `saveUser` when deactivating the last admin or flipping them to a non-admin profile.
- **Deleting a user also removes their Supabase Auth identity.** After the store removes the app-level `public.users` row, `UsersPage.confirmDelete` calls `deleteAuthUser` → the `delete-user` Edge Function (service-role, admin-gated) deletes the `auth.users` row, freeing the email for a future invite. Before this, "Delete user" left the Auth identity orphaned, so re-inviting that email failed with `email_exists` (the opaque "non-2xx" toast). The `self_delete` / `last_admin` guards run first (so they also protect the Auth deletion), and the Edge Function itself refuses to delete the caller's own identity. Idempotent — a no-op if the Auth identity is already gone. (Users who own RESTRICT-referenced resources — folders/files/shared links — still can't have their `public.users` row removed client-side; that pre-existing FK guard is unchanged.)
- **User save requires a valid profile** (`reason: 'missing_profile'`). The Save button is disabled in the UI; the store validates regardless.
- **Destructive actions always confirm** — user/profile/role delete, user deactivate all use the standard `Modal` confirmation pattern.

## Admin gate
Admin-only routes:
- `/builder`, `/builder/:modelId`
- `/workflow` (list), `/workflow/agent` — the editor `/workflow/:workflowId` is NOT here (see the per-profile note below)
- `/dashboards`, `/dashboards/:dashboardId`
- `/settings/translations`
- `/settings/profiles`, `/settings/profiles/:profileId`
- `/settings/roles`, `/settings/roles/:roleId`
- `/settings/users`

Non-admin-accessible routes: `/`, `/model/:modelName`, `/model/:modelName/new`, `/model/:modelName/:recordId`, `/settings` (landing — but the cards grid filters to admin-only cards and shows an empty state for non-admins), `/public/dashboard/:token`.

**Per-profile (not the blanket admin gate):** `/sales/my-clients`, `/sales/my-tasks`, `/sales/tasks`, `/sales/process`, `/sales/manager` are gated by `<RequirePageAccess>` against `profile.page_access` (see "Custom (non-model) page access" above), not `<RequireAdmin>`. By default Sales Tasks is reachable by everyone and Sales Process + Sales Manager by admins only, but an admin can grant any of them to a non-admin profile (or revoke Sales Tasks from one). The workflow **editor** `/workflow/:workflowId` + run-history `/workflow/logs*` are gated by `<RequireWorkflowView>` (`can_view_workflows` → read-only) — see "Workflow read access".

## User flows
1. **Create a profile:** `/settings/profiles` → "+ New Profile" → give name → PermissionMatrix shows every model with 6 toggles + "All" → save. New profiles are never `is_admin` or `is_system`.
2. **Create a role definition:** `/settings/roles` → "+ New Role" → give name → add custom fields (like a mini-model) → save.
3. **Create a user:** `/settings/users` → "+ New User" → fill name + email → pick profile (defaults to first; empty option removed) → check any roles and fill their field values inline → leave "Send invite email" checked → save. The invitee gets a one-click sign-in email; clicking it logs them in bound to the row you just created. If they didn't get it (spam, typo), click the mail icon on their row to resend.
4. **Restrict access:** Change a profile's matrix → users with that profile immediately lose access in the UI (sidebar hides models, buttons disappear, record pages gate by permission).
5. **Dynamic assignment:** In a workflow `assign_user` action or a `role_variable` field mapping, pick a role and add conditions that match role fields to trigger-record fields. At run time the engine finds the matching user.
6. **Grant a Sales Operations page to a profile:** `/settings/profiles/:profileId` → **Sales Operations** card → check Sales Manager (or Sales Process / Sales Tasks) → Save. Users on that profile immediately get the sidebar link + route access. Unchecking Sales Tasks for a profile hides it from those users. Admin profiles always see all three (toggles are disabled there).

## Data touched
- Reads/writes: `users`, `profiles`, `roles` (mirrored in localStorage + Supabase when configured).
- Reads: `models` (to render the PermissionMatrix and filter the sidebar).
- Consumed by: `usePermission`, `useModelPermissions`, `useIsAdmin` hooks, `RequireAdmin` guard, `workflowEngine` (`assign_user` actions and `role_variable` field mappings).

## Key files
| File | What it does |
|---|---|
| `src/pages/Settings/UsersPage.tsx` | User list, create/edit modal with inline role-field editor, delete + deactivate confirmations (delete also removes the Supabase Auth identity via `deleteAuthUser`), Send-invite checkbox on create, Resend-invite button per row, per-user "Allow profile preview" grant checkbox (off by default) + Eye badge |
| `src/lib/auth.ts` | Supabase Auth wrapper — `signIn`, `signOut`, `getSession`, `getSessionUid`, `onAuthChange`, `sendPasswordResetEmail`, `updatePassword`, `inviteUser` (calls `invite-user`), `deleteAuthUser` (calls `delete-user`), TOTP MFA helpers. `inviteUser`/`deleteAuthUser` read the Edge Function's real error body (via `FunctionsHttpError.context`) so toasts show the actual reason (e.g. `email_exists`, email rate limit) instead of "Edge Function returned a non-2xx status code" |
| `src/pages/Login.tsx`, `src/pages/auth/ResetPassword.tsx` | Sign-in page and password-recovery landing page |
| `src/pages/Settings/ProfilesPage.tsx` | Profile list and editor; system badge; delete guard UI; renders the Sales Operations (page-access) card + the model PermissionMatrix; persists `page_access` (always sent, even `{}`, so a full revoke-to-default resets the column) |
| `src/pages/Settings/components/PermissionMatrix.tsx` | Per-model expandable card: 6 action toggles + view/edit scope editors + per-field hidden/readonly/editable rules + the "Show in this profile's sidebar" toggle. Owns the reference-dependency wiring: toggling `view` auto-adds/prunes `auto_reference` grants and renders the removable "Reference modules (data-only)" chip panel |
| `src/lib/moduleDependencies.ts` | `resolveModelDataDependencies(rootModelId, models)` — pure transitive closure of the modules a model displays data from. Type-agnostic: harvests every `*_model_id` from each field definition (covers lookup/location/future types) + reads `schema.displayed_child_models` for embedded child lists (units on a project). Drives the editor's auto-reference grants; NOT an enforcement path |
| `src/data/seedModels.ts` + `src/lib/schemaMigrations.ts` (`healDisplayedChildModels`) | Declare embedded-child relationships as DATA on the model (`schema.displayed_child_models`, by slug — e.g. all_projects → units) and backfill them onto existing system models on load (refreshSystemModels only inserts, never updates) |
| `src/pages/Settings/components/PageAccessMatrix.tsx` | Per-profile toggles for the custom Sales Operations pages; stores an explicit `page_access` override only when it diverges from a page's `default_access`; admin profiles render checked + disabled |
| `src/lib/customPages.ts` | Registry of custom (non-model) pages — id, route, bilingual label, icon, `default_access`, optional `hidden_from_sidebar`. Single source of truth read by the Sidebar, the route guard, and PageAccessMatrix |
| `src/components/guards/RequirePageAccess.tsx` | Route guard for `/sales/*` — gates on `canAccessPage` (no MFA step, unlike RequireAdmin); redirects home with an access-denied toast |
| `src/components/guards/RequireWorkflowView.tsx` | Route guard for the read-only run-history routes (`/workflow/logs*`) — gates on `canViewWorkflows` (admin or `can_view_workflows`); no MFA step |
| `src/pages/SalesProcess/SalesProcessStudioPage.tsx` | Reads `workflows` from the store to show each phase's linked workflow; "Open in Builder" admin-only, "View Runs" gated by `useCanViewWorkflows` |
| `src/pages/Workflow/WorkflowLogsPage.tsx`, `WorkflowRunDetailPage.tsx` | Read-only run history for workflow-view profiles; Clear-all / Delete buttons gated by `useIsAdmin` |
| `supabase/migrations/2026-06-18_workflow_view_access.sql` | `profiles.can_view_workflows` column + `wassell_can_view_workflows` helper + workflows/workflow_groups SELECT-vs-write policy split + `workflow_runs_read` view grant |
| `src/pages/Settings/components/ScopeConditionEditor.tsx` | Filter-condition row builder used inside both the view-scope and edit-scope sections of `PermissionMatrix` — picks target (model field or `created_by`), operator, and value source (literal / current user / role field) |
| `src/lib/scopeFilters.ts` | Scope evaluator: resolves user-context value sources, walks conditions, returns boolean per record. Evaluator + `applyScope` filter helper |
| `src/pages/Settings/AuditLogPage.tsx` | Admin-only audit-log viewer: filter by entity type, free-text search on actor + entity, expandable rows show before/after JSONB |
| `src/pages/ProfilePage.tsx` | Self-service /profile page: change name, change password, manage MFA factor |
| `src/pages/auth/MfaSetup.tsx` | TOTP enrollment + challenge page; gated by RequireAdmin via `getCurrentAal()` |
| `supabase/functions/invite-user/index.ts` | Edge Function that uses the service-role key to verify the caller is an admin (`wassell_is_admin(auth.uid())`), then issues `auth.admin.inviteUserByEmail` AND atomically writes `public.users.auth_uid` for the matching email (skips if `auth_uid` is already set — never clobbers). Deployed with `verify_jwt = false` (does its own Bearer + `getUser` + admin gating; gateway-off so auth errors return CORS-bearing JSON instead of a masked fetch failure). |
| `supabase/functions/delete-user/index.ts` | Edge Function (service-role, admin-gated via `wassell_is_admin`) that deletes a user's `auth.users` identity — by `auth_uid` when the frontend supplies it (from `users.auth_uid`), else resolved from the email via the admin user list. Idempotent (no-op if already gone); refuses to delete the caller's own identity. Mirror of `invite-user`; closes the orphan-re-invite gap. Also `verify_jwt = false` (same internal-auth posture as `invite-user`). |
| `supabase/config.toml` | Pins `verify_jwt = false` for `invite-user` + `delete-user` so a future `supabase functions deploy` doesn't regress the gateway-off posture back to the default (true). |
| `supabase/migrations/2026-05-24_bind_my_auth_uid.sql` | SECURITY DEFINER RPC `bind_my_auth_uid()` — closes the 2026-05-06 chicken-and-egg in `users_write` for users invited before the Edge-Function fix. Called from `initialize()` on every sign-in; idempotent. |
| `src/pages/Settings/RolesPage.tsx` | Role list + editor. Wraps each role as an `AppModel`-shaped object and delegates to `SectionManager` with `ownerKind='role'` for the full builder UX. Read-only Members table supports all field-type displays. |
| `src/pages/Builder/components/SectionManager.tsx` | Shared builder (used by both models and roles). `ownerKind` prop gates rename propagation. |
| `src/pages/Builder/components/FieldEditor.tsx` | Shared field editor. `ownerKind='role'` skips `renameField` propagation (role-field slugs aren't referenced in records/workflows/views). |
| `src/pages/Settings/components/UserRoleFields.tsx` | Inline role-field editor on the User modal. Uses `DynamicField` from the record form for all supported types. |
| `src/lib/roleSchema.ts` | Helpers: `roleFields(role)` flattens sections into ordered list; `emptyRoleSchema()` builds the default single-section schema for new roles. |
| `src/hooks/usePermission.ts` | `usePermission`, `useModelPermissions`, `useIsAdmin`, `useCanAccessPage`, `useCanViewWorkflows` — every hook forwards `previewProfileId` (profile preview) |
| `src/lib/permissions.ts` | Permission evaluation + `isAdmin` + `canAccessPage` + `canViewWorkflows` + `isModelSidebarHidden` (nav-only reference-hide, admins exempt); all functions take an optional trailing `previewProfileId` honored only for users with `can_preview_profiles`; exports `resolveEffectiveProfile` |
| `src/components/guards/RequireAdmin.tsx` | Route guard that redirects non-admins |
| `src/components/layout/Sidebar.tsx` | Filters models by `view` permission; renders the Sales Operations links from `CUSTOM_PAGES` gated by `canAccessPage` |
| `supabase/migrations/2026-06-18_profile_page_access.sql` | Adds the additive `page_access JSONB DEFAULT '{}'` column to `profiles` |
| `src/components/layout/Header.tsx` | Read-only signed-in pill when auth is on; dev-only user-switcher dropdown when auth is off; sign-out button; profile-preview Eye switcher + always-reachable gold "وضع المعاينة" banner for users granted `can_preview_profiles` |
| `src/stores/appStore.ts` | `bindAuth` / `signOutAndClear`, email→user lookup + seed-admin bootstrap inside `initialize()` |
| `src/pages/Workflow/components/ActionList.tsx` | `assign_user` action + role-variable mapping; dangling-role warning |
| `src/types/index.ts` | `User`, `Profile`, `Role`, `UserRoleAssignment`, `StoreMutationResult` |
| `src/data/seedUsers.ts` | Seeded admin + Sales profiles, seeded roles, seeded admin user |
| `src/stores/appStore.ts` | `users`, `profiles`, `roles` state; invariant enforcement; migration/heal |
| `supabase/migrations/2026-05-06_a1_rls_initplan_wrap.sql` | RLS init-plan wraps for all 24 advisor-flagged policies; updates `regenerate_frozen_model_artifacts` to emit the wrapped form; re-regenerates artifacts for every existing frozen model |
| `supabase/migrations/2026-05-06_a4_definer_search_path.sql` | `SET search_path = public, pg_temp` on every public-schema SECURITY DEFINER function |
| `supabase/migrations/2026-05-06_b1_b2_revoke_definer_execute.sql` | `REVOKE EXECUTE ... FROM PUBLIC` on every public function; explicit `GRANT EXECUTE` to `anon` / `authenticated` |
| `supabase/migrations/2026-05-06_b3_activity_log_rls.sql` | activity_log SELECT/INSERT/DELETE policy split; no UPDATE (audit log is immutable) |
| `supabase/migrations/2026-05-06_b4_dedupe_permissive_policies.sql` | `*_write FOR ALL` → `*_insert` / `*_update` / `*_delete` split on 9 tables; `freeze_model` patched to emit the split for future frozen junctions |
| `supabase/migrations/2026-05-07_b_followup_tighten_always_true_policies.sql` | 11 always-true policies tightened (webhook, marketing, settings, notifications, deprecated wa_*) |

## Open questions / deliberate non-goals
After the Phase 1–4 roadmap, the system is feature-complete. The remaining
items are *intentional* non-goals at the current scale (5–50 users) — not
defects:

- **No SSO / SAML.** Overkill for a small CRM. Revisit if Wassel onboards
  a 500-person partner.
- **No SCIM provisioning.** Same.
- **No API tokens / service accounts.** Useful for automation but a
  separate concern; user-management is for humans.
- **No per-record audit log.** The `audit_log` table covers users /
  profiles / roles only. Record-level audit (who edited which field on
  which record) is a different feature with different retention rules
  and would multiply the table size by 10–100×.
- **No IP allowlisting.** Friction outweighs value at this scale.
- **No multi-tenant separation.** Single-tenant is correct for Wassel —
  there's one company, one workspace.
- **No deactivation lockout for an existing live session.** Deactivation
  enforces at sign-in; if a user is signed in when an admin flips them
  to `is_active = false`, they keep their session until token refresh
  fails. Hard immediate revoke would need a Realtime channel or Edge
  Function pre-hook on every request.
- **Role lookup fields are single-select only** (`is_multi` on role
  fields is not implemented). Adding it would require updating
  `wassell_record_passes_scope` to handle array role-field values.
- **Workflows referencing a deleted role** still show a warning rather
  than auto-suggesting a replacement. Same reasoning as multi-role
  fields — the UX cost outweighs the recovery benefit.

## Project-level Supabase dashboard checklist
Three settings can only be flipped from the dashboard. **Without these,
Phase 2's lockdown code is in place but not actually armed:**

1. **Auth → Settings → "Allow new users to sign up": OFF.** Closes
   self-registration. Inviting goes through the `invite-user` Edge
   Function which uses the service-role key and bypasses this setting.
2. **Auth → Providers → MFA → TOTP: enabled.** Required for
   `mfa.enroll({ factorType: 'totp' })` to work.
3. **Auth → Password requirements → Minimum length: 12.** The client
   validates inline (`MIN_PASSWORD_LENGTH`); the server is the source
   of truth.
- **Scope conditions on structured fields are limited.** `range`-type fields can be compared via `field_path: 'min' | 'max'` (mirroring dashboard filter behavior), but `multiselect` / `lookup is_multi` fields use scalar comparison — equality against an array always fails. Use `contains` for substring matches against the JSON serialization or split into multiple OR conditions (not yet supported — filters are AND-only).
- **Read-only fields are skipped during create.** When a profile marks a field `readonly`, that field doesn't appear in the create form — the value is populated by defaults / workflows / formulas, never by the creator. ("Create-only" semantics — set on insert, locked after — is not supported. Add a 4th state if real-world demand emerges.)
- **`current_user` against a free-text field doesn't work usefully.** It compares the raw user UUID against the field value, which is almost never what an admin wants. Use it with `created_by` or `assignee`-typed fields where the value is also a user id.
