# PRD: Financing Calculator (حاسبة التمويل)

**Status:** Live — V3 (Bayut-style)
**Last updated:** 2026-08-20
**Related PRDs:** [clients.md](clients.md), [access-control.md](access-control.md)

## What it is (in plain English)

A simple installment estimator, deliberately duplicated from bayut.sa's
listing-page "حاسبة التمويل". Pick a bank, set the property price, the down
payment and the repayment period, and see the estimated monthly installment,
the total financing amount and the total amount due — instantly, with all math
done in the browser.

The previous V2 prequalification engine (four-step wizard, income/obligation
capacity, SAMA DBR ceilings, product matching, saved scenarios, consent gate,
admin screens — ~3,900 lines) was **deleted on user decision (2026-08-20):
too complicated**. Its data tables remain in the database untouched but no
code reads them.

## Why it exists

Reps want a fast "roughly what would this cost per month" answer to quote in
a WhatsApp conversation. Bayut's calculator is the reference UX the user asked
to copy.

## Key behaviors

- **Ten lenders** with a per-tenure (5–25 years) **flat annual rate** each,
  loaded from `financing_banks`; a built-in copy of the same matrix serves as
  the offline fallback. Rates were scraped verbatim from bayut.sa
  `GET /api/banks` on 2026-08-20 (including FAB's 16-year anomaly; Riyad Bank
  publishes no rates there and is seeded at Bayut's 3.60% fallback).
- **Flat-rate math, identical to Bayut** (their bundle module 90319):
  `loan = price − downPayment`; `total = loan + loan × rate × years`;
  `monthly = total / (12 × years)`. This is simple interest, NOT
  reducing-balance amortization — a 3.8% flat rate costs about the same as a
  ~6.5% APR. The flat rate is printed next to the result so the basis is
  visible.
- **Down-payment floors:** Saudi + first home → **10%** minimum; Saudi
  non-first-home and non-Saudi → **30%**; maximum 80%. Changing the floor
  resets the down payment to the new minimum (Bayut behavior).
  **Deliberate divergence:** Bayut's own "هل تمتلك عقار؟" toggle is wired
  backwards (owning property gets the 10% concession). We ask "هل هذا أول
  عقار تتملكه؟" and wire it per SAMA: first home → 10%.
- **Term** 5–25 years (default 15). **Price** free-typed, slider capped at
  1.3× the current price (Bayut's multiplier), minimum 100,000.
- **Donut** shows interest vs financing value; details card shows monthly
  installment, total financing amount and the applied flat rate.
- **Copy summary** puts a bilingual WhatsApp-ready recap on the clipboard
  (replaces Bayut's "تقديم طلب" lead form, which has no meaning inside a CRM).
- `?price=` query param prefills the price; legacy `?client=` links still open
  the page (the param is ignored).

## User flows

1. Rep opens **حاسبة التمويل** from the sidebar (or a client's quick action).
2. Picks nationality / first-home, a bank, adjusts price, down payment, term.
3. Reads the monthly figure; optionally **نسخ الملخص** and pastes into
   WhatsApp.

## Data touched

- `financing_banks` (read-only from the SPA; RLS: authenticated SELECT, no
  write policies — rates are edited via SQL/Claude, no admin UI).
- Nothing else. The page stores no customer data, saves nothing, and calls no
  API endpoint.
- Legacy tables kept but orphaned: `financing_products`, `financing_rates`,
  `financing_rules`, `financing_scenarios` (V2) and the deprecated `fin_*`
  set (V1). Drop requires an explicit user decision.

## Key files

| File | Role |
|---|---|
| `src/pages/Financing/FinancingPage.tsx` | The whole UI (one component) |
| `src/lib/financing/banks.ts` | Bank/rate types, DB loader, built-in default matrix |
| `src/lib/financing/calc.ts` | The flat-rate formula (Bayut module 90319 duplicate) |
| `src/lib/financing/__tests__/financing.test.ts` | Bayut-parity fixtures (live-measured numbers) |
| `supabase/migrations/2026-08-20_financing_bayut_style.sql` | `financing_banks` + seed |
| `src/lib/customPages.ts` | Page registration (`financing_calculator`, `/financing`, opt-in per profile) |

## Access

Registered as custom page `financing_calculator`, default access `admin`,
granted per profile in Settings (unchanged from V2). The page itself holds no
sensitive data.

## Known limitations (deliberate)

- Flat-rate quotes understate the true APR-equivalent cost — same as Bayut.
- No affordability/DBR check, no eligibility matching, no scenario history:
  all removed by design.
- Rates are hand-maintained numbers, not bank feeds; update them in
  `financing_banks` when they drift.
