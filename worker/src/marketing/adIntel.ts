// ============================================================================
// Ad-intelligence PURE logic (no I/O, unit-tested): landing-URL normalization,
// creative fingerprinting, campaign signatures, headline keys, insight dedup keys.
// Deterministic — NO AI. Used by runCollectionJob's paid_ads pipeline.
// ============================================================================
import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Host+query-stripped URL key (matches the SQL mkt_url_key) — stable across
 *  Meta's rotating CDN edge hosts + expiring tokens. Used to decide if a
 *  creative actually changed (avoids re-downloading the same image). */
export function urlKey(u: string | null | undefined): string {
  return (u ?? '').replace(/\?.*$/, '').replace(/^https?:\/\/[^/]+/, '');
}

// ── Landing-page normalization ──────────────────────────────────────────────
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'msclkid', 'dclid', 'yclid', 'twclid', 'igshid', 'mibextid',
  'mc_eid', 'mc_cid', 'ref', 'ref_src', 'ref_url', 'source', '_ga', '_gl',
  'campaign_id', 'ad_id', 'adset_id', 'fb_action_ids', 'fb_action_types', 'fb_ref',
  '__tn__', '__cft__', 'wtsid', 's_kwcid', 'utm_id',
]);
function isTracking(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith('utm_') || k.startsWith('_nc_') || k.startsWith('__cft') || TRACKING_PARAMS.has(k);
}

/** Canonicalize a landing URL: drop scheme case, www, tracking params, hash, trailing slash. */
export function normalizeLandingUrl(raw: string | undefined | null): { canonical: string; domain: string | null } {
  if (!raw) return { canonical: '', domain: null };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { canonical: raw.trim(), domain: null }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) if (!isTracking(k)) kept.push([k, v]);
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = kept.map(([k, v]) => (v ? `${k}=${v}` : k)).join('&');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const canonical = `${u.protocol}//${host}${path}${qs ? `?${qs}` : ''}`;
  return { canonical, domain: host };
}

// ── Headline normalization / campaign signature ─────────────────────────────
export function normalizeHeadlineKey(headline: string | undefined | null): string {
  return (headline ?? '')
    .normalize('NFKC')
    .replace(/\{\{[^}]*\}\}/g, ' ')        // Meta dynamic placeholders {{product.name}}
    .replace(/[\p{P}\p{S}]/gu, ' ')        // punctuation/symbols
    .replace(/[ـً-ْ]/g, '')                // arabic tatweel/harakat
    .replace(/\s+/g, ' ').trim().toLowerCase()
    .split(' ').slice(0, 8).join(' ');     // first 8 tokens = the campaign's headline core
}

/**
 * Deterministic campaign group key. Ads sharing advertiser + landing + CTA + the
 * headline core belong to one campaign (high-confidence grouping — no fabrication:
 * identical landing+cta+headline is a strong signal). Returns a short stable hash.
 */
export function campaignSignature(parts: {
  organizationId?: string | null; advertiserName?: string | null;
  landingCanonical?: string | null; cta?: string | null; headline?: string | null;
}): string {
  const key = [
    parts.organizationId ?? '',
    (parts.advertiserName ?? '').trim().toLowerCase(),
    parts.landingCanonical ?? '',
    (parts.cta ?? '').trim().toLowerCase(),
    normalizeHeadlineKey(parts.headline),
  ].join('|');
  return 'meta:' + createHash('sha1').update(key).digest('hex').slice(0, 24);
}

// ── Perceptual dHash (difference hash) — algorithm only ─────────────────────
// Pure: takes a 9×8 grayscale matrix (row-major, values 0–255) → 64-bit hex.
// The worker feeds it decoded pixels IF an image decoder is available; the exact
// sha256 fingerprint (above) is the always-on dedup, dHash the resize-robust add.
export function dHashFromGrayscale(gray9x8: number[]): string {
  if (gray9x8.length !== 72) throw new Error('dHash expects a 9x8 grayscale matrix (72 values)');
  let bits = '';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    bits += gray9x8[r * 9 + c]! > gray9x8[r * 9 + c + 1]! ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length) * 4;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

// ── Insight / notification dedup keys ───────────────────────────────────────
export function insightKey(kind: string, ...parts: Array<string | null | undefined>): string {
  return [kind, ...parts.map((p) => p ?? '')].join(':');
}
