/**
 * Director prompts — provider-neutral system prompts + user builders for the
 * three generation stages (concepts → package → derivatives) plus regenerate.
 *
 * Arabic primary (the working language of the deliverables), English gloss
 * second. The SYSTEM prompt is the stable cacheable prefix (role → hard rules
 * → recipes → writer rules → brand kit → stage output contract); everything
 * per-content (facts catalog, brief, targets, references, assets, chosen
 * concept, previous package) goes in the USER turn so the prefix cache hits
 * across contents.
 *
 * The spec twins these prompts encode: .claude/skills/writing-post/SKILL.md
 * (recipes + hard rules + Decisions Log) and the Decisions Log of
 * .claude/skills/writing-video-script/SKILL.md.
 */
import { brandKitPromptBlock } from '../brandKit.js';
import type {
  BasePackage,
  BrandKit,
  Concept,
  DerivativeTarget,
  PostRead,
  SlideRead,
  WriterRules,
} from '../contracts.js';
import { masterAspectFor, type PlacementSpec } from '../placementSpecs.js';
import type { PlannedDerivative } from './adaptation.js';
import type { CandidateAssetRow } from './assets.js';
import { rankCandidateAssets } from './assets.js';
import { ALLOWED_AI_MODES } from './policy.js';
import type { CreativeReferenceRow } from './references.js';
import type { DirectorInput } from './types.js';

// ── Recipes (writing-post SKILL.md "Post recipe library" + launch) ───────────
export interface PostRecipe {
  key: string;
  label_ar: string;
  label_en: string;
  beats_ar: string;
  /** true → runDirector throws `facts_insufficient:` when no claimable price fact exists. */
  requires_price: boolean;
}

export const POST_RECIPES: readonly PostRecipe[] = [
  {
    key: 'feature_spec', label_ar: 'مواصفات / مزايا', label_en: 'Feature / spec', requires_price: false,
    beats_ar: 'الوصفة الأساسية (الأكثر استخدامًا): عنوان بإيموجي (المشروع + الحي) ← سطر الجاهزية (جاهزة / على الخارطة) ← المساحة والسعر بالأعلى ← نقاط المزايا ← دعوة وصل ← بلوك الهاشتاق. التصميم: اسم المشروع + ١–٤ أسطر قصيرة فقط. الأفضل للبيع المباشر.',
  },
  {
    key: 'lifestyle', label_ar: 'لايف ستايل / علامة', label_en: 'Lifestyle / brand', requires_price: false,
    beats_ar: 'نص قصير ملهم بلا تفريغ مواصفات + سطر عاطفي/هوية + هاشتاقات قليلة. الأفضل للوصول والوعي.',
  },
  {
    key: 'offer', label_ar: 'عرض / إلحاح', label_en: 'Offer / urgency', requires_price: true,
    beats_ar: 'قصير وصادم: سعر + ندرة («٥٥ وحدة بس») + دعوة واضحة 👇. سطر السعر قد يكون أحد أسطر التصميم هنا لأنه الخطّاف.',
  },
  {
    key: 'event', label_ar: 'فعالية / إعلان', label_en: 'Event / announcement', requires_price: false,
    beats_ar: '«تعلن … / نعلن …» + تفاصيل المكان 📍 والتاريخ 🗓 + هاشتاقات؛ غالبًا ثنائي اللغة. للإطلاقات والمعارض والمحطات.',
  },
  {
    key: 'occasion', label_ar: 'مناسبة', label_en: 'Occasion', requires_price: false,
    beats_ar: 'يوم وطني / يوم التأسيس / عيد: سطر عاطفي واحد + ربط بالعلامة + هاشتاق المناسبة. قصير، بلا مواصفات.',
  },
  {
    key: 'launch', label_ar: 'إطلاق', label_en: 'Launch', requires_price: true,
    beats_ar: 'خطّاف إعلان ← كشف المشروع ← ٢–٣ مميزات فارقة ← الطرح الأول والسعر ← دعوة «كن أول من يحجز».',
  },
];

export function recipeByKey(key: string | null | undefined): PostRecipe | null {
  if (!key) return null;
  return POST_RECIPES.find((r) => r.key === key) ?? null;
}

// ── Hard rules (embedded verbatim-ish from the skills' rules + Decisions Logs) ─
const HARD_RULES_AR: readonly string[] = [
  'قواعد صارمة لا تُخالَف (من مهارة كتابة البوست وسجلي القرارات):',
  '١) اسم المشروع يتصدّر التصميم دائمًا عبر design_text.project_name_lead — ولا يلزم تكراره في سطور العناوين.',
  '٢) عناوين التصميم: ١–٤ أسطر قصيرة للمنشور المفرد؛ وللكاروسيل ١–٣ أسطر على الغلاف + سطر واحد لكل شريحة. التصميم = الاسم + العناوين فقط — ممنوع تكديس السعر/المساحة/الوحدات/الحالة/التواصل على الصورة؛ كل التفاصيل تعيش في الكابشن. (سطر سعر واحد يجوز فقط عندما تكون الوصفة عرضًا/إطلاقًا والسعر هو الخطّاف.)',
  '٣) كل رقم (سعر، مساحة، عدد، نسبة، تاريخ، مسافة، ضمان) يأتي حصرًا من حقائق المشروع المصنّفة [claimable]، ويُذكر معرّف الحقيقة (F1…) في fact_refs للحقل الذي ظهر فيه — في أي وصفة وفي أي حقل (عناوين، شرائح، كابشن، نص إعلاني). إن نقصت معلومة احذفها ولا تخمّن.',
  '٤) الجاهزية في الاتجاهين: «بيع على الخارطة» + تاريخ التسليم عندما تكون الحقائق off_plan؛ و«جاهزة للسكن / استلام فوري» عندما تكون ready. لا تُوهم بعكس المعطى أبدًا.',
  '٥) الجهتان الوحيدتان المذكورتان: وصل العقارية + مطوّر المشروع. ممنوع ذكر أي مسوّق أو منافس أو وكالة أو رقم هاتف أو رخصة أو منصة أو معرّف. كل دعوة تواصل (CTA) تكون لوصل العقارية فقط («للحجز والاستفسار: وصل العقارية») — ولا تخترع رقمًا.',
  '٦) الهاشتاقات هاشتاقاتنا: #وصل_العقارية + هاشتاق المشروع + وسوم عامة (المدينة/الحي/العقارات). ممنوع أي هاشتاق منافس مهما ظهر في مراجعهم.',
  '٧) اللهجة سعودية دافئة؛ الأرقام في نص التصميم بالأرقام العربية الهندية (١٬٠٥٠٬٠٠٠) والعملة ر.س.',
  '٨) ممنوع استخدام عبارة «بدون سعي» في أي نص — تُحذف بصمت دائمًا حتى لو وردت في وثيقة المشروع.',
  '٩) اللغة = لغة سجل المحتوى؛ لا لغة ثانية تلقائيًا. الاسم اللاتيني للمشروع مسموح في latin_name فقط.',
  '١٠) كابشن عضوي فقط للأهداف العضوية المختارة، ونص إعلاني (paid) فقط للأهداف المدفوعة المختارة — لا نص لأي هدف غير مختار.',
  '١١) محتوى المنافسين للإلهام ودراسة البنية فقط — ليس مصدرًا لأي حقيقة أو رقم أو اسم.',
  '١٢) كل مشتق (derivative) يحمل VisualAdaptation كاملة؛ وعندما لا يتغيّر شيء يُكتب ذلك صراحة («لا تغيير — …») بدل ترك الحقل فارغًا.',
  '١٣) الألوان من هوية وصل؛ أي لون خارجها يُذكر صراحة في brand_kit.deviations (وضع استرشادي) أو يُمنع كليًا (وضع إلزامي).',
  `١٤) توصيات صور الذكاء الاصطناعي ضمن الأنماط المسموحة فقط (${ALLOWED_AI_MODES.join(' / ')}). ممنوع اختلاق مزايا المشروع أو تغييرها (مبنى/وحدات/داخلية/إطلالة/مرافق) في أي موجّه صور؛ supporting_visual يبقى لايف ستايل/تجريديًا بلا مزايا المشروع؛ وعندما تنقص لقطة حقيقية استخدم request_photo بدل اختلاقها.`,
  '١٥) الخطّاف قوي وسريع: سؤال، أو تنوّع منتجات، أو سعر بدء — لا تفتح بتحية طويلة («بسم الله… الله يبارك في وقتكم»)؛ الدفء يأتي بعد الخطّاف لا قبله.',
];

const HARD_RULES_EN =
  'Binding summary: project name leads the design; 1–4 headline lines only (nothing else on the image); ' +
  'numbers only from claimable facts, each cited in the field\'s fact_refs; readiness stated both ways; ' +
  'only Wassel + the developer are named and every CTA is Wassel; hashtags are ours, never competitor tags; ' +
  'Saudi dialect; Arabic-Indic numerals on the design; never «بدون سعي»; keep the record\'s language; ' +
  'organic copy only for selected organic targets, paid copy only for selected paid targets; ' +
  'competitor content is inspiration, never a fact source; every derivative carries a full VisualAdaptation; ' +
  'AI image prompts never fabricate project features.';

// ── Writer rules + brand kit blocks ──────────────────────────────────────────
function renderWriterRules(rules: WriterRules): string {
  const lines: string[] = ['قواعد الكاتب المعتمدة (تُحرَّر من الإعدادات — التزم بها كما هي):'];
  if (rules.shared.length > 0) {
    lines.push('— قواعد مشتركة:');
    rules.shared.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  if (rules.post.length > 0) {
    lines.push('— قواعد البوست:');
    rules.post.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  if (rules.decisions_log.length > 0) {
    lines.push('— سجل القرارات (ملاحظات المشغّل المتراكمة — أحدثها آخرًا، وكلها ملزمة):');
    for (const d of rules.decisions_log) lines.push(`• [${d.date}] ${d.note}`);
  }
  return lines.join('\n');
}

function renderRecipes(): string {
  const lines = ['مكتبة وصفات البوست (beats كل وصفة):'];
  for (const r of POST_RECIPES) {
    lines.push(`— ${r.key} (${r.label_ar} / ${r.label_en}): ${r.beats_ar}`);
  }
  return lines.join('\n');
}

function renderBrandKit(kit: BrandKit | null, language: string): string {
  if (!kit) {
    return language === 'en'
      ? 'Brand kit: none configured yet — stay conservative with Wassel defaults and list every colour choice as a deviation.'
      : 'الهوية البصرية: لا توجد هوية معتمدة بعد — التزم ألوان وصل العامة بتحفّظ واذكر كل اختيار لون في الانحرافات.';
  }
  return brandKitPromptBlock(kit, language === 'en' ? 'en' : 'ar');
}

// ── System prompts (stable prefix first) ─────────────────────────────────────
export interface DirectorPromptCtx {
  language: string;
  rules: WriterRules;
  brandKit: BrandKit | null;
}

const ROLE_AR =
  'أنت المدير الإبداعي لمنشورات «وصل العقارية» في السوق العقاري السعودي. تحوّل حقائق المشروع إلى إبداع منشورات متكامل (نص التصميم + الاتجاه البصري + الكابشن/النص الإعلاني) بمستوى أفضل ما عند المنافسين، وبلا أي اختلاق. مخرجاتك JSON فقط وفق المخطط المطلوب.';

function systemPrefix(ctx: DirectorPromptCtx, stageContract: string): string {
  return [
    ROLE_AR,
    'You are the creative director for Wassel Real Estate social posts. Arabic is the primary working language; every rule below is binding. Output JSON only, matching the requested schema.',
    HARD_RULES_AR.join('\n'),
    HARD_RULES_EN,
    renderRecipes(),
    renderWriterRules(ctx.rules),
    renderBrandKit(ctx.brandKit, ctx.language),
    stageContract,
  ].join('\n\n');
}

const CONCEPTS_CONTRACT_AR = [
  'مهمتك في هذه المرحلة: اقترح ٢–٣ اتجاهات إبداعية (concepts) للمنشور.',
  'لكل اتجاه: id (c1/c2/c3) + عنوان قصير + الزاوية (angle) + الصيغة (single أو carousel) + فكرة التصميم في سطر واحد + المرجع الذي يستند إليه (من المراجع المعروضة فقط — ref_id حقيقي أو null) + الأهداف المقترحة بصيغة platform:placement_type + لماذا ينجح.',
  'اختر الأفضل في recommended (أحد المعرفات). اذكر في warnings أي محاذير، وفي missing أي حقائق تنقصك.',
  'لا أرقام إلا من الحقائق الـ claimable. لا تكتب الكابشن ولا التفاصيل هنا — هذه بطاقات اتجاه فقط.',
].join('\n');

const PACKAGE_CONTRACT_AR = [
  'مهمتك في هذه المرحلة: ابنِ الحزمة الإبداعية الأساسية (BasePackage) كاملة للاتجاه المختار.',
  'strategy: الهدف والجمهور (مع source) وسياق الحملة والزاوية والرسالة الرئيسية والاستجابة المطلوبة والصيغة ومبررها وintended_use وmaster_aspect (الأنسب للأهداف المختارة بأقل إعادات تخطيط) ومبرره واللغة (= لغة المحتوى حرفيًا).',
  'design_text: project_name_lead (= اسم المشروع من الحقائق حرفيًا، أو صيغته اللاتينية في latin_name عند ثنائية الهوية) + ١–٤ سطور عناوين (الغلاف للكاروسيل) + cta_on_design اختياري + fact_refs لكل رقم.',
  'slides: للكاروسيل فقط — لكل شريحة دورها ورسالتها وسطرها وأصلها (asset_ref من الأصول المرشحة) وfact_refs وخيط الاستمرارية. للمفرد: مصفوفة فارغة.',
  'visual_direction: المفهوم والمزاج والتكوين وعائلة التخطيط والتسلسل الهرمي والخط (أرقام عربية هندية) ومعالجة الصورة والخلفية والزخارف والشعار وموضع الدعوة والمساحة السالبة وملاحظة مناطق الأمان.',
  'palette: من هوية وصل (source brand_kit) أو هوية المشروع أو الأصول — مع ذكر أي انحراف في brand_kit.deviations.',
  'assets: اختر من الأصول المرشحة فقط (file_id حقيقي) — لكل اختيار موضعه واستخدامه ومعالجته ولماذا وهل هو إنتاجي. الحقوق تُنسخ من بيانات الأصل؛ لا تقررها بنفسك.',
  'references: اختر حتى ٤ من المراجع المعروضة فقط (ref_id حقيقي) — لكل مرجع جانب الدراسة (aspect) وماذا تدرس وكيف تكيّفه وما لا يُنسخ وكيف نتميّز.',
  'ai_recommendations: عند الحاجة فقط، وضمن الأنماط المسموحة — موجّه تنفيذي جاهز + must_keep + must_change + policy_check (قاعدة §7 التي يحققها) + status=recommended.',
  'facts_used: كل معرّفات الحقائق التي استندت إليها. confidence من ٠ إلى ١ لكل من النص والأصول والمراجع. warnings وmissing بلا تجميل.',
].join('\n');

const DERIVATIVES_CONTRACT_AR = [
  'مهمتك في هذه المرحلة: أنتج مشتقًا (derivative) واحدًا لكل هدف مختار — لا أكثر ولا أقل.',
  'لكل مشتق: target مطابق حرفيًا للهدف (target_kind/platform/placement_type/target_ref) + dimensions من المواصفة + adaptation كاملة.',
  'الحقول الهندسية للـ adaptation محسومة في الهياكل المعروضة (aspect/px/safe_zones/requires_separate_design/image_change/slide_mapping) — انسخها كما هي؛ أنت تؤلّف الحقول النصية فقط (image_instructions/text_reposition/logo_reposition/layout_changes/element_scaling)، وإن لم يتغير شيء اكتب «لا تغيير — …» صراحة.',
  'النص: للأهداف العضوية كابشن (ضمن caption_max) + هاشتاقاتنا (ضمن hashtags_max) + char_count + fact_refs. للأهداف المدفوعة primary_text + headline + description + cta + destination_url (أو null) + fact_refs.',
  'كل رقم في أي نص يستشهد بمعرّف حقيقة claimable في fact_refs ذلك النص.',
].join('\n');

export function conceptsSystem(ctx: DirectorPromptCtx): string {
  return systemPrefix(ctx, CONCEPTS_CONTRACT_AR);
}

export function packageSystem(ctx: DirectorPromptCtx): string {
  return systemPrefix(ctx, PACKAGE_CONTRACT_AR);
}

export function derivativesSystem(ctx: DirectorPromptCtx): string {
  return systemPrefix(ctx, DERIVATIVES_CONTRACT_AR);
}

// ── User builders (per-content data) ─────────────────────────────────────────
function langName(language: string): string {
  return language === 'en' ? 'English' : 'العربية';
}

function renderContent(input: DirectorInput): string {
  return [
    `المحتوى: «${input.content.title ?? '(بلا عنوان)'}» — النوع: ${input.content.content_type_key ?? 'post'}، اللغة: ${input.content.language}.`,
    `قاعدة اللغة: أنتج كل النصوص بـ${langName(input.content.language)} فقط — لا لغة ثانية تلقائيًا (الاسم اللاتيني للمشروع مسموح في latin_name فقط).`,
  ].join('\n');
}

function renderBrief(brief: Record<string, unknown> | null): string {
  if (!brief) return 'الموجز: غير متوفر — استنتج الجمهور والهدف من الحقائق (audience_source=inferred).';
  const g = (k: string): unknown => brief[k];
  const lines: string[] = ['الموجز (mos_script_brief):'];
  const campaign = g('campaign');
  if (campaign && typeof campaign === 'object') {
    const c = campaign as Record<string, unknown>;
    lines.push(`— الحملة: ${String(c.name ?? '(بدون اسم)')} — الهدف: ${String(c.objective ?? '—')} — العرض: ${String(c.offer ?? '—')}${c.audience_text ? ` — جمهور الحملة: ${String(c.audience_text)}` : ''}`);
  }
  if (g('objective')) lines.push(`— الهدف: ${String(g('objective'))}`);
  if (g('audience')) lines.push(`— الجمهور: ${String(g('audience'))}`);
  if (Array.isArray(g('platforms')) && (g('platforms') as unknown[]).length > 0) {
    lines.push(`— المنصات: ${(g('platforms') as unknown[]).join('، ')}`);
  }
  if (g('core_message')) lines.push(`— الرسالة الجوهرية: ${String(g('core_message'))}`);
  if (g('idea')) lines.push(`— الفكرة: ${String(g('idea'))}`);
  if (g('cta')) lines.push(`— الدعوة المعتمدة: ${String(g('cta'))}`);
  if (lines.length === 1) lines.push('— (موجز فارغ عمليًا — استنتج من الحقائق، audience_source=inferred)');
  return lines.join('\n');
}

function renderFacts(input: DirectorInput): string {
  const pkg = input.facts.package;
  const lines: string[] = [
    'حقائق المشروع (المصدر الوحيد للأرقام — كل رقم تستخدمه يُستشهد بمعرّفه في fact_refs):',
    `اسم المشروع: ${pkg.project_name}`,
    `الجاهزية: ${pkg.readiness}${pkg.sold_out ? ' — المشروع مباع بالكامل (لا تبِع توفرًا)' : ''}`,
  ];
  if (pkg.developer_name) lines.push(`المطوّر (يجوز ذكره): ${pkg.developer_name}`);
  lines.push(input.facts.catalog || '(لا حقائق رقمية متاحة — لا تستخدم أي رقم)');
  if (pkg.missing.length > 0) lines.push(`حقائق ناقصة (لا تخمّنها): ${pkg.missing.join('، ')}`);
  if (pkg.warnings.length > 0) lines.push(`تنبيهات الحقائق: ${pkg.warnings.join(' | ')}`);
  return lines.join('\n');
}

function renderRecipe(input: DirectorInput): string {
  const recipe = recipeByKey(input.recipe) ?? recipeByKey(typeof input.brief?.recipe === 'string' ? (input.brief.recipe as string) : null);
  if (!recipe) return 'الوصفة: غير محددة — اختر الأنسب من المكتبة واذكر اختيارك في rationale.';
  return `الوصفة المطلوبة: ${recipe.key} (${recipe.label_ar} / ${recipe.label_en}).\nبنيتها: ${recipe.beats_ar}`;
}

function renderTargets(targets: DerivativeTarget[], specs: PlacementSpec[]): string {
  const lines: string[] = [`الأهداف المختارة (${targets.length}) — النص موجود لها فقط:`, `الأبعاد المقترحة للتصميم الأساسي (master): ${masterAspectFor(targets)}.`];
  for (const t of targets) {
    const spec = specs.find((s) => s.platform === t.platform && s.placement_type === t.placement_type);
    if (!spec) {
      lines.push(`— ${t.target_kind} · ${t.platform}:${t.placement_type} — (لا مواصفة معروفة)`);
      continue;
    }
    const parts = [
      `— ${t.target_kind} · ${t.platform}:${t.placement_type}`,
      `الأبعاد: ${spec.aspects.map((a) => `${a}=${spec.px[a]?.[0]}×${spec.px[a]?.[1]}`).join('، ')}`,
    ];
    if (spec.safe_zones) parts.push(`مناطق أمان: ${JSON.stringify(spec.safe_zones)}`);
    if (spec.max_slides !== undefined) parts.push(`حد الشرائح: ${spec.max_slides}`);
    if (spec.caption_max !== undefined) parts.push(`حد الكابشن: ${spec.caption_max}`);
    if (spec.hashtags_max !== undefined) parts.push(`حد الهاشتاق: ${spec.hashtags_max}`);
    if (spec.manual_publish) parts.push('نشر يدوي');
    if (spec.notes) parts.push(`ملاحظة: ${spec.notes}`);
    lines.push(parts.join(' — '));
  }
  return lines.join('\n');
}

/** Compact one-line summary of an L1 SlideRead / L2 PostRead (defensive — read is jsonb). */
export function renderReadSummary(read: unknown, level: string): string {
  if (!read || typeof read !== 'object') return '';
  const r = read as Record<string, unknown>;
  const out: string[] = [];
  if (level === 'slide') {
    const s = read as Partial<SlideRead>;
    if (typeof r.layout === 'string') out.push(`تخطيط: ${r.layout}`);
    if (typeof r.text_position === 'string') out.push(`موضع النص: ${r.text_position}`);
    if (typeof r.density === 'string') out.push(`كثافة: ${r.density}`);
    if (Array.isArray(s.hierarchy) && s.hierarchy.length > 0) out.push(`هرمية: ${s.hierarchy.slice(0, 4).join(' ← ')}`);
    if (Array.isArray(s.palette)) {
      const hexes = s.palette.slice(0, 4).map((p) => (p && typeof p === 'object' ? String((p as { hex?: unknown }).hex ?? '') : '')).filter(Boolean);
      if (hexes.length > 0) out.push(`ألوان: ${hexes.join(' ')}`);
    }
    if (Array.isArray(s.mood) && s.mood.length > 0) out.push(`مزاج: ${s.mood.join('، ')}`);
    if (typeof s.notes === 'string' && s.notes) out.push(`ملاحظة: ${s.notes.slice(0, 160)}`);
  } else {
    const p = read as Partial<PostRead>;
    if (typeof r.format === 'string') out.push(`صيغة: ${r.format}`);
    if (Array.isArray(p.role_sequence) && p.role_sequence.length > 0) out.push(`تسلسل الأدوار: ${p.role_sequence.join(' ← ')}`);
    if (typeof p.narrative_arc === 'string' && p.narrative_arc) out.push(`قوس السرد: ${p.narrative_arc.slice(0, 160)}`);
    if (Array.isArray(p.strengths) && p.strengths.length > 0) out.push(`نقاط قوة: ${p.strengths.slice(0, 3).join('؛ ')}`);
    if (Array.isArray(p.weaknesses) && p.weaknesses.length > 0) out.push(`نقاط ضعف: ${p.weaknesses.slice(0, 2).join('؛ ')}`);
    if (p.learnable && typeof p.learnable === 'object') {
      const l = p.learnable as { structure?: string; hierarchy?: string; avoid?: string };
      if (l.structure) out.push(`يُتعلّم — بنية: ${l.structure.slice(0, 160)}`);
      if (l.avoid) out.push(`يُتجنّب: ${l.avoid.slice(0, 120)}`);
    }
  }
  return out.join(' | ');
}

const MAX_REFERENCES_IN_PROMPT = 8;

function renderReferences(rows: CreativeReferenceRow[]): string {
  if (rows.length === 0) return 'المراجع: لا توجد مراجع منافسين متاحة — ابنِ من الحقائق والهوية مباشرة.';
  const lines = [`مراجع للدراسة (إلهام البنية فقط — ليست مصدر حقائق؛ اختر منها بمعرّف ref_id حرفيًا):`];
  rows.slice(0, MAX_REFERENCES_IN_PROMPT).forEach((r, i) => {
    const head = `(${i + 1}) ref_id=${r.ref_id} — ${r.ref_kind} · ${r.org_name ?? 'جهة غير معروفة'} · ${r.platform ?? '؟'} · مستوى ${r.level}${r.slide_index !== null ? ` · شريحة ${r.slide_index}` : ''}`;
    const readSummary = renderReadSummary(r.read, r.level);
    lines.push(readSummary ? `${head}\n    قراءة التصميم: ${readSummary}` : head);
  });
  return lines.join('\n');
}

function renderDominantColors(colors: unknown): string {
  if (!Array.isArray(colors) || colors.length === 0) return '';
  const hexes = colors
    .slice(0, 4)
    .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' ? String((c as { hex?: unknown }).hex ?? '') : ''))
    .filter((h) => h.startsWith('#') || /^[0-9a-fA-F]{6}$/.test(h));
  return hexes.length > 0 ? hexes.join(' ') : '';
}

function renderAssets(rows: CandidateAssetRow[]): string {
  if (rows.length === 0) return 'الأصول المرشحة: لا توجد صور مشروع متاحة — اقترح request_photo عند الحاجة ولا تخترع أصولًا.';
  const ranked = rankCandidateAssets(rows);
  const lines = ['الأصول المرشحة (صور المشروع مرتبةً بأولوية الحقوق — اختر منها فقط بـ file_id حرفيًا؛ الحقوق كما هي معروضة ولا تُقرَّر منك):'];
  for (const r of ranked) {
    const parts = [
      `file_id=${r.file_id}`,
      r.original_name ? `«${r.original_name}»` : null,
      r.primary_category ?? r.document_type ?? null,
      r.asset_nature ? `طبيعة:${r.asset_nature}` : null,
      r.acquisition_source ? `مصدر:${r.acquisition_source}` : null,
      `حقوق:${r.usage_rights ?? '؟'}${r.rights_verified === true ? ' (موثّقة)' : ' (غير موثّقة — تتطلب تأكيدًا بشريًا)'}`,
      r.production_state ? `حالة:${r.production_state}` : null,
      r.width_px && r.height_px ? `${r.width_px}×${r.height_px}` : null,
      r.headline_space && r.headline_space !== 'none' ? `مساحة عنوان:${r.headline_space}` : null,
      r.has_text === true ? 'فيها نص' : null,
    ].filter((x): x is string => !!x);
    const colors = renderDominantColors(r.dominant_colors);
    if (colors) parts.push(`ألوان:${colors}`);
    if (r.ai_description) parts.push(`وصف: ${r.ai_description.slice(0, 220)}`);
    lines.push(`— ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

function renderConceptChoice(input: DirectorInput): string {
  const choice = input.conceptChoice;
  let concept: Concept | null = choice?.concept ?? null;
  if (!concept && choice?.concept_id && input.concepts) {
    concept = input.concepts.concepts.find((c) => c.id === choice.concept_id) ?? null;
  }
  if (choice?.custom) {
    return [
      'الاتجاه المختار (مخصص من الفريق):',
      `— العنوان: ${choice.custom.title}`,
      `— الزاوية: ${choice.custom.angle}`,
      `— الصيغة: ${choice.custom.format}`,
    ].join('\n');
  }
  if (!concept) return 'الاتجاه المختار: غير محدد — اختر أفضل اتجاه بنفسك واذكره في rationale.';
  return [
    `الاتجاه المختار (${concept.id}):`,
    `— العنوان: ${concept.title}`,
    `— الزاوية: ${concept.angle}`,
    `— الصيغة: ${concept.format}`,
    `— فكرة التصميم: ${concept.one_line_design_idea}`,
    `— لماذا ينجح: ${concept.why}`,
  ].join('\n');
}

/** The per-content blocks every stage shares, in stable order. */
function commonBlocks(input: DirectorInput): string[] {
  return [
    renderContent(input),
    renderBrief(input.brief),
    renderRecipe(input),
    renderFacts(input),
    renderTargets(input.targets, input.specs),
    renderReferences(input.referenceRows),
    renderAssets(input.assetRows),
  ];
}

export function conceptsUser(input: DirectorInput): string {
  return [
    ...commonBlocks(input),
    'المطلوب الآن: ٢–٣ اتجاهات إبداعية (concepts) وفق عقد المرحلة في التعليمات. JSON فقط.',
  ].join('\n\n');
}

export function packageUser(input: DirectorInput): string {
  const intendedUse = input.intendedUse ? `\nintended_use المعتمد لهذه الحزمة: ${input.intendedUse} (الزمه في strategy).` : '';
  return [
    ...commonBlocks(input),
    renderConceptChoice(input) + intendedUse,
    'المطلوب الآن: الحزمة الإبداعية الأساسية (BasePackage) كاملة للاتجاه المختار. JSON فقط.',
  ].join('\n\n');
}

function renderPlannedSkeletons(planned: PlannedDerivative[]): string {
  const lines = ['الهياكل الهندسية المحسومة لكل هدف (انسخ الحقول الهندسية كما هي — أنت تؤلّف النصوص فقط):'];
  for (const p of planned) {
    const key = `${p.target.target_kind}:${p.target.platform}:${p.target.placement_type}`;
    if (!p.skeleton || !p.dimensions) {
      lines.push(`— ${key}: لا مواصفة — وثّق ذلك في warnings المشتق.`);
      continue;
    }
    lines.push(
      `— ${key}: aspect=${p.skeleton.aspect}، px=${p.dimensions.px[0]}×${p.dimensions.px[1]}` +
      `، safe_zones=${JSON.stringify(p.skeleton.safe_zones)}` +
      `، requires_separate_design=${p.skeleton.requires_separate_design}` +
      `، image_change=${p.skeleton.image_change}` +
      (p.skeleton.slide_mapping.length > 0 ? `، slide_mapping=${JSON.stringify(p.skeleton.slide_mapping)}` : '') +
      (Object.keys(p.limits).length > 0 ? `، limits=${JSON.stringify(p.limits)}` : ''),
    );
  }
  return lines.join('\n');
}

export function derivativesUser(input: DirectorInput & { basePackage: BasePackage }, planned: PlannedDerivative[]): string {
  return [
    renderContent(input),
    renderFacts(input),
    'الحزمة الأساسية المعتمدة (التصميم الرئيسي الذي تُشتق منه):',
    JSON.stringify(input.basePackage, null, 1),
    renderPlannedSkeletons(planned),
    'المطلوب الآن: مشتق واحد لكل هدف مختار أعلاه — لا أكثر ولا أقل. JSON فقط.',
  ].join('\n\n');
}

export function regenerateUser(input: DirectorInput): string {
  const prev = input.previousPackage ? JSON.stringify(input.previousPackage, null, 1) : '(غير متوفرة)';
  const note = input.revisionNote?.trim() || '(بلا ملاحظة — حسّن الجودة العامة مع الحفاظ على القواعد)';
  return [
    ...commonBlocks(input),
    renderConceptChoice(input),
    'الحزمة السابقة (أعد توليدها كاملة مع معالجة الملاحظة — لا تنسخها حرفيًا):',
    prev,
    `ملاحظة المراجع (السبب المباشر لإعادة التوليد — عالجها أولًا): ${note}`,
    'المطلوب الآن: نسخة جديدة كاملة من BasePackage. JSON فقط.',
  ].join('\n\n');
}
