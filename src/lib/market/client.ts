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
