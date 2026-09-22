# Wassel Marketing OS — the month planner and the task dispatcher

## Technical brief with a plain-language version of every section

Prepared 2026-09-21 (Riyadh). Each section is written twice: **Technical** for the record and for an external reviewer, then **In plain terms** for the operator. **[measured]** = read from the production database or the repository that day. **[inferred]** = projected from the function logic, not observed. Function bodies in the appendices are the live definitions (`pg_get_functiondef`), not migration files.

The question for the reviewer is in §9.

---

## 1. Two subsystems

### Technical

Wassel CRM: React/TypeScript SPA on Vercel, Supabase Postgres, a Fly.io worker for Meta. The Marketing OS (`/m`) plans and produces a month of social-media posts and Meta ads for three real-estate projects. Producers: **one writer** (مريم, role `writer`), **one designer** (سارة, role `montage`); a marketing manager approves; the operator plans.

| Subsystem | Where | Runs | Decides |
|---|---|---|---|
| **Month planner** ("compiler") | TypeScript — `api/_lib/marketing/planning/{monthCompiler,monthActions,actions,snapshot}.ts`; engine `src/lib/marketingOS/scheduling/{schedule,ledger,refresh,calendar,types}.ts` | Once, at compile + confirm | Which posts/ads exist, their publish days, and — by backward scheduling against a capacity ledger — the **person and day** of every production step, written to `mos_task_reservations` |
| **Task dispatcher** | Postgres functions: `mos_task_dispatch`, `mos_dispatch_sweep`, `mos_plan_start_due`, `mos_capacity_used`, `mos_role_has_room`, `mos_work_due_at`, … | Every 10 min (Vercel cron `/api/cron/planning-sweep`, `*/10 * * * *` UTC); at confirm; on every task close | When a task is **created**, when it is **handed to a person**, its **deadline** |

Since 2026-09-17 the dispatcher does not read the planner's `planned_start`/`planned_end`. It copies them into `workflow_role_tasks.scheduled_start/scheduled_end` (informational) and decides everything from capacity and the clock.

### In plain terms

There are two brains. One plans the month: it puts every task on a person and a day and saves that. The other hands out the work every ten minutes. The second brain does not look at the first brain's days. It saves them, shows them on screen, and then ignores them. Everything else in this document is a consequence of that.

---

## 2. The data

### Technical

- **`mos_month_template`** (one row) — the standing month. Live **[measured]**: `posting_weekdays [0,2,4,6]` (Sun/Tue/Thu/Sat), `posts_per_row 3`, `creatives_per_project_week 5`, `projects_per_month 3`, `campaign_length_days 30`, `budget_per_project 2000`, `lead_time_working_days 10`, `safety_margin_days 2`, `publish_time 18:00`. Per-month overrides in `month_starts` JSONB; for `2026-09`: `organic_from 2026-09-22`, `paid_from 2026-09-22`, `ads_live_when_ready true`, `through 2026-10` (September and October compiled as ONE month), `budget_per_project 2667`, `creative_overrides [{batch_day 2026-09-22, creatives 2}]`.
- **`mos_content`** — one row per post or ad creative; `row_id` groups an organic batch's 3 posts; `purpose organic|paid`; `target_publish_at` is NULL for every paid creative **[measured]**.
- **`mos_content_rows`** — one per organic batch (`row_key` e.g. `2026-09:w3:2026-09-24:c`, `batch_day`, `project_id`, pinned `workflow_version_id`). **The row is the unit of work** (3 units).
- **`mos_content_plan`** — per single content: `status planned→in_production→…`, `production_start`, `required_ready_at`, `stage_deadlines`, `need_at`, `content_key`.
- **`mos_refresh_cycles`** — per project per weekly ad batch: `round`, `refresh_on`, `ready_by` (one working day before), `production_start_on`, `status scheduled→producing`. Live **[measured]**: round 0 = `09-22 / 09-21 / 09-10`, round 1 = `09-29 / 09-28 / 09-17`, round 2 = `10-06 / 10-05 / 09-24`, … round 5 = `10-27 / 10-26 / 10-15`.
- **`mos_creative_slots`** — one per creative per cycle; `content_id` set when the shell is created.
- **`mos_task_reservations`** — **the planner's bookings**: `plan_id, cycle_id, content_id, content_key, row_id, step_key, role_key, assignee_user_id, bucket, planned_start, planned_end, weight, status reserved|stale|consumed, consumed_task_id`. 520 rows, all created at confirm 2026-09-20 13:54 Riyadh; every one spans a single day; weight 1 (creative) or 3 (row); every one of the five production steps has one **[measured]**.
- **`workflow_role_tasks`** — **the dispatcher's tasks**: `subject_table (mos_content|mos_content_rows), subject_id, step_key, role_key, assignee_user_id, status open|done|skipped, round, opened_at, assigned_at, due_at, closed_at, units, waiting_since, waiting_reason capacity|no_holder|day_off|inactive, scheduled_start, scheduled_end, effort_days, reservation_id, blocked`. One `open` task per subject (partial unique index).
- **`mos_step_rules`** — the dispatcher's rulebook **[measured]**: `writing` 24 h / cap `writing` 10; `writing_review` 12 h uncapped; `design` 24 h / cap `design` 7; `design_writer_review` 12 h uncapped; `design_review` 12 h uncapped. `scheduling` and `publish_check` have no row → 24 h uncapped.
- **`mos_role_load`** (planner default per role×bucket: writer post 10, montage post 7) and **`mos_user_capacity`** (planner per person×bucket: مريم post 10 / approvals 20, سارة post 7 / approvals 20, مدير النظام post 0, ريان post 4). CI asserts `mos_step_rules.daily_limit = mos_role_load.daily_new_tasks` and that no holder's `daily_slots` exceeds it.
- **`mos_auto_assign_opt_out`** — may act on a role's tasks but never receives them automatically (the operator's account, for writer and montage).
- **`mos_publications`** — one per post×platform; `planned_at` at commit, `scheduled_at` NULL until the publisher takes it; releases fire on `COALESCE(scheduled_at, planned_at)`.
- **Calendar**: `mos_weekend_days() = [5]` → Friday off; `mos_holidays` empty. No working hours anywhere.

**Pinned workflow, `post` v9 [measured]**: `writing` (writer) → `writing_review` (marketing_manager, approval) → `design` (montage) → `design_writer_review` (writer, approval) → `design_review` (marketing_manager, final approval, `auto_meta_ad`) → `scheduling` (writer, after-ready) → `publish_check` (ops_supervisor, after-ready). Each step's `due_days` (0,1,3,1,1,1,1) is used only for a placeholder `due_at` at insert and is immediately overwritten by the dispatcher — dead in practice.

**Units**: `mos_task_units` = non-archived posts in a row (3) or 1.

### In plain terms

Think of four books:

- **The month settings** — the standing rules: post on Sun/Tue/Thu/Sat, 3 posts a batch, 5 ads per project per week, 3 projects, 2,000 per project. September has a few one-offs written next to it: start 22 Sep, run through October, first ad batch only 2 per project, budget 2,667.
- **The plan's diary** (`mos_task_reservations`) — 520 lines, one per task per step: "Wednesday 23, مريم, write the Thursday batch, 3 units". Every line is one day. This is the schedule you approved.
- **The to-do list** (`workflow_role_tasks`) — the tasks people actually see. Each has: who holds it, when they got it, when it's due, or — if nobody has it — why it's waiting.
- **The rulebook** (`mos_step_rules`) — writing: 24 hours, at most 10 units; design: 24 hours, at most 7; the three reviews: 12 hours, no limit.

The same "10 a day / 7 a day" number is stored in **three** places (rulebook, planner default, per-person). They agree today; a test checks that they do.

A batch of 3 posts is one task worth 3 units. An ad creative is one task worth 1.

Every post goes through seven steps: write → manager reviews → design → writer checks the design → manager gives final approval → schedule → confirm it went out. The first five are production. Each step has a "due in N days" number next to it that nothing uses.

---

## 3. The planner

### Technical

**3.1 Geometry.** Weeks Sun–Sat. For 2026-09 (stretched) **[measured]**: first posting day Tue 22 Sep, last Sat 31 Oct; 23 posting days × 3 projects = 69 posts in 23 rows (a/b/c per project + general rows); 6 paid batches anchored on `paid_from` + 7k → Tuesdays 22 Sep, 29 Sep, 6, 13, 20, 27 Oct; 22 Sep = 2 creatives per project (override), the rest 5 → 81 creatives, 18 cycles, 138 publications. `productionStart = max(startFrom, firstPostingDay − lead_time_working_days)`; the lead is a target, not a gate.

**3.2 Refresh-cycle dates** (`refresh.ts`): `refreshOn_k = startsOn + 7k`; `ready_by = one working day before`; `production_start_on = addWorkingDays(ready_by, −(lead−1))` = 10 working days = 12 calendar days before the batch. Rounds 0 and 1 therefore have `production_start_on` (10 Sep, 17 Sep) **before** the confirm date (20 Sep).

**3.3 Backward (as-late-as-possible) scheduling** (`schedule.ts`). From the header: *"Items are placed in publishing order, and within an item stages are placed LAST first, each as late as its deadline allows. Batch 1 therefore takes the slots nearest its own deadlines and later batches are pushed EARLIER into their slack — never the other way round."* `requiredReadyAt = needDay − publishBufferDays(1)`. `computeDeadlines` walks backward; on a **`sameDayChain`** path (the `post` workflow is one) a predecessor may end on the day its successor starts. A **row** uses `sameDaySlots = 3` → every stage is ONE day carrying 3 slots → **all five production stages of a row get the same deadline and ALAP puts them on the same day** (observed: the Thu 24 Sep row has writing 3 and design 3 both on Wed 23). A **paid creative** uses per-step estimates, all 1 day in the live plan. Placement = DFS with backtracking over (person, window), windows tried latest-first, person with most free capacity first; two sound infeasibility proofs (`time_bound`, `capacity_bound`). `bucketOfStep`: approval steps book against `approvals` (cap 20), everything else against `post` (مريم 10, سارة 7).

**3.4 Ledger** (`ledger.ts`): `CapacityBook` keyed `(userId, day, bucket)`; cap = `mos_user_capacity.daily_slots`; `freeOn = 0` on non-working days and leave; existing load from `mos_work_ledger_v` = **open** assigned tasks + un-consumed reservations + manual tasks. Finished tasks drop out. Receipt time never consulted. So the planner's "full" = per calendar day, open work only.

**3.5 Commit**: `month_confirm` → `mos_campaign_plan_commit_month` → per plan `mos_campaign_plan_commit`: campaigns, executions, cycles + slots, rows + 3 shells each, content plans, publications (`planned_at`), reservations. Hash-guarded (`WS409 plan_changed`). Then `month_confirm` calls `mos_plan_start_due()` immediately.

**3.6 The live plan [measured]** (production-step reservations, units per planned day):

| Day | writing | design | For |
|---|---|---|---|
| Mon 21 Sep | 9 | **9** | Tue 22 row (3) + 6 launch creatives |
| Tue 22 | 0 | 0 | — |
| Wed 23 | 3 | 3 | Thu 24 row |
| Thu 24 | 3 | 3 | Sat 26 general row |
| Fri 25 | off | off | |
| Sat 26 | 3 | 7 | writing: Sun 27 row; design: Sun 27 row + **4 يمام بارك 14 round-1** |
| Sun 27 | 8 | 7 | writing: يمام 17 ×3, **يمام بارك 14 ×5**; design: ريا النخيل + يمام 17 round-1 |
| Mon 28 | 10 | 7 | writing: ريا النخيل ×5, يمام 17 ×2, Tue 29 row; design: ريا النخيل ×4 + Tue 29 row |
| Tue 29 | 0 | 0 | — |
| Wed 30 | 3 | 3 | Thu 1 Oct row |

Three observations: (a) every day that is not the eve of a batch is empty; (b) **يمام بارك 14 round-1: design booked Sat 26, writing Sun 27 — design before writing**; `mos_task_rules_audit()` reports **103 `R1_order` violations** — mechanism inside the ALAP search not traced; (c) **Mon 21 carries 9 design units on سارة against her cap of 7** — the ledger's `fits()` should refuse `used + w > cap`; the month was confirmed because the compiler reported nothing unplaced; so either the cap the search saw was not 7 or the booking bypassed the check. Not traced. (A source comment says a row's minimum lead is "5 working days"; the live plan gives it 1 — stale.)

### In plain terms

The planner works **backwards from the day a post goes out**. It puts the last step (final approval) on the day before publishing, the step before that as late as it can, and so on. The code says why: so that the first batch of the month grabs the days nearest its own deadline and no later batch can push it out. That sounds reasonable. It has three effects you can see in this month's plan:

1. **Everything lands on the eve.** Each batch is written *and* designed on the working day before it publishes. Any day that isn't the eve of a batch is empty. Tomorrow (Tue 22) is empty. Tue 29 is empty. Hence "she'd have nothing today or tomorrow" if we simply followed the plan as it is.
2. **Five steps on one day.** For a batch of 3 posts, the plan puts writing, manager review, design, writer's check and final approval all on the same day. The rulebook gives those steps 84 hours between them. Nobody could actually follow that plan; it's a capacity check dressed as a schedule.
3. **It books things it shouldn't.** For the يمام بارك 14 ads of 29 Sep, design is on Saturday and writing on Sunday — designing before the text exists. The audit counts 103 order problems like that. And on Monday 21 it booked **9 design units on سارة, whose limit is 7**. That should have been refused. It wasn't, and I don't yet know why. It is the real reason 3 launch designs are sitting unassigned: the plan asked for 9 on a 7-unit day.

When the month is confirmed, the plan writes 520 diary lines and immediately calls the dispatcher — which is why tasks appeared on Sunday at 13:54, the minute you pressed confirm.

---

## 4. The dispatcher

### Technical

**4.1 `mos_capacity_used(user, key, at)`** = `sum(units)` of tasks with `assigned_at ∈ (at − 24h, at]`, **any status**. No day boundary; finished tasks count until their receipt is 24 h old.

**4.2 `mos_task_dispatch(task, notify)`**: guards → `units := mos_task_units` → rule → inactive subject → `waiting 'inactive'`; non-working day → `'day_off'`; pick a routine holder where `capacity_key IS NULL OR used + units ≤ daily_limit OR used = 0`, least-recently-assigned first; none → `'capacity'`/`'no_holder'`; else `assigned_at := clock_timestamp()`, **`due_at := mos_work_due_at(now, allowance)`** (+ leave). `mos_work_due_at` adds hours skipping Friday.

**4.3 `mos_plan_start_due()`** (cron + confirm), in order:
1. `mos_dispatch_sweep()`: release tasks whose holder lost the role; then dispatch **every** open unassigned task, ordered `mos_subject_publish_at ASC NULLS LAST, mos_subject_publish_rank, waiting_since`.
2. Start every `mos_content_rows` row that has a reservation and no task (and planned singles with a `production_start`), ordered by publish date, **gated only by `mos_role_has_room(first step)`** — same capacity predicate at `clock_timestamp()`. **No date gate.**
3. Mark content plans `in_production`.
4. Refresh cycles with `status='scheduled' AND production_start_on ≤ today`: create the content shells, bind reservations by `content_key`, `workflow_role_path_start` each.

At the 2026-09-20 13:54 confirm **[measured]**: rounds 0 and 1 were past their `production_start_on` → 6 launch + 15 round-1 creatives created at once; the Tue 22 row started; 8 tasks / 10 units handed to مريم (row 3 + 6 launch + 1 round-1); **14 round-1 writing tasks → `waiting 'capacity'`** (their planner day: 27–28 Sep).

**4.4 Lifecycle**: `workflow_role_path_start` inserts the first task (placeholder due), `mos_plan_consume_reservation` finds the matching reservation (`row_id`/`content_id`/`content_key` + `step_key`, `ORDER BY planned_start`), marks it `consumed`, copies `planned_start/end → scheduled_start/end`, then `mos_task_dispatch`. `workflow_advance_role_path` closes the task (`done`, `closed_at = now()`), inserts the next step's task (or a **round+1** task at the latest prior `creates_revision` step on `changes_requested`), consume → dispatch. **It never re-dispatches the closer's own waiting work**: refill happens at the next 10-minute sweep. `mos_plan_repair()` (same cron) marks un-consumed reservations with `planned_end < today` as `stale` and **re-dates them to start today**.

**4.5 Ordering keys**: `mos_subject_publish_at` = row `batch_day` 00:00 Riyadh, or `COALESCE(target_publish_at, need_at)` for singles — **NULL for all 14 waiting paid creatives [measured]**; `mos_subject_publish_rank` = 0 for rows, 1 for paid creatives in an `ads_live_when_ready` month.

**4.6 Visibility** (`api/marketing-os.ts` `readOpenQueueTasks`): my queue = `assignee = me OR (assignee IS NULL AND waiting_since IS NULL AND role_key IN my roles)` — waiting tasks excluded on purpose; «القادم إليك» excludes items whose `owner_role` is my role. The waiting pill shows a reason, never a time.

### In plain terms

The dispatcher has four habits, and each one is a problem on its own:

1. **It counts what she was *given*, not what she still *has*.** Its capacity counter asks "how many units did I hand this person in the last 24 hours?" — finished or not. So a writer who got 10 at 13:54 on Sunday and finished them all by 06:07 on Monday is still "full" until 13:54 Monday. It has no idea a new day started, and no idea she finished.
2. **It hands out anything that's ready, as early as it can.** An organic batch starts the moment she has room, whatever day the plan said. Ad texts start when their 12-day production window opens — and for the 22 Sep and 29 Sep batches that window had opened before you even approved the month, so all 22 ad texts were created at once on Sunday.
3. **It serves the waiting pile before it starts anything new.** Every ten minutes: first give out the tasks already waiting, then, if room is left, start new batches. Next week's ad texts were already waiting; this week's Thursday batch hadn't been started. So next week's work goes first.
4. **The deadline is 24 hours from whenever it happened to hand the task over.** Not from the plan. Hand it over early → early deadline (ad texts planned for 27–28 Sep became "due 22 Sep"). Hand it over late → deadline after the post goes out (the launch designs).

And the waiting pile is **invisible to the person it's waiting for**: her page deliberately hides tasks that are waiting for capacity, and the "coming to you" strip hides her own role. From her chair the desk is empty; from the system's chair 14 tasks are queued behind a counter that says she's full.

---

## 5. What was agreed on 17 Sep

### Technical

From `supabase/migrations/2026-09-17_01_task_step_rules_and_audit.sql` / `_02_task_dispatcher.sql`, verbatim:

> · Capacity decides WHEN work is handed out; each step's deadline counts from the moment that person receives work they can actually do.
> · Writing: 24h allowance, max 10 units per writer in any rolling 24 hours. Design: 24h allowance, max 4 [now 7] units per designer in any rolling 24 hours.
> · Writing review, design check by writer, final approval: 12h, no limit.
> · A row of 3 posts counts as 3 units; a single item counts as 1.
> · Earliest possible: confirmed work starts as soon as capacity allows, in publish-date order. "A post in a day" is a target, not a guarantee.
> · Rolling windows, not calendar days: no working hours exist here.
> · Being allowed to do a role and receiving its routine tasks are separate.
> · Confirmed work starts as soon as the first step's role has room, in publish-date order. **The planner's dates are a forecast; they no longer gate starting.**
> · Someone who loses a role gives its open tasks back; they are re-handed.

Also that day: *late unfinished work does NOT block new hand-outs*; Friday is off (`_09`); rejected in discussion: "whole post same day", "one 24h post timer", "end-of-day deadlines", "company working hours", "per-person weekly availability calendars".

Context: before 17 Sep two placers disagreed (`mos_plan_consume_reservation` copied the planner's named person and an end-of-planned-day deadline; `mos_perf_place_open_task` used "tasks opened today" + 24 h SLA), and the planner's days were visibly wrong (ALAP, design before writing, 14 out-of-order items). The chosen fix routed around the planner's days instead of fixing them.

### In plain terms

On 17 Sep two parts of the system were handing out work and contradicting each other, and the plan's days were visibly wrong. After the GPT review we chose to replace both with one dispatcher whose rule is "capacity decides when". The line that matters was written in the migration in plain words — *"the planner's dates are a forecast; they no longer gate starting"* — but it was described to you as a detail about capacity. What it meant was: the days you approve will not be the days work is handed out. That was never said to you plainly. The fix treated the schedule's bad days by throwing the schedule away.

---

## 6. What happened Sunday–Monday

### Technical [measured]

| Riyadh | Event |
|---|---|
| Sun 20 Sep 13:54 | Confirm. 520 reservations. `mos_plan_start_due`: 22 paid shells + Tue 22 row started; 8 writing tasks / 10 units → مريم (`assigned_at 13:54:10`, `due_at` Mon 13:54); 14 writing tasks waiting (capacity). |
| Sun 18:10 → Mon 06:07 | مريم closed all 8 (last two 05:59:37, 06:07:20). ~20 min per single text once started. |
| Sun 18:40–19:32 | Design tasks reached سارة: 5 tasks / 7 units (Tue 22 row, 3 launch designs, 1 round-1). **3 launch designs (publish Tue 12:00) → waiting.** |
| Mon 06:07 → 14:00 | Writer idle: `mos_capacity_used = 10` until 13:54:10; next sweep ~14:00. ≈ 7 h 47 m, 6 daytime. |
| Mon 10:00–10:23 | Experimental capacity rule applied and reverted (§8.1). |
| Mon 10:54 | سارة: 5 open, 7 units, 0 closed in 24 h. 3 design tasks waiting. Her 3-unit row leaves the window 18:40 → the 3 launch designs reach her ~18:50 Mon, `due_at` ~18:50 Tue — after the 12:00 Tue publish. |
| Mon 14:00 **[inferred]** | 10 of the 14 waiting round-1 texts (planned 27–28 Sep) → مريم, `due_at` Tue 14:00. Thu 24 Sep row cannot start before Tue ~14:00. |

Three counters disagree about "is مريم full?": dispatcher 10/10 (received, rolling); planner ledger 0 (open work); performance desk = tasks *opened* today per role. A stale open design task on archived content has sat on ريان since 5 Sep; nothing closes tasks on inactive subjects.

### In plain terms

You pressed confirm on Sunday at 13:54. The system immediately created all the ad texts for the first two weeks and gave مريم ten units of work: the Tuesday batch plus the launch ad texts, all due Monday 13:54. Fourteen more ad texts — next week's — went into the invisible waiting pile.

She finished everything by 06:07 Monday. Then she sat with an empty desk until 14:00, about eight hours, six of them in daytime, while fourteen tasks waited — because the counter only forgets her Sunday hand-out at 13:54 Monday.

Meanwhile her finished texts turned into design tasks for سارة on Sunday evening: seven units, which is her whole limit, so three launch designs went into the waiting pile too. By Monday morning she had closed none of the seven. Under the current rule those three reach her tonight around 18:50, due tomorrow 18:50 — six hours after the ads were supposed to go live. And if nothing changes, at 14:00 today مريم gets ten of next week's ad texts, due tomorrow 14:00, while this week's Thursday batch can't start before Tuesday afternoon.

---

## 7. The defects

### D1 — Two schedules
**Technical.** The planner writes `planned_start/planned_end` per (subject, step); `mos_plan_start_due` step 2 has no date gate and `mos_task_dispatch` sets `due_at` from receipt. The reservation's dates are copied to the task and never read.
**Plain.** You approve schedule A; the system runs schedule B.

### D2 — The plan is not executable
**Technical.** ALAP + `sameDayChain` + `sameDaySlots` put all five production stages of a row on one day; every non-eve day is empty; 103 `R1_order` violations (design before writing); Mon 21 books 9 design units on a 7-unit person (§3.6 c).
**Plain.** The plan crams a whole batch's five steps into one day, leaves the other days empty, sometimes designs before writing, and on launch day asks one designer for more than her limit. This is why the dispatcher stopped trusting it — but throwing the plan away was the wrong fix; the direction should have been fixed.

### D3 — Inconsistent start triggers, inverted order
**Technical.** Refresh creatives start on `production_start_on` (12-day window); rows start on room; the sweep dispatches existing waiting tasks before the start loop; paid creatives have NULL `publish_at` so they cannot be date-ordered against rows.
**Plain.** Ad texts are created early, organic batches are created when there's room, and whatever is already waiting goes first. So next week's work beats this week's. At 14:00 today the system will hand out the 29 Sep ad texts and hold back the 24 Sep batch.

### D4 — The waiting state, and its invisibility
**Technical.** Overflow of a greedy start policy; `readOpenQueueTasks` excludes `waiting_since IS NOT NULL`; «القادم إليك» excludes own role.
**Plain.** Waiting exists only because the system creates more than fits. And the person it's waiting for can't see it.

### D5 — Deadlines are receipt-relative
**Technical.** `due_at = mos_work_due_at(assigned_at, allowance)`; pinned `due_days` dead.
**Plain.** A deadline is "24 hours after whenever the system happened to give it to you". Early hand-out → early deadline; late hand-out → deadline after the post is out.

### D6 — Capacity = units received in a rolling 24 h, any status
**Technical.** `mos_capacity_used` (§4.1). No day boundary; finished work counts. `mos_work_due_at` skips Friday but the 24-h window doesn't → a Thursday batch is due Saturday yet leaves the window Friday, so Saturday 00:00 can hand out a second full batch on top **[inferred]**.
**Plain.** A fast worker who finishes early is punished with an empty desk until the clock runs out. And Fridays make the counter and the deadlines disagree.

### D7 — Three capacity models
**Technical.** Dispatcher (received, rolling), planner ledger (open per day), performance desk (opened today per role, tasks not units). CI checks only that the limits match.
**Plain.** Ask three parts of the system "is she full?" and get three answers.

### D8 — Smaller
**Technical.** `scheduled_start/end` unused; `mos_plan_repair` re-dates stale reservations to today; `days_to_clear` assumes a daily rate; audit `R6` lacks the `used = 0` exception; no dispatch on close (10-min refill latency); nothing closes tasks on archived content.
**Plain.** Loose ends that will bite whichever way we go.

---

## 8. What the operator wants

### Technical — verbatim, 2026-09-21

1. *"Since the next day started, the tasks should be available. … Since she finished all of her tasks, why can't she have her tasks now?"*
2. *"If we schedule certain tasks … on a certain date, and then that date has finished, then another date came. We just hand out the next tasks. … we don't change anything in terms of when those tasks need to be submitted. Those tasks' 24-hour rules will still stay."*
3. *"Let's say we handed 10 tasks at 10 am on Sunday, and then she finished the tasks at 12 pm on Sunday … As soon as the day finishes, at 12 am on Monday, we will hand her those new tasks. Those new tasks will also have the 24-hour rule."*
4. *"My only goal is that, since she finished her tasks, she should be able to start the next batch of tasks early. … as soon as all tasks are finished, she receives a new batch of tasks without the rule of the due date changing."*
5. *"Don't we already schedule all of the tasks with their date at the beginning of the month? … If we plan everything ahead, why do we need a waiting state?"*
6. *"Will it, by mistake, assign the task which is for after tomorrow before the task that should be done by tomorrow?"* — yes (D3).

Implied model: **the plan is the schedule.** Hand each task out at 00:00 Riyadh on its planned day with its 24-hour allowance; a person who has finished everything may pull the *next planned day's* batch forward, and it keeps its planned deadline; the daily limit is the plan's own (≤10 writing / ≤7 design per day), so planned work never needs a waiting state.

**8.1 Tried and reverted, 21 Sep 10:00–10:23.** A variant of D6 was applied (`mos_capacity_used` counted received units only since the last moment the person had nothing unfinished for that key — "finish the whole batch → next batch at the next sweep"), deadlines unchanged at receipt + 24 h. Verified read-only first (NEW ≤ OLD at 1,908 replay points; one difference, the writer from 06:07). At 10:10 the sweep handed the writer the 10 round-1 texts with `due_at` Tue 22 10:10. The operator rejected it — *"it changed the date"* — because "keeping the due date" means the **planned** date, and receipt-relative deadlines have no planned date to keep. Reverted (function restored, 10 tasks back to waiting, 10 unread notifications deleted). Nothing remains.

### In plain terms

Everything you said today describes the same picture: the plan is real, each task has its day, on that day it's handed out, and if she finishes early she may start the next day's batch early — with the next day's deadline, not a new one. In that picture there is no waiting pile, because the plan already never gives anyone more than they can do in a day.

This morning I built the wrong thing on top of the old rule — "finished everything → next batch, due 24 hours from now" — and the ad texts for 27–28 Sep showed up on her screen due 22 Sep. You were right that it "changed the date": under the old rule there is no planned date to keep. It's fully undone.

---

## 9. Questions for the reviewer

Each with the plain reason it matters.

1. **Planner direction** — as-early-as-possible (forward from `productionStart`, writing first), as-late-as-possible (current), or level-loaded (~4 writing units/day)? *Plain: forward planning keeps her busy from day one but writes October's ads in September; the designer, not the writer, is the bottleneck.*
2. **Same-day chain for rows** — five stages on one day contradicts 24+12+24+12+12 h of allowances. Spread over consecutive working days? What minimum lead does that imply for a month confirmed two days before it starts? *Plain: a batch can't be written, reviewed, designed, checked and approved in one day; the plan should stop pretending it can.*
3. **Dispatcher reads the plan** — hand out at 00:00 Riyadh on `planned_start` (skip Friday), `due_at = planned_end 24:00`. What replaces `mos_role_has_room` / `waiting 'capacity'` for planned work? Is a waiting state needed for anything beyond revisions, transfers, role loss, hand-overbooked plans? *Plain: make the diary the to-do list.*
4. **Pull-forward semantics** — define "finished everything" (same capacity key only? do open reviews block? do tasks on archived content block?); one planned day at a time?; any per-day ceiling once the plan's own ≤10 is the only limit?; strictly next planned day (which is what keeps order safe)? *Plain: "finished early → start tomorrow's" — but exactly what counts as finished, and how far ahead may she go?*
5. **Two plan dates for ads** — the cycle's `production_start_on` (12-day window) vs the reservation's `planned_start` (ALAP). Which is the schedule? Create shells at the window but hand out on `planned_start`? Give paid creatives `target_publish_at = refresh_on` so `publish_at` is never NULL? *Plain: an ad text currently has two "start" dates and no publish date; pick one.*
6. **Off-plan deadlines** — a task handed out late relative to plan: planned deadline (already past) or receipt + allowance? Pulled forward: planned deadline (agreed). A revision (round+1): immediate, receipt + allowance, counted against the day's plan or not? *Plain: what's the due date when the plan has already been missed, or when a text comes back for a rewrite?*
7. **Late confirm** — work planned for a day already past at confirm: hand out immediately (as happened; it saved the launch) or wait for the next 00:00? *Plain: this month was approved on Sunday for Monday's work; what should have happened?*
8. **Residual ordering** — with plan-driven hand-outs D3 vanishes for planned work; what order applies to dynamic work (revisions, sold-out replacements, hand-made tasks)? *Plain: what goes first when something unplanned appears?*
9. **Capacity counters** — should `mos_capacity_used` survive, become "planned + pulled forward today", or go? Restate the CI test to cover window semantics; performance desk to read the same counter. *Plain: one answer to "is she full?"*
10. **Rollout for the live month** — 14 waiting writing tasks (planned 27–28 Sep), 3 waiting launch designs, 22 rows with reservations and no task, refresh rounds 2–5 `scheduled`. Least disruptive switch without re-planning? Note `mos_plan_repair` re-dates any reservation whose window passes. *Plain: how do we move the running month over without breaking it?*
11. **The designer and launch day** — 3 of 6 launch ads miss Tue 12:00 under every rule: one designer, 7 units open, none closed in 24 h, and the plan booked 9 on her for Mon 21 against a cap of 7. Why did the compiler's check pass 9-on-7 (and what else is it passing)? Is 7/day realistic for a one-person lane on a day that needs a row plus a slate? Should the launch have been split across Sun 20 and Mon 21, or the 2-per-project override refused? *Plain: the launch was overbooked on paper before anyone touched it; the system let it through.*

---

## Appendix A — live SQL bodies (verbatim, 2026-09-21)

### `mos_capacity_used`

```sql
CREATE OR REPLACE FUNCTION public.mos_capacity_used(p_user_id uuid, p_capacity_key text, p_at timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(COALESCE(t.units, 1)), 0)
    FROM public.workflow_role_tasks t
    JOIN public.mos_step_rules sr ON sr.step_key = t.step_key
   WHERE t.assignee_user_id = p_user_id
     AND sr.capacity_key = p_capacity_key
     AND t.assigned_at IS NOT NULL
     AND t.assigned_at >  p_at - interval '24 hours'
     AND t.assigned_at <= p_at
$function$
```

### `mos_role_has_room`

```sql
CREATE OR REPLACE FUNCTION public.mos_role_has_room(p_role_key text, p_step_key text, p_units numeric)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.mos_role_routine_holders(p_role_key) h(uid)
      LEFT JOIN public.mos_step_rules sr ON sr.step_key = p_step_key
     WHERE sr.capacity_key IS NULL
        OR public.mos_capacity_used(h.uid, sr.capacity_key, clock_timestamp()) + p_units <= sr.daily_limit
        OR public.mos_capacity_used(h.uid, sr.capacity_key, clock_timestamp()) = 0)
$function$
```

### `mos_role_routine_holders`

```sql
CREATE OR REPLACE FUNCTION public.mos_role_routine_holders(p_role_key text)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT u.id
    FROM public.users u
    JOIN public.roles r ON r.key = 'mos_' || p_role_key
   WHERE u.is_active
     AND jsonb_typeof(COALESCE(u.role_assignments, '[]'::jsonb)) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(u.role_assignments) e
                  WHERE e->>'role_id' = r.id::text)
     AND NOT EXISTS (SELECT 1 FROM public.mos_auto_assign_opt_out o
                      WHERE o.user_id = u.id AND o.role_key = p_role_key)
$function$
```

### `mos_task_units`

```sql
CREATE OR REPLACE FUNCTION public.mos_task_units(p_subject_table text, p_subject_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_subject_table = 'mos_content_rows' THEN
           GREATEST((SELECT count(*) FROM public.mos_content c
                      WHERE c.row_id = p_subject_id AND c.archived_at IS NULL), 1)::numeric
         ELSE 1::numeric END
$function$
```

### `mos_subject_publish_at`

```sql
CREATE OR REPLACE FUNCTION public.mos_subject_publish_at(p_subject_table text, p_subject_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_subject_table = 'mos_content_rows' THEN
           (SELECT (r.batch_day::timestamp AT TIME ZONE 'Asia/Riyadh')
              FROM public.mos_content_rows r WHERE r.id = p_subject_id)
         ELSE
           (SELECT COALESCE(c.target_publish_at, cp.need_at)
              FROM public.mos_content c
              LEFT JOIN public.mos_content_plan cp ON cp.content_id = c.id
             WHERE c.id = p_subject_id)
         END
$function$
```

### `mos_subject_publish_rank`

```sql
CREATE OR REPLACE FUNCTION public.mos_subject_publish_rank(p_subject_table text, p_subject_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_subject_table = 'mos_content_rows' THEN 0
    WHEN EXISTS (
      SELECT 1
        FROM public.mos_content c
        LEFT JOIN public.mos_content_plan cp ON cp.content_id = c.id
        CROSS JOIN public.mos_month_template t
       WHERE c.id = p_subject_id
         AND c.purpose = 'paid'
         AND COALESCE(
               t.month_starts
                 -> to_char(COALESCE(c.target_publish_at, cp.need_at) AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM')
                 ->> 'ads_live_when_ready',
               'false') = 'true'
    ) THEN 1
    ELSE 0
  END
$function$
```

### `mos_is_working_day`

```sql
CREATE OR REPLACE FUNCTION public.mos_is_working_day(p_day date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_day IS NOT NULL
     AND NOT (EXTRACT(dow FROM p_day)::int = ANY (public.mos_weekend_days()))
     AND NOT EXISTS (SELECT 1 FROM public.mos_holidays h WHERE h.day = p_day);
$function$
```

### `mos_work_due_at`

```sql
CREATE OR REPLACE FUNCTION public.mos_work_due_at(p_from timestamp with time zone, p_hours numeric)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_left   interval := p_hours * interval '1 hour';
  v_cursor timestamptz := p_from;
  v_day    date;
  v_eod    timestamptz;
  i        int := 0;
BEGIN
  IF p_from IS NULL OR p_hours IS NULL THEN RETURN NULL; END IF;
  WHILE i < 400 LOOP
    i := i + 1;
    v_day := (v_cursor AT TIME ZONE 'Asia/Riyadh')::date;
    v_eod := ((v_day + 1)::timestamp AT TIME ZONE 'Asia/Riyadh');
    IF public.mos_is_working_day(v_day) THEN
      IF v_cursor + v_left <= v_eod THEN
        RETURN v_cursor + v_left;
      END IF;
      v_left := v_left - (v_eod - v_cursor);
    END IF;
    v_cursor := v_eod;
  END LOOP;
  RAISE EXCEPTION 'MOS:WORK_DUE_UNBOUNDED no working day within 400 days of %', p_from
    USING ERRCODE = 'data_exception';
END $function$
```

### `mos_task_dispatch`

```sql
CREATE OR REPLACE FUNCTION public.mos_task_dispatch(p_task_id uuid, p_notify boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_task    public.workflow_role_tasks%ROWTYPE;
  v_rule    public.mos_step_rules%ROWTYPE;
  v_bucket  text;
  v_units   numeric;
  v_allow   numeric;
  v_now     timestamptz := clock_timestamp();
  v_pick    uuid;
  v_due     timestamptz;
  v_leave_h numeric;
  v_holders int;
  v_label   text;
BEGIN
  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status <> 'open' THEN RETURN 'not_open'; END IF;
  IF v_task.assignee_user_id IS NOT NULL AND v_task.assigned_at IS NOT NULL THEN
    RETURN 'already_assigned';
  END IF;

  IF v_task.subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT % (task %)', v_task.subject_table, p_task_id
      USING ERRCODE = 'feature_not_supported';
  END IF;
  IF v_task.subject_table = 'mos_content'
     AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = v_task.subject_id) THEN
    RAISE EXCEPTION 'MOS:SUBJECT_NOT_FOUND mos_content % (task %)', v_task.subject_id, p_task_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_task.subject_table = 'mos_content_rows'
     AND NOT EXISTS (SELECT 1 FROM public.mos_content_rows r WHERE r.id = v_task.subject_id) THEN
    RAISE EXCEPTION 'MOS:SUBJECT_NOT_FOUND mos_content_rows % (task %)', v_task.subject_id, p_task_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.key = 'mos_' || v_task.role_key) THEN
    RAISE EXCEPTION 'MOS:ROLE_NOT_FOUND mos_% (task %)', v_task.role_key, p_task_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_bucket := public.mos_subject_bucket(v_task.subject_table, v_task.subject_id);
  v_units  := public.mos_task_units(v_task.subject_table, v_task.subject_id);
  SELECT * INTO v_rule FROM public.mos_step_rules WHERE step_key = v_task.step_key;
  v_allow := COALESCE(v_rule.allowance_hours, 24);

  IF public.mos_subject_inactive(v_task.subject_table, v_task.subject_id) THEN
    UPDATE public.workflow_role_tasks
       SET bucket = v_bucket, units = v_units, assignee_user_id = NULL, assigned_at = NULL,
           due_at = NULL, waiting_since = COALESCE(waiting_since, v_now), waiting_reason = 'inactive'
     WHERE id = p_task_id;
    RETURN 'waiting';
  END IF;

  IF NOT public.mos_is_working_day((v_now AT TIME ZONE 'Asia/Riyadh')::date) THEN
    UPDATE public.workflow_role_tasks
       SET bucket = v_bucket, units = v_units, assignee_user_id = NULL, assigned_at = NULL,
           due_at = NULL, waiting_since = COALESCE(waiting_since, v_now), waiting_reason = 'day_off'
     WHERE id = p_task_id;
    RETURN 'waiting';
  END IF;

  SELECT h.uid INTO v_pick
    FROM public.mos_role_routine_holders(v_task.role_key) h(uid)
   WHERE v_rule.capacity_key IS NULL
      OR public.mos_capacity_used(h.uid, v_rule.capacity_key, v_now) + v_units <= v_rule.daily_limit
      OR public.mos_capacity_used(h.uid, v_rule.capacity_key, v_now) = 0
   ORDER BY (SELECT max(t.assigned_at) FROM public.workflow_role_tasks t
              WHERE t.assignee_user_id = h.uid AND t.role_key = v_task.role_key) ASC NULLS FIRST,
            h.uid
   LIMIT 1;

  IF v_pick IS NULL THEN
    SELECT count(*) INTO v_holders FROM public.mos_role_routine_holders(v_task.role_key);
    UPDATE public.workflow_role_tasks
       SET bucket = v_bucket, units = v_units, assignee_user_id = NULL, assigned_at = NULL,
           due_at = NULL, waiting_since = COALESCE(waiting_since, v_now),
           waiting_reason = CASE WHEN v_holders = 0 THEN 'no_holder' ELSE 'capacity' END
     WHERE id = p_task_id;
    IF v_holders = 0 THEN
      RAISE WARNING 'MOS:TASK_WAITING_NO_HOLDER % (role=%) — no active holder takes routine % work',
        p_task_id, v_task.role_key, v_task.role_key;
    END IF;
    RETURN 'waiting';
  END IF;

  v_due := public.mos_work_due_at(v_now, v_allow);
  SELECT COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(l.end_at, v_due) - GREATEST(l.start_at, v_now))) / 3600.0), 0)
    INTO v_leave_h
    FROM public.mos_leaves l
   WHERE l.user_id = v_pick AND l.status = 'approved'
     AND l.start_at < v_due AND l.end_at > v_now;
  IF v_leave_h > 0 THEN v_due := v_due + (v_leave_h * interval '1 hour'); END IF;

  UPDATE public.workflow_role_tasks
     SET bucket = v_bucket, units = v_units, assignee_user_id = v_pick, assigned_at = v_now,
         due_at = v_due, waiting_since = NULL, waiting_reason = NULL
   WHERE id = p_task_id;

  IF p_notify THEN
    PERFORM public.mos_task_notify_assigned(p_task_id);
  END IF;

  RETURN 'assigned';
END $function$
```

### `mos_dispatch_sweep`

```sql
CREATE OR REPLACE FUNCTION public.mos_dispatch_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r          record;
  v_released int := 0;
  v_assigned int := 0;
  v_waiting  int := 0;
  v_out      text;
BEGIN
  PERFORM public.mos_ledger_lock();

  FOR r IN
    SELECT t.id FROM public.workflow_role_tasks t
     WHERE t.status = 'open' AND t.assignee_user_id IS NOT NULL
       AND t.subject_table IN ('mos_content', 'mos_content_rows')
       AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
       AND NOT public.mos_user_holds_role(t.assignee_user_id, t.role_key)
  LOOP
    UPDATE public.workflow_role_tasks
       SET assignee_user_id = NULL, assigned_at = NULL, due_at = NULL
     WHERE id = r.id;
    v_released := v_released + 1;
  END LOOP;

  FOR r IN
    SELECT t.id FROM public.workflow_role_tasks t
     WHERE t.status = 'open' AND t.assignee_user_id IS NULL
       AND t.subject_table IN ('mos_content', 'mos_content_rows')
       AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
     ORDER BY public.mos_subject_publish_at(t.subject_table, t.subject_id) ASC NULLS LAST,
              public.mos_subject_publish_rank(t.subject_table, t.subject_id) ASC,
              COALESCE(t.waiting_since, t.created_at), t.id
  LOOP
    v_out := public.mos_task_dispatch(r.id, true);
    IF v_out = 'assigned' THEN v_assigned := v_assigned + 1;
    ELSIF v_out = 'waiting' THEN v_waiting := v_waiting + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('released', v_released, 'assigned', v_assigned, 'waiting', v_waiting);
END $function$
```

### `mos_plan_start_due`

```sql
CREATE OR REPLACE FUNCTION public.mos_plan_start_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today   date := public.mos_perf_today();
  r         record;
  s         record;
  v_started int := 0;
  v_rows    int := 0;
  v_shells  int := 0;
  v_cycles  int := 0;
  v_ct      uuid;
  v_ver     uuid;
  v_new     uuid;
  v_first   jsonb;
  v_sweep   jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();

  v_sweep := public.mos_dispatch_sweep();

  FOR r IN
    SELECT q.st, q.id, q.ver
      FROM (
        SELECT 'mos_content_rows'::text AS st, rw.id, rw.workflow_version_id AS ver
          FROM public.mos_content_rows rw
         WHERE EXISTS (SELECT 1 FROM public.mos_task_reservations tr
                        WHERE tr.row_id = rw.id AND tr.status IN ('reserved','stale'))
           AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                            WHERE t.subject_table = 'mos_content_rows' AND t.subject_id = rw.id)
        UNION ALL
        SELECT 'mos_content', c.id, c.workflow_version_id
          FROM public.mos_content_plan cp
          JOIN public.mos_content c ON c.id = cp.content_id AND c.row_id IS NULL
         WHERE cp.status = 'planned'
           AND cp.production_start IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                            WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
      ) q
     WHERE NOT public.mos_subject_inactive(q.st, q.id)
       AND public.mos_is_working_day(v_today)
     ORDER BY public.mos_subject_publish_at(q.st, q.id) ASC NULLS LAST, public.mos_subject_publish_rank(q.st, q.id) ASC, q.id
  LOOP
    SELECT v.definition->'metadata'->'steps'->0 INTO v_first
      FROM public.workflow_versions v WHERE v.id = r.ver;
    IF v_first IS NULL THEN
      RAISE WARNING 'MOS:START_NO_WORKFLOW % % has no pinned workflow steps', r.st, r.id;
      CONTINUE;
    END IF;
    IF NOT public.mos_role_has_room(v_first->>'role_key', v_first->>'key',
                                    public.mos_task_units(r.st, r.id)) THEN
      CONTINUE;
    END IF;

    PERFORM public.mos_task_notify_assigned(
      ((public.workflow_role_path_start(r.st, r.id)) ->> 'opened_task_id')::uuid);
    IF r.st = 'mos_content_rows' THEN
      UPDATE public.mos_content_plan cp
         SET status = 'in_production'
       WHERE cp.status = 'planned'
         AND cp.content_id IN (SELECT c.id FROM public.mos_content c WHERE c.row_id = r.id);
      v_rows := v_rows + 1;
    ELSE
      UPDATE public.mos_content_plan SET status = 'in_production' WHERE content_id = r.id;
    END IF;
    v_started := v_started + 1;
  END LOOP;

  UPDATE public.mos_content_plan cp
     SET status = 'in_production'
   WHERE cp.status = 'planned'
     AND (EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                   WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
       OR EXISTS (SELECT 1 FROM public.mos_content c
                    JOIN public.workflow_role_tasks t
                      ON t.subject_table = 'mos_content_rows' AND t.subject_id = c.row_id
                   WHERE c.id = cp.content_id));

  FOR r IN
    SELECT cy.id AS cycle_id, cy.execution_id, cy.round, ex.campaign_id,
           cm.name AS campaign_name, cm.project_id
      FROM public.mos_refresh_cycles cy
      JOIN public.mos_campaign_executions ex ON ex.id = cy.execution_id
      LEFT JOIN public.mos_campaigns cm ON cm.id = ex.campaign_id
     WHERE cy.status = 'scheduled'
       AND cy.production_start_on IS NOT NULL
       AND cy.production_start_on <= v_today
     ORDER BY cy.production_start_on, cy.round
  LOOP
    SELECT ct.id,
           (SELECT wv.id FROM public.workflow_versions wv
             WHERE wv.workflow_id = ct.workflow_id ORDER BY wv.version_no DESC LIMIT 1)
      INTO v_ct, v_ver
      FROM public.mos_content_types ct WHERE ct.key = 'post' AND ct.archived_at IS NULL;

    IF v_ct IS NOT NULL THEN
      FOR s IN
        SELECT sl.id, sl.slot_index, sl.kind, sl.content_key
          FROM public.mos_creative_slots sl
         WHERE sl.cycle_id = r.cycle_id AND sl.content_id IS NULL
           AND sl.status = 'reserved'
         ORDER BY sl.slot_index
      LOOP
        INSERT INTO public.mos_content
          (content_type_id, workflow_id, workflow_version_id, title, project_id, project_ids,
           campaign_id, purpose)
        SELECT v_ct, ct.workflow_id, v_ver,
               COALESCE(r.campaign_name, 'حملة') || ' — تحديث ' || r.round || '/' || (s.slot_index + 1),
               r.project_id,
               CASE WHEN r.project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(r.project_id) END,
               r.campaign_id, 'paid'
          FROM public.mos_content_types ct WHERE ct.id = v_ct
        RETURNING id INTO v_new;

        UPDATE public.mos_creative_slots
           SET content_id = v_new, status = 'producing' WHERE id = s.id;

        UPDATE public.mos_task_reservations
           SET content_id = v_new
         WHERE content_id IS NULL AND row_id IS NULL AND cycle_id = r.cycle_id
           AND content_key IS NOT NULL AND content_key = s.content_key;

        IF NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                        WHERE t.subject_table = 'mos_content' AND t.subject_id = v_new) THEN
          PERFORM public.workflow_role_path_start('mos_content', v_new);
          v_started := v_started + 1;
        END IF;
        v_shells := v_shells + 1;
      END LOOP;
    END IF;

    UPDATE public.mos_refresh_cycles SET status = 'producing' WHERE id = r.cycle_id AND status = 'scheduled';
    v_cycles := v_cycles + 1;
  END LOOP;

  RETURN jsonb_build_object('started', v_started, 'rows_started', v_rows,
                            'shells_created', v_shells, 'cycles_started', v_cycles,
                            'dispatch', v_sweep);
END $function$
```

### `mos_plan_consume_reservation`

```sql
CREATE OR REPLACE FUNCTION public.mos_plan_consume_reservation(p_task_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_task   public.workflow_role_tasks%ROWTYPE;
  v_res    public.mos_task_reservations%ROWTYPE;
  v_key    text;
  v_is_row boolean;
BEGIN
  PERFORM public.mos_ledger_lock();

  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status <> 'open'
     OR v_task.subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RETURN NULL;
  END IF;
  IF v_task.reservation_id IS NOT NULL THEN
    RETURN v_task.reservation_id;
  END IF;

  v_is_row := v_task.subject_table = 'mos_content_rows';

  IF v_is_row THEN
    SELECT r.row_key INTO v_key FROM public.mos_content_rows r WHERE r.id = v_task.subject_id;
  ELSE
    SELECT cp.content_key INTO v_key FROM public.mos_content_plan cp WHERE cp.content_id = v_task.subject_id;
  END IF;

  SELECT * INTO v_res
    FROM public.mos_task_reservations r
   WHERE r.status IN ('reserved','stale')
     AND r.step_key = v_task.step_key
     AND (CASE WHEN v_is_row THEN
                 r.row_id = v_task.subject_id
                 OR (r.row_id IS NULL AND r.content_id IS NULL
                     AND v_key IS NOT NULL AND r.content_key = v_key)
               ELSE
                 r.content_id = v_task.subject_id
                 OR (r.content_id IS NULL AND r.row_id IS NULL
                     AND v_key IS NOT NULL AND r.content_key = v_key)
          END)
   ORDER BY (CASE WHEN v_is_row THEN r.row_id IS NOT NULL
                  ELSE r.content_id IS NOT NULL END) DESC,
            r.planned_start
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.mos_task_reservations
     SET status           = 'consumed',
         consumed_task_id = v_task.id,
         content_id       = CASE WHEN v_is_row THEN content_id ELSE v_task.subject_id END,
         row_id           = CASE WHEN v_is_row THEN v_task.subject_id ELSE row_id END,
         updated_at       = now()
   WHERE id = v_res.id;

  UPDATE public.workflow_role_tasks
     SET scheduled_start = v_res.planned_start,
         scheduled_end   = v_res.planned_end,
         effort_days     = GREATEST(v_res.weight, 0.5),
         reservation_id  = v_res.id,
         bucket          = COALESCE(bucket, v_res.bucket)
   WHERE id = v_task.id;

  PERFORM public.mos_task_dispatch(v_task.id, false);

  RETURN v_res.id;
END $function$
```

### `workflow_role_path_start`

```sql
CREATE OR REPLACE FUNCTION public.workflow_role_path_start(p_subject_table text, p_subject_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_steps  jsonb;
  v_first  jsonb;
  v_ver    uuid;
  v_new_id uuid;
  v_found  boolean;
BEGIN
  -- (a) THE LEDGER LOCK, FIRST STATEMENT.
  PERFORM public.mos_ledger_lock();

  IF p_subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- The creation right, not the assignment right.
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('write_content') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM public.workflow_role_tasks
              WHERE subject_table = p_subject_table
                AND subject_id = p_subject_id AND status = 'open') THEN
    RETURN jsonb_build_object('opened_task_id', NULL, 'already_open', true);
  END IF;

  IF p_subject_table = 'mos_content_rows' THEN
    SELECT true, r.workflow_version_id, v.definition->'metadata'->'steps'
      INTO v_found, v_ver, v_steps
      FROM public.mos_content_rows r
      LEFT JOIN public.workflow_versions v ON v.id = r.workflow_version_id
     WHERE r.id = p_subject_id;
  ELSE
    SELECT true, c.workflow_version_id, v.definition->'metadata'->'steps'
      INTO v_found, v_ver, v_steps
      FROM public.mos_content c
      LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
     WHERE c.id = p_subject_id;
  END IF;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'MOS:SUBJECT_NOT_FOUND % %', p_subject_table, p_subject_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_steps IS NULL OR jsonb_typeof(v_steps) <> 'array'
     OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object('opened_task_id', NULL, 'already_open', false);
  END IF;

  v_first := v_steps -> 0;
  INSERT INTO public.workflow_role_tasks
    (subject_table, subject_id, workflow_version_id, step_key, role_key, round, due_at)
  VALUES
    (p_subject_table, p_subject_id, v_ver,
     v_first->>'key', v_first->>'role_key', 1,
     now() + COALESCE((v_first->>'due_days')::int, 2) * interval '1 day')
  RETURNING id INTO v_new_id;

  -- (b) THE SWAP, before the legacy capacity-aware placer (2026-08-28).
  IF public.mos_plan_consume_reservation(v_new_id) IS NULL THEN
    PERFORM public.mos_perf_place_open_task(v_new_id);
  END IF;

  RETURN jsonb_build_object('opened_task_id', v_new_id, 'already_open', false);
END $function$
```

### `workflow_advance_role_path`

```sql
CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(p_subject_table text, p_subject_id uuid, p_result text, p_note text DEFAULT NULL::text, p_targets jsonb DEFAULT '[]'::jsonb, p_finish boolean DEFAULT false, p_return_to text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_task      public.workflow_role_tasks%ROWTYPE;
  v_roles     text[];
  v_steps     jsonb;
  v_version   uuid;
  v_idx       integer;
  v_next      jsonb;
  v_new_id    uuid;
  v_round     integer;
  v_closed_by uuid;
  v_step      jsonb;
  v_missing   text[];
  v_ret_idx   integer;
  v_is_row    boolean;
  v_members   integer;
  v_m         record;
  v_m_missing text[];
BEGIN
  -- (a) THE LEDGER LOCK, FIRST STATEMENT.
  PERFORM public.mos_ledger_lock();

  IF p_subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;
  v_is_row := p_subject_table = 'mos_content_rows';

  SELECT * INTO v_task
    FROM public.workflow_role_tasks
   WHERE subject_table = p_subject_table
     AND subject_id    = p_subject_id
     AND status        = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:NO_OPEN_TASK';
  END IF;

  v_roles := public.wassell_mos_roles(auth.uid());
  IF NOT (
       'administrator'     = ANY(v_roles)
    OR 'marketing_manager' = ANY(v_roles)
    OR v_task.role_key     = ANY(v_roles)
    OR COALESCE(v_task.assignee_user_id = public.wassell_app_user_id(auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'MOS:NOT_YOUR_TASK' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_result NOT IN ('submitted','approved','changes_requested') THEN
    RAISE EXCEPTION 'MOS:BAD_RESULT %', p_result;
  END IF;
  IF p_result = 'changes_requested'
     AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;

  -- The PINNED step list, off whichever subject holds it.
  IF v_is_row THEN
    SELECT r.workflow_version_id, v.definition->'metadata'->'steps'
      INTO v_version, v_steps
      FROM public.mos_content_rows r
      LEFT JOIN public.workflow_versions v ON v.id = r.workflow_version_id
     WHERE r.id = p_subject_id;

    SELECT count(*) INTO v_members
      FROM public.mos_content c WHERE c.row_id = p_subject_id;
    IF v_members = 0 THEN
      RAISE EXCEPTION 'MOS:ROW_EMPTY % (no posts belong to this row)', p_subject_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    SELECT c.workflow_version_id, v.definition->'metadata'->'steps'
      INTO v_version, v_steps
      FROM public.mos_content c
      LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
     WHERE c.id = p_subject_id;
  END IF;

  -- (c) server-enforced requirements, read from the PINNED step, evaluated for
  -- EVERY member of the subject (one post, or the row's three).
  IF p_result IN ('submitted','approved') AND v_steps IS NOT NULL
     AND jsonb_typeof(v_steps) = 'array' THEN
    SELECT e.elem INTO v_step
      FROM jsonb_array_elements(v_steps) e(elem)
     WHERE e.elem ->> 'key' = v_task.step_key
     LIMIT 1;

    v_missing := ARRAY[]::text[];

    FOR v_m IN
      SELECT c.id, COALESCE(NULLIF(btrim(c.ref), ''), NULLIF(btrim(c.title), ''), c.id::text) AS label
        FROM public.mos_content c
       WHERE (v_is_row AND c.row_id = p_subject_id)
          OR (NOT v_is_row AND c.id = p_subject_id)
       ORDER BY c.row_order NULLS LAST, c.created_at
    LOOP
      v_m_missing := ARRAY[]::text[];

      SELECT COALESCE(v_m_missing || array_agg(q.k), v_m_missing) INTO v_m_missing
        FROM (
          SELECT COALESCE(f ->> 'key', f #>> '{}') AS k
            FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f) q
       WHERE q.k IS NOT NULL
         AND NULLIF(btrim(COALESCE(
               (SELECT c.data ->> q.k FROM public.mos_content c WHERE c.id = v_m.id), '')), '') IS NULL;

      SELECT COALESCE(v_m_missing || array_agg(q.k), v_m_missing) INTO v_m_missing
        FROM (
          SELECT COALESCE(f ->> 'role', f #>> '{}') AS k
            FROM jsonb_array_elements(COALESCE(v_step -> 'required_files', '[]'::jsonb)) f) q
       WHERE q.k IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.mos_asset_links al
                          WHERE al.content_id = v_m.id AND al.role = q.k
                            AND al.superseded_at IS NULL);

      IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f
                  WHERE COALESCE(f ->> 'key', f #>> '{}') = 'caption')
         AND NOT EXISTS (SELECT 1 FROM public.mos_content c
                          WHERE c.id = v_m.id
                            AND c.data ->> 'caption_confirmed_text' IS NOT NULL
                            AND c.data ->> 'caption_confirmed_text' = c.data ->> 'caption') THEN
        v_m_missing := v_m_missing || 'caption_confirmed'::text;
      END IF;

      IF COALESCE(array_length(v_m_missing, 1), 0) > 0 THEN
        IF v_is_row THEN
          SELECT COALESCE(v_missing || array_agg(v_m.label || ' — ' || u.k ORDER BY u.ord), v_missing)
            INTO v_missing FROM unnest(v_m_missing) WITH ORDINALITY AS u(k, ord);
        ELSE
          v_missing := v_missing || v_m_missing;
        END IF;
      END IF;
    END LOOP;

    IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
      RAISE EXCEPTION 'MOS:REQUIREMENTS_MISSING %', array_to_string(v_missing, ', ')
        USING ERRCODE = 'invalid_parameter_value',
              DETAIL  = to_jsonb(v_missing)::text;
    END IF;
  END IF;

  v_closed_by := public.wassell_app_user_id(auth.uid());

  UPDATE public.workflow_role_tasks
     SET status           = 'done',
         result           = p_result,
         note             = p_note,
         revision_targets = COALESCE(p_targets, '[]'::jsonb),
         closed_at        = now(),
         closed_by_user_id = v_closed_by
   WHERE id = v_task.id;

  -- (e) bind exactly what was approved — ONE approval row PER MEMBER.
  IF p_result = 'approved' THEN
    INSERT INTO public.mos_content_approvals
      (content_id, step_key, round, approved_by_user_id, approved_at,
       writing_hash, design_hash, caption_hash, package_hash)
    SELECT c.id, v_task.step_key, v_task.round, v_closed_by, now(),
           public.mos_content_writing_hash(c.id),
           public.mos_content_design_hash(c.id),
           public.mos_caption_hash(c.data ->> 'caption'),
           public.mos_content_package_hash(c.id)
      FROM public.mos_content c
     WHERE (v_is_row AND c.row_id = p_subject_id)
        OR (NOT v_is_row AND c.id = p_subject_id)
    ON CONFLICT (content_id, step_key, round) DO UPDATE
      SET approved_by_user_id = EXCLUDED.approved_by_user_id,
          approved_at         = EXCLUDED.approved_at,
          writing_hash        = EXCLUDED.writing_hash,
          design_hash         = EXCLUDED.design_hash,
          caption_hash        = EXCLUDED.caption_hash,
          package_hash        = EXCLUDED.package_hash;

    IF COALESCE((v_step ->> 'auto_meta_ad')::boolean, false) THEN
      UPDATE public.mos_content
         SET data = CASE WHEN data ? 'revision'
                         THEN jsonb_set(data, '{revision,closed_at}', to_jsonb(now()))
                         ELSE data END
       WHERE (v_is_row AND row_id = p_subject_id)
          OR (NOT v_is_row AND id = p_subject_id);
    END IF;
  END IF;

  IF v_steps IS NULL
     OR jsonb_typeof(v_steps) <> 'array'
     OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  IF p_finish AND p_result = 'approved' THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  SELECT ord - 1 INTO v_idx
    FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
   WHERE elem->>'key' = v_task.step_key;

  IF p_result = 'changes_requested' THEN
    IF NULLIF(btrim(COALESCE(p_return_to, '')), '') IS NOT NULL THEN
      SELECT ord - 1, elem INTO v_ret_idx, v_next
        FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
       WHERE elem->>'key' = p_return_to
       LIMIT 1;
      IF v_next IS NULL THEN
        RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (not a step in this workflow)', p_return_to
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF v_ret_idx >= COALESCE(v_idx, 0) THEN
        RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (not a prior step)', p_return_to
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF NOT COALESCE((v_next->>'creates_revision')::boolean, false) THEN
        RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (does not create a revision)', p_return_to
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    ELSE
      SELECT elem INTO v_next
        FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
       WHERE ord - 1 < COALESCE(v_idx, 0)
         AND COALESCE((elem->>'creates_revision')::boolean, false)
       ORDER BY ord DESC
       LIMIT 1;
      IF v_next IS NULL THEN
        v_next := v_steps -> 0;
      END IF;
    END IF;
    v_round := v_task.round + 1;
  ELSE
    IF v_idx IS NOT NULL AND v_idx < jsonb_array_length(v_steps) - 1 THEN
      v_next := v_steps -> (v_idx + 1);
    ELSE
      v_next := NULL;
    END IF;
    v_round := v_task.round;
  END IF;

  IF v_next IS NOT NULL THEN
    INSERT INTO public.workflow_role_tasks
      (subject_table, subject_id, workflow_version_id, step_key, role_key,
       round, due_at)
    VALUES
      (p_subject_table, p_subject_id, v_version,
       v_next->>'key', v_next->>'role_key', v_round,
       now() + COALESCE((v_next->>'due_days')::int, 2) * interval '1 day')
    RETURNING id INTO v_new_id;

    -- (b) THE SWAP, before the legacy placer.
    IF public.mos_plan_consume_reservation(v_new_id) IS NULL THEN
      PERFORM public.mos_perf_place_open_task(v_new_id);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'closed_task_id', v_task.id,
    'opened_task_id', v_new_id,
    'next_step_key',  CASE WHEN v_next IS NULL THEN NULL ELSE v_next->>'key' END,
    'round',          v_round,
    'done',           v_next IS NULL);
END $function$
```

### `mos_plan_repair`

```sql
CREATE OR REPLACE FUNCTION public.mos_plan_repair(p_campaign_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today    date := public.mos_perf_today();
  v_staled   int := 0;
  v_redated  int := 0;
  v_at_risk  int := 0;
  v_late     int := 0;
  v_batches  int := 0;
  r          record;
  v_span     int;
  v_start    date;
  v_end      date;
BEGIN
  PERFORM public.mos_ledger_lock();

  UPDATE public.mos_task_reservations res
     SET status = 'stale', updated_at = now()
   WHERE res.status = 'reserved'
     AND res.planned_end < v_today
     AND res.consumed_task_id IS NULL
     AND (p_campaign_id IS NULL
          OR EXISTS (SELECT 1 FROM public.mos_content_plan cp
                      WHERE cp.content_id = res.content_id AND cp.campaign_id = p_campaign_id));
  GET DIAGNOSTICS v_staled = ROW_COUNT;

  FOR r IN
    SELECT res.id, res.weight
      FROM public.mos_task_reservations res
     WHERE res.status = 'stale'
       AND (p_campaign_id IS NULL
            OR EXISTS (SELECT 1 FROM public.mos_content_plan cp
                        WHERE cp.content_id = res.content_id AND cp.campaign_id = p_campaign_id))
  LOOP
    -- the span is the EFFORT in working days, not the calendar width of the
    -- old window (a window can be wider than its effort after a repair).
    v_span := GREATEST(ceil(r.weight)::int, 1);
    SELECT min(d), max(d) INTO v_start, v_end
      FROM public.mos_working_days_from(v_today, v_span) d;
    UPDATE public.mos_task_reservations
       SET planned_start = v_start, planned_end = v_end, status = 'reserved', updated_at = now()
     WHERE id = r.id;
    v_redated := v_redated + 1;
  END LOOP;

  UPDATE public.mos_content_plan cp
     SET status = 'late'
   WHERE cp.status IN ('planned','in_production','at_risk')
     AND cp.required_ready_at IS NOT NULL AND cp.required_ready_at < v_today
     AND (p_campaign_id IS NULL OR cp.campaign_id = p_campaign_id);
  GET DIAGNOSTICS v_late = ROW_COUNT;

  UPDATE public.mos_content_plan cp
     SET status = 'at_risk'
   WHERE cp.status IN ('planned','in_production')
     AND (p_campaign_id IS NULL OR cp.campaign_id = p_campaign_id)
     AND EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                  WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id
                    AND t.status = 'open'
                    AND (cp.stage_deadlines ->> t.step_key)::date IS NOT NULL
                    AND (cp.stage_deadlines ->> t.step_key)::date < v_today);
  GET DIAGNOSTICS v_at_risk = ROW_COUNT;

  UPDATE public.mos_publish_batches b
     SET status = v.risk
    FROM public.mos_publish_batch_v v
   WHERE v.id = b.id AND b.status <> v.risk
     AND v.risk IN ('planned','on_track','at_risk','late','done')
     AND (p_campaign_id IS NULL OR b.campaign_id = p_campaign_id);
  GET DIAGNOSTICS v_batches = ROW_COUNT;

  RETURN jsonb_build_object('staled', v_staled, 'redated', v_redated,
                            'at_risk', v_at_risk, 'late', v_late, 'batches', v_batches);
END $function$
```

### `mos_perf_place_open_task`

```sql
CREATE OR REPLACE FUNCTION public.mos_perf_place_open_task(p_task_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.mos_task_dispatch(p_task_id, false);
END $function$
```

### `mos_campaign_plan_commit_month`

```sql
CREATE OR REPLACE FUNCTION public.mos_campaign_plan_commit_month(p_plans jsonb, p_expected_hash text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hash text;
  v_out  jsonb := '[]'::jsonb;
  v_res  jsonb;
  e      jsonb;
  v_n    int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('approve_plan') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM public.mos_ledger_lock();

  v_hash := public.mos_workload_snapshot_hash();
  IF p_expected_hash IS NOT NULL AND p_expected_hash <> v_hash THEN
    RAISE EXCEPTION 'plan_changed'
      USING ERRCODE = 'WS409',
            DETAIL  = jsonb_build_object('expected', p_expected_hash, 'actual', v_hash)::text,
            HINT    = 'the workload moved since the preview — re-plan the month';
  END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_plans, '[]'::jsonb)) LOOP
    IF NULLIF(e ->> 'plan_id', '') IS NULL THEN
      RAISE EXCEPTION 'MOS:PLAN_ID_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_res := public.mos_campaign_plan_commit(
      (e ->> 'plan_id')::uuid,
      COALESCE(e -> 'reservations', '[]'::jsonb),
      NULL,                                   -- gated once, above. See the note.
      COALESCE(e -> 'materialise', '{}'::jsonb),
      p_actor);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'plan_id', e ->> 'plan_id', 'result', v_res));
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'plans', v_n,
                            'snapshot_hash', v_hash, 'committed', v_out);
END $function$
```

### `mos_capacity_backlog`

```sql
CREATE OR REPLACE FUNCTION public.mos_capacity_backlog()
 RETURNS TABLE(capacity_key text, role_key text, waiting_tasks integer, waiting_units numeric, daily_limit integer, holders integer, days_to_clear numeric, oldest_waiting_at timestamp with time zone, oldest_waiting_hours numeric, next_publish_at timestamp with time zone, next_publish_in_hours numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH waiting AS (
    SELECT
      sr.capacity_key,
      t.role_key,
      COALESCE(t.units, public.mos_task_units(t.subject_table, t.subject_id), 1) AS units,
      COALESCE(t.waiting_since, t.created_at) AS since,
      public.mos_subject_publish_at(t.subject_table, t.subject_id) AS publish_at,
      sr.daily_limit
    FROM public.workflow_role_tasks t
    JOIN public.mos_step_rules sr ON sr.step_key = t.step_key
   WHERE t.status = 'open'
     AND t.assignee_user_id IS NULL
     AND t.waiting_since IS NOT NULL
     AND t.waiting_reason = 'capacity'
     AND sr.capacity_key IS NOT NULL
     AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
  ),
  holders AS (
    SELECT sr.capacity_key, w.role_key, count(*)::int AS n
      FROM (SELECT DISTINCT capacity_key, role_key FROM waiting) w
      JOIN public.mos_step_rules sr ON sr.capacity_key = w.capacity_key
     CROSS JOIN LATERAL public.mos_role_routine_holders(w.role_key) h(uid)
     GROUP BY 1, 2
  )
  SELECT
    w.capacity_key,
    w.role_key,
    count(*)::int                                            AS waiting_tasks,
    sum(w.units)                                             AS waiting_units,
    max(w.daily_limit)                                       AS daily_limit,
    COALESCE(max(h.n), 0)                                    AS holders,
    -- Working days to clear at the current rate. NULL — not zero — when there
    -- is nobody holding the role: "it never clears" is not "it clears today".
    CASE WHEN COALESCE(max(h.n), 0) > 0 AND max(w.daily_limit) > 0
         THEN round(sum(w.units) / (COALESCE(max(h.n), 0) * max(w.daily_limit))::numeric, 1)
    END                                                      AS days_to_clear,
    min(w.since)                                             AS oldest_waiting_at,
    round(EXTRACT(EPOCH FROM (now() - min(w.since))) / 3600.0, 1) AS oldest_waiting_hours,
    min(w.publish_at)                                        AS next_publish_at,
    round(EXTRACT(EPOCH FROM (min(w.publish_at) - now())) / 3600.0, 1) AS next_publish_in_hours
  FROM waiting w
  LEFT JOIN holders h ON h.capacity_key = w.capacity_key AND h.role_key = w.role_key
  GROUP BY w.capacity_key, w.role_key
  ORDER BY sum(w.units) DESC
$function$
```


## Appendix B — planner excerpts (TypeScript, verbatim)

### src/lib/marketingOS/scheduling/schedule.ts — header, deadline chain, earliest-ends, placement order

```ts
/**
 * Backward production scheduling against the live work ledger.
 *
 * Given each item's publishing date(s), this computes the stage deadlines
 * (backward from the required-ready date) and then PLACES every stage on a real
 * person and real working days, respecting the capacity already committed to
 * other work.
 *
 * Two properties the reviews demanded:
 *
 *  1. **Publishing batches drive production.** Items are placed in publishing
 *     order, and within an item stages are placed LAST first, each as late as
 *     its deadline allows. Batch 1 therefore takes the slots nearest its own
 *     deadlines and later batches are pushed EARLIER into their slack — never
 *     the other way round. A later batch's capacity problem can never displace
 *     an earlier batch.
 *
 *  2. **A search limit is never presented as proof of infeasibility.**
 *     Placement is a depth-first search WITH BACKTRACKING over (person, window)
 *     choices, so a first-fit mistake is reconsidered. Separately, two SOUND
 *     bounds can *prove* impossibility — a time bound (the chain cannot finish
 *     by the deadline even with infinite people) and a capacity bound (required
 *     slot-days exceed every free slot-day before the deadline). When neither
 *     bound fires and the search still fails, the result says
 *     `searchIncomplete: true` with `infeasibleProof: null`, and the UI must
 *     word it as "no schedule found", never "impossible".
 *
 * PURE.
 */
import type { WorkCalendar } from './calendar';
import {
  addWorkingDays, daysBetween, isWorkingDay, nextWorkingDay, prevWorkingDay,
  workingDaysIn, workingWindowEndingAt,
} from './calendar';
import { CapacityBook, effortWeights, effortWeightsSameDay } from './ledger';
import type {
  LoadBucket, PathRole, PlanConflict, PlannedStage, StepSpec, WorkflowSpec,
} from './types';
// ...
 * Row (`sameDaySlots`): one day carrying every member's slot.
 */
function stageWeights(step: StepSpec, sameDaySlots?: number): number[] {
  return sameDaySlots && sameDaySlots > 0
    ? effortWeightsSameDay(sameDaySlots)
    : effortWeights(step.workingDays);
}

/**
 * Backward deadlines: the last production step ends on the required-ready day,
 * and every earlier step must END `span(next)` working days before that.
 *
 * `spanOf` overrides how long a step occupies; a ROW passes `() => 1`, because
 * each of its stages is one sitting on one day.
 *
 * `sameDayChain` (see `WorkflowSpec.sameDayChain`): the predecessor may END on
 * the day its successor STARTS, rather than the working day before it. For a
 * one-day successor that is the same day.
 */
export function computeDeadlines(
  steps: StepSpec[],
  requiredReadyAt: string,
  cal: WorkCalendar,
  spanOf: (step: StepSpec) => number = (step) => effortWeights(step.workingDays).length,
  sameDayChain = false,
): string[] {
  const out: string[] = new Array<string>(steps.length).fill(requiredReadyAt);
  if (!steps.length) return out;
  out[steps.length - 1] = requiredReadyAt;
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    const next = steps[i + 1];
    const later = out[i + 1] ?? requiredReadyAt;
    const nextSpan = next ? spanOf(next) : 1;
    out[i] = addWorkingDays(later, -(sameDayChain ? nextSpan - 1 : nextSpan), cal);
  }
  return out;
}

/** Earliest possible end for each step given `today` and infinite people. */
function earliestEnds(
  steps: StepSpec[], today: string, cal: WorkCalendar, spanOf: (step: StepSpec) => number,
  sameDayChain = false,
): string[] {
  const out: string[] = new Array<string>(steps.length).fill(today);
  let cursor = nextWorkingDay(today, cal);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const span = step ? spanOf(step) : 1;
    const end = addWorkingDays(cursor, span - 1, cal);
    out[i] = end;
    // The mirror of `computeDeadlines`: the next step may start the day this one
    // ends. Both bounds must move together, or the time proof and the deadlines
    // disagree about what "fits".
    cursor = sameDayChain ? end : addWorkingDays(end, 1, cal);
  }
  return out;
}

// ...
      reqs.push({
        itemKey: it.key,
        priority: it.priority,
        order: i,
        step,
        bucket: bucketOfStep(step, it.workflow.bucket),
        weights: w,
        span: w.length,
        deadline: due,
        afterReady: false,
      });
    }
  }

  // ---- sound bound #2: capacity. Per (role, bucket) and per deadline horizon.
  const proof = capacityBound(reqs, book, cal, today, conflicts);
  if (proof) {
    return {
      ok: false, items: result, conflicts, infeasibleProof: 'capacity_bound',
      searchIncomplete: false, stats: { expansions: 0, backtracks: 0, budget }, touched,
    };
  }

  // ------------------------------------------------------------- placement
  // Order: items in publishing order; stages LAST → FIRST inside each item.
  const plan: StageReq[][] = ordered.map((it) =>
    reqs.filter((r) => r.itemKey === it.key).sort((a, b) => b.order - a.order));
  const flat: StageReq[] = plan.flat();

  const chosen = new Map<string, PlannedStage>();
  let expansions = 0;
  let backtracks = 0;
  let exhausted = false;

// ...
      conflicts.push({
        kind: 'no_eligible_person', itemKey: r.itemKey, stepKey: r.step.key, day: null,
        messageAr: `لا يوجد من يشغل دور «${r.step.roleKey}» بسعة في «${r.bucket}».`,
        messageEn: `Nobody holds the "${r.step.roleKey}" role with capacity in "${r.bucket}".`,
        detail: { role: r.step.roleKey, bucket: r.bucket },
      });
      return false;
    }

    // Candidate windows, LATEST first (leaves the most room for predecessors).
    let end = dl;
    for (let guard = 0; guard < 400; guard += 1) {
      if (daysBetween(today, end) < 0) break;
      if (!isWorkingDay(end, cal)) { end = addWorkingDays(end, -1, cal); continue; }
      const win = workingWindowEndingAt(end, r.span, cal);
      const winStart = win[0];
      const winEnd = win[win.length - 1];
      if (!winStart || !winEnd) break;
      if (daysBetween(today, winStart) < 0) break;

      // Person order: most free capacity across the window (balance), then
      // fewest total open slots, then id — deterministic.
      const ranked = people
        .map((p) => ({
          p,
          free: Math.min(...win.map((d, i) => book.freeOn(p.userId, d, r.bucket) - (r.weights[i] ?? 1))),
          load: win.reduce((acc, d) => acc + book.usedOn(p.userId, d, r.bucket), 0),
        }))
        .filter((x) => x.free >= -1e-9)
        .sort((a, b) => (b.free - a.free) || (a.load - b.load) || (a.p.userId < b.p.userId ? -1 : 1));

      for (const cand of ranked) {
        win.forEach((d, i) => book.add(cand.p.userId, d, r.bucket, r.weights[i] ?? 1));
        chosen.set(stageKey(r), {
          stepKey: r.step.key,
          roleKey: r.step.roleKey,
          bucket: r.bucket,
          assigneeUserId: cand.p.userId,
          start: winStart,
          end: winEnd,
          deadline: r.deadline,
          // The step's ESTIMATE, kept for display and for the effort screens.
          workingDays: r.step.workingDays,
          // What was actually reserved, day by day. For a ROW this is `[3]` on
          // one day while `workingDays` still reads the step's `2` — recording
          // only the estimate left every reader to re-derive the booking from a
          // number that does not describe it.
          slotWeights: r.weights.slice(0, win.length),
        });
        if (dfs(idx + 1)) return true;
```

### src/lib/marketingOS/scheduling/ledger.ts — the capacity book

```ts
/**
 * The capacity ledger — ONE definition of "how much work does this person
 * already have on this day", used by the preview, by the commit, and by the
 * SQL validator (`mos_work_ledger_v` produces exactly these rows).
 *
 * Plan v2.1 §4.3 rules encoded here:
 *   • every unit of remaining work appears exactly once (the snapshot loader
 *     guarantees that; a consumed reservation leaves as its task enters);
 *   • elapsed time is NEVER progress — remaining effort shrinks only when the
 *     assignee records it (the loader applies `progress_days`);
 *   • `stale` reservations stay at full weight, projected from today;
 *   • leave and holidays are HARD constraints, not deadline extensions.
 *
 * PURE.
 */
import type { WorkCalendar } from './calendar';
import { isWorkingDay, daysBetween } from './calendar';
import type { LedgerRow, LoadBucket, PersonCapacity, WorkloadSnapshot } from './types';

const key = (userId: string, day: string, bucket: LoadBucket): string => `${userId}|${day}|${bucket}`;

/**
 * A mutable capacity book: how much of each (person, day, bucket) is used, and
 * what the ceiling is. Built once per plan run from the snapshot, then written
 * to as the placement search assigns and un-assigns stages.
 */
export class CapacityBook {
  private used = new Map<string, number>();

  private readonly people = new Map<string, PersonCapacity>();

  private readonly onLeave = new Set<string>();

  constructor(
    private readonly snapshot: WorkloadSnapshot,
    private readonly cal: WorkCalendar,
  ) {
    for (const p of snapshot.people) {
      this.people.set(p.userId, p);
      for (const l of p.leaves) {
        // Inclusive range; guarded so a bad row cannot spin.
        const span = daysBetween(l.from, l.to);
        if (span < 0 || span > 730) continue;
        let d = l.from;
        for (let i = 0; i <= span; i += 1) {
          this.onLeave.add(`${p.userId}|${d}`);
          d = shift(d, 1);
        }
      }
    }
    for (const row of snapshot.ledger) {
      this.add(row.userId, row.day, row.bucket, row.weight);
    }
  }

  /** The people who may perform work in `bucket` for `roleKey`. Stable order. */
  eligible(roleKey: string, bucket: LoadBucket): PersonCapacity[] {
    return this.snapshot.people
      .filter((p) => p.roles.includes(roleKey as PersonCapacity['roles'][number]))
      .filter((p) => (p.caps[bucket] ?? 0) > 0)
      .slice()
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  capacityOf(userId: string, bucket: LoadBucket): number {
    return this.people.get(userId)?.caps[bucket] ?? 0;
  }

  usedOn(userId: string, day: string, bucket: LoadBucket): number {
    return this.used.get(key(userId, day, bucket)) ?? 0;
  }

  freeOn(userId: string, day: string, bucket: LoadBucket): number {
    if (!isWorkingDay(day, this.cal)) return 0;
    if (this.onLeave.has(`${userId}|${day}`)) return 0;
    return Math.max(0, this.capacityOf(userId, bucket) - this.usedOn(userId, day, bucket));
  }

  /** Does `userId` have room for `weights[i]` on each of `days[i]`? */
  fits(userId: string, days: string[], bucket: LoadBucket, weights: number[]): boolean {
    for (let i = 0; i < days.length; i += 1) {
      const day = days[i];
      const w = weights[i] ?? 1;
      if (day === undefined) continue;
// ...
    left -= w;
  }
  return out;
}

/**
 * The SAME-DAY spread: the whole weight lands on one day.
 *
 * `effortWeights` above answers "how long does this take", spreading N across N
 * consecutive working days. A ROW asks the opposite question. Three posts
 * written side by side in one sitting are ONE task, ONE submit and THREE slots
 * **on the same day** — running them through `effortWeights(3)` would reserve
 * one slot on each of three days, which is not a row at all.
 *
 * The SQL twin is `mos_spread_effort_same_day(start, effort)`
 * (2026-09-15). **Both must agree exactly**: the preview computes load in JS and
 * `mos_campaign_plan_commit`'s conflict test recomputes it in SQL, so any
 * divergence surfaces as a WS409 on a plan that actually fits — a bug the
 * commit's own comment records having happened once already.
 *
 *   3    → [3]
 *   0.25 → [0.25]
 */
export function effortWeightsSameDay(slots: number): number[] {
  return [Math.max(0, Number(slots) || 0)];
}

```

### src/lib/marketingOS/scheduling/refresh.ts — refresh-cycle dates

```ts
  policy: PaidPolicy;
}

/**
 * The launch + every kept weekly refresh, with the creatives each must produce.
 *
 * Rules:
 *   R_k = startsOn + k·cycleDays for k ≥ 1, kept only while
 *   (endsOn − R_k + 1) ≥ minRemainingDays — a final partial week short of that
 *   never gets its own refresh (its creatives would run for a day or two).
 *
 *   ready_by          = one working day before the refresh
 *   production_start  = the day that leaves exactly `leadTimeWorkingDays`
 *                       working days up to and including ready_by
 *   decision_due      = one working day before the refresh (same day as ready_by:
 *                       everything is built and verified, so the human decides
 *                       with the replacements already in hand)
 *
 * Production per kept refresh:
 *   policy A → slateSize, minus one when a BANKED spare is a known fact at that
 *              cycle's production start (earmarked exclusively to it);
// ...
    return Number.isFinite(v) && (v as number) > 0 ? Math.max(1, Math.floor(v as number)) : slate;
  };
  const keepMinFor = (s: number): number => Math.max(0, Math.min(s - 1, Math.floor(policy.keepMin)));
  const cycleDays = Math.max(1, Math.floor(policy.cycleDays));
  const minRemaining = Math.max(0, Math.floor(policy.minRemainingDays));
  const lead = Math.max(1, Math.floor(policy.leadTimeWorkingDays));
  const totalDays = daysBetween(input.startsOn, input.endsOn) + 1;

  const out: CycleForecast[] = [];

  // Round 0 — the launch slate.
  const launchReady = addWorkingDays(input.startsOn, -1, cal);
  const launchSlate = slateFor(input.startsOn);
  out.push({
    executionKey: input.executionKey,
    round: 0,
    refreshOn: input.startsOn,
    readyBy: launchReady,
    productionStartOn: addWorkingDays(launchReady, -(lead - 1), cal),
    decisionDueOn: null,
    produced: launchSlate,
// ...

  if (totalDays <= 0) return out;

  for (let k = 1; ; k += 1) {
    const refreshOn = addDays(input.startsOn, k * cycleDays);
    const daysLeft = daysBetween(refreshOn, input.endsOn) + 1;
    if (daysLeft <= 0) break;
    if (daysLeft < minRemaining) {
      // A refresh this close to the end is deliberately skipped — recorded so
      // the preview can explain the number instead of just showing it.
      out.push({
        executionKey: input.executionKey,
        round: k,
        refreshOn,
        readyBy: null,
        productionStartOn: null,
        decisionDueOn: null,
        produced: 0,
        bankedSpareSlotId: null,
        slotKinds: [],
        note: `skipped — only ${daysLeft} day(s) remain (minimum ${minRemaining})`,
      });
      break;
    }
    const readyBy = addWorkingDays(refreshOn, -1, cal);
    const productionStartOn = addWorkingDays(readyBy, -(lead - 1), cal);
    const cycleSlate = slateFor(refreshOn);
    const cycleKeep = keepMinFor(cycleSlate);
    const replacements = cycleSlate - cycleKeep;
    const kinds: Array<'replacement' | 'fifth'> = Array.from({ length: replacements }, () => 'replacement' as const);
    if (policy.fifthPolicy === 'A') {
      for (let i = 0; i < cycleKeep; i += 1) kinds.push('fifth');
    }
    out.push({
      executionKey: input.executionKey,
      round: k,
      refreshOn,
      readyBy,
      productionStartOn,
      decisionDueOn: readyBy,
      produced: kinds.length,
```

### api/_lib/marketing/planning/monthCompiler.ts — chain length and minimum lead

```ts
/**
 * Working days the production chain OCCUPIES, end to end.
 *
 * Two shapes, because the month has two kinds of subject:
 *
 *   • a ROW is three posts worked in one sitting per step, so each step takes
 *     exactly ONE day whatever its estimate says — that is what
 *     `ScheduleItem.sameDaySlots` / `effortWeightsSameDay` mean, and the step's
 *     day-estimate is deliberately ignored there;
 *   • a PAID creative is the classic path, where each step occupies its own
 *     estimate — design alone is two working days.
 *
 * Read off the PINNED workflow, never a constant: change the path in Settings
 * and the month's minimum lead changes with it.
 */
export function chainWorkingDays(wf: WorkflowSpec, sameDay: boolean): number {
  const steps = wf.steps.filter((s) => !s.afterReady);
  if (steps.length === 0) return 0;
  const spans = steps.map((s) => (sameDay ? 1 : effortWeights(s.workingDays).length));
  // On a same-day path each step starts the day the previous one ends, so
  // adjacent steps SHARE a day: the chain is 1 + Σ(span − 1). Otherwise every
  // step takes its own days in turn: Σ span. This is the forward statement of
  // exactly what `scheduleProduction`'s `earliestEnds` proves — keep them equal.
  return wf.sameDayChain === true
    ? 1 + spans.reduce((total, x) => total + (x - 1), 0)
    : spans.reduce((total, x) => total + x, 0);
}

/**
 * The fewest WORKING DAYS OF LEAD a subject needs in order to exist at all.
 *
 * "Lead" here is counted the way `MonthPostingDay.leadWorkingDays` counts it:
 * working days in `[productionStart, publishDay)` — the publish day itself is
 * not one of them. The chain's first step sits ON `productionStart`, so a chain
 * of `span` days ends on the `span − 1`-th lead day, and the publish buffer
 * pushes the required-ready date that many working days earlier again. Hence
 * `span − 1 + buffer`, which is exactly the bound `scheduleProduction` proves
 * with `time_bound` — the same arithmetic, stated forwards.
 *
 * With the shipped post path and the default one-day buffer that is **5** for a
 * row and **6** for a paid creative. Neither number is written down anywhere:
 * both fall out of the workflow.
 */
export function minLeadWorkingDays(
  wf: WorkflowSpec, sameDay: boolean, publishBufferDays: number,
): number {
  const span = chainWorkingDays(wf, sameDay);
  if (span <= 0) return 0;
  return Math.max(0, span - 1 + Math.max(0, publishBufferDays));
}

/** The two minimums a month is bounded by, derived from the rules it compiles under. */
```

### api/_lib/marketing/planning/snapshot.ts — how the pinned workflow becomes a WorkflowSpec

```ts
  const wfKeyById = new Map<string, string>();
  for (const w of (wfRes.data as WorkflowRow[]) ?? []) {
    const meta = (w.metadata ?? {}) as { key?: string; steps?: unknown };
    const wfKey = typeof meta.key === 'string' ? meta.key : w.id;
    wfKeyById.set(w.id, wfKey);
    const rawSteps = Array.isArray(meta.steps) ? meta.steps : [];
    const seed = DEFAULT_WORKFLOWS[wfKey];
    const bucket: 'post' | 'video' = seed?.bucket ?? (/video/i.test(wfKey) ? 'video' : 'post');
    const steps: StepSpec[] = rawSteps.map((raw) => {
      const s = raw as Record<string, unknown>;
      const key = String(s.key ?? '');
      const seededStep = seed?.steps.find((x) => x.key === key);
      const isApproval = Boolean(s.is_approval);
      const afterReady = /schedul|publish|جدول|نشر/i.test(key);
      const eff = effort.get(`${wfKey}|${key}|${bucket}`)
        ?? effort.get(`${wfKey}|${key}|*`)
        ?? seededStep?.workingDays
        ?? 1;
      return {
        key,
        roleKey: String(s.role_key ?? 'writer') as PathRole,
        isApproval,
        workingDays: eff,
        afterReady,
        labelAr: String(s.label_ar ?? key),
        labelEn: String(s.label_en ?? key),
      };
    }).filter((s) => s.key);
    // `sameDayChain` is a property of the PATH, and the live row carries no such
    // field — so it comes from the seed. Dropping it here would silently put
    // every post back on one-step-per-day in production while tests (which
    // read the seed directly) kept passing.
    if (steps.length) {
      workflows[wfKey] = {
        workflowKey: wfKey, bucket, steps,
        ...(seed?.sameDayChain ? { sameDayChain: true } : {}),
      };
    }
  }
  // Seeds cover offline / fresh-DB cases; live rows always win.
  for (const [k, v] of Object.entries(DEFAULT_WORKFLOWS)) if (!workflows[k]) workflows[k] = v;
```

### api/cron/planning-sweep.ts — header and handler sequence

```ts
/**
 * GET / POST /api/cron/planning-sweep — the campaign-planning clock.
 *
 * Every 10 minutes (vercel.json):
 *   1. `mos_plan_start_due()` — opens the FIRST workflow task for planned
 *      content whose `production_start` has arrived. This is why the commit
 *      does not open tasks: a campaign approved three weeks early should not
 *      dump twenty tasks into the queue today. Paid replacement slots get their
 *      content shells created here too, at each cycle's `production_start_on`.
 *   2. `mos_plan_repair()` — marks reservations whose window has passed but
 *      whose step never opened as `stale`, re-dates them forward, moves
 *      production plans to `at_risk` / `late`, and lets each publishing batch
 *      take the rollup view's verdict.
 *
 *      **It raises no task.** This header said until 2026-09-15 that "a batch
 *      at risk raises ONE `plan_conflict` task for the manager with the
 *      options". Checked against the live `pg_get_functiondef`: the function
 *      ends at `jsonb_build_object('staled',…,'batches',…)` and writes nothing
 *      to `mos_manual_tasks`. The only writer of a `plan_conflict` task in the
 *      repo is `worker/src/runRefreshCycleJob.ts` (the partial-refresh and
 *      slate-cap branches). A reader who believed this comment would have gone
 *      looking for a manager task that never arrives.
 *
 *   3. The next-month reminder (build plan F7). «اختيار مشاريع نوفمبر مطلوب
 *      خلال ٥ أيام» — the one date on the operator's calendar the month model
 *      depends on, because production for the first week starts about ten
 *      working days before it publishes. It rides THIS cron on purpose:
 *      `vercel.json` already declares ten crons, which is the plan's limit, so
 *      an eleventh schedule cannot be claimed. `npm run build` does not
 *      validate `vercel.json`, so that ceiling is only ever discovered at
 *      deploy time.
 *
 * The refresh-cycle clock lives in the Fly worker (it has to talk to Meta);
 * this endpoint is the database-only half.
 *
 * Auth: Bearer $CRON_SECRET or ?secret= for smoke tests. Always 200 so Vercel
 * never marks the cron failed; the structured body carries each step's outcome
 * and any error is ALSO console.error-ed (repo rule: fail loudly, never
 * silently).
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { monthGeometry, parseMonthTemplate } from '../_lib/marketing/planning/monthCompiler.js';
// ...
export default async function handler(req: Request): Promise<Response> {
  const startedAt = Date.now();

  const expected = process.env.CRON_SECRET;
  if (!expected) return json({ error: 'CRON_SECRET is not set; refusing to run' }, 500);
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) return json({ error: 'unauthorized' }, 401);

  const sb = getServiceSupabase();
  const out: Record<string, unknown> = {};

  // 1 — open what is due to start.
  const started = await sb.rpc('mos_plan_start_due');
  if (started.error) {
    console.error('[planning-sweep] mos_plan_start_due failed', started.error.code, started.error.message);
    out.start_due = { error: started.error.message };
  } else {
    out.start_due = started.data;
  }

  // 2 — repair drift and re-rate the batches.
  const repaired = await sb.rpc('mos_plan_repair', { p_campaign_id: null });
  if (repaired.error) {
    console.error('[planning-sweep] mos_plan_repair failed', repaired.error.code, repaired.error.message);
    out.repair = { error: repaired.error.message };
  } else {
    out.repair = repaired.data;
  }

  // 3 — the next-month reminder. A failure here is reported and does not stop
  //     the sweep: the two steps above are the ones work depends on.
  try {
    out.next_month_reminder = await nextMonthReminder(sb);
```

### api/marketing-os.ts — the queue filter that hides waiting work

```ts
async function readOpenQueueTasks(
  sb: SupabaseClient,
  sel: QueueSelector,
): Promise<{ tasks: Array<Record<string, unknown>> } | { fail: Response }> {
  let q = sb.from('workflow_role_tasks')
    .select(QUEUE_TASK_COLUMNS)
    .eq('status', 'open')
    .in('subject_table', ['mos_content', 'mos_content_rows']);

  if (!sel.team) {
    const roles = sel.roles.filter((r) => (MOS_ROLE_KEYS as readonly string[]).includes(r));
    const clauses: string[] = [];
    if (sel.preview) {
      if (roles.length > 0) clauses.push(`role_key.in.(${roles.join(',')})`);
    } else {
      if (sel.userId) clauses.push(`assignee_user_id.eq.${sel.userId}`);
      if (roles.length > 0) {
        // Waiting work (open, not handed out for lack of room) is nobody's to
        // claim: taking it would bypass the capacity limit it is waiting on.
        clauses.push(`and(assignee_user_id.is.null,waiting_since.is.null,role_key.in.(${roles.join(',')}))`);
      }
    }
    // No person AND no queue-bearing role → an empty queue, never everyone's.
    if (clauses.length === 0) return { tasks: [] };
    q = q.or(clauses.join(','));
  }

  const res = await q.order('due_at', { ascending: true, nullsFirst: false }).limit(500);
  const f = dbFail(res.error);
  if (f) return { fail: f };
  return { tasks: (res.data ?? []) as unknown as Array<Record<string, unknown>> };
```

