---
name: writing-post
description: Write Saudi-Arabic social POST captions (image / carousel) for one of OUR real-estate projects, learned from competitors' post captions. Use whenever the user asks to write a post, caption, «بوست», «منشور», or «كابشن» for a named project (e.g. "write posts for أكنان 25"). Pulls the project's real facts from all_projects + the most relevant competitor CAPTIONS (mkt_content_posts.caption, image/carousel), learns the recurring caption recipes, and writes ready-to-paste captions with hashtags. Sibling of writing-video-script (videos); this one is captions, not scripts. LIVING skill — every operator note is logged below and never re-asked.
---

# Writing Post — learn from competitors, caption ours

## ⭐ META-RULE (read first, never violate)
**This skill is LIVING.** Every operator reaction ("shorter", "don't dump the
component list", "always end with the hashtag", "this hook is better") is a
patch: **edit this file and log it in the Decisions Log** immediately, so it is
never re-litigated.

## What this does
Turn one of our projects into ready-to-paste post captions, in the styles the
competition uses — grounded in the project's real numbers, never invented.
Same three steps as the video skill: (1) load the project's facts, (2) study
competitor CAPTIONS, (3) write the caption(s) in the chosen recipe.

## Prod IDs (Supabase project `zhqqsxwealdwqzrbpwyv`, read via the Supabase MCP)
- all_projects model id: `220c49b9-de57-492d-9eca-c0d9f54fd40f`
- Competitor captions: `mkt_content_posts.caption` (join `mkt_content_enrichment`
  for content_type + `mkt_organizations` for the org).

## Step 1 — load the project's real facts
Same as writing-video-script Step 1 (resolve by name, read `data`: name,
district, developer, unit_types, area/available_price ranges, features,
guarantees, landmarks, construction_status, show unit; mine `marketing_document`
first).

## Step 2 — study competitor DESIGN COPY (the text ON the image) FIRST
A post has TWO text layers: the **on-design copy** written ON the picture (the
headline/tagline the viewer reads first) and the **caption** below it. The
persuasive copy we learn from is the ON-DESIGN text — and we DO capture it: every
post image is OCR'd into `mkt_visual_text` (the image twin of video transcription).
Learn that FIRST:
```sql
select o.name_ar org, left(v.text, 280) on_image_text
from mkt_visual_text v
join mkt_content_posts p on p.id = v.content_post_id
join mkt_organizations o on o.id = p.organization_id
where v.status='done' and p.post_type in ('image','carousel')
  and v.text ~ '[ء-ي]' and length(v.text) between 12 and 280
order by (o.name_ar = '<the project marketer, if useful>') desc, v.created_at desc
limit 16;
```
THEN (secondary) read the CAPTION for the supporting text / specs / CTA / hashtag
conventions:
```sql
select o.name_ar org, p.post_type, p.caption
from mkt_content_posts p join mkt_organizations o on o.id=p.organization_id
where p.caption ~ '[ء-ي]' and length(p.caption) between 100 and 650
  and p.post_type in ('image','carousel')
order by length(p.caption) desc limit 12;
```
**Design copy = the hook; caption = the support.** Learn the hook from OCR.

## Post recipe library (keep in sync as we learn)
1. **Feature / spec post** *(the workhorse)* — ✨emoji headline (project + district)
   → جاهزة/على الخارطة line → المساحة + السعر up top → bulleted m<br>features (or
   components by floor for a single unit) → 📞 CTA → hashtag block. Best for a
   direct sell.
2. **Lifestyle / brand post** — short aspirational prose (no spec dump) + a
   branded/emotive line + minimal hashtags. Best for reach/awareness.
3. **Offer / urgency post** — punchy: price + scarcity ("٥٥ وحدة بس") + a clear
   👇 CTA. Short.
4. **Event / announcement post** — «تعلن … / نعلن …» + 📍/🗓 details + hashtags;
   often bilingual AR+EN. Best for launches, milestones, معارض.
5. **Occasion post** — national day / يوم التأسيس / عيد — one emotive line + a
   brand tie + occasion hashtag. Short, no specs.

## Hard rules (never violate — shared with writing-video-script)
1. **Facts only** — every number from the project record; missing → omit.
2. **Available price range** is the "تبدأ من"; never the all-unit range.
3. **Off-plan flag BOTH ways** — «بيع على الخارطة» + delivery date when off-plan;
   «جاهزة للسكن / استلام فوري» when ready. Never imply the wrong one.
4. **Only وصل العقارية is named**, plus the project's DEVELOPER. NEVER the marketer
   in our data, a competitor, or an agency. **Every CTA/contact is Wassel** — never
   a marketer name, phone, license or portal (even though they're in the record).
5. **Hashtags:** use **#وصل_العقارية** and the project hashtag (e.g. #أكنان_٢٥) +
   generic ones (#عقارات_الرياض, the district). **NEVER a competitor's brand
   hashtag** (e.g. #أوشن_العقارية) — competitors put their own; we put ours.
6. **Saudi dialect**, warm; **Arabic-Indic numerals** (١٬٠٥٠٬٠٠٠), currency ر.س.
7. Hook style per the Decisions Log (punchy / variety- or price-led, not a slow
   greeting).
8. Ready-to-PASTE: emojis, line breaks, and the hashtag block included.

## Output format
For each post, produce TWO layers (state the recipe of each):
1. **The headlines = the on-design copy.** These ARE the design's text — nothing
   else goes on the image. It is the **PROJECT NAME** (wordmark/lead, with the وصل
   logo lockup) + **3–4 SHORT headline lines**. That's the whole design. Do NOT
   stack price/area/units/status/CTA/contact onto the image — competitors don't
   (تل الربوة = name + one tagline; ربوة الرمز = name + two short lines; ستون
   التندى = name + tagline + 3 feature words). The name is non-negotiable — always
   the lead. This is the PRIMARY deliverable — the few punchy lines the designer
   sets in type.
2. **Caption** — where ALL the detail lives: the price, area, units, status,
   amenities, location, + 📞 Wassel CTA + hashtag block.
Ready to paste. No file unless asked.

## Components — how this becomes an in-app BUTTON
Same 7 components as writing-video-script (see that skill), with ONE difference:
a post has no scenes, so **component 6 (Output) writes the caption into the
content record's WRITING fields (headlines / caption)**, not `mos_scenes`. The
button «اكتب بوست» sits on an image/carousel content record, picks a recipe, runs
components 1–5, and (on approve) fills the caption. Non-destructive.

## Decisions Log (self-improving core — append every operator note, dated)

**2026-09-01 — Shared rules seeded (from writing-video-script).** Only وصل
العقارية is named (plus the developer); every contact/CTA is Wassel — never the
marketer (ريفا) or a competitor, no phones/licenses/portals. Off-plan flagged
both ways. Facts only; available price is the "تبدأ من". Hook is punchy /
variety- or price-led, not the slow «بسم الله» greeting.

**2026-09-01 — Hashtags are ours, never theirs.** Use #وصل_العقارية + the project
+ generic/district tags. Never carry a competitor's brand hashtag into our post,
even though competitor captions end with their own (#أوشن_العقارية, etc.).

**2026-09-01 — The PROJECT NAME must be ON the design (operator).** Every
competitor design leads with the project name/wordmark («تل الربوة — عنوانٌ
للراحة»، «أكنان ٢٥ — بدأ البيع»، «ربوة الرمز — لراحة العائلة»). A design without
the project name is a failure. Always put it prominently as the lead/wordmark
(with the وصل logo), the tagline under it, then the facts. This was a real miss:
a 10-post batch once had the name only as a list label, never in the copy.

**2026-09-01 — NEVER say «بدون سعي» (operator, hard rule).** Even when it sits in
the project record's features / marketing_document (يمام بارك had it), NEVER carry
«بدون سعي» into a headline OR a caption. Drop it silently — it is not a selling
line we use. Applies to every post, no exceptions.

**2026-09-01 — The design = project name + 3–4 headlines, NOTHING else
(operator).** Headlines ARE "the shit written on the design." The image carries
the wordmark + 3–4 short punchy lines and stops there. Do NOT put a price/area/
units/status/CTA/contact stack on the image — that was a real miss (a full spec
sheet got rendered onto the design). ALL detail (price, area, units, «على
الخارطة»، amenities, location, CTA) lives in the CAPTION. Proof from competitor
OCR: تل الربوة = name + «عنوانٌ للراحة ومساحات للاستقرار» (one line); ربوة الرمز =
name + «لراحة العائلة» + «نبني مسكنًا ونصنع مستقبلاً»; ستون التندى = name + «راحة
بكافة تفاصيلها» + ٣ كلمات مزايا. A price line may be ONE of the 3–4 only when the
recipe is offer/launch and it's the hook — never a stack.

**2026-09-01 — Learn from the ON-IMAGE text, not the caption (operator).** A
post's persuasive copy is what's written ON the design (headline/tagline). We DO
capture it: every post image is OCR'd into `mkt_visual_text`. Learn the design
copy from THERE; the caption is only the supporting text/specs/CTA/hashtags.
Always output BOTH layers, design copy first. (Real examples that made the point:
الرمز «عنوانٌ للراحة ومساحات للاستقرار»، مينا «لأن القيمة الحقيقية لا تنتهي عند
البيع».)
