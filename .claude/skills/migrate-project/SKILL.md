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
- A **detailed `project_analysis`** AND a **`marketing_document`** written on the project record
  (ALWAYS — both are standard deliverables, not optional). See the "Content fields" step below.

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
- **Auto-IDs (⚠ READ — the RPC does NOT work over the service key):** `record_assign_auto_id(model_id,
  field_id, scope_key, start)` is `SECURITY DEFINER` and **gates on `wassell_user_has_action(auth.uid(),
  model, 'create')`** — under the service-role key `auth.uid()` is NULL, so it RAISES `42501 insufficient_
  privilege`. It also returns a **bare INTEGER** (not the formatted code); the prefix+padding are applied
  client-side. So calling it via REST with the service key fails, and if you blindly stuff the response
  into `data` you write the *error JSON* as the code (the `42501`-everywhere bug — see Decisions Log).
  **Correct path (no profile/JWT needed): compute the next id yourself in raw SQL via the Supabase MCP**
  (runs as postgres, bypasses the auth gate), replicating the RPC's self-heal = `max existing numeric + 1`,
  then format. Use the **real formatted codes only** for the max (regex `^U-\d+$` for units / `^م ش\d+$`
  for projects) so stale garbage codes from a prior failed run don't inflate it:
  - project_id: prefix `م ش`, no padding → ``'م ش' || (max(substring(project_id from '^م ش(\d+)$')::int)+1)``
  - unit_code:  prefix `U-`, **NO lpad** → ``'U-' || (real_max+rn)::text`` over the N new units.
    ⚠ **NEVER `lpad((real_max+rn)::text, 4, '0')` — Postgres `lpad` TRUNCATES (keeps the LEFT n chars) when
    the string is longer than the target width.** unit_code is now in 5-digit territory (`U-43552`…), so
    `lpad(…,4,…)` silently turned `43552`→`4355`, collapsing all 69 codes into 8 collided 4-digit codes
    (and those short codes also collide with real units elsewhere). The live codes are plain `'U-'||n`
    (unpadded, e.g. `U-43551`), so just concatenate — no padding needed. Bit الرمز/سديم-فلل, 2026-06-28;
    caught by the `count(distinct unit_code)` verify step (which is why that check is mandatory).
  ⚠ Do NOT use a `(SELECT max FROM cte)` scalar inside an `UPDATE … FROM ranked` that also writes
  unit_code — it misread/clustered the values; **materialize the max as a literal first**, then UPDATE.
  Assign `project_id` (all_projects) and `unit_code` (units). Set the code into `data` directly via the
  same SQL `UPDATE records SET data = jsonb_set(...)` (the row is unfrozen JSONB; the version trigger is fine).
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
6. **Content fields (ALWAYS — both, every project).** After the units land (so rollups/stats exist),
   compute pricing/area/floor/bedroom stats from the written units and write TWO textarea fields on the
   `all_projects` record, both in **Arabic**, merging onto existing `data` (never null other fields):
   - **`project_analysis`** — a *detailed* analysis: overview, location & access (landmarks + drive
     times), inventory breakdown (by building/floor/bedroom + sold list), areas, **pricing** (range,
     avg, median, price/m², per-bedroom tiers + the key driver, e.g. "bedroom-driven not area-driven"),
     models/components, sales channel + payment plan, developer context, and sales strengths/considerations.
   - **`marketing_document`** — persuasive marketing copy in the developer/brochure voice: location
     hooks, lifestyle/design highlights, segment-tailored options, a price anchor ("تبدأ من …"),
     sales-channel reassurance (سكني/وافي if applicable), and a contact/CTA.
   Ground every number in the actual written units — don't invent figures.
7. **Verify.** Query: units linked == expected, rollups populated, sample unit components/plan resolve
   (signed URL 200), AND `project_analysis` + `marketing_document` are both set. Hand the user a short
   summary with the project UUID.

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
- **[2026-06-28] Plans — brochure-only generic MODEL plans (no per-unit plans):** when the ONLY plans
  available are a handful of generic نموذج/model drawings in the brochure (e.g. الشقة 1–4) and the unit
  inventory carries NO model tag (so unit→plan is inference-only and areas overlap), **SKIP per-unit
  `unit_plan` entirely** (leave empty on all units). The model plans stay accessible via the brochure
  already linked on the project (`broucher_developer`). User chose this for Alajlan riv52 (2026-06-28)
  over fuzzy bedroom-match or representative-only attaching. Only attach `unit_plan` when the source
  gives a real per-unit (or per-exact-layout) plan.
- **[2026-06-28] Classification:** decide per source. **Almajdiah → `our_projects`** (project_type +
  project_classification = our_projects, is_public=true). For a new developer, ask once, then log it.
- **[2026-06-28] Alajlan Invest (العجلان ريفيرا, developer `5db67fcc-6a6f-4d0a-83a2-c1e7f41e03d6`) →
  `our_projects`** (matches the existing record + ALL sibling ريفييرا projects already in CRM). Already
  in `developers`; do NOT create a new developer. Many Alajlan Riviera projects were bulk-seeded
  2026-04-26 as bare project rows with **0 units** — the migration job is to ENRICH the existing row +
  ADD its units, never duplicate.
- **[2026-06-28] Auto-IDs:** assign them on real runs (`project_id` code + `unit_code`).
- **[2026-06-28] Dedup:** dedup by `project_name`. If the project already exists, do NOT blindly
  duplicate — surface it and confirm update/reconcile vs. duplicate with the user.
- **[2026-06-28] Rollups:** never set the 11 rollup fields; triggers compute them from units.
- **[2026-06-28] Content fields ALWAYS:** every migration writes BOTH a detailed `project_analysis`
  AND a `marketing_document` (Arabic, merged onto existing `data`) as standard deliverables — see
  pipeline step 6. The `project_analysis` is the deep evidence-based analysis (pricing/location/
  inventory/strategy); the `marketing_document` is persuasive customer-facing copy. Numbers must be
  computed from the actually-written units. (User asked for these on Alajlan riv52, 2026-06-28 → now
  permanent for all projects.) Verify both are set in step 7.
- **[2026-06-28] Inputs:** accept a URL AND/OR files (units spreadsheet, brochure PDF, plans PDF/images,
  screenshots) — see Inputs section. A plans file is the right source for units a sparse API misses.
- **[2026-06-28] Auto-id over service key FAILS (root-caused the `42501` bug):** `record_assign_auto_id`
  gates on `auth.uid()` create-permission → raises `42501` under the service-role key, and returns a bare
  INTEGER. Don't call it via REST with the service key. Compute the next id in raw SQL via the Supabase MCP
  (max **real-formatted** code +1) and set it with `jsonb_set` — see the rewritten "Auto-IDs" bullet in
  Write channel. The reference script `04-build-and-write.mjs` still does the OLD broken `rpc(...).code`
  thing — treat the Write-channel bullet as the source of truth, not that script.
- **[2026-06-28] Filter the unit_code max to real codes (`^U-\d+$`):** during the nuwar run, units of a
  CONCURRENT migration (project `413b9850…`, سدن فلل سكنية-51) were transiently sitting at the `42501`
  error-code (mid auto-id fix by a parallel session) and inflated the global max to 42501. They self-resolved
  to clean `U-42xx` shortly after. Lesson: **5 sessions run in parallel** — never trust the raw global max;
  compute next unit_code over `unit_code ~ '^U-\d+$'` only so an in-flight sibling's interim garbage can't
  push your codes into the 40000s. (Same idea for project_id: filter `^م ش\d+$`.)
- **[2026-06-28] نوار run (Alajlan, `our_projects`):** project `aac8ea71-cee4-4913-81d3-e2cbc6d5a64c`
  (`م ش2808`), 16 units `U-4325`–`U-4340`, dev `5db67fcc…`. Geography for **حي الملك عبدالله، الرياض** =
  `location:{district:'d24d7f93-0e7f-72c0-f1fa-c81b85328d8d', city:'44254a38-ce40-938f-17b7-55814a44e45c',
  region:'9c0c7a82-738d-6456-2101-b7226cc84e20'}` (Riyadh city/region are shared with riv52). The
  all_projects `location` field (type `location`) holds those three UUIDs; legacy `preferred_city`/
  `preferred_neighborhoods` are free-text mirrors. districts/cities/regions are **FROZEN** (own tables) —
  look up the district UUID in `public.districts` by `name_ar` + `city_name_ar`, NOT in `records`.

- **[2026-06-28] الرمز (Al Ramz Real Estate) run — files-only (brochure + sales PDF), `our_projects`:**
  developer `dfe055a2-de6a-49e6-8502-14d10d6d6b62` (name `الرمز`, alramzre.com) ALREADY exists — do NOT
  create. Project **سديم فلل** ALREADY existed as a bare row `93181558-b673-4cb1-83b6-c738c41b1f21`
  (`م ش1884`, our_projects, حي الصفا/الرياض, district `31b81461-50a2-d93c-4a90-5c2936e5fa51`, lat/lng +
  brochure already set) with **0 units** → classic ENRICH-existing + ADD-units (same posture as the
  Alajlan bulk-seeded rows). Added 69 villas `U-43552`–`U-43620`, 16 available @ flat 2,140,000 ر.س / 53
  reserved / 0 sold; enriched `nearby_landmarks`+`features`+`preferred_amenities`(replaced 4 INVALID stale
  values `صالة/غرفة-نوم/دورة-مياه/مطبخ` — none were real options — with `نظام-مراقبة-امنية/نظام-دخول-ذكي/مصاعد`)
  +`data_sources`+`project_analysis`+`marketing_document`. Rollups auto-filled (area_range 324–440 = build).
- **[2026-06-28] Villa area mapping (مساحة البناء / مساحة الأرض):** for villa sales sheets with TWO area
  columns, `unit_area` = **مساحة البناء** (built-up, the larger; the rollup `area_range` follows it) and
  `deed_area` = **مساحة الأرض** (plot/land = registered deed area). Don't use total_area/private_area for
  these. (الرمز سديم: build 324–440, land 200–362.)
- **[2026-06-28] Sales-PDF parsing (PyMuPDF positional + NFKC):** Arabic price/units PDFs extract as
  REVERSED **presentation-form glyphs** that fragment words and fuse cells (`هنا325محجو`, `261محجو`,
  `هنا22`). Recipe: `get_text("words")` for x/y coords, cluster rows by y (~140px apart), assign columns by
  x-center, and **`unicodedata.normalize("NFKC", t)`** every token so presentation forms collapse to
  standard Arabic (then `"محجوز" in row` = reserved, `"بلك" in page` = block header). Cross-validate
  available-count against the independent price-count. `محجوزة`=reserved (no price shown); priced units
  carried a flat launch price. (الرمز سديم: blocks 191/192/195 = 26/21/22 units; 192 fully reserved.)
- **[2026-06-28] No per-unit model tag + generic A–F model plans (Adobe-share links):** the sales sheet's
  `المخططات`→`إضغط هنا` links are per-MODEL Adobe share URLs (not downloadable images) and the inventory
  has NO model column, so unit→plan is inference-only → **SKIP `unit_plan`** (existing brochure-only rule
  extends to Adobe-share-link plans). When no per-unit model mapping exists, apply ONE representative
  components/bedrooms/bathrooms set uniformly across all units (derived from the brochure's floor
  breakdowns) and DOCUMENT the per-model variation (e.g. "A/B = 4 beds, C–F = 5") in `project_analysis`.
  (Set bedrooms=5/bathrooms=5/elevator=مؤسس/parking=internal + a 16-item فيلا component set for سديم.)

- **[2026-07-02] ريفا riva.sa is a MARKETER (not a developer) — one listing, many sub-brand "developers":**
  riva.sa lists 24 projects for ~15 sub-brands (يمام، زنك، مجبب، فيورا، عزوم، آبه، أوشن، أكدال، الرمز،
  مسان، عبق، ديارا، أجذى، ديار أصيلة، زود…). The CRM models each sub-brand as its own `developers` row
  (bulk-seeded 2026-04-18 with `website: riva.sa`). Posture: classification = **`riva_projects`**
  (dedicated dropdown option `مشاريع ريفا`, created 2026-07-02 at the user's request — the seed rows
  originally carried `general_project`; all 23 were flipped) **AND membership in `our_projects`**
  (user decision 2026-07-02: every riva project also gets an our_projects record `{project:<uuid>}`,
  which auto-flips `is_public` via the our_projects-drive-website triggers → published on wassel.re;
  verified live via the /project OG tags). Developer = the sub-brand row.
  Group projects by the page's developer-logo URL; groups containing an already-matched project inherit
  its developer; for unknown groups **read the logo image** to get the brand (create the developer with
  `website: riva.sa`). If the logo is a text-free SVG, read the brochure cover/back instead (that's how
  زود was identified for إلوفي — élevée/الوڤي, a Jadwa Investment fund).
- **[2026-07-02] Marketer listing counters can be STALE — the project page is authoritative:** riva's
  listing card for مجبب هاوس said 46/2/23 (=71 units) but the project page renders 41, and the page's own
  Livewire status filters (`case` 0/1/2) return exactly 16/2/23. Trust the per-project page inventory.
- **[2026-07-02] Cross-marketer dedup:** a project already migrated from the DEVELOPER's own site
  (جديل الرمال ← alramzre.com, 68 units, our_projects) also appears on riva.sa (60 units). Do NOT re-add
  or overwrite from the marketer — the developer-source migration wins; skip the project entirely.
- **[2026-07-02] Bare-seed rename needs developer-site proof:** يمام 8 (bare 0-unit row) = يمام فلورز 8 —
  verified on yamam.sa's own project list (it has ONE "8" project) before renaming the row.
- **[2026-07-02] "نماذج" sold as units:** إلوفي lists 4 نماذج with real prices/areas (incl. بنتهاوس) —
  migrate each نموذج as a unit (`unit_model='نموذج N'` + note). Added `unit_type` option `بنتهاوس`.
- **[2026-07-02] Multi-level units (تاون هاوس/فيلا "الأرضي - الأول", villa "3"):** the single-value
  `floor` dropdown can't hold spans — leave `floor` unset, write 'المستويات: <text>' into notes. Single
  floors map as usual (الملحق→الروف).
- **[2026-07-02] Missing unit descriptions (sold units often omit them):** propagate the component
  description from a sibling unit in the SAME project with the same bedroom count (layouts repeat per
  bed count); tag the note '(المكونات منسوخة من وحدة مطابقة)'. Riva: 248/315 native, ~66 propagated.

## Per-developer API/source adapters (document each site as you learn it)
- **ريفا العقارية (riva.sa)** → **Laravel + Livewire v3, fully SERVER-RENDERED — plain `fetch` + regex,
  no Browserbase needed.** Listing `/projects` renders 18 cards; page 2 (6 more) is Livewire pagination —
  `?page=2` is IGNORED; replay it: GET `/projects` (keep cookies + `csrf-token` meta + the
  `frontend.projects-page` `wire:snapshot`), then POST `/livewire/update` with
  `{_token, components:[{snapshot, updates:{}, calls:[{path:'',method:'gotoPage',params:[2,'projects_page']}]}]}`
  → `components[0].effects.html`. Project page `/project/<slug>` has EVERYTHING server-side: name+type in
  header, `الرياض - <district>`, description rich-text, specs block (area range, beds, baths, kitchens,
  `رخصة الاعلان`, `تاريخ النشر`, price range `X الي Y`), المميزات list, الضمانات (name+duration),
  المعالم القريبة (name + `المسافة: N كم`), Google-maps `?q=lat,lng` link, brochure URL in the
  `pdf-viewer` snapshot's `data.pdfUrl`, developer logo `<img src=".../developers/...">`, `og:image`
  (hero → `main_image`). **Unit cards** = blocks split on `wire:key="<id>"` that contain `post-title`
  (other wire:keys are feature icons — filter them): number, type badge, price `text-success">N` OR
  `تواصل معنا` (price hidden but unit may still be متاح), area `N م²`, beds after `bed.png`, baths after
  `bathtub-01.png`, card `<img>` = **the real per-unit floor plan** (attach to `unit_plan`), status =
  `مباع`/`محجوز` badge text in the block else available. **Unit popup** (floor + component description +
  images): POST `/livewire/update` on the `frontend.conponents.unit-popup` snapshot with
  `calls:[{method:'loadUnit',params:[<id>]}]` (params = bare int; object param → 419) →
  `effects.html` has `الدور : <floor>` + a dash-separated description; snapshot `data.unitImages` has the
  plan URL(s). ~150ms between calls was enough for 315 popups, no rate-limiting. Status semantics on the
  page tabs: case 0=متاح, 1=محجوز, 2=مباع. Riva run 2026-07-02: 24 projects (23 migrated + جديل الرمال
  skipped), 255 units written, م ش2811–2817, م ط195–200, U-43814–U-44068.
- **Almajdiah** → JSON units API `https://etmaam.almajdiah.com/api/client/v1/projects/{id}?…&page=N`
  (paginated 30/page; `units.meta.last_page`). `{id}` from the page URL `/projects/{id}`. No auth.
- **Alajlan Invest** (`alajlaninvest.com/project/<slug>/`, e.g. `riv52`) → **WordPress (Mharty theme),
  NO JSON units API.** The static HTML has none of the unit data; the units render client-side into
  **HTML `<table>`s, one per building** (tabs "المبنى I / J / K"), only after the page runs JS +
  scrolls. **Adapter = Browserbase DOM scrape** (`_riv52_units2.mjs` pattern): goto
  `domcontentloaded`, wait ~6s, wheel-scroll ~16×, then `document.querySelectorAll('table')` →
  rows → cells. Columns (RTL): **الوحدة | الأدوار | المساحة | المواصفات | السعر | المميزات**.
  Unit code = building-letter+number (`I1`,`J6`,`K28`). Price cell is a number OR `مباعة` (=sold, no
  price). المواصفات = `Nغرف نوم / صالة / مطبخ / غرفة خادمة / Nدورات مياه`. المميزات =
  parking (`موقف خارجي`→external, `موقف في القبو`→basement) + balcony (`بلكونة واجهة`→facade امامية,
  `بلكونة جانبية`→facade جانبية) + `تراس` / `سطح خاص`→سطح / `مساحة خارجية`→فناء خارجي / `زاوية`(corner→notes).
  Floor `السطح`→`الروف`. `unit_number` is a NUMBER field → store the numeric part; put the letter in
  `building_number`/`block` and the full code (`I1`) in `unit_model`/notes. riv52 had 86 units (I:27,
  J:29, K:30), 80 available / 6 sold; brochure `بروشور-سدن-شقق.pdf` (17pp, image-heavy, reversed text
  layer) → 4 model plans + landmarks + the map link.
  - **Alajlan `nuwar` variant (أدوار/فلل, 2026-06-28):** same Browserbase DOM-scrape, but the units render
    as **ONE single `<table>`** (no per-building tabs) with **7 columns**: `الوحدة | نوع الوحدة | الدور |
    المساحة | المواصفات | السعر | المميزات`. Code = `V{block}-{suffix}` (e.g. `V3-2`) → `block`/
    `building_number`=`V3`, `unit_number` (NUMBER)=suffix `2`, full code `V3-2` → `unit_model`+notes.
    `نوع الوحدة`=`دور` → `unit_type='دور'`. `الدور`: الأرضي→`ارضي`, الأول→`اول`, **الملحق العلوي→`الروف`**.
    `المساحة` `190م`→`unit_area` (NET). `المواصفات` = `N غرف نوم / N دورات مياه / مطبخ→مطبخ / صالة→صالة جلوس /
    غرفة خادمة`. `السعر` = number OR `مباعة` (=sold, no price). `المميزات` = تراس→تراس / مساحة خارجية→فناء
    خارجي / سطح خاص→سطح / **زاوية→note (corner)**. Components also enriched from the brochure's single
    **Model A** plan per level (ground: +مستودع/فناء خارجي/مصعد/غرفة-نوم-رييسية; first: +مجلس/مصعد; ملحق:
    +سطح/فتحة-سماوية/مصعد). Brochure text layer was **clean & readable** (not reversed) — `get_text()` worked.
    Map `goo.gl` link resolved to a precise pin (24.7157, 46.7574) — better than district centroid. nuwar:
    16 units listed (15 available / 1 sold) though the brochure states 84 floors + 28 villas total (live
    table = current released inventory only). Plans = generic Model A only → **SKIP `unit_plan`** (logged rule).
- **الرمز (Al Ramz, alramzre.com)** → **files-only adapter (no API scraped this run).** Source = the
  developer's two PDFs: a **villa brochure** (`get_text` gave clean-ish Arabic for amenities/landmarks/
  developer stats/model floor breakdowns) and a **sales price PDF** (`ملف أسعار`). Sales PDF shape: a
  `NNN بلك` header page precedes each block's data pages; each data page is a 6-row table, RTL columns by
  x-center (page width 1920): **الوحدة** (unit#, x≈1630) | **مساحة البناء** (build, x≈1270) | **مساحة الأرض**
  (land, x≈925) | **المخططات** (`إضغط هنا` plan link, x≈600, per-MODEL Adobe-share URL) | **السعر**
  (x≈200 = `محجوزة` OR a flat price number). Parse with the PyMuPDF positional + NFKC recipe in the
  Decisions Log. Map: build→`unit_area`, land→`deed_area`, block→`block`, in-block number→`unit_number`,
  `محجوزة`→reserved/`unit_status`, priced→available + `total_price`. SKIP `unit_plan` (per-model only).
  No model column → uniform representative components/beds/baths (see Decisions Log).
- Other non-Almajdiah sites: document each site's units source + field shape here as you learn it.

## Verify & cleanup
- Verify: `count units WHERE project_id=<uuid>` == expected; project `unit_count` populated; a sample
  `unit_plan` signed URL returns 200 image/*.
- To roll back a run: delete files (+storage objects), delete units, delete project, revert any options
  you added. (See scripts/cleanup.mjs.)
