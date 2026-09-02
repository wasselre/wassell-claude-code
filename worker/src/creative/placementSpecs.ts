// ============================================================================
// PLACEMENT SPECS — Post Creative Director (added 2026-09-02, contracts §10)
// ----------------------------------------------------------------------------
// WORKER COPY of the PLACEMENT SPECS block in src/lib/marketingOS/
// platformRules.ts (the worker is a standalone package and cannot import from
// src/). KEEP IDENTICAL to that block — change both together. The only
// differences are this header comment and the CAPTION_MAX twin below
// (platformRules.ts defines CAPTION_MAX earlier for its preflight rules).
// PlacementSpec / PlacementType are STRUCTURAL TWINS of
// worker/src/creative/contracts.ts.
// ============================================================================

/** Caption ceilings per platform — twin of CAPTION_MAX in platformRules.ts. */
export const CAPTION_MAX: Record<string, number> = {
  instagram: 2000,
  tiktok: 2200,
  snapchat: 160,
};

/** Placement type keys — MUST stay in sync with contracts.ts PlacementType. */
export type PlacementType =
  | 'feed' | 'carousel' | 'story' | 'reel_cover' | 'photo_mode' | 'post'
  | 'ad_feed' | 'ad_story' | 'ad_carousel' | 'ad_reels' | 'ad_display';

/** Structural twin of contracts.ts PlacementSpec. */
export interface PlacementSpec {
  platform: string;
  placement_type: PlacementType;
  target_kind: 'organic' | 'paid';
  aspects: string[];                       // first = preferred
  px: Record<string, [number, number]>;    // aspect → [w,h]
  safe_zones?: { top?: number; bottom?: number; left?: number; right?: number }; // px at the reference size
  max_slides?: number;
  formats?: string[];                      // 'jpg' | 'webp' | 'png' | 'mp4'
  caption_max?: number;
  hashtags_max?: number;
  manual_publish?: boolean;                // no automated publish (X, website, google display)
  notes?: string;
}

/** Hashtag ceilings per platform (Instagram's 30 is enforced in the publish preflight). */
export const HASHTAG_MAX: Record<string, number> = {
  instagram: 30,
};

/**
 * The deterministic geometry + ceilings for every derivative target. The model
 * never invents dimensions: it reads the spec for its target and the skeleton
 * from adaptationSkeleton(). caption_max / hashtags_max come from the same
 * constants the publish preflight enforces (CAPTION_MAX / HASHTAG_MAX).
 */
export const PLACEMENT_SPECS: PlacementSpec[] = [
  // ── organic ──────────────────────────────────────────────────────────
  {
    platform: 'instagram', placement_type: 'feed', target_kind: 'organic',
    aspects: ['4:5', '1:1'], px: { '4:5': [1080, 1350], '1:1': [1080, 1080] },
    formats: ['jpg', 'png', 'webp'],
    caption_max: CAPTION_MAX.instagram, hashtags_max: HASHTAG_MAX.instagram,
  },
  {
    platform: 'instagram', placement_type: 'carousel', target_kind: 'organic',
    aspects: ['4:5', '1:1'], px: { '4:5': [1080, 1350], '1:1': [1080, 1080] },
    formats: ['jpg', 'png', 'webp'], max_slides: 10,
    caption_max: CAPTION_MAX.instagram, hashtags_max: HASHTAG_MAX.instagram,
  },
  {
    platform: 'instagram', placement_type: 'story', target_kind: 'organic',
    aspects: ['9:16'], px: { '9:16': [1080, 1920] },
    safe_zones: { top: 250, bottom: 250 }, formats: ['jpg', 'png'],
    notes: 'Stories carry no caption field — copy lives on the design.',
  },
  {
    platform: 'tiktok', placement_type: 'photo_mode', target_kind: 'organic',
    aspects: ['9:16', '3:4'], px: { '9:16': [1080, 1920], '3:4': [1080, 1440] },
    formats: ['jpg', 'webp'], max_slides: 10,
    caption_max: CAPTION_MAX.tiktok,
    notes: 'Photo Mode accepts JPG/WebP only — PNG is rejected at publish.',
  },
  {
    platform: 'snapchat', placement_type: 'story', target_kind: 'organic',
    aspects: ['9:16'], px: { '9:16': [1080, 1920] },
    formats: ['jpg', 'png'], max_slides: 1,
    caption_max: CAPTION_MAX.snapchat,
  },
  {
    platform: 'x', placement_type: 'post', target_kind: 'organic',
    aspects: ['16:9', '1:1', '4:5'], px: { '16:9': [1600, 900], '1:1': [1080, 1080], '4:5': [1080, 1350] },
    formats: ['jpg', 'png', 'webp'], max_slides: 4,
    manual_publish: true,
  },
  {
    platform: 'website', placement_type: 'post', target_kind: 'organic',
    aspects: ['16:9'], px: { '16:9': [1600, 900] },
    formats: ['jpg', 'webp'], manual_publish: true,
  },
  // ── paid ─────────────────────────────────────────────────────────────
  {
    platform: 'meta', placement_type: 'ad_feed', target_kind: 'paid',
    aspects: ['1:1', '4:5'], px: { '1:1': [1080, 1080], '4:5': [1080, 1350] },
    formats: ['jpg', 'png'],
  },
  {
    platform: 'meta', placement_type: 'ad_story', target_kind: 'paid',
    aspects: ['9:16'], px: { '9:16': [1080, 1920] },
    safe_zones: { top: 250, bottom: 250 }, formats: ['jpg', 'png'],
  },
  {
    platform: 'meta', placement_type: 'ad_carousel', target_kind: 'paid',
    aspects: ['1:1'], px: { '1:1': [1080, 1080] },
    formats: ['jpg', 'png'], max_slides: 10,
  },
  {
    platform: 'meta', placement_type: 'ad_reels', target_kind: 'paid',
    aspects: ['9:16'], px: { '9:16': [1080, 1920] },
    safe_zones: { top: 250, bottom: 250 }, formats: ['mp4'],
  },
  {
    platform: 'google', placement_type: 'ad_display', target_kind: 'paid',
    aspects: ['1.91:1', '1:1'], px: { '1.91:1': [1200, 628], '1:1': [1080, 1080] },
    formats: ['jpg', 'png'], manual_publish: true,
  },
];

/** Look up the spec for one target. Undefined = the target has no spec (caller warns, never guesses). */
export function placementSpec(platform: string, type: PlacementType | string): PlacementSpec | undefined {
  return PLACEMENT_SPECS.find((s) => s.platform === platform && s.placement_type === type);
}

/**
 * Layout families. Same family (or a crop-compatible pair) = the master can be
 * adapted with a crop/extend; anything else = a separate design (re-layout).
 */
export type AspectFamily = 'square' | 'portrait' | 'vertical' | 'landscape' | 'wide' | 'other';

export function aspectFamily(aspect: string): AspectFamily {
  switch (aspect.trim()) {
    case '1:1': return 'square';
    case '4:5': case '3:4': case '2:3': return 'portrait';
    case '9:16': return 'vertical';
    case '16:9': case '4:3': return 'landscape';
    case '1.91:1': case '21:9': return 'wide';
    default: return 'other';
  }
}

/** Numeric w/h ratio of an aspect string ('4:5' → 0.8). */
function aspectRatio(aspect: string): number {
  const m = aspect.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return 1;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return h > 0 ? w / h : 1;
}

/** True when adapting between the two families is geometry-only (crop/extend), not a re-layout. */
function cropCompatible(a: AspectFamily, b: AspectFamily): boolean {
  if (a === b) return a !== 'other';
  const pair = new Set([a, b]);
  return (pair.has('square') && pair.has('portrait') && pair.size === 2)
      || (pair.has('landscape') && pair.has('wide') && pair.size === 2);
}

/** The slice of a DerivativeTarget the master-aspect chooser needs. */
export interface PlacementTargetRef {
  platform: string;
  placement_type: string;
}

/** Tie-break preference: the most reusable master canvases first. */
const MASTER_ASPECT_PREFERENCE = ['4:5', '1:1', '9:16', '16:9', '3:4', '1.91:1'];

/**
 * Pick the master aspect that serves the selected targets with the fewest
 * re-layouts: an aspect scores 2 per target that carries it natively and 1 per
 * target it can reach with a crop/extend (crop-compatible family). Ties break
 * by MASTER_ASPECT_PREFERENCE. Defaults to '4:5' when nothing is selected.
 */
export function masterAspectFor(targets: PlacementTargetRef[]): string {
  const specs = targets
    .map((t) => placementSpec(t.platform, t.placement_type))
    .filter((s): s is PlacementSpec => !!s);
  if (specs.length === 0) return '4:5';
  const candidates = new Set<string>();
  for (const s of specs) for (const a of s.aspects) candidates.add(a);
  const pref = (a: string | null): number => (a === null ? Number.MAX_SAFE_INTEGER : MASTER_ASPECT_PREFERENCE.indexOf(a));
  let best: string | null = null;
  let bestScore = -1;
  for (const cand of candidates) {
    const fam = aspectFamily(cand);
    let score = 0;
    for (const s of specs) {
      if (s.aspects.includes(cand)) score += 2;
      else if (s.aspects.some((a) => cropCompatible(fam, aspectFamily(a)))) score += 1;
    }
    if (score > bestScore || (score === bestScore && pref(cand) < pref(best))) {
      best = cand;
      bestScore = score;
    }
  }
  return best ?? '4:5';
}

/**
 * The deterministic slice of a VisualAdaptation (contracts.ts) — geometry the
 * model is NOT allowed to decide. The model fills the prose instructions; the
 * skeleton fixes the facts. Structural twin of the VisualAdaptation fields it
 * covers; the remaining fields are the model's to author.
 */
export interface AdaptationSkeleton {
  aspect: string;
  px: [number, number];
  safe_zones: { top?: number; bottom?: number; left?: number; right?: number };
  requires_separate_design: boolean;
  image_change: 'none' | 'crop' | 'extend' | 'replace';
  slide_mapping: Array<{ from_index: number; to_index: number | null; note: string }>;
}

/**
 * Deterministic adaptation geometry from `masterAspect` to a target spec:
 *   same aspect            → no change
 *   crop-compatible family → crop (target wider) or extend (target taller), no re-layout
 *   different family       → requires_separate_design (4:5→9:16 = separate + extend)
 * `masterPlacementType` ('carousel' → non-carousel) adds a slide_mapping
 * placeholder the model must replace with the real per-slide mapping.
 */
export function adaptationSkeleton(
  masterAspect: string,
  spec: PlacementSpec,
  masterPlacementType?: string,
): AdaptationSkeleton {
  const aspect = spec.aspects[0] ?? masterAspect;
  const px = spec.px[aspect] ?? [1080, 1080];
  const safe_zones = spec.safe_zones ?? {};
  // A slide-remap placeholder is only needed when a multi-slide master (carousel)
  // targets a placement that CANNOT itself carry multiple slides. Feed, ad_carousel
  // and TikTok photo_mode all hold a slide set, so the slides carry over 1:1.
  const MULTI_SLIDE_TARGETS = new Set(['carousel', 'ad_carousel', 'feed', 'photo_mode']);
  const fromCarousel = masterPlacementType === 'carousel' && !MULTI_SLIDE_TARGETS.has(spec.placement_type);
  const slide_mapping: AdaptationSkeleton['slide_mapping'] = fromCarousel
    ? [{ from_index: 0, to_index: null, note: 'PLACEHOLDER — map every master carousel slide to a frame of this placement (or null to drop it)' }]
    : [];

  if (aspect === masterAspect) {
    return { aspect, px, safe_zones, requires_separate_design: fromCarousel, image_change: 'none', slide_mapping };
  }
  const compatible = cropCompatible(aspectFamily(masterAspect), aspectFamily(aspect));
  // Taller target (smaller w/h ratio) needs more canvas → extend; wider target → crop.
  const image_change: AdaptationSkeleton['image_change'] =
    aspectRatio(aspect) < aspectRatio(masterAspect) ? 'extend' : 'crop';
  return {
    aspect,
    px,
    safe_zones,
    requires_separate_design: !compatible || fromCarousel,
    image_change,
    slide_mapping,
  };
}
