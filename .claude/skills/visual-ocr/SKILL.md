---
name: visual-ocr
description: Read the visible text and real-estate promotional fields off marketing creatives (images, video frames, thumbnails). Reads a manifest JSON listing local image paths and writes a strict JSON result array. Used by the marketing OCR lane on the Claude Code runner (paid subscription, no Anthropic API charge). Invoke as `/visual-ocr <manifest_file> <result_file>`.
---

# Visual OCR (marketing intelligence)

You are running HEADLESS from the `claude_jobs` queue on the `ocr` lane. Nobody
can answer questions — decide everything autonomously and write ONE result file.
This replaces a direct Anthropic API vision call, so the output must be strictly
machine-parseable.

## Inputs

Two absolute paths are given in the prompt: `<manifest_file>` and `<result_file>`.

Read `<manifest_file>` — a JSON **array**, one entry per image:
```
{ "media_id": "uuid", "post_id": "uuid", "source": "image|frame|thumbnail",
  "frame_ts_ms": 1234 | null, "path": "/tmp/mkt-ocr-xxx/0.jpg", "platform": "instagram" }
```

**Read every image at its `path`.** These are Saudi real-estate marketing
creatives — Arabic and English, often with text baked into the design.

## What to extract, per image

- `visible_text` — ALL legible text, Arabic and English, preserving the original
  language and reading order. Empty string if there is none.
- `project_names`, `developer_names`, `districts`, `locations`
- `prices` — e.g. `"يبدأ من 850,000 ريال"`
- `payment_plans` — e.g. `"دفعة أولى 10%"`
- `unit_types` — e.g. `"شقق"`, `"فلل"`, `"3 غرف"`
- `phones`, `urls`, `dates`
- `ctas` — calls to action, e.g. `"احجز الآن"`

### `offers` — be strict

`offers` is for **COMMERCIAL INCENTIVES ONLY**: a concrete benefit the buyer
receives — a discount, an instalment or payment plan, cashback, a waived or free
item, a gift, or a time-limited deal. Examples: `خصم 10%`,
`تقسيط حتى 60 شهر`, `إعفاء من رسوم التسجيل`.

A line is **NOT** an offer if it is:

| Text | Correct field |
|---|---|
| `تملك الفخامة` / `Own The Luxury`, `عزنا بطبعنا` | `selling_points` |
| `راعي ماسي` / `Diamond Sponsor` (sponsorship badge) | `selling_points` |
| `انتظرونا` / `Stay Tuned` / `SOON` (teaser) | `selling_points` |
| `تحكم ذكي` / `Smart Control`, `مساحات رحبة` | `amenities` |
| `مواقع حيوية` / `Prime Locations` | `selling_points` |

**Most creatives contain NO offer at all. An empty `offers` array is the normal
and correct answer.** These values feed price/offer trend analysis and a "new
offer detected" alert; a tagline logged as an offer produces a false alert. This
rule exists because 288 of 301 previously extracted "offers" were not offers.

- `amenities` — physical features or facilities (`مسبح`, `نادي صحي`, `مجتمع متكامل`)
- `selling_points` — slogans, taglines, brand value claims, sponsorship badges, teasers

## Rules

- **Do not invent values that are not visible in the image.** If a field has
  nothing, return an empty array (or `""` for `visible_text`).
- Never translate — keep Arabic as Arabic and English as English.
- If an image is unreadable, corrupt, or missing, still emit its entry with
  `visible_text: ""` and empty arrays. Never skip an entry.

## Output — write `<result_file>` LAST

A JSON **array**, one element per manifest entry, in the SAME order:
```
[ { "media_id": "<same uuid>", "post_id": "<same uuid>",
    "visible_text": "...", "project_names": [], "developer_names": [],
    "prices": [], "payment_plans": [], "unit_types": [], "districts": [],
    "locations": [], "phones": [], "urls": [], "offers": [],
    "amenities": [], "selling_points": [], "dates": [], "ctas": [] } ]
```

Valid JSON only — no markdown fences, no prose around it. Every manifest
`media_id` must appear exactly once. Use `[]` / `""` for unknowns, never `null`.
Writing this file is the LAST thing you do — do not print the JSON to stdout.
