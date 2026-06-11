/**
 * Document templates for Wassel Documents.
 *
 * Each template builds a TipTap JSON document in the caller's language
 * (Arabic-first company — templates read naturally in both). Templates are
 * CODE-DEFINED (not DB rows): the initial set is fixed product surface, and
 * keeping them here makes them version-controlled and instantly available
 * offline.
 *
 * `{{token}}` placeholders (e.g. {{client_name}}, {{project_name}}) are
 * deliberate forward-compat with the CRM-variables feature — until that
 * ships they read as obvious fill-me-in slots; once it ships they resolve
 * live from the document's linked records. Keep token slugs aligned with
 * the live model field slugs.
 *
 * Only node types supported by the editor's extension set may appear here:
 * paragraph, heading(1-3), bulletList, orderedList, listItem, blockquote,
 * horizontalRule, text with bold/italic/underline marks.
 */

import type { JSONContent } from '@tiptap/core';

// ─── JSON builders ────────────────────────────────────────────────────────

type Inline = JSONContent;

function t(text: string): Inline {
  return { type: 'text', text };
}
function b(text: string): Inline {
  return { type: 'text', marks: [{ type: 'bold' }], text };
}
function h(level: 1 | 2 | 3, ...content: Inline[]): JSONContent {
  return { type: 'heading', attrs: { level }, content };
}
function p(...content: Inline[]): JSONContent {
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}
function li(...blocks: JSONContent[]): JSONContent {
  return { type: 'listItem', content: blocks };
}
function bullets(items: Array<Inline[] | string>): JSONContent {
  return {
    type: 'bulletList',
    content: items.map((it) => li(p(...(typeof it === 'string' ? [t(it)] : it)))),
  };
}
function ordered(items: Array<Inline[] | string>): JSONContent {
  return {
    type: 'orderedList',
    content: items.map((it) => li(p(...(typeof it === 'string' ? [t(it)] : it)))),
  };
}
function quote(text: string): JSONContent {
  return { type: 'blockquote', content: [p(t(text))] };
}
function hr(): JSONContent {
  return { type: 'horizontalRule' };
}
function doc(...content: JSONContent[]): JSONContent {
  return { type: 'doc', content };
}

// ─── Template registry ────────────────────────────────────────────────────

export type DocumentTemplateId =
  | 'proposal'
  | 'contract'
  | 'marketing_brief'
  | 'meeting_notes'
  | 'property_report'
  | 'project_presentation';

export interface DocumentTemplate {
  id: DocumentTemplateId;
  labelAr: string;
  labelEn: string;
  descAr: string;
  descEn: string;
  build: (isAr: boolean) => JSONContent;
}

const proposal: DocumentTemplate = {
  id: 'proposal',
  labelAr: 'عرض خدمات',
  labelEn: 'Proposal',
  descAr: 'عرض تسويق وبيع مشروع عقاري لعميل — نطاق العمل والأسعار والجدول الزمني',
  descEn: 'Real-estate marketing & sales proposal — scope, pricing, timeline',
  build: (isAr) =>
    isAr
      ? doc(
          h(1, t('عرض خدمات تسويق وبيع — {{project_name}}')),
          p(t('مقدم إلى: '), b('{{client_name}}')),
          p(t('التاريخ: '), t('{{today}}')),
          hr(),
          h(2, t('الملخص التنفيذي')),
          p(
            t(
              'يسعدنا في وصل العقارية تقديم هذا العرض لتولي تسويق وبيع مشروع {{project_name}}، اعتماداً على خبرتنا في السوق العقاري السعودي ومنظومتنا التشغيلية المتكاملة.',
            ),
          ),
          h(2, t('نطاق العمل')),
          h(3, t('التسويق')),
          bullets([
            'دراسة السوق والمنافسين وتحديد الجمهور المستهدف',
            'الهوية الإعلانية للمشروع والمحتوى الإبداعي (ريلز، سناب، تيك توك، ميتا)',
            'إدارة الحملات الممولة وتحسينها أسبوعياً',
            'تقارير أداء شهرية',
          ]),
          h(3, t('المبيعات')),
          bullets([
            'فريق مبيعات مخصص للمشروع',
            'استقبال العملاء وإدارة الزيارات والمعاينات',
            'إدارة رحلة العميل حتى الإفراغ',
          ]),
          h(2, t('الأسعار والعمولة')),
          p(t('نسبة العمولة: '), b('٪ ____'), t(' من قيمة كل وحدة مباعة.')),
          p(t('ميزانية الحملات الإعلانية: تُحدد باتفاق الطرفين وتدفع بشكل مستقل.')),
          h(2, t('الجدول الزمني')),
          ordered([
            'الأسبوع 1–2: التحضير والهوية والمحتوى',
            'الأسبوع 3: إطلاق الحملات',
            'شهرياً: تقرير أداء واجتماع متابعة',
          ]),
          h(2, t('الشروط العامة')),
          bullets([
            'مدة العرض: 15 يوماً من تاريخه',
            'تُوقع اتفاقية تسويق وبيع مستقلة عند الموافقة',
          ]),
          hr(),
          p(b('وصل العقارية')),
          p(t('التوقيع: ____________________')),
        )
      : doc(
          h(1, t('Marketing & Sales Proposal — {{project_name}}')),
          p(t('Prepared for: '), b('{{client_name}}')),
          p(t('Date: '), t('{{today}}')),
          hr(),
          h(2, t('Executive Summary')),
          p(
            t(
              'Wassel Real Estate is pleased to submit this proposal to market and sell {{project_name}}, building on our Saudi market expertise and integrated operations.',
            ),
          ),
          h(2, t('Scope of Work')),
          h(3, t('Marketing')),
          bullets([
            'Market & competitor study, target-audience definition',
            'Project ad identity and creative content (Reels, Snap, TikTok, Meta)',
            'Paid campaign management with weekly optimization',
            'Monthly performance reports',
          ]),
          h(3, t('Sales')),
          bullets([
            'Dedicated sales team for the project',
            'Lead reception, visits and viewings management',
            'Full client journey through to deed transfer',
          ]),
          h(2, t('Pricing & Commission')),
          p(t('Commission: '), b('____ %'), t(' of each sold unit value.')),
          p(t('Ad budget: agreed by both parties and paid separately.')),
          h(2, t('Timeline')),
          ordered([
            'Weeks 1–2: setup, identity, content',
            'Week 3: campaign launch',
            'Monthly: performance report + review meeting',
          ]),
          h(2, t('General Terms')),
          bullets(['Proposal validity: 15 days', 'A separate marketing & sales agreement is signed upon approval']),
          hr(),
          p(b('Wassel Real Estate')),
          p(t('Signature: ____________________')),
        ),
};

const contract: DocumentTemplate = {
  id: 'contract',
  labelAr: 'عقد',
  labelEn: 'Contract',
  descAr: 'هيكل اتفاقية: الأطراف، التمهيد، البنود، الأتعاب، التوقيعات',
  descEn: 'Agreement skeleton: parties, recitals, clauses, fees, signatures',
  build: (isAr) =>
    isAr
      ? doc(
          h(1, t('اتفاقية تسويق وبيع عقاري')),
          p(t('إنه في يوم {{today}} تم الاتفاق بين كل من:')),
          ordered([
            [b('الطرف الأول: '), t('وصل العقارية — سجل تجاري رقم ____________')],
            [b('الطرف الثاني: '), t('{{client_name}} — هوية/سجل رقم ____________')],
          ]),
          h(2, t('التمهيد')),
          p(
            t(
              'حيث إن الطرف الثاني يمتلك مشروع {{project_name}}، ويرغب في إسناد أعمال تسويقه وبيعه إلى الطرف الأول، فقد اتفق الطرفان على ما يلي:',
            ),
          ),
          h(2, t('البند الأول — نطاق الأعمال')),
          p(t('يتولى الطرف الأول أعمال التسويق والبيع للمشروع وفق أفضل الممارسات المهنية.')),
          h(2, t('البند الثاني — الأتعاب')),
          p(t('يستحق الطرف الأول عمولة قدرها '), b('٪ ____'), t(' من قيمة كل وحدة مباعة، تستحق عند ____________.')),
          h(2, t('البند الثالث — مدة الاتفاقية')),
          p(t('تسري هذه الاتفاقية لمدة ____ شهراً تبدأ من تاريخ التوقيع، وتتجدد باتفاق الطرفين كتابةً.')),
          h(2, t('البند الرابع — التزامات الطرفين')),
          bullets([
            'يلتزم الطرف الأول ببذل العناية المهنية وتقديم تقارير دورية',
            'يلتزم الطرف الثاني بتوفير المستندات والتصاريح اللازمة',
          ]),
          h(2, t('البند الخامس — الإنهاء')),
          p(t('يجوز لأي من الطرفين إنهاء الاتفاقية بإشعار كتابي مدته ____ يوماً، مع حفظ الحقوق المستحقة قبل الإنهاء.')),
          h(2, t('البند السادس — النظام الواجب التطبيق')),
          p(t('تخضع هذه الاتفاقية لأنظمة المملكة العربية السعودية، وأي نزاع يُحال إلى الجهة القضائية المختصة.')),
          hr(),
          p(b('الطرف الأول'), t('  —  التوقيع: ____________________')),
          p(b('الطرف الثاني'), t('  —  التوقيع: ____________________')),
        )
      : doc(
          h(1, t('Real-Estate Marketing & Sales Agreement')),
          p(t('On {{today}}, this agreement is made between:')),
          ordered([
            [b('First party: '), t('Wassel Real Estate — CR No. ____________')],
            [b('Second party: '), t('{{client_name}} — ID/CR No. ____________')],
          ]),
          h(2, t('Recitals')),
          p(
            t(
              'Whereas the second party owns {{project_name}} and wishes to assign its marketing and sales to the first party, the parties agree as follows:',
            ),
          ),
          h(2, t('Clause 1 — Scope')),
          p(t('The first party shall market and sell the project per professional best practice.')),
          h(2, t('Clause 2 — Fees')),
          p(t('The first party earns a commission of '), b('____ %'), t(' of each sold unit value, due upon ____________.')),
          h(2, t('Clause 3 — Term')),
          p(t('This agreement runs for ____ months from signature and renews by written consent.')),
          h(2, t('Clause 4 — Obligations')),
          bullets([
            'First party: professional care and periodic reporting',
            'Second party: provide required documents and permits',
          ]),
          h(2, t('Clause 5 — Termination')),
          p(t('Either party may terminate with ____ days written notice; accrued rights survive.')),
          h(2, t('Clause 6 — Governing Law')),
          p(t('This agreement is governed by the laws of the Kingdom of Saudi Arabia.')),
          hr(),
          p(b('First party'), t('  —  Signature: ____________________')),
          p(b('Second party'), t('  —  Signature: ____________________')),
        ),
};

const marketingBrief: DocumentTemplate = {
  id: 'marketing_brief',
  labelAr: 'موجز تسويقي',
  labelEn: 'Marketing Brief',
  descAr: 'أهداف الحملة، الجمهور، الرسائل، القنوات، الميزانية، مؤشرات الأداء',
  descEn: 'Campaign objectives, audience, messages, channels, budget, KPIs',
  build: (isAr) =>
    isAr
      ? doc(
          h(1, t('موجز تسويقي — {{project_name}}')),
          quote('وثيقة مرجعية لفريق التسويق والمحتوى — تُحدّث مع كل مرحلة من الحملة.'),
          h(2, t('نبذة عن المشروع')),
          p(t('المشروع: '), b('{{project_name}}')),
          p(t('الموقع: {{project_location}}')),
          p(t('نطاق الأسعار: {{price_range}}')),
          h(2, t('أهداف الحملة')),
          ordered(['توليد ____ عميل محتمل شهرياً', 'بيع ____ وحدة خلال ____ أشهر', 'بناء وعي بالمشروع في مدينة ____']),
          h(2, t('الجمهور المستهدف')),
          bullets([
            'الفئة العمرية: ____',
            'الدخل والشريحة: ____',
            'دوافع الشراء: سكن / استثمار',
          ]),
          h(2, t('الرسائل الأساسية')),
          bullets(['الرسالة الأولى: ____', 'الرسالة الثانية: ____', 'نقطة التميز عن المنافسين: ____']),
          h(2, t('القنوات')),
          bullets(['ريلز إنستغرام', 'سناب شات', 'تيك توك', 'حملات ميتا الممولة', 'قوقل (بحث/عرض)']),
          h(2, t('الميزانية')),
          p(t('الميزانية الشهرية: ____ ر.س — التوزيع حسب أداء القنوات.')),
          h(2, t('مؤشرات الأداء (KPIs)')),
          bullets(['تكلفة العميل المحتمل (CPL)', 'معدل التحويل من تواصل إلى زيارة', 'عدد الزيارات والمبيعات الشهرية']),
          h(2, t('الجدول الزمني')),
          p(t('انطلاق الحملة: ____ — المراجعة الأولى: ____')),
        )
      : doc(
          h(1, t('Marketing Brief — {{project_name}}')),
          quote('Reference document for the marketing & content team — update each campaign phase.'),
          h(2, t('Project Overview')),
          p(t('Project: '), b('{{project_name}}')),
          p(t('Location: {{project_location}}')),
          p(t('Price range: {{price_range}}')),
          h(2, t('Objectives')),
          ordered(['Generate ____ leads/month', 'Sell ____ units within ____ months', 'Build awareness in ____']),
          h(2, t('Target Audience')),
          bullets(['Age range: ____', 'Income segment: ____', 'Motivation: residence / investment']),
          h(2, t('Key Messages')),
          bullets(['Message 1: ____', 'Message 2: ____', 'Differentiator vs competitors: ____']),
          h(2, t('Channels')),
          bullets(['Instagram Reels', 'Snapchat', 'TikTok', 'Meta paid campaigns', 'Google (search/display)']),
          h(2, t('Budget')),
          p(t('Monthly budget: SAR ____ — allocated by channel performance.')),
          h(2, t('KPIs')),
          bullets(['Cost per lead (CPL)', 'Lead → visit conversion rate', 'Monthly visits and sales']),
          h(2, t('Timeline')),
          p(t('Launch: ____ — First review: ____')),
        ),
};

const meetingNotes: DocumentTemplate = {
  id: 'meeting_notes',
  labelAr: 'محضر اجتماع',
  labelEn: 'Meeting Notes',
  descAr: 'الحضور، جدول الأعمال، النقاش، القرارات، المهام',
  descEn: 'Attendees, agenda, discussion, decisions, action items',
  build: (isAr) =>
    isAr
      ? doc(
          h(1, t('محضر اجتماع — {{today}}')),
          p(b('الموضوع: '), t('____')),
          p(b('الحضور: '), t('____')),
          p(b('المكان: '), t('____')),
          hr(),
          h(2, t('جدول الأعمال')),
          ordered(['____', '____', '____']),
          h(2, t('النقاش')),
          p(t('____')),
          h(2, t('القرارات')),
          bullets(['____']),
          h(2, t('المهام')),
          bullets([[t('المهمة: ____ — '), b('المسؤول: '), t('____ — '), b('الموعد: '), t('____')]]),
          h(2, t('الاجتماع القادم')),
          p(t('التاريخ: ____ — الموضوع: ____')),
        )
      : doc(
          h(1, t('Meeting Notes — {{today}}')),
          p(b('Subject: '), t('____')),
          p(b('Attendees: '), t('____')),
          p(b('Location: '), t('____')),
          hr(),
          h(2, t('Agenda')),
          ordered(['____', '____', '____']),
          h(2, t('Discussion')),
          p(t('____')),
          h(2, t('Decisions')),
          bullets(['____']),
          h(2, t('Action Items')),
          bullets([[t('Task: ____ — '), b('Owner: '), t('____ — '), b('Due: '), t('____')]]),
          h(2, t('Next Meeting')),
          p(t('Date: ____ — Subject: ____')),
        ),
};

const propertyReport: DocumentTemplate = {
  id: 'property_report',
  labelAr: 'تقرير عقاري',
  labelEn: 'Property Report',
  descAr: 'ملخص العقار والمواصفات والأسعار ومقارنة السوق والتوصية',
  descEn: 'Property summary, specs, pricing, market comparison, recommendation',
  build: (isAr) =>
    isAr
      ? doc(
          h(1, t('تقرير عقاري — {{project_name}}')),
          p(t('تاريخ التقرير: {{today}} — إعداد: وصل العقارية')),
          hr(),
          h(2, t('ملخص العقار')),
          bullets([
            [b('المشروع: '), t('{{project_name}}')],
            [b('الموقع: '), t('{{project_location}}')],
            [b('نوع الوحدات: '), t('____')],
          ]),
          h(2, t('المواصفات')),
          bullets([
            [b('نطاق المساحات: '), t('{{area_range}}')],
            [b('غرف النوم: '), t('{{bedroom_range}}')],
            [b('دورات المياه: '), t('{{bathroom_range}}')],
          ]),
          h(2, t('الأسعار')),
          bullets([
            [b('نطاق الأسعار: '), t('{{price_range}}')],
            [b('متوسط سعر المتر: '), t('{{avg_price_per_m2}}')],
            [b('الوحدات المتاحة: '), t('{{available_units}}')],
          ]),
          h(2, t('مقارنة السوق')),
          p(t('مقارنة بالمشاريع المنافسة في الحي/المدينة:')),
          bullets(['المشروع المنافس 1: السعر/م² ____', 'المشروع المنافس 2: السعر/م² ____']),
          h(2, t('نقاط القوة والضعف')),
          h(3, t('القوة')),
          bullets(['____']),
          h(3, t('الضعف')),
          bullets(['____']),
          h(2, t('التوصية')),
          quote('____'),
        )
      : doc(
          h(1, t('Property Report — {{project_name}}')),
          p(t('Report date: {{today}} — Prepared by Wassel Real Estate')),
          hr(),
          h(2, t('Property Summary')),
          bullets([
            [b('Project: '), t('{{project_name}}')],
            [b('Location: '), t('{{project_location}}')],
            [b('Unit types: '), t('____')],
          ]),
          h(2, t('Specifications')),
          bullets([
            [b('Area range: '), t('{{area_range}}')],
            [b('Bedrooms: '), t('{{bedroom_range}}')],
            [b('Bathrooms: '), t('{{bathroom_range}}')],
          ]),
          h(2, t('Pricing')),
          bullets([
            [b('Price range: '), t('{{price_range}}')],
            [b('Avg price/m²: '), t('{{avg_price_per_m2}}')],
            [b('Available units: '), t('{{available_units}}')],
          ]),
          h(2, t('Market Comparison')),
          p(t('Versus competing projects in the district/city:')),
          bullets(['Competitor 1: price/m² ____', 'Competitor 2: price/m² ____']),
          h(2, t('Strengths & Weaknesses')),
          h(3, t('Strengths')),
          bullets(['____']),
          h(3, t('Weaknesses')),
          bullets(['____']),
          h(2, t('Recommendation')),
          quote('____'),
        ),
};

const projectPresentation: DocumentTemplate = {
  id: 'project_presentation',
  labelAr: 'عرض مشروع',
  labelEn: 'Project Presentation',
  descAr: 'تعريف بالمشروع: الرؤية، الموقع، الوحدات، خطط الدفع، التواصل',
  descEn: 'Project intro: vision, location, units, payment plans, contact',
  build: (isAr) =>
    isAr
      ? doc(
          h(1, t('{{project_name}}')),
          quote('مشروع سكني بمعايير عصرية — قدمته لكم وصل العقارية'),
          h(2, t('الرؤية')),
          p(t('____')),
          h(2, t('الموقع وسهولة الوصول')),
          p(t('{{project_location}}')),
          bullets(['قريب من: ____', 'الطرق الرئيسية: ____', 'الخدمات المحيطة: ____']),
          h(2, t('الوحدات')),
          bullets([
            [b('الأنواع: '), t('____')],
            [b('المساحات: '), t('{{area_range}}')],
            [b('الأسعار: '), t('{{price_range}}')],
            [b('المتاح حالياً: '), t('{{available_units}} وحدة')],
          ]),
          h(2, t('المزايا والمواصفات')),
          bullets(['ضمانات: ____', 'التشطيبات: ____', 'مواقف وخدمات: ____']),
          h(2, t('خطط الدفع والتمويل')),
          bullets(['دفعة أولى: ____', 'دعم/تمويل بنكي: ____', 'مدة التسليم: ____']),
          h(2, t('تواصل معنا')),
          p(b('وصل العقارية'), t(' — هاتف: ____ — البريد: ____')),
        )
      : doc(
          h(1, t('{{project_name}}')),
          quote('A modern residential project — presented by Wassel Real Estate'),
          h(2, t('Vision')),
          p(t('____')),
          h(2, t('Location & Access')),
          p(t('{{project_location}}')),
          bullets(['Near: ____', 'Main roads: ____', 'Nearby services: ____']),
          h(2, t('Units')),
          bullets([
            [b('Types: '), t('____')],
            [b('Areas: '), t('{{area_range}}')],
            [b('Prices: '), t('{{price_range}}')],
            [b('Available now: '), t('{{available_units}} units')],
          ]),
          h(2, t('Features & Specs')),
          bullets(['Warranties: ____', 'Finishes: ____', 'Parking & amenities: ____']),
          h(2, t('Payment & Financing')),
          bullets(['Down payment: ____', 'Bank financing: ____', 'Handover: ____']),
          h(2, t('Contact Us')),
          p(b('Wassel Real Estate'), t(' — Phone: ____ — Email: ____')),
        ),
};

export const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
  proposal,
  contract,
  marketingBrief,
  meetingNotes,
  propertyReport,
  projectPresentation,
];

/** Resolve {{today}} at build time — it's a creation-time fact, not a live
 *  CRM variable, so baking it in keeps the doc stable. */
export function buildTemplateContent(template: DocumentTemplate, isAr: boolean): JSONContent {
  const json = template.build(isAr);
  const today = new Date().toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return replaceTextTokens(json, { today }) as JSONContent;
}

/** Walk a TipTap JSON tree replacing {{key}} tokens in text nodes. Only the
 *  provided keys are replaced — unknown tokens ({{client_name}}, ...) are
 *  left intact for the CRM-variables feature to resolve later. */
function replaceTextTokens(node: unknown, vars: Record<string, string>): unknown {
  if (Array.isArray(node)) return node.map((n) => replaceTextTokens(n, vars));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'text' && typeof v === 'string') {
        out[k] = v.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m);
      } else {
        out[k] = replaceTextTokens(v, vars);
      }
    }
    return out;
  }
  return node;
}
