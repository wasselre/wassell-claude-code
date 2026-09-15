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

**The most alarming thing we found is unrelated to this plan, and it is armed rather than firing.**
The writer confirms a caption, the manager approves it, and then the ad builder looks for that
confirmation under a key that nothing in the entire codebase ever writes. It concludes the writer
never confirmed, generates its own caption with AI, and sends *that* to Meta. You would approve one
text and Meta would spend the budget on another, with no error anywhere.

It has not happened yet, and the reason is luck rather than design: the caption field only shipped on
2026-09-14, and **0 of the 24 content records carry a caption at all** (verified 2026-09-15:
`with_caption = 0`, `with_confirm = 0`). The writer path has therefore never been reachable — every
ad so far took the legacy AI route openly. It would have fired on the first caption a writer ever
confirmed, which under this plan is week one. Fixed first, on its own, before anything else.

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

## 2. Decisions — all settled

The proposal said nothing was open; the survey found eight things that were. All eight are now
decided — four by the operator on 2026-09-15, four taken as engineering calls. **Nothing below is
open.**

| # | Decision | Settled as |
|---|---|---|
| **D1** | Do the new material gates (two design slots, a confirmed caption) apply to the 24 pre-cutover content records? 9 of the 17 ad-bearing rows have no slots (8 carry only a legacy `final` link: P-132/133/134/136/141/142/143/144; P-148 is square-only), the missing verticals **do not exist as files**, and **0 of 24 rows carry a caption**. | **New work only.** Gates apply to content pinned after the cutover. The 24 existing records finish on their old rulebook and are never re-published through the new path. No re-uploads, no back-written captions, no migration. *Operator, 2026-09-15.* |
| **D2** | What happens to the four live executions carrying 5,559.74 SAR? No `slot_id` or `activated_at` on any of their 42 ad rows; two of them (2,652 and 1,424 SAR) have **zero** ads linked to any content. | **Pause all of them at the cutover.** Nine running ads stop; the new month starts from zero paid spend. This is not the cheapest option but it is the only one with no invented data in it — see §3.1 for what it costs and the timing constraint it creates. *Operator, 2026-09-15, against the recommendation to let them end naturally.* |
| **D3** | Does an empty caption hard-block publishing? Adding it to `preflightPublishSet` blocks all 10 existing draft publications at once, in three surfaces. | **No.** Resolve the caption from the approved writing and block only when *that* is missing. Requires the resolver in the same change (D1, Group D). *Engineering call.* |
| **D4** | Which key is the writer's caption confirmation? The UI writes `caption_confirmed_at`; SQL compares `caption_confirmed_text`; the ad builder gates on `caption_confirmed_by_writer_at`, which **nothing writes**. | **`caption_confirmed_text` is the comparison, `caption_confirmed_at` the timestamp.** `caption_confirmed_by_writer_at` is deleted repo-wide. This is the live money bug — item S1. *Engineering call; there is only one correct answer.* |
| **D5** | Define "qualified" for cost per qualified lead. | **Qualified = every stage except the terminal-lost ones.** The operator's rule was "anything that is not unqualified or lost". The canonical list (`src/lib/salesProcess/config.ts:97-111`) has **thirteen** stages and **three** are terminal-lost: «غير مؤهل» (10), «خاسر» (11) and **«يريد إيجار» (12)** — a client who wants a rental we do not sell, whose own code comment reads *"Terminal — client wants a rental we don't offer."* All three are excluded; «مغلق ناجح» (9) is terminal but obviously qualified. *Operator, 2026-09-15, extended to the third terminal stage on the same reading.* See the two notes below. |
| **D6** | Define "days since last featured." No source exists: nothing has ever published and only 24 content records exist. | `greatest(last day with spend in mos_ad_metrics_daily, last mos_content.created_at)` per project, **labelled as such on the screen**. Revisit after one real month. *Engineering call.* |
| **D7** | Does a project-column note reach that project's paid creatives, or only its organic rows? | **Separate. Paid notes are their own channel.** The E1 switch gives the grid two panes and **each pane carries its own project-column notes and its own cell notes**. The month note sits above both. *Operator, 2026-09-15, against the recommendation to share one column note.* |
| **D8** | The month confirms four plans at once but `mos_campaign_plan_commit` takes a single `plan_id` inside one advisory-lock transaction. | **One compiler call committing all four in one transaction.** Four sequential commits can leave a month half-reserved with no clean undo. *Engineering call.* |

**Two notes on D5.**

*First, a correction to this plan's own earlier premise.* It said «خاسر» is "a value not in the
model's option list". It **is** in the canonical list, at order 11. The conclusion — an explicit set,
never an ordinal range — survives anyway, and for a better reason: `src/lib/salesStudio/analytics.ts:154`
already implements `stageOrderOf(c) >= 7` semantics under which «غير مؤهل», «خاسر» and «يريد إيجار»
count as having *reached every funnel stage*. An ordinal rule here would silently inherit that.

*Second, build it as a derived set, not a literal.* Export the exclusion from
`src/lib/salesProcess/` as "terminal and not «مغلق ناجح»" and have F2 import it, so a fourth terminal
stage added by the Sales OS is caught by `assertSalesProcessEnums()` instead of quietly inflating the
denominator.

*And the convergence this creates is real.* «جديد» counts as qualified, and an ad lead auto-onboards
at «جديد» — so a project's leads are **maximally** qualified exactly when the measure is read on the
20th, before anyone has triaged them. Cost per lead and cost per qualified lead will land as two
near-identical riyal figures under two different Arabic labels, when the proposal separated them
deliberately (one drives the weekly ad rule, one picks next month's projects). **F2 therefore renders
the pair as a count, not two currency figures: «١٣ مؤهل من ١٧».** That is honest at any triage state
and stops the month page implying a precision it does not have.

---

## 3. The cutover

### S — Three safety items that land and are verified BEFORE anything else

These are separable, independently deployable, and each fixes something wrong today. They are not
part of the month model; they are the ground it stands on.

| | What | Where | Why first |
|---|---|---|---|
| **S1** | **The caption key mismatch.** The worker gated on `caption_confirmed_by_writer_at` — written by nothing in `src/`, `api/` or `supabase/` (only the fixture at `scripts/e2e-content-workflow.ts:159`). It therefore always concluded the writer did not confirm and wrote its own DeepSeek caption to Meta. **Armed but never fired:** 0 of 24 content records carry a caption, so the writer path has never been reachable. | `worker/src/runMetaAdJob.ts` → compare `caption_confirmed_text` to `caption` **raw and untrimmed** (matching `2026-09-14_01:895` and `WritingFields.tsx:405`); timestamp is `caption_confirmed_at`; third key deleted from all code | Week one of this plan is the first time a writer confirms a caption, which is exactly when it would have fired. **✅ DONE 2026-09-15** — also now refuses a caption edited after confirmation, which the old gate could not detect. |
| **S2** | **`activated_at` is NULL on all 30 ad rows.** It was going to be backfilled from Meta's history so the seven-day rule could judge the existing ads fairly — the only fallback, `min(mos_ad_metrics_daily.day)`, is the **sync** start and is up to 10 days late (mena52-V3: created 2026-08-16, first lead 2026-08-15, metrics begin 2026-08-25). | **D2 removed the reason for the backfill.** Every legacy ad is paused at the cutover, so the weekly rule never judges one; every ad it will ever see is one **E1 activates and stamps**. What remains is: (a) E1 must stamp `activated_at` at activation — it does; (b) the **historical** window still matters to the F2 month report and to D6's "days since last featured", both of which read `mos_ad_metrics_daily` directly and neither of which needs `activated_at`. | **Reduced to nothing as a pre-cutover blocker.** No backfill migration, and **no `legacy_unmanaged` exclusion flag** — §3.1 says that artefact is gone and it must not reappear here. The gate below is therefore **two items, not three**. Keep this row as the record of why the backfill was dropped. |
| **S3** | **`account_id` NULL at commit.** `mos_campaign_plan_commit` inserts publications with `account_id` NULL (`2026-09-14_02:488-498`); `publishRelease.ts:64` refuses unless `pub.account_connected === true`; but `mos_release_due`'s `automatable` is a **platform**-level check. | NEW `supabase/migrations/2026-09-15_01_publication_default_account.sql` — a BEFORE INSERT trigger on `mos_publications` resolves the connected, publishable account for the platform. A trigger rather than a re-emit of the long commit RPC, and it covers every other insert path too. | Without it **every release of the first compiled month becomes a `publish_failed` task the moment the sweep ticks.** This is why §12 says the Instagram path is "built; never exercised". **✅ DONE 2026-09-15**, applied to production: all 10 publications resolve to `wassel.re`. Also fixes a latent second bug — the insert's `ON CONFLICT (content_id, platform, account_id)` could never fire while `account_id` was NULL, since Postgres treats NULLs as distinct, so the idempotency the RPC believes it has did not exist. X (`@wassel_sa`) still resolves to NULL on purpose and surfaces as «الحساب غير موصول». |

**Verification gate — two items.** S1 proves out by building one ad and confirming the caption Meta
receives is byte-identical to the approved `data.caption`. S3 proves out by one real feed post and one
real story published through bundle.social from a committed plan. S2 carries nothing to verify.
**Nothing in §4 starts until both pass.**

### What the cutover does to live data

| Live thing | Count / state | What happens |
|---|---|---|
| Content records | 24; 23 `done`, **1 mid-`design`** | Keep their pinned version (`ea460e57…` ×22, `bf04288d…` ×2). The one in-flight item walks its old chain to completion. No migration touches them. |
| Draft publications | 10, all `status='draft'`, `scheduled_at` **and** `planned_at` NULL | `mos_release_due` filters on `due_at IS NOT NULL`, so the sweep is **structurally blind** to them. A single cutover cannot make a stale row appear on Instagram. **No quarantine step needed.** |
| Approvals | `mos_content_approvals` = **0 rows** | The hash mechanism exists but has no data. Any publish check written as "no matching approval → refuse" would block **100%** of publishing on day one. The check must be "an approval exists **and** the hash differs → refuse"; absent approval falls through to the legacy path. The 23 `done` records must not be re-published through the new release path expecting a hash. |
| Campaigns with ads | **Three, not two**, plus a fourth with spend: C-042 ربوة الرمز (17 ads, 0 running) · C-041 تل الربوة (13, 4 running) · C-037 أكنان ٢٥ (6, 4 running, campaign `paused`) · `meta-sync:act_1926066658353506` (1 running, 1,424.47 SAR, `project_id` NULL) | Per **D2**: **all nine running ads paused at the cutover**, via the same `mosMetaSetStatus` path the new activation lane uses. Nothing is deleted; every ad keeps its Meta history. See §3.1. The proposal's "two live campaigns" is wrong — correct it. |
| Open tasks | 322 workflow tasks; approval tasks open with `assignee_user_id` **NULL** | `mos_perf_place_open_task` assigns only when `mos_role_load.daily_new_tasks > 0`, which is **0** for `marketing_manager`. Fixed in §4 group C; existing NULL-assignee tasks are backfilled to the single holder of each role. |
| Capacity rows | Writer 10/day and designer 4/day already in **both** `mos_role_load` and `mos_user_capacity`; **manager capped at approvals=20** | §5.3's "merge the two capacity screens" is a **data** change, not code. The manager cap is one row to change to uncapped. |

### 3.1 The paid pause (D2), and the timing constraint it creates

Pausing everything is the clean-slate option. It costs three things and buys two, and it puts one
hard constraint on when this ships.

**What it costs**

1. **Nine running ads stop**, including the four on C-041 تل الربوة and the four on C-037 أكنان ٢٥,
   plus the `meta-sync` ad that alone accounts for 1,424.47 SAR and 107,704 impressions.
2. **The lead flow from them ends the same day.** Those ads are the source of the click-to-WhatsApp
   conversations the attribution chain has been recording — 241 chats since 2026-08-15. Paid lead
   volume goes to zero until the first new batch activates.
3. **Meta's learning resets.** Every new ad set enters the learning phase from scratch, which the
   proposal already accepts as a known cost of adding ads weekly — but here it happens on all three
   projects at once rather than rolling.

**What it buys**

1. **No invented data anywhere.** The alternative required either guessing an `activated_at` for ads
   whose real one is unknown, or carrying a `legacy_unmanaged` exclusion flag through the ranking
   lane, the month page and the exceptions query forever. Both are gone.
2. **The build gets smaller.** Group E drops the exclusion flag, the ranking feeder drops its
   "ignore unmanaged executions" branch, and the month report drops the mixed-provenance case where
   some spend is governed by the new rule and some is not. The two executions that no ad links to any
   content — 2,652 SAR and 1,424 SAR — stop being a permanent special case.

**The sequence — and it is not "pause on deploy day".**
An earlier draft of this plan said *confirm the month, then deploy, then pause*. That is impossible:
the compiler is B1 and the confirm screen is F1, so **both ship in the very deploy the month was
supposed to be confirmed before**. And confirmation must precede the first batch by ten working days,
so pausing at deploy time buys exactly the dead fortnight the constraint exists to avoid.

The pause is tied to **the batch date, not the deploy date**:

1. **Deploy A–F whenever it is ready.** Safe before any pause: the sweep is structurally blind to the
   10 drafts (`due_at IS NOT NULL`) and pinned versions protect every in-flight item.
2. **Confirm the month on its normal date** (~the 20th), ten working days before the first posting Sunday.
3. **Production runs its ten working days** as usual. Legacy paid keeps running and keeps producing
   leads throughout — there is no reason to stop it early.
4. **Pause the legacy ads from the same lane step that activates the first new batch.** E1 builds both
   from one primitive, so legacy paid stops in the same tick that new paid starts.

The gap becomes **hours, not weeks, and the month boundary stops mattering** — which is the better
outcome, since it also removes the deploy-scheduling constraint entirely.

**Build consequence:** `mosMetaSetStatus` — zero callers today — serves **both** the lane's
activate-and-pause and the cutover pause. But it is **not sufficient on its own**: the `meta_set_status`
action (`api/marketing-os.ts:6319-6333`) does exactly one thing, `MetaMarketingClient.setStatus()`, and
writes **nothing** to our tables. Contrast `applyCycle` (`runRefreshCycleJob.ts:663-699`), which writes
`status='paused'`, stamps `retired_at` and retires the slot after every Meta pause. A cutover pause built
on `mosMetaSetStatus` alone would stop the ads at Meta while leaving `mos_execution_ads.status='running'`
and open `mos_refresh_cycles` rows behind it — and E5's automatic application could then **re-activate the
ads it just paused**. See E1 and E5 for what the script must write.

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
| A7 | NEW `public.mos_month_notes` (`id, month, lane 'organic'\|'paid'\|null, project_id nullable, batch_date nullable, kind 'month'\|'project'\|'row'\|'paid_batch', body, author_user_id, created_at, updated_at`) | Notes **cannot** live on `mos_campaign_plans.input` — `campaignPlanRevise` rewrites it wholesale and `parsePlanInput` drops unknown keys. `mos_comments` has only `content_id`/`campaign_id`. Key on the **template coordinate** `(month, lane, project_id, date)`, which the Sun أ / Tue ب / Thu ج rule fixes before any planning runs — **not** on the plan item key `${projectId}:post:${n}`, which carries no day and follows the item if distribution moves it. **Per D7 the `lane` column is load-bearing**: a project-column note belongs to one lane only, so the organic pane and the paid pane each carry their own; `lane IS NULL` is the month note, which reaches both. | s | low |
| A8 | NEW `public.mos_month_template` (one row: posting weekdays, posts per row, creatives per project per week, campaign length, budget per project, Meta template ref, lead-time days, safety-margin days, publish time, intra-row gap minutes, the four weekly-rule numbers, **`general_topic_bank text[]`**) | The standing month as data. Replaces what 16 settings screens express. The topic bank is §3.7's promised fallback for a Saturday cell left blank — it existed nowhere in this plan until 2026-09-15. | s | low |
| A8b | `mos_content_rows.project_id` **nullable**, plus a `general` marker on `kind`/`row_key`; B1 emits one general row per posting week; F2b's organic chain becomes `month → project column (skipped when null) → cell note → topic bank` | **The Saturday general row had no build item at all.** The words "Saturday", "general" and «عام» appeared nowhere in this plan, yet it is **one of the four posting days — a quarter of the organic month, 4 rows and 12 posts of every 16 and 48.** It has no project, so B1's grouping by `(project, batch_day)` cannot produce it; under D7 it has no project column to inherit from, so its own cell note is the only project-specific instruction it can ever receive; and its fallback topic bank did not exist. | m | **high** |
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
| C7 | The exceptions query | **`result='rejected'` has 0 rows across 322 tasks.** The live value is `changes_requested` (9 writing_review, 2 design_review, 2 design, 1 editing; max round 4). A "rejected three times" predicate written against `rejected` **would never fire.** Build the list over: incomplete row at batch date · `changes_requested` round ≥ 3 · ad failed · publish failed · account not connected · platform rejected · sold-out project · capacity breach · **the weekly ranking cleared no creative** (the `ranked.length === 0` branch — an empty ranking must produce a line, not silence; see E1b). | m | med |
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
| D6b | `api/_lib/marketing/publishRelease.ts` — the manual caller | §3 says "no quarantine step needed", but that is proven **only against the sweep** (`mos_release_due` filters `due_at IS NOT NULL`). `publishRelease.ts` has **two** callers, stated in its own docblock: the sweep, **and the endpoint when a person presses publish** — which never consults `due_at`. So a person can still push a pre-cutover draft through the new by-destination path, where it has no slots, no caption and no approval hash. Refuse explicitly: a publication whose content is pinned to a pre-cutover workflow version takes the legacy path or is refused by name, never the new resolver. | s | **high** |
| D7 | Ordering | Sequence the build so **D1 lands before the PublishTab file picker is demoted** (Group F). The picker is the only thing that fills `asset_ids` today; removing it first leaves every release with no material — which `releaseActions.requirements` correctly reports as "This release has no approved file to publish." | — | **high** |

### Group E — Paid (depends on S2, A, B)

| # | Where | What | Size | Risk |
|---|---|---|---|---|
| E1 | NEW lane step in `worker/src/marketing/refreshLane.ts` (110 lines today) + NEW `scripts/cutover-pause-legacy-ads.mjs` | **Ad activation on the batch date.** Activate the five new, **stamp `activated_at`**, then judge the running set. The same primitive performs the D2 cutover pause, **run from the activation tick of the first new batch, not on deploy day** (§3.1). The script must do per execution what `applyCycle` already does per ad: call Meta, then write `mos_execution_ads.status='paused'` + `retired_at`, retire the `mos_creative_slots` row, and **close every open `mos_refresh_cycles` row on the four legacy executions** — `mosMetaSetStatus` writes none of that by itself. It also writes a **manifest row per ad before the first Meta call** (`ad_row_id`, `platform_ad_id`, prior status, prior Meta effective status, `paused_at`) and carries a paired **`--restore`** mode. A log is not a manifest, and "re-runnable" means re-pause, not undo. | l | **high** |
| E1b | `mos_settings.planning` + `applyCycle` | **The slate must not ratchet.** `rankCreatives` takes a `ranked.length === 0` branch (`creativeRanking.ts:346-353`) when nothing clears both data gates: it sets `defaultReplace = []` and summarises "keep everything and let you decide". With E5 applying automatically and no decision screen, that is **silence** — and the five new activate regardless, so the live slate grows by five with nothing retired. Add `maxActiveCreatives` mirroring the existing `minActiveCreatives`, cap activation against it, and see C7 for the exception line. | s | **high** |
| E1c | `RANKING_DEFAULTS` / `mos_month_template` | The 150 SAR gate was calibrated against a campaign spending ~691 SAR/week. The standing budget is 2,000 SAR per project per month — about **467 SAR/week** — so the same absolute gate is a materially stricter rule. Seed `minSpendSar` from `mos_month_template.budget_per_project` at compile time rather than hard-coding it. **Do not defer to §3.6's "review the four numbers after one month"**: if the gates never clear, the ratchet compounds before that review happens. | s | med |
| E2 | `worker/src/runRefreshCycleJob.ts:358` | Filters `placement_variant !== 'story'` out of the slate **and** reads metrics with `.in('ad_row_id', ids)` over that filtered set — so **story spend and story leads are invisible to the weekly decision today.** §3.4's "feed and story of one creative summed" is a real behaviour change. Sum on the creative key `COALESCE(pair_id, id)` — a feed row's `pair_id` equals its own id and the story row carries the feed row's, which also handles pre-2026-09-07 ads where `pair_id` is NULL. | m | **high** |
| E3 | NEW `api/_lib/marketing/ourLeads.ts` + the ranking feeder | Our WhatsApp leads per ad per window, from `chat_messages.meta.ad`. **Group on `resolved.ad_id`** (the internal `mos_execution_ads` UUID) and derive the project through execution→campaign — `resolved.content_id` is present on only **73 of 278** attributed messages, so grouping on it silently drops 74%. Note `meta.ad.ad_id` is the **platform** id; there is no top-level `source_id` (0/278), so the doc's shorthand does not match the live JSON. | m | med |
| E4 | `worker/src/marketing/creativeRanking.ts` | `RANKING_DEFAULTS` already carries `minSpendSar: 150` / `minImpressions: 2000`. The **pure core survives**; feed it our leads via `MetricTotals.leads` and a per-ad window `[activated_at, activated_at+6d]`. Add the two guards (≥5 leads, ≥20% margin → else **keep both**), the cost-per-click fallback, and fatigue **keep-and-flag** on the only scaled ad. Extend the existing unit tests. | m | med |
| E5 | `mos_settings.planning.autoApplyDefaultDecision` → true; `refreshCycleList`/`refreshCycleDecide` | Both exist with zero callers. With the rule re-pointed, the decision applies automatically and nothing is escalated. Keep the two actions as the audit surface, not a decision screen. **Order this LAST inside Group E**, gated on an assertion that no legacy execution has an open `mos_refresh_cycles` row — otherwise automatic application can re-activate what the cutover just paused. | xs | med |
| E6 | Campaign + ad-set creation from the template at confirmation | Replaces the manual push. The feed/story ad-set pair is created from `mos_month_template`; **nobody names it.** | m | med |

### Group F — The month page and UI (depends on all)

| # | Where | What | Size | Risk |
|---|---|---|---|---|
| F1 | NEW `src/pages/Marketing/MonthPage.tsx` + actions `month_get` / `month_compile` / `month_confirm` / `month_report` | One page, two tenses. Plan: three project slots with the **D6** suggestion, volume summary, capacity verdict, weeks grid. Report: the same page with live numbers. **E1 (screens):** the weeks card carries a `العضوي`/`المدفوع` switch. The paid pane shows three cells per week (one per project), each with its own note pencil, **and its own per-project column note pencil** — without that second affordance the `lane='paid', kind='project'` row A7 provisions can never be written and F2b's middle level resolves to nothing. The organic pane keeps its column notes; the month note sits above the switch and reaches both. | xl | med |
| F2 | NEW `mos_month_metrics` RPC | Reads `mos_ad_metrics_daily` (113 rows, 2026-08-25→2026-09-15, **read by no `api/` action today**) and our leads. **Do not reuse `mos_paid_analytics`:** `mos_execution_daily` has **0 rows** so it always takes its `daily_days = 0` fallback and returns **lifetime** `mos_campaign_executions.spend/leads` with `scoped:false`; and every `starts_on` is NULL so its current-vs-previous comparison **compares a number with itself**. Keep an **unattributed** row as a fail-loud guard (repo convention), but scoped to pre-cutover history — after D2's pause no *new* spend can be unattributed, so it must not be framed as a steady state. **Render cost per qualified lead as a count, not a second currency figure** — «١٣ مؤهل من ١٧» beside cost per lead, per the D5 note. Import the terminal-stage exclusion from `src/lib/salesProcess/`; do not hand-list it and do not reuse `stageOrderOf`. | l | med |
| F2b | `src/pages/Marketing/` — the resolved-brief panel | Per **D7** the brief resolves down **one lane only**: an organic row task reads `month → organic project column → row cell`; a paid creative task reads `month → paid project column → paid batch cell`. Each line labelled by where it came from; empty levels hidden. A paid task must never show an organic column note, or the separation D7 asks for leaks straight back. | s | low |
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
  and a second fixture inside the guards asserting **keep both**; a third asserting the
  `ranked.length === 0` branch raises an exception line rather than activating five more (E1b); and the
  cutover script reporting **nine ads paused with a manifest row each, a re-run that is a no-op, and
  `--restore` exercised once on a real ad** before Group G deletes the Meta-ad-id field.
- **The one proof that matters** — on production: one real Instagram **feed post** and one real
  **story** published from a compiled month through bundle.social with the caption resolved from the
  approved writing; and one real ad **activated on its batch date** and judged on its own seven days.
  §12 flags both paths as "built; never exercised". Until this passes, the month model is untested
  regardless of what the suites say.

---

## 6. Rollback

One phase means rollback is not a rail edit. The lever is **the pinned workflow version** — but note
first that there are now **two** one-way doors, not one, and the earlier one is the paid pause.

0. **The cutover pause is the first irreversible act, and a code revert does not undo it.** Nine ads
   stop, Meta's learning phase resets on all three projects, and the paid lead flow is severed.
   Reverting the deploy restarts none of it. This is why E1 writes a manifest and carries a
   `--restore` mode, and why Group G must not delete the Meta ad id field until restore has been
   exercised once on a real ad.

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

**On deploy scheduling:** A–F has **no** date constraint — deploy it whenever it is ready. The month
boundary matters only to the *pause*, which runs from the first new batch's activation tick and not
from the deploy (§3.1). Group G waits a week, and additionally waits until `--restore` has been
exercised once.

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

**What was decided on 2026-09-15, and what it means in practice:**

- **Old work is left alone.** The 24 existing items finish the way they started. Nobody re-makes nine
  missing designs and nobody back-writes 24 captions before the first month can run.
- **All the running ads get paused — but on the day the new ones start, not on the day we deploy.**
  An earlier version of this plan had that backwards and would have left you with a fortnight of no
  paid advertising at all. The order is: ship the software, pick the month as you normally would
  around the 20th, let production run its two weeks, and stop the old ads in the same moment the new
  ones go live. The gap is hours. Nine ads stop, and that is the one step a code rollback cannot
  undo — so the script records what it stopped and can put it back.
- **A "qualified" lead is anyone not marked غير مؤهل, خاسر — or يريد إيجار.** That third one is the
  same idea as the first two: a client who wants to rent something we do not sell. It sits in the
  stage list right beside them and reads as terminal in the code's own words, so it is excluded on
  your rule, not against it. Worth knowing: this still counts a brand-new lead nobody has spoken to
  yet, so the page shows «١٣ مؤهل من ١٧» rather than two near-identical riyal figures that would
  imply a precision they do not have.
- **Notes for ads are their own thing, separate from notes for posts.** The month grid gets two
  views, and each keeps its own notes. A note you write on a project's posts never reaches that
  project's ads, and the writer of an ad never sees an instruction meant for a post.

**Everything is now settled. There is nothing left to answer before the work starts.**
