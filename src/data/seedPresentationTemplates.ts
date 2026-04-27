import type { PresentationTemplate } from '@/types';
import { WASSEL_BRAND_ID } from './seedPresentationBrands';

// Stable UUID for the seeded Wassel template. Must not change — once the
// daemon (Phase 2) takes over, its sync reuses this id so seeded jobs stay
// bound to the same row.
export const WASSEL_TEMPLATE_ID = '00000000-0000-4000-8000-000000000100';

const NOW = '2026-04-23T00:00:00.000Z';

/**
 * Phase 1 seed for the Presentations catalog. When the daemon (Phase 2)
 * lands and syncs from `~/.claude/ppt/templates/<slug>/template.json`, it
 * upserts into `presentation_templates` by id and becomes the source of
 * truth — this seed becomes a fallback for offline/dev installs.
 *
 * Keep the shape aligned with the manifest JSON the daemon will read.
 */
export const SEED_PRESENTATION_TEMPLATES: PresentationTemplate[] = [
  {
    id: WASSEL_TEMPLATE_ID,
    slug: 'wassel',
    label_ar: 'عرض وصل العقاري',
    label_en: 'Wassel Real-Estate Deck',
    description_ar:
      'عرض تقديمي عربي من 15 شريحة لمشروع عقاري — تحليل سوق، خطة تسويقية، خطة بيعية. يعتمد على بيانات بسيطة ويُسلَّم كرابط Google Drive.',
    description_en:
      '15-slide RTL Arabic deck for a real-estate project — market analysis, marketing plan, sales plan. Pulls Paseetah data and delivers a Google Drive link.',
    command: '/wassel',
    icon: 'building-2',
    input_schema: [
      {
        name: 'project_brief',
        label_ar: 'ملخص المشروع',
        label_en: 'Project brief',
        type: 'textarea',
        required: true,
        source: 'user',
        placeholder_ar:
          'اسم المشروع، الحي، المدينة، المطور، عدد الوحدات، الوحدات المتبقية، المرافق، أي تفاصيل يعرفها المستخدم...',
        placeholder_en:
          'Project name, district, city, developer, unit count, remaining units, amenities, any known details...',
      },
    ],
    record_binding: {
      model_slug: 'targeted_projects',
      optional: true,
    },
    estimated_duration_seconds: 900,
    is_available: true,
    manifest_path: null,
    manifest_synced_at: NOW,
    // Phase 2 fields. The seed is daemon-shaped (uses `command`), so tools
    // and steps are empty — the local daemon doesn't read them. Once a user
    // duplicates this template via the in-app builder, the duplicate will
    // be flagged user-authored and the cloud worker will read tools+steps.
    tools: [],
    steps: [],
    // Phase 3.3 — brand_id is the source of truth. Embedded `brand` field
    // is null (its data lives in `presentation_brands` keyed by WASSEL_BRAND_ID).
    brand_id: WASSEL_BRAND_ID,
    brand: null,
    // Phase 3.4 — what THIS deck's slides are. Brand carries visual
    // identity that applies to any Wassel deck; this carries the 15-slide
    // sequence specific to the Wassel real-estate market-analysis deck.
    output_structure: `- Slide count: exactly 15 slides
- Format: 16:9
- Sequence (fixed):
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

- Divider slides: 1, 3, 7, 11 (use the brand's DIVIDER layout — no footer)
- All other slides: use the brand's CONTENT layout (with footer)

Slide-specific required phrases:
- Slide 4 subtitle MUST contain "تحليل مربع مشروع <project> <district> — <city>". Never shorten.
- Slide 7 subtitle is exactly: "الهدف: صناعة الطلب، وجلب المهتمين"
- Slide 11 subtitle is exactly: "تحويل الطلب والاهتمام إلى مبيعات"

Cover-slide tag pill: \`<project_name> — <city>، <district>\` (city before district, Arabic comma). Reversing is a violation.

Slide 4 KPI tiles are content-driven (3 picked from evidence) — no fixed labels. Pick the 3 most presentable, story-supporting metrics for THIS project. Each label states its scope unambiguously (e.g. "...في الحي" for district, "...للمشروع" for project).

Slide 6 opportunity bullets follow this order:
  1. Demand indicator (units sold per month in the square)
  2. What drives sales in this square + whether our project has it
  3. Our project's sales rate vs square average
  4. Remaining inventory and its total value

Slide 10 funnel constants (formula-driven, do NOT override):
  - View → Lead = 1%
  - Lead → Sale = 0.6%

Slide 14 sales-plan constants (formula-driven):
  - Appointment booking: 6%
  - Appointment attendance: 40%
  - Natural walk-in visits: 2× appointment visits
  - Interested from total visits: 20%
  - Booking rate: 60%
  - Sale from booking: 80%
- Two presentation modes (chosen automatically): monthly-distribute when natural funnel ≥ 4 sales/month AND project has ≥ 3 units; collapse-to-campaign otherwise.`,
    is_user_authored: false,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
  },
];
