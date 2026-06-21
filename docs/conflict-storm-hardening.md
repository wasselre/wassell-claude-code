# record_save conflict-storm hardening — architecture + operator runbook

_Last updated: 2026-06-21._

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
