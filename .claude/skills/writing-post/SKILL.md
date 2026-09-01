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

## Step 2 — study competitor captions (refresh the recipes)
```sql
select o.name_ar org, p.post_type, e.result->>'content_type' ctype, p.caption
from mkt_content_posts p
join mkt_organizations o on o.id=p.organization_id
left join mkt_content_enrichment e on e.content_post_id=p.id and e.status='done'
where p.caption is not null and length(p.caption) between 100 and 650
  and p.post_type in ('image','carousel') and p.caption ~ '[ء-ي]'
order by (o.name_ar = '<the project marketer, if useful>') desc, length(p.caption) desc
limit 16;
```
Learn STRUCTURE + conventions (emojis, line breaks, bullet lists, hashtag block).

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
1–3 ready-to-paste captions (state the recipe of each). No file needed unless asked.

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
