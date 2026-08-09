/**
 * Snapchat campaign settings schema.
 *
 * Field names + enums: docs/reference/ad-platforms/snapchat.md. Money is
 * entered in SAR; Snap's API wants micros (×1,000,000) — that conversion is
 * the future push layer's job. Deprecated values (MIN_ROAS bidding, the
 * Oracle DLX* audiences) are deliberately absent.
 */
import { PlatformSchema } from './types';

export const snapchatSchema: PlatformSchema = {
  platform: 'snapchat',

  sections: [
    {
      key: 'objective',
      ar: 'الهدف الإعلاني',
      en: 'Objective',
      fields: [
        {
          key: 'objective_v2_type',
          control: 'select',
          ar: 'هدف الحملة',
          en: 'Campaign objective',
          immutable: true,
          options: [
            { value: 'AWARENESS_AND_ENGAGEMENT', ar: 'الوعي والتفاعل', en: 'Awareness & engagement' },
            { value: 'TRAFFIC', ar: 'الزيارات', en: 'Traffic' },
            { value: 'LEADS', ar: 'العملاء المحتملون', en: 'Leads' },
            { value: 'APP_PROMOTION', ar: 'ترويج التطبيق', en: 'App promotion' },
            { value: 'SALES', ar: 'المبيعات', en: 'Sales' },
          ],
        },
        {
          key: 'ad_squad_type',
          control: 'select',
          ar: 'نوع المجموعة الإعلانية',
          en: 'Ad squad type',
          options: [
            { value: 'SNAP_ADS', ar: 'إعلانات سناب', en: 'Snap Ads' },
            { value: 'LENS', ar: 'عدسة', en: 'Lens' },
            { value: 'FILTER', ar: 'فلتر', en: 'Filter' },
          ],
        },
      ],
    },

    {
      key: 'budget_bidding',
      ar: 'الميزانية والمزايدة',
      en: 'Budget & bidding',
      fields: [
        {
          key: 'pacing_level',
          control: 'select',
          ar: 'مستوى الميزانية',
          en: 'Budget level',
          options: [
            { value: 'AD_SQUAD', ar: 'على المجموعة (المعتاد)', en: 'Per ad squad (normal)' },
            { value: 'CAMPAIGN', ar: 'على الحملة (ميزانيات ذكية)', en: 'Campaign level (Smart Budgets)' },
          ],
        },
        {
          key: 'budget_mode',
          control: 'select',
          ar: 'نمط الميزانية',
          en: 'Budget mode',
          options: [
            { value: 'DAILY', ar: 'يومية', en: 'Daily' },
            { value: 'LIFETIME', ar: 'إجمالية', en: 'Lifetime' },
          ],
        },
        {
          key: 'daily_budget_micro',
          control: 'money',
          ar: 'الميزانية اليومية (ريال)',
          en: 'Daily budget (SAR)',
          visibleWhen: { key: 'budget_mode', anyOf: ['DAILY'] },
          hint_ar: 'الحد الأدنى ٥ ريالات تقريبًا — تُحوَّل إلى ميكرو عند الربط',
          hint_en: 'converted to micros at push time',
        },
        {
          key: 'lifetime_budget_micro',
          control: 'money',
          ar: 'الميزانية الإجمالية (ريال)',
          en: 'Lifetime budget (SAR)',
          visibleWhen: { key: 'budget_mode', anyOf: ['LIFETIME'] },
        },
        {
          key: 'bid_strategy',
          control: 'select',
          ar: 'استراتيجية المزايدة',
          en: 'Bid strategy',
          options: [
            { value: 'AUTO_BID', ar: 'مزايدة تلقائية', en: 'Auto-bid' },
            { value: 'LOWEST_COST_WITH_MAX_BID', ar: 'سقف مزايدة', en: 'Max bid' },
            { value: 'TARGET_COST', ar: 'تكلفة مستهدفة', en: 'Target cost' },
          ],
        },
        {
          key: 'bid_micro',
          control: 'money',
          ar: 'قيمة المزايدة (ريال)',
          en: 'Bid amount (SAR)',
          visibleWhen: { key: 'bid_strategy', anyOf: ['LOWEST_COST_WITH_MAX_BID', 'TARGET_COST'] },
        },
        {
          key: 'optimization_goal',
          control: 'select',
          ar: 'هدف التحسين',
          en: 'Optimization goal',
          options: [
            { value: 'IMPRESSIONS', ar: 'الظهور', en: 'Impressions' },
            { value: 'SWIPES', ar: 'السحبات (نقرات)', en: 'Swipes (clicks)' },
            { value: 'LANDING_PAGE_VIEW', ar: 'مشاهدات صفحة الهبوط', en: 'Landing page views' },
            { value: 'LEAD_FORM_SUBMISSIONS', ar: 'نماذج العملاء', en: 'Lead form submissions' },
            { value: 'PIXEL_PAGE_VIEW', ar: 'مشاهدة صفحة (بكسل)', en: 'Pixel page view' },
            { value: 'PIXEL_SIGNUP', ar: 'تسجيل (بكسل)', en: 'Pixel sign-up' },
            { value: 'PIXEL_PURCHASE', ar: 'شراء (بكسل)', en: 'Pixel purchase' },
            { value: 'PIXEL_ADD_TO_CART', ar: 'إضافة للسلة (بكسل)', en: 'Pixel add to cart' },
            { value: 'VIDEO_VIEWS', ar: 'مشاهدات الفيديو (ثانيتان)', en: 'Video views (2s)' },
            { value: 'VIDEO_VIEWS_15_SEC', ar: 'مشاهدات ١٥ ثانية', en: '15-second views' },
            { value: 'STORY_OPENS', ar: 'فتح القصة', en: 'Story opens' },
            { value: 'APP_INSTALLS', ar: 'تنزيلات التطبيق', en: 'App installs' },
            { value: 'USES', ar: 'استخدام العدسة/الفلتر', en: 'Lens/filter uses' },
          ],
        },
        {
          key: 'billing_event',
          control: 'select',
          ar: 'حدث الفوترة',
          en: 'Billing event',
          hint_ar: 'سناب تفوتر بالظهور دائمًا',
          hint_en: 'Snapchat always bills per impression',
          options: [{ value: 'IMPRESSION', ar: 'الظهور', en: 'Impression' }],
        },
        {
          key: 'pacing_type',
          control: 'select',
          ar: 'وتيرة الصرف',
          en: 'Pacing',
          immutable: true,
          options: [
            { value: 'STANDARD', ar: 'قياسية', en: 'Standard' },
            { value: 'ACCELERATED', ar: 'متسارعة (تتطلب سقف مزايدة)', en: 'Accelerated (needs max bid)' },
          ],
        },
      ],
    },

    {
      key: 'schedule',
      ar: 'الجدولة',
      en: 'Schedule',
      fields: [
        { key: 'start_time', control: 'date', ar: 'تاريخ البدء', en: 'Start date', ltr: true },
        { key: 'end_time', control: 'date', ar: 'تاريخ الانتهاء', en: 'End date', ltr: true },
      ],
    },

    {
      key: 'targeting',
      ar: 'الاستهداف',
      en: 'Targeting',
      fields: [
        {
          key: 'country_code',
          control: 'tags',
          ar: 'الدول (رمز ISO صغير)',
          en: 'Countries (lowercase ISO)',
          ltr: true,
          placeholder: 'sa',
          hint_ar: 'سناب تريد الرمز بحروف صغيرة: sa',
          hint_en: 'Snap wants lowercase: sa',
        },
        { key: 'region_id', control: 'tags', ar: 'المناطق', en: 'Regions', hint_ar: 'أسماء أو معرفات المناطق', hint_en: 'region names or ids' },
        {
          key: 'circles',
          control: 'tags',
          ar: 'نقاط دائرية (خط عرض,خط طول,نصف قطر م)',
          en: 'Radius circles (lat,lng,radius m)',
          ltr: true,
          placeholder: '24.77,46.73,5000',
          hint_ar: 'نصف القطر ٩٦ م – ١٠٠ كم، حتى ٥٠٠ دائرة',
          hint_en: 'radius 96 m–100 km, up to 500 circles',
        },
        { key: 'min_age', control: 'number', ar: 'العمر من', en: 'Age from', min: 13, max: 35 },
        {
          key: 'max_age',
          control: 'number',
          ar: 'العمر إلى',
          en: 'Age to',
          min: 13,
          max: 55,
          hint_ar: 'اتركه فارغًا لبلا سقف',
          hint_en: 'leave empty for uncapped',
        },
        {
          key: 'gender',
          control: 'select',
          ar: 'الجنس',
          en: 'Gender',
          options: [
            { value: '', ar: 'الجميع', en: 'All' },
            { value: 'MALE', ar: 'رجال', en: 'Men' },
            { value: 'FEMALE', ar: 'نساء', en: 'Women' },
          ],
        },
        {
          key: 'languages',
          control: 'tags',
          ar: 'اللغات (رمز ISO)',
          en: 'Languages (ISO)',
          ltr: true,
          placeholder: 'ar, en',
        },
        {
          key: 'interests',
          control: 'tags',
          ar: 'الاهتمامات (فئات نمط الحياة)',
          en: 'Interests (lifestyle categories)',
          hint_ar: 'فئات SLC — عقارات، تسوق فاخر…',
          hint_en: 'SLC categories — real estate, luxury shopping…',
        },
        {
          key: 'segments',
          control: 'tags',
          ar: 'شرائح الجمهور (تضمين)',
          en: 'Audience segments (include)',
          ltr: true,
          hint_ar: 'معرفات الشرائح — قوائم العملاء والمشابهون',
          hint_en: 'segment ids — customer lists and lookalikes',
        },
        { key: 'excluded_segments', control: 'tags', ar: 'شرائح (استبعاد)', en: 'Segments (exclude)', ltr: true },
        {
          key: 'enable_targeting_expansion',
          control: 'toggle',
          ar: 'توسيع الاستهداف الذكي',
          en: 'Smart targeting expansion',
        },
      ],
    },

    {
      key: 'placements',
      ar: 'مواضع الظهور',
      en: 'Placements',
      fields: [
        {
          key: 'placement_config',
          control: 'select',
          ar: 'اختيار المواضع',
          en: 'Placement selection',
          options: [
            { value: 'AUTOMATIC', ar: 'تلقائي', en: 'Automatic' },
            { value: 'CUSTOM', ar: 'يدوي', en: 'Custom' },
          ],
        },
        {
          key: 'snapchat_positions',
          control: 'multiselect',
          ar: 'المواضع',
          en: 'Positions',
          visibleWhen: { key: 'placement_config', anyOf: ['CUSTOM'] },
          options: [
            { value: 'INTERSTITIAL_USER', ar: 'بين قصص الأصدقاء', en: 'Between friends’ stories' },
            { value: 'INTERSTITIAL_CONTENT', ar: 'داخل المحتوى', en: 'Within content' },
            { value: 'INTERSTITIAL_SPOTLIGHT', ar: 'سبوتلايت', en: 'Spotlight' },
            { value: 'INSTREAM', ar: 'داخل العروض', en: 'In-stream (shows)' },
            { value: 'PUBLIC_STORIES_INSTREAM', ar: 'القصص العامة', en: 'Public stories' },
            { value: 'FEED', ar: 'الموجز', en: 'Feed' },
            { value: 'CHAT_FEED', ar: 'موجز المحادثات', en: 'Chat feed' },
            { value: 'CAMERA', ar: 'الكاميرا', en: 'Camera' },
            { value: 'POST_CAPTURE_CAROUSEL', ar: 'بعد التصوير', en: 'Post-capture' },
          ],
        },
        {
          key: 'brand_safety_inventory',
          control: 'select',
          ar: 'سلامة العلامة',
          en: 'Brand safety',
          options: [
            { value: 'FULL_INVENTORY', ar: 'المخزون الكامل', en: 'Full inventory' },
            { value: 'LIMITED_INVENTORY', ar: 'مخزون محدود', en: 'Limited inventory' },
          ],
        },
      ],
    },

    {
      key: 'destination',
      ar: 'الوجهة والتتبع',
      en: 'Destination & tracking',
      fields: [
        {
          key: 'pixel_id',
          control: 'text',
          ar: 'معرف البكسل',
          en: 'Pixel id',
          ltr: true,
          visibleWhen: {
            key: 'optimization_goal',
            anyOf: ['PIXEL_PAGE_VIEW', 'PIXEL_SIGNUP', 'PIXEL_PURCHASE', 'PIXEL_ADD_TO_CART', 'LANDING_PAGE_VIEW'],
          },
        },
        {
          key: 'conversion_window',
          control: 'select',
          ar: 'نافذة الإسناد',
          en: 'Attribution window',
          options: [
            { value: 'SWIPE_28DAY_VIEW_1DAY', ar: '٢٨ يوم سحب / يوم مشاهدة', en: '28-day swipe / 1-day view' },
            { value: 'SWIPE_7DAY', ar: '٧ أيام سحب', en: '7-day swipe' },
          ],
        },
        { key: 'profile_id', control: 'text', ar: 'معرف الحساب العام', en: 'Public profile id', ltr: true },
      ],
    },
  ],

  adSections: [
    {
      key: 'creative',
      ar: 'الإعلان على المنصة',
      en: 'On-platform creative',
      fields: [
        {
          key: 'creative_type',
          control: 'select',
          ar: 'نوع الإعلان',
          en: 'Ad type',
          options: [
            { value: 'SNAP_AD', ar: 'إعلان سناب (فيديو/صورة)', en: 'Snap Ad (video/image)' },
            { value: 'WEB_VIEW', ar: 'مرفق موقع', en: 'Web view' },
            { value: 'STORY', ar: 'إعلان قصة', en: 'Story ad' },
            { value: 'COLLECTION', ar: 'مجموعة', en: 'Collection' },
            { value: 'LEAD_GENERATION', ar: 'نموذج عملاء', en: 'Lead generation' },
            { value: 'AD_TO_CALL', ar: 'اتصال', en: 'Ad to call' },
            { value: 'AD_TO_MESSAGE', ar: 'رسالة', en: 'Ad to message' },
            { value: 'DEEP_LINK', ar: 'رابط عميق', en: 'Deep link' },
            { value: 'APP_INSTALL', ar: 'تنزيل تطبيق', en: 'App install' },
          ],
        },
        {
          key: 'headline',
          control: 'text',
          ar: 'العنوان (≤34 حرفًا)',
          en: 'Headline (≤34 chars)',
          max: 34,
        },
        { key: 'brand_name', control: 'text', ar: 'اسم العلامة (≤32)', en: 'Brand name (≤32)', max: 32 },
        {
          key: 'call_to_action',
          control: 'select',
          ar: 'زر الإجراء',
          en: 'Call to action',
          options: [
            { value: 'MORE', ar: 'المزيد', en: 'More' },
            { value: 'SIGN_UP', ar: 'سجّل', en: 'Sign up' },
            { value: 'APPLY_NOW', ar: 'قدّم الآن', en: 'Apply now' },
            { value: 'BOOK_NOW', ar: 'احجز الآن', en: 'Book now' },
            { value: 'SHOP_NOW', ar: 'تسوّق الآن', en: 'Shop now' },
            { value: 'GET_NOW', ar: 'احصل عليه', en: 'Get now' },
            { value: 'ORDER_NOW', ar: 'اطلب الآن', en: 'Order now' },
            { value: 'VIEW', ar: 'شاهد', en: 'View' },
            { value: 'WATCH', ar: 'شاهد الفيديو', en: 'Watch' },
            { value: 'DOWNLOAD', ar: 'تنزيل', en: 'Download' },
            { value: 'CALL_NOW', ar: 'اتصل الآن', en: 'Call now' },
            { value: 'MESSAGE_NOW', ar: 'راسلنا', en: 'Message now' },
          ],
        },
        {
          key: 'url',
          control: 'text',
          ar: 'رابط الموقع',
          en: 'Website URL',
          ltr: true,
          placeholder: 'https://…',
        },
        { key: 'lead_generation_form_id', control: 'text', ar: 'معرف نموذج العملاء', en: 'Lead form id', ltr: true },
        {
          key: 'phone_number',
          control: 'text',
          ar: 'رقم الهاتف (اتصال/رسالة)',
          en: 'Phone number (call/message)',
          ltr: true,
          visibleWhen: { key: 'creative_type', anyOf: ['AD_TO_CALL', 'AD_TO_MESSAGE'] },
        },
      ],
    },
  ],
};
