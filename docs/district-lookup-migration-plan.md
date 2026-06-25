# District / Neighborhood Lookup Migration — Affected-Model Analysis & Plan

> **Status: ANALYSIS / PROPOSAL — awaiting final go-ahead. No schema changes or migrations have been run.**
> Author: Claude (analysis session) · Date: 2026-06-25 · Source of truth: live `wassell-prod` DB + repo code (not seedModels/PRDs).
>
> **Decisions confirmed by the user (2026-06-25):**
> 1. **`units.district` → mirror from the unit's project** (no independent unit district; drop the standalone dropdown after cutover).
> 2. **Expand the districts model to other cities FIRST** (relational matching for all projects on day one — adds a data-sourcing prerequisite, Phase 0 below).
> 3. **Dual-read transition** for the engine (lookup-primary with legacy-text fallback; reverting is a one-line flip).

---

## 0. Executive summary — the situation is much further along than the brief assumes

Two things the brief treats as "to be built" **already exist in production**:

1. **The `Districts` model is already built and fully populated.**
   - Model `districts` (`d9a9db7e-…`), **189 records**, all 189 carrying both `center_lat`/`center_lng` **and** `boundary_geojson`.
   - Fields: `district_id` (auto-id `DIS-####`), `name_ar`, `name_en`, `city`, `municipality`, `region`, `precise_location`, `center_lat`, `center_lng`, `boundary_geojson`.
   - **It is completely dormant: no lookup field anywhere points to it, and no line of `src/**` or `api/**` reads it.** It is a reference table waiting to be wired.

2. **The Project Matching Assistant already exists and is sophisticated.**
   - Model `matching_chats` ("Sales Assistant", `7c0ffee2-…`), page `src/pages/Matching/`, engine `api/_lib/matchAgent.ts` + endpoint `api/match.ts`.
   - It already does geo-aware, weighted, multi-tier scoring (exact district → nearby-by-distance → same-city), with haversine distance and a `requires_verification` flag for `all_projects` (Tier-2) picks.
   - **But it matches on TEXT** (`all_projects.preferred_neighborhoods`) plus **coordinates stored on `all_projects`** (`latitude`/`longitude`), not on the `districts` model. The coordinates were backfilled in `supabase/migrations/2026-06-21_project_geo.sql` by (a) parsing map links and (b) cascading a **district centroid computed by averaging project coords per district** — i.e. it reinvents centroids the `districts` model already has authoritatively.

**Therefore the real task is not "introduce a districts model + matching engine." It is "wire the existing districts model into the existing project/client schema and upgrade the existing engine to read authoritative district geo (centroid + GeoJSON) instead of the per-project averaged centroid."** That is a smaller, lower-risk change than the brief envisions.

### Two big de-risking facts
- **Zero workflows and zero dashboards reference any district/neighborhood/city field.** (Verified by scanning every `workflows` row's conditions/actions/branches/metadata and every `dashboards` row's widgets/filters.) Step 7 of the brief's migration plan ("update workflows/automations") is **empty** — there is nothing to update.
- **Client-side district preference is nearly unused: only 17 of 458 clients** have any `preferred_neighborhoods` value. The `clients` "Preferred Districts" lookup is effectively greenfield — almost nothing to migrate, so we can make it a clean lookup from day one.

---

## A. All district/neighborhood-related fields (live DB)

| Model | Field (slug) | Label (EN / AR) | Type | Role | Populated | Notes |
|---|---|---|---|---|---|---|
| **districts** | `name_ar`, `name_en` | Name | text (required) | reference name | 189 | The authoritative names. |
| districts | `city` | "Region" / المدينة | text | reference | 189 | ⚠️ **`label_en` is wrongly "Region"** (collides with `region`); `label_ar`=المدينة. Cleanup candidate. |
| districts | `municipality`, `region`, `precise_location` | — | text | reference | — | Hierarchy metadata. |
| districts | `center_lat`, `center_lng` | Centroid | number | **geo source** | 189 | Authoritative centroid. |
| districts | `boundary_geojson` | Boundary (GeoJSON) | textarea | **geo source** | 189 | Authoritative polygon — currently unused by any code. |
| **all_projects** | `preferred_neighborhoods` | Preferred Neighborhoods / الحي | **dropdown (single)** | **legacy district** | **913 / 1064** | The field the engine matches on today. Misnamed (plural slug, single value). |
| all_projects | `preferred_city` | Preferred City / المدينة | dropdown | legacy city | — | Engine secondary match. |
| all_projects | `latitude`, `longitude` | — | number | geo | **581 / 1064** | Backfilled by `2026-06-21_project_geo.sql`. |
| all_projects | `geo_source`, `geo_confidence` | — | dropdown | geo provenance | — | `inline_link` / `district_centroid` / `manual`; high/medium/low. |
| all_projects | `project_location` | Project Location | url | map link | 607 / 1064 | Google Maps URL; lat/lng parsed from it. |
| **units** | `district` | District / الحي | **dropdown** | **independent district** | **925 / 943** | ⚠️ **Separate dropdown from all_projects**, ~160 options incl. messy `حي X`-prefixed duplicates. Not derived from the unit's project. |
| units | `city` | City | dropdown | independent city | — | |
| units | `location_url` | Location URL | mirror | — | — | Mirrors `all_projects.project_location` via the unit's `project_id`. |
| **clients** | `preferred_neighborhoods` | Preferred Neighborhoods / الأحياء المفضلة | **multiselect** | **client district pref** | **17 / 458** | Greenfield in practice. |
| clients | `preferred_city` | المدينة المفضلة | multiselect | client city pref | — | |
| clients | `preferred_area` | المساحة المفضلة | range | area pref | — | Not a district field; listed for completeness. |
| **marketing_operations** | `mirror_district` / `mirror_city` | الحي / المدينة | mirror | display | — | Mirror `all_projects.preferred_neighborhoods` / `preferred_city` via its `project` lookup. |
| **real_estate_offices** | `district`, `city`, `region` | — | text | office directory | — | Competitor-office address; **unrelated to project matching** — out of scope. |
| **project_details / site_settings** | `pd_map_*`, `about_card_city` | "Map Section Headline" etc. | text | **page copy** | — | UI label strings for the public website, **not location data** — out of scope. |

---

## B. Mirror fields (how the mirror mechanism works here)

Mirror config keys in this codebase: a `mirror` field uses **`mirror_target_field_name`** (the source slug on the looked-up model) + **`mirror_via_lookup_field_id`** (the lookup field on *this* model that resolves the source record). A `section_mirror` uses **`section_mirror_source_section_id`** + **`section_mirror_via_lookup_field_id`**, plus `section_mirror_field_mode` (`all` = auto-includes new fields added to the source section; `custom` = fixed field list).

| Mirror | On model | Mirrors | Via lookup | Field mode | Auto-picks-up a new district field? |
|---|---|---|---|---|---|
| `geographic_info` (section) | our_projects | all_projects **Geographic Information** section (`9e8fc144`) | `project`→all_projects | **all** | ✅ **Yes** — add the district lookup to all_projects' Geographic Information section and `our_projects` inherits it automatically. |
| `client_pref` (section) | followups | clients **Client Preferences** section (`84e95d93`) | `client_id`→clients | **all** | ✅ **Yes** — add Preferred Districts to clients' Client Preferences and followups inherits it. |
| `client_preferences` (section) | unanswered_requests | clients Client Preferences (`84e95d93`) | `client_id`→clients | **all** | ✅ Yes (auto). |
| `client_pref` (section) | sales_valuation_reviews | clients Client Preferences (`84e95d93`) | `client`→clients | **all** (sync `none`) | ✅ field appears; value syncs once on create (sync_mode `none`). |
| `mirror_district` | marketing_operations | all_projects `preferred_neighborhoods` | `project`→all_projects | n/a | ❌ point-mirror — must be re-pointed to the new district field deliberately. |
| `mirror_city` | marketing_operations | all_projects `preferred_city` | `project`→all_projects | n/a | ❌ deliberate. |
| `location_url` | units | all_projects `project_location` | `project_id`→all_projects | n/a | unaffected (location URL, not district). |
| `dfghjkl` ("Project Location") | targeted_projects | all_projects `project_location` | `project`→all_projects | n/a | unaffected. Note junk slug. |
| `project_info` (section) | targeted_projects | all_projects **Project Information** section (`fad0a581`) | `project`→all_projects | **custom** | ❌ wrong section + custom mode — won't inherit a district lookup added to the Geographic section. |

**Implication:** adding ONE lookup field to all_projects' Geographic Information section and ONE multi-lookup to clients' Client Preferences section **automatically propagates to `our_projects`, `followups`, `unanswered_requests`, and `sales_valuation_reviews`** (all `field_mode:'all'`). Only `marketing_operations` (and optionally `targeted_projects`) need a deliberate mirror re-point.

---

## C. Lookup chains affected

Project lookups resolve to **two different project models**, which matters for the district chain depth:

- **Direct to `all_projects`** (1 hop to district): `appointments.project_id`, `chat_templates.project_id`, `clients.preferred_projects` (multi), `copywriter_chats.linked_project_id`, `marketing_operations.project`, `our_projects.project`, `project_details.project_id`, `reel_scripts.project`, `targeted_projects.project`, `tasks.project` (multi), `units.project_id`.
- **To `our_projects`** (2 hops: record → our_projects → all_projects → district): `visits.project_id`, `reservations.project_id`, `offer_prices.project_id`, `financing.project_id`, `ownership_transfer.project_id`.

```
units / appointments / marketing_operations / targeted_projects
    → all_projects.district_lookup (NEW)
        → districts (centroid + GeoJSON + metadata)

visits / reservations / offer_prices / financing / ownership_transfer
    → our_projects → all_projects.district_lookup (NEW)
        → districts

clients.preferred_districts (NEW multi-lookup)
    → districts        ⇕  matched against all_projects.district_lookup by the engine
```

There is **no model that links directly to `districts` today** — every chain above is the *target* state.

---

## D. Client-preference fields (detail)

The "Client Preferences" model the brief refers to is a **section on the `clients` model** (`84e95d93`), not a standalone model. It stores:
- `preferred_city` — multiselect (Arabic labels as values)
- `preferred_neighborhoods` — multiselect (Arabic labels), **17/458 populated**
- `preferred_area` — range

These are read for matching context by `src/lib/followups/assistantContext.ts` (builds the assistant preface), `src/lib/salesStudio/assignment.ts` (lead-routing experiment targeting, candidate slugs include `preferred_district`/`neighborhood`), and surfaced in `src/pages/Followups/components/PreferenceSummary.tsx`. They are section-mirrored into `followups`, `unanswered_requests`, `sales_valuation_reviews`.

**Target:** add `preferred_districts` = **multi-lookup → districts** to the Client Preferences section. Keep `preferred_neighborhoods` (multiselect) as a temporary legacy field. Because only 17 clients have data, backfill is trivial.

---

## E. Forms / views / reports likely affected
- **Forms:** all_projects form (new District lookup in Geographic Information), clients form (new Preferred Districts), optionally units form. `our_projects`/`followups`/etc. inherit via section-mirror — no manual form change.
- **Table/card/map views:** `src/pages/Records/components/MapsView.tsx` + `MapsBuilder.tsx` already plot lat/lng; switching the authoritative coord source to `districts.center_lat/lng` improves the ~483 projects currently relying on averaged centroids. Project cards in the matching UI (`ProjectMatchCard.tsx`) show a `district` spec string.
- **Reports/dashboards:** **none** reference district fields (verified). No dashboard work required.

## F. Workflows / automations likely affected
- **None.** No workflow's trigger/conditions/actions/branches reference any district, neighborhood, or city field. Step 7 of the brief is a no-op for the current data. (If a future Matching workflow is added, it should call the engine, per the architecture rule that the workflow engine is the only executor — but nothing exists today.)

## G. Assistant / engine logic affected (this is the real work — code, not schema)
- `api/_lib/matchAgent.ts` — `scoreProject()` reads `preferred_neighborhoods` (text, fuzzy) + project `latitude`/`longitude`; computes nearby tier via haversine to a district centroid. **Upgrade:** resolve the project's district via `district_lookup`, read `districts.center_lat/lng` as the authoritative centroid, and (new capability) use `districts.boundary_geojson` for point-in-polygon validation of a project's own pin.
- `api/match.ts` — endpoint; `get_customer_context` reads client prefs. **Upgrade:** read `preferred_districts` lookup ids, compare by district id (exact) + centroid distance (nearby) instead of fuzzy text.
- `src/lib/locationUtils.ts` — has `haversineKm` + map-link parsing; **add `pointInPolygon(lat,lng,geojson)`** (none today).
- `src/lib/followups/assistantContext.ts`, `src/lib/salesStudio/assignment.ts`, `src/lib/projectMessageFacts.ts`, `src/lib/matching/recommendation.ts` — all read the text slugs by **candidate-slug fallback** already; extend each to also resolve the district lookup. **Keep the text path during transition** (dual-read).
- Tests: `src/lib/__tests__/projectMatchScoring.test.ts`, `matchProjects.integration.test.ts`, `salesAssistant.test.ts` assert against text district values (`'الفاروق'` etc.) — update/extend for lookup-based matching.

---

## Affected-model classification (Type 1 must / Type 2 during / Type 3 later)

| Model | Change | Type | Auto or manual |
|---|---|---|---|
| `districts` | Fix mislabeled `city` field; **optional** `aliases` (text) + `is_active` fields to aid matching | **1** (label fix) / 3 (aliases) | manual |
| `all_projects` | **Add `district_lookup` (lookup→districts, single)** in Geographic Information section; keep `preferred_neighborhoods` as legacy | **1** | manual |
| `clients` | **Add `preferred_districts` (multi-lookup→districts)** in Client Preferences; keep `preferred_neighborhoods` legacy | **1** | manual |
| `units` | **Mirror the project's district** (via `project_id`→all_projects) — decision #1. Drop the standalone `district` dropdown after cutover; no per-unit district backfill | **2** | manual |
| `our_projects` | Inherits district_lookup via `geographic_info` section-mirror | **2** | **auto** |
| `followups`, `unanswered_requests`, `sales_valuation_reviews` | Inherit `preferred_districts` via client-pref section-mirror | **2** | **auto** |
| `marketing_operations` | Re-point `mirror_district` to the new district field (or add `mirror_district_lookup`) | **2** | manual |
| `appointments` | Optional: add a district mirror from its `project_id` if needed for display/matching | **3** | manual |
| `visits`, `reservations`, `offer_prices`, `financing`, `ownership_transfer` | Optional district mirror through `our_projects`; only if a screen needs it | **3** | manual |
| `targeted_projects` | Optional: extend `project_info` mirror or add district; fix junk slug `dfghjkl` | **3** | manual |
| `real_estate_offices`, `project_details`, `site_settings` | Out of scope (office directory / page copy) | — | — |

---

## 6. Lookup vs displayed name — per-model decision

| Surface | Stores | Why |
|---|---|---|
| `all_projects.district_lookup` | **Lookup → districts** (source of truth) | Matching needs the district id + centroid + GeoJSON. |
| `all_projects.preferred_neighborhoods` | **Legacy dropdown, kept** | Rollback + comparison; engine dual-reads during transition. |
| `clients.preferred_districts` | **Multi-lookup → districts** | Client can prefer several districts; engine compares ids. |
| `units.district` | **Mirror of the project's district** (display only) | Decision #1 — one source of truth (the project). |
| `our_projects` / `followups` / etc. | **Mirror** (display) of the lookup's name | Display only; no second source of truth. |
| matching engine | **Operates on lookup ids + coordinates**, never on dropdown text once cut over | Per the brief's general rule. |

---

## 7. Migration plan (step-by-step, after approval)

**Phase 0 — Expand the districts model beyond Riyadh (decision #2, prerequisite).**
This is now a **hard prerequisite** before the value-mapping backfill, because relational matching for non-Riyadh projects requires those districts to exist. Work:
- **Identify the source dataset** for the existing 189 Riyadh districts (likely a Saudi national-address / Amanah / municipal boundary export, given every record has a real GeoJSON polygon + centroid). Reuse the same source for other cities — **this needs to be located/confirmed; it is the critical dependency for Phase 0.**
- Determine which cities to cover: derive the target list from the **`preferred_city` values on the 764 currently-unmatched projects** (and `units.city`) so we cover exactly the cities the data actually uses (Jeddah, Dammam, Khobar, Makkah, etc.).
- Load new district records with the **same field shape** (`name_ar`, `name_en`, `city`, `municipality`, `region`, `center_lat`, `center_lng`, `boundary_geojson`). Each new district must carry a centroid + polygon to be useful to the engine.
- Re-measure the match rate (the "149/913 exact" figure) after expansion — that number is the gate for how clean the Step-3 backfill will be.
- **Output of Phase 0:** a districts table covering all cities present in the project/unit data, reviewed before any lookup is wired.

**Step 1 — Snapshot.** Back up affected models + records before any change:
- `models` rows for `all_projects`, `clients`, `units`, `districts` → `_backup_models_district_migration_20260625`.
- `records` for those four model_ids → `_backup_records_district_migration_20260625`.
- (Pattern matches prior backups, e.g. `_backup_all_projects_20260601`.)

**Step 2 — Add new lookup fields (schema only, no data yet).** Migration `supabase/migrations/2026-06-25_district_lookups.sql`:
- Add `district_lookup` to `all_projects` Geographic Information section (`9e8fc144`) — `type:'lookup'`, `lookup_model_id:'d9a9db7e-…'`, `lookup_display_field:'name_ar'`, `is_multi:false`. Auto-propagates to `our_projects`.
- Add `preferred_districts` to `clients` Client Preferences section (`84e95d93`) — lookup, `is_multi:true`. Auto-propagates to followups/unanswered/valuation.
- (Optional, per decision) add `district_lookup` to `units`.
- Fix `districts.city` label_en. These are **unfrozen** models → edit `models.schema` JSONB only; the `models_view_sync` trigger regenerates `v_all_projects`/`v_clients`. No physical-table DDL, no freeze-artifact regen (none are frozen).

**Step 3 — Map legacy values → district records (data backfill, separate reviewed migration).** Resolution ladder, in order, recording the rule used in a temp `district_match_method` field:
1. Exact `name_ar`. (Measured: **149/913** project rows.)
2. Exact `name_en`.
3. Normalized AR: strip leading `حي `, the article `ال`, tatweel `ـ`, collapse whitespace, unify alef/hamza/teh-marbuta; then re-match.
4. Alias match (if an `aliases` field is added).
5. **Coordinate point-in-polygon**: for the 581 projects with lat/lng, find the district whose `boundary_geojson` contains the point.
6. Leave unmatched for manual review (expected to be largely **non-Riyadh projects** — the districts model is Riyadh-only/189, so many competitor projects in other cities have no district record yet).
- Same ladder for `clients.preferred_neighborhoods` (only 17 rows) and, if in scope, `units.district` (925 rows, but its dropdown has duplicate `حي X` entries to normalize first).

**Step 4 — Coordinate validation.** For projects that got both a name-match district AND have their own pin, compare the pin against the matched district's polygon; emit one of: `valid`, `coordinate_conflict`, `missing_coordinates`, `outside_known_districts`, `ambiguous_boundary`, `needs_manual_review` into a temp `district_migration_status` field. Do **not** auto-resolve conflicts — queue them.

**Step 5 — Update mirrors.** Re-point `marketing_operations.mirror_district` to the new district field. Verify the auto-propagated section-mirrors (`our_projects`, `followups`, etc.) render the lookup's display name. (No action needed for those four beyond verification.)

**Step 6 — Update forms & views.** Confirm the new lookups render in the all_projects + clients forms; switch the matching/map authoritative coordinate source to `districts.center_lat/lng`; ensure project cards show the lookup-derived district name.

**Step 7 — Workflows/automations.** **No-op** (none reference district). Documented here so the gap is explicit, not forgotten.

**Step 8 — Keep legacy fields.** Retain `all_projects.preferred_neighborhoods`, `clients.preferred_neighborhoods`, `units.district` as legacy; rename labels to "(Legacy)" and set the engine to dual-read. Hide from normal users only after Step 10 validation passes.

**Step 9 — Engine upgrade (code).** Update `matchAgent.ts`/`match.ts`/`locationUtils.ts`/the four client libs + tests to read the lookup (with text fallback). Ship behind the dual-read so nothing breaks mid-rollout.

**Step 10 — Approval gate + cutover.** After validation, flip the engine to lookup-primary, hide legacy fields, drop the temp migration-status fields.

---

## 9–13. Matching, coordinate, unmatched, ambiguous, rollback

- **Matching strategy:** the resolution ladder in Step 3 (exact AR → exact EN → normalized AR → alias → point-in-polygon → manual).
- **Coordinate validation:** Step 4 (point-in-polygon against `boundary_geojson`; conflict states queued).
- **Unmatched records:** stay on legacy text (engine still matches them by text); flagged `needs_manual_review`; the most common cause will be **a real missing district** (non-Riyadh) — surface a "districts to add" list rather than forcing a wrong match.
- **Ambiguous records:** never auto-pick; queue with candidate list (mirrors the matching assistant's existing `ambiguous`/`candidates` pattern in `propose_task`).
- **Rollback/safety:** legacy fields retained + Step-1 snapshots; the new lookup is additive (no data destroyed); engine dual-reads so reverting is a one-line flip. Follows the repo's "never silently drop data / fail loudly" rule.

---

## 14. Testing plan
- Unit: extend `projectMatchScoring.test.ts` for lookup-id exact match + point-in-polygon nearby; add `pointInPolygon` unit tests (inside / on-edge / outside / multi-polygon).
- Integration: `matchProjects.integration.test.ts` with a project whose lookup district ≠ its legacy text, to prove the engine prefers the lookup.
- Data: dry-run the Step-3 ladder in a transaction, `ROLLBACK`, and report counts per rule + the unmatched/ambiguous lists **before** committing.
- Live: after deploy, smoke-test the Matching assistant on a Riyadh district and confirm `geo_confidence:'high'` picks resolve via the districts centroid (per the repo's "test everything before done" rule + `docs/claude-live-ops.md`).

## 15. Approval checklist (resolved / remaining)
1. ~~Scope of `units.district`~~ → **Resolved: mirror the project's district (decision #1).**
2. ~~Non-Riyadh coverage~~ → **Resolved: expand the districts model first (decision #2) — see Phase 0.**
3. ~~Engine transition~~ → **Resolved: dual-read (decision #3).**
4. **OPEN — Phase 0 data source:** where do the non-Riyadh district names + GeoJSON boundaries + centroids come from? (Confirm the source of the existing 189 Riyadh districts and whether it covers other cities.) **This is the gating dependency.**
5. **OPEN — minor:** fix `districts.city` mislabeled `label_en` ("Region"→"City"); add optional `aliases` (text) + `is_active` (checkbox) fields to aid matching? (recommend yes.)
6. **OPEN — confirm temp fields:** lat/lng already exist on all_projects, so the brief's "Project Latitude/Longitude" are unneeded; `district_migration_status` / `district_match_method` will be temporary and dropped at cutover. OK?

## 16. Implementation order (after final go-ahead)
1. **Phase 0** — locate the district data source; expand the districts model to all cities present in the data; re-measure match rate. **First gate: reviewed districts table.**
2. Snapshot (Step 1).
3. Schema migration: add `all_projects.district_lookup` + `clients.preferred_districts` + `units` project-district mirror + `districts.city` label fix (Step 2) — verify auto-propagation to our_projects/followups/etc.
4. `pointInPolygon` helper + engine dual-read code, with tests (Step 9 partial) — ship inert (dual-read still prefers text until backfill lands).
5. Dry-run the value-mapping ladder; review unmatched/ambiguous (Steps 3 + 13) — **second gate: the mapping report.**
6. Commit the backfill; coordinate validation (Steps 3–4).
7. Re-point marketing_operations mirror; verify section-mirrors + forms/maps (Steps 5–6).
8. Flip engine to lookup-primary (dual-read keeps text fallback); hide legacy fields; drop temp fields (Step 10).
9. Update PRDs (`docs/prd/` — data-storage, ai-agent/matching, record-management) per the project's PRD discipline.

---

### Appendix — key live IDs
- Models: all_projects `220c49b9-de57-492d-9eca-c0d9f54fd40f` · clients `2e86f197-385f-4853-908f-b4cb7237f7d8` · units `7ca3014d-f658-418e-9c53-2d279c97f009` · our_projects `6609286a-f95a-45db-94e6-48cfa915ccbd` · districts `d9a9db7e-b602-470c-b81b-5d6ff17048e9` · matching_chats `7c0ffee2-5cab-4b0a-9d3e-12ab34cd56ef`.
- Sections: all_projects Geographic Information `9e8fc144-d3ae-4b62-bf1c-831b152c58ac` · clients Client Preferences `84e95d93-b3cb-40d3-9f69-0b30d51a2a3a`.
- Existing geo migration: `supabase/migrations/2026-06-21_project_geo.sql`. Matching engine: `api/_lib/matchAgent.ts`, `api/match.ts`.
