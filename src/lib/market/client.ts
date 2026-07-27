/**
 * Browser-side client for POST /api/market-intelligence (action dispatch).
 * One thin wrapper per action; all are authenticated + RLS-scoped server-side.
 */

import { supabase } from '@/lib/supabase';
import type { MarketBenchmark, DemandSupplyRow, MarketOverview, BestValueListing } from './types';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call<T>(action: string, payload: object = {}): Promise<T> {
  const res = await fetch('/api/market-intelligence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `market-intelligence ${action} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface BenchmarkFilters {
  city_id?: string;
  district_id?: string;
  district_ids?: string[];
  property_type?: string;
  bedrooms_bucket?: string;
  source_type?: string;
  confidence_grade?: string;
  page?: number;
  page_size?: number;
  sort?: string;
  sort_dir?: 'asc' | 'desc';
}

export const fetchOverview = () => call<MarketOverview>('overview');
export const fetchFilters = () => call<{ snapshot_date: string | null; cities: { id: string; name: string }[]; property_types: string[] }>('filters');
export const fetchBenchmarks = (f: BenchmarkFilters) =>
  call<{ rows: MarketBenchmark[]; total: number; page: number; page_size: number; snapshot_date: string | null }>('benchmarks', f);
export const fetchDistrict = (district_id: string) =>
  call<{ snapshot_date: string | null; benchmarks: MarketBenchmark[]; demand_supply: DemandSupplyRow[]; best_value: BestValueListing[] }>('district', { district_id });
export const fetchDemandSupply = (f: { city_id?: string; district_id?: string; property_type?: string }) =>
  call<{ rows: DemandSupplyRow[]; snapshot_date: string | null }>('demand_supply', f);

export interface OpportunityQueues {
  snapshot_date: string | null;
  sales_push: DemandSupplyRow[];
  acquisition: DemandSupplyRow[];
  pricing_watch: Array<{ district_id: string; district_name: string; property_type: string; our_ppm2: number; market_ppm2: number; gap_pct: number; confidence_grade: string }>;
  thin_market: DemandSupplyRow[];
}
export const fetchOpportunities = () => call<OpportunityQueues>('opportunities');

export const fetchBestValue = (district_id: string, property_type: string, budget_max?: number) =>
  call<{ listings: BestValueListing[]; snapshot_date: string | null }>('best_value', { district_id, property_type, requirements: { budget_max } });

export interface PricingReportRow {
  district_id: string; district_name: string; district_name_en: string | null; property_type: string;
  our_ppm2: number; our_units: number; market_ppm2: number | null; market_p25: number | null; market_p75: number | null;
  gap_pct: number | null; position: 'below' | 'fair' | 'premium' | 'unknown'; market_confidence: string | null; market_sample: number; client_demand: number;
}
export const fetchPricingReport = () => call<{ snapshot_date: string | null; rows: PricingReportRow[] }>('pricing_report');

export interface ClientReportData {
  snapshot_date: string | null;
  districts: MarketBenchmark[];
  budget: null | { district_name: string; budget_min: number | null; budget_max: number; p25_price: number; median_price: number; p75_price: number; position: 'below' | 'within' | 'above' };
  property_type: string | null;
}
export const fetchClientReport = (requirements: { districts?: string[]; property_type?: string; budget_max?: number; budget_min?: number }) =>
  call<ClientReportData>('client_report', { requirements });

export const recomputeBenchmarks = () => call<{ ok: true; benchmark_segments: number; demand_segments: number }>('recompute');

// ── Area statistics (the map surface) ───────────────────────────────────────
// An "area" is any set of client-preference location_items — districts, a road
// band ("north of X up to 5 km"), a radius around a landmark, a freehand
// polygon, plus exclusions. Membership is resolved server-side by the SAME
// predicate the Project Finder uses, so what you measure is what you'd match.

export interface AreaBand {
  median?: number | null; p10?: number | null; p25?: number | null;
  p75?: number | null; p90?: number | null; min?: number | null; max?: number | null;
}
export interface AreaTypeRow {
  property_type: string; count: number;
  median_price: number | null; median_price_per_sqm: number | null;
  p25_price_per_sqm: number | null; p75_price_per_sqm: number | null; median_area: number | null;
}
export interface AreaBedroomRow {
  bedrooms_bucket: string; count: number;
  median_price: number | null; median_price_per_sqm: number | null;
}
export interface AreaDistrictRow {
  district_id: string; district_name: string | null; district_name_en: string | null;
  city_name: string | null; count: number; median_price_per_sqm: number | null;
}
export interface AreaStats {
  raw_count: number;
  deduped_count: number;
  duplicate_ratio: number;
  confidence_grade: 'high' | 'medium' | 'low';
  confidence_reason: string;
  active_only: boolean;
  has_geometry: boolean;
  /** Per-item compile status — an item with a non-'ok' status contributed NOTHING. */
  geo_items: Array<{ item_id: string; kind: string; polarity: string; validation_status: string }>;
  price: AreaBand;
  price_per_sqm: AreaBand;
  median_area: number | null;
  by_type: AreaTypeRow[];
  by_bedrooms: AreaBedroomRow[];
  districts: AreaDistrictRow[];
  our_inventory: {
    project_count?: number; unit_count?: number; available_units?: number;
    median_price_per_sqm?: number | null; median_price?: number | null;
  };
  demand: { active_clients?: number; basis?: string };
  snapshot_date: string;
}

export interface AreaFilters {
  property_type?: string;
  bedrooms_bucket?: string;
  city_id?: string;
  district_ids?: string[];
  /** Default true — delisted ads are excluded from "current asking market". */
  active_only?: boolean;
}

export const fetchAreaStats = (items: unknown[], filters: AreaFilters = {}) =>
  call<AreaStats>('area_stats', { items, ...filters });

export interface MapDistrict {
  district_id: string; district_name: string | null; district_name_en: string | null;
  city_id: string | null; city_name: string | null;
  listing_count: number; duplicate_ratio: number; confidence_grade: 'high' | 'medium' | 'low';
  median_price: number | null; median_price_per_sqm: number | null;
  p25_price_per_sqm: number | null; p75_price_per_sqm: number | null; median_area: number | null;
  our_units: number; demand_clients: number;
  centroid: [number, number] | null;
  /** GeoJSON geometry (Polygon | MultiPolygon), simplified server-side. */
  outline: { type: string; coordinates: unknown } | null;
}
export const fetchMapDistricts = (f: { property_type?: string; bedrooms_bucket?: string; city_id?: string } = {}) =>
  call<{ districts: MapDistrict[] }>('map_districts', f);

export interface GeoCoverage {
  in_scope: number; with_coordinates: number;
  without_coordinates: number; pct_without_coordinates: number;
}
export const fetchGeoCoverage = () => call<GeoCoverage>('geo_coverage');

export interface ClientAreaData {
  client_id: string;
  client_name: string | null;
  has_location_prefs: boolean;
  location_items: unknown[];
  budget_min: number | null;
  budget_max: number | null;
  preferred_unit_type: string | null;
  preferred_unit_type_raw: string | null;
  stats: AreaStats;
}
export const fetchClientArea = (client_id: string, f: AreaFilters = {}) =>
  call<ClientAreaData>('client_area', { client_id, ...f });
