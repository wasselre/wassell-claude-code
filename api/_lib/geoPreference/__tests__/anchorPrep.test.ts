import { describe, it, expect } from 'vitest';
import {
  prepareMention, prepareEvidence, bareRoyalName, venueTailAfter, proximityTargets, tokenize, locatePhrase,
  anchorOccurrences, mentionStrings, offeredAsAlternative,
} from '../anchorPrep.js';
import { sanitizeDistanceM, type AnchorToken, type Evidence } from '../ontology.js';
import { parseExtractorOutput, EXTRACT_SYSTEM_PROMPT, EXTRACTOR_VERSION, type Conversation } from '../extractor.js';

/**
 * Pure tests for the per-mention anchor preparation — the LEGACY path
 * (anchorPrep.ts; binding design 2026-10-04 §2.1, tests §6.2). Every decision
 * is made from the TEXT of the mention, by whole words — never by array
 * position or substring. Nothing here touches a database; the end-to-end
 * outcomes are in roadSideLandmark.test.ts.
 *
 * Expectations changed ON PURPOSE by the 2026-10-04 design (§5.4) carry a
 * comment naming the rule: the conjunction rules and the royal «undo» are gone
 * (BD2, P5 c), «على / من» are no longer fold connectors (P4), a region owner
 * asks (P6), a district beside ONE named city is that city's (P9), and a
 * distance the customer did not say asks (P10).
 */

const a = (anchor_type: AnchorToken['anchor_type'], span: string, extra: Partial<AnchorToken> = {}): AnchorToken =>
  ({ anchor_type, span, normalized_token: span, ...extra });

function ev(mention_span: string, anchors: AnchorToken[], ref = 'm1'): Evidence {
  return {
    id: 'e1', mention_span, anchors,
    speaker: 'client', preference_holder: 'client', holder_role: 'buyer', quoted_speaker: 'none',
    dialogue_act: 'statement', conditionality: 'asserted', temporal_reference: 'present',
    preference_applicability: 'active', preference_role: 'positive', commitment: 'preferred',
    hardness_evidence: 'none', modality: 'explicit',
    source: { channel: 'chat', ref, timestamp: '2026-10-01T00:00:00Z' },
  };
}
const shape = (p: { anchors: AnchorToken[] }) => p.anchors.map((x) => [x.anchor_type, x.normalized_token]);
const asks = (p: { contexts: Array<{ ask_reason?: string }> }) => p.contexts.map((c) => c.ask_reason ?? null);

describe('mention text — whole words', () => {
  it('tokenize folds spelling and remembers punctuation; locatePhrase allows a clitic on the first word only', () => {
    const t = tokenize('ابي بالنرجس، شمال لـطريق الملك فهد');
    expect(t.map((x) => x.f)).toEqual(['ابي', 'بالنرجس', 'شمال', 'لطريق', 'الملك', 'فهد']);
    expect(t[2]!.punctBefore).toBe(true);
    expect(locatePhrase(t, 'النرجس')).toEqual([{ start: 1, end: 2, prefix: 'ب' }]);
    expect(locatePhrase(t, 'طريق الملك فهد')).toEqual([{ start: 3, end: 6, prefix: 'ل' }]);
    // «الرياضية» is not «الرياض»; «للعليا» is ل + العليا.
    expect(locatePhrase(tokenize('الرياضية'), 'الرياض')).toEqual([]);
    expect(locatePhrase(tokenize('قريب للعليا'), 'العليا')).toEqual([{ start: 1, end: 2, prefix: 'ل' }]);
  });

  it('hard punctuation sets both flags; quotes and brackets are SOFT (punctBefore only)', () => {
    const t = tokenize('شمال، طريق "الرياض" (بارك) - مول');
    expect(t.map((x) => [x.punctBefore, x.hardPunctBefore])).toEqual([
      [false, false], [true, true], [true, false], [true, false], [true, true],
    ]);
  });
});

describe('rule a — a bare direction folds with the road that FOLLOWS it in the text', () => {
  it('[direction غرب, road الملك فهد] → [direction «غرب الملك فهد»], a road referent', () => {
    const p = prepareMention(ev('ابي فيلا غرب الملك فهد', [a('direction', 'غرب'), a('road', 'الملك فهد')]));
    expect(shape(p)).toEqual([['direction', 'غرب الملك فهد']]);
    expect(p.anchors[0]!.span).toBe('غرب الملك فهد');
    expect(p.contexts).toEqual([{ referent_is_road: true }]);
  });

  it('keeps the district beside it; «على» is NEVER a connector (P4 — design §5.4)', () => {
    const p = prepareMention(ev('ابي بالنرجس شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('road', 'طريق الملك سلمان')]));
    expect(shape(p)).toEqual([['district', 'النرجس'], ['direction', 'شمال طريق الملك سلمان']]);
    // «على طريق X» is along the road, never a side of it: no fold, and the bare
    // direction beside a road asks (BD2).
    const anchors = [a('direction', 'الشمال'), a('road', 'طريق الملك فهد')];
    const q = prepareMention(ev('في الشمال على طريق الملك فهد', anchors));
    expect(q.anchors).toEqual(anchors);
    expect(q.contexts[0]).toEqual({ ask_reason: 'direction_referent_unclear' });
  });

  it('a road anchor that is a bare royal name becomes «الملك <name>»', () => {
    const p = prepareMention(ev('النرجس جنوب سلمان', [a('district', 'النرجس'), a('direction', 'جنوب'), a('road', 'سلمان')]));
    expect(p.anchors.map((x) => x.normalized_token)).toEqual(['النرجس', 'جنوب الملك سلمان']);
  });

  it('NEVER by array position: words between the direction and the road → no fold', () => {
    const anchors = [a('direction', 'الشمال'), a('road', 'طريق الملك فهد')];
    const p = prepareMention(ev('ابي الشمال وما ابي طريق الملك فهد', anchors));
    expect(p.anchors).toEqual(anchors);
  });

  it('a span that cannot be located in the mention → no fold', () => {
    const anchors = [a('direction', 'شمال'), a('road', 'طريق الملك فهد')];
    expect(prepareMention(ev('ابي فيلا هناك', anchors)).anchors).toEqual(anchors);
  });

  it('a city right after the direction owns it: «شمال الرياض على طريق الملك فهد» keeps the road separate (finding 0)', () => {
    const anchors = [a('direction', 'شمال'), a('city', 'الرياض'), a('road', 'طريق الملك فهد')];
    const p = prepareMention(ev('شمال الرياض على طريق الملك فهد', anchors));
    expect(p.anchors).toEqual(anchors);
  });

  it('a «قريب من» road is a proximity target, never folded (findings 0, 9, 28)', () => {
    const road = a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 });
    const p = prepareMention(ev('في الشمال قريب من طريق الملك فهد خلال 2 كيلو', [a('direction', 'الشمال'), road]));
    expect(p.anchors).toEqual([a('direction', 'الشمال'), road]);
    expect(p.contexts[1]).toEqual({ radius_m: 2000, proximity: true });
    // Without the role, the phrase right before it is enough.
    const q = prepareMention(ev('ابي الشمال قريب من طريق الملك فهد', [a('direction', 'الشمال'), a('road', 'طريق الملك فهد')]));
    expect(q.anchors.map((x) => x.anchor_type)).toEqual(['direction', 'road']);
    expect(q.contexts[1]).toEqual({ proximity: true });
  });

  it('a direction that already carries its referent («شمال الرياض») is left alone', () => {
    const anchors = [a('direction', 'شمال الرياض'), a('road', 'الملك فهد')];
    const p = prepareMention(ev('شمال الرياض قريب الملك فهد', anchors));
    expect(p.anchors.map((x) => x.anchor_type)).toEqual(['direction', 'road']);
  });

  it('no road ⇒ the anchors are unchanged (prepareEvidence returns the SAME object); the city owning the direction is its zone city', () => {
    const e = ev('شمال الرياض', [a('direction', 'شمال'), a('city', 'الرياض')]);
    const out = prepareEvidence([e]);
    expect(out.evidence[0]).toBe(e);
    expect(out.prepared[0]!.contexts).toEqual([{ city: 'الرياض' }, {}]);
    expect(out.prepared[0]!.mode).toBe('legacy');
  });

  it('several directions: each pairs only with its own road; the unpaired one beside a road side asks (BD2 — design §5.4)', () => {
    const p = prepareMention(ev('شرق او غرب الملك فهد', [a('direction', 'شرق'), a('direction', 'غرب'), a('road', 'الملك فهد')]));
    expect(shape(p)).toEqual([['direction', 'شرق'], ['direction', 'غرب الملك فهد']]);
    expect(p.contexts[0]).toEqual({ ask_reason: 'direction_referent_unclear' });
    expect(p.contexts[1]).toEqual({ referent_is_road: true });
    const q = prepareMention(ev('شمال او جنوب طريق الملك فهد', [a('direction', 'شمال'), a('direction', 'جنوب'), a('road', 'طريق الملك فهد')]));
    expect(q.contexts[0]).toEqual({ ask_reason: 'direction_referent_unclear' });
    // Two roads, two adjacent directions → two road sides, nothing unclear.
    const r = prepareMention(ev('شمال طريق الملك فهد وجنوب طريق الملك سلمان', [
      a('direction', 'شمال'), a('road', 'طريق الملك فهد'), a('direction', 'جنوب'), a('road', 'طريق الملك سلمان'),
    ]));
    expect(shape(r)).toEqual([['direction', 'شمال طريق الملك فهد'], ['direction', 'جنوب طريق الملك سلمان']]);
    expect(r.contexts.every((c) => !c.ask_reason)).toBe(true);
  });

  it('a direction owned by its city is not unclear next to a road side', () => {
    const p = prepareMention(ev('شمال الرياض او غرب طريق الملك فهد', [
      a('direction', 'شمال'), a('city', 'الرياض'), a('direction', 'غرب'), a('road', 'طريق الملك فهد'),
    ]));
    expect(p.contexts[0]!.ask_reason).toBeUndefined();
  });
});

describe('rule b — a bare royal name right after a direction is the King … Road', () => {
  it('[district النرجس, direction شمال, district سلمان] → road side on «الملك سلمان»', () => {
    const p = prepareMention(ev('النرجس شمال سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('district', 'سلمان')]));
    expect(shape(p)).toEqual([['district', 'النرجس'], ['direction', 'شمال الملك سلمان']]);
  });

  it('only the bare forms WITHOUT the article — «الفهد», «الفيصلية», «حي الملك سلمان» are districts', () => {
    expect(bareRoyalName(a('district', 'حي الملك سلمان', { normalized_token: 'الملك سلمان' }))).toBeNull();
    expect(bareRoyalName(a('district', 'حي سلمان', { normalized_token: 'سلمان' }))).toBeNull();
    expect(bareRoyalName(a('road', 'طريق فهد'))).toBeNull();
    expect(bareRoyalName(a('district', 'الفيصلية'))).toBeNull();
    expect(bareRoyalName(a('district', 'الفهد'))).toBeNull();
    expect(bareRoyalName(a('district', 'السلمان'))).toBeNull();
    expect(bareRoyalName(a('district', 'فهد'))).toBe('فهد');
    expect(bareRoyalName(a('district', 'عبد الله'))).toBe('عبدالله');
  });

  it('«ابي في الفهد شمال نجران» — the district BEFORE the direction is never folded (finding 1)', () => {
    const anchors = [a('district', 'الفهد'), a('direction', 'شمال'), a('city', 'نجران')];
    expect(prepareMention(ev('ابي في الفهد شمال نجران', anchors)).anchors).toEqual(anchors);
    // Even a bare royal district is folded only when it FOLLOWS the direction.
    const b = [a('district', 'سلمان'), a('direction', 'جنوب')];
    expect(prepareMention(ev('سلمان جنوب', b)).anchors).toEqual(b);
  });

  it('inside ONE direction anchor: «جنوب سلمان» → token «جنوب الملك سلمان», a road referent; the span stays the customer\'s (P5 b)', () => {
    const p = prepareMention(ev('ابي بالنرجس جنوب سلمان', [a('district', 'النرجس'), a('direction', 'جنوب سلمان')]));
    expect(shape(p)).toEqual([['district', 'النرجس'], ['direction', 'جنوب الملك سلمان']]);
    expect(p.anchors[1]!.span).toBe('جنوب سلمان');
    expect(p.contexts[1]).toEqual({ referent_is_road: true });
    // «شمال الفهد» (article) is untouched.
    const q = prepareMention(ev('شمال الفهد', [a('direction', 'شمال الفهد')]));
    expect(q.anchors[0]!.normalized_token).toBe('شمال الفهد');
    expect(q.contexts[0]).toEqual({});
  });

  it('a royal-name district WITHOUT a direction is untouched', () => {
    const p = prepareMention(ev('سلمان', [a('district', 'سلمان')]));
    expect(p.anchors).toEqual([a('district', 'سلمان')]);
  });
});

describe('rule c — a distance belongs to the anchor that carries it', () => {
  it('distance_m on the landmark → radius_m; «قريب من» right before it → proximity', () => {
    const p = prepareMention(ev('قريب من الرياض بارك خلال 3 كيلو', [a('landmark', 'الرياض بارك', { distance_m: 3000 })]));
    expect(p.contexts[0]).toEqual({ radius_m: 3000, proximity: true });
  });

  it('role constraint_proximity alone marks proximity (no number ⇒ no radius)', () => {
    const p = prepareMention(ev('الرياض بارك', [a('landmark', 'الرياض بارك', { role_in_relation: 'constraint_proximity' })]));
    expect(p.contexts[0]).toEqual({ proximity: true });
  });

  it('a distance on ANOTHER anchor never reaches the road', () => {
    const p = prepareMention(ev('خلال كيلو من طريق الملك فهد', [a('road', 'طريق الملك فهد'), a('relative_ref', 'خلال كيلو', { distance_m: 1000 })]));
    expect(p.contexts[0]!.radius_m).toBeUndefined();
    expect(p.contexts[1]!.radius_m).toBe(1000);
  });

  it('a landmark\'s distance never becomes the band depth of a road side in the same mention (findings 5, 16)', () => {
    const p = prepareMention(ev('غرب طريق الملك فهد قريب من جامعة الملك سعود بحدود 2 كيلو', [
      a('direction', 'غرب'), a('road', 'طريق الملك فهد'), a('landmark', 'جامعة الملك سعود', { distance_m: 2000 }),
    ]));
    expect(shape(p)).toEqual([['direction', 'غرب طريق الملك فهد'], ['landmark', 'جامعة الملك سعود']]);
    expect(p.contexts[0]).toEqual({ referent_is_road: true });
    expect(p.contexts[1]).toEqual({ radius_m: 2000, proximity: true });
  });

  it('a district never gets a radius', () => {
    const p = prepareMention(ev('النرجس 3 كيلو', [a('district', 'النرجس', { distance_m: 3000 })]));
    expect(p.contexts[0]).toEqual({});
  });

  it('a folded road side carries either part\'s stated distance as its band', () => {
    const p = prepareMention(ev('غرب الملك فهد بحدود 2 كيلو', [a('direction', 'غرب'), a('road', 'الملك فهد', { distance_m: 2000 })]));
    expect(p.anchors).toHaveLength(1);
    expect(p.anchors[0]!.distance_m).toBe(2000);
    expect(p.contexts[0]).toEqual({ referent_is_road: true, radius_m: 2000 });
  });

  it('a ONE-anchor road side that carries its own distance uses it as the band (finding 19)', () => {
    const p = prepareMention(ev('ابي غرب الملك فهد خلال 2 كيلو', [a('direction', 'غرب الملك فهد', { distance_m: 2000 })]));
    // «الملك فهد» after the direction is the road reading of a royal name → a road referent.
    expect(p.contexts[0]).toEqual({ referent_is_road: true, radius_m: 2000 });
  });

  it('an implausible distance is ignored', () => {
    const p = prepareMention(ev('قريب من كافد', [a('landmark', 'كافد', { distance_m: 5 })]));
    expect(p.contexts[0]).toEqual({ proximity: true });
  });
});

describe('rule b of proximity — per anchor, whole words only (findings 4, 8, 14, 18, 26, 27)', () => {
  const targets = (span: string, anchors: AnchorToken[]) => proximityTargets(ev(span, anchors));

  it('a phrase right BEFORE the anchor makes it a target; a role does too', () => {
    expect(targets('جنب النخيل مول', [a('landmark', 'النخيل مول')])).toEqual([true]);
    expect(targets('بالقرب من الرياض بارك', [a('landmark', 'الرياض بارك')])).toEqual([true]);
    expect(targets('وقريب من طريق الملك فهد', [a('road', 'طريق الملك فهد')])).toEqual([true]);
    expect(targets('near riyadh park', [a('landmark', 'riyadh park')])).toEqual([true]);
    expect(targets('النرجس', [a('district', 'النرجس', { role_in_relation: 'proximity' })])).toEqual([true]);
    // «على طريق X» / role along: along the road (P3).
    expect(targets('طريق الملك فهد', [a('road', 'طريق الملك فهد', { role_in_relation: 'along' })])).toEqual([true]);
    expect(targets('طريق الملك فهد', [a('road', 'طريق الملك فهد', { role_in_relation: 'على' })])).toEqual([true]);
  });

  it('never a substring: «العقربية», «تقريبا», «اقرب», «مشيرفة» and the role «approximate» are not proximity', () => {
    expect(targets('العقربية بالخبر', [a('district', 'العقربية'), a('city', 'الخبر')])).toEqual([false, false]);
    expect(targets('شمال الرياض تقريبا', [a('direction', 'شمال'), a('city', 'الرياض')])).toEqual([false, false]);
    expect(targets('في الرياض، واقرب شي للعليا', [a('city', 'الرياض'), a('district', 'العليا')])).toEqual([false, false]);
    expect(targets('مشيرفة بالمزاحمية', [a('district', 'مشيرفة'), a('city', 'المزاحمية')])).toEqual([false, false]);
    expect(targets('قربان بالمدينة', [a('district', 'قربان'), a('city', 'المدينة')])).toEqual([false, false]);
    expect(targets('النرجس', [a('district', 'النرجس', { role_in_relation: 'approximate' })])).toEqual([false]);
  });

  it('a phrase about something ELSE («قريب من المدارس») does not touch the city', () => {
    expect(targets('ابي في شمال الرياض قريب من المدارس', [a('direction', 'شمال'), a('city', 'الرياض')])).toEqual([false, false]);
  });
});

describe('«بين طريقين» is NOT prepared — it stays corridor_underspecified (decision D)', () => {
  it('two boundary roads stay two plain roads with no companions', () => {
    const r1 = a('road', 'طريق الملك فهد', { role_in_relation: 'boundary_start' });
    const r2 = a('road', 'طريق العليا', { role_in_relation: 'boundary_end' });
    const p = prepareMention(ev('بين طريق الملك فهد وطريق العليا', [r1, r2]));
    expect(p.anchors).toEqual([r1, r2]);
    expect(p.contexts).toEqual([{}, {}]);
  });

  it('even with a distance or a city: a boundary road gets nothing', () => {
    const r1 = a('road', 'طريق الملك فهد', { role_in_relation: 'boundary_start', distance_m: 2000 });
    const r2 = a('road', 'طريق العليا', { role_in_relation: 'boundary_end' });
    const p = prepareMention(ev('بالرياض بين طريق الملك فهد وطريق العليا', [a('city', 'الرياض'), r1, r2]));
    expect(p.contexts).toEqual([{}, {}, {}]);
  });
});

describe('rule e — a city is a proximity target only when IT is the target', () => {
  it('«قريب من الرياض بارك» with anchor [city الرياض] → landmark «الرياض بارك»', () => {
    const p = prepareMention(ev('قريب من الرياض بارك', [a('city', 'الرياض')]));
    expect(p.anchors).toEqual([{ anchor_type: 'landmark', span: 'الرياض بارك', normalized_token: 'الرياض بارك' }]);
    expect(p.contexts[0]).toEqual({ proximity: true });
  });

  it('«قريب من الرياض» (nothing after the city word) → the city carries proximity (resolver asks)', () => {
    const p = prepareMention(ev('قريب من الرياض', [a('city', 'الرياض')]));
    expect(p.anchors[0]!.anchor_type).toBe('city');
    expect(p.contexts[0]).toEqual({ proximity: true });
  });

  it('a distance stated FROM a city is a proximity reading: «خلال 3 كيلو من الرياض بارك» → the venue with 3000', () => {
    const p = prepareMention(ev('خلال 3 كيلو من الرياض بارك', [a('city', 'الرياض', { distance_m: 3000 })]));
    expect(shape(p)).toEqual([['landmark', 'الرياض بارك']]);
    expect(p.contexts[0]).toEqual({ proximity: true, radius_m: 3000 });
  });

  it('a city that is NOT the target is never rewritten — «في الرياض بجوار جامعة الملك سعود» (finding 10)', () => {
    const p = prepareMention(ev('ابي شقة في الرياض بجوار جامعة الملك سعود خلال 2 كيلو', [
      a('city', 'الرياض'), a('landmark', 'جامعة الملك سعود', { distance_m: 2000 }),
    ]));
    expect(shape(p)).toEqual([['city', 'الرياض'], ['landmark', 'جامعة الملك سعود']]);
    expect(p.contexts[0]).toEqual({});
    expect(p.contexts[1]).toEqual({ radius_m: 2000, proximity: true, city: 'الرياض' });
    const q = prepareMention(ev('في الرياض بالقرب من النخيل مول', [a('city', 'الرياض'), a('landmark', 'النخيل مول')]));
    expect(q.anchors.map((x) => x.span)).toEqual(['الرياض', 'النخيل مول']);
  });

  it('a city beside a road side / road / landmark is their SCOPE: its name rides as `city` (findings 2, 6, 29)', () => {
    const p = prepareMention(ev('بجدة شمال طريق الملك عبدالله', [a('city', 'جدة'), a('direction', 'شمال'), a('road', 'طريق الملك عبدالله')]));
    expect(shape(p)).toEqual([['city', 'جدة'], ['direction', 'شمال طريق الملك عبدالله']]);
    expect(p.contexts).toEqual([{}, { referent_is_road: true, city: 'جدة' }]);
    const q = prepareMention(ev('في الخبر قريب من طريق الملك فهد خلال 2 كيلو', [
      a('city', 'الخبر'), a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 }),
    ]));
    expect(q.contexts[1]).toEqual({ radius_m: 2000, proximity: true, city: 'الخبر' });
    // A REGION is never a scope (round 3, #25): no element carries a region name,
    // so scoping on it made every road unfindable. The merge drops its record.
    const r = prepareMention(ev('منطقة الرياض شمال طريق الملك فهد', [a('region', 'منطقة الرياض'), a('direction', 'شمال'), a('road', 'طريق الملك فهد')]));
    expect(r.contexts).toEqual([{}, { referent_is_road: true }]);
  });

  it('a bare direction owned by its city takes THAT city as its zone (round 3, #4/#15)', () => {
    const p = prepareMention(ev('شمال الرياض', [a('direction', 'شمال'), a('city', 'الرياض')]));
    expect(p.contexts).toEqual([{ city: 'الرياض' }, {}]);
  });

  it('a city already extracted next to its own venue landmark is not duplicated', () => {
    const p = prepareMention(ev('قريب من الرياض بارك', [a('landmark', 'الرياض بارك'), a('city', 'الرياض')]));
    expect(p.anchors.map((x) => [x.anchor_type, x.span])).toEqual([['landmark', 'الرياض بارك']]);
  });

  it('«تقريبا», «قريبة من المدارس», district names: the city stays the city (findings 14, 18, 26, 27)', () => {
    for (const [span, anchors] of [
      ['ابي بيت في الرياض تقريبا بمليون', [a('city', 'الرياض')]],
      ['ابي فيلا شمال الرياض قريبة من المدارس', [a('direction', 'شمال'), a('city', 'الرياض')]],
      ['ابي بيت في الرياض قريب من شغلي', [a('city', 'الرياض')]],
      ['ابي في العقربية بالخبر', [a('district', 'العقربية'), a('city', 'الخبر')]],
    ] as Array<[string, AnchorToken[]]>) {
      const p = prepareMention(ev(span, anchors));
      expect(p.anchors).toEqual(anchors);
      expect(p.contexts.every((c) => !c.proximity)).toBe(true);
    }
  });

  it('venueTailAfter: up to three whole words, stopping at a stop word, a «و…» conjunction or punctuation', () => {
    expect(venueTailAfter('قريب من الرياض بارك او النخيل', 'الرياض')).toBe('بارك');
    expect(venueTailAfter('قريب من الرياض بارك، ابي فيلا', 'الرياض')).toBe('بارك');
    expect(venueTailAfter('قريب من الرياض والخرج', 'الرياض')).toBe('');
    expect(venueTailAfter('قريب من الرياض', 'الرياض')).toBe('');
    expect(venueTailAfter('الرياضية', 'الرياض')).toBe('');
    expect(venueTailAfter('قريب من الرياض فرونت مول الكبير جدا', 'الرياض')).toBe('فرونت مول الكبير');
    expect(venueTailAfter('قريب من الرياض بس', 'الرياض')).toBe('');
  });

  it('a city in a NON-proximity mention is untouched', () => {
    const p = prepareMention(ev('في الرياض', [a('city', 'الرياض')]));
    expect(p.contexts[0]).toEqual({});
  });

  it('a direction owned by a city that turns out to be a venue is no longer owned — it asks (BD2)', () => {
    const p = prepareMention(ev('شمال الرياض بارك خلال 2 كيلو', [a('direction', 'شمال'), a('city', 'الرياض', { distance_m: 2000 })]));
    expect(shape(p)).toEqual([['direction', 'شمال'], ['landmark', 'الرياض بارك']]);
    expect(p.contexts[0]).toEqual({ ask_reason: 'direction_referent_unclear' });
  });
});

describe('extractor — distance_m validated, never guessed; the prompt says how (geo-extract/v9c)', () => {
  it('sanitizeDistanceM keeps 50…50,000 m, drops the rest', () => {
    expect(sanitizeDistanceM(3000)).toBe(3000);
    expect(sanitizeDistanceM('2000')).toBe(2000);
    expect(sanitizeDistanceM(49)).toBeNull();
    expect(sanitizeDistanceM(50_001)).toBeNull();
    expect(sanitizeDistanceM(Number.NaN)).toBeNull();
    expect(sanitizeDistanceM('قريب')).toBeNull();
    expect(sanitizeDistanceM(null)).toBeNull();
  });

  it('parseExtractorOutput carries a valid distance_m and drops an invalid one', () => {
    const raw = JSON.stringify({
      evidence: [{
        id: 'e1', mention_span: 'خلال 3 كيلو من الرياض بارك', preference_role: 'positive',
        anchors: [
          { anchor_type: 'landmark', span: 'الرياض بارك', normalized_token: 'الرياض بارك', role_in_relation: 'proximity', distance_m: 3000 },
          { anchor_type: 'road', span: 'طريق الملك فهد', normalized_token: 'طريق الملك فهد', distance_m: 999999 },
        ],
      }],
      relations: [],
    });
    const out = parseExtractorOutput(raw, { channel: 'chat', ref: 'm1', timestamp: '' });
    expect(out.evidence[0]!.anchors[0]!.distance_m).toBe(3000);
    expect('distance_m' in out.evidence[0]!.anchors[1]!).toBe(false);
  });

  it('the «جنوب سلمان» example normalizes to the King Salman Road, and a travel TIME is not a distance (findings 17, 20)', () => {
    expect(EXTRACTOR_VERSION).toBe('geo-extract/v9d');
    expect(EXTRACT_SYSTEM_PROMPT).toContain("normalized_token:'جنوب الملك سلمان'");
    expect(EXTRACT_SYSTEM_PROMPT).not.toContain("«جنوب سلمان» → span:'جنوب سلمان'،");
    expect(EXTRACT_SYSTEM_PROMPT).toContain('مدة التنقّل ليست مسافة');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('لا تحوّل الوقت إلى أمتار');
  });

  it('v9d (design 2026-10-04 §2.8): a one-anchor road side only when said contiguously; verbatim contiguous spans; «على طريق X» is along; a road with no direction word is a road', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('يشمل الطريق في span نفسه فقط إذا قالها العميل متصلةً («غرب الملك فهد»، «شمال طريق الملك سلمان»)');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('span و mention_span نصّان حرفيان متصلان من كلام العميل كما كتبه');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('فاجعل كلماتها («خلال 3 كيلو») داخل mention_span');
    expect(EXTRACT_SYSTEM_PROMPT).toContain("[road 'طريق الملك فهد', role_in_relation:'along'] — وليس «شمال طريق الملك فهد» أبدًا");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("طريقٌ ذُكر بلا كلمة جهة = anchor من نوع road وليس direction");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("{ anchor_type:'road', span:'طريق الملك فهد', normalized_token:'طريق الملك فهد', role_in_relation:'proximity', distance_m:2000 }");
  });

  it('round 3 #17: a road side\'s distance rides on its ONE direction anchor (v9c example)', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain("{ anchor_type:'direction', span:'غرب الملك فهد', normalized_token:'غرب الملك فهد', distance_m:2000 }");
    expect(EXTRACT_SYSTEM_PROMPT).toContain('ولا تُنشئ anchor طريق ثانيًا لأجلها');
  });

  it('round 3 #18: the prompt limits the royal rule to the bare form — «الفهد» / «السلمان» are never rewritten', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('هذا للصيغة المجرّدة بلا «ال» فقط');
    expect(EXTRACT_SYSTEM_PROMPT).toContain("«شمال الفهد» → normalized_token:'شمال الفهد'");
  });

  it('round 3 #19: Arabic-Indic digits, separators and a metre unit are read; another unit is not', () => {
    expect(sanitizeDistanceM('٢٠٠٠')).toBe(2000);
    expect(sanitizeDistanceM('۲۰۰۰')).toBe(2000);
    expect(sanitizeDistanceM('2,000')).toBe(2000);
    expect(sanitizeDistanceM('٢٬٠٠٠')).toBe(2000);
    expect(sanitizeDistanceM('2000 م')).toBe(2000);
    expect(sanitizeDistanceM('1500 متر')).toBe(1500);
    expect(sanitizeDistanceM('٢٫٥')).toBeNull(); // 2.5 m — out of bounds, never "2.5 km"
    expect(sanitizeDistanceM('2 كم')).toBeNull();
    expect(sanitizeDistanceM('2,5')).toBeNull();
    const raw = JSON.stringify({
      evidence: [{ id: 'e1', mention_span: 'غرب الملك فهد خلال ٢ كيلو', preference_role: 'positive',
        anchors: [{ anchor_type: 'direction', span: 'غرب الملك فهد', normalized_token: 'غرب الملك فهد', distance_m: '٢٠٠٠' }] }],
      relations: [],
    });
    expect(parseExtractorOutput(raw, { channel: 'chat', ref: 'm1', timestamp: '' }).evidence[0]!.anchors[0]!.distance_m).toBe(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round 3 of the 2026-10-03 review — the pure half of each confirmed defect
// (the end-to-end half is in roadSideLandmark.test.ts), as the 2026-10-04
// design now decides them.
// ─────────────────────────────────────────────────────────────────────────────

describe('round 3 — royal short names', () => {
  it('#1 a span «سلمان» normalized «الملك سلمان» IS the bare royal name (the road reading is not a district)', () => {
    expect(bareRoyalName(a('district', 'سلمان', { normalized_token: 'الملك سلمان' }))).toBe('سلمان');
    // The span still decides: «حي» anywhere, an article form, or a different name → not bare.
    expect(bareRoyalName(a('district', 'حي سلمان', { normalized_token: 'الملك سلمان' }))).toBeNull();
    expect(bareRoyalName(a('district', 'الفهد', { normalized_token: 'الملك فهد' }))).toBeNull();
    expect(bareRoyalName(a('district', 'سلمان', { normalized_token: 'الفهد' }))).toBeNull();
    expect(bareRoyalName(a('district', 'الملك سلمان', { normalized_token: 'سلمان' }))).toBeNull();
    const p = prepareMention(ev('النرجس شمال سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('district', 'سلمان', { normalized_token: 'الملك سلمان' })]));
    expect(shape(p)).toEqual([['district', 'النرجس'], ['direction', 'شمال الملك سلمان']]);
    expect(p.contexts[1]).toEqual({ referent_is_road: true });
  });

  it('#3 inside one direction anchor, «جنوب حي سلمان» (normalized «جنوب سلمان») names a DISTRICT: it asks side_of_district (P5 a — design §5.4)', () => {
    for (const [span, norm] of [['جنوب حي سلمان', 'جنوب سلمان'], ['شمال حي عبدالله', 'شمال عبدالله']] as const) {
      const anchor = a('direction', span, { normalized_token: norm });
      const p = prepareMention(ev(`ابي ${span}`, [anchor]));
      expect(p.anchors).toEqual([anchor]);
      expect(p.contexts).toEqual([{ ask_reason: 'side_of_district' }]);
    }
  });

  it('#18 a model rewrite of a place name to «الملك …» ASKS (P5 c); «حي الملك فهد» asks side_of_district; the legitimate one is a road referent', () => {
    const p = prepareMention(ev('ابي شقة شمال الفهد', [a('direction', 'شمال الفهد', { normalized_token: 'شمال الملك فهد' })]));
    expect(p.contexts[0]).toEqual({ ask_reason: 'referent_road_word_disagrees' });
    const q = prepareMention(ev('شمال حي الملك فهد', [a('direction', 'شمال حي الملك فهد', { normalized_token: 'شمال الملك فهد' })]));
    expect(q.contexts[0]).toEqual({ ask_reason: 'side_of_district' });
    const ok = a('direction', 'جنوب سلمان', { normalized_token: 'جنوب الملك سلمان' });
    const r = prepareMention(ev('ابي جنوب سلمان', [ok]));
    expect(r.anchors[0]).toBe(ok);
    expect(r.contexts[0]).toEqual({ referent_is_road: true });
  });
});

describe('round 3 — adjacency and each anchor\'s own words', () => {
  it('#2 a bare direction AFTER a folded road side asks — with «او» or a glued «و» (BD2 — design §5.4)', () => {
    const p = prepareMention(ev('ابي غرب الملك فهد او شرق', [a('direction', 'غرب'), a('road', 'الملك فهد'), a('direction', 'شرق')]));
    expect(shape(p)).toEqual([['direction', 'غرب الملك فهد'], ['direction', 'شرق']]);
    expect(p.contexts).toEqual([{ referent_is_road: true }, { ask_reason: 'direction_referent_unclear' }]);
    const q = prepareMention(ev('ابي غرب الملك فهد وشرق', [a('direction', 'غرب'), a('road', 'الملك فهد'), a('direction', 'شرق')]));
    expect(q.contexts[1]).toEqual({ ask_reason: 'direction_referent_unclear' });
  });

  it('#2 a road said twice with ONE road anchor: each direction folds with its own copy', () => {
    const p = prepareMention(ev('شمال طريق الملك فهد او جنوب طريق الملك فهد', [a('direction', 'شمال'), a('road', 'طريق الملك فهد'), a('direction', 'جنوب')]));
    expect(shape(p)).toEqual([['direction', 'شمال طريق الملك فهد'], ['direction', 'جنوب طريق الملك فهد']]);
    expect(p.contexts).toEqual([{ referent_is_road: true }, { referent_is_road: true }]);
  });

  it('#23 a bare direction beside a road side ASKS — with no word between too, and when its word is not in the text (BD2 — design §5.4)', () => {
    const p = prepareMention(ev('ابي في الشمال غرب طريق الملك فهد', [a('direction', 'الشمال', { normalized_token: 'شمال' }), a('direction', 'غرب طريق الملك فهد')]));
    expect(p.contexts).toEqual([{ ask_reason: 'direction_referent_unclear' }, { referent_is_road: true }]);
    const q = prepareMention(ev('ابي شمالي غرب الملك فهد', [a('direction', 'شمال'), a('direction', 'غرب الملك فهد')]));
    expect(q.contexts[0]).toEqual({ ask_reason: 'direction_referent_unclear' });
  });

  it('#6/#14 punctuation right after the direction (before a connector) stops the fold', () => {
    for (const [mention, dir] of [['ابي بالشمال، على طريق الملك فهد', 'الشمال'], ['شمال، على طريق الملك فهد', 'شمال']] as const) {
      const anchors = [a('direction', dir), a('road', 'طريق الملك فهد')];
      expect(prepareMention(ev(mention, anchors)).anchors).toEqual(anchors);
    }
  });

  it('#8 two anchors with the same words own one occurrence each', () => {
    const tokens = tokenize('شمال الرياض، تحديدا شمال طريق الملك فهد');
    const anchors = [a('direction', 'شمال'), a('city', 'الرياض'), a('direction', 'شمال'), a('road', 'طريق الملك فهد')];
    expect(anchorOccurrences(tokens, anchors).map((o) => o.map((x) => x.start))).toEqual([[0], [1], [3], [4]]);
    const p = prepareMention(ev('شمال الرياض، تحديدا شمال طريق الملك فهد', anchors));
    expect(shape(p)).toEqual([['direction', 'شمال'], ['city', 'الرياض'], ['direction', 'شمال طريق الملك فهد']]);
    expect(p.contexts[0]).toEqual({ city: 'الرياض' });
    const q = prepareMention(ev('غرب الملك فهد او غرب الرياض', [a('direction', 'غرب'), a('road', 'الملك فهد'), a('direction', 'غرب'), a('city', 'الرياض')]));
    expect(shape(q)).toEqual([['direction', 'غرب الملك فهد'], ['direction', 'غرب'], ['city', 'الرياض']]);
  });

  it('#5 emoji and WhatsApp markup are separators, not punctuation and not part of a word', () => {
    expect(tokenize('قريب من *الرياض* بارك🙏').map((t) => [t.f, t.punctBefore])).toEqual([
      ['قريب', false], ['من', false], ['الرياض', false], ['بارك', false],
    ]);
    const p = prepareMention(ev('ابي بيت قريب من الرياض🙏', [a('city', 'الرياض')]));
    expect(p.anchors[0]!.anchor_type).toBe('city');
    expect(p.contexts[0]).toEqual({ proximity: true });
    const q = prepareMention(ev('ابي بيت قريب من *الرياض* بارك', [a('city', 'الرياض')]));
    expect(shape(q)).toEqual([['landmark', 'الرياض بارك']]);
    expect(tokenize('شمال، طريق').map((t) => t.punctBefore)).toEqual([false, true]);
  });
});

describe('round 3 — the city of a mention', () => {
  it('#4/#15 a bare direction owned by a named CITY takes it as its zone city; a REGION owner asks (P6 — design §5.3 #5/#10)', () => {
    expect(prepareMention(ev('ابي فيلا شمال جدة', [a('direction', 'شمال'), a('city', 'جدة')])).contexts).toEqual([{ city: 'جدة' }, {}]);
    expect(prepareMention(ev('ابي شمال منطقة الرياض', [a('direction', 'شمال'), a('region', 'منطقة الرياض')])).contexts)
      .toEqual([{ ask_reason: 'zone_of_region' }, {}]);
  });

  it('#7 two different named cities → no scope; the element asks (city_unclear)', () => {
    const p = prepareMention(ev('في الدمام او الخبر قريب من طريق الملك فهد بحدود 2 كيلو', [
      a('city', 'الدمام'), a('city', 'الخبر'), a('road', 'طريق الملك فهد', { distance_m: 2000 }),
    ]));
    expect(p.contexts[2]).toEqual({ radius_m: 2000, city_unclear: true, proximity: true });
    // The same city twice is one city.
    const q = prepareMention(ev('في الخبر، الخبر قريب من طريق الملك فهد', [a('city', 'الخبر'), a('city', 'الخبر'), a('road', 'طريق الملك فهد')]));
    expect(q.contexts[2]).toEqual({ city: 'الخبر', proximity: true });
  });

  it('#12 a district in a mention naming ONE city must be in that city (admin_city — P9, design §5.3 #7d)', () => {
    const p = prepareMention(ev('الروضة شمال طريق الملك عبدالله بجدة', [a('district', 'الروضة'), a('direction', 'شمال طريق الملك عبدالله'), a('city', 'جدة')]));
    expect(p.contexts).toEqual([{ admin_city: 'جدة' }, { city: 'جدة', referent_is_road: true }, {}]);
    // No road side / venue in the mention: still Jeddah's الروضة.
    expect(prepareMention(ev('الروضة بجدة', [a('district', 'الروضة'), a('city', 'جدة')])).contexts).toEqual([{ admin_city: 'جدة' }, {}]);
  });

  it('#9 the venue name stops at a number, a distance word or a «و…» word', () => {
    expect(venueTailAfter('ابي قريب من الرياض بارك ٣ كيلو', 'الرياض')).toBe('بارك');
    expect(venueTailAfter('قريب من الرياض بارك 3 كيلو', 'الرياض')).toBe('بارك');
    expect(venueTailAfter('قريب من الرياض بارك خلال كيلوين', 'الرياض')).toBe('بارك');
    expect(venueTailAfter('قريب من الرياض بارك وجامعة الملك سعود', 'الرياض')).toBe('بارك');
    expect(venueTailAfter('قريب من الرياض بارك بحدود 2 كيلو', 'الرياض')).toBe('بارك');
    const p = prepareMention(ev('ابي قريب من الرياض بارك ٣ كيلو', [a('city', 'الرياض', { distance_m: 3000 })]));
    expect(shape(p)).toEqual([['landmark', 'الرياض بارك']]);
    expect(p.contexts[0]).toEqual({ proximity: true, radius_m: 3000 });
  });

  it('#8 rule e measures from the occurrence after «من»: «في الرياض فيلا خلال 3 كيلو من الرياض بارك»', () => {
    const p = prepareMention(ev('ابي في الرياض فيلا خلال 3 كيلو من الرياض بارك', [a('city', 'الرياض', { distance_m: 3000 })]));
    expect(shape(p)).toEqual([['landmark', 'الرياض بارك']]);
    expect(p.contexts[0]).toEqual({ proximity: true, radius_m: 3000 });
  });

  it('#10 a city dropped as a duplicate of its venue passes its distance on to the venue', () => {
    const p = prepareMention(ev('خلال 3 كيلو من الرياض بارك', [a('city', 'الرياض', { distance_m: 3000 }), a('landmark', 'الرياض بارك')]));
    expect(p.anchors).toEqual([a('landmark', 'الرياض بارك', { distance_m: 3000 })]);
    expect(p.contexts).toEqual([{ radius_m: 3000, proximity: true }]);
    // The venue's own distance wins over the city's (the text says «كيلو»: P10).
    const q = prepareMention(ev('قريب من الرياض بارك خلال كيلو', [a('city', 'الرياض', { distance_m: 3000 }), a('landmark', 'الرياض بارك', { distance_m: 1000 })]));
    expect(q.contexts).toEqual([{ radius_m: 1000, proximity: true }]);
  });

  it('#25 a region is never the scope: «النرجس بمنطقة الرياض غرب الملك فهد»', () => {
    const p = prepareMention(ev('النرجس بمنطقة الرياض غرب الملك فهد', [a('district', 'النرجس'), a('region', 'منطقة الرياض'), a('direction', 'غرب الملك فهد')]));
    expect(p.contexts).toEqual([{}, {}, { referent_is_road: true }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-04 design §6.2 — one block per rule, in the binding order.
// ─────────────────────────────────────────────────────────────────────────────

describe('P0 — the mention texts', () => {
  const conv = (over: Partial<Conversation> = {}): Conversation => ({
    channel: 'chat',
    turns: [
      { speaker: 'client', text: 'ابي قريب من الرياض بارك خلال 3 كيلو', ref: 'm1' },
      { speaker: 'agent', text: 'تبي خلال 5 كيلو؟', ref: 'm1' },
      { speaker: 'client', text: 'او 7 كيلو', ref: 'm2' },
    ],
    ...over,
  });

  it('mention_span first, then the CUSTOMER\'s turns attributed to the mention', () => {
    const e = ev('قريب من الرياض بارك', []);
    expect(mentionStrings(e)).toEqual(['قريب من الرياض بارك']);
    expect(mentionStrings(e, conv())).toEqual(['قريب من الرياض بارك', 'ابي قريب من الرياض بارك خلال 3 كيلو']);
  });

  it('an unlabelled call counts every attributed turn; a labelled call only the client\'s', () => {
    const e = ev('قريب من الرياض بارك', []);
    expect(mentionStrings(e, conv({ channel: 'call' }))).toHaveLength(3);
    expect(mentionStrings(e, conv({ channel: 'call', speaker_labels: 'none' }))).toHaveLength(3);
    expect(mentionStrings(e, conv({ channel: 'call', speaker_labels: 'hatif_role' }))).toHaveLength(2);
  });

  it('a turn without its own ref carries the conversation id (as the extractor attributes it)', () => {
    const e = ev('قريب من الرياض بارك', [], 'call-1');
    const c: Conversation = { channel: 'call', id: 'call-1', turns: [{ speaker: 'client', text: 'خلال 3 كيلو' }] };
    expect(mentionStrings(e, c)).toEqual(['قريب من الرياض بارك', 'خلال 3 كيلو']);
  });
});

describe('P1 — a road typed as a direction', () => {
  it('a direction with NO direction word whose text starts with a road word is a road (live L2)', () => {
    const p = prepareMention(ev('ابي قريب من طريق الملك فهد تقريبا 2 كيلو', [
      a('direction', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 }),
    ]));
    expect(shape(p)).toEqual([['road', 'طريق الملك فهد']]);
    expect(p.contexts).toEqual([{ proximity: true, radius_m: 2000 }]);
  });

  it('never when the span OR the token has a direction word, nor without a road word', () => {
    for (const anchor of [
      a('direction', 'شمال طريق الملك فهد'),
      a('direction', 'طريق الملك فهد', { normalized_token: 'شمال طريق الملك فهد' }),
      a('direction', 'الملك فهد'),
    ]) {
      expect(prepareMention(ev(`ابي ${anchor.span}`, [anchor])).anchors[0]!.anchor_type).toBe('direction');
    }
  });
});

describe('P2 — repeated words', () => {
  it('a city inside a road name is dropped («الدمام» in «طريق الدمام»), and the road side folds', () => {
    const p = prepareMention(ev('الروابي جنوب طريق الدمام', [
      a('district', 'الروابي'), a('direction', 'جنوب'), a('road', 'طريق الدمام'), a('city', 'الدمام'),
    ]));
    expect(shape(p)).toEqual([['district', 'الروابي'], ['direction', 'جنوب طريق الدمام']]);
    expect(p.named_places).toEqual([]);
  });

  it('a bare twin inside a road side is dropped; so is a repeated bare word with no occurrence of its own', () => {
    const p = prepareMention(ev('شمال طريق الملك عبدالله', [a('direction', 'شمال'), a('direction', 'شمال طريق الملك عبدالله')]));
    expect(shape(p)).toEqual([['direction', 'شمال طريق الملك عبدالله']]);
    const q = prepareMention(ev('ابي الشمال', [a('direction', 'الشمال'), a('direction', 'شمال')]));
    expect(shape(q)).toEqual([['direction', 'الشمال']]);
  });

  it('a dropped anchor\'s distance moves to its container', () => {
    const p = prepareMention(ev('ابي جنوب طريق الدمام خلال 2 كيلو', [a('direction', 'جنوب طريق الدمام'), a('city', 'الدمام', { distance_m: 2000 })]));
    expect(p.anchors).toEqual([a('direction', 'جنوب طريق الدمام', { distance_m: 2000 })]);
    expect(p.contexts).toEqual([{ referent_is_road: true, radius_m: 2000 }]);
  });

  it('the city a direction is OF is kept («الرياض» in «شمال الرياض»); an anchor with no occurrence is never dropped', () => {
    const p = prepareMention(ev('شمال الرياض', [a('direction', 'شمال الرياض'), a('city', 'الرياض')]));
    expect(shape(p)).toEqual([['direction', 'شمال الرياض'], ['city', 'الرياض']]);
    const q = prepareMention(ev('ابي طريق الدمام', [a('road', 'طريق الدمام'), a('city', 'الخبر')]));
    expect(shape(q)).toEqual([['road', 'طريق الدمام'], ['city', 'الخبر']]);
  });
});

describe('P3 — proximity reads through quotes and brackets, never through hard punctuation', () => {
  it('quotes, brackets, «» and an English «the» between the phrase and the city → the venue', () => {
    for (const m of ['قريب من "الرياض بارك"', 'قريب من (الرياض بارك)', 'قريب من «الرياض بارك»']) {
      const p = prepareMention(ev(m, [a('city', 'الرياض')]));
      expect(shape(p)).toEqual([['landmark', 'الرياض بارك']]);
      expect(p.contexts).toEqual([{ proximity: true }]);
    }
    expect(shape(prepareMention(ev('near the Riyadh Park', [a('city', 'Riyadh')])))).toEqual([['landmark', 'Riyadh Park']]);
  });

  it('a hard comma between, or punctuation inside the phrase, breaks it: the city stays the city', () => {
    for (const m of ['قريب من، الرياض بارك', 'قريب، من الرياض بارك']) {
      const p = prepareMention(ev(m, [a('city', 'الرياض')]));
      expect(shape(p)).toEqual([['city', 'الرياض']]);
      expect(p.contexts).toEqual([{}]);
    }
  });
});

describe('P4 — the fold is strict', () => {
  it('one «طريق» may stand between: the road anchor without its road word still folds, with the customer\'s words as span', () => {
    const p = prepareMention(ev('ابي شمال طريق الملك فهد', [a('direction', 'شمال'), a('road', 'الملك فهد')]));
    expect(shape(p)).toEqual([['direction', 'شمال الملك فهد']]);
    expect(p.anchors[0]!.span).toBe('شمال طريق الملك فهد');
    expect(p.contexts).toEqual([{ referent_is_road: true }]);
  });

  it('«على» / «من» never fold, and no punctuation of any kind may stand between', () => {
    for (const m of [
      'في الشمال على طريق الملك فهد', 'شمال من طريق الملك فهد', 'شمال، طريق الملك فهد', 'شمال (طريق الملك فهد)', 'شمال - طريق الملك فهد',
    ]) {
      const anchors = [a('direction', m.includes('الشمال') ? 'الشمال' : 'شمال'), a('road', 'طريق الملك فهد')];
      expect(prepareMention(ev(m, anchors)).anchors).toEqual(anchors);
    }
  });

  it('the road\'s first word may carry «ل», not «ب»', () => {
    const p = prepareMention(ev('غرب لطريق الملك فهد', [a('direction', 'غرب'), a('road', 'طريق الملك فهد')]));
    expect(shape(p)).toEqual([['direction', 'غرب طريق الملك فهد']]);
    const anchors = [a('direction', 'غرب'), a('road', 'طريق الملك فهد')];
    expect(prepareMention(ev('غرب بطريق الملك فهد', anchors)).anchors).toEqual(anchors);
  });

  it('a «near» road and a corridor bound never fold', () => {
    for (const role of ['proximity', 'boundary_start']) {
      const road = a('road', 'طريق الملك فهد', { role_in_relation: role });
      expect(prepareMention(ev('شمال طريق الملك فهد', [a('direction', 'شمال'), road])).anchors).toEqual([a('direction', 'شمال'), road]);
    }
  });
});

describe('P5 — a direction with a referent is read span-first (rules a–f)', () => {
  it('a: a referent starting with «حي» asks side_of_district', () => {
    const p = prepareMention(ev('ابي جنوب حي سلمان', [a('direction', 'جنوب حي سلمان', { normalized_token: 'جنوب سلمان' })]));
    expect(asks(p)).toEqual(['side_of_district']);
  });

  it('b: a road-like referent is a road — the clitic is stripped, a bare royal name becomes «الملك …»', () => {
    const glued = a('direction', 'وجنوب سلمان', { normalized_token: 'جنوب الملك سلمان' });
    const p = prepareMention(ev('ابي النرجس وجنوب سلمان', [a('district', 'النرجس'), glued]));
    expect(p.anchors[1]).toBe(glued); // the token already agrees with the span: the same object
    expect(p.contexts[1]).toEqual({ referent_is_road: true });
    const q = prepareMention(ev('في جنوب سلمان', [a('direction', 'في جنوب سلمان')]));
    expect(shape(q)).toEqual([['direction', 'جنوب الملك سلمان']]);
    expect(q.contexts).toEqual([{ referent_is_road: true }]);
    // «غرب الملك فهد» → «غرب طريق الملك فهد» is the same road.
    const r = prepareMention(ev('ابي غرب الملك فهد', [a('direction', 'غرب الملك فهد', { normalized_token: 'غرب طريق الملك فهد' })]));
    expect(r.contexts).toEqual([{ referent_is_road: true }]);
    // «شرق طريق الدمام» (token «شرق الدمام») — the customer said «طريق»: a road, never Dammam city.
    const s = prepareMention(ev('ابي شرق طريق الدمام', [a('direction', 'شرق طريق الدمام', { normalized_token: 'شرق الدمام' })]));
    expect(s.contexts).toEqual([{ referent_is_road: true }]);
    expect(s.named_places).toEqual([]);
  });

  it('c: the customer\'s referent is not a road but the token made it one → asks', () => {
    for (const [span, tok] of [['شرق الدمام', 'شرق طريق الدمام'], ['غرب العليا', 'غرب شارع العليا'], ['شمال الفهد', 'شمال الملك فهد']] as const) {
      const p = prepareMention(ev(`ابي ${span}`, [a('direction', span, { normalized_token: tok })]));
      expect(asks(p)).toEqual(['referent_road_word_disagrees']);
    }
  });

  it('d: the customer\'s referent replaces the token\'s, with no flag, and is a NAMED place', () => {
    const p = prepareMention(ev('ابي فيلا شمال جدة', [a('direction', 'شمال جدة', { normalized_token: 'شمال الرياض' })]));
    expect(shape(p)).toEqual([['direction', 'شمال جدة']]);
    expect(p.contexts).toEqual([{}]);
    expect(p.named_places).toEqual([{ kind: 'city', token: 'جدة' }]);
    // A token that agrees (ة/ه) keeps its object.
    const same = a('direction', 'شمال جدة', { normalized_token: 'شمال جده' });
    expect(prepareMention(ev('ابي شمال جدة', [same])).anchors[0]).toBe(same);
    expect(prepareMention(ev('ابي جنوب انس بن مالك', [a('direction', 'جنوب انس بن مالك')])).contexts).toEqual([{}]);
  });

  it('e: a bare span stays bare; a city referent only in the token CONFIRMS (Rule Z) and is a named place', () => {
    // Repair round 1: the token's referent used to be DROPPED, so the established
    // city's zone was drawn for «في جدة بالشمال» stored as [«بالشمال» / «شمال جدة»].
    const p = prepareMention(ev('ابي بالشمال', [a('direction', 'بالشمال', { normalized_token: 'شمال الرياض' })]));
    expect(shape(p)).toEqual([['direction', 'شمال']]);
    expect(p.contexts).toEqual([{ confirm_city: 'الرياض' }]);
    expect(p.named_places).toEqual([{ kind: 'city', token: 'الرياض' }]);
    const q = prepareMention(ev('ابي في جدة بالشمال', [a('direction', 'بالشمال', { normalized_token: 'شمال جدة' })]));
    expect(q.contexts).toEqual([{ confirm_city: 'جدة' }]);
    expect(q.named_places).toEqual([{ kind: 'city', token: 'جدة' }]);
    // No referent anywhere: bare, no flag.
    expect(prepareMention(ev('ابي بالشمال', [a('direction', 'بالشمال', { normalized_token: 'شمال' })])).contexts).toEqual([{}]);
  });

  it('e: a ROAD (or district) referent only in the token asks referent_only_in_token', () => {
    for (const [m, span, tok] of [
      ['ابي غرب الملك فهد', 'غرب', 'غرب الملك فهد'],
      ['ابي غرب طريق الملك فهد', 'غرب', 'غرب طريق الملك فهد'],
      ['ابي جنوب سلمان', 'جنوب', 'جنوب الملك سلمان'],
      ['ابي على طريق الملك فهد من الغرب', 'الغرب', 'غرب طريق الملك فهد'],
      ['ابي شمال حي النرجس', 'شمال', 'شمال حي النرجس'],
    ] as const) {
      expect(asks(prepareMention(ev(m, [a('direction', span, { normalized_token: tok })])))).toEqual(['referent_only_in_token']);
    }
  });

  it('e: a token referent that is not the mention\'s named city → zone_city_unclear (BD3)', () => {
    const p = prepareMention(ev('ابي في الرياض بالشمال', [a('city', 'الرياض'), a('direction', 'بالشمال', { normalized_token: 'شمال جدة' })]));
    expect(asks(p)).toEqual([null, 'zone_city_unclear']);
  });

  it('f: a span with no direction word falls back to the token', () => {
    const p = prepareMention(ev('ابي شمالي الرياض', [a('direction', 'شمالي الرياض', { normalized_token: 'شمال الرياض' })]));
    expect(p.contexts).toEqual([{}]);
    expect(p.named_places).toEqual([{ kind: 'city', token: 'الرياض' }]);
    const q = prepareMention(ev('ابي الشمالي طريق الملك فهد', [a('direction', 'الشمالي طريق الملك فهد', { normalized_token: 'شمال طريق الملك فهد' })]));
    expect(q.contexts).toEqual([{ referent_is_road: true }]);
  });

  it('f: a side the customer never said (only the token has it) asks anchor_not_in_text', () => {
    // Repair round 1: «قريب من الملك فهد» stored as [«الملك فهد» / «غرب الملك فهد»] drew a band WEST of the road.
    expect(asks(prepareMention(ev('ابي قريب من الملك فهد', [a('direction', 'الملك فهد', { normalized_token: 'غرب الملك فهد' })]))))
      .toEqual(['anchor_not_in_text']);
    expect(asks(prepareMention(ev('ابي فيلا على طريق الملك فهد', [
      a('direction', 'طريق الملك فهد', { normalized_token: 'غرب طريق الملك فهد' }),
    ])))).toEqual(['anchor_not_in_text']);
    // The side said in an adjectival form grounds it («الغربي»).
    expect(asks(prepareMention(ev('ابي الغربي طريق الملك فهد', [
      a('direction', 'الغربي طريق الملك فهد', { normalized_token: 'غرب طريق الملك فهد' }),
    ])))).toEqual([null]);
  });
});

describe('P6 — a city right after a bare direction owns it', () => {
  it('directly, across «مدينة / محافظة», and with a «ب / ل» clitic', () => {
    for (const m of ['ابي شمال جدة', 'ابي شمال مدينة جدة', 'ابي شمال بجدة', 'ابي شمال لجدة']) {
      expect(prepareMention(ev(m, [a('direction', 'شمال'), a('city', 'جدة')])).contexts).toEqual([{ city: 'جدة' }, {}]);
    }
  });

  it('never across «و», another word or punctuation: the city then only CONFIRMS (BD3)', () => {
    for (const m of ['ابي شمال وجدة', 'ابي شمال في جدة', 'ابي شمال، جدة']) {
      expect(prepareMention(ev(m, [a('direction', 'شمال'), a('city', 'جدة')])).contexts).toEqual([{ confirm_city: 'جدة' }, {}]);
    }
  });

  it('a REGION owner asks zone_of_region and is a named region', () => {
    const p = prepareMention(ev('ابي شمال القصيم', [a('direction', 'شمال'), a('region', 'القصيم')]));
    expect(asks(p)).toEqual(['zone_of_region', null]);
    expect(p.named_places).toEqual([{ kind: 'region', token: 'القصيم' }]);
  });
});

describe('P7 — bare directions: the closed set BD1–BD5', () => {
  it('BD1 a region in the mention → zone_city_unclear; none → no flag', () => {
    const p = prepareMention(ev('في المنطقة الشرقية بالشمال', [a('region', 'المنطقة الشرقية'), a('direction', 'الشمال')]));
    expect(asks(p)).toEqual([null, 'zone_city_unclear']);
    expect(prepareMention(ev('في الشمال', [a('direction', 'الشمال')])).contexts).toEqual([{}]);
  });

  it('BD2 beside a road, a venue, a road side or an OWNED direction → direction_referent_unclear; beside a bare one → no flag', () => {
    expect(asks(prepareMention(ev('ابي الشمال قريب من طريق الملك فهد', [a('direction', 'الشمال'), a('road', 'طريق الملك فهد')]))))
      .toEqual(['direction_referent_unclear', null]);
    expect(asks(prepareMention(ev('ابي الشمال قريب من النخيل مول', [a('direction', 'الشمال'), a('landmark', 'النخيل مول')]))))
      .toEqual(['direction_referent_unclear', null]);
    // «شمال او شرق جدة»: «شرق» is Jeddah's, so «شمال» could be Jeddah's or the client's city.
    const p = prepareMention(ev('ابي شمال او شرق جدة', [a('direction', 'شمال'), a('direction', 'شرق'), a('city', 'جدة')]));
    expect(p.contexts).toEqual([{ ask_reason: 'direction_referent_unclear' }, { city: 'جدة' }, {}]);
    expect(prepareMention(ev('شمال او جنوب', [a('direction', 'شمال'), a('direction', 'جنوب')])).contexts).toEqual([{}, {}]);
  });

  it('BD3 a named city elsewhere only CONFIRMS; two named cities → zone_city_unclear', () => {
    expect(prepareMention(ev('ابي في جدة بالشمال', [a('city', 'جدة'), a('direction', 'الشمال')])).contexts)
      .toEqual([{}, { confirm_city: 'جدة' }]);
    expect(asks(prepareMention(ev('في الرياض او جدة بالشمال', [a('city', 'الرياض'), a('city', 'جدة'), a('direction', 'الشمال')]))))
      .toEqual([null, null, 'zone_city_unclear']);
  });

  it('BD4 right next to a district (gap «حي» allowed, punctuation ignored), or not in the text → side_of_district', () => {
    for (const [m, anchors] of [
      ['ابي شمال حي النرجس', [a('direction', 'شمال'), a('district', 'النرجس')]],
      ['ابي المعذر الشمالي', [a('district', 'المعذر'), a('direction', 'الشمالي', { normalized_token: 'شمال' })]],
      ['النرجس، الشمال منه', [a('district', 'النرجس'), a('direction', 'الشمال')]],
      ['ابي بحي الصفاء بالشرق', [a('district', 'حي الصفاء', { normalized_token: 'الصفاء' }), a('direction', 'الشرق')]],
      ['ابي النرجس', [a('district', 'النرجس'), a('direction', 'شمال')]],
    ] as Array<[string, AnchorToken[]]>) {
      const p = prepareMention(ev(m, anchors));
      expect(p.contexts.find((_, i) => p.anchors[i]!.anchor_type === 'direction')).toEqual({ ask_reason: 'side_of_district' });
    }
  });

  it('BD4 asks BEFORE BD3: a city word never cancels the side-of-district veto', () => {
    // Repair round 1: «بالرياض» used to reach BD3 first and turn the north side
    // of Narjis into the whole north of Riyadh.
    for (const [m, anchors] of [
      ['ابي شمال حي النرجس بالرياض', [a('direction', 'شمال'), a('district', 'حي النرجس'), a('city', 'الرياض')]],
      ['ابي شمال النرجس بالرياض', [a('direction', 'شمال'), a('district', 'النرجس'), a('city', 'الرياض')]],
      ['ابي بحي الصفاء بالشرق في الرياض', [a('district', 'حي الصفاء'), a('direction', 'بالشرق'), a('city', 'الرياض')]],
    ] as Array<[string, AnchorToken[]]>) {
      const p = prepareMention(ev(m, anchors));
      expect(p.contexts.find((_, i) => p.anchors[i]!.anchor_type === 'direction')).toEqual({ ask_reason: 'side_of_district' });
    }
  });

  it('BD4 a district elsewhere in the mention → no flag (the established zone is unioned with it)', () => {
    const p = prepareMention(ev('في ضاحية خزام أو، ابي في الشمال', [a('district', 'خزام'), a('direction', 'الشمال')]));
    expect(p.contexts).toEqual([{}, {}]);
  });

  it('BD5 alone → no flag (the established zone)', () => {
    expect(prepareMention(ev('ابي في الشمال', [a('direction', 'الشمال')])).contexts).toEqual([{}]);
  });
});

describe('P10 — a radius only for a distance the customer SAID', () => {
  const landmark = (d: number) => a('landmark', 'الرياض بارك', { distance_m: d });

  it('a distance_m the text does not state asks distance_unverified — never a radius', () => {
    const p = prepareMention(ev('قريب من طريق الملك فهد', [a('road', 'طريق الملك فهد', { distance_m: 2000 })]));
    expect(p.contexts).toEqual([{ proximity: true, ask_reason: 'distance_unverified' }]);
    // A travel time is not a distance.
    expect(asks(prepareMention(ev('قريب من الرياض بارك 10 دقايق', [landmark(10000)])))).toEqual(['distance_unverified']);
    // A number within 1 % is the same number.
    expect(prepareMention(ev('قريب من الرياض بارك 2 كيلو', [landmark(2010)])).contexts).toEqual([{ proximity: true, radius_m: 2010 }]);
  });

  it('the attributed customer turn verifies a distance the trimmed mention_span lost; another ref or the agent does not', () => {
    const turns = (ref: string, speaker: 'client' | 'agent') => ({
      channel: 'chat' as const, turns: [{ speaker, text: 'ابي قريب من الرياض بارك خلال 3 كيلو', ref }],
    });
    const e = ev('قريب من الرياض بارك', [landmark(3000)]);
    expect(prepareMention(e, { conversation: turns('m1', 'client') }).contexts).toEqual([{ proximity: true, radius_m: 3000 }]);
    expect(asks(prepareMention(e, { conversation: turns('m2', 'client') }))).toEqual(['distance_unverified']);
    expect(asks(prepareMention(e, { conversation: turns('m1', 'agent') }))).toEqual(['distance_unverified']);
    expect(asks(prepareMention(e))).toEqual(['distance_unverified']);
  });
});

describe('P11 — grounding: a structural anchor must be in the customer\'s words', () => {
  it('live L1: «شمال طريق الملك فهد» is not in «شمال الرياض على طريق الملك فهد» → asks', () => {
    const p = prepareMention(ev('شمال الرياض على طريق الملك فهد', [a('direction', 'شمال طريق الملك فهد')]));
    expect(p.contexts[0]!.ask_reason).toBe('anchor_not_in_text');
  });

  it('a v8 split row whose spans are verbatim passes', () => {
    const p = prepareMention(ev('شمال الرياض على طريق الملك فهد', [
      a('direction', 'شمال'), a('city', 'الرياض'), a('road', 'طريق الملك فهد', { role_in_relation: 'along' }),
    ]));
    expect(p.contexts).toEqual([{ city: 'الرياض' }, {}, { city: 'الرياض', proximity: true }]);
  });

  it('an attributed customer turn grounds it; admin places and bare directions are exempt', () => {
    const venue = a('landmark', 'جامعة الملك سعود');
    const conversation: Conversation = { channel: 'chat', turns: [{ speaker: 'client', text: 'قريب من جامعة الملك سعود', ref: 'm1' }] };
    expect(asks(prepareMention(ev('ابي قريب منها', [venue])))).toEqual(['anchor_not_in_text']);
    expect(asks(prepareMention(ev('ابي قريب منها', [venue]), { conversation }))).toEqual([null]);
    expect(asks(prepareMention(ev('ابي فيلا', [a('district', 'النرجس')])))).toEqual([null]);
    expect(asks(prepareMention(ev('ابي فيلا', [a('city', 'الرياض'), a('direction', 'شمال')])))).toEqual([null, null]);
  });
});

describe('P9 — a named city scopes only what it QUALIFIES (repair round 1)', () => {
  it('a city offered as an alternative (no «ب / في», not an owner or a referent) beside another place asks city_role_unclear', () => {
    for (const [m, anchors] of [
      ['ابي الروضة او جدة', [a('district', 'الروضة'), a('city', 'جدة')]],
      ['جدة او الروضة', [a('city', 'جدة'), a('district', 'الروضة')]],
      ['الروضة، جدة', [a('district', 'الروضة'), a('city', 'جدة')]],
      ['الروابي ولا الدمام', [a('district', 'الروابي'), a('city', 'الدمام')]],
      ['ابي شمال الرياض او جدة', [a('direction', 'شمال الرياض'), a('city', 'جدة')]],
      ['شمال طريق الملك عبدالله او جدة', [a('direction', 'شمال طريق الملك عبدالله'), a('city', 'جدة')]],
    ] as Array<[string, AnchorToken[]]>) {
      const p = prepareMention(ev(m, anchors));
      expect(p.contexts.find((_, i) => p.anchors[i]!.anchor_type === 'city')!.ask_reason, m).toBe('city_role_unclear');
      expect(p.contexts.some((c) => c.admin_city || c.city), m).toBe(false);
    }
  });

  it('a qualifying city scopes: «بجدة», «في جدة», «في مدينة جدة», an owner, a referent', () => {
    for (const m of ['الروضة بجدة', 'الروضة في جدة', 'الروضة في مدينة جدة', 'الروضة بمدينة جدة']) {
      expect(prepareMention(ev(m, [a('district', 'الروضة'), a('city', 'جدة')])).contexts, m).toEqual([{ admin_city: 'جدة' }, {}]);
    }
    expect(prepareMention(ev('الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال'), a('city', 'جدة')])).contexts)
      .toEqual([{ admin_city: 'جدة' }, { city: 'جدة' }, {}]);
  });

  it('a disjunction word between the city and a place stops the scope; one before both does not', () => {
    const p = prepareMention(ev('النرجس او الشمال بالرياض', [a('district', 'النرجس'), a('direction', 'الشمال'), a('city', 'الرياض')]));
    expect(p.contexts[0]).toEqual({});
    const q = prepareMention(ev('او شمال طريق الملك فهد بالخبر', [a('direction', 'شمال طريق الملك فهد'), a('city', 'الخبر')]));
    expect(q.contexts[0]).toMatchObject({ city: 'الخبر' });
  });
});

describe('outputs — disjunctive, named_places', () => {
  it('disjunctive: «او / أو / ولا / ام / or» as a whole word of mention_span; «و» is not', () => {
    expect(prepareMention(ev('النرجس او شمال طريق الملك سلمان', [])).disjunctive).toBe(true);
    expect(prepareMention(ev('النرجس أو العليا', [])).disjunctive).toBe(true);
    expect(prepareMention(ev('north or south', [])).disjunctive).toBe(true);
    expect(prepareMention(ev('ابي النرجس وجنوب سلمان', [])).disjunctive).toBe(false);
    expect(prepareMention(ev('ابي الاوسط', [])).disjunctive).toBe(false);
  });

  it('disjunctive: the Gulf «والا / وإلا / والّا» and «يا … يا» (repair round 1); one «يا» is not', () => {
    for (const m of ['النرجس والا شمال طريق الملك سلمان', 'النرجس وإلا شمال طريق الملك سلمان', 'النرجس والّا العليا',
      'يا النرجس يا شمال طريق الملك سلمان', 'either Narjis or Olaya']) {
      expect(prepareMention(ev(m, [])).disjunctive, m).toBe(true);
    }
    expect(prepareMention(ev('يا اخي ابي النرجس', [])).disjunctive).toBe(false);
  });

  it('named_places: the scope cities, every region, and each P5 path-d referent — distinct', () => {
    expect(prepareMention(ev('ابي في جدة بالشمال', [a('city', 'جدة'), a('direction', 'الشمال')])).named_places)
      .toEqual([{ kind: 'city', token: 'جدة' }]);
    expect(prepareMention(ev('شمال طريق الملك فهد بالمنطقة الشرقية', [
      a('direction', 'شمال'), a('road', 'طريق الملك فهد'), a('region', 'المنطقة الشرقية'),
    ])).named_places).toEqual([{ kind: 'region', token: 'المنطقة الشرقية' }]);
    expect(prepareMention(ev('شمال جدة وجدة', [a('direction', 'شمال جدة'), a('city', 'جدة')])).named_places)
      .toEqual([{ kind: 'city', token: 'جدة' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('V8 — a road side offered as an alternative («او …»)', () => {
  const side = 'شمال طريق الملك سلمان';
  const said = (text: string) => offeredAsAlternative(ev(side, []), { channel: 'chat', turns: [{ speaker: 'client', text, ref: 'm1' }] });

  it('«او» right before the road side', () => {
    expect(said('ابي فيلا بالنرجس او شمال طريق الملك سلمان')).toBe(true);
    expect(said('النرجس أو شمال طريق الملك سلمان')).toBe(true);
  });

  it('«او» a few filler words back («او اي مكان …», «او في …») — 2026-10-04', () => {
    expect(said('ابي في النرجس، أو أي مكان شمال طريق الملك سلمان')).toBe(true);
    expect(said('النرجس او في شمال طريق الملك سلمان')).toBe(true);
  });

  it('a qualifier, not an alternative: no «او», or the «او» joins districts', () => {
    expect(said('ابي فيلا بالنرجس شمال طريق الملك سلمان')).toBe(false);
    expect(said('النرجس او الياسمين شمال طريق الملك سلمان')).toBe(false);
  });

  it('without the conversation only the span is read (the bug the sales agent hit)', () => {
    expect(offeredAsAlternative(ev(side, []))).toBe(false);
  });
});

describe('P10 — a venue said as a station', () => {
  const conv = (text: string): Conversation => ({ channel: 'chat', id: 'c', turns: [{ speaker: 'client', text, ref: 'm1' }] });
  const station = (p: { contexts: Array<{ station?: boolean }> }) => p.contexts.map((c) => c.station === true);
  it('a station word inside the span', () => {
    expect(station(prepareMention(ev('قريبة من محطة مترو العليا', [a('landmark', 'محطة مترو العليا')])))).toEqual([true]);
  });
  it('«محطة» right before the name in the customer\u2019s turn, though the span dropped it', () => {
    const e = ev('مستشفى الإيمان', [a('landmark', 'مستشفى الإيمان')]);
    expect(station(prepareMention(e, { conversation: conv('ابي شقة قريبة من محطة مستشفى الإيمان') }))).toEqual([true]);
  });
  it('no station word → not a station', () => {
    const e = ev('مستشفى الإيمان', [a('landmark', 'مستشفى الإيمان')]);
    expect(station(prepareMention(e, { conversation: conv('ابي شقة قريبة من مستشفى الإيمان') }))).toEqual([false]);
  });
});
