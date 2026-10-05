import { describe, it, expect } from 'vitest';
import { mergeLocationItems, locationItemPlaceKey } from '../../../geo-preference/review.js';
import { buildAiPrefPatch, undoPrefValue } from '../../../../src/lib/clientPrefs/mergePrefs.js';
import {
  readStoredProfiles, resolveTarget, profileValues, writeProfileValues, addAiProfile, removeAiProfile,
} from '../profileTarget.js';
import { conflictingFields, routeFromAnswer } from '../wishRouter.js';
import type { Conversation } from '../../geoPreference/extractor.js';
import type { LocationItem } from '../../../../src/lib/geo/locationItems.js';

const d = (id: string, polarity: 'include' | 'exclude', label = id): LocationItem =>
  ({ id: `${id}-${polarity}`, kind: 'district', polarity, district_id: id, district_label: label }) as LocationItem;
const sug = (slug: string, value: unknown, quote = 'q') => ({ slug, value, quote, confidence: 90 });
const options = { preferred_unit_type: ['شقة', 'دور', 'فيلا'], preferred_readiness: ['ready', 'off_plan'] };

describe('places: a place is never both wanted and excluded (live test 2026-10-05)', () => {
  it('a newer exclusion drops the earlier inclusion of the same district', () => {
    const out = mergeLocationItems([d('east1', 'include'), d('north1', 'include')], [d('east1', 'exclude')]);
    expect(out.map((i) => `${i.polarity}:${locationItemPlaceKey(i)}`).sort()).toEqual(['exclude:d:east1', 'include:d:north1']);
  });
  it('a newer inclusion drops the earlier exclusion', () => {
    const out = mergeLocationItems([d('east1', 'exclude')], [d('east1', 'include')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.polarity).toBe('include');
  });
  it('inside one batch the exclusion wins', () => {
    const out = mergeLocationItems([], [d('east1', 'include'), d('east1', 'exclude')]);
    expect(out.map((i) => i.polarity)).toEqual(['exclude']);
  });
  it('plain additions still union', () => {
    expect(mergeLocationItems([d('a', 'include')], [d('a', 'include'), d('b', 'include')])).toHaveLength(2);
  });
});

describe('preferences: a change of mind replaces the AI\'s old values, a rep\'s stay', () => {
  it('replace mode drops only the AI-added set values', () => {
    const r = buildAiPrefPatch(
      { preferred_unit_type: ['شقة', 'فيلا'] }, { preferred_unit_type: sug('preferred_unit_type', ['دور']) }, ['preferred_unit_type'], options, new Set(),
      { slugs: new Set(['preferred_unit_type']), aiAdded: { preferred_unit_type: ['شقة'] } },
    );
    expect(r.patch.preferred_unit_type).toEqual(['فيلا', 'دور']); // فيلا was the rep's
    expect(r.replaced).toEqual(['preferred_unit_type']);
    expect(r.added.preferred_unit_type).toEqual(['دور']);
  });
  it('without replace mode it still unions (same wish)', () => {
    const r = buildAiPrefPatch({ preferred_unit_type: ['شقة'] }, { preferred_unit_type: sug('preferred_unit_type', ['دور']) }, ['preferred_unit_type'], options, new Set());
    expect(r.patch.preferred_unit_type).toEqual(['شقة', 'دور']);
    expect(r.replaced).toEqual([]);
  });
  it('undo of a replacement restores the earlier value while the field is unchanged', () => {
    expect(undoPrefValue('preferred_unit_type', ['دور'], { before: ['شقة'], after: ['دور'], added: ['دور'], replaced: true })).toEqual({ value: ['شقة'] });
    expect(undoPrefValue('preferred_unit_type', ['دور', 'فيلا'], { before: ['شقة'], after: ['دور'], added: ['دور'], replaced: true })).toBeNull();
  });
});

describe('profiles on the server', () => {
  const flat = { preferred_unit_type: ['فيلا'], client_name: 'x' };
  it('a client without profiles has one active `default`', () => {
    expect(readStoredProfiles(flat)).toMatchObject({ activeId: 'default', materialized: false });
    expect(resolveTarget(flat, 'default')).toBeNull();
  });
  it('adding a profile keeps the active one active and writes only that profile', () => {
    const { data, profileId } = addAiProfile(flat, 'شقة استثمار - دبي', '2026-10-05T00:00:00Z');
    const st = readStoredProfiles(data);
    expect(st.activeId).toBe('default');
    expect(st.profiles.map((p) => p.name)).toEqual(['التفضيل الرئيسي', 'شقة استثمار - دبي']);
    expect(resolveTarget(data, profileId)).toBe(profileId);
    const written = writeProfileValues(data, profileId, { preferred_unit_type: ['شقة'] });
    expect(written.preferred_unit_type).toEqual(['فيلا']); // the active (flat) profile is untouched
    expect(profileValues(written, profileId).preferred_unit_type).toEqual(['شقة']);
    expect(removeAiProfile(written, profileId)).not.toBeNull();
    expect(removeAiProfile(written, 'default')).toBeNull(); // never the active one
  });
});

describe('the wish router', () => {
  const conv: Conversation = { channel: 'chat', id: 't', turns: [
    { speaker: 'client', text: 'ابي فيلا في الشمال للسكن' },
    { speaker: 'agent', text: 'أبشر' },
    { speaker: 'client', text: 'وكمان ابي شقة استثمار في دبي' },
  ] };
  it('no conflict with the only profile → nothing to decide', () => {
    expect(conflictingFields({ preferred_unit_type: ['فيلا'] }, { prefs: { preferred_unit_type: { value: ['فيلا'], quote: null } }, places: [] })).toEqual([]);
    expect(conflictingFields({}, { prefs: { preferred_unit_type: { value: ['شقة'], quote: null } }, places: [] })).toEqual([]);
  });
  it('a new type, a flipped place, or a new area next to saved ones is a conflict', () => {
    expect(conflictingFields({ preferred_unit_type: ['فيلا'] }, { prefs: { preferred_unit_type: { value: ['شقة'], quote: null } }, places: [] })).toEqual(['unit_type']);
    expect(conflictingFields({ location_items: [d('e', 'include')] }, { prefs: {}, places: [d('e', 'exclude')] })).toEqual(['location']);
    expect(conflictingFields({ location_items: [d('e', 'include')] }, { prefs: {}, places: [d('w', 'include')] })).toEqual(['location']);
  });
  const ctx = { profileIds: ['default'], activeId: 'default', conversation: conv, conflicts: ['unit_type' as const] };
  it('a second wish needs the customer\'s own words', () => {
    expect(routeFromAnswer({ decision: 'second_wish', quote: 'وكمان ابي شقة استثمار في دبي', new_profile_name: 'شقة استثمار - دبي' }, ctx))
      .toMatchObject({ kind: 'second', profileName: 'شقة استثمار - دبي' });
    expect(routeFromAnswer({ decision: 'second_wish', quote: 'العميل يريد عقارين' }, ctx)).toMatchObject({ kind: 'same', profileId: null });
  });
  it('a change of mind falls back to the conflicting fields when the model lists none', () => {
    expect(routeFromAnswer({ decision: 'changed_mind', quote: 'وكمان ابي شقة', changed: [] }, ctx)).toMatchObject({ kind: 'changed', fields: ['unit_type'] });
  });
  it('an unknown profile id means the active profile', () => {
    expect(routeFromAnswer({ decision: 'same_wish', profile_id: 'nope' }, ctx)).toMatchObject({ kind: 'same', profileId: null });
  });
});
