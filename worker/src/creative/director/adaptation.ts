/**
 * Adaptation planner — the deterministic geometry behind every derivative.
 *
 * contracts §0 rule 7 + §10: dimensions come from PLACEMENT_SPECS per selected
 * target (never hardcoded, never model-invented), and every derivative carries
 * a FULL VisualAdaptation. The skeleton (`adaptationSkeleton`, A-FACTS
 * placementSpecs.ts) fixes the facts — aspect / px / safe zones /
 * requires_separate_design / image_change / slide mapping; the model only
 * authors the prose instructions. This module:
 *
 *   planAdaptations(base, targets, specs)  → one PlannedDerivative per selected target
 *   finalizeAdaptation(model, planned)     → complete VisualAdaptation: skeleton facts
 *                                            authoritative + prose filled with explicit
 *                                            "no change" wording when the model left it empty
 *
 * The slide mapping is deterministic too (carousel master → target frames);
 * the model's mapping is kept only when it covers every master slide.
 */
import type { BasePackage, DerivativeTarget, VisualAdaptation } from '../contracts.js';
import {
  adaptationSkeleton,
  type AdaptationSkeleton,
  type PlacementSpec,
} from '../placementSpecs.js';

/** One selected target + everything deterministic about its derivative. */
export interface PlannedDerivative {
  target: DerivativeTarget;
  /** null when the target has no PLACEMENT_SPECS entry (validator warns; we never guess). */
  spec: PlacementSpec | null;
  skeleton: AdaptationSkeleton | null;
  dimensions: { aspect: string; px: [number, number] } | null;
  /** The PLACEMENT_SPECS ceilings that apply — merged (authoritatively) into derivative.limits. */
  limits: Record<string, unknown>;
}

/** Stable target identity — same key shape as grounding.ts. */
export function targetKey(t: Pick<DerivativeTarget, 'target_kind' | 'platform' | 'placement_type'>): string {
  return `${t.target_kind}:${t.platform}:${t.placement_type}`;
}

/** The ceilings a spec imposes (only the keys the spec actually carries). */
export function specLimits(spec: PlacementSpec): Record<string, unknown> {
  const limits: Record<string, unknown> = {};
  if (spec.caption_max !== undefined) limits.caption_max = spec.caption_max;
  if (spec.hashtags_max !== undefined) limits.hashtags_max = spec.hashtags_max;
  if (spec.max_slides !== undefined) limits.max_slides = spec.max_slides;
  if (spec.formats !== undefined) limits.formats = spec.formats;
  if (spec.manual_publish) limits.manual_publish = true;
  return limits;
}

/**
 * Deterministic carousel → target frame mapping. Every master slide appears
 * exactly once; frames beyond the placement's capacity map to null (dropped,
 * with the note saying so). Single-frame placements keep the cover only.
 */
export function deterministicSlideMapping(
  slideCount: number,
  spec: PlacementSpec | null,
): VisualAdaptation['slide_mapping'] {
  if (slideCount === 0) return [];
  const capacity = spec?.max_slides ?? 1;
  const out: VisualAdaptation['slide_mapping'] = [];
  for (let i = 1; i <= slideCount; i++) {
    if (i <= capacity) {
      out.push({
        from_index: i,
        to_index: i,
        note: capacity > 1 ? 'شريحة مقابل إطار — نفس الترتيب' : 'الغلاف فقط — موضع بإطار واحد',
      });
    } else {
      out.push({
        from_index: i,
        to_index: null,
        note: `تُسقط — الحد الأقصى لهذا الموضع ${capacity} ${capacity > 1 ? 'إطارات' : 'إطار واحد'}`,
      });
    }
  }
  return out;
}

/**
 * Plan one derivative per selected target. `masterPlacementType` is 'carousel'
 * when the base is a carousel (adaptationSkeleton then seeds the slide-mapping
 * placeholder, which we replace here with the real deterministic mapping).
 */
export function planAdaptations(
  base: Pick<BasePackage, 'strategy' | 'slides'>,
  targets: DerivativeTarget[],
  specs: PlacementSpec[],
): PlannedDerivative[] {
  const masterAspect = base.strategy.master_aspect;
  const masterPlacementType = base.strategy.format === 'carousel' ? 'carousel' : undefined;
  return targets.map((target) => {
    const spec = specs.find(
      (s) => s.platform === target.platform && s.placement_type === target.placement_type,
    ) ?? null;
    if (!spec) return { target, spec: null, skeleton: null, dimensions: null, limits: {} };
    const skeleton = adaptationSkeleton(masterAspect, spec, masterPlacementType);
    if (base.strategy.format === 'carousel') {
      skeleton.slide_mapping = deterministicSlideMapping(base.slides.length, spec);
    }
    return {
      target,
      spec,
      skeleton,
      dimensions: { aspect: skeleton.aspect, px: skeleton.px },
      limits: specLimits(spec),
    };
  });
}

/** Explicit "nothing changes" wording — the contract forbids empty adaptation strings. */
function noChangeWording(field: string): string {
  switch (field) {
    case 'image_instructions':
      return 'لا تغيير — تُستخدم صورة التصميم الأساسي كما هي.';
    case 'text_reposition':
      return 'لا تغيير — مواضع النص كما في التصميم الأساسي.';
    case 'logo_reposition':
      return 'لا تغيير — موضع الشعار كما في التصميم الأساسي.';
    case 'layout_changes':
      return 'لا تغيير — التخطيط مطابق للتصميم الأساسي.';
    case 'element_scaling':
      return 'لا تغيير — تُحجَّم العناصر تناسبيًا مع الأبعاد الجديدة.';
    default:
      return 'لا تغيير.';
  }
}

/** Deterministic fallback instructions when geometry changes but the model left the prose empty. */
function geometryWording(field: string, skeleton: AdaptationSkeleton): string {
  const dims = `${skeleton.aspect} (${skeleton.px[0]}×${skeleton.px[1]})`;
  switch (field) {
    case 'image_instructions':
      if (skeleton.image_change === 'crop') {
        return `اقتصاص مركزي إلى ${dims} مع الحفاظ على مناطق الأمان وعناصر التصميم الأساسية.`;
      }
      if (skeleton.image_change === 'extend') {
        return `تمديد الخلفية إلى ${dims} دون المساس بعناصر التصميم أو النص أو الشعار.`;
      }
      return `استبدال الصورة بما يناسب ${dims} — راجع asset_substitutions.`;
    case 'text_reposition':
      return 'يُعاد توزيع النص وفق التخطيط الجديد ضمن مناطق الأمان — يلزم تصميم منفصل.';
    case 'logo_reposition':
      return 'يُعاد تموضع الشعار ضمن مناطق الأمان للموضع الجديد.';
    case 'layout_changes':
      return 'تخطيط منفصل لهذا الموضع (اختلاف عائلة الأبعاد) — يُعاد بناء التسلسل الهرمي وفق الاتجاه البصري.';
    case 'element_scaling':
      return `تُحجَّم العناصر تناسبيًا إلى ${dims}.`;
    default:
      return '';
  }
}

/**
 * Merge the model's adaptation prose with the planned skeleton. Skeleton facts
 * (aspect / px / safe_zones / requires_separate_design / image_change) are
 * authoritative — the model may NOT override geometry. Every prose string ends
 * non-empty: the model's wording when given, else explicit "no change" /
 * deterministic geometry wording. The model's slide mapping is kept only when
 * it covers every master slide of a carousel base; otherwise the deterministic
 * mapping stands. Asset substitutions pass through (the asset module already
 * guards ids).
 */
export function finalizeAdaptation(
  model: Partial<VisualAdaptation> | null | undefined,
  planned: PlannedDerivative,
  slideCount: number,
): VisualAdaptation {
  const m = model ?? {};
  if (!planned.skeleton || !planned.dimensions) {
    // No spec for this target — the model's fields stand as-is (validator warns),
    // but the prose strings are still guaranteed non-empty.
    return {
      aspect: m.aspect ?? '',
      px: m.px ?? [0, 0],
      safe_zones: m.safe_zones ?? {},
      requires_separate_design: m.requires_separate_design ?? true,
      image_change: m.image_change ?? 'none',
      image_instructions: m.image_instructions?.trim() || noChangeWording('image_instructions'),
      text_reposition: m.text_reposition?.trim() || noChangeWording('text_reposition'),
      logo_reposition: m.logo_reposition?.trim() || noChangeWording('logo_reposition'),
      layout_changes: m.layout_changes?.trim() || noChangeWording('layout_changes'),
      element_scaling: m.element_scaling?.trim() || noChangeWording('element_scaling'),
      slide_mapping: m.slide_mapping ?? [],
      asset_substitutions: m.asset_substitutions ?? [],
    };
  }
  const skeleton = planned.skeleton;
  const prose = (field: 'image_instructions' | 'text_reposition' | 'logo_reposition' | 'layout_changes' | 'element_scaling'): string => {
    const authored = m[field]?.trim();
    if (authored) return authored;
    const geometryChanged = skeleton.requires_separate_design || skeleton.image_change !== 'none';
    return geometryChanged ? geometryWording(field, skeleton) : noChangeWording(field);
  };

  const modelMapping = m.slide_mapping ?? [];
  const coversAllSlides = slideCount > 0
    && modelMapping.length >= slideCount
    && Array.from({ length: slideCount }, (_, i) => i + 1).every((idx) => modelMapping.some((e) => e.from_index === idx));

  return {
    aspect: skeleton.aspect,
    px: skeleton.px,
    safe_zones: skeleton.safe_zones,
    requires_separate_design: skeleton.requires_separate_design,
    image_change: skeleton.image_change,
    image_instructions: prose('image_instructions'),
    text_reposition: prose('text_reposition'),
    logo_reposition: prose('logo_reposition'),
    layout_changes: prose('layout_changes'),
    element_scaling: prose('element_scaling'),
    slide_mapping: slideCount > 0
      ? (coversAllSlides ? modelMapping : (skeleton.slide_mapping.length > 0 ? skeleton.slide_mapping : deterministicSlideMapping(slideCount, planned.spec)))
      : (m.slide_mapping ?? []),
    asset_substitutions: m.asset_substitutions ?? [],
  };
}
