# Wassell — Model Architecture Migration Decision Plan

> **Status:** Decision plan only. No code, no migrations, no file changes implemented.
> **Date:** 2026-06-25
> **Author:** Claude (deep audit of live `wassell-prod` DB + working tree)
> **Scope:** Every model currently in the app (43 models, all unfrozen JSONB as of audit).

---

## A. Executive Recommendation

**Do NOT rip out the Model Builder, and do NOT do a from-scratch rewrite to hand-coded tables. Instead, migrate the core business spine to typed Postgres tables *through the seam the app already has*, model-by-model, and demote the Builder to a customization/admin layer.**

The decisive finding from the audit is that **the migration target already exists in the codebase and is unused in production.** Wassell already has:

1. **A read seam** — the `unified_records` view (`supabase/schema.sql:2237`), a `UNION ALL` of the `records` table plus each frozen model's `<name>_v` JSONB-shape view. Every consumer (UI, analytics, all four AI agents, both workflow engines) reads `(id, model_id, data jsonb, created_by_user_id, created_at, updated_at)` and never branches on storage.
2. **A write seam** — `record_save` / `record_delete` RPCs (`supabase/schema.sql:2995`, `:2381`) that dispatch on `models.is_hardcoded`.
3. **A migration mechanism** — `freeze_model()` (`supabase/schema.sql:1937`), which promotes a JSONB model to a dedicated typed table with junction tables for multi-value fields, subtables for `table` fields, regenerated RLS policies, and a `<name>_v` view that re-emits the typed columns back as `data jsonb` so **nothing downstream breaks**.

**Crucially: zero models are frozen in production today** (`is_hardcoded = false`, `table_name = null` for all 43). The platform built the entire JSONB→typed-table machinery and never turned it on. The "development overhead" the user is feeling is the overhead of running the *entire* app — including the core sales spine — on the dynamic JSONB path, when a structured path already exists.

**Therefore the recommendation is a refinement, not a revolution:**

| | |
|---|---|
| **Migrate to typed tables** | The transactional/relational **core spine** (clients, followups, units, all_projects, appointments, visits, phone_calls, offer_prices, reservations, financing, ownership_transfer) and the **reference/geography** tier (regions, cities, districts, developers, real_estate_offices). |
| **Vehicle** | A **hardened, hybrid extension of `freeze_model`** — typed columns for engineer-owned core fields **plus** a `custom jsonb` overflow column for Builder-added fields. Keep the `unified_records` + `record_save` seam so the generic UI keeps working unchanged. This is the "core columns + JSONB custom fields" hybrid (option 3) realized through existing infrastructure. |
| **Stay dynamic (JSONB / Builder)** | Low-stakes business + customization + sandbox models (competitors, tasks, contacts, chat_templates, targeted_projects, our_projects, project_details, marketing_operations, reel_scripts, prompt_snippets, design_templates, image_presets, unanswered_requests). |
| **Keep as system custom-UI (not "tables")** | Conversation/job models that store inline message/job arrays and render bespoke pages (chats, ai_chats, matching_chats, copywriter_chats, image_chats, decks, data_migration). These are **not relational record stores** and gain nothing from typing. |
| **Become config-only** | site_settings (223 fields, 1 row), sales_valuation_settings, sales_mistake_categories. |
| **Demote the Builder** | After core models are typed, the Builder becomes a **Customization Studio**: it edits the `custom jsonb` overflow on core models (read-only on engineer-owned columns, exactly as `ModelEditor.tsx:35` already renders for frozen models) and remains the full authoring surface for Tier-3 dynamic models. Core schema changes go through hand-written SQL migrations, as CLAUDE.md already prescribes for frozen models. |

**Why not "migrate everything"?** The generic renderer, analytics engine, RLS scope engine, and AI agents are all *decoupled from physical storage* and *coupled to field slugs*. Migrating Tier-3/Tier-4 models buys nothing (low row counts, no dev overhead, actively edited in-app) and costs a migration each. Evidence below.

**Why not "keep everything dynamic"?** Five concrete, documented pain sources fall hardest on exactly the high-row, high-relationship core models:

- **Whole-dataset-in-browser-memory.** `initialize()` loads *every record of every model* into one in-memory map (`appStore.ts:2028-2034`); filtering/sorting/search/pagination all run in React (`RecordListPage.tsx:244-298`), not SQL. With `real_estate_offices` at **19,291 rows**, `districts` at **3,732**, `all_projects` at **1,064**, `units` at **943**, this scales with *total* row count in the client. This is the single biggest scaling liability and it is invisible until it tips.
- **Version-conflict CPU storms** (incident 2026-06-02; circuit breaker at `appStore.ts:822-851`) — a JSONB-record concurrency artifact.
- **Fragile mirrors/rollups** — render-time JS hops (`mirrorResolver.ts`) and trigger-maintained aggregates (`2026-06-15_persist_project_rollups.sql`) that silently break on rename/refactor.
- **No compile-time schema** — engineers can't rely on field shape; every reader does defensive `data->>slug`.
- **1000-row PostgREST truncation class of bug** (`appStore.ts:1151`).

---

## B. Model-by-Model Decision Matrix

Legend — **Target**: `TABLE` (typed, hybrid: core columns + `custom jsonb`), `REF` (clean reference table + FKs), `JSONB` (stay Builder-managed), `CUSTOM-UI` (system bespoke-UI, keep inline JSONB), `CONFIG` (config singleton/lookup). **Pri**: migration priority (1 = first). **Risk**: of migrating.

### Tier 1 — Core business spine → `TABLE` (hybrid)

| Model | id (prefix) / slug | Rows | Purpose | Key relationships (lookups) | Mirrors/Rollups/Formulas | Workflow deps | AI deps | Target | Pri | Risk | Reasoning |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **clients** | `2e86…` clients | 458 | Lead/customer master | →followups, →cities×, →districts×, →regions×, →all_projects×, unit_picker→units. **Fan-in hub**: referenced by 13 models | 0 mirror, 0 rollup; `records_fill_client_next_action` BEFORE-trigger fills next-action; `_touch_client` AFTER-trigger | Source/target of nearly every workflow (First Follow-up, all followup branches) | aiAgent `save_lead` dedups on `data->>phone`; matchAgent `get_customer_context` | TABLE | **2** | High | Spine of the whole CRM; highest fan-in. Typed columns kill the version-storm + phone-canon bugs. Trigger porting required. |
| **followups** | `764e…` followups | 858 | Task/activity engine | →clients, →appointments, →phone_calls, →chats, →visits×, self×2 (previous/source) | **5 mirrors + 1 section_mirror** (client name/phone surfaced); `_touch_client` source | Hub of 8+ workflows (branch on `call_result`); server-runner **rejected** by enrollment gate (whatsapp action) | Follow-up Workspace (hardcoded slug config `salesProcess/config.ts`) | TABLE | **3** | High | Highest write-churn model; mirrors are fragile. Self-referential FKs + appointment/visit links. Port mirrors to a `_v` join. |
| **units** | `7ca3…` units | 943 | Inventory line-items | →all_projects, →developers; unit_picker target | **4 mirrors**; drives `records_touch_project_on_unit_change` → all_projects rollups | none direct | aiAgent/matchAgent read unit aggregates via project rollups | TABLE | **4** | High | High row count, feeds the rollup triggers. Must port `records_touch_project_on_unit_change` to the typed write path *before/with* all_projects. |
| **all_projects** | `220c…` all_projects | 1,064 | Project master (incl. competitor projects) | →cities, →developers, →districts, →regions. **Fan-in hub**: 9 models + our_projects | **11 trigger-maintained rollups** (`recalc_project_rollups_data`), 4 subtables, 3 multiselects | `Targeted Projects` workflow (on `is_targeted`) | aiAgent/matchAgent/copywriter `get_project` split details vs rollups by `is_rollup` | TABLE | **4** | **Highest** | Heaviest model (50 fields, 11 rollups, subtables). Rollup triggers + scope must be ported atomically. Co-migrate with units. |
| **appointments** | `b032…` appointments | 7 | Site-visit bookings | →clients, →all_projects, →followups | none | `Appointment booked`, `No-Show Recovery`, `Auto-close no-show` (on_due) | match `propose_task` | TABLE | **5** | Med | Low rows now but core to sales pipeline + `on_due` sweeper. Easy migrate, high future value. |
| **visits** | `372e…` visits | 5 | Completed visits + rating | →clients, →our_projects, →followups, unit_picker→units× | save-time linked-create (createMissingLinkedRecords) | `Visit → After-Visit` | visit-rating token trigger | TABLE | **5** | Med | Save-time linked-create + rating token trigger (`reference_record_trigger_search_path`) must be preserved. |
| **phone_calls** | `1ef3…` phone_calls | 638 | Call log (Hatif) | →clients, →followups | none | `Apology WhatsApp on missed call` (on create) | call_history derived panel reads this | TABLE | **6** | Med | High rows, append-heavy, simple shape — ideal early typed table. Webhook writes via `record_save` already. |
| **offer_prices** | `5a1e0ffe…02` offer_prices | 1 | Price offer (sales) | →clients, →our_projects, unit_picker→units | none | `Offer Created → Offer Follow-up` | document-generation template binding | TABLE | **7** | Low | Sales-transaction model; near-empty so migration is cheap. Typed now = clean foundation for the offer→reservation→financing→deed chain. |
| **reservations** | `5a1e0ffe…02`* reservations | 1 | Unit reservation | →clients, →offer_prices, →our_projects, unit_picker→units | none | `Reservation → Financing Follow-up` | document-generation | TABLE | **7** | Low | Same chain; cheap now. |
| **financing** | `5a1e0ffe…03` financing | 0 | Mortgage tracking | →clients, →our_projects | none | `Financing Status Updated` | — | TABLE | **7** | Low | Empty — migrate as greenfield typed table. |
| **ownership_transfer** | `5a1e0ffe…04` ownership_transfer | 0 | Deed transfer (إفراغ) | →clients, →our_projects, unit_picker→units | none | `Ownership Transfer → Closed Won` | — | TABLE | **7** | Low | Empty — greenfield. Completes the deal pipeline as typed tables. |

\* IDs truncated; reservations is `5a1e0ffe-…-000000000002` per audit.

### Tier 2 — Reference / geography → `REF` (clean tables + real FKs)

| Model | slug | Rows | Purpose | Relationships | Target | Pri | Risk | Reasoning |
|---|---|---|---|---|---|---|---|---|
| **regions** | regions | 13 | KSA regions (top of geo hierarchy) | parent of cities | REF | **1** | Low | Tiny, stable, pure reference. Clean FK hierarchy regions←cities←districts. Ideal first migration (proves the pattern at zero risk). |
| **cities** | cities | 152 | Cities | →regions | REF | **1** | Low | Same. |
| **districts** | districts | 3,732 | Riyadh+ districts | →cities, →regions | REF | **1** | Low-Med | High row count (memory pressure) + pure reference → strong migrate signal, low semantic risk. |
| **developers** | developers | 194 | Real-estate developers | parent of units/all_projects | REF | **1** | Low | Stable reference. |
| **real_estate_offices** | real_estate_offices | **19,291** | Office directory | none | REF | **1** | Low | **Largest model.** No relationships, no workflows, no rollups — but it's 19k rows loaded into browser memory on every boot. Migrating it (and serving it via server-side paged query) is the single highest-leverage memory win. |

### Tier 3 — Stay dynamic → `JSONB` (Builder-managed)

| Model | slug | Rows | Why it stays | Target |
|---|---|---|---|---|
| **competitors** | competitors | 636 | Marketing reference + reel knowledge base; actively re-analyzed in-app; copywriter reads `data.type`/analysis slugs. No transactional role. | JSONB |
| **our_projects** | our_projects | 11 | Thin lookup+section_mirror sidecar over all_projects. Migrate *only if* all_projects forces it; otherwise leave. | JSONB |
| **targeted_projects** | targeted_projects | 13 | Dedup sidecar maintained by the `Targeted Projects` workflow. | JSONB |
| **project_details** | project_details | 3 | 61-field config-ish sheet, 2 subtables, 3 rows. Low stakes. | JSONB |
| **marketing_operations** | marketing_operations | 3 | 10-mirror dashboard view over a single project lookup — pure display aggregation. | JSONB |
| **reel_scripts** | reel_scripts | 1 | Copywriter output sink. | JSONB |
| **tasks** | tasks | 16 | User-created generic task model. | JSONB |
| **contacts** | contacts | 2 | User-created. | JSONB |
| **chat_templates** | chat_templates | 11 | WhatsApp message templates. | JSONB |
| **prompt_snippets** | prompt_snippets | 13 | Migration prompt library. | JSONB |
| **design_templates** | design_templates | 2 | Templates Library. | JSONB |
| **image_presets** | image_presets | 3 | Brand presets for image gen. | JSONB |
| **unanswered_requests** | unanswered_requests | 0 | Empty user model. | JSONB |

### Tier 4 — System custom-UI (inline message/job arrays) → keep `CUSTOM-UI` (JSONB)

| Model | slug | Rows | Why NOT a typed table | Target |
|---|---|---|---|---|
| **chats** | chats | 250 | WhatsApp threads; messages in `chat_messages` (Realtime). Custom two-pane UI. | CUSTOM-UI |
| **ai_chats** | ai_chats | 19 | Sales agent; `data.messages[]` inline. Bespoke split-pane. | CUSTOM-UI |
| **matching_chats** | matching_chats | 17 | Project-matching assistant; inline messages. | CUSTOM-UI |
| **copywriter_chats** | copywriter_chats | 17 | Copywriter; inline messages. | CUSTOM-UI |
| **image_chats** | image_chats | 136 | Creative Workspace v3; `data.generations[]` + `media_assets`. Optimistic-concurrency tuned. | CUSTOM-UI |
| **decks** | decks | 21 | Deck-gen jobs; status driven by Realtime + Fly worker. | CUSTOM-UI |
| **data_migration** | data_migration | 55 | Migration wizard drafts; single-logical-owner records, version-unaware writes. | CUSTOM-UI |

These store **arrays of messages/generations/jobs** in `data`, render **bespoke React pages** (not the generic record table/form), and rely on tuned write semantics (optimistic concurrency, sole-writer echo-dedup). Typing them would be all cost, no benefit — and would break the inline-array model.

### Tier 5 — Sales Valuation + config

| Model | slug | Rows | Decision | Target |
|---|---|---|---|---|
| **sales_valuation_reviews** | sales_valuation_reviews | 343 | Trigger-driven (`svr_*`) quality-loop records; →clients/followups/categories, 4 mirrors. **Defer** — recently built, trigger-coupled. Migrate later with the Tier-1 wave *only if* dev overhead proves real. | JSONB→TABLE (Phase 5, conditional) |
| **sales_correction_tasks** | sales_correction_tasks | 0 | Part of the same svr_* loop. | JSONB |
| **sales_rep_daily_valuations** | sales_rep_daily_valuations | 2 | svr_* daily summary. | JSONB |
| **sales_mistake_categories** | sales_mistake_categories | 13 | Lookup/enum table. | CONFIG (REF) |
| **sales_valuation_settings** | sales_valuation_settings | 1 | Singleton settings. | CONFIG |
| **site_settings** | site_settings | 1 | **223 fields, 15 sections, 1 row.** Pure config singleton for the public website. | CONFIG |

---

## C. Relationships, Lookups & Cardinality Audit

The complete relationship graph (extracted live). **Two fan-in hubs dominate: `clients` and `all_projects`.** All lookups currently store the **target record `id`** (string) or an **array of ids** (`is_multi`) in `record.data[slug]` — never labels (`LookupCombobox.tsx:110-130`). Display labels are derived at render (`mirrorResolver.ts:250-290`).

| Source.field | Target | Card. | Current storage | Structured replacement | FK / junction | Cascade |
|---|---|---|---|---|---|---|
| clients.next_followup_id | followups | M:1 | `data.next_followup_id` (id) | `next_followup_id uuid` | FK | ON DELETE SET NULL |
| clients.preferred_cities/districts/regions/projects | cities/districts/regions/all_projects | M:N | `data[...]` (id[]) | **junction tables** `clients__preferred_*` (record_id, target_record_id) | FK both sides | CASCADE on parent |
| clients.client_favorite_units | units | M:N | `data` (id[]), unit_picker | junction `clients__favorite_units` | FK | CASCADE |
| followups.client_id | clients | M:1 | id | `client_id uuid` | FK | RESTRICT (don't orphan activity) |
| followups.appointment_id / completed_by_call_id / completed_by_chat_id | appointments/phone_calls/chats | M:1 | id | FK columns | FK | SET NULL |
| followups.previous_followup_id / source_followup_id | followups (self) | M:1 | id | self-FK | FK | SET NULL |
| followups.visit | visits | M:N | id[] | junction `followups__visit` | FK | CASCADE |
| units.project_id | all_projects | M:1 | id | `project_id uuid` | FK + **trigger** | RESTRICT |
| units.developer_id | developers | M:1 | id | `developer_id uuid` | FK | SET NULL |
| all_projects.city_lookup/district_lookup/region_lookup/developer | cities/districts/regions/developers | M:1 | id | FK columns | FK | SET NULL |
| appointments.client_id/project_id/source_followup_id | clients/all_projects/followups | M:1 | id | FK columns | FK | SET NULL/RESTRICT |
| visits.client_id/source_followup_id | clients/followups | M:1 | id | FK | FK | RESTRICT |
| visits.project_id | **our_projects** | M:1 | id | FK (to our_projects, NOT all_projects) | FK | SET NULL |
| visits.units | units | M:N | id[] unit_picker | junction `visits__units` | FK | CASCADE |
| phone_calls.client_link/linked_followup_id | clients/followups | M:1 | id | FK | FK | SET NULL |
| offer_prices/reservations/financing/ownership_transfer.client_id | clients | M:1 | id | FK | FK | RESTRICT |
| offer_prices/reservations/financing/ownership_transfer.project_id | **our_projects** | M:1 | id | FK | FK | RESTRICT |
| offer_prices/reservations/ownership_transfer.unit_id | units | M:1 | unit_picker | `unit_id uuid` FK | FK | RESTRICT |
| reservations.offer_id | offer_prices | M:1 | id | FK | FK | RESTRICT |
| cities.region_lookup | regions | M:1 | id | FK | FK | RESTRICT |
| districts.city_lookup/region_lookup | cities/regions | M:1 | id | FK | FK | RESTRICT |
| sales_valuation_reviews.client/follow_up/mistake_category/correction_task | clients/followups/categories/tasks | M:1 | id | FK | FK | SET NULL |
| ai_chats/matching_chats/copywriter_chats.linked_* | clients/all_projects | M:1 | id | leave as `data` (Tier-4) | — | — |
| reel_scripts/targeted_projects/chat_templates/tasks/marketing_operations.project | all_projects | M:1 / M:N | id / id[] | leave as `data` (Tier-3) | — | — |

**Critical relationship facts:**
1. **Transaction models (offer/reservation/financing/ownership_transfer) link `project_id → our_projects`, not `all_projects`.** `our_projects` (11 rows) is the *owned-inventory* subset; `all_projects` (1,064) includes competitor projects. Any structured schema must preserve this two-tier project model — do **not** collapse them.
2. **`unit_picker` has `lookup_model_id = null`** — it's a hardcoded special picker bound to `units` (`DynamicCell.tsx:419-444`). Its FK target is implicit; the migration must hardcode `→ units`.
3. **Where lookups are consumed** (so each FK migration knows its blast radius): **Forms** (`DynamicField.tsx:353`, `LookupCombobox`), **Tables/Cards** (`DynamicCell.tsx:373-417`), **Dashboards** (analytics `grouping.ts:63-69` resolves field-id→slug), **Workflows** (conditions + `{slug}`/`{lookup_slug.target}` tokens, `workflowEngineCore.ts:202-215`), **Automations** (DB triggers read `data.<slug>`), **AI** (all four agents read `data.<slug>` for project/client context), **Project matching** (`matchAgent.ts:579-798` scores on lookup'd geo + ranges), **Filters/Views** (`scopeFilters.ts` + saved-view conditions reference field-ids→slugs).

---

## D. Mirrors & Section Mirrors Audit (major migration risk)

**Nothing is stored for `mirror` fields — every value is a render-time JS hop through a sibling lookup** (`mirrorResolver.ts:25-26`: "NO data is stored for mirror fields"). `section_mirror` is the same, plus an optional **local-override map** stored at `record.data[container.name]` (`sectionMirrorExpand.ts:287`). There is **no `lookup_path` property** — a mirror is defined by exactly two props: `mirror_via_lookup_field_id` (the sibling lookup field's **UUID**) + `mirror_target_field_name` (the target slug). One hop only; chained mirrors are forbidden (`mirrorResolver.ts:60-62`).

| Mirror location | Hops through | Surfaces | Stored? | Recommended after migration | Breaks if… |
|---|---|---|---|---|---|
| followups (5 mirrors + 1 section_mirror) | `client_id` lookup → clients fields (name, phone, etc.) | Workspace, tables | Derived | **`<name>_v` view JOIN** (computed column in the per-model view) | client_id renamed, or the sibling lookup field UUID changes |
| units (4 mirrors) | `project_id` → all_projects fields | tables | Derived | `_v` JOIN | project_id renamed |
| sales_valuation_reviews (4 mirrors + section_mirror) | client/follow_up lookups | review UI | Derived | `_v` JOIN | source lookups change |
| marketing_operations (10 mirrors) | single `project` lookup → all_projects | dashboard | Derived | `_v` JOIN (or keep JSONB — Tier-3) | project lookup removed |
| our_projects (1 mirror + 3 section_mirror) | `project` → all_projects | sidecar | Derived (+ overrides) | keep JSONB (Tier-3) | — |
| targeted_projects / unanswered_requests | project / client | sidecar | Derived (+ overrides) | keep JSONB | — |

**Migration rule for mirrors:** because mirrors are *render-derived*, a typed migration must reproduce them as **JOIN-backed computed columns in the `<name>_v` view** (which `regenerate_frozen_model_artifacts` already builds — it just needs mirror-aware JOIN generation, which it does **not** have today: the current freeze maps `mirror → SKIPPED`). This is the **single largest gap in the existing Freeze mechanism** and must be closed before freezing followups/units/sales_valuation_reviews. **Section-mirror local overrides** (`record.data[container.name]`) must migrate as a `jsonb` column or be folded into the `custom` overflow. **Sync-back:** section_mirror supports editable children with write-back (`section_mirror_edit_mode`/`sync_field_names`); the typed migration must route those writes to the *target* record, not the mirror host — a non-trivial server-action, not a column.

---

## E. Formulas & Rollups Audit

| Kind | Where | Evaluation today | Stored? | Recommended target | Complexity |
|---|---|---|---|---|---|
| **formula** (0 live formula fields found; `table` per-row formulas exist) | `formulaEngine.ts` (custom JS parser) | Client-only: snapshot at `saveRecord` (`appStore.ts:2779`) + live in form (`DynamicField.tsx:439`) | **Both** (snapshot in `data` + live recompute) | **App-layer computation, preserved.** A bulk migration that writes records *not through `saveRecord`* leaves snapshots stale. After typing: keep snapshot column, recompute in the form. Do **not** push to SQL generated columns (the grammar — IF/CONCAT/DAYS/ranges — exceeds simple generated-column expressions). | Low (few/no live instances) |
| **rollups** (11 on all_projects) | `recalc_project_rollups_data` (SQL, SECURITY DEFINER) + BEFORE-fill + AFTER-touch triggers (`2026-06-15_persist_project_rollups.sql`) | **DB trigger**, keyed off `records` table | **Stored** in `data`, trigger-authoritative | **Keep as DB trigger, ported to the typed write path.** When all_projects/units become typed tables, the triggers (which fire `ON records`) must move to fire on the new tables. `recalc_project_rollups_data` already matches units by scalar `project_id` OR array membership — that logic survives; only the trigger attachment point changes. | **High** — must be atomic with the all_projects+units co-migration; otherwise rollups silently zero out. |

**Testing requirement:** before cutover, assert `recalc_project_rollups_data(p)` over the typed tables equals the current stored `data` for all 11 rollups across all projects-with-units (the same equality check done at the 2026-06-15 cutover). The CLAUDE.md hard rule "SQL aggregation must stay semantically identical" extends to the typed port.

---

## F. Dashboards, Views, Cards, Maps, Search

**Headline: every UI/config surface is decoupled from physical storage and coupled to field slugs + the `unified_records` view shape.** A migration that (a) keeps the `unified_records` row shape, (b) names typed columns identically to field slugs, and (c) keeps `models.schema` in sync with DDL needs **zero UI changes**.

| Surface | Reads `model.schema`? | Reads `data` by slug? | What changes on migration | Adapter needed? |
|---|---|---|---|---|
| Record list / table (`RecordListPage.tsx`, `TableView.tsx:78,337`) | Yes | Yes | **Filtering/sorting/search/pagination run in-memory in React** — migrating to typed tables is the *opportunity* to push these to SQL (esp. for 19k/3.7k-row models). Not required for correctness; required for scale. | No (correctness); Yes (scale — server-paged query path) |
| Saved views (`model_views` table, `types/index.ts:2021`; RLS `schema.sql:798`) | resolves field-id→slug | Yes | None if slug=column. | No |
| Card builder (`CardView.tsx:180`, `CardBuilder.tsx`) | Yes (field-ids) | Yes | None. | No |
| Maps config (`model.maps_config` JSONB, `MapsView.tsx:201`, `locationUtils.ts`) | Yes (field-ids) | Yes | None — config stays on the model row; coords stay in `data`/columns. | No |
| Analytics / dashboards (isomorphic `runAnalyticsQuery`; client `useAnalyticsQuery.ts:23`, server `analyticsRun.ts:120`) | resolves field-id→slug | Yes (`filter.ts:29`, `grouping.ts:119`, `aggregate.ts:23`) | None if view-shape preserved. **No Kanban/status board exists.** | No |
| Custom buttons (`schema.custom_buttons`, `run-button-workflow.ts:159`) | Yes | Yes (`recordButtonActions.ts:38`) | None. | No |
| Global search | **Does not exist** | — | Nothing to migrate. | — |
| Builder UI (`ModelEditor.tsx:35` `isFrozen` gate) | Yes | — | **Already renders read-only for `is_hardcoded` models.** This is the demotion mechanism — it's built. | No |
| Import / Data Migration (`excelUtils.ts:493`, wizard → `record_save`) | Yes | Yes, writes via RPC | None — already writes through the dispatcher. | No |

**The one hazard across all surfaces:** column-name/slug drift, or `models.schema` not tracking DDL. The `regenerate_*` RPCs enforce this when used; a hand-written migration that drifts breaks scope evaluation **and** the analytics engine **silently** (reads `data[slug]` → null). This is why every core migration must update table DDL **and** `models.schema` atomically (the CLAUDE.md frozen-model migration template).

---

## G. Workflows & Automations

Two execution planes, both slug-keyed:

- **Plane A — client JS engine** (`workflowEngine.ts:212`, fired from `appStore.ts:2958`): runs only in the saving browser tab; reads `data[slug]`, reads `model.schema` for field types (`getFieldTypeMap`).
- **Plane B — Postgres triggers + server sweepers** (`svr_*`, `records_fill_*`, `records_touch_*`, on_due cron): fire on every `records` write; read `data.<slug>`.

**Server-authoritative runner is inert** — `workflow_capture_models` allowlist is **empty** (no migration seeds it), gated by an action-support check (`2026-06-23_workflow_capture_enrollment_gate.sql`). So server-side workflow execution is **not yet a migration constraint**.

| Automation | Trigger model · event | References | Action | After migration |
|---|---|---|---|---|
| First Follow-up | clients · created | client slugs | create followup | App-layer workflow, slugs preserved |
| Followup branches (After-Visit, Confirmation, Booking, Offer, WhatsApp) | followups · updated | `call_result`, type | create/update records, WhatsApp | App-layer workflow |
| WhatsApp No-Response Escalation | followups · on_due | followup slugs | WhatsApp | Server sweeper |
| Appointment booked / No-Show Recovery / Auto-close | appointments · created/updated/on_due | appt slugs | create followup, close | App-layer + cron |
| Apology WhatsApp | phone_calls · created | call slugs | WhatsApp | App-layer |
| Offer/Reservation/Financing/Ownership chain | offer_prices/reservations/financing/ownership_transfer | deal slugs | create followup, status | App-layer |
| Visit → After-Visit | visits · created | visit slugs | create followup | App-layer |
| Targeted Projects | all_projects · updated (`is_targeted`) | project slugs | dedup into targeted_projects | App-layer |
| **DB triggers** (`svr_*`×5, `records_fill_client_next_action`, `_touch_client`, `records_fill_project_rollups`, `_touch_project_on_unit_change`) | records · per-model | `data.<slug>` | fill/touch/aggregate | **Must be ported to the typed write path before freezing the underlying model** — they fire `ON records` and read `data`. This is the heaviest DDL work. |

**Decision:** keep workflows as **app-layer dynamic workflows** (they reference slugs, slugs survive). Keep DB triggers as **triggers, re-pointed to the typed tables**. Do not rewrite workflows into DB triggers — that would lose the in-app editability that is a product feature.

---

## H. Permissions & RLS

**~90% reusable for typed tables as-is.** The scope engine (`wassell_record_passes_scope`, `schema.sql:605`) is storage-agnostic: it reads `created_by_user_id` or `rec.data ->> field_slug`. For frozen tables, `wassell_can_view_jsonb`/`wassell_can_edit_jsonb` (`schema.sql:2281`) rebuild a synthetic `records` row from the typed columns via `jsonb_build_object(column→slug)` and call the **same** evaluator. Scope rules survive **iff column name = field slug** — which `freeze_model` enforces by construction.

| Aspect | Coupling | Migration action |
|---|---|---|
| Model-level action grants (`wassell_user_has_action`, `schema.sql:582`) | Profile JSONB, not record shape | Reuse as-is |
| Scope conditions (view/edit) | `data ->> slug` leaf; already bridged via `*_jsonb` helpers | Reuse; **audit each profile for multi-value scope rules** (see below) |
| **Multi-value scope (multiselect/multi-lookup/table)** | **Omitted from frozen policy `jsonb_build_object`** (`schema.sql:1646`) for perf → **fails closed** | **Per-model gate:** before migrating clients (8 multiselects, 5 multi-lookups) audit whether any profile's scope references a multi-value field. If yes, this breaks — design a junction-aware policy or keep that model JSONB. |
| Field-level permissions (`field_permissions`) | **Client-only** (`permissions.ts:307`), keyed by field.id | Unchanged (cosmetic today). Typed columns *enable* true column-grants later, but the app doesn't use them. |
| Audit log (`activity_log`), page access, workflow view access | Decoupled | Reuse as-is |
| Soft delete | **None** — `record_delete` is a hard DELETE | Inherit hard-delete; consider adding `deleted_at` during the typed migration if soft-delete is wanted (out of current scope). |

**The migration-blocking permission question:** for each Tier-1 model, does any `profiles.model_permissions[].view_scope/edit_scope` condition reference a **multiselect or multi-lookup** field? `clients` is the risk (8 multiselects, 5 multi-lookups). **This must be answered per-model before its migration** (Open Question Q3).

---

## I. AI Assistants

All four data-reading agents read via `unified_records` (`data jsonb`) and are **transparent to a typed migration as long as the view shape holds**. They break only if `data` stops being JSONB-by-slug.

| Agent | Reads schema? | Reads JSONB? | Migration impact | Adapter |
|---|---|---|---|---|
| **Builder Agent** (`builderAgent.ts`) | Yes (it IS the schema editor) | No (never reads records) | **`refuseIfFrozen` guard (`builderAgent.ts:678`) already locks it out of typed models — by design.** Schema edits → SQL migrations. | None (intentional) |
| **AI Sales Agent** (`aiAgent.ts`) | Yes (resolves dropdown labels) | Yes (`data->>preferred_city`, `{min,max}` ranges, `JSON.stringify(data)` scoring, `save_lead` dedup on `data->>phone`) | Works through `unified_records`; only breaks if `data` shape changes | `unified_records` view |
| **Match Agent** (`matchAgent.ts`) | Yes (`is_rollup` split) | Yes (geo/range slugs) | Same | view |
| **Copywriter** (`copywriterAgent.ts`) | Yes (rollup split) | Yes (analysis slugs on competitors) | competitors stays JSONB anyway | view |
| **Follow-up Workspace** (`salesProcess/config.ts`) | No (hardcoded slug config) | Yes (via store `AppRecord.data`) | **Coupled to specific slugs, not schema** — survives if slug names preserved; won't auto-adapt to renames | none |
| **Migrate agent** (`migrateAgent.ts`) | via caller `targetFields.ts:71` | writes via `record_save` | Only `targetFields.ts` would derive the hunt-list from column metadata instead of schema | none |

**Decision:** AI reads stay on `unified_records`. The seam already does the abstraction. No agent needs a rewrite; one (`targetFields.ts`) needs a small change only if the Builder stops being the schema source for core models.

---

## J. Target Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              Generic SPA + Agents            │
                    │  RecordListPage · DynamicField · Analytics   │
                    │  4 AI agents · Workflow engine (slug-keyed)  │
                    └───────────────┬─────────────────┬───────────┘
                       READS via    │                 │  WRITES via
                  unified_records (jsonb shape)    record_save / record_delete RPC
                                    │                 │  (dispatch on is_hardcoded)
        ┌───────────────────────────┼─────────────────┼───────────────────────────┐
        │                           │                 │                           │
   Tier 1/2 TYPED TABLES       Tier 3 JSONB       Tier 4 CUSTOM-UI          Tier 5 CONFIG
   clients, followups,         competitors,       chats, ai_chats,          site_settings,
   units, all_projects,        tasks, our_proj,   matching/copywriter/      sales_valuation_
   appointments, visits,       targeted_proj,     image_chats, decks,       settings,
   phone_calls, offers,        marketing_ops,     data_migration            mistake_categories
   reservations, financing,    project_details    (inline arrays in data)
   ownership_transfer          (records table)
   + regions/cities/districts
   + developers/offices
        │
        ├─ core fields → typed columns (engineer-owned, FK-constrained)
        ├─ custom fields → `custom jsonb` overflow (Builder-owned)  ◄── HYBRID (NEW)
        ├─ multi-value → junction tables (FK both sides)
        ├─ table fields → subtables
        ├─ mirrors → JOIN-backed computed columns in <name>_v view   ◄── FREEZE GAP TO CLOSE
        ├─ rollups → DB triggers re-pointed to the typed table       ◄── must port
        └─ <name>_v view re-emits everything as data jsonb → unified_records
```

**Concrete decisions:**
- **Which models become real tables:** Tier 1 (11) + Tier 2 (5) = **16 typed tables**.
- **Which stay Builder-managed:** Tier 3 (13) + Tier 5 config-as-JSONB.
- **Can core models still have custom fields?** **Yes — via a new `custom jsonb` overflow column** (the hybrid). This is the key new capability: `freeze_model` today is all-or-nothing (every schema field → a column). The hybrid freeze adds an overflow column so the Builder can keep adding fields to a typed model without a migration; the `<name>_v` view merges `custom` into the emitted `data`.
- **Where custom fields live:** `custom jsonb` on the typed table. Engineer fields = columns; admin fields = overflow.
- **Builder behavior after change:** **Customization Studio.** Read-only on engineer columns (already implemented — `ModelEditor.tsx:35`), full edit on overflow custom fields + all Tier-3 models. Builder-created *new models* keep creating JSONB records (no auto-DDL) — promotion to typed is a deliberate engineer action.
- **Model freezing:** **Keep and harden, don't remove.** It is the migration vehicle. Harden it with: (1) the `custom jsonb` overflow, (2) per-table `version` column for optimistic concurrency (Phase F.2.1, currently missing — frozen tables ignore `p_expected_version`), (3) mirror-aware `<name>_v` JOIN generation, (4) trigger-porting helpers, (5) junction-aware RLS for multi-value scope.
- **Future schema changes:** hand-written SQL migrations (DDL + `models.schema` update + `regenerate_frozen_model_artifacts` + `rebuild_unified_records`), per the existing CLAUDE.md frozen-migration template.
- **How admin customization coexists with dev-controlled core schema:** the column/overflow split. Admins never touch columns; engineers never touch overflow semantics.

---

## K. Migration Roadmap (Phased)

### Phase 0 — Audit & dependency graph ✅ (this document)
- **Goal:** full inventory + dependency map. **Done.** Output: this file.
- **Validation:** every model has a Tier decision; relationship graph complete.

### Phase 1 — Classify & freeze the mechanism gaps
- **Goal:** make `freeze_model` production-ready as the migration vehicle.
- **Tasks:** (1) add `custom jsonb` overflow support to `freeze_model`/`freeze_apply_row`/`regenerate_frozen_model_artifacts`/`<name>_v`; (2) add per-table `version` column + bump trigger + honor `p_expected_version` for frozen tables (Phase F.2.1); (3) add mirror-aware JOIN generation to `<name>_v`; (4) build a reusable "port records-trigger to typed table" helper; (5) junction-aware multi-value scope policy option.
- **Files:** `supabase/schema.sql` (FREEZE block), new migration.
- **Risks:** changing `freeze_model` affects every future freeze — test on a sandbox model first.
- **Validation:** freeze a **Tier-3 sandbox model** (e.g. a copy of `contacts`) end-to-end; confirm UI/analytics/RLS unchanged; confirm `custom` overflow round-trips.
- **Rollback:** none needed (no prod model frozen yet).

### Phase 2 — Migrate Tier 2 reference tables (regions, cities, districts, developers, real_estate_offices)
- **Goal:** prove the pattern at lowest risk + win the biggest memory reduction (19k offices, 3.7k districts).
- **Tasks:** freeze each (no mirrors, no rollups, no workflows); add FKs regions←cities←districts; **add a server-paged read path** for the SPA list page so 19k offices aren't loaded into memory.
- **Files:** `appStore.ts` (per-model server-query path for large REF tables), `RecordListPage.tsx`.
- **DB:** 5 freezes + FK constraints.
- **Risks:** Low. Backfill FK ids from existing `data` lookups.
- **Validation:** row counts match; lookups from all_projects/clients still resolve; memory footprint drops.
- **Rollback:** `unified_records` still unions; un-freeze path = restore from `_backup_*`.

### Phase 3 — Co-migrate all_projects + units (rollup pair)
- **Goal:** the hardest pair, done together because of the rollup triggers.
- **Tasks:** freeze both atomically; port `recalc_project_rollups_data` + both triggers to fire on the typed tables; verify rollup equality.
- **Risks:** **High** — rollups silently zero if triggers mis-point. Mirrors on units must become `_v` JOINs.
- **Validation:** all 11 rollups equal pre-migration values for every project-with-units; `get_project` (3 agents) returns identical fact sheets.
- **Rollback:** keep `_backup_all_projects_rollups_*`; un-freeze.

### Phase 4 — Migrate phone_calls, appointments, visits, offer/reservation/financing/ownership
- **Goal:** the transactional pipeline (mostly low-row, low-risk).
- **Tasks:** freeze with hybrid; preserve save-time linked-create (visits) + rating token trigger; wire FK to `our_projects`.
- **Risks:** Med. Workflows must still fire (slug-keyed — they will).
- **Validation:** each workflow fires end-to-end; document-generation still binds offer/reservation templates.

### Phase 5 — Migrate clients, then followups (the spine)
- **Goal:** highest-value, highest-risk core. Last, after the pattern is proven.
- **Tasks:** **clients first** (resolve multi-value scope question Q3); port `_fill_client_next_action` + `_touch_client`; junction tables for 5 multi-lookups + favorite_units. **Then followups** (5 mirrors → `_v` JOINs; self-FKs; port `_touch_client` source side).
- **Risks:** **Highest.** Spine of the app, highest churn, mirror-heavy.
- **Validation:** Follow-up Workspace, all followup-branch workflows, next-action fill, sales-valuation svr_* loop all intact.
- **Conditional:** migrate `sales_valuation_reviews` here only if its dev overhead is proven.

### Phase 6 — Update workflows/dashboards/AI verification pass
- **Goal:** confirm slug contract held; push large-table list queries to SQL where beneficial.
- **Tasks:** smoke-test all 17 workflows, all dashboard widgets, all 4 agents on the typed models.

### Phase 7 — Demote dynamic paths
- **Goal:** Builder → Customization Studio; lock core schema to migrations.
- **Tasks:** ensure Builder read-only on columns (done for frozen); document the overflow workflow; keep Tier-3/4 fully dynamic.

### Phase 8 — Harden
- **Goal:** column-level grants (optional), soft-delete (optional), server-side list pagination as default for typed tables.

---

## L. Database Migration Strategy (data movement)

For each Tier-1/2 model, the existing `freeze_model` already does the heavy lifting (typed CREATE TABLE, junctions, subtables, copy, RLS regen, `_v` view, `unified_records` rebuild, delete-from-records). The per-model plan layers on top:

| Concern | Strategy |
|---|---|
| Source location | `records` table, `data jsonb` (current) |
| Target | `<name>` typed table + `<model>__<field>` junctions/subtables + `custom jsonb` overflow |
| Field mapping | field-type→column-type map (`freeze_model:1996-2011`); **column name = field slug** (mandatory) |
| Type coercion | `freeze_check_coercion` pre-validates; aborts on un-coercible value (no silent loss) |
| Null/default | nulls preserved; FKs nullable unless RESTRICT |
| Enum/dropdown | → `text` column, option `value` preserved |
| Lookup id mapping | **ids are stable UUIDs — they map 1:1.** Single lookup → `uuid` FK; multi → junction `target_record_id`. No re-keying. |
| File/media | `image`/`file` slugs stay `text` (file ids) — no byte movement |
| Date/time | → `timestamptz` via `try_timestamptz` |
| Currency/number | → `numeric` via `try_numeric` |
| Duplicate detection | none auto; rely on existing app-level dedup (phone canon) |
| Validation | `freeze_check_coercion` + rollup-equality + count match |
| Failed rows | `freeze_check_coercion` returns offending rows; fix before freeze |
| Backfill | FK columns backfilled from `data->>lookup_slug`; junctions from `data` arrays |
| **Old→new id mapping** | **Identity — record `id` is preserved across freeze** (the typed table reuses the same UUID PK). All cross-model lookup ids remain valid. This is the property that makes model-by-model migration safe. |
| Rollback | `_backup_*` snapshot tables + the model is restorable by un-freeze; `unified_records` unions regardless |
| Verification queries | per model: `count(*)` parity; `recalc_*` equality (all_projects); `get_project`/`get_customer_context` agent diff; workflow smoke tests |

---

## M. Code Migration Strategy (app layers)

| Layer | Change required? | Detail |
|---|---|---|
| `unified_records` consumers (UI, analytics, agents, workflows) | **No** | View shape preserved |
| `record_save`/`record_delete` callers | **No** | Dispatcher already routes on `is_hardcoded` |
| `freeze_model` & friends | **Yes** | Add hybrid overflow, per-table version, mirror JOINs, trigger-port helpers (Phase 1) |
| DB triggers (`svr_*`, `_fill_*`, `_touch_*`, rollups) | **Yes** | Re-point from `ON records` to the typed tables (Phases 3-5) |
| `appStore.ts` list path | **Optional** | Server-paged query for large typed REF tables (Phase 2) — the memory win |
| `RecordListPage.tsx` filter/sort | **Optional** | Push to SQL for typed tables (scale, not correctness) |
| `targetFields.ts` (migrate wizard) | **Maybe** | Derive hunt-list from columns if Builder stops being schema source for core |
| Builder UI | **No** | `ModelEditor.tsx:35` already renders read-only for `is_hardcoded` |

---

## N. Testing Strategy

| Level | What |
|---|---|
| **Migration validation** | `freeze_check_coercion` clean; `count(*)` parity; **rollup equality** for all_projects (11 fields × all projects); lookup-id resolution spot checks |
| **Unit** | `recalc_project_rollups_data` parity test (typed vs JSONB); junction backfill counts; FK integrity |
| **Integration** | All 17 workflows fire end-to-end on typed models; `on_due` sweepers; svr_* loop; next-action fill; touch-cascades |
| **UI** | Record list/form/card/map render; saved views; analytics widgets; Follow-up Workspace; Builder read-only gate |
| **AI** | `get_project`/`get_customer_context`/`save_lead` return byte-identical results pre/post per model |
| **Permission** | Each profile's view/edit scope evaluated on typed table = same row set as JSONB; **multi-value scope audit per model** |
| **Concurrency** | Per-table version bump + 40001 on stale write (frozen tables must gain this — currently missing) |
| **Pre-migration gate** | Snapshot `_backup_*`; equality assertions must pass before `DELETE FROM records` |

---

## O. Rollback Strategy

1. **`unified_records` unions regardless of freeze state** — a half-migrated app still reads everything.
2. **Per-model un-freeze** is the unit of rollback (the model can be reverted to JSONB; `_backup_*` snapshot tables hold pre-migration `records` rows — pattern already used: `_backup_all_projects_rollups_20260615`, `_backup_*_20260616`).
3. **Record ids are identity-preserved**, so reverting one model never breaks another model's lookup ids.
4. **No big-bang** — strangler/model-by-model means at most one model is mid-flight; rollback blast radius = one model.
5. **Deploy-side:** app reads/writes through the seam regardless, so a rollback is a DB operation, not an app redeploy.

---

## P. Risks & Tradeoffs (brutally honest)

**Gets simpler:** compile-time schema for core models; SQL-queryable typed columns (BI, agents, website all benefit); browser memory (esp. the 19k offices + 3.7k districts); FK integrity replaces app-level id bookkeeping; the version-storm class of bug shrinks for typed tables.

**Gets harder:** schema changes on core models now need a migration (no more in-app Builder edits — *this is the intended tradeoff*, and the user already said they'll "talk to Claude"); mirrors become view-JOIN engineering; rollup triggers must be ported with surgical care; two storage shapes coexist for the whole transition.

**What may break:** rollups (if triggers mis-point — Phase 3 is the danger zone); multi-value RLS scope on frozen tables (fails closed — must audit clients); mirror values if the `_v` JOIN generation is incomplete (the current freeze SKIPs mirrors — **this gap must be closed first**); formula snapshots if any bulk write bypasses `saveRecord`.

**What should NOT be migrated yet / at all:** Tier-3 dynamic (no benefit), Tier-4 custom-UI (inline arrays, would break), site_settings (config singleton). **sales_valuation_reviews** — defer; it's new and trigger-coupled.

**What should be rewritten, not migrated:** nothing structurally — but the **mirror mechanism** for typed models is a *new* implementation (JOIN-backed `_v` columns), not a port. And **section_mirror write-back** needs a server-action, not a column.

**Dangerous paths:** all_projects+units rollup cutover (Phase 3); clients multi-value scope (Phase 5); any migration that ALTERs a column without updating `models.schema` (silent-empty bug).

**Assumptions to confirm:** see Open Questions.

**Needs tests before any change:** rollup equality; multi-value scope per profile; workflow firing on typed models.

---

## Q. Open Questions (only true blockers)

1. **Hybrid vs pure freeze:** Confirm we want the **`custom jsonb` overflow** (core columns + admin-editable custom fields on the *same* typed model). If "core models are 100% engineer-owned, no admin custom fields ever," we can use the existing all-columns freeze and skip the overflow work. **This decides Phase 1 scope.**
2. **List performance vs correctness:** Is the **19k-offices / 3.7k-districts in-browser-memory** problem an active pain (slow boot, crashes) or latent? If active, Phase 2 + server-paged list becomes priority #1 regardless of the typing decision. (The typing and the paging are separable wins.)
3. **clients multi-value scope:** Do any `profiles.model_permissions` view/edit scope rules on **clients** reference a multiselect or multi-lookup field? If yes, clients can't use the standard frozen RLS (fails closed) — needs a junction-aware policy or stays JSONB. *(I can answer this with one query against `profiles` when you greenlight Phase 5 planning.)*
4. **Builder-created new models post-migration:** Should new Builder models stay JSONB forever (promotion = deliberate engineer freeze), or should the Builder offer "create as typed table"? Recommendation: stay JSONB; promotion is explicit. Confirm.
5. **our_projects two-tier:** Confirm `our_projects` (owned inventory) stays as the FK target for deal models and is **not** collapsed into all_projects. (Strongly recommended to keep.)
