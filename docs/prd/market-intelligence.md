# Market Intelligence

**Last updated:** 2026-06-29

## What it is
A brokerage **command center** built on a deterministic benchmark precompute layer over the data Wassel already holds — **46,561 market listings** (Aqar asking ads), **our verified units**, and **client demand**. It answers: where are prices, where is demand strong, where is supply weak, which of our projects are mispriced, and which districts to source inventory from. It also powers **deal-quality badges** inside the Project Finder and generates **branded PDF reports** (client market snapshot + our-project pricing).

**ZERO AI in any number.** Every figure is a precomputed SQL aggregate or a DB-filtered scan. No LLM computes a benchmark, ranking, badge, or conclusion. (The Project Finder's existing bounded parse/explain + `assertRankingUnchanged` guard are untouched; badges are attached *after* ranking and never affect order.)

**Honest by design.** Asking prices are labelled "current asking market", never "market value". Every benchmark carries `raw_count` vs `deduped_count` + `duplicate_ratio` + a `confidence_grade` (high/medium/low). Transaction data is **not connected yet** (`market_listings.sold_at` is empty) — the schema + readers are transaction-ready and show honest empty states.

## Key behaviors
- **Benchmark precompute** (`market_benchmarks`): per **district × canonical property type × bedrooms bucket × source_type**, the median + P10/P25/P75/P90 of price and **price/m²**, median area, sample/dedup counts, and a confidence grade. `source_type` ∈ `asking` (market listings) | `our_verified` (our units) | `transaction` (reserved). Property type is collapsed from 326 noisy Arabic strings to a stable canon (`wassell_canon_property_type`, mirrored in `src/lib/market/propertyType.ts`). Refreshed by `wassell_refresh_market_benchmarks()` (SECURITY DEFINER, counts all rows; ~1,500 segments in ~2s).
- **Dedup**: a deterministic fingerprint (district|type|price|area|bedrooms|rounded coords) collapses re-listed ads; `duplicate_ratio` lowers confidence.
- **Demand × supply** (`market_demand_supply_benchmarks`): active-client demand (from each open lead's `location.district[]` ∪ `preferred_projects`' districts, × canon `preferred_unit_type`, × budget bucket) crossed with market / our / catalog supply, yielding `undersupply_score`, `sales_priority_score`, `acquisition_priority_score`. **Demand data is thin today** — confidence grades + UI caveats say so.
- **Page** (`/market-intelligence`, admin/manager by default via `CUSTOM_PAGES`): Overview cards + confidence summary; **Benchmarks** (filterable, paginated table → district drawer); **Demand × Supply** table; **Opportunities** (Sales push / Acquisition / Pricing watch / Thin-market queues); **Our Pricing** (our_verified vs asking median, with PDF export). A loud caveat strip sits above every tab.
- **District drawer**: asking market by type, our inventory here, our demand here, best-value listings (≤P25 on a confident benchmark, marked *verify before offering*), and a one-click branded **market snapshot PDF**.
- **Best-value listings**: deterministic — only surfaced when the segment's benchmark is medium/high confidence; price/m² below P25 (or P10 when high confidence); always flagged external + verify.
- **Project Finder deal badges**: each finder card gets a non-ranking `deal` badge — `strong_value` (≤P25, confident, geo-verified, type matches), `fair_market`, `premium_price` (≥P75), `potential_value` (cheap but weak benchmark/geo → verify), `thin_market`, `no_benchmark`, `missing_price`/`missing_area`. Low-confidence benchmarks can never yield "strong value". External/catalog sources keep "verify before offering".
- **Recompute**: admin-only (`/api/market-intelligence` action `recompute`, server-side `wassell_is_admin` check + service-role refresh). The refresh functions are revoked from `public`.

## User flows
1. **Manager opens Market Intelligence** → Overview cards (active listings, districts, demand, confidence split, supply gaps, high-opportunity districts) → Benchmarks tab, filters by city/type/bedrooms/source/confidence → clicks a district → drawer with price bands, our inventory/demand, best-value listings → downloads a branded PDF snapshot.
2. **Acquisition decision** → Opportunities → Acquisition queue (demand, no Wassel supply, market proves supply exists) ranked by priority.
3. **Pricing our project** → Our Pricing tab → our /m² vs market median + P25–P75, position (below/fair/premium), client demand → Export PDF.
4. **Salesperson in a follow-up** → Suggested Projects modal → each card shows a deal-quality badge (e.g. "Strong value −18%") grounded in the district benchmark.

## Data touched
- **Reads:** `records` (market_listings, units, our_projects, all_projects, clients), frozen `public.districts` (names/city), `market_benchmarks`, `market_demand_supply_benchmarks`.
- **Writes:** only the two benchmark tables, and only via the SECURITY DEFINER refresh functions. No client/listing/project data is ever mutated. PDFs are generated client-side (jsPDF) — nothing persisted.

## Key files
- SQL: `supabase/migrations/2026-06-29_market_intel_benchmarks.sql` (canon fn + `market_benchmarks` + refresh), `2026-06-29_market_intel_demand_supply.sql` (budget-bucket fn + `market_demand_supply_benchmarks` + refresh), `2026-06-29_market_intel_admin_guard.sql` (refresh→service-role only).
- API: `api/market-intelligence.ts` (action dispatch: overview/filters/benchmarks/district/demand_supply/opportunities/best_value/client_report/pricing_report/recompute), `api/_lib/marketBadge.ts` (post-ranking finder badge enrichment).
- Shared pure libs (SPA + API, tested): `src/lib/market/{propertyType,format,types,dealBadge,client}.ts`.
- SPA page: `src/pages/MarketIntelligence/MarketIntelligencePage.tsx` + `components/{shared,BenchmarkTab,DemandSupplyTab,OpportunitiesTab,PricingTab,DistrictDrawer}.tsx` + `reports/{marketSnapshotPdf,pricingReportPdf}.ts`.
- Finder integration: `api/_lib/projectFinder.ts` (+`deal` field), `api/project-finder.ts` (enrich step), `src/lib/matching/projectFinder.ts`, `src/pages/Followups/components/FinderCard.tsx`.
- Registration: `src/lib/customPages.ts` (`market_intelligence`), `src/App.tsx` route.
- Tests: `src/lib/market/{propertyType,dealBadge,format}.test.ts`.

## Limitations / follow-ups
- **Asking-only**: no transaction/sold prices yet. Schema + UI are transaction-ready; connecting a feed (e.g. Paseetah) lights up `asking_transaction_gap_pct` and a transaction source filter automatically.
- **Single snapshot**: `market_listings` is a ~2-day scrape, so no trends/days-on-market yet. `snapshot_date` is stored per refresh so accumulating snapshots over time unlocks trend widgets later.
- **Thin demand data**: few clients have structured prefs today; demand×supply leans on `preferred_projects`. Treated as a signal with explicit confidence/caveats.
- **Refresh cadence**: recompute is admin-triggered (button). pg_cron is disabled on prod; a Fly-worker tick could automate it later (same pattern as the other queues).
- **Finder badge district match** is by district name (+canon type) against the benchmark; within a city this is unambiguous.
