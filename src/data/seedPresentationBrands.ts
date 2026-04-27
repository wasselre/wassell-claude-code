import type { PresentationBrandRecord } from '@/types';

/** Stable UUID for the seeded Wassel brand. Matches the row inserted by
 *  the Phase 3.3 supabase migration so re-seeds are idempotent. */
export const WASSEL_BRAND_ID = '00000000-0000-4000-8000-000000000200';

const NOW = '2026-04-26T00:00:00.000Z';

/**
 * Bundled brand seed. The single Wassel brand carries the full design
 * spec extracted from the `wassel-presentation` and `wassel-deck-review`
 * skills — colors, typography, layout rules, text rules, banned and
 * required vocabulary. Users clone this brand or reference it directly
 * from their templates instead of re-typing it.
 */
export const SEED_PRESENTATION_BRANDS: PresentationBrandRecord[] = [
  {
    id: WASSEL_BRAND_ID,
    slug: 'wassel',
    label_ar: 'هوية وصل العقارية',
    label_en: 'Wassel Real Estate',
    description_ar:
      'هوية شركة وصل العقارية: الألوان، الخطوط، وقواعد التصميم لعروض السوق العقاري السعودي.',
    description_en:
      'Wassel real estate brand: colors, typography, and design rules for Saudi real estate decks.',
    colors: [
      { id: 'wassel-copper', role_en: 'Primary', role_ar: 'الأساسي', hex: '#B8734F', notes: 'Headers, footer strip, accent strips' },
      { id: 'wassel-sand', role_en: 'Secondary', role_ar: 'الثانوي', hex: '#E8D9C0', notes: 'Footer band, left strip on content slides' },
      { id: 'wassel-brown', role_en: 'Dark / dividers', role_ar: 'البني الداكن', hex: '#6B4226', notes: 'Divider slides, dark cards, dark-track elements' },
      { id: 'wassel-cream', role_en: 'Background', role_ar: 'الخلفية', hex: '#F8F5E9', notes: 'Page background on content slides' },
      { id: 'wassel-gold', role_en: 'Accent', role_ar: 'لمسة ذهبية', hex: '#D9B57F', notes: 'Top underline on brown header, dark-card top accent, H2 subtitle color' },
      { id: 'wassel-charcoal', role_en: 'Body text', role_ar: 'نص المتن', hex: '#3F3F3F', notes: 'Body text on white cards' },
      { id: 'wassel-white', role_en: 'Cards', role_ar: 'البطاقات', hex: '#FFFFFF', notes: 'Card backgrounds; card-over-white text' },
    ],
    font_family: 'Amiri',
    font_notes:
      'Used on EVERY text run, no exceptions. Set Amiri across all three OOXML font slots: <a:latin>, <a:ea>, AND <a:cs> (complex script). PowerPoint renders Arabic from the cs slot — if it\'s empty, Arabic silently falls back to the theme default even though the dropdown says "Amiri".',
    design_rules: `Visual identity rules that apply to ANY Wassel deck (per-deck slide
structure lives on the template's output_structure, not here).

- Content slides use the CONTENT layout: sand left strip, brown header band
  with gold underline, cream background, sand footer with copper top-border
  and wassel.re left-aligned.
- Divider slides use the DIVIDER layout: brown background, copper Najdi /
  Diriyah triangular-notch accent strip on the left edge, no footer.
- Footer on content slides:
  - Left: \`wassel.re\` in copper, no underline, shape-level hyperlink (NOT
    run-level)
  - Right: project context, e.g. \`وصل العقارية  |  مقام كورتيارد ١٧\`
  - Sand (#E8D9C0) band with copper (#B8734F) 2px top border
- Card icons: Lucide icons (https://lucide.dev) embedded as line-art SVG in
  the slide's accent color — copper (#B8734F) on white/cream cards, gold
  (#D9B57F) on brown/dark cards. Stroke-based, monochrome, stroke-width
  ~1.5, sized ~32–40 px in card layouts. NOT emoji (they render in their
  own multi-colored fonts). NOT typographic Unicode glyphs (♪ ◆ ✦ etc —
  they read as text, not iconography). Exception: branded platform logos
  (Snapchat, TikTok, Instagram, LinkedIn) keep their official multi-color
  brand marks on platform tiles — never replace those with Lucide.`,
    text_rules: `- Arabic-Indic digits (٠-٩) everywhere — every Western digit converts to Arabic-Indic before rendering. Project numbers, years, prices, percentages — all Arabic-Indic. Latin letters and building codes (A/B/C/D) stay untouched.
- Arabic decimal/thousands separators inside Arabic numbers: a "." between two Arabic-Indic digits becomes "٫" (U+066B); a "," becomes "٬" (U+066C). Standalone commas in sentences (e.g. "حي النرجس، الرياض") stay as-is.
- RLM marks around em-dash / hyphen / underscore in Arabic context. Any separator (em-dash, en-dash, hyphen, underscore, pipe) with whitespace on at least one side gets wrapped with RLM (U+200F) and balanced spacing.
- LRM marks on Latin/numeric tokens inside Arabic paragraphs. Wrap each numeric/Latin run in U+200E marks if the surrounding text is Arabic.
- RTL paragraphs: Arabic-containing paragraphs get \`rtl="1"\` on their <a:pPr>.
- Line spacing 1.5 when paragraph is ≥8 words.
- Auto-fit: every textbox gets <a:normAutofit/> by default (text shrinks to fit shape). Opt-outs: \`grow_to_fit=True\` (shape grows to text) or \`auto_fit=False\` (no fitting).
- Hyperlink styling: copper, NO underline. Use shape-level hyperlinks (NOT run-level) — run-level hyperlinks trigger PowerPoint's theme to override the run color.
- RTL tables: PowerPoint has no true RTL flag on tables. To get the first logical column on the physical right, feed the columns reversed.
- Icons in cards: Lucide icons (lucide.dev) embedded as line-art SVG in the slide's accent color (copper #B8734F on white/cream cards, gold #D9B57F on brown/dark cards). Stroke-based, monochrome, stroke-width ~1.5. NOT emoji (multi-color font glyphs). NOT typographic Unicode glyphs. Exception: branded platform logos (Snapchat, TikTok, Instagram, LinkedIn) keep their official multi-color marks on platform tiles.
- NO parentheses in body / callout copy. Replace \`(text)\` with \`— text —\` (em-dashes with spaces). Allowed exceptions: URLs, the builder's intentional \`\\u200E(A/B/C/D)\\u200E\` building-code wrap, numeric-range content like \`(1,490,000 - 2,090,000)\`.
- NEVER invent numbers. If the evidence is missing for a metric, omit the card or render the builder's "—" placeholder. Fabricating a "reasonable" number is the single failure mode that disqualifies a Wassel deck.`,
    forbidden_phrases: [
      { id: 'wassel-fb-1', wrong: 'Wassel CRM', right: 'نظام وصل', note: 'Always use the Arabic phrase' },
      { id: 'wassel-fb-2', wrong: 'CRM وصل', right: 'نظام وصل' },
      { id: 'wassel-fb-3', wrong: 'نادٍ', right: 'نادي', note: 'No kasra' },
    ],
    // Brand-level required phrases are vocabulary that applies to ANY
    // Wassel deck. Slide-specific exact phrases (slide 4/7/11 subtitles)
    // belong on the template's output_structure, not here.
    required_phrases: [],
    is_system: true,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
  },
];
