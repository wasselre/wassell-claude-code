import type { PresentationTemplate } from '@/types';

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
    created_at: NOW,
    updated_at: NOW,
  },
];
