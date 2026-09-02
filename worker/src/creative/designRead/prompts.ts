/**
 * Design-read prompts (worker path).
 *
 * The runner path reads the SAME instructions from the two skills
 * (.claude/skills/visual-design-read-{slide,post}/SKILL.md) — these prompts are
 * the callRole-shaped twin for the direct API lane. Keep the vocabulary and the
 * reading rules identical across all three surfaces (canonical:
 * docs/creative-director/design-read-vocab.md).
 */

import type { SlideRead } from '../contracts.js';

const COMMON_RULES = [
  'You are reading the DESIGN of Saudi real-estate marketing creatives (mostly Arabic).',
  'Describe layout, typography, palette, hierarchy and composition — NEVER the project facts (prices, offers, names are another lane\'s job).',
  'Use the enum values EXACTLY as written (snake_case, English) even though the creative is Arabic; free-text fields may be Arabic or English.',
  'Palette hexes are the observed dominant colours, upper-case #RRGGBB, at most 6.',
  'branding_intensity: 0 no brand · 1 logo only · 2 logo + brand colours/typography · 3 the brand IS the design.',
  'When torn between two enum values, pick the closer one and explain in notes.',
].join('\n');

export const SLIDE_READ_SYSTEM = [
  'You are a senior visual designer producing a structured design read of ONE marketing slide (a static image, possibly one carousel card).',
  COMMON_RULES,
  'Fill every field of the SlideRead schema. An unreadable image still gets a read: image.present=false, best-effort enums, and say so in notes.',
].join('\n\n');

export const POST_READ_SYSTEM = [
  'You are a senior visual designer producing a structured design read of a WHOLE marketing post — a single image or an entire carousel.',
  COMMON_RULES,
  'Judge the WHOLE: narrative arc, cover→CTA promise, slide relationships, template recurrence and visual continuity are only visible across slides.',
  'slide_count, role_sequence and content_density_profile MUST agree with the number of images provided, in the given order.',
  'Slide-level reads may be supplied as evidence — trust their enum fields, but look at the images yourself; the post read is your judgement of the whole, not an average of the parts.',
  'strengths = what a Wassel designer should copy; weaknesses = what to avoid; learnable = the distilled lesson (reusable structure, hierarchy trick, the trap to avoid).',
].join('\n\n');

export interface SlidePromptContext {
  org_name?: string | null;
  platform?: string | null;
  slide_index?: number | null;
  slide_count?: number | null;
}

/** User prompt for one slide read (the image rides along as req.images[0]). */
export function slideReadUserPrompt(ctx: SlidePromptContext = {}): string {
  const lines = ['Produce the SlideRead for the attached image.'];
  if (ctx.slide_index != null && ctx.slide_count != null) {
    lines.push(`Context: this is slide ${ctx.slide_index + 1} of ${ctx.slide_count} in its carousel.`);
  }
  if (ctx.platform) lines.push(`Platform: ${ctx.platform}.`);
  lines.push('Return ONLY the structured output.');
  return lines.join('\n');
}

export interface PostPromptSlide {
  media_id: string;
  carousel_index: number;
  slide_read?: SlideRead | null;
}

export interface PostPromptContext {
  org_name?: string | null;
  platform?: string | null;
  post_type?: string | null;
}

/** User prompt for one post read (all slide images ride along, in order). */
export function postReadUserPrompt(slides: PostPromptSlide[], ctx: PostPromptContext = {}): string {
  const lines = [
    `Produce the PostRead for the attached ${slides.length} image(s), given IN CAROUSEL ORDER (image 1 = cover).`,
  ];
  if (ctx.post_type) lines.push(`Post type: ${ctx.post_type}.`);
  if (ctx.platform) lines.push(`Platform: ${ctx.platform}.`);
  const withReads = slides.filter((s) => s.slide_read);
  if (withReads.length > 0) {
    lines.push('', 'Existing slide-level reads (evidence — verify against the images):');
    for (const s of withReads) {
      lines.push(`slide ${s.carousel_index + 1}: ${JSON.stringify(s.slide_read)}`);
    }
  }
  lines.push('', 'Return ONLY the structured output.');
  return lines.join('\n');
}
