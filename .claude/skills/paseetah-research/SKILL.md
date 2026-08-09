---
name: paseetah-research
description: Pull Saudi Arabia real-estate market data (prices, transactions, absorption, yield, demographics, regulatory) from Paseetah (paseet.ai) using the Claude-in-Chrome browser tools, organized around 9 required categories. Use this skill whenever the user asks for Saudi market numbers, asks to "check paseet" or "check paseetah", mentions نبضة or بيسيطة, wants numeric evidence on a specific مربع / حي / منطقة in KSA, or is building anything that needs current transaction data from a Saudi district or city. Also use when another skill — like wassel-project-research — needs market evidence as input. Produces a clean, scope-labeled Arabic market data table with sources.
---

# Paseetah Research — Saudi Real-Estate Market Data

This skill retrieves quantitative market evidence from **Paseetah** (paseet.ai/ar/chat — Arabic interface) and returns it as a scope-labeled Arabic table covering nine required metric categories. It's generic: useful for any Saudi project-research or market-analysis task, not only Wassel decks.

## What this skill does

Given a geographic target (project square, district, city, or a named comparable), this skill:

1. Opens `paseet.ai/ar/chat` in a Chrome browser session (Arabic interface — Paseetah's data coverage is Arabic-first).
2. Runs **one query pass per category** (9 categories total, Arabic queries).
3. Reads the full response (chat bubble + side panels + tables + footnotes).
4. Returns a **Market Numeric Data Table** with every value labeled by scope and category.

It does not interpret the numbers or produce a narrative. That's the caller's job.

## What it doesn't do

- **Doesn't handle logins.** If the user isn't signed in to Paseetah, stop and ask them to sign in. Never enter credentials.
- **Doesn't invent data.** If Paseetah returns nothing or errors out, record the gap explicitly — don't fall back to training data for Saudi prices.
- **Doesn't promote area-level numbers to project-specific claims.** If the only number available is a district average, the scope stays `حي` — never upgrade it.

## Running the research

### Step 1 — Load the Chrome tools

Claude-in-Chrome tools are deferred; they don't exist in context until you load them:

```
tool_search(query="browser chrome navigate")
```

You should get back tools like `navigate`, `get_page_text`, `find`, `form_input`, `computer`, `read_page`, `javascript_tool`. If the search returns nothing, Chrome isn't available in this session — tell the user to enable the "Claude in Chrome" feature in their settings and stop here.

### Step 2 — Open Paseetah (Arabic interface)

```
navigate(url="https://paseet.ai/ar/chat")
```

Then `get_page_text()` (or `read_page()` for the accessibility tree) to see what loaded. Common outcomes:

- **Chat UI visible** (Arabic placeholder like `اكتب طلبك هنا...`) → proceed to step 3.
- **Login page** → stop. Tell the user: *"بيسيطة تطلب تسجيل الدخول. الرجاء تسجيل الدخول في paseet.ai من نافذة Chrome هذه، ثم اطلب مني المتابعة."* Wait for explicit confirmation. Do not attempt to log in yourself.
- **Error / timeout** → try `navigate` once more. If still failing, report the failure and stop.

**RTL note:** the /ar/chat interface is RTL. Use `find` (semantic locator) with Arabic labels (e.g. `إرسال` for the send button, `اكتب طلبك` for the input) rather than pixel coordinates. The layout flips but the accessibility tree is stable.

### Step 3 — The 9-category query loop (mandatory)

Run **one query pass per category**. Do not skip categories; if a category has no applicable data for the target, record that explicitly in the output. Query language: **Arabic only**.

Click `محادثة جديدة` (New Chat) before starting the loop, so all nine passes live in one clean thread.

For each category below, send the listed query (substituting `<الحي>`, `<المدينة>`, `<نوع الوحدة>`, `<المربع>` as appropriate), wait for the response, then `get_page_text` to capture the reply. If Paseetah offers suggested follow-up chips (e.g. "عطني بيانات عن الحي..."), click one at most per category only if it adds a metric the primary query missed.

#### Category 1 — التسعير (Pricing)
```
متوسط سعر المتر لـ <نوع الوحدة> في <الحي> بمدينة <المدينة> خلال آخر ١٢ شهر، مع نطاق السعر الأدنى والأعلى.
```
Follow-up if time allows:
```
اتجاه سعر المتر في <الحي> خلال آخر ٣ إلى ٥ سنوات.
```

#### Category 2 — نشاط السوق (Market activity)
```
كم عدد الصفقات العقارية لـ <نوع الوحدة> في <الحي> خلال آخر ١٢ شهر وإجمالي قيمتها بالريال؟
```
Follow-up:
```
نسبة التغير السنوية في عدد وقيمة الصفقات في <الحي>، ومتوسط أيام البيع إذا كان متاحاً.
```

#### Category 3 — العرض (Supply side)
```
إجمالي المعروض السكني في <الحي> ونسبة الشواغر إن أمكن، وكم شهر يمثل المخزون الحالي عند وتيرة المبيعات الحالية.
```
Follow-up:
```
هل توجد مشاريع تحت الإنشاء أو قيد الإطلاق في <الحي>؟ ما حجمها؟
```

#### Category 4 — مواصفات المنتج (Product specs)
```
مزيج الوحدات السكنية في <الحي> (شقق / فلل / دور)، ومتوسط المساحة لكل نوع، ومستوى التشطيب السائد في المشاريع الجديدة.
```

#### Category 5 — العائد والاستثمار (Yield & returns)
```
متوسط الإيجار السنوي للمتر المربع في <الحي>، والعائد الإجمالي على الاستثمار للشقق، والعائد الصافي إن أمكن.
```
Follow-up:
```
فترة الاسترداد التقديرية (Payback period) لشراء وحدة استثمارية في <الحي>.
```

#### Category 6 — الموقع (Location & accessibility)
*Paseetah usually doesn't have travel-time data — ask and move on.*
```
المسافة من <الحي> إلى أقرب محاور رئيسية (طريق الملك فهد / طريق الملك سلمان / المطار / وسط الرياض).
```

#### Category 7 — الطلب والسكان (Demand & demographics)
```
إحصاءات السكان في <الحي>: إجمالي السكان، النسبة السعودية، حجم الأسرة الوسيط، العمر الوسيط، ومعدل النمو السكاني.
```
Follow-up:
```
ما متوسط دخل الأسرة في <الحي> أو في النطاق الأوسع؟
```

#### Category 8 — المنافسة (Competitive landscape)
```
أحدث المشاريع السكنية المنافسة في <الحي> (أو المربع <المربع>) مع بيانات السعر، نسبة البيع، ومساحة الوحدات لكل مشروع.
```

#### Category 9 — التنظيمي (Regulatory / physical)
```
التصنيف التنظيمي لـ <الحي>، ونسبة البناء والارتفاع المسموح، وأي تصنيفات خاصة (روشن، مناطق الأرض البيضاء، مناطق مطورة).
```

### Step 4 — Read each response fully

After each query, **don't just read the first paragraph**. Use `get_page_text` to capture the whole chat bubble, then look for:
- Numeric tables (Paseetah often renders them as small grids inside the reply)
- Footnotes (scope caveats, time windows, data-source disclaimers like "السجل العقاري" or "وزارة العدل")
- Side panels that might open with detailed breakdowns
- "اشتراك بلس" / premium paywall notices — these reveal the data *does* exist, just behind the paywall; record that as a gap with confidence=متوسط rather than missing

If Paseetah says "لا تتوفر بيانات لهذا المربع، ولكن هنا متوسط الحي" — that's exactly the scope information to capture. Record as `النطاق = حي`, not project-level.

### Step 5 — Scope every metric

For each number extracted, label its scope precisely using the Arabic vocabulary:

| النطاق (Scope)    | Meaning                                                |
|-------------------|--------------------------------------------------------|
| `مشروع`           | Data for one named project only                        |
| `مربع`            | Data for the مربع the project sits in                  |
| `حي`              | Data for the whole حي                                  |
| `منطقة`           | Broader than district (e.g. شمال الرياض)               |
| `مدينة`           | City-wide                                              |
| `مقارنات`         | Derived from comparable projects/transactions          |
| `سوق`             | Country-level or generic market                        |
| `غير محدد`        | Scope unclear — do not guess                           |

## Output format

Return a markdown table with these 15 columns (Arabic headers, RTL — mirrors the downstream Google Sheet exactly):

```
| الفئة | المؤشر | القيمة | الوحدة | النطاق | الجغرافيا | الفترة الزمنية | تاريخ الاستخراج | المصدر الأساسي | رابط المصدر | المصدر الثانوي | حالة التحقق | مستوى الثقة | طريقة التجميع | ملاحظات |
```

Controlled vocabulary per column:

- **الفئة** — exactly one of: `التسعير` / `نشاط السوق` / `العرض` / `مواصفات المنتج` / `العائد والاستثمار` / `الموقع` / `الطلب والسكان` / `المنافسة` / `التنظيمي`
- **المؤشر** — Arabic metric name
- **القيمة** — numeric value as Paseetah returned it, preserving Arabic-Indic digits if native. Use `غير متوفر` when Paseetah couldn't answer.
- **الوحدة** — `ريال/م²`, `%`, `صفقة`, `شهر`, `م²`, `وحدة`, `كم`, `—` (none), etc.
- **النطاق** — from the table above
- **الجغرافيا** — specific location (e.g. `حي النرجس، الرياض`)
- **الفترة الزمنية** — `آخر ١٢ شهر`, `٢٠٢٤`, `Q٤ ٢٠٢٥`, `لحظي`
- **تاريخ الاستخراج** — ISO date of this session (e.g. `2026-04-20`)
- **المصدر الأساسي** — `بيسيطة (Paseetah)`
- **رابط المصدر** — leave empty for Paseetah in-chat responses (no permalink)
- **المصدر الثانوي** — what Paseetah cited as its source (e.g. `وزارة العدل - بيانات الصفقات`, `السجل العقاري`, `الهيئة العامة للإحصاء`)
- **حالة التحقق** — `موثق` / `متضارب` / `غير واضح` / `غير موجود`
- **مستوى الثقة** — `عالي` (Paseetah returned a specific number with cited source) / `متوسط` (directional, or behind paywall but acknowledged) / `منخفض` (vague, rephrased, or not directly answered)
- **طريقة التجميع** — always `بيسيطة - محادثة` for this skill
- **ملاحظات** — free-text Arabic: period, sample, scope conflicts, paywall notes

Example row:
```
| التسعير | متوسط سعر المتر للشقق | ٧٨٠٠ | ريال/م² | حي | حي النرجس، الرياض | آخر ١٢ شهر | 2026-04-20 | بيسيطة (Paseetah) |  | وزارة العدل | موثق | عالي | بيسيطة - محادثة | شقق سكنية فقط |
```

After the table, add a short **الفجوات والملاحظات** (Gaps & Notes) section listing:
- Categories Paseetah couldn't answer
- Metrics behind the Plus subscription paywall (record the metric, not invented numbers)
- Conflicts between sources (if Paseetah cited two)
- Anything unusual about the session (login required, slow response, interface switched to /en, etc.)

## Common pitfalls

- **Skipping a category.** Every run must have one row per category minimum, even if the row's `القيمة = غير متوفر`. Gap visibility is the whole point.
- **Clicking through without reading.** Paseetah's side panels load more detail than the chat bubble — always `read_page` again after a panel opens.
- **Mixing scopes in one row.** Keep one row per metric-scope pair. If Paseetah returned both حي and مربع figures, those are two rows.
- **Assuming the data is current.** Paseetah has ingestion lag. Record the session date separately from the data period (`تاريخ الاستخراج` vs `الفترة الزمنية`).
- **Latin digits inside Arabic text.** Where possible preserve Arabic-Indic digits (`٠-٩`) as Paseetah returned them. The downstream Arabic deck builder will normalize either form.
- **Credential leakage.** Never log, repeat, or type into the page any credential the user shares in chat. If the user pastes a password, refuse and ask them to log in directly in the browser.

## When this skill is done

Hand back the 15-column Arabic markdown table + الفجوات والملاحظات section in a single response. Save the table to the path the caller specified (e.g. `./<slug>/market/paseetah.md`). If another skill called this one (e.g. `wassel-project-research`), the caller will read this file, merge it with its own web-research output, and emit the consolidated Google Sheet. If the user called this skill directly, they're free to use the table however they like.
