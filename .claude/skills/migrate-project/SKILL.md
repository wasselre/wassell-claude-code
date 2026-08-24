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
- **[2026-08-02] EXACT COORDINATES ARE MANDATORY — every project MUST have `latitude` + `longitude`:**
  a place-name maps link (`.../maps/search/?api=1&query=<Project District>`) is NOT coordinates and is
  NOT sufficient on its own. When the source only gives a place-name/search link (common — e.g. Binghatti's
  public pages embed `google.com/maps/embed/v1/place?q=<Project>, <Area>` with no lat/lng), you MUST RESOLVE
  it to exact coordinates: **open the Google-Maps link in a browser and read the resolved `@<lat>,<lng>,<zoom>`
  from the redirected URL** (Google recenters on the matched place), or geocode `<Project>, <District>, <City>`
  and take the top hit's lat/lng. Store the numeric `latitude`/`longitude` on the project. Verify at the end
  that NO migrated project has null lat/lng (the 2026-08-02 Binghatti batch shipped 31/32 projects with only a
  search link and no coordinates — a real miss caught by the user; backfilled by opening each maps link).
  If a place-name query resolves only to the district centroid (building not yet in Google), store that +
  flag `geo_confidence:'district'` in the record so it's known to be approximate, not exact.
- **[2026-08-03] READ IMAGE-ONLY BROCHURE PAGES WITH GPU OCR — don't skip amenity/spec pages baked as images:**
  luxury brochures put real content (amenity lists, spec tables, floor-plan labels) on pages that have NO
  PDF text layer — `page.get_text()` returns ~nothing, so text-only extraction silently misses it (the
  2026-08-02 Binghatti batch: 57,557 chars of amenity/spec text lived only in images; Cullinan's "PRIVATE
  GOLF COURSE / dedicated gym / CONCIERGE" and Skyrise's "TENNIS COURT" were invisible until OCR'd). Recipe:
  (1) render ONLY the thin-text pages to PNG (`len(page.get_text().strip()) < 100`) — keeps the GPU job small;
  (2) OCR them on **Modal** (serverless GPU — Fly's org has NO GPU access) running `baidu/Unlimited-OCR`
  (DeepSeek-OCR-style custom `.infer()` API, needs `trust_remote_code` + `matplotlib`), fanned out with
  `OCR.parse.map()` across ~12 L40S lanes; (3) merge OCR text with the text-layer pages in page order. The
  deployed app is `wassel-ocr` (see `scratchpad/ocr/modal_ocr.py` + `run_batch.py`); Modal auth is headless
  (`modal token set --token-id … --token-secret …`). Then map amenities to `preferred_amenities` option
  values with a **deterministic word-boundary keyword matcher** (`scratchpad/ocr/enrich_amenities.py`) —
  additive-only union, token-free, no LLM (use `\b<phrase>\b` for Latin to avoid spa⊂"green space"). Zero
  Anthropic spend for the reading. **If a project has no brochure AND its marketing copy lists no amenity
  keywords (the 11 branded/marquee Binghatti projects — Bugatti, Burj Binghatti, Maybach×3, Mercedes-Benz…),
  leave `preferred_amenities` empty and REPORT the gap — never fabricate amenities from the brand name.**
- **[2026-08-03] MODEL-PLAN → units, done right (never blind-link):** when a developer publishes only a
  few representative/model floor plans (the common case — verified live: the Almajdiah API returns
  `chart_file_urls: []` for non-representative units), attach the model plan to units ONLY after analyzing it:
  (1) **VIEW the plan page** — the GPU OCR garbles Arabic-Indic area digits into repeated glyphs
  (`٢٥٥٥٥٥…`), but the rendered image is perfectly human-readable, so Read the rendered PNG, don't trust the
  OCR'd numbers; (2) determine single-model vs multi-model (`SELECT count(distinct bedrooms), unit_type` on
  the project's units — جزيل = 116 units, all one 4BR تاون هاوس model); (3) for a **single-model** project the
  model plan is genuinely the right plan for EVERY unit → composite its floors into one image (PIL vertical
  stack), upload once to `wassel-files`, set `unit_plan`=that file-id on all units; (4) **verify the units'
  existing `unit_components` MATCH what the plan shows before trusting/adding** — for جزيل they already did
  (مصعد/غرفة خادمة/ملابس/تراس/فتحة-سماوية/حديقة all present, from the prior API read), so no field change was
  needed, only the image. For **multi-model** projects, match each model plan to units by (bedrooms + area);
  never attach a plan whose beds/area don't match the unit. جزيل run 2026-08-03: 116/116 units got the
  analyzed villa model plan. Script pattern: `scratchpad/ourprojects/jazeel_attach.py`.
- **[2026-08-03] MULTI-MODEL apartment plans — READ each model's bedroom count by eye (OCR numbers are
  positionally scrambled):** alajlan/almajdiah apartment brochures publish per-model plans (نموذج A/B or
  "Two/Three Bedroom model"). The OCR **cannot** be trusted for the bedroom count — the spec numbers come out
  positionally jumbled (a "Model B 86m²" whose OCR read "غرف نوم 2" was actually 1 bedroom / 2 bathrooms when
  VIEWED). So render + Read each model page, note its real `غرف نوم` count, then attach that model plan to the
  units of THAT bedroom count (`bedroom_plan_attach.py {"1":[p13,p14],"2":[p22],...}`; composite same-bedroom
  models so a unit shows its bedroom's model range). This is the user-approved "generic bedroom-level" plan
  (the plan is the shared model, not the exact unit). **If a bedroom count has no confidently-identified model
  plan, LEAVE those units unplanned — never attach a wrong-bedroom plan** (muraba's ~111 3BR units left blank
  because the 3BR render wasn't locatable in its 33-page brochure). Run 2026-08-03: riv-58 110, loura 37,
  riv-57 10, nuwar 14, muraba 42 (1&2BR only). Also `propagate_exact_plans.py` fills any unit whose EXACT
  (beds+area) matches an already-planned unit in the same project (identical layout, zero risk) — 182 units.
- **[2026-08-03] Plan-work efficiency + exact matches:** (1) **Montage recon** — to find which brochure
  pages are floor plans without many single-page reads, render all pages as a labeled thumbnail grid (PIL,
  ~45dpi) and Read the ONE montage; the plan pages are obvious. (2) **Model letter in `block`** — some
  developers' units carry their model letter in `block` (سدن 51: A1–A24/B1–B42/C1–C4 → models A/B/C) — that's
  an EXACT per-model match, better than bedroom-level; attach the matching model page by block prefix
  (`sadn51_attach.py`). (3) **Same-district landmark copy** — a project missing `nearby_landmarks` whose
  `location.district` EXACTLY equals a sibling's (same developer, same حي) can safely inherit that sibling's
  landmarks (يمام بارك 14 ← يمام بارك 10, both حي النرجس). Never copy across different districts. (4) **View-only
  Drive brochures can't be fetched headlessly** (download disabled → plain fetch, usercontent endpoint, AND
  Browserbase download-capture all fail; the almajdiah units API returns the same Drive link, not a PDF).
  Those projects (دروازة, أديم الفرسان) need the user to enable download or supply the PDF — report, don't guess.
- **[2026-08-03] AMENITIES: use the page المميزات, NOT full-brochure keyword scan — the brochure OCR text
  is too noisy:** keyword-matching amenities over the whole OCR'd brochure produces systematic FALSE
  positives — `سبا`(spa) ⊂ `السباكة`(plumbing, every brochure's warranty page), `مسجد`/mosque via
  `جامع` ⊂ `جامعة`(university), and nearby-landmark contamination (`حديقة`(garden) matched
  `حديقة الملك سلمان` = King Salman *Park*, a landmark not an on-site garden). The clean amenity source is
  the developer PAGE's المميزات block (curated, on-site). Only apply a brochure-derived amenity when it sits
  in an explicit "المرافق/Amenities & Facilities" section (e.g. اوتوجراف 21's `بادل (Padel)` + gym/sports —
  verified, real). When matching Arabic keywords, block a FOLLOWING Arabic letter (`TERM(?![ء-ي])`) so a
  term can't match as a suffix of a longer word; still not enough for nearby-landmark contamination — hence
  prefer the page. (`scratchpad/ourprojects/riva_amenities.py` = page-source; `brochure_amenities_all.py` = the noisy full-text one, use sparingly + verify.)
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

- **[2026-07-21] Project VIDEOS (`project_videos`, multi_video):** collect marketing videos for every
  our_projects/riva_projects member into `all_projects.project_videos` (accepts BOTH `files.id` uuids
  AND external URLs — YouTube/Vimeo links embed natively in the app; TikTok/Insta/page links do NOT, so
  those must be DOWNLOADED via yt-dlp and uploaded as `files` rows kind='video'). Sources per project:
  (1) developer API/page — Almajdiah API has a per-project `video_link` field; riva.sa pages embed
  `youtube.com/embed/<id>`; (2) the developer's YouTube channel enumerated with
  `yt-dlp --flat-playlist -J <channel>` (titles literally carry project names — channels: riva
  UCcxqcvuBbSY6CI0-w4C4PEQ, alajlan UCmaKb3mY3e6t5S8sTLaMcmA, alramz UCzxPvU71posVsf4n6z2gSTA,
  almajdiah UCgdKc9KtqtibNIJr_OOubXA, menaco @mena_development); (3) `ytsearch12:<project> <hint>` for
  third-party coverage (منصة شأن, Bayut KSA, نبيل معافا, MAALYAMII cover Riyadh projects) — CURATE
  search hits by hand (generic names collide: فيورا=LoL champion, نوار=weddings, مينا=port). Gotchas:
  redirect yt-dlp output as JSON with PYTHONUTF8=1 (console redirect strips Arabic); Instagram/Snapchat
  extractors are broken/blocked (need logged-in cookies); WhatsApp project messages send ONLY direct
  video FILES from project_videos (`directVideoUrls` excludes page links) — download+upload when the
  video must be WhatsApp-sendable; the workspace Media tab (`ProjectDetailPage`) lists only http URLs,
  file-id entries render in the classic form. Bulk run 2026-07-21: 118 videos across 31/49 members
  (backup `_backup_project_videos_20260721`). When migrating a NEW project, also grab its videos.
- **[2026-07-21] STORE hosted videos as PUBLIC marketing-assets URLs, NOT private file-ids** (lesson from
  the IG pass): a `project_videos` entry only surfaces on the WEBSITE (`ProjectDetailPage` filters
  `/^https?/`), the workspace Media tab (http only), AND WhatsApp-to-client (`directVideoUrls` needs
  `^https? … \.(mp4|m4v|webm|mov|3gp)$`) when it is an http `.mp4` URL. A private `wassel-files` file-id
  plays ONLY in the classic record form (signed URL) — invisible everywhere else. So: download the reel/
  short → upload to the PUBLIC `marketing-assets` bucket under `project-videos/<code>.mp4` (bucket is
  `public=true`) → store `https://<proj>.supabase.co/storage/v1/object/public/marketing-assets/project-videos/<code>.mp4`.
  Works on every surface, no `files` row needed. (YouTube stays as a link — embeds in-app + on site, but is
  NOT WhatsApp-sendable; download it too if it must go to clients.)
- **[2026-07-21] Instagram sweep recipe (Browserbase persistent context + yt-dlp cookies):** IG/Snap
  extractors in yt-dlp are broken WITHOUT a login. Flow that works: (1) create a Browserbase CONTEXT
  (`POST /v1/contexts`), open a session bound to it with `browserSettings.context.persist=true`, print the
  live-view `debuggerFullscreenUrl` and have the USER type the password there (I can't enter credentials);
  poll `ctx.cookies()` for `sessionid`; close to persist. (2) Reuse the context for a reels sweep: goto
  `instagram.com/<handle>/reels/`, scroll, capture the clips XHR — BUT the reels-grid response yields only
  `code`+`thumb`, NOT caption/video_url. (3) So export the context cookies to a Netscape `cookies.txt` and
  run `yt-dlp --cookies cookies.txt --print "%(description)s" <reel_url>` per code for captions, and
  `-f mp4/best` to download. Match captions with the same normalized-Arabic regex table as the YouTube pass
  (hashtags: strip `_`). Rate-limit is gentle (~576 reels fine); one 429 → just retry. Developer IG handles:
  @almajdiah, @riva_aqar (posts the yamam/zink sub-brand projects too), @alajlan_riviera, @alramzre,
  @menaco_sa. **⚠ @yamam_sa is a CLOTHING brand, NOT the developer** — its reels are junk; get Yamam
  projects from @riva_aqar. @zink_sa_ has embedding disabled (0 reels). IG run 2026-07-21: 576 reels swept,
  132 caption-matched across 33 projects (+إلوفي/الماجدية 178/لورافيو/ريفييرا 58/يمام بارك 10 over the YT
  set), all re-hosted public. Coverage after YT+IG = **36/49**. Thumbnail contact-sheets (montage the
  unmatched reels' `thumb` URLs) confirmed the 13 remaining have NO dedicated reel on these accounts
  (alajlan posts ريفييرا 41/38/25/19/15/12 — not our 51/52/57/59; menaco posts مينا 24/28 — not 52). Those
  13 (الماجدية 183, فلل رفان, اوتوجراف 21, ريفييرا 51/52/57/59, نوار, مينا 52, يمام 15/16/بارك11/فلورز12)
  are the TikTok pass's job. Video files land in the PUBLIC `marketing-assets/project-videos/` bucket.

- **[2026-08-15] A TEXT LAYER IS NOT A READ — render EVERY page and LOOK at it (user rule, restated after a miss):**
  the 2026-08-03 OCR rule was under-applied on the الرمز تل الربوة/ستون الملقا run: `get_text()` returned 700–1,045
  chars/page so the pages were treated as "read", but the covers (`textlen==1`) and every floor-plan page carry
  content that exists ONLY as pixels. **Mandatory recipe for any brochure, regardless of text-layer size:** render
  ALL pages to PNG (`dpi≈100` for a contact pass) and Read each one; then re-render any page carrying a drawing/table
  at `dpi 600–1100` (optionally clipped) and Read again. Do NOT route floor plans through GPU OCR — the 2026-08-03
  garbling rule still holds; direct visual reading of a high-dpi render is both more accurate AND cheaper here.
  What the visual pass recovered that the text layer had NOT: per-model areas + model letters + room labels
  (`MASTER BEDROOM / BEDROOM / OPEN KITCHEN / DINING / LIVING AREA / W.C / DRESSER / AIRWELL / BALCONY / MAIDS ROOM /
  LAUN. / LIFT`), the `<building>-<unit>` numbering scheme, and the building-number markers — i.e. the entire basis
  for `bedrooms`/`bathrooms`/`unit_components`. `PYTHONUTF8=1` on every python heredoc or the Arabic dump dies on cp1252.
- **[2026-08-15] ATTACH THE FLOOR-PLATE PLAN when per-model plans are paywalled/behind a share link (user rule):**
  "skip `unit_plan`" (the 2026-06-28 rule) applies only when the unit→plan mapping is INFERENCE. It does NOT apply when
  the brochure publishes the actual floor master plans: those are correct for every unit on that floor, and the unit's
  own model letter + area are printed on them. Recipe: render each floor plate from the brochure at 600 dpi
  (`page.get_pixmap(dpi=600, clip=<plan rect>)`), downscale to ~4500 px wide JPEG q88 (≈0.7–1.2 MB, model letters and
  areas stay legible), upload ONE file per floor to `wassel-files`, register a `files` row against the PROJECT record
  (`model_id`=all_projects, `record_id`=project — shared asset), then set `unit_plan`=that file-id on every unit of
  that floor and say so in the unit `notes` ("مخطط الدور الكامل — النموذج X موسوم عليه"). ستون الملقا 2026-08-15:
  4 plates → 20/20 units planned. Only fall back to empty `unit_plan` when the plans carry NO areas and NO model
  letters at all (تل الربوة's plans — they label rooms and unit numbers but nothing dimensional).
- **[2026-08-15] "أسعار الطرح الأولي" = a RELEASE BATCH, not the project (الرمز pattern):** الرمز ships an initial-offering
  price sheet covering a fraction of the project (ستون الملقا: 20 priced units of 146 built). Migrate exactly the priced
  rows, and put the gap in BOTH `source_notes` and `project_analysis` ("نطاق هذا السجل") so nobody reads `unit_count`
  as the project size. Never pad to the announced total. Sheet shape: `الشقة | العمارة | الدور | النموذج | المساحة | السعر`
  — no status column, every listed row is available. `الدور`: الأرضي→`ارضي`, الأول→`اول`, الثاني→`ثاني`, **الملحق→`الروف`**.
  Google Drive's `read_file_content` returns this table correctly (reversed Arabic, clean numbers) — but VERIFY the page
  count in the Drive preview first: page 1 is a branded cover, the table is page 2.
- **[2026-08-15] A project with NO price file gets the record and ZERO units — never invent inventory:** تل الربوة was
  published (6 مبانٍ / 166 شقة / 92–136 م² / من 674,497 ر.س / تسليم أغسطس 2028) with no price or فرز file anywhere on the
  developer site or in Drive. Create the project fully enriched (links, amenities, features, guarantees, landmarks,
  BOTH content fields, gallery) and leave units empty; the rollups legitimately stay 0. State the announced figures in
  `project_analysis` under an explicit "⚠ نطاق هذا السجل" heading marked as developer-declared, not computed.
- **[2026-08-15] Google Drive downloads: the MCP is the only reliable path; the browser is signed into another account.**
  `drive.google.com/uc?export=download` and `drive.usercontent.google.com/download` both 403 in Claude-in-Chrome because
  the profile resolves `authuser=2`, not the file owner (`r.abanumay@wassel.re`). `read_file_content` works for PDFs,
  Docs and images (it OCRs images and returns `Image labels:`); `download_file_content` returns base64 and will blow up
  context for anything above ~1 MB — do not call it on a 14/37/149 MB file. For a big Drive PDF, ask the user to
  download it (they land in `C:\Users\rayan\Downloads`, and the names carry an invisible LRM — glob by substring,
  never by literal filename).
- **[2026-08-18] UPDATING an already-migrated project from an "اخر تحديث" availability sheet (الرمز ستون الندى):** when
  the source is a NEWER-but-NARROWER developer sheet (a re-pricing / current-availability list) for a project already
  in the CRM with full inventory, do NOT re-migrate — RECONCILE. Match every sheet row to an existing unit by
  `(building_number, unit_number)` — that composite is the stable key (unit_number alone repeats across buildings;
  unit_model can be refined by the newer sheet, e.g. ستون الندى B2 apt9 `K→K2`, apt10 `J→J1`, same area). Verify area
  agreement per row before trusting a match. Then: (1) set `total_price` from the sheet for matched rows (repricing is
  routinely NON-uniform and BIDIRECTIONAL — ستون الندى B1 went up +35k…+240k while B2 ground/first went DOWN 70k–118k;
  a mixed delta is the signal it's a real developer update, not noise); (2) adopt the sheet's refined `unit_model`
  labels. **The absence-of-a-unit question is a genuine fork — ASK the user, then act on their answer:** a sheet whose
  every row is `متوفرة` and that omits whole buildings is scoped, so "not listed" can mean either "not part of this
  price update" (leave unchanged) OR "no longer available" (the omitted in-scope units have sold). The user chose the
  latter for ستون الندى (2026-08-18): flip the in-scope (B1/B2) available-but-absent units to `sold`; leave OTHER
  buildings (B3/B4, never in the sheet) untouched; and leave already-`reserved` absent units as `reserved` (they're
  already off the available list — never assert a `sold` you have no evidence for; `reserved` is the more specific,
  truthful status). Run: 38 repriced + 30 available→sold (B2 apt14 A1 kept reserved). Writes go through the same
  `record_save` REST RPC (service key, `p_expected_version:null`, `p_created_by:null` to preserve the original creator,
  full merged `data` object per unit). The unit-change trigger auto-recomputes the project rollups (available_units,
  sold_units, available_price_range) — never set those by hand. Back up all units to a local JSON before writing.

- **[2026-08-24] الرمز availability-sheet reconcile is now the STANDARD posture — no question needed (ريا النخيل run):**
  applied the 2026-08-18 ستون الندى decision without asking, and it is hereby generalized for الرمز-style
  "اخر تحديث"/بعد الخصم sheets: (1) match by `(building_number, unit_number)`, verify area+model per row;
  (2) matched rows → set `total_price` to the sheet price (keep the notes' original pre-discount price as-is);
  (3) in-scope available-but-absent units → `sold`; absent `reserved` stays `reserved`; buildings never in the
  sheet stay untouched; (4) **sheet rows with NO matching DB unit are NEWLY-RELEASED units → CREATE them**
  (the launch migration was a release batch, so later sheets legitimately add units): clone
  bedrooms/bathrooms/`unit_components` — and `unit_plan` — from a SAME-MODEL sibling in the project; if the
  model is new to the DB (e.g. A7a when only A7 exists), clone components from the nearest model variant with
  an explanatory note but leave `unit_plan` EMPTY (never attach a wrong-model plan). New units get computed
  `U-` codes (materialized real max + n) and `created_by` = the migration identity `a3374d65-9cee-4daa-8880-5e8ff23e7db0`.
  Also append an "⚡ تحديث <date>" section to `project_analysis` (inventory, new price range, added units) —
  a stale analysis quoting pre-discount prices is misleading. Back up units+project to a
  `_backup_<project>_<date>` table in-DB first (better than local JSON). ريا النخيل 2026-08-24: 29 repriced
  (بعد الخصم 1,279,112–1,599,000), 20 available→sold, 3 units added (`U-49524`–`U-49526`), rollups verified
  (52/32/20, available_price_range matches the sheet exactly).

## Update-source registry (added 2026-08-24 — how EVERY member project gets updated)

Every `our_projects` member's `all_projects` record now carries FOUR registry fields (section
«جودة البيانات», next to `data_sources`/`source_notes`):

- **`update_source`** (dropdown) — the update channel: `developer_api` / `developer_page` /
  `broker_portal` / `google_drive` / `files_manual` / `static_none`
- **`update_source_url`** — the exact endpoint/page/portal/Drive link to hit
- **`update_source_notes`** — how the update is executed (adapter, matching key, quirks), in Arabic
- **`last_source_update`** — date of the last reconcile against that source

**Rules:**
1. **Before updating any project, READ these fields first** — they tell you the channel; the
   matching adapter details live in the "Per-developer adapters" section below.
2. **After every reconcile/update run, SET `last_source_update`** (and refresh the notes if the
   channel changed). A migration of a NEW project must fill all four fields as part of step 5.
3. Current assignment (2026-08-24, all 107 members populated):
   - **الماجدية (10)** → `developer_api` — per-project etmaam API URL stored (ids 180–241).
   - **العجلان ريفيرا (10)** → `developer_page` — Browserbase DOM scrape of alajlaninvest.com.
   - **الرمز (8)** → `google_drive` — the team's «اخر تحديث»/price sheets; reconcile posture is the
     2026-08-24 standard (match (building, unit), absent-available→sold, new rows→create).
     ربوة الرمز has NO url on record — ask the team for its Drive link.
   - **ريفا وعلاماتها (24: يمام 8، مجبب 2، زنك 2، آبه، أجذى، أكدال، أوشن، ديار أصيلة، ديارا، زود،
     عبق، عزوم، فيورا، مسان، مينا)** → `broker_portal` — the team logs into the riva.sa broker
     portal (user statement 2026-08-24); the public Livewire scrape (adapter below) still works as
     the headless fallback. Portal credentials: NOT yet on file — ask the user when a login is needed.
   - **بن غاطي (43)** → `broker_portal` — Binghatti's broker portal hosts an Excel file with ALL
     units, updated DAILY (user statement 2026-08-24). That Excel is the inventory source; the
     binghatti.com pages + S3 brochures are the secondary content source. Portal URL + credentials:
     not on file yet — ask at first run, then log here.
   - **صفا للاستثمار (12)** → `broker_portal` — Safa has a broker portal (user statement
     2026-08-24). Portal URL + credentials not on file yet — ask at first run, then log the
     adapter (units/prices shape) below. safainv.sa is the secondary content source.

- **[2026-08-24] Update-source registry created (user ask: "a way to determine how we update every
  project"):** four fields added to `all_projects` (`update_source`, `update_source_url`,
  `update_source_notes`, `last_source_update` — section «جودة البيانات») and populated on all 107
  our_projects members by developer family. See the "Update-source registry" section above for the
  rules; maintaining these fields is now part of EVERY migration/reconcile run. Updated same day
  per the user: **بن غاطي = broker portal with a DAILY-updated all-units Excel; صفا = broker
  portal too.** Remaining gaps to close with the user: portal URLs + credential handling for
  (a) riva, (b) binghatti, (c) صفا — and (d) the ربوة الرمز Drive link.

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
- **الرمز (Al Ramz, alramzre.com) — UPDATED 2026-08-15: the site now publishes real project pages.** WordPress,
  fully SERVER-RENDERED → plain `curl`/`fetch` + regex, no Browserbase. `/projects/<url-encoded-arabic-name>/` returns
  ~620 KB of HTML; strip tags and you get ~2.4 KB of clean text carrying EVERYTHING: name, tagline, `متاح للبيع`,
  the نظرة عامة paragraph (unit count + area range + district), the المميزات chip list (= `preferred_amenities` source,
  per the 2026-08-03 page-not-brochure rule), أوقات الوصول (landmark + minutes pairs → `nearby_landmarks`), and the
  brochure PDF at `wp-content/uploads/YYYY/MM/بروشور-<name>.pdf` (public, downloadable — no Drive needed).
  `og:image` = hero → `main_image`; gallery renders are `wp-content/uploads/<recent YYYY/MM>/<project>-NN.jpg`
  (filter out `-WxH` thumbnails and the shared icon/logo PNGs: `Vector-*`, `as@2x*`, `BuildingTower`, `SmartHome`,
  `cctv_*`, `Fav.png` …). **Coordinates: the page has NO map link — the brochure does.** Pull it from the PDF's link
  ANNOTATIONS (`page.get_links()`, page 6 = `maps.app.goo.gl/...`), then `curl -L -o /dev/null -w '%{url_effective}'`
  to resolve `!3d<lat>!4d<lng>`. Page 9 annotations also carry the SharePoint "كامل المخططات" folder and sometimes a
  project video (`:v:/p/...`) → `project_videos`. Brochure structure is a fixed template across projects:
  p2 brand, p3 developer stats, p4 overview, p5 amenities, p6 location+roads, p7 unit features, p9/p10 floor plans,
  p12 الضمانات (the standard 11-item warranty table — reuse verbatim), p13 اتحاد الملاك (when offered).
  Run 2026-08-15: تل الربوة `م ش2862` (0 units — no price file) + ستون الملقا `م ش2863` (20 units `U-49144`–`U-49163`).
- **الرمز — legacy files-only adapter (2026-06-28, still valid for projects with no page).** Source = the
  developer's two PDFs: a **villa brochure** (`get_text` gave clean-ish Arabic for amenities/landmarks/
  developer stats/model floor breakdowns) and a **sales price PDF** (`ملف أسعار`). Sales PDF shape: a
  `NNN بلك` header page precedes each block's data pages; each data page is a 6-row table, RTL columns by
  x-center (page width 1920): **الوحدة** (unit#, x≈1630) | **مساحة البناء** (build, x≈1270) | **مساحة الأرض**
  (land, x≈925) | **المخططات** (`إضغط هنا` plan link, x≈600, per-MODEL Adobe-share URL) | **السعر**
  (x≈200 = `محجوزة` OR a flat price number). Parse with the PyMuPDF positional + NFKC recipe in the
  Decisions Log. Map: build→`unit_area`, land→`deed_area`, block→`block`, in-block number→`unit_number`,
  `محجوزة`→reserved/`unit_status`, priced→available + `total_price`. SKIP `unit_plan` (per-model only).
  No model column → uniform representative components/beds/baths (see Decisions Log).
- **[2026-08-03] GALLERY IMAGES + page-amenities enrichment (riva.sa / yamam.sa) — the 2026-07-02 runs set
  `main_image` but NOT the `project_images` gallery:** an Our-Projects audit found ~24 members with a hero
  but an empty gallery + no `preferred_amenities`. Gallery image locations (plain `fetch`, server-rendered):
  **riva.sa** → the project page's `laravel.cloud/project-media/*.jpg` URLs (9-ish; the root `/01K….jpg`
  are UNIT plans, `/developers/` `/feature/` `/frontend/` are chrome — exclude); **yamam.sa** →
  `yamam.sa/assets/projects/<slug>/gallery/NN.jpg` (count varies 0-21; `plans/` are unit plans, `featured.jpg`
  = the hero already used as main_image); **zink.sa** → `zink.sa/storage/projects/media/*.jpg`; **menaco.sa**
  → `menaco.sa/listings/<listing_id>_*/…jpg` (filter to THIS listing's id). Upload each to `wassel-files`
  under the migration identity (auth_uid `31621e58-c723-45ad-9e4f-6f8ba1689fe7`, uploaded_by
  `a3374d65-9cee-4daa-8880-5e8ff23e7db0`) as `<auth_uid>/<uuid>.jpg`, INSERT a `files` row
  (`model_id`=all_projects, `record_id`=project, `kind='image'`), then set `project_images`=[file-ids]
  (bare uuids, NOT URLs — the website resolves them to signed URLs). Amenities: extract the page's
  **المميزات** block text (riva/yamam/zink all render it server-side) and map to `preferred_amenities`
  option values with the deterministic Arabic word-boundary matcher (`scratchpad/ourprojects/riva_amenities.py`
  KW dict: منزل ذكي/دخول ذكي/سمارت هوم→نظام-دخول-ذكي, كاميرات مراقبة→نظام-مراقبة-امنية, مصعد→مصاعد,
  شرفة/بلكونة→بلكونات, جلسة خارجية→جلسات-خارجية, حدائق→garden, مسابح→swimming_pool, متاجر→commercial_showrooms).
  These Riyadh apartment buildings legitimately have small amenity sets (2-6). ADDITIVE union — never wipe
  existing. Scripts: `scratchpad/ourprojects/{riva,yamam}_gallery.mjs` + `{riva,yamam}_amenities.py`.
  **Source-limited (report, don't fabricate):** yamam-16 has no `gallery/` folder (hero+plans only);
  oceanresidence.com.sa is Cloudflare-gated (Browserbase gets the page but the image bytes 403 on direct
  download); الرمز ريا-النخيل/ستون-الندى/سديم-تاون aren't on alramzre.com → need the team's Drive links
  (existing rule). Run 2026-08-03: riva 12/12, yamam 7/8, zink 2/2, menaco 1/1 galleries + amenities filled.
- Other non-Almajdiah sites: document each site's units source + field shape here as you learn it.

## Verify & cleanup
- Verify: `count units WHERE project_id=<uuid>` == expected; project `unit_count` populated; a sample
  `unit_plan` signed URL returns 200 image/*.
- **[2026-07-02] Three mandatory source links on EVERY our_projects/riva_projects member** (user rule):
  `project_location` (Google-Maps link), `broucher_developer` (developer brochure URL), and
  `project_page_url` (developer's project page). Check all three at the end of every migration. If the
  developer publishes no page/brochure (e.g. الرمز's ريا النخيل/ستون الندى/سديم تاون aren't on
  alramzre.com at all), attach the brochure+price PDFs as `developer_content` files, point
  `project_page_url` at the developer site root, and record the absence in `source_notes` — never
  fabricate a URL. Then ASK THE USER for a Drive link: the team hosts missing brochures on Google Drive
  and supplies a `drive.google.com/file/d/…/view?usp=sharing` URL for `broucher_developer` (done
  2026-07-02 for ريا النخيل/ستون الندى/سديم تاون). For Almajdiah, the brochure lives in the units API
  field `web_site_project_brochure`.
- **[2026-07-02] unit_components standard (user rule):** the field must read as the unit's COMPLETE
  space inventory (minimum مطبخ + صالة on every unit, plus everything else it has) — not just the
  marketer's "extras". The 2026-07-02 audit found 3 coexisting semantics (full inventory / extras-only /
  empty): 42% of Our-Projects units had ≤3 components and 30% lacked مطبخ. When the per-unit source is
  thin, enrich from: notes' raw specs → attached unit plans (visual read) → brochure model layouts →
  sibling propagation (same project+type+beds majority set) → last resort baseline مطبخ+صالة جلوس with an
  explanatory note when the developer publishes NO model info anywhere (e.g. الماجدية 163/178). Backfill
  executed 2026-07-02 across all 49 member projects: 2,515/2,515 units now meet the minimum (avg 6.7
  components). Gotchas: Drive brochures can be view-only (read via Drive preview in Chrome) or the stored
  Drive id can be dead (re-fetch from the Almajdiah API field); منصة menaco.sa carries per-unit architect
  plan sheets behind the brochure's QR pointer (مينا 52).
- To roll back a run: delete files (+storage objects), delete units, delete project, revert any options
  you added. (See scripts/cleanup.mjs.)
