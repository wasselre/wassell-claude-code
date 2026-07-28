# Marketing Management v2 — architecture decision record

**Status:** design approved for implementation; database migrations written, **not yet applied**.
**Date:** 2026-07-28
**Scope:** `/marketing-management` (إدارة التسويق). Does not touch `/marketing-intelligence` (ذكاء التسويق).

---

## Part 1 — Audit: what actually exists

Everything below was **probed against production** (`zhqqsxwealdwqzrbpwyv`) via PostgREST with the
service key on 2026-07-28, not read off migration filenames. Method: a missing table returns
`PGRST205`, a missing column returns `42703`, a missing function returns `PGRST202`. Absence and
emptiness are therefore distinguished.

### 1.1 The 22 management tables all exist — and are nearly empty

| Table | Rows | Table | Rows |
|---|---|---|---|
| mkt_internal_campaigns | **2** | mkt_content_tasks | **12** |
| mkt_internal_campaign_projects | 0 | mkt_approvals | **2** |
| mkt_internal_campaign_members | 0 | mkt_mgmt_comments | 0 |
| mkt_content_items | **1** | mkt_publications | **0** |
| mkt_content_platforms | 0 | mkt_performance_snapshots | **0** |
| mkt_content_status_history | **2** | mkt_lead_attributions | **0** |
| mkt_content_versions | 0 | mkt_intelligence_actions | 0 |
| mkt_video_details | 0 | mkt_mgmt_alerts | 0 |
| mkt_video_scenes | **3** | mkt_role_grants | **0** |
| mkt_post_details | 0 | mkt_carousel_slides | 0 |
| mkt_raw_assets | **2** | mkt_asset_links | 0 |

**This is the single most important finding.** The management system is structurally complete and
operationally unused: one content item (status `brief`, type `reel`, no campaign, no project), two
campaigns, twelve tasks, three scenes, two assets, two approvals, two history rows. **Zero
publications, zero performance snapshots, zero lead attributions.**

Consequence for this rebuild: the migration-risk section of the brief — backfilling live campaigns,
preserving publication history, avoiding double-counted revenue — is **almost entirely
hypothetical**. There is no history to damage. A structural refactor here is low-risk in a way it
would not be if these tables held a year of production data. The safety machinery is still built
(additive migrations, reconciliation queries, no destructive DDL), because the *code paths* must
survive even when the row counts are small.

### 1.2 The marketing-intelligence side is the opposite: large and live

| Table | Rows |
|---|---|
| mkt_observed_facts | **16,120** |
| mkt_collection_jobs | **4,020** |
| mkt_content_posts | **2,954** |
| mkt_organizations | **201** |
| mkt_insights | **49** |
| mkt_paid_ads | **10** |
| mkt_providers | 4 |

This is real, working, valuable data. **v2 does not touch any of it.** The only contact point is
`mkt_intelligence_actions`, which links an insight to the content produced in response.

### 1.3 The 2026-08-21 migration is confirmed NOT applied

All nine columns absent from `mkt_content_items` (`42703` on each): `organic_or_paid`,
`funnel_stage`, `content_angle`, `offer_message`, `cta_destination`, `tracking_link`,
`next_action`, `blocker`, `final_asset_id`. The RPC `mkt_content_next_statuses` is absent
(`PGRST202`).

Production is therefore running the fallback path shipped in `75c396c`: the content panel lists all
statuses with a caveat naming the missing function, and the nine fields return `503`. The prior
report was correct, and is now verified rather than believed.

### 1.4 What IS applied and working

Columns present on `mkt_content_items`: `content_number`, `project_id`, `campaign_id`,
`source_insight_id`, `photographer_user_id`, `target_audience`, `content_pillar`, plus the full
plan/creative/owner set.

Functions confirmed live by invocation:

| Function | Evidence |
|---|---|
| `mkt_content_status_allowed` | returned `true` for `writing → brief` |
| `mkt_mgmt_overview` | returned a full KPI/alert/coverage payload |
| `mkt_mgmt_generate_alerts` | ran, emitted 2 `campaign_without_content` |
| `mkt_generate_content_tasks` | rejected a fake id with `P0001 content item … not found` |
| `wassell_mkt_role` | returned a role string |
| `wassell_mkt_can` | returned a boolean |
| `mkt_asset_enqueue_processing` | returned `0` |

### 1.5 A live permissions gap

`mkt_role_grants` has **0 rows**, and `wassell_mkt_role` resolves to:

```
p_auth_uid IS NULL                  → 'none'
wassell_is_admin(p_auth_uid)        → 'administrator'
otherwise COALESCE(grant, 'viewer') → 'viewer'
```

So today: app admins have full marketing access; **every non-admin is read-only**, because nothing
grants a marketing role and no UI exists to grant one. This is not a design flaw — the fallback is
correctly conservative — but it means the ten-role matrix has never been exercised by a real
non-admin user. v2 adds a role-grant surface so it can be.

### 1.6 API and UI as built

`api/marketing-mgmt.ts` exposes **30 actions**: `overview`, `generate_alerts`, `campaign_list`,
`campaign_detail`, `campaign_save`, `content_list`, `content_detail`, `content_create`,
`content_update`, `content_transition`, `platform_set`, `version_create`, `approval_decide`,
`approval_list`, `task_update`, `scene_save`, `slide_save`, `scene_reorder`, `slide_reorder`,
`asset_list`, `asset_save`, `asset_process`, `asset_link`, `publication_list`, `publication_save`,
`performance_list`, `performance_record`, `attribution_record`, `intelligence_action`,
`intelligence_responses`.

UI: `MarketingManagementPage.tsx` + `AssetUploader`, `CampaignsTab`, `ContentEditor`,
`ContentSummary`, `PlanningTabs`, `ProductionEditor`, `QueueTabs`; library
`src/lib/marketingMgmt/{client,labels,projects}.ts`.

Existing SQL test files: `mkt_asset_processing_test.sql`, `mkt_fact_extraction_test.sql`,
`mkt_processing_health_test.sql`, `mkt_trend_insights_test.sql`, `claude_job_claim_test.sql`.
**No test covers the management schema's constraints.** v2 adds one.

### 1.7 Two operational hazards found

1. **No DDL path from this environment.** `exec_sql` does not exist (`PGRST202`); `psql` is not
   installed; no database password or Supabase access token is present in any env file
   (`.env.local`, `.env`, `.deploy-secrets.local`); the Supabase MCP requires an interactive OAuth
   flow. The service key performs reads and row writes through PostgREST, which **cannot execute
   DDL**. Every migration in this document is therefore written and committed but **unapplied**.
2. **Concurrent authorship.** Another agent is committing to this worktree and to `main` (e.g.
   `aafe713`, `1e7e481`, `7c39868`). v2 work must rebase before every push and must not stage files
   it did not create.

---

## Part 2 — Why the architecture changes

The audit confirms the brief's premise: the system begins at **campaign** and **content**. There is
no representation of a business objective, a strategy, a plan, a measurable goal, an initiative, or
a repeatable program. `mkt_internal_campaigns` carries `objective`, `target_leads`,
`target_revenue`, `target_cpl` — goal-shaped fields *inside* a campaign, which is why a goal cannot
outlive a campaign, cannot be shared by two campaigns, and cannot be allocated unevenly across
months.

v2 inserts the missing layers above campaigns and leaves the production machinery below them intact.

---

## Part 3 — Final terminology

| Term | Table | Lifetime | Contains |
|---|---|---|---|
| **Strategy version** | `mkt_strategy_versions` | years, versioned | positioning, audiences, value props, funnel, channel roles, priorities, non-priorities |
| **Plan** | `mkt_plans` | a period | one strategy version → goals, budget, capacity, portfolio |
| **Goal** | `mkt_goals` | a period | outcome \| kpi \| output, with a metric and a source of truth |
| **Target period** | `mkt_goal_target_periods` | a month/week | deliberate per-period allocation (never target ÷ 12) |
| **Initiative** | `mkt_initiatives` | months, outcome-oriented | hypothesis, scope, umbrella for programs + campaigns |
| **Program** | `mkt_programs` | ongoing, no end date | cadence + recurring output commitment |
| **Campaign** | `mkt_internal_campaigns` *(existing, extended)* | start → end | coordinated push, `campaign_class` organic \| paid |
| **Content pillar** | `mkt_content_pillars` | permanent | classification only — never a container |
| **Content item** | `mkt_content_items` *(existing, extended)* | — | one primary origin + many usages |
| **Usage** | `mkt_content_usage` | — | reuse of an approved item without changing its origin |
| **Channel plan** | `mkt_channel_plans` | a period | per-platform capacity and mix rules |
| **Allocation** | `mkt_capacity_allocations` | a week | program reservation \| campaign allocation \| reactive reserve |
| **Review** | `mkt_reviews` + `mkt_review_decisions` | weekly/monthly/quarterly | lessons and continue/change/scale/pause/stop |

**A program is not a permanent campaign. A campaign is not a project. A pillar is not a container.
An output commitment is not a business outcome.**

---

## Part 4 — Entity relationships

```
mkt_strategy_versions (chain via supersedes_version_id)
        │ 1
        ▼ n
mkt_plans (self-parent: annual → quarterly → monthly)
        ├──── mkt_goals (self-parent) ──── mkt_goal_target_periods
        ├──── mkt_plan_projects
        ├──── mkt_channel_plans ──── mkt_capacity_allocations
        ├──── mkt_reviews ──── mkt_review_decisions
        └──── portfolio
               ├── mkt_initiatives ──┬── mkt_programs
               │                     └── mkt_internal_campaigns (organic | paid)
               ├── mkt_programs            (may attach directly to a plan)
               └── mkt_internal_campaigns  (may attach directly to a plan)

mkt_internal_campaigns (paid) ──► mkt_platform_campaigns ──► mkt_ad_groups ──► mkt_ads
                                                                                │
mkt_content_items ◄─────────────── creative ────────────────────────────────────┘
   │ origin_kind ∈ {program, campaign, reactive, standalone}
   ├── origin_program_id  → mkt_programs
   ├── origin_campaign_id → mkt_internal_campaigns
   ├── primary_pillar_id  → mkt_content_pillars
   ├── mkt_content_item_pillars  (additional pillars)
   └── mkt_content_usage         (reuse: paid ad, second campaign, …)

mkt_activity_goals  — secondary goals for initiative | program | campaign
```

### 4.1 No unsafe polymorphism

The brief forbids `entity_type + entity_id` with no verifiable target. Where a row must point at
"one of several activity kinds", v2 uses **one nullable FK column per kind plus a CHECK that exactly
one is set**, and a `kind` column that must agree with which column is populated. Every reference is
a real foreign key; the database can always prove the target exists.

Applied to: `mkt_content_items.origin_*`, `mkt_activity_goals`, `mkt_capacity_allocations`,
`mkt_review_decisions`, `mkt_content_usage`.

`project_id` remains an unenforced uuid, consistent with the existing schema, because `all_projects`
lives as JSONB in `records` and no FK is possible. This is pre-existing and documented, not new.

### 4.2 Parent-child rules

- A plan's parent must be a plan of a **longer** type (monthly → quarterly → annual). Cycles blocked.
- A goal's parent goal must belong to the **same plan**.
- A program or campaign under an initiative must share that initiative's **plan**.
- A strategy version may supersede only an **approved** version, and not itself.
- An initiative, program or campaign that is **active** must have a plan, a primary goal, an owner.

### 4.3 Goals: three kinds, never conflated

```
goal_category = 'outcome' → 300 qualified organic leads / month
goal_category = 'kpi'     → 500,000 qualified impressions / month
goal_category = 'output'  → one original analytics report / week
```

`mkt_goal_target_periods` holds an explicit row per period. Seasonality is the default, not an
exception: an annual goal of 3,600 may be allocated 200 in January and 450 in December. Nothing in
the schema or the API divides a target by twelve.

### 4.4 Origin versus usage

A content item has **exactly one** production origin, fixed at creation. Reuse never rewrites it.

```
Weekly Analytics program → content item (origin_kind='program')
   → organic publication      (publication row)
   → later used in a paid ad  (mkt_content_usage row, usage_kind='paid_ad')
origin_kind stays 'program'.
```

---

## Part 5 — Status models

| Entity | States |
|---|---|
| Strategy version | draft → in_review → approved → superseded / archived |
| Plan | draft → in_review → approved → active → completed / cancelled / archived |
| Goal | draft → active → achieved / missed / abandoned; result on_track \| at_risk \| off_track |
| Initiative | proposed → active → paused / completed / cancelled; decision continue\|change\|scale\|pause\|stop |
| Program | draft → active → paused → retired / archived (no end date required) |
| Campaign | existing states preserved unchanged |
| Content item | existing 18 states preserved unchanged |

**Approved strategy versions are immutable**, following the same principle as approved content
versions: substantive columns cannot be edited once `approved`; only `status` may move to
`superseded` or `archived`. A change means a **new version**.

---

## Part 6 — The approval gate

A content item may sit in `idea`/`brief`/`writing` with no strategic context. It may **not** reach
`awaiting_final_approval`, `approved`, `ready_to_publish`, `scheduled` or `published` without:

1. a plan, 2. a primary goal, 3. an origin, 4. a primary pillar, 5. an audience,
6. a CTA or intended result where `cta_destination` applies.

Enforced by a trigger that raises a **single message listing exactly what is missing**, so the UI can
show the same list. Not a silent block.

---

## Part 7 — Capacity model

Capacity belongs to the **channel**, above any campaign.

```
mkt_channel_plans: platform=instagram, week capacity=21, reactive_reserve=2
mkt_capacity_allocations for a given week_start:
  program_reservation  Market Analytics    2
  program_reservation  Education           3
  program_reservation  Brand & Trust       2
  reactive_reserve                         2
  → campaign capacity available = 21 − 7 − 2 = 12
  campaign_allocation  six campaigns request 25
  → over-allocated by 13, with the six campaigns named
```

`mkt_capacity_status(channel_plan_id, week_start)` returns requested / reserved / available /
over-allocation plus the affected activities. Campaigns **request** deliverables; the master
calendar **decides** slots. A campaign deliverable ("produce four apartment tours") is a different
record from a publication ("post tour 2 to Instagram, Aug 12, 19:30").

---

## Part 8 — Paid hierarchy

```
mkt_internal_campaigns (campaign_class='paid')  ← normalized: objective, budget, dates,
        │                                          audience strategy, destination,
        ▼                                          conversion event, tracking, owner, status
mkt_platform_campaigns  (platform + platform_config jsonb + config_schema_version)
        ▼
mkt_ad_groups           (targeting jsonb + schema version)
        ▼
mkt_ads                 (creative → content item, copy, destination)
```

Platform specifics live in `platform_config` jsonb behind a `config_schema_version`, validated by a
per-platform function. There is deliberately **no universal form** merging every Meta/TikTok/
Snapchat/Google setting.

**Unverified, stated plainly:** the exact field vocabulary for each ad platform has **not** been
checked against current official documentation in this pass. v2 therefore ships the extensible
structure and a permissive validator, and does **not** claim platform parity. No ad-platform API
integration exists; nothing in v2 publishes to any network.

---

## Part 9 — Permission model

Thirteen new capabilities added to `wassell_mkt_can`, enforced in RLS:

`read_strategy` · `write_strategy` · `approve_strategy` · `read_plan` · `write_plan` ·
`approve_plan` · `manage_goals` · `manage_initiatives` · `manage_programs` · `manage_campaigns` ·
`manage_capacity` · `manage_paid_structure` · `review_performance`

| Role | Strategy | Plan | Goals / portfolio | Capacity | Paid |
|---|---|---|---|---|---|
| administrator, marketing_manager | write + approve | write + approve | manage | manage | manage |
| content_manager | read | read | manage programs/campaigns/goals | manage | — |
| writer / designer / video_editor | read | read | — | — | — |
| publisher | read | read | — | — | — |
| reviewer | read | read | — | — | — |
| sales | read | read | — | — | — |
| viewer | read | read | — | — | — |

**A writer cannot approve a strategy or a plan.** Existing content-approval and publishing
boundaries are unchanged.

---

## Part 10 — Roll-up rules

```
publication / ad  →  content item  →  program | campaign  →  initiative  →  goal  →  plan
```

- Performance snapshots stay **append-only**; the current value is the latest snapshot per
  publication, never a sum across captures of the same post.
- Attribution distinguishes **direct** from **influenced**.
- A content item reused in three places contributes **once** to each parent, and a lead is credited
  once per parent — reuse never multiplies a lead. Enforced by unique constraints on usage links and
  by counting distinct leads at each level.
- Organic, paid, account-level and content-level metrics are stored and reported separately.
- Missing ≠ zero; failed ≠ success; unsupported ≠ failed; partial coverage shows its denominator;
  forecasts are labelled as forecasts; derived values name their source.

---

## Part 11 — Migration mapping

| Legacy | v2 |
|---|---|
| `mkt_internal_campaigns` row | stays a campaign, same id/code/name/dates/budget/status; gains `plan_id`, `initiative_id`, `program_id`, `primary_goal_id`, `campaign_class` |
| `mkt_internal_campaigns.objective`, `target_*` | left in place; goals become the authoritative target, campaign columns retained for compatibility |
| `mkt_content_items.campaign_id` | retained and kept in sync; `origin_kind`/`origin_campaign_id` added alongside |
| `mkt_content_items.content_pillar` (text) | backfilled into `primary_pillar_id` FK; text column retained |
| content with no campaign | `origin_kind='standalone'`, `needs_classification=true` |
| approved versions, status history, approvals, publications, performance, attributions, asset links | **untouched** |

Legacy rows lacking strategic context are flagged `needs_classification`, **not** attached to a
fabricated strategy. A single holding plan exists only where referential integrity demands one, is
named as a migration holding record, and is never presented as an approved Wassel strategy.

## Part 12 — Non-goals

- No ad-platform API integration, and no claim of one.
- No automatic metric collection; snapshots stay manual until a collector is built.
- No organic auto-publishing; publication records what a human did.
- No deletion of any existing table or column in this phase.
- No change to `/marketing-intelligence` data or behaviour.
- No new top-level route: `/marketing-management` is preserved.
- No AI generation of strategy, plans or goals.
