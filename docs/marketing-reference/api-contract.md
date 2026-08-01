# Marketing OS — API contract for the exact build (2026-08-01)

Single source of truth for every `api/marketing-os.ts` action added or changed by the
52-screen build. UI tasks and API tasks both code against THIS file. One POST endpoint,
`{ action, ...payload }`, caller-JWT client, RLS enforced by the DB. Existing 44 actions
stay unless a row below says CHANGED.

## Engine (workflows / tasks / roles)

| Action | Payload → Response | Notes |
|---|---|---|
| `bootstrap` CHANGED | `{}` → `{ me: { user_id, roles: string[], active_role, surfaces: Record<surface_key,'full'\|'read'\|'hidden'>, prefs }, content_types, workflows: WorkflowDef[], platform_accounts, settings: Record<key,jsonb>, unread_notifications: number }` | `roles` = held mos role keys (stripped `mos_`), from `wassell_mos_roles()`. `workflows` = canonical rows `kind='role_path'` (id, label_ar/en, is_active, steps from `metadata.steps`, current_version_no, current_version_id). `active_role` echoes `x-mos-active-role` header if held, else first role. |
| `task_complete` CHANGED | `{ content_id, result: 'submitted'\|'approved'\|'changes_requested', note?, targets?: string[] }` → `{ closed_task_id, opened_task_id?, next_step_key?, round, done }` | Calls `workflow_advance_role_path('mos_content', content_id, result, note, targets)`. On `submitted`: server also snapshots `mos_content_versions` (round, data, scenes). On `changes_requested`: attaches note to that round's version row; then fires `notify_emit`. |
| `task_transfer` NEW | `{ task_id, to_user_id }` → `{ ok: true }` | `workflow_role_task_transfer` RPC. |
| `workflow_save` NEW | `{ id?, label_ar, label_en, is_active?, steps: StepDef[] }` → `{ workflow, version_no }` | Upserts the CANONICAL workflows row (`kind='role_path'`, steps into `metadata.steps`, `metadata.managed_by='marketing_os'`). Version row is written by the DB trigger; response returns the new version_no. Replaces `step_save` (RETIRED — remove). |
| `roles_list` CHANGED | `{}` → `{ people: [{ user_id, name_ar, name_en, email, roles: string[] }], roles: [{ key, role_id, label_ar, label_en, holders: number }] }` | From canonical `roles` (key like `mos_%`) × `users.role_assignments`. |
| `role_grant` CHANGED | `{ user_id, role_key, grant: boolean }` → `{ ok }` | Appends/removes the `{role_id}` entry in `users.role_assignments` (server-side via caller JWT — users table RLS governs; if the caller lacks users-write, translate 42501 into the bilingual role error). Multi-role: grant/revoke individual keys. |
| `surface_matrix` NEW | `{}` → `{ surfaces: string[], roles: [{key, role_id}], cells: [{role_key, surface_key, level}] }` | Reads `surface_access`. |
| `surface_set` NEW | `{ role_key, surface_key, level }` → `{ ok }` | Upserts one cell; effective immediately. |

`StepDef` = `{ key, label_ar, label_en, role_key, due_days, is_approval, approval_kind?, require_note_on_reject, creates_revision, required_fields: string[], required_files: string[] }`.

## Content versions & comparison

| Action | Payload → Response |
|---|---|
| `content_versions` NEW | `{ content_id }` → `{ versions: [{ id, round, created_at, submitted_by, rejected_note, data, scenes }] }` |
| (snapshotting) | happens inside `task_complete` on `submitted` — no separate action |

## Notifications

| Action | Payload → Response |
|---|---|
| `notifications_list` NEW | `{ unread_only?, limit? }` → `{ rows: [{id, kind, title_ar, title_en, body_ar, body_en, url, read_at, created_at}], unread }` |
| `notifications_read` NEW | `{ ids: uuid[] }` → `{ ok }` — `mark_notifications_read` RPC |
| `notification_rules` NEW | `{}` → `{ rules: [{role_key, event, channel, timing, enabled}] }` |
| `notification_rule_set` NEW | `{ role_key, event, channel, enabled, timing? }` → `{ ok }` |
| `notification_prefs_save` NEW | `{ whatsapp_enabled?, digest_hour?, quiet_from?, quiet_to? }` → `{ prefs }` |
| `remind` NEW | `{ content_id }` → `{ ok }` — screen 01/35 «تذكير»: `notify_emit` to the open task's role + assignee, kind `manual_reminder` |

Server-side emission points (inside existing actions): `task_complete` (task_assigned to next role / changes_requested to writer), `shoot_deliver` (content unblocked), `publication_save` when scheduled_at set (publish_due at tick time — worker), `campaign_save` when requires_signature flips true (budget_signature → CEO), `metrics_queue` overdue (worker sweep).

## Campaigns / executions / outcomes

| Action | Payload → Response |
|---|---|
| `campaign_events` NEW | `{ campaign_id }` → `{ events: [...] }` |
| `campaign_event_add` NEW | `{ campaign_id, kind, summary_ar, summary_en?, detail? }` → `{ event }` — also auto-logged by `execution_save` (added/paused/resumed), budget shifts (`budget_shift` with {from_execution_id,to_execution_id,amount}), `content_linked/unlinked`, `signed` |
| `campaign_outcomes` NEW | `{ campaign_id }` → `{ outcomes }` — `mos_campaign_outcomes(campaign_id)` jsonb verbatim + the settings used |
| `campaign_sign` NEW | `{ campaign_id }` → `{ campaign }` — CEO-only (`approve_budget` + role check ceo/manager): sets signed_by/signed_at, logs `signed` event |
| `budget_shift` NEW | `{ campaign_id, from_execution_id, to_execution_id, amount }` → `{ executions }` — moves budget between executions transactionally; logs event |
| `campaign_save` CHANGED | + brief fields `audience, offer, destination_url, measured_by`; server sets `requires_signature` from settings threshold |
| `execution_save` CHANGED | + `platform_campaign_id, purpose` |

## Attribution

| Action | Payload → Response |
|---|---|
| `attribution_list` NEW | `{ campaign_id? , client_record_id? }` → `{ rows }` (effective view + superseded flag) |
| `attribution_stamp` NEW | `{ client_record_id, campaign_id?, execution_id?, ad_id?, occurred_at, source: 'lead_form'\|'manual'\|'import', note?, supersedes_id? }` → `{ row }` — APPEND ONLY |

## Library / shoots

| Action | Payload → Response |
|---|---|
| `asset_detail` NEW | `{ asset_id }` → `{ asset, used_in: [{content_id, ref, title, role, live_ad: boolean}], versions: [{id, title, created_at}] (parent/children), publications_using: number }` |
| `asset_archive` NEW | `{ asset_id, archived: boolean }` → `{ asset }` — delete stays BLOCKED when used_in > 0 (`asset_delete` CHANGED: returns 409-style `{ error: 'in_use', used_in }`) |
| `assets_unused` NEW | `{ }` → `{ rows }` — assets with zero `mos_asset_links` and zero publications, not archived |
| `assets_bulk` NEW | `{ ids: uuid[], op: 'archive'\|'tag'\|'create_content', tag?, content_type_key? }` → `{ results }` — create_content makes one content item pre-linked to the assets |
| `shoot_detail` NEW | `{ request_id }` → `{ request, items: [{...,scene, content_ref}], assets_count }` |
| `shoot_item_add` NEW | `{ request_id, description, scene_id?, content_id? }` → `{ item }` |

## Performance / numbers

| Action | Payload → Response |
|---|---|
| `numbers_week` NEW | `{ week_start? }` → `{ platforms: [{platform, publications: [{publication_id, content_ref, title, latest: {...}, missing: boolean, skipped_reason?}]}], progress: {entered, total, estimate_minutes} }` |
| `metrics_skip` NEW | `{ publication_id, reason }` → `{ ok }` — stores a `mos_metric_snapshots` row with `extra: {skipped: true, reason}` and NULL metric fields is INVALID per the not-empty CHECK → instead store `extra: {skipped: reason}` (extra <> '{}' satisfies the CHECK). Missing ≠ zero ≠ skipped: three distinct states derived server-side. |
| `metrics_record` CHANGED | supports platform-specific `extra` fields (e.g. TikTok watch-time) |

## Search

`search` CHANGED: results filtered by `surface_access` levels (hidden surface types ABSENT from results and from type-count chips); adds shoots + assets result types with thumbnails; each hit carries `match_reason` + `<mark>` excerpt (server builds the excerpt string; client renders).

## Settings

`settings_data` CHANGED: returns canonical role-path workflows (with versions count), surface matrix summary, notification rules summary, `mos_settings` values, platform accounts, content types — one payload for all settings pages. `settings_save` NEW: `{ key, value }` → mos_settings upsert (threshold cards on screen 25).

## Conventions

- Every NEW action validates payload shape first and returns the endpoint's standard bilingual error envelope on violation.
- Every list action orders deterministically (stable sort keys) — capture reproducibility depends on it.
- No action ever writes `records` — CRM reads only via `unified_records`.
- `x-mos-active-role` request header: optional; server VALIDATES it is held, uses it for display-affecting derivations only, NEVER for authorization (authorization = union of held roles via RLS/RPCs).
