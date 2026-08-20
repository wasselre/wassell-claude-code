// ============================================================================
// bundle.social API client — organic ORGANIC posting to our own connected
// accounts (Instagram / TikTok / Snapchat). Verified live: org "wassel.re",
// team "Wassel", all three accounts authorized.
// ----------------------------------------------------------------------------
// This powers the Marketing OS "publish for real" path. MOS already models one
// publication row per platform (caption + approved file + schedule + result);
// this client takes ONE such row and hands it to bundle.social to post now or
// schedule for its slot. bundle.social does the OAuth token custody, the actual
// upload to each platform, retries and the review-state handling — we only
// upload the approved file (by URL) and create/track the post.
//
// Convention (mirrors loadMetaConfig): loadBundleConfig() returns null when the
// API key or team id is absent, so every caller self-disables cleanly until the
// credentials exist — deploying this code is a no-op until BUNDLE_SOCIAL_API_KEY
// + BUNDLE_SOCIAL_TEAM_ID are set.
//
// Auth: x-api-key header. Base: https://api.bundle.social/api/v1.
// Docs mirrored under C:/Users/rayan/Claude/bundlsocial (scraped 2026-08-19).
// ============================================================================

const BASE_URL = 'https://api.bundle.social/api/v1';

export interface BundleConfig {
  apiKey: string;
  teamId: string;
}

export function loadBundleConfig(env: NodeJS.ProcessEnv = process.env): BundleConfig | null {
  const apiKey = env.BUNDLE_SOCIAL_API_KEY?.trim();
  const teamId = env.BUNDLE_SOCIAL_TEAM_ID?.trim();
  if (!apiKey || !teamId) return null;
  return { apiKey, teamId };
}

/** Our platform slug → bundle.social socialAccountType. Only the three we run. */
export const BUNDLE_PLATFORM_TYPE: Record<string, string> = {
  instagram: 'INSTAGRAM',
  tiktok: 'TIKTOK',
  snapchat: 'SNAPCHAT',
};

/** The platforms we can push via API. Others (x/website) stay manual. */
export function isBundlePlatform(platform: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUNDLE_PLATFORM_TYPE, platform);
}

/** A bundle.social API error, carrying the parsed body + HTTP status for logs. */
export class BundleApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'BundleApiError';
  }
}

async function bundleFetch<T>(
  cfg: BundleConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'x-api-key': cfg.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Network drop — surfaced, never swallowed.
    throw new BundleApiError(
      `bundle.social ${method} ${path} — network error: ${e instanceof Error ? e.message : String(e)}`,
      0,
      null,
    );
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!res.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'message' in parsed
      && typeof (parsed as { message: unknown }).message === 'string')
      ? (parsed as { message: string }).message
      : `bundle.social ${method} ${path} failed (${res.status})`;
    throw new BundleApiError(msg, res.status, parsed);
  }
  return parsed as T;
}

/* ------------------------------------------------------------------ */
/* team + accounts                                                     */
/* ------------------------------------------------------------------ */

export interface BundleSocialAccount {
  id: string;
  type: string;             // INSTAGRAM / TIKTOK / SNAPCHAT / …
  username: string | null;
  displayName: string | null;
  status: string | null;
}

export interface BundleTeam {
  id: string;
  name: string;
  socialAccounts: BundleSocialAccount[];
}

export const getTeam = (cfg: BundleConfig): Promise<BundleTeam> =>
  bundleFetch<BundleTeam>(cfg, 'GET', `/team/${cfg.teamId}`);

/* ------------------------------------------------------------------ */
/* upload (from a public URL — we never stream bytes through the fn)   */
/* ------------------------------------------------------------------ */

export interface BundleUpload {
  id: string;
  type?: string;            // image / video / document
  mime?: string;
}

/**
 * Register media by URL. bundle.social fetches it server-side (≤1 GB, ≤60 s),
 * which is exactly right for short-form / feed content and keeps the edge
 * function from ever holding the file bytes. Returns the uploadId the post needs.
 */
export const uploadFromUrl = (cfg: BundleConfig, url: string): Promise<BundleUpload> =>
  bundleFetch<BundleUpload>(cfg, 'POST', '/upload/from-url', { url, teamId: cfg.teamId });

/* ------------------------------------------------------------------ */
/* post                                                                */
/* ------------------------------------------------------------------ */

/** bundle.social's post lifecycle, verbatim. */
export type BundlePostStatus =
  | 'DRAFT' | 'SCHEDULED' | 'PROCESSING' | 'POSTED'
  | 'RETRYING' | 'ERROR' | 'REVIEW' | 'DELETED';

export interface BundlePost {
  id: string;
  status: BundlePostStatus;
  postDate: string | null;
  /** Set once the platform confirms publication. */
  postedDate?: string | null;
  error?: string | null;
  errorsVerbose?: unknown;
  /** Per-platform progress + result, keyed by PLATFORM. The permalink of a
   *  POSTED post lives in here (shape varies per platform). */
  externalData?: Record<string, Record<string, unknown>> | null;
}

/**
 * Best-effort permalink for a POSTED post — the public URL to show / store as
 * external_url. bundle stores per-platform result under externalData.<PLATFORM>
 * with platform-varying key names, so we scan for the usual ones. Never throws;
 * returns null when nothing url-shaped is present (the manual paste still works).
 */
export function extractPermalink(post: BundlePost): string | null {
  const ext = post.externalData;
  if (!ext || typeof ext !== 'object') return null;
  const KEYS = ['permalink', 'postUrl', 'url', 'externalLink', 'link', 'shareUrl'];
  for (const platform of Object.values(ext)) {
    if (!platform || typeof platform !== 'object') continue;
    for (const k of KEYS) {
      const v = (platform as Record<string, unknown>)[k];
      if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
    }
  }
  return null;
}

/** bundle's fine-grained status → our coarse publication status. */
export function mapBundleStatus(status: BundlePostStatus): 'scheduled' | 'published' {
  return status === 'POSTED' ? 'published' : 'scheduled';
}

export interface CreatePostInput {
  title: string;
  status: 'DRAFT' | 'SCHEDULED';
  socialAccountTypes: string[];
  /** UTC ISO — REQUIRED and validated by bundle even for drafts. */
  postDate: string;
  data: Record<string, unknown>;
}

export const createPost = (cfg: BundleConfig, input: CreatePostInput): Promise<BundlePost> =>
  bundleFetch<BundlePost>(cfg, 'POST', '/post', { teamId: cfg.teamId, ...input });

export const getPost = (cfg: BundleConfig, postId: string): Promise<BundlePost> =>
  bundleFetch<BundlePost>(cfg, 'GET', `/post/${postId}`);

export const deletePost = (cfg: BundleConfig, postId: string): Promise<unknown> =>
  bundleFetch<unknown>(cfg, 'DELETE', `/post/${postId}`);

/* ------------------------------------------------------------------ */
/* analytics — normalized post metrics (bundle refreshes every 24h)     */
/* ------------------------------------------------------------------ */

/** One analytics reading for a post. bundle unifies the metric names across
 *  platforms; a field is 0 (not null) when the platform API doesn't provide it. */
export interface BundleAnalyticsItem {
  impressions: number | null;
  impressionsUnique: number | null;
  views: number | null;
  viewsUnique: number | null;
  likes: number | null;
  dislikes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  forced?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface BundlePostAnalytics {
  items: BundleAnalyticsItem[];
  profilePost?: { permalink?: string | null; publishedAt?: string | null } | null;
}

/**
 * Parsed, normalized metrics for one published post. This is the READ endpoint
 * (not the force-refresh one), so it is NOT subject to the teams×5/day force
 * limit — bundle auto-refreshes every 24h and this returns the last snapshot.
 */
export const getPostAnalytics = (
  cfg: BundleConfig, postId: string, platformType: string,
): Promise<BundlePostAnalytics> =>
  bundleFetch<BundlePostAnalytics>(
    cfg, 'GET',
    `/analytics/post?postId=${encodeURIComponent(postId)}&platformType=${encodeURIComponent(platformType)}`,
  );

/** Force an immediate refresh (rate-limited to teams×5/day — use sparingly). */
export const forcePostAnalytics = (
  cfg: BundleConfig, postId: string, platformType: string,
): Promise<unknown> =>
  bundleFetch<unknown>(cfg, 'POST', '/analytics/post/force', { postId, platformType });

/** The most recent reading in an analytics response (by updatedAt/createdAt). */
export function latestAnalytics(a: BundlePostAnalytics): BundleAnalyticsItem | null {
  const items = a.items ?? [];
  if (items.length === 0) return null;
  return [...items].sort((x, y) => {
    const tx = Date.parse(x.updatedAt ?? x.createdAt ?? '') || 0;
    const ty = Date.parse(y.updatedAt ?? y.createdAt ?? '') || 0;
    return ty - tx;
  })[0] ?? null;
}

/**
 * Map a bundle analytics reading onto our snapshot shape. `views` and the
 * engagement breakdown map 1:1; `engagement` is the total interaction count
 * (likes+comments+saves+shares) since our schema tracks one headline number;
 * `enquiries` stays null (a CRM concept, not a social metric). Platform-only
 * fields ride in `extra`.
 */
export function analyticsToSnapshot(item: BundleAnalyticsItem, platformType: string): {
  views: number | null;
  engagement: number | null;
  enquiries: null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  extra: Record<string, unknown>;
} {
  const n = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null;
  const likes = n(item.likes);
  const comments = n(item.comments);
  const saves = n(item.saves);
  const shares = n(item.shares);
  const parts = [likes, comments, saves, shares].filter((x): x is number => x !== null);
  const engagement = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
  return {
    views: n(item.views),
    engagement,
    enquiries: null,
    likes, comments, saves,
    extra: {
      source: 'bundle.social',
      platform: platformType,
      impressions: n(item.impressions),
      impressions_unique: n(item.impressionsUnique),
      views_unique: n(item.viewsUnique),
      shares,
      dislikes: n(item.dislikes),
    },
  };
}

/* ------------------------------------------------------------------ */
/* analytics — account (profile) level metrics                          */
/* ------------------------------------------------------------------ */

/**
 * One profile-level analytics reading for a connected account. bundle unifies
 * the names across platforms; a field is 0 (not null) when the platform API
 * doesn't provide it. `followers` is the headline growth signal — bundle keeps
 * only 30 days of these, which is exactly why we snapshot them daily on our end.
 */
export interface BundleAccountAnalyticsItem {
  impressions: number | null;
  impressionsUnique: number | null;
  views: number | null;
  viewsUnique: number | null;
  likes: number | null;
  comments: number | null;
  postCount: number | null;
  followers: number | null;
  following: number | null;
  forced?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface BundleAccountAnalytics {
  socialAccount?: { id?: string; type?: string; username?: string | null } | null;
  items: BundleAccountAnalyticsItem[];
}

/**
 * Parsed, normalized profile metrics for ONE connected account. The READ
 * endpoint (not force-refresh), keyed by teamId + platformType — so it works
 * regardless of whether our mos_platform_accounts row has been platform_synced
 * yet. NOT subject to the teams×5/day force limit; bundle auto-refreshes ~24h.
 */
export const getSocialAccountAnalytics = (
  cfg: BundleConfig, platformType: string,
): Promise<BundleAccountAnalytics> =>
  bundleFetch<BundleAccountAnalytics>(
    cfg, 'GET',
    `/analytics/social-account?teamId=${encodeURIComponent(cfg.teamId)}&platformType=${encodeURIComponent(platformType)}`,
  );

/** Force an immediate account-analytics refresh (teams×5/day — use sparingly). */
export const forceSocialAccountAnalytics = (
  cfg: BundleConfig, platformType: string,
): Promise<unknown> =>
  bundleFetch<unknown>(cfg, 'POST', '/analytics/social-account/force', {
    teamId: cfg.teamId, platformType,
  });

/** The most recent reading in an account-analytics response (by updated/created). */
export function latestAccountAnalytics(a: BundleAccountAnalytics): BundleAccountAnalyticsItem | null {
  const items = a.items ?? [];
  if (items.length === 0) return null;
  return [...items].sort((x, y) => {
    const tx = Date.parse(x.updatedAt ?? x.createdAt ?? '') || 0;
    const ty = Date.parse(y.updatedAt ?? y.createdAt ?? '') || 0;
    return ty - tx;
  })[0] ?? null;
}

/**
 * Map a bundle account reading onto our account-snapshot columns. `reach` is
 * bundle's impressionsUnique (unique accounts reached). Platform-only fields
 * ride in `extra`. Integers are floored; a missing metric stays null (not 0) so
 * the growth chart can tell "no data" from "genuinely zero".
 */
export function accountAnalyticsToSnapshot(item: BundleAccountAnalyticsItem, platformType: string): {
  followers: number | null;
  following: number | null;
  post_count: number | null;
  impressions: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  extra: Record<string, unknown>;
} {
  const n = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null;
  return {
    followers: n(item.followers),
    following: n(item.following),
    post_count: n(item.postCount),
    impressions: n(item.impressions),
    reach: n(item.impressionsUnique),
    views: n(item.views),
    likes: n(item.likes),
    comments: n(item.comments),
    extra: {
      source: 'bundle.social',
      platform: platformType,
      views_unique: n(item.viewsUnique),
    },
  };
}

/* ------------------------------------------------------------------ */
/* per-platform post `data` builder                                    */
/* ------------------------------------------------------------------ */

/** One uploaded file, in carousel order, with the kind the shape rules need. */
export interface PlatformUpload {
  id: string;
  kind: 'photo' | 'video' | 'design' | 'audio' | 'document';
}

const isVideoUpload = (u: PlatformUpload): boolean => u.kind === 'video' || u.kind === 'audio';

/**
 * Build the platform-specific `data` block for ONE platform. Each MOS
 * publication is exactly one platform, so this returns a one-key object.
 * `uploads` is the ORDERED file set (the carousel order).
 *
 *   instagram  1 video → REEL; anything else → POST (carousel 1–10, mixed
 *              images+videos — bundle allows mixing on feed posts).
 *   tiktok     1 video → VIDEO; images → IMAGE (Photo Mode, 1–10, autoScale).
 *   snapchat   STORY, exactly 1 file (the set-shape rules guarantee it).
 *
 * The set SHAPE is validated upstream by preflightPublishSet in
 * src/lib/marketingOS/platformRules.ts — keep the two in sync. Anything richer
 * (locations, first-comment hashtags, Spotlight, music) is a later layer.
 */
export function buildPlatformData(
  platform: string,
  opts: { text: string; uploads: PlatformUpload[] },
): { socialAccountType: string; data: Record<string, unknown> } | null {
  const type = BUNDLE_PLATFORM_TYPE[platform];
  if (!type || opts.uploads.length === 0) return null;
  const uploadIds = opts.uploads.map((u) => u.id);
  const videos = opts.uploads.filter(isVideoUpload).length;
  const hasImage = videos < opts.uploads.length;

  if (platform === 'instagram') {
    // Single video = Reel (growth surface). Everything else — single image or
    // any multi-file set — is a feed POST; bundle carries 1–10 mixed files.
    const isReel = opts.uploads.length === 1 && videos === 1;
    return {
      socialAccountType: type,
      data: {
        INSTAGRAM: {
          type: isReel ? 'REEL' : 'POST',
          text: opts.text,
          uploadIds,
          // Feed posts reject images outside 0.8–1.91 aspect (verified live).
          // auto-fit letterboxes any shape instead of failing at post time —
          // the safe default for real-estate photos of varying dimensions.
          ...(!isReel && hasImage ? { autoFitImage: true } : {}),
        },
      },
    };
  }
  if (platform === 'tiktok') {
    // One video → VIDEO; an all-image set → Photo Mode. Mixing is blocked by
    // the shape rules before this is ever called.
    const photoMode = videos === 0;
    return {
      socialAccountType: type,
      data: {
        TIKTOK: {
          type: photoMode ? 'IMAGE' : 'VIDEO',
          text: opts.text,
          uploadIds,
          privacy: 'PUBLIC_TO_EVERYONE',
          disableComments: false,
          disableDuet: false,
          disableStitch: false,
          // Photo Mode: let bundle down-scale oversized images server-side
          // (real-estate photos routinely exceed TikTok's 1920×1080 canvas).
          // No autoAddMusic — random royalty-free music is not a default.
          ...(photoMode ? { autoScale: true } : {}),
        },
      },
    };
  }
  if (platform === 'snapchat') {
    return {
      socialAccountType: type,
      data: { SNAPCHAT: { type: 'STORY', text: opts.text, uploadIds } },
    };
  }
  return null;
}

/**
 * The coarse per-file platform/kind gate. TikTok takes video (VIDEO posts) AND
 * photos (Photo Mode, since carousels landed) — the finer rules (JPG/WebP
 * only, no mixing) live in preflightPublishSet.
 */
export function platformAcceptsKind(platform: string, kind: string): boolean {
  if (platform === 'tiktok') return kind === 'video' || kind === 'audio' || kind === 'photo';
  return true;
}
