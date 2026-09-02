# Design-read controlled vocabulary

*Canonical for the Post Creative Director's static-image design reads
(competitor + Wassel posts/carousels). 2026-09-02. Owner of the enums:
`src/lib/creative/contracts.ts` (`SlideRead`, `PostRead`) — this document
mirrors them verbatim; if the contract changes, change this file and both
skills with it.*

The sibling contract (`docs/marketing-script-visual-contracts.md`) owns the
VIDEO vocabulary (`mkt_cv_*`). This file covers STATIC design reads only —
slides (one image) and posts (a single image or a whole carousel).

## Subjects and levels

One row in `visual_design_reads` = one read of one subject at one level.
`subject_kind` is derived from the OWNING ORGANIZATION of the collected post
(`mkt_organizations.org_type`), never from the media itself:

| subject_kind | level | subject_id | when |
|---|---|---|---|
| `competitor_media` | slide | `mkt_content_media.id` | one stored image of a post whose org is NOT `internal` |
| `competitor_post` | post | `mkt_content_posts.id` | a whole post (single image or carousel) whose org is NOT `internal` |
| `wassel_file` | slide | `mkt_content_media.id` | one stored image of a post whose org IS `internal` (Wassel) |
| `wassel_content` | post | `mkt_content_posts.id` | a whole post whose org IS `internal` (Wassel) |

Slide reads also carry `post_id` (the owning post) and `slide_index`
(the media's `carousel_index`). Post reads carry `post_id = subject_id`.

A read is versioned by `(model_used, rule_version)`: re-reading the same
subject with the same model + rule version upserts in place; a new rule
version produces a new row, so prompts can evolve without destroying history.

## SlideRead (level = slide)

Exactly the fields of `SlideRead` in `contracts.ts`. Enumerations:

- `slide_role`: `cover` | `feature` | `specs` | `offer` | `location` | `proof` | `lifestyle` | `cta` | `brand` | `other`
  - `cover` = carousel first slide designed to stop the scroll; `brand` = a
    slide whose purpose is the developer/marketer identity itself.
- `layout`: `full_bleed_photo_text_bottom` | `full_bleed_photo_text_top` | `split_horizontal` | `split_vertical` | `text_only` | `grid` | `framed` | `collage` | `other`
  - `split_horizontal` = image beside text (left/right); `split_vertical` =
    image above/below text; `framed` = photo inset inside a visible border or
    card on a solid background; `collage` = multiple photos composed together.
- `text_position`: `top` | `center` | `bottom` | `left` | `right` | `band_bottom` | `band_top` | `overlay_center` | `none`
  - `band_*` = text sits inside a solid/translucent strip spanning the width.
- `text_share`: number 0..1 — fraction of the canvas covered by text elements.
- `density`: `low` | `medium` | `high` — overall information load.
- `hierarchy`: free strings, ordered most- to least-dominant (e.g.
  `["headline","price","logo","cta"]`).
- `typography.arabic_style`: `naskh` | `kufi` | `modern_sans` | `calligraphic` | `mixed` | `none`
- `typography.size_levels`: integer ≥ 1 — distinct type sizes in use.
- `typography.weight_contrast`: `low` | `high`
- `typography.latin_present`: boolean
- `typography.numerals`: `arabic_indic` (٠١٢٣) | `western` (0123) | `mixed` | `none`
- `palette[]`: `{ hex: "#RRGGBB", role, share }` — 3–6 dominant colours.
  - `role`: `background` | `text` | `accent` | `logo` | `band` | `other`
  - `share`: 0..1, rough canvas fraction; shares need not sum to 1 exactly.
- `palette_family`: `warm` | `cool` | `neutral` | `high_contrast`
- `image.present`: boolean; `image.kind`: `photo` | `render` | `illustration` | `graphic` | `none`
- `image.subject`: `exterior` | `interior` | `plan` | `aerial` | `lifestyle` | `people` | `abstract` | `none`
- `image.treatment`: free strings (e.g. `["duotone","darkened_for_text","blurred_background"]`).
- `logo.present`: boolean; `logo.position`: free string | null (e.g. `"top_right"`);
  `logo.variant`: free string | null; `logo.size`: `small` | `medium` | `large` | null
- `cta.present`: boolean; `cta.treatment`: `button` | `line` | `phone` | `arrow` | `none`
- `decoration`: free strings (e.g. `["gold_rule","geometric_pattern","diagonal_cut"]`).
- `branding_intensity`: 0 | 1 | 2 | 3
  - 0 = no visible brand; 1 = logo only; 2 = logo + brand colours/typography;
    3 = brand IS the design (identity-first, general-branding style).
- `mood`: free strings (e.g. `["luxurious","calm","urgent"]`).
- `negative_space`: `tight` | `balanced` | `generous`
- `readability`: `{ contrast_ok: boolean, notes: string }`
- `style_tags`: free strings — reusable style labels (e.g. `["minimal_luxury","bold_offer_card"]`).
- `notes`: free string — anything the enum fields cannot say.

## PostRead (level = post)

Exactly the fields of `PostRead` in `contracts.ts`. Enumerations and rules:

- `format`: `single` | `carousel`
- `slide_count`: integer ≥ 1 — MUST equal the number of slides supplied.
- `role_sequence`: array of `slide_role` values (the SlideRead vocabulary),
  length == `slide_count`, in carousel order.
- `narrative_arc`: free string (e.g. `"hook → location → specs → offer → CTA"`).
- `information_progression`: `broad_to_specific` | `specific_to_broad` | `flat` | `alternating`
- `cover_to_cta`: `{ promise_kept: boolean, cta_slide_index: int|null (1-based, ≤ slide_count), cta_type: 'dm'|'call'|'link'|'visit'|'none', notes: string }`
- `slide_relationships[]`: `{ from: int, to: int (1-based, within range), relation: 'continues'|'contrasts'|'zooms_in'|'proves'|'repeats' }`
- `recurring_layout`: `{ template_used: boolean, layout_family: string (a SlideRead layout value or free text), varies_on: string[], fixed: string[] }`
- `visual_continuity`: `{ palette_consistent, typography_consistent, logo_consistent, image_treatment_consistent: boolean, score: 0..1 }`
- `design_system`: `{ palette: [{hex, role}], typography: object, decoration: string[], logo_rules: string }`
- `content_density_profile`: array of `low|medium|high`, length == `slide_count`.
- `branding_intensity`: 0 | 1 | 2 | 3 (post-level, same scale as slides).
- `image_strategy`: `{ mix: Record<string,number> (image.kind → share), asset_dependency: string, reusability: string }`
- `copy_design_relationship`: free string — does copy lead design or vice versa.
- `mood`, `style_tags`: free strings.
- `strengths`, `weaknesses`: free strings — what to copy / what not to copy.
- `learnable`: `{ structure: string, hierarchy: string, avoid: string }` — the
  distilled lesson for the creative director.
- `summary`: free string, 1–3 sentences.

## Reading rules (both levels)

1. Describe what is VISIBLE, never what you infer about the project. A design
   read is about layout, colour, type and composition — not facts.
2. Use the enum values EXACTLY as written (snake_case, English) even though the
   creative is Arabic. Free-text fields may quote Arabic.
3. Every image gets an entry, even an unreadable one (empty/defaults + a note
   in `notes`). Never skip an entry; never invent a media/post id.
4. `branding_intensity` is about the DESIGN's dependence on the brand, not
   whether a logo is present — a slide that is only a logo is a 3, a slide
   with a small corner logo is a 1.
5. Palette hexes are the OBSERVED dominant colours (sampled by eye), upper-case
   `#RRGGBB`. Do not list more than 6.
