/**
 * "What did the AI put on the map for this mention?" — in Arabic words.
 *
 * ONE implementation shared by the grader endpoint (`api/geo-preference/simple-grade.ts`,
 * which ships the raw {@link Placement}s to the browser) and the VERIFIER
 * (`verifier.ts`, which needs each placement as a sentence it can check against
 * the conversation). The sentence mirrors `placementLine` in
 * `src/pages/GeoGrade/components/ConversationGrader.tsx` so the verifier reads
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
}

export const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Every mention's placement, keyed by evidence id. A mention with two refs keeps the last (unchanged behaviour). */
export function placementsByEvidence(expr: GeoPreference | null | undefined): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  if (!expr || !Array.isArray(expr.groups)) return out;
  for (const g of expr.groups) {
    for (const c of g.clauses ?? []) {
      for (const ref of c.anyOf ?? []) {
        const eid = typeof ref.geometry_id === 'string' && ref.geometry_id.startsWith('geo:') ? ref.geometry_id.slice(4) : '';
        const r = ref.recipe;
        if (!eid || !r) continue;
        const ids = Array.isArray(r.resolved_element_ids) ? r.resolved_element_ids.map(String) : [];
        out[eid] = {
          polarity: c.op === 'exclude' ? 'exclude' : 'include',
          operation: String(r.operation ?? ''),
          element_ids: ids,
          resolved: r.geo_data_version !== 'stub' && ids.length > 0,
          label: (Array.isArray(r.source_anchors) ? r.source_anchors : []).map((a) => a.span).filter(Boolean).join(' / '),
          side: r.side ?? null,
          clip_parts: r.clip_parts ? r.clip_parts.map((p) => ({ name: p.name, kept: p.kept, crossed: p.crossed, kept_km2: p.kept_km2, total_km2: p.total_km2 })) : null,
          ...(typeof r.radius_or_band_m === 'number' && Number.isFinite(r.radius_or_band_m) ? { radius_m: r.radius_or_band_m } : {}),
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

function nameOf(id: string, names: Record<string, PlaceName>): string {
  const n = names[id];
  if (!n || !n.name_ar) return id;
  return `${n.name_ar}${n.city ? ` (${n.city})` : ''}`;
}

function km(m: number): string {
  const v = m / 1000;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** One placement → one Arabic sentence (mirrors ConversationGrader's placementLine). */
export function placementSentence(p: Placement, names: Record<string, PlaceName>): string {
  if (!p.resolved) {
    const what = p.element_ids.length ? p.element_ids.join('، ') : (p.label || '؟');
    return `لم يُحدَّد مكان حقيقي لـ «${what}» — يحتاج تأكيدًا`;
  }
  const verb = p.polarity === 'exclude' ? 'استبعد' : 'حدّد';
  const listed = p.element_ids.map((id) => nameOf(id, names));
  // A zone (or any big district list) is summarised, not listed — 30+ names is noise.
  if (p.operation === 'zone_union' || (p.operation === 'district_union' && p.element_ids.length > 6)) {
    return `${verb}: ${p.label || 'منطقة'} — ${p.element_ids.length} حيًا`;
  }
  if (p.operation === 'district_side_clip' && p.side) {
    const roadId = p.element_ids[p.element_ids.length - 1]!;
    const roadName = names[roadId]?.name_ar || roadId;
    const parts = (p.clip_parts ?? []).map((c) => (c.kept
      ? `${c.name}${c.crossed && c.kept_km2 != null && c.total_km2 != null ? ` (${c.kept_km2} من ${c.total_km2} كم²)` : ''}`
      : `${c.name} (كله على الجهة الأخرى — أُسقط)`));
    return `${verb}: ${parts.length ? parts.join('، ') : listed.slice(0, -1).join('، ')} — ${SIDE_AR[p.side] ?? p.side} ${roadName}`;
  }
  if (p.operation === 'within_radius' || p.operation === 'within_distance') {
    return `${verb}: ${p.radius_m != null ? `ضمن ${km(p.radius_m)} كم من ` : 'قرب '}${listed.join('، ')}`;
  }
  if (p.operation === 'corridor') {
    return `${verb}: على امتداد ${listed.join('، ')}${p.radius_m != null ? ` (بعرض ${km(p.radius_m)} كم)` : ''}`;
  }
  if (p.operation === 'directional_band') {
    return `${verb}: ${p.label || 'نطاق'} — ${listed.join('، ')}`;
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
