# The Monthly Operating Model — the build plan

**Status:** Plan. Not started. **Date:** 2026-09-15.
**Companion to:** [`monthly-operating-model.md`](./monthly-operating-model.md) — the settled proposal.
Three further decisions live in the screens review (`_EDITS.md`, E1–E3), folded in below.

**The constraint that shapes everything here:** the proposal's five-phase transition is overridden.
This is built and shipped in **one phase** — one build, one cutover.

Everything below was grounded in the live code and the production database on 2026-09-15. Where the
proposal document and the code disagree, the code is quoted and the document is corrected.

---

## 0. In plain words, before the detail

We are replacing the way marketing work is created and run. Today a person types a campaign into a
wizard, types ad rows by hand, and nothing owns the step where an approved post gets a date. After
this build, you pick three projects once a month, press confirm, and the system creates the whole
month's work, hands it out, publishes it, and only interrupts you when something breaks a rule.

Doing it in one phase means there is no rehearsal. The first month that runs this way is a real month
with real money in it. That is a legitimate choice — the staged version would have taken three times
as long — but it moves all the risk to one day, so most of this plan is about making that one day
survivable.

**The single most useful thing we found:** the system already has a safe way to change how work
flows without touching work that is already in flight. Every piece of content remembers which version
of the process it was created under. New rules ship as a *new version*; anything already moving keeps
walking its old path until it finishes. That is why a single cutover is possible at all, and it is
data, not code — nothing needs building to get it.

**The most alarming thing we found is unrelated to this plan and is costing money now.** The writer
confirms a caption, the manager approves it, and then the ad builder looks for that confirmation
under a key that nothing in the entire codebase ever writes. It concludes the writer never confirmed,
generates its own caption with AI, and sends *that* to Meta. You approve one text; Meta spends the
budget on another; nothing errors. This is fixed first, on its own, before anything else in this plan.

---

## 1. What one phase costs

The document's phases were: 0 stop the bleeding · 1 the month screen · 2 exceptions and batch
approvals · 3 the rail · 4 retire. Collapsing them gives up four things.

| Given up | Consequence |
|---|---|
| **The rehearsal month** (phase 1 ended "run one real month this way") | The first compiled month is live. A compiler bug is discovered against real batch dates, not a dry run. |
| **Rollback as a rail edit** | Phases 0–3 deleted nothing, so rollback was "put the rail item back". Deleting the wizard, goals and measures in the same phase means rollback is a revert-and-redeploy, and any month already committed keeps its rows. |
| **Learning what the exceptions actually are** | Phase 2 built the exception list *after* watching a month produce them. We are now guessing the list from section 3.3 and shipping it closed. If a real exception source is missing, it surfaces as silence — work stuck with nobody told. |
| **Staged capability/rail changes** | Six people-facing surfaces change on one deploy. There is no week where the old and new approval paths coexist for comparison. |

What one phase **keeps**, and it is the important one: **the pinned workflow version**.
`workflow_advance_role_path` reads the step definition off the version pinned to each content record.
Live: 22 records on `ea460e57…`, 2 on `bf04288d…`, both with `required_fields: []` and
`required_files: []` on every step; `post_std` v7 — which already carries `required_fields:['caption']` —
has **zero** records pinned to it. Shipping a new version leaves every in-flight item on its old
chain. This is exactly how the release split shipped on 2026-09-14, and it is the only reason a single
cutover is safe.

**Therefore the governing rule of this build:** every behavioural gate — the caption requirement, the
two design slots, the row task — ships as a **new `workflow_versions` row**, never as an edit to a
live one. Code changes are backward-compatible; the new behaviour is switched on by what a record is
pinned to.

---

## 2. Decisions needed before a line is written

The proposal says nothing is open. The survey found eight things that genuinely are. Six have a clear
recommendation; two are yours alone.

| # | Decision | Recommendation |
|---|---|---|
| **D1** | **Do the new material gates (two design slots, a confirmed caption) apply to the 24 pre-cutover content records?** 9 of the 17 ad-bearing rows have no slots at all (8 carry only a legacy `final` link: P-132/133/134/136/141/142/143/144; P-148 has square only). The missing verticals **do not exist as files** — only سارة can produce them. And **0 of 24 rows carry a caption**. | **No — gates apply only to content pinned after the cutover.** The pinned-version mechanism makes this free. Backfill `final` → `final_square` only where the file measures square, and leave the nine verticals as ordinary production work if those ads are ever rebuilt. "Apply to everything" means nine re-uploads and 24 captions written before the first month can publish. |
| **D2** | **What happens to the four live executions carrying 5,559.74 SAR?** `mos_creative_slots` has 0 rows; `slot_id`, `activated_at`, `retired_at` are NULL on all 42 ad rows. Two of them (2,652 SAR and 1,424 SAR) have **zero** ads linked to any content, so the material rule cannot reach them at all. | **Leave them running outside the new lane until they end naturally, and exclude them explicitly** (a `legacy_unmanaged` flag on the execution), rather than silently skipping. Adopting them into slots means inventing an activation date for ads whose real one is unknown. |
| **D3** | **Does an empty caption hard-block publishing?** Adding it to `preflightPublishSet` blocks all 10 existing draft publications at once and surfaces in three places. | **Resolve the caption from the approved writing and block only when *that* is missing.** This is the §3.4 reading, but it requires the resolver to ship in the same change — sequenced below. |
| **D4** | **Which key is the writer's caption confirmation?** The UI writes `caption_confirmed_at`; SQL compares `caption_confirmed_text`; the ad builder gates on `caption_confirmed_by_writer_at`, which **nothing writes**. | **`caption_confirmed_text` is the comparison and `caption_confirmed_at` is the timestamp. Fix the worker to read those two.** `caption_confirmed_by_writer_at` is deleted from the codebase. See §3, item S1 — this is the live money bug. |
| **D5** | **Define "qualified" for cost per qualified lead.** This choice *is* the monthly project-selection measure. With 14 qualified out of 231 attributed clients, moving one stage changes which project gets picked. `client_stage` also carries «خاسر» on 5 clients — a value not in the model's option list — so it must be an explicit allowlist, never an ordinal range. | Allowlist: **الاتصال لحجز موعد · موعد زيارة · زيارة · متابعة بعد الزيارة · عرض سعر · حجز · تمويل · الإفراغ**. Excluded: جديد · غير مؤهل · يريد إيجار · خاسر. **Yours to confirm — it decides which projects you run.** |
| **D6** | **Define "days since last featured."** There is no source: nothing has ever published and only 24 content records exist. | `greatest(last day with spend in mos_ad_metrics_daily, last mos_content.created_at)` per project, labelled as such on the screen. Revisit after one real month. |
| **D7** | **E1: does a project-column note reach that project's paid creatives, or only its organic rows?** | **Both**, with the paid-batch note able to override. The per-batch pencil E1 adds is the escape hatch that makes the wider scope safe. |
| **D8** | **The month confirms four plans at once (one organic + three paid) but `mos_campaign_plan_commit` takes a single `plan_id` inside one advisory-lock transaction.** | **One compiler call committing all four inside one transaction.** Four sequential commits can leave a month half-reserved with no clean undo, and the advisory lock already serialises the ledger. |

---

## 3. The cutover

### S — Three safety items that land and are verified BEFORE anything else

These are separable, independently deployable, and each fixes something wrong today. They are not
part of the month model; they are the ground it stands on.

| | What | Where | Why first |
|---|---|---|---|
| **S1** | **The caption key mismatch.** The worker gates on `caption_confirmed_by_writer_at` — written by nothing in `src/`, `api/` or `supabase/` (only the fixture at `scripts/e2e-content-workflow.ts:159`). It therefore always concludes the writer did not confirm and writes its own DeepSeek caption to Meta. | `worker/src/runMetaAdJob.ts:750` → read `caption_confirmed_text` + `caption_confirmed_at`; delete the third key repo-wide | **A live correctness bug with money attached.** You approve text A, Meta runs text B, nothing errors. Fix and verify before any caption gate is built on top of it. |
| **S2** | **`activated_at` backfill.** NULL on all 30 ad rows, including every `status='running'` one. The only fallback, `min(mos_ad_metrics_daily.day)`, is the **sync** start: mena52-V3 was created 2026-08-16 and produced its first lead 2026-08-15, but its metrics begin 2026-08-25 — a **10-day error**. | NEW migration: backfill `activated_at` from Meta's own `created_time` / effective-status history where available; NULL where it is not, and exclude those rows from the rule | §3.6's "first seven days from activation" has no anchor without it. Shipping the seven-day rule against a 10-day-wrong window pauses or keeps real spend **on the wrong evidence.** Must land and be verified as its own deploy. |
| **S3** | **`account_id` NULL at commit.** `mos_campaign_plan_commit` inserts publications with `account_id` NULL (`2026-09-14_02:488-498`); `publishRelease.ts:64` refuses unless `pub.account_connected === true`; but `mos_release_due`'s `automatable` is a **platform**-level check. | `mos_campaign_plan_commit` — resolve and write the default publishing account per platform at insert | Without it **every release of the first compiled month becomes a `publish_failed` task the moment the sweep ticks.** This is why §12 says the Instagram path is "built; never exercised". |

**Verification gate:** S1 proves out by building one ad and confirming the caption Meta receives is
byte-identical to the approved `data.caption`. S2 proves out by a query showing every `running` ad
either has a real `activated_at` or is flagged excluded. S3 proves out by one real feed post and one
real story published through bundle.social from a committed plan. **Nothing in §4 starts until all
three pass.**

### What the cutover does to live data

| Live thing | Count / state | What happens |
|---|---|---|
| Content records | 24; 23 `done`, **1 mid-`design`** | Keep their pinned version (`ea460e57…` ×22, `bf04288d…` ×2). The one in-flight item walks its old chain to completion. No migration touches them. |
| Draft publications | 10, all `status='draft'`, `scheduled_at` **and** `planned_at` NULL | `mos_release_due` filters on `due_at IS NOT NULL`, so the sweep is **structurally blind** to them. A single cutover cannot make a stale row appear on Instagram. **No quarantine step needed.** |
| Approvals | `mos_content_approvals` = **0 rows** | The hash mechanism exists but has no data. Any publish check written as "no matching approval → refuse" would block **100%** of publishing on day one. The check must be "an approval exists **and** the hash differs → refuse"; absent approval falls through to the legacy path. The 23 `done` records must not be re-published through the new release path expecting a hash. |
| Campaigns with ads | **Three, not two**, plus a fourth with spend: C-042 ربوة الرمز (17 ads, 0 running) · C-041 تل الربوة (13, 4 running) · C-037 أكنان ٢٥ (6, 4 running, campaign `paused`) · `meta-sync:act_1926066658353506` (1 running, 1,424.47 SAR, `project_id` NULL) | Per **D2**: flagged `legacy_unmanaged`, excluded from the new lane, left to end naturally. The proposal's "two live campaigns" is wrong — correct it. |
| Open tasks | 322 workflow tasks; approval tasks open with `assignee_user_id` **NULL** | `mos_perf_place_open_task` assigns only when `mos_role_load.daily_new_tasks > 0`, which is **0** for `marketing_manager`. Fixed in §4 group C; existing NULL-assignee tasks are backfilled to the single holder of each role. |
| Capacity rows | Writer 10/day and designer 4/day already in **both** `mos_role_load` and `mos_user_capacity`; **manager capped at approvals=20** | §5.3's "merge the two capacity screens" is a **data** change, not code. The manager cap is one row to change to uncapped. |

---

## 4. The build

Ordered by dependency only. No phases. Sizes: xs ≤ ½ day · s ≈ 1 day · m ≈ 2–3 days · l ≈ 1 week · xl > 1 week.

### Group A — Data model (nothing else can start)

| # | Where | What | Size | Risk |
|---|---|---|---|---|
| A1 | NEW `public.mos_content_rows` (`id, campaign_id, project_id, plan_id, kind 'organic_row'\|'paid_batch', batch_day, workflow_version_id, row_key, created_at`) + `mos_content.row_id`, `mos_content.row_order` | The row as a real subject. It carries **its own** `workflow_version_id` because `workflow_advance_role_path` reads pinned steps off the subject and a row has no `mos_content` to read them from. `row_key` lets a reservation name it before the three content records exist. `row_order` is the writer's order; publish order is its reverse. `mos_publish_batches` is **not** reusable (per-execution-per-*platform*, and a paid batch has no publish batch). | m | med |
| A2 | RLS `workflow_role_tasks_read/_ins/_upd/_del` | All four carry `AND subject_table = 'mos_content'`. **A row task the SECURITY DEFINER functions create perfectly is invisible to every browser session** — an empty queue, not an error. Widen to `IN ('mos_content','mos_content_rows')`. Also: `workflow_role_tasks_upd_own` has **no** subject clause, so a person can update a row task they cannot read — add one. | s | **high** |
| A3 | `mos_task_reservations.content_id` | Hard FK to `mos_content`, so a reservation cannot point at a row. Add a `row_id` sibling with its own FK and a CHECK that exactly one is set. **Leave `mos_content_approvals.content_id`'s FK alone** — one approval row *per member* is what makes "send-back is per post, the other two keep their approval" storable with no new partial-approval state. | s | med |
| A4 | `mos_spread_effort` (SQL) **and** `effortWeights()` (`src/lib/marketingOS/scheduling/ledger.ts`) | Both turn N into `[1,1,…]` across N working **days**. A row given weight 3 reserves one slot on each of three days — **the opposite of what a row means.** Add a same-day spread mode. **Change both together**: the commit's conflict test uses SQL, the preview uses JS, and its own comment records that exact divergence having already caused a bogus WS409. | m | **high** |
| A5 | `mos_step_effort` seed rows | `post_std/design/post = 2` against a designer capacity of 4/day is a **real 2/day** — the double-count the proposal rejects. Delete per-step effort for posts; a video stays >1 slot. | xs | low |
| A6 | `mos_user_capacity` | Manager `approvals` 20 → uncapped. Confirm writer 10 / designer 4 agree across both tables and retire `mos_role_load` as an input. | xs | low |
| A7 | NEW `public.mos_month_notes` (`id, month, project_id nullable, batch_date nullable, kind 'month'\|'project'\|'row'\|'paid_batch', body, author_user_id, created_at, updated_at`) | Notes **cannot** live on `mos_campaign_plans.input` — `campaignPlanRevise` rewrites it wholesale and `parsePlanInput` drops unknown keys. `mos_comments` has only `content_id`/`campaign_id`. Key on the **template coordinate** `(month, project_id, date)`, which the Sun أ / Tue ب / Thu ج rule fixes before any planning runs — **not** on the plan item key `${projectId}:post:${n}`, which carries no day and follows the item if distribution moves it. Covers E1's paid-batch cell. | s | low |
| A8 | NEW `public.mos_month_template` (one row: posting weekdays, posts per row, creatives per project per week, campaign length, budget per project, Meta template ref, lead-time days, safety-margin days, publish time, intra-row gap minutes, the four weekly-rule numbers) | The standing month as data. Replaces what 16 settings screens express. | s | low |
| A9 | `mos_publications` — add `placement_variant ('feed'\|'story')` + `pair_id` | **No feed-vs-story discriminator exists** on the organic side; §3.4's "every post is two releases" has no representation. The paid side already has this exact vocabulary on `mos_ad_sets`. Also: `grid_row`/`grid_col` are Instagram profile-grid coordinates, **not** publish order — do not reuse them. | s | med |
| A10 | `mos_content_types` — the `video` type's `field_schema` | `['idea','hook','scenes','duration','aspect_ratio']` — **no caption.** `mos_content_writing_hash`, `mos_tg_content_locked_guard` and the `required_fields` check all iterate `field_schema`, so a video's caption is invisible to all three. Add it before "every item carries a caption" can be true. | xs | low |
| A11 | New `workflow_versions` rows: `post_std` v8, `video_std` v7 | The row path. `writing` step gains `required_fields: ['caption','headlines']`; `design` step gains `required_files: ['final_square','final_vertical']`. **The engine check already exists** — §12 lists "readiness refused at the designer's submit" as missing, but `workflow_advance_role_path` (`2026-09-14_03:193-243`) already refuses on a missing `required_files` role. Every live version just carries `required_files: []`. This is a definition edit, **not engine work.** | s | med |

### Group B — Engine (depends on A)

| # | Where | What | Size | Risk |
|---|---|---|---|---|
| B1 | NEW `api/_lib/marketing/planning/monthCompiler.ts` | Turns one `mos_month_template` row + three project ids + a month into **four** `PlanInput`s (one organic, three paid) for the existing `planCampaign()`. Calls it with `opts.withAlternatives: false` and `rules.searchBudget: 0` — both levers already exist. Groups organic items into rows of three by `(project, batch_day)` before scheduling. **No search, no alternatives, no preview ritual.** | l | med |
| B2 | `src/lib/marketingOS/scheduling/plan.ts` | Organic item construction currently emits `p.posts` loose items keyed `${projectId}:post:${n}` with no day. Add a row-aware path: items carry `rowKey` and `fixedNeedDay` (the template already knows the day), so distribution is satisfied **by construction** rather than by search — "Sun أ / Tue ب / Thu ج is never two of the same project in a row". | m | med |
| B3 | `src/lib/marketingOS/scheduling/releases.ts` | Emit **two** releases per organic post — feed (square, caption) and story (vertical, no caption) — carrying `placement_variant` and `pair_id`. Compute the batch moment from the template's publish time and intra-row gap, and **reverse `row_order`** so the first-read post gets the latest slot. | m | med |
| B4 | `mos_campaign_plan_commit` | Commit four plans in one transaction (**D8**). Create `mos_content_rows` and their members. Write `account_id` (**S3**). Pin to the new versions (**A11**). Keep the advisory lock, the snapshot-hash check and the WS409 conflict contract exactly as they are — **never** SQLSTATE 40001/40P01. | l | **high** |

### Group C — Tasks and approvals (depends on A, B)

| # | Where | What | Size | Risk |
|---|---|---|---|---|
| C1 | `mos_plan_consume_reservation` | Guards on `subject_table <> 'mos_content'` and matches by `mos_content_plan.content_key`. Teach it the row subject and `row_key`, or a row task silently opens with **no reservation, no assignee and no window**. | m | **high** |
| C2 | `mos_perf_place_open_task` | Two defects. It assigns only when `mos_role_load.daily_new_tasks > 0`, which is **0 for `marketing_manager`/`ceo`/`ops_supervisor`** — so every approval task in the live system opens **unassigned** and is reachable only by role. And it wraps its whole body in `EXCEPTION WHEN OTHERS THEN RAISE WARNING`, so an unresolvable subject produces a silent unassigned task. Fix the assignment rule; narrow the catch to the specific conditions it means to swallow. | m | **high** |
| C3 | `mos_work_ledger_v` | Its first arm filters `t.subject_table = 'mos_content'`. Add the row arm, charging **three** slots on the batch's production day (**A4**). This view is the **only** union of workflow tasks + reservations + manual tasks — it is also what the person-keyed queue should read. | m | **high** |
| C4 | `mos_content_v` | LEFT JOINs the open task on `subject_table='mos_content'` and derives `owner_role`, `current_assignee_user_id`, `current_task_due_at`, `current_step_key` and `status_key` from it. **Move the open task to the row without fixing this and all three members fall into the `WHEN tc.total_tasks > 0 THEN 'done'` branch** — and every list, badge, route and notification reads this view. Resolve the member's open task through `row_id`. | m | **high** |
| C5 | `workflow_advance_role_path` | Accept a row subject: read the pinned steps off `mos_content_rows.workflow_version_id`; evaluate `required_fields`/`required_files` across **all three members**; name the offending member in `MOS:REQUIREMENTS_MISSING`. | l | **high** |
| C6 | `src/pages/Marketing/components/RequestChangesModal.tsx` + `p_return_to` | The only rejection surface carrying revision targets and a validated return step. Add the member dimension: send-back targets `(row, member, fields)`. The other two members keep their `mos_content_approvals` row untouched — no new partial-approval state. | m | med |
| C7 | The exceptions query | **`result='rejected'` has 0 rows across 322 tasks.** The live value is `changes_requested` (9 writing_review, 2 design_review, 2 design, 1 editing; max round 4). A "rejected three times" predicate written against `rejected` **would never fire.** Build the list over: incomplete row at batch date · `changes_requested` round ≥ 3 · ad failed · publish failed · account not connected · platform rejected · sold-out project · capacity breach. | m | med |
| C8 | `api/marketing-os.ts` `work_list` + `perf_me` + `perf_desk` | Four definitions of "mine": `work_list` filters `mos_content_v.owner_role` (**role**) while its manual half filters `assignee_user_id` (**person**); `perf_me` filters tasks and omits manual tasks; `perf_desk` pulls everything and groups client-side. Collapse to one person-keyed queue reading `mos_work_ledger_v`. Keep the `effectiveQueueRole` + `surface_access` team gate. | l | med |

### Group D — Material and publishing (depends on A, B, C)

| # | Where | What | Size | Risk |
|---|---|---|---|---|
| D1 | `api/_lib/marketing/publishRelease.ts` | Reads `mos_publication_v`, whose caption is bare `p.caption` with **no fallback**; `mos_release_v` already has `COALESCE(NULLIF(p.caption,''), c.data->>'caption')`. **The publish path uses the view without the fallback.** Switch to the resolver: files from the two slots **by destination**, caption from the approved writing, nothing from a picker. | m | **high** |
| D2 | `publishRelease.ts` — the hash check | **Nobody compares a hash before posting.** The only reader in the repo (`worker/src/runMetaAdJob.ts:778-796`) selects `caption_hash` and throws it away — the destructured type is `{step_key, approved_at}`. It is an existence check dressed as a hash check. Implement "approval exists **and** hash differs → refuse"; absent approval falls through (see §3 — 0 rows live). | m | **high** |
| D3 | `publishRelease.ts` — write-back | After a successful post, write the file ids and the caption actually sent onto `mos_publications`. Route the refusal through `mos_release_open_task` with a **new reason code** — it already takes a reason plus Arabic detail and de-duplicates per release. **Do not invent a second exception mechanism.** | s | med |
| D4 | `src/lib/marketingOS/platformRules.ts:113-127` | Checks only caption **length** and >30 Instagram hashtags. **A feed post with no caption publishes silently with no text.** Add the empty-caption rule per **D3** (block when the approved writing has no caption). Line 344 already has the story rule right. | s | med |
| D5 | `worker/src/marketing/…/resolveSlots` (`runMetaAdJob.ts:405-418`) | Queries `mos_asset_links` **without `superseded_at IS NULL`** — the only slot reader missing it (`content_ad_readiness` and `mos_content_design_hash` both have it). Harmless today (max version = 1 on all 38 links) and **silently wrong on the first re-upload**. | xs | med |
| D6 | `mos_promote_approval_asset` | A **single**-asset bridge; it cannot express "both slots were approved". Live: `approval_asset_id` set on 24/24 yet 15 rows still carry a plain `final` link. Extend to promote both slots, or retire it in favour of the by-destination resolver. | s | med |
| D7 | Ordering | Sequence the build so **D1 lands before the PublishTab file picker is demoted** (Group F). The picker is the only thing that fills `asset_ids` today; removing it first leaves every release with no material — which `releaseActions.requirements` correctly reports as "This release has no approved file to publish." | — | **high** |

### Group E — Paid (depends on S2, A, B)

| # | Where | What | Size | Risk |
|---|---|---|---|---|
| E1 | NEW lane step in `worker/src/marketing/refreshLane.ts` (110 lines today) | **Ad activation on the batch date.** `mosMetaSetStatus` exists with zero callers. Activate the five new, stamp `activated_at`, then judge the running set. | m | med |
| E2 | `worker/src/runRefreshCycleJob.ts:358` | Filters `placement_variant !== 'story'` out of the slate **and** reads metrics with `.in('ad_row_id', ids)` over that filtered set — so **story spend and story leads are invisible to the weekly decision today.** §3.4's "feed and story of one creative summed" is a real behaviour change. Sum on the creative key `COALESCE(pair_id, id)` — a feed row's `pair_id` equals its own id and the story row carries the feed row's, which also handles pre-2026-09-07 ads where `pair_id` is NULL. | m | **high** |
| E3 | NEW `api/_lib/marketing/ourLeads.ts` + the ranking feeder | Our WhatsApp leads per ad per window, from `chat_messages.meta.ad`. **Group on `resolved.ad_id`** (the internal `mos_execution_ads` UUID) and derive the project through execution→campaign — `resolved.content_id` is present on only **73 of 278** attributed messages, so grouping on it silently drops 74%. Note `meta.ad.ad_id` is the **platform** id; there is no top-level `source_id` (0/278), so the doc's shorthand does not match the live JSON. | m | med |
| E4 | `worker/src/marketing/creativeRanking.ts` | `RANKING_DEFAULTS` already carries `minSpendSar: 150` / `minImpressions: 2000`. The **pure core survives**; feed it our leads via `MetricTotals.leads` and a per-ad window `[activated_at, activated_at+6d]`. Add the two guards (≥5 leads, ≥20% margin → else **keep both**), the cost-per-click fallback, and fatigue **keep-and-flag** on the only scaled ad. Extend the existing unit tests. | m | med |
| E5 | `mos_settings.planning.autoApplyDefaultDecision` → true; `refreshCycleList`/`refreshCycleDecide` | Both exist with zero callers. With the rule re-pointed, the decision applies automatically and nothing is escalated. Keep the two actions as the audit surface, not a decision screen. | xs | low |
| E6 | Campaign + ad-set creation from the template at confirmation | Replaces the manual push. The feed/story ad-set pair is created from `mos_month_template`; **nobody names it.** | m | med |

### Group F — The month page and UI (depends on all)

| # | Where | What | Size | Risk |
|---|---|---|---|---|
| F1 | NEW `src/pages/Marketing/MonthPage.tsx` + actions `month_get` / `month_compile` / `month_confirm` / `month_report` | One page, two tenses. Plan: three project slots with the **D6** suggestion, volume summary, capacity verdict, weeks grid. Report: the same page with live numbers. **E1 (screens):** the weeks card carries a `العضوي`/`المدفوع` switch; the paid pane shows three cells per week (one per project) each with its own note pencil. | xl | med |
| F2 | NEW `mos_month_metrics` RPC | Reads `mos_ad_metrics_daily` (113 rows, 2026-08-25→2026-09-15, **read by no `api/` action today**) and our leads. **Do not reuse `mos_paid_analytics`:** `mos_execution_daily` has **0 rows** so it always takes its `daily_days = 0` fallback and returns **lifetime** `mos_campaign_executions.spend/leads` with `scoped:false`; and every `starts_on` is NULL so its current-vs-previous comparison **compares a number with itself**. Render an explicit **unattributed** row — 26% of measured spend (1,424.47 SAR, 107,704 impressions) belongs to a campaign with `project_id` NULL. Never render cost per qualified lead without its lead count beside it (denominators are 13/1/0). | l | med |
| F3 | Row task UI — writer (`WritingFields.tsx`) | **E3.** Three posts side by side, one submit. The headline list has **no reorder** today (only `setHeadline`/`removeHeadline`/append; the numeric badge is display-only) — build the third verb. **The caption is NOT AI-prefilled today**: `contentCaptionGenerate` returns `{caption, source}` and **persists nothing**; the writer must press «توليد بالذكاء» and the box opens empty. Prefill on task open, mark it unconfirmed, require confirm before send. `caption_source` is written to data but rendered only from transient local state that is null on page load — render it from data. **`hashtags` has no editor in the writing task** (only `HashtagsEditor` in `PlacementsTab`), yet `publishRelease.ts:88-102` appends them at publish and **0/24 rows carry any** — give it a home here. | l | med |
| F4 | Row task UI — designer | Three pairs of slots, six files, one submit, readiness refused at submit (**A11**). Read-only panel shows the **lines** and the design brief — not the caption — with the confirmed caption as context. | m | low |
| F5 | One approval component, mounted inline (**E2**) | `ContentPreviewModal` renders through `kit.Modal` (**an overlay, not inline**), is keyed to one `contentId`, and calls `fetchAssets()` with **no filter** — the whole asset library per open, filtered client-side. Three of those per expanded row is **three full library reads**. Refactor to a component that mounts both standalone and inline, with a scoped asset fetch. `s-rowapprove` becomes the permalink, not a destination. | l | med |
| F6 | `src/pages/Marketing/components/TaskCard.tsx` | Still says «الاعتماد مع وجود متطلب ناقص مسموح، لكنه يُسجَّل على الاعتماد نفسه». **The database has refused this since 2026-09-14** (`MOS:REQUIREMENTS_MISSING`). `ApprovalSheet` was corrected; `TaskCard` was not. Two surfaces, one lying. | xs | low |
| F7 | The next-month reminder | **`vercel.json` already declares 10 crons — the plan limit — and `npm run build` does not validate `vercel.json`.** Ride `api/cron/planning-sweep.ts` (*/10); do **not** claim an eleventh slot. Also correct that file's header, which claims `mos_plan_repair()` raises a `plan_conflict` task — verified against the live `pg_get_functiondef`, **it does not**; the only writer is `worker/src/runRefreshCycleJob.ts:746`. | xs | low |

### Group G — Removals (last, after F is proven)

Delete outright: the two dead builders and the orphaned execution-template feature with its three API
actions (845 lines, reachable from nothing) · the inline organic-campaign backdoor · the task card's
inline reject dialog and third approval button · the Meta ad id as a typed field · owner-role
dropdown, execution label, ad-set name and ad name as inputs.

Hide under «متقدم», do not delete: campaign detail and execution pages · the publish tab (account
override only — **after D1**) · the 15 settings screens the month template replaces · the calendar ·
the team page.

Keep the `mos_execution_daily` write path (`daily_save`) until the Numbers rail item is actually
removed — otherwise an operator's hand-entry vanishes silently, which is the exact shape of every
silent-failure bug in this repo.

Reduced rail: **الشهر · مهامي · المحتوى · النشر · المكتبة · الإعدادات**.

---

## 5. Verification

Each group has a gate; nothing proceeds past a red one.

- **S** — as §3. All three verified on production before Group A starts.
- **A/B** — the engine's 66 unit tests plus new row-grouping cases; `scripts/e2e-campaign-plan.ts`
  extended to compile a full month from a template and assert 16 rows / 48 posts / 96 releases /
  60 creatives; a commit followed by a second commit asserting WS409 (never 40001).
- **C** — `scripts/e2e-content-workflow.ts` extended: open a row task, submit with a member missing a
  required file and assert refusal naming that member, send back one post and assert the other two
  keep their approval rows, assert the row charges three slots on one day in `mos_work_ledger_v`.
- **D/E** — `scripts/e2e-release-split.mjs` extended with the hash-mismatch refusal and the write-back;
  a ranking test fixture built from the real أكنان numbers asserting **keep إعلان ٣, pause ١ ٢ ٤ ٦ ٧**
  and a second fixture inside the guards asserting **keep both**.
- **The one proof that matters** — on production: one real Instagram **feed post** and one real
  **story** published from a compiled month through bundle.social with the caption resolved from the
  approved writing; and one real ad **activated on its batch date** and judged on its own seven days.
  §12 flags both paths as "built; never exercised". Until this passes, the month model is untested
  regardless of what the suites say.

---

## 6. Rollback

One phase means rollback is not a rail edit. The lever is **the pinned workflow version**.

1. **Stop new work:** set `mos_month_template.enabled = false` and `autoApplyDefaultDecision = false`.
   The compiler stops; the refresh lane stops acting.
2. **Revert the deploy.** Group G is the only destructive group — sequence it last precisely so that
   a revert before G restores every hidden surface.
3. **In-flight rows survive either way.** They are pinned to v8/v7 and keep walking that chain. The
   releases already created stay due; the sweep keeps publishing them. Nothing needs unwinding.
4. **The irreversible boundary is Group G.** Once the wizard, goals and measures are deleted, rollback
   is a git revert plus a redeploy, not a setting. **Do not ship G in the same deploy as A–F.**

That last point is the one concession to staging worth keeping: A–F in one deploy, G in a second one
a week later. It costs nothing, changes no behaviour, and preserves a cheap undo for the week that
matters most.

---

## 7. Plain-language summary

**What we are building:** one screen where you pick three projects and press confirm, and everything
else — the work, the schedule, the ads, the publishing — happens without you, except when a rule
breaks and you get one line with one decision on it.

**How long:** the work adds up to roughly six to eight weeks for one person, most of it in four
places — the month compiler, the row task, the month page, and the approval component.

**What we found that is already broken and costing money:** the ad builder ignores the caption your
writer confirmed and sends its own AI-written one to Meta instead, because three parts of the system
each use a different name for "the writer confirmed it". You approve one text; Meta runs another. That
is fixed first, alone, before anything else.

**Two more things that are quietly wrong today:** the paid analytics you look at are lifetime totals
labelled as a period, and the "compared to last period" number is comparing a number to itself. And
every ad's activation date is empty, so any "first week" rule would judge ads on a window that starts
up to ten days late.

**The one thing that makes a single cutover safe:** every piece of work remembers which rulebook it
was created under. New rules apply to new work only. Nothing in flight is disturbed, and we do not
have to migrate 24 records or ask سارة to re-make nine designs before we can start.

**What we need from you before anyone writes code:** eight decisions in §2, of which two are genuinely
yours — which client stages count as a "qualified" lead (it decides which projects you run each
month), and whether the four campaigns currently spending 5,559 riyals get adopted into the new rules
or left to finish on their own.
