/**
 * Tracked project links — the server side.
 *
 * A project message carries per-customer links to our own light pages instead
 * of heavy files: /v/<token>/photos, /videos, /brochure, /units, /location — and
 * a UNIT link (/v/<token>) shows one unit's details instead of the unit PDF. One
 * token per sent message; the page reports what the customer does
 * (tracked_link_events) and the CRM reads it back as engagement + an interest
 * score (migrations 2026-09-29_tracked_links*.sql).
 *
 * Media go through the SAME send-safety filters as WhatsApp sends (rights,
 * competitor posters, our designs, floor plans out of the photo gallery, tiny
 * icons), so the page never shows a customer something a send would not.
 * Customer-facing prices are the AVAILABLE family only (CLAUDE.md rollups).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isSendable, isOfferableSocialItem, isSendableCategory, isBrochureFile, isUnitPlanFile,
} from '../../src/pages/Chats/lib/projectFilePicker.js';
import { replaceLinksInMessage } from '../../src/lib/trackedLinks/text.js';

export type LinkSection = 'photos' | 'videos' | 'brochure' | 'units' | 'location';
export const SECTION_ORDER: LinkSection[] = ['photos', 'videos', 'brochure', 'units', 'location'];
export type SentVia = 'agent' | 'bot' | 'rep' | 'bulk' | 'broker' | 'other';

const SHAREABLE_CONFIDENTIALITY = new Set(['internal', 'public']);
const MAX_PHOTOS = 40;
const MAX_VIDEOS = 12;
// An icon / logo / thumbnail is not a project photo (the amenity-icon lesson).
const MIN_PHOTO_SIDE_PX = 300;
const MIN_PHOTO_BYTES = 40_000;

export function appOrigin(): string {
  return (process.env.APP_URL || 'https://app.wassel.re').replace(/\/+$/, '');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** 10 chars from an unambiguous 56-symbol alphabet ≈ 58 bits — unguessable, short. */
export function newToken(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export interface ProjectFile {
  id: string; kind: string; mime_type: string | null; title: string | null; original_name: string | null;
  storage_bucket: string; storage_path: string; width_px: number | null; height_px: number | null;
  size_bytes: number | null; duration_seconds: number | null; primary_category: string | null;
  document_type: string | null; origin: string | null; usage_rights: string | null;
  acquisition_source: string | null; confidentiality: string | null; status: string | null;
  archived_at: string | null; created_at: string;
}
const FILE_COLS = 'id, kind, mime_type, title, original_name, storage_bucket, storage_path, width_px, height_px, size_bytes, duration_seconds, primary_category, document_type, origin, usage_rights, acquisition_source, confidentiality, status, archived_at, created_at';

export interface ProjectMedia {
  record: Record<string, unknown>;
  photos: ProjectFile[];
  videos: ProjectFile[];
  externalVideos: string[];
  brochure: ProjectFile | null;
  brochureUrl: string | null;
  cover: ProjectFile | null;
}

function str(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
}
function isHttp(v: unknown): v is string { return typeof v === 'string' && /^https?:\/\//i.test(v.trim()); }

function tooSmall(f: ProjectFile): boolean {
  if (f.width_px != null && f.height_px != null) return Math.min(f.width_px, f.height_px) < MIN_PHOTO_SIDE_PX;
  return f.size_bytes != null && f.size_bytes < MIN_PHOTO_BYTES;
}
// The picker's field types are stricter about null than this lean query; the
// fields it reads are compatible, so cast at the boundary (as the cron does).
type PickerFile = Parameters<typeof isOfferableSocialItem>[0] & Parameters<typeof isUnitPlanFile>[0]
  & Parameters<typeof isSendable>[0] & Parameters<typeof isSendableCategory>[0];
const pf = (f: ProjectFile) => f as unknown as PickerFile;

function customerSafe(f: ProjectFile): boolean {
  if (f.status !== 'active' || f.archived_at) return false;
  if (f.confidentiality && !SHAREABLE_CONFIDENTIALITY.has(f.confidentiality)) return false;
  return isSendable(pf(f)) && isOfferableSocialItem(pf(f)) && isSendableCategory(pf(f));
}

export async function loadProjectRecord(svc: SupabaseClient, projectId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await svc.from('records').select('id, data').eq('id', projectId).maybeSingle();
  if (error) throw new Error(`project read failed: ${error.message}`);
  return ((data as { data: Record<string, unknown> } | null)?.data ?? null);
}

/** Everything a customer may see for this project, filtered and ordered. */
export async function loadProjectMedia(svc: SupabaseClient, projectId: string): Promise<ProjectMedia | null> {
  const record = await loadProjectRecord(svc, projectId);
  if (!record) return null;
  const { data: links, error: lErr } = await svc.from('file_links').select('file_id, role').eq('record_id', projectId);
  if (lErr) throw new Error(`file links read failed: ${lErr.message}`);
  const roleOf = new Map<string, string | null>();
  for (const l of (links ?? []) as Array<{ file_id: string; role: string | null }>) if (!roleOf.has(l.file_id)) roleOf.set(l.file_id, l.role);
  const ids = [...roleOf.keys()];
  const files: ProjectFile[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await svc.from('files').select(FILE_COLS).in('id', ids.slice(i, i + 150));
    if (error) throw new Error(`files read failed: ${error.message}`);
    files.push(...((data ?? []) as ProjectFile[]));
  }
  const safe = files.filter(customerSafe);

  const mainImageId = str(record.main_image);
  const area = (f: ProjectFile) => (f.width_px ?? 0) * (f.height_px ?? 0);
  const photoRank = (f: ProjectFile) => (f.id === mainImageId || roleOf.get(f.id) === 'main_image' ? 0 : f.primary_category === 'hero_image' ? 1 : 2);
  const photos = safe
    .filter((f) => f.kind === 'image' && !isUnitPlanFile(pf(f)) && !tooSmall(f))
    .sort((a, b) => photoRank(a) - photoRank(b) || area(b) - area(a))
    .slice(0, MAX_PHOTOS);
  const videos = safe
    .filter((f) => f.kind === 'video')
    .sort((a, b) => (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0))
    .slice(0, MAX_VIDEOS);
  const brochure = safe
    .filter((f) => (f.kind === 'pdf' || f.mime_type === 'application/pdf') && isBrochureFile(pf(f), f.title || f.original_name || ''))
    .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))[0] ?? null;
  const externalVideos = (Array.isArray(record.project_videos) ? record.project_videos : []).filter(isHttp);
  return {
    record,
    photos,
    videos,
    externalVideos,
    brochure,
    brochureUrl: brochure ? null : (isHttp(record.brochure_link) ? record.brochure_link.trim() : null),
    cover: photos[0] ?? null,
  };
}

/** The Google Maps address of the project, if we know where it is. */
export function mapsUrl(record: Record<string, unknown>): string | null {
  if (isHttp(record.project_location)) return String(record.project_location).trim();
  const lat = num(record.latitude); const lng = num(record.longitude);
  return lat !== null && lng !== null ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null;
}

const AVAILABLE = new Set(['available', 'متاح', 'متاحة', 'متوفر', 'متوفرة']);

export interface UnitRow { id: string; data: Record<string, unknown> }

/** The project's AVAILABLE units (customers never see sold/reserved stock). */
export async function loadAvailableUnits(svc: SupabaseClient, projectId: string): Promise<UnitRow[]> {
  const { data: m, error: mErr } = await svc.from('models').select('id').eq('name', 'units').maybeSingle();
  if (mErr) throw new Error(`units model read failed: ${mErr.message}`);
  if (!m?.id) return [];
  const out: UnitRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc.from('records').select('id, data')
      .eq('model_id', m.id as string).eq('data->>project_id', projectId).order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`units read failed: ${error.message}`);
    for (const u of (data ?? []) as UnitRow[]) {
      if (AVAILABLE.has(String(u.data?.unit_status ?? '').trim().toLowerCase())) out.push(u);
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Which links this project can offer right now. */
export async function availableSections(svc: SupabaseClient, projectId: string): Promise<{ sections: LinkSection[]; media: ProjectMedia | null }> {
  const media = await loadProjectMedia(svc, projectId);
  if (!media) return { sections: [], media: null };
  const units = await loadAvailableUnits(svc, projectId);
  const sections: LinkSection[] = [];
  if (media.photos.length) sections.push('photos');
  if (media.videos.length || media.externalVideos.length) sections.push('videos');
  if (media.brochure || media.brochureUrl) sections.push('brochure');
  if (units.length) sections.push('units');
  if (mapsUrl(media.record)) sections.push('location');
  return { sections, media };
}

export interface CreatedLink {
  token: string;
  sections: LinkSection[];
  urls: Partial<Record<LinkSection, string>>;
  /** The unit page (unit links only). */
  unitUrl: string | null;
  /** The cover photo to attach to the message (project links only). */
  cover: ProjectFile | null;
}

/** The chat's linked client, if any (so interest shows on the client too). */
async function chatClientId(svc: SupabaseClient, conversationRecordId: string): Promise<string | null> {
  const { data, error } = await svc.from('records').select('data').eq('id', conversationRecordId).maybeSingle();
  if (error) { console.error('[trackedLinks] chat record read failed:', error.message); return null; }
  const v = (data as { data?: Record<string, unknown> } | null)?.data?.client_link;
  return typeof v === 'string' && v ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
}

/**
 * Mint one tracked link for one outgoing message. `conversationRecordId` is the
 * chats record (RLS: whoever can see the chat can see its engagement).
 */
export async function createTrackedLink(
  svc: SupabaseClient,
  a: {
    projectId: string; unitId?: string | null; chatWid?: string | null; conversationRecordId?: string | null;
    /** What the message is about: the whole project (default), its units list,
     *  or one unit (implied by `unitId`). Only labels the link — the project's
     *  interest sums every kind. */
    focus?: 'project' | 'units' | null;
    clientId?: string | null; deviceId?: string | null; sentVia: SentVia; userId?: string | null;
  },
): Promise<CreatedLink> {
  const token = newToken();
  let sections: LinkSection[] = [];
  let cover: ProjectFile | null = null;
  if (!a.unitId) {
    const r = await availableSections(svc, a.projectId);
    sections = r.sections;
    cover = r.media?.cover ?? null;
  }
  const clientId = a.clientId ?? (a.conversationRecordId ? await chatClientId(svc, a.conversationRecordId) : null);
  const { error } = await svc.from('tracked_links').insert({
    token, project_id: a.projectId, unit_id: a.unitId ?? null, chat_wid: a.chatWid ?? null,
    focus: a.unitId ? 'unit' : a.focus === 'units' ? 'units' : 'project',
    conversation_record_id: a.conversationRecordId ?? null, client_id: clientId, device_id: a.deviceId ?? null,
    sent_via: a.sentVia, sections, created_by_user_id: a.userId ?? null,
  });
  if (error) throw new Error(`tracked link insert failed: ${error.message}`);
  const base = `${appOrigin()}/v/${token}`;
  const urls: Partial<Record<LinkSection, string>> = {};
  for (const s of sections) urls[s] = `${base}/${s}`;
  return { token, sections, urls, unitUrl: a.unitId ? base : null, cover };
}

const LABEL: Record<'ar' | 'en', Record<LinkSection, string>> = {
  ar: { photos: '📸 الصور', videos: '🎥 الفيديوهات', brochure: '📄 البروشور', units: '🏠 الوحدات المتاحة', location: '📍 الموقع' },
  en: { photos: '📸 Photos', videos: '🎥 Videos', brochure: '📄 Brochure', units: '🏠 Available units', location: '📍 Location' },
};

/** The links block appended to a project message. */
export function linksBlock(urls: Partial<Record<LinkSection, string>>, lang: 'ar' | 'en'): string {
  return SECTION_ORDER.filter((s) => urls[s]).map((s) => `${LABEL[lang][s]}: ${urls[s]}`).join('\n');
}

/** The message with its website link (and any earlier tracked links) replaced by this message's links. */
export function withTrackedLinks(body: string, urls: Partial<Record<LinkSection, string>>, lang: 'ar' | 'en'): string {
  return replaceLinksInMessage(body, linksBlock(urls, lang));
}

/** Map a send's job id to who sent it. */
export function sentViaOf(jobId: string | null | undefined): SentVia {
  if (!jobId) return 'other';
  if (jobId === 'agent') return 'agent';
  if (jobId === 'basic' || jobId.startsWith('ai')) return 'bot';
  if (jobId.startsWith('broker')) return 'broker';
  return 'other';
}
