/** Shared Market Intelligence types (SPA + api). Mirror the SQL table columns. */

export type ConfidenceGrade = 'high' | 'medium' | 'low';
export type BenchmarkSource = 'asking' | 'transaction' | 'our_verified';

export interface MarketBenchmark {
  snapshot_date: string;
  region_id: string | null;
  city_id: string | null;
  city_name: string | null;
  district_id: string | null;
  district_name: string | null;
  district_name_en: string | null;
  property_type: string;          // canonical
  bedrooms_bucket: string;
  area_bucket: string;
  source_type: BenchmarkSource;
  raw_count: number;
  deduped_count: number;
  duplicate_ratio: number;
  median_price: number | null;
  p10_price: number | null;
  p25_price: number | null;
  p75_price: number | null;
  p90_price: number | null;
  median_price_per_sqm: number | null;
  p10_price_per_sqm: number | null;
  p25_price_per_sqm: number | null;
  p75_price_per_sqm: number | null;
  p90_price_per_sqm: number | null;
  min_price_per_sqm: number | null;
  max_price_per_sqm: number | null;
  median_area: number | null;
  transaction_count: number;
  asking_transaction_gap_pct: number | null;
  confidence_grade: ConfidenceGrade;
  confidence_reason: string | null;
}

export interface DemandSupplyRow {
  snapshot_date: string;
  region_id: string | null;
  city_id: string | null;
  city_name: string | null;
  district_id: string | null;
  district_name: string | null;
  district_name_en: string | null;
  property_type: string;
  budget_bucket: string;
  active_client_count: number;
  matching_market_listing_count: number;
  matching_our_project_count: number;
  matching_all_project_count: number;
  undersupply_score: number;
  sales_priority_score: number;
  acquisition_priority_score: number;
  confidence_grade: ConfidenceGrade;
}

export interface MarketOverview {
  snapshot_date: string | null;
  total_active_listings: number;
  listings_with_price_area: number;
  districts_covered: number;
  active_client_demand: number;
  benchmark_segments: number;
  confidence_counts: { high: number; medium: number; low: number };
  high_opportunity_districts: number;   // demand×supply rows flagged acquisition/sales
  verified_supply_gaps: number;         // demand exists, our supply = 0
  has_transaction_data: boolean;
}

export interface BestValueListing {
  id: string;
  title: string;
  district_id: string | null;
  district_name: string | null;
  property_type: string;          // canonical
  raw_property_type: string;
  price: number | null;
  area: number | null;
  price_per_sqm: number | null;
  bedrooms: number | null;
  median_price_per_sqm: number | null;
  p25_price_per_sqm: number | null;
  vs_median_pct: number | null;
  confidence_grade: ConfidenceGrade | null;
  source_url: string | null;
  main_image_url: string | null;
  verify_before_offering: true;   // always true — external listing
}
