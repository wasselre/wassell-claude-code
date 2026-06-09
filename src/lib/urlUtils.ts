// URL helpers shared across the record-editing surfaces (DynamicField,
// MultiLinkFieldInput, the inline table editor, and nested table columns).

/** A latitude/longitude pair pulled from a Google Maps URL, kept as the raw
 *  strings from the URL so we never lose precision by re-formatting. */
interface LatLng {
  lat: string;
  lng: string;
}

// A single signed decimal coordinate component, e.g. `24.7135517` or `-46.6`.
const COORD = String.raw`(-?\d+(?:\.\d+)?)`;

function isValidLatLng(latStr: string, lngStr: string): boolean {
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  // 0,0 ("Null Island", mid-Atlantic) is almost always a parse artifact rather
  // than a pin a user pasted — treat it as no-match so we don't rewrite to it.
  if (lat === 0 && lng === 0) return false;
  return true;
}

/** Turn a `(lat)(lng)` regex match into a validated LatLng, or null. Narrows
 *  the `string | undefined` capture groups for callers under
 *  `noUncheckedIndexedAccess`. */
function coordsFromMatch(m: RegExpMatchArray | null): LatLng | null {
  const lat = m?.[1];
  const lng = m?.[2];
  if (lat === undefined || lng === undefined) return null;
  return isValidLatLng(lat, lng) ? { lat, lng } : null;
}

/**
 * True for any Google host, including country TLDs (google.com.sa, google.de,
 * google.co.uk) and the www./maps. subdomains. Deliberately rejects look-alikes
 * such as `google.evil.com` so we never rewrite based on a spoofed host.
 */
function isGoogleHost(host: string): boolean {
  if (host === 'google.com' || host.endsWith('.google.com')) return true;
  // google.<cctld> / google.<sld>.<cc>, optionally prefixed by www. / maps.
  // e.g. google.de, google.com.sa, www.google.co.uk, maps.google.com.eg
  return /^(?:www\.|maps\.)?google\.(?:[a-z]{2,3})(?:\.[a-z]{2})?$/.test(host);
}

function isGoogleMapsUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (!isGoogleHost(host)) return false;
  // The maps.* subdomain is Maps regardless of path (e.g. maps.google.com/?q=).
  if (host === 'maps.google.com' || host.startsWith('maps.google.')) return true;
  // Otherwise require a /maps path (google.com/maps/..., google.com/maps?...).
  return /^\/maps(?:\/|$)/.test(url.pathname);
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    // Not a parseable URL (stray spaces, no host, etc.) — caller leaves it as-is.
    return null;
  }
}

/**
 * Pull the most reliable lat/lng out of a Google Maps URL. Preference order:
 *  1. `!3d<lat>!4d<lng>` — the exact pin baked into the place "data" blob.
 *  2. `@<lat>,<lng>`      — the map viewport center.
 *  3. `?q=` / `?query=` / `?ll=` `<lat>,<lng>` query params.
 * Returns null when no confident coordinate is present (a place name only, a
 * directions link, an opaque short link, etc.).
 */
function extractMapsLatLng(url: URL): LatLng | null {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    // decodeURIComponent throws on a malformed %-escape — fall back to the raw
    // pathname so a stray % doesn't sink the whole extraction.
    path = url.pathname;
  }

  const pin = coordsFromMatch(path.match(new RegExp(`!3d${COORD}!4d${COORD}`)));
  if (pin) return pin;

  const at = coordsFromMatch(path.match(new RegExp(`@${COORD},${COORD}`)));
  if (at) return at;

  for (const key of ['q', 'query', 'll']) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    const fromParam = coordsFromMatch(value.match(new RegExp(`^\\s*${COORD},\\s*${COORD}\\s*$`)));
    if (fromParam) return fromParam;
  }
  return null;
}

/**
 * Collapse a long Google Maps link into the shortest form that still opens the
 * same pin: `https://www.google.com/maps?q=<lat>,<lng>`.
 *
 * Deliberately conservative — it only rewrites when ALL of the following hold:
 *  - the input parses as a URL on a recognised Google Maps host,
 *  - it is NOT a multi-stop directions link (collapsing would drop the route),
 *  - a single valid coordinate can be extracted, and
 *  - the canonical form is actually shorter than the input.
 *
 * Opaque share links (maps.app.goo.gl, goo.gl/maps) are intentionally left
 * alone: they're already short and the coordinates live behind a server
 * redirect we can't follow client-side. For those — and for non-Maps URLs,
 * non-URLs, and Maps URLs we can't confidently parse — it returns the input
 * UNCHANGED. We never silently mangle a working link; the worst case is "we
 * left it exactly as the user typed it".
 */
export function shortenGoogleMapsUrl(input: string): string {
  if (typeof input !== 'string') return input;
  const raw = input.trim();
  if (!raw) return input;

  const url = parseUrl(raw);
  if (!url || !isGoogleMapsUrl(url)) return input;

  // Multi-stop directions — collapsing to one pin would lose the route.
  if (/^\/maps\/dir(?:\/|$)/.test(url.pathname)) return input;

  const coords = extractMapsLatLng(url);
  if (!coords) return input;

  const short = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  // Only adopt the rewrite when it genuinely shortens the link, so already-clean
  // URLs (and the rare case where our canonical form is longer) are left as-is —
  // this also makes the function idempotent on its own output.
  return short.length < raw.length ? short : input;
}
