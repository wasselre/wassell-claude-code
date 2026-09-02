---
name: visual-design-read-slide
description: Produce a structured DESIGN READ of marketing creative slides (one entry per image) — layout, typography, palette, hierarchy, branding intensity — using the design-read controlled vocabulary. Reads a manifest JSON listing local image paths and writes a strict JSON result array. Used by the design-read lane on the Claude Code runner (paid subscription, no Anthropic API charge). Invoke as `/visual-design-read-slide <manifest_file> <result_file>`.
---

# Visual design read — SLIDE level (one read per image)

You are running HEADLESS from the `claude_jobs` queue on the `ocr` lane
(kind `mkt_visual_design_slide`). Nobody can answer questions — decide
everything autonomously and write ONE result file. The output feeds a visual
intelligence database (`visual_design_reads`) that a creative director reads
to design Wassel posts, so it must be strictly machine-parseable and use the
controlled vocabulary EXACTLY.

The full vocabulary + reading rules: `docs/creative-director/design-read-vocab.md`
(read it if unsure about an enum; the canonical field list is reproduced below).

## Inputs

Two absolute paths are given in the prompt: `<manifest_file>` and `<result_file>`.

Read `<manifest_file>` — a JSON **array**, one entry per image:
```
{ "media_id": "uuid", "post_id": "uuid", "subject_kind": "competitor_media|wassel_file",
  "carousel_index": 0, "org": "uuid-or-null", "path": "/tmp/mkt-design-slide-xxx/0.jpg" }
```

**Read every image at its `path`.** These are Saudi real-estate marketing
creatives — mostly Arabic, often text baked into the design. You are NOT
transcribing the text (another lane does that); you are reading the DESIGN.

## What to produce, per image — one `SlideRead`

For EACH manifest entry emit `{ "media_id", "post_id", "slide_index", "read" }`
where `read` has EXACTLY these fields (enum values snake_case, EXACTLY as written):

- `slide_role`: `cover|feature|specs|offer|location|proof|lifestyle|cta|brand|other`
- `layout`: `full_bleed_photo_text_bottom|full_bleed_photo_text_top|split_horizontal|split_vertical|text_only|grid|framed|collage|other`
- `text_position`: `top|center|bottom|left|right|band_bottom|band_top|overlay_center|none`
- `text_share`: number 0..1 (canvas fraction covered by text)
- `density`: `low|medium|high`
- `hierarchy`: string[] most-dominant first (e.g. `["headline","price","logo"]`)
- `typography`: `{ "arabic_style": "naskh|kufi|modern_sans|calligraphic|mixed|none",
  "size_levels": int ≥ 1, "weight_contrast": "low|high",
  "latin_present": bool, "numerals": "arabic_indic|western|mixed|none" }`
- `palette`: 3–6 entries `{ "hex": "#RRGGBB", "role": "background|text|accent|logo|band|other", "share": 0..1 }`
- `palette_family`: `warm|cool|neutral|high_contrast`
- `image`: `{ "present": bool, "kind": "photo|render|illustration|graphic|none",
  "subject": "exterior|interior|plan|aerial|lifestyle|people|abstract|none",
  "treatment": string[] }`
- `logo`: `{ "present": bool, "position": string|null, "variant": string|null,
  "size": "small|medium|large|null" }`
- `cta`: `{ "present": bool, "treatment": "button|line|phone|arrow|none" }`
- `decoration`: string[]
- `branding_intensity`: 0|1|2|3 (0 none · 1 logo only · 2 logo + brand
  colours/type · 3 the brand IS the design)
- `mood`: string[]
- `negative_space`: `tight|balanced|generous`
- `readability`: `{ "contrast_ok": bool, "notes": string }`
- `style_tags`: string[]
- `notes`: string (anything the enums cannot say; `""` when nothing)

## Rules

1. Describe the DESIGN, not the project. Never copy prices/offers into the
   read — another lane owns facts. Free-text fields may quote short Arabic
   fragments when they describe the design (e.g. a headline's style).
2. Enum values EXACTLY as written. Free-text fields may be Arabic or English.
3. One entry per manifest item, in the SAME order, every `media_id` exactly
   once. An unreadable/corrupt image still gets an entry: `image.present=false`,
   best-effort enums, and say so in `notes`. Never skip; never invent an id.
4. Hexes are the OBSERVED dominant colours, upper-case `#RRGGBB`, max 6.
5. When torn between two enum values, pick the closer one and explain in `notes`.

## Output — write `<result_file>` LAST

A JSON **array**, one element per manifest entry, in the SAME order:
```
[ { "media_id": "<same uuid>", "post_id": "<same uuid>", "slide_index": 0,
    "read": { …SlideRead… } } ]
```

Valid JSON only — no markdown fences, no prose. Writing this file is the LAST
thing you do — do not print the JSON to stdout.
