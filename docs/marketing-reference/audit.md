# Marketing workspace — audit + reuse/replace ledger

**Date:** 2026-08-01
**Scope:** every marketing-flavoured surface in the repo, classified as keeper (new Marketing OS workspace at `/m`), removal candidate (legacy marketing-management), or reuse-unchanged (Marketing Intelligence). Facts below were verified by reading the files cited; line counts are from `wc -l`.

Three distinct things share the word "marketing" in this codebase and must not be conflated:

1. **Marketing OS workspace** (`/m`) — the new, approved 52-screen module. Owns `mos_*` tables. This is the keeper.
2. **Legacy marketing-management** — the old module. Its code (`src/pages/MarketingManagement/`, `api/marketing-mgmt.ts`, `src/lib/marketingMgmt/`) is **already deleted**; only redirect routes, a historical design doc, and comments referencing it remain.
3. **Marketing Intelligence** (`/marketing-intelligence` + Settings panels) — competitor/market intel over the `mkt_*` dataset, served by `api/marketing.ts`. Unrelated to the other two and reused unchanged.

---

## 1. Inventory of marketing surfaces

### 1a. New Marketing workspace (the keeper)

Everything under `src/pages/Marketing/`, plus its typed client and its endpoint. The workspace renders **outside** `AppLayout` with its own rail/header/visual system (`MarketingWorkspace.tsx` header). Mounted in `src/App.tsx:429-462` under `/m` behind `RequireMarketingWorkspace`.

| File | Lines | Role |
|---|---|---|
| `src/pages/Marketing/MarketingWorkspace.tsx` | 443 | Workspace shell: own rail + header, workspace-wide context (role, content types, project names), `RequireMarketingWorkspace` guard. |
| `src/pages/Marketing/OverviewPage.tsx` | 309 | Overview (design screens 01/34): four "is the machine running" stats + stalled list + this-week list; CEO variant swaps queue for budget. |
| `src/pages/Marketing/WorkPage.tsx` | 276 | My work (screen 02) and Team work (screen 35) — one query, two scopes; groups late / yours / others'. |
| `src/pages/Marketing/ContentListPage.tsx` | 297 | Content library (screens 03 table / 04 board) with filters; stage + owner are read-only derivations from the open task. |
| `src/pages/Marketing/ContentDetailPage.tsx` | 598 | Content workspace (screens 06–12, 38): six tabs + stage rail, tabs as local state (no refetch on tab switch). |
| `src/pages/Marketing/SearchPage.tsx` | 207 | Search results (screen 44), grouped by object kind (content / assets / campaigns), RLS-scoped. |
| `src/pages/Marketing/CalendarPage.tsx` | 206 | Calendar (screen 13): scheduled publications (solid chips) vs due dates (dotted chips) on one grid. |
| `src/pages/Marketing/CampaignsPage.tsx` | 593 | Campaign list (screens 14/19): spend envelopes; cost per lead computed from executions, never typed. |
| `src/pages/Marketing/CampaignDetailPage.tsx` | 648 | Campaign detail (screens 15/20/21/39/40): envelope, content, executions, results tabs; rollups from a DB view. |
| `src/pages/Marketing/ExecutionDetailPage.tsx` | 865 | Execution detail (screen 21): campaign → execution → ad; per-ad targeting + daily results; computed "best" ad. |
| `src/pages/Marketing/LibraryPage.tsx` | 349 | Asset library (screens 16/22/41): assets as first-class objects; unused-assets view via LEFT JOIN on link table. |
| `src/pages/Marketing/UploadPage.tsx` | 679 | Upload & intake (screen 23, the Drive replacement): batch drop, kind auto-detected, dedup at the door, loud per-file failures with retry. |
| `src/pages/Marketing/ShootsPage.tsx` | 577 | Shoot requests (screen 42): open requests, auto-suggest band from missing scenes, completed list with usage %. |
| `src/pages/Marketing/NumbersPage.tsx` | 243 | Weekly numbers (screen 49): manual metric entry for every published post; blank = NULL, never 0. |
| `src/pages/Marketing/SettingsPage.tsx` | 854 | Settings (screens 25/17/26/27/33/37): workflows, content types, platform accounts, role grants (steps point at roles, not people). |
| `src/pages/Marketing/mos.css` | 1816 | The workspace design system — the approved 52-screen stylesheet with its own tokens and class names, used verbatim by every screen. |
| `src/pages/Marketing/components/kit.tsx` | 258 | Shared primitives mapping 1:1 onto the design's classes (`.phead`, `.stat`, `.pill`, `.empty`, `.modal`, `.sk`). |
| `src/pages/Marketing/components/icons.tsx` | 193 | Icon set drawn from the approved screens (not Lucide substitutes); inherits `currentColor`, sized by CSS. |
| `src/pages/Marketing/components/StageRail.tsx` | 77 | Stage rail (screen 06, right column): whole workflow visible, current step lit, closed steps show who/when. |
| `src/pages/Marketing/components/TaskCard.tsx` | 244 | Current-task card (screens 06/38): checklist derived from step `required_fields` + scene footage; soft-gate approval recorded. |
| `src/pages/Marketing/components/CommentThread.tsx` | 160 | Comment + system-event thread (screen 10, right column): rejection notes derived from the task chain. |
| `src/pages/Marketing/components/MaterialsTab.tsx` | 332 | Materials tab (screen 09): assets linked to an item by role (source / final / reference) via the link table. |
| `src/pages/Marketing/components/NewContentModal.tsx` | 262 | New-content modal (screen 05): type pick decides workflow, ref prefix, and first assignee — all stated before commit. |
| `src/pages/Marketing/components/PerformanceTab.tsx` | 283 | Performance tab (screen 12): append-only dated metric readings; DB refuses all-empty readings. |
| `src/pages/Marketing/components/PublishTab.tsx` | 288 | Publishing tab (screen 11): one row per platform with own caption/time/link; publishing is manual by decision. |
| `src/pages/Marketing/components/SceneTable.tsx` | 281 | Scenes tab (screen 07): script scenes with real-timing strip (segment width = duration) and first-class footage status. |
| `src/pages/Marketing/components/WritingFields.tsx` | 474 | Writing surface (screens 07/08): schema keys grouped into design instruments (idea/hook, voiceover, headline approval, caption, design brief); values in `mos_content.data` JSONB. |
| `src/pages/Marketing/lib/format.ts` | 128 | Formatting: Arabic-Indic digits everywhere in Arabic (`num()` is the single digit-shape decision), money, dates, avatars. |
| `src/pages/Marketing/lib/upload.ts` | 227 | Browser-direct upload to the `marketing-assets` bucket under `mos/<uuid>.<ext>` with real XHR progress; only metadata goes through the endpoint. |
| `src/lib/marketingOS/client.ts` | 761 | Typed SPA client for `/api/marketing-os`: thin `call<T>` transport + one typed wrapper per action + all `Mos*` types and label maps. |
| `api/marketing-os.ts` | 1522 | Action-dispatch Edge endpoint for the module. Runs on the caller's JWT (RLS + `wassell_mos_can(<capability>)` is the authorization boundary); reads via deriving views (`mos_content_v`, `mos_campaign_v`, `mos_publication_v`); allow-list updates; bilingual translation of deliberate DB rejections. **44 action handlers.** |

`api/marketing-os.ts` action handlers (44):

```
account_save          ad_delete             ad_save               asset_delete
asset_link            asset_list            asset_save            asset_unlink
bootstrap             calendar              campaign_detail       campaign_list
campaign_save         comment_add           comment_list          content_create
content_detail        content_list          content_type_save     content_update
daily_save            execution_delete      execution_detail      execution_save
metrics_history       metrics_queue         metrics_record        overview
projects_list         publication_list      publication_save      role_grant
roles_list            scene_delete          scene_save            search
settings_data         shoot_deliver         shoot_item_toggle     shoot_list
shoot_save            step_save             task_complete         work_list
```

Tables the endpoint touches (via `.from(...)`): `mos_content`, `mos_content_types`, `mos_scenes`, `mos_workflows`, `mos_workflow_steps`, `mos_tasks`, `mos_role_grants`, `mos_comments`, `mos_campaigns`, `mos_campaign_executions`, `mos_execution_ads`, `mos_execution_daily`, `mos_assets`, `mos_asset_links`, `mos_shoot_requests`, `mos_shoot_items`, `mos_publications`, `mos_metric_snapshots`, `mos_platform_accounts` — plus the views `mos_content_v`, `mos_campaign_v`, `mos_publication_v` and RPCs `wassell_app_user_id`, `wassell_mos_role`. (`mos_ref_counters` is written only by the `SECURITY DEFINER` `mos_next_ref` allocator — see `supabase/migrations/2026-07-30_mos_campaigns_assets_shoots.sql` header.)

### 1b. Legacy marketing-management (the removal candidate)

**The legacy code is already gone.** Verified absences:

| Artifact | Status | Evidence |
|---|---|---|
| `src/pages/MarketingManagement/**` | **not found** | No such directory; the only `MarketingManagement` matches in the repo are in `docs/marketing-management-v2.md` (historical design doc) and comments in `scripts/check-mkt-portfolio-embeds.mjs` / `api/marketing-os.ts`. |
| `api/marketing-mgmt.ts` | **not found** | No such file; referenced only by the historical doc and the two comments above. |
| `src/lib/marketingMgmt/**` | **not found** | No such directory; referenced only by `docs/marketing-management-v2.md:118`. |

Residual legacy references (removal candidates now):

- `src/App.tsx:354-355` — redirect routes: `/marketing-management` and `/marketing-management/*` → `<Navigate to="/m" replace />` (comment at `src/App.tsx:351`: "The old in-Sales marketing page is gone").
- `docs/marketing-management-v2.md` — the old module's design doc (describes `api/marketing-mgmt.ts` with 30 actions, `MarketingManagementPage.tsx`, `src/lib/marketingMgmt/{client,labels,projects}.ts`). Historical record only.
- `scripts/check-mkt-portfolio-embeds.mjs` — a one-off verification script whose header says it replays "the EXACT PostgREST selects that api/marketing-mgmt.ts sends" (targets the `mkt_*` dataset).

**`mkt_*` tables.** Grep of `src/` + `api/` for `mkt_` shows the surviving `mkt_*` references belong to **Marketing Intelligence** (§1c), not to the deleted marketing-management module. Tables/views referenced via `.from(...)`:

| Table | Referenced from |
|---|---|
| `mkt_organizations` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Records/components/MarketingTabPane.tsx` |
| `mkt_content_posts` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Records/components/MarketingTabPane.tsx`, `src/pages/Settings/components/CampaignsPanel.tsx` |
| `mkt_paid_ads` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Records/components/MarketingTabPane.tsx`, `src/pages/Settings/components/CampaignsPanel.tsx` |
| `mkt_content_enrichment` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Settings/ContentIntelligencePage.tsx` |
| `mkt_content_attributions` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Settings/ContentIntelligencePage.tsx` |
| `mkt_transcripts` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Settings/ContentIntelligencePage.tsx` |
| `mkt_content_media` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Settings/ContentIntelligencePage.tsx` |
| `mkt_visual_text` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Settings/ContentIntelligencePage.tsx` (embedded selects) |
| `mkt_project_organizations` | `api/marketing.ts` |
| `mkt_social_accounts` | `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/Records/components/MarketingTabPane.tsx` |
| `mkt_providers` | `api/marketing.ts`, `api/_lib/marketing/registry.ts` |
| `mkt_campaigns` | `api/marketing.ts` |
| `mkt_campaign_members` | `api/marketing.ts` |
| `mkt_campaign_events` | `api/marketing.ts` |
| `mkt_ad_campaigns` | `api/marketing.ts` |
| `mkt_ad_attributions` | `api/marketing.ts` |
| `mkt_ad_history` | `api/marketing.ts` |
| `mkt_advertiser_audit` | `api/marketing.ts` |
| `mkt_collection_jobs` | `api/marketing.ts` |
| `mkt_ingestion_runs` | `api/marketing.ts` |
| `mkt_discovery_runs` | `api/marketing.ts` |
| `mkt_identity_candidates` | `api/marketing.ts` |
| `mkt_insights` | `api/marketing.ts` |
| `mkt_metric_daily` | `api/marketing.ts` |
| `mkt_ops_alerts` | `api/marketing.ts` |
| `mkt_settings` | `api/marketing.ts` |
| `mkt_diagnostics` | `api/marketing.ts` |

RPCs (functions, not tables) called under the same prefix: `mkt_job_enqueue`, `mkt_job_retry`, `mkt_alert_set_status`, `mkt_campaign_merge`, `mkt_campaign_move_member`, `mkt_campaign_rename`, `mkt_campaign_set_member_status`, `mkt_cost_summary`, `mkt_enqueue_content_processing`, `mkt_enqueue_intelligence`, `mkt_insight_set_dismissed`, `mkt_intelligence_index`, `mkt_ops_dashboard`, `mkt_ops_evaluate`, `mkt_org_health`, `mkt_org_set_advertiser`, `mkt_organization_intelligence`, `mkt_project_intelligence`, `mkt_provider_health`, `mkt_queue_health`, `mkt_generate_trend_insights` — all from `api/marketing.ts` except `mkt_generate_trend_insights` (`src/pages/MarketingIntelligence/components/InsightsFeed.tsx`).

**Implication for the ledger:** there is no live `mkt_*`-backed marketing-management code left to remove. The `mkt_*` dataset is the Intelligence module's dataset; any "remove `mkt_*`" decision is a data-retention decision about Intelligence, not a code cleanup.

### 1c. Marketing Intelligence (reuse unchanged)

`api/marketing.ts` (818 lines, Edge runtime) is the read + light-write surface for the **Project Marketing Intelligence** module — competitor/market intel over the shared project catalog (~49k observed facts per the `api/marketing-os.ts` header note). One action-dispatch endpoint: reads run on the caller's Supabase JWT (RLS-scoped; the `mkt_*` tables are authenticated-read public competitor intel), while writes (attribution decisions, provider-health refresh, ops actions) escalate to a service-role client after a server-side admin check. Actions include `provider_health`, `project_overview`, `project_content`, `project_marketers`, `attribution_review`, `accounts`, `attribution_decide`, `refresh_provider_health`, plus collection-ops, intelligence-feed, and ops-monitoring actions over the `mkt_*` tables/RPCs listed in §1b.

Called from the SPA exclusively through `src/lib/marketing/client.ts` (`fetch('/api/marketing')`, one typed wrapper per action), which backs:

- `src/pages/MarketingIntelligence/` (`MarketingIntelligencePage`, route `/marketing-intelligence` at `src/App.tsx:350`; components `InsightsFeed.tsx`, `ProjectPanel.tsx`)
- `src/pages/Records/components/MarketingTabPane.tsx` (per-record marketing tab)
- `src/pages/Settings/ContentIntelligencePage.tsx` and `src/pages/Settings/MarketingOpsPage.tsx` (admin)
- `src/pages/Settings/components/CampaignsPanel.tsx`

A separate sibling endpoint, `api/marketing/generate.ts` (`POST /api/marketing/generate`), is the template-driven design generator (Higgsfield two-phase cleanup + design) called from `src/pages/Records/RecordFormPage.tsx:843` — unrelated to the Intelligence reads above and also unaffected by the workspace migration.

---

## 2. Reuse / extend / replace / remove ledger

| Artifact | Decision | Rationale | Migration note |
|---|---|---|---|
| `src/pages/MarketingManagement/**` | Remove after migration | **Not found** — code already deleted; only the `/marketing-management` redirect routes (`src/App.tsx:354-355`) and the historical doc `docs/marketing-management-v2.md` remain. | Nothing to migrate. Optionally keep the redirect routes indefinitely (bookmarks); the doc is a historical record — archive or delete by operator decision. |
| `api/marketing-mgmt.ts` | Remove after migration | **Not found** — already deleted; referenced only by the historical doc and comments in `scripts/check-mkt-portfolio-embeds.mjs` / `api/marketing-os.ts`. | Nothing to migrate. |
| `src/lib/marketingMgmt/**` | Remove after migration | **Not found** — already deleted; referenced only by `docs/marketing-management-v2.md:118`. | Nothing to migrate. (Note: `src/lib/marketing/` is the Intelligence client — a different directory, keep.) |
| `mkt_*` tables | Remove after data check (data stays in DB until operator confirms) | No live marketing-management code reads them anymore; every surviving `mkt_*` reference is the Marketing Intelligence module (`api/marketing.ts` + `src/lib/marketing/` + Intelligence/Settings pages). | **Flag:** dropping `mkt_*` would delete the Intelligence module's dataset, not legacy-management residue. Confirm with the operator whether Intelligence is being retired before any drop; data stays in DB until then. |
| `api/marketing.ts` (Intelligence) | Reuse unchanged | Live, RLS-scoped, serves `/marketing-intelligence`, the record Marketing tab, and two Settings panels; explicitly disjoint from both the legacy module and the new workspace (`api/marketing-os.ts` header: "that name is already the live Marketing Intelligence endpoint … and is unrelated"). | None. |
| `src/pages/Marketing/**` (the `/m` workspace) | Keep, extend per plan | The approved 52-screen module; mounted under `/m` with its own shell, design system (`mos.css`), typed client, and deriving-view reads. | Extension work lands here; new screens follow the existing kit/icons/mos.css primitives. |
| `api/marketing-os.ts` | Keep, extend | The workspace's single action-dispatch endpoint (44 actions); caller-JWT + RLS posture matches the repo's other bespoke modules. | New actions append to the existing dispatch switch; keep the allow-list update posture. |
| `mos_workflows`, `mos_workflow_steps` | RETIRE: migrate into canonical `workflows` table (`kind:'role_path'`) + engine-level `workflow_versions` | Duplicates the CRM's canonical workflow engine with a marketing-only parallel definition store. | Defined in `supabase/migrations/2026-07-30_01_mos_core.sql`; read/written by `api/marketing-os.ts` (`settings_data`, `step_save`) and rendered by `SettingsPage.tsx` / `StageRail.tsx`. Migration must preserve step order, role-per-step ownership, and per-step SLAs (`required_fields`, durations) as workflow versions. |
| `mos_role_grants` | RETIRE: migrate into canonical roles + `user_roles` junction + `surface_access` | Parallel role-assignment store; the CRM already has `roles`/`profiles` and page-access machinery (`RequirePageAccess`, `useCanAccessPage`). | Defined in `2026-07-30_01_mos_core.sql`; gates every screen via `wassell_mos_role` / `wassell_mos_can` and `MarketingWorkspace`'s capability context. Map each grant (role → person) onto the canonical junction, then repoint `wassell_mos_can` call sites. |
| `mos_tasks` | PROMOTE: becomes engine-generic `workflow_role_tasks` (`subject_table`/`subject_id` polymorphism) | The task chain (open task derives status/owner via `mos_content_v`; one-open-task and rejection-note DB constraints) is the strongest piece of the module and is engine-shaped, not marketing-shaped. | Defined in `2026-07-30_01_mos_core.sql`; consumed by `task_complete`, `work_list`, the deriving views, and `TaskCard`/`StageRail`/`CommentThread`. Preserve the one-open-task-per-subject and rejection-note guarantees as constraints on the new table; repoint `mos_content_v` (or its replacement) to derive from it. |
| All other `mos_*` domain tables (`mos_content`, `mos_content_types`, `mos_scenes`, `mos_campaigns`, `mos_campaign_executions`, `mos_execution_ads`, `mos_execution_daily`, `mos_assets`, `mos_asset_links`, `mos_shoot_requests`, `mos_shoot_items`, `mos_publications`, `mos_metric_snapshots`, `mos_comments`, `mos_platform_accounts`, `mos_ref_counters`) | Keep as marketing-owned DOMAIN data | Pure domain data with no engine overlap: content items and their writing JSONB, scenes/footage, spend (campaigns → executions → ads → daily), the asset library + link table, shoot requests, per-platform publications, append-only metric snapshots, comments, platform accounts, and the ref-number allocator. | `mos_content`, `mos_content_types`, `mos_scenes` are created in the checked-in `2026-07-30_01_mos_core.sql`; the rest were applied to production 2026-07-30 (checked-in stub `2026-07-30_mos_campaigns_assets_shoots.sql` is comments-only — the DDL itself is not in the repo) plus `2026-07-31_mos_asset_file_uploads.sql` and `2026-07-31_mos_shoot_delivery_wire.sql`. All are referenced live via `.from(...)` in `api/marketing-os.ts`. Only their task/workflow/role FK edges change when §above migrations land. |

---

## 3. Canonical engine extension seams (B1–B4)

Mapped 2026-08-01 against the live DB + working tree. `supabase/schema.sql` is **stale** for
`workflows` (missing the prod-only `branches` column) and for the campaigns/assets/shoots half
of `mos_*` — the live DB is the ground truth used below.

### B1 — Workflow engine (host: canonical `workflows` + `api/_lib/workflowRunner.ts`)

| Seam | Location | How marketing extends it |
|---|---|---|
| Definition rows | `workflows` table — `id, label_ar/en, trigger_model_id, trigger_event (CHECK create/update/delete/webhook/on_due/button_click), group_id, conditions, actions, branches (prod-only), metadata jsonb, is_active` | New `kind` column (`'automation'` default / `'role_path'`); role-path steps live at `metadata.steps`, `metadata.managed_by='marketing_os'`. `trigger_event` nullable for role_paths. |
| Write path | SPA store `saveWorkflow` (`src/stores/appStore.ts:3665`) → `workflowToSupabaseRow` (`:1232`) **spreads the whole object** — new columns round-trip for free (precedent: `metadata`, added by Sales OS). | Screen 17 saves through this same path. |
| Versioning | none today | `workflow_versions` table + a `workflows` AFTER INSERT/UPDATE trigger — engine-level, fires for every writer (SPA, workflow agent, marketing editor). `mos_content.workflow_version_id` pins the frozen version. |
| Execution | Server runner `api/_lib/workflowRunner.ts` (worker-invoked via `api/internal/run-workflow-job.ts`, secret-gated; NOT inert — 3 models enrolled). | Role-path transitions = `workflow_advance_role_path()` SQL RPC (transactional open/close of role tasks), thin TS wrapper exported beside the runner; `api/marketing-os.ts task_complete` calls it. No transitions in React. |
| Tasks | `mos_tasks` (one-open-per-content partial unique, rounds, immutable results) | Promoted to engine-generic `workflow_role_tasks` (`subject_table`/`subject_id`); marketing is the first consumer. |

### B2 — Roles & permissions (host: canonical `roles` + `users.role_assignments` + `page_access`)

| Seam | Location | How marketing extends it |
|---|---|---|
| Role rows | `roles` — `id, label_ar/en, schema jsonb, is_system` | 5 marketing roles as canonical rows with a new nullable `roles.key` (`mos_ceo` … `mos_montage`). |
| Assignment | `users.role_assignments` jsonb array of `{role_id, field_values}` — **already multi-role**; edited in `src/pages/Settings/UsersPage.tsx` / `RolesPage.tsx`, evaluated by `wassell_record_passes_scope` (`supabase/schema.sql:633`) | `mos_role_grants` rows migrate into `role_assignments`; grants table dropped. Dual-role (screen 46) = client-side ACTIVE role; server authorizes the union (`wassell_mos_roles()` returns the held set). |
| Capability fn | `wassell_mos_can(text)` — referenced by every `mos_*` RLS policy | CREATE OR REPLACE over canonical assignment; **signature unchanged → zero policy churn**. |
| Surface matrix | `page_access` gates whole custom pages (`src/lib/customPages.ts:142` registers `/m` as `marketing_management`); nothing finer exists | New generic `surface_access` (role × surface_key × full/read/hidden) + `wassell_mos_surface_level()`; nav rail, المزيد sheet, search types, and counts consult it. `/m` page gate stays as-is above it. |
| Known engine bug (pre-existing) | `api/_lib/workflowRunner.ts:471` treats `role_assignments` as an array of ids (it is objects) → `recipient_mode:'role'` push resolves zero recipients | Fixed as part of B3 wiring (notifications reuse the resolver). |

### B3 — Notifications (host: NEW app-wide platform over existing channels)

There is **no existing notifications table or bell** — today's in-app alerting is
`src/components/SalesNotifications.tsx` (ephemeral store-diff toasts, 2 hardcoded events) and
its SQL mirror `records_enqueue_push`. B3 builds the app-wide `notifications` +
`notification_rules` + prefs tables (nothing marketing-branded; Sales adopts later) and delivers
ONLY through existing channels:

| Channel | Existing seam |
|---|---|
| In-app + Realtime | new `notifications` rows + Supabase Realtime (orchestrator pattern: `src/lib/realtime/RealtimeOrchestrator.ts`; mos tables are not on the publication today — the notifications table gets added) |
| Web push | `push_outbox` insert (`supabase/migrations/2026-07-29_web_push.sql:74`; consumer `worker/src/runPushJob.ts`; canonical writer example `api/_lib/workflowRunner.ts:486-543`) |
| WhatsApp (blocking events only) | `api/_lib/whatsappGateway.ts sendMessage` (`:238`) — the same facade the sweepers use; worker-side deliveries drain a queue on the existing Fly worker |
| Scheduled ticks | new poll loop on the existing Fly worker (`worker/src/index.ts` pattern) — publish-time, overdue sweep, ٨:٠٠ digest |

`MOS_EXTERNAL_EFFECTS=off` (branch env + settings row) turns every external channel into a
logged no-op; asserted before fixtures run.

### B4 — CRM attribution & outcomes (host: real CRM models via `unified_records`)

| Model | model_id | Key slugs |
|---|---|---|
| Appointments (`appointments`) | `b032a675-6237-4436-9783-a1a253855f74` | `appointment_date`, `appointment_status` (scheduled/confirmed/rescheduled/completed/no_show/cancelled), `client_id` |
| Visits (`visits`) | `372ed642-3753-40b4-9dd7-e8390f91b1f8` | `scheduled_datetime`, `client_id`; **no status field** — a visit record is the event; `visit_rating`/`rated_at` exist |
| Reservations (`reservations`) | `5a1e0ffe-0000-4000-8000-000000000002` | `reservation_date`, `reservation_amount`, `payment_status` (pending/cheque_received/paid), `client_id` |
| Ownership Transfer (`ownership_transfer`) | `5a1e0ffe-0000-4000-8000-000000000004` | `transfer_status` (pending/form_issued/scheduled/completed) — the terminal state |

Server reads go through `unified_records` under the caller's JWT (pattern:
`api/run-button-workflow.ts:150-171`). Outcomes derive from these records joined to the
append-only `client_attributions` ledger (first-touch, 90-day window, corrections via
`supersedes_id`).

**Honesty note (stated on the rules cards, screens 12/15/40):** the live Reservations model has
**no cancelled state** — the cancellation-exclusion rule is implemented and configurable, but it
currently excludes nothing for reservations until the CRM model gains such a state. Appointments
DO have `cancelled`/`no_show` and are excluded from booked-appointment counts accordingly.
Visits have no status; a visit record counts as one event.

### B6 — Bilingual overlay (host: `value_translations`)

`resolveDisplayText(raw, lang, {kind, model_hint, field_hint})` from
`src/lib/valueTranslation/runtime.ts:198` + `useValueTranslationVersion()`; cache keyed
`(target_lang, sha256(source_text))`; writes are service-role via `api/value-translate.ts`.
Marketing display surfaces call the resolver exactly like `DynamicCell.tsx` does; Arabic source
data is never rewritten.

### B5 — Schema record

The full reproducible schema (including the 16 `mos_*` tables whose DDL was previously live-only)
is checked in as the branch bootstrap (`supabase/branch-bootstrap*.sql`) — see
`docs/marketing-reference/branch-bootstrap-report.md`. Additive domain changes land as normal
migrations in `supabase/migrations/`.
