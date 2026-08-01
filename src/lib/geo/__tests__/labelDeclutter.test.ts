import { describe, it, expect } from 'vitest';
import { pickVisibleLabels, geometryExtent, type LabelCandidate } from '../labelDeclutter';

/**
 * Guards the rule that keeps dense cities readable. The failure this prevents is not
 * subtle — with every in-view district labelled, Dubai's core rendered as a solid black
 * mass of overlapping names, reported from the live app twice.
 */

const at = (id: string, lat: number, lng: number, span: number, text = 'حي'): LabelCandidate =>
  ({ id, text, lat, lng, spanLat: span, spanLng: span });

describe('pickVisibleLabels — size gate', () => {
  it('labels a district big enough to hold its name', () => {
    // ~0.05° across at z13 is several hundred pixels — plenty of room.
    const got = pickVisibleLabels([at('big', 25, 55, 0.05)], { zoom: 13, centerLat: 25 });
    expect(got.has('big')).toBe(true);
  });

  it('drops a district too small on screen to carry one', () => {
    // Same district, same zoom, but a few metres across — it would render as a speck
    // with a name far wider than the shape itself.
    const got = pickVisibleLabels([at('tiny', 25, 55, 0.00005)], { zoom: 13, centerLat: 25 });
    expect(got.has('tiny')).toBe(false);
  });

  it('reveals a district as you zoom in — the same shape earns its name', () => {
    const c = [at('mid', 25, 55, 0.004)];
    const out = pickVisibleLabels(c, { zoom: 11, centerLat: 25 });
    const inn = pickVisibleLabels(c, { zoom: 16, centerLat: 25 });
    expect(out.has('mid')).toBe(false);
    expect(inn.has('mid')).toBe(true);
  });

  it('gives a longer name a harder test than a short one at the same size', () => {
    // ~0.008° ≈ 900 m, which is 47 px at z13 — room for a short name, not a long one.
    const size = 0.008;
    const short = pickVisibleLabels([{ ...at('s', 25, 55, size), text: 'ندد' }], { zoom: 13, centerLat: 25 });
    const long = pickVisibleLabels([{ ...at('l', 25, 55, size), text: 'البرشاء جنوب 2 الحديثة' }], { zoom: 13, centerLat: 25 });
    expect(short.has('s')).toBe(true);
    expect(long.has('l')).toBe(false);
  });
});

describe('pickVisibleLabels — collision', () => {
  it('keeps only one of two names stacked on the same spot', () => {
    const got = pickVisibleLabels([
      at('a', 25, 55, 0.05),
      at('b', 25.00001, 55.00001, 0.04),
    ], { zoom: 13, centerLat: 25 });
    expect(got.size).toBe(1);
  });

  it('keeps the BIGGER district when two collide', () => {
    const got = pickVisibleLabels([
      at('small', 25, 55, 0.02),
      at('large', 25.00001, 55.00001, 0.09),
    ], { zoom: 13, centerLat: 25 });
    expect(got.has('large')).toBe(true);
    expect(got.has('small')).toBe(false);
  });

  it('labels both when they are far enough apart', () => {
    const got = pickVisibleLabels([
      at('a', 25, 55, 0.05),
      at('b', 25.2, 55.2, 0.05),
    ], { zoom: 13, centerLat: 25 });
    expect(got.size).toBe(2);
  });

  it('is deterministic — the same input labels the same places every frame', () => {
    const rows = Array.from({ length: 30 }, (_, i) => at(`d${i}`, 25 + i * 0.0004, 55, 0.02));
    const a = pickVisibleLabels(rows, { zoom: 13, centerLat: 25 });
    const b = pickVisibleLabels([...rows].reverse(), { zoom: 13, centerLat: 25 });
    expect([...a].sort()).toEqual([...b].sort());
  });
});

describe('pickVisibleLabels — priority', () => {
  it('names a selected district however small, and lets it win a collision', () => {
    const got = pickVisibleLabels([
      { ...at('big', 25.00001, 55.00001, 0.09), priority: 0 },
      { ...at('picked', 25, 55, 0.00005), priority: 1 },
    ], { zoom: 13, centerLat: 25 });
    expect(got.has('picked')).toBe(true);
    expect(got.has('big')).toBe(false);
  });
});

describe('pickVisibleLabels — density, the actual reported bug', () => {
  it('caps a Dubai-like cluster instead of labelling all of it', () => {
    // 300 districts of a realistic small-community size (~900 m), packed on a 500 m
    // grid — which is what Dubai's core actually is. Each is individually big enough
    // to earn a name; it is their NEIGHBOURS that must silence most of them.
    const rows = Array.from({ length: 300 }, (_, i) =>
      at(`d${i}`, 25 + (i % 20) * 0.005, 55 + Math.floor(i / 20) * 0.005, 0.008, 'حي البرشاء'));
    const got = pickVisibleLabels(rows, { zoom: 13, centerLat: 25 });

    // The property that matters is not a magic count — it is that NOTHING the map
    // draws overlaps anything else it draws. Verify it directly on the chosen set.
    const degPerPx = 360 / (256 * Math.pow(2, 13));
    const degPerPxLat = degPerPx * Math.cos((25 * Math.PI) / 180);
    const boxes = rows.filter((r) => got.has(r.id)).map((r) => {
      const w = Math.max(24, r.text.length * 6.2) / 2 + 5;
      const h = 13 / 2 + 5;
      const cx = r.lng / degPerPx, cy = -r.lat / degPerPxLat;
      return { x1: cx - w, y1: cy - h, x2: cx + w, y2: cy + h };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const overlaps = a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
        expect(overlaps, `labels ${i} and ${j} overlap`).toBe(false);
      }
    }
    // A meaningful reduction — the exact number is a property of the grid, not a
    // contract. The no-overlap check above is the real assertion.
    expect(got.size).toBeGreaterThan(0);
    expect(got.size).toBeLessThan(rows.length * 0.4);
  });

  it('empty input is not an error', () => {
    expect(pickVisibleLabels([], { zoom: 13, centerLat: 25 }).size).toBe(0);
  });
});

describe('geometryExtent', () => {
  it('measures a Polygon', () => {
    const e = geometryExtent({ type: 'Polygon', coordinates: [[[55, 25], [55.1, 25], [55.1, 25.2], [55, 25.2], [55, 25]]] });
    expect(e?.spanLng).toBeCloseTo(0.1, 6);
    expect(e?.spanLat).toBeCloseTo(0.2, 6);
  });

  it('measures a MultiPolygon across all its parts', () => {
    const e = geometryExtent({ type: 'MultiPolygon', coordinates: [
      [[[55, 25], [55.1, 25], [55.1, 25.1], [55, 25]]],
      [[[56, 26], [56.1, 26], [56.1, 26.1], [56, 26]]],
    ] });
    expect(e?.spanLng).toBeCloseTo(1.1, 6);
    expect(e?.spanLat).toBeCloseTo(1.1, 6);
  });

  it('returns null rather than throwing on junk', () => {
    expect(geometryExtent(null)).toBeNull();
    expect(geometryExtent({ type: 'Point', coordinates: [55, 25] })).toBeNull();
    expect(geometryExtent({ type: 'Polygon' })).toBeNull();
  });
});
