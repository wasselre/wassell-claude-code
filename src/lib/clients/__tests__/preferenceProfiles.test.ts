import { describe, it, expect } from 'vitest';
import type { AppModel } from '@/types';
import {
  PROFILES_KEY,
  ACTIVE_PROFILE_KEY,
  DEFAULT_PROFILE_ID,
  profileFieldSlugs,
  profileKeys,
  readProfiles,
  hasProfiles,
  addProfile,
  switchProfile,
  renameProfile,
  deleteProfile,
} from '../preferenceProfiles';

// Minimal clients model: an identity section + a "Client Preferences" section.
const model = {
  id: 'clients',
  name: 'clients',
  schema: {
    sections: [
      {
        id: 's1',
        label_ar: 'أساسي',
        label_en: 'Basic',
        order: 0,
        is_base: true,
        fields: [
          { id: 'f1', name: 'client_name', label_ar: '', label_en: '', type: 'text', order: 0 },
          { id: 'f2', name: 'purchase_objective', label_ar: '', label_en: '', type: 'multiselect', order: 1 },
        ],
      },
      {
        id: 's2',
        label_ar: 'تفضيلات العميل',
        label_en: 'Client Preferences',
        order: 1,
        is_base: true,
        fields: [
          { id: 'f3', name: 'budget', label_ar: '', label_en: '', type: 'range', order: 0 },
          { id: 'f4', name: 'preferred_unit_type', label_ar: '', label_en: '', type: 'multiselect', order: 1 },
          { id: 'f5', name: 'a_custom_pref', label_ar: '', label_en: '', type: 'text', order: 2 },
        ],
      },
    ],
  },
} as unknown as AppModel;

const keys = profileKeys(model);

describe('profile key derivation', () => {
  it('includes preference-section fields, sidecars, and the goal tag', () => {
    const slugs = profileFieldSlugs(model);
    expect(slugs).toContain('budget');
    expect(slugs).toContain('preferred_unit_type');
    expect(slugs).toContain('a_custom_pref'); // Builder-added field, from the section
    expect(slugs).toContain('purchase_objective'); // known goal tag (Basic section)
  });

  it('excludes identity + derived fields', () => {
    const slugs = profileFieldSlugs(model);
    expect(slugs).not.toContain('client_name');
    expect(slugs).not.toContain('is_retired'); // DERIVED_READONLY_SLUGS
  });

  it('profileKeys adds the sidecar keys', () => {
    expect(keys).toContain('location_items');
    expect(keys).toContain('preference_constraints');
  });
});

describe('readProfiles migration-on-read', () => {
  it('synthesizes one default profile from the flat slugs when none saved', () => {
    const data = { budget: { min: 1, max: 2 }, preferred_unit_type: ['شقة'] };
    const { profiles, activeId } = readProfiles(data, keys, true);
    expect(profiles).toHaveLength(1);
    expect(activeId).toBe(DEFAULT_PROFILE_ID);
    expect(profiles[0].data.budget).toEqual({ min: 1, max: 2 });
    expect(hasProfiles(data)).toBe(false);
  });

  it('reads a saved array and resolves the active id (falls back to first)', () => {
    const data = {
      [PROFILES_KEY]: [
        { id: 'a', name: 'A', created_at: '', data: {} },
        { id: 'b', name: 'B', created_at: '', data: {} },
      ],
      [ACTIVE_PROFILE_KEY]: 'zzz', // stale → falls back to first
    };
    const { profiles, activeId } = readProfiles(data, keys, true);
    expect(profiles).toHaveLength(2);
    expect(activeId).toBe('a');
    expect(hasProfiles(data)).toBe(true);
  });
});

describe('addProfile', () => {
  it('snapshots the active values, adds a blank active profile, and clears the flat slugs', () => {
    const data = { budget: { min: 1, max: 2 }, preferred_unit_type: ['فيلا'] };
    const mut = addProfile(data, keys, { budget: { min: 1, max: 2 }, preferred_unit_type: ['فيلا'], location_items: [{ id: 'x' }] }, 'شقة استثمار', true);
    const list = mut.patch[PROFILES_KEY] as Array<{ id: string; name: string; data: Record<string, unknown> }>;
    expect(list).toHaveLength(2);
    // Default profile captured the current values.
    expect(list[0].data.budget).toEqual({ min: 1, max: 2 });
    // New profile is active + blank; flat slugs cleared.
    expect(mut.patch[ACTIVE_PROFILE_KEY]).toBe(list[1].id);
    expect(list[1].name).toBe('شقة استثمار');
    expect(mut.patch.budget).toBeNull();
    expect(mut.flat?.preferred_unit_type).toBeNull();
  });
});

describe('switchProfile', () => {
  it('captures current values into the old profile and loads the target into flat slugs', () => {
    const data = {
      [PROFILES_KEY]: [
        { id: 'a', name: 'A', created_at: '', data: { budget: { min: 1, max: 1 } } },
        { id: 'b', name: 'B', created_at: '', data: { budget: { min: 9, max: 9 }, preferred_unit_type: ['دور'] } },
      ],
      [ACTIVE_PROFILE_KEY]: 'a',
      budget: { min: 5, max: 5 }, // live edited value on active profile A
    };
    const mut = switchProfile(data, keys, { budget: { min: 5, max: 5 } }, 'b', true)!;
    const list = mut.patch[PROFILES_KEY] as Array<{ id: string; data: Record<string, unknown> }>;
    // A got the live value snapshotted.
    expect(list.find((p) => p.id === 'a')!.data.budget).toEqual({ min: 5, max: 5 });
    // Flat slugs now B's; keys absent on B are cleared to null.
    expect(mut.patch.budget).toEqual({ min: 9, max: 9 });
    expect(mut.patch.preferred_unit_type).toEqual(['دور']);
    expect(mut.patch.a_custom_pref).toBeNull();
    expect(mut.patch[ACTIVE_PROFILE_KEY]).toBe('b');
  });

  it('returns null when switching to the already-active or a missing profile', () => {
    const data = { [PROFILES_KEY]: [{ id: 'a', name: 'A', created_at: '', data: {} }], [ACTIVE_PROFILE_KEY]: 'a' };
    expect(switchProfile(data, keys, {}, 'a', true)).toBeNull();
    expect(switchProfile(data, keys, {}, 'missing', true)).toBeNull();
  });
});

describe('renameProfile', () => {
  it('renames and rejects an empty name', () => {
    const data = { [PROFILES_KEY]: [{ id: 'a', name: 'A', created_at: '', data: {} }], [ACTIVE_PROFILE_KEY]: 'a' };
    const mut = renameProfile(data, keys, {}, 'a', '  فيلا سكن  ', true)!;
    const list = mut.patch[PROFILES_KEY] as Array<{ id: string; name: string }>;
    expect(list[0].name).toBe('فيلا سكن');
    expect(mut.flat).toBeUndefined(); // flat slugs untouched
    expect(renameProfile(data, keys, {}, 'a', '   ', true)).toBeNull();
  });
});

describe('deleteProfile', () => {
  const base = {
    [PROFILES_KEY]: [
      { id: 'a', name: 'A', created_at: '', data: { budget: { min: 1, max: 1 } } },
      { id: 'b', name: 'B', created_at: '', data: { budget: { min: 2, max: 2 } } },
    ],
    [ACTIVE_PROFILE_KEY]: 'a',
    budget: { min: 1, max: 1 },
  };

  it('never deletes the last profile', () => {
    const one = { [PROFILES_KEY]: [{ id: 'a', name: 'A', created_at: '', data: {} }], [ACTIVE_PROFILE_KEY]: 'a' };
    expect(deleteProfile(one, keys, {}, 'a', true)).toBeNull();
  });

  it('deleting the active profile switches to the first remaining and loads its flat slugs', () => {
    const mut = deleteProfile(base, keys, { budget: { min: 1, max: 1 } }, 'a', true)!;
    const list = mut.patch[PROFILES_KEY] as Array<{ id: string }>;
    expect(list.map((p) => p.id)).toEqual(['b']);
    expect(mut.patch[ACTIVE_PROFILE_KEY]).toBe('b');
    expect(mut.patch.budget).toEqual({ min: 2, max: 2 });
  });

  it('deleting a non-active profile leaves the flat slugs untouched', () => {
    const mut = deleteProfile(base, keys, { budget: { min: 1, max: 1 } }, 'b', true)!;
    expect(mut.patch[ACTIVE_PROFILE_KEY]).toBe('a');
    expect(mut.flat).toBeUndefined();
    expect('budget' in mut.patch).toBe(false);
  });
});
