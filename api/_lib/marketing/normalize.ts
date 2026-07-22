// ============================================================================
// Provider-agnostic normalization + deterministic dedup helpers (spec §6).
// ============================================================================
import { sha256Hex } from './sha256';
import type { NormalizedContentPost, Platform } from './types';

/**
 * Canonicalize a post URL so the same post from different providers/params maps
 * to one dedup key (§6 step 2). Strips query/hash, lowercases host, trims slashes.
 */
export function canonicalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Fuzzy content fingerprint (§6 step 3): publisher + published time + caption
 * (+ first media url). Used as a secondary dedup guard when a platform lacks a
 * stable external id, and later for near-duplicate detection.
 */
export function contentFingerprint(p: {
  platform: Platform;
  handle?: string;
  publishedAt?: string;
  caption?: string;
  firstMediaUrl?: string;
}): string {
  const norm = (p.caption ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const basis = [p.platform, p.handle ?? '', p.publishedAt ?? '', norm, p.firstMediaUrl ?? ''].join('|');
  return sha256Hex(basis).slice(0, 32);
}

/** Attach canonicalUrl + contentHash to a normalized post (idempotent). */
export function withDedupKeys(post: NormalizedContentPost, handle?: string): NormalizedContentPost {
  const canonicalUrl = post.canonicalUrl ?? canonicalizeUrl(post.postUrl);
  const firstMediaUrl = post.mediaRefs?.[0]?.url ?? post.thumbnailRef;
  const contentHash =
    post.contentHash ??
    contentFingerprint({
      platform: post.platform,
      handle,
      publishedAt: post.publishedAt,
      caption: post.caption,
      firstMediaUrl,
    });
  return { ...post, canonicalUrl, contentHash };
}

/** Deduplicate a batch in-memory before upsert (belt-and-suspenders; the DB
 *  unique index is the real guard). Keeps the first occurrence per external id. */
export function dedupeBatch(posts: NormalizedContentPost[]): NormalizedContentPost[] {
  const seen = new Set<string>();
  const out: NormalizedContentPost[] = [];
  for (const p of posts) {
    const key = `${p.platform}:${p.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
