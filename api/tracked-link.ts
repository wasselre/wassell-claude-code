/**
 * POST /api/tracked-link  (ANONYMOUS — powers the public /v/:token pages)
 *
 * Body:
 *   { token, action: 'page', section }  → the page data for one section
 *                                         (photos | videos | brochure | units | location),
 *                                         or the unit page for a unit link
 *   { token, action: 'unit', unitId }   → one unit's details (opened from /units)
 *   { token, action: 'track', session, events: [...] } → record what the customer did
 *
 * Security posture (same as /api/broker-portal and /api/share/view):
 *   - The token is resolved with the service role against `tracked_links`
 *     (anon has no grant). An unknown token returns the same 404 as any failure.
 *   - A unit is served only when it belongs to the link's project.
 *   - Only a WHITELISTED projection leaves the server — no internal notes,
 *     sources or analyses; sold/reserved units are never listed; prices are the
 *     AVAILABLE ranges only.
 *   - Files are short-lived signed URLs, from the same send-safety filters as
 *     WhatsApp sends (api/_lib/trackedLinks.ts).
 *   - Tracking accepts only known event kinds/sections, bounded values, and at
 *     most MAX_EVENTS per call — a noisy client cannot flood the table. No IP
 *     address or user agent is stored.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonError, jsonOk } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
import {
  loadProjectMedia, loadAvailableUnits, mapsUrl, SECTION_ORDER,
  type LinkSection, type ProjectFile,
} from './_lib/trackedLinks.js';

export const config = { runtime: 'edge' };

const URL_TTL_SECONDS = 60 * 60 * 6;
const LINK_LIFETIME_DAYS = 365;
const MAX_EVENTS = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9]{8,32}$/;
const KINDS = new Set(['view', 'photo_open', 'video_play', 'video_progress', 'time', 'brochure_page', 'map_open', 'unit_open', 'units_filter']);
const SECTIONS = new Set(['photos', 'videos', 'brochure', 'location', 'units', 'unit']);

interface LinkRow { id: string; project_id: string; unit_id: string | null; sections: string[]; created_at: string }

function str(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
}
function range(v: unknown): { min: number | null; max: number | null } {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { min: num(o.min), max: num(o.max) };
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.replace(/-/g, ' ').trim()) : [];
}

async function resolveLink(svc: SupabaseClient, token: string): Promise<LinkRow | null> {
  const { data, error } = await svc.from('tracked_links').select('id, project_id, unit_id, sections, created_at').eq('token', token).maybeSingle();
  if (error) throw new Error(`link lookup failed: ${error.message}`);
  const l = data as LinkRow | null;
  if (!l) return null;
  if (Date.now() - new Date(l.created_at).getTime() > LINK_LIFETIME_DAYS * 86_400_000) return null;
  return l;
}

async function sign(svc: SupabaseClient, f: ProjectFile, opts?: { width?: number }): Promise<string | null> {
  const { data, error } = await svc.storage.from(f.storage_bucket).createSignedUrl(
    f.storage_path, URL_TTL_SECONDS,
    opts?.width ? { transform: { width: opts.width, height: opts.width, resize: 'contain', quality: 72 } } : undefined,
  );
  if (error) { console.error('[tracked-link] sign failed:', f.id, error.message); return null; }
  return data?.signedUrl ?? null;
}

async function signById(svc: SupabaseClient, fileId: string, width?: number): Promise<string | null> {
  const { data, error } = await svc.from('files').select('id, storage_bucket, storage_path, status, archived_at, confidentiality').eq('id', fileId).maybeSingle();
  if (error) { console.error('[tracked-link] file read failed:', fileId, error.message); return null; }
  const f = data as { storage_bucket: string; storage_path: string; status: string | null; archived_at: string | null; confidentiality: string | null } | null;
  if (!f || f.status !== 'active' || f.archived_at || (f.confidentiality && !['internal', 'public'].includes(f.confidentiality))) return null;
  return sign(svc, f as unknown as ProjectFile, width ? { width } : undefined);
}

async function districtName(svc: SupabaseClient, record: Record<string, unknown>): Promise<{ district: string | null; city: string | null }> {
  const loc = record.location && typeof record.location === 'object' ? (record.location as Record<string, unknown>) : {};
  const id = str(loc.district);
  if (!id) return { district: null, city: null };
  const { data, error } = await svc.from('districts').select('display_name, name_ar, city_name_ar').eq('id', id).maybeSingle();
  if (error) { console.error('[tracked-link] district read failed:', error.message); return { district: null, city: null }; }
  const d = data as { display_name?: string | null; name_ar?: string | null; city_name_ar?: string | null } | null;
  return { district: str(d?.display_name) ?? str(d?.name_ar), city: str(d?.city_name_ar) };
}

function readiness(d: Record<string, unknown>): 'ready' | 'off_plan' | null {
  const cs = String(d.construction_status ?? '').trim().toLowerCase();
  const ps = String(d.project_status ?? '').trim().toLowerCase();
  if (cs === 'ready' || cs === 'جاهز' || ps === 'available' || ps === 'ready') return 'ready';
  return cs || ps ? 'off_plan' : null;
}

function unitSummary(u: { id: string; data: Record<string, unknown> }) {
  const d = u.data;
  return {
    id: u.id,
    code: str(d.unit_code) ?? str(d.unit_number),
    type: str(d.unit_type),
    bedrooms: num(d.bedrooms),
    bathrooms: num(d.bathrooms),
    area: num(d.unit_area) ?? num(d.total_area),
    price: num(d.total_price),
    floor: str(d.floor),
  };
}

function unitDetail(u: { id: string; data: Record<string, unknown> }) {
  const d = u.data;
  return {
    ...unitSummary(u),
    total_area: num(d.total_area),
    private_area: num(d.private_area),
    facade: str(d.facade),
    parking: str(d.parking_space),
    model: str(d.unit_model),
    components: list(d.unit_components),
  };
}

async function header(svc: SupabaseClient, projectId: string, record: Record<string, unknown>, cover: ProjectFile | null) {
  const price = range(record.available_price_range);
  const place = await districtName(svc, record);
  return {
    name: str(record.project_name) ?? '',
    district: place.district,
    city: place.city,
    readiness: readiness(record),
    handover_date: str(record.handover_date)?.slice(0, 10) ?? null,
    price_from: price.min,
    price_to: price.max,
    cover_url: cover ? await sign(svc, cover, { width: 1200 }) : null,
    project_id: projectId,
  };
}

async function page(svc: SupabaseClient, link: LinkRow, section: string): Promise<Response> {
  const media = await loadProjectMedia(svc, link.project_id);
  if (!media) return jsonError(404, 'link not available');
  const head = await header(svc, link.project_id, media.record, media.cover);

  // A UNIT link: that unit's page.
  if (link.unit_id) {
    const { data, error } = await svc.from('records').select('id, data').eq('id', link.unit_id).maybeSingle();
    if (error) throw new Error(`unit read failed: ${error.message}`);
    const u = data as { id: string; data: Record<string, unknown> } | null;
    if (!u || String(u.data?.project_id ?? '') !== link.project_id) return jsonError(404, 'link not available');
    const planId = str(u.data?.unit_plan);
    return jsonOk({ kind: 'unit', project: head, unit: { ...unitDetail(u), plan_url: planId ? await signById(svc, planId, 1400) : null } });
  }

  const sections = SECTION_ORDER.filter((s) => link.sections.includes(s));
  const s = (sections.includes(section as LinkSection) ? section : sections[0]) as LinkSection | undefined;
  const out: Record<string, unknown> = { kind: 'project', project: head, sections, section: s ?? null };
  if (s === 'photos') {
    out.photos = await Promise.all(media.photos.map(async (f) => ({
      id: f.id, thumb: await sign(svc, f, { width: 640 }), url: await sign(svc, f, { width: 1600 }),
    })));
  } else if (s === 'videos') {
    out.videos = [
      ...(await Promise.all(media.videos.map(async (f) => ({ id: f.id, url: await sign(svc, f), duration: f.duration_seconds, title: f.title })))),
      ...media.externalVideos.map((u) => ({ id: u, url: u, external: true })),
    ];
  } else if (s === 'brochure') {
    out.brochure = media.brochure
      ? { id: media.brochure.id, url: await sign(svc, media.brochure), name: media.brochure.title || media.brochure.original_name }
      : { id: 'external', url: media.brochureUrl, external: true };
  } else if (s === 'units') {
    const units = await loadAvailableUnits(svc, link.project_id);
    out.units = units.map(unitSummary).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  } else if (s === 'location') {
    out.location = { maps_url: mapsUrl(media.record), district: head.district, city: head.city };
  }
  return jsonOk(out);
}

async function unit(svc: SupabaseClient, link: LinkRow, unitId: string): Promise<Response> {
  const { data, error } = await svc.from('records').select('id, data').eq('id', unitId).maybeSingle();
  if (error) throw new Error(`unit read failed: ${error.message}`);
  const u = data as { id: string; data: Record<string, unknown> } | null;
  if (!u || String(u.data?.project_id ?? '') !== link.project_id) return jsonError(404, 'unit not available');
  const planId = str(u.data?.unit_plan);
  return jsonOk({ unit: { ...unitDetail(u), plan_url: planId ? await signById(svc, planId, 1400) : null } });
}

async function track(svc: SupabaseClient, link: LinkRow, session: string, events: unknown): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(session)) return jsonError(400, 'session is required');
  if (!Array.isArray(events) || events.length === 0) return jsonOk({ recorded: 0 });
  const rows = [];
  for (const e of events.slice(0, MAX_EVENTS) as Array<Record<string, unknown>>) {
    const kind = typeof e.kind === 'string' ? e.kind : '';
    if (!KINDS.has(kind)) continue;
    const section = typeof e.section === 'string' && SECTIONS.has(e.section) ? e.section : null;
    const item = typeof e.item === 'string' ? e.item.slice(0, 200) : null;
    let value = typeof e.value === 'number' && Number.isFinite(e.value) ? e.value : null;
    if (kind === 'time') value = value === null ? null : Math.min(Math.max(value, 0), 120);   // one beat ≤ 2 min
    if (kind === 'video_progress') value = value === null ? null : Math.min(Math.max(Math.round(value), 0), 100);
    if (kind === 'time' && !value) continue;
    rows.push({ link_id: link.id, session_id: session, kind, section, item, value });
  }
  if (!rows.length) return jsonOk({ recorded: 0 });
  const { error } = await svc.from('tracked_link_events').insert(rows);
  if (error) throw new Error(`event insert failed: ${error.message}`);
  return jsonOk({ recorded: rows.length });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  let body: { token?: unknown; action?: unknown; section?: unknown; unitId?: unknown; session?: unknown; events?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid JSON body');
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!TOKEN_RE.test(token)) return jsonError(404, 'link not available');

  const svc = makeServiceClient('api:tracked-link');
  if (!svc) return jsonError(500, 'Supabase env vars missing');
  try {
    const link = await resolveLink(svc, token);
    if (!link) return jsonError(404, 'link not available');
    if (body.action === 'track') return await track(svc, link, typeof body.session === 'string' ? body.session : '', body.events);
    if (body.action === 'unit') {
      const unitId = typeof body.unitId === 'string' ? body.unitId : '';
      if (!UUID_RE.test(unitId)) return jsonError(400, 'unitId is required');
      return await unit(svc, link, unitId);
    }
    return await page(svc, link, typeof body.section === 'string' ? body.section : '');
  } catch (e) {
    console.error('[tracked-link] failed:', (e as Error).message);
    return jsonError(500, 'temporarily unavailable');
  }
}
