# Geography Understanding Ability — Operations Runbook

**Last updated:** 2026-09-03

This is the operator's guide to running, observing, cost-controlling, and rolling
back the Geography Understanding Ability (the geo-preference pipeline). It covers
the **operational safeguards** that sit around the core pipeline
(`api/_lib/geoPreference/*`), not the interpretation logic itself.

> **The one rule that never changes:** the ability is **review-first**. Its only
> side effect is a `pending` row in `geo_pref_proposals`. Nothing it does writes to
> a client record until a human confirms a proposal. `auto_write_enabled` stays
> **false** until the frozen-TEST safety gate is cleared. See "Keeping auto-write
> off" below.

---

## 1. What the safeguards are

| File | What it protects against |
|---|---|
| `api/_lib/geoPreference/versioning.ts` | A rep confirming a **stale** proposal that newer client evidence already overtook. |
| `api/_lib/geoPreference/observability.ts` | Blind failures (no latency/outcome/error trail) **and** PII/coordinate leakage into logs or the wrong reviewer role. |
| `api/_lib/geoPreference/llmBudget.ts` | Runaway LLM **cost** and provider **rate-limit** breaches on the extractor/backfill path. |
| `api/_lib/geoPreference/backfillClaim.ts` | A backfill **double-processing** a unit (two workers racing, or a re-run redoing finished work). |

All four are pure logic with injected stores/clocks — unit-tested in
`api/_lib/geoPreference/__tests__/` (`versioning.test.ts`, `observability.test.ts`,
`llmBudget.test.ts`, `backfillClaim.test.ts`, `safeguardsRls.test.ts`). Run them
with `npx vitest run api/_lib/geoPreference/`.

---

## 2. Running the backfill

The backfill re-extracts geo-preferences over historical conversations. It is
**operator-driven and throttled** — never automatic — for the same reason as the
listing-photo backfill: a fan-out of thousands of paid LLM calls must be under a
human's hand.

Every backfill run MUST wire in two safeguards:

1. **An `LlmBudget`** (cost + rate). Construct **one budget for the whole run**:
   ```ts
   import { createLlmBudget } from '../api/_lib/geoPreference/llmBudget';
   const budget = createLlmBudget({
     maxCalls: 5000,        // hard ceiling on LLM calls this run
     maxTokens: 8_000_000,  // hard ceiling on (estimated) tokens this run
     maxConcurrency: 3,     // at most 3 extractions in flight
     minIntervalMs: 250,    // ≥250ms between call starts (≈4/s)
   });
   // pass it into every extraction:
   await extract(conversation, { budget });
   ```
   When a ceiling is hit, `extract` throws `LlmBudgetExceededError` — **catch it at
   the loop top and STOP**. The backlog is safe; it lives in the data, not the
   loop, so a later run resumes it.

2. **A `ClaimLedger`** (idempotency + concurrency):
   ```ts
   import { ClaimLedger, dedupKey, setDoneStore } from '../api/_lib/geoPreference/backfillClaim';
   // seed "done" from the DB (e.g. conversations that already have evidence at this version)
   const ledger = new ClaimLedger(setDoneStore(alreadyDoneKeys));
   for (const item of items) {
     const key = dedupKey(item);           // "chat:<conv>@<extraction_version>"
     if (!ledger.claim(key).ok) continue;  // racing worker or done ⇒ skip
     try { await processOne(item, { budget }); ledger.complete(key); }
     catch (e) { ledger.release(key); throw e; } // failed ⇒ re-claimable next run
   }
   ```
   A **new extractor version** changes the dedup key, so bumping
   `EXTRACTOR_VERSION` intentionally re-processes everything; a re-run at the same
   version skips finished work.

**Dry-run first.** Always size the backlog (count conversations × estimated
tokens) before a real run, and start with a small `maxCalls` to prove the wiring.

---

## 3. How review works

1. The pipeline (`runReviewFirst` in `orchestrator.ts`) writes **one `pending`
   proposal** per checkpoint into `geo_pref_proposals`. It never writes a client
   record — there is no port for it to do so (structural guarantee, tested).
2. A reviewer opens the proposal. What they see is **role-scoped** (see §4).
3. The reviewer **confirms** or **rejects**. Only a `pending` proposal is
   confirmable — `confirmability()` in `versioning.ts` is the confirm-boundary
   guard.
4. **Staleness:** if the customer says something newer for the same subject while a
   proposal is still open, the new run supersedes the old one:
   ```ts
   import { supersedeStaleOpenProposals, asOfFromTimestamp } from '../api/_lib/geoPreference/versioning';
   // AFTER creating the fresh proposal:
   await supersedeStaleOpenProposals(store,
     { client_id, conversation_id },
     { id: freshProposalId, as_of: asOfFromTimestamp(checkpoint.as_of_timestamp) });
   ```
   Older open proposals are marked `superseded` with `superseded_by` pointing at
   the fresh one, so a rep can no longer confirm the outdated reading.

> **Schema dependency:** persisting supersession needs the review-and-ops migration
> to add `'superseded'` to `geo_pref_proposals.status` and a `superseded_by uuid
> REFERENCES geo_pref_proposals(id)` column. `versioning.ts` decides *when*; the
> migration provides the columns.

---

## 4. Observability

Every stage boundary emits one structured event via `geoObserver`
(`observability.ts`), wired into `orchestrator.ts`:

- Stages: `extraction`, `resolution`, `gating`, `review_outcome`, `versioning`.
- Each event carries `stage`, `outcome` (`ok`/`error`), `latency_ms`, correlation
  ids, a `result` label (e.g. the gate decision), and — on failure — the error
  **message** (never the raw object).
- `time()` **re-throws on error** (per CLAUDE.md's silent-failure rule): it records
  the failure loudly, then lets it propagate.
- The default console sink is **silent under Vitest** (`VITEST=true`) and when
  `GEO_OBS_SILENT=1`; production logs one `[geoPreference] {…}` line per event.
- `detail` payloads are **PII-scrubbed** (`scrubPii`) before logging — phone, name,
  coordinates, and raw utterances are dropped as defence-in-depth.

**Reviewer-role redaction** (`redactPreferenceForRole`) — the application-side twin
of the review-and-ops SQL views:

| Role | Sees | Never sees |
|---|---|---|
| `meaning_reviewer` | meaning fields + proposed action | phone, name, coordinates, raw utterance |
| `geo_operator` | proposed action + **pseudonymized** coordinates | phone, name, precise pin, meaning, utterance |
| `admin` | everything | — |

`pseudonymizeCoordinate` truncates to a ~1 km grid (precision 2) and attaches a
stable, non-reversible pseudonym derived from the client id + salt — so a geo
operator can tell mentions apart without learning **who** or the exact home pin.

---

## 5. Cost controls

- **Per-run ceilings** (`maxCalls`, `maxTokens`) are hard stops; a hit throws
  `LlmBudgetExceededError` and the run halts. Token reservations are optimistic
  (reserve the estimate, reconcile with actual usage on release).
- **Concurrency** (`maxConcurrency`) caps simultaneous in-flight calls.
- **Rate** (`minIntervalMs`) spaces call starts.
- The live single-extraction path passes **no budget** (a lone call has nothing to
  throttle). Only backfills construct a budget.
- `estimateExtractionTokens` deliberately **over-estimates** so the ceiling errs
  toward stopping early rather than overspending.

---

## 6. Keeping auto-write OFF

`auto_write_enabled` ships **`DEFAULT false`** in `geo_pref_gate_config`, and the
gate (`gate.ts`) can never return `auto_write` while it is false — even with
perfect signals it returns `confirm`/`human_review`. To keep it off:

- **Do not** flip `geo_pref_gate_config.auto_write_enabled` to `true`. There is one
  row (`id = true`); leave its `auto_write_enabled = false`.
- Verify at any time:
  ```sql
  SELECT auto_write_enabled FROM public.geo_pref_gate_config;  -- must be false
  ```
- Even if it were flipped on, a write still routes through a **pending proposal →
  human apply** step; the gate only *names* the action. But the posture is: it
  stays off until the frozen-TEST gate clears, and that is a deliberate,
  documented decision — not a config someone toggles in passing.

---

## 7. ROLLBACK

Both geo-preference migrations are **ADDITIVE ONLY** — they create new types,
tables, columns, policies, and functions, and **ALTER no existing object** (no
frozen model, no `unified_records`, no shared view). That means:

- Rollback is **safe**: it touches nothing outside the geo_pref_* namespace and
  does **not** require the frozen-model view-chain unwind.
- Because everything is new, a rollback is just "drop what the migration created",
  in reverse dependency order.

### 7a. Rollback — `2026-09-03_geo_preference_ability.sql` (core)

Creation order was: `TYPE` → 8 tables → per-table SELECT policies. The only
foreign key is `geo_pref_proposals.checkpoint_id → geo_pref_checkpoints(id)`.
Reverse it: **policies → tables (FK child first) → type.**

```sql
BEGIN;

-- 1. Drop the generated SELECT policies (one per table).
DROP POLICY IF EXISTS geo_pref_evidence_select       ON public.geo_pref_evidence;
DROP POLICY IF EXISTS geo_pref_relations_select      ON public.geo_pref_relations;
DROP POLICY IF EXISTS geo_pref_geometry_select       ON public.geo_pref_geometry;
DROP POLICY IF EXISTS geo_pref_checkpoints_select    ON public.geo_pref_checkpoints;
DROP POLICY IF EXISTS geo_pref_gold_split_select     ON public.geo_pref_gold_split;
DROP POLICY IF EXISTS geo_pref_challenge_tags_select ON public.geo_pref_challenge_tags;
DROP POLICY IF EXISTS geo_pref_gate_config_select    ON public.geo_pref_gate_config;
DROP POLICY IF EXISTS geo_pref_proposals_select      ON public.geo_pref_proposals;

-- 2. Drop tables. proposals FIRST (it references checkpoints via FK), then the
--    rest. Indexes (incl. the gist index on geometry) drop with their table.
DROP TABLE IF EXISTS public.geo_pref_proposals;      -- FK child of checkpoints
DROP TABLE IF EXISTS public.geo_pref_checkpoints;
DROP TABLE IF EXISTS public.geo_pref_evidence;
DROP TABLE IF EXISTS public.geo_pref_relations;
DROP TABLE IF EXISTS public.geo_pref_geometry;
DROP TABLE IF EXISTS public.geo_pref_gold_split;
DROP TABLE IF EXISTS public.geo_pref_challenge_tags;
DROP TABLE IF EXISTS public.geo_pref_gate_config;

-- 3. Drop the enum type LAST (every table that used it is gone now).
DROP TYPE IF EXISTS public.geo_pref_origin;

COMMIT;
```

(If you prefer, `DROP TABLE ... CASCADE` on each removes the need to order the FK
child first — but the explicit order above documents the one dependency and avoids
cascading into anything unexpected. Nothing outside geo_pref_* depends on these.)

### 7b. Rollback — `2026-09-03_review_and_ops.sql` (review + ops)

> This migration is owned by a sibling workstream and may not be present yet. It is
> **additive** in the same way: new review/audit tables, the `superseded_by` column
> + `'superseded'` status value on `geo_pref_proposals`, role-scoped views, and
> SECURITY DEFINER RPCs for the SQL-only write path. Roll it back in this order —
> **policies → RPCs/functions → views → tables → added columns → type/enum
> additions** — honoring FKs (drop child tables before parents), always in one
> transaction:

```sql
BEGIN;
-- 1. Policies it added (capture their exact names from the migration first).
--    DROP POLICY IF EXISTS <name> ON public.<table>;
-- 2. SECURITY DEFINER RPCs / functions it added.
--    DROP FUNCTION IF EXISTS public.<fn>(<args>);
-- 3. Views it added (role-scoped review views).
--    DROP VIEW IF EXISTS public.<view>;
-- 4. New tables (FK children first).
--    DROP TABLE IF EXISTS public.<review_table>;
-- 5. Columns it added to existing geo_pref_* tables.
--    ALTER TABLE public.geo_pref_proposals DROP COLUMN IF EXISTS superseded_by;
-- 6. Enum VALUE additions cannot be removed in Postgres without recreating the
--    type. If it added 'superseded' to a status CHECK (not an enum), just restore
--    the original CHECK constraint. If it widened an ENUM, recreating the type is
--    required — note it and coordinate; it is otherwise harmless to leave the
--    extra value present since no row will reference it after the tables are gone.
COMMIT;
```

**Rule of thumb:** because both migrations only ADD, a rollback that drops exactly
what they created returns the database to its prior state with zero risk to any
existing object. Do the drops in ONE transaction so concurrent readers never meet a
half-removed schema.

### 7c. Live verification of the RLS posture (after the migration is applied)

The unit test `safeguardsRls.test.ts` validates the **committed SQL** offline
(a test must not depend on prod state). After the migration is applied, confirm the
live posture read-only:

```sql
-- Every geo_pref_* table has RLS enabled and ONLY a SELECT-to-authenticated policy.
SELECT c.relname, c.relrowsecurity,
       p.polname, p.polcmd,           -- polcmd: r=SELECT, a=INSERT, w=UPDATE, d=DELETE, *=ALL
       pg_get_expr(p.polqual, p.polrelid) AS using_expr
FROM pg_class c
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE c.relname LIKE 'geo_pref_%'
ORDER BY c.relname, p.polname;
-- Expect: relrowsecurity = true for all; every policy polcmd = 'r' (SELECT).
-- Any 'a'/'w'/'d'/'*' policy granted to authenticated is a posture violation.
```

---

## 8. In plain language (for a non-engineer)

- **Review-first** means the robot never edits a client's file by itself. It only
  leaves a **sticky note** ("I think this customer wants north Riyadh — please
  confirm"). A person reads the note and decides. The master switch that would let
  it write on its own is **off**, and we keep it off on purpose.
- **Stale notes get cancelled.** If the customer changes their mind a minute later,
  the old sticky note is automatically crossed out and a new one takes its place —
  so nobody confirms an out-of-date guess.
- **Who sees what.** The person judging *what the customer meant* does **not** see
  the phone number, the name, or a map pin. The person checking *the map* sees only
  a **blurred, ~1 km** location with a fake code instead of the customer's identity.
  Only an admin sees everything. Logs are scrubbed the same way.
- **Spending guardrails.** When we re-scan lots of old chats, a spending cap and a
  speed limit are switched on. If the cap is reached, the job **stops itself** — the
  unfinished work is safe and picked up next time. Two workers can't accidentally do
  the same chat twice, and re-running skips whatever was already finished.
- **Turning it off.** Everything here is *new* plumbing bolted on beside the
  existing system. If we ever need to remove it, we just unbolt it — nothing that
  was already running is touched, so it's a safe undo.
