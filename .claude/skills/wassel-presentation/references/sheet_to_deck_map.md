# Sheet → Deck Mapping

This reference tells the subagent exactly how to turn `sources.csv` rows into the `content` dict that `build_deck.py` expects.

**Contract:** rows in `sources.csv` are keyed by `(الفئة, المؤشر)`. The build script's content dict has fixed slots. The mapping below is the one-to-one (or one-to-computed) link between them.

Any sheet row not listed below is **preserved in the sheet** but **not rendered on a slide**. That's deliberate — categories 5 (yield), 7 (demographics), 9 (regulatory) exist for audit completeness even though the current 15-slide deck doesn't have cards for every metric.

If you want a new slide card to pull a currently-unmapped row, that's a spec change — do it by editing `build_deck.py` and adding a mapping entry here, not by ad-hoc parsing.

---

## Direct mappings (sheet row → content slot)

| Sheet row `(الفئة, المؤشر)` | Content dict key | Used on | Transform |
|---|---|---|---|
| (التسعير, متوسط سعر المتر) | `market.avg_price` — when expressed as price/m² | Slide 4 price-range card | Strip unit (`ريال/م²`) from القيمة. Use the per-unit `avg_price` below for the large avg-unit price figure. |
| (التسعير, نطاق السعر (أدنى – أعلى)) | `market.price_range_min` + `market.price_range_max` | Slide 4 price-range card | If القيمة is a hyphenated range like `1,490,000 - 2,090,000`, split on `-`. If two separate rows exist (one for min, one for max), use each. |

## Slide 4 KPI tiles — `market.kpis` (3 items, content-driven)

**There are no fixed KPI names on slide 4.** The three tiles are picked per-project from whatever the evidence actually contains. Labels like "إجمالي الوحدات في المربع", "متوسط نسبة البيع", "وحدات تُباع شهرياً" were placeholders from the reference deck — they are NOT the spec.

Schema (from `build_deck.py::slide4_market`):

```python
"market": {
    "kpis": [
        {"value": "10,202", "label": "متوسط سعر متر الدور في الحي"},
        {"value": "173",    "label": "متوسط مساحة الدور في الحي"},
        {"value": "7",      "label": "صفقات الدور خلال 12 شهر"},
    ],
    ...
}
```

### How to pick the 3 KPIs

1. **Look at the sheet's filled rows** — scan every `(الفئة, المؤشر)` pair where `القيمة` is a real number (not `غير متوفر`). The good candidates sit in categories `التسعير`, `نشاط السوق`, `العرض`, `مواصفات المنتج`, `العائد والاستثمار`.
2. **Favor numbers that support the slide's storyline.** Slide 4 exists to argue "the market supports this project" in three quick tiles, which the insight card then explains. The three tiles should each set up ONE positioning angle — pricing, rarity/demand, and product-fit (size / amenities / finish) is a common triplet. Don't pick three pricing metrics.
3. **Every label must state its scope explicitly** — `... في الحي`, `... في المربع`, `... للمشروع`, `... للوحدة`. Never leave it ambiguous. A reader must never be able to mistake a حي figure for a project figure.
4. **Every value must be presentable at 42pt copper-bold** — that's a big glyph. Percentages, small integers (≤ 4 digits), Arabic-Indic thousand-separated numbers (`١٠٬٢٠٢`) all work. A very long string like "178 - 269 م²" is too wide for the tile — pick a single number instead (midpoint 223).
5. **Never render a tile as `—`.** If the obvious metric isn't in the evidence, pick a different metric that IS. Zero dead tiles on slide 4 — if you have fewer than 3 usable metrics from the sheet, go back to research, don't ship a gap.

### Examples of good triplets by project profile

- **Underpriced boutique project in a scarce segment** (e.g. ادوار العليا, 6 وحدات دور):
  - متوسط سعر متر <نوع> في الحي — anchors "below this" story
  - متوسط مساحة <نوع> في الحي — anchors "bigger than this" story
  - عدد صفقات <نوع> في ١٢ شهر — anchors rarity/liquidity story
- **Larger development in a high-activity district:**
  - إجمالي الوحدات في المربع
  - متوسط نسبة البيع في الحي
  - وحدات تُباع شهرياً في الحي
- **Yield-driven investor pitch:**
  - العائد الإجمالي للحي
  - متوسط الإيجار السنوي للمتر
  - عدد عقود الإيجار النشطة

Pick the triplet whose numbers tell THIS deck's story, not a default.

## Slide 4 `insight_lines` (two punchy lines, each ≤ 12 words)

EXACTLY 2 lines, each ≤ 12 words (ideally ≤ 8). The card is sized for one-liners, not sentences.

**NO PARENTHESES.** This is a hard rule from `SKILL.md → Critical text rules → Punctuation enforcement`. Replace `(...)` with `— text —` (em-dashes with spaces). Enforced by `wassel-deck-review` as an auto-fix.

Compose the two lines from top-level findings. Each line typically pairs one number with one framing clause:

1. **Line 1 — the pricing framing.** Template: `<avg price/m²> — <scope label> — <district avg>`. Example: `٨٬٠٧٠ ريال/م² — أقل بـ ٢١% من متوسط الحي`. (Note: no parens around the comparison number.)
2. **Line 2 — the market activity framing.** Template: `<transactions count> صفقة في <window> — <market state adjective>`. Example: `سوق رقيق — ٧ صفقات دور فقط في آخر ١٢ شهر`.

Do NOT concatenate full sentences from paragraphs. Do NOT include multiple clauses per line. Keep each line a six-to-ten-word headline. No parens anywhere.

---

## Slide 5 — competitors table (from category 8)

`competitors.rows` is a list of 6-cell arrays. Pull from the competitive-landscape rows of the sheet:

- Rows where `الفئة = المنافسة` and `المؤشر = المشاريع المنافسة المباشرة` usually hold a list of projects in `القيمة` or `ملاحظات`. Each competitor becomes one row in the table.
- Columns (right-to-left reading order per build_deck logic): `المشروع | المطوّر | عدد الوحدات | نسبة البيع | متوسط السعر | ملاحظات`.
- Fill cells from additional sheet rows per competitor if they exist; otherwise use `—`.
- `competitors.footnote` — pull from `الفئة=نشاط السوق, الفترة الزمنية` of the primary source so the table's time-window is transparent.

---

## Slide 6 — project + opportunity (mixed: brief + categories 4, 7, 8)

| Content key | Data source |
|---|---|
| `project.location` | From the project brief (user-provided), not from the sheet. Sheet's `(الموقع, *)` rows may be useful to add context in the notes. |
| `project.area_range` | From the project brief. If absent, use sheet's `(مواصفات المنتج, متوسط مساحة الوحدة)`. |
| `project.price_range` | From sheet's `(التسعير, نطاق السعر)` formatted as `<min> الى <max> ريال`. |
| `project.unit_total` | From the project brief (user-provided). |
| `project.units_available` | From the project brief (user-provided). |
| `project.amenities` | From `(مواصفات المنتج, المرافق)` in the sheet. |
| `project.warranties` | From `(مواصفات المنتج, مستوى التشطيب)` or the brochure in ملاحظات. |
| `project.opportunity_bullets` (4 items, each ≤ 12 words) | **Composed** from sheet findings: one pricing advantage bullet, one demand/absorption bullet, one amenity bullet, one numeric-inventory bullet. See template below. |
| `project.expected_revenue` | **Computed** from remaining units × avg price. |
| `project.remaining_units` | From the project brief. |
| `project.avg_price_millions` | Computed from `(التسعير, متوسط سعر المتر)` × average unit size, expressed in millions with one decimal. |

### opportunity_bullets template

Four bullets, in this order:

1. **Demand bullet** — `الطلب <verb>: الحي يسجل <N> صفقة <window>` using `(نشاط السوق, عدد الصفقات)`.
2. **Pricing bullet** — `السعر (<avg>) <below/at/above> متوسط الحي (<district avg>)` from `(التسعير, *)` + `(المنافسة, *)`.
3. **Amenity/differentiator bullet** — from `(المنافسة, فجوة التمييز مقابل المنافسين)` or project brief amenities list.
4. **Inventory bullet** — `<N> وحدة متاحة بقيمة تجاوز <M> مليون ريال`.

Each ≤ 12 words. If a source row is `غير متوفر`, skip that bullet rather than writing a weak line.

---

## Slides 10, 14 — marketing & sales plan

These are brand-constant slides (fixed conversion funnels). The only inputs are:

| Content key | Data source |
|---|---|
| `marketing_targets.total_units_sold` | From the project brief's remaining-units figure. Not from the sheet. Slide 14 reads this as the CAMPAIGN total and uses it for the collapse-mode decision. |
| `sales_plan.leads_per_month` | From the project brief OR from a Wassel planning convention. Not from the sheet. |
| `funnel_kpis.avg_unit_price` | From `(التسعير, متوسط سعر المتر)` × avg unit size, formatted as `1.2M`. |
| `funnel_kpis.months_to_sellout` | ⚠️ **Now auto-computed by the builder** from `total_units / natural_monthly_sales` (with a floor of 1). The value you pass in the content dict is IGNORED if both inputs are present — this is so the sidebar always reports honest pacing regardless of whether the table collapsed. Passing a value only matters as a fallback when those inputs aren't available. |
| `funnel_kpis.overall_conversion` | Brand constant (0.61% or 0.6%). Don't pull from sheet. |
| `funnel_kpis.leads_per_sale` | Brand constant (166). Don't pull from sheet. |

### Slide 14 — monthly-distribute vs collapse-to-campaign

The builder decides automatically which presentation to render based on the inputs:

- **Monthly-distribute** — natural monthly sales rate (from `leads_per_month` through the fixed funnel) is **≥ 4 sales/month** AND the project has **≥ 3 units**.
  - Header: `قمع المبيعات الشهري — مشروع <X>`
  - Table header bar: `الخطة البيعية الشهرية`
  - Sales row label: `المبيعات`
- **Collapse-to-campaign** — fires automatically when EITHER (a) natural sales/month < 4 for a ≥3-unit project, or (b) the project has < 3 units (can never hit 4/month).
  - The builder scales `leads_per_month` up internally so the derived `sales` figure equals `marketing_targets.total_units_sold`. The whole campaign is represented as a single one-row funnel walk.
  - Header: `قمع المبيعات للحملة — مشروع <X>`
  - Table header bar: `الخطة البيعية للحملة`
  - Sales row label: `إجمالي المبيعات`
  - All other row labels stay the same (funnel-stage names are scale-agnostic).

You don't need to pass a flag — the builder detects the case from the numbers. If you want to see which mode fired, inspect the generated deck's slide-14 header text.

**The sidebar KPI `أشهر لبيع المتبقي من المشروع` is always computed from the natural monthly rate** — it doesn't match the collapsed-table-walk numbers, because the collapse is just a presentation choice for the funnel math. The sidebar remains the honest schedule.

---

## Identifier fields (top of content dict)

| Content key | Source |
|---|---|
| `project_name` | Project brief — use the verified official name. If the brief has a colloquial tag vs an official product name, use the official name. |
| `district` | Project brief. |
| `city` | Project brief. |
| `year` | The run year (current year or deck target year). |
| `footer_right` | Template `وصل العقارية  \|  <project>`. |
| `marketing_footer_right` | Template `وصل العقارية  \|  الخطة التسويقية`. |
| `sales_footer_right` | Template `وصل العقارية  \|  الخطة البيعية`. |

---

## Unmapped sheet rows (preserved in sheet, not on any slide)

These categories/metrics are currently audit-only. They DO have sheet rows but the deck doesn't render them:

- All of `الموقع` (category 6) beyond the project-brief `location` string
- All of `العائد والاستثمار` (category 5) except the computed `avg_price_millions`
- All of `الطلب والسكان` (category 7)
- All of `التنظيمي` (category 9)
- `الفترة الزمنية`, `تاريخ الاستخراج`, `المصدر الأساسي` — these stay in the sheet for traceability; the deck doesn't surface them

**This is correct.** The sheet is the defensible data bible. The deck is the curated client-facing narrative. Not everything in the sheet belongs on a slide.

---

## Conflict handling

If two sheet rows share `(الفئة, المؤشر)` with `حالة التحقق = متضارب`:

- The FIRST row is the preferred source (Paseetah for market categories, web for project facts — see merge_to_sheet.py precedence).
- Use the first row's value for the slot.
- Mention the conflict in the slide-4 `insight_lines` only if it materially affects positioning (e.g. Paseetah says market avg is 10,202 but web source says 12,500 — relevant to the "priced below market" narrative).

---

## Missing data handling

- If a required slot's sheet row has `القيمة = غير متوفر`:
  - For slide-4 `market.kpis` — **do NOT leave a tile as `—`.** Pick a different metric that IS in the data. Zero dead tiles on slide 4. If you can't find 3 usable metrics, go back to research — never ship slide 4 with a blank tile.
  - For `opportunity_bullets` — **drop the bullet entirely**, don't write a weak line.
  - For `insight_lines` — reduce to one line if the other is unsupportable. Better one strong line than two weak ones.
- Flag in the orchestrator's return summary which slots ended up blank so the user knows what to fill manually if needed.
