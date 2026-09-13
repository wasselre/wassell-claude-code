---
name: content-enrichment
description: Enrich a batch of collected competitor social posts — decide the primary project (from a pre-narrowed candidate list ONLY, and only with a verbatim quote as proof), general-branding vs project-specific, projects mentioned that we do not know, and structured content fields — from a deterministic evidence package. Reads an evidence JSON file and writes a strict JSON result array. Used by the marketing content-intelligence Claude runner (replaces the Anthropic enrichment API). Invoke as `/content-enrichment <evidence_file> <result_file>`.
---

# Content enrichment (marketing intelligence)

You are running HEADLESS from the `claude_jobs` queue. No one can answer questions — decide everything autonomously and write ONE result file. This replaces a direct Anthropic API call, so your output must be strictly machine-parseable.

## Inputs
Two absolute paths are given in the prompt: `<evidence_file>` (input) and `<result_file>` (output).

Read `<evidence_file>` — a JSON **array**. Each element is one post:
```
{ "post_id": "uuid", "platform": "instagram|tiktok|youtube", "post_type": "...",
  "account": "@handle (platform)",
  "organization_name": "الرمز",
  "brand_tokens": ["الرمز", "alramz", ...],
  "sibling_projects": ["ربوة الرمز", "ستون الملقا", "برج الرمز", ...],
  "attribution_locked": false,
  "caption": "...", "transcript": "...", "ocr_text": "...",
  "candidates": [ { "projectId": "uuid", "nameAr": "...", "nameEn": "...", "confidence": 0.0,
                    "strength": "full_name|number|word", "ambiguous": false,
                    "matchedAliases": ["..."] } ],
  "evidence_lengths": { "caption": 804, "transcript": 1081, "ocr_text": 1360 },
  "evidence_truncated": { "caption": false, "transcript": false, "ocr_text": false } }
```

`candidates` is the ONLY set of projects you may attribute to. It was narrowed deterministically upstream. **You may NOT invent or reference any project outside this list** — but you CAN (and must) report other projects the post names, in `mentioned_projects`.

What the candidate labels mean:
- `strength: "full_name"` — the project's whole name appears in the evidence. Strong.
- `strength: "number"` — the project's distinctive number appears (174, or "ريفييرا 44"). Strong.
- `strength: "word"` — ONE word of the name appears. **Weak.** Treat it as a hint, not an answer: choose it only if the post concretely promotes that project, and quote the words that prove it.
- `ambiguous: true` — a lone-word match, or several projects matched. Extra caution.

## Read the WHOLE evidence, never a preview
A project reference frequently appears **late** in a caption — after the hook, the
emoji block, or several lines of ad copy. Judging from the opening words alone
produces confident, wrong answers (a real review once mis-called a correct
attribution a false positive after reading only the first 45 characters).

- Evaluate the **entire** `caption`, `transcript` and `ocr_text` before deciding.
- If any `evidence_truncated` flag is `true`, the text you were given is
  incomplete. Decide from what you have, but be conservative: prefer `-1` over a
  guess, and say so in `reasoning` (e.g. "caption truncated at 8000 chars").

## Your job — per post
Combine caption + transcript + ocr_text and decide:

1. `primary_project_index` — the **index into that post's `candidates` array** that this content primarily promotes, or **-1** if it is general company branding / no specific project / a project that is not a candidate.
2. `evidence_quote` — **REQUIRED whenever `primary_project_index` is not -1.** A short verbatim excerpt (6–200 characters) copied EXACTLY from `caption`, `transcript` or `ocr_text` that names the chosen project concretely — the project name, its number, or the name with its unit/price/offer. The validator checks the quote really occurs in the evidence and really contains the project's name (not just the company's brand word); a pick without a valid quote is discarded and becomes -1. Use `""` when the index is -1.
3. `mentioned_projects` — names of projects the post clearly promotes or announces that are NOT in `candidates` (e.g. the caption says «مشروع ديارا الروضة D1» and no candidate is that). Copy the name as written, without «مشروع». Empty array when none. This is how catalog gaps become visible instead of being forced onto the nearest candidate.
4. `is_general_branding` — true when the post is a national day (يوم التأسيس / اليوم الوطني / Founding Day), sports/match support, leadership/allegiance, quality certification, company services (design, furniture, consulting), or pure brand-value content.
5. Structured fields (only from evidence — never invent): `content_type` (project_launch|offer|walkthrough|testimonial|teaser|brand|event), `objective`, `offer`, `financing`, `payment_plan`, `price`, `unit_types` (array), `location`, `district`, `amenities` (array), `selling_points` (array), `ctas` (array), `language` (ar|en|mixed|none), `campaign_message` (one line).

### Critical attribution rules
- **The company's own name is NEVER project evidence.** `brand_tokens` lists the publisher's name words and account handles. A post that only carries the brand (logo, tagline, "في عزوم نوفرلك كل شيء", "ديارا العقارية تملك بيت أحلامك") is `-1`, even when a candidate's name starts with that brand word. This rule was ignored on ~half of such posts before; it is now enforced by the validator through the quote.
- **A sibling is not a candidate.** If the post names a project in `sibling_projects` (or any other project) that is NOT in `candidates`, return `-1` and put that name in `mentioned_projects`. Never map "ستون الملقا" onto "ستون الندى" because they share a word.
- **A district is not a project.** "جنوب الربوة" is a place; it is not evidence for "ربوة الرمز". A place name counts only inside the project's actual name.
- **Weak candidates need a concrete reference:** for `strength: "word"` choose the project only when the evidence carries the project's actual name/number or a unit/price/offer explicitly tied to it — and quote it.
- Choose `primary_project_index` ONLY from the candidate list. If evidence doesn't clearly point to one candidate, return `-1`.
- `attribution_locked: true` means a human already fixed this post's project. Still fill the structured fields; your index is ignored, so return `-1` with an empty quote.
- Do NOT invent prices, offers, or districts not present in the evidence.

### What counts as an `offer` (be strict)
`offer` is for a **commercial incentive** — a concrete benefit the buyer receives:
a discount, an installment or payment plan, cashback, a waived or free item, a
gift, or a time-limited deal. Examples: `خصم 10%`, `تقسيط حتى 60 شهر`,
`إعفاء من رسوم التسجيل`, `دفعة أولى 5%`.

These are **NOT offers** — each has its own field:

| Text | Field |
|---|---|
| `تملك الفخامة` / `Own The Luxury`, `عزنا بطبعنا`, `حياة برفاه` | `selling_points` |
| `راعي ماسي` / `Diamond Sponsor` (sponsorship badge) | `selling_points` |
| `انتظرونا` / `Stay Tuned` / `SOON` (teaser) | `selling_points`, and `content_type: teaser` |
| `تحكم ذكي` / `Smart Control`, `مساحات رحبة`, `مجتمع متكامل` | `amenities` |
| `مواقع حيوية` / `Prime Locations` | `selling_points` |

**Most posts contain no offer at all.** Leaving `offer` empty is the normal and
correct answer — an empty field is far more useful than a slogan recorded as a
commercial term, because these values feed price/offer trend analysis and a
"new offer detected" alert. A tagline logged as an offer produces a false alert.

`financing` and `payment_plan` follow the same rule: a real financing product or
instalment structure, not a claim that a project is "affordable".

## Output — write `<result_file>` LAST
Write a JSON **array**, one element per input post, in the SAME order, exactly:
```
[ { "post_id": "<same uuid>", "primary_project_index": <int -1..candidates.length-1>,
    "evidence_quote": "<verbatim excerpt or \"\">",
    "mentioned_projects": [],
    "is_general_branding": <bool>, "content_type": "...", "objective": "...",
    "offer": "...", "financing": "...", "payment_plan": "...", "price": "...",
    "unit_types": [], "location": "...", "district": "...", "amenities": [],
    "selling_points": [], "ctas": [], "language": "ar|en|mixed|none",
    "campaign_message": "..." } ]
```
Rules for the file: valid JSON only (no markdown fences, no prose around it). Every input `post_id` must appear exactly once. `primary_project_index` must be an integer in `[-1, candidates.length-1]`. Use `""` / `[]` for unknown fields, never null. Writing this file is the LAST thing you do — do not print the JSON to stdout, only write the file.
