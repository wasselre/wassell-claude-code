// ============================================================================
// Controlled vocabulary for cv tags (contracts §6).
//
// KEEP IDENTICAL to infra/modal/video-cv/labels.py — Modal's zero-shot labels
// and the worker's LLM tags must speak the same language or the search filter
// `tags @> …` silently matches nothing. A tag is `<group>:<value>`.
// ============================================================================

export const CV_VOCAB = {
  shot_size: ['wide', 'medium', 'close', 'extreme_close', 'aerial'],
  setting: ['exterior_facade', 'interior_living', 'kitchen', 'bedroom', 'bathroom', 'amenity_pool', 'gym', 'lobby', 'street', 'map', 'studio', 'render', 'office'],
  subject: ['building', 'unit', 'person', 'presenter', 'family', 'vehicle', 'text_card', 'logo', 'map', 'plan'],
  graphic: ['none', 'text_overlay', 'animated_map', '3d_render', 'motion_graphic', 'split_screen', 'slideshow'],
  motion: ['static', 'pan', 'tilt', 'dolly', 'drone', 'handheld', 'zoom'],
  light: ['day', 'golden', 'night', 'studio'],
  purpose: ['hook', 'location', 'product', 'feature', 'proof', 'offer', 'cta', 'brand'],
  reproducibility: ['easy', 'moderate', 'hard'],
} as const;

export type VocabGroup = keyof typeof CV_VOCAB;
export const VOCAB_GROUPS = Object.keys(CV_VOCAB) as VocabGroup[];

/** Every legal tag, e.g. `shot_size:wide`. */
export const ALL_TAGS: readonly string[] = VOCAB_GROUPS.flatMap((g) => CV_VOCAB[g].map((v) => `${g}:${v}`));
const TAG_SET = new Set(ALL_TAGS);

/** Flat list of every legal tag string, for prompts. */
export function vocabForPrompt(): string {
  return VOCAB_GROUPS.map((g) => `${g}: ${CV_VOCAB[g].join(', ')}`).join('\n');
}

/** Normalise a model-emitted tag to the canonical `group:value` form. */
function normaliseTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s*:\s*/, ':').replace(/\s+/g, '_').replace(/[‐-―−]/g, '-');
}

export interface TagValidation { valid: string[]; rejected: string[] }

/**
 * Keep only tags that exist in the vocabulary (deduped, order preserved).
 * Rejections are returned, not thrown — a model inventing `setting:garden` is
 * expected noise, and the caller records it in the analysis for diagnosis.
 */
export function validateTags(tags: readonly unknown[] | null | undefined): TagValidation {
  const valid: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    if (typeof t !== 'string' || t.trim() === '') continue;
    const n = normaliseTag(t);
    if (!TAG_SET.has(n)) { rejected.push(t); continue; }
    if (seen.has(n)) continue;
    seen.add(n);
    valid.push(n);
  }
  return { valid, rejected };
}

/** Is `value` a legal member of `group`? */
export function isVocabValue(group: VocabGroup, value: unknown): boolean {
  return typeof value === 'string' && (CV_VOCAB[group] as readonly string[]).includes(value);
}

/** First tag value of a group, e.g. tagValue(tags,'purpose') → 'hook' | null. */
export function tagValue(tags: readonly string[], group: VocabGroup): string | null {
  const prefix = `${group}:`;
  const hit = tags.find((t) => t.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
