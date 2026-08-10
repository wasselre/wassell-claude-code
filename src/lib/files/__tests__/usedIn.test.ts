/**
 * Tests for the "Used in" panel's render-determining logic.
 *
 * These cover everything that decides WHAT the panel puts on screen: the
 * feature gate, the grouping that turns N link rows into N' record rows, the
 * bilingual role labels, and the fail-loudly contract on transport errors.
 *
 * Pixel-level render evidence needs a browser; this sandbox has none and the
 * repo carries no jsdom/testing-library harness, so that is verified manually
 * against a deployed preview, not here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { groupByRecord, recordKey, fetchUsedIn, fileLinksEnabled, UsedInLink } from '../usedIn';
import { roleLabel, FILE_LINK_ROLE_LABELS } from '../linkRoles';

const link = (over: Partial<UsedInLink>): UsedInLink => ({
  link_id: 'l1', role: 'floor_plan', record_id: 'r1', model_id: 'm-units',
  model_name: 'units', model_label_ar: 'وحدات', model_label_en: 'Units',
  title: 'A-101', ...over,
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('fileLinksEnabled — the panel ships dark', () => {
  it('is OFF when the flag is unset', () => {
    vi.stubEnv('VITE_FEATURE_FILE_LINKS', '');
    expect(fileLinksEnabled()).toBe(false);
  });
  it('is OFF for any value other than exactly "1"', () => {
    for (const v of ['0', 'true', 'yes', 'on']) {
      vi.stubEnv('VITE_FEATURE_FILE_LINKS', v);
      expect(fileLinksEnabled()).toBe(false);
    }
  });
  it('is ON only for "1"', () => {
    vi.stubEnv('VITE_FEATURE_FILE_LINKS', '1');
    expect(fileLinksEnabled()).toBe(true);
  });
});

describe('groupByRecord — one record reads as ONE row', () => {
  it('collapses several roles on the same record into one row', () => {
    const out = groupByRecord([
      link({ link_id: 'l1', role: 'main_image' }),
      link({ link_id: 'l2', role: 'marketing_asset' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].roles).toEqual(['main_image', 'marketing_asset']);
  });

  it('does not duplicate a role repeated across source occurrences', () => {
    const out = groupByRecord([
      link({ link_id: 'l1', role: 'floor_plan' }),
      link({ link_id: 'l2', role: 'floor_plan' }),
    ]);
    expect(out[0].roles).toEqual(['floor_plan']);
  });

  it('keeps distinct records apart', () => {
    const out = groupByRecord([
      link({ record_id: 'r1', title: 'A-101' }),
      link({ record_id: 'r2', title: 'B-202' }),
    ]);
    expect(out.map((g) => g.title)).toEqual(['A-101', 'B-202']);
  });

  it('preserves a null model_name so the panel can refuse to deep-link', () => {
    const out = groupByRecord([link({ model_name: null })]);
    expect(out[0].model_name).toBeNull();
  });

  it('returns nothing for no links — the panel renders nothing, not an empty card', () => {
    expect(groupByRecord([])).toEqual([]);
  });

  // Record ids are only unique PER MODEL. A frozen model keeps its rows in its
  // own physical table, so the same uuid really can exist under two models —
  // and they are two different business records that must never be merged into
  // one row (which would also mean one wrong deep-link).
  it('does NOT merge the same record uuid across two different models', () => {
    const out = groupByRecord([
      link({ record_id: 'same-uuid', model_id: 'm-units',    model_name: 'units',    role: 'floor_plan',          title: 'Unit A-101' }),
      link({ record_id: 'same-uuid', model_id: 'm-listings', model_name: 'listings', role: 'supporting_document', title: 'A listing' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.model_name).sort()).toEqual(['listings', 'units']);
    // each keeps its OWN role — no cross-contamination
    expect(out.find((g) => g.model_name === 'units')!.roles).toEqual(['floor_plan']);
    expect(out.find((g) => g.model_name === 'listings')!.roles).toEqual(['supporting_document']);
  });

  it('still merges roles when model AND record both match', () => {
    const out = groupByRecord([
      link({ record_id: 'r9', model_id: 'm-p', role: 'main_image' }),
      link({ record_id: 'r9', model_id: 'm-p', role: 'gallery_image' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].roles).toEqual(['main_image', 'gallery_image']);
  });

  it('emits a model-scoped key, usable as a stable React key', () => {
    const out = groupByRecord([link({ record_id: 'r1', model_id: 'm-units' })]);
    expect(out[0].key).toBe('m-units|r1');
    expect(recordKey({ model_id: 'm-units', record_id: 'r1' })).toBe('m-units|r1');
  });
});

describe('roleLabel — bilingual, never a raw slug', () => {
  it('translates every known role in both languages', () => {
    for (const role of Object.keys(FILE_LINK_ROLE_LABELS)) {
      expect(roleLabel(role, true)).toBeTruthy();
      expect(roleLabel(role, false)).toBeTruthy();
      expect(roleLabel(role, true)).not.toBe(role);
    }
  });
  it('falls back to the slug for a role the client does not know yet', () => {
    // Forward-compatible: SQL may add a role before this table catches up.
    expect(roleLabel('brand_new_role', false)).toBe('brand_new_role');
  });
  it('labels the unmapped sentinel rather than showing "unmapped"', () => {
    expect(roleLabel('unmapped', false)).not.toBe('unmapped');
    expect(roleLabel('unmapped', true)).not.toBe('unmapped');
  });

  // These two are NOT field-derived roles and mean different things:
  // `attachment` = associated, relationship type NOT asserted (the legacy
  // files.record_id column); `unmapped` = a real field we haven't named yet.
  // Showing the same label for both would erase that distinction.
  it('distinguishes the role-neutral attachment from the unmapped sentinel', () => {
    expect(roleLabel('attachment', false)).not.toBe(roleLabel('unmapped', false));
    expect(roleLabel('attachment', true)).not.toBe(roleLabel('unmapped', true));
  });
});

describe('fetchUsedIn — fails loudly, never to a blank box', () => {
  it('throws with the server error text on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({ error: 'link lookup failed: boom' }),
    }));
    await expect(fetchUsedIn('f1')).rejects.toThrow('link lookup failed: boom');
  });

  it('throws on a non-OK response with an unparseable body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 502, json: async () => { throw new Error('not json'); },
    }));
    await expect(fetchUsedIn('f1')).rejects.toThrow('HTTP 502');
  });

  it('returns an empty list (not an error) when the file is genuinely unlinked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ links: [], hiddenCount: 0 }),
    }));
    await expect(fetchUsedIn('f1')).resolves.toEqual({ links: [], hiddenCount: 0 });
  });

  it('never invents a hiddenCount the server did not send', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ links: [link({})] }),
    }));
    const res = await fetchUsedIn('f1');
    expect(res.hiddenCount).toBe(0);
    expect(res.links).toHaveLength(1);
  });
});
