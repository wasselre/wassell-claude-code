---
name: content-enrichment
description: Enrich a batch of collected competitor social posts — decide the primary project (from a pre-narrowed candidate list ONLY), general-branding vs project-specific, and structured content fields — from a deterministic evidence package. Reads an evidence JSON file and writes a strict JSON result array. Used by the marketing content-intelligence Claude runner (replaces the Anthropic enrichment API). Invoke as `/content-enrichment <evidence_file> <result_file>`.
---

# Content enrichment (marketing intelligence)

You are running HEADLESS from the `claude_jobs` queue. No one can answer questions — decide everything autonomously and write ONE result file. This replaces a direct Anthropic API call, so your output must be strictly machine-parseable.

## Inputs
Two absolute paths are given in the prompt: `<evidence_file>` (input) and `<result_file>` (output).

Read `<evidence_file>` — a JSON **array**. Each element is one post:
```
{ "post_id": "uuid", "platform": "instagram|tiktok|youtube", "post_type": "...",
  "account": "@handle (platform)", "caption": "...", "transcript": "...",
  "ocr_text": "...", "candidates": [ { "projectId": "uuid", "nameAr": "...", "nameEn": "...", "confidence": 0.0 } ],
  "evidence_lengths": { "caption": 804, "transcript": 1081, "ocr_text": 1360 },
  "evidence_truncated": { "caption": false, "transcript": false, "ocr_text": false } }
```

`candidates` is the ONLY set of projects you may attribute to. It was narrowed deterministically upstream. **You may NOT invent or reference any project outside this list.**

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

1. `primary_project_index` — the **index into that post's `candidates` array** that this content primarily promotes, or **-1** if it is general company branding / no specific project.
2. `is_general_branding` — true when the post is a national day (يوم التأسيس / اليوم الوطني / Founding Day), sports/match support, leadership/allegiance, quality certification, or pure brand-value content.
3. Structured fields (only from evidence — never invent): `content_type` (project_launch|offer|walkthrough|testimonial|teaser|brand|event), `objective`, `offer`, `financing`, `payment_plan`, `price`, `unit_types` (array), `location`, `district`, `amenities` (array), `selling_points` (array), `ctas` (array), `language` (ar|en|mixed|none), `campaign_message` (one line).

### Critical attribution rules
- Choose `primary_project_index` ONLY from the candidate list. If evidence doesn't clearly point to one candidate, return `-1`.
- **Brand-name / project-name collision:** many developers name projects after their own brand (e.g. the account "العجلان ريفييرا" and projects "ريفييرا 44/57/59"). A brand logo or tagline that merely echoes the developer name in `account` is NOT project evidence. Require a CONCRETE project reference — a project-specific name that is not just the brand word, OR a unit/price/offer/payment-plan, OR a district tied to that project — before choosing a project. National/founding/sports/brand-value posts are general branding even when a candidate name appears in the OCR.
- Do NOT invent prices, offers, or districts not present in the evidence.

## Output — write `<result_file>` LAST
Write a JSON **array**, one element per input post, in the SAME order, exactly:
```
[ { "post_id": "<same uuid>", "primary_project_index": <int -1..candidates.length-1>,
    "is_general_branding": <bool>, "content_type": "...", "objective": "...",
    "offer": "...", "financing": "...", "payment_plan": "...", "price": "...",
    "unit_types": [], "location": "...", "district": "...", "amenities": [],
    "selling_points": [], "ctas": [], "language": "ar|en|mixed|none",
    "campaign_message": "..." } ]
```
Rules for the file: valid JSON only (no markdown fences, no prose around it). Every input `post_id` must appear exactly once. `primary_project_index` must be an integer in `[-1, candidates.length-1]`. Use `""` / `[]` for unknown fields, never null. Writing this file is the LAST thing you do — do not print the JSON to stdout, only write the file.
