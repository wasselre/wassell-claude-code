/**
 * POST /api/market-intelligence
 *
 * Read + recompute surface for the Market Intelligence page. ONE dispatch endpoint
 * (action-based, like /api/migrate) so the SPA makes a single authenticated call.
 *
 * ZERO AI. Every number comes from the precomputed benchmark tables
 * (market_benchmarks / market_demand_supply_benchmarks) or a DB-side filtered scan
 * of market_listings — never from an LLM. Asking prices are surfaced as "current
 * asking market", never as "market value".
 *
 * Auth: the caller's Supabase JWT (RLS-scoped). The benchmark tables are
 * non-sensitive aggregates (authenticated read). best_value scans market_listings
 * through the RLS-respecting wassell_market_candidates RPC, so a salesperson only
 * sees listings they're permitted to. recompute is admin-only (server-side check)
 * and runs via a service-role client.
 *
 * Actions:
 *   overview | filters | benchmarks | district | demand_supply | opportunities
 *   | best_value | client_report | pricing_report | recompute
 *   | area_stats | map_districts | geo_coverage | client_area
 *
 * AREA vs DISTRICT — the two are computed differently and that is deliberate.
 * The district benchmarks key off the scraped location.district TEXT field; the
 * area actions resolve membership by COORDINATES through wassell_geo_match (the
 * same predicate the Project Finder uses). ~3.9% of in-scope ads carry no
 * coordinates and are therefore invisible to an area calculation — geo_coverage
 * returns that number so the UI can state it instead of letting a smaller count
 * read as a smaller market.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
// .js extension is REQUIRED — src/lib is shared with the browser, but the
// deployed Node ESM bundle will not resolve an extensionless relative import.
import { canonPropertyType } from '../src/lib/market/propertyType.js';

export const config = { runtime: 'edge' };

const MARKET_MODEL_ID = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

// canon type → raw Arabic ILIKE terms for wassell_market_candidates (mirror of the
// matcher's property-type synonyms; the benchmark canon function is the inverse).
const CANON_TO_TERMS: Record<string, string[]> = {
  'فيلا': ['فيلا', 'دوبلكس', 'دبلكس', 'فلل'],
  'دور': ['دور'],
  'شقة': ['شقة', 'شقق'],
  'عمارة': ['عمارة', 'عمائر'],
  'تاون هاوس': ['تاون'],
  'أرض': ['أرض', 'اراض', 'أراض'],
  'تجاري': ['تجاري', 'مكتب', 'محل', 'معرض'],
  'استراحة': ['استراح'],
  'سكني': ['سكني'],
};

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); if (Number.isFinite(n)) return n; }
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

interface Body {
  action?: string;
  // filters (shared)
  city_id?: string;
  region_id?: string;
  district_id?: string;
  district_ids?: string[];
  property_type?: string;
  bedrooms_bucket?: string;
  budget_bucket?: string;
  source_type?: string;
  confidence_grade?: string;
  // pagination / sort
  page?: number;
  page_size?: number;
  sort?: string;          // column name
  sort_dir?: 'asc' | 'desc';
  // client_report
  requirements?: { districts?: string[]; property_type?: string; budget_max?: number; budget_min?: number; bedrooms?: number };
  // pricing_report / best_value
  our_project_id?: string;
  // area_stats / client_area — client-preference location_items[] (opaque here;
  // the SQL compiler validates each item and reports its status back).
  items?: unknown;
  active_only?: boolean;
  client_id?: string;
}

async function latestSnapshot(sb: SupabaseClient): Promise<string | null> {
  const { data } = await sb.from('market_benchmarks').select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
  return (data?.snapshot_date as string) ?? null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: Body;
    try { body = (await req.json()) as Body; } catch { return jsonError(400, 'invalid JSON body'); }

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return jsonError(500, 'Supabase env vars missing');
    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const sb = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const action = str(body.action) ?? 'overview';
    try {
      switch (action) {
        case 'overview': return await overview(sb);
        case 'filters': return await filters(sb);
        case 'benchmarks': return await benchmarks(sb, body);
        case 'district': return await district(sb, body);
        case 'demand_supply': return await demandSupply(sb, body);
        case 'opportunities': return await opportunities(sb);
        case 'best_value': return await bestValue(sb, body);
        case 'client_report': return await clientReport(sb, body);
        case 'pricing_report': return await pricingReport(sb);
        case 'recompute': return await recompute(user.userId);
        case 'area_stats': return await areaStats(sb, body);
        case 'map_districts': return await mapDistricts(sb, body);
        case 'geo_coverage': return await geoCoverage(sb);
        case 'client_area': return await clientArea(sb, body);
        default: return jsonError(400, `unknown action: ${action}`);
      }
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}

// ── overview ────────────────────────────────────────────────────────────────
async function overview(sb: SupabaseClient): Promise<Response> {
  const snap = await latestSnapshot(sb);
  if (!snap) {
    return jsonOk({
      snapshot_date: null, total_active_listings: 0, listings_with_price_area: 0,
      districts_covered: 0, active_client_demand: 0, benchmark_segments: 0,
      confidence_counts: { high: 0, medium: 0, low: 0 }, high_opportunity_districts: 0,
      verified_supply_gaps: 0, has_transaction_data: false,
    });
  }
  const [bench, demand, listingCount] = await Promise.all([
    sb.from('market_benchmarks').select('district_id, source_type, confidence_grade, transaction_count, deduped_count')
      .eq('snapshot_date', snap).eq('bedrooms_bucket', 'all'),
    sb.from('market_demand_supply_benchmarks').select('district_id, active_client_count, matching_our_project_count, acquisition_priority_score, sales_priority_score')
      .eq('snapshot_date', snap),
    sb.from('records').select('id', { count: 'exact', head: true }).eq('model_id', MARKET_MODEL_ID),
  ]);
  const brows = (bench.data ?? []) as Array<Record<string, unknown>>;
  const asking = brows.filter((r) => r.source_type === 'asking');
  const conf = { high: 0, medium: 0, low: 0 };
  let listingsWithPriceArea = 0;
  const districts = new Set<string>();
  for (const r of asking) {
    const g = r.confidence_grade as 'high' | 'medium' | 'low';
    if (g in conf) conf[g] += 1;
    listingsWithPriceArea += Number(r.deduped_count ?? 0);
    if (r.district_id) districts.add(String(r.district_id));
  }
  const drows = (demand.data ?? []) as Array<Record<string, unknown>>;
  const activeClients = new Set<string>();
  let gaps = 0; let opp = 0;
  const oppDistricts = new Set<string>();
  for (const r of drows) {
    if (Number(r.matching_our_project_count ?? 0) === 0 && Number(r.active_client_count ?? 0) > 0) gaps += 1;
    if (Number(r.acquisition_priority_score ?? 0) >= 2 || Number(r.sales_priority_score ?? 0) >= 2) oppDistricts.add(String(r.district_id));
  }
  // active client demand = sum of distinct-client demand on the 'all/all' rows is not exact;
  // approximate with max active_client_count per district to avoid double counting types.
  const perDistrictMax = new Map<string, number>();
  for (const r of drows) {
    const d = String(r.district_id);
    perDistrictMax.set(d, Math.max(perDistrictMax.get(d) ?? 0, Number(r.active_client_count ?? 0)));
  }
  let demandTotal = 0; perDistrictMax.forEach((v) => { demandTotal += v; });
  const hasTxn = brows.some((r) => Number(r.transaction_count ?? 0) > 0);
  opp = oppDistricts.size;
  void activeClients;
  return jsonOk({
    snapshot_date: snap,
    total_active_listings: listingCount.count ?? 0,
    listings_with_price_area: listingsWithPriceArea,
    districts_covered: districts.size,
    active_client_demand: demandTotal,
    benchmark_segments: asking.length,
    confidence_counts: conf,
    high_opportunity_districts: opp,
    verified_supply_gaps: gaps,
    has_transaction_data: hasTxn,
  });
}

// ── filters (distinct cities + property types for dropdowns) ─────────────────
async function filters(sb: SupabaseClient): Promise<Response> {
  const snap = await latestSnapshot(sb);
  if (!snap) return jsonOk({ cities: [], property_types: [] });
  const { data } = await sb.from('market_benchmarks').select('city_id, city_name, property_type')
    .eq('snapshot_date', snap).eq('source_type', 'asking').eq('bedrooms_bucket', 'all');
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const cityMap = new Map<string, string>();
  const types = new Set<string>();
  for (const r of rows) {
    if (r.city_id) cityMap.set(String(r.city_id), String(r.city_name ?? ''));
    if (r.property_type) types.add(String(r.property_type));
  }
  return jsonOk({
    snapshot_date: snap,
    cities: [...cityMap.entries()].map(([id, name]) => ({ id, name })),
    property_types: [...types],
  });
}

// ── benchmarks table (paginated) ─────────────────────────────────────────────
async function benchmarks(sb: SupabaseClient, body: Body): Promise<Response> {
  const snap = await latestSnapshot(sb);
  if (!snap) return jsonOk({ rows: [], total: 0, page: 1, page_size: 0, snapshot_date: null });
  const page = Math.max(1, Math.floor(num(body.page) ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(num(body.page_size) ?? 50)));
  const from = (page - 1) * pageSize;

  let q = sb.from('market_benchmarks').select('*', { count: 'exact' })
    .eq('snapshot_date', snap)
    .eq('source_type', str(body.source_type) ?? 'asking')
    .eq('bedrooms_bucket', str(body.bedrooms_bucket) ?? 'all');
  const city = str(body.city_id); if (city) q = q.eq('city_id', city);
  const dids = strArr(body.district_ids); if (dids.length) q = q.in('district_id', dids);
  const did = str(body.district_id); if (did) q = q.eq('district_id', did);
  const pt = str(body.property_type); if (pt) q = q.eq('property_type', pt);
  const cg = str(body.confidence_grade); if (cg) q = q.eq('confidence_grade', cg);

  const sort = str(body.sort) ?? 'deduped_count';
  const sortDir = body.sort_dir === 'asc';
  const allowedSort = new Set(['deduped_count', 'median_price_per_sqm', 'median_price', 'district_name', 'property_type', 'duplicate_ratio']);
  q = q.order(allowedSort.has(sort) ? sort : 'deduped_count', { ascending: sortDir, nullsFirst: false }).range(from, from + pageSize - 1);

  const { data, count, error } = await q;
  if (error) return jsonError(500, error.message);
  return jsonOk({ rows: data ?? [], total: count ?? 0, page, page_size: pageSize, snapshot_date: snap });
}

// ── district detail ──────────────────────────────────────────────────────────
async function district(sb: SupabaseClient, body: Body): Promise<Response> {
  const did = str(body.district_id);
  if (!did) return jsonError(400, 'district_id required');
  const snap = await latestSnapshot(sb);
  if (!snap) return jsonOk({ snapshot_date: null, benchmarks: [], demand_supply: [], best_value: [] });

  const [bench, demand] = await Promise.all([
    sb.from('market_benchmarks').select('*').eq('snapshot_date', snap).eq('district_id', did).order('source_type').order('deduped_count', { ascending: false }),
    sb.from('market_demand_supply_benchmarks').select('*').eq('snapshot_date', snap).eq('district_id', did).order('active_client_count', { ascending: false }),
  ]);
  // best value for the district's top type (highest deduped) at 'all' bedrooms
  const bvType = ((bench.data ?? []).find((r) => (r as Record<string, unknown>).source_type === 'asking' && (r as Record<string, unknown>).bedrooms_bucket === 'all') as Record<string, unknown> | undefined)?.property_type as string | undefined;
  const bv = bvType ? await collectBestValue(sb, snap, did, bvType, undefined) : [];
  return jsonOk({ snapshot_date: snap, benchmarks: bench.data ?? [], demand_supply: demand.data ?? [], best_value: bv });
}

// ── demand × supply ──────────────────────────────────────────────────────────
async function demandSupply(sb: SupabaseClient, body: Body): Promise<Response> {
  const snap = await latestSnapshot(sb);
  if (!snap) return jsonOk({ rows: [], snapshot_date: null });
  let q = sb.from('market_demand_supply_benchmarks').select('*').eq('snapshot_date', snap);
  const city = str(body.city_id); if (city) q = q.eq('city_id', city);
  const did = str(body.district_id); if (did) q = q.eq('district_id', did);
  const pt = str(body.property_type); if (pt) q = q.eq('property_type', pt);
  q = q.order('active_client_count', { ascending: false }).limit(500);
  const { data, error } = await q;
  if (error) return jsonError(500, error.message);
  return jsonOk({ rows: data ?? [], snapshot_date: snap });
}

// ── opportunity queue ────────────────────────────────────────────────────────
async function opportunities(sb: SupabaseClient): Promise<Response> {
  const snap = await latestSnapshot(sb);
  if (!snap) return jsonOk({ snapshot_date: null, sales_push: [], acquisition: [], pricing_watch: [], thin_market: [] });
  const { data } = await sb.from('market_demand_supply_benchmarks').select('*').eq('snapshot_date', snap);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const sales_push = rows.filter((r) => Number(r.sales_priority_score) > 0)
    .sort((a, b) => Number(b.sales_priority_score) - Number(a.sales_priority_score)).slice(0, 25);
  const acquisition = rows.filter((r) => Number(r.matching_our_project_count) === 0 && Number(r.matching_market_listing_count) >= 10 && Number(r.active_client_count) > 0)
    .sort((a, b) => Number(b.acquisition_priority_score) - Number(a.acquisition_priority_score)).slice(0, 25);
  const thin_market = rows.filter((r) => Number(r.active_client_count) > 0 && r.confidence_grade === 'low')
    .sort((a, b) => Number(b.active_client_count) - Number(a.active_client_count)).slice(0, 25);

  // pricing_watch: our_verified vs asking median gap per district×type.
  const { data: bench } = await sb.from('market_benchmarks').select('district_id, district_name, property_type, source_type, median_price_per_sqm, confidence_grade')
    .eq('snapshot_date', snap).eq('bedrooms_bucket', 'all').in('source_type', ['asking', 'our_verified']);
  const brows = (bench ?? []) as Array<Record<string, unknown>>;
  const askMap = new Map<string, Record<string, unknown>>();
  const ourMap = new Map<string, Record<string, unknown>>();
  for (const r of brows) {
    const k = `${r.district_id}|${r.property_type}`;
    if (r.source_type === 'asking') askMap.set(k, r); else ourMap.set(k, r);
  }
  const pricing_watch: Array<Record<string, unknown>> = [];
  ourMap.forEach((our, k) => {
    const ask = askMap.get(k);
    if (!ask) return;
    const o = Number(our.median_price_per_sqm); const a = Number(ask.median_price_per_sqm);
    if (!a || !o) return;
    const gap = Math.round(((o - a) / a) * 100);
    if (Math.abs(gap) >= 8) {
      pricing_watch.push({ district_id: our.district_id, district_name: our.district_name, property_type: our.property_type,
        our_ppm2: Math.round(o), market_ppm2: Math.round(a), gap_pct: gap, confidence_grade: ask.confidence_grade });
    }
  });
  pricing_watch.sort((x, y) => Math.abs(Number(y.gap_pct)) - Math.abs(Number(x.gap_pct)));
  return jsonOk({ snapshot_date: snap, sales_push, acquisition, pricing_watch: pricing_watch.slice(0, 25), thin_market });
}

// ── best-value listings (deterministic; ≤P25, geo+price+area present) ─────────
async function collectBestValue(sb: SupabaseClient, snap: string, districtId: string, canonType: string, budgetMax: number | undefined): Promise<unknown[]> {
  // benchmark slice for the segment
  const { data: bm } = await sb.from('market_benchmarks').select('*')
    .eq('snapshot_date', snap).eq('source_type', 'asking').eq('bedrooms_bucket', 'all')
    .eq('district_id', districtId).eq('property_type', canonType).maybeSingle();
  if (!bm) return [];
  const b = bm as Record<string, unknown>;
  // Only surface deals on a confident benchmark (never fake certainty on thin data).
  if (b.confidence_grade === 'low') return [];
  const p25 = Number(b.p25_price_per_sqm);
  const p10 = Number(b.p10_price_per_sqm);
  const threshold = b.confidence_grade === 'high' ? p10 : p25;
  if (!threshold) return [];

  const terms = CANON_TO_TERMS[canonType] ?? [canonType];
  const { data: cand, error } = await sb.rpc('wassell_market_candidates', {
    p_model_id: MARKET_MODEL_ID,
    p_district_ids: [districtId],
    p_budget_min: null,
    p_budget_max: budgetMax ?? null,
    p_bedrooms: null,
    p_type_terms: terms,
    p_limit: 4001,
  });
  if (error) return [];
  const list = (cand ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
  const out: unknown[] = [];
  for (const row of list) {
    const d = row.data;
    const price = num(d.price); const area = num(d.area);
    const ppm2 = num(d.price_per_m2) ?? (price && area ? price / area : undefined);
    if (!price || !area || !ppm2 || ppm2 <= 0) continue;
    if (ppm2 > threshold) continue;
    out.push({
      id: row.id,
      title: str(d.title) ?? '',
      district_id: districtId,
      district_name: (b.district_name as string) ?? null,
      property_type: canonType,
      raw_property_type: str(d.property_type) ?? '',
      price, area, price_per_sqm: Math.round(ppm2),
      bedrooms: num(d.bedrooms) ?? null,
      median_price_per_sqm: Number(b.median_price_per_sqm) || null,
      p25_price_per_sqm: p25 || null,
      vs_median_pct: b.median_price_per_sqm ? Math.round(((ppm2 - Number(b.median_price_per_sqm)) / Number(b.median_price_per_sqm)) * 100) : null,
      confidence_grade: b.confidence_grade,
      source_url: str(d.source_url) ?? null,
      main_image_url: str(d.main_image_url) ?? null,
      verify_before_offering: true,
    });
  }
  out.sort((a, z) => Number((a as Record<string, unknown>).price_per_sqm) - Number((z as Record<string, unknown>).price_per_sqm));
  return out.slice(0, 30);
}

async function bestValue(sb: SupabaseClient, body: Body): Promise<Response> {
  const did = str(body.district_id);
  const pt = str(body.property_type);
  if (!did || !pt) return jsonError(400, 'district_id and property_type required');
  const snap = await latestSnapshot(sb);
  if (!snap) return jsonOk({ listings: [], snapshot_date: null });
  const budgetMax = num(body.requirements?.budget_max);
  const listings = await collectBestValue(sb, snap, did, pt, budgetMax);
  return jsonOk({ listings, snapshot_date: snap });
}

// ── client market snapshot data bundle (for the PDF) ─────────────────────────
async function clientReport(sb: SupabaseClient, body: Body): Promise<Response> {
  const snap = await latestSnapshot(sb);
  if (!snap) return jsonOk({ snapshot_date: null, districts: [], budget: null });
  const reqDistricts = strArr(body.requirements?.districts);
  const pt = str(body.requirements?.property_type);
  const budgetMax = num(body.requirements?.budget_max);
  const budgetMin = num(body.requirements?.budget_min);

  // benchmark per requested district (the chosen type, else the densest type)
  const out: unknown[] = [];
  for (const did of reqDistricts.slice(0, 8)) {
    let q = sb.from('market_benchmarks').select('*').eq('snapshot_date', snap).eq('source_type', 'asking').eq('bedrooms_bucket', 'all').eq('district_id', did);
    if (pt) q = q.eq('property_type', pt);
    q = q.order('deduped_count', { ascending: false }).limit(1);
    const { data } = await q;
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (row) out.push(row);
  }
  // budget reality check vs the first/best district benchmark
  const ref = out[0] as Record<string, unknown> | undefined;
  let budget: Record<string, unknown> | null = null;
  if (ref && budgetMax) {
    const p25 = Number(ref.p25_price);
    const p75 = Number(ref.p75_price);
    const position = budgetMax < p25 ? 'below' : budgetMax > p75 ? 'above' : 'within';
    budget = { district_name: ref.district_name, budget_min: budgetMin ?? null, budget_max: budgetMax, p25_price: p25, median_price: Number(ref.median_price), p75_price: p75, position };
  }
  // recommended verified options first (our_verified benchmark rows for the districts)
  return jsonOk({ snapshot_date: snap, districts: out, budget, property_type: pt ?? null });
}

// ── our-project pricing report ───────────────────────────────────────────────
async function pricingReport(sb: SupabaseClient): Promise<Response> {
  const snap = await latestSnapshot(sb);
  if (!snap) return jsonOk({ snapshot_date: null, rows: [] });
  // our_verified benchmark rows joined to the asking benchmark for the same segment.
  const { data: ours } = await sb.from('market_benchmarks').select('*')
    .eq('snapshot_date', snap).eq('source_type', 'our_verified');
  const ourRows = (ours ?? []) as Array<Record<string, unknown>>;
  if (!ourRows.length) return jsonOk({ snapshot_date: snap, rows: [] });
  const { data: asking } = await sb.from('market_benchmarks').select('district_id, property_type, median_price_per_sqm, p25_price_per_sqm, p75_price_per_sqm, confidence_grade, deduped_count')
    .eq('snapshot_date', snap).eq('source_type', 'asking').eq('bedrooms_bucket', 'all');
  const askMap = new Map<string, Record<string, unknown>>();
  for (const r of (asking ?? []) as Array<Record<string, unknown>>) askMap.set(`${r.district_id}|${r.property_type}`, r);

  // demand per district×type
  const { data: demand } = await sb.from('market_demand_supply_benchmarks').select('district_id, property_type, active_client_count')
    .eq('snapshot_date', snap);
  const demMap = new Map<string, number>();
  for (const r of (demand ?? []) as Array<Record<string, unknown>>) demMap.set(`${r.district_id}|${r.property_type}`, Number(r.active_client_count ?? 0));

  const rows = ourRows.map((o) => {
    const k = `${o.district_id}|${o.property_type}`;
    const a = askMap.get(k);
    const ourPpm2 = Number(o.median_price_per_sqm);
    const mktPpm2 = a ? Number(a.median_price_per_sqm) : null;
    const gap = a && mktPpm2 ? Math.round(((ourPpm2 - mktPpm2) / mktPpm2) * 100) : null;
    const position = gap == null ? 'unknown' : gap <= -5 ? 'below' : gap >= 5 ? 'premium' : 'fair';
    return {
      district_id: o.district_id, district_name: o.district_name, district_name_en: o.district_name_en,
      property_type: o.property_type, our_ppm2: Math.round(ourPpm2), our_units: o.deduped_count,
      market_ppm2: mktPpm2 ? Math.round(mktPpm2) : null,
      market_p25: a ? Number(a.p25_price_per_sqm) : null, market_p75: a ? Number(a.p75_price_per_sqm) : null,
      gap_pct: gap, position, market_confidence: a ? a.confidence_grade : null,
      market_sample: a ? Number(a.deduped_count) : 0,
      client_demand: demMap.get(k) ?? demMap.get(`${o.district_id}|all`) ?? 0,
    };
  });
  return jsonOk({ snapshot_date: snap, rows });
}

// ── recompute (admin only) ───────────────────────────────────────────────────
async function recompute(userId: string): Promise<Response> {
  const svc = makeServiceClient('api:market-intelligence');
  if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');
  const { data: isAdmin, error: adminErr } = await svc.rpc('wassell_is_admin', { auth_user_id: userId });
  if (adminErr) return jsonError(500, `admin check failed: ${adminErr.message}`);
  if (isAdmin !== true) return jsonError(403, 'recompute is admin-only');
  const r1 = await svc.rpc('wassell_refresh_market_benchmarks');
  if (r1.error) return jsonError(500, `benchmark refresh failed: ${r1.error.message}`);
  const r2 = await svc.rpc('wassell_refresh_demand_supply');
  if (r2.error) return jsonError(500, `demand/supply refresh failed: ${r2.error.message}`);
  return jsonOk({ ok: true, benchmark_segments: r1.data, demand_segments: r2.data });
}

// ── area_stats ──────────────────────────────────────────────────────────────
// Live statistics for ANY area expressible as client-preference location_items.
// The heavy lifting is entirely in SQL (wassell_market_area_stats), which reuses
// wassell_geo_match so the area means exactly what it means in the Finder.
async function areaStats(sb: SupabaseClient, body: Body): Promise<Response> {
  const items = Array.isArray(body.items) ? body.items : [];
  const filters: Record<string, unknown> = {};
  if (str(body.property_type)) filters.property_type = str(body.property_type);
  if (str(body.bedrooms_bucket)) filters.bedrooms_bucket = str(body.bedrooms_bucket);
  if (str(body.city_id)) filters.city_id = str(body.city_id);
  if (strArr(body.district_ids).length) filters.district_ids = strArr(body.district_ids);
  if (typeof body.active_only === 'boolean') filters.active_only = body.active_only;

  const { data, error } = await sb.rpc('wassell_market_area_stats', {
    p_items: items, p_filters: filters,
  });
  if (error) return jsonError(500, `area stats failed: ${error.message}`);
  return jsonOk(data ?? {});
}

// ── map_districts ───────────────────────────────────────────────────────────
// One round trip for all three map layers: the choropleth metric, our units, and
// client demand, each keyed to a district outline.
async function mapDistricts(sb: SupabaseClient, body: Body): Promise<Response> {
  const filters: Record<string, unknown> = {};
  if (str(body.property_type)) filters.property_type = str(body.property_type);
  if (str(body.bedrooms_bucket)) filters.bedrooms_bucket = str(body.bedrooms_bucket);
  if (str(body.city_id)) filters.city_id = str(body.city_id);

  const { data, error } = await sb.rpc('wassell_market_map_districts', { p_filters: filters });
  if (error) return jsonError(500, `map districts failed: ${error.message}`);
  return jsonOk({ districts: data ?? [] });
}

// ── geo_coverage ────────────────────────────────────────────────────────────
// The honesty number for every area figure: how many in-scope ads have no
// coordinates and therefore cannot appear inside any area.
async function geoCoverage(sb: SupabaseClient): Promise<Response> {
  const { data, error } = await sb.rpc('wassell_market_geo_coverage');
  if (error) return jsonError(500, `geo coverage failed: ${error.message}`);
  return jsonOk(data ?? {});
}

// ── client_area ─────────────────────────────────────────────────────────────
// The market as the CLIENT defined it: read their saved location_items through
// the caller's RLS (a rep who cannot see the client gets nothing), then run the
// exact same area statistics over them.
async function clientArea(sb: SupabaseClient, body: Body): Promise<Response> {
  const clientId = str(body.client_id);
  if (!clientId) return jsonError(400, 'client_id is required');

  const { data: rec, error: recErr } = await sb
    .from('unified_records').select('id, data').eq('id', clientId).maybeSingle();
  if (recErr) return jsonError(500, `client lookup failed: ${recErr.message}`);
  if (!rec) return jsonError(404, 'client not found or not visible to you');

  const data = (rec.data ?? {}) as Record<string, unknown>;
  const items = Array.isArray(data.location_items) ? data.location_items : [];

  // preferred_unit_type is a MULTISELECT (e.g. ["فيلا"]) of raw labels, and the
  // benchmark segments are keyed by the canonical type — so take the first
  // choice and canon it. Sending the raw label straight through would silently
  // match no segment and render an empty panel that looks like "no market here".
  const rawPref = Array.isArray(data.preferred_unit_type)
    ? data.preferred_unit_type.find((x): x is string => typeof x === 'string')
    : str(data.preferred_unit_type);
  const prefType = str(body.property_type) ?? (rawPref ? canonPropertyType(rawPref) : undefined);

  const filters: Record<string, unknown> = {};
  if (prefType) filters.property_type = prefType;
  if (str(body.bedrooms_bucket)) filters.bedrooms_bucket = str(body.bedrooms_bucket);
  if (typeof body.active_only === 'boolean') filters.active_only = body.active_only;

  const { data: stats, error } = await sb.rpc('wassell_market_area_stats', {
    p_items: items, p_filters: filters,
  });
  if (error) return jsonError(500, `client area stats failed: ${error.message}`);

  const budget = (data.budget ?? {}) as Record<string, unknown>;
  return jsonOk({
    client_id: clientId,
    client_name: str(data.client_name) ?? null,
    has_location_prefs: items.length > 0,
    location_items: items,
    budget_min: num(budget.min) ?? null,
    budget_max: num(budget.max) ?? null,
    preferred_unit_type: prefType ?? null,
    preferred_unit_type_raw: rawPref ?? null,
    stats: stats ?? {},
  });
}
