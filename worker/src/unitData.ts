/**
 * Data layer for the unit one-pager PDF (unit_pdf_jobs lane).
 *
 * OPTION A (exact parity): reuses the PORTED pure resolvers
 * (worker/src/lib/{projectView,unitView,localizedName}.ts) — the same code the
 * SPA runs — over a minimal in-memory store built from just the records this one
 * unit needs. So the PDF says EXACTLY what the rep's on-screen inventory says
 * (localized option labels, localized geo, derived price/m²), with no second
 * re-implementation to drift.
 *
 * It loads: the units + all_projects + cities + districts model schemas, the
 * unit record, its parent all_projects record, and the record's city/district
 * geography rows — then resolves the ProjectView + UnitView. It also resolves the
 * floor-plan image (files.id → signed URL → bytes → data: URI, or a legacy http
 * URL) and the Wassel header logo (fetched once from the app's public assets).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import type { AppModel, AppRecord } from './lib/projectTypes.js';
import { resolveProjectView, type ProjectStoreSlices, type ProjectView } from './lib/projectView.js';
import { resolveUnitView, type UnitView } from './lib/unitView.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_URL_TTL_S = 600;

export interface UnitPdfInputs {
  project: ProjectView;
  unit: UnitView;
  logoDataUri: string | null;
  planDataUri: string | null;
}

interface UnifiedRow {
  id: string;
  model_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

function firstId(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' && v ? v : null;
}

async function loadModels(supabase: SupabaseClient): Promise<AppModel[]> {
  const { data, error } = await supabase
    .from('models')
    .select('id, name, schema')
    .in('name', ['units', 'all_projects', 'cities', 'districts']);
  if (error) throw new Error(`models load failed: ${error.message}`);
  return (data ?? []) as unknown as AppModel[];
}

async function loadRecords(supabase: SupabaseClient, ids: string[]): Promise<UnifiedRow[]> {
  const wanted = ids.filter((x): x is string => !!x);
  if (wanted.length === 0) return [];
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, model_id, data, created_at')
    .in('id', wanted);
  if (error) throw new Error(`record load failed: ${error.message}`);
  return (data ?? []) as UnifiedRow[];
}

/** Fetch bytes and return a data: URI (base64), or null on any failure. */
async function fetchToDataUri(url: string, mimeHint?: string | null): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.error(`[unit-pdf] image fetch ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const mime = mimeHint || res.headers.get('content-type') || 'application/octet-stream';
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch (err) {
    console.error('[unit-pdf] image fetch failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Resolve a unit's plan-image field to a data: URI. `planImage` is a files.id
 * UUID (private bucket → signed URL) or a legacy http(s) URL. Never throws — the
 * one-pager renders without a plan image when it can't be fetched.
 */
async function resolvePlanDataUri(supabase: SupabaseClient, planImage: string | null): Promise<string | null> {
  if (!planImage) return null;
  if (/^https?:\/\//i.test(planImage)) return fetchToDataUri(planImage);
  if (!UUID_RE.test(planImage)) return null;
  const { data: row, error } = await supabase
    .from('files')
    .select('storage_bucket, storage_path, mime_type')
    .eq('id', planImage)
    .maybeSingle();
  if (error || !row) {
    if (error) console.error(`[unit-pdf] files lookup failed for ${planImage}: ${error.message}`);
    return null;
  }
  const bucket = (row as { storage_bucket?: string }).storage_bucket;
  const path = (row as { storage_path?: string }).storage_path;
  const mime = (row as { mime_type?: string }).mime_type ?? null;
  if (!bucket || !path) return null;
  const { data: signed, error: signErr } = await supabase.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL_S);
  if (signErr || !signed?.signedUrl) {
    if (signErr) console.error(`[unit-pdf] sign plan image failed for ${path}: ${signErr.message}`);
    return null;
  }
  return fetchToDataUri(signed.signedUrl, mime);
}

// The header logo is the same for every render — fetch it once from the app's
// public assets (served by Vercel; the worker cannot ship files outside src/).
// Cached across jobs in the process; a fetch failure degrades to a text-only
// header (buildUnitHtml drops the <img> when the URI is null).
let logoCache: { uri: string | null } | null = null;

async function resolveLogoDataUri(env: WorkerEnv): Promise<string | null> {
  if (logoCache) return logoCache.uri;
  const url = `${env.APP_URL.replace(/\/+$/, '')}/assets/logo-horizontal-white.png`;
  const uri = await fetchToDataUri(url, 'image/png');
  logoCache = { uri };
  return uri;
}

/**
 * Build the ProjectView + UnitView + image data URIs for one unit.
 * Throws only when the unit record itself is missing.
 */
export async function resolveUnitPdfInputs(
  supabase: SupabaseClient,
  env: WorkerEnv,
  unitId: string,
  isAr: boolean,
): Promise<UnitPdfInputs> {
  const models = await loadModels(supabase);
  const opts = { isAr };

  // 1. The unit record.
  const [unitRow] = await loadRecords(supabase, [unitId]);
  if (!unitRow) throw new Error(`unit record not found: ${unitId}`);

  // 2. Its parent all_projects record (project_id is a lookup; value may be a
  //    string or a 1-element array).
  const projectId = firstId(unitRow.data.project_id);
  const [projRow] = projectId ? await loadRecords(supabase, [projectId]) : [];

  // 3. The project's city + district geography rows (for localized place names).
  const geoIds: string[] = [];
  if (projRow) {
    const loc = projRow.data.location && typeof projRow.data.location === 'object' && !Array.isArray(projRow.data.location)
      ? (projRow.data.location as Record<string, unknown>)
      : {};
    const cityId = firstId(loc.city);
    const distId = firstId(loc.district);
    if (cityId) geoIds.push(cityId);
    if (distId) geoIds.push(distId);
  }
  const geoRows = geoIds.length > 0 ? await loadRecords(supabase, geoIds) : [];

  // 4. Assemble the store, grouped by each row's own model_id (frozen or not,
  //    unified_records reports the correct model_id).
  const allRows: UnifiedRow[] = [unitRow, ...(projRow ? [projRow] : []), ...geoRows];
  const records: Record<string, AppRecord[]> = {};
  for (const r of allRows) {
    (records[r.model_id] ??= []).push({ id: r.id, data: r.data, created_at: r.created_at });
  }
  const store: ProjectStoreSlices = { models, records };

  // 5. Resolve the views. When the unit has no project link, resolve an empty
  //    project record so the header still renders (name/place fall back).
  const projectRecordForView: AppRecord = projRow
    ? { id: projRow.id, data: projRow.data, created_at: projRow.created_at }
    : { id: projectId ?? '', data: {}, created_at: unitRow.created_at };
  const unitRecordForView: AppRecord = { id: unitRow.id, data: unitRow.data, created_at: unitRow.created_at };

  const project = resolveProjectView(store, projectRecordForView, opts);
  const unit = resolveUnitView(store, unitRecordForView, opts);

  // 6. Images (both independent, both best-effort).
  const [logoDataUri, planDataUri] = await Promise.all([
    resolveLogoDataUri(env),
    resolvePlanDataUri(supabase, unit.planImage),
  ]);

  return { project, unit, logoDataUri, planDataUri };
}
