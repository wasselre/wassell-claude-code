# Market Ingest — master plan

_Last updated: 2026-08-19_

This is the single entry point for the market-listing ingestion system. It says
**what we are building**, the **invariants that never bend**, the **lifecycle**
every listing flows through, **what is built vs. deferred**, and where the
per-stage detail lives. Read this first; follow the links for depth.

> **The two onboarding playbooks** — how to add a NEW portal — are the companion
> docs to this plan:
> - [`extraction-playbook.md`](./extraction-playbook.md) — build the extractor for a new platform
> - [`adapter-playbook.md`](./adapter-playbook.md) — build the adapter for a new platform

---

## 1. What we are building

A **governed, multi-portal pipeline** that brings real-estate listings from any
external portal (Aqar today; Bayut / Wasalt / others next) into the Wassell CRM's
`market_listings` model — and never lets a wrong or misunderstood value silently
become trusted data.

The whole system is one sentence:

> **Bring every source field in RAW, match it to a CRM field only after a human has
> ruled on what it means, compute all derived values inside the app, and let nothing
> reach the live table without passing the gate — then repeat for the next portal.**

Two properties make it "governed" rather than just a scraper:

1. **Provenance & meaning are first-class.** Every field a portal emits is
   catalogued with example values; a human rules on what it means; that ruling is
   the authority the adapter obeys. New/renamed/changed fields are flagged
   automatically — the system tells you when a portal changed under you.
2. **Truth is never overwritten by accident.** Extraction never alters the source;
   the adapter never invents; the app owns every computed number; enrichment added
   out-of-band (deed numbers, verified phones, mirrored photos) is never wiped by a
   routine re-scrape.

---

## 2. The invariants (non-negotiable)

These hold for **every** portal and every code path. The playbooks and Gate A all
descend from these.

1. **Extraction brings source data RAW, exactly as-is.** It never alters, coerces,
   "cleans", or drops original values. (Detail: [extraction-playbook](./extraction-playbook.md).)
2. **The adapter only MATCHES + applies field rules.** It maps raw values into CRM
   fields and applies matching rules (e.g. `0` in a basic/count field means "not
   specified" → `null`, never `0`). It does **not** compute derived values.
   (Detail: [adapter-playbook](./adapter-playbook.md).)
3. **The app computes every DERIVED value** (price/m², description counts, feature
   counts, basic-info completeness, project rollups) via DB triggers — one
   implementation, server-side, authoritative.
4. **Field meaning is DECIDED, not assumed.** The mapping from a portal field to a
   CRM column is authored by a human in the cockpit and stored in
   `source_field_mappings` (Gate A). The adapter consumes those rulings; it does not
   hardcode guesses.
5. **Nothing reaches a `market_listings` column until it has been ruled on.** The
   publish step is a deliberate, gated action — never an implicit side effect of a
   scan.
6. **Identity is `source + external_id`, never the bare ad id.** Two portals can
   share an integer id; keying on the bare id silently merges two listings into a
   chimera. (Detail: [adapter-playbook](./adapter-playbook.md).)
7. **`market_listings` is FROZEN.** It lives in its own physical table, not in
   `records`. All writes go through the frozen write-path (`record_save` /
   `market_listing_merge`); reads of existing rows come from the physical table.
   Writing to `records` for it is blocked. (Detail: [adapter-playbook](./adapter-playbook.md)
   and CLAUDE.md "Frozen models".)
8. **A missing/partial signal degrades, never fails.** One un-mirrored photo, one
   un-decided field, one absent enrichment value must not fail the listing.

---

## 3. The lifecycle (eight stages)

Every listing flows through the same conveyor, portal after portal:

```
 (per portal)                                             (shared, portal-agnostic)
┌───────────┐   ┌──────────┐   ┌───────────┐   ┌───────────────┐   ┌──────────┐   ┌──────────┐
│ 1 EXTRACT │──▶│ 2 ADAPT  │──▶│ 3 APP     │──▶│ 4 GOVERN      │──▶│ 5 COCKPIT│──▶│ 6 PUBLISH│
│  raw      │   │  match   │   │  compute  │   │  Gate A       │   │  human   │   │  gated   │
│  (RSC/…)  │   │  +rules  │   │  derived  │   │  catalog+maps │   │  rules   │   │  → live  │
└───────────┘   └──────────┘   └───────────┘   └───────────────┘   └──────────┘   └──────────┘
      │                                                                                  │
      └───────────────────────── 7 REPEAT for the next portal ──────────────────────────┘
                         8 (later) Gate B: storage enforcement + freeze CI baseline
```

| # | Stage | What it does | Where it lives | Status |
|---|-------|--------------|----------------|--------|
| 1 | **Extract** | Scrape a portal, capture every field RAW + immutable evidence | `aqar-scraper` repo; [extraction-playbook](./extraction-playbook.md) | ✅ built (Aqar) |
| 2 | **Adapt** | Match raw → CRM fields, apply field rules, route platform-specific/ignored | `aqar-scraper/src/sync/crmClient.ts`; [adapter-playbook](./adapter-playbook.md) | ✅ built (Aqar) |
| 3 | **App compute** | Derived values (price/m², counts, signals, rollups) via triggers | DB triggers on `market_listings` | ✅ built |
| 4 | **Govern (Gate A)** | Catalog every field, store mappings & gaps, hold evidence, RLS | [`gate-a.md`](./gate-a.md); tables below | ✅ built |
| 5 | **Cockpit** | Operator sees raw/mapped/health and rules on field meaning | [`automation-section-spec.md`](./automation-section-spec.md); `/market-automation` | ✅ Decisions live (Phase 2) |
| 6 | **Publish** | Gate ruled fields onto the live `market_listings` columns | ledger + `market_listing_write` + `market_listing_publish` (Phase 3 Inc 1–2) | ✅ enforced gate live; **Inc 3 (promote-to-column) pending** |
| 7 | **Next portal** | Re-run 1–6 for Bayut/Wasalt/… (schema is portal-generic) | the two playbooks | ⚠️ no portal onboarded yet besides Aqar |
| 8 | **Gate B** | Storage-object enforcement + freeze-baseline CI fixture | [`gate-a.md`](./gate-a.md) §7–8 | 🚫 deferred & blocked |

---

## 4. Governance layer (Gate A) — the spine

Gate A is the data contract every portal plugs into. Full detail in
[`gate-a.md`](./gate-a.md); the essentials:

- **`source_field_catalog`** — every observed source field path per platform, with
  example values, observed type, occurrence count, page section. Populated by
  extraction/observation. "What the portal actually gave."
- **`source_field_mappings`** — the **decision authority**. PK
  `(platform, source_path, contract_version)`. Each row's `status` is the human
  ruling: `mapped_existing_field` (+ `canonical_field`), `candidate_new_field`,
  `reviewed_source_specific`, `intentionally_ignored`, `technical_excluded`,
  `review_required`. Deciding statuses require a `reason` + stamp `reviewer` /
  `decided_at`.
- **`schema_gap_events`** — raised when a field appears with no confirmed mapping
  (new / changed / unresolved). This is the "will it tell me when a portal changes?"
  mechanism. Resolved when the operator rules.
- **`v_source_field_status`** — the reconciled view (catalog × mappings × gaps) the
  cockpit reads.
- **`market-raw` bucket** — immutable raw evidence per scrape. The source of truth
  you can always replay against.

The write path is the `source_field_decide` RPC (cockpit Phase 2). The **publisher**
(Phase 3) is a separate gated step — a decision alone never flows to the live table.

---

## 5. The cockpit — `/market-automation`

Operator-facing governance surface. Full spec in
[`automation-section-spec.md`](./automation-section-spec.md).

- **Pane A · Raw Evidence** — every observed field with examples, type, section.
- **Pane B · Field Decisions** — the queue of undecided/changed fields; the operator
  rules each (the six dispositions above). This is the gate.
- **Pane C · Data Health** — data-quality stats (completeness, missing basics).
- **Publish control** (Phase 3) — a button, never a cron.
- **Continuous monitoring** — surfaces new/missing/changed fields automatically.

`reviewed_source_specific` already produces a real behavior: the extractor keeps
those fields verbatim in `scraped_extras` (tagged `platform_specific`);
`intentionally_ignored`/`technical_excluded` are dropped. See the spec's
"`reviewed_source_specific` produces a real behavior" section.

---

## 6. Per-portal onboarding (the repeatable part)

Adding a portal = run the two playbooks in order, then govern + publish through the
shared Gate A/cockpit:

1. **[extraction-playbook.md](./extraction-playbook.md)** — find the richest
   deterministic data source in the portal's pages, write the raw extractor, capture
   evidence, feed the field catalog.
2. **[adapter-playbook.md](./adapter-playbook.md)** — write the portal's `build()`
   matching layer (0→null, no derived), wire it to the frozen write-path, consume
   the Gate A rulings.
3. **Govern** — the newly-catalogued fields appear in the cockpit's decision queue;
   the operator rules on each.
4. **Publish** (once Phase 3 exists) — promote to live columns.

The schema is already portal-generic: `source` / `external_id` identity,
`source_field_mappings.platform`, `generation_jobs` as a polymorphic queue. Nothing
in Gate A is Aqar-specific.

---

## 7. Roadmap

**Done (Phase 3 Inc 1–2, 2026-08-19):** the enforced publish gate.
`market_listing_publish_ledger` (allowlist, grandfathered) + `market_listing_write`
(the one gated write — released → live, held → `market_listing_staging`) +
`market_listing_publish` (dry-run diff + backfill-on-release). Cockpit **Publish
tab** with hold + dry-run/release. Scraper insert + update both routed through it.

**Near-term (remaining to close the loop):**
- Cockpit **Phase 3 Inc 3**: `candidate_new_field → column` promotion (repo-side
  migration surfaced as "pending column"), so a genuinely new field gets a real
  column and can then be released.
- Extend adapter decision-consumption to the ignored/technical classes (today it
  drops via not-emitting; make it explicit + decision-driven end to end).

**Mid-term (prove multi-portal):**
- Onboard a **second portal** (Bayut or Wasalt) end-to-end via the two playbooks —
  the real test that the abstraction holds.

**Later (hardening — Gate B):**
- Storage-object enforcement; freeze-baseline CI fixture (gate-a §7–8).
- Optional quality scoring/ranking layer (explicitly OUT of Gate A; only the
  deterministic inputs are captured today).
- Revoke the broad `anon` base-table grant on `market_listings` (gate-a §15).

---

## 8. Open questions (from gate-a §15)

1. Freeze-baseline fingerprint remeasurement (needs rotated read-only prod access).
2. Gate B: does the deployed Storage version honour a custom `role` JWT claim?
3. Fresh-replay behaviour once the freeze baseline migration exists.
4. Issue #15 (users whose scope resolves to `none`).
5. `anon` base-table grant revocation.
6. Whether the branch-bootstrap set should be regenerated post-freeze.

---

## 9. Document index

| Doc | Purpose |
|-----|---------|
| **`README.md`** (this) | Master plan: vision, invariants, lifecycle, roadmap |
| [`extraction-playbook.md`](./extraction-playbook.md) | Build the extractor for a NEW platform |
| [`adapter-playbook.md`](./adapter-playbook.md) | Build the adapter for a NEW platform |
| [`gate-a.md`](./gate-a.md) | Governance & evidence: tables, states, RLS, phasing |
| [`automation-section-spec.md`](./automation-section-spec.md) | The cockpit (`/market-automation`) spec |
| [`freeze-baseline-source-of-truth.md`](./freeze-baseline-source-of-truth.md) | The frozen table's exact shape (CI fixture) |
| `reconciliation-*.sql` | Break-glass restore / rollback tooling |
| `superseded-migrations.md` | Which migrations were superseded and why |

**Related memory / CLAUDE.md:** "Frozen models", `market_ingest_extraction_vs_adapter`,
`reference_frozen_merge_retired_broke_ingest`, `reference_market_listings_frozen_query`,
`project_market_listings_model`, `reference_frozen_model_view_chain_unwind`.
