# Marketing Performance & Load

**Last updated:** 2026-08-28
**Design/decision source:** `docs/marketing-task-load-plan.md` (the approved build spec — every number and rule)

## What it is

The Marketing OS's workload + scoreboard layer: capacity-aware task scheduling, per-role SLA due dates, a posting-cadence coverage calendar, creative ratings that grant XP toward rewards (a day off), a monthly late-counter discipline ledger (warnings → human-approved salary deductions), and monthly KPI salary bonuses (CPL/CTR) measured on ranged Meta ad numbers.

Two engines feed three ledgers:
- **Demand** — posting targets per platform × bucket (post/video) per day.
- **Supply** — per-role daily intake limits; the DB places every new stage-task on the earliest (day, person) with free intake.
- Ledgers: **XP/rating** (per finished creative + on-time closes), **discipline** (monthly counter: 3 warnings then day-salary deductions, all human-approved), **KPI bonus** (per-goal recipients, stacking).

Consequences ship **dark**: `discipline_observe=true`, `deductions_enabled=false` — everything records, nothing punitive can be approved until the manager flips the toggles on the Performance desk.

## Key behaviors

- **Placement**: `workflow_advance_role_path` / `workflow_role_path_start` call `mos_perf_place_open_task` after opening a task — resolves the bucket (`mos_load_buckets`), picks the earliest day+person under `mos_role_load` intake, stamps `opened_at`, and sets `due_at = opened_at + mos_role_sla hours` (leave-shifted). No capacity/SLA config → graceful legacy behavior. Placement errors WARN, never break the advance.
- **Intake counts the day a task OPENED** (closing frees nothing; the day rolling does). Manual reassignment (`task_transfer`) still overrides.
- **On-time XP**: +2 XP (trigger) when any workflow/manual task closes at or before `due_at`. Idempotent per task.
- **Late sweep** (`mos_perf_late_sweep`, Vercel cron `/api/cron/perf-sweep` every 10 min): open, non-blocked, past-due tasks of people not on approved leave → `late_flag` + one `mos_late_events` row + a month-ordinal `mos_discipline_actions` row (1–3 warning, 4+ deduction of 1 day) + an in-app notification. A task is late at most once.
- **Blocked** is manager-only (`manage_performance`) with a required reason; blocked time extends the due date on unblock. **Approved leave** shifts all open dues by the leave duration and exempts from the sweep.
- **Rating**: on a `done` creative, `rate_creative` holders pick one overall level (normal/good/very_good/excellent/very_excellent → 1/2/4/7/10 XP) with per-contributor overrides; every distinct assignee of the creative's done tasks gets a rating + XP. Re-rating adjusts the delta.
- **Rewards**: seeded "Day off = 250 XP". Claim reserves nothing until **approval**, which spends the XP. Manager approves/rejects on the desk.
- **Discipline decisions**: approve/reject on the desk; approving a deduction is refused while observe mode is on or deductions are off (`MOS:DEDUCTIONS_DISABLED`). Employees can dispute a pending action with a note.
- **KPI bonuses**: `mos_perf_kpi_goals` per month (metric cpl/ctr/cpc/leads/spend, comparator, target, bonus %, recipients = users or roles; optional campaign scope). Evaluated from **`mos_perf_paid_monthly`** — a monthly snapshot written by the daily 04:0x-Riyadh cron run via a **ranged** Meta insights pull (`getInsightsRange`), because the live `mos_campaign_executions` numbers are lifetime totals. CPL = spend/leads (SAR), CTR = clicks/impressions (0–1).
- **Coverage strip** on `/m/calendar`: **follows the calendar's view** — this week in week view, else this month — published (+scheduled) vs target-to-date per platform × bucket, with «ناقص N» shortfall flags + a «التفاصيل ←» link to the Organic page. Assists; never auto-schedules.
- **Coverage & cadence panel** on `/m/organic` (نبض المنصات): the detailed demand-vs-supply report. Week/Month toggle; an overall pace bar (published solid + scheduled light, with a vertical "where we should be today" marker) + per-platform × bucket pace bars with status (مكتمل / على المسار / ناقص N); and a **demand-vs-production-capacity** block — per bucket, the daily demand vs the slowest producer stage (finished-piece throughput = the bottleneck role from `mos_role_load`), flagging any structural gap. Shared math with the strip via `lib/coverage.ts`. Reporting only.
- **Structural gap** on the desk: cadence demand per bucket vs total role capacity — the "IG wants 3 videos/day but montage capacity is 2" signal.

## User flows

- **Employee** → `/m/me` (surface `myperf`, all marketing roles): XP + reward progress + claim, open tasks with SLA dues + late/blocked state, this-month late counter + "next miss = …", warnings/deductions + dispute box, leave requests, KPI-bonus status.
- **Manager** → `/m/performance` (surface `performance`; cap `manage_performance`, seeded to marketing_manager + ceo): pending discipline/leave/reward decisions, late+blocked tasks (block/unblock), team table (XP, late counts), load heatmap (opened-today vs capacity), KPI goal editor, and the six system toggles.
- **Manager** → Settings → **Load & SLA** (`/m/settings/load`) and **Posting cadence** (`/m/settings/cadence`), both `manage_roles`-gated.
- **Rating** → on a done creative's overview (`ContentDetailPage`), the `PerfRatingCard` appears for `rate_creative` holders.

## Data touched

New tables (migrations `2026-08-28_01..03`): `mos_load_buckets`, `mos_role_load`, `mos_role_sla`, `mos_posting_targets`, `mos_creative_ratings`, `mos_xp_ledger`, `mos_rewards`, `mos_reward_claims`, `mos_late_events`, `mos_discipline_actions`, `mos_leaves`, `mos_perf_kpi_goals` / `_recipients` / `_results`, `mos_perf_paid_monthly`, `mos_perf_settings` (single row of toggles). Columns added to `workflow_role_tasks` (+`bucket`, `blocked*`, `late_flag`) and `mos_manual_tasks` (`blocked*`, `late_flag`). New capabilities (data): `rate_creative`, `manage_performance`. New surfaces: `myperf`, `performance`. The manual-task guard trigger now bypasses system writes (no `auth.uid()`).

Deliberate separations: employee-bonus goals are `mos_perf_kpi_goals`, NOT the campaign `mos_goals`; XP/discipline hang on `public.users.id`.

## Key files

| Area | File |
|---|---|
| Spec (all decisions) | `docs/marketing-task-load-plan.md` |
| Core migration | `supabase/migrations/2026-08-28_01_mos_perf_core.sql` |
| Engine (placement, sweep, RPCs) | `supabase/migrations/2026-08-28_02_mos_perf_engine.sql` |
| Guard system-write bypass | `supabase/migrations/2026-08-28_03_mos_manual_task_guard_system_writes.sql` |
| Cron (sweep + monthly paid pull) | `api/cron/perf-sweep.ts` + `vercel.json` crons |
| Ranged Meta insights | `api/_lib/marketing/metaMarketingApi.ts` (`getInsightsRange`) |
| API actions (`perf_*`) | `api/marketing-os.ts` |
| Client types + fetchers | `src/lib/marketingOS/client.ts` |
| My profile | `src/pages/Marketing/MyPerfPage.tsx` |
| Manager desk | `src/pages/Marketing/PerformanceDeskPage.tsx` |
| Settings grids | `src/pages/Marketing/components/SettingsLoad.tsx`, `SettingsCadence.tsx` |
| Rating card | `src/pages/Marketing/components/PerfRatingCard.tsx` |
| Coverage math (shared) | `src/pages/Marketing/lib/coverage.ts` |
| Coverage strip | `src/pages/Marketing/components/CoverageStrip.tsx` |
| Coverage panel (Organic) | `src/pages/Marketing/components/CoveragePanel.tsx` (+ `OrganicPulsePage.tsx`) |
| Coverage API (from/to + capacity) | `api/marketing-os.ts` `perf_calendar` |
| Wiring | `src/pages/Marketing/{MarketingWorkspace,SettingsPage,CalendarPage,ContentDetailPage}.tsx`, `src/App.tsx` |

## Non-goals / guardrails

- No auto-publishing from the coverage calendar — it nudges only.
- Money NEVER moves automatically: deductions are created `pending`, and approval is refused until observe mode is off AND deductions are on.
- The assignee cannot self-block a task; blocked is manager-approved with a reason.
- Don't read monthly CPL/CTR off `mos_campaign_executions` — those are lifetime numbers; use `mos_perf_paid_monthly`.
