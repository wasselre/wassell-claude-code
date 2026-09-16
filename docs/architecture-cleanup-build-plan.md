# Wassell Architecture Cleanup — Build Plan (handoff)

**Created:** 2026-09-16 · **Status:** decisions locked, ready to build · **Do NOT start executing without reading the "Governing rules" section.**

This document is the executable output of an architecture audit + a decision review with the operator.
It is **self-contained** — you can build from this alone. Two companion artifacts exist (live record, not required to read):
- Decision log (every decision, live): `https://claude.ai/artifact/YSDMKKcQ62rRUMMRaSHrs7`
- Full audit report: `https://claude.ai/artifact/QMRQPb9bwGUxyGPpD6RFBm`

The prod Supabase project is **`wassell-prod`** (`zhqqsxwealdwqzrbpwyv`). Follow the root `CLAUDE.md` for all conventions (migrations, deploy, worktree, bilingual, silent-failure rules).

---

## 0. What this is, in one paragraph

The app grew a sidebar full of **raw database-model rows** and unnamed folders. The cleanup reorganizes everything around **user workspaces, recurring jobs, and contextual actions — NOT model folders**. Most models stay (they're load-bearing as data); their raw nav rows get hidden and their data surfaced inside a workspace. A set of genuinely-unused features gets **deleted** (with backups). A few new things get **built**.

---

## 1. GOVERNING RULES (non-negotiable — violating these breaks prod)

1. **Workspaces, not folders.** Never rename or reorganize sidebar model *groups*. Hide the raw model nav row and surface the model inside a workspace as a tab / contextual action. (The operator was explicit: thinking in folders = "you understood nothing.")
2. **Nothing destructive without an explicit go-ahead.** Every DELETE below is a **migration with a `_backup_<name>_<date>` snapshot first**. Deletes are the LAST phase and are individually approved.
3. **Build-dependent deletes WAIT for their replacement.** e.g. don't delete the Marketing Intelligence page until Competitor Watch reproduces its Insights feed. These dependencies are marked ⛔BLOCKED-BY below.
4. **One Workflow engine only.** `/workflow` (+ editor/logs/agent) is THE automation engine. Never introduce a second/hidden one. Sales-process config and DB triggers are not "engines."
5. **Never delete a model that is a lookup target, workflow-trigger target, rollup source, website reader, or document-template source** without handling that dependency. See the dependency facts in §4.
6. **`is_system` models cannot be dropped via the Builder UI** — they need a migration (and the `models_guard_schema_shrink` trigger blocks browser-JWT shrinks). Apply migrations yourself against `wassell-prod` (CLAUDE.md rule), then verify.
7. **Frozen tables + rollup write-paths are untouchable.** `market_listings` (frozen), and the `units → all_projects` rollup triggers; `all_projects`/`units` stay unfrozen. Geography (regions/cities/districts) are frozen lookups feeding Project Finder.
8. **Auto-created rows ≠ usage.** Don't re-justify keeping something by its row count if a trigger/machine writes it (this is why Sales Valuation is being deleted despite 1,773 rows).
9. **Verify live after each deploy** (CLAUDE.md deploy section): confirm the Vercel SHA is READY and smoke-test the change.

---

## 2. How to work through this

Execute **by phase** (§6). Within a phase, the items are mostly independent. After each phase, verify. Treat Phase 5 (deletes) as its own approved milestone. Re-read the live DB before any delete (counts may have changed).

---

## 3. Where things live (the files you'll touch most)

| Concern | File |
|---|---|
| All routes | `src/App.tsx` |
| Sidebar build logic + hardcoded nav (Home/Whiteboard/Files) | `src/components/layout/Sidebar.tsx` |
| Custom (non-model) pages: registry, per-profile access, `hidden_from_sidebar`/`archived` flags | `src/lib/customPages.ts` |
| Feature flags + retired/archived model lists (`ARCHIVED_MODULE_MODELS`, `isRetiredModel`) | `src/lib/featureFlags.ts` |
| Sales permission resolver | `src/lib/permissions.ts` |
| Model nav-hide set (`SETTINGS_ONLY_MODEL_NAMES`), `navHidden()` | `src/components/layout/Sidebar.tsx` |
| Marketing workspace shell (separate app at `/m`) | `src/pages/Marketing/MarketingWorkspace.tsx` |

**How the sidebar decides to show a model row** (Sidebar.tsx): a model gets NO nav row if it's in `SETTINGS_ONLY_MODEL_NAMES`, `isRetiredModel()` (retired assistants + `ARCHIVED_MODULE_MODELS`), or per-profile `hidden_from_sidebar`. **This is the mechanism you use to "hide a model row"** — add the model name to the appropriate hide set / mark it in featureFlags, or set the profile flag. No data is touched.

---

## 4. Live dependency facts you must respect (measured 2026-09-15)

- **Lookup hubs:** `all_projects` is a lookup target of **15** models; `clients` of **14**. `developers` ←5, `marketers` ←3, `project_officers` ←1, geography chain `countries→regions→cities→districts`. Hiding their nav rows is fine; the models must stay.
- **Active workflow triggers** (models whose triggers must keep firing even with the page hidden): `appointments`(3), `visits`(2), `financing`(1), `offer_prices`(1), `ownership_transfer`(1), `phone_calls`(1), `reservations`(1), `clients`(1), `followups`(7).
- **Document-template targets:** `reservations` + `offer_prices` feed the official PDF pipeline — keep both models.
- **Website readers (live public site reads these):** `all_projects.is_public`, `project_details`, `site_settings`, view `v_website_public`.
- **`is_public` is the sole website publish switch** (verified: the website reads only `is_public`; `show_on_website` has no reader, 0 of 96 live projects use it).
- **Sales Valuation is 100% DB-trigger-fed** off completed follow-ups (`svr_create_review_on_followup_complete` → reviews → `svr_create_correction_task` → correction tasks → `svr_recompute_daily_summary` → daily valuations). Deleting it means dropping those triggers too.

---

## 5. Decision register (source of truth for WHAT to do)

Legend: **HIDE** = hide nav row, keep model/data · **DELETE** = remove model+data+UI (migration+backup) · **BUILD** · **KEEP** · **ARCHIVE** = data retained, UI off · **DEFER**.

| ID | Decision | Type |
|---|---|---|
| D01 | `is_public` is the sole website publish authority; `show_on_website` retired | KEEP |
| D02 | Content Writer page (`/marketing/posts`, PostsContentPage) | DELETE |
| D03 | `posts_content` + `posts_batches` models/rows (is_system; posts_content has translation twins) | DELETE |
| D04 | `copywriter_chats` model + 17 rows | DELETE |
| D05 | Marketing Intelligence page (`/marketing-intelligence`) — ⛔BLOCKED-BY: Competitor Watch must first gain MI's 7-rule Insights feed + project/org panels. Keep `mkt_*` data + `mkt_intelligence_index`/`mkt_project_intelligence` RPCs | DELETE (page) |
| D06 | Content Intelligence page (`/settings/content-intelligence`) — ⛔BLOCKED-BY: Competitor Watch must first absorb the competitor-content attribution + OCR/transcript-QA surface. Keep `mkt_content_*` data | DELETE (page) |
| D07 | `/settings/marketing-ops` — keep, **improve the UI**, admin-only | KEEP/REDESIGN |
| D07b | `/settings/marketing-advertisers` page. **Consequence: retires competitor PAID-ad collection** (`mkt_ads` stays empty). Organic posts/reels/OCR unaffected | DELETE (page) |
| D08 | `/market-intelligence` (archived market-LISTINGS analytics) — leave archived behind `MARKET_LISTINGS_ARCHIVED` | ARCHIVE (no-op) |
| D09 | Build a **Projects & Inventory** workspace: Registry (all_projects) · Our Projects · Units (contextual) | BUILD |
| D10 | Hide nav rows: `developers`, `marketers`, `project_officers`, `unit_updates` (models stay = lookups) | HIDE |
| D11 | Units contextual (Units tab in a project + Finder); hide standalone `/model/units`; keep a plain admin table for bulk edit. **Never touch the units write/rollup path** | HIDE + contextual |
| D11b | **BUILD** a per-project unit-update cockpit — see §8.1 | BUILD |
| D12 | Registry data-quality fields | SKIP |
| D13 | Build one **Sales Workspace**: Overview · Clients · Work Queue · WhatsApp. Lifecycle models surfaced THROUGH it | BUILD |
| D14 | Merge My Clients into the Clients list (mine/all scope + situation tabs) | BUILD |
| D15 | Work Queue = My Tasks. **DELETE Follow-up Queue** (page + `wa_followup_suggestions` table + the Claude batch that writes it). ⛔BLOCKED-BY: Work Queue exists | BUILD + DELETE |
| D16 | Port the "clients with no next action" audit (`computeNoNextAction`, `src/pages/Sales/lib/queueViews.ts`) into the manager Overview, repoint the SalesManager deep link, THEN retire `SalesTasksPage` (`/sales/tasks`) | BUILD + DELETE |
| D17 | Sales Manager → the manager Overview of the Sales Workspace | BUILD |
| D18 | **DELETE** Sales Studio + Sales Process pages. Config freeze OK'd: the guided Follow-up Workspace keeps running on the current sales-process config, which becomes un-editable in-app | DELETE (pages) |
| D19 | Project Finder stays standalone + embeddable; **never re-implement or swap in an AI matcher** | KEEP |
| D20 | Hide milestone rows: `offer_prices`, `reservations`, `financing`, `ownership_transfer`, `visits`. Surface on Client 360. **Keep models + triggers + doc-template bindings** | HIDE |
| D21 | Hide `phone_calls` list; calls shown contextually (Client 360). Keep model + Hatif webhook writer + workflow | HIDE |
| D22 | Financing calculator (`/financing`) hidden from main nav; stays a contextual tool deep-linked from a client. (Distinct from the `financing` MODEL) | HIDE + contextual |
| D23 | Hide `client_property_options` flat list; it lives in Client 360's Options tab. Keep model | HIDE |
| D24 | Hide raw `chat_templates` row; templates reachable inside Chats as a Templates tab. Keep model + data (powers every send flow) | HIDE |
| D25 | **Dissolve the "New Group" model-folder entirely** (not rename). Its lifecycle models are hidden and surfaced through the Sales Workspace | RESTRUCTURE |
| D26 | **DELETE the entire Sales Valuation operation** — 5 models + `svr_*` triggers/functions + 7 pages. Auto-created ≠ used | DELETE |
| D27 | `sales_mistake_categories` + `sales_valuation_settings` deleted as part of D26 | DELETE |
| D28 | Build **one Team & Access page** covering ALL access: Users, Profiles, Roles (sales), **Marketing** (`role_capabilities`+`surface_access`), + WhatsApp Permissions. Unify the UI; **keep the distinct engines/tables/resolvers** — do not fuse them | BUILD |
| D29 | WhatsApp Permissions moves into Team & Access | BUILD |
| D30 | WhatsApp admin hub = Numbers + AI-Agent policy | BUILD |
| D31 | Move Webhooks under Workflow/integrations (not WhatsApp) | RESTRUCTURE |
| D32 | Chats stays the top-level WhatsApp surface (Sales Workspace WhatsApp tab) | KEEP |
| D33 | Remove the vestigial "Show on Website" toggle from the project page (`ProjectDetailPage.tsx:637`). Keep `website_display_order` | DELETE (toggle) |
| D34 | Build **ONE Website Management page** for everything website-related — see §8.2 | BUILD |
| D35 | Keep `site_settings` + `project_details` models/rows (live website readers); only the editor changes | KEEP |
| D36 | AI-usage reporting gaps | DEFER (other session) |
| D37 | Enter unpriced provider rates | DEFER (other session) |
| D38 | **Activate `unanswered_requests`** into the sales process (follow-ups + chats); fix why the workflow yields 0 rows; give it a reader — see §8.3 | BUILD |
| D39 | Keep `/settings/translations` (metadata-label editor) under System Administration | KEEP |
| D40 | Gather admin/system pages into one **System Administration** area (admin-only) | RESTRUCTURE |
| D41 | Hide geography model nav rows (regions/cities/districts/countries); keep data (Finder) | HIDE |
| D42 | **Security fix:** add `RequireAdmin` to `/geo-review` (App.tsx ~L462) | FIX |
| D43 | **DELETE** Whiteboard: pages + hardcoded Sidebar link + store slice + `whiteboards`/`whiteboard_folders` tables (8 boards — backup first) | DELETE |
| D44 | **DELETE** Dashboards module: pages + `dashboards`/`scheduled_reports`/`scheduled_report_runs` tables + `get_public_dashboard` RPC + Settings card + Header link. ⚠️ Removes the only public share route (`/public/dashboard/:token`) — **confirm no public link is circulating first** | DELETE |
| D45 | **DELETE** `developer_knowledge` model + 13 rows (never-wired KB) | DELETE |
| D46 | **KEEP** `real_estate_offices` (19k) — hide the nav row now, **activate later with the الطلبات الغير مجابة / unanswered-requests feature** (D38). Do NOT archive | HIDE (activate later) |
| D47 | **ARCHIVE** `advertisers` (17 rows) — data retained, UI off, shares market-listings archived state | ARCHIVE |
| D48 | **DELETE** `marketing_operations` model + 3 rows (is_system; legacy Higgsfield; already archived) | DELETE |

---

## 6. Execution sequence (do in this order)

### Phase 0 — Standalone fix (independent)
- **D42** — add `RequireAdmin` to `/geo-review`.

### Phase 1 — Reversible navigation (no data, no builds; instantly revertible)
- **D25** dissolve "New Group"; **D10, D11, D20, D21, D22, D23, D24, D41** hide raw model rows; **D46, D47** hide their nav rows; **D31** move Webhooks under Workflow; **D40** form the System Administration area.
- Add redirects for any hidden deep link so bookmarks/links don't 404.
- **Verify:** all 20 active workflows still resolve; a non-admin Sales profile still works; nothing 404s.

### Phase 2 — Build workspaces & close coverage gaps
- **D13/D14/D15(build side)/D17** Sales Workspace incl. **D16** (port `computeNoNextAction`).
- **D09** Projects & Inventory workspace.
- **D28/D29** Team & Access.
- **D30** WhatsApp admin hub.
- **D33/D34/D35** one Website Management page.
- **D05/D06 prerequisites**: Competitor Watch gains MI's Insights feed + project/org panels, and absorbs Content Intelligence's attribution/OCR-QA. **D07** improve marketing-ops UI.
- Surface **D20–D24** contextually (Client 360 milestones/calls/options, Chats Templates tab, financing from client).

### Phase 3 — New feature builds (details deferred; can run in parallel)
- **D11b** unit-update cockpit (§8.1).
- **D38 + D46** activate unanswered-requests + wire real_estate_offices (§8.3).

### Phase 4 — Verify & observe
- Re-check workflows, triggers, deep links, RLS. Confirm no hidden page was actually needed.
- **Before D44:** confirm no `/public/dashboard/:token` link is in circulation.

### Phase 5 — Deletes (each a migration + `_backup_` snapshot; separately approved)
- **No build dependency:** D02/D03, D04, D18, D26/D27, D43, D45, D48, D07b.
- **After their Phase-2 build lands:** D15 (after Work Queue), D16 (after audit port), D05 (after CW Insights), D06 (after CW absorb), D44 (after public-link check).

### Phase 6 — Archive
- **D47** advertisers. (**D08** no-op.) **Deferred:** D36/D37.

---

## 7. Delete execution recipes (migrations)

Every delete: `BEGIN` → snapshot rows to `public._backup_<model>_<yyyymmdd>` → drop dependents → drop the model row + its `records` (or the physical table) → clean up code (routes, dispatchers, nav) → `COMMIT` → verify.

- **posts_content / posts_batches (D02/D03):** `is_system=true`. Remove the `pair:body/headline/prose/spec` **translation-twin policies** for posts_content in the same migration (see CLAUDE.md "Durable bilingual translation"). Remove the `/marketing/posts` route + `posts_content` entry in `customPages.ts` + `PostsContentPage` code.
- **copywriter_chats (D04):** already UI-retired (in `RETIRED_ASSISTANT_MODELS`). Drop model + 17 records.
- **Sales Valuation (D26/D27):** drop triggers/functions `svr_create_review_on_followup_complete`, `svr_fill_review_computed`, `svr_create_correction_task`, `svr_sweep_overdue_tasks`, `svr_recompute_daily_summary` (AFTER-triggers off `followups` — safe). Drop the 5 models + records (unfrozen, `is_system=false`). Remove the App.tsx custom dispatch (lines ~234-244, ~325-329) + `src/pages/SalesValuation/*`.
- **Follow-up Queue (D15):** remove `FollowUpQueuePage` + `/sales/follow-up-queue` route + `follow_up_queue` customPages entry; drop `wa_followup_suggestions` table; retire the Claude batch that writes it.
- **Sales Studio/Process (D18):** remove `src/pages/SalesStudio/*` + `src/pages/SalesProcess/*` + routes + `sales_studio`/`sales_process` customPages entries. **Leave the sales-process config data** (`sales_processes` row) — the guided Follow-up Workspace still reads it.
- **Whiteboard (D43):** remove `src/pages/Whiteboard/*`, the hardcoded Sidebar NavLink (`Sidebar.tsx:287-295`), the store slice, and drop `whiteboards` + `whiteboard_folders`.
- **Dashboards (D44):** remove `src/pages/Dashboard/*`, the `/dashboards`, `/scheduled-reports`, `/public/dashboard/:token` routes, the Settings card + Header link; drop `dashboards`, `scheduled_reports`, `scheduled_report_runs`, `get_public_dashboard` RPC.
- **developer_knowledge (D45):** drop model + 13 rows (backup — hand-authored, no other copy).
- **marketing_operations (D48):** `is_system=true`; already archived. Drop model + 3 rows.
- **marketing-advertisers (D07b):** page only — remove `MarketingAdvertisersPage` + `/settings/marketing-advertisers` route + Settings card. (Data/pipeline config stays; this just retires the paid-ad confirm UI.)

---

## 8. New builds — design intent (details to be refined with the operator)

### 8.1 Per-project unit-update cockpit (D11b)
The operator's flow: **(1)** first update done manually with Claude to work out the steps / Browserbase code, then saved as a **per-project skill on the operator's Claude account**; **(2)** those instructions saved in the app + a **weekly scheduled job** runs the skill through the operator's Claude account on a **Fly machine**; **(3)** a screen where, when a job needs an operator decision, Claude asks and the operator answers there.
Reuse, don't reinvent: the **Claude Code runner on Fly** (already runs Claude-account jobs) for execution; the **lead-portal registration** feature as the template for the human-in-the-loop screen (job queue + Fly worker + `awaiting_input` handshake → operator answers on a screen → worker resumes); `unit_updates.migration_instructions` + `update_frequency` for the per-project recipe + cadence; a Fly-worker tick for scheduling (pg_cron not enabled).

### 8.2 One Website Management page (D33/D34/D35)
A single control center that manages EVERYTHING website-related: global site settings (`site_settings`) AND per-project pages — which projects are published (`is_public`), each project's page content/images/sections, display order, visibility. Replaces the `/settings/website` redirect + `/settings/project-details` + the raw record forms + the per-project publish flags. Reads `site_settings` + `project_details` underneath (unchanged). Remove the dead "Show on Website" toggle.

### 8.3 Activate unanswered-requests (D38 + D46)
Wire unanswered-request capture into the sales process (follow-ups + chats). Investigate why the active "Create Unresponded Requests" workflow currently yields 0 rows (check its trigger/conditions on `followups`), give it a reader inside the follow-up / chats surfaces, and wire in `real_estate_offices` (same الطلبات الغير مجابة model group) as the operator intends. Not a new engine — activate the existing workflow + model + directory.

### 8.4 Sales Workspace (D13-D25) & Projects & Inventory (D09-D11) & Team & Access (D28-D29)
Reuse existing shared libs — these are not from scratch:
- Sales: `src/pages/Clients/lib/{clientView,clientFilters}.ts`, `src/pages/Sales/lib/{myWork,queueViews}.ts`, `src/pages/Clients/lib/useClientWhatsApp.tsx`. Client 360 (`ClientDetailPage`), Follow-up Workspace (`FollowUpWorkspacePage`), Chats (`ChatsSplitPage`) become anchored drill-ins.
- Projects: `ProjectsListPage`, `OurProjectsPortfolioPage`, `ProjectDetailPage`, `src/pages/Projects/components/UnitsInventory.tsx`.
- Team & Access: `src/pages/Settings/{ProfilesPage,UsersPage,RolesPage}.tsx` + `permissions.ts`; keep the roles `domain='sales'` filter and `is_admin`/`last_admin`/email-match invariants; surface Marketing `role_capabilities`/`surface_access` (from `/m` SettingsAccess) as another section — **don't fuse the engines**.

---

## 9. Deferred / out of scope for this plan
- **D36/D37** AI-usage reporting gaps + provider rates — the operator is handling AI spending in a separate session. Don't touch `/settings/ai-usage` here.

---

## 10. Definition of done for each phase
- Phase 1: sidebar shows only the intended workspace entries; every hidden model still reachable by direct URL/contextual action; all workflows verified firing; no 404s.
- Phase 2/3: each new workspace/page functions and preserves the escape hatches (`?generic=1` etc.); coverage gaps (no-next-action audit, CW Insights) built and verified.
- Phase 5: each delete migration applied to `wassell-prod`, backup table present, code removed, app builds + deploys READY, smoke-tested; no orphaned routes/refs (grep the model name across `src/`, `api/`, `worker/`, `supabase/`).
