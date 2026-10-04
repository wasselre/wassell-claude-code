import { describe, it, expect } from 'vitest';
import { placementLine, placementSavable, sideClipStateOf, kmLabel } from '../placementLine';
import type { DistrictInfo, Placement } from '../shared';
import { buildGeoRows, blockedReason, type GeoCardDTO } from '@/pages/Chats/lib/geoRows';

/**
 * The card's sentence for road sides, distances and side clips (2026-10-03):
 * the rep must read the SIDE and the DISTANCE a rule saves, and a side clip
 * that keeps nothing must say so and not be tickable.
 */

const names: Record<string, DistrictInfo> = {
  dm: { name_ar: 'الملقا', name_en: 'Al Malqa', city: 'الرياض' },
  ksr: { name_ar: 'طريق الملك سلمان', name_en: 'King Salman Road', city: 'الرياض' },
  kfr: { name_ar: 'طريق الملك فهد', name_en: 'King Fahd Road', city: 'الرياض' },
  park: { name_ar: 'الرياض بارك', name_en: 'Riyadh Park', city: 'الرياض' },
};
const pl = (over: Partial<Placement>): Placement => ({
  polarity: 'include', operation: 'district_polygon', element_ids: ['dm'], resolved: true, label: '', ...over,
});
const clip = (over: Partial<Placement> = {}): Placement => pl({
  operation: 'district_side_clip', element_ids: ['dm', 'ksr'], side: 'north', ...over,
});

describe('placementLine — sides and distances (finding 25)', () => {
  it('two sides of one road read differently, with the band depth', () => {
    const west = placementLine(pl({ operation: 'directional_band', element_ids: ['kfr'], side: 'west', radius_m: 5000 }), 'positive', names, true);
    const east = placementLine(pl({ operation: 'directional_band', element_ids: ['kfr'], side: 'east', radius_m: 5000, polarity: 'exclude' }), 'negative', names, true);
    expect(west).toEqual({ text: 'حدّد: غرب طريق الملك فهد · ٥ كم', tone: 'ok' });
    expect(east).toEqual({ text: 'استبعد: شرق طريق الملك فهد · ٥ كم', tone: 'ok' });
    expect(placementLine(pl({ operation: 'directional_band', element_ids: ['kfr'], side: 'west', radius_m: 2500 }), 'positive', names, false).text)
      .toBe('selected: West of King Fahd Road · 2.5 km');
  });

  it('a distance rule reads «قرب X · N كم», not the bare venue', () => {
    expect(placementLine(pl({ operation: 'within_distance', element_ids: ['park'], radius_m: 3000 }), 'positive', names, true).text)
      .toBe('حدّد: قرب الرياض بارك · ٣ كم');
    expect(placementLine(pl({ operation: 'within_radius', element_ids: ['park'], radius_m: 3000 }), 'positive', names, false).text)
      .toBe('selected: Near Riyadh Park · 3 km');
  });

  it('round 3 #20/#22: a road side with NO side (a legacy diagonal band) warns, is not savable, and is never re-guessed from its label', () => {
    for (const label of ['شمال شرق الملك فهد', 'west of King Fahd Road', 'غرب الملك فهد']) {
      const p = pl({ operation: 'directional_band', element_ids: ['kfr'], side: null, radius_m: 5000, label });
      expect(placementLine(p, 'positive', names, true)).toEqual({ text: 'تعذّر تحديد جهة الطريق: طريق الملك فهد — لن يُحفظ', tone: 'warn' });
      expect(placementLine(p, 'positive', names, false).tone).toBe('warn');
      expect(placementSavable(p)).toBe(false);
      expect(blockedReason(p)).toBe('band_no_side');
    }
    // With the server's side it is an ordinary tickable road side.
    const ok = pl({ operation: 'directional_band', element_ids: ['kfr'], side: 'west', radius_m: 5000 });
    expect(placementSavable(ok)).toBe(true);
    expect(blockedReason(ok)).toBeNull();
  });

  it('kmLabel: one decimal under 10 km with «٫», whole km from 10 up', () => {
    expect(kmLabel(5000, true)).toBe('٥');
    expect(kmLabel(2500, true)).toBe('٢٫٥');
    expect(kmLabel(12_400, true)).toBe('١٢');
    expect(kmLabel(2500, false)).toBe('2.5');
  });
});

describe('a side clip — «النرجس — الجزء الشمالي من طريق الملك سلمان»; nothing kept ⇒ a warning, not tickable (finding 23)', () => {
  it('a clip that keeps a part names the part on that side', () => {
    const p = clip({ clip_state: 'ok', clip_parts: [{ name: 'الملقا', kept: true, crossed: true, kept_km2: 4.2, total_km2: 21.85 }] });
    expect(placementLine(p, 'positive', names, true)).toEqual({ text: 'حدّد: الملقا (4.2 من 21.85 كم²) — الجزء الشمالي من طريق الملك سلمان', tone: 'ok' });
    expect(placementSavable(p)).toBe(true);
  });

  it('every district on the other side → «لا يقع جزء من الحي على هذا الجانب», warn, not savable', () => {
    const p = clip({ clip_state: 'empty', clip_parts: [{ name: 'الملقا', kept: false, crossed: false, kept_km2: 0, total_km2: 21.85 }] });
    expect(placementLine(p, 'positive', names, true)).toEqual({ text: 'لا يقع جزء من الحي على هذا الجانب: الملقا — الجزء الشمالي من طريق الملك سلمان', tone: 'warn' });
    expect(placementSavable(p)).toBe(false);
    // Without the server's flag the parts alone say the same.
    expect(sideClipStateOf(clip({ clip_parts: [{ name: 'الملقا', kept: false, crossed: false, kept_km2: 0, total_km2: 21.85 }] }))).toBe('empty');
  });

  it('never computed (a legacy row) → «تعذّر حساب الجزء», warn, not savable', () => {
    const p = clip();
    expect(sideClipStateOf(p)).toBe('missing');
    expect(placementLine(p, 'positive', names, true)).toEqual({ text: 'تعذّر حساب الجزء: الملقا — الجزء الشمالي من طريق الملك سلمان', tone: 'warn' });
    expect(placementSavable(p)).toBe(false);
  });

  it('the chat card row is not tickable for it; other places still are', () => {
    const card: GeoCardDTO = {
      status: 'pending', checkpoint_id: 'cp', analyzed_at: null, stale: false, graded: false, can_reanalyze: true, customer_messages: 1,
      names,
      mentions: [
        { evidence_id: 'e1', mention_span: 'ابي الملقا شمال سلمان', preference_role: 'positive' },
        { evidence_id: 'e2', mention_span: 'ابي غرب الملك فهد', preference_role: 'positive' },
        { evidence_id: 'e3', mention_span: 'الورود', preference_role: 'positive' },
      ],
      proposal: {
        id: 'p1', version: 1, status: 'pending', proposed_action: 'confirm', expression: { groups: [] }, items: [], items_by_evidence: {}, verifier: null,
        by_evidence: {
          e1: clip({ clip_state: 'empty', clip_parts: [{ name: 'الملقا', kept: false, crossed: false, kept_km2: 0, total_km2: 21.85 }] }),
          e2: pl({ operation: 'directional_band', element_ids: ['kfr'], side: 'west', radius_m: 5000 }),
          e3: pl({ resolved: false, element_ids: ['الورود'] }),
        },
      },
    };
    const rows = buildGeoRows(card, true);
    expect(rows.map((r) => [r.evidenceId, r.savable, r.line.tone, r.blocked])).toEqual([
      ['e1', false, 'warn', 'side_empty'], ['e2', true, 'ok', null], ['e3', false, 'warn', null],
    ]);
  });

  it('a legacy clip with no shape is blocked as "never computed"; a clip that keeps a part is not blocked', () => {
    expect(blockedReason(clip())).toBe('side_missing');
    expect(blockedReason(clip({ clip_state: 'ok', clip_parts: [{ name: 'الملقا', kept: true, crossed: false, kept_km2: 21.85, total_km2: 21.85 }] }))).toBeNull();
    expect(blockedReason(clip({ resolved: false }))).toBeNull();
  });
});
