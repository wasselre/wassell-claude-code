// Client helper for the Projects AI actions. The DETERMINISTIC half (audit
// scoring, issue detection) lives here so the database/code decides; the AI half
// (callProjectAi → /api/project-ai) only NARRATES the supplied facts. Fact
// builders emit compact, already-resolved objects so the model never sees raw
// records and cannot invent values.

import { supabase } from '@/lib/supabase';
import { formatPriceRange, type ProjectView } from './projectView';
import type { UnitView } from './unitView';
import { FINDER_GROUP_KEYS, type FinderResponse } from '@/lib/matching/projectFinder';

export type ProjectAiAction = 'clean' | 'brief' | 'whatsapp' | 'compare_units' | 'audit' | 'match_explain';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function callProjectAi(
  action: ProjectAiAction,
  facts: unknown,
  language: 'ar' | 'en',
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch('/api/project-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, facts, language }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/project-ai failed (${res.status})`);
  }
  const json = (await res.json()) as { result?: string };
  return json.result ?? '';
}

// ── deterministic data-quality audit ────────────────────────────────────────

export interface ProjectAudit {
  score: number; // 0–100
  requiredMissing: string[];
  optionalMissing: string[];
  blockingWebsite: string[];
  blockingMatching: string[];
}

// Field keys + bilingual labels for the audit checklist. Required = the facts a
// project must have to be useful; matching/website blockers are subsets.
const REQUIRED: { key: keyof ProjectView; ar: string; en: string }[] = [
  { key: 'name', ar: 'اسم المشروع', en: 'Project name' },
  { key: 'developer', ar: 'المطور', en: 'Developer' },
  { key: 'city', ar: 'المدينة', en: 'City' },
  { key: 'district', ar: 'الحي', en: 'District' },
  { key: 'status', ar: 'حالة المشروع', en: 'Status' },
  { key: 'priceRange', ar: 'نطاق السعر', en: 'Price range' },
  { key: 'unitCount', ar: 'عدد الوحدات', en: 'Unit count' },
];

const OPTIONAL: { key: keyof ProjectView; ar: string; en: string }[] = [
  { key: 'construction', ar: 'حالة الإنشاء', en: 'Construction status' },
  { key: 'areaRange', ar: 'نطاق المساحة', en: 'Area range' },
  { key: 'imageRef', ar: 'صورة المشروع', en: 'Project image' },
  { key: 'brochureDeveloper', ar: 'بروشور المطور', en: 'Developer brochure' },
  { key: 'projectType', ar: 'نوع المشروع', en: 'Project type' },
];

function isMissing(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export function auditProject(view: ProjectView, isAr: boolean): ProjectAudit {
  const lab = (o: { ar: string; en: string }) => (isAr ? o.ar : o.en);
  const requiredMissing = REQUIRED.filter((f) => isMissing(view[f.key])).map(lab);
  const optionalMissing = OPTIONAL.filter((f) => isMissing(view[f.key])).map(lab);

  // Website publish blockers: must have a name, image and price to look credible.
  const blockingWebsite: string[] = [];
  if (isMissing(view.name)) blockingWebsite.push(isAr ? 'اسم المشروع' : 'Project name');
  if (isMissing(view.imageRef)) blockingWebsite.push(isAr ? 'صورة المشروع' : 'Project image');
  if (isMissing(view.priceRange)) blockingWebsite.push(isAr ? 'نطاق السعر' : 'Price range');

  // Matching blockers: deterministic matcher needs geo + price + unit types.
  const blockingMatching: string[] = [];
  if (!view.hasGeo) blockingMatching.push(isAr ? 'الموقع الجغرافي' : 'Geo location');
  if (isMissing(view.priceRange)) blockingMatching.push(isAr ? 'نطاق السعر' : 'Price range');
  if (isMissing(view.unitTypes)) blockingMatching.push(isAr ? 'أنواع الوحدات' : 'Unit types');

  // Score: required weighted heavier than optional.
  const reqScore = (REQUIRED.length - requiredMissing.length) / REQUIRED.length; // 0–1
  const optScore = (OPTIONAL.length - optionalMissing.length) / OPTIONAL.length; // 0–1
  const score = Math.round((reqScore * 0.75 + optScore * 0.25) * 100);

  return { score, requiredMissing, optionalMissing, blockingWebsite, blockingMatching };
}

/** Deterministic issue detection for "Clean this project". AI only phrases these. */
export function detectIssues(view: ProjectView, isAr: boolean): string[] {
  const out: string[] = [];
  const audit = auditProject(view, isAr);
  for (const m of audit.requiredMissing) out.push(isAr ? `حقل مطلوب ناقص: ${m}` : `Missing required field: ${m}`);
  if (!view.hasGeo) out.push(isAr ? 'لا يوجد موقع جغرافي محقق' : 'No verified geo location');
  if (isMissing(view.imageRef) && view.unitTypes.length === 0) {
    out.push(isAr ? 'لا توجد وسائط (صورة/أنواع وحدات)' : 'No media (image / unit types)');
  }
  // Invalid ranges: min > max.
  if (view.priceRange && view.priceRange.min > view.priceRange.max) {
    out.push(isAr ? 'نطاق السعر غير صحيح (الأدنى أكبر من الأعلى)' : 'Invalid price range (min > max)');
  }
  if (view.areaRange && view.areaRange.min > view.areaRange.max) {
    out.push(isAr ? 'نطاق المساحة غير صحيح (الأدنى أكبر من الأعلى)' : 'Invalid area range (min > max)');
  }
  // Inventory inconsistency: counts don't add up.
  if (
    view.unitCount !== null &&
    view.availableUnits !== null &&
    view.soldUnits !== null &&
    view.reservedUnits !== null &&
    view.availableUnits + view.soldUnits + view.reservedUnits > view.unitCount
  ) {
    out.push(isAr ? 'مجموع الوحدات (متاح/مباع/محجوز) يتجاوز إجمالي العدد' : 'Available+sold+reserved exceeds unit count');
  }
  return out;
}

// ── compact fact builders (what the model is allowed to see) ─────────────────

export function projectFacts(view: ProjectView, isAr: boolean): Record<string, unknown> {
  return {
    name: view.name,
    developer: view.developer,
    // ISSUE #8 — geography must match the requested output language. `view.city`
    // is the ARABIC name; sending it while asking for English output is what let
    // models invent transliterations. Falls back to null (omit) rather than
    // leaking Arabic into an English brief.
    city: isAr ? view.city : (view.cityLocalized?.enDisplay ?? null),
    district: isAr ? view.district : (view.districtLocalized?.enDisplay ?? null),
    status: view.status ? (isAr ? view.status.label_ar : view.status.label_en) : null,
    construction: view.construction ? (isAr ? view.construction.label_ar : view.construction.label_en) : null,
    project_type: view.projectType ? (isAr ? view.projectType.label_ar : view.projectType.label_en) : null,
    unit_types: view.unitTypes.map((u) => (isAr ? u.label_ar : u.label_en)),
    unit_count: view.unitCount,
    available_units: view.availableUnits,
    sold_units: view.soldUnits,
    reserved_units: view.reservedUnits,
    price_range: formatPriceRange(view.priceRange, isAr),
    area_range: view.areaRange,
    has_geo: view.hasGeo,
    is_targeted: view.isTargeted,
  };
}

export interface NarrationCandidate {
  project_name: string;
  group: string;
  score: number;
  band: string;
  breakdown: Record<string, number | null>;
  data_gaps: string[];
  mismatch_warnings: string[];
}

/**
 * Map the DETERMINISTIC finder response into the candidate list the AI narrates.
 * It strictly PRESERVES the engine's groups, order and scores and only passes
 * through the top `perGroup` of each group — it NEVER re-ranks, adds, or invents
 * a candidate. This is the boundary that keeps "AI explains, engine decides".
 */
export function finderCandidatesForNarration(resp: FinderResponse, perGroup = 3): NarrationCandidate[] {
  return FINDER_GROUP_KEYS.flatMap((k) =>
    resp.groups[k].slice(0, perGroup).map((m) => ({
      project_name: m.project_name,
      group: k,
      score: m.score,
      band: m.match_band,
      breakdown: m.score_breakdown,
      data_gaps: m.data_gaps,
      mismatch_warnings: m.mismatch_warnings,
    })),
  );
}

export function unitFacts(u: UnitView, isAr: boolean): Record<string, unknown> {
  return {
    code: u.code,
    developer_code: u.developerCode,
    type: u.type ? (isAr ? u.type.label_ar : u.type.label_en) : null,
    status: u.status ? (isAr ? u.status.label_ar : u.status.label_en) : null,
    bedrooms: u.bedrooms,
    bathrooms: u.bathrooms,
    floor: u.floor ? (isAr ? u.floor.label_ar : u.floor.label_en) : null,
    area_m2: u.area,
    total_price: u.totalPrice,
    price_per_m2: u.pricePerM2,
    components: u.components.map((c) => (isAr ? c.label_ar : c.label_en)),
  };
}
