# Marketing Management v2 — architecture decision record

**Status:** implemented and applied to production. Plan↔strategy binding and the three-class goal
model landed 2026-08-25 (`2026-08-25_01`, `_02`, `_03`); verified by
`supabase/tests/mkt_plan_strategy_goal_test.sql` — 24 checks, run against production inside a
transaction that rolled back.
**Date:** 2026-07-28, last revised 2026-08-25
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

The column is **`goal_class`** (renamed from `goal_category` on 2026-08-25, when the old name was
freed up for an optional *theme*: acquisition, conversion, brand, …). The class is what kind of
thing the goal **is**; the theme is what it is **about**.

```
goal_class = 'outcome'           → 300 qualified organic leads / month   هدف نتيجة
goal_class = 'kpi'               → 12% lead→appointment conversion       مؤشر أداء
goal_class = 'output_commitment' → 48 published videos this year         التزام تنفيذي
```

Each renders differently, because each is judged differently — an outcome by result against target,
a KPI by its current reading and direction, a commitment by done-vs-required. One shared
target/actual/forecast card for all three is what made every goal look alike.

**A goal is not just a number.** `metric` and `unit` are separate columns and both are required to
activate, so a target of `900` cannot stand alone — 900 *of what* has to be answerable.
`aggregation_method` says how readings combine, and `source_of_truth` is a **key from a fixed list**,
not prose (existing free text was moved to `source_of_truth_note` and left visible).

**A missing baseline is not zero.** `baseline_state` ∈ known | unknown | not_applicable is required;
`known` additionally requires a number (`mkt_goal_baseline_known_has_value`). Nothing converts an
absent baseline into 0.

**Actuals are evidence, not entry.** `mkt_goal_measurements` is append-only (UPDATE and DELETE both
raise); `mkt_goal_actual()` combines the readings by the goal's aggregation method, and a trigger
refreshes the cached `mkt_goals.actual_value`. `actual_value` is deliberately **absent** from the
API's `GOAL_EDITABLE` list, so the only way the number moves is by recording a reading. With no
readings the answer is `{value: null, is_measured: false}` — unmeasured, not zero.

`mkt_goal_target_periods` holds an explicit row per period. Seasonality is the default, not an
exception: an annual goal of 3,600 may be allocated 200 in January and 450 in December. Nothing in
the schema or the API divides a target by twelve.

**Allocation validation follows the metric.** `mkt_goal_allocation_status()` only requires periods to
sum to the target when `aggregation_method = 'sum'`. For a rate, percentage or "latest reading"
metric, `difference` and `consistent` come back **null** with a note — demanding that monthly
conversion rates add up to an annual conversion rate is the classic spreadsheet error, and the
function refuses to make it.

### 4.3.1 A plan is bound to an exact strategy version

`mkt_plans.strategy_version_id` points at one immutable version, and **a plan never follows the
strategy forward on its own**. Approving a newer version leaves every existing plan where it is.

- `mkt_tg_plan_needs_approved_strategy` refuses `approved`/`active` unless the bound version is
  itself `approved`. `mkt_plan_missing_requirements()` names the same blockers the trigger raises,
  so the screen and the database can never disagree about why a button is disabled.
- Moving a plan is an explicit act: `mkt_plan_rebase_strategy(plan, version, reason)`, surfaced as a
  confirmation showing current vs proposed. There is no automatic migration path.
- Every change appends to `mkt_plan_strategy_links` (from, to, plan status at the time, reason, who,
  when). The table is append-only — UPDATE and DELETE raise. `changed_at` defaults to
  `clock_timestamp()`, not `now()`, so entries written in one transaction are still strictly ordered.

Legacy plans with no strategy were **flagged** (`needs_classification = true`), never given an
invented binding.

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
| Goal | draft → active → achieved / missed / abandoned; result on_track \| at_risk \| off_track. `active` is gated on a complete definition (`mkt_goal_missing_requirements` empty) |
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

## Part 13 — Portfolio rebuild (2026-08-26)

### The bug that started it

Creating a campaign from Portfolio → `غير مصنّفة` → `جديد` failed with a raw Postgres message:

```
null value in column "code" of relation "mkt_internal_campaigns" violates not-null constraint
```

Three separate faults produced it:

1. `PortfolioCreateForm` rendered for **every** tab, and its submit treated any kind other than
   `initiatives`/`programs` as a campaign — including `unclassified`.
2. The code input only rendered for the organic and paid tabs, so the unclassified path posted a
   campaign with no `code`. `code` is `NOT NULL` with no default.
3. `rlsAware` had no `23502` branch, so PostgREST's own sentence reached the screen.

None of these is fixed by adding a code box. `Unclassified` is a **state legacy rows are in**, not a
creatable type; and an identifier the user has to invent is a defect in the schema.

### What changed

**Identity.** `mkt_campaign_code_seq` + `mkt_next_campaign_code()` issue `CMP-nnnn`. It is the column
DEFAULT *and* a `BEFORE INSERT` refill (PostgREST sends explicit nulls, which skip a DEFAULT).
`nextval` is atomic and does not roll back, so two concurrent creates cannot collide — no `MAX + 1`,
no browser-side counter. `code` was removed from `CAMPAIGN_EDITABLE`: a code a caller can set is a
code a caller can change. Existing hand-typed codes (`k`, `z`, `مينا 52`) are untouched; the sequence
starts above any existing `CMP-nnnn`.

**Two incompleteness states, permanently separated.**

| Condition | Means | Arabic |
|---|---|---|
| `campaign_class IS NULL` | nobody ever said organic or paid | `النوع غير محدد` |
| `needs_classification = true` | no plan or no primary goal | `السياق الاستراتيجي ناقص` |

An explicitly organic campaign with no goal is the second, and used to be labelled as the first.
`needs_classification` stopped being a one-time backfill flag and is now DERIVED by trigger on all
three portfolio tables, so it cannot drift.

**Integrity added.** A campaign's primary goal must belong to its own plan (initiatives and programs
already enforced this; campaigns had the gap). A new campaign must declare organic or paid. Dates
outside the plan period now need a RECORDED override (`period_override_reason` + who + when) instead
of a flat refusal real launches could not express. `mkt_camp_active_complete` gates activation on
plan + goal + owner + class + both dates. Deleting a record that carries content, ads, publications,
measurements or attribution is refused with a reason — archive is the supported path.

**Programs.** The recurring commitment is four explicit fields — `commitment_count` of `output_type`
every `every_n_periods` `commitment_unit` — so "3 project videos every week" is data the UI composes a
sentence from. Positive-value CHECKs on both counts. Still no end date.

**Errors.** `dbError()` maps `MKT:<token>` (raised by our own triggers/RPCs) and named constraints to
bilingual, actionable sentences, plus generics for `23502 / 23505 / 23503 / 23514 / 42501`. The
original error is always `console.error`-logged with code, details and hint. **No PostgREST text,
table name or constraint name reaches a user.** The client picks the Arabic or English side from the
interface language.

**Interface.** Three primary views replace the five filter tabs:
`خريطة المحفظة` (plan → goal → initiative → programs/campaigns, with goal-direct work shown in place,
and an "outside the hierarchy" group so unattached records stay visible), `القائمة`, and
`بحاجة للاستكمال` with a filter per missing thing. One `إنشاء` menu offers exactly four types;
Unclassified is not among them. All three record types open a drawer that edits, transitions, archives,
shows related records, results, review decisions, and the completion checklist the database enforces.

**One campaign system.** `CampaignsTab` lost its own create form (which asked for a code and never
asked for a plan, a goal or a type — the second creation path that filled the portfolio with
unattached campaigns). Both screens now read the same `portfolio_map` payload, render the same
`CampaignCard`, and edit through the same `RecordDrawer` and the same API actions. Portfolio =
strategic hierarchy and portfolio health; Campaigns = execution detail.

### Files

| File | Role |
|---|---|
| `supabase/migrations/2026-08-26_01_mkt_portfolio_integrity.sql` | sequence, triggers, CHECKs, delete guards, missing-requirements fns, `mkt_campaign_classify` |
| `supabase/migrations/2026-08-26_02_mkt_portfolio_fields.sql` | `budget_kind`, `conversion_objective`, `tracking_template`, `locations`, `property_types` |
| `supabase/tests/mkt_portfolio_test.sql` | 23 assertions; each fails against the pre-2026-08-26 schema |
| `scripts/check-mkt-portfolio-embeds.mjs` | runs every PostgREST select/RPC the endpoint sends against the live DB |
| `api/marketing-mgmt.ts` | `dbError`, `requirePortfolioContext`, `portfolio_map`, `portfolio_detail`, `campaign_classify`, `portfolio_secondary_goals_set`, `campaign_projects_set`, `portfolio_missing_requirements` |
| `src/pages/MarketingManagement/components/portfolio/` | `PortfolioView`, `CreateDrawer`, `RecordDrawer`, `cards`, `shared` |

### Known limitation found while doing this

`campaign_list` and `campaign_detail` embedded `mkt_content_items(id,status)` on
`mkt_internal_campaigns`. Since `origin_campaign_id` was added in `2026-08-22_03`, there are TWO
foreign keys between those tables and PostgREST rejected the embed with `PGRST201` — meaning the
Campaigns tab had been failing to load since v2 landed. Disambiguated to
`mkt_content_items!campaign_id(...)`. Reading the select string could not have found this; running it
did.

---

## Part 14 — Campaign taxonomy, content counting and the status machine (2026-08-27)

`2026-08-27_01_mkt_campaign_lifecycle.sql`. Four defects, two of them visible on screen.

### 14.1 Class, purpose and channel_mix were one question wearing three hats

`campaign_type` accepted **both** `'organic'/'paid'` **and** `'project_launch'/'awareness'/…` — a
CLASS and a PURPOSE in one column. That is the whole of `MKT:campaign_class_required`: the form
offered "type", the user picked `organic`, the form felt complete, and `campaign_class` stayed NULL
for `mkt_tg_campaign_portfolio_valid` to reject.

```
campaign_class  organic | paid      how the campaign operates      عضوية / مدفوعة
campaign_type   project_launch, promotional_offer, awareness,      what it is FOR
                lead_generation, retargeting, construction_update,
                investor, seasonal, custom
channel_mix     DERIVED from campaign_class by trigger. Legacy. Never asked.
```

`channel_mix = 'both'` cannot be created: organic and paid are **sibling campaigns under one
initiative**, not one campaign with a mixed channel. Pre-existing `'both'` rows are preserved and
flagged, never auto-split.

**Backfill used explicit evidence only.** `campaign_type='paid'` IS a statement about the class, so
it became `campaign_class='paid'`. It is NOT a statement about purpose, so purpose became NULL
rather than a guess, and `needs_classification` widened to cover a missing class, a missing purpose
or a legacy `'both'`.

### 14.2 "Campaign content" meant four different things

Four relationships, counted separately by `mkt_campaign_content_counts()` and **deduplicated by
content id** — an item reachable three ways is one item:

| | reached by |
|---|---|
| produced | `origin_campaign_id` |
| reused | `mkt_content_usage.campaign_id` |
| legacy | `campaign_id` only, and not explained by either of the above |
| paid creative | `mkt_ads → mkt_ad_groups → mkt_platform_campaigns` |

Legacy is **historical by construction**: `mkt_ci_origin_sync` keeps `campaign_id` and
`origin_campaign_id` in lockstep on every write, so no new row can land in that bucket. The test has
to disable that trigger to build one.

### 14.3 One percentage was hiding three different answers

The old "Completion %" was `published ÷ content`, i.e. `0/0 → 0%` for a campaign with no content —
identical to one that planned twelve items and shipped none, and to one nobody has measured. Three
measures now, each able to decline to answer:

```
deliverables   7 of 12 completed          (from the campaign's own deliverables[])
publication    5 of 8 approved published  (approved = approved|ready_to_publish|scheduled|published,
                                           so publishing never shrinks the denominator)
outcome        42 of 100 qualified leads  (target vs actual_results)

no_target      nobody has said what done means
awaiting_data  a target exists, nothing measured yet
measured       a real reading — which may legitimately be 0
```

### 14.4 Status was a free-text column

It was in the API save allow-list, so a generic save could move a campaign from `archived` to
`active`. It now moves **only** through `campaign_transition`, against
`mkt_campaign_status_allowed()`:

```
draft → planned|cancelled     planned → active|draft|cancelled
active → paused|completed|cancelled     paused → active|completed|cancelled
completed → archived    cancelled → archived    archived → (terminal)
```

`mkt_campaign_next_statuses()` returns each legal move **with its blockers**, so the UI can show a
blocked action greyed out with the reason rather than hiding it. Advancing to `planned`/`active`
runs `mkt_campaign_activation_blockers()`; a **paid** campaign additionally needs at least one
`mkt_platform_campaigns` row, because otherwise it has nowhere to spend. Every transition appends to
`mkt_campaign_status_history` (append-only, `clock_timestamp()` so same-transaction rows still
order).

| File | Role |
|---|---|
| `supabase/migrations/2026-08-27_01_mkt_campaign_lifecycle.sql` | the whole of Part 14 |
| `supabase/tests/mkt_campaign_lifecycle_test.sql` | 19 assertions, verified against production inside a rolled-back transaction |
| `src/pages/MarketingManagement/components/portfolio/progress.tsx` | the three measures |
| `src/pages/MarketingManagement/components/portfolio/StatusBar.tsx` | legal transitions + blocker reasons |

### 14.5 The rest of the workspace

**Schedule.** A campaign's flight dates say when it is *allowed* to run; they say nothing about when
its content goes out. Separate blocks: the flight window, then production deadlines and publications
side by side. A task with no due date says so rather than being omitted — omitting it reads as
nothing outstanding.

**Reviews and decisions.** continue / change / scale / pause / stop with rationale, plus lessons.
`portfolio_detail` already read these; the execution view — where you would act on them — could not.
An unreviewed campaign says *no decision means unreviewed, not approved*.

**Content actions.** Producing and reusing are different acts. Create prefills the campaign's plan,
goal, objective, audience and origin so new content starts attached. Reuse offers only
approved-or-later items and filters out ones already linked. `content_usage_remove` deletes the
**usage row, never the item** — and the control appears only on the reused group, because an origin
is not detachable; that is what makes it the origin.

**Deliverables** are authored in the campaign drawer (`Deliverables.tsx`). They are an activation
blocker, so without an editor the blocker was unsatisfiable and nothing could leave draft.

### 14.6 api/ is now typechecked

`tsconfig.api.json` and `npm run typecheck:api` existed but were wired into nothing, so 26 endpoints
compiled only under Vercel's esbuild transpile, which does not fail on type errors. `build` now runs
it. Fixing the 46 errors it found surfaced two real defects:

| | |
|---|---|
| `ServerActivityCategory` | missing `'file'` and `'whatsapp'`. Production holds 14,942 and 14 rows of those, and the column has no CHECK — the type was wrong about what the system writes, and the WhatsApp send-audit call site was a type error nothing ran. |
| `analyticsRun` | `gb.field.kind !== 'field'` narrows a mutable **property**, and that narrowing does not survive into the `.find()` closure — so `field_id` was read off the whole union, including the synthetic refs that have none. |

The check immediately earned itself: the very next commit to land (`c33225f7`) failed its Vercel
build on duplicate `Body` members, instead of shipping.

---

## Part 15 — Content operations: the deliverable layer

**Landed 2026-08-27.** Migrations `2026-08-27_01`…`_04`; tests
`supabase/tests/mkt_content_ops_test.sql` (21 assertions, verified against production inside a
rolled-back transaction).

### What was wrong

`mkt_content_items` was three things at once — the strategic idea, the platform output and the
publication. That is why it carried ONE `language`, ONE `caption`, ONE `cta_destination`, ONE
`planned_publish_at`, and platforms as a `mkt_content_platforms` multi-select. "The same reel for
Instagram and TikTok" was a single row, so the two could not have different aspect ratios, captions,
owners or due dates, and could not be scheduled apart. `mkt_video_scenes` hung off
`content_item_id`, so they could not even differ in their scenes.

Two other things were decorative rather than real:

* **The fixed twelve tasks.** Verified in production: both existing content items carried
  `write_brief → … → record_performance` in the same order whether or not any of it applied.
* **The writing surface** — one dropdown over one universal textarea, including for design files.

### The shape now

```
brief → deliverables → artifacts (versioned) → publications → results
```

`mkt_content_items` becomes the BRIEF and gains its strategic fields (`strategy_version_id`,
`scope_kind`, `audience_insight`, `core_promise`, `evidence`, `desired_action`, `mandatory_info`,
`prohibited_claims`, `always_on_reason`, reuse lineage, the four stage clocks). Every legacy column
stays; nothing was dropped.

`mkt_content_deliverables` is one row per platform × account × format × language, carrying the
fields that differ per output. `platform` is **nullable on purpose**: legacy content has none
(`mkt_content_platforms` is empty), and a backfill that wrote 'instagram' would be inventing a fact.
Such rows are flagged `needs_classification` and refused by the scheduling gate.

`mkt_content_versions` **became** the artifact-version table rather than gaining a twin — it already
had `version_number` / `version_type` / `payload` / `approval_state` / `is_locked` / `superseded_by`.
Its closed 9-value CHECK was replaced by an FK to `mkt_artifact_types`, so artifact types are DATA:
adding "subtitle file" is an INSERT. Each type carries `editor_kind`, which is what stops a design
file being rendered behind a textarea.

`mkt_workflow_templates` + `mkt_workflow_steps` replace the fixed twelve. A video gets 10 steps, a
carousel 8, a static post 6, a text post 5, and a raw asset 4 **with no publishing step at all**.

### Rules the database enforces

1. **An approved artifact is immutable.** Editing one raises; a change is a new version. The API has
   no update path for artifacts at all, and `approval_state` is absent from its allow-list so a
   caller cannot approve their own draft in a patch.
2. **Approving an upstream artifact marks its dependants stale** rather than letting an approved
   caption sit against a script that has since been rewritten.
3. **Scheduling is gated** on approved media, approved copy, a platform, an account and a time —
   read from the template's `gates_publish` steps, so a text post is never asked for final media.
   `mkt_deliverable_schedule_blockers()` returns the same list the UI shows.
4. **A brief cannot leave `idea`** without scope, owner, an approved strategy version, a plan, a goal
   or a stated always-on reason, an audience, a message, a desired action, and at least one
   deliverable — `mkt_content_missing_requirements()`, same function, both places.
5. **`next_action` and blockers are computed** (`mkt_content_state()`), not typed into a column.
6. **Approving final media registers it in the library** automatically, with a link back to the
   deliverable.

### Backfill

Non-destructive and self-validating: snapshots four tables, gives each brief one deliverable,
re-parents its tasks and scenes, marks the legacy tasks `template_key='legacy_fixed_12'`, and chains
the 22 rows that sat at `status='blocked'` to a real predecessor — they already carried the reason
"waiting for the previous task", but named no task, so the claim was unfalsifiable and finishing a
step could not unblock the next. It
asserts afterwards that no item lacks a deliverable, no brief got two, no task or scene was orphaned
and the task count did not fall. C-00008 and C-00011 both survive with their 12 tasks and their
scenes.

### What the test suite caught

Three defects that would each have failed for a user rather than a test: `ON CONFLICT` could not
infer the PARTIAL unique index on `(deliverable_id, step_key)` so task generation raised 42P10 every
time; the auto-library trigger wrote `asset_type='video'` and `usage_status='used'`, neither of which
exists in `mkt_raw_assets`' CHECK lists; and `mkt_asset_links.target_type` had no `'deliverable'`
value, making the core library flow impossible.

### Real limitations

* **No platform publishing API is wired.** Publishing is a manual flow that records the URL
  afterwards; `publish_method` is `manual`. Nothing here pretends an integration succeeded.
* **No metrics ingestion.** Results are entered by hand and compared with the deliverable's own KPI
  target. An unmeasured deliverable renders as unmeasured, never 0%.
* `كاتب المحتوى` (`/marketing/posts`) remains a separate bulk caption generator persisting to a
  `posts_batches` model in `records`. It is a generator, not a lifecycle; folding its output into a
  brief is not done.
* The two legacy briefs need a human to say which platform they were for.
