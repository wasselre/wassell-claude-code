/**
 * Downloading a listing photo from a CDN that does not want to serve us.
 *
 * Extracted from runCleanTextJob.ts on 2026-07-29 so the mirror lane
 * (runListingMirrorJob) and the clean lane share ONE implementation of the
 * direct→proxy fetch. Both need it; two copies would drift.
 *
 * Aqar's Cloudflare blocklists datacenter egress by ASN, not by header. The
 * browser UA + Referer below were ALREADY being sent when 4 of the 5 Fly sin
 * machines started getting a blanket 403 around 2026-07-24, while a laptop got
 * 200 with no headers at all. Measured 2026-07-29 on one image:
 *
 *   laptop (KSA)              200      me-central1 VM        200
 *   Fly bom (wa-agent)        200      Fly sin (4 of 5)      403
 *   Fly fra (fresh machine)   403      Fly sjc (scanner)     403
 *
 * So region-hopping is not a fix — a freshly provisioned fra machine was
 * blocked on first provision, and the scanner's own region is blocked too.
 * Refused downloads are retried through LISTING_IMAGE_PROXY_URL, a token-gated,
 * host-allowlisted, https-only, image-only, 25 MB-capped stdlib service running
 * alongside WAHA on the me-central1 VM (infra/imgproxy).
 *
 * Direct-first, not proxy-first: when the CDN is willing to serve us we keep the
 * bytes on the short path and off the WhatsApp VM. With either proxy secret
 * unset the fallback self-disables and the original CDN error propagates
 * unchanged — no silent degradation (CLAUDE.md "fail loudly").
 *
 * This proxy stays even though listings are now mirrored at scan time: it is the
 * ONLY working egress from Fly, so it is what the mirror itself is built on, and
 * it remains the clean lane's fallback for any photo not yet mirrored. See
 * docs/prd/market-intelligence.md for the keep-the-proxy rationale.
 */

/** The env fields this module needs — a structural subset of WorkerEnv. */
export interface AqarFetchEnv {
  LISTING_IMAGE_PROXY_URL: string | null;
  LISTING_IMAGE_PROXY_TOKEN: string | null;
}

export interface FetchedImage {
  bytes: Uint8Array;
  contentType: string;
}

const BROWSER_FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Referer: 'https://sa.aqar.fm/',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
} as const;

/**
 * Download a listing photo's bytes — directly if the CDN allows it, otherwise
 * through the allowlisted me-central1 image proxy. Throws with both failures
 * described when neither path works.
 */
export async function fetchListingImage(
  env: AqarFetchEnv,
  sourceUrl: string,
): Promise<FetchedImage> {
  let directError: string;
  try {
    const res = await fetch(sourceUrl, { headers: BROWSER_FETCH_HEADERS });
    if (res.ok) {
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') ?? 'image/jpeg',
      };
    }
    directError = `source fetch ${res.status}`;
  } catch (err) {
    directError = `source fetch failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const proxyUrl = env.LISTING_IMAGE_PROXY_URL;
  const proxyToken = env.LISTING_IMAGE_PROXY_TOKEN;
  if (!proxyUrl || !proxyToken) throw new Error(directError);

  console.log(`[aqar-fetch] direct fetch refused (${directError}) — retrying via image proxy`);
  const viaProxy = `${proxyUrl}?url=${encodeURIComponent(sourceUrl)}`;
  let res: Response;
  try {
    res = await fetch(viaProxy, { headers: { Authorization: `Bearer ${proxyToken}` } });
  } catch (err) {
    throw new Error(
      `${directError}; image proxy unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${directError}; image proxy ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'image/jpeg',
  };
}

/** Map a content-type to the file extension we store mirrors under. */
export function imageExtFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('avif')) return 'avif';
  return 'jpg';
}
