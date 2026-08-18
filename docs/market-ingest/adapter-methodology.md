# Market-ingest adapters — methodology & working agreement

Last updated: 2026-08-18

This is the decision record for **how we build extraction adapters** for the
market-ingestion program. It captures the working agreement reached with the
operator (r.abanumay@wassel.re). Read this before building or changing any
platform adapter.

---

## 1. Where adapters fit (the shared engine is done; adapters are per-platform)

The pipeline has two layers:

- **The shared engine (source-agnostic, already built).** Gate A tables (raw
  evidence, the mapping authority, schema-gap flags, run/audit ledger,
  provenance) + the write-path RPCs (`ingest_capture_put`, `source_field_observe`,
  `schema_gap_raise`, …) + the controlled publisher (`market_listing_publish`).
  Nobody rebuilds this per platform. Status: merged to `main` (PR #31), **CI-green,
  NOT yet applied to production** (apply paused — see §8).
- **The per-platform adapter (bespoke).** One adapter per platform. Its only job
  is **extraction**: get the platform's pages and turn them into fields. Every
  future platform (Bayut / Dubizzle / Property Finder) is "just another adapter"
  on the same engine.

Because every adapter feeds the SAME downstream (staging → mapping → your review →
publish), **the extraction method is a swappable, per-platform choice; the engine
never changes.**

---

## 2. Core principle: there is NO single right extraction method

> Do not default to one technique. For each platform, **explore every viable
> approach**, then choose the winner on **speed, quality, and cost** *for that
> platform*. Browser automation is ONE option, not the default.

## 3. The two components (keep them separate)

1. **The adapter** — extraction only. Fetch + parse → all the fields we want. It
   does not decide where anything goes.
2. **The mapping layer** — "places every field in the right spot and flags issues":
   - **mapping authority** = `source_field_mappings` (per field: → a CRM column /
     ignore / needs-review).
   - **schema-gap flags** = `schema_gap_events` (a captured field with no decision
     raises a flag for a human — nothing is silently dropped).

## 4. Human-in-the-loop — HARD RULE

- **The operator judges extraction quality, not Claude.** Claude extracts →
  **shows the actual extracted fields** → the operator rules ("good" / "no, you
  missed the phone") → Claude fixes → re-extracts → repeat. Claude never grades
  its own extraction as good/bad/"rich"/"poor".
- **Extraction never auto-writes to the live table.** Publishing is a separate,
  allowlist-gated, off-by-default step the operator authorizes.

## 5. What happens to extracted data (the flow)

- **Raw bytes** (the fetched page / internal data / image refs) → hashed and
  stored **immutable + content-addressed** in the private `market-raw` bucket,
  with a `raw_snapshot`. Replayable, deduped, never discarded.
- **Parsed fields** → logged in the **catalog** → checked against the **mapping
  authority** → unmapped ones raise **schema gaps**. This is all **staging** — it
  does NOT touch `market_listings`.
- **Publisher** (off by default, allowlist + flag gated, identity-safe, quarantines
  destructive changes) → promotes into `market_listings` with change-event +
  provenance + photo-mirror outbox.

## 6. The extraction-approach menu (the option space to explore per platform)

| # | Approach | Typically… |
|---|---|---|
| 1 | Public JSON-LD / static HTML | fastest & cheapest; fewest fields (no phone/deed) |
| 2 | Embedded internal state — parse `next_data`/RSC `listing.*` from raw page bytes | cheap, no browser, full internal object; fragile to page changes |
| 3 | Internal API, direct (the JSON endpoint the app calls) | fastest path to the richest data — if reachable without a browser |
| 4 | Headless browser (Playwright) — render, read hydrated state, intercept API, click "show number" | most complete & robust; slowest & most expensive |
| 5 | Browser-for-handshake then replay API (browser only for cookies/tokens) | rich + fast; browser cost paid once |
| 6 | Mobile-app API | sometimes richer/less guarded; more upfront work |
| 7 | Sitemap / feed for *discovery*, paired with above for *detail* | — |

**Evaluation axes:** speed (per listing + at scale), quality (field completeness +
accuracy + fragility/break-rate), cost (compute, residential-proxy/egress,
maintenance).

**Known constraint:** Aqar's Cloudflare blocks datacenter-IP / plain requests by
ASN; the me-central1 image proxy is the working egress from Fly. Residential /
this-laptop egress works (confirmed 2026-08-18). Stay within authorized browsing —
do not bypass paywalls or defeat anti-bot beyond loading pages as a normal user.

## 7. Per-platform decision process

1. **Extraction spike:** run several approaches (esp. 2–5) against the SAME real
   listing.
2. **Comparison → operator decides:** for each method, report *which fields it
   captured*, roughly *how fast*, *what it costs*, *how fragile*. The operator
   picks the winner.
3. **Build** the adapter that way; **show** the extracted fields; iterate to the
   operator's satisfaction; only then map + (later) publish.

## 8. Current state per platform

### Aqar — NOT settled; extraction method undecided
- **Prior pilot** (`aqar-e2e-gateAB-canary`, 2026-08-16 11:30 UTC, operator
  r.abanumay) captured ONE real listing (id `6612093`, 468 KB evidence incl.
  `next_data`), discovered **94 fields**, authored **94 `source_field_mappings`**
  (23 mapped: incl. advertiser_phone, deed_number, ad_license_number, views,
  plot_area, title_ar/description_ar…) + 31 gaps — all from the **internal
  `listing.*` data**. That pilot's adapter CODE was never committed (only its data
  survives on prod).
- **PR #31 (my build):** a JSON-LD adapter (`worker/src/ingest/adapters/aqar.ts`) +
  plain-HTTP runtime (`runAqarIngest.ts`) — the **extraction half is wrong**
  (public JSON-LD via plain HTTP, ~23 fields, MISSING phone/deed/license/views).
  The parser logic + the shared contract are reusable. The write-path + publisher
  engine is fine and merged.
- **Decision pending:** run the Aqar extraction spike (§7) → operator picks method
  → rebuild the extraction half (likely browser and/or internal `listing.*`) →
  reconcile with the existing 94 `listing.*` mappings (do NOT seed a second
  `offers.*`/`jsonld.*` convention). **Do not apply PR #31's `2026-09-06_02`
  mapping seeds to prod** — they'd pollute the reviewed governance.

### Bayut / Dubizzle / Property Finder — not started
Each = a new adapter on the same engine, same spike → decide → build → operator-judge
loop. (A UAE-portals recon exists on branch `claude/extract-real-estate-listings-q371kr`.)

## 9. Open items
- **No review UI exists yet.** Mapping decisions + gaps live as DB rows; the
  reconciled `v_source_field_status` view is the raw material. A real admin review
  screen (extracted field | examples | maps to → | unmapped? | approve/fix) needs
  building — it's a screen on top of ready data.
- **Aqar extraction spike** pending operator go-ahead.
- Engine (`2026-09-06_01` write-path, `2026-09-06_02` publisher) not yet applied to
  prod; hold until the Aqar adapter/mappings are reconciled.
