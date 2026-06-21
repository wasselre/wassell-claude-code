/**
 * Structured project-recommendation payload — the shape the matching agent emits
 * via the `emit_recommendation` tool when it has a FINAL ranked recommendation.
 * It travels over the SSE stream as a `recommendation` event, is stored on the
 * assistant message, and rendered as a card (ProjectMatchCard).
 *
 * Everything here is derived from the agent's verified tool output
 * (match_projects / get_project). The normalizer is lenient — it never drops a
 * recommendation the agent produced — but it does not fabricate fields.
 */

export type MatchBand = 'strong' | 'good' | 'partial';
export type MatchType = 'exact' | 'nearby' | 'same_city' | 'stretch' | 'partial';
export type DataSource = 'our_projects' | 'all_projects';

export interface RecommendationSpecs {
  city?: string;
  district?: string;
  unit_types?: string;
  price_range?: string;
  area_range?: string;
  bedrooms?: string;
  bathrooms?: string;
  available_units?: string;
  project_status?: string;
}

export interface ProjectRecommendation {
  project_id?: string;
  project_name: string;
  data_source: DataSource;
  requires_verification: boolean;
  score: number;
  match_band: MatchBand;
  match_type: MatchType;
  /** For a "nearby" match: km from the requested district. */
  distance_km?: number;
  why: string;
  specs: RecommendationSpecs;
  selling_points: string[];
  pitch: string;
  warning?: string;
  missing_info: string[];
}

export interface RecommendationPayload {
  summary: string;
  data_source: DataSource | 'mixed';
  requires_verification: boolean;
  recommendations: ProjectRecommendation[];
  questions_to_ask: string[];
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asString).filter((s) => s.trim() !== '') : [];
const asNumber = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
};

function asBand(v: unknown): MatchBand {
  return v === 'strong' || v === 'good' || v === 'partial' ? v : 'partial';
}
function asMatchType(v: unknown): MatchType {
  return v === 'exact' || v === 'nearby' || v === 'same_city' || v === 'stretch' || v === 'partial' ? v : 'partial';
}
function asSource(v: unknown): DataSource {
  return v === 'all_projects' ? 'all_projects' : 'our_projects';
}

function normalizeSpecs(v: unknown): RecommendationSpecs {
  if (!v || typeof v !== 'object') return {};
  const s = v as Record<string, unknown>;
  const out: RecommendationSpecs = {};
  const keys: (keyof RecommendationSpecs)[] = [
    'city', 'district', 'unit_types', 'price_range', 'area_range',
    'bedrooms', 'bathrooms', 'available_units', 'project_status',
  ];
  for (const k of keys) {
    const val = asString(s[k]);
    if (val.trim() !== '') out[k] = val;
  }
  return out;
}

function normalizeOne(v: unknown): ProjectRecommendation | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const name = asString(d.project_name);
  if (!name) return null;
  const source = asSource(d.data_source);
  return {
    project_id: asString(d.project_id) || undefined,
    project_name: name,
    data_source: source,
    requires_verification: d.requires_verification === true || source === 'all_projects',
    score: asNumber(d.score),
    match_band: asBand(d.match_band),
    match_type: asMatchType(d.match_type),
    distance_km: typeof d.distance_km === 'number' ? d.distance_km : undefined,
    why: asString(d.why),
    specs: normalizeSpecs(d.specs),
    selling_points: asStringArray(d.selling_points),
    pitch: asString(d.pitch),
    warning: asString(d.warning) || undefined,
    missing_info: asStringArray(d.missing_info),
  };
}

/**
 * Coerce the raw, untrusted emit_recommendation tool input (typed `unknown` off
 * the wire) into a RecommendationPayload. Returns null only when there are no
 * usable recommendations at all.
 */
export function normalizeRecommendation(data: unknown): RecommendationPayload | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const recs = (Array.isArray(d.recommendations) ? d.recommendations : [])
    .map(normalizeOne)
    .filter((r): r is ProjectRecommendation => r !== null);
  if (recs.length === 0) return null;
  const anyVerify = recs.some((r) => r.requires_verification);
  const rawSource = d.data_source;
  const dataSource: RecommendationPayload['data_source'] =
    rawSource === 'all_projects' || rawSource === 'mixed' || rawSource === 'our_projects'
      ? rawSource
      : anyVerify
        ? 'mixed'
        : 'our_projects';
  return {
    summary: asString(d.summary),
    data_source: dataSource,
    requires_verification: d.requires_verification === true || anyVerify,
    recommendations: recs,
    questions_to_ask: asStringArray(d.questions_to_ask),
  };
}

/**
 * Compact text rendering of a recommendation. Appended to the assistant
 * message's `content` ONLY when rebuilding the API history, so the model stays
 * grounded in what it already produced when the salesperson asks a follow-up.
 * The UI still shows the structured card, never this text.
 */
export function serializeRecommendationForModel(p: RecommendationPayload): string {
  const lines: string[] = [`[Recommendation: ${p.summary || '(no summary)'} | source: ${p.data_source}]`];
  p.recommendations.forEach((r, i) => {
    lines.push(
      `${i + 1}. ${r.project_name} — ${r.match_band} (${r.score}/100, ${r.match_type})` +
        (r.requires_verification ? ' [VERIFY: all_projects]' : ''),
    );
    if (r.why) lines.push(`   why: ${r.why}`);
    const specBits = Object.entries(r.specs).map(([k, val]) => `${k}: ${val}`);
    if (specBits.length) lines.push(`   specs: ${specBits.join('; ')}`);
  });
  if (p.questions_to_ask.length) lines.push(`Ask: ${p.questions_to_ask.join(' / ')}`);
  return lines.join('\n');
}
