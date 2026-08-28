# Marketing Task-Load, Cadence & Performance System — Build Spec

> **Status:** BUILT & SHIPPED 2026-08-28 (single phase; consequences dark — observe mode on,
> deductions off). This document is the decision record; the living PRD is
> `docs/prd/marketing-performance.md`.
> **Last updated:** 2026-08-28
> **Owner:** r.abanumay@wassel.re
> **Applies to:** the shipped **Marketing OS** (`mos_*`, `/m`). Not Sales, not the parallel `mkt_*` stack.

Every number and rule here is **decided**. Identifiers are the real ones from the live
`mos_*` schema. The only genuine open item is one data source (§14). Nothing else is open.

> **Which stack.** There are two marketing content stacks in the repo: **`mos_*`** (shipped,
> live at `/m`, cut over 2026-08-03) and **`mkt_*`** (a newer parallel content-ops layer, not
> yet wired into the `/m` UI). **We attach to `mos_*`.** `mkt_*` is referenced only where its
> richer vocabulary is useful.

---

## 1. What we are building (the one-paragraph version)

Marketing work is a pipeline: a **creative** (`mos_content` row) moves through a chain of
**stage-tasks** (`workflow_role_tasks`, one open at a time), write → review → edit → review →
publish. Today those tasks are handed out with no regard to how loaded a person already is,
there's no measure of whether we post as much as we intend, and nothing — good or bad — is
tied to finishing them well and on time. This build adds four layers on top of the existing
task chain:

1. **Capacity-aware scheduling** — every role has a *daily intake limit* per content bucket;
   new stage-tasks land on people/days so nobody is handed more new work than their limit.
2. **Posting-cadence planner + coverage calendar** — per platform we declare posts-per-day by
   type; a calendar shows target vs planned vs published and flags the gap.
3. **Rating + XP + rewards** — the marketing manager rates every finished creative; points
   accrue per contributor; points unlock a day off.
4. **Discipline + KPI-bonus** — a monthly late-counter escalating from warnings to
   human-approved salary deductions, and monthly team KPI goals that pay salary bonuses.

### Plain-language version
We give every marketing employee a **fair, automatic workload** and a **scoreboard**. The
system won't dump ten new jobs on someone who can only do four a day. It tells us daily whether
we posted as much as we planned. When a job is finished the manager grades it, and good, on-time
work earns points that become a day off. Missing deadlines stacks warnings, and after three in a
month it starts costing a day's pay — but a human always approves that before any money moves,
and you're never punished for waiting on someone else. Hit the month's ad-performance goals and
everyone picked for that goal gets a salary bonus.

---

## 2. Mental model: two engines, three ledgers

```
   ENGINE 1: DEMAND                        ENGINE 2: SUPPLY
   Posting cadence targets                 Role load / capacity
   (per platform × type × /day)            (per role × bucket × new-tasks/day)
            │                                        │
            │  creates creatives ───────────────────>│  places stage-tasks by
            │  (mos_content)                          │  intake limit + SLA
            ▼                                         ▼
        ┌──────────── THE TASK CHAIN (workflow_role_tasks) ─────────────┐
        │  mos_content → stage-task → stage-task → ... → published        │
        └─────────────────────────────────────────────────────────────────┘
            │                    │                     │
            ▼                    ▼                     ▼
   LEDGER A: XP/RATING    LEDGER B: DISCIPLINE   LEDGER C: KPI BONUS
   per finished creative  monthly late-counter   monthly team goals
   → points → day off     → warnings → deduction  → salary bonus %

   COVERAGE CALENDAR reads DEMAND vs the chain's output (planned / mos_publications).
```

**Most important derived output:** the *gap* between demand (cadence) and supply (capacity). If
Instagram demands 3 videos/day but total `montage` capacity produces 2/day, that structural
shortfall is shown loudly — worth more than any single-day nudge.

---

## 3. Glossary (exact meanings)

| Term | Meaning |
|---|---|
| **Creative** | One `mos_content` row moving through the pipeline. Has a `content_type_id` → `mos_content_types`. |
| **Content type** | `mos_content_types` rows: `post`, `video`, `carousel`, `story` (data, not enum). |
| **Load bucket** | The two buckets the operator thinks in: **`video`** and **`post`**. Mapping (default): `video→video`; `post,carousel,story→post`. Editable in Settings. |
| **Stage-task** | One `workflow_role_tasks` row: `subject_table='mos_content'`, `subject_id=<creative>`, owned by `role_key`, assigned to `assignee_user_id`, with its own `due_at`. Exactly one open per creative (`uq_workflow_role_tasks_one_open`). |
| **Open** | `status='open'`. Closing (`workflow_advance_role_path`) hands the creative to the next step; the creative is **not** finished. |
| **Queue** | Every creative currently parked at a step a given person owns. |
| **Capacity / daily load** | How many **new** stage-tasks may *open* in a person's queue per day, per bucket. A rate limit on **intake**, not backlog. |
| **SLA** | Hours a role gets to close a stage-task, from `opened_at` (not the creative's publish date). |
| **Due** | `opened_at + role SLA`, minus overlap with the owner's approved leave. Stored in the existing `workflow_role_tasks.due_at`. |
| **Late event** | An open, non-blocked stage-task past its `due_at` whose owner is not on leave. |
| **XP** | Cumulative points from ratings + on-time closes. Never resets. |
| **Late counter** | Per person, per calendar month, count of late events. Resets on the 1st. |

**Role keys** (real, from `roles` where `domain='marketing'`, internal short key = strip `mos_`):
`ceo`, `marketing_manager`, `ops_supervisor`, `writer` (**content writer**), `montage`
(**"Montier" / editor**). Fixed row uuids exist (`c0febe01-0000-4000-8000-0000000000 0{1..5}`).

---

## 4. Capacity engine (role load)

### 4.1 Bucket mapping — `mos_load_buckets`
```
mos_load_buckets
  content_type_id uuid PK  -> mos_content_types.id
  bucket          text     -- 'post' | 'video'
```
Seed: `video→video`; `post,carousel,story→post`. Editable in Settings so a new content type
maps cleanly.

### 4.2 Capacity config — `mos_role_load`
Set in **Settings → Load & SLA** (new sub-page; §10).
```
mos_role_load
  role_id          uuid  -> roles.id (domain='marketing')
  bucket           text  -- 'post' | 'video'
  daily_new_tasks  int   -- intake limit per day for this (role, bucket)
  PRIMARY KEY (role_id, bucket)
```
Seed (locked):
| role | post/day | video/day |
|---|---|---|
| `montage` (Montier) | 4 | 2 |
| `writer` (content writer) | 10 | 3 |
| every other marketing role | 0 (not a producer) — editable |

**Rule.** A stage-task's bucket (from the creative's content type via `mos_load_buckets`) draws
down the **owning role's** limit for that bucket. The same creative's `write` task (writer) and
later `edit` task (montage) hit different buckets, counted independently.

### 4.3 Scheduling rule
When a stage-task opens (the workflow advancing a creative, or a manual assignment), place it on
the **earliest day, on an eligible person, whose remaining intake for that (role, bucket) > 0**:

```
placement(task):
  candidates = users holding task.role_key, sorted by (today's remaining intake desc,
                                                        current queue size asc)
  day = today
  loop:
    for candidate with remaining_intake(candidate, day, task.bucket) > 0:
        set assignee_user_id, opened_at = start-of(day)
        return
    day += 1                      # nobody free today → push to next day (surface the gap)

remaining_intake(user, day, bucket)
   = mos_role_load(user's role, bucket).daily_new_tasks
   − count(stage-tasks that OPENED for that user/bucket on `day`)
```
- Intake is per **calendar day**; closing old tasks never frees intake, only the day rolling does.
- If no one has capacity for many days → **structural gap** on the coverage calendar + manager
  desk. Never silently queued forever.
- `workflow_role_task_transfer` (manual reassignment) may **override** placement; UI warns
  "puts <person> over their daily load" and records the override in `note`.

### 4.4 SLA — `mos_role_sla`
```
mos_role_sla
  role_id  uuid
  bucket   text          -- 'post' | 'video' | '*'
  step_key text NULL     -- optional finer key, e.g. 'review'; NULL = all steps
  sla_hours numeric
  PRIMARY KEY (role_id, bucket, coalesce(step_key,'*'))
```
Seed (locked): writer post **4h**, writer video **8h**; montage post **6h**, montage video **24h**;
any review step **4h**. `due_at = opened_at + sla_hours`, minus approved-leave overlap (§7.3).

---

## 5. The task chain — reuse + additions

**Reuse** `workflow_role_tasks` (already has `opened_at`, `due_at`, `closed_at`,
`closed_by_user_id`, `assignee_user_id`, `role_key`, `status IN ('open','done','skipped')`,
`result IN ('submitted','approved','changes_requested')`, `round`, the one-open constraint, and
the `workflow_advance_role_path` / `workflow_role_task_transfer` RPCs). Manual work stays on
`mos_manual_tasks`.

**Add** these columns to `workflow_role_tasks` (and mirror the blocked/late fields onto
`mos_manual_tasks` so manual work is measurable too):
```
+ bucket        text        -- denormalized via mos_load_buckets, for load + SLA keys
+ blocked       boolean default false
+ blocked_reason text
+ blocked_by    uuid        -- manager who marked it (manager-approved only)
+ blocked_at    timestamptz
+ late_flag     boolean default false
```
(`opened_at`/`due_at`/`closed_at`/`assignee_user_id` already exist — we only start *populating*
`due_at` at open time via SLA, and we set `opened_at` on placement.)

**Extend `workflow_advance_role_path`** so that when it opens the next step it: resolves `bucket`,
runs §4.3 placement to set `assignee_user_id` + `opened_at`, and computes `due_at` from
`mos_role_sla` (leave-adjusted). Keep it SECURITY DEFINER and atomic as today.

**Late detection** — a new tick in the Fly worker loop (every 5 min, same pattern as the existing
watchdogs): any open, `blocked=false` stage-task with `due_at < now()` whose owner is not on
approved leave → set `late_flag=true` and, once per task, insert one `mos_late_events` row.

---

## 6. Ledger A — Rating, XP, rewards

### 6.1 Ratings — `mos_creative_ratings`
When a creative reaches **done** (`mos_content_v.status_key='done'`), the marketing manager rates
it: one **overall** level, **optional per-contributor override**.
```
mos_creative_ratings
  id                  uuid pk
  content_id          uuid  -> mos_content.id
  contributor_user_id uuid  -> users.id
  contributor_role_id uuid  -> roles.id
  level               text  -- 'normal'|'good'|'very_good'|'excellent'|'very_excellent'
  is_override         boolean default false
  points              int
  rated_by            uuid  -> users.id
  created_at          timestamptz default now()
  UNIQUE (content_id, contributor_user_id)
```
Level → points (locked): `normal 1 · good 2 · very_good 4 · excellent 7 · very_excellent 10`.
Contributors of a creative = distinct `assignee_user_id` across its closed `workflow_role_tasks`.
Manager picks one overall level → a row per contributor at that level → optional per-person bump
(`is_override=true`).

### 6.2 XP ledger — `mos_xp_ledger` (append-only)
```
mos_xp_ledger  id, user_id -> users.id, source ('rating'|'on_time'|'reward_spend'|'adjustment'),
               ref_id uuid null, points int, created_at
```
- **Rating** → `+points`. **On-time** → `+2` when a stage-task closes with `closed_at <= due_at`,
  else `+0`. XP total = `sum(points)`, **never resets**.

### 6.3 Rewards — `mos_rewards` + `mos_reward_claims`
```
mos_rewards        id, label_ar, label_en, cost_xp int, kind ('day_off'), active bool
mos_reward_claims  id, user_id -> users.id, reward_id, cost_xp,
                   status ('requested'|'approved'|'rejected'|'consumed'),
                   decided_by, requested_at, decided_at
```
Seed: one reward — **day off, 250 XP**. On **approval** insert a `reward_spend` XP row of
`−250` (a rejected claim costs nothing). Profile shows progress to the next affordable reward.

---

## 7. Ledger B — Discipline

### 7.1 Late events — `mos_late_events`
```
mos_late_events  id, user_id -> users.id, task_id, content_id, month_key text ('YYYY-MM'),
                 created_at.  UNIQUE (task_id)   -- late at most once
```

### 7.2 Escalation — `mos_discipline_actions`
Monthly counter = `count(mos_late_events for user & month)`. Each late event fires one action by
its **ordinal within the month**: `1,2,3 → warning (إنذار)`; `4+ → one day's salary deduction, each`.
```
mos_discipline_actions
  id, user_id -> users.id, month_key, ordinal int, kind ('warning'|'deduction'),
  status ('pending'|'approved'|'rejected'|'disputed'), amount_days numeric null,
  late_event_id, dispute_note text null, decided_by, decided_at, created_at
```
**Money never moves automatically.** A `deduction` is `pending` until a manager/HR sets it
`approved`. Warnings are `pending → approved` too (the manager issues the notice). The employee
sees every pending action on their profile and may attach a `dispute_note` before a decision.
Full audit (who/when/why). **Counter resets** monthly (new `month_key`); history retained.
Under **observe mode** (§11) events + actions are still recorded but shown as "would-be" and no
approval UI is exposed.

### 7.3 Leave — `mos_leaves`
```
mos_leaves  id, user_id -> users.id, start_at, end_at, kind ('annual'|'sick'|'other'),
            status ('requested'|'approved'|'rejected'), approved_by, created_at
```
Approved leave **pauses the SLA clock**: when computing `due_at` and in the late-sweep, subtract
hours overlapping any approved leave window. Shifts every due date by the leave duration; does not
forgive a specific task.

### 7.4 Blocked (manager-approved only)
`blocked` is set **only** by a manager (`blocked_by`, `blocked_reason`) — the assignee cannot
self-block. Blocked tasks are excluded from the late-sweep. On unblock,
`due_at += now() − blocked_at` so the block's duration doesn't count against the owner.

---

## 8. Ledger C — KPI bonus (named to avoid the campaign `mos_goals` collision)
> `mos_goals` already exists for **campaign** KPIs. These employee-bonus tables use a
> `mos_perf_` prefix and are separate.
```
mos_perf_kpi_goals
  id, month_key, metric text ('cpl'|'ctr'|...), comparator ('lte'|'gte'), target numeric,
  bonus_pct numeric (50 = +50% salary), label_ar, label_en, created_by, created_at

mos_perf_kpi_recipients
  goal_id, subject_kind ('user'|'role'), subject_id, PK (goal_id, subject_kind, subject_id)

mos_perf_kpi_results
  goal_id pk, actual numeric, hit boolean, evaluated_at
```
- Recipients chosen **per goal** (a user or a whole role). Two goals hit → both bonuses stack.
- Seed shape: two example goals — **CPL ≤ target (SAR), +50%** and **CTR ≥ target (fraction 0–1),
  +50%** — targets entered by the manager. Units: `spend` is major SAR; CPL = spend/leads (SAR);
  CTR = clicks/impressions (0–1). `comparator='lte'` for CPL, `'gte'` for CTR.

### 8.1 Metric source (resolved)
Our own paid performance lives on **`mos_campaign_executions`** (per campaign: `spend`,
`impressions`, `clicks`, `leads`, `platform`, `platform_campaign_id`, `source`, `updated_at`) and
`mos_execution_ads` (per ad), synced from Meta by `api/cron/meta-sync.ts` → `mos_meta_sync_apply`
("Meta is source of truth"). CPL/CTR are **derived** (not stored).

**Monthly-window fix (must not be skipped).** The sync pulls insights at `date_preset='maximum'`
(`metaMarketingApi.ts` `getInsights`), so the stored `spend/impressions/clicks/leads` are
**lifetime totals, not monthly** — reading them directly would evaluate a lifetime CPL, not the
month's. Resolution:
1. Extend the Meta client to accept a **`time_range`** (month window) — it already takes a
   `datePreset` param, add ranged pulls.
2. New table **`mos_perf_paid_monthly`** — one row per (month_key, campaign_execution_id) with
   `spend, impressions, clicks, leads`, written by a **monthly Fly-worker tick** that pulls the
   just-closed month's insights. This gives queryable month-over-month history and an audit trail
   of exactly what each bonus was based on (survives a later Meta re-sync / outage).
3. `mos_perf_kpi_results.actual` is computed from `mos_perf_paid_monthly` for the goal's month,
   over the goal's **scope**: default **account-wide** (all our paid executions under the
   Meta-sync holder + human-linked project campaigns); optional per-goal campaign filter
   (add `mos_perf_kpi_goals.scope_campaign_ids uuid[] NULL`).

---

## 9. Posting cadence + coverage calendar

### 9.1 Targets — `mos_posting_targets` (the genuine new demand object; none exists today)
Set in **Settings → Posting cadence**, surfaced read-only on `/m/organic`.
```
mos_posting_targets
  id, platform text, bucket text ('post'|'video'), per_day int, weekday int null (0=Sun),
  active bool.  UNIQUE (platform, bucket, coalesce(weekday,-1))
```
Platforms match `mos_platform_accounts` / `mos_publications.platform` (free text; live values
`instagram, tiktok, x, snapchat`, plus manual `website`). Example (locked): Instagram → `video 2/day`,
`post 1/day`.

### 9.2 Coverage calendar
Extend the existing **`/m/calendar`** (`CalendarPage.tsx`, surface_key `calendar`). Month grid,
day × platform:
- **Target** — `mos_posting_targets`.
- **Planned** — creatives whose intended publish day = that day (`mos_content.target_publish_at` /
  scheduler output).
- **Published** — actual posts that day from `mos_publications` (`status='published'`,
  `published_at`), read via `mos_publication_v`.

Cell states: on-target (green), short (amber, "2 videos short"), over (grey). A short cell
**nudges** ("increase output"); it never auto-schedules a placement (organic publishing stays
manual/approved — we assist, we don't post for you). A month banner shows the structural
demand-vs-capacity gap from §4.3.

---

## 10. Screens (wired to the real shell)

New `/m` pages go in `src/App.tsx` (~L498–538, inside `<MarketingWorkspace>`), a rail item in
`MarketingWorkspace.tsx`, and a `surface_key` seeded in `surface_access`. Settings sub-pages go in
`SettingsPage.tsx` `SECTIONS[]` + the render switch + a `Settings*.tsx` component.

| Screen | Where | Gate | Content |
|---|---|---|---|
| **Load & SLA** | Settings sub-page (new slug `load`) | `manage_roles` | `mos_role_load` + `mos_role_sla` + `mos_load_buckets` grids. |
| **Posting cadence** | Settings sub-page (new slug `cadence`) | `manage_roles` | `mos_posting_targets` editor. |
| **Coverage calendar** | extend `/m/calendar` (surface `calendar`) | `calendar` surface | §9.2. |
| **My profile** | new `/m/me` (surface `myperf`) | everyone (self) | XP + level, reward progress + claim, this-month late counter + "next miss = …", pending warnings/deductions + dispute box, this-month KPI-bonus status, today's load/queue. |
| **Rating control** | on a done creative (`ContentDetailPage.tsx`) | new cap `rate_creative` | overall level + per-contributor override. |
| **Manager desk** | new `/m/performance` (surface `performance`) | new cap `manage_performance` | approve/reject warnings & deductions, mark blocked, approve leave, approve reward claims, set KPI goals+targets+load+SLA, load heatmap + structural gap. |

**New capabilities to seed** in three synced places (CLAUDE.md rule): the `role_capabilities` seed
migration, the `Capability` union in `MarketingWorkspace.tsx` (~L108–119), and the server registry
in `api/marketing-os.ts`. Add: `rate_creative`, `manage_performance` (grant both to
`marketing_manager`; `manage_performance` also to `ceo` for KPI/bonus). Coverage calendar reuses the
existing `calendar` surface/capability. Seed the new `myperf` + `performance` `surface_key`s per
role.

---

## 11. Global toggles (one phase, safe rollout) — `mos_perf_settings`
Single-row, `manage_performance`-gated:
```
mos_perf_settings
  ratings_enabled     bool default true
  xp_rewards_enabled  bool default true
  discipline_observe  bool default true    -- TRUE = record but no consequences
  deductions_enabled  bool default false   -- money only moves when TRUE
  kpi_bonus_enabled   bool default true
  cadence_enabled     bool default true
```
Everything builds at once. `discipline_observe=true` + `deductions_enabled=false` mean the
discipline engine **runs and records** from day one but renders "would-be" numbers and exposes no
approval UI, so the operator watches real data before turning consequences on. No second phase.

---

## 12. Permissions & RLS
- All new tables enable RLS, gated through `public.wassell_mos_can(<capability>, auth.uid())`
  exactly like existing `mos_*` — **never** gate on the active role string (CLAUDE.md).
- Self-service reads (own profile, own leave request, own dispute note) owner-scoped via
  `user_id = public.wassell_app_user_id(auth.uid())`. Admin bypass via `wassell_is_admin(auth.uid())`.
- All writes go through `api/marketing-os.ts` action handlers (like `capability_set`/`surface_set`)
  — never the browser store.

---

## 13. New objects summary
Tables: `mos_load_buckets`, `mos_role_load`, `mos_role_sla`, `mos_creative_ratings`,
`mos_xp_ledger`, `mos_rewards`, `mos_reward_claims`, `mos_late_events`,
`mos_discipline_actions`, `mos_leaves`, `mos_perf_kpi_goals`, `mos_perf_kpi_recipients`,
`mos_perf_kpi_results`, `mos_perf_paid_monthly`, `mos_posting_targets`, `mos_perf_settings`.
Columns added: `workflow_role_tasks` + `mos_manual_tasks` (`bucket`, `blocked*`, `late_flag`).
RPC extended: `workflow_advance_role_path` (placement + SLA due). New RPCs: rate, claim/decide
reward, decide discipline, request/approve leave, mark blocked, set goals/targets/load/sla, toggle
settings. Worker: late-sweep tick + monthly KPI eval + leave-adjusted due recompute.

---

## 14. Anchors — ALL CONFIRMED
Confirmed against the live schema (from the grounding pass):
- Task chain: `workflow_role_tasks` (+ `mos_manual_tasks`), RPCs `workflow_advance_role_path` /
  `workflow_role_task_transfer`, one-open index `uq_workflow_role_tasks_one_open`. ✔
- Creative: `mos_content` + `mos_content_types` (`post/video/carousel/story`), status derived via
  `mos_content_v`. ✔
- Roles: `roles` (domain='marketing', keys `mos_ceo/mm/ops/writer/montage`), `role_capabilities`,
  `wassell_mos_can`, user↔role via `users.role_assignments`. ✔
- Users/auth: `public.users.id`, `users.auth_uid = auth.uid()`, `wassell_app_user_id()`,
  `wassell_is_admin()`. ✔
- Organic published column: `mos_publications` / `mos_publication_v`, `mos_platform_accounts`. ✔
- Calendar surface `calendar` (`CalendarPage.tsx`) + Settings mechanics (`SettingsPage.tsx`
  `SECTIONS`), surface_access model. ✔

- Paid CPL/CTR source: **`mos_campaign_executions`** + `mos_execution_ads` (`spend/impressions/
  clicks/leads`), Meta-synced via `api/cron/meta-sync.ts` / `mos_meta_sync_apply`. CPL/CTR derived.
  Stored values are **lifetime** (`date_preset='maximum'`) → monthly window handled by
  `mos_perf_paid_monthly` + a ranged Meta pull (§8.1). ✔

Nothing open. `mos_metric_snapshots` / `mos_account_metrics` are *organic engagement* — deliberately
NOT used for CPL/CTR.

---

## 15. Build sequence (inside the single phase)
1. Migration: all §13 tables + the task-table columns + `mos_perf_settings` + seed
   `mos_load_buckets` / `mos_role_load` / `mos_role_sla` / `mos_posting_targets` / `mos_rewards` /
   the two new capabilities + the two new `surface_key`s. Apply via Supabase MCP (CLAUDE.md
   standing rule — apply, don't ask).
2. Extend `workflow_advance_role_path` (placement + SLA due); add the write RPCs.
3. Fly worker: late-sweep tick; a **monthly paid-metrics tick** (ranged Meta pull → fill
   `mos_perf_paid_monthly`) + monthly KPI eval off it; leave-adjusted due recompute. Extend the
   Meta client with a `time_range` pull (§8.1).
4. `api/marketing-os.ts`: action handlers + include the new bootstrap fields (perf settings,
   capabilities).
5. UI: Settings sub-pages (Load & SLA, Posting cadence), coverage calendar on `/m/calendar`,
   `/m/me` profile, rating control on `ContentDetailPage`, `/m/performance` manager desk. Sync the
   `Capability` type + rail + `surface_access`.
6. Verify live (deploy + smoke, CLAUDE.md): push a test creative through the chain, watch `due_at`
   compute, force a late event in observe mode, rate a creative and see XP, file a leave and watch a
   due date shift, mark blocked, hit a test KPI goal.

---

## 16. PRD follow-up
User-facing marketing behavior → after build, add a new `docs/prd/` PRD ("Marketing performance &
load"), cross-link from the marketing task/content PRDs, and run `npm run sync:prds`, per the
CLAUDE.md living-docs rule.
