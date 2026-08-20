/**
 * Meta (Facebook + Instagram) campaign settings schema.
 *
 * One API serves both apps — an "Instagram campaign" is the same Meta
 * campaign with placements narrowed to Instagram positions, which is why the
 * app's `instagram` platform resolves to THIS schema.
 *
 * DELIBERATELY MINIMAL (operator decision 2026-08-20): only the fields a Wassel
 * media buyer actually plans. Everything else Meta needs (special ad
 * categories, bidding, billing, placements, demographics, page/pixel ids) is
 * defaulted by the push builder (`api/_lib/marketing/metaPush.ts`), not asked
 * here. Campaign + ad-set NAMES are auto-generated as reference codes on push,
 * so they are not form fields. AUDIENCE comes from the campaign's own audience
 * field (the brief's AudiencePicker), not from platform settings.
 *
 * Field names + enums: docs/reference/ad-platforms/meta.md (ODAX era, v25–v26).
 */
import { PlatformSchema } from './types';

export const metaSchema: PlatformSchema = {
  platform: 'meta',

  goalsByObjective: {
    OUTCOME_AWARENESS: ['REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT', 'THRUPLAY'],
    OUTCOME_TRAFFIC: ['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'IMPRESSIONS', 'REACH', 'CONVERSATIONS', 'QUALITY_CALL', 'PROFILE_VISIT'],
    OUTCOME_ENGAGEMENT: ['POST_ENGAGEMENT', 'PAGE_LIKES', 'EVENT_RESPONSES', 'THRUPLAY', 'CONVERSATIONS', 'LINK_CLICKS', 'IMPRESSIONS', 'REACH', 'OFFSITE_CONVERSIONS'],
    OUTCOME_LEADS: ['LEAD_GENERATION', 'QUALITY_LEAD', 'OFFSITE_CONVERSIONS', 'CONVERSATIONS', 'QUALITY_CALL', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
    OUTCOME_APP_PROMOTION: ['APP_INSTALLS', 'OFFSITE_CONVERSIONS', 'LINK_CLICKS', 'VALUE'],
    OUTCOME_SALES: ['OFFSITE_CONVERSIONS', 'VALUE', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'IMPRESSIONS', 'REACH', 'CONVERSATIONS'],
  },

  sections: [
    {
      key: 'campaign',
      ar: 'الحملة',
      en: 'Campaign',
      fields: [
        {
          key: 'objective',
          control: 'select',
          ar: 'هدف الحملة',
          en: 'Campaign objective',
          immutable: true,
          options: [
            { value: 'OUTCOME_AWARENESS', ar: 'الوعي', en: 'Awareness' },
            { value: 'OUTCOME_TRAFFIC', ar: 'الزيارات', en: 'Traffic' },
            { value: 'OUTCOME_ENGAGEMENT', ar: 'التفاعل', en: 'Engagement' },
            { value: 'OUTCOME_LEADS', ar: 'العملاء المحتملون', en: 'Leads' },
            { value: 'OUTCOME_APP_PROMOTION', ar: 'ترويج التطبيق', en: 'App promotion' },
            { value: 'OUTCOME_SALES', ar: 'المبيعات', en: 'Sales' },
          ],
        },
        {
          key: 'advantage_campaign_budget',
          control: 'toggle',
          ar: 'الميزانية على مستوى الحملة (CBO)',
          en: 'Budget at the campaign level (CBO)',
          hint_ar: 'مُفعّل: ميزانية واحدة للحملة تتوزّع آليًا · مُطفأ: الميزانية على المجموعة',
          hint_en: 'on: one campaign budget auto-split across ad sets · off: budget sits on the ad set',
        },
        {
          key: 'budget_mode',
          control: 'select',
          ar: 'نمط الميزانية',
          en: 'Budget mode',
          options: [
            { value: 'DAILY', ar: 'يومية', en: 'Daily' },
            { value: 'LIFETIME', ar: 'إجمالية (تتطلب تاريخ نهاية)', en: 'Lifetime (needs an end date)' },
          ],
        },
        {
          key: 'daily_budget',
          control: 'money',
          ar: 'الميزانية اليومية (ريال)',
          en: 'Daily budget (SAR)',
          visibleWhen: { key: 'budget_mode', anyOf: ['DAILY'] },
        },
        {
          key: 'lifetime_budget',
          control: 'money',
          ar: 'الميزانية الإجمالية (ريال)',
          en: 'Lifetime budget (SAR)',
          visibleWhen: { key: 'budget_mode', anyOf: ['LIFETIME'] },
        },
      ],
    },

    {
      key: 'adset',
      ar: 'المجموعة الإعلانية',
      en: 'Ad set',
      fields: [
        {
          key: 'destination_type',
          control: 'select',
          ar: 'وجهة التحويل',
          en: 'Conversion location',
          hint_ar: 'أين يذهب من ينقر',
          hint_en: 'where a click lands',
          options: [
            { value: 'WEBSITE', ar: 'الموقع الإلكتروني', en: 'Website' },
            { value: 'ON_AD', ar: 'نموذج فوري على الإعلان', en: 'Instant form (on ad)' },
            { value: 'MESSENGER', ar: 'ماسنجر', en: 'Messenger' },
            { value: 'WHATSAPP', ar: 'واتساب', en: 'WhatsApp' },
            { value: 'INSTAGRAM_DIRECT', ar: 'رسائل إنستغرام', en: 'Instagram Direct' },
            { value: 'FACEBOOK_PAGE', ar: 'صفحة فيسبوك', en: 'Facebook page' },
          ],
        },
        {
          key: 'optimization_goal',
          control: 'select',
          ar: 'هدف التحسين',
          en: 'Conversion goal',
          hint_ar: 'تتغير الخيارات حسب هدف الحملة',
          hint_en: 'options follow the campaign objective',
          options: [
            { value: 'LEAD_GENERATION', ar: 'نماذج العملاء', en: 'Leads (instant forms)' },
            { value: 'QUALITY_LEAD', ar: 'عملاء بجودة أعلى', en: 'Conversion leads' },
            { value: 'OFFSITE_CONVERSIONS', ar: 'التحويلات (بكسل)', en: 'Conversions (pixel)' },
            { value: 'LINK_CLICKS', ar: 'نقرات الرابط', en: 'Link clicks' },
            { value: 'LANDING_PAGE_VIEWS', ar: 'مشاهدات صفحة الهبوط', en: 'Landing page views' },
            { value: 'REACH', ar: 'الوصول', en: 'Reach' },
            { value: 'IMPRESSIONS', ar: 'الظهور', en: 'Impressions' },
            { value: 'AD_RECALL_LIFT', ar: 'تذكّر الإعلان', en: 'Ad recall lift' },
            { value: 'THRUPLAY', ar: 'مشاهدات الفيديو (ThruPlay)', en: 'ThruPlay video views' },
            { value: 'POST_ENGAGEMENT', ar: 'تفاعل المنشور', en: 'Post engagement' },
            { value: 'PAGE_LIKES', ar: 'إعجابات الصفحة', en: 'Page likes' },
            { value: 'EVENT_RESPONSES', ar: 'ردود المناسبات', en: 'Event responses' },
            { value: 'CONVERSATIONS', ar: 'المحادثات', en: 'Conversations' },
            { value: 'QUALITY_CALL', ar: 'المكالمات', en: 'Calls' },
            { value: 'PROFILE_VISIT', ar: 'زيارات الحساب', en: 'Profile visits' },
            { value: 'VALUE', ar: 'قيمة التحويل', en: 'Value' },
            { value: 'APP_INSTALLS', ar: 'تنزيلات التطبيق', en: 'App installs' },
          ],
        },
        { key: 'start_time', control: 'date', ar: 'تاريخ البدء', en: 'Start date', ltr: true },
        {
          key: 'end_time',
          control: 'date',
          ar: 'تاريخ الانتهاء',
          en: 'End date',
          ltr: true,
          hint_ar: 'إلزامي مع الميزانية الإجمالية',
          hint_en: 'required with a lifetime budget',
        },
      ],
    },
  ],

  adSections: [
    {
      key: 'creative',
      ar: 'الإعلان',
      en: 'Ad',
      fields: [
        { key: 'message', control: 'textarea', ar: 'النص الإعلاني (الكابشن)', en: 'Caption' },
      ],
    },
  ],
};
