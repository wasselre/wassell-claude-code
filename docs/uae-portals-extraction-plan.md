# UAE Portals Listing Extraction — Plan (Bayut · Dubizzle · Property Finder)

**Status:** Draft plan · **Date:** 2026-08-05 · **Scope:** UAE, *for-sale*, *residential*, **every field**, all three portals, with cross-platform de-duplication.

This mirrors the existing Aqar pipeline (`aqar-scraper` → Fly + Browserbase → `market_listings` via `market_listing_merge`). Where Aqar needed LLM extraction from HTML, two of these three portals hand us **complete structured JSON**, so this is simpler and higher-fidelity.

---

## 0. Live reconnaissance (already done)

Verified live on 2026-08-05 through a **UAE-geolocated Browserbase session** (datacenter IPs are bot-walled on all three — same ASN-block lesson as Aqar's Cloudflare).

| Portal | Data source | Auth | For-sale residential pool | Detail fetch needed? |
|---|---|---|---|---|
| **Bayut** | Algolia via proxy `search-dsn.bayut.com/1/indexes/*/queries` | proxy-scoped key `strat_a5e4568c`, app `LL8IZ711CS`, index `bayut-production-ads-*-en`. Requires UAE IP + browser session cookie (must run inside the page context). | ~117k | **Yes** — description, permit, full photos, floor plans are detail-only |
| **Dubizzle** | Algolia direct `wd0ptz13zs-dsn.algolia.net/1/indexes/*/queries` | real Algolia key `cdd839b4fdac840289e88633779e8634`, app `WD0PTZ13ZS`, index `property-for-sale-residential.com`, filter `("categories_v2.slug_paths":"property-for-sale/residential")`. **Works from plain Node** (no browser). | ~286k (all UAE, incl. off-plan units) | **No** — index carries the whole listing |
| **Property Finder** | SSR Next.js — `__NEXT_DATA__.props.pageProps.searchResult.listings[]` on each `/en/search` page | none (public HTML), needs UAE IP via Browserbase | ~124k | **Optional** — SERP carries 139 fields; detail adds full-res media + DLD txn history |

> Credentials/indices are embedded in each site's own frontend and **will rotate**. The scanner must re-discover them each run by capturing the live request (as the recon script does), never hard-code them.

---

## 1. Guarantee: *every field, every listing*

We do **not** try to enumerate a fixed column list and risk dropping fields. Two-layer capture:

1. **`source_payload jsonb`** — the **complete raw source object**, stored verbatim per listing. This is the contractual "every field" guarantee: if the portal has it, we keep it, including fields we don't yet understand. (Dubizzle: drop the `_highlightResult` search-metadata sub-tree — it's Algolia noise, not listing data.)
2. **Typed/normalized columns** — the cross-portal common set (below) promoted to real columns for querying, matching, and the CRM UI. Everything else stays reachable in `source_payload`.

### Field inventory captured (raw) per portal

- **Bayut — 86 index fields + detail:** `externalID, price, purpose, type, rooms, baths, area, plotArea, geography{lat,lng}, location[]{name,name_l1,slug,level}, category[]{…bilingual}, coverPhoto, photoIDs[], photoCount, videoCount, panoramaCount, furnishingStatus, completionStatus/completionDetails, offplanDetails, paymentPlanSummaries[], project{…}, agency{name,licenses[]{authority,number},…}, ownerAgent{…}, contactName, phoneNumber{mobile,whatsapp,proxyMobile,phoneNumbers[]}, contactMethodAvailability, amenities[] (+_l1/_l2/_l3), keywords[], verification{status,trucheckedAt,verifiedAt}, truBrokerScore, extraFields{dldBuildingNK,dldPropertySK,hasSaleTransactions}, referenceNumber, createdAt/updatedAt/reactivatedAt, hidePrice, state, hash, title(+_l1..l8)`. **Detail-only (fetch):** full `description`, complete `amenities`, **`permitNumber`** (`GET /api/listing/<id>/permitNumber`), full-res gallery URLs (derivable from `photoIDs` → `https://images.bayut.com/thumbnails/<id>-800x600.jpeg`), floor plans (`/api/floorPlans`), DLD transactions (`/api/transactions`).
- **Dubizzle — 93 index fields (complete):** `external_id, uuid, id, name{en,ar}, description{en,ar}, description_short, price, original_price, size, plot_area, bedrooms, bathrooms, furnished, _geoloc{lat,lng}` **(NOTE: lat/lng are stored SWAPPED)**, `location_path{en,ar}{lvl0..5}, neighborhoods{ids,name{en,ar}}, building{id,name{en,ar}}, city{id,name{en,ar}}, places, landmarks, category_v2{names_en,names_ar,slug_paths,ids}, sale_type, completion_status/percentage, handover_date/year, payment_plan/pre_handover_payment, project_id/project_developer_name, photos[]{main,thumb}, photos_count, video_url, tour_url/tour_360, amenities_v2[]{en,ar,id,value}, property_info[]{label{en,ar},value{en,ar}}` (permit no., TruCheck, etc.), `property_reference, agent{id,name{en,ar},logo,slug}, agent_profile{…,is_emirati_agent}, listed_by, agency_tier, is_verified/verification_state/trucheck_verified_at, has_whatsapp_number/has_sms_number, has_dld_history, absolute_url{en,ar}, short_url, added, annual_community_fee, total_closing_fee, cash_needed, site{id,name}`.
- **Property Finder — 139 SERP fields (near-complete):** `id, listing_id, reference, rera` (permit), `title, description, property_type(+_id), category_id, offering_type, price{value,currency,period,is_hidden}, price_per_area{price,unit}, size{value,unit}, bedrooms(+_value), bathrooms(+_value), furnished, completion_status, is_new_construction, location{id,name,full_name,path,path_name,slug,type,coordinates{lat,lon}}, location_tree[], amenities[], amenity_names[], images[]{small,medium,classification_label}, images_count, floor_plans[], video_url, view_360/has_view_360, listed_date, agent{id,name,email,slug,image,languages[],is_super_agent}, broker{id,name,email,phone,address,logo,slug}, client{…developer…,phone}, contact_options[]{type,value,link,is_did}, share_url, details_path, is_verified/is_exclusive/is_featured/…(20+ badge flags), lead_value, listing_level`. **Detail-only (optional):** full-res images, `amenitiesGrouped`, DLD `propertyTransactions`, `priceTrendsData`.

### Normalized common columns (promoted from raw)

`source` · `external_id` · `source_url` · `listing_type='sale'` · `category='residential'` · `property_type` (→ shared taxonomy) · `title` / `title_ar` · `description` / `description_ar` · `price` · `currency='AED'` · `area_sqm` (converted) · `plot_area_sqm` · `bedrooms` · `bathrooms` · `furnished` · `completion_status` (ready/off-plan) · `latitude` · `longitude` · `emirate` · `city` · `community` · `building` · `location_path` / `location_path_ar` · `permit_number` · `reference_number` · `agent_name` · `agency_name` · `agent_phone` · `agent_whatsapp` · `is_verified` · `image_urls[]` · `image_count` · `video_url` · `listed_at` · `first_seen` · `last_seen` · `is_active` · `scraped_at` · `dupe_group_id` (see §5) · `source_payload jsonb`.

Unit normalization rules: Dubizzle `size` is **sqft → ×0.092903 = sqm**; Bayut/PF `area` already sqm (PF `size.unit` confirms). **Swap Dubizzle `_geoloc` lat/lng.** Map each portal's `property_type` into one taxonomy (Apartment, Villa, Townhouse, Penthouse, Duplex, Floor, Plot/Land, Building, Compound, Hotel Apartment).

---

## 2. Storage / data model

Extend the existing `market_listings` model (unfrozen JSONB in `records`), don't create a new one — the CRM UI, `market_listing_merge`, and the photo-mirror pipeline already work against it.

- Add `source` options: `bayut`, `dubizzle`, `propertyfinder` (alongside `aqar`).
- Add fields listed in §1 (typed columns) + `source_payload` (raw) + `dupe_group_id` + `dupe_role` (`canonical`/`duplicate`).
- Identity: **`source:external_id`** (same convention as Aqar — the scraper warns bare ids collide across portals). Re-scan is idempotent via `market_listing_merge` (`data = data || jsonb_strip_nulls(patch)`), which preserves enrichment-owned keys (permit, mirror map, dedup fields).
- Reads: the auto-generated `v_market_listings` view + the summary fast-path already handle new columns.

---

## 3. Extraction architecture

New repo/app per the Aqar template: a **Fly worker** driving **Browserbase (UAE geolocation)**, with a SQLite durable mirror + delta push to the CRM via `market_listing_merge`. One codebase, a **source adapter** per portal.

Per-source fetchers:

- **Dubizzle (simplest):** direct Algolia POST from Node (no browser). Loop pages; `hitsPerPage=50`.
- **Bayut:** open a residential-for-sale page in the Browserbase page context (to hold the clearance cookie + re-capture the live proxy key), then replay the Algolia query via in-page `fetch(..., {credentials:'include'})` across pages. Then a **detail pass** per new/changed listing (description, permit via `/api/listing/<id>/permitNumber`, gallery, floor plans).
- **Property Finder:** Browserbase page-fetch of each `/en/search?...&page=N`, parse `__NEXT_DATA__…searchResult.listings`. `meta.total_count/page_count` drive pagination. Optional detail pass for full-res media + DLD transactions.

### Beating the result-window caps (critical for completeness)

Algolia returns only the **first ~1,000 hits per query** (Bayut/Dubizzle); PF caps page depth similarly. To get **all** ~117k/286k/124k we **shard** so every shard < 1,000 hits — exactly how Aqar shards areas < 1,500:

1. Shard by **emirate** (Dubai, Abu Dhabi, Sharjah, Ajman, RAK, UAQ, Fujairah) → by **community/tower** facet.
2. If a shard still > ~1,000, sub-shard by **price band** and/or **bedrooms**.
3. Recurse until each leaf < the cap; page through the leaf; union. Log any shard that hits the cap (never silently truncate — repo rule).

Facets exist on every portal: Bayut `location.lvlN` + `price` + `rooms`; Dubizzle `location_path.lvlN` + `price` + `bedrooms`; PF `filter[locations_ids]` + `filter[min/max_price]` + `filter[number_of_bedrooms]`.

### Scheduling (same cadence as Aqar)

- **Daily** cheap pass: newest-first shards, capture new/changed listings, refresh `last_seen`.
- **Weekly reconcile**: full shard walk + sold/removed detection (listing absent from its shard for N runs → `is_active=false`, `sold_at`).
- Fly scheduled machine, `MODE=dailysync`, `RECONCILE_DOW`.

---

## 4. Photo mirror (own the bytes)

Reuse the `listing-photos` bucket + `listing-mirror` `generation_jobs` lane. Image CDNs (`images.bayut.com`, `dbz-images.dubizzle.com`, `static.propertyfinder.ae`) **block non-UAE IPs** (confirmed: they time out from our egress), so mirroring **must go through the UAE proxy** — same posture and code path as the Aqar mirror (`aqarFetch` → me-central1 imgproxy fallback). Store `image_mirror_map` keyed by source URL; partial success = success; a missing mirror degrades, never fails.

---

## 5. Cross-platform de-duplication (the core new work)

Three levels of duplication exist:
- **(a) within a portal** — the same broker re-posts, or the tool re-scans → handled by `source:external_id` identity.
- **(b) same ad, cross-posted** — one broker lists the same unit on Bayut + Dubizzle + PF (the dominant case; the portals are cross-posting targets).
- **(c) same physical unit, different brokers/portals** — different photos/text/permit, same real unit.

We assign every listing a **`dupe_group_id`** (a canonical *property/unit* cluster) via a deterministic-first, layered matcher, and expose "unique properties" vs "all ads".

### Tier 0 — Permit / RERA number (exact, catches most of case b)

Every legal UAE listing carries a regulator permit: Bayut `permitNumber`, PF `rera`, Dubizzle `property_info[label≈"Permit"/"RERA"]` (+ `has_dld_history`). Normalize (uppercase, strip spaces/dashes) → `permit_key`. **Listings sharing a `permit_key` are the same advertised unit** → same `dupe_group_id`. This nails the cross-post case cheaply and exactly. (Scope by emirate — permit schemes differ Dubai/AD/Sharjah — to avoid rare numeric collisions.)

### Tier 1 — Structural fingerprint (strong heuristic, catches case c and permit-less)

For listings without a shared permit, compute
`fp = (emirate, building_or_tower_key, property_type_norm, bedrooms, bathrooms, round(area_sqm/5), round(price, 1%))`
plus a **geo bucket** (coordinates snapped to ~50 m; all three expose tower/building + community, which align across portals). Same `fp` (and geo bucket) → **candidate** cluster.

### Tier 2 — Media / text confirmation (disambiguates Tier-1 candidates)

Two different units in one tower can share `(beds, baths, size)`, so confirm a candidate before merging:
- **Perceptual image hash:** dHash/pHash of mirrored cover + first N gallery photos; cross-platform Hamming distance ≤ ~6 on any pair ⇒ same unit (brokers reuse photos across portals). Store hashes on the listing.
- **Description shingling:** normalized text (fold case/whitespace, strip boilerplate), 5-gram MinHash signature + LSH; Jaccard ≥ ~0.6 ⇒ same ad. Cheap, catches copy-paste cross-posts even when permit is absent.

Merge a Tier-1 candidate into a cluster only if Tier-2 (image **or** text) confirms; otherwise keep separate. This ordering — **exact permit → structural candidate → media/text confirm** — is the same "deterministic-first, verify before merge" discipline as the Aqar property-key + REGA work.

### Cluster + canonical selection

- `dupe_group_id` = the cluster id (permit_key when present, else a stable hash of the confirmed cluster's members).
- Pick a **canonical** ad per cluster (`dupe_role='canonical'`): prefer verified > most photos > most complete fields > most recently listed. Others = `duplicate`, still fully stored (all fields, all sources retained).
- Expose two SQL views: `v_market_properties` (one canonical row per `dupe_group_id`, with a `sources[]` array showing which portals + prices carry it) and the existing all-ads view. The CRM "unique inventory" count reads the former; nothing is deleted.
- Clustering runs incrementally after each scan (only new/changed listings are matched against existing clusters) — a DB function + a worker lane, not a full re-scan.

### Why this is robust

- Case (b) — the bulk — is solved **exactly** by permit_key (Tier 0), no fuzzy risk.
- Case (c) needs fuzzy matching, but only *within* a tight structural+geo candidate set, and only merges on image/text proof — keeping false-merges low.
- Every raw listing is preserved; dedup is an *overlay* (`dupe_group_id`), never a delete — reversible if a rule proves wrong (the repo's silent-failure/observable-truncation rules apply: log every cap hit and every auto-merge).

---

## 6. Volumes & effort

| Portal | Pool | Fetch | Detail pass | Shards (est.) |
|---|---|---|---|---|
| Dubizzle | ~286k | Node direct | none | emirate × community × price |
| Bayut | ~117k | Browserbase (page ctx) | yes (desc/permit/photos) | emirate × community (× price) |
| Property Finder | ~124k | Browserbase (SERP JSON) | optional | emirate × community × price |

Full first crawl is the heavy run (shard-walk + Bayut/PF detail passes + photo mirror through the UAE proxy — the proxy is the throughput bottleneck, shared with the WhatsApp gateway, so it's throttled/resumable like the Aqar backfill). Daily deltas are cheap.

## 7. Phasing

1. **Model + storage:** add sources, typed columns, `source_payload`, `dupe_group_id`; extend `market_listing_merge`/summary view.
2. **Dubizzle source** (Node-direct, complete index) end-to-end into `market_listings` — fastest proof.
3. **Bayut source** (Algolia replay + detail pass + permit endpoint).
4. **Property Finder source** (SERP `__NEXT_DATA__`, optional detail).
5. **Photo mirror** wired for the three CDNs via the UAE proxy.
6. **Dedup engine:** Tier 0 permit → Tier 1 fingerprint → Tier 2 image/text; cluster + canonical + `v_market_properties`.
7. **Schedule** daily + weekly reconcile on Fly; sold/removed detection.

## 8. Risks & mitigations

- **Key/index/buildId rotation** → re-discover the live request every run; never hard-code (recon script already does this).
- **Bot walls / IP** → UAE Browserbase for Bayut/PF + all photo fetches; Dubizzle direct works today but front it the same way if it starts blocking.
- **Result-window caps** → recursive facet sharding + **log every shard that hits the cap** (no silent truncation).
- **ToS / rate** → public listing data, but throttle politely, reuse sessions, cache detail passes (only new/changed).
- **Dedup false-merge** → deterministic permit-first; fuzzy merges require image/text proof; all merges reversible + logged; raw always retained.
