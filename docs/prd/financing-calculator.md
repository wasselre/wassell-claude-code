# PRD: Financing Calculator (حاسبة التمويل العقاري)

**Status:** Live
**Last updated:** 2026-07-28
**Related PRDs:** [clients.md](clients.md), [sales-process.md](sales-process.md), [record-management.md](record-management.md), [access-control.md](access-control.md), [data-storage.md](data-storage.md)

## What it is (in plain English)

A financing calculator and financing-intelligence system inside Wassel. A rep
opens it from a client (or from a project/unit), answers a six-step
questionnaire about the customer's income, existing debts, government-support
status, the property and their preferences, and gets back an **indicative**
answer: how much they can likely afford, what a specific property would cost per
month, which Saudi bank products appear applicable, why each one does or does
not fit, and what cash they need on the day.

Every number carries its provenance: which official page it came from, when that
page was last verified, and — critically — whether the rate behind it is a real
contractual rate or a bank's "starting from" marketing figure. The scenario can
be saved, duplicated for what-ifs, attached to a project or unit, and converted
into a financing case in the existing `financing` model.

It never says "approved". It structurally cannot.

## Why it exists

Reps were quoting monthly payments from memory or from a bank's public
calculator, with no record of what was said, no check against the customer's
actual debt burden, and no way to reproduce the figure a month later when the
customer asked why it changed. Meanwhile the regulatory rules that decide
affordability (SAMA's debt-burden bands, the LTV matrix, qualifying-income
treatment) are precise, public, and were being applied inconsistently or not at
all.

## Key behaviors

- **Three calculator modes** in one engine: affordability (no property),
  property payment (a specific unit), and product comparison.
- **Declared / verified / qualifying income are three separate numbers.** Basic
  salary counts in full; other periodic income counts at 50% and only with ≥24
  months of documentation; government subsidies are excluded **except**
  documented REDF/Sakani support in a real-estate product.
- **A credit card is charged on its LIMIT, not its balance** — a SAR 50,000
  limit carries a monthly obligation at a zero balance.
- **Every affordability ceiling is evaluated separately and the most restrictive
  wins**: total obligations, non-real-estate obligations, salary deduction (a %
  of gross salary — a different base), and the customer's own stated maximum.
- **Income ≥ SAR 25,000 returns `requires_bank_review`**, because SAMA Art. 17
  hands the real-estate decision to the creditor's own policy. The system does
  not invent a ratio.
- **An obligation ending before financing starts is excluded, reported, AND
  drives a second "after it ends" scenario.** It is never silently dropped.
- **A product with no published rate produces no installment** and shows
  "product data unavailable". Most Saudi banks publish no rate; 4 of 21 seeded
  products carry one.
- **Every displayed installment shows its rate basis.** Green = published
  contractual rate. Orange = "starting from" / representative example / range
  midpoint, i.e. an approximation.
- **An unknown eligibility criterion downgrades to `requires_bank_review`** —
  never a silent pass, never a silent exclusion.
- **APR is a cash-flow IRR per SAMA's methodology**, not a nominal-rate
  conversion. It is an *effective* annual rate, so it always exceeds the profit
  rate even with zero fees.
- **Stale data is flagged**, per-source: pricing goes stale in 90 days,
  regulations in 365, benchmarks in 7.
- **Consent is required before converting to a financing case.** Enforced
  server-side (409), not just hidden in the UI.
- **Calculations are immutable and reproducible.** Each run freezes its inputs,
  its results and the exact rule/product/rate version ids it read.

## User flows

1. **Main happy path:** Client 360 → "حاسبة التمويل" quick action → wizard
   pre-filled with the client link → six steps (each "Next" saves a draft) →
   Calculate → results page with capacity breakdown, product comparison, term
   and down-payment grids, upfront cash, and caveats.
2. **Affordability only:** skip the property step. The engine returns maximum
   installment, maximum financing and maximum property value with no selected
   product.
3. **What-if:** open a saved scenario → Duplicate → change the term or down
   payment → Recalculate → compare the two runs.
4. **Convert:** on a result, record customer consent, then "Convert to financing
   case" → creates a `financing` record via `record_save`, carrying the chosen
   product's required-document list.
5. **Empty/error state:** with no products seeded the result is
   `product_data_unavailable`; with a missing regulatory rule it is
   `insufficient_information` — both explain what is missing rather than
   showing a zero.

## Data touched

- **Reads:** `fin_regulatory_rule_versions`, `fin_product_versions`,
  `fin_product_rate_versions`, `fin_product_fee_rules`,
  `fin_tax_rule_versions`, `fin_support_program_versions`,
  `fin_benchmark_observations`, `fin_providers`, `fin_products`, `users`
- **Writes:** `fin_scenarios` + children (`fin_scenario_applicants`,
  `fin_income_sources`, `fin_obligations`, `fin_scenario_support`,
  `fin_property_scenarios`, `fin_preferences`), `fin_calculation_runs`,
  `fin_calculation_results`, `fin_product_match_results`, `fin_cash_flows`,
  `fin_scenario_notes`, `fin_audit_events`
- **Writes on conversion:** `records` (the `financing` model, via the
  `record_save` RPC)
- **Ingestion writes:** `fin_sources`, `fin_source_records`,
  `fin_source_snapshots`, `fin_data_refresh_runs`,
  `fin_data_validation_issues`, `fin_manual_review_queue`, and every
  reference/version table

## Key files

| File | What it does |
|---|---|
| `src/lib/financing/engine.ts` | Orchestrates the whole calculation; pins version ids |
| `src/lib/financing/capacity.ts` | Qualifying income, obligations, DBR ceilings (no numeric literals) |
| `src/lib/financing/payment.ts` | Per-method payment maths and dated cash-flow schedules |
| `src/lib/financing/apr.ts` | SAMA cash-flow IRR APR |
| `src/lib/financing/ltv.ts` | LTV matrix, fee cap, upfront cash, RETT |
| `src/lib/financing/matching.ts` | Eligibility evaluation, rate resolution, staleness |
| `src/lib/financing/types.ts` | Domain types; `ResultStatus` has no `approved` |
| `src/lib/financing/client.ts` | SPA client + bilingual label vocabulary + SAR formatting |
| `api/financing.ts` | Action-dispatch endpoint on the caller's JWT; runs the engine server-side |
| `src/pages/Financing/FinancingPage.tsx` | Dashboard / scenarios / products / admin tabs |
| `src/pages/Financing/components/ScenarioWizard.tsx` | The six-step questionnaire |
| `src/pages/Financing/components/ResultsView.tsx` | Results, comparison, grids, caveats |
| `src/pages/Financing/components/StatusChips.tsx` | Status / confidence / rate-basis / stale chips |
| `scripts/financing/fetch-sources.mjs` | Stage 1 — parallel Browserbase fetch |
| `scripts/financing/seed.mjs` | Stages 2–7 — validate, diff, versioned upsert, issue log |
| `scripts/financing/sources/manifest.mjs` | The official-source manifest |
| `scripts/financing/sources/regulatoryData.mjs` | Reviewed SAMA/ZATCA rules with verbatim evidence |
| `scripts/financing/sources/providerData.mjs` | Reviewed provider/product data with verbatim evidence |
| `supabase/migrations/2026-08-28_01_financing_reference_data.sql` | Reference layer |
| `supabase/migrations/2026-08-28_02_financing_scenarios.sql` | Scenario layer |
| `docs/financing/ARCHITECTURE.md` | Full technical documentation |
| `docs/financing/EMPLOYEE-GUIDE.md` | Bilingual guide for reps |

## Access control

`financing_calculator` is a custom page with `default_access: 'admin'` —
opt-in per profile in Settings → Profiles, because the module reads customer
salary and debt data. The real gate is RLS: reference data is readable by any
authenticated user and writable only by admins; a scenario is visible only to
its owner, its assigned specialist, its creator, or an admin.

## Known limitations

Documented in full in `docs/financing/ARCHITECTURE.md`. In summary: no SIMAH
access; bank project-approval and approved-employer lists are not public; most
contractual rates are not published; SAMA's licensed-entity register and the
Sakani/REDF figures could not be collected; no current SAIBOR fixing is
publicly machine-readable.
