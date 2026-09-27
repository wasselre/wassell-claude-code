import { describe, it, expect } from 'vitest';
import {
  placementsByEvidence, placementElementIds, placementSentence, renderPlacements, verifierMentionsFor,
  type Placement, type PlaceName,
} from '../placementText.js';
import type { GeoPreference, GeometryRecipe, AnchorToken } from '../ontology.js';

/**
 * placementText: "what did the AI put on the map for this mention", in Arabic
 * words — the verifier's input, mirroring the grader's placementLine.
 */

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const ROAD = 'RUH-ROAD-0694';

const anchor = (span: string): AnchorToken => ({ anchor_type: 'district', span, normalized_token: span });
function recipe(over: Partial<GeometryRecipe>): GeometryRecipe {
  return {
    operation: 'district_polygon', source_anchors: [], resolved_element_ids: [],
    geo_data_version: 'v1', resolver_version: 'r1', compiled_at: '2026-09-27T00:00:00Z', ...over,
  };
}
function expr(refs: Array<{ eid: string; op?: 'include' | 'exclude'; recipe: GeometryRecipe }>): GeoPreference {
  return {
    schema_version: 'v1',
    groups: [{
      id: 'g1', role: 'primary', strength: 'soft', priority: 1,
      clauses: refs.map((r) => ({ op: r.op ?? 'include', anyOf: [{ geometry_id: `geo:${r.eid}`, recipe: r.recipe }] })),
    }],
  };
}

const NAMES: Record<string, PlaceName> = {
  [D1]: { name_ar: 'النرجس', city: 'الرياض' },
  [D2]: { name_ar: 'العليا', city: 'الرياض' },
  [ROAD]: { name_ar: 'طريق الملك فهد' },
};

describe('placementsByEvidence', () => {
  it('keys placements by the evidence id behind geo:<id> and carries polarity + resolution', () => {
    const p = placementsByEvidence(expr([
      { eid: 'e1', recipe: recipe({ resolved_element_ids: [D1], source_anchors: [anchor('النرجس')] }) },
      { eid: 'e2', op: 'exclude', recipe: recipe({ resolved_element_ids: [D2], source_anchors: [anchor('العليا')] }) },
      { eid: 'e3', recipe: recipe({ resolved_element_ids: ['الملقا'], geo_data_version: 'stub' }) },
    ]));
    expect(p.e1).toMatchObject({ polarity: 'include', element_ids: [D1], resolved: true, label: 'النرجس' });
    expect(p.e2).toMatchObject({ polarity: 'exclude', resolved: true });
    expect(p.e3!.resolved).toBe(false);
    expect(p.e1!.radius_m).toBeUndefined();
  });

  it('empty / malformed expression → no placements', () => {
    expect(placementsByEvidence(null)).toEqual({});
    expect(placementsByEvidence({ schema_version: 'v1' } as unknown as GeoPreference)).toEqual({});
  });

  it('placementElementIds splits uuids (districts) from external ids (roads) and skips unresolved names', () => {
    const p = placementsByEvidence(expr([
      { eid: 'e1', recipe: recipe({ operation: 'district_side_clip', resolved_element_ids: [D1, ROAD], side: 'west' }) },
      { eid: 'e2', recipe: recipe({ resolved_element_ids: ['الملقا'], geo_data_version: 'stub' }) },
    ]));
    expect(placementElementIds(p)).toEqual({ districtIds: [D1], elementIds: [ROAD] });
  });
});

describe('placementSentence', () => {
  const base: Placement = { polarity: 'include', operation: 'district_polygon', element_ids: [D1], resolved: true, label: 'النرجس' };

  it('a district list, by name with its city', () => {
    expect(placementSentence(base, NAMES)).toBe('حدّد: النرجس (الرياض)');
    expect(placementSentence({ ...base, element_ids: [D1, D2] }, NAMES)).toBe('حدّد: النرجس (الرياض)، العليا (الرياض)');
  });

  it('an exclusion says استبعد', () => {
    expect(placementSentence({ ...base, polarity: 'exclude' }, NAMES)).toBe('استبعد: النرجس (الرياض)');
  });

  it('a zone, or more than six districts, is summarised with its label and a count', () => {
    const ids = Array.from({ length: 37 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    expect(placementSentence({ ...base, operation: 'zone_union', element_ids: ids, label: 'شمال الرياض' }, NAMES)).toBe('حدّد: شمال الرياض — 37 حيًا');
    expect(placementSentence({ ...base, operation: 'district_union', element_ids: ids.slice(0, 7), label: 'الأحياء' }, NAMES)).toBe('حدّد: الأحياء — 7 حيًا');
  });

  it('a clipped district names the kept parts, the dropped ones, and the road side', () => {
    const s = placementSentence({
      ...base, operation: 'district_side_clip', element_ids: [D1, D2, ROAD], side: 'west',
      clip_parts: [
        { name: 'النرجس', kept: true, crossed: true, kept_km2: 4.2, total_km2: 6.1 },
        { name: 'العليا', kept: false, crossed: false, kept_km2: 0, total_km2: 3 },
      ],
    }, NAMES);
    expect(s).toBe('حدّد: النرجس (4.2 من 6.1 كم²)، العليا (كله على الجهة الأخرى — أُسقط) — غرب طريق الملك فهد');
  });

  it('a radius names the landmark and the distance', () => {
    expect(placementSentence({ ...base, operation: 'within_radius', element_ids: [ROAD], radius_m: 2000 }, NAMES)).toBe('حدّد: ضمن 2 كم من طريق الملك فهد');
    expect(placementSentence({ ...base, operation: 'corridor', element_ids: [ROAD], radius_m: 1500 }, NAMES)).toBe('حدّد: على امتداد طريق الملك فهد (بعرض 1.5 كم)');
  });

  it('an unresolved mention says no real place was picked', () => {
    expect(placementSentence({ ...base, resolved: false, element_ids: ['الملقا'] }, NAMES)).toBe('لم يُحدَّد مكان حقيقي لـ «الملقا» — يحتاج تأكيدًا');
    expect(placementSentence({ ...base, resolved: false, element_ids: [], label: 'الشرق' }, NAMES)).toBe('لم يُحدَّد مكان حقيقي لـ «الشرق» — يحتاج تأكيدًا');
  });

  it('an unknown id falls back to the id itself rather than disappearing', () => {
    expect(placementSentence({ ...base, element_ids: ['99999999-9999-4999-8999-999999999999'] }, {})).toBe('حدّد: 99999999-9999-4999-8999-999999999999');
  });
});

describe('renderPlacements / verifierMentionsFor', () => {
  const e = expr([
    { eid: 'e1', recipe: recipe({ resolved_element_ids: [D1] }) },
    { eid: 'e2', op: 'exclude', recipe: recipe({ resolved_element_ids: [D2], radius_or_band_m: 1000, operation: 'within_distance' }) },
  ]);

  it('renderPlacements returns one mention per placement', () => {
    expect(renderPlacements(e, NAMES)).toEqual([
      { evidence_id: 'e1', polarity: 'include', placed: 'حدّد: النرجس (الرياض)', on_map: true },
      { evidence_id: 'e2', polarity: 'exclude', placed: 'استبعد: ضمن 1 كم من العليا (الرياض)', on_map: true },
    ]);
  });

  it('verifierMentionsFor lists EVERY mention, stating the unplaced ones plainly', () => {
    const out = verifierMentionsFor([
      { id: 'e1', mention_span: 'أبي النرجس', preference_role: 'positive' },
      { id: 'e3', mention_span: 'عندنا في الخبر أرخص', preference_role: 'none' },
      { id: 'e4', mention_span: 'الملقا', preference_role: 'negative' },
    ], e, NAMES);
    expect(out.map((m) => m.evidence_id)).toEqual(['e1', 'e3', 'e4']);
    expect(out[0]).toMatchObject({ on_map: true, placed: 'حدّد: النرجس (الرياض)', mention_span: 'أبي النرجس' });
    expect(out[1]).toMatchObject({ on_map: false, placed: 'اعتبره ليس تفضيلًا — لم يضع شيئًا على الخريطة' });
    expect(out[2]).toMatchObject({ on_map: false, polarity: 'exclude', placed: 'لم يُوضع على الخريطة' });
  });
});
