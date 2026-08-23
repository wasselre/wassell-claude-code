---
name: client-study
description: >
  Produce a client-facing, Wassel-branded Arabic real-estate market study as a
  PDF, answering the specific question a client raised in their WhatsApp chat
  (e.g. "this project seems overpriced for its land size", "district X gives me
  more space than district Y — which is better?"). Use whenever the user pastes
  an app.wassel.re chat/client URL and asks for a study (دراسة), when a rep
  promised a client a دراسة in chat, or when the user asks to compare a
  project's price to the market or one district/area against another for a
  specific client. Reads the full chat + client record + live market_listings +
  projects/units + geo landmarks from Supabase, runs the query library with
  data-trap checks, renders a 3–4 page A4 PDF via the brand scaffold, verifies
  it visually, and drafts the WhatsApp message that accompanies it.
---

# Client Study — دراسة عقارية للعميل

Turn a client's real question from WhatsApp into a branded, data-backed Arabic
PDF study they can be sent directly. Two reference studies shipped 2026-07-22:
"ساندستون ريزيدنسيز vs سوق النرجس" (project-vs-market pricing) and "المهدية vs
الجبيلة" (district comparison incl. landmark distances).

**The quality bar:** the client's instinct is engaged honestly (validated,
then reframed with numbers), every number comes from live data with a stated
sample size, and the layout survives visual inspection. A beautiful wrong
study is worse than no study — the data-trap checklist below is not optional.

## Inputs

- A chat URL `https://app.wassel.re/model/chats/<record-id>` (or a client URL /
  phone). Supabase project id: `zhqqsxwealdwqzrbpwyv` (via the Supabase MCP).
- The chat record's `data.wid` gives the `chat_messages.chat_wid`;
  `data.client_link` gives the client record id.

## Headless runs (app-triggered via claude_jobs — read this FIRST when headless)

When this skill runs from the runner daemon (`scripts/claude-study-runner.mjs`)
there is NO human and NO authenticated Supabase MCP (it needs a claude.ai
OAuth flow that cannot happen headless). Rules for that mode:

- **All DB reads go through the bundled helper** (service-role, read-only):
  `node .claude/skills/client-study/assets/db_query.mjs "SELECT ..."` — one
  statement per call, rows come back as JSON. Try the Supabase MCP first if it
  responds; on ANY auth/availability error switch to the helper immediately —
  do not retry the MCP or print OAuth URLs.
- **Never wait for input.** Make every judgment call autonomously per this
  skill; put anything you would have asked the rep into `heads_ups`.
- **The result sentinel is a hard contract**: valid strict JSON, and every
  path (`pdf_path`) written with FORWARD slashes (C:/Users/...) — raw
  backslashes are invalid JSON escapes and break the runner's parser.
- Skip the copy-to-Downloads step; the runner uploads the PDF itself.

## Step 1 — Read EVERYTHING first (never skip)

1. Chat record → wid, client_link.
2. **The full transcript**, oldest→newest (`chat_messages` by `chat_wid`).
   You are looking for:
   - **THE question** — usually in the client's last substantive messages.
     Quote it (paraphrased politely) in the study's سؤال الدراسة box.
   - What was already offered and **why each offer was rejected** (age?
     district? price? size?) — rejections define what "good" means to them.
   - Any **factual claims the rep made** (developer names, prices) — verify
     them against the DB; if wrong, use the correct fact in the study without
     calling out the error, and TELL THE USER separately.
   - Whether a study was **promised** and with what scope/deadline.
3. Client record → stated preferences (budget, type, areas, districts,
   location_items polygon). Note where chat statements are newer than the
   record (chat wins; suggest updating the record).

## Step 2 — Classify the study & agree the skeleton

Common shapes (compose if needed):
- **Project vs market**: is project X overpriced for its class? → district
  median price/m² for the matched comp class, per-unit premium %, what the
  premium buys, honest alternative project, negotiation pointer.
- **Area vs area**: X vs Y → per-m² medians for the client's size band, supply
  depth (# listings), what the budget buys in each, real examples both sides,
  landmark distances, tradeoffs, recommendation by priority.

Structure that works (3–4 A4 pages, never more):
1. سؤال الدراسة (.q) → خلاصة الدراسة (.verdict) → headline stats (.stats or
   key table) → the subject's numbers vs market.
2. Visual bars (.bars) + real comps table(s) with street names.
3. (Optional, **max one page**) landmark distances table + خلاصة مكانية.
4. Tradeoff cards (.duo) + alternative (.alt) + التوصية (.verdict).

## Step 3 — Query library (adapt, don't invent from scratch)

Resolve the district id first: `districts` table (`name_ar ~ 'حي X'`), or take
it from the subject project's `data.location->district`. All market queries run
on the `market_listings` model (unfrozen JSONB in `records`).

**Market stats for a comp class** (THE core number — always report n):
```sql
-- villas, one district, active sale ads, sane prices; band = subject's class
SELECT count(*) AS n,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (data->>'price_per_m2')::numeric)
    FILTER (WHERE (data->>'price_per_m2')::numeric BETWEEN 1000 AND 40000)) AS median_ppm2,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY (data->>'price_per_m2')::numeric)
    FILTER (WHERE (data->>'price_per_m2')::numeric BETWEEN 1000 AND 40000)) AS p25,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY (data->>'price_per_m2')::numeric)
    FILTER (WHERE (data->>'price_per_m2')::numeric BETWEEN 1000 AND 40000)) AS p75
FROM records WHERE model_id = (SELECT id FROM models WHERE name='market_listings')
  AND data->'location'->>'district' = '<district-uuid>'
  AND data->>'property_type' = 'فيلا'          -- or شقة / دور ...
  AND data->>'listing_type' = 'sale' AND (data->>'is_active')::boolean
  AND data->>'age' = 'جديد'                     -- match the subject's age class
  AND (data->>'area')::numeric BETWEEN <lo> AND <hi>
  AND (data->>'price')::numeric BETWEEN 300000 AND 30000000;
```

**Comps table rows**: same filters + `quality_grade IN ('A','B')`, `ORDER BY
abs(ppm2 - median)` or `quality_score DESC`, LIMIT 6–8. Show street_name, area,
bedrooms, age, price, ppm2.

**`quality_grade` means AD quality, NOT property quality** (critical — user
correction, study #3). The scraper's `quality_grade` (A/B/C/D) / `quality_score`
scores the *listing*, not the home: اكتمال البيانات (30), الوسائط صور/فيديو (25),
الوصف والمميزات (20), الموثوقية والترخيص (15), حداثة الإعلان (10). So A/B = a
complete, licensed, media-rich, recent AD — it filters out junk/incomplete/
mislabeled listings so a price floor is trustworthy, but it says NOTHING about
finish or condition. **Never label a `quality_grade`-filtered figure «جيدة» /
"good apartment"** — that implies property quality. Label such a floor
**«أدنى سعر موثّق»** (or «أرخص شقة بإعلان موثّق») and always add the footnote:
*«الموثّق = إعلان مكتمل البيانات ومرخّص، لاستبعاد الإعلانات الناقصة أو المضلِّلة —
وليس تقييماً لحالة الشقة.»*

**Subject project + units**: `all_projects` record (available_price_range /
available_area_range / avg_price_per_m2 are trigger-maintained stored rollups —
trust them); per-unit detail from the `units` model
(`data::text LIKE '%<project-id>%'`) — unit_area is LAND area.

**Competing projects**: all_projects with `available_units > 0`, same district,
`available_price_range->>min <= budget`. Quote the **available**-range family
only (never all-unit ranges) per repo rules.

**⚠️ ALWAYS city/region-scope `all_projects` to the CLIENT'S city — verify, never
trust the Arabic district name** (hard rule — user caught a Jeddah + a Qassim
project served to a Riyadh client, study #3). District NAMES repeat across
cities: حي الصفا, حي الصوارى, حي الفاروق, حي الريان all exist in Riyadh AND
Jeddah/Qassim. Filtering `all_projects` by budget alone silently pulls in
same-named districts in the wrong city. Every projects query MUST
`JOIN districts d ON d.id = (p.data->'location'->>'district')::uuid` and filter
`d.city_name_ar = '<client city>'` (or `d.region_name_ar`). Before listing ANY
project in the study, confirm its `city_name_ar` matches the client's city and
its `center_lat/lng` is where you claim — a project you call "قريبة" must
actually be in that city. Never describe a project's location from its district
name alone.

**Landmark distances** (client asked "which is closer?"): `geo_elements`
(element_type: hospitals, malls, universities, landmarks, lifestyle,
business_zones, airports_transport) + `district_boundaries`
(`district_record_id`, PostGIS `geom`):
```sql
-- ST_Distance(ST_Centroid(boundary)::geography, ge.geom::geography)/1000 → km
-- For an area with NO boundary row: centroid = avg lat/lng of its listings.
```
Pick 5–7 client-relevant anchors (nearest hospital, nearest mall, الدرعية,
جامعة, البوليفارد, كافد, المطار) and ALWAYS footnote "مسافات مباشرة".

**Coverage-gap fallback** (e.g. الجبيلة outside city geo): filter listings by
`data->>'title' ~ 'اسم المنطقة'` — the scraper often catches areas the geo
tables don't. Verify the centroid clusters tightly (stddev of lat/lng) before
using such a set for distances.

## Step 4 — Data-trap checklist (all mandatory)

- **Outlier exclusion**: a comp/project at less than ~60% of the district
  median almost certainly is a different product (shell finish, mislabeled
  district, build-up vs land area). Exclude it; don't headline it.
- **Bound everything**: ppm2 1,000–40,000; price 300k–30M. Aqar data has junk.
- **Centroid sanity**: before publishing any distance from a listings-derived
  centroid, check lat/lng stddev is small and the point is where the area
  actually is. (الجبيلة = 24.91, 46.42 — NW beyond الدرعية.)
- **Cross-check chat claims**: developer names, prices, statuses said in chat
  vs the DB. The study states the truth; the rep gets a private heads-up.
- **Duplicated-message history**: chat_messages had a WAHA-migration dupe wave
  (cleaned 2026-07-22); if counts look doubled, dedupe by (flow, date, body).
- **unit_area is land**, `price_per_m2` in listings is price/land-m². Never
  mix land and build-up areas in one comparison.
- **Counter-findings stay in**: if a number favors the "other side" (e.g.
  المطار أقرب للجبيلة), keep it — one honest row buys the whole study's
  credibility.

## Step 5 — Write the study (language & content rules)

- Arabic, client-facing, Saudi-polite. Use **متوسط**, never وسيط (user rule).
- Arabic-Indic numerals (١٢٬٦٠٠) everywhere; wrap numbers in `class="num"`.
- Validate the client's instinct FIRST ("ملاحظتك صحيحة..."), then reframe.
- Always state sample sizes ("٧١٧ إعلاناً نشطاً") — numbers without n are
  opinions.
- Before any unit-comparison table: a 2–3 line intro of the available
  units/models (user rule).
- Do NOT include: sales/inventory status ("بِيع ٣ من ٧"), developer/marketer
  attribution lines, "بدون سعي" — user removed all of these (2026-07-22).
- **ALWAYS flag off-plan projects** (hard rule — user standing preference). Any
  project sold «على الخارطة» / under construction (not ready-to-hand-over) MUST
  be labeled **«على الخارطة»** inline next to its name/row EVERY time it appears
  — never omit it. Check each `all_projects` record's status/delivery field
  before listing it; if a project is off-plan and you don't say so, the study is
  wrong. Ready units say nothing special; off-plan is the flag that must show.
- **Our projects (`all_projects`) are ones Wassel MARKETS, not builds.** Never
  write «من تطويرنا» / «طوّرناها» / "we developed" — factually wrong. And even
  when the user asks to feature our projects, present them **neutrally as
  market options that fit the budget**, never «لدينا» / «مشاريعنا» / a push the
  client can feel is steered. Phrase like «تتوفر مشاريع سكنية جديدة ضمن ميزانيتك
  في أحياء قريبة» and let the numbers make the case. (User correction, study #3.)
- Every stats table/section gets a `.note` with the source + comparison class.
- Footer sources line: "تحليل N إعلاناً نشطاً في <الحي> (<شهر سنة>). الأسعار
  استرشادية وقابلة للتغير."
- End with a concrete next step (زيارة، مقارنة ميدانية، تفاوض) — a study
  without a call-to-action is a dead end.

## Step 6 — Render, VERIFY, deliver

1. Write the body fragment (only `<div class="page">` blocks, `{logo}`
   placeholders in headers) to `<name>_body.html` in the scratchpad.
2. `python <skill>/assets/render_study.py <name>_body.html <name>` — produces
   the PDF + a tall verification screenshot.
3. **Read the screenshot.** Check: no content under the footer, no cut-off
   sections, bars proportional, tables not overflowing. A `.page` is fixed
   297mm with overflow:hidden — anything past it silently disappears. If a
   page overflows, move a section to a new page (renumber page X من Y).
4. Copy the PDF to `C:\Users\rayan\Downloads\<arabic-name>.pdf`.
5. Give the user: the path, a chat-ready **WhatsApp summary message** in the
   rep's tone (short, validates the client, 2–3 headline numbers, ends with
   the visit/next-step offer), and any private heads-ups (wrong claims in
   chat, record fields worth updating).

## Decisions Log (META-RULE: append every user correction here)

- 2026-07-22 · Terminology: **متوسط** not وسيط — user correction on study #1.
- 2026-07-22 · Removed from client-facing studies: project sales status
  ("بِيع ٣ من ٧ وحدات"), developer/marketer attribution note, "بدون سعي".
- 2026-07-22 · Add a brief intro of available units/models BEFORE the
  units-vs-market comparison table.
- 2026-07-22 · Add-on sections requested mid-flight (e.g. landmark distances)
  get **max one page**, kept simple: one table + one خلاصة box.
- 2026-07-22 · Landmark distances live in `geo_elements` + PostGIS
  `district_boundaries` (key: `district_record_id`). الجبيلة/العمارية/الدرعية
  have NO district rows (outside Riyadh city admin boundary) — use the
  listings-title fallback + centroid sanity check.
- 2026-07-22 · Study #1 verdict pattern that landed well: "إحساسك دقيق
  جزئياً + النطاق المعتاد + وش يبرر الفرق + بديل صادق + توصية حسب الأولوية".
- 2026-07-22 · Keep honest counter-rows (المطار أقرب للجبيلة) — user approved.
- 2026-07-22 · Deployment decision: stays in Claude Code (user call). Revisit an in-app button + worker queue (deck-pipeline shape: study_jobs + SQL tool + Chrome-in-Docker + vision verify) only if study volume makes the rep wait on sessions.
- 2026-07-23 · Headless lessons from acceptance runs #1/#2: the Supabase MCP is unauthenticated in runner sessions (prints an OAuth URL and dies) → added `assets/db_query.mjs` + `claude_runner_sql` read-only RPC; sentinel JSON broke on Windows backslash paths → forward slashes required + runner parses leniently.
- 2026-08-23 · Study #3 (منار, budget-not-enough): (a) `quality_grade` is AD quality, not property quality — label a grade-filtered floor «أدنى سعر موثّق» with the footnote, never «جيدة» (see query library). (b) `all_projects` = projects we MARKET, not build — never «من تطويرنا»/«لدينا»; feature them neutrally as budget-fitting market options even when the user asks to show them (see Step 5 rules). (c) **CITY-SCOPE `all_projects` — user caught a جدة (حي الصوارى) + a بريدة/القصيم (حي الريان) project served to a Riyadh client** because the projects query filtered by budget alone. District names repeat across cities; ALWAYS JOIN districts and filter `city_name_ar`/`region_name_ar` to the client's city, and verify each recommended project's city before listing it (see query-library hard rule). (d) **ALWAYS flag off-plan** — pull `construction_status`/`project_status` for every `all_projects` row; `under_construction`/`تحت-التطوير`/`available_on_map` → label «على الخارطة» inline on every appearance; `ready`/`available` → ready. Never omit the off-plan flag.
