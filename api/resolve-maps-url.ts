/**
 * Vercel edge function: resolve a Google Maps URL (short or long) to lat/lng.
 *
 * Short `maps.app.goo.gl` links redirect server-side; browsers can't follow
 * that redirect (CORS). This function runs server-side, follows the redirect,
 * and extracts coordinates from the final URL.
 *
 * Also handles long-form URLs with coordinates buried in the path — though
 * those can usually be parsed client-side in locationUtils.ts#parseGoogleMapsUrl.
 */

export const config = {
  runtime: 'edge',
};

interface ResolveResponse {
  lat: number | null;
  lng: number | null;
  finalUrl?: string;
  error?: string;
}

const GOOGLE_HOST = /^https?:\/\/([^/]+\.)?(google\.[a-z.]+|goo\.gl|g\.co)\//i;

export default async function handler(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');

  if (!url) {
    return json({ lat: null, lng: null, error: 'missing url param' }, 400);
  }
  if (!GOOGLE_HOST.test(url)) {
    return json({ lat: null, lng: null, error: 'only google maps urls are allowed' }, 400);
  }

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        // Googlebot-ish UA — Google sometimes returns a lightweight redirect
        // for browser UAs and a richer page for bots. Either way res.url is
        // the final URL after redirects.
        'User-Agent': 'Mozilla/5.0 (compatible; WassellBot/1.0; +https://app.wassel.re)',
      },
    });

    const finalUrl = res.url;
    const coords =
      parseFromUrl(finalUrl) ??
      (await parseFromBody(res));

    if (!coords) {
      return json({ lat: null, lng: null, finalUrl }, 200);
    }
    return json({ lat: coords.lat, lng: coords.lng, finalUrl }, 200, {
      // Cache the response for a year — Google Maps short URLs resolve to
      // stable targets. Also lets Vercel's edge cache serve repeat hits
      // without re-running the function.
      'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
    });
  } catch (err) {
    return json({ lat: null, lng: null, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function parseFromUrl(url: string): { lat: number; lng: number } | null {
  // Order matters — !3d!4d is the most accurate (place coords), then /@ (viewport), then ?q/?ll
  const placeMatch = url.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  if (placeMatch) return toLatLng(placeMatch[1], placeMatch[2]);

  const atMatch = url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atMatch) return toLatLng(atMatch[1], atMatch[2]);

  const qMatch = url.match(/[?&](?:q|ll|query)=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (qMatch) return toLatLng(qMatch[1], qMatch[2]);

  // Path-based: /maps/search/LAT,+LNG/... or /maps/place/.../LAT,LNG/...
  const pathMatch = url.match(/\/(?:search|place|dir)\/(-?\d+\.?\d*)[,\s+](?:\+|%20)?\s*(-?\d+\.?\d*)/);
  if (pathMatch) return toLatLng(pathMatch[1], pathMatch[2]);

  return null;
}

// Fallback: if the final URL doesn't carry coords, scrape them out of the
// HTML body. Google embeds them in several places — meta tags, inline JSON,
// and the APP_INITIALIZATION_STATE blob. We try the cheapest matches first.
async function parseFromBody(res: Response): Promise<{ lat: number; lng: number } | null> {
  try {
    const body = await res.text();

    // Meta og:url often carries the canonical URL with coords
    const ogMatch = body.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
    if (ogMatch?.[1]) {
      const fromOg = parseFromUrl(ogMatch[1]);
      if (fromOg) return fromOg;
    }

    // Inline /@lat,lng or !3d!4d anywhere in the page
    const anywhere = parseFromUrl(body);
    if (anywhere) return anywhere;

    return null;
  } catch {
    return null;
  }
}

/** Takes the capture groups straight from a regex match, which are
 *  `string | undefined` — a pattern can match while a group does not. Number()
 *  turns undefined into NaN, so the finite check below already rejected that
 *  case; accepting the honest type just makes it visible. */
function toLatLng(latStr: string | undefined, lngStr: string | undefined): { lat: number; lng: number } | null {
  if (latStr === undefined || lngStr === undefined) return null;
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function json(body: ResolveResponse, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
