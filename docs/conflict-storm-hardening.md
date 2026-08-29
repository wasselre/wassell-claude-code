# record_save conflict-storm hardening — architecture + operator runbook

_Last updated: 2026-08-29._

This is the source-of-truth doc for the `record_save` version-conflict "storm"
defense. A storm is a client (historically a stale browser tab) retrying
`record_save` with a wedged `p_expected_version`, so every call fails the version
check (`version_mismatch`, SQLSTATE `40001`) and the tab retries forever —
~1,000–1,700 failed saves/sec, which pins Postgres on per-request overhead.

**Do not add another mitigation layer without real evidence the current ones are
insufficient.** The layers below were built and verified live on 2026-06-21.

Code / migrations:
- `supabase/migrations/2026-06-16_conflict_storm_watchdog.sql` (original watchdog + kill helper)
- `supabase/migrations/2026-06-21_conflict_storm_hardening.sql` (telemetry, rate sweep, per-record block, auto-throttle, candidates)
- `supabase/migrations/2026-06-21_conflict_storm_layer3_session_ratelimit.sql` (per-session block)
- `src/lib/staleBuild.ts`, `src/hooks/useAppVersionPoller.ts`, `src/components/UpdateBanner.tsx` (forced stale-build reload)
- `src/stores/appStore.ts` → `supabaseRecordUpsert` (breaker, write-lockout, `record_conflict_report` call)
- `src/lib/conflictBreaker.ts` (per-record breaker state machine incl. the 2026-08-29 absolute conflict cap — see §6)
- `worker/src/index.ts` → `runConflictStormSweep` (calls the sweep every 30s)

---

## 1. Architecture

### 1.1 Conflict telemetry (every `version_mismatch`)

`record_save` emits, on each conflict (durable: `RAISE LOG` survives the txn
abort — an in-DB table can't, because the conflict path `RAISE`s and rolls back):

```
record_save_conflict v2 record=<uuid> model=<uuid> user=<auth.uid> session=<jwt session_id>
  role=<authenticated|service_role> tab=<x-wassel-tab> build=<x-wassel-build>
  expected=<vN> current=<vM> ip=<x-forwarded-for> client=<x-client-info>
  referer=<page url> path=</rpc/record_save> ua=<user-agent>
```

The raised ERROR also carries `[record=… model=… user=… session=… role=…]`.

- `session`, `role` come from `request.jwt.claims` (unspoofable by page JS).
- `tab` / `build` come from headers the browser client sets (`src/lib/supabase.ts`):
  `x-wassel-tab` (per-tab uuid, stable for a tab's life) and `x-wassel-build`
  (the bundle's git SHA). An **outdated `build=`** is the signature of a
  never-reloaded tab; the same `tab=` across a storm pins it to one tab.
- **Caller discrimination:** `role=authenticated` + browser `ua`/`referer`/
  `x-client-info=supabase-js-web` ⇒ the **browser SPA save path** (the only path
  that can sustain a storm). `role=service_role` + no browser headers ⇒ a
  server/worker/automation/AI-agent caller (these pass `p_expected_version=NULL`
  or retry-resolve and cannot storm).

### 1.2 Per-record block

- Table `record_save_blocks(record_id, model_id, blocked_until, reason, created_by)`.
- `record_save` checks it as the **first** statement (one PK probe). If blocked →
  terminal raise `conflict_storm_blocked` (ERRCODE `40001`, so the client's
  existing reload/breaker path handles it).
- **Auto-set** by `record_conflict_report(record_id)` — which the browser
  fire-and-forgets on every conflict — once one `(record, session)` exceeds
  **8 conflicts / 15s** → blocks that record for **5 min** + a
  `conflict_auto_block` `system_alerts` row.
- **Ops-set/cleared:** `block_conflict_storm_record(id, minutes, reason)` /
  `unblock_conflict_storm_record(id)`.

### 1.3 Per-session block

- Tables `session_save_blocks(session_id, blocked_until, …)` +
  `session_conflict_counters(session_id, window_start, count)`.
- `record_save` checks `session_save_blocks` for the caller's JWT `session_id`
  **before** the per-record check. If blocked → terminal `conflict_storm_blocked`
  for **all** saves from that session.
- **Auto-set** by `record_conflict_report`: a session exceeding **25 conflicts /
  30s across records** is blocked for **10 min** + a `conflict_session_block`
  `system_alerts` row. (Per-IP was rejected as the key: office NAT shares one IP
  across legit users → false positives. IP is still captured in telemetry.)

### 1.4 Forced stale-build reload (the cap on non-cooperating old bundles)

`src/lib/staleBuild.ts` + `useAppVersionPoller` + `UpdateBanner`:

- The poller compares the tab's baked-in `__BUILD_VERSION__` against
  `/api/version` every 60s (when visible). On mismatch the tab is **outdated**.
- On outdated: arm a **90s** forced-reload deadline, then **force a reload
  regardless of tab visibility** (the prior behavior only auto-reloaded *hidden*
  tabs, so a stale visible/storming tab lingered for days — that was the gap).
- **Protect unsaved work:** `UpdateBanner` shows a live countdown + a "save now"
  warning; a `beforeunload` native prompt fires only when a form is dirty (forms
  register via `setFormUnsaved`).
- **Stop a storming stale tab early:** if a stale tab also trips the client storm
  breaker, `appStore` calls `lockStaleBuildWrites()` — saves then short-circuit
  terminally and **non-silently** (`status:'conflict'`, the form keeps the
  edits) and the reload is pulled in.
- **Self-propagating:** any tab on an old build reloads itself within ~60s of its
  next poll after a deploy. This is what actually removes non-cooperating bundles.

### 1.5 Rollback-rate sweep (autonomous detection)

- `conflict_storm_sweep()` measures `pg_stat_database.xact_rollback` delta/sec
  between calls (snapshot in `conflict_sweep_state`). A storm is **≥75
  rollbacks/sec** (normal load is <~10; a storm is hundreds–thousands). Every
  failed save aborts its txn → increments `xact_rollback`, so this is unmissable.
- The Fly worker (`runConflictStormSweep`) calls it every **30s**; on a storm it
  inserts a `conflict_storm` `system_alerts` row (deduped to one per 10 min) +
  logs loudly + optionally pings `CONFLICT_ALERT_WEBHOOK_URL`. Returns
  `{ storm, rollback_rate, aborted, active, alert_id }`.
- **Why rate-based:** the 2026-06-16 detector sampled an instantaneous
  `idle in transaction (aborted)` count, which lasts microseconds — it missed a
  live 1,700/s storm for days (`system_alerts` stayed empty). Do not revert to
  sampling a short-lived state.

### 1.6 Known limitation (by design, not a gap to "fix")

**There is no edge we own in front of `record_save`.** The browser calls
PostgREST directly (`https://<project>.supabase.co/rest/v1/rpc/record_save`);
managed Supabase exposes no per-RPC rate-limit knob, and a Vercel proxy wouldn't
help (an outdated bundle bypasses it). Also, a non-cooperating client's
*conflicting* calls cannot be durably counted in-DB — the conflict path `RAISE`s,
which rolls back any write, and `dblink` autonomous-commit needs an embedded DB
password we will not ship.

Therefore: the per-record / per-session auto-blocks are **client-cooperative**
(fed by `record_conflict_report`), the sweep is the **autonomous detector**, and
**forced stale-build reload (§1.4) is what closes the non-cooperating hole** — it
removes old bundles instead of trying to rate-limit them. The DB blocks still
keep every blocked call a cheap terminal reject.

Token-TTL note: shortening the Supabase JWT TTL would reduce how long a
revoked/stale session persists, but it affects every user (forced reauth,
background failures, support noise) — **left as-is on purpose.** Do not change
auth/session policy casually.

---

## 2. Operator runbook

### 2.1 Identify a storm

A storm does **not** show in the API/edge logs or `pg_stat_statements` (failed
saves aren't recorded there) — that's the classic trap. Use:

```sql
-- Authoritative: current rollback rate (run twice; the worker also calls this every 30s)
SELECT public.conflict_storm_sweep();           -- { storm: true, rollback_rate: <N/s>, ... }

-- The alert feed (auto-raised by the worker within ~60s of a storm)
SELECT id, kind, severity, created_at, detail
FROM public.system_alerts
WHERE kind IN ('conflict_storm','conflict_auto_block','conflict_session_block')
ORDER BY created_at DESC LIMIT 10;

-- Direct measurement, independent of the sweep snapshot
WITH s0 AS (SELECT sum(xact_rollback) r FROM pg_stat_database WHERE datname=current_database()),
     z  AS (SELECT pg_sleep(10)),
     s1 AS (SELECT sum(xact_rollback) r FROM pg_stat_database WHERE datname=current_database())
SELECT round((((SELECT r FROM s1)-(SELECT r FROM s0))/10.0)::numeric,1) AS rollbacks_per_sec;
```

Also: Supabase logs → **postgres** service shows a wall of
`version_mismatch …` ERROR lines during a storm (NOT the API logs).

### 2.2 Find the exact record / session / user / tab

Read the **postgres logs** and grep for the enriched line — it has everything:

```
record_save_conflict v2 record=<uuid> model=<uuid> user=<uuid> session=<id>
  role=authenticated tab=<uuid> build=<sha> expected=v8 current=v35 ip=… referer=https://app.wassel.re/ …
```

If you only have the version pair (`current vN`) from the plain ERROR, bridge it
to the row(s):

```sql
SELECT * FROM public.conflict_storm_candidates(35);  -- pass the "current vN"
```

(The target's version may climb if it's also getting legit edits — widen by a
few versions if the exact lookup misses.)

### 2.3 Block / unblock safely

```sql
-- Block ONE record for 60 min (protects the row; saves to it fast-reject terminally)
SELECT public.block_conflict_storm_record('<record-id>', 60, 'manual: live storm');

-- Lift it once the source is gone
SELECT public.unblock_conflict_storm_record('<record-id>');

-- Block / unblock a whole SESSION (rare; usually auto-set at 25 conflicts/30s)
INSERT INTO public.session_save_blocks(session_id, blocked_until, reason)
VALUES ('<jwt-session-id>', now() + interval '15 minutes', 'manual')
ON CONFLICT (session_id) DO UPDATE SET blocked_until=EXCLUDED.blocked_until;
DELETE FROM public.session_save_blocks WHERE session_id = '<jwt-session-id>';
```

A block is reversible and lossless. Prefer it as the first response.

### 2.4 Verify the CPU / request rate actually dropped

```sql
-- Re-run the direct measurement from §2.1 — expect it to fall toward the
-- normal baseline (<~10/s). Also re-check the sweep:
SELECT public.conflict_storm_sweep();   -- expect storm:false once the source stops
```

Cross-check the Supabase dashboard CPU graph. **Important:** a block does NOT by
itself drop the request rate — a non-cooperating tab keeps sending (each call is
now a cheap terminal reject). The rate truly drops only when the **source stops**:
the forced stale-build reload removes it, or the user closes the tab, or (real
record neutralized) the client's dirty-retry clears. Don't declare it fixed on a
single 0 reading — confirm the source is gone (e.g. the offending `session` no
longer appears in fresh `record_save_conflict` log lines).

### 2.5 When NOT to delete a real record

`kill_conflict_storm_record(id)` backs up then DELETEs the row; the storming
client's next save re-INSERTs it at v1. That is the proven collapse **for a
disposable draft** (e.g. a `data_migration` draft). **Do NOT kill a real record
with live edits** (e.g. a `clients` row): after the delete, the stale client's
next save can re-insert its *stale* payload, reverting the row to the old data
(recoverable from the backup, but a live regression). For a real record:

1. `block_conflict_storm_record(id, …)` — protect it (lossless), and
2. stop the **source** (forced reload removes it; or revoke the session; or the
   user closes the tab),
3. then `unblock_conflict_storm_record(id)`.

The 2026-06-21 incident target (`clients` "ريان", `d0d9651e`) was blocked then
unblocked — intact at v35, never killed. Backup of record state at the time:
`public._backup_storm_record_20260621`.

---

## 3. Thresholds (current, tune only with evidence)

| Knob | Value | Where |
|---|---|---|
| Storm detection | ≥75 rollbacks/sec | `conflict_storm_sweep` (`c_threshold`) |
| Sweep cadence | 30s | worker `CONFLICT_SWEEP_INTERVAL_MS` |
| Per-record auto-block | ≥8 conflicts / 15s → 5 min | `record_conflict_report` (`c_trip`/`c_window`/`c_block`) |
| Per-session auto-block | ≥25 conflicts / 30s → 10 min | `record_conflict_report` (`c_strip`/`c_swindow`/`c_sblock`) |
| Forced-reload grace | 90s | `useAppVersionPoller` (`FORCE_RELOAD_GRACE_MS`) |
| Version poll | 60s (visible tabs) | `useAppVersionPoller` (`POLL_INTERVAL_MS`) |

---

## 4. The 2026-07-05 → 2026-07-18 storm (13 days undetected-in-practice)

The sweep fired correctly every 10 minutes for THIRTEEN DAYS (~1,600
rollbacks/sec, ~150M failed transactions/day) but nobody actioned it: the alert
carried no attribution, and the documented "grep record_save_conflict in the
Postgres logs" runbook failed because the flood itself lagged the hosted log
indexer ~9 hours behind. Offenders (finally identified 2026-07-18 via a
60-second diagnostic capture inside record_save): **two zombie browser tabs on
months-old pre-1340f07 SPA bundles** tight-looping stale-version `record_save`
retries against dead `chat_templates` drafts — old bundles neither call
`record_conflict_report` (so no auto-throttle, no telemetry) nor honor the
newer forced-reload path. The loops died the moment a retry received a success
response (which is also why `mode='noop'` record blocks kill loops the reject
mode can't).

Changes shipped in `2026-07-18_conflict_storm_sweep_attribution.sql`:

- Alert + RPC response now include `top_offenders` (last-60s
  `conflict_telemetry_buckets` aggregate; empty ⇒ non-reporting client) and
  `storm_run_minutes` (minutes since the last calm `conflict_rate_samples`
  row).
- A storm running >60 min re-alerts hourly (was: 10-min dedup forever — one
  long storm went effectively silent after the first alert).
- The runbook text in the alert now covers the logs-lagging case: identify the
  hot record LIVE via `pg_locks` (`locktype='tuple'`, relation `records`,
  map `page/tuple` through `ctid`), and prefer a `noop` block for dead records
  (success breaks retry loops; NEVER noop a record still receiving legitimate
  edits).

Threshold left at 75/s — the true calm baseline is ~0/s (verified: rollbacks
went to literally zero once the loops broke).

---

## 5. The 2026-07-19 → 2026-07-22 storm (#2) + same-day re-ignition (#3) — the listing-message pattern

**Timeline (all UTC, from `conflict_rate_samples` hourly aggregation):** storm #1
died 07-18 ~20:30 (noop blocks on 5 chat_templates drafts, blocked until
2026-08-17). Calm until 07-19 ~05:45. Storm #2 then ran **continuously at
~2,000 rollbacks/sec for ~82 hours** (~590M failed saves) until noop blocks on
four Jul-19 chat_templates drafts (`52b57c9d`, `bc74a106`, `7afe6832`,
`8d393de1`) landed 07-22 14:55. Calm for 22 minutes. At **15:17:01** a user
started a fresh listing-message clean (draft `cbae54d2`, "@6488957", 11 photos);
the storm **re-ignited at 15:17:18** (~1,200/sec) targeting that brand-new
draft — while it was still mid-clean — and kept hammering it long after it
completed successfully (v14, ready, 15:17:45). A noop block on `cbae54d2` at
15:33 collapsed the rate to 0 instantly. A 50-second diagnostic flap (block
deleted, rate watched, block re-inserted) showed **no resumption** — the loop
died permanently on its first success, same semantics as storm #1. The block on
`cbae54d2` was then removed for good (it is a live saved message; a lingering
noop would silently swallow the user's edits — the §2.5 rule).

**What was ruled out (verified live during the storm):**

- **The Fly deck worker.** All 5 machines were fully replaced at 15:18-15:19
  while the storm ran uninterrupted. The running bundle was also SSH-verified
  to contain the `clean_text_entry_patch` fix (worker clean fills don't call
  `record_save` at all).
- **The generation-jobs system.** Every clean-text job for every storm draft
  completed with `attempts=1`; zero queued/running jobs globally.
- **The server workflow engine.** `workflow_jobs` was empty in every status.
- **All committed retry loops.** Every `record_save` retry path in the repo —
  at HEAD and at the storm-era builds (`8255467`, `cb6423e`) — is bounded
  (api/worker `recordSaveWithRetry` 3 attempts; clean-text era opts 10
  attempts/4 min; pending-sync 5; compress requeue 3; workflow_job_fail
  max_attempts) and re-reads fresh state each attempt. No `while(true)` exists
  in `api/` or `worker/src`.

**What is established about the hammer (still unattributed to a code path):**

- It watches for listing-message chat_templates drafts and starts hammering the
  **newest draft within ~17s of creation**, mid-clean, with a **frozen stale
  (data, version) snapshot** — the target's `updated_at`/`version` freeze
  proves it never re-reads (a re-reading writer would immediately succeed).
- role=service_role, node supabase-js via PostgREST. Storm-#2-era Postgres logs
  attributed three long-lived clients: the deck-worker **v50 image**
  (build ULID 01KXV3Y8… = 2026-07-18 17:21Z, commit ≈ `a8cff44`) and Vercel
  function instances of the 07-19 deployments `8255467`/`cb6423e` — but the
  same behavior re-appeared 07-22 on the **current** stack, so old builds are
  not the cause, and hosted log lag (§4) makes log-line timestamps unreliable
  under flood.
- Retry-until-success, no backoff: only a SUCCESS response (mode='noop' block)
  kills it. Reject blocks, worker restarts, machine replacement, and stopping
  the WAHA POC apps all failed to stop it.

**Next-ignition playbook (do this FIRST, while it burns):**

1. Confirm + locate: latest `conflict_rate_samples` (or §2.1 direct
   measurement); the target is virtually always the most recently created
   `chat_templates` draft (model `4a70d8f1-2a6a-4ea7-b7ef-45c6e6af732b`).
2. **Before killing it, capture the caller**: replace `record_save` with an
   instrumented copy whose two `IF v_block_mode = 'noop' THEN RETURN p_id;`
   branches first `INSERT INTO public._diag_noop_hits(rec, expected, headers,
   claims) SELECT p_id, p_expected_version, nullif(current_setting(
   'request.headers', true),'')::jsonb, v_claims` — noop'd transactions COMMIT,
   so the capture survives and records the hammer's ip / x-wassel-build /
   user-agent / jwt claims on its first (successful) hit. Sequence-counter
   instrumentation in the version-mismatch branch (`PERFORM nextval(...)` per
   candidate id — sequence bumps survive rollback) locates the record without
   any log access.
3. Noop-block the target → rate collapses → read `_diag_noop_hits` → restore
   the stock `record_save` → chase the attributed process.
4. If the target is a LIVE saved message the user still edits, lift the noop as
   soon as the flap test (delete block, watch 45s, re-insert if needed) shows
   the loop is dead.

The 06-20 sampling loop for live SQL diagnosis (SQL editor, role postgres):
`pg_stat_activity WHERE query ILIKE '%record_save%'` in a 40×150ms
`pg_stat_clear_snapshot()` loop into a temp table — pg_locks tuple-lock
sampling misses sub-ms locks; the activity sampler does not.

**CORRECTION (2026-07-22 ~16:00 UTC, learned the hard way):** "the loop dies
permanently on first success" is WRONG. After the 15:33 noop kill and a calm
flap test, the storm re-ignited by 15:52 at ~1,100/s while the user actively
worked (two more listing cleans at 15:41 and 15:50), and this later wave did
NOT stop when every recent chat_templates draft was noop-blocked — the hammer
**re-acquires new targets dynamically and the target had moved beyond
chat_templates candidates**. Treat the hammer as a persistent driver attached
to the user's active working environment (tab(s)/API instances) that spawns a
new stale-snapshot loop per touched record. Blocks are per-record whack-a-mole;
the §5 step-2 capture (instrumented noop branch → `_diag_noop_hits`) is the
only path to the driver, OR sample `pg_stat_activity`/locks live while it
burns. A noop block on a record that is NOT the current target has pure
downside (silent write loss) — flap-verify before leaving any noop in place.

### 5.1 CLOSED 2026-07-23: zombie Vercel function instances, proven end-to-end

The 2026-07-23 03:20 post-expiry wave was diagnosed to ground truth with a
**non-transactional logical-WAL capture** (`pg_logical_emit_message(false, …)`
added temporarily to `record_save`'s conflict branch + a `test_decoding` slot —
non-transactional messages survive the aborted transaction, making them the ONLY
durable capture channel while hosted logs lag 13h+). Result, unambiguous:

- **One sender**: a Vercel function instance in `iad1`, `x-wassel-service=api:files`
  (the shared service client that `api/templates/clean-listing-images.ts` uses),
  `x-wassel-build=794a74d` (a docs-only deploy!), ip `44.197.133.1`, resending ONE
  frozen `(data, version)` payload (`exp=13`) for the listing draft it was serving
  when it was spawned (`976b559b`, "@6717645", created 15:58Z Jul 22, mid-clean
  snapshot) at **~500–1,500/s for 13+ hours**, ignoring every response.
- **Every storm since Jul 5 fits this species**: an instance serving a
  listing-message clean freezes a mid-clean snapshot and resends it forever. The
  three storm-#2 senders (v50 worker image + Vercel builds 8255467/cb6423e) were
  the same thing on Jul-19 infra. All committed retry code is bounded and
  re-reads fresh — the frozen version proves the replay happens BELOW the app
  loop (runtime/instance-level request replay; exact Fluid-runtime mechanism
  still unproven, but it is NOT a code loop in this repo).
- **Kills that work**: `vercel remove` of the sender's deployment (the two
  Jul-19 Vercel senders died within ~2 min of deletion on 2026-07-23; the
  794a74d sender survived at least ~10 min post-deletion — its hot loop seems
  to dodge idle reaping — so ALSO noop-block its target record for cheap
  containment until the instance is reaped). The old worker-image sender died
  with the deck-worker machine replacements. **Reject blocks, restarts, and
  success responses do NOT stop these senders — they ignore everything.**
- **Standing recipe** (all via the Supabase MCP `apply_migration`/`execute_sql`,
  fully autonomous): (1) add the WAL emit to the conflict branch, (2) create the
  `storm_diag` slot, (3) read `pg_logical_slot_get_changes` → rec/build/svc/ip,
  (4) `vercel ls --meta githubCommitSha=<build>` → `vercel remove <url>`,
  (5) noop-block the target, (6) **restore stock record_save and DROP THE SLOT**
  (an unread slot retains WAL forever).
- **Open item**: why a Fluid instance replays a frozen request indefinitely —
  needs Vercel support / instance-level introspection. Until understood, any
  listing-message clean can spawn a new zombie on the then-current deployment;
  the sweep alert + this recipe is the response.

---

## 6. 2026-08-29 — CURRENT-build tab storming a `followups` two-writer record (client-breaker gap + fix)

**Signature.** CPU 76% (m6g.large, ap-south-1); probe = ~1,158 rollbacks/sec vs 38
commits/sec. `xmax` hunt (see the memory `supabase-cpu-version-conflict-storm.md`)
found the hot row instantly: `records` top row `851ee772` (model `followups`
`764e0e67`), `xmax` ~8M txns ahead of every other row, churning each sample while
`version` pinned at **3**. Enriched postgres log: **697,208 conflicts**, user
`31621e58` (r.abanumay's own uid), session `78e32499`, **build `41699b01` = the
CURRENT prod HEAD** (NOT an ancient bundle), tab `4e4de160`, `expected=2 current=3`
fixed, `client=supabase-js-web`. The tab loaded the followup at v2; server
automation (the WhatsApp activity bridge / no-response escalation, `created_by=null`,
version-unaware) bumped it to v3; the tab then re-sent `expected=2` forever.

**Why the existing client breaker didn't catch it.** `records_bump_version` bumps
on **every** UPDATE, so `current` staying pinned at 3 through 697k conflicts proves
**zero successful saves happened** — which means `clearRecordConflict` never ran, so
the reload-attempt cap *should* have wedged after the 2nd conflict. It didn't,
because **every existing hard-stop trigger has a reset path** and a hot two-writer
record keeps hitting them:

- `recordConflicts` (windowed count, trips at `RECORD_CONFLICT_LIMIT=4` in 10s) is
  **deleted on every reload-and-retry** by `releaseBreakerForRetry` — so the count
  can be perpetually re-zeroed before it trips.
- `recordReloadAttempts` (the `MAX_RELOAD_RETRIES=1` cap) is only a single-shot
  backstop and is reset by `clearRecordConflict`.
- The only *monotonic* latch, `engageHardWriteStop` (`staleBuild.writeLocked`, reset
  only by a page reload), was therefore never reached, so the tab never
  write-locked and never force-reloaded.

**Fix (this change).** A new **absolute, monotonic per-record conflict counter**
in `src/lib/conflictBreaker.ts` (`noteAbsoluteConflict` / `reachedAbsoluteConflictCap`,
cap `RECORD_ABSOLUTE_CONFLICT_LIMIT = 6`) that has **no window and exactly one reset —
a genuinely successful save (`clearRecordConflict`)**. `supabaseRecordUpsert`
increments it on every `version_mismatch`; once it crosses the cap it calls
`markRecordWedged` + `engageHardWriteStop('record-storm')` — the same latch the
windowed trip uses, but now reachable via a path **no re-fetch/retry race can
zero**. During a real storm there is never a success (the version can't advance),
so the counter marches to 6 and hard-stops the tab within milliseconds instead of
looping ~1,158/s. A legitimate concurrent edit resolves in ≤2 conflicts then
SUCCEEDS (resetting the counter to 0), so the cap can't false-positive on real
editing. Covered by `src/lib/__tests__/conflictBreaker.test.ts` ("absolute conflict
cap" describe block), incl. the reset-race that defeats the windowed breaker.

**Containment used live** (still the right first move on recurrence): session-scoped
`session_save_blocks` **noop** on the offending JWT session (`78e32499`) → rollbacks
`1,158→0` in one sweep. Chose SESSION scope, not RECORD scope, on purpose:
`851ee772` is a live two-writer automation record, so a record-noop would also
silently discard the WhatsApp bridge's legit writes; a session-noop silences only
the one stale browser tab (service_role automation carries no JWT session). Expires
+3h. The code fix above is what prevents the *next* one without an operator.

**Plain version.** A single browser tab had an out-of-date copy of one follow-up
(it thought the row was at "version 2"; the system had already moved it to "version
3" because our automation touched it). The tab kept trying to save its stale copy,
the database kept refusing, and the tab kept retrying — about 1,158 times a second,
700 thousand times total — which is what spiked the database to 76%. We already had
a "stop after a few failures" brake, but it had loopholes: a couple of the counters
that feed the brake got quietly reset each retry, so the brake never engaged. The
fix adds one counter that CANNOT be reset except by an actual successful save — and
during this kind of jam there are no successful saves — so after 6 straight failures
on the same record the tab now slams the brake on itself and reloads, ending the jam
almost instantly instead of grinding for ten minutes.
