/**
 * Decide which place labels a map may draw, so names never pile on top of each other.
 *
 * Attaching a label to every feature in view is fine over Riyadh — its districts are
 * large and few — and produces a solid black mass over Dubai, which packs ~500
 * districts into one city, many only a few hundred metres across. The same is true of
 * any dense city we add next, so the rule is measured in SCREEN PIXELS rather than a
 * hand-tuned zoom threshold, and needs no per-city configuration.
 *
 * Two steps, in the order a cartographer would apply them:
 *
 *   1. SIZE GATE — a feature gets a name only if it is physically big enough on screen
 *      to hold one. A district rendering 20 px wide cannot show «البرشاء جنوب 2»;
 *      drawing it there helps nobody and buries its neighbours.
 *   2. GREEDY COLLISION — biggest features place first, and any label whose text box
 *      would overlap one already placed is dropped.
 *
 * The result degrades the right way: zoomed out you get the major places named, and as
 * you zoom in the smaller ones gain room and appear on their own.
 *
 * Pure and framework-free so it can be unit-tested and shared by every map surface.
 */

export interface LabelCandidate {
  /** Stable id — what the caller uses to map the result back to its marker. */
  id: string;
  /** Text to be drawn; its length drives the width estimate. */
  text: string;
  /** Anchor point, in degrees. */
  lat: number;
  lng: number;
  /** Extent of the feature in degrees — how much room the name has to live in. */
  spanLat: number;
  spanLng: number;
  /**
   * Optional priority bump. Higher wins ties and places earlier — used so a SELECTED
   * district keeps its name even when a larger neighbour would out-rank it.
   */
  priority?: number;
}

export interface DeclutterOptions {
  /** Google Maps zoom level. */
  zoom: number;
  /** Map centre latitude, for the Mercator vertical correction. */
  centerLat: number;
  /** Average glyph width in px at the label's font size. */
  charPx?: number;
  /** Line height in px. */
  linePx?: number;
  /** Breathing room around each label's box, in px. Without it adjacent names sit
   *  flush against each other — legible in isolation, cramped as a field. */
  padPx?: number;
  /**
   * How much of the label's width the feature must span before it earns a name.
   * Below 1 lets a name slightly overhang its own shape, which reads fine and keeps
   * long names on narrow districts.
   */
  fitRatio?: number;
}

/**
 * @returns the ids that should be labelled, in placement order.
 */
export function pickVisibleLabels(
  candidates: LabelCandidate[],
  { zoom, centerLat, charPx = 6.2, linePx = 13, fitRatio = 0.75, padPx = 5 }: DeclutterOptions,
): Set<string> {
  const out = new Set<string>();
  if (!candidates.length || !Number.isFinite(zoom)) return out;

  // Degrees covered by one pixel at this zoom (the world is 256 px wide at z0).
  const degPerPx = 360 / (256 * Math.pow(2, Math.max(zoom, 1)));
  // A degree of LATITUDE covers more pixels than a degree of longitude, by 1/cos(lat)
  // — ~10% at Dubai's 25° and growing further north. That is the axis that decides
  // whether two horizontal labels collide, so it cannot be ignored.
  const latScale = Math.cos((centerLat * Math.PI) / 180) || 1;
  const degPerPxLat = degPerPx * latScale;

  const ranked = [...candidates].sort((a, b) => {
    const pa = a.priority ?? 0, pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    const areaA = (a.spanLat || 0) * (a.spanLng || 0);
    const areaB = (b.spanLat || 0) * (b.spanLng || 0);
    if (areaA !== areaB) return areaB - areaA;
    return a.id.localeCompare(b.id); // stable: same input, same labels, every frame
  });

  const placed: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const c of ranked) {
    const text = (c.text ?? '').trim();
    if (!text) continue;
    const wPx = Math.max(24, text.length * charPx);

    // Step 1 — is the feature big enough on screen to carry its own name?
    // A priority candidate (e.g. the district you just selected) skips the gate: you
    // asked for it, so it is named however small it is.
    const isPriority = (c.priority ?? 0) > 0;
    if (!isPriority) {
      const boxW = (c.spanLng || 0) / degPerPx;
      const boxH = (c.spanLat || 0) / degPerPxLat;
      if (boxW < wPx * fitRatio || boxH < linePx * 1.2) continue;
    }

    // Step 2 — would it land on a name already placed?
    const cx = c.lng / degPerPx;
    const cy = -c.lat / degPerPxLat; // y grows downward; only consistency matters
    const halfW = wPx / 2 + padPx;
    const halfH = linePx / 2 + padPx;
    const box = { x1: cx - halfW, y1: cy - halfH, x2: cx + halfW, y2: cy + halfH };
    if (placed.some((p) => box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1)) continue;

    placed.push(box);
    out.add(c.id);
  }
  return out;
}

/** Bounding box + centroid of a GeoJSON Polygon/MultiPolygon, in degrees. */
export function geometryExtent(geometry: unknown): {
  lat: number; lng: number; spanLat: number; spanLng: number;
} | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g || !Array.isArray(g.coordinates)) return null;

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  let sumLat = 0, sumLng = 0, n = 0;
  const ring = (r: unknown) => {
    if (!Array.isArray(r)) return;
    for (const pt of r) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const lng = Number(pt[0]), lat = Number(pt[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      sumLat += lat; sumLng += lng; n++;
    }
  };
  if (g.type === 'Polygon') for (const r of g.coordinates) ring(r);
  else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) { if (Array.isArray(poly)) for (const r of poly) ring(r); }
  else return null;

  if (!n) return null;
  return {
    // Ring-average rather than bbox centre: for a concave or multi-part shape the bbox
    // centre can sit outside the shape entirely, which is where the label would land.
    lat: sumLat / n, lng: sumLng / n,
    spanLat: maxLat - minLat, spanLng: maxLng - minLng,
  };
}
