# Briefing for the reviewing agent — Wassel Marketing OS task assignment redesign

You are being asked to **review an implementation plan** (`mos-plan-driven-assignment-plan-v2.md`) before anything is built. You have no prior context; this document gives you all of it. Your job is to find what is wrong, missing, unsafe or vague in the plan, with evidence. You are **not** asked to implement anything, and you must **not** write to the database or the repository while reviewing.

Files handed to you with this briefing:

| file | what it is | trust level |
|---|---|---|
| `01-plan-v9.md` | **The plan under review (v9, 22 Sep ~15:10).** v8 plus the seventh review's point: how the approval payload, hashtag composition and the built-text hash relate (§5f item 6), a truthful three-field build record, and two workflow choices named as such (decisions 23, 24); §0 lists it, §0b–§0f the earlier rounds. | Proposal |
| `01-plan-v8.md` | Kept for the line references in the seventh review. Superseded by v9. | Superseded |
| `01-plan-v7.md` | Kept for the line references in the sixth review. Superseded. | Superseded |
| `01-plan-v6.md` | Kept for the line references in the fifth review. Superseded. | Superseded |
| `01-plan-v5.md` | Kept for the line references in the fourth review. Superseded. | Superseded |
| `01-plan-v4.md` | Kept for the line references in the third review. Superseded. | Superseded |
| `01-plan-v3.md` | Kept for the line references in the second review. Superseded. | Superseded |
| `01-plan-v2.md` | Kept for the line references in the first review. Superseded. | Superseded |
| `05-review-resolutions.md` | First review's six re-verifications (evidence, contracts, skeletons, tests). Now carries a governing banner and inline `⚠ SUPERSEDED` markers where it conflicts with v4. | Verified facts; skeletons illustrative |
| `06-review-2-resolutions.md` | Second review's six re-verifications, the 05-vs-v3 reconciliation scan, and twelve adversarial refutations (two lenses per resolution). Banner lists which skeleton parts the refuters overturned. | Verified facts; skeletons illustrative |
| `wassel-mos-scheduling-brief-paired.md` | Technical description of the system as it is, each section in technical and plain language, with the verbatim SQL bodies of 18 live functions and the planner's TypeScript excerpts (as of 21 Sep). | Verified facts + verbatim code |
| `wf2_findings.md` | Findings of the second audit (22 Sep): five tracers, each finding tagged CONFIRMED (survived two independent refuters), CONTESTED (a refuter corrected it — the correction is included), INFERRED or COULD_NOT_DETERMINE. | Read the tag before trusting a line |
| `wf2_tables.md` | The live-state tables from 22 Sep 08:12 Riyadh: every open task, the repaired reservations, the recovery matrix, capacity, per-day load, the correction dry run, SQL skeletons. | Measured |

---

## 1. The product and the people

Wassel (وصل العقارية) is a Saudi real-estate marketing company. Its CRM has a **Marketing OS** module (`/m`) that plans and produces one month of social-media posts and Meta ads for three real-estate projects at a time. The production team is tiny and every role has exactly one holder:

- **مريم** — the only writer (role key `writer`)
- **سارة** — the only designer (role key `montage`)
- **حسام** — the marketing manager, who approves (`marketing_manager`)
- **The operator** (the person who will read your review) plans the month and owns the rules.

Every post and every ad goes through the same pinned workflow (version 9 of the `post` content type):

```
writing (writer, 24 h) → writing_review (manager, 12 h) → design (designer, 24 h)
→ design_writer_review (writer, 12 h) → design_review = final approval (manager, 12 h)
→ scheduling (writer) → publish_check (ops)
```
The first five are **production steps**; the hours are **response allowances** — the time a person has once work is handed to them. They are not processing durations: people usually finish faster.

Units of work: an **organic row** is one batch of three posts written and designed together — one task worth **3 units**. A **paid creative** (an ad) is one task worth **1 unit**. Capacity per person per day: writing 10 units, design 7 units (stored in three places that must agree: `mos_step_rules.daily_limit`, `mos_role_load`, `mos_user_capacity.daily_slots`). **Friday is the only non-working day**; there are no working hours — the system runs on a 24-hour clock skipping Fridays (`mos_work_due_at`).

## 2. The two subsystems, and the gap between them

**The month planner** (TypeScript: `api/_lib/marketing/planning/monthCompiler.ts`, engine in `src/lib/marketingOS/scheduling/`) runs once when the operator compiles and confirms a month. It decides which posts and ads exist, which day each publishes, and — by **backward scheduling** from each publish date against a capacity ledger — the **person and day** of every production step. At confirm it writes one row per (subject, step) into `mos_task_reservations` (`planned_start`, `planned_end`, `weight`, `assignee_user_id`). This month has 520 such rows (104 subjects × 5 steps). It also stores the compiled plan as JSON in `mos_campaign_plans.plan`, which is never modified afterwards — that is where original dates can always be recovered.

**The dispatcher** (Postgres functions: `mos_task_dispatch`, `mos_dispatch_sweep`, `mos_plan_start_due`, `mos_capacity_used`, `mos_plan_consume_reservation`, `workflow_role_path_start`, `workflow_advance_role_path`, `mos_plan_repair`) runs every 10 minutes from a Vercel cron (`/api/cron/planning-sweep`), at confirm, and on every task completion. It creates tasks in `workflow_role_tasks` (one open task per subject, enforced by a unique index), hands them to people, and sets deadlines.

**The gap:** since 17 Sep the dispatcher **does not read the planner's days**. Its rule is "start anything that is ready, give it to whoever has room, in publish order; the plan's dates are a forecast". Deadlines are `dispatch moment + allowance`. The planner's dates are copied onto the task (`scheduled_start/end`) and read by nothing.

## 3. What happened (timeline)

- **17 Sep** — two assignment systems disagreed; the plan's dates were visibly wrong (design booked before writing). A new single dispatcher was built with the rule "capacity decides when; deadlines from receipt; plan dates are a forecast". Capacity was defined as *units received in a rolling 24 hours, finished or not*. The operator was told "capacity decides when" and did not understand that the days they approve would no longer be used. That is the root of everything that followed.
- **Sun 20 Sep 13:54** — the operator confirmed September (stretched through October as one plan; first posts Tue 22 Sep). The dispatcher immediately created 21 paid creatives' tasks (their production windows had already opened) and handed مريم 10 units; 14 more writing tasks went into an invisible "waiting for capacity" state.
- **Mon 21 Sep 06:07** — مريم had finished all 10. The counter still said 10/10 until 13:54, so she sat idle ~8 hours while 14 tasks waited. Meanwhile next week's ad texts (planned 27–28 Sep) were queued ahead of this week's organic batch (planned 23 Sep), because already-waiting tasks are served before new ones are started. The operator asked why.
- **21 Sep 10:00–10:23** — the previous assistant (me) built and applied a capacity variant without being asked ("finish everything → next batch, due 24 h from now"). It handed her next week's texts with a 22 Sep deadline. The operator rejected it ("it changed the date") and it was fully reverted. Lesson recorded: the planned date is the thing to keep; deadlines must come from the plan, not from the hand-out moment.
- **21 Sep 14:00** — the old rule handed her the 10 texts anyway (due 22 Sep 14:00). She submitted 7 by 22:34. The designer received the launch designs late that evening and has finished none by this morning.
- **22 Sep 00:00** — `mos_plan_repair` re-dated 13 reservations whose day had passed to "today", capacity-blind, with no history (one became a 3-day span). The 22 Sep ad launch has 0 ads on Meta because all six creatives are still in design.
- **22 Sep** — the operator fixed the operational rules (§5 below) and asked for the revised plan you are reviewing.

## 4. The verified defects (what the plan is fixing)

All of these were traced in the live function bodies and data, and each survived two independent refuters unless noted. Details and evidence in `wf2_findings.md`.

1. **Capacity counts finished work.** `mos_capacity_used` sums units by `assigned_at` in the trailing 24 h, any status. A fast worker is idle until the timestamps age out.
2. **Deadlines are receipt-relative.** `due_at = mos_work_due_at(clock_timestamp(), allowance)` at dispatch; no plan floor; early hand-out shortens the deadline, late hand-out gives a fresh one with no visible target. The task's `scheduled_start/end` (plan dates) are write-only.
3. **Assignment is decided in several places.** `mos_task_dispatch` both picks the holder (with the capacity gate, including an `OR used = 0` escape that admits any size) and applies the assignment; it is called inline from `workflow_role_path_start`, `workflow_advance_role_path`, `content_revise`, `mos_campaign_plan_commit` (via `mos_plan_consume_reservation`) and the sweep. Only the sweep orders tasks; inline calls bypass ordering. `mos_role_has_room` restates the same predicate (redundant, not conflicting).
4. **No refill on completion.** The only trigger on close awards XP; refill waits for the 10-minute cron.
5. **Start triggers are inconsistent.** Organic rows start when there is room (no date gate); paid creatives start when the cycle's 12-day window opens; the sweep serves already-waiting tasks before starting new ones. Paid creatives have no `target_publish_at` (NULL), so they cannot be date-ordered against posts.
6. **The planner inverts dates.** `schedule.ts:264-272` `effectiveDeadline()` returns `max(cap, deadline)` where the comment and the algorithm require `min`. Harmless while every step of a same-day chain shares one deadline; when capacity pushes a successor a day earlier, its predecessor is not pulled back. All 35 inverted subjects are paid (only they saturate the designer). No test guards step order.
7. **A real overbooking passed the commit guard.** 9 design units on سارة for 21 Sep against a cap of 7, written at confirm across four plans in one transaction. The tempting explanation (a row spread per-day in the check, same-day in the ledger, under-count of exactly 2) was **refuted** by both reviewers; the true cause is not recoverable from the record (the confirm-time payload is not stored). The plan therefore makes the guard structural rather than fixing a theory.
8. **Repair silently moves dates.** `mos_plan_repair` re-dates any unconsumed reservation whose day passed to today, keeps no history, and can turn a one-day booking into a multi-day span. Fired this morning on 13 rows.
9. **Waiting work is invisible to its owner.** The queue API filters out the owner's waiting rows; the "coming to you" strip excludes the owner's own role; the per-person planned forecast is shipped in the payload and rendered nowhere.
10. **Completion is subject-bound, not task-bound.** `workflow_advance_role_path` selects "the open task for this subject". After one advance that is the successor, so a concurrent duplicate or a content-id-only retry advances the workflow twice. The API's non-transactional id pre-check narrows but does not close this. `content_revise` takes no ledger lock; `workflow_role_task_transfer` appends its note on every replay.
11. **`mos_ledger_lock` is a reentrant advisory transaction lock.** It serialises sessions; it cannot stop a function from re-entering itself within one transaction. The current call graph is acyclic; a naive "refill calls opener calls refill" would loop.
12. **A phantom task** (design, on content archived 16 Sep, assigned to a non-holder since 5 Sep) can never be cleared by any engine path.

## 5. The operator's confirmed rules (requirements — not open to challenge)

Quoted from the operator on 22 Sep:

- Everyone receives their normal scheduled work automatically when its dependencies are satisfied.
- After finishing their current work, the next ready batch becomes available **optionally**. Finishing early does not create extra mandatory work.
- Making future work available, or starting it early, must not change its planned deadline.
- Downstream steps have planned deadlines; actual readiness depends on completion and approval of earlier steps.
- Late handoffs give the recipient their full response allowance. The original plan target remains visible; publication risk is tracked separately from employee lateness.
- Planned deadline = **planned handoff time + step allowance** (writing/design 24 h; reviews/approvals 12 h), on the working calendar. Not end-of-day. Handoffs and deadlines coherent across the chain; they are targets — actual handoffs happen when predecessors finish. Routine dispatch timing must not generate misleading lateness or publication-risk flags.
- Priority: **planned date first**, then publish date, then rank, then workflow step position **fourth**. Step position does not repair inverted dates; the dates must be corrected.
- **One process** makes assignment decisions (refill); the assignment function applies them without a conflicting admission policy. No recursive refill: task creation inside refill only creates and binds; assignment decisions are made once.
- Early work: distinguish "available to start early" from "required now"; offering must not increase today's mandatory workload or start a countdown; select the early batch **once per refill** — the **whole** ready batch of **one** future planned day; blocked work on the earliest future day must not hide later executable work that exists only as reservations.
- Completion bound to the specific expected task, or a unique completion event id validated under the transaction lock; retries and concurrent duplicates cannot complete the successor, advance twice, or duplicate assignments; the one-open-task constraint alone is insufficient.
- Migration: re-read current state first; recover original reservation dates from verified records (never assume `stage_deadlines` equals booked dates); distinguish corrected targets from recovered originals; capacity guard inside the commit transaction under the shared lock, validating existing workload plus new bookings across every occupied day, counting tasks and consumed reservations exactly once; provide a dry-run comparison.
- Preserve: the 24 h / 12 h allowances, the working calendar, role eligibility, opt-outs; read capacity from the live tables; a row stays one task of three units. Backward scheduling is not inherently wrong.

## 6. What the plan proposes (summary; the file has the detail)

1. **Deadline model.** A per-step planned turnaround `target_hours` (data; proposed 4/2/4/2/2 h) chains planned handoff **times** by step order, anchored on each step's booked day at 00:00; planned deadline = handoff + allowance via `mos_work_due_at`. Enforced `due_at = GREATEST(plan_due_at, assigned_at + allowance)`; `plan_due_at` kept as a separate immutable column; anchor is the **assignment moment**, never the predecessor's `closed_at` or the task's `opened_at` (both would manufacture lateness for queued work). Three separate measures: employee lateness (`due_at`), handoff slip (informational), publication risk (projected ready vs required-ready vs publish, recomputed per handoff). The late sweep is unchanged.
2. **Correction of the running month.** One-line fix of the comparator + a regression test. A one-shot transactional correction of **reserved rows only**: originals recovered from the plan JSON into `*_orig` columns, successors moved forward (never predecessors), within capacity, non-violating steps untouched, results written to the live booking and to `*_corrected`. Dry run: 116 steps / 52 subjects, 0 organic, 0 over cap, 0 unrepairable, 38 creatives lose their buffer → publication risk. Issued deadlines are never shortened (`GREATEST(due_at, plan_due_at)`).
3. **One decider.** `mos_task_dispatch` → `mos_task_assign_apply` (admission block and holder pick **deleted**, including `OR used = 0`). New `mos_task_open` creates + binds only. New `mos_refill` decides everything in one pass; openers request a refill through a transaction-local flag (`mos.in_refill` / `mos.refill_again`) rather than calling it; `mos_role_has_room` pre-gate removed; `mos_dispatch_sweep` becomes an alias; the commit stops assigning at confirm.
4. **Optional early work.** Offered tasks are opened + bound, **unassigned** (`offered_to_user_id`, `due_at NULL`); refill never auto-assigns them; they become mandatory only when their planned day arrives; explicit start gives `due_at = plan_due_at`. Batch = all executable items of the earliest future day with any executable item, chosen once per refill after a single idle test per (person, capacity key). Planned work is not capacity-gated at dispatch (the plan and the commit guard are the cap); unplanned work (revisions etc.) uses an open-units limit.
5. **Idempotent completion.** `mos_completion_events(event_id PK, …)`; `workflow_advance_role_path` gains required `p_task_id` + `p_event_id`; replay returns the stored outcome; a closed task raises `MOS:TASK_ALREADY_CLOSED` without touching the successor; `content_revise` takes the lock; transfer gets a replay guard; the API rejects content-id-only completions; the SPA generates one uuid per user action.
6. **Migration + guard.** One transaction under the lock with the cron paused: schema, originals for all 520, functions, correction, `due_at` never shortened, the 4 waiting tasks → offered, phantom closed, `target_publish_at = refresh_on` on paid shells, repair rewritten to never re-date, one refill. Commit guard: whole-month union across all plans before any insert, same-day keyed on `row_key` (never the free-text `spread`), `existing` = `mos_work_ledger_v` **alone** (it already counts open tasks + unconsumed reservations + stale + manual and excludes consumed reservations — adding them would double-count), superseded plans excluded, `WS409 capacity_conflict`. New CI fixture with four cases.

## 7. What I want you to check hardest

1. **The `GREATEST` deadline rule and its anchor.** Construct a case where `GREATEST(plan_due_at, assigned_at + allowance)` still produces a misleading late flag or removes a fair allowance. Consider a task offered early, started late; a task whose plan day passed while it waited for its predecessor; a step after Friday; a blocked-then-unblocked task (unblock shifts `due_at` by the pause).
2. **Publication risk arithmetic.** With targets 4/2/4/2/2 and a row on one day, does the "projected ready" ever say on-track for a chain that cannot really make 18:00? Does anchoring the forecast on the current open step's *assignment* moment hide a predecessor that is late but still open?
3. **The correction algorithm.** Forward-only, never move a predecessor, capacity per (assignee, day, bucket) with consumed reservations counted once through their task: can it produce a step *after* its subject's publish date without reporting it? Does "process subjects by earliest remaining planned day" match the operator's priority rule? Multi-day steps: only one exists (a repair artifact); is collapsing it correct?
4. **Recursion and the flag.** `mos.in_refill` via `set_config(…, true)` is transaction-local. Is there a path where two refills run in different transactions on the same rows without the advisory lock serialising them? Is there a path where the outer refill finishes without draining `refill_again`?
5. **Idempotent completion.** Two concurrent completions with *different* event ids for the same task: the second must get `TASK_ALREADY_CLOSED`. Where exactly does the event row get inserted relative to the transition, and what happens on rollback? Are there callers of `workflow_advance_role_path` the plan did not list (the plan names API, `rowTasks.ts`, `releaseMaterial.ts`, worker, cron — verify with a grep)?
6. **Exactly-once capacity accounting.** Read `mos_work_ledger_v` (`pg_get_viewdef`) and confirm it really excludes consumed reservations and spreads open tasks the way the commit check assumes. Confirm the superseded-plan exclusion cannot exclude live reservations.
7. **The early-batch semantics.** "Idle test evaluated once, before materialising": is it per (person, capacity key) or per role? What happens when the earliest future day has an executable item for the writer but the batch's other members belong to the designer? Does "one day" mean one calendar day of the *person's* reservations?
8. **Migration ordering.** The cron (`/api/cron/planning-sweep`, every 10 min) calls `mos_plan_start_due` then `mos_plan_repair`; the plan says pause it. Verify there is a way to pause it (there is no flag today), or that running the migration inside one transaction under `mos_ledger_lock` is sufficient because repair also takes the lock. Verify the recovery from the plan JSON keys every one of the 520 rows uniquely (content_key / row_key / step / cycle).
9. **CI and house rules.** `supabase/tests/ci/assert_engine_conformance.sql` asserts the three capacity tables agree; the plan changes what the dispatcher's limit *means* (open-units ceiling for unplanned work only). Say whether that test's contract still holds or must be restated. No function may raise SQLSTATE `40001`/`40P01` (PostgREST retries those forever — see CLAUDE.md); check every new `RAISE`.
10. **Scale of change.** Is anything in the plan avoidable while still meeting all the confirmed rules? Is anything missing that the rules require (e.g., the UI must show offered work and plan dates — is that scoped)?

## 8. How to verify things yourself (read-only)

- Repository worktree: `C:/Users/rayan/Claude/wassell-claude-code/.claude/worktrees/2/.claude/worktrees/campaign-scheduling-audit-57ffa2`. Key paths: `api/_lib/marketing/planning/*`, `src/lib/marketingOS/scheduling/*`, `api/marketing-os.ts` (queue API), `api/cron/planning-sweep.ts`, `src/pages/Marketing/WorkPage.tsx`, `supabase/migrations/2026-09-17_0*.sql` (the dispatcher's migrations — but the **live bodies** may differ; always read them from the database), `supabase/tests/ci/*`.
- Live database (read-only RPC; refuses writes; `EXPLAIN` refused):
  `cd C:/Users/rayan/Claude/wassell-claude-code && node "C:/Users/rayan/AppData/Local/Temp/claude/C--Users-rayan-Claude-wassell-claude-code--claude-worktrees-2--claude-worktrees-campaign-scheduling-audit-57ffa2/e6d07d9c-c374-428a-acb4-cd7cd7d9ecc9/scratchpad/sql.mjs" "<ONE SQL STATEMENT>"` — prints a JSON array. Redirect to a file and read it with Python using UTF-8 (Arabic breaks the Windows console). Do not alias a column as bare `day`.
- Function bodies: `SELECT pg_get_functiondef('public.<name>'::regproc)`. Views: `pg_get_viewdef`.
- Tables: `workflow_role_tasks`, `mos_task_reservations`, `mos_campaign_plans` (column `plan` jsonb), `mos_content`, `mos_content_rows`, `mos_content_plan`, `mos_refresh_cycles`, `mos_creative_slots`, `mos_step_rules`, `mos_user_capacity`, `mos_role_load`, `mos_publications`, `mos_leaves`, `mos_holidays`, `mos_auto_assign_opt_out`.
- Existing tests you may run read-only: `npx vitest run src/lib/marketingOS/scheduling/__tests__/…`.
- Count open work by `status='open'`, never by `closed_at IS NULL` (60 legacy August rows are `skipped` with a NULL `closed_at`).

## 9. Constraints on the eventual implementation (from the repo's CLAUDE.md) that your review should respect

- Never raise SQLSTATE `40001` or `40P01`; use `WS409` for conflicts, `WS429` for rate limits.
- No silent `try/catch`; failures surface loudly.
- Migrations are written under `supabase/migrations/` and applied to production by the assistant in the same session, then verified live.
- Work over ~200 lines is written by a separate coder from a spec and reviewed; below that, done directly.
- Bilingual UI (Arabic first), RTL; no hard-coded strings in JSX.
- Every user-facing change updates the PRD in `docs/prd/`.
- Everything must be tested before it is called done; a fix that exists only in chat is not a fix.

## 10. Open decisions the operator has not yet answered

1. `target_hours` seeds (4/2/4/2/2).
2. Offered work as unassigned with `offered_to` (proposed) vs pre-assigned with no deadline.
3. Planned work not capacity-gated at dispatch (proposed).
4. The publication-risk verdict for the 38 buffer-losing creatives is the day-plan view (at risk, not late).
5. Whether archiving content should auto-close its open tasks going forward.
6. Whether to re-plan the running month at source (proposed: no; the correction suffices).

If your review depends on one of these, say which and review both branches.

## 11. What a good review looks like

For each of the six points: (a) does the plan meet the confirmed rule exactly, (b) what would break it, with a concrete input and the line of code or SQL that shows it, (c) what is missing or vague enough that an implementer would have to guess. Then a ranked list of the changes you would require before implementation. Quote evidence; label anything you inferred; do not repeat the plan back.
