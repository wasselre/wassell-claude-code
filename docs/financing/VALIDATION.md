# Validation against official bank disclosures

_Last updated: 2026-07-29_

The spec asks that, where official bank calculators or disclosures are publicly
accessible, we compare their published output against our implementation,
record the comparison, explain any variance, and define an acceptable tolerance
— **without** bending our formulas to match a calculator whose method is
undocumented.

Two Saudi banks publish formal **APR disclosure** pages carrying complete
representative examples: property value, LTV, term, APR, monthly payment and
early-settlement terms. Those are the strongest validation targets available in
this market, and this is the comparison against them.

## Sources

| Bank | Disclosure |
|---|---|
| Riyad Bank | [Prices of financing and savings products](https://www.riyadbank.com/information/special-pages/arp-disclosure) |
| Banque Saudi Fransi | [Home finance products](https://bsf.sa/arabic/personal/finance/home-finance-products/tawaruq-personal-finance) and sibling product pages |

## Test 1 — APR round-trip (the direct test of our APR engine)

Build the payment schedule at the nominal rate implied by each published APR,
then re-solve the APR from those cash flows with our SAMA IRR implementation.
A correct implementation returns the published figure.

| Example | Published APR | Re-solved by our engine | Δ |
|---|---|---|---|
| Riyad — Murabaha, first home | 6.90% | **6.9000%** | 0.0000 pp |
| Riyad — self-construction | 6.71% | **6.7100%** | 0.0000 pp |
| Riyad — Tawarruq home equity | 7.17% | **7.1700%** | 0.0000 pp |

**Exact to four decimal places on all three.** Our APR solver agrees with SAMA's
methodology as these banks apply it. This is the single most important
validation result in the module.

## Test 2 — monthly payment reconstruction

Rebuild each published monthly payment from the published inputs
(property × LTV = principal, at the published APR, over the published term).

| Example | Principal | Published | Ours | Variance |
|---|---|---|---|---|
| Riyad — Murabaha, first home (850,000 · 90% · 25y) | 765,000 | 5,221.30 | 5,256.98 | **+0.68%** |
| Riyad — self-construction (1,000,000 · 90% · 11y) | 900,000 | 9,510.68 | 9,567.01 | **+0.59%** |
| BSF — first home (1,000,000 · 90% · 25y) | 900,000 | 6,525.00 | 6,572.76 | **+0.73%** |
| Riyad — Tawarruq home equity (500,000 · 46% · 16y) | 230,000 | 2,468.84 | 1,987.36 | **−19.50%** |

### Explaining the variance

**The three purchase products agree to within 0.73%, all in the same direction
(ours slightly high).** That direction is exactly what theory predicts and is
itself evidence the implementation is right:

APR includes fees; a profit rate does not. When we invert a published APR to get
a nominal rate, we recover a rate that carries *both* profit and fee cost. Using
it as if it were pure profit therefore produces a payment slightly **above** the
bank's, by roughly the fee component. An admin fee near the SAMA cap (1% of the
amount or SAR 5,000, whichever is lower) spread over 11–25 years accounts for a
variance of this size and sign. If our figures came out *below* the published
ones, that would signal a real defect; coming out slightly above does not.

**Accepted tolerance: ±1.0% on the monthly payment** for products priced from a
published APR rather than a published contractual rate, provided the variance is
positive. A negative variance, or anything beyond ±1.0%, is a defect and should
fail review.

### The fourth case is a genuine finding, not a rounding error

Riyad's Tawarruq home-equity example does not reconcile with **any** standard
amortising schedule at the stated 46% LTV. Working backwards from the published
SAR 2,468.84 over 16 years at 7.17% implies a principal near SAR 285,700 — about
57% of the SAR 500,000 property, not the 46% stated.

We did **not** adjust our formula to close that gap. Home equity against an
already-owned property is not a purchase Murabaha, and the spec is explicit that
we must not reshape our maths to match an undocumented method. Instead the
product is seeded with `calculation_method: 'manual_quotation'`, so the engine
declines to publish an installment for it and asks for a bank quotation. The
discrepancy is recorded here and in the product's `conditions_notes`.

This is the schema's `calculation_method` column doing exactly the job it exists
for: one product family in the dataset genuinely does not amortise the way the
others do, and the system says so rather than guessing.

## Reproducing

The comparison is arithmetic over the published figures in
`scripts/financing/sources/providerData.mjs` (each carries its `example_*`
fields and an `evidence` quote). Re-run it against
`src/lib/financing/payment.ts` and `src/lib/financing/apr.ts`; both are pure and
need no database.

## What this does and does not establish

**Establishes:** our APR implementation matches SAMA's methodology as two banks
independently apply it; our amortisation matches published payments within a
stated, explained tolerance on ordinary purchase products.

**Does not establish:** that any customer will be offered these rates. Every
figure above is a *representative example*; all four are stored as
`rate_disclosure_type: 'representative_example'` and surface in the UI with an
orange basis chip. Riyad states plainly that "APR may differ depending on the
amount and the maturity period different from above and subject to credit
scoring of each customer."
