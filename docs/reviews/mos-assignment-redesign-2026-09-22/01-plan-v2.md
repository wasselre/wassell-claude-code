# Wassel Marketing OS — plan-driven task assignment: revised implementation plan (v2)

2026-09-22, ~10:00 Riyadh. Proposal only; nothing has been changed. Built from a second 76-agent read-only audit (Opus 4.8): five tracers (live state re-read at 08:12 today, commit guard, call chain/recursion/idempotency, deadline model, correction dry run), two independent refuters per claim (20 confirmed, 14 corrected), two competing plan drafts and a judge. Every number below is from the live database this morning unless marked **[inferred]**.

Throughout: **CONFIRMED** = the operational behaviour you fixed on 22 Sep (not up for challenge). **CHOICE** = an implementation decision you can challenge. **CHALLENGE** = a technical concern in your six points that the evidence contradicts.

---

## 0. Live state, re-read 2026-09-22 08:12 Riyadh

| Item | Now |
|---|---|
| Open tasks (`status='open'`) | **23**: سارة 8 design (6 launch creatives P-471…476 r1, P-477, one row revision r2); مريم 3 writing (P-479/480/487, assigned 21 Sep 14:00, due today 14:00); **4 writing unassigned** (P-488…491, `waiting_reason='capacity'`, planned 27 Sep); حسام 7 writing_review (due today 02:54–10:34); ريان 1 phantom (P-135, archived content, due 6 Sep). 60 further August rows are `skipped` with `closed_at NULL` — count open work by `status='open'`, never by `closed_at`. |
| What the 21 Sep 14:00 sweep did | Handed مريم exactly 10 writing units at once (her cap); she submitted 7 by 22:34, each advanced to حسام inline. 19:40 sweep handed سارة 3 more launch designs (due today 19:40). All `due_at` = dispatch clock + allowance. |
| Reservations | 520: **46 consumed** (25 → done, 21 → open), **474 reserved**. 0 stale, 0 duplicates, all `consumed_task_id` links intact. |
| Repair fired | Yes — at **22 Sep 00:00:00** `mos_plan_repair` re-dated **13** reserved review steps from 21 Sep to today (7 `design_review` on حسام, 6 `design_writer_review` on مريم) and turned the row's weight-3 `design_review` into a **3-day span (22→24 Sep)**. No history kept. |
| Originals recoverable? | **Yes, all 520 exactly**, from `mos_campaign_plans.plan->'reservations'` (the compiled plan stored at confirm, never mutated; keyed by content_key / row_key / step; per-plan counts match the table 115/135/135/135). All 13 re-dated rows recover to 21 Sep, including the row's. `mos_content_plan.stage_deadlines` are bounds (all five steps collapse to one date) — not booked dates, not used. (One tracer called the row's original "unrecoverable" because it looked only at stage_deadlines; the plan-JSON match, confirmed by both refuters, supersedes that.) |
| Ordering defects | 35 paid subjects have design planned *before* writing (100 R1_order pairs / 52 subjects among reserved rows; 72 immediate-predecessor). **0** reserved successors sit before a done predecessor's actual finish; **0** before an in-progress predecessor's due. Organic: 0. |
| Capacity | Writer مريم post 10, designer سارة post 7 (`mos_user_capacity` = `mos_step_rules` = `mos_role_load`). No leaves, no holidays, Friday off. Design is booked at exactly 7 on every ad-cadence day (Sat/Sun/Mon of each week); writing at 10 on five Mondays. |
| 22 Sep launch | All 6 launch creatives still **in design** on سارة (writing approved 20–21 Sep). Meta: 3 running campaigns, 6 active ad sets, **0 ads**. Organic: 6 Instagram publications `planned_at` 18:00–18:10 today, none yet booked to the publisher (`scheduled_at` NULL — that is normal until release). |

---

## 1. Planned handoffs and deadlines

**CONFIRMED.** Planned deadline = planned handoff time + step allowance (writing/design 24 h, reviews/approvals 12 h) on the working calendar; not end-of-day; coherent across the chain; targets only — actual handoff is when the predecessor finishes and approves. Early availability keeps the planned deadline. A late handoff gives the recipient the full allowance from actual receipt; the original target stays visible; publication risk is tracked separately; routine dispatch timing must not create misleading flags.

**What exists today [verified].** Every production step is booked as a *date* (`planned_start = planned_end`). The only intra-day times in the plan are publish instants (`mos_publications.planned_at`, 18:00 + 5-minute row gaps). `due_at` is set once at dispatch: `mos_work_due_at(clock_timestamp(), allowance)` — a fresh allowance from the dispatch moment, with no plan floor (e.g. P-477's design: planned 28 Sep, `due_at` 21 Sep 19:32). `mos_work_due_at` is the one calendar-aware clock (hours, skipping non-working days). `mos_perf_late_sweep` reads only `due_at`.

**CHOICE 1a — where planned handoff *times* come from.** The plan books days; it has no notion of the hour a step is handed over. I propose one data column, `mos_step_rules.target_hours` (planned turnaround, ≤ allowance), and a chain computed **by step order** (never by booked date) anchored on booked days:

```
handoff_1   = booked_day_1 at 00:00 Riyadh           -- day-start release
cand_k      = mos_work_due_at(handoff_{k-1}, target_{k-1})
handoff_k   = GREATEST(booked_day_k at 00:00, cand_k)
plan_due_k  = mos_work_due_at(handoff_k, allowance_k)
```
Proposed seeds (data, tunable): writing 4 h, writing_review 2 h, design 4 h, design_writer_review 2 h, design_review 2 h (Σ 14 h). Cross-day spacing comes from the booked days, intra-day order from the targets, Friday is skipped by `mos_work_due_at` in both hops. Rejected alternative: chaining handoffs by the *allowances* themselves — that makes a one-day row an 84-hour chain and flags feasible work as at risk. Rejected: an equal split of "a working day" — there are no working hours to split.

**Worked examples (computed):**

*Row, five steps booked Wed 23 Sep, publishes Thu 24 Sep 18:00:*

| step | planned handoff | allowance | planned deadline |
|---|---|---|---|
| writing | Wed 00:00 | 24 h | Thu 00:00 |
| writing_review | Wed 04:00 | 12 h | Wed 16:00 |
| design | Wed 06:00 | 24 h | Thu 06:00 |
| design_writer_review | Wed 10:00 | 12 h | Wed 22:00 |
| design_review | Wed 12:00 | 12 h | Thu 00:00 |

Projected ready (last handoff + its target) Wed 14:00; required-ready Thu 06:00; publish Thu 18:00 → on track with a day of slack. Handoffs strictly increase; deadlines are handoff + allowance, none is "end of day".

*Paid creative across days (live c0:s1 — writing/review/design booked 21 Sep, the two later reviews 22 Sep):* design_writer_review's chained candidate is 21 Sep 10:00 but its booked day is the 22nd → handoff 22 Sep 00:00, deadline 22 Sep 12:00; design_review handoff 22 Sep 02:00, deadline 14:00. The booked day wins when it is later; the chain never runs backwards even where the booked dates are inverted.

*Across Friday:* a 12-hour review handed off Thu 24 Sep 20:00 is due **Sat 26 Sep 08:00** (4 h to midnight, Friday contributes nothing, 8 h on Saturday). A successor booked Saturday after a Thursday 22:00 predecessor gets handoff Sat 02:00.

**CHOICE 1b — the enforced deadline.** Two columns on the task: `plan_due_at` (the planned deadline, immutable copy from the reservation) and `due_at` (what the person is held to):

```
due_at = GREATEST(plan_due_at, mos_work_due_at(assigned_at, allowance))   + approved-leave extension, as today
```
Early pickup → `plan_due_at` wins (deadline unchanged). On time → equal. Late handoff → full allowance from receipt. `plan_due_at` stays visible for tracking. `mos_perf_late_sweep` is unchanged: it already reads only `due_at`.

**CHOICE 1c — the "actual handoff" anchor is the assignment moment (`assigned_at`), for every step.** Not the predecessor's `closed_at` (a task that waited in a queue after its predecessor closed would inherit a past deadline and be flagged late the instant it arrives — the judge caught this in the alternative draft) and not `opened_at` (same failure: the 4 waiting writing tasks were opened 20 Sep). "When it became the person's" is the honest anchor; the GREATEST makes the choice irrelevant whenever the handoff is on time or early.

**Three separate measures, so routine timing cannot mislead:**
- *Employee lateness* = `closed_at > due_at`. Unchanged sweep.
- *Handoff slip* = `assigned_at − plan_handoff_at`, informational only (never disciplines).
- *Publication risk* = projected ready (current open step's actual handoff + Σ remaining targets, calendar-aware) versus required-ready and the publish instant → `on_track / at_risk / late`, recomputed on each handoff, stored on the task (`at_risk`, `risk_reason`). Replaces `mos_plan_repair`'s coarse at-risk that reads the collapsed `stage_deadlines`.

Check against your rule: the 00:00 sweep dispatches a planned step at ~00:05 → slip 5 minutes, due = plan, not at risk. A writer finishing within her allowance hands design over later than the 06:00 target → design's due = receipt + 24 h, `plan_due_at` still shown, risk recomputed from the real handoff (on track while projected ready ≤ required ready). A step that arrives so late the remaining chain cannot finish before publish → `at_risk`/`late` on the *publication*, the recipient's own deadline still fair.

---

## 2. Correcting the remaining schedule of the running month

**CONFIRMED.** Planned date is the first sort field; step position is fourth and repairs nothing. Execution order (design opens only after writing approval) is protected already, but the inverted **dates** drive wrong deadlines, priorities and risk flags and must be corrected. Preserve the original schedule as history; correct only remaining operational bookings; keep completed work and issued commitments; no rebuild or reconfirm.

**Root cause [traced, both refuters agree].** `src/lib/marketingOS/scheduling/schedule.ts:264-272` `effectiveDeadline()` returns the *later* of "own deadline" and "successor's start" where the comment (and the algorithm) need the earlier: `daysBetween(cap, r.deadline) < 0 ? cap : r.deadline` is `max`. Invisible while all steps of a same-day chain share one deadline; when capacity pushes a successor a day earlier, the predecessor is not pulled back with it. Only paid cycles saturate the designer, so all inversions are paid. One-line fix (`< 0 ? r.deadline : cap`) plus a test that saturates the designer and asserts monotone steps — no test guards this today.

**CHOICE 2a — one-shot correction, reserved rows only**, in one transaction under `mos_ledger_lock`, with the cron paused for the run:

1. **Preconditions asserted** (abort otherwise): kind-2 violations (reserved successor before a *done* predecessor's `closed_at`) = 0 and kind-3 (before an *in-progress* predecessor's `due_at`) = 0 — both are 0 today, proving this is a pure ordering repair. Multi-day reserved spans: exactly 1 (the repaired row `design_review`, 22→24 Sep) — collapsed to one day.
2. **Recover originals** into `planned_start_orig / planned_end_orig` from the plan JSON for all 520 (461 equal the live row; 13 differ — the repaired ones). Compute `planned_handoff_at_orig / planned_due_at_orig` from the original days with the §1 chain.
3. **Repack** (greedy, forward only): process subjects by (earliest remaining planned day, publish date, rank, key); steps in workflow order; for each reserved step, `floor = max(all predecessors' corrected days — or actual finish day for done ones —, own planned day, today)` advanced to a working day; if `floor` is later than the current day, move to the earliest working day ≥ floor where the assignee's booked weight in that bucket + this weight ≤ `mos_user_capacity.daily_slots` (booked = open tasks + reserved + already-moved rows; consumed reservations counted once, through their task). Never move a predecessor earlier; never move a non-violating step; organic rows are never displaced (0 in the dry run).
4. Write the result to `planned_start/planned_end` (operational booking) **and** to `*_corrected` columns; recompute `planned_handoff_at / planned_due_at`. Originals untouched. Three states are therefore distinguishable per row: recovered original, correction target, and any later repair.
5. Recompute publication risk; close the phantom `a588fc62`.

**Dry run (read-only, computed against the live rows this morning):**

| metric | value |
|---|---|
| Reserved steps moved | **116** of 474, across **52** subjects (design 32, design_writer_review 32, design_review 52) |
| Moves by distance | +1 day 64 · +2 days 32 · +3 days 20 |
| Driver | 72 direct ordering fixes + 44 capacity cascades (fixing a design onto its review day overflows سارة's 7 on 10 days: 27/28 Sep, 4/5, 11/12, 18/19, 25/26 Oct → spill forward) |
| Organic rows moved | 0 |
| Days over cap after correction | 0 |
| Subjects that cannot be repaired before publish | **0** |
| Subjects losing their ready-by buffer (ready *on* publish day) | 38 paid creatives + the 22 Sep row → flagged `at_risk` (publication), not employee lateness |
| Consumed / in-flight rows touched | 0 |

Representative rows:

| subject | step | original → corrected | reason |
|---|---|---|---|
| P-488 (paid c1, publishes 29 Sep) | design | 26 Sep → **29 Sep** (+3) | inverted + سارة full 27/28 |
| P-488 | design_writer_review | 28 Sep → 29 Sep (+1) | cascade |
| P-488 | design_review | 27 Sep → 29 Sep (+2) | inverted + capacity |
| a9f8 c2 s5 (unmaterialised, publishes 6 Oct) | design / design_review | 3 Oct → 6 Oct / 4 Oct → 6 Oct | inverted + capacity |
| 22 Sep row | design_review | 22→24 Sep span → 22 Sep | de-span |
| P-471…476 (launch) | writing / review / design | untouched | done or in flight |

**Issued commitments.** The 21 open assigned tasks keep their assignment and their `due_at` is never shortened: `due_at := GREATEST(current due_at, plan_due_at)`. Concretely: مريم's 3 writing tasks (planned 27/28 Sep, due today 14:00) become due **27/28 Sep 24:00** — they were handed out early and should never have been due today. حسام's 7 reviews likewise move to their planned deadlines. سارة's 6 launch designs keep today's 19:31–19:40 (their plan target, 21 Sep, is already past — the full allowance stands).

**Where the plan and the risk disagree, both are shown.** For the 38 buffer-losing creatives the day plan says "producible on publish day" (0 late) while a strict allowance chain would put final approval after publish. That is exactly the publication-risk signal, kept separate from lateness.

---

## 3. One process decides assignment

**CONFIRMED.** One process (refill) decides which task goes to which eligible person; the assignment function applies that decision with no admission policy of its own; no recursive refill; task creation inside refill only creates and binds.

**The call chain today [traced].** `mos_task_dispatch` does both jobs in one body: the holder pick with the capacity gate (`WHERE capacity_key IS NULL OR used+units ≤ daily_limit OR used = 0`, least-recently-assigned first) and the application (`UPDATE … assignee, assigned_at, due_at`, notify). It is reached from three places: `mos_dispatch_sweep` (per waiting task), `mos_perf_place_open_task` (alias), and the tail of `mos_plan_consume_reservation` — which is called by `workflow_role_path_start`, `workflow_advance_role_path`, `content_revise` **and `mos_campaign_plan_commit`** (assignment at commit). `mos_plan_start_due` also pre-gates starts with `mos_role_has_room`, which restates dispatch's predicate verbatim (redundant, not conflicting — the judge corrected my earlier "two conflicting policies" wording). The graph is acyclic today; the danger is the naive future wiring where an opener calls refill.

**CHOICE 3a — the split (all four behaviours land atomically in one migration):**

| function | role |
|---|---|
| `mos_task_open(subject)` — new | create the first-step task and bind its reservation (= `mos_plan_consume_reservation` minus its trailing dispatch); copies `scheduled_*`, `plan_handoff_at`, `plan_due_at`; **never assigns**. Guarded by the one-open-task index. |
| `mos_task_assign_apply(task, user, notify)` — replaces `mos_task_dispatch` | applies a decision: `FOR UPDATE` guard (open, unassigned, subject active, working day), sets assignee/`assigned_at`/`due_at` (§1b), notify. **The holder pick and the whole capacity `WHERE`, including `OR used = 0`, are deleted** — this answers your point that the earlier plan never said so explicitly. |
| `mos_refill(p_roles)` — new | the only decider (§4 for the lanes). One pass under `mos_ledger_lock`: release strays → open due subjects and refresh-cycle shells via `mos_task_open` → build the ordered candidate set → decide per task → `mos_task_assign_apply`. |
| `workflow_role_path_start`, `workflow_advance_role_path`, `content_revise`, `mos_campaign_plan_commit` | call `mos_task_open` (create + bind) then **request** a refill; they never dispatch. |
| `mos_plan_start_due` | opens due subjects/cycles via `mos_task_open`, then `mos_refill(NULL)`. The `mos_role_has_room` pre-gate and the second dispatch surface are removed. `mos_dispatch_sweep` becomes an alias so the cron endpoint is unchanged. |

**CHOICE 3b — no recursion, by construction and by guard.** `mos_ledger_lock` is `pg_advisory_xact_lock` — reentrant inside one transaction (verified empirically: two acquires, one lock row), so it cannot stop recursion. Two measures: (i) refill never calls anything that calls refill — it calls `mos_task_open`, which only creates and binds; (ii) a transaction-local flag: refill sets `mos.in_refill='1'`; an opener that runs *inside* a refill sets `mos.refill_again='1'` instead of calling refill; the outer refill drains once at the end. Decisions are made once per pass, after all candidates exist.

**CHALLENGE (your framing, not your conclusion):** the `OR used = 0` escape did **not** cause the 9-on-7 launch day — that was written at confirm (§6), a layer the dispatch gate never sees. It is still removed, because it lets the first task of a day exceed the cap on the dispatch path.

---

## 4. Optional early work, whole batch, one day

**CONFIRMED.** Work available to start early is distinct from work required now; offering it adds no mandatory workload and starts no countdown; the eligible early batch is selected once per refill — the whole ready batch of one future planned day, not the first task; blocked work on the earliest future day must not hide later executable work that exists only as reservations; starting early keeps the planned deadline.

**CHOICE 4a — representation.** An offered task is *opened and bound* (so it is visible with its plan dates) but **unassigned**: `assignee_user_id NULL`, `due_at NULL`, `waiting_reason='offered'`, new `offered_to_user_id` / `offered_at`. It appears in that person's «متاح للبدء مبكرًا» band. `mos_perf_late_sweep` ignores it (due_at NULL). **Refill never assigns an offered task on its own** — it becomes mandatory only when its planned day arrives, at which point it is simply that day's work. A person starts it explicitly (`task_start` → `mos_task_assign_apply`), and `due_at = GREATEST(plan_due_at, now + allowance) = plan_due_at`. (The judge rejected the alternative "unassigned pool that the next refill assigns when room frees" — that converts an offer into mandatory work.)

**CHOICE 4b — selection, once per refill, per (person, capacity key):**
1. *Mandatory lane* — every open task whose dependencies are met and whose planned day ≤ today is assigned (ordered by §4c). Planned work is not capacity-gated: the plan sized the day and the commit guard (§6) enforces that.
2. *Idle test* — the person has no open, non-blocked assigned task of that capacity key (open review tasks, uncapped, do not count).
3. *Early lane* — if idle: scan future planned days in order; the first day that has at least one **executable** item for this person (predecessor done and approved, or first step) is the batch day; offer **all** executable items of that day (materialising reservation-only subjects with `mos_task_open`), and no items from later days. Items of that day that are not executable stay visible in the plan view with the reason («بانتظار اعتماد الكتابة»). A day whose items are all blocked is skipped, so later executable reservation-only work is not hidden. The idle test is evaluated once, before the batch is materialised — the first offered task cannot cancel the rest.
4. *Unplanned work* (no reservation: revisions, legacy, `scheduling`, `publish_check`) — assigned when the person's open units of that key + this task ≤ `mos_step_rules.daily_limit` (read live), or they hold nothing. `mos_capacity_used` survives only here, redefined as open units (the 24-hour window is deleted).

**CHOICE 4c — the one ordering**, used by every path (a SQL function, never inline):
1. planned day of the task's own reservation (else the subject's earliest reserved step, else publish date) — **first**
2. `mos_subject_publish_at` ASC NULLS LAST (paid creatives get `target_publish_at = refresh_on`, so it is never NULL)
3. `mos_subject_publish_rank`
4. step position in the pinned workflow — **fourth**
5. `round`, `id` (stable tie-break)

Applied to today: مريم holds 3 open writing tasks → not idle → no early offer yet; the 4 waiting P-488…491 (planned 27 Sep) become **offered**, no countdown. When she finishes the 3, the earliest future day with executable writing is Wed 23 Sep (the Thu 24 batch) → offered whole; the 27 Sep set is not exposed until she is idle again and no earlier day remains.

**Tests (added to the CI fixture and run live after apply):**

| # | scenario | expected |
|---|---|---|
| E1 | Several paid creatives belong to the next planned day; some are executable, some await review | One refill offers every executable member of that day together; nothing from a later day; the non-executable members stay listed as blocked with reason |
| E2 | Person does not start the offered batch | No `due_at`, no `late_flag`, no `mos_late_events`, no change to `plan_due_at`; refill runs again → still offered, still unassigned; when its planned day arrives it is assigned as normal |
| E3 | Person starts the offered batch early | `assigned_at` = now, `due_at` = `plan_due_at` (unchanged); `at_risk` false |
| E4 | Earliest future day's items are all blocked; a later day has an executable reservation-only item | The later item is materialised and offered; the blocked earlier items remain visible with their reason |
| E5 | Person is not idle | No early offer, even with room |

---

## 5. Completion cannot be repeated

**CONFIRMED.** Bind completion to the specific expected task, or a unique completion event id validated under the lock; retries and concurrent duplicates must not complete the successor, advance twice, or duplicate assignments; the one-open-task index alone is insufficient.

**Traced.** `workflow_advance_role_path` selects **by subject**: `WHERE subject_table=… AND subject_id=… AND status='open' FOR UPDATE`, no task id, no event id. The SPA sends `task_id`; the API (`task_complete`, `row_task_complete`) pre-checks it non-transactionally, then calls the RPC with the subject only. Race: two requests both see X open → both enter → the lock serialises them → the first closes X and opens Y → the second re-selects "the open task for the subject" = **Y** and advances it. A content_id-only call reproduces it sequentially. `content_revise` takes no ledger lock; `workflow_role_task_transfer` appends its note on every replay. No idempotency table exists.

**CHOICE 5a.** Table `mos_completion_events(event_id uuid PK, task_id, subject_table, subject_id, result, outcome jsonb, created_at)`. `workflow_advance_role_path` gains required `p_task_id` and `p_event_id`; under `mos_ledger_lock`: (1) if `event_id` exists → return the stored outcome (replay); (2) `SELECT … WHERE id = p_task_id AND subject matches AND status='open' FOR UPDATE`; not found → `RAISE 'MOS:TASK_ALREADY_CLOSED'` — the successor is never touched; (3) the transition, `mos_task_open` for the next step, refill request; (4) insert the event as the last write (the PK backstops a concurrent duplicate with a different `task_id` check order). `content_revise` gains the lock and `p_event_id`; `workflow_role_task_transfer` gains `p_event_id` and short-circuits replays. API: `task_id` required (content_id-only rejected with 400), forwarded as `p_task_id`, plus a client uuid as `p_event_id` (generated once per user action in `client.ts` / `rowClient.ts`, reused across retries). Every caller of the RPC is audited before the parameters become required (API, `rowTasks.ts`, `releaseMaterial.ts`, worker, cron); a transition window logs loudly for callers still sending subject only.

Tests: sequential retry with the same event id → same outcome, one successor; concurrent duplicates → one advances, the other gets `TASK_ALREADY_CLOSED`, exactly one successor exists, no duplicate assignment; content_id-only → 400; the event row is absent if the transaction rolled back.

---

## 6. Migration and the capacity guard

**CONFIRMED.** Re-read the state (done, §0). Recover originals from verified records (the plan JSON, §0), distinguish corrected targets from recovered originals (§2 schema). Capacity guard inside the commit transaction under the shared lock, across every occupied day, counting tasks and consumed reservations exactly once. Provide a dry-run comparison.

**Why 9 landed on a 7-day [traced as far as the record allows].** The launch day's nine design units came from four plans committed in one `mos_campaign_plan_commit_month` call (organic row 3 + three paid plans × 2). Each per-plan check computes "proposed" from its own payload and "existing" from `mos_work_ledger_v` (no plan filter, same-transaction visibility). Two refuters proved the tempting story — "the row was spread per-day in the check and same-day in the ledger, under-counting by exactly 2" — is **not** established: the planner sets `spread='same_day'` for rows and the ledger keys same-day on `row_id`, so the last plan's check should have seen 7 + 2 = 9. The historical payload is not persisted, so the actual cause (most plausibly a deploy-skew between the API build and the DB function on 20 Sep) cannot be recovered read-only. The guard is therefore made structural.

**CHOICE 6a — the guard.** In `mos_campaign_plan_commit_month`, after `mos_ledger_lock()` and the snapshot-hash gate, **before** the per-plan loop: union all plans' reservations; same-day iff `row_key` is set (never the free-text `spread`); spread with `mos_spread_effort_mode`; for every (assignee, day, bucket) touched: `existing` (pre-commit) + `proposed` ≤ `mos_user_daily_slots`, and not on leave; else `RAISE 'capacity_conflict' USING ERRCODE='WS409'` with the offending cells. **Exactly once:** `existing` is `mos_work_ledger_v` and nothing else — it already counts open tasks (spread as the ledger does), reserved-unconsumed reservations, stale rows and manual tasks, and it *excludes* consumed reservations because their open task is counted instead. Summing "tasks + consumed reservations" on top would double-count; the spec says so verbatim. Reservations of plans this commit supersedes (same campaign, `proposed`/`approved`) are excluded so a re-preview → re-confirm does not false-positive. The same parity fix (`row_key`, not `spread`) goes into the per-plan check. The correction RPC (§2) runs the same guard at its end. Neither `assert_engine_conformance.sql` (static config equality) nor `mos_task_rules_audit` R2 (post-hoc, rolling 24 h — returns 0 for this incident because the dispatcher throttled) covers it; a new fixture does: (a) one plan with 6×1 + one row of 3 on a 7-slot day → WS409; (b) the real four-plan split → WS409; (c) a row labelled `per_day` with `row_key` set still counts 3 → WS409; (d) 7 on 7 passes.

**CHOICE 6b — migration, one transaction, cron paused, under the lock:**

1. Schema: `mos_step_rules.target_hours` (+ seed, CHECK ≤ allowance); reservations `planned_start_orig`, `planned_end_orig`, `planned_handoff_at_orig`, `planned_due_at_orig`, `planned_start_corrected`, `planned_end_corrected`, `planned_handoff_at`, `planned_due_at`; tasks `plan_handoff_at`, `plan_due_at`, `handoff_slip`, `at_risk`, `risk_reason`, `offered_to_user_id`, `offered_at`; `mos_completion_events`; a UNIQUE index on reservations over a normalised subject key (`COALESCE(content_id::text, row_id::text, cycle_id||':'||content_key)`, `step_key`, `round`) after a 0-duplicates assertion (0 today).
2. Recover originals for all 520 from `mos_campaign_plans.plan` (assert 520 matches; abort on any miss).
3. Functions: `mos_plan_chain`, `mos_publication_risk`, `mos_task_priority`, `mos_task_open`, `mos_task_assign_apply`, `mos_refill`, rewired `path_start / advance / revise / commit / start_due / repair`, guard in `commit_month`, `schedule.ts` fix deployed with it.
4. Correction (§2) with its preconditions; write `plan_*` onto the 21 open reservation-backed tasks; `due_at := GREATEST(due_at, plan_due_at)` (never shortened); the 4 waiting P-488…491 → `offered`; phantom closed; `target_publish_at = refresh_on` on the 21 paid shells.
5. `mos_plan_repair` rewritten: it no longer re-dates or re-spans; a passed plan day is simply due (§4) and sorts first; it keeps marking content-plan status from `mos_publication_risk`.
6. Run `mos_refill(NULL)` once; resume the cron.

**Dry-run comparison (what changes the moment it lands, from the live state):**

| who / what | now | after |
|---|---|---|
| مريم — 3 open writing (P-479/480/487) | due today 14:00 (dispatch + 24 h) | due 28/28/27 Sep 24:00 (planned); assignment unchanged |
| مريم — 4 waiting writing (P-488…491) | unassigned "capacity", invisible to her | **offered** (planned 27 Sep), visible, no countdown; mandatory on 27 Sep |
| مريم — 6 design_writer_review (repaired to today) | reservations only, plan day today | orig 21 Sep restored; materialise when each launch design is approved; then due = receipt + 12 h, `at_risk` on the launch creatives (handoff late vs plan) — no lateness on her |
| حسام — 7 writing_review | due today 02:54–10:34 | due 27/28 Sep 24:00 (planned); unchanged assignment |
| سارة — 6 launch designs + P-477 + row r2 | due today 19:31–19:40 / 18:50 | unchanged (plan target passed; full allowance stands); launch creatives flagged `at_risk` for publication |
| ريان — phantom P-135 | open since 5 Sep | closed (`skipped`, note) |
| 116 reserved steps / 52 subjects | inverted dates | corrected forward (§2 table); originals kept |
| 13 repair-moved reviews | 22 Sep (+ one 3-day span) | originals 21 Sep restored; corrected day = 22 Sep (overdue-by-plan, due lane); span removed |
| Early work offered today | — | مريم: none until her 3 are done, then the Wed 23 batch; سارة: none (8 open); حسام: none (7 open) |
| Publication risk | not surfaced per task | 22 Sep launch: 6 creatives at risk (design in progress, ads 12:00 today); 24 Sep row on track; 29 Sep: 11 creatives on track, P-488…491 ready on publish day → at risk; c2–c5: 34 at risk (buffer lost), 0 late |
| Capacity | dispatcher gate 10/7 rolling | planned work ungated (commit guard enforces the plan); unplanned work open-units ≤ 10/7 |

---

## 7. Verification scenarios (CI fixture + live acceptance after apply)

1. **Finish last current task → next batch offered, deadlines unchanged.** Writer closes her last open writing task; in the same transaction refill offers the whole executable batch of the earliest future day; each offered task has `assignee NULL`, `due_at NULL`, `plan_due_at` intact. Starting one sets `due_at = plan_due_at`.
2. **Earlier posts beat later ads.** A reservation-only organic row planned 23 Sep vs an existing paid text planned 27 Sep: the row is materialised and offered/assigned first; the text stays offered. Creation order is irrelevant.
3. **Design cannot start before approval.** With inverted dates in the plan, no design task exists until `writing_review` is approved; when it is, the design task is created and ordered by its corrected planned day.
4. **Blocked work does not idle anyone.** Designer's earliest task blocked → visible with reason, not counted, the next eligible task assigned/offered.
5. **Repeated completion.** Same event id twice → one advance; concurrent duplicates → `TASK_ALREADY_CLOSED` for the loser; content_id-only → 400; exactly one successor, one assignment.
6. **Late predecessor.** Predecessor approved two working days after plan → successor `due_at` = receipt + allowance, `plan_due_at` unchanged and visible, `handoff_slip` recorded, publication risk recomputed; no lateness on the recipient.
7. **New day not blocked by yesterday's hand-outs.** Ten units assigned yesterday 13:54, all done by 06:07; at 08:00 today the day's planned work is assigned. No 24-hour term exists.
8. **Revision ordered consistently.** `content_revise` round 2 with plan day 25 Sep sorts after round-1 work planned 23/24 Sep; admitted under the open-units rule; never jumps for being newest.
9. **No recursive refill.** An advance inside a running refill sets `refill_again`; one drain; task counts unchanged on a second refill.
10. **Repair preserves targets.** A reservation whose plan day passed and has no task: after `mos_plan_repair`, dates unchanged, task materialised as overdue-by-plan and sorted first.
11. **Commit guard.** Cases (a)–(d) above; and the correction RPC aborts on a synthetic overbook.
12. **Comparator fix.** The saturated-designer test passes; the same fixture through `mos_task_rules_audit` gives `R1_order = 0`.
13. **Migration idempotence and recovery.** Second run is a no-op; 520 originals recovered (13 differ from live); kind-2/kind-3 preconditions hold; `due_at` never decreased for any open task; consumed rows byte-identical.
14. **Deadline arithmetic.** The three worked examples of §1 reproduce from `mos_plan_chain`; the Friday case gives Sat 08:00.
15. **E1–E5** from §4.

Live acceptance after apply: `mos_task_rules_audit()` R1_order = 0 for reserved rows (only consumed history may remain), no open reservation-backed task with `due_at < plan_due_at`, the 4 offered tasks visible in مريم's page with 27 Sep, no task flagged late by the next sweep that was not already overdue.

---

## 8. Challenges to the six points (evidence)

- **"Repeated request could find and advance the successor" — correct, and worse than stated:** the API's id pre-check does not help a concurrent duplicate, and a content_id-only call double-advances sequentially. Fixed inside the RPC (§5), not at the API.
- **"Your plan says due planned tasks bypass the capacity gate but `mos_task_dispatch` still has it" — correct; fixed by deleting the function's admission block outright (§3), not by adding a lane around it.**
- **"Do not assume `stage_deadlines` can reconstruct originals" — correct, and unnecessary:** the compiled plan JSON holds every original booked date exactly; the one row an agent called unrecoverable is recoverable from it.
- **"Count tasks and consumed reservations exactly once" — agreed, with one precision:** the correct instrument is `mos_work_ledger_v` alone; adding consumed reservations to it would be the double-count.
- **The 9-on-7 was not a dispatch-path defect** (the dispatcher throttled to 7); the `OR used = 0` clause is removed for a different reason. The commit-time cause is not recoverable from the record; the structural guard closes it regardless.

---

## 9. Decisions I need from you

1. `target_hours` seeds (4/2/4/2/2) — accept, or set your own.
2. Offered work: unassigned with `offered_to` (proposed) vs pre-assigned with no deadline. Proposed keeps "offered" and "assigned" distinct on screen.
3. Planned work is not capacity-gated at dispatch (the plan and the commit guard are the cap) — confirm.
4. Publication risk verdict for the 38 buffer-losing creatives: judged by the day plan (feasible, at risk) — confirm.
5. Archiving content auto-closes its open tasks going forward (the phantom is closed either way) — yes/no.
6. Re-plan the running month to remove the inversions at source (optional): the correction above makes it unnecessary.
