# Wassel Slide Templates — Per-Slide Specs

Every position in this file is in **inches**, extracted directly from the reference deck (`العرض_-_مقام_17.pptx`). Slide canvas is 10.00 × 5.625 (16:9).

Do not round creatively. If you're adding a new slide type, follow the geometry of the closest existing slide.

**Universal text rule:** Every user-facing string goes through `_clean_text()` which normalizes spacing, wraps em-dashes in RLM marks in Arabic context, and converts ALL Western digits (`0-9`) to Arabic-Indic (`٠-٩`). Don't manually insert Arabic-Indic digits — let the cleaner do it. Don't pass Western digit strings expecting them to survive unchanged.

**Total slide count: 15** (the former "why Wassel" slide 15 was deleted; closing slide is now slide 15).

---

## Shared elements

### Content-slide chrome (used on slides 2, 4, 5, 6, 8, 9, 10, 12, 13, 14)

```
background:           cream #F8F5E9, full canvas

# left sand strip
rect  left=0.00 top=0.00  w=0.18  h=5.625  fill=sand #E8D9C0
# dot ladder on the strip — 9 copper squares at y = 0.50, 1.06, 1.62, 2.18, 2.74, 3.30, 3.86, 4.42, 4.98
# each: left=0.04 w=0.10 h=0.10 fill=copper #B8734F

# header band (brown bar with gold underline and copper right cap)
rect  left=0.00 top=0.00     w=10.00 h=1.10 fill=brown #6B4226
rect  left=0.00 top=1.10     w=10.00 h=0.04 fill=gold  #D9B57F
rect  left=9.85 top=0.00     w=0.15  h=1.10 fill=copper #B8734F

# logo (top-left on header)
image left=0.28 top=0.16 w=0.57 h=0.57  src=assets/wassel_logo_white.png

# title + subtitle (RTL-anchored, right-aligned visually)
text  left=1.10 top=0.10  w=8.55 h=0.56  Amiri 26pt Bold  color=#FFFFFF   align=right  rtl  text=<TITLE>
text  left=1.10 top=0.65  w=8.55 h=0.38  Amiri 13pt       color=#D9B57F   align=right  rtl  text=<SUBTITLE>

# footer band (bottom)
rect  left=0.00 top=5.37 w=10.00 h=0.26 fill=sand #E8D9C0
rect  left=0.00 top=5.37 w=10.00 h=0.02 fill=copper #B8734F
text  left=0.25 top=5.38 w=9.50 h=0.23  Amiri 9pt color=#6B4226 align=right rtl  text=<RIGHT_FOOTER>
text  left=0.25 top=5.38 w=9.50 h=0.23  Amiri 9pt color=#B8734F align=left       text=wassel.re   hyperlink=https://wassel.re
```

### Divider-slide chrome (used on slides 1, 3, 7, 11, 15 — cover/closing are variants)

```
background: brown #6B4226, full canvas

# left copper strip with Najdi/Diriyah triangular-notch pattern
rect  left=0.00 top=0.00  w=0.55 h=5.625  fill=copper #B8734F
# 9 brown triangular notches cutting inward from the strip's right edge.
# Each notch is a BROWN filled isosceles triangle rotated 270° (tip points LEFT,
# base on the right edge). Implemented via MSO_SHAPE.ISOSCELES_TRIANGLE with
# rotation=270 — PowerPoint-native preset, renders crisply.
#   notch: bounding box width=0.20in (notch_depth), height=0.28in (notch_h),
#          positioned so the right edge aligns with x=0.55 (strip inner edge).
#   9 notches evenly spaced between y=0.15 and y=5.47.
# Between each adjacent pair of notches, a small BROWN diamond (0.10in × 0.10in,
# rotated 45°) sits at x=0.14 centered between the notch y-centers.
# This is the signature Najdi/Diriyah motif — do NOT replace with a dot ladder.

# gold separator under the title
rect  left=1.00 top=2.65 w=8.50 h=0.04 fill=gold #D9B57F

# title (large, centered, white)
text  left=0.70 top=1.55 w=9.00 h=1.05  Amiri 52pt Bold color=#F8F5E9 align=center rtl  text=<DIVIDER_TITLE>

# subtitle (under the gold line, gold color, centered)
text  left=0.70 top=2.72 w=9.00 h=0.50  Amiri 20pt color=#D9B57F align=center rtl  text=<DIVIDER_SUBTITLE>

# NO footer, NO logo on dividers 3/7/11.
```

---

## Slide 1 — Cover

Divider chrome (brown bg + copper left strip + gold separator) **with** a large centered logo at the top and a copper tag-pill mid-page. No footer.

```
# Large centered logo
image left=3.94 top=0.08 w=2.56 h=2.56   src=assets/wassel_logo_white.png

# Brand name (big)
text  left=0.70 top=2.85 w=9.10 h=0.85  Amiri 46pt Bold color=#F8F5E9 align=center rtl  text="وصل العقارية"

# Subtitle
text  left=0.70 top=3.65 w=9.10 h=0.48  Amiri 21pt color=#E8D9C0 align=center rtl  text="خطة التسويق والإدارة البيعية"

# Project tag (copper pill)
# Order: project — CITY، DISTRICT  (city FIRST, then district, separated by
# Arabic comma). Reversing this is a spec violation caught by the review skill.
# Digits inside the project name are auto-converted to Arabic-Indic by
# _clean_text (e.g., "مقام كورتيارد 17" renders as "مقام كورتيارد ١٧").
rect  left=2.80 top=4.28 w=4.40 h=0.55 fill=copper #B8734F
text  left=2.80 top=4.29 w=4.40 h=0.52  Amiri 13.5pt Bold color=#FFFFFF align=center rtl  text="<PROJECT_NAME> — <CITY>، <DISTRICT>"

# Year
text  left=0.70 top=4.98 w=9.10 h=0.35  Amiri 13pt color=#D9B57F align=center   text=<YEAR>
```

---

## Slide 2 — About Wassel

Content-chrome. Three brown "stat" KPI cards across the top, a body paragraph above them, three white value-proposition cards below. Title: `عن وصل العقارية`. Subtitle: `منظومة بيع عقاري متكاملة`.

```
# Body paragraph (above the stat row)
text  left=0.85 top=1.17 w=7.49 h=0.62  Amiri 15pt color=#6B4226 align=center rtl
      lines = [
        "شركة سعودية متخصصة في التسويق العقاري وإدارة المبيعات، تعمل على مستوى المملكة العربية السعودية.",
        "نؤمن بأن البيع الناجح يبدأ بنظام لا بجهد فردي."
      ]

# Stat cards (3 × brown card, top gold accent, big gold number, cream caption)
# card frame:    w=2.20 h=1.22, fill=brown, top border=gold h=0.06
# number:        Amiri 34pt Bold color=gold
# caption:       Amiri 12pt color=sand

# card 1 (rightmost in Arabic reading order — physically left-most in LTR coords)
rect  left=1.38 top=1.95 w=2.20 h=1.22 fill=brown
rect  left=1.38 top=1.96 w=2.20 h=0.06 fill=gold
text  left=1.38 top=2.06 w=2.20 h=0.62  Amiri 34pt Bold color=gold align=center rtl  text="1 مليون+"
text  left=1.38 top=2.68 w=2.20 h=0.42  Amiri 12pt color=sand align=center rtl  text="ميزانيات مصروفة على الحملات"

# card 2 (middle)
rect  left=3.76 top=1.96 w=2.20 h=1.22 fill=brown
rect  left=3.76 top=1.96 w=2.20 h=0.06 fill=gold
text  left=3.76 top=2.06 w=2.20 h=0.62  Amiri 34pt Bold color=gold align=center  text="70+"
text  left=3.76 top=2.68 w=2.20 h=0.42  Amiri 12pt color=sand align=center rtl  text="مشروع مدار"

# card 3 (leftmost in Arabic reading — physically right-most)
rect  left=6.14 top=1.96 w=2.20 h=1.22 fill=brown
rect  left=6.14 top=1.96 w=2.20 h=0.06 fill=gold
text  left=6.14 top=2.06 w=2.20 h=0.62  Amiri 34pt Bold color=gold align=center rtl  text="2+ مليار"
text  left=6.14 top=2.68 w=2.20 h=0.42  Amiri 12pt color=sand align=center rtl  text="مشاريع مباعة"

# Value-prop cards (3 × white, top copper accent)
# each: w=2.20 h=1.77, fill=white, top border=copper h=0.06
# title: Amiri 13pt Bold color=brown, align right, rtl
# body: Amiri 11.5pt color=charcoal, align right, rtl, 2 short lines

# card A — rightmost in Arabic (left=1.38)
title="عملية مبيعات موحدة"   body="ضمان عملية مبيعات عالية الكفاءة تعتمد على النظام لا الفرد"
# card B (middle, left=3.76)
title="نظام تقني متكامل"     body="أتمتة كاملة من الاستقبال حتى الإفراغ"
# card C (leftmost, left=6.14)
title="تسويق ذكي مبني على البيانات"  body="محتوى وإعلانات مركّزة تصل للعميل الصحيح"
```

---

## Slide 3 — Divider: `تحليل مربع المشروع`

Divider chrome. Subtitle: `دراسة السوق والمشروع وفرصته`.

---

## Slide 4 — Market analysis

Content chrome. Three white stat cards (top row), one full-width insight card (middle), one full-width two-column price-range card (bottom).

```
title="تحليل السوق"
subtitle="تحليل مربع مشروع <PROJECT_NAME> <DISTRICT> — <CITY>"   # ALWAYS include "مربع مشروع"

# Three stat cards — each: w=2.90 h=1.65, fill=white, top copper accent 0.06
# Big number: Amiri 42pt Bold color=copper, align center
# Label: Amiri 12pt color=charcoal, align center rtl

# card 1 (left=0.30)   number=<TOTAL_UNITS>  label="إجمالي الوحدات في المربع"
# card 2 (left=3.40)   number=<SALES_RATE>   label="متوسط نسبة البيع"     # e.g. "76%"
# card 3 (left=6.50)   number=<MONTHLY>      label="وحدات تُباع شهرياً"

# Insight card (middle, full width)
rect  left=0.30 top=3.08 w=9.10 h=1.10 fill=white
rect  left=9.41 top=3.08 w=0.08 h=1.10 fill=copper    # right-side accent bar
text  left=0.28 top=3.35 w=0.25 h=0.45  Amiri 18pt color=copper align=center  text="✦"
text  left=0.55 top=3.12 w=8.85 h=0.98  Amiri 14pt color=brown align=right rtl auto_fit=true
      lines=[<INSIGHT_LINE_1>, <INSIGHT_LINE_2>]
      # HARD LIMIT: each line ≤ 12 words (ideally ≤ 8). EXACTLY 2 lines.
      # Card is sized for punchy one-liners, not full sentences. If the
      # research layer produces two full paragraphs they will overflow.
      # Example good:  "71 صفقة سكنية في ٦ أشهر — سوق مستقر"
      # Example bad:   "حي العليا يسجل 71 صفقة سكنية في آخر 6 أشهر (السجل
      #                العقاري) بمتوسط 10,202 ريال/م² — سوق مستقر وسط الرياض"
      # auto_fit=true is a safety net — if content slightly overruns,
      # PowerPoint shrinks font at render. It does NOT rescue 2x-long content.

# Price-range card (bottom, two columns separated by a thin sand rule)
rect  left=0.30 top=4.32 w=9.19 h=0.78 fill=white
rect  left=5.90 top=4.36 w=0.02 h=0.68 fill=sand    # divider rule

# Right column (in Arabic reading = physically left): range in the square
text  left=0.35 top=4.38 w=5.40 h=0.28  Amiri 11pt Bold color=brown align=right rtl  text="نطاق الأسعار في المربع:"
text  left=0.35 top=4.62 w=5.40 h=0.28  Amiri 13pt Bold color=copper align=right rtl  text="<RANGE_MIN> ريال الى <RANGE_MAX> ريال"

# Left column (physically right): avg unit price
text  left=6.30 top=4.38 w=3.10 h=0.28  Amiri 11pt Bold color=brown align=right rtl  text="متوسط سعر الوحدة:"
text  left=6.40 top=4.61 w=3.10 h=0.28  Amiri 13pt Bold color=copper align=right rtl  text="~<AVG_PRICE> ريال"
```

---

## Slide 5 — Competitor comparison

Content chrome with a **PowerPoint table** (this is the only slide where a real table is acceptable). Title: `مقارنة المشاريع المنافسة`. Subtitle: `المشاريع السكنية النشطة في مربع <PROJECT> <DISTRICT>`.

```
table  left=0.25 top=1.20 w=9.55 h=3.15
       # header row: fill=brown #6B4226, text white Amiri 12pt Bold, align center rtl
       # body rows:  alternating sand/white; text Amiri 11pt color=charcoal, align center rtl
       # columns (right-to-left reading order):
       #   المشروع | المطوّر | عدد الوحدات | نسبة البيع | متوسط السعر | ملاحظات

# Footnote below the table
text  left=0.25 top=5.12 w=9.50 h=0.22  Amiri 9.5pt color=charcoal align=right rtl
      text="* <FOOTNOTE>"    # e.g. launch-timing caveat
```

---

## Slide 6 — Project & opportunity

Content chrome. Right half = specs list (white card with alternating cream/white rows). Left half top = dark brown "strategic opportunity" card with 4 bullets. Left half bottom = white revenue card.

**Bullet order is fixed — reference it in SKILL.md.**

```
title="المشروع وفرصته في السوق"
subtitle="<PROJECT_NAME> — <DISTRICT>"

# Specs card (white, top copper accent, 6 alternating rows)
rect  left=4.85 top=1.22 w=4.90 h=3.85  fill=white
rect  left=4.85 top=1.22 w=4.90 h=0.06  fill=copper
text  left=4.90 top=1.32 w=4.80 h=0.40  Amiri 15pt Bold color=brown align=right rtl  text="مواصفات المشروع"

# 6 rows, each h=0.40. Alternating fills: cream/white/cream/white/cream/white
# Row pattern:
#   bg fill covering full row width at left=4.90 w=4.80
#   label right-side (physically right — left=7.60 w=2.05): Amiri 10pt Bold color=copper rtl
#   value left-side (physically left — left=4.92 w=2.60): Amiri 10pt color=charcoal rtl
# Rows (y-top): 1.80, 2.25, 2.70, 3.15, 3.60, 4.05, 4.50
#   الموقع          | <LOCATION>
#   المساحات         | <AREA_RANGE>      e.g. "91 م² حتى 265 م²"
#   الأسعار          | <PRICE_RANGE>
#   الوحدات الكلية   | "<N> وحدة — <B> عمائر \u200E(<LETTERS>)\u200E"
#   الوحدات المتاحة  | "~<N> وحدة"
#   المرافق          | "نادي رياضي، لاونج، ..."   # use "نادي" not "نادٍ"
#   الضمانات         | "هيكل إنشائي <X> سنوات  |    عزل <Y> سنة"

# Strategic opportunity card (top-left, brown)
rect  left=0.25 top=1.22 w=4.40 h=1.88 fill=brown
rect  left=0.25 top=1.22 w=4.40 h=0.06 fill=gold
text  left=0.30 top=1.30 w=4.25 h=0.40  Amiri 14pt Bold color=gold align=right rtl  text="الفرصة الاستراتيجية"

# 4 bullets — keep this ORDER, do not shuffle
# each line: Amiri 12pt color=sand, align right rtl
text  y=1.77 text="✦  <DEMAND_INDICATOR>"                        # e.g. "الطلب مرتفع: الحي يسجل 7 وحدات مباعة شهرياً"
text  y=2.07 text="✦  <AMENITY_ADVANTAGE>"                       # e.g. "المرافق تُحرّك البيع — مقام 17 يملكها"
text  y=2.37 text="✦  <SALES_RATE_COMPARISON>"                   # e.g. "معدل مبيعات المشروع قريب من متوسط السوق"
text  y=2.67 text="✦  <INVENTORY_VALUE>"                          # e.g. "43 وحدة متاحة بقيمة تجاوز 50 مليون ريال"

# Revenue card (bottom-left, white)
rect  left=0.25 top=3.20 w=4.40 h=1.87 fill=white
rect  left=0.25 top=3.20 w=4.40 h=0.06 fill=copper
text  left=0.30 top=3.30 w=4.25 h=0.38  Amiri 13pt Bold color=brown align=right rtl  text="الإيراد المتوقع للمطوّر من الوحدات المتبقية"
text  left=0.30 top=3.68 w=4.25 h=0.72  Amiri 38pt Bold color=copper align=right rtl  text="+<EXPECTED_REVENUE>"    # e.g. "+50,000,000"
text  left=0.30 top=4.38 w=4.25 h=0.26  Amiri 11pt color=charcoal align=right rtl  text="ريال سعودي  — تقديري"
text  left=0.30 top=4.66 w=4.25 h=0.32  Amiri 10.5pt color=copper align=right rtl  text="<REMAINING_UNITS> وحدة متبقية  ×  متوسط سعر <AVG_PRICE> مليون ريال"
```

---

## Slide 7 — Divider: `الخطة التسويقية`

Divider chrome. Subtitle is **exact**: `الهدف: صناعة الطلب، وجلب المهتمين`. Do not paraphrase.

---

## Slide 8 — Marketing I: Opening event

Content chrome. **Three** equal element cards below an audience-bar (not more, not less — reference spec). No "عروض تحفيزية" section.

```
title="الخطة التسويقية – اولاً: حفل الإفتتاح"
subtitle="إطلاق قوي يصنع الزخم من اليوم الأول"

# "المدعوون" (invitees) header bar
rect  left=0.41 top=1.96 w=9.16 h=0.32 fill=brown
text  left=0.38 top=1.98 w=9.30 h=0.28 Amiri 11pt color=gold align=center rtl  text="المدعوون"

# 5 audience pills below the bar (right-to-left in Arabic)
# pattern: copper fill when odd, brown when even
# each pill: w=1.76 h=0.50, with a small white-square icon-holder on the right-edge (physically left of the text)
# pill y=2.33
# rightmost (left=0.41)   icon=📣   text="دعوات عامة"
# (left=2.26)             icon=⭐   text="عملاء وصل"
# (left=4.11)             icon=👥   text="مؤثرون عقاريون"
# (left=5.96)             icon=🏢   text="مطوّرون ومستثمرون"
# leftmost (left=7.81)    icon=🏠   text="أهل الحي"

# "عناصر الحفل" (event elements) header bar
rect  left=0.41 top=2.88 w=9.16 h=0.32 fill=brown
text  left=0.38 top=2.90 w=9.30 h=0.28 Amiri 11pt color=gold align=center rtl  text="عناصر الحفل"

# 5 element tiles — white card, big icon center-top, gold underline, label
# each: w=1.76 h=1.05, fill=white; y=3.23
# icon-circle: fill=cream #F8F5E9, size 0.52×0.52 centered in the top half
# underline: gold bar at bottom of icon area, h=0.04
# label: Amiri 11pt Bold color=brown, align=center rtl
# x positions (right-to-left pills): 0.41, 2.26, 4.11, 5.96, 7.81
# labels: "عرض فني" | "لوحات إرشادية" | "إنارة احترافية" | "قهوجية" | "مقهى متنقل"
```

---

## Slide 9 — Marketing II: Content & digital platforms

Content chrome. Top half = 6 content-type tiles in a 3×2 grid. Bottom half = 4 social-platform cards with branded color headers.

```
title="الخطة التسويقية — ثانياً: المحتوى والتسويق الرقمي"
subtitle="تسويق رقمي مركّز يصل للعميل الصحيح"

# "المحتوى" (content) header bar: left=0.33 top=1.22 w=9.15 h=0.30 fill=brown
# label: Amiri 11pt color=gold align=center rtl  text="المحتوى"

# 6 content tiles in 3×2 grid (2 rows, 3 columns). Each: w=2.95 h=0.60, white card with a right-edge copper accent bar (physically right edge)
# Row 1 y=1.63: rightmost x=0.33 "فيديو سينمائي / إبراز الفخامة والتفاصيل"
#                 middle   x=3.43 "جولات افتراضية / تقليل التردد قبل الزيارة"
#                 leftmost x=6.53 "درون جوي / إبراز الموقع والمحيط"
# Row 2 y=2.33: x=0.33 "بروشور رسمي / كتيب تعريفي ويتضمن قائمة الوحدات"
#                 x=3.43 "منشورات منصات التواصل / عروض ومزايا ولقطات"
#                 x=6.53 "مقاطع ترويجية / الانتشار الواسع والسريع"

# "المنصات الترويجية" header bar: left=0.33 top=3.14 w=9.15 h=0.28 fill=brown
# label: Amiri 11pt Bold color=gold align=center rtl

# 4 platform cards. Each: w=1.93–2.03 h≈1.77, fill=white, with colored header strip top=0.51-0.52
# y=3.48; x positions (right-to-left): 0.33, 2.65, 5.05, 7.45
# Platforms (right-to-left):
#   Snapchat:  header fill=#FFFC00  title="سناب شات"  role="التحويل الأساسي"     body="تغطيات للوحدات"
#   TikTok:    header fill=#000000  title="تيك توك"  role="صناعة الطلب والانتشار"  body="محتوى بصري سريع + جولات طبيعية + مؤثرون"
#   Instagram: header fill=#C13584  title="إنستاغرام"  role="بناء الثقة"           body="ريلز احترافية + ستوري يومي + مراجعات"
#   LinkedIn:  header fill=#0A66C2  title="لينكدإن"   role="استقطاب المستثمرين"   body="عائد إيجاري + نمو القيمة + موقع استراتيجي"
# header text: Amiri 13pt Bold color=white/brown (white for dark bgs, brown for Snapchat yellow)
# role:       Amiri 11pt Bold color=copper align=right rtl
# body:       Amiri 10pt color=charcoal align=right rtl
```

---

## Slide 10 — Marketing III: Measured outcomes

Content chrome. Left = white "target numbers" card with 5 alternating cream/white metric rows. Right = dark brown "why it works" card with 4 diamond-bullet items. Full-width copper tagline strip at the bottom.

```
title="الخطة التسويقية - ثالثاً: نتائج مدروسة"
subtitle="قوة الخطة تكمن في تزامن المحاور الثلاثة"

# LEFT — Target numbers card
rect  left=0.25 top=1.22 w=4.50 h=3.60 fill=white
rect  left=0.25 top=1.22 w=4.50 h=0.06 fill=copper
text  left=0.30 top=1.32 w=4.35 h=0.38  Amiri 14pt Bold color=brown align=right rtl  text="أرقام الترويج المستهدفة"

# 5 metric rows at y = 1.80, 2.38, 2.96, 3.54, 4.12; each w=4.35 h=0.52, fill alternates #FFF7F2 and white
# big number (Amiri 22pt Bold copper, align=center in its own box) on the physically-left side at x=0.32 w=1.50
# label (Amiri 12pt charcoal align=right rtl) on the physically-right side at x=1.88 w=2.72
# Row values (replace with project targets):
#   700,000 | "مشاهدة مستهدفة"
#   1%      | "نسبة التحويل إلى مهتمين"
#   7,000   | "مهتم مستهدف"
#   0.6%    | "نسبة تحويل المهتمين إلى مبيعات"
#   43      | "وحدة مباعة — إجمالي المشروع"

# RIGHT — Why it works card
rect  left=4.95 top=1.22 w=4.80 h=3.60 fill=brown
rect  left=4.95 top=1.22 w=4.80 h=0.06 fill=gold
text  left=5.00 top=1.30 w=4.65 h=0.42  Amiri 14pt Bold color=gold align=right rtl  text="لماذا تنجح هذه الخطة؟"

# 4 items. For each, a gold diamond glyph on the right (x=5.05) and two lines of text next to it
# item y positions: 1.91, 2.65, 3.39, 4.13
# diamond char "◈" Amiri 14pt color=gold
# title line: Amiri 12.5pt Bold color=white align=right rtl
# body line:  Amiri 11pt color=sand align=right rtl
# items:
#   "المحتوى يخلق الرغبة" / "فيديوهات تُحوّل المشروع إلى تجربة إستثنائية"
#   "الترويج يجلب العميل" / "استهداف دقيق يصل للمشتري الجاهز"
#   "الحفل يسرّع القرار" / "بيئة مثالية للحجز الفوري من اليوم الأول"
#   "إدارة العملاء تُغلق الصفقة" / "متابعة منهجية حتى اكتمال البيع"

# Tagline strip (full width, copper)
rect  left=0.25 top=4.95 w=9.50 h=0.40 fill=copper
text  left=0.30 top=4.98 w=9.35 h=0.32  Amiri 15pt Bold color=white align=center rtl  text="نحن لا ننتظر العميل —  نحن نصنعه"
```

---

## Slide 11 — Divider: `الخطة البيعية`

Divider chrome. Subtitle is **exact**: `تحويل الطلب والاهتمام إلى مبيعات`.

---

## Slide 12 — Sales journey (horizontal serpent, 10 stages)

Content chrome. Two rows × 5 cards in a horizontal serpentine. Row 1 reads right-to-left (stages 1→5), row 2 reads left-to-right (6→10). An L-shaped gold bridge connects row 1 end to row 2 start. Stage 10 is a copper-filled finale card with a white checkmark. Each card has a dark-brown number-strip on its physically-right edge.

```
title="عملية المبيعات —  مسار العمل"
subtitle="رحلة العميل من أول تواصل حتى الإفراغ"

# Card sizing (all cards, uniform):
#   total card w = 1.72 (body 1.38 + right-edge number strip 0.34)
#   card h = 0.62
#   horizontal gap between cards in a row = 0.18
# Grid: 5 × 1.72 + 4 × 0.18 = 9.32 in. Center in 10.00 → left margin ≈ 0.34.

# Card body:
#   fill = white   (stage 10 is COPPER — see finale below)
#   outline = sand #E8D9C0 (1pt)
# Right-edge number strip (width=0.34):
#   fill = brown #6B4226
#   number: "01".."09" in Amiri 13pt Bold, color=gold, centered. Arabic-Indic
#   digit conversion is automatic — the string "01" renders as "٠١".
# Body text (title):
#   Amiri 11pt Bold, color=brown, align=center, rtl

# Row 1 — y=1.95. Reads R→L. Stage 1 is physically rightmost.
#   Physical column 4 (rightmost): stage 1 "استقبال العميل"
#   Physical column 3:             stage 2 "التواصل وجمع البيانات"
#   Physical column 2:             stage 3 "حجز الموعد"
#   Physical column 1:             stage 4 "تأكيد الموعد"
#   Physical column 0 (leftmost):  stage 5 "الزيارة"

# Row 2 — y=3.45. Reads L→R. Stage 6 is physically leftmost.
#   Physical column 0 (leftmost):  stage 6  "متابعة بعد الزيارة"
#   Physical column 1:             stage 7  "تقديم عرض السعر"
#   Physical column 2:             stage 8  "الحجز"
#   Physical column 3:             stage 9  "التمويل"
#   Physical column 4 (rightmost): stage 10 "الإفراغ" — FINALE

# Horizontal connectors (same-row transitions):
#   Thin gold bars (fill=gold #D9B57F, height=0.06) in the vertical middle of
#   each card row, bridging card-to-card between stage and stage+1. Each bar
#   spans exactly from the trailing edge of one card to the leading edge of
#   the next.

# L-bridge (row 1 → row 2):
#   Vertical gold bar from the bottom-left edge of stage 5 to the top-left
#   edge of stage 6. Both stages share the same physical-left x, so the
#   bridge is a straight vertical drop. A small horizontal stub (0.22in wide)
#   extends right at the top of stage 6 to visually merge the bridge with
#   the first card of row 2.

# Stage 10 finale (full-copper card):
#   Body fill: copper #B8734F (instead of white)
#   Number strip: same brown+gold as other cards
#   Content inside the body is split into two zones:
#     Left zone (width 0.40): gold/white "✓" in Amiri 22pt Bold, centered
#     Right zone: "الإفراغ" in Amiri 14pt Bold, color=white, centered rtl
```

---

## Slide 13 — Detailed sales journey (10 step cards, 2 columns)

Content chrome. 10 step cards arranged in 2 columns × 5 rows. Right column (physically right, steps 1–5) and left column (physically left, steps 6–10). Each card has a copper numbered badge hanging off its physically-right edge.

```
title="عملية المبيعات —  النسخة التفصيلية"
subtitle="10 خطوات منهجية من أول تواصل حتى إغلاق الصفقة"

# Each step card: w=4.68 h=0.74, alternating fills white / cream #F8F5E9
# Numbered badge: 0.35×0.35 copper circle/square with white bold number, positioned on the physically-right edge of the card
# title: Amiri 12pt Bold color=brown align=right rtl  (full width of card minus badge)
# subtitle: Amiri 9.5pt color=charcoal align=right rtl

# Right column (steps 1-5), x=5.08, card_y = 1.22, 2.04, 2.86, 3.68, 4.50
#   Badge x = 9.60 (at each card's right edge)
# Left column (steps 6-10), x=0.25, card_y = 1.22, 2.04, 2.86, 3.68, 4.50
#   Badge x = 4.77

# Step labels and blurbs (all written in Arabic):
# 01 استقبال العميل        — "تسجيل تلقائي في النظام وبدء مسار المتابعة فوراً"
# 02 التواصل وجمع البيانات — "اتصال خلال دقائق، جمع نوع الوحدة والميزانية والهدف، تصنيف الجدية"
# 03 حجز الموعد            — "اقتراح وقت محدد، تثبيته في النظام، إرسال تأكيد فوري للعميل"
# 04 تأكيد الموعد          — "تذكير قبل يوم واتصال في نفس اليوم لرفع نسبة الحضور"
# 05 الزيارة الميدانية     — "استقبال العميل وعرض الوحدات المناسبة بتجربة احترافية"
# 06 المتابعة بعد الزيارة   — "تواصل فوري، معالجة الاعتراضات، إعادة تقديم العرض"
# 07 تقديم عرض السعر        — "عرض مخصص بحسب الوحدة والميزانية يُرسَل بشكل منظم"
# 08 الحجز                  — "تثبيت الوحدة وإنشاء مستند الحجز وتحديث حالتها في النظام"
# 09 التمويل                — "متابعة إجراءات التمويل والتنسيق مع الجهات المعنية"
# 10 الإفراغ                — "استكمال الإجراءات النهائية ونقل الملكية وإصدار المستندات"
```

---

## Slide 14 — Sales plan by the numbers (formula-driven monthly table)

Content chrome. Right 20% = vertical brown KPI sidebar (unchanged from earlier design). Left 80% = a monthly-breakdown **table** (17 rows) where every value is derived from a single input via fixed conversion constants. No PowerPoint `<a:tbl>` — every cell is drawn as individual rectangles so it renders reliably across PowerPoint versions.

```
title="خطة المبيعات بالأرقام"
subtitle="قمع المبيعات الشهري — مشروع <PROJECT_NAME>"

# RIGHT KPI sidebar (unchanged)
rect  left=7.82 top=1.22 w=1.93 h=4.15 fill=brown
rect  left=7.82 top=1.22 w=1.93 h=0.06 fill=gold
text  left=7.85 top=1.30 w=1.85 h=0.40  Amiri 11pt Bold color=gold align=center rtl  text="مؤشرات التحويل"
# 4 KPI pairs: big number (Amiri 22pt Bold color=gold) + label (Amiri 10pt color=sand)
# y positions: 1.78/2.20, 2.63/3.05, 3.48/3.90, 4.33/4.75
# pair 1: "<OVERALL_CONVERSION%>"   / "نسبة التحويل الإجمالية"
# pair 2: "<LEADS_PER_SALE>"        / "مهتم لكل وحدة مباعة"
# pair 3: "<AVG_UNIT_PRICE>"        / "متوسط سعر الوحدة"
# pair 4: "<MONTHS_TO_SELL_OUT>"    / "أشهر لبيع المتبقي من المشروع"

# LEFT — Formula-driven table. Area: x=0.35 y=1.22 w=7.40 h=4.15
# Primary input: content['sales_plan']['leads_per_month']  (monthly leads)
# Fixed constants (NEVER override):
#   appointment_booking_rate = 6%
#   appointment_attendance   = 40%
#   natural_visits_multiplier = 2   (natural = 2 × appointment visits)
#   interested_from_visits   = 20%
#   booking_rate             = 60%
#   sale_from_booking        = 80%
# All derived numbers use round() — nearest integer.
# Fixed-constant percentages display with 2 decimals (6.00%, 40.00%, etc.)
# Derived percentages use 1 decimal (9.3%, 0.7%, etc.)

# Table structure:
#   Header row (h=0.35, copper fill): "الخطة البيعية الشهرية" centered, white Amiri 13pt Bold
#   Body: 17 rows, row_h = (4.15 - 0.35) / 17 ≈ 0.224
#   Alternating row fills: RGBColor(0xFF, 0xF7, 0xF2) / white
#   Column split: label takes 60% of width on the right (Amiri 10.5pt color=brown, align=right rtl)
#                 value takes 40% on the left  (Amiri 11pt Bold color=copper, align=center)

# Rows (label + formula, in order):
#   1  "المهتمين"                      = leads                              (INPUT)
#   2  "نسبة حجز موعد %"               = 6.00%                              (const)
#   3  "المواعيد"                       = round(leads × 0.06)
#   4  "نسبة الحضور %"                  = 40.00%                             (const)
#   5  "زيارات المواعيد"                = round(appointments × 0.40)
#   6  "الزيارات الطبيعية"               = 2 × appointment_visits
#   7  "إجمالي الزيارات"                = appointment_visits + natural_visits
#   8  "المهتمين %"                     = 20.00%                             (const)
#   9  "عروض الأسعار"                   = round(total_visits × 0.20)
#  10  "نسبة الحجز %"                   = 60.00%                             (const)
#  11  "الحجوزات"                       = round(offers × 0.60)
#  12  "نسبة البيع من الحجوزات"         = 80.00%                             (const)
#  13  "المبيعات"                       = round(bookings × 0.80)
#  14  "نسبة الزيارات الى المبيعات"     = (sales / total_visits) × 100       (derived %)
#  15  "إجمال نسبة التحويل"             = (sales / leads) × 100              (derived %)
#  16  "عدد المهتمين للبيعة الوحدة"    = round(leads / sales)
#  17  "إجمالي الوحدات المباعة"         = sales  (monthly, same as row 13)
```

---

## Slide 15 — Closing

Divider chrome (brown bg, copper left strip with Najdi triangular-notch pattern, gold lines top and bottom). Centered large logo at top, big title in cream, subtitle in sand, three cream pillar cards, and `wassel.re` as the finishing line.

```
background: brown #6B4226 full canvas

# gold top and bottom lines
rect  left=0.55 top=0.00  w=9.45 h=0.04 fill=gold
rect  left=0.55 top=5.58  w=9.45 h=0.04 fill=gold

# Centered logo (big)
image left=4.29 top=0.24 w=1.96 h=1.96  src=assets/wassel_logo_white.png

# Title
text  left=0.70 top=2.20 w=9.10 h=0.72  Amiri 36pt Bold color=cream align=center rtl  text="شراكة تسويقية متكاملة"

# Subtitle
text  left=0.70 top=2.90 w=9.10 h=0.42  Amiri 16pt color=sand align=center rtl  text="وصل العقارية —  النظام الذي يُحوّل الاهتمام إلى مبيعات"

# 3 cream pillar cards — each w=2.82 h=1.60, top copper accent 0.06
# positions: x = 0.72, 3.77, 6.82 (right-to-left reading)
# title: Amiri 14pt Bold color=brown align=center rtl
# body: Amiri 12pt color=charcoal align=center rtl

# card 1 (rightmost, x=0.72):  "إطلاق قوي"  / "زخم من اليوم الأول"
# card 2 (middle, x=3.77):     "تسويق مركّز" / "المحتوى والترويج يصلان للعميل الصحيح"
# card 3 (leftmost, x=6.82):   "إغلاق منهجي" / "١٠ خطوات تُحوّل الاهتمام إلى حجوزات"

# wassel.re tagline at bottom — SHAPE-LEVEL hyperlink (NOT run-level).
# The run-level hyperlink triggers PowerPoint's theme to override color & add
# underline. Use shape_hyperlink so the text stays gold/copper as set.
text  left=0.70 top=5.20 w=9.10 h=0.28  Amiri 13pt color=gold align=center  text="wassel.re"   shape_hyperlink=https://wassel.re
```
