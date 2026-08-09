---
name: wassel-presentation
description: Build a brand-compliant Arabic RTL PowerPoint deck for Wassel Real Estate (وصل العقارية) from a verified project evidence pack. Runs AFTER paseetah-research and wassel-project-research have produced sources.csv. Takes the csv + the project brief and produces the 15-slide .pptx with exact Wassel colors, Amiri font, RTL layout, fixed slide structure, and mandatory wording rules. Use this skill whenever the user mentions Wassel, وصل العقارية, a Wassel marketing or sales plan, a project analysis deck for a Saudi real-estate project, or asks for a presentation in the Wassel style. Does NOT do research itself — if the sources.csv doesn't exist yet, run wassel-project-research first.
---

# Wassel Real Estate — Presentation Builder

This skill builds the Wassel-branded Arabic RTL `.pptx` deck from pre-verified project data. The build is deterministic, not creative — every deck looks like it came off the same assembly line. The skill's job is to take a `sources.csv` (produced by `wassel-project-research`) plus a project brief and execute the build.

**This skill does NOT do research.** Research is owned by:
- `paseetah-research` (market data from paseet.ai)
- `wassel-project-research` (web research, merge to sources.csv)

If `sources.csv` doesn't exist yet, invoke those skills first — in that order — before calling this one.

---

## Inputs

When invoked by the orchestrator, you receive:

1. **`sources.csv`** — the 15-column Arabic evidence table with ~45+ rows, produced by `wassel-project-research/scripts/merge_to_sheet.py`.
2. **Project brief** — the original user-provided facts (project name, developer, district, unit count, remaining units, amenities from brochure, etc.). Some deck fields come from here, not the sheet.

Use the **`references/sheet_to_deck_map.md`** file in this skill to map sheet rows into the build script's content dict. Do not invent your own mapping — the map is the canonical interface.

---

## The build — deterministic, not creative

The build is executed by `scripts/build_deck.py`. It exposes helpers (`addStrip`, `addHeader`, `addFooter`, `addDivider`) and produces a 16:9 .pptx with the layouts from the reference "مقام 17" deck.

**How to use it:**

1. **Read `scripts/build_deck.py` top comment** — it documents the content-dict schema line-by-line.
2. **Read `references/sheet_to_deck_map.md`** — it documents the sheet-row → content-slot mapping.
3. **Read `references/slide_templates.md`** — per-slide exact specs (positions, colors, font sizes) extracted from the reference deck.
4. **Build the content dict** by:
   - Copying identifier fields from the project brief (`project_name`, `district`, `city`, `year`, `footer_right`).
   - Parsing `sources.csv` and mapping rows to dict slots per `sheet_to_deck_map.md`.
   - Computing derived fields (e.g. `market.monthly_sold` from transaction count, `project.avg_price_millions` from price × area).
   - Composing the short-form fields (`insight_lines` ≤12 words each, `opportunity_bullets` ≤12 words each) per the templates in `sheet_to_deck_map.md`.
5. **Run `build_deck.build(content, output_path=...)`**. Output is the raw `.pptx`.
6. **Do NOT hand the raw pptx to the user.** Pass it to `wassel-deck-review` first.

Do not rewrite the build script per project. The reference deck is the spec; adjust content, not layout.

### Brand constants (non-negotiable)

```
copper   = #B8734F   (primary — headers, footer strip, accent strips)
sand     = #E8D9C0   (secondary — footer band, left strip on content slides)
brown    = #6B4226   (dividers, dark cards, "dark track" elements)
cream    = #F8F5E9   (page background)
gold     = #D9B57F   (top underline on brown header, dark-card top accent, H2 subtitle color)
charcoal = #3F3F3F   (body text on white cards)
white    = #FFFFFF   (cards, card-over-white text)

Font: Amiri — every text element, no exceptions.
Format: 16:9 (10" × 5.625").
RTL: enabled for Arabic paragraphs. Latin/numeric runs are LTR.
```

### Typography & text-rendering rules (enforced by the builder)

These aren't aesthetic choices — they're fixes for specific PowerPoint rendering bugs the builder handles for you. If you extend the builder, preserve these rules.

**1. Arabic-Indic digits everywhere.** Every Western digit (`0-9`) is converted to Arabic-Indic (`٠-٩`) before rendering. Project numbers, years, prices, percentages — all Arabic-Indic. Latin letters and building codes (`A/B/C/D`) are untouched. Rationale: Arabic-Indic digits are strong-RTL in Unicode bidi and inherit the surrounding Arabic direction. Western digits are strong-LTR and cause punctuation to drift.

**2. Arabic decimal/thousands separators inside Arabic numbers.** A `.` or `,` between two Arabic-Indic digits is converted to `٫` (U+066B) or `٬` (U+066C). Standalone commas in sentences (`حي النرجس، الرياض`) are left alone.

**3. RLM around em-dash / hyphen / underscore in Arabic context.** Any separator in Arabic text (em-dash, en-dash, hyphen, underscore, pipe) with whitespace on at least one side is wrapped with RLM (U+200F) marks and balanced spacing. Without this, PowerPoint's bidi resolution absorbs spaces into neighbors and renders `حي النرجس —مدارس` instead of `حي النرجس — مدارس`.

**4. Font = Amiri across all three OOXML slots.** Every text run sets `latin`, `ea`, AND `cs` (complex script) typeface to Amiri. PowerPoint renders Arabic from the `cs` slot; if empty, Arabic falls back to the theme default even though the dropdown says "Amiri".

**5. Line spacing = 1.5 when ≥8 words.** Automatic in `_add_text`.

**6. Text fits the shape — automatic shrink-to-fit.** Every textbox gets `<a:normAutofit/>` (text shrinks to fit shape) by default. This protects fixed-grid layouts from overflow when content is longer than expected. Opt-outs: `grow_to_fit=True` (shape grows to text) for boxes where layout-wrapping is intentional, `auto_fit=False` to disable both.

**7. Hyperlink styling — use `shape_hyperlink`, NOT `hyperlink`.** `wassel.re` in footers and closing slide must render **copper, no underline, not blue**. The run-level `hyperlink` parameter triggers PowerPoint's theme to override the run color. Use `shape_hyperlink` instead.

**8. RTL tables require reversed column data.** PowerPoint has no true "right-to-left table" flag. To render a table where the first logical column appears on the physical right, feed reversed column data.

### Slide sequence (15 slides, fixed)

```
 1  Cover (brown bg, logo, title, subtitle, project tag, year)
 2  About Wassel (3 KPI cards + 3 value cards)            [content layout]
 3  DIVIDER — تحليل مربع المشروع
 4  Market analysis (3 stat cards + insight strip + price range card)    [content]
 5  Competitor comparison (table)                                         [content]
 6  Project & opportunity (dark opportunity card + revenue card + specs)  [content]
 7  DIVIDER — الخطة التسويقية
 8  Marketing I — Opening event (audience bar + 3 equal element cards)    [content]
 9  Marketing II — Content & digital platforms (6 tiles + 4 platform cards) [content]
10  Marketing III — Measured outcomes (formula funnel + "why this works") [content]
11  DIVIDER — الخطة البيعية
12  Sales journey — 10-stage serpent, 2 rows × 5 cards                    [content]
13  Detailed sales journey — 10 numbered step cards in 2 columns          [content]
14  Sales plan by the numbers — formula-driven monthly table              [content]
15  Closing — "شراكة تسويقية متكاملة" + 3 cream cards + wassel.re
```

Slides 1, 3, 7, 11 are **divider-style** (brown background, no footer, copper Najdi/Diriyah triangular-notch accent strip on left edge). All other slides follow the **content layout** (sand left strip, brown header band with gold underline, cream background, sand footer with copper top-border and `wassel.re` left-aligned).

### Cover-slide tag pill rule

`<project_name> — <city>، <district>`. **City before district**, Arabic comma. Example: `مقام كورتيارد ١٧ — الرياض، حي النرجس`. Reversing is wrong and will be caught by the review skill.

### Formula-driven content (do NOT override via content dict)

Two slides derive numbers from fixed constants.

**Slide 10 — marketing funnel** (input: `marketing_targets.total_units_sold`)
- View → Lead = **1%** (fixed)
- Lead → Sale = **0.6%** (fixed)
- Derives: `leads_target = round(units / 0.006)`, `impressions = round(leads / 0.01)`

**Slide 14 — sales plan** (inputs: `sales_plan.leads_per_month` + `marketing_targets.total_units_sold`)
Fixed constants:
- Appointment booking: **6%**
- Appointment attendance: **40%**
- Natural walk-in visits: **2× appointment visits**
- Interested from total visits: **20%**
- Booking rate: **60%**
- Sale from booking: **80%**

**Two presentation modes — chosen automatically:**
- **Monthly-distribute (default)** — when the natural funnel walk from `leads_per_month` produces **≥ 4 sales/month** AND the project has **≥ 3 units**. Table shows one month's funnel row; header reads `الخطة البيعية الشهرية`; sales-row label is `المبيعات`.
- **Collapse-to-campaign** — fires when either (a) natural sales/month < 4 for a project with ≥ 3 units, or (b) the project has < 3 units (which can never yield 4/month). Table shows one campaign-total row: leads are scaled up so the derived sales equal `marketing_targets.total_units_sold`. Header reads `الخطة البيعية للحملة`; the formerly-monthly sales row is re-labeled `إجمالي المبيعات`. All other row labels stay the same because the funnel-stage names are scale-agnostic.

Rationale: small or slow-selling projects (6 units × 1 sale/month × 6 months) look weak as a monthly distribution. Collapsing the math into one visible campaign row shows the actual work — `868 leads → 6 sales` — which is both truthful and more presentable than `1 sale/month × 6 months` fragments.

**The sidebar KPI `أشهر لبيع المتبقي من المشروع` is always computed from the NATURAL monthly rate (not the collapsed table walk).** The collapse is a presentation choice for the funnel table only — it doesn't pretend the campaign ships in one month. Sidebar = honest schedule (`round(total_units / natural_monthly_sales)`, floor of 1); table = compressed math.

Every derived number uses `round()`. Percentages: 2 decimals for fixed constants, 1 decimal for derived indicators.

### Critical text rules (violations reject the build)

**Word enforcement:**
- Always `نادي` — never `نادٍ`.
- Always `نظام وصل` — never `Wassel CRM` or `CRM وصل`.

**Punctuation enforcement:**
- **No parentheses in body/callout copy — ever.** Never use `(...)` or the fullwidth variants `（...）` inside `market.insight_lines`, `project.opportunity_bullets`, `project.amenities`, `project.warranties`, competitor `ملاحظات` cells, or any other user-visible free-text copy. Replace with em-dashes: `— text —` (with a space on each side).
  - Wrong: `٨٬٠٧٠ ريال/م² — تحت متوسط الحي (١٠٬٢٠٢)`
  - Right: `٨٬٠٧٠ ريال/م² — تحت متوسط الحي — ١٠٬٢٠٢`
  - Allowed exceptions (non-free-text): URLs, legacy brand names where parens are part of the registered mark, and the builder's internal `\u200E(A/B/C/D)\u200E` building-code wrap which uses LRMs for bidi stability. Don't invent new exceptions.
- This rule is enforced by `wassel-deck-review` as an auto-fix pass.

**Exact phrases (never edit):**
- Slide 4 subtitle must contain: `مربع مشروع`. Full pattern: `تحليل مربع مشروع <project> <district> — <city>`. Never shorten.
- Slide 7 subtitle is exactly: `الهدف: صناعة الطلب، وجلب المهتمين`
- Slide 11 subtitle is exactly: `تحويل الطلب والاهتمام إلى مبيعات`

**Slide 4 KPI tiles are content-driven, not fixed slots:**
- The three tiles at the top of slide 4 are picked per-project from whatever is in the evidence. There are no mandatory indicators — not "إجمالي الوحدات في المربع", not "متوسط نسبة البيع", not "وحدات تُباع شهرياً". Those were placeholder labels from the reference deck; they are NOT the spec.
- Schema: `market.kpis = [{"value": "...", "label": "..."}, ...]`, exactly 3 items. Pick the three most presentable, story-supporting metrics for THIS project.
- Never render a tile as `—`. If a metric isn't in the evidence, pick a different metric that is.
- Every label must state its scope unambiguously (e.g. `... في الحي` for district-level, `... للمشروع` for project-level). A reader should never be able to mistake a حي figure for a project figure.
- Good slide-4 picks lean toward the three angles the insight card will reinforce (pricing, rarity/demand, size/differentiation). Bad picks are numbers the deck doesn't use elsewhere.

**Footer on every content slide:**
- Left: `wassel.re` copper, no underline, shape-level hyperlink to `https://wassel.re`
- Right: project context, e.g., `وصل العقارية  |  مقام كورتيارد ١٧`
- Sand (#E8D9C0) band with copper (#B8734F) 2-pixel top border.

### Icon rule for short-title cards

Cards with short titles need a brand-colored icon — use typographic Unicode symbols (♪ ◆ ✦ ★ ■ ● ♯ ≋ ▶ ◐ ✈ ❐ etc.) which take the font's color — NOT emoji (which render in their own colors). Exception: branded platform logos on slide 9 (Snapchat, TikTok, Instagram, LinkedIn).

### Layout constraints that fail silently if you skip them

- **Slide 8:** three equal element cards. Audience bar above with 5 pill-cards. Icons: typographic symbols in copper.
- **Slide 9:** 6 content cards with typographic icons in copper on the physically-left side. 4 platform cards use branded colors.
- **Slide 14:** monthly table uses rectangles (not `<a:tbl>`). Formula-driven from `sales_plan.leads_per_month`.
- **Slide 6 — opportunity bullets:** dark-brown "الفرصة الاستراتيجية" card's bullets follow this order:
  1. Demand indicator (units sold per month in the square)
  2. What drives sales in this square + whether our project has it
  3. Our project's sales rate vs square average
  4. Remaining inventory and its total value

### Why these rules are strict

Wassel uses these decks with institutional developers and sovereign-wealth-adjacent clients. The layout is part of the agency's trust signal. A deck that drifts — wrong color, Western digits mid-Arabic, "Wassel CRM", blue underlined wassel.re — looks like a lookalike, not the real thing. The build script encodes all of this; your job is to feed it clean, verified content.

---

## What good output looks like

1. The raw `.pptx` built by `scripts/build_deck.py` — saved to the project's working directory.
2. The reviewed `.pptx` produced by `wassel-deck-review` running on the raw file.
3. The reviewed file is what gets uploaded to Drive by the orchestrator.

Do NOT invent numbers to fill a slide. If a sheet row says `غير متوفر` for a slot the deck needs, either let `build_deck.py` render the `—` placeholder, or drop the bullet/card entirely (see sheet_to_deck_map.md "Missing data handling" section).

---

## Companion skills and pipeline position

This skill sits in the middle of the pipeline:

```
 [main thread]   1. paseetah-research          → paseetah.md
 [subagent]      2. wassel-project-research    → web_research.md + sources.csv
 [subagent]      3. orchestrator uploads sheet (parent agent step)
 [subagent]      4. wassel-presentation         → raw.pptx       ← THIS SKILL
 [subagent]      5. wassel-deck-review          → reviewed.pptx
 [subagent]      6. orchestrator uploads deck  (parent agent step)
```

- **`paseetah-research`** — market data upstream
- **`wassel-project-research`** — web research + merge upstream; produces `sources.csv`
- **`wassel-deck-review`** — runs on this skill's output; auto-fixes mechanical drift, reports judgment calls

---

## Reference files shipped with this skill

- `references/sheet_to_deck_map.md` — canonical mapping from `sources.csv` rows to content-dict slots. **Load-bearing.**
- `references/slide_templates.md` — per-slide exact shape specs (positions, colors, font sizes).
- `assets/wassel_logo_white.png` — the only logo the skill ships; don't swap.
- `scripts/build_deck.py` — the builder. `build(content: dict, output_path: str)` entry point. Schema documented at top of file.

---

## One last reminder

**Never let the deck invent numbers.** If `sources.csv` says `غير متوفر` for a metric, the deck either (a) omits that card and keeps the slide structurally whole, or (b) shows the card with the builder's `—` placeholder. Fabricating a "reasonable-looking" number is the single failure mode that gets a Wassel deck thrown out.
