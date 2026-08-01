# Branch bootstrap — verification report (mos-fixtures)

**Date:** 2026-08-01
**Produced by:** the isolated-database bootstrap task for the Marketing-workspace project.

## What this is

Production project `zhqqsxwealdwqzrbpwyv` has a recorded migration history that starts
2026-04-23 and does **not** create the core tables (`records`, `models`, `users`, …) — they
were applied outside migration tracking. `create_branch` replays only the recorded history
onto a fresh DB, so every branch comes up broken (on `mos-fixtures` the replay failed
atomically and left `public` completely empty — 0 tables, 0 functions).

The fix is a **catalog-derived schema bootstrap**: `supabase/branch-bootstrap-01.sql` …
`branch-bootstrap-14.sql` (~2.6 MB total), generated directly from prod's live catalogs by
`scripts/generate-branch-bootstrap.mjs`. Applied in order to a fresh empty branch DB they
recreate production's public schema faithfully — structure only, plus a small set of
platform seed rows. All files are idempotent (safe to re-run).

## The running branch

| | |
|---|---|
| Branch name | `mos-fixtures` |
| Branch id | `fc7fc812-f62f-479d-b313-6746859f6cec` |
| Project ref | `czdznzadjqzajrnjoafi` |
| API URL | `https://czdznzadjqzajrnjoafi.supabase.co` |
| Publishable key | `sb_publishable_51WcnX8TV5R9IMAQ3pW-HQ_EytArsnq` |
| Legacy anon key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6ZHpuemFkanF6YWpybmpvYWZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1NjA1MzcsImV4cCI6MjEwMTEzNjUzN30.M_m1G34RO5L8e-ENg75Q6gzQVFhh3Yuj3HXg3Ei4UBg` |
| Branch status | `MIGRATIONS_FAILED` (expected — the recorded history is broken; the underlying project is `ACTIVE_HEALTHY` and fully bootstrapped) |

The branch is left RUNNING for later phases. Do not `reset_branch` it — a reset replays
the broken recorded history and wipes the bootstrap.

The branch also carries two **branch-only helper RPCs** (not part of the bootstrap files):
`public.mos_bootstrap_exec(p_token, p_sql)` and `public.mos_bootstrap_query(p_token, p_sql)` —
SECURITY DEFINER, token-gated, granted to `anon`. They let scripts apply SQL / run
verification queries over PostgREST without the branch's service key. The token lives in the
git-ignored `.mos-branch.local` at the worktree root (`MOS_BOOTSTRAP_TOKEN`), together with
the branch URL + anon key. To remove them when no longer needed:
`DROP FUNCTION public.mos_bootstrap_exec(text,text), public.mos_bootstrap_query(text,text);`
Branch-only config change: `ALTER ROLE anon/authenticator SET statement_timeout='600s'`
(prod defaults were 3 s / 8 s — too tight to apply 600 KB bootstrap chunks via PostgREST).

## Verification — prod vs branch

Counts (extension-owned objects excluded; verified 2026-08-01 via
`scripts/verify-branch-bootstrap.mjs`):

| Check | Prod | Branch | Result |
|---|---|---|---|
| Tables (public, base) | 375 | 375 | OK |
| Views | 59 | 59 | OK |
| Functions | 511 | 513 | +2 = the branch-only `mos_bootstrap_*` helpers (explained) |
| Triggers (non-internal) | 181 | 181 | OK |
| Event trigger `ensure_rls` | 1 | 1 | OK |
| Policies (public) | 527 | 527 | OK |
| Policies (storage) | 20 | 20 | OK |
| RLS-enabled tables | 375 | 375 | OK |
| Non-constraint indexes | 472 | 472 | OK |
| PK/UNIQUE/CHECK constraints | 781 | 781 | OK |
| Foreign keys | 422 | 422 | OK |
| Sequences | 8 | 8 | OK |
| Storage buckets | 6 | 6 | OK |
| Realtime publication members | 17 | 17 | OK |
| Non-default replica identities | 14 | 14 | OK |
| `security_invoker` views | 56 | 56 | OK |
| SECURITY DEFINER functions | 426 | 428 | +2 = same helpers |
| Seed rows: models / model_groups / roles / profiles / workflow_groups / mos_workflows / mos_workflow_steps / mos_content_types / mos_platform_accounts / listing_mirror_settings / webhook_slugs | 49/7/6/6/5/2/16/4/4/1/1 | same | OK |

Deep faithfulness (md5 of rendered definitions, prod vs branch):

- **Function definitions:** byte-identical for all 511 functions (`pg_get_functiondef`).
- **View definitions + reloptions:** identical for all 59 (incl. `unified_records` and the
  deliberately-definer `v_our_projects_scope`).
- **Trigger definitions + enabled state:** identical for all 181.
- **Index definitions:** identical for all 472.
- **Policy quals/with_check/cmd/roles:** identical for all 547 (public + storage).
- **Constraint definitions:** identical for all 1,203.
- **Table column signatures** (name, type, not-null, default, identity/generated, in
  column order): identical for all 375 tables after normalizing one rendering artifact
  (see delta 4).
- **Relation ACLs:** identical text for all 442 tables/views/sequences.
- **Function EXECUTE privileges:** semantically identical for `anon`, `authenticated`,
  `service_role` across all 511 functions (per-object ACL replay preserved prod's
  revocations, e.g. service-role-only functions stay locked down).
- **Sequence parameters:** identical for all 8.
- **Seed row content:** md5-per-row identical for `models` (name+schema+is_hardcoded+
  table_name), `roles`, `profiles`, `mos_workflow_steps`, `mos_content_types`, and
  bucket configs.

Functional spot checks on the branch: `SELECT * FROM unified_records LIMIT 0` works;
`record_save` exists; `wassell_mos_can('read')` executes (returns false with no auth
context, as expected); all 49 `models.schema` JSONB intact; `v_clients` selectable;
PostGIS works (`ST_MakePoint` OK); `records` is empty (no data copied).

## Documented deltas (no silent skips)

1. **+2 functions on the branch** — `mos_bootstrap_exec` / `mos_bootstrap_query`, the
   token-gated apply/verify plumbing. Branch-only; drop SQL above.
2. **`webhook_slugs.created_by` NULLed** in the seed (nullable FK → `auth.users`, which is
   not copied per the no-auth-data rule). Everything else seeds verbatim.
3. **Object ownership** — prod objects are owned by a mix of `postgres` and
   `supabase_admin`; on the branch everything is owned by `postgres` (the bootstrap runs
   as postgres). Functionally equivalent: SECURITY DEFINER functions run as postgres,
   which owns every table (owner RLS-exemption preserved). Cannot be avoided without
   superuser.
4. **Default-expression rendering artifact (not a real diff)** — comparing
   `pg_get_expr` output cross-project shows `extensions.uuid_generate_v4()` (prod render)
   vs `uuid_generate_v4()` (branch render) for 30 tables, because prod's PostgREST session
   pins `search_path=public` while the branch helper pins `public, extensions`. Both
   defaults resolve to the same extension function; normalized hashes are identical.
5. **Function ACL *text*** differs cosmetically (grantor recorded as `postgres` instead of
   `supabase_admin`, entry order) — semantic privileges verified identical (see above).
6. **`site_settings`** — listed as a candidate seed table but does not exist as a physical
   table in prod (it is a model living in `records`); skipped.
7. **`mos_role_grants`** — intentionally skipped (role wiring is being rebuilt).
8. **Object COMMENTs** are not replicated (cosmetic only).
9. **Sequence current values** are not copied — counters start fresh on the branch.
10. **`supabase_migrations.schema_migrations` is empty on the branch** — the bootstrap is
    applied via RPC, not recorded as migrations (deliberate: recording it would collide
    with prod's broken history on future branch operations).
11. **Vault/auth schemas untouched** — branch keeps its own (empty) `auth`; prod has no
    triggers on `auth.users` (verified), so nothing was needed there. Vault secrets are
    not copied (encrypted, and not schema).
12. **`pg_net` absent on prod** — no webhooks infrastructure to replicate.

## How to re-run

Everything runs from the worktree root (`.claude/worktrees/marketing-os`). Prod is read
via the read-only `claude_runner_sql` RPC (service key from the repo root `.env.local`);
the scripts never write to prod.

**Regenerate the bootstrap files** (when prod schema drifts):

```
node scripts/generate-branch-bootstrap.mjs
```

**Apply to a branch** (idempotent; re-applies cleanly over an already-bootstrapped DB):

```
node scripts/apply-branch-bootstrap.mjs            # all files, in order
node scripts/apply-branch-bootstrap.mjs --from 5   # resume from file 05
node scripts/apply-branch-bootstrap.mjs --only 13  # single file
```

**Verify** (paired prod-vs-branch counts + spot checks):

```
node scripts/verify-branch-bootstrap.mjs
```

**Bootstrapping a brand-new branch from scratch:**

1. `create_branch` via the Supabase MCP (get_cost → confirm_cost → create_branch). Expect
   `MIGRATIONS_FAILED`; the DB will be empty (the replay fails atomically) — verify
   `public` is empty; if a future history replays partially, drop leftover public objects
   first.
2. On the new branch (via MCP `execute_sql`), create `mos_bootstrap_exec` /
   `mos_bootstrap_query` with a fresh random token (copy the definitions from the
   "running branch" section pattern: SECURITY DEFINER, `SET search_path = public,
   extensions`, token check, `GRANT EXECUTE ... TO anon`), and raise timeouts:
   `ALTER ROLE anon SET statement_timeout='600s'; ALTER ROLE authenticator SET
   statement_timeout='600s'; NOTIFY pgrst, 'reload config';`
3. Write `.mos-branch.local` at the worktree root with `MOS_BRANCH_URL`,
   `MOS_BRANCH_ANON_KEY` (from `get_publishable_keys`), `MOS_BOOTSTRAP_TOKEN`.
4. `node scripts/apply-branch-bootstrap.mjs` then `node scripts/verify-branch-bootstrap.mjs`.
