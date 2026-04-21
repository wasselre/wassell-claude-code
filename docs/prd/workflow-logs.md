# PRD: Workflow Execution Logs

**Status:** Live
**Last updated:** 2026-04-20
**Related PRDs:** workflow-automation.md

## What it is (in plain English)
Every time a workflow fires — successful, skipped, or failed — the system writes a detailed log entry. The Workflow Logs page shows all those entries, and clicking one opens a page that explains step-by-step what the workflow actually did: which conditions it checked (what it expected vs. what it actually read), which actions it ran, what values were resolved for each action, which records were touched, and a before/after diff of changed fields. Designed to answer "why did this happen?" (or "why didn't it happen?") without digging through code.

## Why it exists
Workflows mutate data silently in the background. When something surprising shows up in a record, users had no way to trace it back to the workflow that caused it — short of reading source code or guessing. Logs turn the engine into a white box: exact inputs, exact outputs, exact reasons for every skip.

## Key behaviors
- URL: `/workflow/logs` (list), `/workflow/logs/:runId` (detail). Entry points: Settings → Workflow Execution Logs card; Workflow list page → "Logs" pill button.
- **Every workflow firing creates exactly one `WorkflowRun` entry**, whether conditions pass or not. Skipped runs (conditions not met) are logged too, with the full condition trace, so users can see *why* a workflow didn't fire.
- **List page**: reverse-chronological stream with a stat strip (total / success / partial / skipped / failed), filterable by status, workflow, trigger model, and a full-text search over workflow name, record id, error, and record snapshot JSON. Each row shows: status dot, workflow name, trigger model + event, per-action summary (✓ executed / ⤼ skipped / ✗ failed), timestamp + relative time, duration, triggered-by user, cascade depth.
- **Detail page** — the deep trace — includes:
  - Summary strip: trigger model, event, record id, triggered-by user, duration, start/finish times, cascade depth, and any top-level error.
  - Jump links to the workflow editor and the triggering record.
  - **Conditions trace**: each condition with operator, expected value (from the workflow definition), actual value (from the trigger record), and — for `only_on_change` conditions — the `now` + `before` readings that decided whether the false→true transition fired. Green/red highlighting on pass/fail.
  - **Actions trace**: each action card expands to its type-specific body:
    - `update_record`: filter field, filter value source (static vs trigger field), resolved filter value, matched record id (or "no matching record found"), full field-mappings table (target field, source expression, resolved value), and a **before/after diff** of fields that changed.
    - `create_record`: created record id, dedup check result, field mappings table, new-record data table.
    - `send_notification`: the language the engine picked, the shown message, and both AR/EN templates for reference.
    - `assign_user`: assignment field, mode (specific vs role-based), role condition count, candidate count, selection strategy, previous assignee, new assignee (with name + email).
  - **Record snapshot section** (collapsible): the triggering record's full `data` at the moment the workflow fired, plus the previous-state data for `on_update` events.
  - **Copy JSON** button dumps the entire `WorkflowRun` to the clipboard for bug reports.
- **Retention**: the in-memory + localStorage log is capped at the most recent **500 runs** (newest first). Older runs drop off as new ones come in. This prevents busy installations from bloating storage while still giving plenty of context for diagnosis.
- **Storage**: like other entities, runs are mirrored to a `workflow_runs` table in Supabase when configured, and kept in `wassell_workflow_runs` in localStorage as the authoritative offline copy.
- **Admin-only**: the route is gated by `RequireAdmin` — regular users cannot read other people's runs.
- **Bulk clear**: "Clear all" on the list page wipes every run (with a confirmation). Individual runs can be deleted from the detail page.

## User flows
1. **Diagnose why a field changed unexpectedly:** open Workflow Logs → filter by the affected model → find the recent run against the offending record → open detail → read the diff table.
2. **Diagnose why a workflow didn't run:** filter by workflow → see a "Skipped" entry → open detail → condition trace shows which check failed and what the actual value was.
3. **Audit who triggered what:** filter by user (via the triggered-by column — future enhancement) or scan the "Triggered by" column on the list.
4. **Share a bug report:** open the run → click "Copy JSON" → paste into Slack/issue tracker.

## Data touched
- Writes: `workflow_runs` (definition as JSONB).
- Reads: `workflows` (to name the workflow), `models` (for trigger + target model labels and field labels in the diff/snapshot tables), `users` (for "triggered by" and "assigned to" labels), `records` (only via the snapshot already embedded in the run — we do not re-query records).

## Key files
| File | What it does |
|---|---|
| `src/pages/Workflow/WorkflowLogsPage.tsx` | List view with filters, stat strip, and row rendering |
| `src/pages/Workflow/WorkflowRunDetailPage.tsx` | Detail view — summary, conditions trace, actions trace, snapshots |
| `src/lib/workflowEngine.ts` | Builds the `WorkflowRun` trace as it executes each workflow and calls `logRun` when done |
| `src/stores/appStore.ts` | `workflowRuns` state + `appendWorkflowRun` / `deleteWorkflowRun` / `clearWorkflowRuns` mutations; wires the `logRun` callback when `executeWorkflows` is invoked |
| `src/types/index.ts` | `WorkflowRun`, `WorkflowRunStatus`, `WorkflowConditionTrace`, `WorkflowActionTrace`, `FieldMappingTrace` |
| `src/App.tsx` | Routes `/workflow/logs` and `/workflow/logs/:runId` |
| `src/pages/Settings/SettingsPage.tsx` | "Workflow Execution Logs" card in Settings |
| `src/pages/Workflow/WorkflowListPage.tsx` | "Logs" pill button in the header |

## Open questions / known limitations
- Retention is a hard cap (500). No time-based eviction, no per-workflow quota.
- No pagination — the list page renders all filtered runs. Fine for 500 entries, but if we raise the cap we'll want windowed rendering.
- No per-workflow log filter inside the editor yet (only the global page). The global page can be filtered by workflow, which covers the same use case.
- No export to CSV/JSON for the full page (only single-run Copy JSON). Good follow-up.
- Depth-exceeded runs (recursion cap hit) are silently dropped today — the engine returns before building a trace. Ideally we'd still emit a `depth_exceeded` run; status enum already exists for it.
- Logs don't record the record's final committed state (post-all-actions) — just the resolved-data snapshot at the time each action ran.
