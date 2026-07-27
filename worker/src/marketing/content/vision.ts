// ============================================================================
// Visual-text extraction (Phase 6). Reads visible Arabic + English text and the
// real-estate promotional fields off images / video frames / thumbnails / ad
// creatives using Claude vision with a FORCED structured-output tool (enum-free,
// but strictly typed) — the same forced-tool posture as reelAnalyst.mjs.
//
// One Claude call per post carries up to MAX_IMAGES images and returns an array
// indexed to the inputs, so a carousel or a video's sampled frames cost one
// request, not N. Arabic OCR quality: Claude reads Arabic marketing typography
// (title cards, price overlays) well; sonnet is the cost/quality sweet spot.
// ============================================================================
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.MKT_VISION_MODEL ?? 'claude-sonnet-4-6';
const MAX_IMAGES = 8;

export interface VisualFields {
  visible_text: string;
  project_names: string[];
  developer_names: string[];
  prices: string[];
  payment_plans: string[];
  unit_types: string[];
  districts: string[];
  locations: string[];
  phones: string[];
  urls: string[];
  offers: string[];
  amenities: string[];
  selling_points: string[];
  dates: string[];
  ctas: string[];
}
export interface VisualResult { index: number; fields: VisualFields }

const EMPTY: VisualFields = { visible_text: '', project_names: [], developer_names: [], prices: [], payment_plans: [], unit_types: [], districts: [], locations: [], phones: [], urls: [], offers: [], amenities: [], selling_points: [], dates: [], ctas: [] };

const TOOL: Anthropic.Tool = {
  name: 'record_visual_text',
  description: 'Record the visible text and real-estate promotional fields read from each image, in input order.',
  input_schema: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        description: 'One entry per input image, in the same order they were provided.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'Zero-based index of the image.' },
            visible_text: { type: 'string', description: 'All legible text in the image, Arabic and English, preserving the original language. Empty string if none.' },
            project_names: { type: 'array', items: { type: 'string' } },
            developer_names: { type: 'array', items: { type: 'string' } },
            prices: { type: 'array', items: { type: 'string' }, description: 'e.g. "يبدأ من 850,000 ريال"' },
            payment_plans: { type: 'array', items: { type: 'string' }, description: 'e.g. "دفعة أولى 10%"' },
            unit_types: { type: 'array', items: { type: 'string' }, description: 'e.g. "شقق", "فلل", "3 غرف"' },
            districts: { type: 'array', items: { type: 'string' } },
            locations: { type: 'array', items: { type: 'string' } },
            phones: { type: 'array', items: { type: 'string' } },
            urls: { type: 'array', items: { type: 'string' } },
            // `offers` previously had NO description, and there was nowhere to put
            // a feature or a slogan — so every promotional line on a creative
            // landed here. Measured: 288 of 301 extracted "offers" were not
            // offers (108 were the sponsorship badge "Diamond Sponsor / راعي
            // ماسي"). A tight definition plus the two buckets below fixes the
            // cause rather than filtering the symptom downstream.
            offers: {
              type: 'array', items: { type: 'string' },
              description: 'COMMERCIAL INCENTIVES ONLY — a concrete benefit the buyer receives: '
                + 'a discount, an installment/payment plan, cashback, a waived or free item, '
                + 'a gift, or a time-limited deal. e.g. "خصم 10%", "تقسيط حتى 60 شهر", '
                + '"إعفاء من رسوم التسجيل". A line is NOT an offer if it is a slogan '
                + '("تملك الفخامة", "Own The Luxury"), a sponsorship badge ("راعي ماسي", '
                + '"Diamond Sponsor"), a teaser ("انتظرونا", "Stay Tuned", "SOON"), or a '
                + 'feature ("تحكم ذكي", "مساحات رحبة") — those go in selling_points or '
                + 'amenities. If nothing qualifies, return an empty array.',
            },
            amenities: {
              type: 'array', items: { type: 'string' },
              description: 'Physical features or facilities of the property/community, '
                + 'e.g. "تحكم ذكي / Smart Control", "مساحات رحبة", "مسبح", "نادي صحي", '
                + '"مجتمع متكامل".',
            },
            selling_points: {
              type: 'array', items: { type: 'string' },
              description: 'Brand slogans, taglines and value claims that are not a '
                + 'concrete commercial benefit, e.g. "تملك الفخامة / Own The Luxury", '
                + '"عزنا بطبعنا", "حياة برفاه", "مواقع حيوية / Prime Locations". '
                + 'Sponsorship badges and teasers belong here too, not in offers.',
            },
            dates: { type: 'array', items: { type: 'string' } },
            ctas: { type: 'array', items: { type: 'string' }, description: 'calls to action e.g. "احجز الآن"' },
          },
          required: ['index', 'visible_text'],
        },
      },
    },
    required: ['images'],
  },
};

function mediaType(mime: string | null): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  if (mime?.includes('png')) return 'image/png';
  if (mime?.includes('webp')) return 'image/webp';
  if (mime?.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}

/** Extract visual text + fields for up to MAX_IMAGES images in one call. Returns per-index results + cost. */
export async function extractVisualText(images: Array<{ buffer: Buffer; mime: string | null }>): Promise<{ results: VisualResult[]; costUsd: number }> {
  if (images.length === 0) return { results: [], costUsd: 0 };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'stub') {
    return { results: images.slice(0, MAX_IMAGES).map((_, i) => ({ index: i, fields: { ...EMPTY, visible_text: 'وصل ريفييرا' } })), costUsd: 0 };
  }
  const client = new Anthropic({ apiKey });
  const use = images.slice(0, MAX_IMAGES);
  const content: Anthropic.ContentBlockParam[] = [];
  use.forEach((im, i) => {
    content.push({ type: 'text', text: `Image ${i}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType(im.mime), data: im.buffer.toString('base64') } });
  });
  content.push({ type: 'text', text: 'For EACH image above, in order, read all visible Arabic and English text and extract the real-estate promotional fields. '
    + 'Call record_visual_text with one array entry per image. If an image has no legible text, return an empty visible_text for it. '
    + 'Do not invent values not visible in the image. '
    + 'Be strict about `offers`: it is for COMMERCIAL INCENTIVES only (a discount, an installment plan, cashback, something free or waived, a time-limited deal). '
    + 'Slogans, sponsorship badges, teasers and product features are NOT offers — put them in selling_points or amenities. '
    + 'Most creatives contain NO offer at all; an empty offers array is the normal and correct answer.' });

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4096,
    tools: [TOOL], tool_choice: { type: 'tool', name: 'record_visual_text' },
    messages: [{ role: 'user', content }],
  });
  const block = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const raw = (block?.input ?? {}) as { images?: Array<Partial<VisualFields> & { index?: number }> };
  const results: VisualResult[] = (raw.images ?? []).map((e, i) => ({
    index: typeof e.index === 'number' ? e.index : i,
    fields: { ...EMPTY, ...e, visible_text: e.visible_text ?? '' },
  }));
  const inTok = msg.usage.input_tokens, outTok = msg.usage.output_tokens;
  const costUsd = Math.round((inTok * 3e-6 + outTok * 1.5e-5) * 10000) / 10000; // sonnet approx $3/$15 per Mtok
  return { results, costUsd };
}

export { MAX_IMAGES };
