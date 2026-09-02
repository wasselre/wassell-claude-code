/**
 * assetMeta tests — Post Creative Director (A-ASSETS).
 *
 * 1. Palette: quantized histogram on synthetic RGBA pixels (pure), plus a
 *    synthetic PNG decoded end-to-end via sharp WHEN sharp is installed (it is
 *    a soft dependency — the gate is explicit, never a silent skip).
 * 2. Rights: the full classifyRights matrix (contracts §0 rule 9) +
 *    recheckRightsForFinal over a fake files_rights_v.
 * 3. Lane: flags OFF = no work (no RPC, no storage download, no backfill).
 * 4. Header parser + aspect snapping (the no-sharp fallback path).
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeDeterministicMeta,
  dominantColorsFromPixels,
  readImageSize,
  snapAspectRatio,
} from '../assetMeta/deterministic';
import { classifyRights, recheckRightsForFinal } from '../assetMeta/rights';
import { assetMetaTick, type LaneDeps, type RunBackfillBatchFn } from '../lanes/assetMetaLane';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal PNG byte sequence: signature + IHDR(width,height). Enough for the
 *  header parser (which reads only the first 24 bytes). */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); // IHDR length
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** RGBA pixel array for `count` pixels of one colour. */
function solidPixels(r: number, g: number, b: number, count: number): Uint8Array {
  const px = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  return px;
}

function concatPixels(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function sharpAvailable(): Promise<boolean> {
  try {
    const mod = (await import('sharp' as string)) as { default?: unknown };
    return typeof mod.default === 'function';
  } catch {
    return false;
  }
}

// ── Palette ──────────────────────────────────────────────────────────────────

describe('dominantColorsFromPixels', () => {
  it('ranks the dominant colour first with an honest share', () => {
    // 50% pure red, 25% pure green, 25% pure blue.
    const px = concatPixels(
      solidPixels(255, 0, 0, 50),
      solidPixels(0, 255, 0, 25),
      solidPixels(0, 0, 255, 25),
    );
    const colors = dominantColorsFromPixels(px, 100);
    expect(colors.length).toBe(3);
    // Pure 255 quantizes to bin 15 → center 248.
    expect(colors[0]).toEqual({ hex: '#f80808', share: 0.5 });
    expect(colors[1]!.share).toBe(0.25);
    expect(colors[2]!.share).toBe(0.25);
    // Green before blue on the count tie? No — equal counts break ties by bin
    // key ascending; both shares are what actually matter.
    expect(new Set([colors[1]!.hex, colors[2]!.hex])).toEqual(new Set(['#08f808', '#0808f8']));
  });

  it('caps at 5 colours and skips fully transparent pixels', () => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 8; i++) parts.push(solidPixels(i * 32, 0, 0, 10));
    const transparent = new Uint8Array(40 * 4); // alpha 0 everywhere
    const colors = dominantColorsFromPixels(concatPixels(...parts, transparent), 8 * 10 + 40);
    expect(colors.length).toBe(5);
    const sum = colors.reduce((n, c) => n + c.share, 0);
    expect(sum).toBeCloseTo(0.625, 5); // 50 of 80 opaque pixels
  });

  it('returns [] for empty input', () => {
    expect(dominantColorsFromPixels(new Uint8Array(0), 0)).toEqual([]);
  });
});

describe('computeDeterministicMeta', () => {
  it('reads dimensions from a PNG header and snaps the aspect (no sharp needed)', async () => {
    const meta = await computeDeterministicMeta(pngHeader(1080, 1350));
    expect(meta.width_px).toBe(1080);
    expect(meta.height_px).toBe(1350);
    expect(meta.aspect_ratio).toBe('4:5');
    expect(meta.has_text).toBeNull();
  });

  it('yields a palette on a synthetic PNG when sharp is installed', async () => {
    if (!(await sharpAvailable())) {
      // Soft dependency absent in this checkout — the lead adds sharp to the
      // worker image. Logged loudly here so a skipped palette is never silent.
      console.error('[assetMeta.test] sharp not installed — end-to-end palette test skipped');
      return;
    }
    const sharp = ((await import('sharp' as string)) as { default: (b: Buffer) => {
      create?: never;
    } }).default as unknown as (opts: { create: { width: number; height: number; channels: 3; background: { r: number; g: number; b: number } } }) => { png(): { toBuffer(): Promise<Buffer> } };
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const meta = await computeDeterministicMeta(png);
    expect(meta.width_px).toBe(32);
    expect(meta.height_px).toBe(32);
    expect(meta.aspect_ratio).toBe('1:1');
    expect(meta.dominant_colors).not.toBeNull();
    expect(meta.dominant_colors![0]!.hex).toMatch(/^#c8[0-2][0-9a-f][0-2][0-9a-f]$/); // (200,30,30) floored to an 8-bin → #c81818
    expect(meta.dominant_colors![0]!.share).toBeGreaterThan(0.9);
  });
});

// ── Header parser + aspect snapping ──────────────────────────────────────────

describe('readImageSize', () => {
  it('parses PNG headers', () => {
    expect(readImageSize(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });
  it('returns null for non-image bytes', () => {
    expect(readImageSize(Buffer.from('not an image at all........'))).toBeNull();
  });
});

describe('snapAspectRatio', () => {
  it('snaps near-common ratios and reduces exotic ones', () => {
    expect(snapAspectRatio(1080, 1080)).toBe('1:1');
    expect(snapAspectRatio(1920, 1080)).toBe('16:9');
    expect(snapAspectRatio(1080, 1920)).toBe('9:16');
    expect(snapAspectRatio(1080, 1350)).toBe('4:5');
    expect(snapAspectRatio(1000, 777)).toBe('5:4'); // within 4% of a common ratio → snapped
    expect(snapAspectRatio(1000, 713)).toBe('1000:713'); // genuinely exotic → reduced fraction
  });
  it('returns null on degenerate input', () => {
    expect(snapAspectRatio(0, 100)).toBeNull();
    expect(snapAspectRatio(100, 0)).toBeNull();
  });
});

// ── Rights matrix (contracts §0 rule 9) ──────────────────────────────────────

describe('classifyRights', () => {
  it('competitor media is reference-only even with otherwise-usable rights', () => {
    const c = classifyRights({ acquisition_source: 'competitor', usage_rights: 'approved', rights_verified: true });
    expect(c).toMatchObject({ selectable_for_production: false, needs_rights_confirmation: false, badge: 'reference_only', reason: 'competitor_reference_only' });
  });

  it.each(['restricted', 'do_not_use'] as const)('%s is blocked and never selectable', (rights) => {
    const c = classifyRights({ usage_rights: rights, acquisition_source: 'developer', rights_verified: true });
    expect(c).toMatchObject({ selectable_for_production: false, needs_rights_confirmation: false, badge: 'blocked', reason: `rights_${rights}` });
  });

  it.each(['ai_generated', 'ai_edited'] as const)('unreviewed %s output requires AI review', (nature) => {
    const c = classifyRights({ asset_nature: nature, acquisition_source: 'internal', usage_rights: 'needs_review', rights_verified: false });
    expect(c).toMatchObject({ selectable_for_production: false, needs_rights_confirmation: true, badge: 'ai_review', reason: 'ai_output_needs_review' });
  });

  it('human-reviewed AI output with approved rights is selectable', () => {
    const c = classifyRights({ asset_nature: 'ai_generated', acquisition_source: 'internal', usage_rights: 'approved', rights_verified: true });
    expect(c).toMatchObject({ selectable_for_production: true, needs_rights_confirmation: false, badge: 'verified' });
  });

  it('internal_only is not for production', () => {
    const c = classifyRights({ usage_rights: 'internal_only', acquisition_source: 'internal', rights_verified: true });
    expect(c).toMatchObject({ selectable_for_production: false, badge: 'reference_only', reason: 'internal_only' });
  });

  it.each(['approved', 'use_after_edit', 'attribution_required'] as const)('verified %s is selectable', (rights) => {
    const c = classifyRights({ usage_rights: rights, acquisition_source: 'developer', rights_verified: true, asset_nature: 'real' });
    expect(c).toMatchObject({ selectable_for_production: true, needs_rights_confirmation: false, badge: 'verified', reason: 'rights_verified' });
  });

  it('developer-supplied with unclear rights is a production candidate needing confirmation', () => {
    const c = classifyRights({ usage_rights: null, acquisition_source: 'developer', rights_verified: false });
    expect(c).toMatchObject({ selectable_for_production: true, needs_rights_confirmation: true, badge: 'unverified', reason: 'rights_unverified' });
  });

  it('AI-suggested rights need confirmation', () => {
    const c = classifyRights({ usage_rights: 'approved', acquisition_source: 'internal', rights_provenance: 'ai_suggested', rights_verified: false });
    expect(c).toMatchObject({ selectable_for_production: true, needs_rights_confirmation: true, badge: 'unverified', reason: 'rights_ai_suggested' });
  });

  it('needs_review needs confirmation', () => {
    const c = classifyRights({ usage_rights: 'needs_review', acquisition_source: 'client', rights_verified: false });
    expect(c).toMatchObject({ selectable_for_production: false, needs_rights_confirmation: true, badge: 'unverified', reason: 'rights_needs_review' });
  });

  it('public/unknown source with unclear rights is NOT a production candidate', () => {
    const c = classifyRights({ usage_rights: null, acquisition_source: 'public', rights_verified: false });
    expect(c).toMatchObject({ selectable_for_production: false, needs_rights_confirmation: true, badge: 'unverified' });
  });
});

describe('recheckRightsForFinal', () => {
  function fakeRightsSb(rows: Array<{ file_id: string; usage_rights: string | null; rights_provenance: string | null; rights_verified: boolean | null }>) {
    const chain = {
      select: () => chain,
      in: () => Promise.resolve({ data: rows, error: null }),
    };
    return { from: () => chain } as unknown as Pick<SupabaseClient, 'from'>;
  }

  it('ok=true when every file is verified and unblocked', async () => {
    const r = await recheckRightsForFinal(fakeRightsSb([
      { file_id: 'a', usage_rights: 'approved', rights_provenance: 'human_approved', rights_verified: true },
    ]), ['a']);
    expect(r).toEqual({ ok: true, blocked: [], unconfirmed: [] });
  });

  it('blocked files are reported and fail the check', async () => {
    const r = await recheckRightsForFinal(fakeRightsSb([
      { file_id: 'a', usage_rights: 'do_not_use', rights_provenance: 'human_approved', rights_verified: true },
      { file_id: 'b', usage_rights: 'approved', rights_provenance: 'human_approved', rights_verified: true },
    ]), ['a', 'b']);
    expect(r.ok).toBe(false);
    expect(r.blocked).toEqual([{ file_id: 'a', reason: 'rights_do_not_use' }]);
    expect(r.unconfirmed).toEqual([]);
  });

  it('unverified + missing rows are unconfirmed, never silently ok', async () => {
    const r = await recheckRightsForFinal(fakeRightsSb([
      { file_id: 'a', usage_rights: 'approved', rights_provenance: 'ai_suggested', rights_verified: false },
    ]), ['a', 'missing']);
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toEqual([
      { file_id: 'a', reason: 'rights_ai_suggested' },
      { file_id: 'missing', reason: 'rights_unknown' },
    ]);
  });

  it('empty input is trivially ok; read errors throw loudly', async () => {
    await expect(recheckRightsForFinal(fakeRightsSb([]), [])).resolves.toEqual({ ok: true, blocked: [], unconfirmed: [] });
    const badChain = { select: () => badChain, in: () => Promise.resolve({ data: null, error: { message: 'rls denied' } }) };
    const badSb = { from: () => badChain } as unknown as Pick<SupabaseClient, 'from'>;
    await expect(recheckRightsForFinal(badSb, ['a'])).rejects.toThrow('rights_blocked:');
  });
});

// ── Lane: flags off = no work ────────────────────────────────────────────────

describe('assetMetaTick', () => {
  function fakeDeps(opts: { creative_writer?: unknown; creative_backfill?: unknown }) {
    const rpcCalls: string[] = [];
    let downloads = 0;
    const sb = {
      from: (table: string) => {
        if (table !== 'mos_settings') throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: () => Promise.resolve({
                data: { value: key === 'creative_writer' ? opts.creative_writer ?? {} : opts.creative_backfill ?? {} },
                error: null,
              }),
            }),
          }),
        };
      },
      rpc: (name: string) => { rpcCalls.push(name); return Promise.resolve({ data: [], error: null }); },
      storage: { from: () => ({ download: () => { downloads += 1; return Promise.resolve({ data: null, error: { message: 'nope' } }); } }) },
    };
    const deps: LaneDeps = {
      supabase: sb as unknown as SupabaseClient,
      env: {} as LaneDeps['env'],
      workerId: 'test',
      sleep: () => Promise.resolve(),
      isShuttingDown: () => false,
      log: vi.fn(),
    };
    return { deps, rpcCalls, downloads: () => downloads };
  }

  it('does NOTHING when both flags are off', async () => {
    const { deps, rpcCalls, downloads } = fakeDeps({
      creative_writer: { asset_enrich_v2: false },
      creative_backfill: { asset_meta: { enabled: false }, asset_enrich: { enabled: false } },
    });
    const runBackfillBatch: RunBackfillBatchFn = vi.fn(() => Promise.resolve({ processed: 0, failed: 0, cost_usd: 0 }));
    const r = await assetMetaTick(deps, { runBackfillBatch });
    expect(r).toEqual({ didWork: false, meta: { processed: 0, failed: 0 }, enrich: null });
    expect(rpcCalls).toEqual([]);      // no targets RPC
    expect(downloads()).toBe(0);       // no storage traffic
    expect(runBackfillBatch).not.toHaveBeenCalled();
  });

  it('does NOTHING when the settings rows are absent (defaults are off)', async () => {
    const { deps, rpcCalls } = fakeDeps({});
    const r = await assetMetaTick(deps, { runBackfillBatch: null });
    expect(r.didWork).toBe(false);
    expect(rpcCalls).toEqual([]);
  });

  it('runs the enrich batch only when BOTH gates are on', async () => {
    const runBackfillBatch: RunBackfillBatchFn = vi.fn(() => Promise.resolve({ processed: 3, failed: 0, cost_usd: 0.01 }));
    // backfill tier on but the v2 flag off → no batch.
    const a = fakeDeps({
      creative_writer: { asset_enrich_v2: false },
      creative_backfill: { asset_enrich: { enabled: true, batch_size: 5 } },
    });
    await assetMetaTick(a.deps, { runBackfillBatch });
    expect(runBackfillBatch).not.toHaveBeenCalled();
    // Both on → the batch runs.
    const b = fakeDeps({
      creative_writer: { asset_enrich_v2: true },
      creative_backfill: { asset_enrich: { enabled: true, batch_size: 5 } },
    });
    const r = await assetMetaTick(b.deps, { runBackfillBatch });
    expect(runBackfillBatch).toHaveBeenCalledWith('asset_enrich', b.deps, { batchSize: 5 });
    expect(r.enrich).toEqual({ processed: 3, failed: 0 });
    expect(r.didWork).toBe(true);
  });
});
