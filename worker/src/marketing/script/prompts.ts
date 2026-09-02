/**
 * Prompt assembly — the stable system prefix (cacheable) comes from
 * mos_settings.script_writer_rules + code scaffolding; the user turn carries
 * four DELIMITED channels so the model can never confuse claim sources:
 *
 *   <verified_facts>      the ONLY source of claims (F-ids)
 *   <brand_rules>         Wassel naming / CTA / numerals
 *   <competitor_examples> style + structure only (E-ids) — facts inside are NOT usable
 *   <brief>               what to write
 *
 * Output order is fixed (plan → scenes → hooks) so the writer commits to a
 * structure before wording.
 */
import type { Brief, Exemplar, FactsPackage, JSONSchema, RecipeRow, ReviewReport, ScriptWriterRules } from './types.js';

export const PURPOSES = ['hook', 'location', 'product', 'feature', 'proof', 'offer', 'comparison', 'cta', 'brand'] as const;
const SHOT_SIZES = ['wide', 'medium', 'close', 'extreme_close', 'aerial'];
const SETTINGS = ['exterior_facade', 'interior_living', 'kitchen', 'bedroom', 'bathroom', 'amenity_pool', 'gym', 'lobby', 'street', 'map', 'studio', 'render', 'office'];
const SUBJECTS = ['building', 'unit', 'person', 'presenter', 'family', 'vehicle', 'text_card', 'logo', 'map', 'plan'];
const MOTIONS = ['static', 'pan', 'tilt', 'dolly', 'drone', 'handheld', 'zoom'];
const GRAPHICS = ['none', 'text_overlay', 'animated_map', '3d_render', 'motion_graphic', 'split_screen'];

export const GENERATION_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    patterns_learned: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { pattern: { type: 'string' }, from: { type: 'array', items: { type: 'string' } } }, required: ['pattern', 'from'] },
    },
    scene_plan: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { order: { type: 'integer' }, purpose: { type: 'string', enum: [...PURPOSES] }, goal: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } } }, required: ['order', 'purpose', 'goal', 'facts'] },
    },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          order: { type: 'integer' },
          purpose: { type: 'string', enum: [...PURPOSES] },
          duration_sec: { type: 'number' },
          voiceover: { type: 'string' },
          on_screen_text: { type: 'string' },
          visual: { type: 'string' },
          visual_intent: {
            type: 'object', additionalProperties: false,
            properties: {
              shot_size: { type: 'string', enum: SHOT_SIZES }, subject: { type: 'string', enum: SUBJECTS }, setting: { type: 'string', enum: SETTINGS },
              interior_exterior: { type: 'string', enum: ['interior', 'exterior', 'graphic', 'mixed'] }, motion: { type: 'string', enum: MOTIONS },
              graphic_kind: { type: 'string', enum: GRAPHICS }, mood: { type: 'string' },
            },
            required: ['shot_size', 'subject', 'setting', 'interior_exterior', 'motion', 'graphic_kind', 'mood'],
          },
          angle: { type: 'string' },
          fact_refs: { type: 'array', items: { type: 'string' } },
          learned_from: { type: 'array', items: { type: 'string' } },
          asset_requirement: { type: 'string', enum: ['footage', 'image', 'graphic', 'animation', 'template', 'none'] },
          production_note: { type: 'string' },
        },
        required: ['order', 'purpose', 'duration_sec', 'voiceover', 'on_screen_text', 'visual', 'visual_intent', 'angle', 'fact_refs', 'learned_from', 'asset_requirement', 'production_note'],
      },
    },
    hooks: { type: 'array', items: { type: 'string' } },
  },
  required: ['patterns_learned', 'scene_plan', 'scenes', 'hooks'],
};

export const REVIEW_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    overall: { type: 'string', enum: ['pass', 'revise', 'reject'] },
    dialect: { type: 'integer', minimum: 1, maximum: 5 },
    hook: { type: 'integer', minimum: 1, maximum: 5 },
    progression: { type: 'integer', minimum: 1, maximum: 5 },
    fit: { type: 'integer', minimum: 1, maximum: 5 },
    completeness: { type: 'integer', minimum: 1, maximum: 5 },
    notes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { scene: { type: 'integer' }, note: { type: 'string' } }, required: ['scene', 'note'] } },
  },
  required: ['overall', 'dialect', 'hook', 'progression', 'fit', 'completeness', 'notes'],
};

const HOOK_STYLE_TEXT: Record<string, string> = {
  question_or_variety_or_price_never_greeting:
    'الخطّاف (المشهد الأول) سؤال، أو تنوّع المنتجات، أو السعر — قوي وسريع. ممنوع فتح الفيديو بتحية طويلة («بسم الله… الله يبارك في وقتكم يا متابعين»). الدفء (بسم الله / ما شاء الله) مسموح بعد الخطّاف داخل الجولة، لا كافتتاحية.',
};

/** Stable, cacheable system prefix — rules as data + code scaffolding. */
export function buildSystemPrompt(rules: ScriptWriterRules): string {
  const hook = HOOK_STYLE_TEXT[rules.hook_style] ?? rules.hook_style;
  const numerals = rules.numerals_on_screen === 'arabic_indic' ? 'الأرقام على الشاشة (on_screen_text) بالأرقام العربية الهندية (٦٧٤٬٤٩٧)؛ العملة ر.س.' : 'الأرقام على الشاشة بالأرقام الغربية.';
  const dev = rules.allow_developer_name ? 'يجوز ذكر اسم المطوّر (مالك المشروع) فقط.' : 'لا يُذكر اسم المطوّر.';
  const forbidden = rules.forbidden_claim_classes.length ? `ممنوع نهائياً أي ادّعاء عن: ${rules.forbidden_claim_classes.join('، ')} (عوائد، تمويل، نسب أرباح) حتى لو ظهرت في الأمثلة.` : '';
  const lines = [
    `أنت كاتب سكربتات فيديو إعلاني لشركة «${rules.marketer_name}» في السوق العقاري السعودي. تكتب بلهجة سعودية دافئة ومقنعة، جملة واحدة قوية لكل مشهد، بلا حشو.`,
    '',
    'قواعد صارمة لا تُخالَف:',
    `1) كل رقم أو ادّعاء حقيقي (سعر، مساحة، عدد وحدات، مسافة، زمن، تاريخ تسليم، دفعة، ضمان) يأتي حصراً من <verified_facts> مع الإشارة إلى معرّفه (F#) في fact_refs. الحقائق التي عليها claimable=false تُذكر وصفياً بلا أرقام. إن نقصت معلومة، احذفها ولا تخمّن ولا تقرّب ولا تخترع.`,
    '2) السعر يُذكر دائماً بصيغة «تبدأ من …» بسعر البدء المتاح فقط. إن لم يوجد سعر متاح (مشروع مباع أو بلا مخزون) فلا يُذكر أي سعر ولا أي إتاحة.',
    '3) حالة الجاهزية تؤخذ من الحقائق: إن كانت «بيع على الخارطة» فاذكرها بوضوح (مع تاريخ التسليم إن وُجد) ولا تقل «جاهز/استلام فوري»؛ وإن كانت «جاهز» فبِعْ «جاهزة للسكن / استلام فوري» ولا تقل «على الخارطة/تسليم». لا تخلط بين الحالتين.',
    `4) الشركة الوحيدة التي تُذكَر هي «${rules.marketer_name}». ${dev} لا تذكر أي مسوّق آخر أو منافس أو وكالة أو رقم هاتف أو رخصة أو رابط أو حساب. كل دعوة للتواصل تكون: «${rules.cta_default}» — في المشهد الأخير فقط، ولا قناة تواصل أخرى في أي مشهد.`,
    `5) ${hook}`,
    `6) ${numerals} التعليق الصوتي (voiceover) بلهجة سعودية طبيعية.`,
    '7) <competitor_examples> للأسلوب والبنية والإيقاع فقط. الحقائق والأرقام والأسماء والعروض داخلها ليست قابلة للاستخدام أبداً — وممنوع نسخ أي جملة منها حرفياً (أقصى تطابق مسموح أقل من ' + rules.max_exemplar_overlap_words + ' كلمات متتالية). اذكر ما تعلّمته منها في patterns_learned و learned_from بمعرّفاتها (E#).',
    forbidden,
    '8) فكرة واحدة لكل مشهد. كل مشهد ٢–١٥ ثانية. مجموع المدد يقارب المدة المطلوبة في <brief> (±٢٠٪). عدد المشاهد يقارب scene_count_hint (±٢).',
    '9) الترتيب الإلزامي للإخراج: patterns_learned ثم scene_plan (خطة الأغراض والحقائق لكل مشهد) ثم scenes ثم hooks (٣ خطّافات بديلة بأسلوب القاعدة ٥). أخرج JSON مطابقاً للمخطط فقط بلا أي نص خارجه.',
    '10) visual_intent يصف اللقطة بالمفردات المحددة (shot_size/subject/setting/interior_exterior/motion/graphic_kind/mood) حتى يمكن مطابقتها بلقطات مرجعية لاحقاً. production_note يذكر ما يحتاجه التصوير أو التصميم.',
    ...(rules.extra_rules ?? []).map((r, i) => `${11 + i}) ${r}`),
  ].filter((l) => l !== '');
  return lines.join('\n');
}

function factsChannel(facts: FactsPackage): string {
  const lines = facts.facts.map((f) => `${f.id} [${f.class}${f.claimable ? '' : ' | claimable=false'}] ${f.rendered_ar}${f.note ? ` — (${f.note})` : ''}`);
  const head = [
    `المشروع: ${facts.project_name}`,
    `الجاهزية: ${facts.readiness === 'off_plan' ? 'بيع على الخارطة' : facts.readiness === 'ready' ? 'جاهز للسكن' : facts.readiness}`,
    facts.sold_out ? 'تنبيه: المشروع مباع بالكامل — لا سعر ولا إتاحة.' : '',
    facts.warnings.length ? `تحذيرات البيانات: ${facts.warnings.join(' | ')}` : '',
  ].filter(Boolean);
  return `<verified_facts>\n${head.join('\n')}\n${lines.join('\n')}\n</verified_facts>`;
}

function brandChannel(rules: ScriptWriterRules, facts: FactsPackage): string {
  const dev = rules.allow_developer_name && facts.developer_name ? `المطوّر (يجوز ذكره): ${facts.developer_name}` : 'لا يُذكر اسم المطوّر.';
  return `<brand_rules>\nالمسوّق الوحيد: ${rules.marketer_name}\nالدعوة للتواصل: ${rules.cta_default}\n${dev}\nالأرقام على الشاشة: ${rules.numerals_on_screen}\n</brand_rules>`;
}

function exemplarsChannel(exemplars: Exemplar[]): string {
  if (exemplars.length === 0) return '<competitor_examples>\n(لا توجد أمثلة — اعتمد على الوصفة والقواعد.)\n</competitor_examples>';
  const items = exemplars.map((e) => {
    const meta = [e.platform, e.content_type, e.views !== null ? `${e.views} مشاهدة` : null].filter(Boolean).join(' · ');
    const sp = e.selling_points.length ? `\nنقاط بيعها: ${e.selling_points.join('، ')}` : '';
    return `[${e.id}] (${meta})\nالنص: ${e.transcript}${e.ocr ? `\nنص على الشاشة: ${e.ocr}` : ''}${e.campaign_message ? `\nرسالتها: ${e.campaign_message}` : ''}${sp}`;
  });
  return `<competitor_examples>\nتنبيه: هذه أمثلة لتعلّم الأسلوب والبنية والإيقاع فقط. الحقائق والأرقام والأسماء والعروض والأرقام داخلها ليست قابلة للاستخدام في السكربت. قد تكون مترجمة آلياً — تعلّم الهيكل لا النص الحرفي.\n\n${items.join('\n\n')}\n</competitor_examples>`;
}

function briefChannel(brief: Brief, recipe: RecipeRow): string {
  const lines = [
    `الوصفة: ${recipe.label_ar} (${recipe.key}) — بنية الأغراض: ${recipe.structure.join(' → ')}`,
    `إرشاد الوصفة: ${recipe.guidance}`,
    `المدة المطلوبة: ${brief.duration_sec} ثانية · عدد المشاهد التقريبي: ${brief.scene_count_hint} · مرحلة القمع: ${brief.funnel}`,
    `المنصات: ${brief.platforms.join('، ')} · الغرض: ${brief.purpose} · اللغة: ${brief.language}`,
    brief.objective ? `الهدف: ${brief.objective}` : '',
    brief.audience ? `الجمهور: ${brief.audience}` : '',
    brief.objection ? `اعتراض يجب معالجته داخل السكربت: ${brief.objection}` : '',
    brief.campaign?.offer ? `عرض الحملة (يُذكر فقط إن كان مدعوماً بحقيقة): ${brief.campaign.offer}` : '',
    brief.core_message ? `الرسالة الأساسية: ${brief.core_message}` : '',
    brief.idea ? `الفكرة: ${brief.idea}` : '',
    brief.hook ? `خطّاف مقترح من الفريق: ${brief.hook}` : '',
    brief.angle ? `الزاوية: ${brief.angle}` : '',
    `الدعوة للتواصل: ${brief.cta}`,
    brief.existing_scenes.length ? `مشاهد موجودة حالياً (${brief.existing_scenes.length}) — اكتب سكربتاً كاملاً جديداً؛ لا تكرّر جملها: ${brief.existing_scenes.slice(0, 8).map((s) => `#${s.position} ${s.visual ?? ''}`).join(' | ')}` : '',
    brief.assets_summary.count ? `أصول متاحة للمونتاج: ${Object.entries(brief.assets_summary.kinds).map(([k, n]) => `${k}:${n}`).join('، ')}` : 'لا توجد أصول جاهزة — افترض تصويراً جديداً أو رندرات.',
  ].filter(Boolean);
  return `<brief>\n${lines.join('\n')}\n</brief>`;
}

export interface WriterPromptInput { brief: Brief; facts: FactsPackage; exemplars: Exemplar[]; recipe: RecipeRow; rules: ScriptWriterRules }

export function buildWriterUserPrompt(i: WriterPromptInput): string {
  return [factsChannel(i.facts), brandChannel(i.rules, i.facts), exemplarsChannel(i.exemplars), briefChannel(i.brief, i.recipe)].join('\n\n');
}

/** Repair turn: the same channels + the combined report; must fix every FAIL, keep what passed. */
export function buildRepairUserPrompt(i: WriterPromptInput, previous: unknown, report: ReviewReport): string {
  const fails = report.validator.checks.filter((c) => c.level === 'fail').map((c) => `- ${c.key}: ${c.detail}`);
  const claimFails = report.validator.claims.filter((c) => c.verdict === 'fail').map((c) => `- مشهد ${c.scene} (${c.field}): «${c.mention}» — ${c.reason}`);
  const ents = report.validator.entities.map((e) => `- مشهد ${e.scene}: «${e.mention}» (${e.kind})`);
  const judge = report.judge ? report.judge.notes.map((n) => `- مشهد ${n.scene}: ${n.note}`) : [];
  return [
    buildWriterUserPrompt(i),
    '<previous_output>',
    JSON.stringify(previous),
    '</previous_output>',
    '<review>',
    'أعد كتابة السكربت مع إصلاح كل ما يلي. احتفظ بكل مشهد نجح كما هو قدر الإمكان، وأصلح المشاهد المذكورة فقط، وأعد الإخراج كاملاً بنفس المخطط.',
    fails.length ? `فحوصات فاشلة:\n${fails.join('\n')}` : '',
    claimFails.length ? `ادّعاءات غير مدعومة (احذف الرقم أو استبدله بحقيقة موجودة):\n${claimFails.join('\n')}` : '',
    ents.length ? `أسماء/قنوات تواصل ممنوعة (احذفها):\n${ents.join('\n')}` : '',
    judge.length ? `ملاحظات المراجع:\n${judge.join('\n')}` : '',
    '</review>',
  ].filter(Boolean).join('\n');
}

export function buildReviewerSystemPrompt(rules: ScriptWriterRules): string {
  return [
    `أنت مراجع مستقل لسكربتات فيديو عقارية سعودية لشركة «${rules.marketer_name}». تحكم على السكربت دون أن ترى أمثلة المنافسين — لديك الحقائق المعتمدة وتقرير المدقّق الآلي والملخّص.`,
    'قيّم من ١ إلى ٥: dialect (لهجة سعودية طبيعية غير فصيحة جامدة ولا مصرية/شامية)، hook (يوقف التمرير في أول ثانيتين، ليس تحية)، progression (تسلسل منطقي: موقع → منتج → إثبات → دعوة)، fit (يطابق الوصفة والجمهور والهدف)، completeness (يستخدم الحقائق المهمة ولا يترك فجوة، والدعوة واضحة).',
    'overall = pass إذا لا شيء يمنع التصوير؛ revise إذا تحتاج تعديلات محددة؛ reject إذا الأساس خاطئ (جاهزية معكوسة، أرقام مختلقة، جهة أخرى مذكورة).',
    'notes: ملاحظات قابلة للتنفيذ لكل مشهد يحتاج تغييراً (scene = ترتيب المشهد؛ 0 للملاحظات العامة). لا تقترح أرقاماً جديدة غير موجودة في الحقائق.',
    'أخرج JSON مطابقاً للمخطط فقط.',
  ].join('\n');
}

export function buildReviewerUserPrompt(i: { brief: Brief; facts: FactsPackage; recipe: RecipeRow; scenes: unknown; hooks: string[]; validator: ReviewReport['validator'] }): string {
  const v = i.validator;
  const summary = [
    `فحوصات: ${v.checks.map((c) => `${c.key}=${c.level}`).join('، ')}`,
    `ادّعاءات فاشلة: ${v.claims.filter((c) => c.verdict === 'fail').length} · للمراجعة: ${v.claims.filter((c) => c.verdict === 'review').length}`,
    `كيانات ممنوعة: ${v.entities.length}`,
  ].join('\n');
  return [
    factsChannel(i.facts),
    briefChannel(i.brief, i.recipe),
    `<validator_report>\n${summary}\n${v.checks.filter((c) => c.level !== 'pass').map((c) => `- ${c.key} (${c.level}): ${c.detail}`).join('\n')}\n</validator_report>`,
    `<script>\n${JSON.stringify({ scenes: i.scenes, hooks: i.hooks })}\n</script>`,
  ].join('\n\n');
}
