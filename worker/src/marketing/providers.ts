// ============================================================================
// Marketing providers — CONSOLIDATED COPY of api/_lib/marketing/* for the worker.
// ----------------------------------------------------------------------------
// The worker is a standalone package (rootDir:src) and cannot import api/_lib
// (same posture as worker/src/imageGen.ts copying api/_lib/imageGen.ts). Keep
// this in sync with:
//   api/_lib/marketing/{types,normalize,registry}.ts
//   api/_lib/marketing/providers/{youtube,apify,browserbase}.ts
// Only the collection paths the worker runs live here; validateConnection +
// normalization + dedup are identical to the api copies.
// ============================================================================
import { createHash } from 'node:crypto';

export type ProviderKey = 'apify' | 'youtube' | 'browserbase';
export type Platform = 'instagram' | 'tiktok' | 'snapchat' | 'youtube' | 'x' | 'facebook';
export type ProviderHealth = 'not_configured' | 'connected' | 'auth_failed' | 'rate_limited' | 'unavailable' | 'config_invalid';

export interface NormalizedMetrics { views?: number; likes?: number; comments?: number; shares?: number; saves?: number; playCount?: number; followers?: number }
export interface NormalizedContentPost {
  platform: Platform; externalId: string; postUrl?: string; canonicalUrl?: string;
  postType?: 'image' | 'video' | 'carousel' | 'reel' | 'story' | 'short' | 'text' | 'unknown';
  caption?: string; lang?: string; publishedAt?: string;
  mediaRefs?: Array<{ kind: string; url: string; storagePath?: string }>;
  thumbnailRef?: string; durationMs?: number; hashtags?: string[]; mentions?: string[];
  metrics?: NormalizedMetrics; contentHash?: string; raw: unknown;
}
export interface CollectAccountContentInput { platform: Platform; handle: string; externalAccountId?: string; cursor?: string | null; mode: 'incremental' | 'backfill'; limit?: number }
export interface CollectedContentBatch { provider: ProviderKey; posts: NormalizedContentPost[]; nextCursor?: string | null; hasMore: boolean; cost?: Record<string, unknown>; rateLimit?: Record<string, unknown> }
export interface ProviderHealthResult { provider: ProviderKey; health: ProviderHealth; detail?: string; checkedAt: string }

export class ProviderError extends Error {
  constructor(message: string, public readonly health: ProviderHealth = 'unavailable') { super(message); this.name = 'ProviderError'; }
}

// ── normalize (copy of api/_lib/marketing/normalize.ts) ─────────────────────
export function canonicalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { const u = new URL(url); u.search = ''; u.hash = ''; return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`; }
  catch { return undefined; }
}
export function contentFingerprint(p: { platform: Platform; handle?: string; publishedAt?: string; caption?: string; firstMediaUrl?: string }): string {
  const norm = (p.caption ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200);
  return createHash('sha256').update([p.platform, p.handle ?? '', p.publishedAt ?? '', norm, p.firstMediaUrl ?? ''].join('|')).digest('hex').slice(0, 32);
}
export function withDedupKeys(post: NormalizedContentPost, handle?: string): NormalizedContentPost {
  const canonicalUrl = post.canonicalUrl ?? canonicalizeUrl(post.postUrl);
  const firstMediaUrl = post.mediaRefs?.[0]?.url ?? post.thumbnailRef;
  const contentHash = post.contentHash ?? contentFingerprint({ platform: post.platform, handle, publishedAt: post.publishedAt, caption: post.caption, firstMediaUrl });
  return { ...post, canonicalUrl, contentHash };
}

// ── YouTube (copy of providers/youtube.ts, collection path) ─────────────────
const YT_API = 'https://www.googleapis.com/youtube/v3';
function ytKey(): string { const k = process.env.YOUTUBE_DATA_API_KEY; if (!k) throw new ProviderError('YOUTUBE_DATA_API_KEY not set', 'not_configured'); return k; }
async function yt<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${YT_API}/${path}`); for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v); url.searchParams.set('key', ytKey());
  const res = await fetch(url.toString());
  if (res.status === 403) { const b = (await res.json().catch(() => ({}))) as { error?: { errors?: Array<{ reason?: string }> } }; const reason = b?.error?.errors?.[0]?.reason ?? ''; if (/quota/i.test(reason)) throw new ProviderError(`YouTube quota (${reason})`, 'rate_limited'); throw new ProviderError(`YouTube 403 (${reason})`, 'auth_failed'); }
  if (res.status === 429) throw new ProviderError('YouTube rate limited', 'rate_limited');
  if (!res.ok) throw new ProviderError(`YouTube ${res.status}`, 'unavailable');
  return (await res.json()) as T;
}
function durationToMs(iso?: string): number | undefined { if (!iso) return undefined; const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); if (!m) return undefined; return ((Number(m[1] ?? 0)) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000; }
interface YtVideos { items?: Array<{ id: string; snippet?: { title?: string; description?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }>; tags?: string[]; defaultAudioLanguage?: string }; contentDetails?: { duration?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> }
export function normYouTubeVideo(v: NonNullable<YtVideos['items']>[number]): NormalizedContentPost {
  return withDedupKeys({
    platform: 'youtube', externalId: v.id, postUrl: `https://www.youtube.com/watch?v=${v.id}`, canonicalUrl: `https://www.youtube.com/watch?v=${v.id}`,
    postType: 'video', caption: [v.snippet?.title, v.snippet?.description].filter(Boolean).join('\n\n') || undefined, lang: v.snippet?.defaultAudioLanguage,
    publishedAt: v.snippet?.publishedAt, thumbnailRef: v.snippet?.thumbnails?.high?.url ?? v.snippet?.thumbnails?.default?.url,
    durationMs: durationToMs(v.contentDetails?.duration), hashtags: (v.snippet?.tags ?? []).slice(0, 30),
    metrics: { views: v.statistics?.viewCount ? Number(v.statistics.viewCount) : undefined, likes: v.statistics?.likeCount ? Number(v.statistics.likeCount) : undefined, comments: v.statistics?.commentCount ? Number(v.statistics.commentCount) : undefined },
    raw: v,
  });
}
export const YouTube = {
  async health(): Promise<ProviderHealthResult> {
    const checkedAt = new Date().toISOString();
    if (!process.env.YOUTUBE_DATA_API_KEY) return { provider: 'youtube', health: 'not_configured', checkedAt };
    try { await yt<unknown>('channels', { part: 'id', forHandle: 'YouTube' }); return { provider: 'youtube', health: 'connected', checkedAt }; }
    catch (e) { const err = e instanceof ProviderError ? e : new ProviderError(String(e)); return { provider: 'youtube', health: err.health, detail: err.message, checkedAt }; }
  },
  async resolveChannel(query: string): Promise<{ channelId: string; uploads: string; title?: string; subs?: number }> {
    const q = query.trim();
    const params: Record<string, string> = { part: 'snippet,statistics,contentDetails' };
    if (/^UC[\w-]{20,}$/.test(q)) params.id = q; else params.forHandle = q.replace(/^@/, '');
    const resp = await yt<{ items?: Array<{ id: string; snippet?: { title?: string }; statistics?: { subscriberCount?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>('channels', params);
    const item = resp.items?.[0]; const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
    if (!item || !uploads) throw new ProviderError(`YouTube channel not found: ${query}`, 'unavailable');
    return { channelId: item.id, uploads, title: item.snippet?.title, subs: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : undefined };
  },
  async collect(input: CollectAccountContentInput): Promise<CollectedContentBatch> {
    const ch = input.externalAccountId ? await YouTube.resolveChannel(input.externalAccountId) : await YouTube.resolveChannel(input.handle);
    const pageToken = input.cursor && !input.cursor.startsWith('uploads:') ? input.cursor : undefined;
    const pl = await yt<{ nextPageToken?: string; items?: Array<{ contentDetails?: { videoId?: string } }> }>('playlistItems', { part: 'contentDetails', playlistId: ch.uploads, maxResults: String(Math.min(50, input.limit ?? 50)), ...(pageToken ? { pageToken } : {}) });
    const ids = (pl.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => !!x);
    if (ids.length === 0) return { provider: 'youtube', posts: [], hasMore: false, nextCursor: null };
    const vids = await yt<YtVideos>('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(',') });
    return { provider: 'youtube', posts: (vids.items ?? []).map(normYouTubeVideo), nextCursor: pl.nextPageToken ?? null, hasMore: Boolean(pl.nextPageToken), cost: { units_estimate: 1 + 1 } };
  },
};

// ── TikTok/IG/FB parsers (copy of providers/apify.ts parsers) ───────────────
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v ? Number(v) : undefined);
export function parseTiktokVideo(it: Record<string, unknown>, handle: string): NormalizedContentPost | null {
  const id = s(it.id); if (!id) return null;
  const vm = it.videoMeta as Record<string, unknown> | undefined;
  return withDedupKeys({
    platform: 'tiktok', externalId: id, postUrl: s(it.webVideoUrl) ?? `https://www.tiktok.com/@${handle}/video/${id}`, postType: 'video',
    caption: s(it.text) ?? s(it.description), publishedAt: typeof it.createTimeISO === 'string' ? it.createTimeISO : undefined,
    thumbnailRef: s(vm?.coverUrl), durationMs: n(vm?.duration) != null ? n(vm?.duration)! * 1000 : undefined,
    metrics: { views: n(it.playCount), likes: n(it.diggCount), comments: n(it.commentCount), shares: n(it.shareCount), saves: n(it.collectCount) }, raw: it,
  }, handle);
}
export function parseInstagramPost(it: Record<string, unknown>, handle: string): NormalizedContentPost | null {
  const id = s(it.id) ?? s(it.shortCode) ?? s(it.code); if (!id) return null;
  const isVideo = it.type === 'Video' || Boolean(it.videoUrl);
  return withDedupKeys({
    platform: 'instagram', externalId: id, postUrl: s(it.url) ?? (s(it.shortCode) ? `https://www.instagram.com/p/${it.shortCode}/` : undefined),
    postType: it.productType === 'clips' ? 'reel' : isVideo ? 'video' : it.type === 'Sidecar' ? 'carousel' : 'image',
    caption: s(it.caption), publishedAt: s(it.timestamp), thumbnailRef: s(it.displayUrl) ?? s(it.thumbnailUrl),
    hashtags: Array.isArray(it.hashtags) ? (it.hashtags as string[]) : [],
    metrics: { likes: n(it.likesCount), comments: n(it.commentsCount), views: n(it.videoViewCount) }, raw: it,
  }, handle);
}
