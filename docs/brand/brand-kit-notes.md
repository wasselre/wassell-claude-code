# Brand kit notes — what came from where

Companion to `brand-kit.draft.json` (a `BrandKit` per `src/lib/creative/contracts.ts`).
Status: **draft, advisory** — nothing here is enforced until a reviewer with the
`approve_creative` capability promotes it (contracts §0 rule 12).

Every entry below is labelled **[documented]** (a source says it, quoted) or
**[inferred]** (I derived it; the reviewer must confirm or strike it).

---

## 1. Palette

The 2026 canon, transcribed from `brand/README.md` and verified against the
delivered sheet `brand/الألوان.png` (I read the image — hex, RGB, CMYK and
Pantone all match the README table):

| Name | Hex | Roles in the kit | Role evidence |
|---|---|---|---|
| Copper Bronze | `#B8734F` | primary, cta, accent_strip | [documented] "Primary" (palette sheet + README); header/footer strips and accent bars throughout `slide_templates.md`; CTA/tag-pill on the cover slide |
| Deep Terracotta | `#A6482A` | hover, emphasis | [documented] "Hover / emphasis" (README + sheet); `render_study.py` uses it for the header sub-line and `.alt h4` |
| Warm Sand/Beige | `#E8D9C0` | divider, soft_background, border | [documented] "Borders, dividers" (README + sheet); footer band + left strip in `slide_templates.md` |
| Rich Chocolate Brown | `#6B4226` | dark_ground, headline_on_light, header_band, wordmark | [documented] "Headers, contrast areas, Arabic wordmark" (README); divider-slide background + header band in `slide_templates.md`; wordmark chocolate colourway visible in `الخط.png` |
| Soft Cream | `#F8F5E9` | page_background, light_text_on_dark | [documented] "Page + app-icon background" (README); divider titles are cream on brown in `slide_templates.md` |
| Charcoal/Slate Gray | `#3F3F3F` | body_text | [documented] "Body text" (README + sheet) |
| Subtle Gold | `#D9B57F` | badge, highlight, underline | [documented] "Badges, highlights" (README + sheet); gold underline under the brown header band + KPI numbers on dark cards in `slide_templates.md` |
| Website Dark Surface | `#352013` | dark_surface | **[inferred — secondhand]** From the A-BRAND brief ("website dark surfaces #352013 / #1A1009"). The website repo (`C:\Users\rayan\Claude\Wassel Website`) is outside this worktree's allowed directories; both the Read tool and shell were refused. **Reviewer: verify against `Wassel Website/index.html` lines 25–125.** |
| Website Dark Surface Deep | `#1A1009` | dark_surface_alt | **[inferred — secondhand]** Same as above. |
| White | `#FFFFFF` | light_text_on_dark, logo_on_dark, card_fill | [documented] Explicit member of the allowed palette in both deck engines (`wassel_chrome.py`, `review.py`); white logo variants exist in `brand/` |

### The palette conflict (must be resolved by a human, tracked elsewhere)

`tailwind.config.js`, `src/index.css` and `CLAUDE.md` still carry the **retired**
pre-2026 palette (`#8E4E3A`, `#D4B896`, `#4A2C2A`, `#F5EDE0`, `#4A4E54`,
`#C09B5F`). `brand/README.md` says migration "is tracked separately — see the
rebrand inventory in the PR that added this folder." This kit uses the 2026
canon only; the retired values are deliberately NOT listed, not even as
deviations. Note the deck builders (`wassel_chrome.py`, `build_deck.py`,
`review.py`) were already updated to the 2026 values — the drift is confined to
the app shell (Tailwind/index.css/CLAUDE.md).

A smaller conflict inside the canon: `wassel-general-ppt` allows only seven
colours (no terracotta — its emphasis colour is missing), while
`render_study.py` uses all eight including terracotta, and `review.py` allows
the seven plus explicitly-listed platform colours and two one-off fills
(`#FFF7F2`, `#5A371F`). The kit includes terracotta (it is on the delivered
sheet) and treats the one-off deck fills as deck-internal, not brand.

### Usage ratio — [documented]

From the palette sheet (and README): **50% copper · 30% earth tones · 15%
charcoal · 5% gold.** Encoded as `{copper:50, earth:30, charcoal:15, gold:5}`.
"Earth tones" is the sheet's word — it groups terracotta/sand/chocolate/cream.

### Combinations

Allowed — the first two are [documented] directly off the palette sheet, which
prints "Print" (copper + terracotta + chocolate) and "Digital" (charcoal +
sand + gold) swatch groups. The remaining three are [inferred] from the deck
chrome actually in use: cream+copper+chocolate (content slides),
chocolate+gold+cream (divider slides), cream+sand+copper (footer/soft bands).

Avoid — all three are **[inferred]**, reviewer please confirm or strike:
- `[terracotta, copper]` — adjacent large fills read as a hover state change;
  the sheet reserves terracotta for emphasis.
- `[gold, sand]` — text-grade gold on sand fails contrast at body sizes.
- `[charcoal, chocolate]` — two near-equal darks; muddy edge, no hierarchy.

## 2. Typography — mostly [documented]

- **Amiri for display AND body, every script, every size.** `wassel-general-ppt`:
  "Font: Amiri only. Every text element. Every script. Every size. No system
  fonts, no theme fonts, no Latin fallbacks." `wassel-presentation` sets Amiri
  on all three OOXML slots because PowerPoint renders Arabic from the `cs` slot.
- **Arabic-Indic numerals.** Both deck engines convert every Western digit and
  the digit-adjacent `.`/`,` to `٫`/`٬` (bidi stability). The writing skills
  require the same in captions (١٬٠٥٠٬٠٠٠, ر.س).
- **Latin policy: Amiri; bilingual project names allowed.** [documented in
  spirit] — the deck builders leave Latin letters and building codes untouched
  (wrapped in LRM inside Arabic paragraphs); contracts §0 rule 5 allows
  bilingual project names in `latin_name`.
- **Max 2 type sizes per design.** **[inferred]** — from the brief and the
  observed competitor/design practice the writing-post skill codifies (project
  wordmark + 3–4 short lines, one display size + one support size). The deck
  world uses more levels; this rule is scoped to social post designs.
- **Tajawal: observed, unsanctioned.** **[inferred — secondhand]** The brief
  records "Tajawal body observed" on the website. No source sanctions it.
  Flagged in `typography.notes` so the reviewer makes an explicit call.

## 3. Logo — [documented] except where marked

From `brand/README.md` + the files themselves (I read `الأيقونة.png` and
`الشعار العرضي.png`):
- Variants: **horizontal** (`الشعار العرضي`), **vertical/stacked**
  (`الشعار الطولي`), **icon** (`الأيقونة` — the monoline fortress mark alone),
  **wordmark** (`الاسم`). Each ships in a **white** colourway for dark
  backgrounds (`... ابيض.png`).
- The mark: a single continuous copper line drawing a three-tower fortress —
  crenellated merlons, a scalloped frieze band, an arched doorway, and a Sadu
  diamond weave at the base.
- `on_dark: white`; `on_light: copper or chocolate` — [documented] (white
  variants + the copper mark / chocolate wordmark colourways in `الخط.png`).
- `clear_space: 1× icon height` — **[inferred]** (no source states a clear-space
  rule; this is the conventional default). Reviewer confirm.
- `min_size` — **not documented anywhere**; the kit carries a proposal
  (24px digital / 8mm print) explicitly marked "needs reviewer confirmation".
- `default_position: top_start` — [documented] from the deck chrome: logo sits
  top-left of the header band in an RTL layout (i.e. the "start" edge is where
  the language begins reading... the decks place it physically left; the brief
  names the rule `top_start`). Also: app icons flatten the mark onto opaque
  cream inset to 76% of the tile (brand/README.md) — recorded here as context,
  not a kit field.

## 4. Character & motifs — [documented]

Statement: **traditional, clean, Najdi**. Evidence:
- `slide_templates.md` specifies the divider-strip motif by name: "the
  signature Najdi/Diriyah motif — do NOT replace with a dot ladder" — 9 brown
  triangular notches cut into a copper strip, with small brown diamonds between
  them. I read `brand/نمط 7.png`: it is exactly this stepped-notch strip.
- `brand/نمط3.png`: a Sadu weaving band — chevron (`<<<`) strips framing a row
  of rosette medallions, copper line on cream.
- `brand/نمط 4.png`: opposing up/down triangles separated by dot columns.
- `brand/نمط5.png`: stepped diamond / hourglass Sadu columns.
- `brand/نمط6.png`: diamond lattice with dot centres and triangle caps.
- Website motifs (Najdi arch, Sadu ribbon, arch frame, crenellation) are
  **[secondhand]** from the brief (website unreadable, see §1).

`negative_space: generous` — [inferred] from the pattern sheets themselves
(vast empty cream around a single band) and the deck layouts.

**Tension to resolve:** the content-slide chrome in `slide_templates.md` uses a
copper **dot ladder** on the left sand strip, while the divider spec forbids
dot ladders as a notch-strip replacement, and the brief's character statement
says "no dot ladders". I placed "dot ladders" in `image_treatment.avoid` per
the brief; reviewer should decide whether the deck chrome's strip is
grandfathered (it is a deck-internal layout, not post creative).

## 5. Image treatment — [inferred], grounded

Allowed list is grounded in the deck/site patterns (real photography,
full-bleed with a single text band, warm grade, cream negative space, motif
ribbons at edges). Avoid list: crosshatch / dot ladders / stock gloss from the
brief's character statement; glow/drop shadows from the brief's prohibited
list (and nothing in any source uses them); off-palette filters and text over
busy areas are readability corollaries. Reviewer confirm all.

## 6. Prohibited — [documented] sources for each

| Entry | Source |
|---|---|
| Price/spec stack on the design | writing-post Decisions Log 2026-09-01 (two entries): "The design = project name + 3–4 headlines, NOTHING else… a full spec sheet got rendered onto the design — a real miss" |
| «بدون سعي» | writing-post Decisions Log 2026-09-01: "NEVER say «بدون سعي» (operator, hard rule)" |
| Competitor hashtags | writing-post Hard rule 5 + Decisions Log: "Hashtags are ours, never theirs" |
| Emoji as icons | wassel-presentation icon rule: typographic Unicode symbols in a brand colour, "NOT emoji (which render in their own colors)" |
| >2 type sizes | brief (see §2 — inferred) |
| Glow / drop shadows | brief; no source uses them |
| «Wassel CRM» | `review.py` BANNED_SUBSTRINGS + both deck skills: always «نظام وصل» |
| «نادٍ» | `review.py` BANNED_SUBSTRINGS: always «نادي» (non-kasra form) |

Related wording rules that are NOT in the prohibited list because they belong
to `writer_rules` (A-DB's seed), not the visual kit: parentheses banned in
free-text deck copy; exact divider subtitles; city-before-district tag order;
Wassel-only CTA/contact (writing-video-script Decisions Log).

## 7. Open questions for the reviewer

1. Verify the two website dark surfaces (`#352013`, `#1A1009`) against
   `Wassel Website/index.html` — I could not read that repo from this worktree.
2. Tajawal on the website: sanction it (add to `latin_policy`/notes) or flag
   the website for migration to Amiri?
3. Clear-space (`1× icon height`) and min-size (24px/8mm) proposals — confirm
   or replace with the designer's real values.
4. The three `combinations_avoid` entries are inferred — confirm or strike.
5. Dot-ladder tension (§4): is the content-slide dot ladder grandfathered?
6. `usage_ratio` is per-composition guidance from a print-oriented sheet —
   confirm it should steer social designs (advisory only while mode=advisory).
7. `approved_example_ids` is empty by design — populated later via
   `design_example_set` once `mos_design_examples` has approved rows.
