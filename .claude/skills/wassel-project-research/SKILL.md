---
name: wassel-project-research
description: Research a Saudi real-estate project across nine required categories (pricing, market activity, supply, product specs, yield, location, demand/demographics, competition, regulatory) and produce a unified Arabic evidence table. Runs AFTER Paseetah (which the main thread handles) and fills the gaps Paseetah couldn't cover, then merges both into one consolidated CSV that downstream skills (wassel-presentation) consume. Use this skill whenever the user asks to research, verify, or build an evidence pack for a Saudi real-estate project — developer, marketer, district, pricing, inventory, competitors. Produces one Arabic markdown table (the same 15-column schema as paseetah-research) and invokes the merge script to write the final sources.csv.
---

# Wassel Project Research — Evidence Builder

This skill produces the **unified Arabic evidence pack** that downstream Wassel workflows (decks, proposals, sales plans) consume. It is the web-research leg of the pipeline; Paseetah is the other leg and runs before this skill in the main thread.

Two things this skill is strict about:

1. **Every claim has a source.** If a fact can't be sourced, the row is marked `غير موجود` (Not Found) — never invented.
2. **Scope is preserved.** District-level numbers never get promoted to project-level claims. Market-level never gets promoted to square-level.

The output is **one 15-column Arabic markdown table** (`web_research.md`) and a merged CSV (`sources.csv`) produced by the merge script.

---

## When to use this skill

- The user hands you a Saudi real-estate project (name, developer, location, brochure, listing link) and asks for research, analysis, or an evidence pack.
- Another skill (typically `wassel-presentation`) needs verified project data before it can run.
- The user asks to verify something specific — pricing, inventory status, developer history — for a KSA project.

**Don't use this skill for:**
- Pure market-level questions with no project attached (use `paseetah-research` directly).
- Building slides, proposals, or marketing content (use the relevant build skill after this one runs).

---

## Inputs you receive

When the subagent orchestrator invokes this skill, it gives you:

1. **Project brief** — name, developer, city, district, unit data, brochure link, etc.
2. **Path to the Paseetah output file** (already produced by the main thread), e.g. `./<slug>/market/paseetah.md`. Read it; don't re-query Paseetah. You have no Chrome tools in this context — the main thread owns Paseetah.
3. **Working directory** — where to write your output files.

If the Paseetah file is missing or empty, record that as a verification gap and continue. The merge script handles missing-file gracefully; your job is still to fill the 9 categories from web sources as completely as possible.

---

## The workflow — six stages, strict order

Don't compress the stages. The downstream quality depends on clean separation between what's verified, what's market-level, and what's a conflict.

### Stage 1 — Read the user brief

Extract from whatever the user provided:
- Project name
- Developer
- Marketer (may or may not be Wassel)
- City
- District (حي)
- Square (مربع) if known
- Project type (residential compound, tower, villas, offices, mixed-use)
- Unit types and counts
- Any numbers already given (prices, sizes, areas, launch date)

Treat everything here as an **initial brief** — not yet verified. Nothing moves into the evidence table without going through verification.

### Stage 2 — Read the Paseetah file

Open the file at the path the orchestrator gave you. It's a 15-column Arabic markdown table plus a الفجوات والملاحظات section. Note:

- Which of the 9 categories Paseetah covered well
- Which categories came back `غير متوفر` or behind the paywall
- Any conflicts Paseetah already flagged with cited sources

This shapes where your web research needs to work hardest. Paseetah is strong on pricing, transactions, absorption, demographics; typically weak on location (travel times), competitive landscape (specific competitors), regulatory, yield details, amenities.

### Stage 3 — Web research, organized by the 9 categories

**Analyze every file/link the user provided *in full* — top-to-bottom.** Scroll every section, expand every accordion, read footers, open downloadable brochures. Critical information often hides mid-page or in the footer, not in the hero section.

Then search broadly across:
- Official developer site
- Official project site (if separate)
- Brochures / PDFs (often linked from the project page footer)
- Listing platforms (Aqar, Bayut, property portals, Riva.sa)
- Google Maps / Apple Maps (for geography, nearby amenities, travel times)
- Official Saudi data sources: GASTAT (الهيئة العامة للإحصاء), REGA (الهيئة العامة للعقار), ministry data portals
- News articles (Arabic business press: Argaam, Mubasher, Al-Eqtisadiah)
- Videos (YouTube walkthroughs, promotional)

If the user restricted sources ("only use the brochure", "only use the official site"), obey that exactly.

**For each of the 9 categories, do at least one targeted search.** The target is one verified datapoint per cell that Paseetah left empty, plus independent verification of any Paseetah numbers that matter most (pricing, absorption).

| # | الفئة (Category) | Typical web sources |
|---|---|---|
| 1 | التسعير | Developer site, project brochure, Riva.sa, Bayut, Aqar |
| 2 | نشاط السوق | Paseetah usually authoritative — web only for cross-check |
| 3 | العرض | Developer/ROSHN announcements, news of competing launches |
| 4 | مواصفات المنتج | Brochure, project site, listing platforms |
| 5 | العائد والاستثمار | Rental comps on Aqar/Bayut, JLL/Knight Frank reports if public |
| 6 | الموقع | Google Maps, city/ministry maps, project brochure |
| 7 | الطلب والسكان | GASTAT, Paseetah usually has this; news articles for growth rate |
| 8 | المنافسة | Developer sites of competitors, Riva, news, social media of competing projects |
| 9 | التنظيمي | Amana (امانة) of the city, MoMRAH portals, ROSHN designations, zoning maps |

**Language preservation:** If a source is in Arabic, keep quotes and names in Arabic. Don't translate or transliterate project names.

### Stage 4 — Produce `web_research.md`

**Output format: one 15-column Arabic markdown table, identical schema to the Paseetah output.** This is what lets the merge script combine both sources by column.

```
| الفئة | المؤشر | القيمة | الوحدة | النطاق | الجغرافيا | الفترة الزمنية | تاريخ الاستخراج | المصدر الأساسي | رابط المصدر | المصدر الثانوي | حالة التحقق | مستوى الثقة | طريقة التجميع | ملاحظات |
```

Controlled vocabulary (same as paseetah-research — do not invent new values):

- **الفئة** — exactly one of: `التسعير` / `نشاط السوق` / `العرض` / `مواصفات المنتج` / `العائد والاستثمار` / `الموقع` / `الطلب والسكان` / `المنافسة` / `التنظيمي`
- **المؤشر** — Arabic metric name. Use the canonical seed labels (see the 45-row seed list in `scripts/merge_to_sheet.py`) **exactly** so the merge script can match them. Extra web-only metrics outside the seed list are allowed — they'll be appended as bonus rows.
- **القيمة** — exact value. Use `غير متوفر` for gaps.
- **الوحدة** — `ريال/م²`, `%`, `صفقة`, `شهر`, `م²`, `وحدة`, `كم`, `—` (none), etc.
- **النطاق** — `مشروع` / `مربع` / `حي` / `منطقة` / `مدينة` / `مقارنات` / `سوق` / `غير محدد`
- **الجغرافيا** — specific location
- **الفترة الزمنية** — e.g. `آخر ١٢ شهر`, `٢٠٢٤`, `لحظي`
- **تاريخ الاستخراج** — today's date (ISO)
- **المصدر الأساسي** — exact source name in Arabic when possible (e.g. `موقع المطور - رسم العقارية`, `Riva.sa`, `Bayut`, `الهيئة العامة للإحصاء`, `امانة الرياض`)
- **رابط المصدر** — full URL
- **المصدر الثانوي** — any second source that corroborates
- **حالة التحقق** — `موثق` / `متضارب` / `غير واضح` / `غير موجود`
- **مستوى الثقة** — `عالي` (primary source, explicit figure) / `متوسط` (secondary source, or primary source with caveats) / `منخفض` (social media, outdated, inferred)
- **طريقة التجميع** — `بحث ويب - رسمي` (official site / government), `بحث ويب - ثانوي` (listing platform, news), `نشرة المشروع` (brochure), `محسوب` (derived from other rows)
- **ملاحظات** — free-text Arabic — caveats, URLs of supporting pages, cross-source notes

Rules:
- **Every row needs a source.** URL or cited document. "General knowledge" is not a source.
- **Rows are atomic.** One fact per row. "Price is 1.2M and unit size is 180m²" becomes two rows.
- **Keep conflicting facts visible.** If the brochure says 180 units and the listing platform says 192, emit both rows with `حالة التحقق = متضارب`.
- **No derived calculations get a web source.** If you compute something from other rows (e.g. يارد-per-م² from total-land ÷ unit-count), mark `طريقة التجميع = محسوب` and cite the two input rows in ملاحظات.

### Stage 5 — Verify

For each row, `حالة التحقق` should reflect the source tier:

- **موثق** — confirmed by an authoritative source (official developer, official project site, official PDF, government portal).
- **متضارب** — two or more sources disagree. Both rows stay.
- **غير واضح** — source exists but is ambiguous (outdated listing, social media post without context).
- **غير موجود** — no source located. Row is kept only if the fact was claimed in the brief and you want to flag it as unverified; otherwise drop it.

**Evidence priority (strongest to weakest):**
Official project > official developer > official marketer > official PDFs > government portals (GASTAT, REGA, Amana, MoMRAH) > reputable listing platforms (Riva, Bayut, Aqar) > reputable news > Paseetah (secondary for project-specific facts, primary for market metrics) > social media / secondary sources.

Save the table to `./<slug>/research/web_research.md`.

### Stage 6 — Merge to CSV

Run the merge script. It takes both inputs and emits the consolidated `sources.csv` the downstream skills read.

```bash
python C:/Users/rayan/.claude/skills/wassel-project-research/scripts/merge_to_sheet.py \
    ./<slug>/market/paseetah.md \
    ./<slug>/research/web_research.md \
    ./<slug>/research/sources.csv \
    "<project name>" \
    "<ISO date>"
```

On Windows use the full path to Python 3.12 if `python` isn't on PATH — `C:/Users/rayan/AppData/Local/Programs/Python/Python312/python.exe`.

The script:
- Walks a fixed 45-row seed list (9 categories × 5 metrics)
- Matches each seed to rows from either source by `(الفئة, المؤشر)`
- Uses precedence: Paseetah wins numeric market categories; web wins project facts / regulatory / location
- Emits both rows marked `متضارب` when values disagree by >10% numeric or by string
- Fills missing seeds with `غير متوفر`, `حالة التحقق = غير موجود`
- Writes UTF-8-BOM CSV (so Excel and Sheets import renders Arabic correctly)

Read the stderr summary the script prints — `filled=N gaps=N conflicts=N`. If more than 20 of 45 rows are gaps, go back to stage 3 and do more research before handing off.

### Hand off

Stop here. Don't write slides, don't draft copy. Report to the orchestrator:

- Path to `sources.csv` — for the downstream sheet-upload and deck-build phases
- Paths to `paseetah.md` and `web_research.md` — kept for audit
- Fill/gap/conflict counts from the merge summary
- Top 3 blocking gaps (categories where Paseetah AND web both failed) if any

---

## Handling conflicts, missing facts, and weak sources

**Conflicting facts:** Emit both rows, both marked `متضارب`, both with their own source. The merge script keeps them paired. Downstream, the deck writer decides which to lead with — or to not claim either.

**Missing facts:** Either omit the row (if it's outside the 45 seed) or mark `حالة التحقق = غير موجود`. Never fabricate.

**Weak sources:** A single social-media post is not verification for a price claim. A listing on Bayut is evidence but not authoritative if the developer's own materials disagree. Use the evidence-priority ladder above. If only a weak source exists, `مستوى الثقة = منخفض`.

**Outdated sources:** Date-stamp anything that could have changed (prices, inventory). If the source is >6 months old for a fast-moving metric, mark `غير واضح` and try to find a fresher source.

---

## Language and formatting

- **Arabic content stays Arabic.** Don't translate حي النرجس to "Al-Narjis District" in any cell.
- **Numbers:** accept either Arabic-Indic or Western digits — the downstream deck builder normalizes them.
- **Dates:** ISO format (YYYY-MM-DD) unless the source explicitly uses Hijri, in which case keep both.
- **Sources:** full URL. If the source is a PDF downloaded from a page, cite the PDF URL in `رابط المصدر` and the page it came from in `ملاحظات`.

---

## Companion skills and pipeline position

- **`paseetah-research`** — runs BEFORE this skill, in the main thread. Produces `paseetah.md` that this skill reads.
- **`wassel-presentation`** — runs AFTER this skill. Takes `sources.csv` as input and maps its rows into the deck's content dict. See `wassel-presentation/references/sheet_to_deck_map.md` for the row → content-slot mapping.
- **`wassel-deck-review`** — reviews/patches the .pptx.

**Typical flow:**
```
 [main thread]   1. paseetah-research         → paseetah.md
 [subagent]      2. wassel-project-research   → web_research.md + sources.csv (this skill)
 [subagent]      3. upload sheet to Drive     (orchestrator step)
 [subagent]      4. wassel-presentation       → raw.pptx
 [subagent]      5. wassel-deck-review        → reviewed.pptx
 [subagent]      6. upload deck to Drive      (orchestrator step)
```

---

## One last reminder

**Never invent a number to fill a gap.** Wassel uses these evidence packs with institutional developers and sovereign-wealth-adjacent clients. A fabricated figure in the evidence pack propagates into the sheet and into the deck, which ends up in the client conversation — and that's the single failure mode this skill exists to prevent. If the number isn't verified, it's `غير موجود`. Let the downstream deck builder decide how to handle the gap.
