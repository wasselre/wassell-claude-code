---
name: migrate-project
description: Migrate a real-estate developer's project (the project record + ALL its units) into the Wassell CRM from a project page URL or a file. Reads the developer's units API, project page, brochure, and unit floor plans; creates the all_projects record and every linked unit with exact components, plan images, prices, and developer links; lets the DB rollups auto-compute. Use whenever the user pastes a developer project link (almajdiah.com, alajlaninvest.com, etc.) or hands over project files and wants it migrated into all_projects + units. Replaces the in-app Data Migration wizard.
---

# Migrate Project — living migration pipeline

## ⭐ META-RULE (read first, never violate)
**This skill is a LIVING process.** Every time a migration forces you to ask the user a question,
once they answer you **MUST immediately edit this file** and record the answer as a permanent rule
in the **Decisions Log** below — so that question is never asked again. The goal is to converge to
**zero questions**, at which point this becomes a standalone API agent. Treat each Q&A as a patch to
the skill, not a one-off. If you discover a new fact about a developer's site, a field, or an edge
case, log it here too.

---

## What this does (end state)
From one project link (or files), produce in **wassell-prod**:
- 1 `all_projects` record (deduped by `project_name`), with developer link, location, brochure/page
  URLs in the developer-content fields, amenities, services, landmarks, features.
- N `units` records linked to it (`project_id` = the project's UUID), each with exact components,
  facade, parking, prices, areas, floor, and its floor-plan image in `unit_plan`.
- Auto-ID codes assigned (`project_id` code on the project, `unit_code` on each unit).
- Rollups (`unit_count`, `available_units`, `price_range`, …) fill **automatically** via DB triggers.

## When you're with the user
The user runs ~5 of these in parallel, one project per session, and stays available to answer.
Pause ONLY at a genuine, un-logged decision point; answer-then-log; otherwise proceed autonomously.

## Inputs — a URL **and/or files** (both supported)
The user may give a **project page URL**, **files**, or both. Handle every source and converge on the
same build+write step:
- **Project page URL** → discover the developer's units JSON API (richest, live). Default when given.
- **Units file** (Excel/CSV/PDF/image/screenshot of the unit table) → parse to the same unit fields:
  Excel/CSV via the `xlsx` lib; PDF/image via render-to-PNG (PyMuPDF) + visual read. Map columns to the
  units schema the same way (statuses, floors, components, prices, areas).
- **Brochure** (PDF) → amenities/services/landmarks/features (render→PNG + read if no Arabic text layer).
- **Plans** (PDF or image set) → per-unit floor plans → `unit_plan` image field + read for
  components/beds/baths. A plans PDF is the "separate file" that covers the units a sparse API misses.
- **When both URL and files are given:** prefer the **API for live unit data + prices**, and the
  **files for plans + brochure content**; reconcile and flag conflicts to the user.

---

## Prerequisites / secrets (read from env, never hardcode in the repo)
`C:\Users\rayan\Claude\wassell-claude-code\.env.local` holds:
- `SUPABASE_SERVICE_ROLE_KEY` (sb_secret_…) — the write channel. Lets Node call `record_save`,
  `record_assign_auto_id`, `add_field_option`, and the Storage API directly.
- `SUPABASE_URL` = https://zhqqsxwealdwqzrbpwyv.supabase.co
- `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` — cloud browser for API discovery / page reads.

Working scripts live next to this file in `scripts/` (Almajdiah-proven reference implementation).
Run them from a scratch dir; they load the keys from `.env.local`.

## Prod IDs (project zhqqsxwealdwqzrbpwyv)
| thing | id |
|---|---|
| all_projects model | `220c49b9-de57-492d-9eca-c0d9f54fd40f` |
| units model | `7ca3014d-f658-418e-9c53-2d279c97f009` |
| developers model | `11bade2c-7da9-4d00-b045-eaab37153da2` |
| districts / cities / regions | `d9a9db7e-…` / `d15a0001-…-0002` / `d15a0001-…-0001` |
| image bucket | `wassel-files` (path `<auth_uid>/<file_id>.jpg`, files row `kind='image'`) |

## Write channel (the same path the wizard uses)
- `record_save(p_model_id, p_id, p_data, p_created_by, p_expected_version)` via REST RPC with the
  service key. New records: `p_id = crypto.randomUUID()`, `p_expected_version = null`. Returns the id.
- Lookups store the **target UUID** (developer → developers.id, unit.project_id → all_projects.id,
  district_lookup → districts.id, …). Dropdowns/multiselects store the option **`value`**, not the label.
- **Auto-IDs:** call `record_assign_auto_id(model_id, field_id, scope_key, start)` and put the returned
  code into `data` BEFORE `record_save`. Assign `project_id` (all_projects) and `unit_code` (units).
- **New options:** call the atomic RPC `add_field_option(model_name, field_name, value, label_ar,
  label_en, color)` — it locks + de-dupes so 5 parallel sessions can't clobber the schema.
- **Images:** download bytes → `POST /storage/v1/object/wassel-files/<auth_uid>/<uuid>.jpg` (service
  key) → INSERT a `files` row (`kind='image'`, `record_id`=unit, `uploaded_by_user_id`=public.users id,
  `storage_bucket='wassel-files'`, `storage_path`) → set the image field = the file id (bare string).
- **Direct DB writes do NOT fire client-side workflows.** Fine for project/unit creation.

---

## Pipeline (per project)

1. **Discover the units API.** Most developer sites are a front-end shell calling a JSON backend.
   Open the project page in Browserbase, capture network requests, find the units endpoint.
   - Almajdiah: `https://etmaam.almajdiah.com/api/client/v1/projects/{id}?…&page=N` (paginated 30/page;
     `units.meta.last_page`, `units.meta.total`). No auth. `{id}` is in the page URL `/projects/{id}`.
2. **Extract ALL units + project meta.** Page through to `last_page`. Capture per unit: unit_number,
   building_name, status, floor_text, room_count, bathroom_count, area/special_area/total_area,
   price_before_tax/after_tax/tax_rate, unit_description, garage_text, chart_file_urls (plan).
   Capture project: name, location.map_url + lat/lng, web_site_project_brochure, image/gallery,
   units_count, status_text.
3. **Read the project page + brochure** for the 5 content fields (NOT in the units API):
   download the brochure PDF; if its Arabic has no text layer, render pages to PNG (PyMuPDF) and read
   them visually. Extract amenities, services, nearby landmarks, features.
4. **Unit plans.** Download each `chart_file_urls` image; **read the drawing** to extract components +
   confirm beds/baths; upload into the unit's `unit_plan` image field. NOTE: developers usually attach
   plans to only a few representative units (one per layout), not all — see Decisions Log on coverage.
5. **Build + write.** Find-or-create developer; find-or-create project (dedup by `project_name` — if it
   exists, see Decisions Log); assign auto-IDs; write project; write each unit with `project_id`=the
   project UUID. Create any missing options via `add_field_option` first.
6. **Verify.** Query: units linked == expected, rollups populated, sample unit components/plan resolve
   (signed URL 200). Hand the user a short summary with the project UUID.

---

## Field mappings (locked)
- **unit_status:** sold→`sold`; available/under_sale→`available`; booked/booked_paid/pre_booking/
  reserved→`reserved`; under_construction→`under_construction`.
- **floor** (from `floor_text`): الأرضي→`ارضي`, الأول→`اول`, الثاني→`ثاني`, الثالث→`ثالث`,
  الرابع→`4` … العشرون→`20`, بنتهاوس→`الروف`.
- **unit_type** (from `floor_text`): if floor_text ∈ {شقة,دور,فيلا,تاون هاوس} use it; else (it's a real
  floor) → `شقة`. (floor_text is overloaded: real floor for apartments, unit type for villa/townhouse
  projects, e.g. أديم الفرسان = mixed تاون هاوس + فيلا.)
- **unit_components** (multiselect): parse `unit_description` (split on " - ") + read the plan.
  بلكونه→بلكونة, سطح خاص→سطح, سيب خاص→سيب-خاص, غرفة خادمة, مستودع, تراس; plan rooms → صالة جلوس
  (living), صالة طعام (dining), مطبخ (kitchen), غرفة غسيل (laundry), فناء خارجي (ground outdoor),
  سطح (roof terrace), ملابس (walk-in closet), غرفة-نوم-رييسية (master).
- **facade** (multiselect): واجهه امامية/أمامية→امامية, واجهه جانبية→جانبية, خلفية→خلفية.
- **parking_space** (multiselect): موقف قبو→`basement`, خارجي→`external`, خاص/داخلي→`internal`.
- **all_projects.preferred_amenities** maps brochure amenities to option values (lounge, sports_club,
  swimming_pool, garden, …); create missing ones via `add_field_option`.
- **Tables:** features `{feature, keywords}`; services `{service, notes}`; guarantees `{col_1 نوع,
  col_2 شركة, col_3 مدة, col_4 ملاحظات}`; nearby_landmarks `{landmark, property_type, distance,
  duration}`.

---

## Decisions Log (the self-improving core — append every answered question, dated)
- **[2026-06-28] Area:** `unit_area` = **NET** area (API `area`). Keep `total_area` and
  `private_area` (=special_area) separate. (Rollup `area_range` follows unit_area.)
- **[2026-06-28] Components:** extract the **exact components for EVERY unit** — from `unit_description`
  AND by reading the unit's floor plan. Don't settle for brochure headlines.
- **[2026-06-28] New options:** when a brochure/plan value has no existing dropdown option, **create
  it** (via `add_field_option`). Don't route it elsewhere.
- **[2026-06-28] Developer URLs:** the developer's project page → `project_page_url`; the developer's
  brochure → `broucher_developer`; (these are the "developer-content" section). Do **NOT** use the
  generic `brochure_link`. `developer_content` is an attachment field.
- **[2026-06-28] Map:** the "الوصول لموقع المشروع" map link → `project_location`; also set
  `latitude`/`longitude`.
- **[2026-06-28] Plans:** download each unit plan into the `unit_plan` IMAGE field (real file in
  wassel-files), AND read the plan to extract components + confirm beds/baths. Plan coverage is often
  sparse (developer attaches one plan per layout, not per unit). Propagation policy for the un-planned
  units = **DEFERRED — ask the user per project until decided here.**
- **[2026-06-28] Classification:** decide per source. **Almajdiah → `our_projects`** (project_type +
  project_classification = our_projects, is_public=true). For a new developer, ask once, then log it.
- **[2026-06-28] Auto-IDs:** assign them on real runs (`project_id` code + `unit_code`).
- **[2026-06-28] Dedup:** dedup by `project_name`. If the project already exists, do NOT blindly
  duplicate — surface it and confirm update/reconcile vs. duplicate with the user.
- **[2026-06-28] Rollups:** never set the 11 rollup fields; triggers compute them from units.
- **[2026-06-28] Inputs:** accept a URL AND/OR files (units spreadsheet, brochure PDF, plans PDF/images,
  screenshots) — see Inputs section. A plans file is the right source for units a sparse API misses.

## Open questions (resolve → move into Decisions Log)
- Un-planned-units plan policy (propagate by exact beds/baths/area signature, or leave, or request full
  plans file from developer).
- Per-developer API discovery for non-Almajdiah sites (Alajlan Invest etc.): document each site's
  units endpoint + field shape here as you learn it.
- Per-developer classification (log each developer → our_projects vs general here).

## Verify & cleanup
- Verify: `count units WHERE project_id=<uuid>` == expected; project `unit_count` populated; a sample
  `unit_plan` signed URL returns 200 image/*.
- To roll back a run: delete files (+storage objects), delete units, delete project, revert any options
  you added. (See scripts/cleanup.mjs.)
