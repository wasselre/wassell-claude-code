// ============================================================================
// YouTube provider — official Data API v3 (public collection, API-key only).
// ----------------------------------------------------------------------------
// Flow (spec §9): resolve channelId once → uploads playlist → incremental
// playlistItems (pageToken cursor stored on the account) → batch videos.list
// for statistics → normalize → upsert. No OAuth (public data only).
// Quota/rate errors map to ProviderHealth so the UI shows an honest status.
// ============================================================================
import type {
  MarketingIntelligenceProvider,
  ProviderHealthResult,
  DiscoverAccountInput,
  DiscoveredAccount,
  CollectAccountContentInput,
  CollectedContentBatch,
  CollectContentMetricsInput,
  CollectedMetricBatch,
  NormalizedContentPost,
  NormalizationContext,
  NormalizedMarketingRecord,
  NormalizedMetrics,
} from '../types';
import { ProviderError } from '../types';
import { withDedupKeys } from '../normalize';

const API = 'https://www.googleapis.com/youtube/v3';

function apiKey(): string {
  const k = process.env.YOUTUBE_DATA_API_KEY;
  if (!k) throw new ProviderError('YOUTUBE_DATA_API_KEY not set', 'not_configured');
  return k;
}

async function yt<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', apiKey());
  const res = await fetch(url.toString());
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: { errors?: Array<{ reason?: string }> } };
    const reason = body?.error?.errors?.[0]?.reason ?? '';
    if (/quota/i.test(reason)) throw new ProviderError(`YouTube quota exceeded (${reason})`, 'rate_limited');
    throw new ProviderError(`YouTube 403 (${reason})`, 'auth_failed');
  }
  if (res.status === 429) throw new ProviderError('YouTube rate limited', 'rate_limited');
  if (!res.ok) throw new ProviderError(`YouTube ${res.status}: ${(await res.text()).slice(0, 200)}`, 'unavailable');
  return (await res.json()) as T;
}

interface ChannelListResp {
  items?: Array<{
    id: string;
    snippet?: { title?: string; customUrl?: string };
    statistics?: { subscriberCount?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }>;
}
interface PlaylistItemsResp {
  nextPageToken?: string;
  items?: Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }>;
}
interface VideosResp {
  items?: Array<{
    id: string;
    snippet?: { title?: string; description?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }>; tags?: string[]; defaultAudioLanguage?: string };
    contentDetails?: { duration?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }>;
}

/** ISO-8601 duration (PT#M#S) → ms. */
function durationToMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return undefined;
  const h = Number(m[1] ?? 0), min = Number(m[2] ?? 0), s = Number(m[3] ?? 0);
  return (h * 3600 + min * 60 + s) * 1000;
}

function extractHandleOrId(query: string): { channelId?: string; handle?: string; username?: string } {
  const q = query.trim();
  const chan = q.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (chan) return { channelId: chan[1] };
  const at = q.match(/youtube\.com\/@([\w.-]+)/i) || q.match(/^@([\w.-]+)$/);
  if (at) return { handle: at[1] };
  const user = q.match(/youtube\.com\/user\/([\w-]+)/i);
  if (user) return { username: user[1] };
  if (/^UC[\w-]{20,}$/.test(q)) return { channelId: q };
  return { handle: q.replace(/^@/, '') };
}

async function resolveChannel(query: string): Promise<{ channelId: string; uploads: string; title?: string; subs?: number }> {
  const { channelId, handle, username } = extractHandleOrId(query);
  let resp: ChannelListResp;
  if (channelId) {
    resp = await yt<ChannelListResp>('channels', { part: 'snippet,statistics,contentDetails', id: channelId });
  } else if (handle) {
    resp = await yt<ChannelListResp>('channels', { part: 'snippet,statistics,contentDetails', forHandle: handle });
  } else {
    resp = await yt<ChannelListResp>('channels', { part: 'snippet,statistics,contentDetails', forUsername: username! });
  }
  const item = resp.items?.[0];
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!item || !uploads) throw new ProviderError(`YouTube channel not found for "${query}"`, 'unavailable');
  return {
    channelId: item.id,
    uploads,
    title: item.snippet?.title,
    subs: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : undefined,
  };
}

function normVideo(v: NonNullable<VideosResp['items']>[number]): NormalizedContentPost {
  const metrics: NormalizedMetrics = {
    views: v.statistics?.viewCount ? Number(v.statistics.viewCount) : undefined,
    likes: v.statistics?.likeCount ? Number(v.statistics.likeCount) : undefined,
    comments: v.statistics?.commentCount ? Number(v.statistics.commentCount) : undefined,
  };
  const thumb = v.snippet?.thumbnails?.high?.url ?? v.snippet?.thumbnails?.default?.url;
  return withDedupKeys({
    platform: 'youtube',
    externalId: v.id,
    postUrl: `https://www.youtube.com/watch?v=${v.id}`,
    // YouTube identity lives in ?v= — set canonical explicitly so the generic
    // query-stripping canonicalizer doesn't erase it.
    canonicalUrl: `https://www.youtube.com/watch?v=${v.id}`,
    postType: 'video',
    caption: [v.snippet?.title, v.snippet?.description].filter(Boolean).join('\n\n') || undefined,
    lang: v.snippet?.defaultAudioLanguage,
    publishedAt: v.snippet?.publishedAt,
    thumbnailRef: thumb,
    durationMs: durationToMs(v.contentDetails?.duration),
    hashtags: (v.snippet?.tags ?? []).slice(0, 30),
    metrics,
    raw: v,
  });
}

export class YouTubeProvider implements MarketingIntelligenceProvider {
  readonly providerKey = 'youtube' as const;

  async validateConnection(): Promise<ProviderHealthResult> {
    const checkedAt = new Date().toISOString();
    if (!process.env.YOUTUBE_DATA_API_KEY) return { provider: 'youtube', health: 'not_configured', checkedAt };
    try {
      // Cheapest verifying call: resolve a well-known channel handle.
      await yt<ChannelListResp>('channels', { part: 'id', forHandle: 'YouTube' });
      return { provider: 'youtube', health: 'connected', checkedAt };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(String(e));
      return { provider: 'youtube', health: err.health, detail: err.message, checkedAt };
    }
  }

  async discoverAccount(input: DiscoverAccountInput): Promise<DiscoveredAccount[]> {
    if (input.platform !== 'youtube') return [];
    const ch = await resolveChannel(input.query);
    return [{
      platform: 'youtube',
      handle: ch.title ?? ch.channelId,
      profileUrl: `https://www.youtube.com/channel/${ch.channelId}`,
      externalAccountId: ch.channelId,
      displayName: ch.title,
      followers: ch.subs,
      // uploads playlist id carried so the caller can store it as the sync anchor
    }];
  }

  /**
   * Incremental: `cursor` = uploads-playlist pageToken from last run, OR the
   * uploads playlist id prefixed "uploads:" on first call. We resolve the uploads
   * playlist from externalAccountId (channelId) and page from the cursor.
   */
  async collectAccountContent(input: CollectAccountContentInput): Promise<CollectedContentBatch> {
    if (input.platform !== 'youtube') throw new ProviderError('YouTube provider only serves platform=youtube', 'config_invalid');
    const channelId = input.externalAccountId ?? (await resolveChannel(input.handle)).channelId;
    const uploads = input.externalAccountId
      ? (await resolveChannel(channelId)).uploads
      : (await resolveChannel(input.handle)).uploads;

    const pageToken = input.cursor && !input.cursor.startsWith('uploads:') ? input.cursor : undefined;
    const pl = await yt<PlaylistItemsResp>('playlistItems', {
      part: 'contentDetails',
      playlistId: uploads,
      maxResults: String(Math.min(50, input.limit ?? 50)),
      ...(pageToken ? { pageToken } : {}),
    });
    const ids = (pl.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => !!x);
    if (ids.length === 0) return { provider: 'youtube', posts: [], hasMore: false, nextCursor: null };

    // Batch statistics + details (up to 50 ids in one call → quota-efficient).
    const vids = await yt<VideosResp>('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(',') });
    const posts = (vids.items ?? []).map(normVideo);
    return {
      provider: 'youtube',
      posts,
      nextCursor: pl.nextPageToken ?? null,
      hasMore: Boolean(pl.nextPageToken),
    };
  }

  async collectContentMetrics(input: CollectContentMetricsInput): Promise<CollectedMetricBatch> {
    const ids = input.posts.map((p) => p.externalId);
    const out: CollectedMetricBatch['metrics'] = [];
    // videos.list accepts up to 50 ids per call.
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const vids = await yt<VideosResp>('videos', { part: 'statistics', id: chunk.join(',') });
      for (const v of vids.items ?? []) {
        out.push({
          externalId: v.id,
          metrics: {
            views: v.statistics?.viewCount ? Number(v.statistics.viewCount) : undefined,
            likes: v.statistics?.likeCount ? Number(v.statistics.likeCount) : undefined,
            comments: v.statistics?.commentCount ? Number(v.statistics.commentCount) : undefined,
          },
          raw: v,
        });
      }
    }
    return { provider: 'youtube', metrics: out };
  }

  normalizeRawRecord(record: unknown, _ctx: NormalizationContext): NormalizedMarketingRecord {
    return normVideo(record as NonNullable<VideosResp['items']>[number]);
  }
}
