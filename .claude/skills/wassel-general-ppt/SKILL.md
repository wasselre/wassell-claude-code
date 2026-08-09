---
name: wassel-general-ppt
description: Build any custom Wassel-branded PowerPoint with completely free composition. The brand is enforced (palette, Amiri font, Arabic typography rules, wording rules) but slide size, layout, structure, sectioning, header/footer treatment, card patterns, and visual approach are fully your call — every deck should feel different. Use whenever the user wants a Wassel-branded deck that is NOT the project marketing & sales analysis with the مقام-17 reference structure (that has its own dedicated skill, wassel-presentation). Triggers include company profiles, pitch decks, capability decks, internal presentations, training materials, partner proposals, service overviews, event collateral, mobile/social formats, printed handouts, and any one-off Wassel deck. The skill provides only primitives (colors, font, Arabic typography helpers, logo, drawing functions) — never templates, never layouts, never structural defaults.
---

# Wassel General PPT

Build any custom Wassel-branded `.pptx`. Brand stays. Everything else is yours.

---

## When to use this skill vs `wassel-presentation`

Use **`wassel-presentation`** for project marketing & sales plans with the مقام-17 16-slide structure. It enforces a fixed deck.

Use **this skill** for everything else Wassel-branded — and the goal is **variety**. Every deck composed with this skill should feel completely different from the last: different size, different layouts, different sectioning, different visual approach. Reusing the same look across decks is the failure mode this skill exists to avoid.

If the request is ambiguous, ask one short clarifying question. Don't guess.

---

## What's locked (brand)

These are the only things you must not deviate from. Everything else is your call.

**Palette — only these seven colors anywhere on the deck** (except photos and platform logos):

| Constant | Hex | Role |
|----------|-----|------|
| `COPPER` | `#B8734F` | primary |
| `SAND` | `#E8D9C0` | secondary |
| `BROWN` | `#6B4226` | dark |
| `CREAM` | `#F8F5E9` | light |
| `GOLD` | `#D9B57F` | accent |
| `CHARCOAL` | `#3F3F3F` | dark text |
| `WHITE` | `#FFFFFF` | light text |

**Font: Amiri only.** Every text element. Every script. Every size. No system fonts, no theme fonts, no Latin fallbacks. The engine sets it on all three OOXML font slots so it actually renders for Arabic.

**Arabic typography rules** — auto-applied by `add_text`, you don't think about them:
- Western digits → Arabic-Indic
- `.` and `,` between digits → `٫` and `٬`
- Em-dashes wrapped with RLM in Arabic context
- Line spacing 1.5 when the block has ≥8 words
- Hyperlinks via shape, never run (no blue underlined links)

**Wording rules** — manual, NOT auto-enforced. Check before saving:
- Always `نادي` — never `نادٍ`.
- Always `نظام وصل` — never `Wassel CRM` / `CRM وصل`.
- Latin codes (e.g. `A/B/C/D`) inside Arabic paragraphs wrapped with `LRM` marks.

That is the entire brand contract.

---

## What's free (everything else)

You decide:

- **Size and aspect.** 16:9, 4:3, A4 landscape/portrait, square, Instagram portrait, story format, or any custom `(width, height)`. Pick what fits the deck's purpose. Common presets are exposed as constants (see below) but custom sizes work too.
- **Slide count.**
- **Sectioning, agenda, ordering.**
- **Per-slide layout** — full-bleed, multi-column, asymmetric, hero, list, mosaic, table, image-led, text-led, minimalist, dense — whatever serves the content.
- **Whether to use a header band, a footer band, a left strip, a logo, or none of the above.** The skill does not provide chrome helpers. If a slide wants a header, you compose it from `add_rect` + `add_text` + `add_logo`. Same for footers, dividers, cards, etc.
- **Background color per slide** — any palette color (or `None` for transparent).
- **Spacing, hierarchy, scale, mood.**

Each deck should feel distinct. If two consecutive decks made with this skill look like they came from the same template, the skill failed at its job.

---

## The engine

`scripts/wassel_chrome.py`. **Read its module docstring before composing** — full API, typography rules, and rationale are documented there.

**Public functions:**

```
new_presentation(size=...)                             # canvas — pick the size
blank_slide(prs, bg=CREAM)                             # slide with background fill
add_rect(slide, x, y, w, h, fill, line=None)           # filled rectangle
add_text(slide, x, y, w, h, text, ...)                 # Amiri text + RTL + digit fix
add_logo(slide, x, y, w, h)                            # white Wassel logo
add_shape_hyperlink(shape, url)                        # clickable, no theme override
clean_text(text)                                       # apply text fixes manually
```

**Brand constants** (RGBColor): `COPPER`, `SAND`, `BROWN`, `CREAM`, `GOLD`, `CHARCOAL`, `WHITE`. Plus `FONT` (`"Amiri"`) and `LOGO_PATH`.

**Size presets** (tuples): `SIZE_16_9`, `SIZE_4_3`, `SIZE_A4_LANDSCAPE`, `SIZE_A4_PORTRAIT`, `SIZE_SQUARE`, `SIZE_INSTAGRAM_PORTRAIT`, `SIZE_INSTAGRAM_STORY`. Or pass any custom `(w, h)` tuple.

**Bidi marks** (importable for manual use): `LRM`, `RLM`, `ALM`, `LRE`, `PDF`, `NBSP`.

That is the whole API. There are no `addHeader`, `addFooter`, `addStrip`, `addDivider`, no slide-pattern functions, no card builders. Compose from primitives.

---

## Workflow

1. Understand the brief. Ask the user for purpose, audience, content, language (Arabic / English / mixed), and any constraints. Never invent content.

2. Pick a canvas size that fits the purpose. Don't default to 16:9 reflexively — if it's a printed handout, use A4; if it's social, use square or portrait; if it's screen, 16:9 is fine.

3. Design each slide fresh. Don't reuse layouts from your last deck. Vary backgrounds, structures, hierarchy. Some slides may have a brown header band, some may not. Some may have a footer with `wassel.re`, some may not. Some may be image-dominant, some text-only. The variation is intentional.

4. Write a task-specific Python build script in `/home/claude/`. Import from the engine:

```python
import sys
sys.path.insert(0, "/mnt/skills/user/wassel-general-ppt/scripts")
import wassel_chrome as wc
```

5. Run it. Save the output to `/mnt/user-data/outputs/<descriptive_name>.pptx`.

6. Hand it over with `present_files`. Lead with the file. Keep the chat reply lean: one line on what was built, any omissions or assumptions.

---

## Skill files

```
wassel-general-ppt/
├── SKILL.md                     ← this file
├── scripts/
│   └── wassel_chrome.py         ← the engine (constants + primitives)
└── assets/
    └── wassel_logo_white.png    ← transparent logo for use on dark backgrounds
```

The build script for each deck is an ephemeral task artifact in `/home/claude/`, not part of the skill.
