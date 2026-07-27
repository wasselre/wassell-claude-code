# PRD: Sales Studio 2.0 (Sales Strategy Layer)

**Status:** Live
**Last updated:** 2026-07-27 (**Hidden from the sidebar:** the `sales_studio` entry in `src/lib/customPages.ts` carries `hidden_from_sidebar: true`, so no nav link renders. The route `/sales/studio` (and its `experiments` / `processes/:id` children), its `RequirePageAccess` guard, and the per-profile access toggle are unchanged — a direct URL still opens Studio for anyone permitted. Restore = delete the flag.) | Previously 2026-06-21
**Related PRDs:** [sales-process.md](sales-process.md) (the executor + config layer it overlays), [followups-workspace.md](followups-workspace.md), [data-storage.md](data-storage.md)

## What it is (in plain English)
Sales Studio is the business-facing strategy layer for the Sales Operating System. A sales manager opens **Sales Studio** (`/sales/studio`) and sees a **library of Sales Processes** — named, versioned playbooks for how leads are worked from "New" to "Closed Won". Opening a process shows its **customer journey map**: every lifecycle stage with the workflows attached to it, each rendered as a plain-language business card (what it does, when it runs, what the branches/outcomes are, current timings/messages/assignment). The manager can **safely edit business-level values** (objective text, follow-up timing like `+2d @10:00`, WhatsApp templates, max attempts, assignment strategy, enable/disable a branch) without ever touching the deep Workflow Builder. Edits land in a **draft version**; publishing makes it active without disturbing the live one. Managers can **assign clients** to a process/version, run **A/B experiments** between two process versions, compare them with **real funnel analytics**, and **promote the winner**. The Workflow engine still executes everything — Studio only configures.

## Why it exists
The Sales OS workflow engine is powerful but technical. Managers need to tune strategy (timing, messaging, who gets the lead, which branches are on) and prove what works, without learning the raw workflow editor and without risking the live automation. Sales Studio gives them a safe, measurable strategy surface on top of the same single executor.

## Key behaviors
- **The Workflow engine remains the only executor.** Studio produces a *config-overlaid copy* of a workflow that the same engine runs (`applyProcessOverlayToWorkflow`). It never transitions a client itself — no second execution path.
- **Overlay = safe values only**, keyed by the LIVE workflow's `branch.id` / `action.id`: timing (`date_expression`), WhatsApp body, assignment strategy, branch enable/disable, max-attempts (drops a retry once the cap is hit), objective text. Triggers, target models, raw mappings, and JSON are NOT editable in Studio — those route to "Open in Workflow Builder".
- **Process-aware execution:** when a client has an active assignment with a `sales_process_version_id`, the store injects `buildProcessOverlayResolver` into `executeWorkflows`. The matching workflows run with that version's overlay. **No assignment → the workflow runs its built-in (legacy/default) behavior unchanged** — clearly isolated as the compatibility path.
- **Versioning is non-destructive.** Editing an active version forks a draft first (`ensureDraftVersion`). Publishing archives the prior active and activates the draft. Existing clients are **never silently migrated** — they stay on their assigned version until explicitly migrated (and only those with no open follow-up are eligible for the bulk "migrate" action).
- **One default process** (DB partial unique index); the default is the cohort for all unassigned clients. **One active + one draft version per process** (partial unique indexes).
- **Experiments** A/B two process versions. Assignment is manual, by rules, or deterministic random-split (`deterministicGroup` — stable per client+experiment, no reassignment drift). An active experiment must have both a control and a variant version. Groups persist on the assignment row AND mirror onto the client record (`experiment_group`).
- **Analytics are real and honest.** Funnel metrics are computed from `clients` + `followups` + the downstream models. "Reached a stage" = the client's current stage is at/past the milestone OR a linked downstream record exists. Metrics that can't be computed show `—` with a reason — **never faked**. Low sample size (<30/group) → recommendation is "inconclusive". No statistical certainty is claimed.
- **Promote winner** safely updates the right process/version records: promote variant to default, publish variant as active, create a new process from variant, archive the loser, or keep both — then marks the experiment completed with a result summary.
- **Bilingual + RTL/LTR** throughout (inline `isAr ? ar : en`, matching the Sales OS pages).
- **Access:** admin-only by default (`sales_studio` custom page, per-profile grantable). Non-admins see a read-only library if granted; editing is admin-gated.

## User flows
1. **First open (admin):** Studio auto-seeds the **Default Sales Process** + a v1 active version derived from the live sales workflows (`seedDefaultSalesProcess`, idempotent, DB-unique-index backed). The journey renders immediately.
2. **Tune a workflow:** open a process → Journey → a workflow card → "Edit simple". If viewing the active version, a draft is forked. Adjust timing/message/assignment/branches → "Save to draft" → "Publish draft" (confirm). Live clients keep their version until migrated.
3. **Assign a client:** "Assign client" → pick client + process + version (+ optional experiment group) + reason → prior active assignment is deactivated (history kept), new one created, client record mirrors the keys.
4. **Run an experiment:** Experiments → "Create experiment" → name/hypothesis, control + variant versions, primary metric, guardrails, assignment mode (+ split% / target rules). Activate → "Apply assignments" routes eligible clients. Open the experiment → control × variant funnel table + interpretation (winner, Δ, guardrail alerts, recommendation) → "Promote winner".
5. **Empty/error states:** empty library (CTA to create), process-not-found / experiment-not-found cards, unavailable metrics shown as `—` with hover reasons, missing-workflow advisory cards on the journey.

## Data touched
- **Reads:** `clients`, `followups`, `appointments`, `visits`, `offer_prices`, `reservations`, `financing`, `ownership_transfer` (JSONB records, for cohorts + funnels); `workflows` (+ `metadata.{managed_by,sales_stage,activity_type,outcome}`); `workflow_runs` (per-workflow metrics).
- **Writes:** `sales_processes`, `sales_process_versions` (`config_json` overlay), `sales_experiments`, `client_sales_process_assignments` (top-level tables, store slices). Plus 4 read-only JSONB keys on `clients` records: `current_sales_process_id`, `current_sales_process_version_id`, `current_sales_experiment_id`, `experiment_group`.
- **RPCs:** `sales_process_set_default`, `sales_process_publish_version` (atomic, SECURITY DEFINER, admin-gated). RLS: authenticated-read, admin-write (mirrors `sales_process_overrides`).

## Key files
| File | What it does |
|---|---|
| `supabase/migrations/2026-06-21_sales_studio_2.sql` | 4 tables + RLS + indexes + RPCs + clients-schema patch |
| `src/lib/salesStudio/overlay.ts` | The engine seam: `applyProcessOverlayToWorkflow`, `buildProcessOverlayResolver`, `resolveSalesProcessRule` |
| `src/lib/salesStudio/journey.ts` | Builds the journey map + workflow cards (plain-language, compatibility, editable surfaces) |
| `src/lib/salesStudio/analytics.ts` | Real funnel metrics + experiment comparison (availability-honest) |
| `src/lib/salesStudio/assignment.ts` | Rules matching + deterministic random-split |
| `src/lib/salesStudio/defaults.ts` | Derive v1 config from live workflows; default process seed |
| `src/lib/salesStudio/cohorts.ts` | Downstream-model + cohort resolution |
| `src/pages/SalesStudio/SalesStudioHomePage.tsx` | Process Library (`/sales/studio`) |
| `src/pages/SalesStudio/ProcessJourneyPage.tsx` | Journey map + version manager + assignment (`/sales/studio/processes/:id`) |
| `src/pages/SalesStudio/ExperimentsPage.tsx` / `ExperimentDetailPage.tsx` | Experiments list + analytics/promote |
| `src/pages/SalesStudio/components/**` | ProcessCard, CreateProcessModal, WorkflowCardView, WorkflowSimpleEditor, VersionManager, AssignClientModal, ExperimentBuilderModal, PromoteWinnerModal |
| `src/stores/appStore.ts` | Slices + CRUD actions + the `executeWorkflows` overlay-resolver injection |
| `src/lib/workflowEngine.ts` | `executeWorkflows` accepts the optional `resolveProcessOverlay` (last param) |
| `src/lib/salesStudio/__tests__/salesStudio.test.ts` | 17 unit tests (overlay, assignment, analytics) |

## Open questions / known limitations
- **Server-side `on_due` sweeper uses the legacy/default path** (no overlay). The client-side completion path (rep records an outcome → next action created) is process-aware; the scheduled-reminder sweeper (`api/_lib/workflowSweeper.ts`) runs the built-in workflow behavior. Wiring the overlay server-side (load assignments/versions in the sweeper) is the next hardening step.
- **Scope rules on multi-value frozen-model fields** are out of scope here (unchanged from the freeze posture).
- **Funnel "reached a stage"** is a current-stage-or-linked-record lower bound (no stage history table). Honest but conservative.
- **Compare active-vs-draft** is via the version selector (view each version's journey); a side-by-side field-level diff view is future work.
- **Client 360 assignment panel:** assignment lives in Sales Studio (modal reachable from the process/journey page). A dedicated panel inside the generic client form is future work.
- Max-attempts enforcement applies to retry `create_record` actions identified by `action.id`; it does not rewrite branch conditions.
