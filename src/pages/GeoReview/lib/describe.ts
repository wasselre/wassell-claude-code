/**
 * Read-only, defensive describers for the review UI. They inspect the compiled
 * GeoPreference structure WITHOUT re-implementing the server's authoritative
 * GeoPreference→location_items mapping (that lives in api/geo-preference/review.ts
 * and is what actually gets applied). These only produce human labels for the
 * expression editor and geometry summary.
 */
import type { GeoClauseDTO, GeoPreferenceDTO } from './types';

interface LooseRecipe {
  operation?: string;
  source_anchors?: { span?: string; normalized_token?: string }[];
  resolved_element_ids?: string[];
}
interface LooseAnchorRef {
  recipe?: LooseRecipe;
}

const OP_LABEL_AR: Record<string, string> = {
  district_polygon: 'حي', district_union: 'أحياء', pin_containing_district: 'حي (من موقع)',
  zone_union: 'داخل منطقة', within_radius: 'ضمن نطاق', pin_point: 'حول نقطة',
  within_distance: 'ضمن مسافة', corridor: 'على محور', directional_band: 'جهة طريق',
};
const OP_LABEL_EN: Record<string, string> = {
  district_polygon: 'District', district_union: 'Districts', pin_containing_district: 'District (from pin)',
  zone_union: 'Inside zone', within_radius: 'Within radius', pin_point: 'Around pin',
  within_distance: 'Within distance', corridor: 'Along corridor', directional_band: 'Side of road',
};

export function anchorRefLabel(ref: unknown, isAr: boolean): string {
  const recipe = (ref as LooseAnchorRef | null)?.recipe;
  if (!recipe) return isAr ? 'غير محدد' : 'unresolved';
  const anchors = Array.isArray(recipe.source_anchors) ? recipe.source_anchors : [];
  const name = anchors[0]?.span || anchors[0]?.normalized_token
    || (Array.isArray(recipe.resolved_element_ids) ? recipe.resolved_element_ids[0] : '') || '';
  const op = recipe.operation ?? '';
  const opLabel = (isAr ? OP_LABEL_AR[op] : OP_LABEL_EN[op]) ?? op;
  return name ? `${name} — ${opLabel}` : opLabel;
}

export function describeClause(clause: GeoClauseDTO, isAr: boolean): { op: 'include' | 'exclude'; parts: string[] } {
  const anyOf = Array.isArray(clause.anyOf) ? clause.anyOf : [];
  return { op: clause.op, parts: anyOf.map((r) => anchorRefLabel(r, isAr)) };
}

/** Deep-clone a GeoPreference for safe local editing. */
export function cloneExpression(expr: GeoPreferenceDTO): GeoPreferenceDTO {
  return JSON.parse(JSON.stringify(expr)) as GeoPreferenceDTO;
}

/** True when the reviewer's working copy differs from the original. */
export function isEdited(original: GeoPreferenceDTO, working: GeoPreferenceDTO): boolean {
  return JSON.stringify(original) !== JSON.stringify(working);
}

/** Total clause count — a working copy with zero clauses can't be applied. */
export function clauseCount(expr: GeoPreferenceDTO): number {
  return (expr.groups ?? []).reduce((n, g) => n + (g.clauses?.length ?? 0), 0);
}
