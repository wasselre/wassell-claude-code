/**
 * Video-script generator — the in-app twin of the `writing-video-script` skill.
 *
 * Given a project (from a content record) + a recipe, it loads the project's real
 * facts + the most relevant competitor video transcripts, and asks the model for a
 * STRICT scene array that maps 1:1 onto mos_scenes. The skill file
 * (.claude/skills/writing-video-script/SKILL.md) is the source-of-truth spec; keep
 * the recipes + rules here in sync with it.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

const ALL_PROJECTS_MODEL_ID = '220c49b9-de57-492d-9eca-c0d9f54fd40f';
const SCRIPT_MODEL = 'claude-sonnet-4-6'; // creative Arabic copy — quality over cost (swappable)

export const SCRIPT_RECIPES = {
  walkthrough: {
    ar: 'جولة', en: 'Walkthrough',
    beats: 'جولة (ميدانية أو رندرات): خطّاف قصير → ترسيخ الموقع → تجوّل في مزايا الوحدة بأسلوب ودّي («ما شاء الله») → المساحات والسعر → إشارة ثقة (جاهز أو ضمانات) → دعوة للتواصل.',
  },
  offer: {
    ar: 'عرض', en: 'Offer',
    beats: 'قصير (~٣٠ ثانية): خطّاف ندرة/سعر → العرض والسعر → إلحاح («قبل ما يخلص») → دعوة فورية للحجز.',
  },
  rent_vs_own: {
    ar: 'إيجار مقابل تملّك', en: 'Rent vs own',
    beats: 'لا يحتاج تصويراً: خطّاف «مستأجر؟» → مقارنة شخصين (واحد يستأجر وواحد يتملّك) → الحساب (استخدم سعر المشروع الحقيقي؛ رقم الإيجار يبقى وصفياً بلا تخمين) → الخلاصة أن التملّك أفضل → دعوة.',
  },
  product_explainer: {
    ar: 'شرح المنتج', en: 'Product explainer',
    beats: 'خطّاف «لماذا هذا المنتج مختلف» → المشكلة/الحاجة → المنتج كحل (مكوّنات ومرافق) → لمن يناسب → دعوة.',
  },
  launch: {
    ar: 'إطلاق', en: 'Launch',
    beats: 'خطّاف إعلان → كشف المشروع → ٢-٣ مميزات فارقة → الطرح الأول والسعر → دعوة «كن أول من يحجز».',
  },
} as const;
export type ScriptRecipe = keyof typeof SCRIPT_RECIPES;
export const isScriptRecipe = (v: unknown): v is ScriptRecipe =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(SCRIPT_RECIPES, v);

export interface ScriptScene {
  visual: string;
  voiceover: string;
  on_screen_text: string;
  start_sec: number | null;
  end_sec: number | null;
}
export interface ScriptDraft {
  scenes: ScriptScene[];
  hooks: string[];
  recipe: ScriptRecipe;
  project_name: string;
}

const UNIT_AR: Record<string, string> = {
  villa: 'فيلا', apartment: 'شقة', floor: 'دور', penthouse: 'بنتهاوس',
  townhouse: 'تاون هاوس', duplex: 'دوبلكس', studio: 'استوديو',
};

interface Range { min?: number | null; max?: number | null }
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Compact, model-ready facts sheet + the flags the rules depend on. */
export function buildFactsSheet(data: Record<string, unknown>): { sheet: string; projectName: string; hasFacts: boolean } {
  const g = (k: string): unknown => data[k];
  const projectName = String(g('project_name') ?? g('name') ?? 'المشروع');
  const status = `${String(g('construction_status') ?? '')} ${String(g('project_status') ?? '')}`;
  const services = Array.isArray(g('services')) ? (g('services') as Array<Record<string, unknown>>) : [];
  const servicesText = services.map((s) => `${s.service ?? ''} ${s.notes ?? ''}`).join(' ');
  const isOffPlan = /خارطة|تطوير|off.?plan|available_on_map/i.test(status + ' ' + servicesText);
  const isReady = !isOffPlan && /جاهز|ready/i.test(String(g('construction_status') ?? ''));

  const price = (g('available_price_range') ?? g('price_range') ?? {}) as Range;
  const area = (g('available_area_range') ?? g('area_range') ?? {}) as Range;
  const startPrice = num(price.min);
  const types = Array.isArray(g('unit_types')) ? (g('unit_types') as string[]).map((t) => UNIT_AR[t] ?? t) : [];
  const features = Array.isArray(g('features'))
    ? (g('features') as Array<Record<string, unknown>>).map((f) => String(f.feature ?? '')).filter(Boolean)
    : [];
  const guarantees = Array.isArray(g('guarantees'))
    ? (g('guarantees') as Array<Record<string, unknown>>).map((x) => `${x.col_1 ?? ''} ${x.col_3 ?? ''}`.trim()).filter(Boolean)
    : [];
  const landmarks = Array.isArray(g('nearby_landmarks'))
    ? (g('nearby_landmarks') as Array<Record<string, unknown>>)
        .map((l) => `${l.landmark ?? ''}${l.distance ? ` (${l.distance})` : l.duration ? ` (${l.duration})` : ''}`.trim())
        .filter(Boolean)
    : [];
  const marketingDoc = typeof g('marketing_document') === 'string' ? (g('marketing_document') as string) : '';

  const lines: string[] = [];
  lines.push(`اسم المشروع: ${projectName}`);
  const city = g('city_name') ?? g('preferred_city');
  const district = g('preferred_neighborhoods');
  if (city || district) lines.push(`الموقع: ${[district, city].filter(Boolean).join('، ')}`);
  lines.push(`حالة البناء: ${isOffPlan ? 'بيع على الخارطة' : isReady ? 'جاهز للسكن / استلام فوري' : String(g('construction_status') ?? 'غير محدد')}`);
  if (isOffPlan && g('handover_date')) lines.push(`التسليم المتوقع: ${String(g('handover_date')).slice(0, 7)}`);
  if (types.length) lines.push(`أنواع الوحدات: ${types.join('، ')}`);
  if (startPrice) lines.push(`السعر يبدأ من (المتاح): ${startPrice.toLocaleString('en-US')} ر.س`);
  if (num(area.min) && num(area.max)) lines.push(`المساحات المتاحة: ${num(area.min)}–${num(area.max)} م²`);
  if (num(g('available_units'))) lines.push(`الوحدات المتاحة: ${num(g('available_units'))}`);
  if (features.length) lines.push(`المزايا: ${features.slice(0, 16).join('، ')}`);
  if (guarantees.length) lines.push(`الضمانات: ${guarantees.slice(0, 10).join(' | ')}`);
  if (landmarks.length) lines.push(`معالم قريبة: ${landmarks.slice(0, 6).join('، ')}`);
  if (marketingDoc) lines.push(`\nالوثيقة التسويقية (المصدر الأساسي للحقائق النوعية):\n${marketingDoc.slice(0, 1800)}`);

  return { sheet: lines.join('\n'), projectName, hasFacts: Boolean(startPrice || marketingDoc || features.length) };
}

/** Load the project's raw jsonb from all_projects (service client — public catalog read). */
export async function loadProjectData(svc: SupabaseClient, projectId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await svc
    .from('unified_records')
    .select('data')
    .eq('id', projectId)
    .eq('model_id', ALL_PROJECTS_MODEL_ID)
    .maybeSingle();
  if (error || !data) return null;
  return (data.data ?? null) as Record<string, unknown> | null;
}

/** The ~12 most relevant competitor video transcripts, to ground the voice. */
export async function loadTranscripts(svc: SupabaseClient): Promise<string[]> {
  const { data, error } = await svc.rpc('mkt_script_transcripts_sample');
  if (!error && Array.isArray(data)) return (data as Array<{ txt: string }>).map((r) => r.txt).filter(Boolean);
  // Fallback: direct query if the helper RPC isn't present.
  const q = await svc
    .from('mkt_transcripts')
    .select('text, status')
    .eq('status', 'done')
    .order('duration_ms', { ascending: false })
    .limit(12);
  if (q.error || !q.data) return [];
  return (q.data as Array<{ text: string }>).map((r) => (r.text ?? '').slice(0, 500)).filter(Boolean);
}

function systemPrompt(): string {
  return [
    'أنت كاتب سكربتات فيديو إعلاني لشركة «وصل العقارية» في السوق العقاري السعودي. تكتب بلهجة سعودية دافئة ومقنعة.',
    'قواعد صارمة لا تُخالَف:',
    '1) كل رقم (سعر، مساحة، عدد، مسافة، ضمان) يجب أن يأتي من «حقائق المشروع» فقط — لا تخترع أي رقم. إن نقصت معلومة، احذفها ولا تخمّن.',
    '2) السعر يُذكر دائماً بصيغة «تبدأ من …» باستخدام سعر البدء المتاح المعطى.',
    '3) حالة البناء: إن كانت «بيع على الخارطة» فاذكرها بوضوح مع تاريخ التسليم؛ وإن كانت «جاهز» فبِع «جاهزة للسكن / استلام فوري». لا تخلط بين الحالتين ولا تدّعي عكس المعطى.',
    '4) الشركة الوحيدة التي تُذكَر هي «وصل العقارية». لا تذكر اسم أي مسوّق آخر، أو منافس، أو حتى اسم المطوّر أو رقمه أو رخصته أو رابطه. كل دعوة للتواصل تكون: «للحجز والاستفسار: وصل العقارية».',
    '5) الخطّاف (أول مشهد) قوي وسريع: سؤال، أو تنوّع منتجات، أو سعر — لا تفتح بتحية طويلة مثل «بسم الله الله يبارك في وقتكم».',
    '6) الأرقام على الشاشة (on_screen_text) بالأرقام العربية الهندية (٦٧٤٬٤٩٧). التعليق الصوتي (voiceover) بلهجة سعودية طبيعية.',
    '7) في وصفة «إيجار مقابل تملّك»: استخدم سعر المشروع الحقيقي فقط؛ أي رقم إيجار يبقى وصفياً بلا رقم مُختلَق.',
    'أنتج ٥–٨ مشاهد، ولكل مشهد: visual (وصف اللقطة)، voiceover (التعليق)، on_screen_text (النص الظاهر)، وتوقيت تقريبي بالثواني (start_sec/end_sec). وأنتج ٣ خطّافات بديلة (hooks).',
    'استدعِ الأداة emit_script واملأ scenes و hooks. لا تكتب أي نص خارج الأداة.',
  ].join('\n');
}

export async function generateScript(
  recipe: ScriptRecipe,
  factsSheet: string,
  transcripts: string[],
): Promise<{ scenes: ScriptScene[]; hooks: string[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const r = SCRIPT_RECIPES[recipe];
  const learn = transcripts.length
    ? `\n\nمقتطفات من فيديوهات المنافسين (للأسلوب والبنية فقط — قد تكون مترجمة آلياً؛ تعلّم منها الهيكل والنبرة لا النص الحرفي):\n${transcripts.slice(0, 12).map((t, i) => `(${i + 1}) ${t}`).join('\n')}`
    : '';
  const userText =
    `الوصفة المطلوبة: ${r.ar} (${r.en}).\nبنية الوصفة: ${r.beats}\n\n` +
    `حقائق المشروع (المصدر الوحيد للأرقام):\n${factsSheet}${learn}`;

  const tool = {
    name: 'emit_script',
    description: 'أخرج سكربت فيديو منظّم كمشاهد + خطّافات بديلة.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scenes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              visual: { type: 'string', description: 'وصف اللقطة/المشهد' },
              voiceover: { type: 'string', description: 'التعليق الصوتي بالعربية السعودية' },
              on_screen_text: { type: 'string', description: 'النص الظاهر على الشاشة (أرقام عربية هندية)' },
              start_sec: { type: 'number' },
              end_sec: { type: 'number' },
            },
            required: ['visual', 'voiceover', 'on_screen_text'],
          },
        },
        hooks: { type: 'array', items: { type: 'string' }, description: '٣ خطّافات بديلة' },
      },
      required: ['scenes', 'hooks'],
    },
  };

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: SCRIPT_MODEL,
    // Generous ceiling: a full 5-8 scene Arabic script + 3 hooks needs ~1.5-2k
    // output tokens, and 1500 truncated the tool JSON → 0 scenes. Generation
    // runs in the worker (background job), so latency doesn't gate this.
    max_tokens: 4000,
    system: systemPrompt(),
    tools: [tool],
    tool_choice: { type: 'tool', name: 'emit_script' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const out = (toolUse?.input ?? {}) as { scenes?: unknown; hooks?: unknown };

  const scenes: ScriptScene[] = Array.isArray(out.scenes)
    ? (out.scenes as Array<Record<string, unknown>>)
        .map((s) => ({
          visual: String(s.visual ?? '').trim(),
          voiceover: String(s.voiceover ?? '').trim(),
          on_screen_text: String(s.on_screen_text ?? '').trim(),
          start_sec: num(s.start_sec),
          end_sec: num(s.end_sec),
        }))
        .filter((s) => s.voiceover || s.visual)
    : [];
  const hooks: string[] = Array.isArray(out.hooks)
    ? (out.hooks as unknown[]).filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim())
    : [];
  if (scenes.length === 0) throw new Error('no scenes returned');
  return { scenes, hooks };
}
