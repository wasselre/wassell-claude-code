# Market Listings Automation — section spec

Last updated: 2026-08-29

The operator-facing **cockpit** for the market-ingestion pipeline. You *see* and
*decide* here; you never author extractor/adapter code here (that stays in the
repo). The section is a UI on top of the Gate A tables — no new storage model.

## 0. Principles (non-negotiable)

1. **Cockpit, not IDE.** The app does control + judgment (review, decide, re-run,
   publish). Building/testing the extractor + adapter happens in the repo.
2. **The gate is real.** No extracted value reaches a live `market_listings`
   column until a human decision exists for that field. Publishing is downstream
   of a click, never automatic.
3. **Evidence is immutable + replayable.** Raw bytes live in the `market-raw`
   bucket; the UI reads them but never rewrites them. Any interpretation can be
   re-run against the same evidence — no extractor's output is final.
4. **Completeness is judged against the FULL observed field set** (the catalog),
   never against what one extractor happened to read. This is the antidote to the
   RSC-vs-JSON-LD self-validation trap.
5. **No field is silently mapped OR silently dropped.** Every observed field is in
   exactly one state; undecided = visible in the queue, blocking nothing downstream
   but flowing nothing either.

## 1. Placement & access

- Route: `/market-automation` (top-level, its own shell — like the Marketing OS
  `/m`, not nested under a record model).
- Access: a data-ops capability (admin + a `market_automation` grant). Read for
  viewers; decide/publish for the operator.
- Nav: single entry "أتمتة إعلانات السوق / Market Listings Automation".

## 2. The contract it sits on (Gate A — already built)

| Table / view | Role | Section writes? |
|---|---|---|
| `raw_snapshot` + `market-raw` bucket | immutable raw evidence (bytes + hash) | read only |
| `source_field_catalog` | every OBSERVED field: `source_path`, `source_label`, `page_section`, `raw_data_type`, `unit`, `language`, `example_values`, `occurrence_count`, `example_listing_id`, `first/last_seen` | read only |
| `source_field_mappings` | the DECISION per `(platform, source_path)`: `status`, `canonical_field`, `transformation`, `is_equivalent_to_existing`, `reviewer`, `reason`, `decided_at` | **writes** (the decision) |
| `schema_gap_events` | undecided/ambiguous fields raised for a human: `suggested_type`, `suggested_canonical_field`, `appears_equivalent_to`, `criticality`, `affected_record_count`, `sample_listing_ids`, `status` | writes (resolve/hold) |
| `v_source_field_status` | reconciled join of catalog × mappings × gaps — the raw material for panes A & B | read only |
| `market_listings` (+ `_v`) | the live table — target-column picker + coverage stats | read only |
| publish ledger + `market_listing_publish` RPC | allowlist-gated publisher (off by default) | writes (allowlist + trigger) |

The decision table (`source_field_mappings`) **is the contract**: the app writes
the operator's rulings; the repo's adapter reads them to know how to map. Neither
side reaches around it.

## 3. Pane A — Raw Evidence ("what the platform actually gave")

**Two views.**

**A1. Field inventory (per platform).** The complete observed field set, one row
per `source_path`, so nothing an extractor skipped can hide.
- Columns: `source_path` · `source_label` · example values · `unit` · `raw_data_type`
  · `page_section` · listing-types it appears on · `occurrence_count` · decision
  status (chip) · last seen.
- Read: `v_source_field_status` filtered by platform; listing-type coverage from
  `source_field_catalog.example_listing_id` joined to `market_listings.category`.
- Row → opens the field in Pane B.

**A2. Single-listing raw.** Pick a listing → its full extracted object AND the raw
snapshot, side by side (raw evidence vs parsed fields), plus what each field
currently maps to.
- Read: `raw_snapshot` (bytes from `market-raw`), the parsed object, `source_field_mappings`.
- Action: **Re-extract** — re-run the adapter against the stored snapshot (no
  re-fetch), diff old vs new parsed output. This is how a stronger extractor is
  proven against the same evidence.

## 4. Pane B — Field Decisions ("what it means") — the gate

The core. A queue + a per-field decision panel.

**The queue.** Everything not yet ruled: `authoritative_status IN ('review_required')`
+ any catalog field with no mapping row + open `schema_gap_events`. Sorted by
`criticality` then `occurrence_count`. Nothing leaves the queue without a ruling.

**Per-field panel** shows the evidence (from Pane A) + the system's *suggestion*
(`schema_gap_events.suggested_*`, `appears_equivalent_to`) as a hint only, and a
**listing-type breakdown** — because a field's meaning can change by type
(`area` = built-area on a villa, land-area on a plot). If examples diverge by type,
the panel flags "meaning may vary by type" and lets the decision be conditional.

**What you see when deciding a field (and when you decide it).**
- **Real example values, not just the name** — pulled from real listings
  (`source_field_catalog.example_values`), plus a "peek into one ad" link to see
  the field in context. You never rule on a bare `wc`; you see `wc → "3","2","0"`.
- **Observed type vs. target type** — the section shows the type the *values*
  actually are (`raw_data_type`) next to the type of the column you'd map to. If
  they clash (a text value like the "click to contact" phone placeholder → a
  numeric column), it **warns and blocks** the mapping. Drift later fires the
  "shape changed" alert.
- **Suggestion → you confirm.** Every field arrives with a proposed disposition
  and the reason for it (name looks like X, type matches, values match, an existing
  column already holds this). Your screen is a list of suggestions to approve or
  override — never blank fields to fill.
- **You decide ONCE per platform, off accumulated evidence — not per ad.** A ruling
  is stored against `(platform, source_path)` and applies to every listing forever.
  You don't decide from one ad: the extractor runs over a representative sample
  first (all listing types + enough volume) and the catalog accrues what it saw, so
  each field shows a **confidence signal** — *"seen in N listings across M types"* —
  and thinly-evidenced fields can be **held** until more ads confirm the pattern.
  After the structure is set, cataloging continues on every run, so any new /
  missing / changed field is flagged automatically (§6b). Decide once, watch forever.

**Disposition (writes `source_field_mappings.status`):**

| Operator ruling | `status` | also captures |
|---|---|---|
| Same as an existing Wassell field | `mapped_existing_field` | `canonical_field` (target column picker), `transformation`, `is_equivalent_to_existing` |
| A genuinely new *universal* concept | `candidate_new_field` | proposed name/type → later promoted to a real column |
| Belongs only to the ad (keep, no column) | `kept_in_extras` *(new value)* | routes the value into `scraped_extras` |
| Unique platform metadata | `reviewed_source_specific` | kept per-platform (see below) |
| Noise / technical junk | `intentionally_ignored` / `technical_excluded` | dropped |
| Ambiguous — not understood yet | `review_required` | **held**; nothing flows |

Every ruling stamps `reviewer`, `reason`, `decided_at`, `contract_version`.
Writing a decision resolves the matching `schema_gap_events` row.

**`reviewed_source_specific` produces a real behavior (added 2026-08-19).** A
`reviewed_source_specific` ruling is not just a label: the aqar-scraper extractor
(`src/decisions.ts` → `src/rsc.ts`) loads the platform's set of these source paths
once per run and, for each top-level raw RSC field in the set, appends the value
verbatim to the listing's `scraped_extras` — tagged `source_section:
'platform_specific'`, keyed by source path (e.g. `listing.rega_total_price`),
objects JSON-stringified, capped at 2000 chars. The record form badges these
`خاص بالمنصة` (see `ScrapedExtrasField.tsx`), distinct from the curated Arabic-
labeled details. Fields ruled `intentionally_ignored` / `technical_excluded` are
never in the set, so they are **dropped from the record entirely** (they survive
only as immutable raw evidence in the `market-raw` bucket). Because the extractor
is the only stage holding the full raw object, the routing lives there; it fails
open (no Supabase env → capture skipped that run, logged). Storage is the existing
`scraped_extras` jsonb column — deliberately NOT a dedicated `platform_extras`
column, to avoid a frozen-table view-chain migration on the 4.85 GB
`market_listings`. Decisions take effect on the next (re-)scrape of a listing.

**Guardrails in the UI:**
- `mapped_existing_field` requires picking a real `market_listings` column, and
  warns if that column is already the target of a *different* source_path with a
  conflicting unit/type (catches "two things → one column").
- `candidate_new_field` cannot publish until promoted to an actual column
  (separate, repo-side migration) — the app shows it as "pending column".
- `area`-class fields: the picker refuses a bare `area` target when the type
  breakdown shows mixed meaning; forces built/land/total disambiguation.

## 5. Pane C — Data Health ("is the data trustworthy") — data stats, not real-estate

Operational health of the ingest itself:
- **Field coverage** — % of live listings with a non-null value per key column
  (deed_number, advertiser_phone, area, price, location…), per platform, per type.
- **Gap queue** — count of undecided/`review_required` fields + affected record
  count (from `schema_gap_events`).
- **Extraction completeness** — observed fields vs mapped vs held vs dropped.
- **Dedup** — canonical vs duplicate counts (`dupe_role`), split groups.
- **Freshness** — last scan, staleness distribution (`last_seen`, `scraped_at`).
- **Publish/quarantine** — rows promoted, rows the publisher quarantined and why.

All read-only aggregates over `market_listings`, `v_source_field_status`,
`schema_gap_events`, and the publish ledger.

## 6. Publish control (a button, never a cron)

The publisher (`market_listing_publish`) stays **off by default, allowlist-gated,
identity-safe**. The app is where the operator:
- toggles which `canonical_field`s are in the publish allowlist,
- runs a **dry-run diff** (what would change, what would be quarantined),
- releases a batch.
Nothing here runs automatically; the section only *exposes* the controls.

## 6b. Continuous monitoring & alerts (the "will it tell me?" part)

The section is a live drift-and-failure detector, not a one-time review. Because
the adapter re-catalogs every observed field on every run (`source_field_observe`)
and raises a flag for anything without a decision (`schema_gap_raise`), the cockpit
surfaces — with a badge + an alert feed — each of these AFTER go-live:

| Alert | What it means | Detected from | Type |
|---|---|---|---|
| **New unmapped field** | the platform started sending a field with no decision (schema drift / a new Aqar field) | `schema_gap_events` (raised automatically) → decision queue | structural |
| **Field went quiet** | a previously-common field stopped appearing (extractor broke, or the platform dropped it) | `source_field_catalog.occurrence_count` / `last_seen` falling off | field failure |
| **Coverage regression** | a *mapped* field's fill-rate on live listings dropped below its baseline (e.g. deed 95% → 10%) | rolling coverage over `market_listings` per column | extraction failure |
| **Type / shape change** | a field's `raw_data_type` or value pattern changed (was numeric, now text; unit changed) | `source_field_catalog` type + example drift | structural / semantic |
| **Meaning-varies-by-type** | a field's values diverge across listing types (built vs land `area`) | per-`category` example breakdown | semantic |
| **Publish quarantine** | a would-be publish failed an identity/destructive-change check | publish ledger | safety |
| **Run failure** | an extraction/adapter batch errored | run/audit ledger | operational |

Key property: **a value with no decision, or a field that failed, never silently
flows** — it either sits in the queue (unmapped) or fires an alert (regression /
quiet / quarantine). Nothing degrades quietly into the live table. Thresholds
(coverage baseline, quiet window) are per-field settings in Pane C.

## 7. Explicitly OUT of scope

- Authoring/editing extractor or adapter code (repo only).
- Real-estate analytics (prices, trends) — that's the existing analytics surface.
- Any write to `raw_snapshot` / `market-raw` (evidence is immutable).

## 8. Exists vs. to-build

- **Exists:** the whole data layer (Gate A tables + `market-raw` + the write-path
  and publisher RPCs), and the reconciled `v_source_field_status` view.
- **To build:** (1) the three panes (read-heavy UI); (2) one decision-write RPC
  (`source_field_decide`) that upserts `source_field_mappings` + resolves the gap;
  (3) the `kept_in_extras` status value + the extras-routing in the adapter;
  (4) publish-control wiring; (5) the `candidate_new_field → column` promotion flow
  (repo-side migration, surfaced as "pending column").

## 9. Suggested build order

1. **Pane A + Pane C, read-only** — you can *see* everything (raw, mapped, health)
   before any decision UI exists. Immediate value, zero risk.
2. **Pane B decision queue + `source_field_decide` RPC + the gate** — the human
   loop goes live; mappings become operator-authored, not adapter-assumed.
3. **Publish control + promote-to-column** — close the loop to the live table.

Until Pane B ships, the standing rule holds: **no field reaches a `market_listings`
column until the operator has ruled on its meaning.**

---

## Decision review mode (added 2026-08-29)

The per-field decision UI is a **full-page focus mode** (not the old right drawer),
reached by clicking any row in the Raw Evidence / Field Decisions tabs.
Implemented in `src/pages/MarketAutomation/components/DecisionPanel.tsx`; navigation
+ session state live in `MarketAutomationPage.tsx`.

- **Filter bar** (raw + decisions tabs): text search (path / AR+EN label / target)
  and status chips (All / Needs decision / Mapped / New / Platform-specific /
  Ignored / Excluded), with a live match count.
- **Walk the list**: Prev / Save & Next / Save & close, plus ←/→ keys (RTL-aware)
  and Esc. Saving does an OPTIMISTIC in-place row update (no full reload → no scroll
  jump) and advances to the next field in the current filtered snapshot.
- **Gamification** (session-scoped, resets on reload): a progress bar that counts
  **the fields YOU decided this session** out of the list you're walking
  (`راجعت X من Y في هذه الجلسة`) — NOT the global already-decided count — with the
  real remaining queue shown as a muted note; a 🔥 streak, ⭐ XP (+10/decision,
  +15 for a real mapping), a 🏆 level, and a completion banner when the list (or the
  whole queue) is cleared.
- **Split mappings are adapter logic, not a cockpit feature.** One source can feed
  two columns (e.g. `listing.categoryName` → clean `property_type` + `offer_type`
  sale/rent). The cockpit records the primary mapping (`→ property_type`) with a
  reason; the second half is done in the scraper adapter. Same pattern as
  `listing.closed` (a sold signal, filed "ignored" as a mapping but consumed in code).
