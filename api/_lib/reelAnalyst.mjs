/**
 * reelAnalyst — clean + analyze one Saudi real-estate marketing reel transcript.
 *
 * ONE forced-tool Anthropic call (same pattern as api/_lib/migrateAgent.ts)
 * that does BOTH jobs in a single pass, grounded in the same cleaned text:
 *   Phase 1 — CLEAN  : reconstruct the most-likely original Arabic from a noisy
 *                      auto-transcript. Correction, NOT rewriting.
 *   Phase 2 — ANALYZE: extract hook / hook_type / angle / psych_trigger /
 *                      structure / tone / cta / cta_type from the cleaned text.
 *
 * Written as plain ESM (.mjs) on purpose: it is the single source of truth for
 * the cleaning prompt, shared verbatim by BOTH
 *   - api/analyze-reel.ts          (the in-app "Clean & Analyze" button), and
 *   - scripts/backfill-reel-analysis.mjs  (the bulk run, plain `node`).
 * The repo has no tsx/ts-node, so a .mjs script can't import a .ts engine —
 * keeping the engine here lets both consumers share it with zero drift.
 *
 * The only dependency is @anthropic-ai/sdk (a top-level package dependency).
 * Per CLAUDE.md "Silent Failures": every failure throws loudly — callers
 * record `processing_status='error'` + the reason; nothing is swallowed.
 */

import Anthropic from '@anthropic-ai/sdk';

// Pinned to the IDs proven available in this project (decks + aiAgent + migrate
// all use opus-4-7 / sonnet-4-6). Bump in one place when the account gains a
// newer tier. Opus does the Arabic reconstruction + nuanced marketing read; the
// calls are short (~600 chars in) so it stays cheap.
export const REEL_ANALYST_MODEL = 'claude-opus-4-7';
export const REEL_ANALYST_FALLBACK_MODEL = 'claude-sonnet-4-6';

// Allowed categorical slugs — MUST match the dropdown/multiselect options added
// to the `competitors` model in
// supabase/migrations/2026-06-09_competitor_reel_analysis_fields.sql.
export const HOOK_TYPES = ['question', 'curiosity', 'shock', 'lifestyle', 'investment', 'problem', 'statement'];
export const ANGLES = ['location', 'luxury', 'privacy', 'family', 'investment_return', 'exclusivity', 'space', 'design', 'value', 'amenities'];
export const PSYCH_TRIGGERS = ['status', 'fomo', 'security', 'comfort', 'achievement', 'pride', 'convenience', 'wealth', 'belonging', 'aspiration'];
export const TONES = ['luxury', 'premium', 'urgent', 'friendly', 'expert', 'educational', 'aspirational', 'warm'];
export const CTA_TYPES = ['book_visit', 'contact', 'reserve', 'message', 'whatsapp', 'visit_location', 'learn_more', 'none'];

/** Shortest input we'll attempt. Anything below this is noise — callers should
 * mark it `skipped`, not feed it to the model. */
export const MIN_TRANSCRIPT_CHARS = 20;

const ANALYSIS_TOOL = {
  name: 'emit_reel_analysis',
  description:
    'Return the cleaned transcript and the structured marketing analysis of one ' +
    'Saudi real-estate marketing reel. Always call this tool — never reply in prose.',
  input_schema: {
    type: 'object',
    properties: {
      clean_content: {
        type: 'string',
        description:
          'The CORRECTED transcript in Arabic — the most likely original wording, with ASR errors fixed. ' +
          'Same spoken content, same tone, same Saudi dialect, same stylistic repetition. NOT rewritten, NOT summarized, NOT improved.',
      },
      hook: {
        type: 'string',
        description: 'The exact opening line(s) that stop the scroll, VERBATIM from clean_content (Arabic). Empty string if none.',
      },
      hook_type: {
        type: 'string',
        enum: HOOK_TYPES,
        description: 'The mechanism of the hook. Pick the single closest.',
      },
      angle: {
        type: 'array',
        items: { type: 'string', enum: ANGLES },
        description: 'What the reel is actually selling. 1–3 strongest; multiple allowed.',
      },
      psych_trigger: {
        type: 'array',
        items: { type: 'string', enum: PSYCH_TRIGGERS },
        description: 'The emotion/desire being activated. 1–3 strongest.',
      },
      structure: {
        type: 'string',
        description:
          'The logical beat breakdown as a short arrow chain in Arabic, e.g. "خطّاف ← مشكلة ← حل ← مزايا ← دعوة" ' +
          'or "خطّاف ← رؤية نمط الحياة ← مزايا المشروع ← دعوة". Capture the repeatable pattern, not a summary.',
      },
      tone: {
        type: 'array',
        items: { type: 'string', enum: TONES },
        description: 'The tone(s) of the script. 1–3 strongest.',
      },
      cta: {
        type: 'string',
        description: 'The exact call-to-action phrase, VERBATIM from clean_content (Arabic). Empty string if none.',
      },
      cta_type: {
        type: 'string',
        enum: CTA_TYPES,
        description: "The category of the CTA. Use 'none' if the reel has no call to action.",
      },
      analysis_notes: {
        type: 'string',
        description:
          'Brief notes (Arabic or English): flag any word/number you had to guess during cleaning and could not confidently ' +
          'reconstruct, plus any caveat about the analysis. Keep it short. Empty string if nothing noteworthy.',
      },
      confidence: {
        type: 'number',
        description: 'Your confidence (0.0–1.0) in the fidelity of the CLEANING reconstruction (not the analysis).',
      },
    },
    required: ['clean_content', 'hook', 'hook_type', 'angle', 'psych_trigger', 'structure', 'tone', 'cta', 'cta_type', 'confidence'],
  },
};

const SYSTEM_PROMPT = `أنت متخصص في تصحيح النصوص وتحليل التسويق العقاري السعودي لشركة وصل العقارية (Wassel).

تتلقى نصاً مُفرّغاً آلياً (ASR) من ريل/فيديو تسويقي عقاري سعودي. النص فيه أخطاء تفريغ: كلمات خاطئة أو مسموعة بشكل غلط، كلمات ملتصقة، كلمات قصيرة ساقطة، وجُمل مكسورة. مهمتك مرحلتان، وتُعيد النتيجة دائماً عبر استدعاء الأداة \`emit_reel_analysis\` فقط — لا تكتب نثراً.

═══════════════════════════════════
المرحلة ١ — التصحيح (تصحيح تفريغ، وليس إعادة كتابة)
═══════════════════════════════════
الهدف: إعادة بناء ما قيل على الأرجح في الفيديو الأصلي. صحّح أخطاء التفريغ مستعيناً بمعرفتك بالعقار وباللهجة السعودية:
- أسماء الأحياء والمناطق (مثال: "حيا العار" ← "حي العارض"؛ "الصحافه" ← "الصحافة"؛ "الرياضة" ← "الرياض").
- مصطلحات العقار (مثال: "دورة ميناء" ← "دورة مياه"؛ "الصارة/طالة" ← "الصالة"؛ "مجلس"، "ملحق"، "روف"، "درج"، "قبو"، "لاندسكيب").
- الأرقام والأسعار والمساحات حين يكون السياق واضحاً.

يجب أن تحافظ على:
- المعنى الأصلي، والكلمات الأصلية، والنبرة، والأسلوب البيعي.
- اللهجة السعودية العامية كما هي.
- التكرار الأسلوبي المتعمَّد (مثل "ما شاء الله تبارك الرحمن") — لا تحذفه، فهو جزء من أسلوب المتحدث.

ممنوع تماماً:
- لا تُعد الصياغة، ولا تُحسّن، ولا تُلخّص، ولا تختصر، ولا تترجم.
- لا تضف معلومات أو أرقاماً أو مزايا لم تُذكر.
- لا تضف لمسات تسويقية من عندك.

قواعد إضافية:
- أضف فقط علامات ترقيم خفيفة وفواصل جُمل لتسهيل القراءة. يبقى النص منطوقاً كما هو، لكنه مُصحَّح.
- إذا تعذّر فهم مقطع تماماً، أبقِ أقرب إعادة بناء ممكنة، وضع "[غير واضح]" بحذر شديد، وأشِر إلى ذلك في analysis_notes. لا تختلق.

═══════════════════════════════════
المرحلة ٢ — التحليل (من النص المُصحَّح clean_content)
═══════════════════════════════════
حلّل النص المُصحَّح واستخرج أنماط التفكير التسويقي:
- hook: الجملة/الجمل الافتتاحية التي توقف التمرير — حرفياً من clean_content.
- hook_type: آلية الخطّاف (أقرب تصنيف واحد).
- angle: ما الذي يبيعه الريل فعلاً (الأقوى ١–٣، يجوز التعدد).
- psych_trigger: العاطفة/الرغبة المُفعَّلة (الأقوى ١–٣).
- structure: تسلسل المشاهد كسلسلة أسهم مختصرة بالعربية تُبرز النمط القابل للتكرار.
- tone: نبرة النص (الأقوى ١–٣).
- cta: الدعوة لاتخاذ إجراء حرفياً من clean_content (سلسلة فارغة إن لم توجد).
- cta_type: تصنيف الدعوة ('none' إن لم توجد دعوة).
- analysis_notes: ملاحظات موجزة — أشِر لأي كلمة/رقم اضطررت لتخمينه أثناء التصحيح.
- confidence: ثقتك (0.0–1.0) في دقّة إعادة بناء التصحيح.

صنّف فقط ضمن القيم المتاحة في الأداة. عند الشك اختر الأقرب.`;

/** @typedef {Object} ReelAnalysis
 * @property {string} clean_content
 * @property {string} hook
 * @property {string} hook_type
 * @property {string[]} angle
 * @property {string[]} psych_trigger
 * @property {string} structure
 * @property {string[]} tone
 * @property {string} cta
 * @property {string} cta_type
 * @property {string} analysis_notes
 * @property {number} confidence
 * @property {string} model  // which model produced it (for auditing)
 */

const asString = (v) => (typeof v === 'string' ? v : '');
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const subsetOf = (v, allowed) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => allowed.includes(x)))] : [];

/**
 * Clean + analyze one reel transcript.
 *
 * @param {string} apiKey  ANTHROPIC_API_KEY
 * @param {string} rawTranscript  the raw `content` field of a competitors reel
 * @returns {Promise<ReelAnalysis>}
 * @throws if the input is too short, the API errors on both models, or the
 *         model returns no usable cleaned transcript.
 */
export async function cleanAndAnalyzeReel(apiKey, rawTranscript) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const raw = typeof rawTranscript === 'string' ? rawTranscript.trim() : '';
  if (raw.length < MIN_TRANSCRIPT_CHARS) {
    throw new Error(`Transcript too short to analyze (${raw.length} chars < ${MIN_TRANSCRIPT_CHARS})`);
  }

  const client = new Anthropic({ apiKey });
  const call = (model) =>
    client.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [ANALYSIS_TOOL],
      tool_choice: { type: 'tool', name: 'emit_reel_analysis' },
      messages: [
        {
          role: 'user',
          content:
            'صحّح النص المُفرّغ التالي ثم حلّله، واستدعِ الأداة emit_reel_analysis:\n\n' +
            '<<<RAW_TRANSCRIPT>>>\n' +
            raw +
            '\n<<<END>>>',
        },
      ],
    });

  let response;
  let usedModel = REEL_ANALYST_MODEL;
  try {
    response = await call(REEL_ANALYST_MODEL);
  } catch (primaryErr) {
    // Surface, then try the fallback tier once. If THAT fails too, throw the
    // fallback error up — the caller records it (never silently swallowed).
    usedModel = REEL_ANALYST_FALLBACK_MODEL;
    response = await call(REEL_ANALYST_FALLBACK_MODEL);
  }

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error('Model did not return a reel analysis (no tool_use block)');
  }
  const out = /** @type {Record<string, unknown>} */ (toolBlock.input);

  const clean_content = asString(out.clean_content).trim();
  if (!clean_content) {
    throw new Error('Model returned an empty clean_content');
  }

  const confidenceNum = Number(out.confidence);
  const confidence = Number.isFinite(confidenceNum) ? Math.min(1, Math.max(0, confidenceNum)) : 0;

  return {
    clean_content,
    hook: asString(out.hook).trim(),
    hook_type: oneOf(out.hook_type, HOOK_TYPES, ''),
    angle: subsetOf(out.angle, ANGLES),
    psych_trigger: subsetOf(out.psych_trigger, PSYCH_TRIGGERS),
    structure: asString(out.structure).trim(),
    tone: subsetOf(out.tone, TONES),
    cta: asString(out.cta).trim(),
    cta_type: oneOf(out.cta_type, CTA_TYPES, 'none'),
    analysis_notes: asString(out.analysis_notes).trim(),
    confidence,
    model: usedModel,
  };
}
