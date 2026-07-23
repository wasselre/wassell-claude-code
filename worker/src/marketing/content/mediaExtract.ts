// ============================================================================
// Pure extraction of downloadable media descriptors from a provider's raw post
// payload. The collection normalizer historically dropped media URLs (media_refs
// was stored empty), but the raw Apify/YouTube payload retains everything — this
// is the single place that reads a raw payload and enumerates its media assets
// (video, images, carousel children, thumbnail) with carousel ordering.
// ============================================================================

export interface MediaDescriptor {
  carouselIndex: number;
  kind: 'video' | 'image' | 'thumbnail';
  url: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v ? Number(v) : undefined);

/** Enumerate downloadable media for one collected post. Ordering: carousel index, then thumbnail last. */
export function extractMedia(platform: string, raw: Record<string, unknown>): MediaDescriptor[] {
  if (platform === 'instagram') return extractInstagram(raw);
  if (platform === 'tiktok') return extractTiktok(raw);
  if (platform === 'youtube') return extractYouTube(raw);
  return [];
}

function extractInstagram(raw: Record<string, unknown>): MediaDescriptor[] {
  const out: MediaDescriptor[] = [];
  const children = Array.isArray(raw.childPosts) ? (raw.childPosts as Array<Record<string, unknown>>) : [];
  if (children.length > 0) {
    // carousel — one descriptor per child, preserving order
    children.forEach((c, i) => {
      const video = str(c.videoUrl);
      const image = str(c.displayUrl) ?? firstImage(c.images);
      if (video) out.push({ carouselIndex: i, kind: 'video', url: video, width: num(c.originalWidth ?? c.dimensionsWidth), height: num(c.originalHeight ?? c.dimensionsHeight), durationMs: msFromSeconds(c.videoDuration) });
      else if (image) out.push({ carouselIndex: i, kind: 'image', url: image, width: num(c.originalWidth ?? c.dimensionsWidth), height: num(c.originalHeight ?? c.dimensionsHeight) });
    });
  } else {
    const video = str(raw.videoUrl);
    const image = str(raw.displayUrl) ?? firstImage(raw.images);
    if (video) out.push({ carouselIndex: 0, kind: 'video', url: video, width: num(raw.originalWidth ?? raw.dimensionsWidth), height: num(raw.originalHeight ?? raw.dimensionsHeight), durationMs: msFromSeconds(raw.videoDuration) });
    else if (image) out.push({ carouselIndex: 0, kind: 'image', url: image, width: num(raw.originalWidth ?? raw.dimensionsWidth), height: num(raw.originalHeight ?? raw.dimensionsHeight) });
  }
  // post-level cover as a thumbnail (used when the main media is a video)
  const thumb = str(raw.displayUrl);
  if (thumb && out.some((m) => m.kind === 'video')) out.push({ carouselIndex: 0, kind: 'thumbnail', url: thumb });
  return dedupeByUrl(out);
}

function extractTiktok(raw: Record<string, unknown>): MediaDescriptor[] {
  const out: MediaDescriptor[] = [];
  const vm = raw.videoMeta as Record<string, unknown> | undefined;
  // clockworks/tiktok-scraper exposes downloadable urls in mediaUrls[] and/or videoMeta.downloadAddr
  const mediaUrls = Array.isArray(raw.mediaUrls) ? (raw.mediaUrls as unknown[]).map(str).filter((u): u is string => !!u) : [];
  const video = mediaUrls[0] ?? str(vm?.downloadAddr) ?? str(raw.videoUrl) ?? str(raw.webVideoUrl && vm?.downloadAddr);
  const durationMs = msFromSeconds(vm?.duration);
  if (video && !video.includes('tiktok.com/@')) out.push({ carouselIndex: 0, kind: 'video', url: video, width: num(vm?.width), height: num(vm?.height), durationMs });
  const cover = str(vm?.coverUrl) ?? str(vm?.originalCoverUrl);
  if (cover) out.push({ carouselIndex: 0, kind: 'thumbnail', url: cover });
  return dedupeByUrl(out);
}

function extractYouTube(raw: Record<string, unknown>): MediaDescriptor[] {
  // YouTube gives no direct mp4 URL (needs yt-dlp, not installed) — thumbnail + caption only.
  const sn = raw.snippet as Record<string, unknown> | undefined;
  const th = sn?.thumbnails as Record<string, { url?: string }> | undefined;
  const url = th?.maxres?.url ?? th?.high?.url ?? th?.default?.url;
  return url ? [{ carouselIndex: 0, kind: 'thumbnail', url }] : [];
}

function firstImage(images: unknown): string | undefined {
  if (!Array.isArray(images)) return undefined;
  for (const im of images) { const u = typeof im === 'string' ? im : str((im as Record<string, unknown>)?.url); if (u) return u; }
  return undefined;
}
function msFromSeconds(v: unknown): number | undefined { const n = num(v); return n != null && n > 0 ? Math.round(n * 1000) : undefined; }
function dedupeByUrl(items: MediaDescriptor[]): MediaDescriptor[] {
  const seen = new Set<string>(); const out: MediaDescriptor[] = [];
  for (const m of items) { const k = `${m.kind}:${m.carouselIndex}:${m.url}`; if (seen.has(k)) continue; seen.add(k); out.push(m); }
  return out;
}
