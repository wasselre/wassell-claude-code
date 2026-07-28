# Wassel brand assets (2026)

**This folder is the source of truth for Wassel branding.** It was previously
only on one person's OneDrive desktop; it is tracked here so it cannot be lost
and so every surface (app, website, decks, generated PDFs) resolves to the same
artwork and the same hex values.

Original filenames are kept in Arabic exactly as the designer delivered them.
Anything the app actually serves is a derivative in `public/assets/` with an
ASCII name — do not point application code at this folder directly.

## Palette

Taken from `الألوان.png` (the delivered COLOR PALETTE sheet).

| Name | Hex | RGB | Notes |
|---|---|---|---|
| Copper Bronze | `#B8734F` | 184, 115, 79 | Primary. Pantone 7517 C. Unchanged from the previous palette. |
| Deep Terracotta | `#A6482A` | 166, 75, 42 | Hover / emphasis |
| Warm Sand/Beige | `#E8D9C0` | 232, 217, 192 | Borders, dividers |
| Rich Chocolate Brown | `#6B4226` | 107, 66, 38 | Headers, contrast areas, Arabic wordmark |
| Soft Cream | `#F8F5E9` | 248, 245, 233 | Page + app-icon background |
| Charcoal/Slate Gray | `#3F3F3F` | 63, 63, 63 | Body text |
| Subtle Gold | `#D9B57F` | 217, 181, 127 | Badges, highlights |

Usage ratio, per the sheet: **50%** Copper Bronze · **30%** earth tones ·
**15%** charcoal · **5%** gold.

> ⚠️ **Six of these seven values changed in the 2026 refresh.** Only Copper
> Bronze carried over. The retired values (`#8E4E3A`, `#D4B896`, `#4A2C2A`,
> `#F5EDE0`, `#4A4E54`, `#C09B5F`) still appear in `src/index.css`, the
> Tailwind config, `CLAUDE.md`, and the deck/PDF generators. Migrating those
> is tracked separately — see the rebrand inventory in the PR that added this
> folder.

## Files

| File | What it is |
|---|---|
| `الأيقونة.png` | The castle mark alone. **Source for the app icons.** |
| `الأيقونة ابيض.png` | Castle mark, white — for dark backgrounds |
| `الاسم.png` / `الاسم ابيض.png` | Wordmark only (وصل العقارية / Wassel Real Estate) |
| `الشعار العرضي.png` / `... - ابيض.png` | Horizontal lockup (wordmark + mark side by side) |
| `الشعار الطولي.png` / `... ابيض.png` | Vertical/stacked lockup |
| `الألوان.png` | The palette sheet transcribed above |
| `الخط.png` | Wordmark colourway sheet (copper / chocolate / charcoal / pale) |
| `نمط3.png` … `نمط 7.png` | Decorative brand patterns |

## Regenerating the app icons

```bash
node scripts/generate-app-icons.mjs
```

Reads `الأيقونة.png` and writes `public/assets/icon-{180,192,512}.png`. Two
constraints are baked into that script and must not be undone:

1. **The output is flattened onto opaque Soft Cream.** iOS renders any
   transparency in a home-screen icon as solid **black**.
2. **The mark is inset to 76% of the tile.** It spans 1964 of 2000px in the
   source — used edge-to-edge, iOS's rounded-rect mask clips the outer towers.
