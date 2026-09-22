/**
 * The material rule, branch by branch.
 *
 * `resolveReleaseMaterial` decides what a release posts, so every wrong answer
 * it can give is a wrong thing on the company's real Instagram — or a month of
 * work refused. The branches are driven here against a recording fake client
 * rather than production, and the two hashes it compares are computed by the
 * DATABASE (verified live: `mos_caption_hash('  hello \n')` returns
 * md5('hello \n'), NOT md5('hello') — Postgres `btrim/1` strips spaces only
 * where JS `.trim()` strips all whitespace, so a JS re-implementation would
 * have refused every caption that ends in a newline).
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { preflightPublishSet } from '../../../../src/lib/marketingOS/platformRules.js';
import {
  MANAGED_MATERIAL_RULE, RELEASE_REFUSAL, SLOT_BY_VARIANT, resolveReleaseMaterial,
} from '../releaseMaterial.js';

const PUB = '11111111-1111-4111-8111-111111111111';
const CONTENT = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const SQUARE = '44444444-4444-4444-8444-444444444444';
const VERTICAL = '55555555-5555-4555-8555-555555555555';

type Row = Record<string, unknown>;
type Fail = { message: string; code?: string };

interface Fixture {
  placementVariant?: string | null;
  content?: Row | null;
  version?: Row | null;
  links?: Row[];
  approval?: Row | null;
  designHash?: string | null;
  captionHash?: string | null;
  fail?: Partial<Record<'mos_publications' | 'mos_content' | 'workflow_versions'
    | 'mos_asset_links' | 'mos_content_approvals', string>>;
  rpcFail?: string;
}

interface Calls {
  filters: Array<{ table: string; op: string; args: unknown[] }>;
  rpcs: Array<{ fn: string; args: Row }>;
}

/** Minimal chainable stand-in for the PostgREST builder the resolver uses. */
function makeClient(fx: Fixture): { sb: SupabaseClient; calls: Calls } {
  const calls: Calls = { filters: [], rpcs: [] };

  const listFor = (table: string): { data: unknown; error: Fail | null } => {
    const msg = fx.fail?.[table as keyof NonNullable<Fixture['fail']>];
    if (msg) return { data: null, error: { message: msg, code: 'TEST' } };
    switch (table) {
      case 'mos_publications': return { data: { placement_variant: fx.placementVariant ?? null }, error: null };
      case 'mos_content': return { data: fx.content ?? null, error: null };
      case 'workflow_versions': return { data: fx.version ?? null, error: null };
      case 'mos_asset_links': return { data: fx.links ?? [], error: null };
      case 'mos_content_approvals': return { data: fx.approval ?? null, error: null };
      default: throw new Error(`fake client: unexpected table ${table}`);
    }
  };

  const builder = (table: string): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    const chain = (op: string) => (...args: unknown[]) => {
      calls.filters.push({ table, op, args });
      return self;
    };
    for (const op of ['select', 'eq', 'is', 'in', 'order', 'limit']) self[op] = chain(op);
    self.maybeSingle = () => Promise.resolve(listFor(table));
    // `mos_asset_links` is awaited without `.maybeSingle()`.
    self.then = (
      ok: (v: { data: unknown; error: Fail | null }) => unknown,
      no?: (e: unknown) => unknown,
    ) => Promise.resolve(listFor(table)).then(ok, no);
    return self;
  };

  const sb = {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: Row) => {
      calls.rpcs.push({ fn, args });
      if (fx.rpcFail) return Promise.resolve({ data: null, error: { message: fx.rpcFail } });
      if (fn === 'mos_content_design_hash') return Promise.resolve({ data: fx.designHash ?? null, error: null });
      if (fn === 'mos_caption_hash') return Promise.resolve({ data: fx.captionHash ?? null, error: null });
      throw new Error(`fake client: unexpected rpc ${fn}`);
    },
  } as unknown as SupabaseClient;

  return { sb, calls };
}

const managedVersion = (steps: Row[] = [{ key: 'design_review', auto_meta_ad: true }]): Row => ({
  definition: { metadata: { key: 'post_std', managed_by: 'marketing_os', material_rule: MANAGED_MATERIAL_RULE, steps } },
});
const legacyVersion = (): Row => ({ definition: { metadata: { key: 'post_std', managed_by: 'marketing_os', steps: [] } } });
const content = (over: Row = {}): Row => ({
  data: { caption: 'نص معتمد', hashtags: '#وصل #الرياض' },
  workflow_version_id: VERSION, ...over,
});

const run = (fx: Fixture) => {
  const { sb, calls } = makeClient(fx);
  return resolveReleaseMaterial(sb, PUB, CONTENT).then((r) => ({ r, calls }));
};

describe('the cutover boundary (D1 / D6b)', () => {
  it('content with no pinned workflow version takes the legacy path', async () => {
    const { r } = await run({ content: content({ workflow_version_id: null }) });
    expect(r.mode).toBe('legacy');
    if (r.mode !== 'legacy') return;
    // A legacy record may still carry `hashtags`; the copy ignores it (removed 2026-09-22).
    expect(r.copy).toEqual({ caption: 'نص معتمد' });
  });

  it('a pre-cutover version — no material_rule marker — takes the legacy path', async () => {
    const { r, calls } = await run({ content: content(), version: legacyVersion(), placementVariant: 'feed' });
    expect(r.mode).toBe('legacy');
    // It never even looked at the slots: the legacy path reads the row.
    expect(calls.filters.some((c) => c.table === 'mos_asset_links')).toBe(false);
  });

  it('the marker switches the content onto the managed path', async () => {
    const { r } = await run({
      content: content(), version: managedVersion(), placementVariant: 'feed',
      links: [{ asset_id: SQUARE, role: 'final_square' }],
    });
    expect(r.mode).toBe('managed');
  });
});

describe('files by destination (D1)', () => {
  it('a feed post resolves the square slot and carries the approved caption', async () => {
    const { r, calls } = await run({
      content: content(), version: managedVersion(), placementVariant: 'feed',
      links: [{ asset_id: SQUARE, role: 'final_square' }],
    });
    expect(r.mode).toBe('managed');
    if (r.mode !== 'managed') return;
    expect(r.assetIds).toEqual([SQUARE]);
    expect(r.caption).toBe('نص معتمد');
    expect('hashtags' in r).toBe(false);
    expect(r.captionRequired).toBe(true);
    const roleFilter = calls.filters.find((c) => c.table === 'mos_asset_links' && c.op === 'eq' && c.args[0] === 'role');
    expect(roleFilter?.args[1]).toBe(SLOT_BY_VARIANT.feed);
  });

  it('a story resolves the vertical slot and carries NO caption', async () => {
    const { r, calls } = await run({
      content: content(), version: managedVersion(), placementVariant: 'story',
      links: [{ asset_id: VERTICAL, role: 'final_vertical' }],
    });
    expect(r.mode).toBe('managed');
    if (r.mode !== 'managed') return;
    expect(r.assetIds).toEqual([VERTICAL]);
    expect(r.caption).toBe('');
    expect(r.captionRequired).toBe(false);
    const roleFilter = calls.filters.find((c) => c.table === 'mos_asset_links' && c.op === 'eq' && c.args[0] === 'role');
    expect(roleFilter?.args[1]).toBe(SLOT_BY_VARIANT.story);
  });

  it('only the CURRENT slot version is read — superseded links are filtered out (D5 parity)', async () => {
    const { calls } = await run({
      content: content(), version: managedVersion(), placementVariant: 'feed',
      links: [{ asset_id: SQUARE, role: 'final_square' }],
    });
    const isFilter = calls.filters.find((c) => c.table === 'mos_asset_links' && c.op === 'is');
    expect(isFilter?.args).toEqual(['superseded_at', null]);
  });

  it('a missing slot refuses by name rather than guessing another file', async () => {
    const { r } = await run({
      content: content(), version: managedVersion(), placementVariant: 'feed', links: [],
    });
    expect(r.mode).toBe('refuse');
    if (r.mode !== 'refuse') return;
    expect(r.reason).toBe(RELEASE_REFUSAL.MATERIAL_UNRESOLVED);
    expect(r.en).toContain('square 1:1');
  });

  it('a managed publication with no placement refuses instead of defaulting to feed', async () => {
    const { r } = await run({
      content: content(), version: managedVersion(), placementVariant: null,
      links: [{ asset_id: SQUARE, role: 'final_square' }],
    });
    expect(r.mode).toBe('refuse');
    if (r.mode !== 'refuse') return;
    expect(r.reason).toBe(RELEASE_REFUSAL.MATERIAL_UNRESOLVED);
  });
});

describe('the hash check (D2)', () => {
  const base: Fixture = {
    content: content(), version: managedVersion(), placementVariant: 'feed',
    links: [{ asset_id: SQUARE, role: 'final_square' }],
  };

  it('NO approval row falls through and publishes — 0 rows live, refusing would block everything', async () => {
    const { r, calls } = await run({ ...base, approval: null });
    expect(r.mode).toBe('managed');
    // No approval means no hashes to compare, so no RPC round-trip either.
    expect(calls.rpcs).toHaveLength(0);
  });

  it('an approval whose hashes still match publishes', async () => {
    const { r } = await run({
      ...base,
      approval: { step_key: 'design_review', approved_at: '2026-09-15T00:00:00Z', design_hash: 'dh', caption_hash: 'ch' },
      designHash: 'dh', captionHash: 'ch',
    });
    expect(r.mode).toBe('managed');
  });

  it('a design changed after approval refuses — this is the hash check that did not exist', async () => {
    const { r } = await run({
      ...base,
      approval: { step_key: 'design_review', approved_at: '2026-09-15T00:00:00Z', design_hash: 'dh', caption_hash: 'ch' },
      designHash: 'dh-NEW', captionHash: 'ch',
    });
    expect(r.mode).toBe('refuse');
    if (r.mode !== 'refuse') return;
    expect(r.reason).toBe(RELEASE_REFUSAL.APPROVAL_MISMATCH);
    expect(r.en).toContain('the design');
    expect(r.en).not.toContain('caption');
  });

  it('a caption changed after approval refuses BOTH halves of the pair — a story too', async () => {
    const { r } = await run({
      ...base, placementVariant: 'story', links: [{ asset_id: VERTICAL, role: 'final_vertical' }],
      approval: { step_key: 'design_review', approved_at: '2026-09-15T00:00:00Z', design_hash: 'dh', caption_hash: 'ch' },
      designHash: 'dh', captionHash: 'ch-NEW',
    });
    expect(r.mode).toBe('refuse');
    if (r.mode !== 'refuse') return;
    expect(r.reason).toBe(RELEASE_REFUSAL.APPROVAL_MISMATCH);
  });

  it('the caption hash is computed from the CONTENT caption, not the story blank', async () => {
    const { calls } = await run({
      ...base, placementVariant: 'story', links: [{ asset_id: VERTICAL, role: 'final_vertical' }],
      approval: { step_key: 'design_review', approved_at: '2026-09-15T00:00:00Z', design_hash: 'dh', caption_hash: 'ch' },
      designHash: 'dh', captionHash: 'ch',
    });
    const call = calls.rpcs.find((c) => c.fn === 'mos_caption_hash');
    expect(call?.args).toEqual({ p_text: 'نص معتمد' });
  });

  it('a blank caption on both sides is not a mismatch (both hash to NULL)', async () => {
    const { r } = await run({
      ...base, content: content({ data: { caption: '', hashtags: null } }),
      approval: { step_key: 'design_review', approved_at: '2026-09-15T00:00:00Z', design_hash: 'dh', caption_hash: null },
      designHash: 'dh', captionHash: null,
    });
    // Still managed — the EMPTY caption is blocked later by the platform
    // rulebook (captionRequired), not mistaken for an approval mismatch.
    expect(r.mode).toBe('managed');
    if (r.mode !== 'managed') return;
    expect(r.captionRequired).toBe(true);
  });

  it('the approval is looked up on the step the pinned version flags auto_meta_ad', async () => {
    const { calls } = await run({
      ...base, version: managedVersion([{ key: 'writing', auto_meta_ad: false }, { key: 'row_final', auto_meta_ad: true }]),
      approval: null,
    });
    const inFilter = calls.filters.find((c) => c.table === 'mos_content_approvals' && c.op === 'in');
    expect(inFilter?.args[1]).toEqual(['row_final']);
  });

  it('a version with no flagged step falls back to the two final-approval keys', async () => {
    const { calls } = await run({ ...base, version: managedVersion([{ key: 'writing' }]), approval: null });
    const inFilter = calls.filters.find((c) => c.table === 'mos_content_approvals' && c.op === 'in');
    expect(inFilter?.args[1]).toEqual(['design_review', 'final_review']);
  });
});

describe('a failed read is never silently downgraded', () => {
  for (const table of ['mos_publications', 'mos_content', 'workflow_versions', 'mos_asset_links', 'mos_content_approvals'] as const) {
    it(`${table} failing returns 'error', not 'legacy' and not 'managed'`, async () => {
      const { r } = await run({
        content: content(), version: managedVersion(), placementVariant: 'feed',
        links: [{ asset_id: SQUARE, role: 'final_square' }],
        approval: { step_key: 'design_review', approved_at: null, design_hash: 'dh', caption_hash: 'ch' },
        designHash: 'dh', captionHash: 'ch',
        fail: { [table]: 'boom' },
      });
      expect(r.mode).toBe('error');
    });
  }

  it('a failing hash RPC returns error rather than publishing unchecked', async () => {
    const { r } = await run({
      content: content(), version: managedVersion(), placementVariant: 'feed',
      links: [{ asset_id: SQUARE, role: 'final_square' }],
      approval: { step_key: 'design_review', approved_at: null, design_hash: 'dh', caption_hash: 'ch' },
      rpcFail: 'no function',
    });
    expect(r.mode).toBe('error');
  });
});

/**
 * The other half of the rule lives in the platform rulebook: the resolver
 * decides WHETHER a destination must carry text, and `preflightPublishSet`
 * enforces it. Tested here because the two only make sense together.
 */
describe('the empty-caption rule (D4)', () => {
  const photo = [{ kind: 'photo', mime_type: 'image/jpeg', size_bytes: 500_000 }];

  it('is OFF by default — every legacy publication behaves exactly as before', () => {
    const r = preflightPublishSet('instagram', photo, '');
    expect(r.issues.filter((i) => i.level === 'block')).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it('blocks a feed post whose approved writing has no caption', () => {
    const r = preflightPublishSet('instagram', photo, '', { captionRequired: true });
    const blocks = r.issues.filter((i) => i.level === 'block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.en).toContain('no approved caption');
    expect(r.ok).toBe(false);
  });

  it('treats whitespace-only as no caption', () => {
    const r = preflightPublishSet('instagram', photo, '   \n  ', { captionRequired: true });
    expect(r.issues.some((i) => i.level === 'block')).toBe(true);
  });

  it('passes once there is text', () => {
    const r = preflightPublishSet('instagram', photo, 'نص', { captionRequired: true });
    expect(r.issues.filter((i) => i.level === 'block')).toHaveLength(0);
  });

  it('a story passes with no caption — the copy lives on the design', () => {
    const r = preflightPublishSet('instagram', photo, '', { captionRequired: false });
    expect(r.issues.filter((i) => i.level === 'block')).toHaveLength(0);
  });

  it('the caption ceiling and the hashtag cap still fire alongside it', () => {
    const long = preflightPublishSet('snapchat', photo, 'x'.repeat(200), { captionRequired: true });
    expect(long.issues.some((i) => i.level === 'block' && i.en.includes('platform limit'))).toBe(true);
    const tags = `t ${Array.from({ length: 31 }, (_, i) => `#h${i}`).join(' ')}`;
    const many = preflightPublishSet('instagram', photo, tags, { captionRequired: true });
    expect(many.issues.some((i) => i.level === 'block' && i.en.includes('30 hashtags'))).toBe(true);
  });
});
