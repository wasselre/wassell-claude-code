# Adapter playbook — building the adapter for a new platform

_Last updated: 2026-08-19_

How to build the **adapter** stage (stage 2) for any new real-estate portal. The
adapter's one job: **match the raw fields the extractor produced to CRM fields,
apply field rules, and write them to `market_listings` through the frozen
write-path.** It never alters the source (that's extraction's raw) and never
computes derived values (that's the app/DB).

Read the [master plan](./README.md) and the
[extraction-playbook](./extraction-playbook.md) first.

---

## 0. The prime directive

> **The adapter is the MATCHING layer. It places raw values into CRM fields and
> applies field rules — nothing more.**

Two boundaries define it, one on each side:

- **It does not alter the source.** The raw values arrive verbatim from extraction;
  the adapter's transforms are *matching* decisions (which column, `0`→`null`), not
  "cleaning" the source. The evidence stays the source of truth.
- **It does not compute derived values.** `price_per_m2`, `*_count`,
  `basic_info_*`, quality signals, project rollups — all owned by DB triggers. The
  adapter must not set them; if it does, it drifts from the one server-side
  implementation and the DB overwrites it anyway.

The three-way split, memorized:

| Layer | Owns | Example |
|-------|------|---------|
| **Extraction** | raw capture | `price: 0` stored as `0` |
| **Adapter** | matching + field rules | `0`→`null` (0 in a basic field = "not specified") |
| **App (DB triggers)** | derived values | `price_per_m2 = round(price/area)` |

---

## 1. The field rules

1. **`0` in a basic/count field = "not specified" → `null`, never `0`.** Price, area,
   bedrooms, bathrooms, living_rooms, floors, etc. In JS: `num(x) || null` maps both
   `0` and `null` to `null`; a real count is kept. (This is the explicit operator
   rule: "the adapter when it sees 0 in a basic field it should not fill the field
   and not make it 0.")
2. **Never set a derived value.** No `price_per_m2`, no `feature_count`, no
   `description_*_count`, no `basic_info_*`, no `quality_*`. Comment each omission so
   the next author doesn't "helpfully" add it back.
3. **Matching is DECISION-DRIVEN, not assumed.** A portal field maps to a CRM column
   because a human ruled `mapped_existing_field` in the cockpit
   (`source_field_mappings`), not because the adapter guessed. Consume the rulings:
   - `mapped_existing_field` → write to `canonical_field`.
   - `reviewed_source_specific` → keep verbatim in `scraped_extras` (tagged
     `source_section:'platform_specific'`, keyed by source path). See
     `aqar-scraper/src/decisions.ts` + the `rsc.ts` sweep.
   - `intentionally_ignored` / `technical_excluded` → **drop** (never carried onto
     the row; survives only as raw evidence).
   - `candidate_new_field` → held as "pending column" until promoted via a migration
     (Phase 3).
   - `review_required` / undecided → left out of the mapped columns; the cockpit
     queue surfaces it.
4. **Identity is `source + external_id`, never the bare ad id.** Build the existence
   map keyed on `extKey(source, external_id)` (e.g. `aqar:6612093`). A bare integer
   id collides across portals and silently PATCHes one listing with another's data.
5. **Preserve enrichment.** Fields filled out-of-band (deed number from bulkFetch,
   verified phone from the REGA worker, `property_split`, `image_mirror_map`,
   `video_mp4_map`, `original_image_urls`) are NEVER emitted by the adapter and NEVER
   overwritten by it. The merge path's `strip_nulls` (below) protects the ones the
   adapter *does* emit but may not have a value for.

---

## 2. The write path — `market_listings` is FROZEN (read this twice)

`market_listings` was frozen 2026-08-07: it lives in its own physical table, **not**
in `records`. This changes every write. Getting it wrong is how the ingest went dark
for 12 days (see memory `reference_frozen_merge_retired_broke_ingest`). The rules:

- **Read existing rows from the physical table**, keyset-paginated:
  ```
  GET market_listings?select=id,external_id,source&id=gt.<last>&order=id.asc&limit=1000
  ```
  Loop on `id > last`. **Do NOT** read `records` for it (returns 0 → every listing
  looks new → blocked inserts). **Do NOT** use Range/offset pagination without an
  `ORDER BY` — it silently skips rows over many pages (pulled 195,801 of 314,080 →
  would re-insert ~118k duplicates) and is O(n²) slow. Keyset is complete and O(n).
- **Insert new listings via the `record_save` dispatcher**, one row per call:
  ```
  POST /rpc/record_save { p_model_id, p_id: <uuid>, p_data, p_created_by: null, p_expected_version: null }
  ```
  `record_save` routes frozen models to `freeze_apply_row` (maps the jsonb to
  physical columns + junctions). **Do NOT** `POST /records` for a frozen model — the
  `records_block_frozen_writes` trigger rejects it.
- **Update existing listings via `market_listing_merge`**, which merges without
  wiping enrichment:
  ```
  POST /rpc/market_listing_merge { p_id, p_patch }
  ```
  It locks the row, reads the current jsonb from `market_listings_v`, applies
  `data || jsonb_strip_nulls(patch)`, and routes through `record_save`.
  **`strip_nulls` is load-bearing:** the adapter emits `deed_number` /
  `advertiser_phone` as `null` when it has none, but those are enriched out-of-band —
  stripping nulls stops a null from overwriting an enriched value, and any key the
  patch omits is preserved by `||`. A raw `record_save` (full REPLACE) would wipe
  every enrichment column.
- **Retry transient failures.** A 314-page pull can't abort on one reset; wrap page
  fetches in a bounded retry (`getJson` in `crmClient.ts`).

Reference: `aqar-scraper/src/sync/crmClient.ts` — `build()` (matching),
`loadMaps()` (keyset read), `insert()` (record_save), `patch()` (merge),
`getJson()` (retry). Frozen infra: CLAUDE.md "Frozen models".

---

## 3. Step-by-step: onboard a new portal's adapter

1. **Get the fields ruled.** The extractor already fed `source_field_catalog`; the
   operator rules each field in the cockpit. The adapter reads
   `source_field_mappings` for its `platform` to know each field's disposition.
2. **Write `build(rawRow) → record`.** Emit **only**:
   - the columns the rulings mapped (`mapped_existing_field` → `canonical_field`),
     with the `0`→`null` rule applied to basic/count fields;
   - `scraped_extras` carrying the `reviewed_source_specific` fields (tagged
     `platform_specific`) — this may live in the extractor sweep (Aqar does) or the
     adapter, but it must be decision-driven;
   - identity (`external_id`, `source`) + the geography/location shape the model
     expects.
   Emit **nothing** derived, and **nothing** for `intentionally_ignored` /
   `technical_excluded` / `candidate_new_field` (pending) / enrichment.
3. **Wire `loadMaps()`** to keyset-read the frozen table (§2) and build
   `crmIdByExt` keyed on `extKey(source, external_id)`.
4. **Wire `insert()`** → `record_save` per row; **`patch()`** → `market_listing_merge`.
5. **Verify the whole write path against prod** with a realistic payload (features +
   images + coords) — not just a minimal row. The minimal-row test passes even when a
   junction/queue FK is broken (see §5). Confirm: the row lands, junctions populate,
   the mirror job enqueues, derived columns recompute, and enrichment survives a
   null-bearing merge.

---

## 4. Rules checklist (paste into the PR)

- [ ] `0` in a basic/count field → `null` (`num(x) || null`), never `0`.
- [ ] **No** derived values set (`price_per_m2`, `*_count`, `basic_info_*`, `quality_*`).
- [ ] Matching is driven by `source_field_mappings`, not hardcoded guesses.
- [ ] `reviewed_source_specific` kept in `scraped_extras`; ignored/technical dropped.
- [ ] Identity keyed on `extKey(source, external_id)`, never the bare id.
- [ ] Reads existing rows from the **physical `market_listings`**, **keyset**-paginated.
- [ ] Inserts via **`record_save`**; updates via **`market_listing_merge`** (never `POST /records`).
- [ ] Enrichment fields never emitted and never overwritten; `strip_nulls` verified.
- [ ] Page fetches retried; a single reset can't abort the pull.
- [ ] End-to-end tested against prod with a **realistic** payload (features + images + coords).

---

## 5. Anti-patterns (the four freeze bugs — do not repeat)

All four broke the Aqar ingest for 12 days once `market_listings` froze. They are the
canonical "what goes wrong writing to a frozen model."

1. **Reading `records` for a frozen model.** `loadMaps` queried `records` → 0 rows →
   every listing looked new → routed to a blocked insert. **Fix:** read the physical
   table.
2. **Offset pagination without `ORDER BY`.** Silently pulled 62% of rows → would
   re-insert ~118k duplicates. **Fix:** keyset (`id > last order by id`).
3. **Writing new rows to `records` + calling a retired merge.** `POST /records` is
   blocked; the old `market_listing_merge` was rewritten to `RAISE`. **Fix:**
   `record_save` for inserts, rebuilt frozen-aware `market_listing_merge` for updates.
4. **A polymorphic queue FK to `records`.** `generation_jobs.record_id` FK →
   `records`, but listing-mirror jobs reference the frozen table (ids not in
   `records`) → every insert-with-images failed `23503`. **Fix:** drop the FK (a
   polymorphic queue can't enforce a single-table FK).

Two more to avoid:
- **Full-replace on update** (`record_save` with the scraper's data instead of a
  merge) — wipes deed/phone/mirror-maps/property_split. Always merge with `strip_nulls`.
- **Testing inserts with a minimal payload only.** A minimal row skips the
  features/image/coords code paths and passes even when a junction or queue FK is
  broken. Always test with the realistic shape.

**Meta-lesson:** freezing a model moves its ids OUT of `records`, so *every* object
still keyed on `records` for that model breaks — writers, RPCs, AND polymorphic FKs.
When onboarding a portal onto the frozen table, audit all three.

---

## 6. Reconcile after a fix

The scraper's push marker (`/data/crm_push_marker.txt` on the Fly volume) advances
even past *failed* pushes, so after fixing a write bug you must reset it to the gap
start and re-run — otherwise the missed changes are never retried:

```
# on the machine
printf '<gap-start ISO>' > /data/crm_push_marker.txt
```

Then start the machine; `pushToCrm` re-processes everything since the marker.
Verify with the DB (rows created/updated in the window) and the run's
`[push] DONE inserted= updated= failed=` line (failed should be 0).

---

## 7. Interfaces this stage respects

- **Up from extraction:** a raw field set keyed by the portal's own names + the
  catalog rows. The adapter maps; it must not require pre-shaping.
- **From Gate A:** `source_field_mappings` (the rulings) — the adapter's matching
  authority.
- **Down to the app:** the physical `market_listings` row; DB triggers then compute
  all derived values and rollups.
- **Never** writes derived values, never writes to `records`, never bypasses the gate
  to promote a `candidate_new_field` (that's a repo-side migration + the publisher).
