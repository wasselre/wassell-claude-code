/**
 * "Send to client" helpers — shared by the Project Finder cards, the Client
 * Options cards, and the WhatsApp flows they launch. Pure functions over the
 * store's chat_templates / project / listing records; no I/O.
 *
 * A "prepared message" is a chat_templates record linked to the source:
 *   • projects  → data.project_id  (all_projects id; created by
 *     ProjectWhatsAppFlow / the Generate-project-messages tool)
 *   • listings  → data.listing_id + data.status === 'ready' (created by
 *     ListingMessageModal — drafts mid-cleaning are NOT ready and never send)
 */

import type { AppRecord } from '@/types';

/** First stored template for an all_projects id (same rule ProjectWhatsAppFlow used). */
export function findProjectTemplate(templates: AppRecord[], projectId: string): AppRecord | null {
  return templates.find((t) => (t.data as Record<string, unknown>)?.project_id === projectId) ?? null;
}

/** The ready (approved) template for a market listing — drafts don't count. */
export function findReadyListingTemplate(templates: AppRecord[], listingId: string): AppRecord | null {
  return (
    templates.find((t) => {
      const d = t.data as Record<string, unknown>;
      return d?.listing_id === listingId && d?.status === 'ready';
    }) ?? null
  );
}

/** The template's cleaned listing photos as public URLs (Approve writes them). */
export function templateListingImageUrls(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.images)) return [];
  return (data.images as Array<{ public_url?: unknown } | null>)
    .map((im) => im?.public_url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
}

/** Pick the template body for the UI language, falling back to the other. */
export function templateBody(data: Record<string, unknown>, isAr: boolean): string {
  const ar = typeof data.body_ar === 'string' ? data.body_ar.trim() : '';
  const en = typeof data.body_en === 'string' ? data.body_en.trim() : '';
  return (isAr ? ar || en : en || ar);
}

/**
 * Direct video-FILE URLs from a record's video field (all_projects
 * `project_videos`, market_listings `video_urls`). Only files WhatsApp can
 * carry as a video message qualify — HLS playlists (Aqar/Cloudflare Stream
 * .m3u8) and page links (YouTube etc.) are excluded, not errored: they can't
 * be uploaded as media.
 */
const DIRECT_VIDEO_RE = /\.(mp4|m4v|webm|mov|3gp)(\?|#|$)/i;

export function directVideoUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(
    (v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v) && DIRECT_VIDEO_RE.test(v),
  );
}
