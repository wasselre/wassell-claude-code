# Spec — Next-Action Backstop (sales task safety net)

**Status:** BUILT + tested on prod DB · deploy of the cron pending · **Date:** 2026-09-03
**Owner model(s):** `clients`, `followups`, `appointments` · **Runs on:** Vercel cron (daily 08:00 Asia/Riyadh)

## Build status (2026-09-03)
- **Migration applied to prod** (`supabase/migrations/2026-09-03_next_action_backstop.sql`): the
  `next_action_backstop_state` guard table + the `reconcile_stranded_clients(p_default_owner,
  p_grace_minutes, p_dry_run)` RPC. Dormant until the cron deploys — nothing calls it yet.
- **Cron endpoint** `api/cron/reconcile-stranded-clients.ts` + `vercel.json` cron `0 5 * * *`
  (05:00 UTC = 08:00 Riyadh). Not yet deployed.
- **Decisions locked:** grace **60 min** · cadence **once daily 08:00 Riyadh** · fallback **whatsapp_follow_up** · ownerless → **System Admin** default queue (`a3374d65`, resolved by the RPC).
- **Verified on prod (dry + live):** clean baseline finds 0 false positives; a re-stranded منيرة was
  detected with the correct `no_show_recovery_call` branch + appointment link + her real owner; the
  live run **reopened** her existing cancelled recovery call (not a duplicate — respects the
  `tg_records_dedup_noshow_recovery` rule), stamped `creation_source='next_action_backstop'`, cleared
  the cancel fields; a second same-day run correctly returned `skipped: already_ran_today`; the guard
  was reset to NULL for a clean production start.

---

## 1. Problem (verified, not assumed)

The sales-task lifecycle is driven by **two uncoordinated systems that do not share an invariant**:

1. **The Workflow engine** — now server-authoritative for `clients` + `followups` (enrolled
   2026-07-29/30; the browser skips these, the Fly worker executes them). It creates the *next*
   task, **but only when a record save matches a configured trigger + branch** (e.g. "follow-up
   completed with a specific outcome → create the next task"). A bare completion, or a completion
   whose outcome maps to no create-branch, produces nothing.

2. **Hand-written SQL trigger "bridges"** — `reconcile_outbound_whatsapp`, the supersede trigger
   (`records_supersede_followups`), no-show detection, and `clients_cancel_followups_on_retire`.
   These **cancel** tasks deterministically, outside the workflow engine. Most have **no paired
   step that creates a replacement**.

Destruction is server-side and unconditional. Creation is conditional on a matching branch.
**No layer owns the rule "an active client always has exactly one open next-action."** When a task
dies via a bridge, or via a completion with no create-branch, nobody is responsible for the
replacement. The only existing self-heal — `reconcile_inbound_whatsapp` ("live client, no open
task → make one") — fires **only on an inbound customer message**, so a client who goes quiet is
never repaired.

**Live evidence (2026-09-03):** client منيرة عبدالله no-showed an appointment; the system correctly
created a no-show recovery-call task, then auto-cancelled it when an outbound WhatsApp was sent, and
created no replacement. She sat as an active, non-retired, non-terminal client with **zero** open
tasks — nobody assigned to chase her. Sizing query: **1 of 134** active clients stranded at that
instant (a snapshot undercounts the true over-time rate, which today is unmeasurable).

## 2. The invariant this feature owns

> **Every *active* client has exactly one open next-action** — where "active" excludes terminal
> stages and retired clients, and a scheduled upcoming appointment counts as the client's
> next-action (so no task is forced on top of it).

## 3. Design

### 3.1 Where it runs
A **Vercel cron** (`api/cron/reconcile-stranded-clients.ts`, schedule `0 5 * * *` = 08:00 Riyadh)
calls the `reconcile_stranded_clients` RPC once per day. **Not** a synchronous DB trigger (a trigger
would race the workflow engine's legitimate next-task creation and duplicate — see 3.5). At a daily
cadence the workflow engine (seconds) has always already run by morning, so races are impossible and
the 60-min grace is belt-and-suspenders. Trade-off: a client stranded at 09:00 waits until the next
08:00 (~23 h) — accepted (morning-batch rhythm).

### 3.2 Selection predicate (a client is "stranded" when ALL hold)
- client model, `is_retired <> 'true'`
- `client_stage` NOT IN (`خاسر`, `مغلق ناجح`, `غير مؤهل`)
- **zero** follow-ups with status `open`/`in_progress`
- **no upcoming** appointment: no `appointments` row with `appointment_status` IN
  (`scheduled`,`confirmed`,`rescheduled`) whose `appointment_date` is today-or-future (Riyadh)
- has been in this state for **more than the grace window** (default **45 min**) — measured from the
  client's most recent follow-up `updated_at` (or client `updated_at` if none)

### 3.3 What task to create (decision table)
Owned by the client's `client_owner`; `scheduled_datetime` = now (Riyadh), so it surfaces in Due Now.

| Client's situation | Task created |
|---|---|
| Most recent appointment status = `no_show` | `no_show_recovery_call` (link `appointment_id`; **reopen** existing per 3.5) |
| Otherwise (incl. last-was-whatsapp and generic) | `whatsapp_follow_up` (operator-chosen fallback) |

### 3.4 Observability (required)
Every task the backstop creates carries `creation_source: 'next_action_backstop'`. This is the leak
counter: the count over time is the first-ever measurement of how often the happy path drops a task,
and the category tells us *where* — so upstream causes get fixed instead of the net running forever.

### 3.5 Safety / idempotency
- **Idempotent by construction** — the guard is "zero open tasks", so once it creates one the client
  no longer qualifies. No duplicates across passes.
- **Grace window prevents racing the workflow engine.** The engine creates the real next task within
  seconds of a save; the backstop only acts on gaps older than 45 min, so it never steps on a
  next-task that is legitimately coming.
- **no_show_recovery_call dedup (`tg_records_dedup_noshow_recovery`)**: this trigger returns NULL for
  a new recovery call if the appointment already has ONE (regardless of status). So for the no-show
  branch the backstop must **re-open the existing cancelled recovery call** (UPDATE) rather than
  INSERT a new one. (This is exactly how منيرة was fixed by hand: reopened `352335f9`.)
- **created_by must be a `public.users.id`, not `auth.uid`** (the server-runner FK lesson). Use the
  client's `client_owner` (already a public.users id) as both owner and `created_by`.
- Writing a `followups` row fires the capture trigger → a workflow job → the worker runs enrolled
  followups workflows on the insert/reopen. Verified low-risk (no create-triggered followups
  workflow interferes); call out in testing.

### 3.6 Scope boundary — what this does NOT fix
- **Unlinked chats** (conversation never tied to a client — the Sanjin case). No client ⇒ no task to
  attach; separate fix (reliable chat↔client linking / phone capture).
- **Wrongly-retired live clients** (ياسمين). Retire cancels tasks *by design*; the fault is the
  retire criteria + inbound-only un-retire. Separate fix (tighten retire, un-retire on outbound).

## 4. Data touched
- Reads: `records` (clients, followups, appointments).
- Writes: inserts/reopens `followups` rows only. No schema change. No writes to `clients` or
  `appointments`.

## 5. Rollout
1. **Dark / report-only** — run the selection pass, log the stranded set + intended task per client,
   create nothing. Gather the real rate for a week. (Doubles as the "size the leak over time" number
   we cannot get today.)
2. **Enable creation** behind a settings flag (kill switch: flip flag off → pass no-ops).
3. Watch `creation_source='next_action_backstop'` counts; drive them down by fixing the upstream
   causes they reveal.

## 6. Decisions (RESOLVED with operator 2026-09-03)
- Grace window: **60 min**.
- Cadence: **once daily, 08:00 Asia/Riyadh** (Vercel cron `0 5 * * *`).
- Generic fallback task: **whatsapp_follow_up**.
- Ownerless clients: **assign to the default queue = System Admin** (`a3374d65`; the RPC resolves the
  admin itself when `p_default_owner` is null). The report-only skip path is retained as a safety net
  for the case where no admin is resolvable.

## 7. Verification plan
- Unit: predicate correctness (terminal excluded, retired excluded, upcoming-appt excluded,
  grace-window respected).
- Live (disposable client): strand it → confirm one task created after grace, correct type/owner,
  `creation_source` stamped; run pass again → no duplicate.
- No-show branch: confirm it reopens the existing recovery call (dedup path), not a swallowed insert.
- Confirm no race: a fresh completion that the workflow engine will replace does NOT get a backstop
  task inside the grace window.

## 8. Plain language
Add one caretaker whose only job is to walk the customer list every few minutes and ask: *"Is this a
live customer, with no upcoming appointment, and not one open to-do?"* If yes — and only after a short
wait, so it never steps on a to-do the system was about to write itself — it writes one, pointing the
right rep at the right next step, and signs it so we can count how often the normal process is
dropping the ball. It does **not** fix conversations that were never tied to a customer file, or
customers wrongly filed as dormant — those are two smaller, separate fixes.
