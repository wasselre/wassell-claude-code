/**
 * The 15 marketing-post angles for the Posts Content writer.
 *
 * These come from the two Arabic template sets the user supplied (2026-07-26):
 * a SHORT set (social-caption length: العنوان / الوصف / spec lines) and a LONG
 * set (formal: العنوان / المحتوى / بيانات العقار incl. المزايا / القيمة
 * الاستثمارية). Both sets are the SAME 15 slots in the same order, so one
 * registry carries both tones.
 *
 * IMPORTANT — these are ANGLES, not property types.
 * The templates read like property types (شقة فاخرة، بنتهاوس، فيلا…) but a real
 * project almost always has exactly ONE unit type (verified live: all 49
 * our_projects rows have a single `unit_types` value). Generating a «فيلا
 * مستقلة» post for an apartment project would be a lie. So each slot is treated
 * as a MARKETING ANGLE (فخامة / إطلالة / استقلالية / أمان / تقنية …) that the
 * writer applies to whatever the project actually sells. `preferred_types` is a
 * fit hint for the UI, never a filter; `evidence_keywords` is what we match
 * against the project's real features/services/amenities to decide whether the
 * angle is GROUNDED in data or is generic filler.
 *
 * The `reference` copy is style guidance handed to the model — never emitted
 * verbatim. Typos in the user's source were corrected here (مستقيلة→مستقلة,
 * سكوني→سكني, متنساً→متنفساً, ارتجاز→ارتكاز).
 */

/** `unit_types` option values on the live all_projects model. */
export type UnitTypeValue =
  | 'apartment' | 'apartments' | 'townhouse' | 'townhouses' | 'villa' | 'villas'
  | 'duplex' | 'floor' | 'floors' | 'studio' | 'penthouse' | 'برج';

export type PostTone = 'short' | 'long';

export interface PostAngle {
  /** Stable slug — persisted on the record as `angle`, so never rename. */
  id: string;
  /** 1-15, the order the user gave them in. */
  order: number;
  label_ar: string;
  label_en: string;
  /** The emotional pitch, shown under the angle name in the UI. */
  theme_ar: string;
  theme_en: string;
  /** Unit types this angle reads most naturally for. A fit HINT, not a filter. */
  preferred_types: UnitTypeValue[];
  /**
   * Arabic substrings matched (case/space-insensitive) against the project's
   * features + services + amenities + construction status. A hit means the
   * angle is backed by real project data; zero hits means the writer is working
   * from generic positioning and the post is flagged «غير مدعوم ببيانات».
   */
  evidence_keywords: string[];
  /** Style reference per tone — the user's own copy, never emitted verbatim. */
  reference: Record<PostTone, { headline: string; body: string }>;
}

export const POST_ANGLES: PostAngle[] = [
  {
    id: 'luxury',
    order: 1,
    label_ar: 'الفخامة والرقي',
    label_en: 'Luxury',
    theme_ar: 'ترويجي فاخر',
    theme_en: 'Premium promotional',
    preferred_types: ['apartment', 'apartments', 'penthouse', 'villa', 'villas'],
    evidence_keywords: ['فاخر', 'تشطيب', 'رخام', 'حجر طبيعي', 'واجهات', 'جودة عالية', 'ممتاز', 'راقٍ', 'راقي'],
    reference: {
      short: {
        headline: 'عنوان الفخامة والعيش العصري الراقي.',
        body: 'استمتع بأسلوب حياة استثنائي في شقة فاخرة تجمع بين التخطيط الذكي، الإضاءة الطبيعية الوافرة، والخصوصية المطلقة لعائلتك.',
      },
      long: {
        headline: 'إعادة تعريف لمفهوم السكن الفاخر والعيش المترف.',
        body: 'يتجلى في هذا المشروع السكني أسمى معايير الهندسة المعمارية الحديثة؛ حيث تتناغم المساحات المفتوحة مع الإضاءة الطبيعية لتبدع بيئة سكنية تحاكي تطلعات أصحاب الذوق الرفيع. صُمم هذا الصرح ليكون ملاذاً هادئاً يجمع بين خصوصية العائلة ورفاهية التفاصيل.',
      },
    },
  },
  {
    id: 'view_height',
    order: 2,
    label_ar: 'الإطلالة والارتفاع',
    label_en: 'View & Height',
    theme_ar: 'جاذبية وإطلالة',
    theme_en: 'Panoramic appeal',
    preferred_types: ['penthouse', 'apartment', 'apartments', 'برج'],
    evidence_keywords: ['إطلالة', 'بانورامي', 'تراس', 'بلكونة', 'بلكونات', 'شرفة', 'سطح', 'روف', 'دور علوي', 'مصعد'],
    reference: {
      short: {
        headline: 'امتلك أفق المدينة واستمتع بالقمة.',
        body: 'تجربة سكنية تعلو بأسلوب حياتك؛ بنتهاوس فاخر يمنحك إطلالة بانورامية ساحرة مع تراس خارجي خاص لأوقات استجمام لا تُنسى.',
      },
      long: {
        headline: 'أفقٌ جديد للرفاهية فوق هامة المدينة.',
        body: 'تجربة سكنية تعلو بأسلوب حياتك إلى آفاق غير مسبوقة؛ إطلالات بانورامية تُعانق الأفق، مع مساحات خارجية خاصة صُممت بعناية لتمنحك أوقاتاً مفعمة بالهدوء والخصوصية التامة في أعلى نقطة بالحي.',
      },
    },
  },
  {
    id: 'independence',
    order: 3,
    label_ar: 'الاستقلالية العائلية',
    label_en: 'Independence',
    theme_ar: 'عائلي / استقلالية',
    theme_en: 'Family independence',
    preferred_types: ['townhouse', 'townhouses', 'villa', 'villas', 'duplex', 'floor', 'floors'],
    evidence_keywords: ['مدخل خاص', 'مدخل مستقل', 'حوش', 'موقف', 'كراج', 'مستقل', 'سطح', 'خصوصية'],
    reference: {
      short: {
        headline: 'الخيار الأمثل لمن ينشد استقلالية الفيلا وعملية التصميم.',
        body: 'تاون هاوس مودرن بمدخل مستقل وحوش خاص، صُمم بحرفية عالية ليمنح أسرتك مساحات واسعة وراحة تدوم.',
      },
      long: {
        headline: 'تناغم الخصوصية مع المساحة في مجتمع سكني واعد.',
        body: 'الحل السكني الأمثل للباحثين عن استقلالية الفيلا وعملية التخطيط الحديث. استُغلت أركانه بحرفية معمارية تضمن أقصى درجات الانتفاع من المساحات، مع مراعاة أعلى معايير العزل والخصوصية للعائلة.',
      },
    },
  },
  {
    id: 'family_stability',
    order: 4,
    label_ar: 'الاستقرار العائلي',
    label_en: 'Family Stability',
    theme_ar: 'استقرار ودفء',
    theme_en: 'Stability & warmth',
    preferred_types: ['apartment', 'apartments', 'floor', 'floors', 'townhouse'],
    evidence_keywords: ['غرف', 'ماستر', 'مجلس', 'صالة', 'عدادات', 'مطبخ', 'عائلي', 'مدرسة', 'مسجد', 'خدمات'],
    reference: {
      short: {
        headline: 'بيت العمر الذي يستحقه استقرار عائلتك.',
        body: 'شقة عائلية متكاملة الخدمات تضمن لك الفصل التام بين مجالس الضيافة والأجنحة الخاصة، على بعد خطوات من أهم المرافق الحيوية.',
      },
      long: {
        headline: 'مسكن متكامل يحتضن طموحات أسرتك.',
        body: 'صُممت هذه الوحدات لتكون النواة الأساسية لأسرة تسعى نحو الاستقرار والراحة. يتميز التخطيط الداخلي بالفصل المتقن بين مجالس الضيافة والأجنحة العائلية الخاصة، مما يمنح كل فرد في الأسرة حيزه الخاص من الراحة والتفرد.',
      },
    },
  },
  {
    id: 'compound_security',
    order: 5,
    label_ar: 'الأمان والمجتمع المغلق',
    label_en: 'Security & Compound',
    theme_ar: 'أمان ورفاهية',
    theme_en: 'Safety & amenities',
    preferred_types: ['apartment', 'apartments', 'townhouse', 'townhouses', 'villa', 'villas'],
    evidence_keywords: ['أمن', 'حراسة', 'كاميرات', 'مراقبة', 'بوابة', 'مجمع', 'نادي', 'مسبح', 'ملعب', 'حديقة', 'مساحات خضراء', 'أطفال', 'لاونج', 'مرافق'],
    reference: {
      short: {
        headline: 'مجتمعك الآمن وحياتك المفعمة بالرفاهية.',
        body: 'امتلك وحدتك داخل مجمع سكني يوفر حراسة أمنية متكاملة، مساحات خضراء، ومرافق ترفيهية تُثري حياة عائلتك يومياً.',
      },
      long: {
        headline: 'بيئة آمنة تفيض بالسكينة وتنبض بالحياة.',
        body: 'الامتلاك هنا يعني الانضمام إلى مجتمع حيوي متكامل الخدمات؛ حيث تلتقي الأناقة بالأمان، ضمن بيئة تُحيطها المساحات الخضراء والمرافق المهيأة لتعزيز نمط حياة صحي وراقٍ لكافة أفراد العائلة.',
      },
    },
  },
  {
    id: 'nature_privacy',
    order: 6,
    label_ar: 'الطبيعة والخصوصية',
    label_en: 'Nature & Privacy',
    theme_ar: 'طبيعة وخصوصية',
    theme_en: 'Greenery & privacy',
    preferred_types: ['apartment', 'apartments', 'townhouse', 'villa'],
    evidence_keywords: ['حديقة', 'أرضي', 'مشجرة', 'أفنية', 'مساحات خضراء', 'جلسات', 'خارجية', 'مدخل خاص', 'تنسيق'],
    reference: {
      short: {
        headline: 'رغد العيش بين أحضان الطبيعة والخصوصية.',
        body: 'وحدة فريدة بمدخل خاص وحديقة خارجية واسعة، تمنحك متنفساً خاصاً وأجواءً استثنائية دون التنازل عن سهولة السكن الفاخر.',
      },
      long: {
        headline: 'امتدادٌ من الخضرة وخصوصية تُعانق الطبيعة.',
        body: 'تجربة سكنية استثنائية من خلال المساحات الخضراء الخاصة التي تُشكل امتداداً طبيعياً للصالة الرئيسية. خيار يجمع بين سهولة العيش في الشقق الفاخرة وجمال المساحات المفتوحة المشابهة للفلل.',
      },
    },
  },
  {
    id: 'smart_home',
    order: 7,
    label_ar: 'المنزل الذكي',
    label_en: 'Smart Home',
    theme_ar: 'مستقبل وراحة',
    theme_en: 'Tech & comfort',
    preferred_types: ['apartment', 'apartments', 'penthouse', 'villa', 'duplex'],
    evidence_keywords: ['ذكي', 'ذكية', 'تحكم', 'أتمتة', 'سمارت', 'بدون مفاتيح', 'استشعار', 'تطبيق', 'ترشيد', 'طاقة', 'مكنسة مركزية'],
    reference: {
      short: {
        headline: 'بيت المستقبل بين يديك بنقرة زر.',
        body: 'وحدة ذكية مجهزة بأحدث تقنيات التحكم عن بُعد للإضاءة والتكييف والأمان، لتستمتع بأقصى درجات الراحة وترشيد الطاقة.',
      },
      long: {
        headline: 'التقنية في خدمة الراحة.. أسلوب عيشٍ يتطلع للمستقبل.',
        body: 'صُمم هذا المشروع ليتوافق مع معايير المستقبل الذكي؛ حيث أُدمجت أنظمة التحكم التقني بأسلوب معماري سلس، مما يتيح لك إدارة بيئة مسكنك الداخلية من إضاءة وتكييف وحماية بأعلى قدر من الكفاءة والسهولة.',
      },
    },
  },
  {
    id: 'corner_space',
    order: 8,
    label_ar: 'الموقع المميز والمساحة',
    label_en: 'Corner & Space',
    theme_ar: 'مساحة وتميز',
    theme_en: 'Space & distinction',
    preferred_types: ['townhouse', 'townhouses', 'villa', 'villas', 'duplex'],
    evidence_keywords: ['زاوية', 'ارتداد', 'واجهتين', 'واجهات', 'إضاءة طبيعية', 'مساحة', 'كراج', 'موقف'],
    reference: {
      short: {
        headline: 'تميّز بالموقع واحظَ بمساحة مضاعفة.',
        body: 'وحدة زاوية بجمالية معمارية فريدة وارتداد جانبي واسع، توفر لك ولعائلتك إضاءة طبيعية غنية ومساحات خارجية إضافية.',
      },
      long: {
        headline: 'تميّز الموقع ورخاء المساحة.',
        body: 'يحظى هذا العقار بموقع استراتيجي يضمن له إضاءة طبيعية على مدار النهار وارتداداً حراً يرفع من مستوى الخصوصية. خيار سكني رصين يجسد التوازن بين الجمال المعماري واستغلال الأرض.',
      },
    },
  },
  {
    id: 'smart_start',
    order: 9,
    label_ar: 'الانطلاقة الذكية',
    label_en: 'Smart Start',
    theme_ar: 'بداية جديدة',
    theme_en: 'First home',
    preferred_types: ['apartment', 'apartments', 'studio', 'floor'],
    evidence_keywords: ['توزيع', 'مطبخ', 'مجهز', 'تكييف', 'عملي', 'مودرن', 'حديث', 'تمويل', 'دفعات', 'سداد'],
    reference: {
      short: {
        headline: 'بداية جديدة في مساحة صُممت لأجلك.',
        body: 'وحدة سكنية بتصميم مودرن وتوزيع ذكي يستغل كل متر مربع، لتضمن لك جودة الحياة بأفضل تكلفة تشغيلية.',
      },
      long: {
        headline: 'بدايةٌ مكللة بالأناقة وعملية التصميم.',
        body: 'خيار سكني كُيّف بحرفية عالية ليناسب بداية مراحل الاستقرار. يجمع بين كفاءة توزيع المساحات، وجودة التشطيبات، والتكلفة التشغيلية المتوازنة التي تمنحك انطلاقة سكنية متينة ومريحة.',
      },
    },
  },
  {
    id: 'prestige',
    order: 10,
    label_ar: 'الهيبة والثبات',
    label_en: 'Prestige',
    theme_ar: 'فخامة وهيبة',
    theme_en: 'Grandeur',
    preferred_types: ['villa', 'villas', 'duplex', 'penthouse'],
    evidence_keywords: ['مستقل', 'فيلا', 'مسبح', 'مصعد', 'حديقة', 'كود البناء', 'إشراف هندسي', 'إرث', 'مساحات واسعة'],
    reference: {
      short: {
        headline: 'عنوان الثبات والمهابة المعمارية التي تدوم.',
        body: 'مسكن فاخر صُمم ليكون إرثاً سكنياً مستداماً، تتكامل فيه المسطحات المائية والحدائق لتقديم أرقى مستويات العيش المترف.',
      },
      long: {
        headline: 'عنوان الثبات والمهابة المعمارية.',
        body: 'صرح سكني يعكس أعلى درجات الإتقان الهندسي؛ حيث صُمم ليكون إرثاً سكنياً مستداماً. تتكامل فيه المسطحات المائية مع الحدائق الداخلية والمساحات الواسعة لتلبي تطلعات الأسر التي لا ترتضي لعيشها بديلاً عن الرفاهية.',
      },
    },
  },
  {
    id: 'value_balance',
    order: 11,
    label_ar: 'التوازن والقيمة',
    label_en: 'Value & Balance',
    theme_ar: 'توازن وقيمة',
    theme_en: 'Balanced value',
    preferred_types: ['duplex', 'townhouse', 'floor', 'floors', 'apartment'],
    evidence_keywords: ['دوبلكس', 'دبلكس', 'أدوار', 'ملحق', 'جناح', 'مجالس', 'كسوة', 'مواد', 'تصميم'],
    reference: {
      short: {
        headline: 'الاستقلالية التي تطمح إليها بأسعار متوازنة.',
        body: 'تصميم رأسي مبتكر يضمن الفصل المثالي بين أدوار المعيشة والنوم، مع كسوة خارجية عصرية ومواد عالية الجودة.',
      },
      long: {
        headline: 'الخيار الرصين للتوسع السكني العائلي.',
        body: 'تتميز هذه الوحدات بجماليتها البصرية واستغلالها الأمثل للارتفاعات والمساحات العمودية. صُممت لتمنح ساكنيها شعور الاستقلالية الكاملة، مع جودة عالية في المواد الإنشائية المستعملة والكسوة الخارجية.',
      },
    },
  },
  {
    id: 'off_plan',
    order: 12,
    label_ar: 'البيع على الخارطة',
    label_en: 'Off-Plan',
    theme_ar: 'فرصة استثمارية',
    theme_en: 'Investment window',
    preferred_types: [],
    evidence_keywords: ['خارطة', 'خريطة', 'تحت الإنشاء', 'حساب ضمان', 'وافي', 'تسليم', 'دفعات', 'سداد', 'تمويل', 'إطلاق'],
    reference: {
      short: {
        headline: 'اقتنص الفرصة وتملك بأسعار مرحلة الإطلاق.',
        body: 'احجز وحدتك مبكراً في مشروع معتمد وتحت الإنشاء، واستمتع بمرونة تشكيل المخططات والتشطيبات بخطط دفع ميسرة.',
      },
      long: {
        headline: 'استثمر في مراحل التأسيس الأولى واضمن قيمتك المستقبلية.',
        body: 'نضع بين أيديكم فرصة الاكتتاب السكني في أحد أحدث مشاريعنا المعتمدة رسمياً. يتيح لكم هذا المشروع فرصة اختيار توزيع المخططات والتشطيبات الداخلية بمرونة كاملة وبأسعار التأسيس الأولى، تحت إشراف هندسي صارم على كافة مراحل البناء.',
      },
    },
  },
  {
    id: 'quality_warranty',
    order: 13,
    label_ar: 'الجودة والضمانات',
    label_en: 'Quality & Warranty',
    theme_ar: 'راحة بال',
    theme_en: 'Peace of mind',
    preferred_types: [],
    evidence_keywords: ['ضمان', 'عزل', 'هيكل', 'خرسانة', 'كود البناء', 'إشراف', 'صيانة', 'جودة', 'عيوب خفية'],
    reference: {
      short: {
        headline: 'جودة تُرى وضمانات تمنحك طمأنينة العمر.',
        body: 'مسكن صُمم وفق أعلى معايير كود البناء الحديث، بإشراف هندسي صارم وضمانات طويلة المدى تحمي استثمارك العقاري.',
      },
      long: {
        headline: 'متانةٌ تتحدى الزمن وضمانات توفر لك رغد البال.',
        body: 'لا نكتفي بجمال الظاهر، بل نُولي البنية التحتية والمواد الأساسية الاهتمام الأكبر. صُممت هذه الوحدات لتطابق أعلى كودات البناء، مما يضمن لك مسكناً مستداماً يقلل من تكاليف الصيانة المستقبلية.',
      },
    },
  },
  {
    id: 'location_access',
    order: 14,
    label_ar: 'الموقع وسهولة الوصول',
    label_en: 'Location & Access',
    theme_ar: 'نقطة تمركز',
    theme_en: 'Connectivity',
    preferred_types: [],
    evidence_keywords: ['طريق', 'شارع', 'محور', 'مدرسة', 'مسجد', 'سوق', 'مركز', 'مستشفى', 'قريب', 'دقائق', 'كم', 'حديقة عامة'],
    reference: {
      short: {
        headline: 'في قلب الحدث.. اختصر وقتك وقسّم يومك براحة.',
        body: 'مشروع سكني في موقع جغرافي استراتيجي يربطك فوراً بالمحاور الرئيسية، المدارس، والمناطق التجارية لتنعم بسهولة التنقل يومياً.',
      },
      long: {
        headline: 'موقعٌ استراتيجي يصنع الفارق في تفاصيل يومك.',
        body: 'يقع هذا المشروع السكني في نقطة ارتكاز حيوية تضمن لك سهولة الوصول إلى أهم المحاور الرئيسية بالمدينة، مع القرب الشديد من مراكز التسوق، المدارس، والمناطق الترفيهية، ليوفر عليك الوقت والجهد يومياً.',
      },
    },
  },
  {
    id: 'facade_light',
    order: 15,
    label_ar: 'الواجهات والإضاءة',
    label_en: 'Facade & Light',
    theme_ar: 'جماليات التصميم',
    theme_en: 'Design aesthetics',
    preferred_types: [],
    evidence_keywords: ['واجهة', 'واجهات', 'زجاج', 'إضاءة', 'نوافذ', 'حجر', 'تصميم', 'معماري', 'اتساع', 'ارتفاع السقف'],
    reference: {
      short: {
        headline: 'منزل ينبض بالحياة والضوء الطبيعي.',
        body: 'وحدات سكنية تتميز بشفافية معمارية وواجهات ممتدة، لتمنحك شعوراً دائماً بالاتساع، الدفء، والانشراح في كل زاوية.',
      },
      long: {
        headline: 'عندما تشكّل الإضاءة والتصميم المساحة السكنية.',
        body: 'تعتمد هُوية هذا المشروع على تقنية الشفافية المعمارية؛ حيث تُعزز الواجهات الشاسعة مرور الضوء الطبيعي، مما يُضفي على المساحات الداخلية شعوراً بالاتساع والارتباط الدائم بالمحيط الخارجي.',
      },
    },
  },
];

/** Lookup by the persisted `angle` slug. */
export function angleById(id: string): PostAngle | undefined {
  return POST_ANGLES.find((a) => a.id === id);
}

/** Normalize Arabic text for keyword matching: strip tatweel + diacritics,
 *  unify alef/ya/ta-marbuta variants, collapse whitespace. */
export function normalizeAr(s: string): string {
  return s
    .replace(/[ـ]/g, '')
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Which of the angle's evidence keywords actually appear in the project's
 * real text (features + services + amenities + landmarks + status). Empty =
 * the angle is NOT grounded in project data → the UI flags it and the post is
 * never auto-approved.
 */
export function matchAngleEvidence(angle: PostAngle, haystack: string[]): string[] {
  const hay = normalizeAr(haystack.join('   '));
  return angle.evidence_keywords.filter((k) => hay.includes(normalizeAr(k)));
}
