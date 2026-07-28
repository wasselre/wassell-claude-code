# Saudi Real Estate Financing — technical documentation

_Last updated: 2026-07-28_

## What this module is

An indicative real-estate financing calculator and financing-intelligence system
for Wassel. It answers four questions for a customer, from officially published
data only:

1. How much financing might they afford?
2. What would a specific property cost them per month?
3. Which Saudi financing products appear applicable, and why?
4. What cash do they need on the day?

It is **not** a bank approval and cannot express one. See "The honesty
architecture" below — that constraint is enforced by the type system, the
database schema, and the tests, not by a disclaimer alone.

---

## The honesty architecture

Everything unusual about this module exists to prevent one failure: a
confident-looking number that the bank will not honour. Four mechanisms:

### 1. `rate_disclosure_type` is a first-class, NOT NULL column

Saudi banks overwhelmingly publish a *"starting from"* APR attached to one
representative example, not a customer-specific contractual rate. Of the 21
seeded products, **4 carry any published rate at all**, and only one of those is
an exact contractual rate.

`fin_product_rate_versions.rate_disclosure_type` records which kind of figure a
number is: `exact_rate | starting_from | published_range |
representative_example | promotional | quotation_required`. A CHECK constraint
refuses an `exact_rate` row that has no contractual rate. The engine maps it to
a `RateBasis`, and **every UI surface that renders an installment also renders
the basis chip**.

### 2. A product with no published rate produces NO installment

`ProductMatch.monthly_payment` stays `null` and the status becomes
`product_data_unavailable`. The database enforces this too:

```sql
CONSTRAINT fin_match_payment_needs_basis CHECK (
  estimated_monthly_payment IS NULL OR (rate_basis IS NOT NULL AND rate_basis <> 'unavailable')
)
```

### 3. Unknown ≠ permitted, and unknown ≠ excluded

An eligibility criterion the provider does not publish becomes an entry in
`unknown_criteria` and downgrades the match to `requires_bank_review`. Treating
`null` as "no restriction" would recommend products the customer cannot get;
treating it as "excluded" would empty the list. Both are wrong.

### 4. `'approved'` is unrepresentable

The `ResultStatus` union has no `approved` member, and the
`fin_calculation_results.result_status` CHECK omits it. The status cannot be
typed, stored, or rendered.

---

## Data model

36 tables, all prefixed `fin_`. Two layers with different security postures.

### Reference layer — public bank data, staff-readable, admin-writable

| Table | Holds |
|---|---|
| `fin_sources` | Official sources only. A CHECK (`is_official = true`) bans blogs/aggregators. `authority_rank` (1 regulator … 5 provider) resolves conflicts toward the higher authority. |
| `fin_source_records` | One row per fetch **attempt**, including failures. A dead source is data. |
| `fin_source_snapshots` | Immutable page captures, deduped by `(source_id, content_hash)`. |
| `fin_data_refresh_runs` | Per-refresh counters. |
| `fin_data_validation_issues` | Named gaps and contradictions. |
| `fin_manual_review_queue` | Extracted changes awaiting a human decision. |
| `fin_providers` / `fin_products` | Entities. |
| `fin_product_versions` | Eligibility + limits, effective-dated. |
| `fin_product_rate_versions` | Pricing, effective-dated (moves far faster). |
| `fin_product_fee_rules` / `_eligibility_rules` / `_document_requirements` / `_property_rules` | Structured detail. |
| `fin_project_provider_approvals` | **Seeded empty on purpose** — bank project-approval lists are not public. |
| `fin_regulatory_rules` + `_versions` | SAMA/ZATCA rules as machine-readable payloads. |
| `fin_support_programs` + `_versions` | REDF / Sakani. |
| `fin_tax_rules` + `_versions` | RETT. |
| `fin_benchmarks` + `_observations` | SAIBOR. Observations immutable. |

### Scenario layer — customer financial data, owner-scoped

`fin_scenarios` → `fin_scenario_applicants`, `fin_income_sources`,
`fin_obligations`, `fin_scenario_support`, `fin_property_scenarios`,
`fin_preferences`, `fin_calculation_runs`, `fin_calculation_results`,
`fin_product_match_results`, `fin_cash_flows`, `fin_scenario_notes`,
`fin_audit_events`.

Customer identity is **not** duplicated — `client_record_id` points at the
existing `records` row.

### Versioning contract

Every version table carries `effective_from` / `effective_to`, provenance
(`source_id` NOT NULL, `source_url`, `collected_at`, `verified_at`,
`extraction_method`, `confidence`, `content_hash`), and review columns.

**Append-only triggers** (`fin_tg_version_append_only`) block DELETE and freeze
`effective_from` / `source_id`. A correction creates a new version. Results,
runs, cash flows, audit events and benchmark observations are fully append-only.

Selection goes through `fin_rule_version_at()`, `fin_product_version_at()`,
`fin_rate_version_at()` — one implementation, so the SPA, the API and any future
worker cannot each invent their own "which rule was live then".

---

## Reproducing a historical calculation

Every run stores:

- `engine_version` and `as_of_date`
- `input_snapshot` (frozen — later edits to the scenario do not touch it)
- `result_snapshot`
- pinned arrays: `regulatory_rule_version_ids`, `tax_rule_version_ids`,
  `support_program_version_ids`, `product_version_ids`, `rate_version_ids`,
  `benchmark_observation_ids`

To replay: read `input_snapshot`, load reference data with the run's
`as_of_date`, and run the engine at the recorded `engine_version`. The pinned
ids let you verify you loaded exactly what the original run read.

The seed contains a live demonstration: `sama_ltv_ceilings` has a **superseded**
version (85% first-home, 2017-01-05 → 2018-01-14) alongside the current 90% one.
A calculation dated in that window replays against 85%.

---

## The calculation engine (`src/lib/financing/`)

Pure, deterministic, dependency-free. No clock reads (`as_of_date` is an input),
no randomness, no network, **no LLM**. Same inputs → byte-identical output,
asserted in tests.

| File | Responsibility |
|---|---|
| `types.ts` | Domain types. `ResultStatus` has no `approved`. |
| `money.ts` | Integer-halala arithmetic, safe date maths. |
| `payment.ts` | Per-method schedules and payment/principal maths. |
| `apr.ts` | SAMA cash-flow IRR. |
| `capacity.ts` | Qualifying income, obligations, DBR ceilings. |
| `ltv.ts` | LTV matrix, fees, upfront cash, RETT. |
| `matching.ts` | Eligibility, rate resolution, staleness. |
| `engine.ts` | Orchestration. |

**There is not one numeric regulatory literal in `capacity.ts` or `ltv.ts`.**
Every percentage comes from a `RuleVersion` payload.

### Flow

1. **Qualifying income** (SAMA Art. 14) — gross salary 100%; other periodic
   income 50% and only with ≥24 months of documented history; government
   subsidies excluded except documented MoH/REDF support in real-estate
   products. Declared / verified / qualifying are three separate outputs.
2. **Obligations** (Art. 13) — a credit card is charged as a percentage of its
   **ceiling**, not its balance. Uneven instalments are averaged including any
   balloon. An obligation ending before financing starts is excluded *and*
   reported, *and* drives a second "after it ends" scenario.
3. **Ceilings** — evaluated separately, most restrictive wins:
   - total obligations (% of total income; 65% for MoH/REDF beneficiaries)
   - non-real-estate obligations (45%)
   - salary deduction (33.33% employees / 25% retirees — of **gross salary**, a
     different base)
   - the customer's own stated maximum
   - For income ≥ SAR 25,000 the rule **defers to the creditor** (Art. 17b); the
     engine returns `requires_bank_review` rather than inventing a ratio.
4. **Principal** — reverse of the product's documented cash-flow method.
5. **LTV** — the tighter of the regulatory matrix and the product's own cap.
6. **Upfront cash** — down payment, valuation gap, capped fees, RETT less
   first-home relief.
7. **APR** — see below.
8. **Confidence** — the **worst** of rate basis, product-data confidence,
   schedule approximation, staleness and unknown-criteria count.

### APR

SAMA's Rules Governing Calculation of the APR (circular 45025707, 17/4/1445H):

```
Σ C_d/(1+X)^S_d  =  Σ B_p/(1+X)^t_p
```

Periods in years on a basis of **twelve equal months**; all unavoidable costs
included; default penalties excluded. Solved by **bisection** (deterministic and
bracketed, unlike Newton–Raphson on a schedule with a balloon).

**APR is an EFFECTIVE annual rate.** A product contracted at a nominal 5% paid
monthly has an APR of `(1 + 0.05/12)^12 − 1 = 5.1162%` *before any fee*. APR is
never equal to the profit rate. Asserted in
`src/lib/financing/__tests__/apr.test.ts`.

When no contractual rate is published, `canCalculateCompliantApr` refuses and
the UI shows the **published** APR labelled as published.

---

## Ingestion pipeline

```
npm run financing:fetch     # stage 1 — parallel Browserbase fetch
npm run financing:seed      # stages 2-7 — parse, validate, diff, version, report
npm run financing:refresh   # both, marked trigger=scheduled
```

### Why Browserbase

Every source that matters is behind Cloudflare or renders client-side. Plain
`fetch()` returned challenge pages for sama.gov.sa, sakani.sa, bidaya.com.sa and
bsf.sa. Browserbase reached **33 of 45** sources; the other 12 are recorded as
failures, not as "no data". Sources are fetched **in parallel** (bounded worker
pool) — a full refresh is one wall-clock batch.

### The evidence contract

Every non-null seeded fact carries the **verbatim sentence** from the official
page that states it. Before writing, the seeder re-checks that string against
the current snapshot:

- present → supported; re-stamp `verified_at`
- absent → open a `fin_data_validation_issues` row; do **not** keep the old
  number silently and do **not** adopt a new one automatically

This is what makes fabrication structurally hard: a number with no matching
sentence on an official page cannot pass validation.

### Idempotency

Re-running creates nothing. Version comparison uses **canonical JSON** (keys
sorted at every depth) because Postgres reorders `jsonb` keys — comparing raw
`JSON.stringify` reported "changed" on every run and would have filled the
history with fabricated change events. Verified: run 1 created 36 versions, run
2 created 0.

---

## Security

- Every `/api/financing` call runs on the **caller's JWT**. No service-role path.
- Reference data: read = any authenticated user, write = `wassell_is_admin`.
- Scenario data: `fin_can_access_scenario()` — owner, assigned specialist,
  creator, or admin. Children inherit through one `EXISTS` on the parent.
- The engine runs **server-side** so the stored run is authoritative.
- `fin_audit_events` records which fields changed, **never their values** —
  logging salaries into a table with a broader read audience would defeat the
  scoping.
- No national ID is collected. An indicative estimate does not need one.
- **Consent gate**: `convert_to_case` returns 409 unless
  `consent_to_share_with_provider` is recorded. Enforced server-side.

---

## Known limitations

These require access this repository does not have:

1. **No SIMAH access.** Declared obligations are self-reported.
2. **Bank project-approval lists are not public.** `fin_project_provider_approvals`
   is empty; the UI says "project approval not verified".
3. **Approved-employer lists are not published.** Any product requiring one
   always returns `requires_bank_review`.
4. **Most contractual profit rates are not published.** 4 of 21 products carry a
   rate; 1 is exact. Everything else needs a bank quotation.
5. **SAMA's licensed-entity register was unreachable** (server error on every
   attempt). No provider is marked `license_verified`.
6. **REDF/Sakani subsidy figures could not be collected** — sakani.sa returned a
   bot challenge, redf.gov.sa timed out. Amounts are NULL, not estimated.
7. **No current SAIBOR fixing.** The only machine-readable official disclosure
   (BSF) is dated 2022-10-11. Seeded with its real date so the staleness
   detector fires; variable products must not be priced from it.
8. **The ZATCA RETT guideline PDF was not machine-readable** (download stream).
   RETT figures are `confidence: medium` with an open review issue.

## How to

**Add a provider** → add to `PROVIDERS` in
`scripts/financing/sources/providerData.mjs`, add its source to `manifest.mjs`,
run `financing:refresh`.

**Add a product** → add to `PRODUCTS` with an `evidence` array quoting the
official page. Omit `rate` entirely if no rate is published.

**Update a regulatory rule** → add a new entry (or bump `version_number`) in
`regulatoryData.mjs` with the new `effective_from`; the seeder closes the old
window and opens a new one. Never edit a stored version.

**Correct a source** → fix the URL in `manifest.mjs` and re-run
`financing:fetch`. The old snapshot stays.
