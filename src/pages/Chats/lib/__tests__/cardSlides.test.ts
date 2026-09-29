import { describe, it, expect } from 'vitest';
import { buildCardSlides, callDayMonth, mergeDoneSlides, type SlideSourceDTO } from '../cardSlides';
import type { CallGeoDTO, CallProposalDTO, PrefsCardDTO, PrefSuggestionDTO } from '../../components/PrefSuggestionsSection';
import type { GeoCardDTO, GeoCardProposalDTO } from '../geoRows';

const sug = (value: unknown): PrefSuggestionDTO => ({ value, quote: 'q', confidence: 0.9, slug: 'x' });

const geoProposal = (id: string, status: string, evidence: string[]): GeoCardProposalDTO => ({
  id, version: 1, status, proposed_action: 'propose',
  expression: { groups: [] } as unknown as GeoCardProposalDTO['expression'],
  by_evidence: Object.fromEntries(evidence.map((e) => [e, { polarity: 'include', operation: 'district_polygon', element_ids: ['d1'], resolved: true, label: '' }])),
  items: [], items_by_evidence: {}, verifier: null,
});

const geoCard = (status: GeoCardDTO['status'], proposal: GeoCardProposalDTO | null, mentions: string[]): GeoCardDTO => ({
  status, checkpoint_id: 'cp', proposal,
  mentions: mentions.map((e) => ({ evidence_id: e, mention_span: `span ${e}`, preference_role: 'primary' })),
  names: {}, analyzed_at: null, stale: false, graded: false, can_reanalyze: true, customer_messages: 3,
});

const callPref = (id: string, call_id: string, call_at: string, status: CallProposalDTO['status'] = 'pending', slugs = ['budget']): CallProposalDTO => ({
  id, version: 1, status, call_id, call_at,
  suggestions: Object.fromEntries(slugs.map((s) => [s, sug({ min: 1 })])),
  current_values: {}, created_at: call_at, decided_at: null, saved_fields: null,
});

const callGeo = (call_id: string, call_at: string, status = 'pending', mentions = ['c1']): CallGeoDTO => ({
  call_id, call_at, proposal_id: `g-${call_id}`,
  card: geoCard('pending', geoProposal(`g-${call_id}`, status, mentions), mentions),
  has_places: false,
});

const prefs = (over: Partial<PrefsCardDTO> = {}): PrefsCardDTO => ({
  proposal: null, read_state: null, unread_customer_messages: 0, pending_transcripts: 0, unread_voice_notes: 0,
  current_values: {}, call_proposals: [], call_geo: [], ...over,
});

const chatPrefProposal = (status: 'pending' | 'saved' | 'dismissed' | 'superseded', slugs: string[]): NonNullable<PrefsCardDTO['proposal']> => ({
  id: 'pp', version: 1, status, suggestions: Object.fromEntries(slugs.map((s) => [s, sug(['apartment'])])),
  current_values: {}, model: 'm', created_at: '2026-09-01T00:00:00.000Z', decided_at: null, saved_fields: null,
});

const card = (geo: GeoCardDTO, p: PrefsCardDTO): SlideSourceDTO => ({ ...geo, prefs: p });

describe('buildCardSlides', () => {
  it('no card, nothing to act on ⇒ no slides', () => {
    expect(buildCardSlides(null)).toEqual([]);
    expect(buildCardSlides(card(geoCard('none', null, []), prefs()))).toEqual([]);
  });

  it('orders chat places, chat specs, then calls newest first (places before specs)', () => {
    const c = card(
      geoCard('pending', geoProposal('gp', 'pending', ['e1', 'e2']), ['e1', 'e2', 'e3']),
      prefs({
        proposal: chatPrefProposal('pending', ['budget', 'preferred_unit_type', 'not_a_pref_field']),
        call_proposals: [callPref('p-old', 'c-old', '2026-08-01T10:00:00.000Z'), callPref('p-new', 'c-new', '2026-09-20T10:00:00.000Z', 'pending', ['budget', 'preferred_area'])],
        call_geo: [callGeo('c-new', '2026-09-20T10:00:00.000Z', 'pending', ['c1', 'c2', 'c3'])],
      }),
    );
    const slides = buildCardSlides(c);
    expect(slides.map((s) => [s.key, s.count])).toEqual([
      ['chat-places', 2], // e3 has no placement — not a line
      ['chat-specs', 2], // only fields the card renders are counted
      ['call-places:c-new', 3],
      ['call-specs:c-new', 2],
      ['call-specs:c-old', 1],
    ]);
  });

  it('a must_confirm reading is still open', () => {
    const c = card(geoCard('must_confirm', geoProposal('gp', 'must_confirm', ['e1']), ['e1']), prefs());
    expect(buildCardSlides(c).map((s) => s.key)).toEqual(['chat-places']);
  });

  it('decided, superseded and empty things are not slides', () => {
    const c = card(
      geoCard('confirmed', geoProposal('gp', 'confirmed', ['e1']), ['e1']),
      prefs({
        proposal: chatPrefProposal('saved', ['budget']),
        call_proposals: [
          callPref('p1', 'c1', '2026-09-01T00:00:00.000Z', 'saved'),
          callPref('p2', 'c2', '2026-09-02T00:00:00.000Z', 'superseded'),
          callPref('p3', 'c3', '2026-09-03T00:00:00.000Z', 'pending', []),
        ],
        call_geo: [
          callGeo('c4', '2026-09-04T00:00:00.000Z', 'rejected'),
          callGeo('c5', '2026-09-05T00:00:00.000Z', 'pending', []),
        ],
      }),
    );
    expect(buildCardSlides(c)).toEqual([]);
    // An open chat reading with no line on the map is nothing to act on either.
    expect(buildCardSlides(card(geoCard('pending', geoProposal('gp', 'pending', []), ['e1']), prefs()))).toEqual([]);
  });

  it('a call place proposal is shown only when it IS the one the audit minted', () => {
    const g = callGeo('c1', '2026-09-01T00:00:00.000Z');
    const stray: CallGeoDTO = { ...g, proposal_id: 'someone-else' };
    expect(buildCardSlides(card(geoCard('none', null, []), prefs({ call_geo: [stray] })))).toEqual([]);
  });
});

describe('mergeDoneSlides', () => {
  const base = card(
    geoCard('pending', geoProposal('gp', 'pending', ['e1']), ['e1']),
    prefs({
      proposal: chatPrefProposal('pending', ['budget']),
      call_proposals: [callPref('p1', 'c1', '2026-09-20T00:00:00.000Z')],
    }),
  );
  const before = buildCardSlides(base);
  const chatSpecs = before.find((s) => s.key === 'chat-specs')!;

  it('a slide decided this session stays in its old place as done after the reload drops it', () => {
    const after = buildCardSlides(card(base, prefs({ proposal: chatPrefProposal('saved', ['budget']), call_proposals: base.prefs!.call_proposals })));
    expect(after.map((s) => s.key)).toEqual(['chat-places', 'call-specs:c1']);
    const merged = mergeDoneSlides(after, { 'chat-specs': { slide: chatSpecs, done: { action: 'saved' } } });
    expect(merged.map((s) => [s.key, s.done?.action ?? null])).toEqual([
      ['chat-places', null],
      ['chat-specs', 'saved'],
      ['call-specs:c1', null],
    ]);
  });

  it('a new reading with the same topic wins over the done one', () => {
    const fresh = buildCardSlides(card(base, prefs({ proposal: { ...chatPrefProposal('pending', ['budget']), id: 'pp-2' } })));
    const merged = mergeDoneSlides(fresh, { 'chat-specs': { slide: chatSpecs, done: { action: 'dismissed' } } });
    const s = merged.find((x) => x.key === 'chat-specs')!;
    expect(s.proposalId).toBe('pp-2');
    expect(s.done).toBeUndefined();
  });

  it('a done call slide sorts back among the calls by call time', () => {
    const oldCall = buildCardSlides(card(geoCard('none', null, []), prefs({ call_proposals: [callPref('p0', 'c0', '2026-09-01T00:00:00.000Z')] })))[0]!;
    const fresh = buildCardSlides(card(geoCard('none', null, []), prefs({
      call_proposals: [callPref('p9', 'c9', '2026-09-25T00:00:00.000Z'), callPref('p5', 'c5', '2026-08-25T00:00:00.000Z')],
    })));
    const merged = mergeDoneSlides(fresh, { [oldCall.key]: { slide: oldCall, done: { action: 'saved', skipped: ['budget'] } } });
    expect(merged.map((s) => s.key)).toEqual(['call-specs:c9', 'call-specs:c0', 'call-specs:c5']);
  });
});

describe('callDayMonth', () => {
  it('day/month, Arabic digits in Arabic', () => {
    const iso = new Date(2026, 7, 31, 12).toISOString(); // local 31 Aug
    expect(callDayMonth(iso, true)).toBe('٣١/٨');
    expect(callDayMonth(iso, false)).toBe('8/31');
    expect(callDayMonth(null, true)).toBe('');
    expect(callDayMonth('not a date', true)).toBe('');
  });
});
