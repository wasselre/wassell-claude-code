---
name: writing-video-script
description: Write a Saudi Arabic video-ad / reel script for one of OUR real-estate projects, learned from competitors' transcribed videos. Use whenever the user asks to write a video script, reel script, ad script, «سكربت», «نص إعلان», or «سكربت ريل» for a named project (e.g. "write a video ad for أكنان 25"). Pulls the project's real facts from all_projects + the most relevant competitor video transcripts (mkt_transcripts), learns the recurring ad structure, and writes a scene-by-scene script in the marketer's own house voice. This is a LIVING skill — every operator note is logged below and never re-asked.
---

# Writing Video Script — learn from competitors, write for us

## ⭐ META-RULE (read first, never violate)
**This skill is LIVING.** Every time the operator reacts to a draft ("hook 2 is
better", "too long", "don't say X", "always open with the price"), you **MUST
immediately edit this file** and record it as a permanent rule in the
**Decisions Log** at the bottom — so it's never re-litigated. Each reaction is a
patch to the skill, not a one-off. The goal is to converge on scripts the
operator approves first-try.

## What this does
Turn one of our projects into a ready-to-film video ad, in the exact style the
competition (and our own marketer channel) already uses — grounded in the
project's real numbers, never invented.

Three steps: (1) load the project's facts, (2) study competitor transcripts to
refresh the recipe, (3) write the script + alternative hooks.

## Prod IDs (Supabase project `zhqqsxwealdwqzrbpwyv`, read via the Supabase MCP)
- all_projects model id: `220c49b9-de57-492d-9eca-c0d9f54fd40f`
- Competitor transcripts: `mkt_transcripts` (join `mkt_content_posts` + `mkt_content_enrichment` + `mkt_organizations`).

## Step 1 — load the project's real facts
Resolve by name (try the exact and folded spellings the operator used):
```sql
select id, data from unified_records
where model_id='220c49b9-de57-492d-9eca-c0d9f54fd40f'
  and (data->>'project_name' ilike '%<name>%' or data->>'name' ilike '%<name>%');
```
Read from `data`: `project_name`, `city_name`/`preferred_neighborhoods` (district),
`developer` + marketer (from `source_notes`/`marketing_document`), `unit_types`,
`area_range`/`available_area_range`, **`available_price_range`** (the customer-facing
start price), `bedroom_range`, `features[]`, `guarantees[]`, `nearby_landmarks[]`,
`construction_status`, and the show-unit + marketer phone if present in
`marketing_document`. The `marketing_document` / `project_analysis` fields are the
richest human-written source — mine them first.

## Step 2 — study competitor transcripts (refresh the recipe)
```sql
select t.language, round(t.duration_ms/1000.0) secs, o.name_ar org,
 e.result->>'content_type' ctype, left(t.text, 600) txt
from mkt_transcripts t
join mkt_content_posts p on p.id=t.content_post_id
join mkt_organizations o on o.id=p.organization_id
left join mkt_content_enrichment e on e.content_post_id=p.id and e.status='done'
where t.status='done' and length(t.text)>220
  and (e.result->>'content_type' in ('walkthrough','offer','project_launch'))
order by (o.name_ar = '<the project's marketer>') desc, length(t.text) desc
limit 12;
```
Prefer transcripts from **the same marketer** (matches the channel voice) and
**same district** where possible. NOTE: the ASR often outputs English
translations of Arabic speech — learn the STRUCTURE and the recurring Arabic
phrases from them, not verbatim wording.

## The recipe (the recurring 7-beat structure — keep in sync as we learn)
1. **Hook** — a scroll-stopper (see Decisions Log for the preferred style).
2. **Location anchor** — «اليوم في شمال الرياض، حي … تحديدًا».
3. **Positioning / product variety** — what makes it distinct.
4. **Feature walk** — conversational, with «ما شاء الله تبارك الله».
5. **Specs → variety → entry price**.
6. **Trust signals** — ready-to-move / guarantees.
7. **CTA** — show unit + marketer contact.
Tone: warm, hospitable, Saudi dialect, light religious warmth (بسم الله، ما شاء الله).

## Hard rules (never violate)
1. **Every number comes from the project record.** Never invent a price, area,
   count, distance, or guarantee. If a fact is missing, omit it — don't guess.
2. **Use the AVAILABLE price range as the "starts from".** Customer-facing outputs
   quote `available_price_range`, not the all-unit range (a sold-out tier must
   never set the headline price). See CLAUDE.md "persisted project rollups".
3. **Off-plan flag works BOTH ways.** If `construction_status` is off-plan / «على
   الخارطة», say it clearly. If it is **ready**, sell «جاهزة للسكن / استلام فوري»
   as the advantage — never imply off-plan when it's ready, and never imply ready
   when it's off-plan.
4. **Study the marketer's voice, but NEVER name them.** Learn the style from
   their transcripts — the script is OURS. See rule 7.
5. **Arabic-Indic numerals on-screen** (١٬٠٥٠٬٠٠٠), currency ر.س. Voiceover in
   natural Saudi dialect.
6. Keep it filmable: ~45–60s, ≤8 scenes, one idea per scene.
7. **The ONLY company named is وصل العقارية (Wassel).** The single exception is the
   project's **DEVELOPER**, which may be named (e.g. «أكنان»). **NEVER** name the
   marketer in our data (e.g. ريفا العقارية), any competitor, or any agency. **Every
   CTA and every contact is Wassel** — «للحجز والاستفسار: وصل العقارية» — never a
   marketer's name, number, license, or portal. Do NOT fabricate a phone: if
   Wassel's real contact isn't provided, use the brand CTA «تواصل معنا — وصل
   العقارية». (The marketer/broker fields in the record — ريفا, 920016028, license
   numbers, riva.sa — are for OUR matching only; they must never reach the script.)

## Output format
A scene table — **# · المشهد (visual) · التعليق الصوتي (Arabic VO) · نص على الشاشة**
— then **3 alternative hooks** in the preferred style, then a short "Facts used /
checks" note (which record, that the off-plan flag was applied correctly, price
source). Deliver the script directly in chat (no file needed unless asked).

## Components — how this becomes an in-app BUTTON
The skill decomposes into 7 components. An in-app **«اكتب سكربت» / "Write script"**
button on a VIDEO content record re-implements them as one server endpoint — the
skill file stays the SPEC, the endpoint mirrors it:

1. **Project resolver.** The content record already carries its project link, so
   there is NO project picker — the button inherits the project from the record,
   then loads that project's facts from all_projects (Step 1 query).
2. **Competitor learner.** Pull the most relevant competitor video transcripts
   (Step 2 query): filter to walkthrough / offer / project_launch, prefer the same
   district and a marketer whose voice fits, cap ~12, longest first. This is the
   "systematically look through competitors' content" step.
3. **Recipe.** The 7-beat structure + tone (above) — goes into the prompt.
4. **Rules.** The Hard rules + this Decisions Log — become the system prompt. The
   operator's learned preferences (Wassel-only, off-plan both ways, hook style…)
   are the whole differentiator vs a generic AI.
5. **Generator.** ONE LLM call: {project facts + transcript excerpts + recipe +
   rules} → scene table + 3 alternative hooks. Route through the app's text-LLM
   helper (DeepSeek default / Claude fallback per `TEXT_LLM_PROVIDER`), or force
   Claude when script quality matters more than cost.
6. **Output.** Render the scenes for review inside the content record; on approve,
   write them into the record's **scenes** — and they map 1:1 onto `mos_scenes`
   (verified live): scene # → `position`, timing → `start_sec`/`end_sec`,
   visual → `visual`, voiceover → `voiceover`, on-screen text → `on_screen_text`,
   each new scene `footage_status='missing'` (so it auto-populates the shoot
   backlog). The 3 alt hooks go into the content's writing fields (headlines).
   **Non-destructive — never auto-save** (matches the app's anti-silent-failure
   posture). So the generator must emit STRICT scene objects (visual / voiceover /
   on_screen_text / start_sec / end_sec), not prose, so the endpoint inserts rows
   directly.
7. **Feedback loop.** Operator reactions must keep improving it. In-app, the rules
   (component 4) live in an EDITABLE preferences store (a settings row) so the team
   tunes them without a deploy; every approved change is also appended to this
   Decisions Log so the skill and the button stay in sync.

**Where it lives:** the Marketing content detail page, on a video-type record,
gated by `write_content`. Endpoint: a `write_video_script` action taking
`content_id` → runs components 1–5, returns the script, and (on approve) writes
component 6 back into the record.

## Decisions Log (self-improving core — append every operator note, dated)

**2026-09-01 — Hook style (operator: "hook 2 is better").**
Default to a **punchy, question/variety-led hook** that lists the product choice
and lands an immediate benefit — e.g. «تبي فيلا؟ تاون هاوس؟ دور؟ بنتهاوس؟ في
<المشروع> كلها موجودة — وجاهزة تستلمها اليوم.» **Do NOT open with the long
«بسم الله… الله يبارك في وقتكم يا متابعين» greeting as the hook** — that is the
competitors' default but it is too slow to stop a scroll. Warmth (بسم الله / ما
شاء الله) may appear AFTER the hook, inside the walkthrough, not as the opener.
Lead the hook with variety, immediacy ("ready today"), or the entry price.

**2026-09-01 — Only Wassel is named; contact is always us (operator: "you said
contact Riva").** The script may name the project's **developer** and nothing
else. NEVER name the marketer from our data (ريفا العقارية), a competitor, or an
agency, and NEVER route contact anywhere but **وصل العقارية**. The CTA is always
«للحجز والاستفسار: وصل العقارية» (or «تواصل معنا — وصل العقارية») — never a
marketer's name, phone (e.g. 920016028), license, or portal link, even though
those sit in the project record. Applies to voiceover AND on-screen text. This
mistake happened once (أكنان 25 draft closed with "ريفا العقارية 920016028") —
do not repeat it.
