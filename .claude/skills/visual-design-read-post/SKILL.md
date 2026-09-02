---
name: visual-design-read-post
description: Produce a structured DESIGN READ of a whole marketing post (single image or carousel) — narrative arc, slide relationships, recurring layout, visual continuity, design system, learnable lessons — using the design-read controlled vocabulary. Reads a manifest JSON listing posts with their staged slide images and writes a strict JSON result array. Used by the design-read lane on the Claude Code runner (paid subscription, no Anthropic API charge). Invoke as `/visual-design-read-post <manifest_file> <result_file>`.
---

# Visual design read — POST level (one read per post, all slides together)

You are running HEADLESS from the `claude_jobs` queue on the `ocr` lane
(kind `mkt_visual_design_post`). Nobody can answer questions — decide
everything autonomously and write ONE result file. The output feeds
`visual_design_reads` (level `post`) which the creative director reads to
design Wassel carousels, so it must be strictly machine-parseable and use the
controlled vocabulary EXACTLY.

The full vocabulary + reading rules: `docs/creative-director/design-read-vocab.md`.

## Inputs

Two absolute paths are given in the prompt: `<manifest_file>` and `<result_file>`.

Read `<manifest_file>` — a JSON **array**, one entry per POST:
```
{ "post_id": "uuid", "subject_kind": "competitor_post|wassel_content",
  "org": "uuid-or-null", "post_type": "image|carousel",
  "slides": [ { "media_id": "uuid", "carousel_index": 0, "path": "…/0-0.jpg" } ],
  "slide_reads": [ { "carousel_index": 0, "read": { …SlideRead… } } ] }
```

- `slides` is in CAROUSEL ORDER — read every image at its `path`.
- `slide_reads` carries the slide-level design reads ALREADY stored for this
  post when they exist (may be `[]`). Use them as evidence — you may trust
  their enum fields — but LOOK AT THE IMAGES yourself; the post read is your
  judgement of the whole, not an average of the parts.

## What to produce, per post — one `PostRead`

For EACH manifest entry emit `{ "post_id", "read" }` where `read` has EXACTLY
these fields (enum values snake_case, EXACTLY as written):

- `format`: `single|carousel`
- `slide_count`: int ≥ 1 — MUST equal the number of slides in the manifest entry.
- `role_sequence`: string[] of slide roles (the SlideRead `slide_role`
  vocabulary), length == slide_count, in carousel order.
- `narrative_arc`: string — the story the carousel tells (e.g.
  `"hook → location → specs → offer → CTA"`).
- `information_progression`: `broad_to_specific|specific_to_broad|flat|alternating`
- `cover_to_cta`: `{ "promise_kept": bool, "cta_slide_index": int|null (1-based),
  "cta_type": "dm|call|link|visit|none", "notes": string }`
- `slide_relationships`: array of `{ "from": int, "to": int (1-based),
  "relation": "continues|contrasts|zooms_in|proves|repeats" }` — the
  significant relationships only (not every pair).
- `recurring_layout`: `{ "template_used": bool, "layout_family": string,
  "varies_on": string[], "fixed": string[] }` — is this one template with
  slots swapped, and what is fixed vs variable.
- `visual_continuity`: `{ "palette_consistent": bool, "typography_consistent": bool,
  "logo_consistent": bool, "image_treatment_consistent": bool, "score": 0..1 }`
- `design_system`: `{ "palette": [ { "hex": "#RRGGBB", "role": string } ],
  "typography": object, "decoration": string[], "logo_rules": string }` — the
  post-level system (the union the slides obey).
- `content_density_profile`: array of `low|medium|high`, length == slide_count.
- `branding_intensity`: 0|1|2|3 (post-level, same scale as slides).
- `image_strategy`: `{ "mix": object (image.kind → share, e.g. {"photo":0.7,"render":0.3}),
  "asset_dependency": string, "reusability": string }`
- `copy_design_relationship`: string — does the copy lead the design or sit on it.
- `mood`: string[] · `style_tags`: string[]
- `strengths`: string[] — what a Wassel designer should copy.
- `weaknesses`: string[] — what to avoid copying.
- `learnable`: `{ "structure": string, "hierarchy": string, "avoid": string }` —
  the distilled lesson: the reusable structure, the hierarchy trick, the trap.
- `summary`: string, 1–3 sentences.

## Rules

1. Whole-post judgement: narrative arc, continuity and cover→CTA promise are
   only visible across slides — never emit a post read from one slide's evidence.
2. `slide_count`, `role_sequence` and `content_density_profile` MUST agree with
   the manifest's slide list; a validator rejects mismatches.
3. Enum values EXACTLY as written. Free-text fields may be Arabic or English.
4. One entry per manifest post, in the SAME order, every `post_id` exactly
   once. Never skip; never invent an id. If every slide is unreadable, still
   emit the entry with best-effort fields and say so in `summary`.
5. A single-image post is a valid post read: `format:"single"`, `slide_count:1`,
   empty `slide_relationships`, arc/progression judged on that one design.

## Output — write `<result_file>` LAST

A JSON **array**, one element per manifest entry, in the SAME order:
```
[ { "post_id": "<same uuid>", "read": { …PostRead… } } ]
```

Valid JSON only — no markdown fences, no prose. Writing this file is the LAST
thing you do — do not print the JSON to stdout.
