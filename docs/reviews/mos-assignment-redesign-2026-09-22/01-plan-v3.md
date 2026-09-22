# Wassel Marketing OS — plan-driven task assignment: implementation plan v3

2026-09-22, ~11:30 Riyadh. Supersedes `01-plan-v2.md`. Proposal only; nothing has been changed. v3 resolves the six issues of the external review. Each issue was re-verified against the live database and code by a dedicated read-only agent (Opus 4.8); the full evidence, SQL skeletons and acceptance tests are in `05-review-resolutions.md`. Where v3 changes v2, the change is marked **[v3]**.

Notation: **CONFIRMED** = operator rule, not up for challenge. **CHOICE** = implementation decision you can challenge. **CHALLENGE** = a claim in the review that the evidence contradicts or refines.

---

## 0. What changed since v2 (the reviewer's six issues)

| # | Reviewer's issue | Verdict on re-verification | What v3 does |
|---|---|---|---|
| 1 | Offered work disappears from the capacity ledger (consumed reservation + unassigned task = counted by nobody) | **Confirmed live.** `mos_work_ledger_v` task arms require `assignee_user_id IS NOT NULL`; reservation arms count only `reserved`/`stale`. P-488…491 contribute 0 ledger rows; مريم's 27 Sep cell reads 1 unit against 5 real. The commit guard, the planner's snapshot (`snapshot.ts:148`) and `mos_month_exceptions` all read that view. v2's own "bind consumes the reservation" would make the hole the steady state. | **[v3] New reservation status `bound`**: binding marks the reservation `bound` (counted through the reservation arm, attributed to its planned assignee); assignment flips `bound → consumed` in the same transaction that sets the assignee (task arm takes over). Exactly-once transfer, fail-safe (worst case over-count, never silent under-count). Conformance assertion added. §3, §4, §8. |
| 2 | Publication risk frozen at the assignment moment; can read "on track" after the publish time | **Confirmed live**: the six launch creatives (design open since 20 Sep, ads for today, 0 on Meta) read `on_track` under the v2 formula. Also: there is **no stored activation hour** for paid ads — `activate_on` is a date; ads go live on the first 60-s refresh-lane tick at/after 00:00 Riyadh once built. The "12:00" in v2 was an assumption. | **[v3] Time-aware forecast**: current step's expected finish = `GREATEST(now(), handoff + target)`; blocked → `blocked`; downstream steps floored at their booked day; required-ready and publish instants defined per subject type with two lead settings; recomputed on every handoff **and every 10-minute sweep** and on block/unblock. Forecast rerun for the running month. §1c, §6. |
| 3 | Completion idempotency must cover the API precheck and the post-transition side effects (notifications, Meta job) | **Confirmed live**: API returns 404/409 before the RPC; `enqueueMetaAdJob` mints `crypto.randomUUID()` per call with no dedupe key; `notify_emit` inserts a fresh row every call; the RPC has exactly two callers (not five as v2 said). Asset promotion is already idempotent. | **[v3]** API precheck removed; `event_id` bound to the actor; the RPC records a **side-effects manifest** in the event row; deterministic Meta job id (uuid v5 of event id) with `ON CONFLICT DO NOTHING`; notification `dedupe_key`; a TS recovery pass re-runs pending effects; explicit outcomes for same-event concurrent, different-event on closed, foreign-actor replay. §5. |
| 4 | Excluding superseded plans from the guard hides bookings that stay live | **Confirmed live**: `mos_campaign_plan_commit` flips the old plan to `superseded` and never touches its reservations; the ledger has no plan join; `mos_plan_start_due` would materialise the old plan's subjects. A re-confirm today would strand 474 rows. | **[v3]** The commit **retires** the superseded plans' unconsumed reservations (`status='superseded'`, provenance columns) and closes their offered/bound-unassigned tasks, in the same transaction, before the guard; assigned work untouched and still counted. The guard has no exclusion clause. §6. |
| 5 | Migration table contradicts its own rules (GREATEST over NULL, P-477, review midnights, nonexistent `round`) | **All four confirmed.** `mos_task_reservations` has no `round`; 4 of the 21 are unassigned; reviews chain to 16:00 not 24:00; P-477's design is booked 28 Sep → extends to 29 Sep 06:00. | **[v3]** Deadline write split by assignment state; index without `round` (0 duplicates, virtual subjects covered); comparison regenerated for all 23 open tasks with the exact chain (§8). |
| 6 | One visibility rule for the four future tasks | **Confirmed**: v2 used "offered" for both "visible" and "startable early". | **[v3] Three bands**: A «مطلوب الآن» (assigned), B «متاح للبدء مبكرًا» (the one future day's batch, idle-gated, `offered_to` set), C «قادم حسب الخطة» (all other planned work, always visible, read-only, with readiness reasons). P-488…491 are **Band C**, not offered. The old «القادم إليك» heuristic is replaced. §4. |

Corrections to v2's own facts, from the re-verification: `workflow_advance_role_path` has 2 callers; mos_task_reservations has no `round`; paid creatives have 0 publications (their publish instant must come from `refresh_on`); the launch has no activation hour.

---

## 1. Planned handoffs, deadlines, and risk

**CONFIRMED.** Planned deadline = planned handoff time + step allowance (writing/design 24 h; reviews 12 h) on the working calendar; not end-of-day; coherent across the chain; targets only. Early availability keeps the planned deadline. A late handoff gives the full allowance from receipt; the original target stays visible; publication risk is separate from employee lateness; routine dispatch timing must not create misleading flags.

**1a. Planned handoff times — CHOICE (unchanged from v2).** `mos_step_rules.target_hours` (data; seeds writing 4, writing_review 2, design 4, design_writer_review 2, design_review 2; CHECK ≤ allowance). Chain by step order, anchored on booked days, computed by `mos_plan_chain(subject)`:
```
handoff_1  = booked_day_1 00:00 Riyadh
cand_k     = mos_work_due_at(handoff_{k-1}, target_{k-1})
handoff_k  = GREATEST(booked_day_k 00:00, cand_k)          -- uses the *_corrected day when present, else the original
plan_due_k = mos_work_due_at(handoff_k, allowance_k)
```
Consequences the reviewer asked to state precisely: a first-step writing task booked day D is due D+1 00:00; a review handed off at D 04:00 is due **D 16:00** (not midnight); design at D 06:00 is due D+1 06:00; the writer's check at D 10:00 is due D 22:00; final approval at D 12:00 is due D+1 00:00. Across Friday: a review handed off Thu 20:00 is due Sat 08:00. Worked examples (row on one day; paid creative across days) are in `05-review-resolutions.md` and unchanged from v2.

**1b. Enforced deadline — CHOICE (unchanged).** Two task columns: `plan_due_at` (immutable copy) and `due_at`:
```
due_at = GREATEST(plan_due_at, mos_work_due_at(assigned_at, allowance))   + approved-leave extension
```
Anchor = the assignment moment, for every step. Never the predecessor's `closed_at`, never `opened_at` (both manufacture lateness for queued work). Discipline (`mos_perf_late_sweep`) unchanged, reads `due_at` only. `handoff_slip = assigned_at − plan_handoff_at` is informational.

**1c. Publication risk — [v3] replaced.** Computed by `mos_publication_risk(subject)`, STABLE, evaluated live where shown and cached on the task by the sweep.

- *Current step c* = earliest step in workflow order not done. If `c.blocked` → `risk='blocked'`, reason = `blocked_reason`, no estimate. Else `handoff_c = c.assigned_at` if assigned, else `GREATEST(now(), booked_day_c 00:00)`; **`expected_finish_c = GREATEST(now(), mos_work_due_at(handoff_c, target_c))`** — slides with the clock while unfinished.
- *Remaining steps k*: `handoff_k = GREATEST(expected_finish_{k-1}, booked_day_k 00:00)` — downstream booked days are preserved: writing finishing early does not assume the designer accepted early work; `finish_k = mos_work_due_at(handoff_k, target_k)`. `projected_ready = finish_last`.
- *Required-ready and publish instants*, per subject type:
  - Organic: `publish_at` = earliest member `mos_publications.planned_at` (18:00 + 5-minute gaps); `required_ready_at = publish_at − release_lead_hours` (new setting, default 2 h: release-sweep latency + scheduling/publish_check + bundle fetch).
  - Paid: there is **no stored activation time**. `activate_on = refresh_on` (a date); the refresh lane polls every 60 s and activates a built ad on the first tick at/after 00:00 Riyadh of that day; under `ads_live_when_ready` an ad counts as on time any time that day. So `required_ready_at = refresh_on 00:00 − ad_build_lead_hours` (new setting, default 2 h — note the build path includes a **human caption approval** the 5-step chain does not model; see decision 4), `publish_at = end of the refresh_on day`. Paid creatives have no publications; nothing reads `mos_publications` for them.
- *Verdicts*: `blocked`; `on_track` (projected ≤ required-ready); `at_risk` (required-ready < projected ≤ publish); `late` (projected > publish).
- *Recompute points*: every handoff (assign, advance/close), **every 10-minute sweep for every in-flight subject** (this is what ages the flag when nothing happens — v2's "per handoff" was insufficient), and block/unblock. Stored `at_risk/risk_reason` is a ≤10-minute cache; the queue API evaluates the function live.
- `mos_plan_repair` stops writing `at_risk`; this function is the only source.

Rerun on the live state (10:11 today; corrected booked days; leads 2 h):

| subject | publish / activation | required-ready | projected ready | verdict |
|---|---|---|---|---|
| 22 Sep launch — 6 creatives P-471…476 | activation 22 Sep 00:00 (live-when-ready) | 21 Sep 22:00 | 22 Sep 14:11 (design open, sliding) | **at_risk** on the day line; **late** against any fixed hour (v2's formula said on_track) |
| 22 Sep organic row (design r2 open) | 22 Sep 18:00 | 16:00 | 14:11 | on_track (~2 h) |
| 24 Sep row (reservation-only, booked 23 Sep) | 24 Sep 18:00 | 16:00 | 23 Sep 14:00 | on_track |
| 29 Sep — 11 creatives with buffer | 29 Sep 00:00 | 28 Sep 22:00 | ≤ 28 Sep | on_track |
| 29 Sep — P-488…491 (design corrected → 29 Sep) | 29 Sep 00:00 | 28 Sep 22:00 | 29 Sep 08:00 | at_risk |
| c2–c5 creatives whose design was corrected onto the activation day | round activation 00:00 | −2 h | activation day 08:00 | at_risk (34), late 0 |

**CHALLENGE (refinement, not disagreement):** per-subject risk assumes each subject can start now; with one designer holding 8 open designs, several launch creatives are really later than 14:11. Queue contention is a further source of optimism the per-subject forecast does not model; the capacity view (§8) shows it. Whether to fold role-queue contention into the risk verdict is decision 6.

---

## 2. Correcting the remaining schedule of the running month

**CONFIRMED.** Planned date is the first sort field, step position fourth; correct the dates; preserve originals as history; correct only remaining operational bookings; keep completed work and issued commitments; no rebuild.

**Root cause (unchanged).** `schedule.ts:264-272` `effectiveDeadline()` returns `max(cap, deadline)` where the comment and algorithm need `min`. One-line fix + a saturated-designer test.

**CHOICE 2a — one-shot correction, reserved rows only [v3: counts `bound` in booked weight].** Under `mos_ledger_lock`, cron paused:
1. Preconditions asserted (abort otherwise): reserved successor before a *done* predecessor's `closed_at` = 0; before an *in-progress* predecessor's `due_at` = 0 (both 0 today); exactly 1 multi-day span (the repaired row `design_review` 22→24 Sep) → collapsed to one day.
2. Originals for all 520 into `planned_start_orig/planned_end_orig` from `mos_campaign_plans.plan->'reservations'` (all 520 match; 13 differ from the live row because repair moved them). `planned_handoff_at_orig / planned_due_at_orig` from the original days.
3. Repack, forward only: subjects by (earliest remaining planned day, publish date, rank, key); steps in workflow order; `floor = max(predecessors' corrected days or actual finish day, own day, today)` advanced to a working day; move only violating steps to the earliest working day ≥ floor with room, where **booked = open assigned tasks + reservations in (`reserved`, `bound`) + already-moved rows**; consumed (assigned) reservations count once through their task. Never move a predecessor; never move a non-violating step; organic rows never displaced.
4. Write to live `planned_start/planned_end` **and** `*_corrected`; recompute `planned_handoff_at / planned_due_at`; recompute risk; close the phantom.

Dry run (unchanged numbers, recomputed this morning): 116 reserved steps / 52 subjects (design 32, design_writer_review 32, design_review 52); +1 day 64, +2 days 32, +3 days 20; 72 direct ordering fixes + 44 capacity cascades; organic moved 0; days over cap after 0; unrepairable before publish 0; 38 creatives lose their ready-by buffer → `at_risk` by the forecast in §1c.

**Issued commitments [v3 corrected].** Only the **17 assigned** open reservation-backed tasks get `due_at := GREATEST(due_at, plan_due_at)`; the 4 unassigned ones keep `due_at NULL` (§8 has every value). Assigned tasks whose booked day is in the future are extended, not "unchanged": P-477 (design booked 28 Sep, in progress since 20 Sep) → due 29 Sep 06:00. Keeping such early-started work assigned with a week-out deadline is decision 3.

---

## 3. One process decides assignment; the booking is never lost

**CONFIRMED.** One process (refill) decides; the apply function applies with no admission policy; no recursive refill; creation inside refill only creates and binds.

**CHOICE 3a — the split (unchanged), with the [v3] reservation lifecycle:**

| function | role |
|---|---|
| `mos_task_open(subject)` | creates the first-step task and **binds** its reservation: `status 'reserved' → 'bound'`, `consumed_task_id = task`, planned assignee kept on the reservation; copies `scheduled_*`, `plan_handoff_at`, `plan_due_at`; task `assignee NULL`. Never assigns. The consume-search stays `WHERE status IN ('reserved','stale')`, so a `bound` reservation can never be bound twice. |
| `mos_task_assign_apply(task, user, notify)` | replaces `mos_task_dispatch`. `FOR UPDATE` guard (open, unassigned, subject active, working day); sets assignee/`assigned_at`/`due_at` (§1b); clears `offered_to`; **in the same transaction flips the reservation `bound → consumed`** (idempotent no-op if already consumed); notify. The holder pick and the whole capacity `WHERE`, including `OR used = 0`, are deleted. |
| `mos_refill(p_roles)` | the only decider (§4). Under `mos_ledger_lock`, one pass: release strays → open due subjects and refresh-cycle shells via `mos_task_open` → ordered candidate set → decide → apply. Transaction-local flag `mos.in_refill` / `mos.refill_again`; openers request a refill instead of calling it. |
| `workflow_role_path_start`, `workflow_advance_role_path`, `content_revise`, `mos_campaign_plan_commit` | call `mos_task_open` then request a refill; never dispatch. |
| release / unassign while open (role loss, transfer that clears the assignee) | reservation `consumed → bound` (re-pointed to the intended holder), task `assignee NULL`, `due_at NULL`. True cancellation: reservation `released`, task `skipped`. |
| `mos_plan_repair` | treats `bound` like `consumed`: never re-dates or re-spans it. |

**The single accounting rule.** A unit of planned work is counted by exactly one arm of `mos_work_ledger_v` at every moment: the reservation arm while `reserved`/`stale`/**`bound`** (attributed to the reservation's planned assignee on its planned day); the task arm once assigned (`consumed`); nobody once done. `consumed` therefore means "actively assigned or finished", never "offered". Early start keeps the ledger cell on the planned day (`scheduled_start` unchanged). Every reader — the commit guard, `mos_month_exceptions`, the planner's snapshot, the correction — inherits the correct number by reading the view. A conformance assertion fails CI if any `consumed` reservation backs an open unassigned task.

Why `bound` rather than counting unassigned tasks by `offered_to`: an unassigned task with no `offered_to` (a legacy row, a mid-transaction state, a future path that forgets the column) would vanish silently — the same class of bug being fixed. `bound` fails loud (an over-count that shows in the exceptions view), never silent.

Live effect: مريم's 27 Sep writing cell goes from 1 counted unit to 5; a plan proposing 6 more units there is refused (WS409) instead of passing.

**CHALLENGE (unchanged from v2):** the `OR used = 0` clause is removed because it lets the first task of a day exceed the cap on the dispatch path; it did not cause the 9-on-7 launch day, which was written at confirm.

---

## 4. Visibility, optional early work, ordering

**CONFIRMED.** Distinguish work available to start early from work required now; offering adds no mandatory workload and no countdown; the early batch is the whole ready batch of one future planned day, selected once per refill; blocked work on the earliest future day must not hide later executable reservation-only work; starting early keeps the planned deadline.

**CHOICE 4a — three bands per person [v3].** Membership is a pure partition derived from two task columns (`assignee_user_id`, `offered_to_user_id`) plus reservations; refill changes only whether `offered_to` is set.

| band | predicate | what it is | actions |
|---|---|---|---|
| **A «مطلوب الآن»** | task open, `assignee = me` | assigned work; real `due_at` | work / complete |
| **B «متاح للبدء مبكرًا»** | task open, `assignee NULL`, `offered_to = me`, `due_at NULL` | the one future day's executable batch, set by refill only when I passed the idle test and it is my earliest executable future day | **start early** → `mos_task_assign_apply`, `due_at = plan_due_at` |
| **C «قادم حسب الخطة»** | (task open, my role, `assignee NULL`, `offered_to NULL`) ∪ (reservation `reserved`, `assignee = me`, no open task), horizon 14 days | all my other planned work: planned day, planned deadline, readiness (`blocked: …`, «بانتظار اعتماد الكتابة», «محجوز ليوم …») | none (view only) |

Band C is always shown, whatever the person's load. Band B is shown only when refill selected it. The old «القادم إليك» heuristic and the queue's self-claim clause are removed; Band C's reservation source is a SECURITY DEFINER read (`mos_planned_steps`), because reservations carry RLS with no browser policies.

**CHOICE 4b — selection in `mos_refill`, once per pass, per (person, capacity key):**
1. *Mandatory*: every open task whose dependencies are met and whose planned day ≤ today → assigned (ordered by 4c). Planned work is not capacity-gated; the plan and the commit guard are the cap.
2. *Idle test* (evaluated once, before materialising): no open, non-blocked assigned task of that capacity key; open review tasks do not count.
3. *Early batch*: if idle, the first future day with ≥ 1 executable item for this person; **all** its executable items are opened (`mos_task_open`, reservation `bound`) and marked `offered_to = me`; non-executable items of that day stay in Band C with their reason; a day with no executable item is skipped. Refill **never assigns** an offered task; it becomes mandatory on its planned day.
4. *Unplanned work* (revisions, legacy, `scheduling`, `publish_check`): assigned when open units of that key + this task ≤ `mos_step_rules.daily_limit` (live) or the person holds nothing; `mos_capacity_used` survives only here, as open units.

**CHOICE 4c — the one ordering** (unchanged): planned day of the task's own reservation (else the subject's earliest reserved step, else publish date); `publish_at` NULLS LAST (paid creatives get `target_publish_at = refresh_on`); `publish_rank`; step position; `round`, `id`.

**The four tasks P-488…491 today [v3]:** Band C, visible with planned day 27 Sep and `plan_due_at` 28 Sep 00:00, read-only, no countdown. Not offered: مريم holds 3 assigned writing tasks (not idle), and even when idle her earliest executable future writing day is Wed 23 Sep (the Thu 24 row), so refill offers that batch first; the 27 Sep set moves to Band B only when it is her earliest remaining executable day and she is idle; it becomes mandatory on 27 Sep.

Band tests (added to CI and live acceptance): A1 assigned work is A regardless of plan day; B0 P-488…491 are C at migration; B1 idle → the 23 Sep batch is offered whole, 27 Sep stays C; B2 an offer not started stays B with `plan_due_at` unchanged and no lateness; B3 start early → A with `due_at = plan_due_at`; C1 Band C shown while fully loaded (سارة); C2 readiness follows predecessor approval; E4 blocked earliest day → next executable day offered; P partition is exhaustive and disjoint.

---

## 5. Completion cannot be repeated, and neither can its side effects

**CONFIRMED.** Bind completion to the expected task or a unique event id validated under the lock; retries and concurrent duplicates cannot complete the successor, advance twice, or duplicate assignments.

**Traced [v3 additions].** The API rejects a closed task before the RPC (`task_complete` 404 at `marketing-os.ts:2409-2417`; `row_task_complete` 409 at :5704-5720), so a lost response + retry returns an error, not the stored success. After the RPC the API runs: `mos_promote_approval_asset` (idempotent already), `enqueueMetaAdJob` (`metaAutoAd.ts:210` `crypto.randomUUID()`, `generation_jobs` has only its PK — a second call is a second job; the worker's `platform_ad_id` guard covers only the same ad row), `wakeWorker`, `emitNotify` (`notify_emit` inserts a fresh row per call; `push_outbox.dedupe_key` is derived from the fresh id). The RPC has exactly two callers (`:2499`, `:5763`). `mos_completion_events` does not exist yet.

**CHOICE 5a — contract.**
- *Event identity*: the SPA mints one `event_id` per user action (reused across the ad-set choose → pick cycle and across retries); body field or `Idempotency-Key`. The RPC stores `actor_user_id`; a replay by a different actor → `MOS:EVENT_OWNER_MISMATCH` (403).
- *API*: no status precheck. Resolve the task by id (404 if absent); if open and the result is an approval on an `auto_meta_ad` step, resolve the Meta target (a "choose" still returns 409 with no change); call the RPC with `p_task_id`, `p_event_id`, `p_meta_target`; then run the **shared effect runner** keyed by `event_id`; return the outcome (carries `replayed: true` on replay).
- *RPC* `workflow_advance_role_path`, under `mos_ledger_lock`: (1) replay lookup first — found → enforce actor, return stored outcome; (2) `SELECT … WHERE id = p_task_id AND subject matches FOR UPDATE`; not found → `MOS:TASK_NOT_FOUND` (404); not open → `MOS:TASK_ALREADY_CLOSED` (**WS409**, never a bare raise); (3) existing transition + `mos_task_open` + refill request; (4) build the **side-effects manifest** (`promote_asset`, `meta_ad` with a deterministic `job_id`, `notify` per recipient) into the event row; (5) insert `mos_completion_events` as the last write. Rollback removes event and transition together.
- *Side effects, each idempotent and durable*: Meta job id = uuid v5 of `event_id`, `generation_jobs` insert `ON CONFLICT (id) DO NOTHING`; a new `mos_execution_ads` row (when no placeholder exists) gets a deterministic id too; `notifications.dedupe_key` (unique partial index) = `event_id:kind:recipient`, `notify_emit` gains `p_dedupe_key` and `ON CONFLICT DO NOTHING`, push dedupe derived from it; `mos_completion_effect_done` flips a manifest element (single row-locked jsonb merge). *Recovery*: a TS cron pass (decision 5 for cadence) re-runs any manifest element still `pending` older than 2 minutes through the same runner. A replay also runs pending effects synchronously.
- `content_revise` gains the ledger lock and `p_event_id`; `workflow_role_task_transfer` gains `p_event_id` and skips the note on replay. The 2 RPC callers are switched together; a transition window logs loudly for subject-only calls.

**Expected results (as the reviewer asked):** concurrent requests with the same event id → both return the same success, effects once; a different event id on a completed task → 409 already-closed, successor untouched; same event id by a different user → 403; lost response + retry → same success, effects once; crash between commit and job creation → recovery enqueues exactly one job; content-id-only completion → 400.

---

## 6. Migration and the capacity guard

**CONFIRMED.** Re-read the state; originals from verified records; corrected vs original distinguished; guard inside the commit transaction under the lock across every occupied day, counting each unit exactly once; dry-run comparison.

**6a. The guard [v3].** In `mos_campaign_plan_commit_month`, after the lock and hash gate, before any insert: union all plans' reservations; same-day iff `row_key` is set (never the free-text `spread`); `existing` = `mos_work_ledger_v` **alone** (open assigned tasks + `reserved`/`bound`/`stale` reservations + manual; consumed excluded because their task is counted); `existing + proposed ≤ mos_user_daily_slots` per (assignee, day, bucket) and not on leave, else `WS409 capacity_conflict` with the cells. **No status-based exclusion clause.**

**6b. Superseded plans are retired, not excluded [v3].** Inside `mos_campaign_plan_commit`, after the idempotent `approved → already` short-circuit and the `proposed`-only check, and **before** the guard, for the plans it supersedes (same campaign, `proposed`/`approved`, other id):
- unconsumed reservations (`reserved`/`stale`, no task) → `status='superseded'`, `superseded_by_plan_id`, `superseded_at`;
- the old plan's **offered / bound-unassigned** content tasks → `skipped` with note `plan_superseded:<id>`; their reservations → `superseded` (rows are shared by `row_key` and carried forward; their old row reservation is retired, the single open row task is kept);
- consumed reservations behind **assigned** tasks: untouched, still counted through the task, deadlines unchanged;
- plan status → `superseded` (the existing end-of-function update moves here).
`superseded` joins the reservation status CHECK; every reader uses positive filters (`reserved`/`stale`/`bound`), so it is inert everywhere. Today 0 plans are superseded; a re-confirm as v2 wrote it would have stranded 474 live rows and let `mos_plan_start_due` materialise 66 duplicate subjects.

**6c. Migration — one transaction, cron paused, under the lock [v3 sequence].**
1. Schema: `mos_step_rules.target_hours` (+ seed, CHECK ≤ allowance); reservations `planned_start_orig`, `planned_end_orig`, `planned_handoff_at_orig`, `planned_due_at_orig`, `planned_start_corrected`, `planned_end_corrected`, `planned_handoff_at`, `planned_due_at`, `superseded_by_plan_id`, `superseded_at`; status CHECK gains `bound` and `superseded`; tasks `plan_handoff_at`, `plan_due_at`, `handoff_slip`, `at_risk`, `risk_reason`, `offered_to_user_id`, `offered_at`; `mos_completion_events`; `notifications.dedupe_key` + unique partial index; settings `planning.release_lead_hours`, `planning.ad_build_lead_hours`; unique index on reservations `(COALESCE(content_id::text, row_id::text, cycle_id::text||':'||content_key), step_key)` after a 0-duplicates assertion (520/520 distinct today; virtual subjects covered by the third branch).
2. Originals for all 520 from `mos_campaign_plans.plan` (assert 520 matches; abort on any miss).
3. Ledger view: reservation arms count `bound`; task arms unchanged.
4. Functions: `mos_plan_chain`, `mos_publication_risk`, `mos_task_priority`, `mos_task_open`, `mos_task_assign_apply`, `mos_refill`, `mos_planned_steps`, `mos_step_readiness`, `mos_meta_job_id`, `mos_completion_effect_done`; rewired `path_start / advance / revise / transfer / commit / commit_month / start_due / repair`; `schedule.ts` fix deployed with it.
5. Correction (§2) with its preconditions.
6. Open tasks: the **17 assigned** reservation-backed → `plan_*` stamped, `due_at := GREATEST(due_at, plan_due_at)`; the **4 unassigned** (P-488…491) → reservation `consumed → bound`, task `assignee NULL`, `offered_to NULL`, `waiting_reason NULL`, `due_at NULL`, `plan_*` stamped (Band C); the phantom → `skipped`; the row revision (no reservation) untouched; `target_publish_at = refresh_on` on the 21 paid shells.
7. `mos_plan_repair`: no re-dating, no re-spanning, no `at_risk` writes; treats `bound` like `consumed`.
8. `mos_refill(NULL)` once; risk recomputed for every in-flight subject; cron resumed.

**CI fixture** (transactional, `db-migrations` job): guard cases (a) 6×1 + a row of 3 on a 7-slot day → WS409; (b) the four-plan split → WS409; (c) a row labelled `per_day` with `row_key` set still counts 3 → WS409; (d) 7 on 7 passes; supersede cases (idempotent re-confirm; genuine re-plan retires unconsumed rows and the guard passes without exclusion; an old-plan offered task is closed; an old-plan assigned task is untouched and still counted; a shared row carries forward); the ledger lifecycle test E-LEDGER-1 (reservation → bound → assigned → done: the cell's sum is constant, then removed); the conformance assertion (no `consumed` reservation behind an open unassigned task).

---

## 7. Change list (delta from v2 marked)

| # | component | change | size |
|---|---|---|---|
| 1 | `schedule.ts:271` | `effectiveDeadline` → min | 1 line |
| 2 | scheduling tests | saturated-designer monotone-steps test | ~60 |
| 3 | migration (schema) | as §6c step 1 **[v3: +bound, +superseded, +provenance, +dedupe_key, +leads, index without round]** | ~80 |
| 4 | `mos_work_ledger_v` | reservation arms count `bound` **[v3]** | ~10 |
| 5 | `mos_capacity_used` | open units only (unplanned work) | ~5 |
| 6 | `mos_plan_chain`, `mos_task_priority` (new) | chain + ordering | ~80 |
| 7 | `mos_publication_risk` (new) **[v3 time-aware]** | §1c | ~90 |
| 8 | `mos_task_open` (new) | create + bind → `bound` **[v3]** | ~50 |
| 9 | `mos_task_assign_apply` (replaces dispatch) | apply only; `bound → consumed` in the same tx **[v3]** | ~40 |
| 10 | `mos_refill` (new) | §4b lanes, three-band marking, flag | ~200 (Kimi from spec; Claude reviews) |
| 11 | `mos_planned_steps`, `mos_step_readiness` (new) **[v3]** | Band C read (definer) | ~60 |
| 12 | `workflow_role_path_start`, `content_revise`, `workflow_role_task_transfer` | open + refill request; lock + event id | ~30 |
| 13 | `workflow_advance_role_path` + `mos_completion_events` + `mos_completion_effect_done` + `mos_meta_job_id` **[v3]** | §5 | ~120 |
| 14 | `notify_emit` **[v3]** | `p_dedupe_key`, `ON CONFLICT DO NOTHING` | ~15 |
| 15 | `mos_campaign_plan_commit` **[v3]** | retire superseded plans before the guard; `row_key` parity | ~50 |
| 16 | `mos_campaign_plan_commit_month` | whole-month union guard, no exclusion | ~40 |
| 17 | `mos_plan_start_due`, `mos_dispatch_sweep`, `mos_plan_repair` | open due/cycles → refill; alias; no re-date, no at_risk writes | ~40 |
| 18 | correction RPC (one-shot) | §2, booked weight includes `bound` | ~180 (Kimi from spec) |
| 19 | `api/marketing-os.ts` (`task_complete`, `row_task_complete`, effect runner, queue) **[v3]** | no precheck; event id; manifest runner; three lists; `mapRoleTask` fields; remove `upcoming` and the self-claim clause | ~150 (Kimi from spec) |
| 20 | `api/_lib/marketing/metaAutoAd.ts` **[v3]** | deterministic job id; `ON CONFLICT DO NOTHING`; deterministic ad-row id | ~20 |
| 21 | recovery cron step **[v3]** | pending effects → runner | ~40 |
| 22 | SPA: `client.ts`, `rowClient.ts`, approval components, `WorkPage.tsx`, `MyPerfPage.tsx` | one event id per action; three bands; start-early action; plan dates and risk chips; waiting pill time | ~200 (Kimi from spec) |
| 23 | CI: `supabase/tests/ci/*` | §6 fixture + conformance assertion | ~150 |
| 24 | PRDs: `docs/prd/marketing-performance.md`, `marketing-workspace.md` | lifecycle, bands, deadline model, completion contract | — |

Deliberately unchanged: backward scheduling; the allowances; Friday-only calendar and `mos_work_due_at`; role eligibility and opt-outs; the one-open-task index; rows = one task of three units; `publish_rank`; the number of crons; `mos_promote_approval_asset`; the worker's `platform_ad_id` guard (kept as defence in depth).

---

## 8. Dry-run comparison, regenerated with the exact logic (live, 22 Sep)

**Open tasks — current → proposed** (targets 4/2/4/2/2; allowances via `mos_work_due_at`; Riyadh):

| ref | step | who | current due | plan handoff | plan due | proposed due | change |
|---|---|---|---|---|---|---|---|
| P-471 / 473 / 474 | design | سارة | 21 Sep 19:31–19:32 | 21 Sep 06:00 | 22 Sep 06:00 | **22 Sep 06:00** | extended +10.5 h |
| P-472 / 475 / 476 | design | سارة | 22 Sep 19:40 | 21 Sep 06:00 | 22 Sep 06:00 | 22 Sep 19:40 | unchanged (current later) |
| P-477 | design | سارة | 21 Sep 19:32 | 28 Sep 06:00 | 29 Sep 06:00 | **29 Sep 06:00** | extended +7 d (booked 28 Sep) |
| P-479 / 480 | writing | مريم | 22 Sep 14:00 | 28 Sep 00:00 | 29 Sep 00:00 | **29 Sep 00:00** | extended |
| P-487 | writing | مريم | 22 Sep 14:00 | 27 Sep 00:00 | 28 Sep 00:00 | **28 Sep 00:00** | extended |
| P-478 / 481 / 482 / 483 | writing_review | حسام | 22 Sep 02:54–10:34 | 28 Sep 04:00 | 28 Sep 16:00 | **28 Sep 16:00** | extended (16:00, not 24:00) |
| P-484 / 485 / 486 | writing_review | حسام | 22 Sep 04:43–10:26 | 27 Sep 04:00 | 27 Sep 16:00 | **27 Sep 16:00** | extended |
| P-488 / 489 / 490 / 491 | writing | — (Band C) | none | 27 Sep 00:00 | 28 Sep 00:00 | **NULL** | reservation `bound`; `plan_due_at` tracked; visible; no countdown |
| P-135 | design (phantom) | ريان | 6 Sep 17:00 | — | — | closed (`skipped`) | archived subject |
| row 22 Sep, design r2 | revision | سارة | 22 Sep 18:50 | — | — | 22 Sep 18:50 | unplanned; unchanged |

Nobody's deadline is shortened. Three of the six launch designs and P-477 get later deadlines because they were handed out before their booked day.

**Schedule corrections** (original → corrected, representative; full list produced by the correction RPC's dry-run mode):

| subject | step | original | corrected | reason |
|---|---|---|---|---|
| P-488 (paid c1, activates 29 Sep) | design | 26 Sep | 29 Sep | inverted + سارة full 27/28 |
| P-488 | design_writer_review / design_review | 28 Sep / 27 Sep | 29 Sep / 29 Sep | cascade / inverted |
| a9f8 c2 s5 (activates 6 Oct) | design / design_review | 3 Oct / 4 Oct | 6 Oct / 6 Oct | inverted + capacity |
| 22 Sep row | design_review | 22→24 Sep (repair span) | 22 Sep | de-span |
| 13 repair-moved reviews | (various) | 21 Sep (recovered) | 22 Sep | overdue-by-plan; due lane |
| P-471…476, all done/in-flight steps | — | untouched | — | history / commitments |

**Bands today**: مريم — A: P-479/480/487; B: none (not idle); C: P-488…491 (27 Sep), the 23/24/26/28 Sep rows, 6 launch design checks («بانتظار اعتماد التصميم»). سارة — A: 8 designs; B: none; C: her Sat/Sun/Mon design reservations with readiness. حسام — A: 7 reviews; C: 7 final approvals («بانتظار التصميم»).

**Capacity**: مريم's 27 Sep writing cell 1 → 5 counted units (the four bound tasks now count). **Publication risk**: as §1c's table.

---

## 9. Verification scenarios

The 15 scenarios of v2 §7 stand, with these replacements and additions:

- **Deadlines**: DL1 early dispatch → `due_at = plan_due_at`, no lateness; DL2 late handoff → full allowance, target visible, `handoff_slip` recorded; the review chain gives 16:00, the Friday case Sat 08:00.
- **Risk** (all new): T1 the reviewer's case — design assigned 23 Sep 06:00, still open on 24 Sep 20:00 → `late`, never `on_track`; T2 blocked → `blocked`; T3 early writing does not pull design's booked day; T4 an open, overdue predecessor is the anchor and slides; T5 organic vs paid instants; T6 the six launch creatives read `at_risk`/`late`, not `on_track`; T7 the sweep re-evaluates an untouched subject every 10 minutes.
- **Ledger** (new): E-LEDGER-1 reservation → bound → assigned → done, cell sum constant then removed, one arm at each step; E-LEDGER-2 the guard sees offered work (5 + 6 > 10 → WS409); E-LEDGER-4 early start keeps the cell on the planned day; E-LEDGER-5 release returns the booking to the reservation arm; E-LEDGER-6 a `bound` reservation cannot be bound twice; E-LEDGER-7 concurrent assign is exactly once; conformance assertion raises on a corrupted row.
- **Completion** (replacing v2 #5): ID1 same event id retry → same success, one successor, effects once; ID2 concurrent different event ids → one advances, one 409; ID3 content-id-only → 400; ID4 lost response + retry → same success; ID5 crash between commit and job creation → recovery enqueues exactly one job; ID6 foreign actor replay → 403; ID7 notification and job dedupe under replay.
- **Supersede** (new): re-preview → re-confirm idempotent; a genuine re-plan retires old unconsumed rows and passes the guard without exclusion; old-plan offered task closed; old-plan assigned task untouched and counted; shared row carries forward; `superseded` inert in every engine path.
- **Bands** (new): A1, B0, B1, B2, B3, C1, C2, E4, P as listed in §4.
- **Migration**: idempotent second run; 520 originals recovered (13 differ from live); kind-2/kind-3 preconditions; the 17/4 split exactly as §8; no `due_at` decreased; consumed rows byte-identical; index builds without `round`.

Live acceptance after apply: `R1_order = 0` on reserved rows; no `consumed` reservation behind an open unassigned task; مريم's page shows P-488…491 in Band C dated 27 Sep; the launch creatives show `at_risk`/`late`; no task newly flagged late by the next sweep that was not already overdue.

---

## 10. Decisions I need from you (updated)

1. `target_hours` seeds 4/2/4/2/2 (the reviewer accepts them as turnaround estimates) — confirm or set.
2. Planned work not capacity-gated at dispatch; the plan and the commit guard are the cap — confirm.
3. Early-started future work (P-477 and the three launch designs handed out before their booked day): keep assigned with the extended planned deadline (proposed), or re-offer it (would require un-binding; not proposed).
4. **Paid activation hour.** Nothing stores one; ads go live from 00:00 on the batch day once built. If you want a fixed hour (e.g. 12:00), it becomes a setting and the launch reads `late`, not `at_risk`. Also: the paid build path includes a human caption approval after final approval that the 5-step chain does not model — either add a step or size `ad_build_lead_hours` for it.
5. Recovery cadence for pending completion effects: inside the 10-minute planning sweep, or a dedicated 1–2-minute cron (proposed for launch days).
6. Should the risk verdict include role-queue contention (one designer, many creatives), or stay per subject with the capacity view alongside (proposed)?
7. Band C horizon 14 days with "show more"; include review steps (proposed yes).
8. Keep P-488…491 materialised as bound-unassigned (proposed; smaller change) vs de-materialise them so Band C is reservation-only.
9. Archiving content auto-closes its open tasks going forward — yes/no (the phantom is closed either way; superseded-plan offers are closed regardless).
