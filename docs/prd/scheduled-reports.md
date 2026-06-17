# PRD: Scheduled Reports

**Status:** Live + verified in prod (2026-06-17) — run-now, automatic scheduler, and source-value match all confirmed. Email is **draft-only** today (`RESEND_API_KEY` not configured). See Verified.
**Last updated:** 2026-06-17
**Related PRDs:** [dashboards.md](dashboards.md), [workflow-automation.md](workflow-automation.md), [access-control.md](access-control.md), [logs.md](logs.md)

## What it is (in plain English)
Scheduled Reports lets an admin put a **dashboard, a single widget, or a saved metric** on a **Riyadh-time schedule** (daily / weekly / monthly) and have its result delivered by **email** — or, when no email provider is configured, **stored as a viewable draft**. It is the **second consumer of the universal analytics engine** after dashboards: a report computes the *exact same numbers* a dashboard widget shows, because it runs the **same `runAnalyticsQuery`** — never a second calculation path.

Each report runs **under its owner's data scope**: the server mints a short-lived owner JWT and queries through it, so a report can only ever see the rows its owner is allowed to see — it does **not** run with the unrestricted service role.

Admins manage reports from **Scheduled Reports** (admin-only): create, edit, pause/resume, delete, **Run now**, and inspect each report's **last result snapshot**, **run history**, and **error state**.

## Why it exists
Managers wanted recurring delivery of the dashboards they already build, without exporting by hand. Reusing the analytics engine guarantees the emailed number equals the dashboard number; owner-scoping guarantees a report never leaks data the recipient's owner couldn't see in-app.

## Architecture (the hard rules)
- **One engine, no second math.** The runner ([api/_lib/reportRunner.ts](../../api/_lib/reportRunner.ts)) resolves the report's source into one or more `AnalyticsQuery` sections and runs each via `runQueryWithClient` → `runAnalyticsQuery` (the dashboards' engine). No report-specific aggregation exists.
- **Owner-scoped execution.** `mintOwnerJwt(owner_auth_uid, SUPABASE_JWT_SECRET)` produces a 5-minute HS256 user JWT (`sub = owner_auth_uid`, `role/aud = authenticated`, via `node:crypto` — no JWT dependency). Records are read through an **anon-key client carrying that JWT**, so PostgREST applies the owner's RLS. The **service role is used only** to load report config and to write run logs / snapshots / status — never to read report data.
- **Scheduling = the existing queue pattern.** The Fly worker polls `scheduled_report_claim_due()` (active + `next_run_at <= now()`, `FOR UPDATE SKIP LOCKED`) and POSTs `/api/internal/run-report` (shared secret `REPORTS_RUNNER_SECRET`); `scheduled_reports_watchdog()` resets a run stuck >10 min. `next_run_at` is computed only by `scheduled_report_next_run()` (the single source of Riyadh date math) — set on create/edit/resume by the `scheduled_reports_fill_next_run` BEFORE-INSERT/UPDATE trigger (which excludes the running→active transition so the runner's own write isn't clobbered) and after each run by the runner.
- **Run now** ([api/scheduled-reports/run-now.ts](../../api/scheduled-reports/run-now.ts)) is the admin path: authorized by the **caller's JWT against the table's admin RLS** (only a caller who can SELECT the report — i.e. an admin — may run it), then runs the **same owner-scoped `runReportById('manual')`** — never the admin's scope, never bypassing owner RLS.
- **Email or draft.** `deliver()` POSTs Resend when `RESEND_API_KEY` is set; otherwise the rendered email is **stored as a draft** in the run snapshot. Snapshots **never include record ids** (engine runs with `includeRecordIds:false`).
- **Never silent.** The runner never throws — every failure is written to the report (`status`, `error_message`, `last_status`) and a `scheduled_report_runs` row.

## Key behaviors
- Source types: **dashboard** (all chart widgets; `table` widgets excluded), **widget** (one chart widget), **metric** (a saved metric), and **custom** (a raw `AnalyticsQuery`, supported by the runner).
- Status: **active / paused / running / error**; last outcome **sent / draft / failed / partial**. A **paused** report is never claimed (the claim filters `status='active'`).
- The admin UI shows status, **next run**, **last run**, **data as of**, **emailed vs. draft**, the result snapshot, error state, and the **owner** whose scope it runs under. The list **refetches** on mount / after actions (it is not realtime-published).

## User flows
- **Create:** pick a source (dashboard/widget/metric), a frequency + Riyadh hour (+ weekday / day-of-month), recipients (optional) → Save. The report becomes `active`; the trigger sets its first `next_run_at`.
- **Operate:** Run now (immediate owner-scoped run), Pause/Resume, Edit, Delete; expand to read the latest snapshot + last runs.
- **Scheduled:** the worker runs due reports; the UI reflects the run + snapshot on its next refetch.

## Data touched
- `scheduled_reports` (config + server-maintained run state; admin RLS) and `scheduled_report_runs` (per-run history; admin RLS). Report DATA is read through the owner-scoped client over `unified_records` (owner RLS). Config reads (dashboards, metric_definitions) use the service role.

## Env / activation runbook
The feature ships dormant until these are set (the runner refuses to mint a token without the secret — **verified to fail safely**: it records a clear error and leaks no data):

| Var | Where | Required? | Purpose |
|-----|-------|-----------|---------|
| `SUPABASE_JWT_SECRET` | Vercel (prod) | **Yes** | Mint the owner-scoped JWT. The Supabase project's JWT secret (Supabase → Settings → API → JWT Secret). |
| `REPORTS_RUNNER_SECRET` | Vercel **and** Fly worker | **Yes** | Shared secret gating `/api/internal/run-report` + the worker's scheduler loop ("feature on"). |
| `APP_URL` | Fly worker | Yes | Base URL the worker POSTs (`https://app.wassel.re`). |
| `RESEND_API_KEY` | Vercel (prod) | Optional | When set, reports email via Resend; otherwise results are stored as drafts. **Currently NOT set → v1 delivers stored drafts only** (verified live: a recipient-bearing scheduled run produced `delivery: draft` and sent no email). Set it (+ `REPORTS_FROM_EMAIL`) to enable live email. |
| `REPORTS_FROM_EMAIL` | Vercel (prod) | Optional | From address (default `Wassel Reports <reports@wassel.re>`). |

`CRON_SECRET` is unrelated (it gates the follow-ups sweeper). After setting these + redeploy, **smoke test**: create a report from a dashboard, **Run now**, confirm the result matches the dashboard, the run row + snapshot appear, and delivery is `sent` (with Resend) or `draft` (without).

## Verified (live in prod, 2026-06-17)
- **Schema/scheduling primitives:** Riyadh next-run math (daily/weekly/monthly) ✓; `next_run_at` set on create by the trigger ✓; `claim_due` claims active-due and **excludes paused** ✓.
- **Run-now (manual):** created a report from a dashboard via the live UI → owner-scoped run produced a real snapshot (no JWT error → `SUPABASE_JWT_SECRET` is set), stored as a draft for 0 recipients, run-history written ✓.
- **Automatic scheduler:** a due report was **claimed and run by the Fly worker** (`triggered_by:'schedule'`, clean, snapshot written, `next_run_at` advanced) → `REPORTS_RUNNER_SECRET` matches on **both** Vercel + Fly and `APP_URL` is set on the worker (all 5 worker machines running) ✓.
- **Source-value match:** the report snapshot total (**126**) equals the value shown on the source dashboard's widget ✓.
- **Email/draft:** `RESEND_API_KEY` is **not configured**, so a recipient-bearing run produced `delivery: draft` and **sent no email** — v1 is draft/stored-output only until Resend is set ✓.
- **Failure path:** the internal runner endpoint returns **401** on an invalid or missing `REPORTS_RUNNER_SECRET` (no run, no data); and the runner **fails safely without `SUPABASE_JWT_SECRET`** (failed run recorded, clear error, **no service-role data fallback**, no crash) ✓.

## Key files
| Area | File |
|------|------|
| Schema + RPCs + triggers | [supabase/migrations/2026-06-17_scheduled_reports.sql](../../supabase/migrations/2026-06-17_scheduled_reports.sql) |
| Runner (owner JWT + engine + deliver) | [api/_lib/reportRunner.ts](../../api/_lib/reportRunner.ts), [api/_lib/reportEmail.ts](../../api/_lib/reportEmail.ts) |
| Shared server analytics executor | [api/_lib/analyticsRun.ts](../../api/_lib/analyticsRun.ts), [api/analytics.ts](../../api/analytics.ts) |
| Endpoints | [api/internal/run-report.ts](../../api/internal/run-report.ts) (worker), [api/scheduled-reports/run-now.ts](../../api/scheduled-reports/run-now.ts) (admin) |
| Worker scheduler | [worker/src/index.ts](../../worker/src/index.ts) (`claimAndRunDueReports`, `runReportsWatchdog`) |
| UI | [src/pages/Dashboard/ScheduledReportsPage.tsx](../../src/pages/Dashboard/ScheduledReportsPage.tsx), [src/pages/Dashboard/components/ScheduledReportModal.tsx](../../src/pages/Dashboard/components/ScheduledReportModal.tsx) |
| Store / types | [src/stores/appStore.ts](../../src/stores/appStore.ts) (`scheduledReports` slice), [src/types/index.ts](../../src/types/index.ts) (`ScheduledReport`, `ScheduledReportRun`) |

## Out of scope (v1)
Authoring a raw custom `AnalyticsQuery` in the UI (the runner supports `source_type='custom'`; the form offers dashboard/widget/metric). Non-email delivery channels. AI "ask your data" (explicitly deferred).
