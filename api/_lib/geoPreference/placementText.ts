/**
 * "What did the AI put on the map for this mention?" — in Arabic words.
 *
 * ONE implementation shared by the grader endpoint (`api/geo-preference/simple-grade.ts`,
 * which ships the raw {@link Placement}s to the browser) and the VERIFIER
 * (`verifier.ts`, which needs each placement as a sentence it can check against
 * the conversation). The sentence mirrors `placementLine` in
 * `src/pages/GeoGrade/lib/placementLine.ts` so the verifier reads
 * the map the same way the human grader sees it.
 *
 * PURE: no IO. The caller looks up district / road / landmark names (see
 * {@link placementElementIds}) and hands them in.
 */
import type { Evidence, GeoPreference } from './ontology.js';

/** Per-mention placement from a compiled expression: `geo:<evidence id>` refs → recipe. */
export interface Placement {
  polarity: 'include' | 'exclude';
  operation: string;
  element_ids: string[];
  resolved: boolean;
  label: string;
  side?: string | null;
  clip_parts?: Array<{ name: string; kept: boolean; crossed: boolean; kept_km2: number | null; total_km2: number | null }> | null;
  /** within_radius / within_distance / corridor / directional_band: the band or radius in metres. */
  radius_m?: number;
  /** district_side_clip: what the computed clip holds ({@link sideClipState}). */
  clip_state?: SideClipState;
}

export const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ────────────────────────────────────────────────────────────────────────────
// district_side_clip shapes — ONE reading shared by the save (review.ts) and
// the card / verifier text, so "nothing on this side" can never be saved as the
// whole district while the card says otherwise.
// ────────────────────────────────────────────────────────────────────────────

type Ring = [number, number][];

/** The clip's polygons as CLOSED outer rings in GeoJSON [lng, lat] order (empty when it holds none). */
export function sideClipRings(clip: { type?: string; coordinates?: unknown } | null | undefined): Ring[] {
  if (!clip || !Array.isArray(clip.coordinates)) return [];
  const polys = clip.type === 'Polygon' ? [clip.coordinates] : (clip.coordinates as unknown[]);
  const out: Ring[] = [];
  for (const poly of polys) {
    const ring = Array.isArray(poly) ? (poly[0] as unknown) : null;
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const closed: Ring = ring.map((pt) => [Number((pt as number[])[0]), Number((pt as number[])[1])] as [number, number]);
    if (closed.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) continue;
    const [fx, fy] = closed[0]!;
    const [lx, ly] = closed[closed.length - 1]!;
    if (fx !== lx || fy !== ly) closed.push([fx, fy]);
    out.push(closed);
  }
  return out;
}

/**
 * What a district_side_clip's computed shape holds:
 *  - 'ok'      — at least one piece of the districts lies on that side;
 *  - 'empty'   — computed, and NOTHING lies on that side (every part dropped, or
 *                no polygon) → nothing may be saved for it;
 *  - 'missing' — no shape was ever stored (a legacy row; hydrateClipGeometry
 *                always writes the shape AND the parts, or throws) → nothing
 *                may be saved either: the old "districts + side rule" fallback
 *                was an OR-union, i.e. the WHOLE district.
 */
export type SideClipState = 'ok' | 'empty' | 'missing';

export function sideClipState(r: {
  clip_geojson?: { type?: string; coordinates?: unknown } | null;
  clip_parts?: ReadonlyArray<{ kept?: boolean }> | null;
}): SideClipState {
  const parts = Array.isArray(r.clip_parts) ? r.clip_parts : null;
  if (parts && parts.length > 0 && !parts.some((p) => p.kept === true)) return 'empty';
  if (!r.clip_geojson) return 'missing';
  return sideClipRings(r.clip_geojson).length > 0 ? 'ok' : 'empty';
}

// ────────────────────────────────────────────────────────────────────────────
// Sides and distances in words.
// ────────────────────────────────────────────────────────────────────────────

const SIDE_WORD = /^\s*(?:ال)?(شمال|جنوب|شرق|غرب)(?=\s|$)/;
const SIDE_WORD_EN = /^\s*(north|south|east|west)(?![a-z])/i;
const SIDE_OF: Record<string, 'north' | 'south' | 'east' | 'west'> = { 'شمال': 'north', 'جنوب': 'south', 'شرق': 'east', 'غرب': 'west' };

/**
 * The side a text's LEADING direction word names («جنوب الدائري الشمالي» →
 * south), else null. Only the first word counts — a direction word inside the
 * road's own name («الدائري الشمالي») never does — and a diagonal («شمال شرق …»,
 * «الشمال الشرقي …») has no road side.
 */
export function leadingSide(text: string | null | undefined): 'north' | 'south' | 'east' | 'west' | null {
  const t = String(text ?? '').replace(/_/g, ' ').replace(/ـ/g, '');
  const m = SIDE_WORD.exec(t);
  if (m) {
    const after = t.slice(m[0].length);
    if (/^\s+(?:ال)?(شمال|جنوب|شرق|غرب)(?=\s|$)/.test(after)) return null; // diagonal
    if (/^\s+ال(شمالي|جنوبي|شرقي|غربي)(?=\s|$)/.test(after)) return null; // «الشمال الشرقي»
    return SIDE_OF[m[1]!] ?? null;
  }
  const e = SIDE_WORD_EN.exec(t);
  if (e) {
    if (/^\s*-?\s*(east|west)(?![a-z])/i.test(t.slice(e[0].length)) && /^(north|south)$/i.test(e[1]!)) return null;
    return e[1]!.toLowerCase() as 'north' | 'south' | 'east' | 'west';
  }
  return null;
}

type BandAnchor = { anchor_type?: string; span?: string; normalized_token?: string };
const SIDE_OF_EN = new Set(['north', 'south', 'east', 'west']);

/**
 * The side of the road a directional_band lies on — ONE reading shared by the
 * save (review.ts), the card and the verifier, so what the rep reads is what is
 * saved:
 *  - the recipe's `side` (the resolver records it from the parsed direction
 *    word; since 2026-10-03 it resolves a band ONLY with a cardinal side — a
 *    diagonal or «وسط» road side asks instead);
 *  - a band stored before that has none: the LEADING direction word of the text
 *    the resolver parsed (the direction anchor's normalized token, else its
 *    span — never the other one as a second try, and never a word inside the
 *    road's own name: «جنوب الدائري الشمالي» is south);
 *  - otherwise (a diagonal, no direction word) → null: the band has no side,
 *    and NOTHING is saved for it (it used to fall back to a 5 km strip on both
 *    sides of the whole road).
 */
export function bandSide(r: {
  side?: string | null;
  source_anchors?: ReadonlyArray<BandAnchor> | null;
}): 'north' | 'south' | 'east' | 'west' | null {
  if (r.side && SIDE_OF_EN.has(r.side)) return r.side as 'north' | 'south' | 'east' | 'west';
  const anchors = Array.isArray(r.source_anchors) ? r.source_anchors : [];
  const d = anchors.find((a) => a.anchor_type === 'direction') ?? anchors[0];
  if (!d) return null;
  return leadingSide((d.normalized_token || d.span || '').trim());
}

/** Metres → km for display: one decimal under 10 km («2.5»), whole km from 10 up («12»). */
export function kmText(m: number): string {
  const v = m / 1000;
  if (v >= 10) return String(Math.round(v));
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * Every mention's placement, keyed by evidence id. A mention with two refs keeps
 * the last (unchanged behaviour). A sub-ref of a mention (`geo:<id>:<part>`,
 * only in proposals stored before 2026-10-03) is not a mention of its own; it
 * is pruned and saved together with its mention (pruneGeoExpression).
 */
export function placementsByEvidence(expr: GeoPreference | null | undefined): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  if (!expr || !Array.isArray(expr.groups)) return out;
  for (const g of expr.groups) {
    for (const c of g.clauses ?? []) {
      for (const ref of c.anyOf ?? []) {
        const eid = typeof ref.geometry_id === 'string' && ref.geometry_id.startsWith('geo:') ? ref.geometry_id.slice(4) : '';
        const r = ref.recipe;
        if (!eid || eid.includes(':') || !r) continue;
        const ids = Array.isArray(r.resolved_element_ids) ? r.resolved_element_ids.map(String) : [];
        out[eid] = {
          polarity: c.op === 'exclude' ? 'exclude' : 'include',
          operation: String(r.operation ?? ''),
          element_ids: ids,
          resolved: r.geo_data_version !== 'stub' && ids.length > 0,
          label: (Array.isArray(r.source_anchors) ? r.source_anchors : []).map((a) => a.span).filter(Boolean).join(' / '),
          side: r.operation === 'directional_band' ? bandSide(r) : r.side ?? null,
          clip_parts: r.clip_parts ? r.clip_parts.map((p) => ({ name: p.name, kept: p.kept, crossed: p.crossed, kept_km2: p.kept_km2, total_km2: p.total_km2 })) : null,
          ...(typeof r.radius_or_band_m === 'number' && Number.isFinite(r.radius_or_band_m) ? { radius_m: r.radius_or_band_m } : {}),
          ...(r.operation === 'district_side_clip' ? { clip_state: sideClipState(r) } : {}),
        };
      }
    }
  }
  return out;
}

/** The ids a caller must name before rendering: uuids → `districts`, anything else → `geo_elements.external_id`. */
export function placementElementIds(placements: Record<string, Placement>): { districtIds: string[]; elementIds: string[] } {
  const d = new Set<string>();
  const e = new Set<string>();
  for (const p of Object.values(placements)) {
    if (!p.resolved) continue; // unresolved ids are bare names, not ids
    for (const id of p.element_ids) (isUuid(id) ? d : e).add(id);
  }
  return { districtIds: [...d], elementIds: [...e] };
}

export interface PlaceName { name_ar: string; city?: string }

/** One mention as the verifier sees it. */
export interface VerifierMention {
  evidence_id: string;
  polarity: 'include' | 'exclude';
  /** ONE Arabic sentence: what the AI put on the map for this mention. */
  placed: string;
  /** false when nothing was put on the map for this mention (not a preference, or dropped). */
  on_map?: boolean;
}

const SIDE_AR: Record<string, string> = { north: 'شمال', south: 'جنوب', east: 'شرق', west: 'غرب' };
/** «الجزء الشمالي من طريق …» — the part of a district on one side of a road. */
const SIDE_PART_AR: Record<string, string> = { north: 'الشمالي', south: 'الجنوبي', east: 'الشرقي', west: 'الغربي' };

/** What the rep / verifier is told when a side clip will save nothing. */
export const SIDE_CLIP_EMPTY_AR = 'لا يقع جزء من الحي على هذا الجانب';
export const SIDE_CLIP_MISSING_AR = 'تعذّر حساب الجزء';
/** …and when a road side has no side (a legacy diagonal band): nothing is saved for it. */
export const BAND_NO_SIDE_AR = 'تعذّر تحديد جهة الطريق';

function nameOf(id: string, names: Record<string, PlaceName>): string {
  const n = names[id];
  if (!n || !n.name_ar) return id;
  return `${n.name_ar}${n.city ? ` (${n.city})` : ''}`;
}

/** A side clip's side text: «الجزء الشمالي من طريق الملك سلمان». */
function sidePart(side: string, roadName: string): string {
  return SIDE_PART_AR[side] ? `الجزء ${SIDE_PART_AR[side]} من ${roadName}` : `${side} ${roadName}`;
}

/** One placement → one Arabic sentence (mirrors ConversationGrader's placementLine). */
export function placementSentence(p: Placement, names: Record<string, PlaceName>): string {
  if (!p.resolved) {
    const what = p.element_ids.length ? p.element_ids.join('، ') : (p.label || '؟');
    return `لم يُحدَّد مكان حقيقي لـ «${what}» — يحتاج تأكيدًا`;
  }
  const verb = p.polarity === 'exclude' ? 'استبعد' : 'حدّد';
  const listed = p.element_ids.map((id) => nameOf(id, names));
  const plain = p.element_ids.map((id) => names[id]?.name_ar || id);
  const dist = p.radius_m != null ? ` · ${kmText(p.radius_m)} كم` : '';
  // A zone (or any big district list) is summarised, not listed — 30+ names is noise.
  if (p.operation === 'zone_union' || (p.operation === 'district_union' && p.element_ids.length > 6)) {
    return `${verb}: ${p.label || 'منطقة'} — ${p.element_ids.length} حيًا`;
  }
  if (p.operation === 'district_side_clip' && p.side) {
    const roadId = p.element_ids[p.element_ids.length - 1]!;
    const roadName = names[roadId]?.name_ar || roadId;
    const side = sidePart(p.side, roadName);
    const districts = (p.clip_parts ?? []).length
      ? (p.clip_parts ?? []).map((c) => c.name).join('، ')
      : listed.slice(0, -1).join('، ');
    const state = p.clip_state ?? 'ok';
    if (state === 'empty') return `${SIDE_CLIP_EMPTY_AR}: ${districts} — ${side}`;
    if (state === 'missing') return `${SIDE_CLIP_MISSING_AR}: ${districts} — ${side}`;
    const parts = (p.clip_parts ?? []).map((c) => (c.kept
      ? `${c.name}${c.crossed && c.kept_km2 != null && c.total_km2 != null ? ` (${c.kept_km2} من ${c.total_km2} كم²)` : ''}`
      : `${c.name} (كله على الجهة الأخرى — أُسقط)`));
    return `${verb}: ${parts.length ? parts.join('، ') : districts} — ${side}`;
  }
  if (p.operation === 'within_radius' || p.operation === 'within_distance') {
    return `${verb}: قرب ${plain.join('، ')}${dist}`;
  }
  if (p.operation === 'corridor') {
    return `${verb}: على امتداد ${listed.join('، ')}${p.radius_m != null ? ` (بعرض ${kmText(p.radius_m)} كم)` : ''}`;
  }
  if (p.operation === 'directional_band') {
    // `side` is bandSide() — the same reading review.ts saves by.
    const side = p.side ?? null;
    if (side && SIDE_AR[side]) return `${verb}: ${SIDE_AR[side]} ${plain.join('، ')}${dist}`;
    return `${BAND_NO_SIDE_AR}: ${listed.join('، ')} — لن يُحفظ`;
  }
  return `${verb}: ${listed.join('، ')}`;
}

/** Every placement in the expression as a {@link VerifierMention}. */
export function renderPlacements(expr: GeoPreference, names: Record<string, PlaceName>): VerifierMention[] {
  return Object.entries(placementsByEvidence(expr)).map(([evidence_id, p]) => ({
    evidence_id,
    polarity: p.polarity,
    placed: placementSentence(p, names),
    on_map: true,
  }));
}

/**
 * EVERY extracted mention of a conversation, in evidence order — the placed ones
 * rendered from the map, the rest stated as "nothing on the map" (mirrors the
 * grader's no-placement line), so the verifier can also judge a mention the
 * system chose to leave off.
 */
export function verifierMentionsFor(
  evidence: ReadonlyArray<Pick<Evidence, 'id' | 'mention_span' | 'preference_role'>>,
  expr: GeoPreference | null | undefined,
  names: Record<string, PlaceName>,
): Array<VerifierMention & { mention_span: string }> {
  const placed = new Map((expr ? renderPlacements(expr, names) : []).map((m) => [m.evidence_id, m]));
  return evidence.map((e) => {
    const m = placed.get(e.id);
    if (m) return { ...m, mention_span: e.mention_span };
    const notPref = e.preference_role === 'none' || e.preference_role === 'exploratory';
    return {
      evidence_id: e.id,
      polarity: e.preference_role === 'negative' ? 'exclude' : 'include',
      placed: notPref ? 'اعتبره ليس تفضيلًا — لم يضع شيئًا على الخريطة' : 'لم يُوضع على الخريطة',
      on_map: false,
      mention_span: e.mention_span,
    };
  });
}
