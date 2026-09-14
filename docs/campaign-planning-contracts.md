# Campaign planning — build contract (v1, 2026-09-13)

Authoritative for this build. Every workstream codes against THIS file. Change
the contract before deviating from it.

Plan of record: `docs/plans/campaign-scheduling-plan.md` (v2.1).
Engine (already built, 30 tests green): `src/lib/marketingOS/scheduling/`.

---

## 0. Non-negotiables (repo rules that bite here)

1. **Never raise SQLSTATE `40001` / `40P01`** from any function. Optimistic
   conflicts use **`WS409`**, rate limits **`WS429`**. Consumers classify by
   MESSAGE first.
2. **Never swallow an error.** No `catch {}`. Surface + log.
3. **No `any`.** Explicit types everywhere.
4. **Bilingual**: every user-visible string has `_ar` and `_en`, or goes through
   `t()`. Arabic-Indic numerals via the existing `num()` helper in
   `src/pages/Marketing/lib/format.ts`.
5. **Marketing capabilities are DATA.** A new capability = seed row in
   `role_capabilities` + `CAPABILITIES` in `api/marketing-os.ts` + the
   `Capability` union in `MarketingWorkspace.tsx`. Three places, always.
6. **Migrations are applied by the session that writes them** (Supabase MCP,
   project `zhqqsxwealdwqzrbpwyv`), then verified.
7. Re-emitting an existing SQL function means copying the LIVE body verbatim
   (`pg_get_functiondef`) and adding only the one change.

---

## 1. Engine API (already implemented — do not re-implement)

```ts
import { planCampaign, DEFAULT_RULES } from '@/lib/marketingOS/scheduling';
// api/**: import from '../src/lib/marketingOS/scheduling/index.js'

planCampaign(input: PlanInput, snapshot: WorkloadSnapshot, rules: RuleSet,
             opts?: { withAlternatives?: boolean }): PlanResult
```

Key types live in `src/lib/marketingOS/scheduling/types.ts`. Read them; do not
re-declare them. Highlights:

- `WorkloadSnapshot = { today, calendar, people, ledger, hash }`
- `PlanResult.feasible`, `.infeasibleProof: 'time_bound'|'capacity_bound'|null`,
  `.searchIncomplete`, `.items[]`, `.batches[]`, `.reservations[]`, `.cycles[]`,
  `.load[]`, `.conflicts[]`, `.totals`, `.alternatives`, `.snapshotHash`
- **`infeasibleProof === null && feasible === false` means "no schedule found",
  NEVER "impossible".** The UI must word it that way.

---

## 2. Database objects

### 2.1 New tables

| Table | Purpose | Key columns |
|---|---|---|
| `mos_campaign_plans` | the preview object | `id, campaign_id, status ∈ proposed\|approved\|superseded\|discarded, input jsonb, plan jsonb, feasibility jsonb, snapshot_hash text, engine_version text, created_by_user_id, created_at, approved_at, approved_by_user_id, superseded_by uuid` |
| `mos_publish_batches` | one publishing wave | `id, plan_id, campaign_id, execution_id, platform, day date, sequence int, status ∈ planned\|on_track\|at_risk\|late\|done, created_at` |
| `mos_content_plan` | 1:1 with content, the PRODUCTION plan | `content_id PK, plan_id, campaign_id, need_at timestamptz, required_ready_at date, production_start date, priority int, stage_deadlines jsonb, stage_assignees jsonb, status ∈ planned\|in_production\|ready\|published\|at_risk\|late, content_key text, created_at, updated_at` |
| `mos_task_reservations` | the PLANNING ledger | `id, plan_id, cycle_id, content_id, content_key text, step_key, role_key, assignee_user_id, bucket, planned_start date, planned_end date, weight numeric, status ∈ reserved\|stale\|consumed\|released, consumed_task_id, created_at, updated_at` |
| `mos_refresh_cycles` | paid weekly refresh | `id, execution_id, round int, refresh_on date, ready_by date, production_start_on date, decision_due_on date, status ∈ scheduled\|producing\|ready\|deciding\|decided\|applying\|applied\|partial\|skipped\|cancelled, decision jsonb, created_at, updated_at` |
| `mos_creative_slots` | a creative's place in a slate | `id, execution_id, cycle_id, slot_index int, kind ∈ initial\|replacement\|fifth\|spare, status ∈ reserved\|producing\|ready\|active\|retired\|released, content_id, ad_row_id, activate_on date, activated_at, retired_at, bank_reserved_for_cycle_id uuid, created_at, updated_at` |
| `mos_ad_metrics_daily` | per-creative windowed performance | `ad_row_id, day date, spend, impressions, clicks, leads, reach, frequency, synced_at` — PK `(ad_row_id, day)` |
| `mos_content_approvals` | what exactly was approved | `id, content_id, step_key, round int, approved_by_user_id, approved_at, writing_hash, design_hash, caption_hash, package_hash` |
| `mos_content_events` | field-level audit | `id, content_id, kind, actor_user_id, at, detail jsonb` |
| `mos_user_capacity` | per-person override | `user_id, bucket, daily_slots int, updated_at` — PK `(user_id, bucket)` |
| `mos_holidays` | non-working dates | `day date PK, label_ar, label_en, created_at` |
| `mos_step_effort` | EXPLICIT effort estimates | `workflow_key, step_key, bucket, working_days numeric` — PK `(workflow_key, step_key, bucket)` |

**Exclusivity of a banked spare (v2.1 correction 2):**
```sql
CREATE UNIQUE INDEX uq_mos_creative_slots_bank_cycle
  ON public.mos_creative_slots (bank_reserved_for_cycle_id)
  WHERE bank_reserved_for_cycle_id IS NOT NULL;
```
plus a `CHECK` that a slot with `bank_reserved_for_cycle_id` is `status='ready'`
and `kind IN ('fifth','spare')`. A cycle may consume ONLY a slot earmarked to it.

### 2.2 Altered tables

- `mos_campaign_executions`: `+ refresh_policy jsonb`, `+ publishing_rules jsonb`,
  `+ CHECK platform IN ('meta','google','instagram','tiktok','snapchat','x','youtube','website')`,
  `+ UNIQUE (campaign_id, platform, coalesce(label,'')) WHERE archived_at IS NULL`.
- `mos_campaigns`: `+ requirements jsonb`, `+ plan_id uuid`.
- `mos_publications`: `+ execution_id uuid REFERENCES mos_campaign_executions ON DELETE SET NULL`,
  `+ batch_id uuid`, `+ planned_at timestamptz`, `+ grid_row int`, `+ grid_col int`,
  `+ scheduled_timezone text NOT NULL DEFAULT 'Asia/Riyadh'`,
  status CHECK extended with `'planned'`.
- `workflow_role_tasks`: `+ scheduled_start date`, `+ scheduled_end date`,
  `+ effort_days numeric`, `+ progress_days numeric NOT NULL DEFAULT 0`,
  `+ reservation_id uuid`.
- `mos_manual_tasks`: `kind` CHECK extended to
  `('manual','caption_review','refresh_decision','plan_conflict','ad_failed')`,
  `+ entity_kind text`, `+ entity_id uuid`, `+ action text`.
- `mos_execution_ads`: `+ slot_id uuid`, `+ activated_at`, `+ retired_at`,
  `+ replaced_by_ad_row_id uuid`.
- `mos_asset_links`: `+ version int NOT NULL DEFAULT 1`, `+ superseded_at timestamptz`,
  `+ uploaded_by_user_id uuid`; unique `(content_id, role) WHERE superseded_at IS NULL`.
- `mos_content_types.field_schema` entries gain `affects_design boolean` — the
  field list becomes objects `{key, affects_design}` OR stays a string array and
  a sibling column `design_fields text[]` carries the flags. **Chosen: sibling
  column `mos_content_types.design_fields text[] NOT NULL DEFAULT '{}'`** (no
  migration of the existing array shape, no reader changes).

### 2.3 Views

- **`mos_work_ledger_v (user_id, day, bucket, weight, source, ref_id)`** — the ONE
  definition. Exactly the three sources in §4.3 of the plan:
  1. `workflow_role_tasks` `status='open'`: window `scheduled_start..scheduled_end`;
     when `today > scheduled_end`, project **remaining** effort from today forward.
     **Remaining = `effort_days - progress_days`, floored at 0.5. Elapsed time is
     never progress.**
  2. `mos_task_reservations` `status IN ('reserved','stale')`: `planned_start..planned_end`;
     a `stale` one projects from today at full remaining weight.
  3. `mos_manual_tasks` `status='open'`: its due day (or today when overdue),
     weight from `mos_settings.planning.manual_task_weight` (default 0.5).
  Never emits a past day. Bucket for approval steps = `'approvals'`.
- `mos_publish_batch_v` — batch + risk rollup.
- `mos_creative_perf_v` — per content/creative windowed metrics from `mos_ad_metrics_daily`.
- `mos_content_v` — `status_key` gains `planned` / `on_hold` / `rejected`; expose
  `plan_status`, `required_ready_at`, `need_at`, `caption`, `caption_confirmed`.

### 2.4 Functions / RPCs

| Name | Signature | Notes |
|---|---|---|
| `mos_workload_snapshot_hash()` | `→ text` | md5 over ordered ledger rows + caps + leaves + holidays + step effort. |
| `mos_campaign_plan_commit(p_plan_id uuid, p_reservations jsonb, p_expected_hash text, p_materialise jsonb)` | `→ jsonb` | **Takes `pg_advisory_xact_lock(hashtext('mos_work_ledger'))` FIRST.** Then hash check → `WS409 plan_changed`; then an INDEPENDENT SQL capacity re-check per touched `(user, day, bucket)` → `WS409 capacity_conflict`; then materialise. Idempotent on an already-approved plan. |
| `mos_plan_consume_reservation(p_task_id uuid)` | `→ uuid` | Swap: reservation `consumed`, task gets assignee + `scheduled_start/end` + `due_at`. Called by the engine RPCs. |
| `mos_plan_repair(p_campaign_id uuid DEFAULT NULL)` | `→ jsonb` | Marks overdue reservations `stale`, re-dates them, flags batches. Sweep-callable. |
| `mos_plan_release(p_content_id uuid)` | `→ int` | Release reservations for content that no longer needs doing. |
| `content_ad_readiness(p_content_id uuid, p_execution_id uuid DEFAULT NULL)` | `→ jsonb` | `{ok, blockers:[{code, label_ar, label_en}]}`. Codes in §4. |
| `mos_campaign_rollup(p_campaign_id uuid, p_execution_id uuid DEFAULT NULL)` | `→ jsonb` | Parent totals = union of placements + provenance, DISTINCT by content id. |
| `content_revise(p_content_id uuid, p_scope text[], p_note text)` | `→ jsonb` | Derives the widest scope from changed keys; opens the correct re-approval chain. |
| `mos_refresh_cycle_decide(p_cycle_id uuid, p_keep_ad_ids uuid[], p_replace_ad_ids uuid[])` | `→ jsonb` | Writes the decision; does NOT touch Meta. |
| `mos_refresh_cycle_apply(p_cycle_id uuid)` | `→ jsonb` | Idempotent. Activates ready replacements, verifies, THEN retires outgoing. Never drops below `min_active`. |
| `workflow_advance_role_path(...)` | +`p_return_to text DEFAULT NULL` | Re-emit verbatim + (a) server-enforced `required_fields`, (b) targeted return, (c) `mos_plan_consume_reservation`, (d) ledger lock, (e) write `mos_content_approvals` on approve. |
| `workflow_role_path_start(...)` | unchanged signature | + reservation consumption + ledger lock. |

**Every ledger writer takes `pg_advisory_xact_lock(hashtext('mos_work_ledger'))`:**
`workflow_role_path_start`, `workflow_advance_role_path`, `workflow_role_task_transfer`,
`mos_plan_consume_reservation`, `mos_perf_task_block`, `mos_leave_decide`,
`mos_manual_task_write`, `capacity_config_save`, `mos_plan_repair`,
`mos_campaign_plan_commit`, `mos_refresh_cycle_apply`.

---

## 3. API actions (`api/marketing-os.ts`)

| Action | Capability | Payload → Response |
|---|---|---|
| `campaign_plan_preview` | `plan_campaign` | `{campaign_id?, input}` → `{plan_id, plan: PlanResult, people, projects}` |
| `campaign_plan_revise` | `plan_campaign` | `{plan_id, overrides}` → same |
| `campaign_plan_commit` | `approve_plan` | `{plan_id}` → `{ok, created:{items,reservations,batches,publications,slots,cycles}}` or 409 `{error:'plan_changed'\|'capacity_conflict', plan, diff}` |
| `campaign_plan_get` | `read` | `{campaign_id}` → the current plan + accuracy |
| `campaign_rollup` | `read` | `{campaign_id, execution_id?}` → totals |
| `content_caption_generate` | `write_content` | `{content_id}` → `{caption, source}` |
| `content_revise` | `revise_approved_content` | `{content_id, scope?, note}` → `{scope, next_step}` |
| `content_ad_readiness` | `read` | `{content_id, execution_id?}` → blockers |
| `refresh_cycle_list` | `read` | `{execution_id}` → cycles + slots + ranking |
| `refresh_cycle_decide` | `decide_refresh` | `{cycle_id, keep_ad_ids, replace_ad_ids}` |
| `capacity_config_save` | `manage_capacity` | `{user_caps?, holidays?, step_effort?, weekend_days?}` |
| `workload_calendar` | `read` | `{from, to}` → ledger cells + capacities |

Existing `task_complete` gains `return_to?: string` and returns `blockers` when a
preflight refuses.

**New capabilities (seed + `CAPABILITIES` + `Capability` union):**
`plan_campaign`, `approve_plan`, `decide_refresh`, `revise_approved_content`,
`manage_capacity`. Seeded to `mos_marketing_manager` + `mos_ceo`;
`plan_campaign` also to `mos_ops_supervisor`.

---

## 4. Ad readiness blocker codes

`final_square`, `final_vertical`, `slots_same_kind`, `caption_approved`,
`project_linked`, `campaign_linked`, `meta_execution_linked`, `ad_set_linked`,
`ad_set_pair_complete`, `saved_audience`, `welcome_template`, `budget_set`,
`destination_valid`, `creative_slot_available`.

---

## 4b. Release contract — the publication task (added 2026-09-14)

Two task types, not one:

| Task | Subject | Covers | Ends |
|---|---|---|---|
| Content | `mos_content` | making the creative | the manager’s final approval |
| Publication | one `mos_publications` row | putting it on ONE destination on ONE date | that destination going live |

The engine models a paid release too (`PlannedRelease.kind = 'ad'`), but an ad is **never** a publication TASK: the worker builds it after the caption is approved and polls the platform until it confirms the ad is live, so there is no human publish step to invent. `mos_release_v` is therefore organic-only, and `release_list` on a paid campaign correctly returns nothing. A failing ad already has its own task kind (`ad_failed`).

A publication task shows **three sections and nothing else**: the final ready content, where it is going, and what that platform demands. The brief, the references, the revision history and the approval controls belong to the content task.

**Actions** (`api/_lib/marketing/planning/releaseActions.ts`):

```
release_get             { release_id }                     -> { release: { content, destination, requirements } }
release_list            { content_id? campaign_id? mine? } -> { releases: [...] }
release_mark_published  { release_id, external_url? }      -> records a HAND-published release
release_open_task       { release_id, reason?, detail? }   -> queue it now
```

**Database** (`2026-09-14_05_release_tasks.sql`): `mos_release_v` answers all three sections in one read; `mos_platform_automatable(platform)` says whether a destination can publish by itself; `mos_release_due()` lists what has come due; `mos_release_sweep()` raises a task ONLY where a person is needed; `mos_release_open_task/close_task` manage it. A publication reaching `published` closes its own task through a trigger.

**Requirements** reuse `preflightPublishSet` from `src/lib/marketingOS/platformRules.ts` — the SAME rulebook the publish gate uses, so a task can never claim a post is fine that the publish path would refuse.

**Capacity:** releases are charged to the `publishing` bucket, never to `post`/`video`. An automatic release costs nobody a slot-day.

**Route:** a publication task opens `/m/releases/:id` — both `taskHref` and its server twin in `api/_lib/marketing/routes.ts` resolve `entity_kind = 'publication'` there.

## 5. Routing contract (frontend)

`src/pages/Marketing/lib/contentRoute.ts`:

```ts
export type ContentSection =
  | 'writing' | 'writing_review' | 'design_upload' | 'design_review_writer'
  | 'final_review' | 'caption' | 'schedule' | 'publish_check' | 'materials_final'   // 'schedule'/'publish_check' remain for content pinned to a PRE-2026-09-14 workflow version
  | 'overview';

export function sectionForStep(steps: StepDef[], stepKey: string): ContentSection;
export function tabForSection(s: ContentSection): 'overview'|'content'|'materials'|'placements'|'tasks';
export function contentHref(row: {...}, steps?: StepDef[]): string;   // /m/content/:id?tab=..&step=..
export function taskHref(task: {...}): string;
export function actionOfTask(task: {...}): TaskAction;
```

URL shape: `/m/content/:id?tab=<tab>&step=<step_key>`. **`step` is always a step
KEY, never a UUID** (the v2 bug). A finished item → `?tab=materials&step=materials_final`.

Server twin: `api/_lib/marketing/routes.ts` `contentUrl(contentId, opts)` — every
notification producer uses it.

---

## 6. Settings defaults (all editable; documented in the final report)

```jsonc
mos_settings.planning = {
  "publish_buffer_days": 1,
  "manual_task_weight": 0.5,
  "approvals_cap_per_day": 20,
  "weekend_days": [5],
  "search_budget": 400000,
  "preview_enabled": true,
  "reservations_enforced": true,
  "refresh_loop_enabled": true,
  "auto_apply_default_decision": false,   // hold + page for the first month
  "min_active_creatives": 5,
  "ads_created_paused": true              // activate on schedule, not on create
}
mos_settings.refresh_policy = {
  "slate_size": 5, "keep_min": 1, "cycle_days": 7,
  "min_remaining_days": 3, "lead_time_working_days": 7, "fifth_policy": "A"
}
mos_settings.ranking = {
  "min_spend_sar": 150, "min_impressions": 2000,
  "fatigue_frequency": 3.0, "fatigue_ctr_drop_pct": 40
}
```

**CPL = spend ÷ leads.** Zero leads → CPL undefined; the creative ranks below
every creative with leads, ordered by CTR desc then CPM asc. Below the data
threshold a creative is *unranked* — never the default winner, never a
guaranteed loser.

---

## 7. ADDENDUM (2026-09-13) — exact RPC call shapes the API uses

The API layer is written and calls these EXACTLY. SQL must match.

```
mos_campaign_plan_commit(
  p_plan_id      uuid,
  p_reservations jsonb,   -- [{item_key, step_key, role_key, bucket, assignee_user_id, planned_start, planned_end, weight}]
  p_expected_hash text,
  p_materialise  jsonb,   -- see below
  p_actor        uuid
) RETURNS jsonb           -- {items, reservations, batches, publications, slots, cycles} counts

mos_campaign_rollup(p_campaign_id uuid, p_execution_id uuid DEFAULT NULL) RETURNS jsonb
content_ad_readiness(p_content_id uuid, p_execution_id uuid DEFAULT NULL) RETURNS jsonb
mos_workload_snapshot_hash() RETURNS text
content_revise(p_content_id uuid, p_scope text[], p_note text) RETURNS jsonb
mos_refresh_cycle_decide(p_cycle_id uuid, p_keep_ad_ids uuid[], p_replace_ad_ids uuid[]) RETURNS jsonb
mos_refresh_cycle_apply(p_cycle_id uuid) RETURNS jsonb
mos_plan_consume_reservation(p_task_id uuid) RETURNS uuid
mos_plan_repair(p_campaign_id uuid DEFAULT NULL) RETURNS jsonb
mos_plan_release(p_content_id uuid) RETURNS integer
```

`p_materialise` shape (snake_case, produced by `materialisePayload` in
`api/_lib/marketing/planning/actions.ts`):

```jsonc
{
  "campaign_id": "uuid|null", "kind": "organic|paid",
  "range_start": "YYYY-MM-DD", "range_end": "YYYY-MM-DD", "cross_post": false,
  "executions": [{ "key": "exec:instagram", "platform": "instagram",
                   "execution_id": null,
                   "publishing_rules": {...} | null,
                   "refresh_policy": {...} | null }],
  "items": [{ "key": "proj:post:1", "title": "...", "content_type_key": "post",
              "project_id": "uuid", "workflow_key": "post_std",
              "need_at": "ISO", "required_ready_at": "YYYY-MM-DD",
              "production_start": "YYYY-MM-DD", "priority": 1000,
              "stage_deadlines": {"writing":"YYYY-MM-DD", ...},
              "stage_assignees": {"writing":"uuid|null", ...},
              "placements": [{ "platform":"instagram","execution_key":"exec:instagram",
                               "planned_at":"ISO","day":"YYYY-MM-DD","batch_key":"exec:instagram|YYYY-MM-DD",
                               "slot_index":0,"grid_row":0,"grid_col":0 }],
              "slot": { "execution_key":"...","cycle_round":1,"slot_index":0,"kind":"replacement" } | null }],
  "batches": [{ "key":"exec:instagram|YYYY-MM-DD","execution_key":"...","platform":"instagram",
                "day":"YYYY-MM-DD","sequence":1,"item_keys":["..."] }],
  "cycles": [{ "execution_key":"...","round":1,"refresh_on":"YYYY-MM-DD","ready_by":"YYYY-MM-DD",
               "production_start_on":"YYYY-MM-DD","decision_due_on":"YYYY-MM-DD",
               "produced":5,"banked_spare_slot_id":null }]
}
```

Materialisation rules the RPC must implement:
1. Create/find one `mos_campaign_executions` row per `executions[]` entry
   (organic children included), stamping `starts_on`/`ends_on` from the range
   and `publishing_rules` / `refresh_policy`.
2. Create one `mos_content` row per item (`campaign_id`, `project_ids=[project_id]`,
   `content_type_id` from `content_type_key`, `organic_platforms` from its
   placements' platforms, `target_publish_at` = `need_at`, pinned
   `workflow_version_id`) — but **do NOT open the first task**; the sweep opens
   it at `production_start`. Paid slot items are created lazily by the sweep at
   `production_start_on`; for round 0 (launch) create them now.
3. `mos_content_plan` per item; `mos_publish_batches` per batch;
   `mos_publications` per organic placement with `status='planned'`,
   `planned_at`, `execution_id`, `batch_id`, grid position;
   `mos_creative_slots` + `mos_refresh_cycles` for paid.
4. `mos_task_reservations` from `p_reservations`, resolving `item_key` →
   `content_id` where the content row now exists (else leave `content_key` only).
5. Set `mos_campaigns.plan_id`, `requirements`, `starts_on`/`ends_on`, and the
   plan row to `status='approved'`, `approved_at=now()`, `approved_by_user_id=p_actor`.
