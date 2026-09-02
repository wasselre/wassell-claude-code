-- ============================================================================
-- 2026-09-02_26_creative_brand_kit_seed.sql  (owner: A-BRAND)
--
-- Seeds mos_settings.brand_kit with the DRAFTED Wassel brand kit (the
-- Post Creative Director's brand truth). Shape: BrandKit per
-- src/lib/creative/contracts.ts; source JSON: docs/brand/brand-kit.draft.json
-- (provenance + open questions: docs/brand/brand-kit-notes.md).
--
-- Contracts §0 rule 12: the kit is DATA with status draft|reviewed; it seeds
-- as status='draft', mode='advisory' — deviations are LISTED, never failed,
-- until a reviewer with the approve_creative capability promotes it.
--
-- Idempotent: ON CONFLICT (key) DO NOTHING — an operator-edited kit is never
-- overwritten by re-running this migration. Per contracts §2, A-BRAND seeds
-- brand_kit ONLY; writer_rules is A-DB's seed (2026-09-02_25).
-- ============================================================================

BEGIN;

INSERT INTO public.mos_settings (key, value) VALUES
  ('brand_kit', $kit${
  "version": 1,
  "status": "draft",
  "mode": "advisory",
  "reviewed_by": null,
  "reviewed_at": null,
  "sources": [
    "brand/README.md (2026 palette + 50/30/15/5 usage ratio)",
    "brand/الألوان.png (delivered COLOR PALETTE sheet — hex/RGB/CMYK/Pantone, print vs digital combos)",
    "brand/الخط.png (wordmark colourways: copper / chocolate / charcoal / pale)",
    "brand/نمط3.png (Sadu band: chevron strips + rosette medallions)",
    "brand/نمط 4.png (Sadu band: opposing triangles with dot columns)",
    "brand/نمط5.png (Sadu band: stepped diamond/hourglass motifs)",
    "brand/نمط6.png (Sadu diamond lattice with dot centres)",
    "brand/نمط 7.png (stepped crenellation notch strip)",
    "brand/الأيقونة.png (monoline fortress mark: crenellated towers, scalloped frieze, arch doorway, Sadu weave base)",
    "brand/الشعار العرضي.png + الشعار الطولي.png + white variants (lockups)",
    ".claude/skills/wassel-general-ppt/SKILL.md + scripts/wassel_chrome.py (palette constants, Amiri-only, Arabic typography transforms, wording rules)",
    ".claude/skills/wassel-presentation/SKILL.md + references/slide_templates.md (colour roles per slot, Najdi/Diriyah notch-strip spec, iconography rule)",
    ".claude/skills/wassel-deck-review/scripts/review.py (allowed palette, banned phrases)",
    ".claude/skills/client-study/assets/render_study.py (all 8 colours incl. terracotta, role usage in PDF scaffold)",
    "src/pages/Marketing/mos.css lines 1-60 (workspace tokens: cream/sand/copper/terracotta/choc/gold/ink)",
    ".claude/skills/writing-post/SKILL.md Decisions Log (on-design copy rules, prohibited phrases, hashtag rules)",
    ".claude/skills/writing-video-script/SKILL.md Decisions Log (Wassel-only CTA, hook style)",
    "Wassel Website/index.html design tokens — UNREADABLE from this worktree (outside allowed dirs); dark surfaces #352013/#1A1009, Najdi arch / Sadu ribbon / crenellation motifs and observed Tajawal body recorded SECONDHAND from the A-BRAND brief — needs reviewer verification"
  ],
  "palette": [
    {
      "name": "Copper Bronze",
      "hex": "#B8734F",
      "roles": ["primary", "cta", "accent_strip"],
      "notes": "Pantone 7517 C. The only colour carried over unchanged from the pre-2026 palette. 50% of any composition per the palette sheet."
    },
    {
      "name": "Deep Terracotta",
      "hex": "#A6482A",
      "roles": ["hover", "emphasis"],
      "notes": "Hover/emphasis only — never a ground. Client-study PDF uses it for the header sub-line and alternative-box headings."
    },
    {
      "name": "Warm Sand/Beige",
      "hex": "#E8D9C0",
      "roles": ["divider", "soft_background", "border"],
      "notes": "Footer bands, left strips, borders, dividers. Part of the sheet's 'digital' combo (charcoal/sand/gold)."
    },
    {
      "name": "Rich Chocolate Brown",
      "hex": "#6B4226",
      "roles": ["dark_ground", "headline_on_light", "header_band", "wordmark"],
      "notes": "Dark grounds (divider slides), header bands, contrast areas; the Arabic wordmark's primary colourway. Part of the sheet's 'print' combo."
    },
    {
      "name": "Soft Cream",
      "hex": "#F8F5E9",
      "roles": ["page_background", "light_text_on_dark"],
      "notes": "Default page/slide background; also the app-icon tile background. On dark grounds, cream is the primary light text colour."
    },
    {
      "name": "Charcoal/Slate Gray",
      "hex": "#3F3F3F",
      "roles": ["body_text"],
      "notes": "Body text on light grounds. 15% of a composition per the palette sheet."
    },
    {
      "name": "Subtle Gold",
      "hex": "#D9B57F",
      "roles": ["badge", "highlight", "underline"],
      "notes": "Badges, highlights, the gold underline under brown header bands, big KPI numbers on dark cards. 5% of a composition — accent, never a ground."
    },
    {
      "name": "Website Dark Surface",
      "hex": "#352013",
      "roles": ["dark_surface"],
      "notes": "Dark surface used by the public website. SECONDHAND (from the A-BRAND brief; the website repo was unreadable from this worktree) — needs reviewer verification."
    },
    {
      "name": "Website Dark Surface Deep",
      "hex": "#1A1009",
      "roles": ["dark_surface_alt"],
      "notes": "Deepest dark surface on the public website. SECONDHAND — needs reviewer verification."
    },
    {
      "name": "White",
      "hex": "#FFFFFF",
      "roles": ["light_text_on_dark", "logo_on_dark", "card_fill"],
      "notes": "Cards on cream, text on dark header bands, and the logo colourway for dark backgrounds. Explicitly in the deck builders' allowed palette."
    }
  ],
  "usage_ratio": {
    "copper": 50,
    "earth": 30,
    "charcoal": 15,
    "gold": 5
  },
  "combinations_allowed": [
    ["#B8734F", "#A6482A", "#6B4226"],
    ["#3F3F3F", "#E8D9C0", "#D9B57F"],
    ["#F8F5E9", "#B8734F", "#6B4226"],
    ["#6B4226", "#D9B57F", "#F8F5E9"],
    ["#F8F5E9", "#E8D9C0", "#B8734F"]
  ],
  "combinations_avoid": [
    ["#A6482A", "#B8734F"],
    ["#D9B57F", "#E8D9C0"],
    ["#3F3F3F", "#6B4226"]
  ],
  "typography": {
    "display": "Amiri",
    "body": "Amiri",
    "numerals": "arabic_indic",
    "max_sizes_per_slide": 2,
    "latin_policy": "Amiri; bilingual project names allowed",
    "notes": "Amiri on every text element, every script, every size — no system/theme/Latin fallback fonts (deck engines set all three OOXML font slots for this reason). Western digits are converted to Arabic-Indic; '.' and ',' between digits become ٫ and ٬. Tajawal is OBSERVED on the public website body but is NOT sanctioned — treat as unsanctioned pending reviewer decision."
  },
  "logo": {
    "variants": ["horizontal", "vertical", "icon", "wordmark"],
    "on_dark": "white",
    "on_light": "copper or chocolate",
    "clear_space": "1× icon height",
    "min_size": "not documented — propose 24px digital / 8mm print (needs reviewer confirmation)",
    "default_position": "top_start"
  },
  "character": {
    "statement": "Traditional, clean, Najdi. Monoline fortress mark and geometric Sadu weaving motifs; flat colour, generous negative space, no gloss.",
    "motifs": [
      "stepped-triangle notch strip (Najdi/Diriyah)",
      "Sadu rosette/chevron bands",
      "Sadu diamond lattice",
      "single arch silhouette",
      "fortress crenellation",
      "monoline fortress mark"
    ],
    "negative_space": "generous"
  },
  "image_treatment": {
    "allowed": [
      "real project photography (rights-cleared)",
      "full-bleed photography with a single text band",
      "warm colour correction consistent with the palette",
      "generous cream negative space around the subject",
      "Najdi/Sadu motif ribbons at the edges"
    ],
    "avoid": [
      "crosshatch fills",
      "dot ladders",
      "stock-photo gloss / generic skyline clichés",
      "glow or drop shadows",
      "filters that shift colours off-palette",
      "text stacks over busy image areas"
    ]
  },
  "prohibited": [
    "price/spec stack on the design (project name + 3–4 short headline lines only; all detail lives in the caption)",
    "«بدون سعي»",
    "competitor hashtags",
    "emoji as icons (use typographic symbols in a brand colour)",
    "more than 2 type sizes on one design",
    "glow / drop shadows",
    "«Wassel CRM» (always «نظام وصل»)",
    "«نادٍ» (always «نادي»)"
  ],
  "approved_example_ids": []
}$kit$::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
