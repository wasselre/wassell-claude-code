# Project Marketing Intelligence — Complete Schema

**Last updated:** 2026-07-26
**Status:** design + gap analysis + migration plan. Supersedes the schema sections
of [marketing-intelligence-design.md](marketing-intelligence-design.md), which
remains the record of *why* the collection layer looks the way it does.

---

## 0. What this system is for

For any **project** (ours or a competitor's) and any **organization**
(developer, authorized marketer, observed marketer), answer:

| Question | Needs |
|---|---|
| **Who** is marketing it? | identity resolution across platforms |
| **Where** are they marketing? | channels: social, paid, landing pages, portals |
| **What** are they saying? | message, offer, price, payment plan, unit mix, CTA |
| **How much** are they doing? | volume, reach/spend proxies, share of voice |
| **How well** is it working? | engagement, growth, campaign longevity |
| **What changed?** | time-series on every one of the above |
| **So what?** | insights, summaries, recommendations |

The current schema is strong on the first two, adequate on the third's *raw
form*, and **structurally unable** to answer the fourth, fifth, sixth, or seventh
in SQL. The reason is a single design gap, stated in §3.

### The organizing principle

Every row in this vertical is one of exactly four things. Naming them makes the
gaps obvious:

1. **ACTOR** — who exists (org, social account, identity candidate).
2. **ARTIFACT** — what they published (post, media, ad, landing page, creative).
3. **FACT** — what an artifact *asserts* (a price, an offer, a district, a phone).
4. **JUDGEMENT** — what we concluded (attribution, enrichment, campaign, summary, insight).

The database models ACTOR, ARTIFACT and JUDGEMENT as first-class tables.
It does **not** model FACT at all — facts live as untyped JSON inside two
different JUDGEMENT tables, under two different key vocabularies. That is the
root cause of most gaps below.

---

## 1. Target schema — domain by domain

Legend: ✅ exists and is right · ⚠️ exists but flawed · ❌ missing

### A. Actors & identity

| Entity | Status | Notes |
|---|---|---|
| `mkt_organizations` | ⚠️ | Correct entity. `org_type` is wrong (see §2.6) — role is per-project, not per-org. Meta identity is bolted on as `meta_*` columns. |
| `mkt_project_organizations` | ✅ | **The right model**: role lives on the link (`developer` / `authorized_marketer` / `observed_marketer`), with confidence, evidence, human confirmation, and validity flags. |
| `mkt_social_accounts` | ⚠️ | Correct entity; `followers` is a scalar with no history (§2.2). |
| `mkt_identity_candidates`, `mkt_discovery_*`, `mkt_advertiser_audit` | ✅ | Discovery vertical, working. |

### B. Channels & presence

| Entity | Status | Notes |
|---|---|---|
| `mkt_social_accounts` | ✅ | Organic + profile channel. |
| `mkt_landing_pages` | ⚠️ | Only 8 columns — no title, no captured content, no offer extraction, no status history. Thin but not wrong. |
| Portal presence (Aqar/Bayut) | — | Deliberately **out of scope**: lives in `market_listings` (a separate vertical). Do not merge; cross-reference by org/project when needed. |

### C. Content (organic) — the strongest area

| Entity | Status |
|---|---|
| `mkt_content_posts` | ✅ |
| `mkt_content_media` | ✅ (content-addressed permanent storage, checksum + phash) |
| `mkt_transcripts` | ✅ |
| `mkt_visual_text` | ✅ as an artifact record; its `structured` payload is a FACT store in disguise (§3) |
| `mkt_content_enrichment` | ✅ as a judgement record; its `result` payload is likewise (§3) |
| `mkt_content_attributions` | ✅ |

### D. Paid

| Entity | Status | Notes |
|---|---|---|
| `mkt_paid_ads` | ⚠️ | Good artifact model (creative fingerprint, phash, lifecycle dates). **No usable reach or spend** — `reach_info` is empty on 10/10 rows and is untyped jsonb. |
| `mkt_ad_history` | ✅ | Change timeline. |
| `mkt_ad_attributions` | ✅ | |
| `mkt_ad_campaigns` | ❌ **delete/merge** | Duplicate campaign concept — see §2.4. |

### E. Campaigns

| Entity | Status |
|---|---|
| `mkt_campaigns` (cross-platform, `cg-v1`) | ✅ authoritative |
| `mkt_campaign_members` / `_events` / `_corrections` / `_summaries` | ✅ |

### F. Commercial facts — **entirely missing** ❌

The single most valuable missing entity. See §3.

### G. Performance & competitive position

| Entity | Status | Notes |
|---|---|---|
| `mkt_metric_snapshots` | ⚠️ | Polymorphic and well-shaped, but **only `subject_type='post'`** is ever written (2 702 rows / 777 posts). No account, campaign, ad, or org series. |
| `mkt_metric_daily` | ✅ | Operational KPIs (provider-level), not competitive metrics. |
| Share of voice / competitive aggregates | ❌ | No entity. Cannot answer "who dominates district X this month". |
| Project marketing rollup | ❌ | No per-project marketing state (activity, platforms, orgs, recency). |

### H. Intelligence outputs

| Entity | Status | Notes |
|---|---|---|
| `mkt_campaign_summaries` | ✅ | Campaign level. |
| `mkt_insights` | ✅ | Rule-generated. |
| `mkt_notifications` | ✅ | |
| Org-level / project-level summaries | ❌ | Only campaigns can be summarised today. |

### I. Operations — complete

`mkt_collection_jobs`, `mkt_ingestion_runs`, `mkt_raw_ingestions`,
`mkt_providers`, `mkt_actor_configs`, `mkt_settings`, `mkt_ops_alerts`,
`mkt_ops_heartbeats`, `mkt_diagnostics`, `mkt_storage_cleanup_runs`. ✅ No gaps.

### J. Our own creative production

`mkt_assets` (30 columns, **0 rows**) — models our own asset pipeline (hook,
script, production_stage). Unused. Not part of competitor intelligence; leave in
place, do not build on it until there is a decision to use it.

---

## 2. Gap analysis — evidence-backed

### 2.1 ❌ No normalized commercial facts — **the primary gap**

Real signal exists today and is unqueryable. Measured:

| Fact | In `visual_text.structured` | In `enrichment.result` |
|---|---|---|
| offers | 158 rows | 8 posts |
| prices | 11 rows | 9 posts |
| phones | 127 rows | — |
| districts | 57 rows | 59 posts |
| unit types | 51 rows | 69 posts |
| project names | 236 rows | — |
| developer names | 204 rows | — |
| payment plans | 2 rows | 1 post |

Two vocabularies (`offers` vs `offer`, `prices` vs `price`), two shapes (array vs
scalar), no units, no currency, no normalization, no time dimension, no source
attribution per fact. Consequences — none of these are expressible in SQL today:

- "What price points is developer X advertising, and how have they moved?"
- "Which competitors advertise payment plans in حي القيروان?"
- "Every phone number a competitor routes leads to" (a real sales signal)
- "Which offers are spreading across the market this month?"

### 2.2 ❌ Time-series exists only for post engagement

`mkt_metric_snapshots` is polymorphic by design but only ever holds
`subject_type='post'`. And `mkt_social_accounts.followers` is a **scalar** —
populated on **1 of 29** accounts, overwritten on each sync.

So "is this competitor growing?" and "is this campaign scaling?" are
unanswerable, and always will be until a series exists.

### 2.3 ❌ No reach or spend signal

`reach_info` is non-empty on **0 of 10** ads and is untyped jsonb. There is no
column anywhere for impressions, reach bounds, spend bounds, or active-day count.
"How much is this competitor spending?" has no home to land in even if we
obtained the data.

### 2.4 ⚠️ Two conflicting campaign entities

`mkt_paid_ads.campaign_id` → `mkt_ad_campaigns` (**10/10 ads**, paid-only, 4 rows)
while `mkt_campaign_members.paid_ad_id` links the *same ads* into `mkt_campaigns`
(cross-platform, 23 rows). An ad therefore belongs to two different "campaigns"
at once, and `campaign_id` has **no foreign key** so nothing declares which is
authoritative. `mkt_campaigns` is the real model (it spans organic + paid and
carries the grouping version, offers, corrections and summaries).

### 2.5 ⚠️ Referential integrity is mostly absent

Only 8 FK constraints exist across 39 tables. Missing FKs on `organization_id` in
`mkt_campaigns`, `mkt_insights`, `mkt_landing_pages`, `mkt_ad_campaigns`; on
`campaign_id` in `mkt_paid_ads` and `mkt_insights`; on `landing_page_id` in
`mkt_paid_ads`. (`project_id` legitimately cannot have one — projects live in the
JSONB `records` table.)

### 2.6 ⚠️ `mkt_organizations.org_type` is the wrong shape

200 `developer` + 1 `marketer`, while `mkt_project_organizations` correctly
records 950 developer links, 49 authorized-marketer links and 7
observed-marketer links across 9 marketer orgs. An org is a developer *on some
projects* and a marketer *on others* — the per-project link is right, and the
scalar contradicts it. (Known real case: the "developer" field sometimes holds
the marketer, e.g. riva.sa.)

### 2.7 ❌ No project- or org-level marketing state

Everything is per-artifact. There is no row that says "project P: 12 posts across
3 platforms by 2 orgs, last active 3 days ago, 1 active campaign". Every UI and
every intelligence prompt recomputes this by scanning.

### 2.8 Not gaps (checked, and fine)

- **Competitor projects** — `all_projects` is market-wide (980 records), so a
  competitor's project already has a home. All 1 006 project links, 4 636
  attributions and 23 campaigns resolve to it with **0 dangling**.
- **Role modelling** — `mkt_project_organizations.relationship_type` is correct.
- **Operations** — complete.

---

## 3. The new core entity: `mkt_observed_facts`

One normalized, queryable, time-stamped row per **claim** an artifact makes.

```
mkt_observed_facts(
  id, 
  -- WHAT
  fact_type        text,     -- price | price_per_m2 | payment_plan | down_payment
                             -- | offer | discount | unit_type | bedrooms | area
                             -- | district | city | phone | url | cta
                             -- | delivery_date | financing | project_name
                             -- | developer_name | amenity | selling_point | audience
  value_text       text,     -- always: the raw claim as written
  value_num        numeric,  -- when numeric (price, area, bedrooms)
  value_unit       text,     -- SAR | SAR/m2 | m2 | months | percent
  value_date       date,     -- when temporal (delivery date)
  normalized_key   text,     -- lowercased/normalized for grouping + dedup

  -- WHO / WHAT IT'S ABOUT
  organization_id  uuid REFERENCES mkt_organizations,
  project_id       uuid,     -- all_projects record (no FK — JSONB records)
  campaign_id      uuid REFERENCES mkt_campaigns,

  -- WHERE IT CAME FROM (provenance — every fact is falsifiable)
  source_type      text,     -- content_post | paid_ad | visual_text | transcript
                             -- | landing_page | enrichment
  source_id        uuid,
  content_post_id  uuid REFERENCES mkt_content_posts,
  paid_ad_id       uuid REFERENCES mkt_paid_ads,
  extractor        text,     -- ocr | caption | transcript | skill | deterministic
  extractor_version text,
  confidence       numeric,

  -- WHEN
  observed_at      timestamptz,  -- when the artifact was published/seen
  created_at, updated_at
)
```

**Why this shape**

- `value_text` is *always* populated — we never lose the original claim.
- `value_num` + `value_unit` make prices and areas comparable and aggregatable.
- `normalized_key` enables "the same offer seen 40 times" without fuzzy matching
  at query time.
- Provenance columns make every fact traceable to the exact artifact — the same
  falsifiability rule the campaign-summary validator enforces.
- `observed_at` gives the time dimension the whole vertical currently lacks.

**It is additive.** The jsonb payloads stay exactly where they are; facts are
*derived* from them. Nothing is deleted, nothing is rewritten.

---

## 4. Other new entities

### `mkt_account_metrics` — follower/audience history
Fixes §2.2 without disturbing the scalar. One row per account per capture:
`(social_account_id, captured_at, followers, following, posts_count, provider)`.
The existing `mkt_social_accounts.followers` stays as the "latest" convenience
value.

### `mkt_project_marketing_state` — per-project rollup
Fixes §2.7. Trigger- or job-maintained, mirroring the `all_projects` rollup
pattern already proven in this codebase:
`(project_id, post_count, ad_count, platform_count, org_count, campaign_count,
first_activity_at, last_activity_at, active_campaign_count, updated_at)`.

### `mkt_share_of_voice` — competitive position over time
Fixes the share-of-voice gap: `(period_start, period_end, scope_type
(city|district|market), scope_key, organization_id, post_count, ad_count,
engagement_total, share_pct, computed_at)`. Deterministic aggregate, no AI.

### Reach/spend columns on `mkt_paid_ads`
Fixes §2.3 so the data has somewhere to land the moment a provider supplies it:
`reach_lower`, `reach_upper`, `impressions_lower`, `impressions_upper`,
`spend_lower`, `spend_upper`, `spend_currency`, `active_days`.

---

## 5. Migration plan — additive, data-preserving, ordered

**Guarantees:** every step is additive or a constraint-add. No table is dropped,
no column is removed, no row is rewritten in place. Existing readers keep working
untouched at every step. Each step has a verification query and is independently
revertible.

| # | Step | Risk | Preserves |
|---|---|---|---|
| 1 | Create `mkt_observed_facts` (+ indexes, RLS) | none — new table | n/a |
| 2 | Backfill facts from `mkt_visual_text.structured` | none — reads only | jsonb untouched |
| 3 | Backfill facts from `mkt_content_enrichment.result` | none — reads only | jsonb untouched |
| 4 | Create `mkt_account_metrics` + seed from current `followers` | none | scalar kept |
| 5 | Create `mkt_project_marketing_state` + backfill | none | n/a |
| 6 | Create `mkt_share_of_voice` | none | n/a |
| 7 | Add reach/spend columns to `mkt_paid_ads` | none — nullable adds | `reach_info` kept |
| 8 | Add missing FK constraints (validated) | low — abort if violated | data unchanged |
| 9 | Deprecate `mkt_ad_campaigns` + `org_type` (comment only, no drop) | none | both kept |

**Deliberately NOT done in this pass:** dropping `mkt_ad_campaigns`, dropping
`org_type`, or rewriting the jsonb payloads. Those are destructive and must
follow a period of the new tables being live and trusted. Step 9 marks them so
the next session knows the intent.

**Ordering constraint:** steps 2–3 must run after 1; 8 must run last (FKs would
reject backfilled rows if any step introduced a bad reference).

---

## 6. Verification — RESULTS (applied 2026-07-26)

Migrations: `supabase/migrations/2026-08-04_mkt_observed_facts.sql`,
`2026-08-05_mkt_series_rollups_integrity.sql`. Baseline snapshot retained as
`public._mkt_schema_baseline_20260726` (39 tables, 14 483 rows).

| Invariant | Result |
|---|---|
| Row counts of every pre-existing table unchanged | ✅ **0 tables changed** |
| `mkt_observed_facts` populated with resolvable sources | ✅ 3 194 facts, **0** unresolvable |
| No fact references a missing organization | ✅ **0** |
| Every FK validates without `NOT VALID` | ✅ **0** unvalidated |
| New tables created | ✅ 4 |

Facts extracted: 476 project names, 334 developer names, 301 offers, 179 URLs,
128 phones, 110 districts, 93 CTAs, 80 unit types, 80 locations, 31 delivery
dates, 12 prices (all 12 parsed numerically), 2 payment plans — spanning
**2022-06-01 → 2026-07-23**, a four-year series that did not previously exist.

Price parsing was manually verified against all 12 rows, including bilingual
forms (`أسعار تبدأ من 575,000 ريال`, `Starting from 999,000 SAR`). The value
1 659 000 cross-validates against the Nawar campaign's stored `key_message`.

## 6a. Two defects this work surfaced

**Attribution quality — 83% of attributions are speculative.** 3 842 of 4 636
`mkt_content_attributions` rows are `marketer_assignment` at confidence 0.40 with
`review_status='candidate'`: they mean "this org markets these projects, so this
post *might* relate to any of them", not "this post is about this project". The
first version of the rollup counted them equally and produced ~130 posts on 3
platforms for nearly *every* project. `post_count` now counts only
`auto_accepted`/`confirmed`; speculative rows are isolated in
`candidate_post_count`. Honest numbers, e.g. عزوم النرجس: **30 confirmed vs 100
speculative** (not 130).

This is a **data-quality issue, not a schema issue** — but it means any
intelligence built on raw attribution counts before today was overstating
project activity by roughly 4×.

**The duplicate campaign entity has spread.** `mkt_insights.campaign_id` holds
`mkt_ad_campaigns` ids for all 14 of its set rows, while the cross-platform
insight rules write `mkt_campaigns` ids into the same column. It is now marked
polymorphic with a `campaign_scope` discriminator rather than given a false FK.

## 6b. Deliberately not done

Dropping `mkt_ad_campaigns`, dropping `mkt_organizations.org_type`, and
rewriting the jsonb payloads are all destructive and must follow a period of the
new tables being live and trusted. All three are marked in the database with
`COMMENT ON` so the intent survives.

~~The extraction pipeline still writes only to the jsonb payloads — facts are
currently backfill-only.~~ **Done 2026-07-26** — see §7 below.

---

## 6c. Silent-success monitoring (fixed 2026-08-12)

Two defects of one family — a green signal produced by not looking. Both were
found by asking "what would this system look like if it were broken?" rather
than by anything reporting an error.

**`content_process` jobs reported `succeeded` when their core step had died.**
The orchestrator caught a failed OCR call, appended the message to `errors`, and
returned normally; the caller then called `mkt_job_complete`. Measured on
production before the fix: **684 succeeded, 0 failed**, and **67 of those
successes carried a `vision:` error** — four days of exhausted Anthropic credits
during which every post came out with no visual text, invisible because the
queue never went red. Two further paths did the same: a post with no stored
media, and a post whose candidate-narrowing threw (leaving it at
`awaiting_intelligence` with no pending enrichment row, so the runner could
never claim it — stranded forever, reported as success).

The fix splits errors into **fatal** (`fatal_errors` → the caller throws → job
fails → bounded backoff retry → a terminal `failed` row) and **degraded**
(`errors` + a `degraded` flag → job succeeds, but countable). The split matters:
276 of those 684 jobs were degradation that *retrying cannot fix* — an expired
TikTok no-watermark URL, a datacenter-blocked YouTube download. Throwing on
those would have converted a silent-success bug into a retry storm.

| Class | Count | Treatment |
|---|---|---|
| `vision:` | 67 | fatal — no OCR means the largest evidence source is gone |
| `narrow:` | — | fatal — the post is unroutable, nothing will ever claim it |
| no media stored | — | fatal — nothing was processed |
| `youtube:` / `video_unavailable:` / `media:` / `transcribe:` | 276 | degraded — retry cannot fix it |
| `enrich:` | 33 | legacy, pre-`ab51ae6` direct-API era |

**The queue-backlog alert could never fire.** `mkt_ops_evaluate` counted
`status='pending'` — a value the `mkt_collection_jobs` CHECK constraint does not
permit (the vocabulary is `queued|running|succeeded|failed|cancelled`). A
167-job backlog was live and silent. Repaired by patching the deployed function
body via `pg_get_functiondef` + `replace` rather than re-typing 3 KB of live SQL
to change one word.

New `mkt_check_processing_health()` runs on the existing ops cadence (injected
into `mkt_ops_evaluate`, same posture as the trend engine — no new scheduler):

- **`processing_infrastructure`** — *critical*, no sample threshold. One
  `vision(infrastructure)` failure is enough, because that class (credit balance,
  auth, rate limit, 5xx, transport) hits every subsequent post identically. This
  is the check that would have caught the credit exhaustion in hours.
- **`processing_failures`** — *critical* past `ops_processing_failure_alert` (3).
- **`processing_degraded`** — *warning* past `ops_processing_degraded_ratio`
  (0.5) on a minimum sample of 10. Warning on purpose: degradation is often
  legitimate, and an alert that cries wolf is worse than none.

Verified live: the alert fires `critical`, then auto-resolves once the cause
clears. Guarded by `supabase/tests/mkt_processing_health_test.sql`, which
asserts the alert *fires* — an alert that cannot fire is the bug being fixed.

## 7. Phase 1 — live fact extraction (implemented 2026-07-26)

```
before:  content → OCR/enrichment → JSON → (manual backfill) → facts
after:   content → OCR/enrichment → JSON + facts, at write time
```

Migration: `supabase/migrations/2026-08-06_mkt_live_fact_extraction.sql`.
Regression guard: `supabase/tests/mkt_fact_extraction_test.sql` (safe against
production — every test rolls back).

### Why extraction lives in SQL, not application code

`mkt_enrichment_upsert` has **two callers in two separate npm packages** —
`worker/src/marketing/content/runContentProcess.ts` and
`scripts/claude-study-runner.mjs` — which cannot import from one another. This
repo already maintains `worker/src/imageGen.ts` as a hand-copied duplicate for
exactly that reason.

Extraction in application code would mean two implementations that drift, plus a
third (the backfill) that must stay byte-identical or *the same content yields
different facts depending on when it was processed*. One SQL implementation
invoked by `AFTER INSERT OR UPDATE` triggers removes the whole class of problem,
and additionally covers direct-SQL writers and any future service. It is the
house pattern already proven by `records_fill_project_rollups`.

**No application code changed.** The triggers fire on the tables the existing
RPCs already write to, so the worker and the runner emit facts with zero edits.

| Emitter | Source | Extractor |
|---|---|---|
| `mkt_emit_facts_visual_text` | `mkt_visual_text.structured` | `ocr` |
| `mkt_emit_facts_enrichment` | `mkt_content_enrichment.result` | `skill` |
| `mkt_emit_facts_paid_ad` | `mkt_paid_ads` cta/landing_url/headline | `deterministic` |

**Transcripts deliberately have no direct emitter.** Transcript text is free-form
speech; the enrichment Skill already reads it and produces structured output, so
transcript-derived claims arrive as `extractor='skill'` facts. Adding a second
path would duplicate them.

### Guarantees, all verified in production

| Property | Evidence |
|---|---|
| Parity with the backfill | Re-emitting everything reproduced **exactly** 1 825 OCR + 1 369 enrichment = 3 194 facts, matching per `fact_type` |
| New coverage | +22 facts from paid ads, which the backfill never touched (3 216 total) |
| Live emission, no backfill | INSERT of new OCR emitted 5 facts immediately; price `1,234,000` parsed; two spellings of one phone collapsed to 1 |
| Production RPC path works | Deleted a row's facts, called `mkt_enrichment_upsert` (the exact RPC worker + runner call) → all 7 regenerated |
| Idempotent | Re-emit twice: 3 216 → 3 216, **0** duplicate groups |
| Re-extraction replaces stale facts | UPDATE to a different price left exactly 1 fact at the new value |
| A broken extractor cannot lose an artifact | Simulated extractor exception → artifact saved, 0 facts, warning logged |

### The one deliberate exception swallow

An exception in an `AFTER` trigger aborts the whole write, so a fact-extraction
bug would prevent the OCR/enrichment row itself from being stored — permanently
losing collected content that cost real money. Facts are *fully recoverable* at
any time via `mkt_reemit_all_facts()` because extraction is deterministic and
idempotent. So `mkt_tg_emit_facts` catches, `RAISE WARNING`s with the table, row
id, message and SQLSTATE (reaching the Postgres logs), and lets the artifact
write succeed. This is a narrow, documented catch with an asymmetric-cost
justification — not a silent swallow.

`mkt_reemit_all_facts()` supersedes the one-off backfill in
`2026-08-04_mkt_observed_facts.sql`, which must not be run again.

---

## 7. What this unlocks (and explicitly does not do)

Once the schema is in place, these become plain SQL — no new AI features
required, which is the point of doing the schema first:

- price and offer trends per developer / district / period
- share of voice by district over time
- competitor growth curves
- lead-routing phone-number inventory
- "which offers are spreading", "who went quiet", "who just launched"

This document changes **no application behaviour**. No new Skill, no new runner
work, no new collection. Schema only.
