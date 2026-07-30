/**
 * Shared classification helpers for the UAE geography build.
 *
 * The Saudi layer arrived pre-tiered: the SPL dataset handed us region_id / city_id /
 * district_id on every row. OSM hands us a flat bag of boundaries and named places,
 * so the region → city → district tiering has to be DERIVED — and derived
 * defensibly, because a district attached to the wrong city disappears from the
 * cascade (the district list is filtered by city_lookup).
 */

// ── name normalization (mirrors src/lib/locationUtils.ts) ───────────────────
// Kept byte-identical in behaviour so the aliases this pipeline writes match what
// the app's matcher normalizes at query time.

export function normalizeAr(name) {
  return String(name ?? '')
    .replace(/^\s*حي\s+/, '')
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeEn(name) {
  return String(name ?? '')
    .replace(/\s*Dist\.?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Bare display name: drop the Arabic "حي" prefix, matching the Saudi convention. */
export const stripHayy = (s) => String(s ?? '').replace(/^\s*حي\s+/, '').trim();

/**
 * OSM English names for UAE emirates carry an "Emirate" suffix ("Dubai Emirate").
 * The cascade shows these raw, so trim it — buyers say "Dubai", not "Dubai Emirate".
 */
export const stripEmirate = (s) => String(s ?? '').replace(/\s*Emirate\s*$/i, '').trim();

// ── geometry predicates ─────────────────────────────────────────────────────

/** Ray-casting point-in-ring. */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in Polygon / MultiPolygon, honouring holes. */
export function pointInGeometry(point, geometry) {
  if (!geometry || !point) return false;
  const polys =
    geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates
    : [];
  for (const rings of polys) {
    if (!rings.length || !inRing(point, rings[0])) continue;
    let inHole = false;
    for (let h = 1; h < rings.length; h++) if (inRing(point, rings[h])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

export function bboxOf(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
      return;
    }
    for (const x of c) walk(x);
  };
  if (!geometry) return null;
  walk(geometry.coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

const inBbox = ([x, y], b) => !!b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/** Great-circle distance in km. */
export function haversineKm([lon1, lat1], [lon2, lat2]) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Distance in km from a point to the nearest edge of a geometry (0 if inside). */
export function distanceToGeometryKm(point, geometry) {
  if (!geometry) return Infinity;
  if (pointInGeometry(point, geometry)) return 0;
  let best = Infinity;
  const seg = (a, b) => {
    // Project onto the segment in degree space, then measure the real distance to the
    // projected point. Good enough at this latitude and far cheaper than a geodesic
    // solve — we only need it to rank candidates and compare against a few km.
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = dx === 0 && dy === 0 ? 0
      : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    const d = haversineKm(point, [a[0] + t * dx, a[1] + t * dy]);
    if (d < best) best = d;
  };
  const walkRing = (ring) => { for (let i = 1; i < ring.length; i++) seg(ring[i - 1], ring[i]); };
  const walk = (coords, depth) => {
    if (depth === 0) { /* a bare position — nothing to walk */ return; }
    if (typeof coords[0]?.[0] === 'number' && depth === 1) { walkRing(coords); return; }
    for (const c of coords) walk(c, depth - 1);
  };
  switch (geometry.type) {
    case 'Point': best = haversineKm(point, geometry.coordinates); break;
    case 'LineString': walkRing(geometry.coordinates); break;
    case 'MultiLineString': case 'Polygon': walk(geometry.coordinates, 2); break;
    case 'MultiPolygon': walk(geometry.coordinates, 3); break;
    default: break;
  }
  return best;
}

/**
 * Which emirate contains this point?
 *
 * 1. Exact containment in an emirate polygon (bbox pre-filtered).
 * 2. Inside the UAE COUNTRY polygon but outside every emirate → nearest emirate by
 *    true polygon distance. Emirate borders are traced independently and do not tile
 *    the country perfectly, so a legitimate point can fall in a seam.
 * 3. Otherwise → rejected.
 *
 * **There is deliberately no distance fallback** (`fallbackKm` defaults to 0). The
 * tempting version — "keep anything within a few km of an emirate edge, for coastal
 * reclamation that postdates the traced coastline" — cannot be made safe, because that
 * is geometrically indistinguishable from a foreign border town. Measured: Al Buraimi,
 * Oman is 2.32 km from Abu Dhabi's edge, closer than some offshore reclamation. An
 * earlier bbox-based version was worse still, scoring Al Buraimi at 0 km because it
 * sits in the concave notch of Abu Dhabi's bounding box beside Al Ain.
 *
 * So the country polygon is the only gate. Verified against OSM's actual tracing:
 * Palm Jumeirah, Yas, Saadiyat, Al Reem and Sir Bani Yas are all INSIDE their emirate
 * polygon already, so nothing real is being lost — and losing a handful of anchors
 * would still beat filing Omani territory as an Abu Dhabi district.
 */
export function locateEmirate(point, emirates, { country = null, fallbackKm = 0 } = {}) {
  for (const em of emirates) {
    if (!inBbox(point, em.bbox)) continue;
    if (pointInGeometry(point, em.geometry)) return { emirate: em, exact: true };
  }

  let best = null;
  for (const em of emirates) {
    if (!em.geometry) continue;
    const d = distanceToGeometryKm(point, em.geometry);
    if (!best || d < best.km) best = { emirate: em, km: d };
  }
  if (!best) return null;

  if (country && pointInGeometry(point, country)) {
    return { emirate: best.emirate, exact: false, km: best.km, why: 'inter-emirate seam' };
  }
  if (fallbackKm > 0 && best.km <= fallbackKm) {
    return { emirate: best.emirate, exact: false, km: best.km, why: 'outside the traced boundary' };
  }
  return null;
}

/**
 * Assign a district to a city: the nearest settlement IN THE SAME EMIRATE, capped.
 * Emirate-first matters — Ajman city sits ~2 km from Sharjah's built-up edge, so a
 * plain nearest-neighbour would scatter Ajman communities into Sharjah.
 * Returns null when nothing is close enough; the caller falls back to the emirate's
 * principal city so no district is ever left cityless (the cascade filters the
 * district list by city, so a cityless district is an invisible district).
 */
export function nearestCity(point, cities, emirateCode, { capKm = 60 } = {}) {
  let best = null;
  for (const c of cities) {
    if (c.emirate_code !== emirateCode || !c.point) continue;
    const d = haversineKm(point, c.point);
    if (!best || d < best.km) best = { city: c, km: d };
  }
  return best && best.km <= capKm ? best : null;
}

// ── OSM tag helpers ─────────────────────────────────────────────────────────

export const nameAr = (tags) => tags?.['name:ar'] || (isArabic(tags?.name) ? tags.name : '') || '';
export const nameEn = (tags) => tags?.['name:en'] || (isLatin(tags?.name) ? tags.name : '') || '';

const isArabic = (s) => !!s && /[؀-ۿ]/.test(s);
const isLatin = (s) => !!s && /[A-Za-z]/.test(s);

/** A stable, sortable external id: `AE-DXB-D0001`. */
export const extId = (emirateCode, kind, n) =>
  `AE-${emirateCode}-${kind}${String(n).padStart(4, '0')}`;
