/**
 * POST /api/broker-portal  (ANONYMOUS — no withAuth)
 *
 * Powers the public /brokers/:token page: one developer's projects, units,
 * payment plans, floor plans, photos, videos, marketing library and documents,
 * shown to outside brokers without a login.
 *
 * Body:
 *   { token, action: 'overview' }                → developer + project cards
 *   { token, action: 'project', projectId }      → one project in full
 *
 * Security posture (same as /api/share/view):
 *   - The token is resolved with the service role against `broker_portals`
 *     (RLS: admins only; anon has no grant). A wrong, inactive or expired
 *     token all return the same 404.
 *   - A project is served only when its `developer` equals the portal's
 *     developer — a valid token cannot be used to read another developer.
 *   - Only a WHITELISTED projection leaves the server. Internal fields
 *     (project_analysis, source_notes, update_source_*, data_sources…) are
 *     never read into the response.
 *   - Files are served as short-lived signed URLs (PORTAL_URL_TTL_SECONDS).
 *     Only active, non-archived files whose confidentiality is internal/public
 *     are included.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonError, jsonOk } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';

export const config = { runtime: 'edge' };

/** Signed URLs live 6 h — a broker browsing a gallery must not see images
 *  expire mid-session. The page re-fetches when it is older than that. */
const PORTAL_URL_TTL_SECONDS = 60 * 60 * 6;
const SHAREABLE_CONFIDENTIALITY = new Set(['internal', 'public']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Types ──────────────────────────────────────────────────────────────────

interface Bi { ar: string; en: string }
interface SchemaOption { value?: string; label_ar?: string; label_en?: string }
interface SchemaField { name?: string; options?: SchemaOption[] }
interface ModelRow { id: string; name: string; schema: { sections?: Array<{ fields?: SchemaField[] }> } | null }
type Json = Record<string, unknown>;
interface RecordRow { id: string; data: Json }
interface PortalRow {
  id: string; developer_id: string; title_ar: string | null; title_en: string | null;
  is_active: boolean; expires_at: string | null;
}
interface FileRow {
  id: string; kind: string | null; mime_type: string | null; original_name: string | null;
  title: string | null; size_bytes: number | null; storage_bucket: string; storage_path: string;
  width_px: number | null; height_px: number | null; duration_seconds: number | null;
  primary_category: string | null; confidentiality: string | null; status: string | null;
  archived_at: string | null; created_at: string | null;
}
interface LinkRow { file_id: string; record_id: string; role: string | null }

type LabelMap = Map<string, Map<string, Bi>>;

// ── Small helpers ──────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function arr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      // A malformed JSON-array string in a record field: treat as empty, but say so.
      console.error('[broker-portal] unparsable array field:', (e as Error).message);
      return [];
    }
  }
  return [];
}
function range(v: unknown): { min: number | null; max: number | null } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Json;
  const min = num(o.min);
  const max = num(o.max);
  return min == null && max == null ? null : { min, max };
}

function buildLabels(model: ModelRow | undefined): LabelMap {
  const out: LabelMap = new Map();
  for (const s of model?.schema?.sections ?? []) {
    for (const f of s.fields ?? []) {
      if (!f.name || !Array.isArray(f.options) || f.options.length === 0) continue;
      const m = new Map<string, Bi>();
      for (const o of f.options) {
        if (!o.value) continue;
        m.set(o.value, { ar: o.label_ar || o.value, en: o.label_en || o.label_ar || o.value });
      }
      out.set(f.name, m);
    }
  }
  return out;
}
function label(labels: LabelMap, field: string, value: unknown): Bi | null {
  const v = str(value);
  if (!v) return null;
  return labels.get(field)?.get(v) ?? { ar: v.replace(/-/g, ' '), en: v.replace(/[-_]/g, ' ') };
}
function labelList(labels: LabelMap, field: string, value: unknown): Bi[] {
  return arr(value).map((x) => label(labels, field, x)).filter((x): x is Bi => x != null);
}

/** Bilingual unit status → the three buckets the page filters on. */
function statusKey(v: unknown): 'available' | 'reserved' | 'sold' | 'other' {
  const s = (str(v) ?? '').toLowerCase();
  if (s === 'available' || s === 'متاح' || s === 'متاحة') return 'available';
  if (s === 'reserved' || s === 'محجوز' || s === 'محجوزة') return 'reserved';
  if (s === 'sold' || s === 'مباع' || s === 'مباعة') return 'sold';
  return 'other';
}

function hostedVideo(url: string): { url: string; kind: 'youtube' | 'direct' | 'link'; youtube_id?: string } | null {
  if (!/^https?:\/\//i.test(url)) return null;
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (yt) return { url, kind: 'youtube', youtube_id: yt[1] };
  if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) || /\/storage\/v1\/object\/public\//.test(url)) {
    return { url, kind: 'direct' };
  }
  return { url, kind: 'link' };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Data loading ───────────────────────────────────────────────────────────

async function resolvePortal(svc: SupabaseClient, token: string): Promise<PortalRow | null> {
  const { data, error } = await svc
    .from('broker_portals')
    .select('id, developer_id, title_ar, title_en, is_active, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (error) throw new Error(`portal lookup failed: ${error.message}`);
  const row = data as PortalRow | null;
  if (!row || !row.is_active) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

async function loadModels(svc: SupabaseClient): Promise<{ projects: ModelRow; units: ModelRow; developers?: ModelRow }> {
  const { data, error } = await svc
    .from('models')
    .select('id, name, schema')
    .in('name', ['all_projects', 'units', 'developers']);
  if (error) throw new Error(`models lookup failed: ${error.message}`);
  const rows = (data ?? []) as ModelRow[];
  const projects = rows.find((r) => r.name === 'all_projects');
  const units = rows.find((r) => r.name === 'units');
  if (!projects || !units) throw new Error('all_projects / units model missing');
  return { projects, units, developers: rows.find((r) => r.name === 'developers') };
}

/** Page through a records query so a big developer is never silently cut at 1,000. */
async function loadAll(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<RecordRow[]> {
  const out: RecordRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`records lookup failed: ${error.message}`);
    const rows = (data ?? []) as RecordRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadGeoNames(svc: SupabaseClient, projects: RecordRow[]) {
  const districtIds = new Set<string>();
  const cityIds = new Set<string>();
  for (const p of projects) {
    const loc = (p.data.location ?? {}) as Json;
    const d = str(loc.district);
    const c = str(loc.city);
    if (d && UUID_RE.test(d)) districtIds.add(d);
    if (c && UUID_RE.test(c)) cityIds.add(c);
  }
  const districts = new Map<string, Bi>();
  const cities = new Map<string, Bi>();
  if (districtIds.size) {
    const { data, error } = await svc.from('districts').select('id, name_ar, name_en').in('id', [...districtIds]);
    if (error) console.error('[broker-portal] district names failed:', error.message);
    for (const r of (data ?? []) as Array<{ id: string; name_ar: string | null; name_en: string | null }>) {
      districts.set(r.id, { ar: r.name_ar ?? r.name_en ?? '', en: r.name_en ?? r.name_ar ?? '' });
    }
  }
  if (cityIds.size) {
    const { data, error } = await svc.from('cities').select('id, name_ar, name_en').in('id', [...cityIds]);
    if (error) console.error('[broker-portal] city names failed:', error.message);
    for (const r of (data ?? []) as Array<{ id: string; name_ar: string | null; name_en: string | null }>) {
      cities.set(r.id, { ar: r.name_ar ?? r.name_en ?? '', en: r.name_en ?? r.name_ar ?? '' });
    }
  }
  return { districts, cities };
}

function projectLocation(p: RecordRow, geo: Awaited<ReturnType<typeof loadGeoNames>>) {
  const loc = (p.data.location ?? {}) as Json;
  const d = str(loc.district);
  const c = str(loc.city);
  const lat = num(p.data.latitude);
  const lng = num(p.data.longitude);
  return {
    district: d ? geo.districts.get(d) ?? null : null,
    city: (c ? geo.cities.get(c) : null) ?? (str(p.data.city_name) ? { ar: str(p.data.city_name)!, en: str(p.data.city_name)! } : null),
    lat, lng,
    map_url: str(p.data.project_location) ?? (lat != null && lng != null ? `https://www.google.com/maps?q=${lat},${lng}` : null),
  };
}

async function loadLinkedFiles(svc: SupabaseClient, recordIds: string[]) {
  const links: LinkRow[] = [];
  for (let i = 0; i < recordIds.length; i += 150) {
    const { data, error } = await svc
      .from('file_links')
      .select('file_id, record_id, role')
      .in('record_id', recordIds.slice(i, i + 150));
    if (error) throw new Error(`file links lookup failed: ${error.message}`);
    links.push(...((data ?? []) as LinkRow[]));
  }
  const fileIds = [...new Set(links.map((l) => l.file_id))];
  const files = new Map<string, FileRow>();
  for (let i = 0; i < fileIds.length; i += 150) {
    const { data, error } = await svc
      .from('files')
      .select('id, kind, mime_type, original_name, title, size_bytes, storage_bucket, storage_path, width_px, height_px, duration_seconds, primary_category, confidentiality, status, archived_at, created_at')
      .in('id', fileIds.slice(i, i + 150));
    if (error) throw new Error(`files lookup failed: ${error.message}`);
    for (const f of (data ?? []) as FileRow[]) {
      if (f.status !== 'active' || f.archived_at) continue;
      if (f.confidentiality && !SHAREABLE_CONFIDENTIALITY.has(f.confidentiality)) continue;
      files.set(f.id, f);
    }
  }
  return { links: links.filter((l) => files.has(l.file_id)), files };
}

function downloadName(f: FileRow): string {
  const name = (f.original_name || f.title || 'file').trim().replace(/^�+/, '');
  const dot = f.storage_path.lastIndexOf('.');
  const ext = dot >= 0 ? f.storage_path.slice(dot + 1).toLowerCase() : '';
  return ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name;
}

interface SignedFile { url: string | null; thumb: string | null; download: string | null }

async function signFiles(svc: SupabaseClient, files: FileRow[]): Promise<Map<string, SignedFile>> {
  const out = new Map<string, SignedFile>();
  // Full views: one batch call per bucket.
  const byBucket = new Map<string, FileRow[]>();
  for (const f of files) {
    const list = byBucket.get(f.storage_bucket) ?? [];
    list.push(f);
    byBucket.set(f.storage_bucket, list);
  }
  for (const [bucket, list] of byBucket) {
    const { data, error } = await svc.storage.from(bucket).createSignedUrls(list.map((f) => f.storage_path), PORTAL_URL_TTL_SECONDS);
    if (error) console.error('[broker-portal] batch sign failed:', error.message);
    const byPath = new Map<string, string>();
    for (const d of data ?? []) if (d.path && d.signedUrl) byPath.set(d.path, d.signedUrl);
    for (const f of list) out.set(f.id, { url: byPath.get(f.storage_path) ?? null, thumb: null, download: null });
  }
  // Thumbnails (images) and named downloads (everything) need per-file calls.
  await mapLimit(files, 16, async (f) => {
    const entry = out.get(f.id)!;
    if (f.kind === 'image') {
      const { data, error } = await svc.storage.from(f.storage_bucket).createSignedUrl(f.storage_path, PORTAL_URL_TTL_SECONDS, {
        transform: { width: 640, height: 640, resize: 'contain', quality: 70 },
      });
      if (error) console.error('[broker-portal] thumb sign failed:', f.id, error.message);
      entry.thumb = data?.signedUrl ?? entry.url;
    }
    const { data, error } = await svc.storage.from(f.storage_bucket).createSignedUrl(f.storage_path, PORTAL_URL_TTL_SECONDS, {
      download: downloadName(f),
    });
    if (error) console.error('[broker-portal] download sign failed:', f.id, error.message);
    entry.download = data?.signedUrl ?? null;
  });
  return out;
}

// ── Actions ────────────────────────────────────────────────────────────────

function projectCard(
  p: RecordRow,
  labels: LabelMap,
  geo: Awaited<ReturnType<typeof loadGeoNames>>,
) {
  const d = p.data;
  return {
    id: p.id,
    name: str(d.project_name) ?? '',
    // "unknown" is a data-quality marker, not something to show a broker.
    status: str(d.project_status) === 'unknown' ? null : label(labels, 'project_status', d.project_status),
    construction_status: label(labels, 'construction_status', d.construction_status),
    unit_types: labelList(labels, 'unit_types', d.unit_types),
    location: projectLocation(p, geo),
    unit_count: num(d.unit_count) ?? 0,
    available_units: num(d.available_units) ?? 0,
    reserved_units: num(d.reserved_units) ?? 0,
    sold_units: num(d.sold_units) ?? 0,
    available_price_range: range(d.available_price_range),
    available_area_range: range(d.available_area_range),
    bedroom_range: range(d.bedroom_range),
    avg_price_per_m2: num(d.avg_price_per_m2),
    handover_date: str(d.handover_date),
    down_payment_percent: num(d.down_payment_percent),
  };
}

async function overview(svc: SupabaseClient, portal: PortalRow): Promise<Response> {
  const models = await loadModels(svc);
  const projLabels = buildLabels(models.projects);
  const [devRes, projects] = await Promise.all([
    svc.from('records').select('id, data').eq('id', portal.developer_id).maybeSingle(),
    loadAll((a, b) =>
      svc.from('records').select('id, data').eq('model_id', models.projects.id)
        .eq('data->>developer', portal.developer_id).order('id').range(a, b),
    ),
  ]);
  if (devRes.error) throw new Error(`developer lookup failed: ${devRes.error.message}`);
  const dev = (devRes.data as RecordRow | null)?.data ?? {};
  const geo = await loadGeoNames(svc, projects);

  // Cover image per project: main_image, else first project_images id.
  const coverIds = new Map<string, string>();
  for (const p of projects) {
    const candidates = [str(p.data.main_image), ...arr(p.data.project_images).map(str)];
    const id = candidates.find((c): c is string => !!c && UUID_RE.test(c));
    if (id) coverIds.set(p.id, id);
  }
  // No cover field set → the best linked image (hero/main/gallery before
  // marketing designs; landscape before portrait).
  const missing = projects.filter((p) => !coverIds.has(p.id)).map((p) => p.id);
  if (missing.length) {
    const { links, files } = await loadLinkedFiles(svc, missing);
    const ROLE_RANK: Record<string, number> = { hero_image: 0, main_image: 1, gallery_image: 2, attachment: 3, marketing_asset: 4, social_post: 5 };
    const best = new Map<string, { id: string; score: number }>();
    for (const l of links) {
      const f = files.get(l.file_id);
      if (!f || f.kind !== 'image' || l.role === 'floor_plan' || f.primary_category === 'unit_plan') continue;
      const landscape = (f.width_px ?? 0) >= (f.height_px ?? 1) ? 0 : 10;
      const score = (ROLE_RANK[l.role ?? ''] ?? 6) + landscape;
      const cur = best.get(l.record_id);
      if (!cur || score < cur.score) best.set(l.record_id, { id: f.id, score });
    }
    for (const [pid, b] of best) coverIds.set(pid, b.id);
  }

  const coverFiles: FileRow[] = [];
  if (coverIds.size) {
    const { data, error } = await svc
      .from('files')
      .select('id, kind, mime_type, original_name, title, size_bytes, storage_bucket, storage_path, width_px, height_px, duration_seconds, primary_category, confidentiality, status, archived_at, created_at')
      .in('id', [...new Set(coverIds.values())]);
    if (error) console.error('[broker-portal] cover lookup failed:', error.message);
    for (const f of (data ?? []) as FileRow[]) {
      if (f.status === 'active' && !f.archived_at && f.kind === 'image') coverFiles.push(f);
    }
  }
  const covers = new Map<string, string>();
  await mapLimit(coverFiles, 16, async (f) => {
    const { data, error } = await svc.storage.from(f.storage_bucket).createSignedUrl(f.storage_path, PORTAL_URL_TTL_SECONDS, {
      transform: { width: 900, height: 600, resize: 'cover', quality: 72 },
    });
    if (error) console.error('[broker-portal] cover sign failed:', f.id, error.message);
    if (data?.signedUrl) covers.set(f.id, data.signedUrl);
  });

  const cards = projects.map((p) => {
    const fid = coverIds.get(p.id);
    return { ...projectCard(p, projLabels, geo), cover: fid ? covers.get(fid) ?? null : null };
  });
  // Projects with stock first, then by size.
  cards.sort((a, b) => (b.available_units - a.available_units) || (b.unit_count - a.unit_count) || a.name.localeCompare(b.name, 'ar'));

  void svc.rpc('broker_portal_record_view', { p_id: portal.id }).then(({ error }) => {
    if (error) console.error('[broker-portal] view bump failed:', error.message);
  });

  return jsonOk({
    portal: { title_ar: portal.title_ar, title_en: portal.title_en },
    developer: {
      name: str(dev.name) ?? '',
      phone: str(dev.phone),
      website: str(dev.website),
    },
    projects: cards,
    expires_at: new Date(Date.now() + PORTAL_URL_TTL_SECONDS * 1000).toISOString(),
  });
}

/** Where a linked file shows up on the page. */
function sectionOf(role: string | null, f: FileRow): 'photos' | 'videos' | 'library' | 'documents' | 'plans' {
  if (role === 'floor_plan' || f.primary_category === 'unit_plan') return 'plans';
  if (role === 'marketing_asset' || role === 'social_post') {
    return f.kind === 'pdf' ? 'documents' : 'library';
  }
  if (f.kind === 'video') return 'videos';
  if (f.kind === 'image') return 'photos';
  return 'documents';
}
const SECTION_RANK = { plans: 0, library: 1, videos: 2, documents: 3, photos: 4 } as const;

async function projectDetail(svc: SupabaseClient, portal: PortalRow, projectId: string): Promise<Response> {
  const models = await loadModels(svc);
  const projLabels = buildLabels(models.projects);
  const unitLabels = buildLabels(models.units);

  const { data: pData, error: pErr } = await svc
    .from('records').select('id, data').eq('id', projectId).eq('model_id', models.projects.id).maybeSingle();
  if (pErr) throw new Error(`project lookup failed: ${pErr.message}`);
  const project = pData as RecordRow | null;
  // Same 404 whether the project is missing or belongs to another developer.
  if (!project || str(project.data.developer) !== portal.developer_id) return jsonError(404, 'project not available');

  const units = await loadAll((a, b) =>
    svc.from('records').select('id, data').eq('model_id', models.units.id)
      .eq('data->>project_id', projectId).order('id').range(a, b),
  );
  const geo = await loadGeoNames(svc, [project]);
  const { links, files } = await loadLinkedFiles(svc, [project.id, ...units.map((u) => u.id)]);

  // Field-held file ids (main_image / project_images / unit_plan) are already
  // projected into file_links by its triggers (source_key 'field:…').
  const signed = await signFiles(svc, [...files.values()]);

  // One entry per file, placed in its most specific section.
  const unitIds = new Set(units.map((u) => u.id));
  const placed = new Map<string, { section: keyof typeof SECTION_RANK; unit_ids: string[] }>();
  for (const l of links) {
    const f = files.get(l.file_id)!;
    const section = sectionOf(l.role, f);
    const cur = placed.get(f.id);
    const unit_ids = cur?.unit_ids ?? [];
    if (unitIds.has(l.record_id) && !unit_ids.includes(l.record_id)) unit_ids.push(l.record_id);
    if (!cur || SECTION_RANK[section] < SECTION_RANK[cur.section]) placed.set(f.id, { section, unit_ids });
    else cur.unit_ids = unit_ids;
  }
  const mediaFiles = [...placed.entries()].map(([id, p]) => {
    const f = files.get(id)!;
    const s = signed.get(id);
    return {
      id,
      section: p.section,
      kind: f.kind,
      mime_type: f.mime_type,
      name: (f.title || f.original_name || '').replace(/^�+/, '').trim(),
      size_bytes: f.size_bytes,
      width: f.width_px,
      height: f.height_px,
      duration_seconds: f.duration_seconds,
      url: s?.url ?? null,
      thumb: s?.thumb ?? null,
      download: s?.download ?? null,
      unit_ids: p.unit_ids,
      created_at: f.created_at,
    };
  }).filter((m) => m.url);

  // Plan file per unit: the unit_plan field wins, else a floor_plan link.
  const planByUnit = new Map<string, string>();
  for (const m of mediaFiles) if (m.section === 'plans') for (const u of m.unit_ids) if (!planByUnit.has(u)) planByUnit.set(u, m.id);

  const d = project.data;
  const hostedVideos = arr(d.project_videos)
    .map(str)
    .filter((u): u is string => !!u && !UUID_RE.test(u))
    .map(hostedVideo)
    .filter((v): v is NonNullable<ReturnType<typeof hostedVideo>> => v != null);

  const unitRows = units.map((u) => {
    const x = u.data;
    const planField = str(x.unit_plan);
    const planId = planField && placed.has(planField) ? planField : planByUnit.get(u.id) ?? null;
    return {
      id: u.id,
      code: str(x.unit_code),
      number: str(x.unit_number),
      building: str(x.building_number),
      model: str(x.unit_model),
      type: label(unitLabels, 'unit_type', x.unit_type),
      floor: label(unitLabels, 'floor', x.floor),
      bedrooms: num(x.bedrooms),
      bathrooms: num(x.bathrooms),
      area: num(x.unit_area),
      price: num(x.total_price),
      status: statusKey(x.unit_status),
      status_label: label(unitLabels, 'unit_status', x.unit_status),
      components: labelList(unitLabels, 'unit_components', x.unit_components),
      payment_plans: arr(x.payment_plans).map((r) => {
        const p = (r ?? {}) as Json;
        return {
          plan: str(p.plan),
          down: num(p.down),
          before_handover: num(p.before_handover),
          on_handover: num(p.on_handover),
          after_handover: num(p.after_handover),
          schedule: str(p.schedule),
        };
      }),
      plan_file_id: planId,
    };
  });

  return jsonOk({
    project: {
      ...projectCard(project, projLabels, geo),
      description: str(d.marketing_document),
      features: arr(d.features).map((r) => str((r as Json)?.feature)).filter((x): x is string => !!x),
      services: arr(d.services).map((r) => {
        const o = (r ?? {}) as Json;
        return { service: str(o.service), notes: str(o.notes) };
      }).filter((s) => s.service),
      guarantees: arr(d.guarantees).map((r) => {
        const o = (r ?? {}) as Json;
        return { item: str(o.col_1), period: str(o.col_3) };
      }).filter((g) => g.item),
      landmarks: arr(d.nearby_landmarks).map((r) => {
        const o = (r ?? {}) as Json;
        return { name: str(o.landmark), duration: str(o.duration), distance: str(o.distance) };
      }).filter((l) => l.name),
      payment_plans: arr(d.payment_plan_schedule).map((r) => {
        const p = (r ?? {}) as Json;
        return {
          plan: str(p.plan),
          down: num(p.down),
          during_construction: num(p.during_construction),
          on_handover: num(p.on_handover),
          post_handover: num(p.post_handover),
          schedule: str(p.schedule),
        };
      }),
      payment_plan_summary: str(d.payment_plan_summary),
      links: {
        developer_brochure: str(d.broucher_developer),
        brochure: str(d.brochure_link),
        page: str(d.project_page_url),
      },
    },
    units: unitRows,
    files: mediaFiles,
    hosted_videos: hostedVideos,
    expires_at: new Date(Date.now() + PORTAL_URL_TTL_SECONDS * 1000).toISOString(),
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  let body: { token?: unknown; action?: unknown; projectId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid JSON body');
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || token.length > 128) return jsonError(400, 'token is required');

  const svc = makeServiceClient('api:broker-portal');
  if (!svc) return jsonError(500, 'Supabase env vars missing');

  try {
    const portal = await resolvePortal(svc, token);
    if (!portal) return jsonError(404, 'link not available');
    if (body.action === 'project') {
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      if (!UUID_RE.test(projectId)) return jsonError(400, 'projectId is required');
      return await projectDetail(svc, portal, projectId);
    }
    return await overview(svc, portal);
  } catch (e) {
    console.error('[broker-portal] failed:', (e as Error).message);
    return jsonError(500, (e as Error).message);
  }
}
