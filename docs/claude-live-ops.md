# Operating the LIVE app directly (Claude playbook)

> How a Claude Code session creates/edits/deletes **models, records, and workflows on the running
> production app**, and tests it — not just edits source code. Established & verified 2026-06-08.

## The connection (this *is* the "API into the live app")

The **Supabase MCP** is connected to project **`wassell-prod`** (`zhqqsxwealdwqzrbpwyv`, ap-south-1).
`execute_sql` / `apply_migration` run with elevated privileges (bypass RLS). The app is a frontend
over this same Postgres, so **DB writes show up in the live app** (refresh; the `records` table is
Realtime). There is no separate API to build — reads and writes go straight to the backend.

The owner `r.abanumay@wassel.re` is on an **Administrator** profile (`is_admin=true`). Admins bypass
`model_permissions` ([`src/lib/permissions.ts:93`](../src/lib/permissions.ts)), so **a model created
via SQL appears in the sidebar automatically** on the next refresh — no permission wiring needed.

## Guardrails (user chose "Guarded autonomy")

- **Read** anything, freely.
- **Sandbox** — free rein, no asking — inside the model group **"🧪 Sandbox (Claude)"**
  (`model_groups.id = 367b5654-087d-4dbe-92e2-85afc3d9ce5b`). All experiments go here.
- **Real business data** (the 25 real models / ~3.9k records / 7 real workflows): state the exact
  change, get a yes, and **back up first** —
  `CREATE TABLE _backup_<table>_<yyyymmdd> AS SELECT … ;` (precedent: `_backup_all_projects_20260601`)
  — before any destructive or bulk operation. Deletes are never silent.

## Recipes

### Records — always via the RPCs (never raw-write `records`)
```sql
-- create / update (same RPC; pass an existing id to update)
select public.record_save(
  '<model_id>'::uuid,
  gen_random_uuid(),                 -- or existing record id
  '{"field_slug": "value"}'::jsonb,  -- full data object (replaces existing data on update)
  '<public.users.id or null>'::uuid, -- created_by: stamped once, preserved on later edits
  null                               -- p_expected_version: the loaded version, or null to skip the check
);
-- delete (works for frozen + unfrozen)
select public.record_delete('<model_id>'::uuid, '<record_id>'::uuid);
```
- A stale `p_expected_version` raises **`40001 version_mismatch`** (loud, no overwrite); a trigger
  auto-bumps `version` on every update.
- Auto-ID fields: `select public.record_assign_auto_id('<model_id>'::uuid,'<field_id>'::uuid,'',1);`
- The `records_block_frozen_writes` trigger rejects direct `records` writes for frozen models — the
  RPCs dispatch to the frozen table for you. (All models are currently unfrozen.)

### Models — insert a `models` row mirroring the Builder's shape
- Defaults to mirror: [`CreateModelModal.tsx:51`](../src/pages/Builder/components/CreateModelModal.tsx)
  and `MAPS_CONFIG_DEFAULT` ([`src/types/index.ts:441`](../src/types/index.ts)) —
  `card_config = {title_field_id:null, subtitle_field_id:null, badge_field_id:null, shown_field_ids:[]}`,
  one base section (`is_base:true`), fields with `id/name/label_ar/label_en/type/required/order/section_id/width/show_in_table`.
- Slugs are snake_case (`src/lib/autoTranslate.ts:27` `slugify`).
- The `models_view_sync` trigger auto-creates a typed **`v_<name>`** view (and drops it on delete).
- Deleting a model is **admin-only** at the RLS level (`wassell_is_admin`); the MCP bypasses RLS.

### Workflows — rows in the `workflows` table
- Shape: `branches[]` (each: `conditions[]` + `actions[]` + `condition_mode 'all'|'any'`), with legacy
  flat `conditions`/`actions` mirroring `branches[0]`. Condition `field_id` is the field **slug**.
- Use `only_on_change: true` on a condition to fire only on a false→true transition (prevents a
  self-updating action from re-triggering forever).
- Types: [`src/types/index.ts:744-1151`](../src/types/index.ts).

## ⚠️ Workflow execution — the caveat that matters

| Trigger | Runs where | Fires on a direct DB/RPC write? |
|---|---|---|
| `create` / `update` / `delete` | **Browser** (`src/lib/workflowEngine.ts`), only while app is open | **No** |
| `webhook` | Browser, on Realtime push | **No** (needs an open tab) |
| `on_due` | **Server** — Vercel cron (`api/sweep-due-followups.ts`), every ~5 min | **Yes** (followups only) |
| `button_click` | **Server** (`api/run-button-workflow.ts`) — paseet actions only | on click |

→ **To test a `create`/`update` workflow you must drive the live UI** (a SQL `record_save` will NOT
fire it). Every run is logged to `workflow_runs` (status, conditions_passed, actions_trace, actor).

## Testing the running UI

- Prod URL: **https://app.wassel.re** (Arabic RTL). Login has TOTP MFA, so Claude can't self-login,
  but the user's Chrome ("Browser 1") is usually already authenticated — drive it via the
  **Claude-in-Chrome MCP** (`select_browser` → `navigate` → `find`/`computer`). See
  `feedback_browser_test_auth` in memory.
- For DB-level truth, query the per-model `v_<name>` views or the `unified_records` view.

## Post-deploy verification (part of the deploy workflow)

`git push origin HEAD:main` is not the end of a deploy — it's the middle. After the push
(see CLAUDE.md → "Worktree workflow"):

1. **SHA:** `git rev-parse HEAD`.
2. **Skip if docs-only-to-PRD:** a push touching ONLY `docs/prd/models/**` + `docs/prd/workflows/**`
   is skipped by `vercel.json`'s `ignoreCommand` (no deploy). Anything else deploys.
3. **Confirm the build** — Vercel MCP `list_deployments`
   (project `prj_4ObF1mUW9KmmhFJDkoHCD0MZzJEh`, team `team_3UCVfsGz7gmIizM7AsVfczzW`):
   match the `target:"production"` / `meta.githubCommitRef:"main"` entry on `meta.githubCommitSha`,
   poll until `state:"READY"` (~1–2 min). `ERROR` → `get_deployment_build_logs`, fix, re-push.
4. **Smoke-test live** — Claude-in-Chrome on `https://app.wassel.re`, hard-reload to bust the hashed
   SPA bundle, exercise the changed behavior, `read_console_messages` (onlyErrors), verify data via
   the Supabase MCP.
5. **Report** the SHA + deployment id + what was tested. Bad deploy → roll back (deployments are
   `isRollbackCandidate`).

Skip step 4 only for changes not observable in the running app (CI/tooling/test-only) — still do
step 3.

## The verification sandbox (created 2026-06-08, safe to delete)
- Group `🧪 Sandbox (Claude)` `367b5654-087d-4dbe-92e2-85afc3d9ce5b`
- Model `claude_link_test` `ff2cb628-83b3-452f-beea-0b62cf9f51b6` (+ view `v_claude_link_test`)
- Workflow `Auto-close when Done (test)` `0125ce02-4f9d-4c0d-ab42-efb6c733e386`
- Teardown: `record_delete` the rows → `delete from workflows where id='0125ce02…'` →
  `delete from models where id='ff2cb628…'` (drops the view via trigger) →
  `delete from model_groups where id='367b5654…'`.
