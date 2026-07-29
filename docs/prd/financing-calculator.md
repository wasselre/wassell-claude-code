# PRD: Financing Calculator (حاسبة التمويل العقاري)

**Status:** Live — V2 (simplified)
**Last updated:** 2026-08-30
**Related PRDs:** [clients.md](clients.md), [sales-process.md](sales-process.md), [access-control.md](access-control.md)

## What it is (in plain English)

An indicative prequalification tool. A rep opens it from a client, answers a
four-step form, and gets an estimate: roughly what the customer can afford,
roughly what a property would cost per month, which of six Saudi bank products
may fit based on published criteria, and what cash is needed at closing. The
scenario saves under the client, can be attached to a project or unit, and can
be converted into the existing `financing` case.

It is **not** a bank underwriting platform, a SIMAH replacement, a regulatory
archive, or a mortgage-data warehouse. V1 drifted into being all four; V2 is the
correction.

## Why it exists

Reps were quoting payments from memory, with no record of what was said and no
check against the customer's real debt burden — while the SAMA rules that decide
affordability are public and precise.

## Key behaviors

- **Four steps, ~20 fields.** Customer → income & obligations → property &
  support → financing.
- **An exact payment requires an exact rate.** Only a published *contractual*
  rate or a rep-entered *bank quotation* produces a monthly payment. A
  "starting from" figure or a representative example produces
  **"exact calculation requires a bank quotation"** instead of a number.
- **Five match statuses, no eligibility claims:** meets published criteria ·
  does not meet published criteria · requires bank review · pricing unavailable ·
  rate stale.
- **Unknown ⇒ requires bank review.** Unpublished criteria, approved-employer
  requirements, project approval and SIMAH status all route here.
- **`approved` does not exist** — absent from the type union and from the DB CHECK.
- **Credit cards are charged on the LIMIT**, not the balance (SAMA Art. 13a).
- **Unverified other income counts zero**, not a reduced share.
- **Retirees are held to 25%**, employees to 33.33% of gross salary.
- **Income ≥ SAR 25,000 returns `requires_bank_review`** — SAMA Art. 17 leaves
  the real-estate ceiling to the bank, so the engine does not invent a ratio.
- **Every rate shows its official source URL and verification date.** Rates
  older than 120 days, or explicitly marked, read as stale.
- **Consent is required before conversion**, enforced server-side (409).
- **Completed scenarios are frozen** — a DB trigger refuses to rewrite a
  `result_snapshot` once `completed_at` is set. Recalculating means duplicating.
- **The snapshot carries the rule values used**, so a historical result stays
  readable without a version graph.

## User flows

1. **Main path:** Client 360 → financing action → four steps → Calculate →
   results with capacity, comparison, upfront cash, caveats.
2. **Affordability only:** leave the property price blank.
3. **With a quotation:** enter the rate the bank quoted plus which bank; that
   product then prices exactly while the others still say "quotation required".
4. **Convert:** record consent → convert → creates a `financing` record via the
   existing `record_save` RPC.

## Data touched

- **Reads/writes:** `financing_products`, `financing_rates`, `financing_rules`,
  `financing_scenarios`
- **Writes on conversion:** `records` (the existing `financing` model, via
  `record_save`)
- **Deprecated, read-only, not read by the app:** the 36 `fin_*` V1 tables —
  see `docs/financing/CLEANUP-PLAN.md`

## Key files

| File | What it does |
|---|---|
| `src/lib/financing/types.ts` | Domain types; `approved` is absent |
| `src/lib/financing/capacity.ts` | Qualifying income, obligations, DBR ceilings |
| `src/lib/financing/payment.ts` | Fixed-rate amortisation + upfront cash |
| `src/lib/financing/matching.ts` | Five-status matcher, rate resolution, staleness |
| `src/lib/financing/engine.ts` | Thin orchestrator; freezes the rules used |
| `src/lib/financing/money.ts` | Deterministic rounding |
| `src/lib/financing/client.ts` | SPA client + bilingual labels |
| `api/financing.ts` | One action-dispatch endpoint on the caller's JWT |
| `src/pages/Financing/FinancingPage.tsx` | Scenarios, wizard, results, admin |
| `supabase/migrations/2026-08-30_0{1,2,3}_*.sql` | V2 schema, data migration, V1 deprecation |

## Access control

`financing_calculator` is a custom page, `default_access: 'admin'` — opt-in per
profile, because it reads salary and debt data. RLS is the real gate: reference
data is readable by any authenticated user and writable only by admins; a
scenario is visible only to its owner, assignee, creator, or an admin.

This application is single-tenant — there is no organizations table — so the
"organization model" here is users + profiles + `wassell_is_admin`.

## Not supported (by design)

Balloon, step-up, self-construction schedules, staged/off-plan disbursement,
undocumented Ijarah, and variable products without a benchmark all return
"exact calculation requires a bank quotation". There is no APR engine: APR is
displayed as the bank publishes it.

## Known limitations

No SIMAH access. Bank project-approval and approved-employer lists are not
public. Most Saudi banks do not publish a contractual profit rate — of the six
seeded products, four carry a published pricing figure and only one is an exact
contractual rate. Sakani/REDF subsidy amounts are not published and are stored
as NULL rather than estimated.
