# Paid Ad Platform Field Reference — Meta / Snapchat / TikTok

Researched 2026-08-09 from the official Marketing API docs of each platform, for replicating real
campaign-creation forms inside the Marketing OS (`/m`). One file per platform:

- [meta.md](meta.md) — Facebook + Instagram (one API; Instagram is a placement choice, not a separate campaign type)
- [snapchat.md](snapchat.md) — Snapchat Ads
- [tiktok.md](tiktok.md) — TikTok Ads (v1.3)

## The shared shape — all three platforms are the same 3-level tree

| Level | Meta | Snapchat | TikTok | What lives here |
|---|---|---|---|---|
| 1. Campaign | Campaign | Campaign | Campaign | **Objective**, status, dates, campaign-level budget (CBO), special categories |
| 2. Ad set | Ad Set | Ad Squad | Ad Group | **Budget + schedule, bidding, optimization goal, placements, full targeting** |
| 3. Ad | Ad + Creative | Ad + Creative | Ad (creatives inline) | Identity/account, media, copy, CTA, destination URL / lead form, tracking |

Level 2 is where ~80% of the settings live on every platform. Level 1 is thin everywhere.

## Cross-platform field equivalence (the "one form, three dialects" table)

| Concept | Meta | Snapchat | TikTok |
|---|---|---|---|
| Objective | `objective`: OUTCOME_AWARENESS / OUTCOME_TRAFFIC / OUTCOME_ENGAGEMENT / OUTCOME_LEADS / OUTCOME_APP_PROMOTION / OUTCOME_SALES | `objective_v2_type`: AWARENESS_AND_ENGAGEMENT / TRAFFIC / LEADS / APP_PROMOTION / SALES | `objective_type`: REACH / TRAFFIC / VIDEO_VIEWS / LEAD_GENERATION / ENGAGEMENT / APP_PROMOTION / WEB_CONVERSIONS / PRODUCT_SALES |
| Budget modes | daily_budget / lifetime_budget (minor currency units) + CBO at campaign | daily_budget_micro / lifetime_budget_micro (micros) + pacing_level=CAMPAIGN | BUDGET_MODE_DAY / BUDGET_MODE_TOTAL / DYNAMIC_DAILY (+ budget float) + budget_optimize_on |
| Bid strategy | LOWEST_COST_WITHOUT_CAP / COST_CAP / LOWEST_COST_WITH_BID_CAP / LOWEST_COST_WITH_MIN_ROAS | AUTO_BID / LOWEST_COST_WITH_MAX_BID / TARGET_COST | BID_TYPE_NO_BID / BID_TYPE_CUSTOM (+ deep_bid_type for value) |
| Optimization goal | `optimization_goal` (30+ values) | `optimization_goal` (18 values) | `optimization_goal` (~19 values) + deterministic billing_event table |
| Billing event | mostly IMPRESSIONS | always IMPRESSION | CPC / CPM / CPV / OCPM (derived from goal) |
| Age | age_min 13–65 / age_max | age_groups or min_age/max_age (13–55) | age_groups buckets (AGE_13_17 … AGE_55_100) |
| Gender | genders [1]/[2] | MALE / FEMALE / OTHER | GENDER_MALE / GENDER_FEMALE / GENDER_UNLIMITED |
| Geo | geo_locations: countries/regions/cities/zips/custom radius pins | geos: country/region/metro/postal + circles (radius) | location_ids (+ zipcode_ids, US/CA) |
| Interests | interests/behaviors ids + flexible_spec AND/OR | SLC_* lifestyle categories | interest_category_ids + interest_keyword_ids + actions (behavior) |
| Custom audiences | custom_audiences / excluded (lookalike = custom audience id) | segments INCLUDE/EXCLUDE (SAM + lookalikes) | audience_ids / excluded_audience_ids |
| AI audience expansion | targeting_automation.advantage_audience | auto_expansion_options / SMART_TARGETING | smart_audience_enabled + smart_interest_behavior_enabled |
| Placements | publisher_platforms + per-platform positions (omit = Advantage+) | placement_v2 config AUTOMATIC/CUSTOM + snapchat_positions | placement_type AUTOMATIC/NORMAL + placements (TikTok/Pangle/Global App Bundle) |
| Schedule | start_time/end_time + adset_schedule dayparting | start_time/end_time + ad_scheduling_config | schedule_type + start/end + dayparting 336-char bitmap |
| Frequency cap | frequency_control_specs (REACH/THRUPLAY) | cap_and_exclusion_config | frequency + frequency_schedule (REACH) |
| Pixel / conversion | promoted_object {pixel_id, custom_event_type} | pixel_id + PIXEL_* goals | pixel_id + optimization_event |
| Lead form | creative CTA value.lead_gen_form_id (destination ON_AD) | LEAD_GENERATION creative + lead_generation_form_id | page_id (Instant Form) on the ad |
| Ad identity | page_id (+ instagram_user_id) | profile_properties.profile_id | identity_type + identity_id (Spark = AUTH_CODE/TT_USER) |
| Primary text | link_data.message | — (headline only) | ad_text (≤100 chars) |
| Headline | link_data.name | headline (≤34 chars) | — (display_name for app/landing) |
| CTA | call_to_action.type (100+ enum) | call_to_action (per-type subsets) | call_to_action (~30 enum) |
| Housing/real-estate flag | special_ad_categories: HOUSING (mandatory field, [] allowed) | regulations (CHE) object | special_industries: [HOUSING] |
| Full-automation product | Advantage+ (3 toggles on a normal campaign since v25) | Smart Budgets (pacing_level=CAMPAIGN) | Smart+ (separate /smart_plus/ endpoints) |

## Mapping to our schema (`mos_campaign_executions`)

Current state (2026-08-09): executions carry `platform`, `budget`, `starts_on/ends_on`, a free-form
`targeting` jsonb (empty in prod), `lead_form_fields` jsonb, `platform_campaign_id`.

Suggested modeling, if/when we build the platform-settings form:

1. **Keep `mos_campaigns` platform-agnostic** (goal, money, dates, success measures) — it matches all
   three platforms' Level-1 "campaign" closely enough.
2. **`mos_campaign_executions` = the platform's Level 2 (ad set / ad squad / ad group).** Add a
   `platform_settings` jsonb column (or reuse `targeting`) whose SHAPE is per-platform, validated by a
   per-platform TypeScript schema: `{ objective, optimization_goal, billing_event, bid: {strategy, amount},
   budget_mode, placements, targeting: {geo, age, gender, languages, interests, audiences, expansion},
   pixel, destination }` — using each platform's REAL enum values (see the per-platform files) so a
   record can later be pushed through the actual API unchanged.
3. **`mos_execution_ads` = Level 3.** Fields worth adding: creative format, primary text / headline,
   CTA enum value, destination URL, lead-form id, spark/boost post id, media asset link.
4. Enum lists that are stable (objectives, optimization goals, bid strategies, placements, CTA subsets,
   age buckets) can be hardcoded per platform. Lists that must stay dynamic on every platform
   (geo ids, interest ids, audience ids, pixels, pages/identities) need either a platform API
   connection (`mos_platform_accounts` already models connection state) or free-text entry in v1.

## Gotchas that will bite a naive form

- **Meta:** the objective → destination_type → optimization_goal matrix (meta.md §2.3) is the #1
  source of API errors — enforce it, don't free-combine enums. Budgets are integer minor units
  (SAR → halalas). `special_ad_categories` is mandatory (empty array allowed).
- **Snapchat:** everything money is micros; `billing_event` is always IMPRESSION; MIN_ROAS and the
  Oracle DLX* audiences are deprecated — don't model them. Ad squad type ≠ STORY (Story is an ad type).
- **TikTok:** goal → billing_event is a deterministic table (tiktok.md §2.7); many enum values are
  allowlist-gated per ad account; IDs are strings; several fields are immutable after creation
  (placement, attribution windows, identity) — the form should mark those "can't change later".
