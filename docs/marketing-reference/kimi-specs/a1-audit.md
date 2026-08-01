TASK: Create the file docs/marketing-reference/audit.md — the Marketing workspace audit + reuse/replace ledger. Sections 1 and 2 only; leave section 3 as a placeholder heading.

You are in the repo root (a React+TS+Vite CRM). Use only facts you verify by reading files — no guesses. Write the doc in English, technical register.

## Section 1 — Inventory (title: "1. Inventory of marketing surfaces")

Produce three sub-inventories, each as a markdown table:

1a. NEW Marketing workspace (the keeper): list every file under src/pages/Marketing/ (including components/ and lib/ subfolders) with line count and a one-line role description (read each file's header comment or first ~30 lines to describe it). Also list src/lib/marketingOS/client.ts and api/marketing-os.ts (for api/marketing-os.ts also count the number of `case '...'` action handlers and list all action names in a code block).

1b. LEGACY marketing-management (the removal candidate): list every file under src/pages/MarketingManagement/ (if it exists — search also for any other legacy marketing page dirs), api/marketing-mgmt.ts, src/lib/marketingMgmt/ — with line counts. Grep the whole src/ and api/ tree for `mkt_` and list every table name referenced and from which files. Grep src/App.tsx (or wherever routes live) for the routes that mount the legacy pages and list them.

1c. Marketing INTELLIGENCE (reuse unchanged): api/marketing.ts — one paragraph on what it does (read its header) and where it is called from (grep for its endpoint path in src/).

## Section 2 — Reuse/replace ledger (title: "2. Reuse / extend / replace / remove ledger")

One markdown table with columns: Artifact | Decision | Rationale | Migration note.
Rows (verify each exists first; mark "not found" if absent):
- src/pages/MarketingManagement/** → remove after migration
- api/marketing-mgmt.ts → remove after migration
- src/lib/marketingMgmt/** → remove after migration
- mkt_* tables → remove after data check (data stays in DB until operator confirms)
- api/marketing.ts (Intelligence) → reuse unchanged
- src/pages/Marketing/** (the /m workspace) → keep, extend per plan
- api/marketing-os.ts → keep, extend
- mos_workflows, mos_workflow_steps → RETIRE: migrate into canonical `workflows` table (kind:'role_path') + engine-level workflow_versions
- mos_role_grants → RETIRE: migrate into canonical roles + user_roles junction + surface_access
- mos_tasks → PROMOTE: becomes engine-generic workflow_role_tasks (subject_table/subject_id polymorphism)
- all other mos_* domain tables (mos_content, mos_content_types, mos_scenes, mos_campaigns, mos_campaign_executions, mos_execution_ads, mos_execution_daily, mos_assets, mos_asset_links, mos_shoot_requests, mos_shoot_items, mos_publications, mos_metric_snapshots, mos_comments, mos_platform_accounts, mos_ref_counters) → keep as marketing-owned DOMAIN data

## Section 3 — placeholder

Write exactly:

```
## 3. Canonical engine extension seams (B1–B4)

_To be completed from the seam-mapping pass._
```

Do NOT touch any file other than docs/marketing-reference/audit.md. Do not run any shell commands that modify files. When done, print a one-line summary of what you wrote.
