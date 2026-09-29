/**
 * Client for the anonymous /api/broker-portal endpoint (public broker page).
 * Types mirror the whitelisted projection in api/broker-portal.ts.
 */

export interface Bi { ar: string; en: string }
export interface Range { min: number | null; max: number | null }

export interface PortalLocation {
  district: Bi | null;
  city: Bi | null;
  lat: number | null;
  lng: number | null;
  map_url: string | null;
}

export interface PortalProjectCard {
  id: string;
  name: string;
  status: Bi | null;
  construction_status: Bi | null;
  unit_types: Bi[];
  location: PortalLocation;
  unit_count: number;
  available_units: number;
  reserved_units: number;
  sold_units: number;
  available_price_range: Range | null;
  available_area_range: Range | null;
  bedroom_range: Range | null;
  avg_price_per_m2: number | null;
  handover_date: string | null;
  down_payment_percent: number | null;
  cover?: string | null;
}

export interface PortalOverview {
  portal: { title_ar: string | null; title_en: string | null };
  developer: { name: string; phone: string | null; website: string | null };
  projects: PortalProjectCard[];
  expires_at: string;
}

export interface UnitPlanRow {
  plan: string | null;
  down: number | null;
  before_handover: number | null;
  on_handover: number | null;
  after_handover: number | null;
  schedule: string | null;
}

export type UnitStatus = 'available' | 'reserved' | 'sold' | 'other';

export interface PortalUnit {
  id: string;
  code: string | null;
  number: string | null;
  building: string | null;
  model: string | null;
  type: Bi | null;
  floor: Bi | null;
  bedrooms: number | null;
  bathrooms: number | null;
  area: number | null;
  price: number | null;
  status: UnitStatus;
  status_label: Bi | null;
  components: Bi[];
  payment_plans: UnitPlanRow[];
  plan_file_id: string | null;
}

export type MediaSection = 'photos' | 'videos' | 'library' | 'documents' | 'plans';

export interface PortalFile {
  id: string;
  section: MediaSection;
  kind: string | null;
  mime_type: string | null;
  name: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  url: string;
  thumb: string | null;
  download: string | null;
  unit_ids: string[];
  created_at: string | null;
}

export interface HostedVideo {
  url: string;
  kind: 'youtube' | 'direct' | 'link';
  youtube_id?: string;
}

export interface ProjectPaymentPlan {
  plan: string | null;
  down: number | null;
  during_construction: number | null;
  on_handover: number | null;
  post_handover: number | null;
  schedule: string | null;
}

export interface PortalProjectDetail {
  project: PortalProjectCard & {
    description: string | null;
    features: string[];
    services: Array<{ service: string | null; notes: string | null }>;
    guarantees: Array<{ item: string | null; period: string | null }>;
    landmarks: Array<{ name: string | null; duration: string | null; distance: string | null }>;
    payment_plans: ProjectPaymentPlan[];
    payment_plan_summary: string | null;
    links: { developer_brochure: string | null; brochure: string | null; page: string | null };
  };
  units: PortalUnit[];
  files: PortalFile[];
  hosted_videos: HostedVideo[];
  expires_at: string;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/broker-portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const err = new Error(json.error ?? `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json;
}

export function fetchPortalOverview(token: string): Promise<PortalOverview> {
  return call<PortalOverview>({ token, action: 'overview' });
}

export function fetchPortalProject(token: string, projectId: string): Promise<PortalProjectDetail> {
  return call<PortalProjectDetail>({ token, action: 'project', projectId });
}
