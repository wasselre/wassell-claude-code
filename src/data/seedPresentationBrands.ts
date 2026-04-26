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
    design_rules: `- Format: 16:9 (10" × 5.625")
- Slide count: exactly 15 slides
- Slide sequence (fixed):
  1. Cover (brown bg, logo, title, subtitle, project tag, year)
  2. About Wassel (3 KPI cards + 3 value cards)
  3. DIVIDER — تحليل مربع المشروع
  4. Market analysis (3 stat cards + insight strip + price range card)
  5. Competitor comparison (table)
  6. Project & opportunity (dark opportunity card + revenue card + specs)
  7. DIVIDER — الخطة التسويقية
  8. Marketing I — Opening event (audience bar + 3 equal element cards)
  9. Marketing II — Content & digital platforms (6 tiles + 4 platform cards)
 10. Marketing III — Measured outcomes (formula funnel + "why this works")
 11. DIVIDER — الخطة البيعية
 12. Sales journey — 10-stage serpent, 2 rows × 5 cards
 13. Detailed sales journey — 10 numbered step cards in 2 columns
 14. Sales plan by the numbers — formula-driven monthly table
 15. Closing — "شراكة تسويقية متكاملة" + 3 cream cards + wassel.re
- Slides 1, 3, 7, 11 are DIVIDERS: brown background, no footer, copper Najdi/Diriyah triangular-notch accent strip on the left edge
- All other slides use the CONTENT layout: sand left strip, brown header band with gold underline, cream background, sand footer with copper top-border and wassel.re left-aligned
- Footer on every CONTENT slide:
  - Left: \`wassel.re\` in copper, no underline, shape-level hyperlink (NOT run-level)
  - Right: project context, e.g. \`وصل العقارية  |  مقام كورتيارد ١٧\`
  - Sand (#E8D9C0) band with copper (#B8734F) 2px top border
- Dividers (slides 1, 3, 7, 11) MUST NOT have a footer
- Cover-slide tag pill format: \`<project_name> — <city>، <district>\` (city before district, Arabic comma). Reversing is a brand violation.`,
    text_rules: `- Arabic-Indic digits (٠-٩) everywhere — every Western digit converts to Arabic-Indic before rendering. Project numbers, years, prices, percentages — all Arabic-Indic. Latin letters and building codes (A/B/C/D) stay untouched.
- Arabic decimal/thousands separators inside Arabic numbers: a "." between two Arabic-Indic digits becomes "٫" (U+066B); a "," becomes "٬" (U+066C). Standalone commas in sentences (e.g. "حي النرجس، الرياض") stay as-is.
- RLM marks around em-dash / hyphen / underscore in Arabic context. Any separator (em-dash, en-dash, hyphen, underscore, pipe) with whitespace on at least one side gets wrapped with RLM (U+200F) and balanced spacing.
- LRM marks on Latin/numeric tokens inside Arabic paragraphs. Wrap each numeric/Latin run in U+200E marks if the surrounding text is Arabic.
- RTL paragraphs: Arabic-containing paragraphs get \`rtl="1"\` on their <a:pPr>.
- Line spacing 1.5 when paragraph is ≥8 words.
- Auto-fit: every textbox gets <a:normAutofit/> by default (text shrinks to fit shape). Opt-outs: \`grow_to_fit=True\` (shape grows to text) or \`auto_fit=False\` (no fitting).
- Hyperlink styling: copper, NO underline. Use shape-level hyperlinks (NOT run-level) — run-level hyperlinks trigger PowerPoint's theme to override the run color.
- RTL tables: PowerPoint has no true RTL flag on tables. To get the first logical column on the physical right, feed the columns reversed.
- Icons in cards: typographic Unicode symbols (♪ ◆ ✦ ★ ■ ● ♯ ≋ ▶ ◐ ✈ ❐) which inherit the font's color, NOT emoji (which render with their own colors). Exception: branded platform logos on slide 9.
- NO parentheses in body / callout copy. Replace \`(text)\` with \`— text —\` (em-dashes with spaces). Allowed exceptions: URLs, the builder's intentional \`\\u200E(A/B/C/D)\\u200E\` building-code wrap, numeric-range content like \`(1,490,000 - 2,090,000)\`.
- NEVER invent numbers. If the evidence is missing for a metric, omit the card or render the builder's "—" placeholder. Fabricating a "reasonable" number is the single failure mode that disqualifies a Wassel deck.`,
    forbidden_phrases: [
      { id: 'wassel-fb-1', wrong: 'Wassel CRM', right: 'نظام وصل', note: 'Always use the Arabic phrase' },
      { id: 'wassel-fb-2', wrong: 'CRM وصل', right: 'نظام وصل' },
      { id: 'wassel-fb-3', wrong: 'نادٍ', right: 'نادي', note: 'No kasra' },
    ],
    required_phrases: [
      { id: 'wassel-rq-1', context: 'Slide 4 subtitle', phrase: 'تحليل مربع مشروع <project> <district> — <city>', note: 'Must contain "مربع مشروع" — never shorten' },
      { id: 'wassel-rq-2', context: 'Slide 7 subtitle', phrase: 'الهدف: صناعة الطلب، وجلب المهتمين', note: 'Exact text — do not edit' },
      { id: 'wassel-rq-3', context: 'Slide 11 subtitle', phrase: 'تحويل الطلب والاهتمام إلى مبيعات', note: 'Exact text — do not edit' },
    ],
    is_system: true,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
  },
];
