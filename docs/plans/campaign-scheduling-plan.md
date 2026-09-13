# Campaign planning, content workflow and task system — audit and implementation plan (v2.1)

**Date:** 2026-09-13 · **Status:** PLAN ONLY, nothing implemented · **Revision:** v2.1 after two reviews (mechanics corrected; architecture unchanged) · **Scope:** Marketing OS (`/m`, `mos_*`, `api/marketing-os.ts`, Fly worker `meta-ad` lane)

Sources: live wassell-prod schema + rows (queried 2026-09-13), `docs/prd/marketing-workspace.md`, six code audits (campaign hierarchy, workflow, tasks/capacity, publishing, Meta, preview/navigation), memory notes. Every claim in §1 was checked against code or the live database. Business thresholds are marked **PROPOSED** wherever they are not already an approved rule.

**What changed in v2 (from the review):**
1. Replacement production no longer waits for the winner decision (§7.3). Production decisions and performance decisions are separate calendars.
2. The fifth replacement is an explicit policy with full workload, not a half-weight reservation (§7.4).
3. One precise capacity ledger with counting rules; the "pull earlier" paragraph is replaced by a stated algorithm and a worked example proving A1/B1/C1 readiness (§4.3, §5.2, §22).
4. One production plan per creative, many placement plans per creative (§5.3).
5. Revisions re-run every approval gate on the exact package version; ad swaps never retire a running ad before its replacement is active (§9.3, §7.5).
6. A concrete commit concurrency protocol: TS plans, SQL validates under a lock every ledger writer also takes (§4.4).
7. CPL corrected (spend ÷ leads); ranking thresholds marked PROPOSED; `mkt_*` cleanup removed from scope.
8. New §22 worked examples and §23 failure cases.

**What changed in v2.1 (second review, four corrections, no architecture change):**
1. The fifth replacement: policy A now produces five per refresh unless a *banked* spare is known to exist at that refresh's production start; "rebuild the spare after it is used" is gone because it cannot land in time for consecutive weeks (§7.4, §22.2).
2. §22.1's "infeasible" variant was wrong: all six creatives fit (B2, C2 on M2 Oct 5–6). Corrected, and both examples become executable acceptance tests (§19, §22.1).
3. Remaining effort is never derived from elapsed time; `stale` reservations stay in the ledger; step effort is seeded from explicit estimates, not from `due_days`; a multi-day task's due date is its planned end, never the one-day SLA fallback (§4.3).
4. Revision scope depends on what changed: caption-only vs image-affecting text; caption confirmation is invalidated by any caption change (§9.3).

---

## 0. The short version

**Requested behaviour in one sentence:** campaigns are *planned* (how much content, who makes it, when, whether it fits) before any content or task exists; production is scheduled backward from publishing dates in batches; paid campaigns forecast weekly creative refreshes; the content workflow is one global state machine with caption as part of writing; content and tasks preview and deep-link identically everywhere.

**What exists today:** a solid production workflow engine (role paths, pinned versions, one open task per item, writer design review, Meta auto-ad on manager approval) and a capacity *rate limiter* — but **no planning layer**. Campaign creation mints content rows and fires the first task immediately. Nothing computes required content, reads workload before committing, schedules backward from a publish date, or models refreshes. Captions are not part of writing (0 of 24 live content rows carry one).

**Core recommendations (details in §20):**
1. ONE pure, deterministic **scheduling engine** used by preview and commit; commit re-plans against the live ledger inside the database and refuses if anything moved.
2. **No new parent/child table.** The child already exists (`mos_campaign_executions`). Organic campaigns get children too; every placement points at a child. Parent = union of children.
3. **Reservations** (`mos_task_reservations`) are the planning ledger; `workflow_role_tasks` stays the execution ledger. One item of remaining work exists in exactly one of them at any time.
4. Keep the 7-step post path. **No eighth step**: `design_review` already is the final manager approval and the ad trigger. Add caption to writing, server-enforced requirements, approval locks bound to package versions, and a preflight gate before the final approve.
5. Retire the Meta "AI caption → manager caption_review" phase for new content (the caption is now approved at writing review).
6. One `<ContentPreview>` modal, one `contentRoute()` resolver, one `<Thumb>` primitive. Deep links from stable keys, never stored routes.

---

## 1. Current-state findings

### 1.1 Data model (live)
| Object | What it is | Notes |
|---|---|---|
| `mos_campaigns` | Parent. `kind ∈ paid,organic`, `status ∈ planning,active,paused,done,cancelled`, `starts_on/ends_on`, `project_ids jsonb`, `budget_total`, `audience_id`, `success_measures` | No cadence, frequency or required-content fields. No status machine. 5 live rows (all paid; one is the Meta sync holder). |
| `mos_campaign_executions` | **The child campaign** (one per platform). `platform` (no CHECK), `status ∈ draft,running,paused,ended`, `platform_settings jsonb`, `platform_campaign_id`, lifetime metrics | Organic campaigns have **no children** (tab hidden). `starts_on/ends_on` never filled by the wizard. No `(campaign_id, platform)` uniqueness. |
| `mos_ad_sets` / `mos_execution_ads` | Ad set / ad. Ad row = `content_id` + `creative jsonb` (+ `auto_ad` state) + `platform_ad_id` + feed/story `pair_id` | Ad metrics **lifetime only**. No daily per-ad series. |
| `mos_content` | The creative. `campaign_id` is **provenance only** since 2026-08-28 (no FK), `project_ids`, `organic_platforms text[]`, `data jsonb`, `approval_asset_id`, `target_publish_at` | No status column (derived from the open task). **No caption in `data` on any live row.** |
| `mos_publications` | Organic placement: `(content_id, platform, account_id)` unique, `scheduled_at`, `caption`, `asset_ids`, bundle ids, `campaign_id` (nullable) | 10 rows, all `draft`, **none with `scheduled_at`**. No project, batch, grid or priority columns. |
| `workflows` kind=`role_path` + `workflow_versions` | Steps as JSONB, pinned per content | `post_std`: writing → writing_review (MM) → design (montage) → design_writer_review (writer) → design_review (MM, `auto_meta_ad`) → scheduling (writer) → publish_check (ops). `video_std`: 11 steps. |
| `workflow_role_tasks` | Execution ledger. One open row per content. `step_key`, `role_key`, `assignee_user_id`, `opened_at`, `due_at`, `round`, `result` | No route/section/action. No reservation state. |
| `mos_manual_tasks` (+`mos_task_series`) | Hand-assigned work; `kind ∈ manual, caption_review` | Consumes **no** capacity. |
| `mos_role_load`, `mos_role_sla`, `mos_load_buckets`, `mos_posting_targets`, `mos_perf_settings`, `mos_leaves` | Capacity/cadence config | Cap per role × bucket (post/video): writer 10/4, montage 4/4, others 0. SLA all 24h (one working day, Friday off, hard-coded). `production_days_per_week=6`. |
| `mos_content_versions` | Snapshot of `data`+scenes per review **round** | Not per artifact, nothing immutable, no approval state. |
| Team (active) | 1 writer, 2 montage, 1 marketing manager | Capacity must be per person. |

A **second, unwired campaign/content schema** (`mkt_internal_campaigns`, `mkt_platform_campaigns`, `mkt_content_deliverables`, `mkt_artifact_types`, `mkt_workflow_steps`, `mkt_publications`, gate triggers, immutable versions) is applied to prod and referenced by nothing in `src/`, `api/`, `worker/`. **Out of scope for this update** — do not build on it, do not remove it here; its contents and dependencies need their own verification before any cleanup.

### 1.2 Campaign creation today
Organic: name, goals, projects (multi), dates, base title + type + count → N content rows with **all** projects stamped, no dates, no platform, no publications; first task opens immediately. Paid: plus budget + executions builder (platform, settings, ad sets, ads) → one `mos_execution_ads` row per content × execution. `campaignCadence.generateCadenceDates` is dead code. `coverage.ts` measures the past.

### 1.3 Capacity and placement today
`mos_perf_place_open_task` runs inside `workflow_advance_role_path` when a step opens: first (day, person) within 30 calendar days whose count of tasks *opened that day* is under `daily_new_tasks`; silently forward-dates `opened_at`; `due_at = opened + one working day`. Backlog, manual tasks, holidays and per-person caps are invisible; leave only extends deadlines; Friday is skipped only for due dates; nothing reads `target_publish_at`. No simulation, no proposal state.

### 1.4 Workflow / approvals today
Transitions `submitted | approved | changes_requested`; a return goes to the last prior step with `creates_revision=true` (writer review has `false`, so a manager rejection of the design goes to montage, never to the writer). `required_fields`/`required_files` are advisory. Captions live on `mos_publications.caption` (organic) and `mos_execution_ads.creative.primary_text` (paid); `WritingFields` hides `caption`; the manager approves writing without one. Nothing is locked after approval; a new design file silently replaces the approved one. Audit = closed task rows + round snapshots + comments. Authorization = role ownership, not the `approve_*` capabilities.

### 1.5 Meta today
Manager approval of `design_review` → target resolution (campaign, meta execution, linked ad set, not already created) → job phase `caption` (DeepSeek) → `caption_review` manual task → manager approves → phase `create` (both design slots, saved-audience feed/story pair, welcome template, enhancements off) → verdict poll → `ad_created`/`ad_failed`. Asset/caption/project checks happen at build time, not before approve; ads default `ACTIVE`; failures need a human retry; no windowed per-creative metrics; no winner/fatigue/pause/replace logic; `meta_set_status` exists but has no UI.

### 1.6 Preview and navigation today
`ContentPreviewModal` on 2 surfaces, missing project/campaign/platform/type/dates. Thumbnails: `content_list` computes a preview but only `CreativePicker` renders it. No central route resolver (~20 bare `/m/content/:id` call sites); `tabForPhase` knows three tabs; the detail page's "open on current step" passes a step UUID where a key is expected, so it always lands on Content; two producers emit a dead `?tab=publish`; finished items land on Placements from the page but Materials from the modal.

---

## 2. Recommended architecture

```
 Campaign (parent)            ──── requirements + context only
   └─ Child campaign (per platform) = mos_campaign_executions (paid AND organic)
        ├─ Placements: mos_execution_ads (paid) / mos_publications (organic)   ← child-level, each with its OWN publishing plan
        └─ Refresh cycles + creative slots (paid only)
 Content (mos_content)        ──── referenced by placements; campaign_id = provenance
   ├─ Production plan (mos_content_plan, 1:1): required-ready, priority, stage deadlines/assignees
   ├─ Workflow tasks (workflow_role_tasks)   ← execution ledger, engine unchanged
   └─ Package versions / approvals / events
 Plan (mos_campaign_plans)    ──── the preview object; approved plan = source of reservations
   ├─ Publish batches (mos_publish_batches)       ← placement-level membership
   ├─ Task reservations (mos_task_reservations)   ← planning ledger
   └─ Creative slots (mos_creative_slots)         ← paid forecast
 Work ledger (mos_work_ledger_v) ── ONE definition of remaining work per person per day (§4.3)
 Scheduling engine            ──── pure TS; preview and commit run the same function; SQL re-validates
 Platform rule plugins        ──── distribution rules, formats, ad-build requirements, grid preview
 Global content rules         ──── workflow, approvals, locks, preview, routing, thumbnails
```

---

## 3. Campaign hierarchy

Parent = `mos_campaigns`, child = `mos_campaign_executions`, for both kinds. UI: «الحملة» / «حملة المنصة». No new table, no `parent_id`.

1. **Organic campaigns get children**: one execution per selected platform, `starts_on/ends_on` from the campaign, `platform_settings` = the platform's publishing-rule overrides. The executions tab stops being hidden for organic.
2. **Every placement points at a child**: add `mos_publications.execution_id` (paid rows already have `mos_execution_ads.execution_id`). Backfill from `campaign_id + platform`.
3. **Constraints**: `CHECK platform IN (...)` (one shared list SQL + TS); `UNIQUE (campaign_id, platform, coalesce(label,'')) WHERE archived_at IS NULL`.
4. **Roll-ups in SQL** — `mos_campaign_rollup(p_campaign_id, p_execution_id default null)`: content = distinct ids reached through placements under the campaign's children ∪ `mos_content.campaign_id = campaign`; ads = primary rows (story shadows excluded); tasks open/late (through content); next publish slots; spend/leads lifetime + ranged; plan status (batches on track / at risk). Child view = the same RPC filtered to one execution: its content (via placements), ads, tasks (content with a placement here), schedule (its batches), performance (its ads), workflow (open steps).
5. **Tasks stay content-scoped.** A task's child campaign is derived task → content → placement → execution. A creative used in two children appears in both; the task is one row.
6. Remove the legacy `mos_campaign_executions.content_id` from roll-up paths (column kept until its uses are migrated to ad rows).

Why not a real parent/child campaign table: it would duplicate the execution row field-for-field, and every Meta push/sync/attribution path keys on executions.

---

## 4. Shared preflight scheduling engine

### 4.1 Shape
`src/lib/marketingOS/scheduling/` — pure TS, importable by `api/**` (same posture as `localizedName.ts`; never imports `@/lib/supabase`).

```ts
planCampaign(input: PlanInput, snapshot: WorkloadSnapshot, rules: RuleSet, now: Date): PlanResult
```
- `PlanInput`: kind; projects with per-project counts (posts, videos) + overrides; platforms; requested range; frequency per platform; cross-post mode; paid refresh policy (§7); buffers; user overrides (locked grid positions, locked assignees).
- `WorkloadSnapshot`: read from the SAME SQL view the commit validates against (`mos_work_ledger_v`, §4.3) plus people/caps/leaves/calendar/config, plus future placements and batches. Carries `snapshot_hash` = `mos_workload_snapshot_hash()` (SQL, deterministic).
- `RuleSet`: per-platform distribution rules (§6), step effort (§4.3), global buffers.
- `PlanResult`: publish batches with grid positions (per placement); per content: production plan (required-ready, priority, stage deadlines + proposed assignees); reservations to create; per-person per-day load table (existing + proposed); conflicts; `feasible`; `earliest_feasible_range` when infeasible; the `snapshot_hash` it was computed against.

Deterministic: same input + snapshot + `now` → byte-identical output (stable sort keys, no randomness).

### 4.2 Preview → revise → commit
- `campaign_plan_preview`: load snapshot, run engine, store `mos_campaign_plans` (`status='proposed'`, `input`, `snapshot_hash`, `plan`, `feasibility`). The stored proposal is what the user reviews, reorders, and shares.
- `campaign_plan_revise`: re-run with overrides (locked positions/assignees); constraints re-checked; the row is updated.
- `campaign_plan_commit` (§4.4): re-plan on the live ledger inside the database's lock, validate, materialise (§8). Status `approved`.

### 4.3 The work ledger — one definition of capacity

**Unit:** a slot-day. Every stage of every item has an `effort` in working days (`mos_step_effort (workflow_key, step_key, bucket, working_days)`). **Seed values are explicit estimates to be confirmed by the manager, not derived from the steps' `due_days`** (those are deadline allowances, not effort): **PROPOSED** post path — writing 1, writing_review 1, design 2, design_writer_review 1, design_review 1, scheduling 0.5, publish_check 0.5; video — idea 1, idea_review 1, script 2, script_review 1, assets 2, editing 3, first_version 1, writer_review 1, review 1. After the first campaign, re-seed from the measured medians in `mos_plan_accuracy_v` (§19). Effort e occupies e consecutive working days at one slot per day for its assignee. Capacity per person per day per bucket = `mos_user_capacity.daily_slots` (fallback `mos_role_load.daily_new_tasks`); manager approvals use the `approvals` bucket (**PROPOSED** 20/day).

**Ledger rows** (`mos_work_ledger_v`: `user_id, day, bucket, item_kind, item_id, weight`) are generated from exactly three sources, and every unit of remaining work appears **once**:

| Source | When it is in the ledger | Days it occupies |
|---|---|---|
| `workflow_role_tasks` with `status='open'` | from open until closed | its `scheduled_start`..`scheduled_end` (new columns, set from the consumed reservation or from placement); if today > `scheduled_end` and still open, it occupies **today and the following working days until its remaining effort is consumed** (carried backlog), never its past days |
| `mos_task_reservations` with `status IN ('reserved','stale')` | from plan commit until consumed or released | `planned_start`..`planned_end`; a `stale` one (window in the past, step not opened) occupies **today onward** for its full effort until the repair pass re-dates it |
| `mos_manual_tasks` open | from creation until closed | its due day (or today if overdue), weight **PROPOSED** 0.5 |

Rules:
1. **Consumption is a swap.** When the workflow opens step S for content C, `mos_plan_consume_reservation` sets the reservation `consumed` (leaves the ledger) and copies its dates/assignee onto the task (enters the ledger) in the same statement. Never both.
2. **A reservation never expires while its work remains.** If `planned_end` passes and the step has not opened (upstream is late), the reservation becomes `stale` — **still in the ledger at full weight, projected from today** — and the repair pass (§8.3) re-dates it forward; it is `released` only when the content/step no longer needs doing (content archived, cycle cancelled, step skipped, or the step was opened without it — then consumed).
3. **Overdue work counts once, forward, and elapsed time is not progress.** A late open task is not counted on its past days; it is re-projected from today with its **remaining effort**. Remaining effort = full `effort` unless the assignee has recorded progress on the task (`progress_days`, optional, entered from the task card — «أنجزت يومًا من يومين»); a task nobody touched for three days still needs its whole effort. The only automatic reduction is on a `submitted`/`approved` close (remaining → 0).
3b. **Due dates respect effort.** When a step opens from a reservation, `due_at = reservation.planned_end` (which already spans the effort in working days) or `stage_deadlines[step]` if earlier; the legacy one-working-day SLA fallback applies **only** to unplanned content with no reservation and no stage deadline. Lateness (`mos_perf_late_sweep`) reads `due_at`, so a two-day design is never flagged late after one day.
4. **Multi-day work** is spread one slot per working day across its window; a 2-day design on Tue–Wed adds one slot Tue and one slot Wed.
5. **Rejections create new work.** A `changes_requested` opens a new round; the repair pass inserts reservations for the re-run stages (in priority order against the current ledger) and re-evaluates the batch (§8.3). The old approvals' ledger rows are already closed; nothing is double-counted.
6. **Leave and holidays are hard constraints**: no slot on those days for that person / anyone.
7. The TS snapshot loader reads `mos_work_ledger_v`; the SQL validator in commit reads the same view. There is one formula.

### 4.4 Commit concurrency — where the calculation happens and how the database validates it

Two campaign approvals must never both book the same remaining designer capacity. Protocol:

1. **Plan in TypeScript** (Vercel function) — `planCampaign` produces the proposed reservations `R = [{content_key, step_key, role_key, user_id, bucket, planned_start, planned_end, weight}]` and the `snapshot_hash` it planned against.
2. **Validate and write in ONE SQL RPC** `mos_campaign_plan_commit(p_plan_id, p_reservations jsonb, p_expected_hash text)`:
   a. `PERFORM pg_advisory_xact_lock(hashtext('mos_work_ledger'))` — serialises against every other ledger writer (list below).
   b. `IF mos_workload_snapshot_hash() <> p_expected_hash THEN RAISE 'plan_changed' USING ERRCODE='WS409'` — the hash is over ordered `(user_id, day, bucket, item_kind, item_id, weight)` of the ledger + caps + leaves + holidays, so any change since preview is detected.
   c. **Independent SQL re-check**: for every `(user_id, day, bucket)` touched by `R`, `SELECT sum(weight) FROM mos_work_ledger_v WHERE …` + Σ proposed ≤ cap; per-person leave/holiday check; any violation → `RAISE 'capacity_conflict' USING ERRCODE='WS409'` with the offending cells. This does not trust the TS arithmetic.
   d. Insert reservations, plan rows, batches, content shells, placements; set plan `approved`. Commit.
3. **Every ledger writer takes the same lock** (this is the part advisory locks require): `workflow_role_path_start`, `workflow_advance_role_path`, `workflow_role_task_transfer`, `mos_plan_consume_reservation`, `mos_perf_task_block`, `mos_leave_decide`, manual task insert/reassign/close RPCs (`mos_manual_task_write`), `mos_holidays`/capacity config writes (`capacity_config_save` → RPC), the repair sweep, and the cycle sweep. All are short transactions; contention is a few writes per hour. Direct table writes to these tables from the API are replaced by RPCs so no writer can bypass the protocol. (Never raise 40001/40P01 — WS409 only, per the standing rule.)
4. On `plan_changed` / `capacity_conflict` the API re-runs preview and returns the new proposal with a diff («تغيّر الحمل أثناء المراجعة: تحرك ٣ عناصر»).

Determinism + step 2c means "preview and commit use the same engine" is not a promise; it is checked: the commit's re-plan (run inside the API before calling the RPC, against the ledger read under a `SELECT … FOR SHARE`-free snapshot) must equal the stored proposal or the proposal is superseded first.

---

## 5. Backward planning from publishing dates

### 5.1 Deadlines per content (production plan)
```
need_at            = min over the content's placements of (placement planned time)     -- earliest use wins
required_ready_at  = end of the last working day before need_at's day (publish_buffer_days, default 1)
deadline[final review]        = required_ready_at
deadline[step i]              = deadline[step i+1] − effort[step i+1] working days
production_start              = deadline[first step] − effort[first step]
```
`post_std` chain (backward): design_review (final manager approval) ← design_writer_review ← design ← writing_review ← writing. `scheduling`/`publish_check` are scheduled forward from `required_ready_at` and are skipped for paid-only items.

### 5.2 Placement algorithm (how "publishing batches drive production" is guaranteed)
Items are ordered by **(need_at ascending, batch sequence, grid position)** — batch 1's items first. For each item, each stage is placed **backward list-scheduling**: the latest window of `effort` consecutive working days ending on or before its deadline where the assigned person has a free slot each day, starting from the deadline and moving earlier. Because batch-1 items are placed first, they take the slots nearest their deadlines; later batches are placed after and, when those days are full, are moved earlier into their slack. An item is placed earlier only by the search moving its window backward; it is never moved *later* than its deadline. If a stage cannot be placed on or after today → the item is infeasible → the plan reports it and computes the earliest feasible range (§6.3).

Assignee choice within a role: the person with the most free slots in the window, tie → fewest total ledger rows that week, tie → stable user id. Locked assignees (overrides) are respected.

Result: if any feasible schedule exists under these rules, batch 1 is ready by its publish date, whatever existing tasks compete — the existing tasks are already in the ledger and simply reduce free slots. §22.1 shows this with real numbers.

### 5.3 One production plan, many placement plans
- `mos_content_plan` (1:1 content): `plan_id, required_ready_at, need_at, priority, stage_deadlines jsonb {step: due}, stage_assignees jsonb, production_start, status ∈ planned, in_production, ready, at_risk, late`.
- **Placement plans** live on the placement: `mos_publications` gains `execution_id, batch_id, planned_at, grid_row, grid_col`; `mos_creative_slots.activate_on` is the paid equivalent. A creative published on Instagram Monday and TikTok Thursday has two publication rows, two batches, one production plan with `need_at = Monday`.
- Cross-post mode: production demand counts once; distribution counts per placement (the existing `coverage.ts` distinction).
- **At risk** (`mos_publish_batch_v`): a batch is `at_risk` if any member content's open task is past its `stage_deadlines[step]`, or its remaining effort no longer fits before `required_ready_at`; `blocked` if a member is blocked; `late` if `required_ready_at` passed without final approval. A content used in two batches flags both.

Task deadlines: when the workflow opens step S from a reservation, `due_at = LEAST(reservation.planned_end, stage_deadlines[S])` and the assignee comes from the reservation (§4.3 rule 3b). Unplanned content keeps today's one-working-day behaviour.

---

## 6. Organic campaign planning

### 6.1 Inputs (wizard, replaces `CampaignContentBuilder`)
Projects; global per-project quantity (posts N, videos M) + per-project overrides; platforms (→ one child each); publishing range; frequency per platform (posts/day or posts/week, weekday mask, time window; defaults from `mos_posting_targets`); cross-post mode.

### 6.2 Distribution
1. Items: project × count → `A1..An`, with content type.
2. Slots: per child, per allowed day, `posts_per_day` slots at the platform's default times.
3. Count feasibility: items ≤ slots, else propose longer range / higher rate.
4. Assign items to slots round-robin over projects with the platform plugin's `canPlace(item, slot, gridSoFar)`: Instagram — not the same project twice in one day, no consecutive same project, distinct projects within each row of 3; TikTok — its own; X — none. Bounded backtracking.
5. Each (child, day) = a **publish batch**; grid row/col for grid platforms (3 columns, newest first).
6. Preview grid is draggable; locked positions become overrides; 4–5 re-run for the rest.

### 6.3 Preview shows
Requested range · totals (per project, per platform) · production window (earliest `production_start` → last final approval) · load table per person per day (existing, reserved, proposed; red where > cap) · Instagram grid (project cover as placeholder thumbnail) · batches with dates · conflicts (person over cap on day D, leave, holiday, campaign X's reservations) · when infeasible: **earliest feasible range** = the smallest forward shift of the publishing window (whole days, search up to 60 days) that yields `feasible`, plus «نفس التواريخ بعدد أقل» = the largest item count that fits (drop from the last batches first).

### 6.4 Materialisation (after approval)
Content shells (title auto, `project_ids=[that project]`, `campaign_id`, `organic_platforms`, type), `mos_content_plan`, `mos_publications` per item × child with `status='planned'` + `planned_at` + `batch_id` + grid, `mos_publish_batches`, reservations for every stage. The first workflow task opens when `production_start` arrives (§8.2).

---

## 7. Paid creative forecasting and weekly refreshes

### 7.1 Two calendars, deliberately separate
- **Production calendar** (fixed at plan time): for every refresh k, a fixed number of replacement creatives is produced ahead of time with a hard ready date. It does not depend on performance.
- **Performance calendar** (decided near each refresh): which existing creative stays and which are replaced, from windowed metrics. It does not delay production.

You never need to know the winner to start producing its replacements.

### 7.2 Refresh calculation (no hard-coded 23)
Inputs per paid child: `starts_on`, `ends_on`, `slate_size` (5), `keep_min` (1), `cycle_days` (7), `min_remaining_days_for_refresh` (**PROPOSED** 3), `lead_time_wd` (working days a replacement needs from production start to *ad built and verdict passed*; default = post-path effort sum 6 + 1 for ad build/verdict = 7).

```
refresh points R_k = starts_on + k·cycle_days   (k ≥ 1), kept iff (ends_on − R_k + 1) ≥ min_remaining_days
K = kept count
initial              = slate_size
replacements_k       = slate_size − keep_min     (4)  — always produced for every kept refresh
fifth_k              = keep_min                  (1)  — produced or not per §7.4 policy
ready_by_k           = R_k − 1 working day
production_start_k   = ready_by_k − lead_time_wd
decision_due_k       = R_k − 1 working day       (performance decision; uses data up to that day)
```
Example, 30 days from 2026-10-01: R = Oct 8 (23 left), Oct 15 (16), Oct 22 (9), Oct 29 (2 < 3 → skipped) → K = 3. Note `production_start_1` = Sep 30, i.e. **before launch** — the first refresh's replacements are produced alongside the launch creatives, which is exactly why production cannot wait for a winner.

### 7.3 Slots and cycles
- `mos_refresh_cycles (id, execution_id, round, refresh_on, ready_by, production_start_on, decision_due_on, status ∈ scheduled, producing, ready, deciding, decided, applying, applied, partial, skipped, cancelled, decision jsonb)`; round 0 = launch.
- `mos_creative_slots (id, execution_id, cycle_id, slot_index, kind ∈ initial, replacement, spare, status ∈ reserved, producing, ready, active, retired, released, content_id, ad_row_id, activate_on, activated_at, retired_at)`.
- At approval: every slot's full task chain is **reserved** (full weight — see §7.4). Content shells are created when each cycle's `production_start_on` arrives (sweep), so queues show only work that has started. Reservations for later cycles are visible in the workload calendar from day one.

### 7.4 The fifth replacement — an explicit policy, full cost
There is no half-reservation, and a spare is not "rebuilt after use": with a 7-day cycle and a 7-working-day lead time, cycle k+1's production starts *before* cycle k's decision (Oct 6 vs Oct 7 in §22.2), so a spare consumed at refresh k cannot be replaced by refresh k+1. Two policies, chosen per campaign (default in Settings):

| Policy | What is produced (all fully reserved at plan time) | Replace-all-5 at a refresh | Cost over K refreshes |
|---|---|---|---|
| **A — replace-all always available (recommended)** | **Five per refresh** (4 replacements + 1 fifth), each starting at that cycle's `production_start_k`. Exception: at `production_start_k` the plan may produce **four** if the child's **bank** holds an unused spare — where the bank counts only fifths from cycles whose decision was already made before `production_start_k` (so it is a known fact, never a forecast). | Always: the fifth is ready by `ready_by_k` like the other four | max `5 + 5K`; min `5 + 5K − B`, where B = cycles that could draw on a known banked spare (in §22.2 only cycle 3 can) |
| **B — four guaranteed, fifth conditional** | 4 per refresh | Not guaranteed. Choosing "replace all" opens an ad-hoc fifth with its real ready date (`decision day + lead_time_wd`); the preview and the decision task say so: «استبدال الخمسة يحتاج تصميمًا إضافيًا: جاهز بعد N يوم عمل». Until then the best outgoing creative keeps running (§7.5 fallback) | `5 + 4K`, plus ad-hoc work when it happens |

Unused fifths under policy A are approved, ad-built (PAUSED) creatives banked on the child; the bank is shown in the preview and the decision task, and a banked spare may be used for a later cycle or another child of the same project. The workload for the chosen policy is reserved in full; the preview shows the difference between A and B in slot-days and in creatives.

### 7.5 The weekly decision and the swap
1. `decision_due_k`: the cycle sweep ranks the active creatives (§7.6), writes the **default decision** (keep the top-ranked one if it passes the data threshold; else replace all — under policy A the fifth is ready; under policy B "replace all" is offered with its real ready date and the default falls back to keeping the best-ranked), opens ONE manual task `kind='refresh_decision'` for the manager with the ranked table (thumbnails + metrics) and keep/replace toggles.
2. **Human confirms** (one click). If undecided by `R_k` 09:00 Riyadh: `auto_apply_default` setting — recommended OFF for the first month (the refresh waits, the manager is paged), ON later.
3. **Readiness gate before any swap**: a replacement is `ready` only when its content has a final approval on its current package hash (§9.3), its ad is built PAUSED, and the verdict poll passed. "Refresh date arrived" proves nothing.
4. **Apply protocol** (`applying`): activate the ready replacement ads → poll `effective_status=ACTIVE` (up to 5 minutes) → only then pause the outgoing ads → mark outgoing slots `retired`, new slots `active`. Order matters: the ad set is never left with fewer active ads than before.
5. **Fallback when only j of the required replacements are ready** (`partial`): activate the j ready ones; keep the outgoing creatives running in rank order until the count of active creatives equals `slate_size`; the cycle stays `partial` with a task «تأخر ٢ من بدائل التحديث» listing what is missing and its new ready date; when a late replacement becomes ready, the swap protocol runs for it alone. If a replacement's ad fails Meta review after activation was attempted, its outgoing counterpart is not paused (step 4 never reached) and the failure is a task.
6. **Minimum active guard** (**PROPOSED** `min_active = slate_size`, configurable): the apply step refuses any action that would leave fewer active ads than the guard.

### 7.6 Ranking (all thresholds PROPOSED — need your approval)
Per active creative over the window `[R_{k−1}, decision_due_k]` from `mos_ad_metrics_daily`:
- **CPL = spend ÷ leads.** Zero leads → CPL undefined.
- **Data threshold**: spend ≥ 150 SAR **and** impressions ≥ 2,000 in the window; below it a creative is *unranked* (neither winner nor loser; keeps its position in the default decision only if nothing ranked exists).
- Rank: lowest CPL among ranked creatives with leads > 0; creatives with zero leads rank below all with leads, ordered by CTR desc then CPM asc.
- **Fatigue flag**: frequency > 3.0 in the window, or CTR down > 40% vs the previous window; a fatigued creative cannot be the default keep even if it ranks first (the manager may still keep it).
- Ties → higher CTR → more leads → older creative.

### 7.7 Per-creative performance (prerequisite)
`mos_ad_metrics_daily (ad_row_id, day, spend, impressions, clicks, leads, reach, frequency, PK (ad_row_id, day))`, filled by the hourly Meta sync via one `getInsightsRange('ad', yesterday..today)` call for the account (idempotent upsert), plus a 14-day backfill on first run; batched to respect the `development_access` call budget. View `mos_creative_perf_v` (content_id, execution_id, 7d/window/lifetime).

### 7.8 Changes to a running campaign
- **Paused**: undecided cycles shift by the pause length; their reservations are released and re-planned on resume (preview → approve). Active ads are paused by the same protocol in reverse.
- **Extended**: cycles appended from the old end under the same policy; new reservations planned (preview → approve).
- **Shortened / ended early**: cycles with `refresh_on` > new end are cancelled, reservations released; content already in production continues and becomes spare.
- All through `campaign_plan_revise` → commit; reservations are never edited by hand.

---

## 8. Capacity reservations and live-task reconciliation

`mos_task_reservations (id, plan_id, cycle_id, content_id, content_key text, step_key, role_key, assignee_user_id, bucket, planned_start date, planned_end date, weight numeric DEFAULT 1, status ∈ reserved, stale, consumed, released, consumed_task_id, updated_at)`. `content_key` lets a reservation exist before its content shell does (paid replacement slots); `content_id` is filled when the shell is created.

1. **Consumption** (`mos_plan_consume_reservation(task_id)`, called by the re-emitted `workflow_role_path_start` / `workflow_advance_role_path` under the ledger lock, before the legacy placer): reservation → `consumed`; task gets `assignee_user_id`, `scheduled_start/end`, `due_at`. Fallback to today's placer only when no reservation exists.
2. **Start**: the sweep opens the first task for planned content whose `production_start` ≤ today (manager may start early). Content before that is `status_key='planned'`.
3. **Repair** (sweep, every 10 minutes, under the lock): for each content whose open task is past its stage deadline, or whose next reservation is `stale`, re-run the engine in *repair mode* for that content's remaining stages (its priority unchanged, other reservations fixed) and rewrite its reservations. If the batch is now infeasible → `at_risk` + task `plan_conflict` for the manager with the options: move the placement (re-plan that batch), reassign, drop the item from the batch. Publish dates are never moved silently.
4. **Release**: content archived/deleted, campaign cancelled, cycle cancelled, step skipped → `released` (trigger + RPC). Never by expiry.
5. **Counting**: §4.3 — one definition, one view.
6. **Workload calendar** (Team page): per person per day, layers committed (tasks) / reserved / proposed (a preview being reviewed), with the campaign each row belongs to.

---

## 9. Content workflow and approval state machine

### 9.1 Steps (unchanged keys, sharper meaning)
| # | step key | role | approves | required to submit/approve (server-enforced) |
|---|---|---|---|---|
| 1 | `writing` | writer | — | body/brief (headlines + design_brief, or script) **and** `data.caption` non-empty **and** `data.caption_confirmed_by_writer_at` set **for the current caption hash** (`data.caption_confirmed_hash = sha(caption)`; any caption change invalidates it) |
| 2 | `writing_review` | marketing_manager | writing + caption | approval row binds `writing_hash` (headlines, brief, caption, hashtags) |
| 3 | `design` | montage | — | required slots per content type present (`final_square` + `final_vertical` for post/carousel; one for story), same media kind |
| 4 | `design_writer_review` | writer | design | approval row binds `design_hash` |
| 5 | `design_review` (label «الاعتماد النهائي») | marketing_manager | the whole package | **preflight gate** (§11); approval row binds `package_hash` = writing + design + caption |
| 6 | `scheduling` | writer | — | organic only; auto-skipped for paid-only |
| 7 | `publish_check` | ops_supervisor | process | organic only |

Video path keeps its 11 steps with the same enforcement (`script` requires scenes + caption; `review` is final).

### 9.2 Results and transitions
- `submitted` / `approved` → next step (or finish). `changes_requested` (note required) → **targeted return**: the modal lists the legitimate prior `creates_revision` steps (from final review: `writing` or `design`); RPC gains `p_return_to`. Round +1.
- New terminal `rejected` (item stops; a manager can reopen) and `on_hold` / resume (reservations released while on hold).
- Three returns on one item → server notification to the manager + flag (the UI copy already promises it).

### 9.3 Package versions, locks, revisions
`mos_content_approvals (content_id, step_key, round, approved_by, approved_at, writing_hash, design_hash, caption_hash, package_hash)` — written on every `approved`. A field set is *locked* once its approving step has an approval row for the current package.

- A locked edit is refused by `content_update` / `attachToSlot` / caption save unless a **revision** is open: `content_revise(content_id, scope, note)` → new round, new package version, and the chain **re-runs every approval gate from the affected step through final approval** on the new hashes. **The scope is determined by what changed, not chosen freely**: every writing field in the content type's `field_schema` carries `affects_design: true|false` (headlines, design_brief, on-screen text, price lines, slides → true; caption, hashtags, notes → false); the server derives the scope from the changed keys and the writer can only widen it, never narrow it:
  - **Caption only** (`caption`/`hashtags` changed, nothing image-affecting): `caption_confirmed_by_writer_at` is **cleared** (it is stored with the caption hash it confirmed; a mismatch invalidates it) → writer reconfirms the revised caption → `writing_review` (manager approves the writing package) → **final review** on the new package hash. Design steps are skipped because the design hash is unchanged.
  - **Image-affecting text or instructions** (any `affects_design` field changed, e.g. the price shown on the creative): `writing_review` → **`design`** (the existing file still shows the old text; montage updates it, new slot version) → `design_writer_review` → **final review**.
  - **Design file only**: `design_writer_review` → **final review**.
  - Any combination takes the widest path.
  The final approval row is what binds the package that will run; no publication, ad, or swap is built from a package hash without a `design_review` approval row for that exact hash, and no writing package is approved while its caption confirmation is missing or refers to an older caption hash.
- **After a revision is finally approved and an ad/publication already exists**: a scheduled (unpublished) publication is updated in place; a published post is not touched (a note offers a new post). A **running ad is never edited in place**: a new creative + ad is built PAUSED from the approved hash, activated, verified ACTIVE, and only then the old ad is paused and marked `replaced_by_ad_row_id` (§7.5 protocol). If the new one fails, the old keeps running and a task reports it.
- Design uploads are versions: `mos_asset_links` gains `version`, `superseded_at`; the previous slot file stays as version n−1 rather than being demoted to `source`. Approval rows reference the design hash, so "the approved version" is unambiguous.
- Unlocked fields (notes, internal tags, references) stay editable and are audited.

### 9.4 Statuses (derived, `mos_content_v.status_key`)
`planned` · `<step_key>` · `on_hold` · `rejected` · `done` (final approved, no open task) · `live` (an active ad or a published post). `at_risk` is a flag.

### 9.5 Scenario table
| Scenario | Behaviour |
|---|---|
| Manager rejects writing | → `writing`, round+1, note, notification (exists) |
| Writer rejects design | → `design` (exists) |
| Manager rejects final | modal: copy → `writing`; visual → `design`; both → `writing` |
| Caption changes after design approval | locked → revision, scope derived = caption → writer reconfirms → writing_review → final review on the new package; then ad/publication update per §9.3 |
| Headline / price / brief changes after design approval | locked → revision, scope derived = image-affecting → writing_review → design (new slot version) → writer design review → final review |
| New design version after approval | locked → revision, scope = design → writer review → final review; old ad replaced only after the new one is verified active |
| Approved record edited (locked field) | refused with the revise option; unlocked fields free, audited |
| Meta ad creation fails | job `failed`, `ad_failed` notification, task with the reason; transient Graph errors (5xx, rate limit, timeout) retried ×3 with backoff by the worker; permanent errors (missing slot, verdict, policy) → human; slot stays `ready`-pending, never `active` |
| Preflight fails at final approval | approve refused with blockers; «اعتماد بدون إعلان» is a second, explicit button |

---

## 10. Caption generation and approval

- **Canonical caption on the content**: `data.caption`, `data.hashtags`, `data.caption_ai_draft`, `data.caption_source ∈ ai, human, ai_edited`, `data.caption_confirmed_by_writer_at`. Per-platform captions on `mos_publications.caption` and `creative.primary_text` become **overrides** initialised from the canonical caption when the placement is created; a later canonical change (through a revision) asks «تحديث N مكان نشر؟».
- **Writing page**: caption beneath the writing content (remove `caption` from `WritingFields`' swallow set), «توليد بالذكاء» → `content_caption_generate` (DeepSeek per the text-LLM routing; same project-facts loader and number guard as the worker), and a required «راجعت الكابشن» confirmation. Submit refuses without body + caption + confirmation.
- Manager approves writing and caption together at `writing_review`.
- Meta phase 1 (AI caption + `caption_review` task) runs **only** for legacy items without an approved caption.
- Platform caption limits validated per placement by `platformRules.ts`.

---

## 11. Meta ad creation after final approval

`content_ad_readiness(content_id, execution_id)` (SQL, SECURITY DEFINER, exposed to the UI) returns blockers: `final_square`, `final_vertical`, `slots_same_kind`, `caption_approved`, `project_linked`, `campaign_linked`, `meta_execution_linked`, `ad_set_linked`, `ad_set_pair_complete`, `saved_audience`, `welcome_template_available`, `budget_set`, `destination_valid`, `creative_slot_available`. The final approve button shows them live and is disabled while any is present; the RPC refuses `approved` with blockers unless `p_skip_ad=true`.

After approval: enqueue `meta-ad` with `phase='create'` directly. Ads are created **PAUSED** and activated by slot/cycle logic (launch on `starts_on`; replacements per §7.5). `mos_settings.meta_auto_ad.status` gets a Settings toggle. `mos_creative_slots.ad_row_id` is set on success; slot `ready`. A null project is a hard blocker (never reuse another project's welcome template). Port the worker-only Graph helpers to the API copy of `metaMarketingApi.ts` (they have diverged).

---

## 12. Universal content thumbnails and preview modal

- Server: `attachContentPreviews(rows)` (lifted from `content_list`) applied to `work_list`, `content_detail`, `campaign_rollup`, `calendar`, `publishing`, `search`, `team`, plan previews (project cover fallback).
- Client: `kit.tsx` `<Thumb>` (wraps `useAssetUrls`) + `<ContentThumb row>`; used on every content table/card/chip (content table + board, campaign overview + content tab, child page, my-work, task cards, calendar chips, publishing board, search, asset "used by", pickers, plan grid).
- `<ContentPreview contentId section? readOnly? onNavigate>` via `usePreview()`: header adds project, campaign → child (platform), type, planned/target publish, stage + owner person, plan status; sections: creative (approved version by hash, others collapsible), writing/brief, caption (canonical + overrides), publishing plan, ads, approvals timeline. **No design yet**: writing + caption + references + current-stage materials + project cover with «لا تصميم بعد».

---

## 13. Universal task preview and deep navigation

**Central resolver + durable links from stable keys; no stored routes.**

- `lib/contentRoute.ts`: `contentHref({id, status_key, current_step_key, steps})`, `taskHref(task)` → `/m/content/:id?tab=<tab>&step=<step_key>`; `sectionForStep()` maps to sections (`writing`, `writing_review`, `design_upload`, `design_review_writer`, `final_review`, `caption`, `schedule`, `publish_check`, `materials_final`, `refresh_decision`); the detail page reads `?step=`, scrolls/focuses and opens the action sheet. Fix the step-key bug. Finished items → `materials_final` everywhere.
- Server twin `contentUrl()` for every notification producer (kills `?tab=publish`).
- Every task resolves `{entity_kind, entity_id, step_key, action, href, section}`; manual tasks get `entity_kind/entity_id/action` columns and `kind` extended (`manual, caption_review, refresh_decision, plan_conflict, ad_failed`).
- Click = navigate (shareable URL); «معاينة» = modal; completed task → final materials. Campaign page gains a Tasks tab and `?tab=`.

---

## 14. Required schema changes (all backward-compatible)

1. `mos_campaign_executions`: `CHECK platform`, uniqueness, `refresh_policy jsonb`, `publishing_rules jsonb`.
2. `mos_campaigns`: `requirements jsonb`, `plan_id`; FK `mos_content.campaign_id` (SET NULL).
3. `mos_publications`: `execution_id`, `batch_id`, `planned_at`, `grid_row`, `grid_col`, `scheduled_timezone DEFAULT 'Asia/Riyadh'`, status `+ 'planned'`.
4. `workflow_role_tasks`: `scheduled_start date`, `scheduled_end date`, `effort_days numeric`, `progress_days numeric DEFAULT 0` (assignee-recorded; never inferred), `reservation_id`. `mos_content_types.field_schema` entries gain `affects_design boolean`.
5. New: `mos_campaign_plans`, `mos_publish_batches`, `mos_content_plan`, `mos_task_reservations`, `mos_refresh_cycles`, `mos_creative_slots`, `mos_ad_metrics_daily`, `mos_content_approvals`, `mos_content_events`, `mos_user_capacity`, `mos_holidays`, `mos_step_effort`, `mos_settings.work_calendar`; views `mos_work_ledger_v`, `mos_publish_batch_v`, `mos_creative_perf_v`; function `mos_workload_snapshot_hash()`.
6. `mos_asset_links`: `version`, `superseded_at`, `uploaded_by`; unique `(content_id, role) WHERE superseded_at IS NULL`.
7. `mos_manual_tasks`: `kind` CHECK extended, `entity_kind`, `entity_id`, `action`.
8. `mos_execution_ads`: `slot_id`, `activated_at`, `retired_at`, `replaced_by_ad_row_id`.
9. `mos_content_v`: `status_key` gains `planned/on_hold/rejected/live`; plan columns; restore `security_invoker=true` (lost 2026-08-06; test each role).
10. RPCs (all taking the ledger lock where they write ledger rows): `mos_campaign_plan_commit`, `mos_plan_consume_reservation`, `mos_plan_repair`, `content_ad_readiness`, `mos_campaign_rollup`, `content_revise`, `mos_refresh_cycle_decide`, `mos_refresh_cycle_apply`, `mos_manual_task_write`, `capacity_config_save`; `workflow_advance_role_path` (+`p_return_to`, requirement enforcement, reservation consumption, lock) and `workflow_role_path_start` re-emitted verbatim from the live bodies with only these additions.
11. Triggers: release reservations on content archive/delete and campaign/cycle cancel; refuse locked-field updates without an open revision (BEFORE UPDATE on `mos_content`, `mos_asset_links`, `mos_publications.caption`, `mos_execution_ads.creative`).
12. CI smokes: commit idempotence, two concurrent commits → exactly one succeeds, reservation consumption is a swap (ledger sum unchanged), stale→repair, lock trigger, no SQLSTATE 40001/40P01.

---

## 15. Required UI changes

Campaign wizard (Requirements → Plan preview with load table, grid, batches, conflicts, alternatives → approve) · Campaign page (totals across children; Schedule, Tasks, Plan tabs) · Child page (content, ads, tasks, schedule, per-creative performance, refresh cycles) · Writing page (caption + AI + confirm; enforced submit) · Final approval (preflight checklist; «اعتماد بدون إعلان») · Materials (slot versions, revise flow) · Team workload calendar + Settings → Capacity (per-person caps, holidays, weekend, step effort; replaces the decorative SLA grid) · Refresh decision task · `<ContentThumb>`, `usePreview()`, `contentHref()` everywhere.

---

## 16. Backend / services changes

Actions: `campaign_plan_preview/revise/commit`, `campaign_rollup`, `content_caption_generate`, `content_revise`, `content_ad_readiness`, `refresh_cycle_decide`, `capacity_config_save`; `task_complete` gains `return_to` + blocker handling; `content_update` respects locks. Engine in `src/lib/marketingOS/scheduling/` re-exported for `api/`. Sweeps on the existing 10-minute `perf-sweep`: start planned content, repair stale reservations, create cycle content shells at `production_start_on`, move cycles to `deciding`, apply decisions (protocol §7.5), activate/retire ads. Meta sync: daily per-ad insights upsert. Worker `runMetaAdJob.ts`: skip phase 1 when caption approved; create PAUSED; transient-error retry; `meta_ad_replace` job kind; set `slot_id`. Notification events (full roles × channels grid): `plan_conflict`, `batch_at_risk`, `refresh_decision_due`, `refresh_applied`, `refresh_partial`, `revision_requested`.

---

## 17. Permissions, audit history, versioning

Capabilities (data + both TS lists): `plan_campaign`, `approve_plan`, `decide_refresh`, `revise_approved_content`, `manage_capacity`. Final approve additionally requires `approve_creative` (exists, gates nothing today). Audit: `mos_content_events (content_id, kind, actor, at, detail)` from the RPCs and lock triggers (`field_changed` with key list + hashes, `design_version_added`, `caption_generated`, `approved` with hashes, `returned`, `revised`, `locked_edit_refused`, `ad_created/failed/replaced/retired`, `reservation_consumed/repaired`, `plan_committed/revised`, `refresh_decided/applied/partial`). Approvals reference package hashes; the preview shows the approved version by hash.

---

## 18. Migration of existing records and compatibility

24 content rows, 5 campaigns, 34 ad rows, 10 draft publications. Existing content keeps its pinned workflow version (no retroactive enforcement); new content pins the new version. Backfill `data.caption` from an approved ad caption or first publication caption where one exists. Legacy `final` links (15) → `final_square` v1 where square, else flagged by preflight. Organic executions backfilled if any organic campaign exists (none today). `mos_step_effort` seeded from `due_days`. `p_finish` stays for paid-only. Feature flags `mos_settings.planning = {preview_enabled, reservations_enforced, refresh_loop_enabled, auto_apply_default_decision, spare_policy}` — each layer ships dark. The `mkt_*` v2 schema is untouched (separate cleanup, after its own verification).

---

## 19. Testing strategy and failure recovery

- **Engine (vitest)**: determinism; constraint satisfaction (IG rules); batch-1 readiness invariant (for random feasible instances, every batch-1 stage lands ≤ its deadline); **completeness** (for random instances, whenever a brute-force search finds a feasible schedule the engine must also return `feasible=true` — the planner may never declare a feasible plan impossible); ledger invariant (Σ ledger rows before and after consumption equal; a stale reservation keeps its weight); remaining-effort rule (an untouched 2-day task still costs 2); backward deadline math on the Riyadh calendar with holidays; refresh-count table for 7/10/14/21/28/30/31/45-day campaigns × `min_remaining` ∈ {1,2,3,5}; policy A/B cost tables incl. the bank rule; pause/extend/shorten. **§22.1 and §22.2 are checked in as fixtures**: the exact ledger, caps and dates, with the expected assignments (A2 → M1 Oct 7–8; B2, C2 → M2 Oct 5–6; the refresh table) as assertions — the examples are acceptance tests, not prose.
- **SQL (CI, postgres:17)**: commit idempotence; two concurrent commits (pgbench-style) → one `approved`, one WS409; hash changes on every ledger writer; consumption swap; stale→repair; lock trigger; WS409 only.
- **Live**: the `🧪 Sandbox (Claude)` campaign; Meta with `meta_auto_ad.status=PAUSED`; bundle DRAFT posts then deleted.
- **Post-launch accuracy** (from the review): `mos_plan_accuracy_v` — planned vs actual per stage per content (delay in working days, by role and by cause: return, leave, capacity), surfaced on the Performance desk; review after the first campaign and re-seed `mos_step_effort` from measured medians.
- **Recovery**: commit is atomic; sweeps idempotent; reservations never vanish with work outstanding; a failed apply leaves outgoing ads running; `mos_content_events` is the forensic trail; kill switches = the planning flags + `external_effects`.

---

## 20. Recommendations, simplifications, risks

**Challenged / simplified**: no eighth step (harden `design_review`); retire the Meta caption phase for new content; children = executions with a plugin per platform; slots + reservations instead of pre-created content; units (slot-days) not hours; reservations as a separate ledger; resolver instead of stored routes.

**Risks**: the manager's approval steps are the real bottleneck for a 4-person team — the planner must count approvals (§4.3) or every preview looks feasible; unify the two "working day" notions before scheduling; fix the `datetime-local` timezone round-trip before writing generated dates; Meta `development_access` call budget (batch insights, back off, apply for Standard); bundle status lag (≤10 min) — batch status must tolerate it; approval locks will annoy on day one — keep unlocked fields free and the revise flow one click; `mos_content_v` invoker restoration may change what roles see — test each role; a 2-day design that starts on a Thursday spans Friday — the calendar math must skip, not stretch (covered by the working-day window definition).

---

## 21. Decisions needed from you

1. Refresh defaults: `cycle_days=7`, `min_remaining_days_for_refresh=3`, `keep_min=1`, `slate_size=5`; global with per-campaign override?
2. **Fifth-replacement policy**: A (five produced per refresh unless a banked spare is known at production start — replace-all always available; recommended) or B (four guaranteed, fifth conditional with its real ready date)?
3. Undecided refresh at the deadline: hold and page (recommended first month) or auto-apply the default?
4. Ads created PAUSED and activated on schedule (recommended) vs ACTIVE immediately.
5. `min_active` guard for an ad set during swaps (proposed = slate size).
6. Ranking thresholds (§7.6): data threshold 150 SAR / 2,000 impressions; fatigue frequency > 3.0 or CTR −40%; skip a final refresh when < 3 days remain — all PROPOSED.
7. Publishing buffer 1 working day; publishing 7 days/week, production 6 (current posture)?
8. Do reels count in an Instagram grid row of 3 (recommended yes; stories no)?
9. Cross-post default: one creative for all platforms, or per-platform creatives?
10. Manual task weight 0.5 slot; manager approvals cap 20/day?
11. A creative in two children counts toward both children's totals (recommended yes; distinct at the parent)?
12. Legacy in-flight items (4 open) finish on the old workflow (recommended) or migrate?

---

## 22. Worked scheduling examples (generated from the engine)

Calendar: Saudi week, **Friday off**, no holidays. Team: writer W (post cap 10/day), montage M1 and M2 (post cap 4/day each), manager MM (approvals cap 20/day). Step effort (working days): writing 1, writing_review 1, design 2, design_writer_review 1, design_review 1. Publish buffer 1 working day. Dates are 2026 (Oct 1 is a Thursday; Oct 11 is a Sunday).

### 22.1 Organic: three projects, publishing batches drive production

Generated by `node scripts/gen-scheduling-examples.mjs` from the engine itself.

**Base ledger** — feasible: `true`, proof: `null`, search complete: `true` (30 expansions, 0 backtracks)

| Item | Project | Publishes | Grid | Writing | Writing review | Design | Writer review | Final approval |
|---|---|---|---|---|---|---|---|---|
| a:post:1 | A | 2026-10-11 #0 | r0c0 | W 2026-10-04 | MM 2026-10-05 | M2 2026-10-06→2026-10-07 | W 2026-10-08 | MM 2026-10-10 |
| b:post:1 | B | 2026-10-11 #1 | r0c1 | W 2026-10-04 | MM 2026-10-05 | M1 2026-10-06→2026-10-07 | W 2026-10-08 | MM 2026-10-10 |
| c:post:1 | C | 2026-10-11 #2 | r0c2 | W 2026-10-04 | MM 2026-10-05 | M2 2026-10-06→2026-10-07 | W 2026-10-08 | MM 2026-10-10 |
| a:post:2 | A | 2026-10-12 #0 | r1c0 | W 2026-10-05 | MM 2026-10-06 | M1 2026-10-07→2026-10-08 | W 2026-10-10 | MM 2026-10-11 |
| b:post:2 | B | 2026-10-12 #1 | r1c1 | W 2026-10-05 | MM 2026-10-06 | M2 2026-10-07→2026-10-08 | W 2026-10-10 | MM 2026-10-11 |
| c:post:2 | C | 2026-10-12 #2 | r1c2 | W 2026-10-05 | MM 2026-10-06 | M1 2026-10-07→2026-10-08 | W 2026-10-10 | MM 2026-10-11 |

**Tight variant (M2 also busy Oct 7)** — feasible: `true`, proof: `null`, search complete: `true` (30 expansions, 0 backtracks)

| Item | Project | Publishes | Grid | Writing | Writing review | Design | Writer review | Final approval |
|---|---|---|---|---|---|---|---|---|
| a:post:1 | A | 2026-10-11 #0 | r0c0 | W 2026-10-04 | MM 2026-10-05 | M1 2026-10-06→2026-10-07 | W 2026-10-08 | MM 2026-10-10 |
| b:post:1 | B | 2026-10-11 #1 | r0c1 | W 2026-10-04 | MM 2026-10-05 | M2 2026-10-06→2026-10-07 | W 2026-10-08 | MM 2026-10-10 |
| c:post:1 | C | 2026-10-11 #2 | r0c2 | W 2026-10-04 | MM 2026-10-05 | M1 2026-10-06→2026-10-07 | W 2026-10-08 | MM 2026-10-10 |
| a:post:2 | A | 2026-10-12 #0 | r1c0 | W 2026-10-05 | MM 2026-10-06 | M1 2026-10-07→2026-10-08 | W 2026-10-10 | MM 2026-10-11 |
| b:post:2 | B | 2026-10-12 #1 | r1c1 | W 2026-10-05 | MM 2026-10-06 | M2 2026-10-05→2026-10-06 | W 2026-10-10 | MM 2026-10-11 |
| c:post:2 | C | 2026-10-12 #2 | r1c2 | W 2026-10-05 | MM 2026-10-06 | M2 2026-10-05→2026-10-06 | W 2026-10-10 | MM 2026-10-11 |

### 22.2 Paid: 30-day Meta campaign, weekly refresh, policy A

| Cycle | refresh_on | days left | ready_by | production start | decision due | produced |
|---|---|---|---|---|---|---|
| launch | 2026-10-01 (Thu) | 30 | 2026-09-30 | 2026-09-23 | — | 5 |
| 1 | 2026-10-08 | 23 | 2026-10-07 | 2026-09-30 | 2026-10-07 | 5 |
| 2 | 2026-10-15 | 16 | 2026-10-14 | 2026-10-07 | 2026-10-14 | 5 |
| 3 | 2026-10-22 | 9 | 2026-10-21 | 2026-10-14 | 2026-10-21 | 5 |
| 4 | 2026-10-29 | 2 | — | — | — | 0 |

Policy A total: **20** creatives (5 launch + 12 replacements + 3 fifths) across 3 kept refreshes. Policy B total: **17**.

## 23. Failure cases

| # | Failure | What the system does | What a human sees |
|---|---|---|---|
| 1 | Designer M1 on sick leave Oct 6–7 (approved Oct 5), batch 1 has B1, C1 on M1 | Leave approval takes the ledger lock, adds leave rows; the repair sweep re-plans B1, C1 (priority unchanged): M2 has Oct 6–7 free 1+1 → C1 → M2; B1 has no window ≤ Oct 7 → `plan_conflict` task with options: move B1 to batch 2 (re-plan batch 2 grid: A2 B1 C2 — rule check passes), reassign to M1 Oct 8–10 with publish moved to Oct 12, or drop | Task in «مهامي» for MM with the three options and the grid preview; batch 1 shows «معرّض للخطر» until decided; nothing moves silently |
| 2 | MM returns B1 writing on Oct 5 («غيّر الزاوية») | Round 2; `writing` reopens for W with due = its stage deadline (Oct 5, so it is immediately late-flagged only if not done today); the repair pass inserts a reservation for `writing_review` Oct 6 (MM has room) and checks design still fits Oct 6–7 → yes; batch stays on track | W sees the return with the note; MM sees the review again Oct 6; no batch flag |
| 3 | Replacement #4 for R1 fails Meta verdict on Oct 7 («Invalid Creative For Objective») | Job `failed`, ad deleted (existing undo), slot stays `producing`, task `ad_failed` for MM with the reason; cycle 1 moves to `partial` on Oct 8: the 3 ready replacements activate, the best-ranked outgoing creative stays running as the 5th (min_active guard), the cycle task lists «بديل ٤ متأخر — إعادة الإنشاء بعد إصلاح الملفات» | MM fixes/re-uploads → revise('design') → writer + final review → ad rebuilt PAUSED → verified → swap for that one slot alone |
| 4 | Two managers approve two campaign plans within the same second | Both previews planned against hash H. Commit 1 takes the lock, hash = H, validates, inserts, commits (hash now H′). Commit 2 takes the lock, hash H′ ≠ H → `WS409 plan_changed`; the API re-plans against the live ledger and returns the new proposal with a diff | Second manager sees «تغيّر الحمل: تحرّكت ٢ مهمة تصميم إلى ٩ أكتوبر» and approves again or edits |
| 5 | Campaign paused Oct 9–12 (4 days) mid-cycle 2 | Cycle 2's `refresh_on` → Oct 19, `ready_by` Oct 18, decision Oct 18; its reservations released and re-planned (preview → approve); cycle 3 shifts likewise; cycle 4 (was skipped) is re-evaluated: Nov 2 vs end Nov 3 (end shifts by pause? — **decision needed**: does a pause extend `ends_on`? default yes) | Preview of the shifted cycles before anything changes; active ads paused via the protocol |
| 6 | Caption edited after the ad is live | `content_update` refuses the locked field; «طلب تعديل» → revise('caption') → writing_review → final review on the new package hash → `meta_ad_replace`: new creative + ad PAUSED → ACTIVE verified → old ad paused, `replaced_by_ad_row_id` set. If Meta rejects the new ad, the old keeps running and a task reports it | Writer edits, MM approves twice (writing, final), the swap is automatic and visible in the ad's events |
| 7 | A stage runs 2 days late upstream, the reservation for the next step is now in the past | Reservation → `stale`; repair re-dates it from today with its remaining effort under the lock; if `required_ready_at` no longer fits → batch `at_risk` + `plan_conflict` task | Calendar shows the moved reservation and the risk flag |
| 8 | Worker dies mid-swap after activating 2 of 4 replacements | Cycle stays `applying` with progress in `decision.applied[]`; the watchdog re-runs `mos_refresh_cycle_apply` (idempotent: activates only slots not yet ACTIVE, pauses outgoing only after all required are ACTIVE) | Nothing to do unless it fails twice → task |
| 9 | Capacity config lowered (montage 4 → 3/day) while plans exist | The change takes the lock and bumps the hash; the repair pass flags every day now over cap and opens one `plan_conflict` task per affected batch | MM sees which batches are over and the offered moves |
| 10 | Hash matches but the SQL validation finds a cell over cap (TS bug or effort table changed between preview and commit) | `WS409 capacity_conflict` with the cells; nothing inserted | «الخطة لم تعد تناسب السعة في ٧ أكتوبر (م١: ٥/٤)» → re-preview |
