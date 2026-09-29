/**
 * Client for the anonymous /api/tracked-link endpoint (the public /v/:token
 * pages). Types mirror the whitelisted projection in api/tracked-link.ts.
 */

export type LinkSection = 'photos' | 'videos' | 'brochure' | 'units' | 'location';

export interface LinkProject {
  name: string;
  district: string | null;
  city: string | null;
  readiness: 'ready' | 'off_plan' | null;
  handover_date: string | null;
  price_from: number | null;
  price_to: number | null;
  cover_url: string | null;
}

export interface UnitSummary {
  id: string;
  code: string | null;
  type: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  area: number | null;
  price: number | null;
  floor: string | null;
}

export interface UnitDetail extends UnitSummary {
  total_area: number | null;
  private_area: number | null;
  facade: string | null;
  parking: string | null;
  model: string | null;
  components: string[];
  plan_url: string | null;
}

export interface LinkPhoto { id: string; thumb: string | null; url: string | null }
export interface LinkVideo { id: string; url: string | null; duration?: number | null; title?: string | null; external?: boolean }
export interface LinkBrochure { id: string; url: string | null; name?: string | null; external?: boolean }

export interface ProjectPage {
  kind: 'project';
  project: LinkProject;
  sections: LinkSection[];
  section: LinkSection | null;
  photos?: LinkPhoto[];
  videos?: LinkVideo[];
  brochure?: LinkBrochure;
  units?: UnitSummary[];
  location?: { maps_url: string | null; district: string | null; city: string | null };
}
export interface UnitPage { kind: 'unit'; project: LinkProject; unit: UnitDetail }
export type LinkPage = ProjectPage | UnitPage;

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/tracked-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error || `request failed (${res.status})`);
  return json;
}

export function fetchPage(token: string, section: string | undefined): Promise<LinkPage> {
  return post<LinkPage>({ token, action: 'page', section: section ?? '' });
}

export function fetchUnit(token: string, unitId: string): Promise<{ unit: UnitDetail }> {
  return post<{ unit: UnitDetail }>({ token, action: 'unit', unitId });
}
